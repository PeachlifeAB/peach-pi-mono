import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCompactionSummarizationPayload } from "./compaction-summarization-payload.ts";
import { isEffectiveReduction } from "./error-classifier.ts";
import type { EmergencyPruner, NotifyLevel, OverflowRecoveryState } from "./overflow-recovery-types.ts";
import { DEFAULT_CHARS_PER_TOKEN } from "./retry-config.ts";
import {
	contextWindowOf,
	requestedMaxOutputTokensOf,
	restoreOutputHeadroom,
	serializedPayloadLength,
	shouldStopUnshrunkOverflowReplay,
} from "./retry-utils.ts";
export function createOverflowPayloadController(options: {
	state: OverflowRecoveryState;
	pruner: EmergencyPruner;
	getReserveTokens: () => number;
	setStatus: (ctx: ExtensionContext, value: string) => void;
	notify: (message: string, level?: NotifyLevel) => void;
	terminal: (ctx: ExtensionContext, message: string) => void;
}) {
	const { state, pruner, getReserveTokens, setStatus, notify, terminal } = options;

	const beforeContext = (
		event: { messages?: AgentMessage[] },
		ctx: ExtensionContext,
	): { messages?: AgentMessage[] } | undefined => {
		if (!Array.isArray(event.messages)) return;
		const payload = { messages: event.messages };
		const payloadChars = serializedPayloadLength(payload);
		const contextWindow = contextWindowOf(ctx);
		if (state.compactionInProgress || pruner.isMemoryPressureActive()) return;
		const knownOverageTokens = Math.max(0, pruner.estimateTokens(payloadChars) - (contextWindow ?? 0));
		const result = pruner.applyMessagesOnly(payload, knownOverageTokens);
		if (result.removedChars <= 0) return;
		state.lastContextPruneRemovedContent = true;
		const messages =
			result.payload &&
			typeof result.payload === "object" &&
			Array.isArray((result.payload as { messages?: unknown }).messages)
				? (result.payload as { messages: AgentMessage[] }).messages
				: event.messages;
		setStatus(ctx, `🔁 retrying · pruned ~${result.removedTokensApprox} tok`);
		notify(
			`Emergency-pruned approximately ${result.removedTokensApprox} tokens from the provider context before retry.`,
			"warning",
		);
		return { messages };
	};

	const beforeProviderRequest = (payload: unknown, ctx: ExtensionContext): unknown => {
		if (isCompactionSummarizationPayload(payload)) return;
		const incomingPayloadChars = serializedPayloadLength(payload);
		const contextWindow = contextWindowOf(ctx);
		const requestedOutputTokens = requestedMaxOutputTokensOf(payload) ?? getReserveTokens();
		const knownOverageTokens = Math.max(
			0,
			pruner.estimateTokens(incomingPayloadChars) - (contextWindow ?? 0) + requestedOutputTokens,
		);
		const hadPruneArmed = pruner.hasBudget();
		const result = pruner.apply(payload, knownOverageTokens);
		const shouldRestore =
			result.removedChars > 0 || state.lastContextPruneRemovedContent || state.outputHeadroomRestoreArmed;
		state.lastContextPruneRemovedContent = false;
		state.outputHeadroomRestoreArmed = false;
		const prunedPayload = shouldRestore
			? restoreOutputHeadroom(result.payload, {
					contextWindow,
					prunedPayloadChars: serializedPayloadLength(result.payload),
					charsPerToken: DEFAULT_CHARS_PER_TOKEN,
					maxRestoredTokens: getReserveTokens(),
				})
			: result.payload;
		const finalPayload = shouldRestore ? prunedPayload : payload;
		const finalPayloadChars = result.removedChars > 0 ? serializedPayloadLength(prunedPayload) : incomingPayloadChars;
		state.lastOutgoingPayloadChars = finalPayloadChars;

		if (
			shouldStopUnshrunkOverflowReplay({
				errorClass: state.activeErrorClass,
				activeErrorSignature: state.activeErrorSignature,
				lastErrorSignature: state.lastErrorSignature,
				currentPayloadChars: finalPayloadChars,
				lastSentPayloadChars: state.lastSentPayloadChars,
			})
		) {
			terminal(ctx, "Overflow recovery stopped: outgoing provider payload did not shrink between retries.");
			return finalPayload;
		}
		if (state.activeErrorSignature !== undefined) {
			state.lastSentPayloadChars = finalPayloadChars;
			state.lastErrorSignature = state.activeErrorSignature;
		}
		const effective = isEffectiveReduction({
			reducedTokens: result.removedTokensApprox,
			overageTokens: knownOverageTokens,
		});
		if (result.removedChars <= 0) {
			if (hadPruneArmed && !effective) state.lastShrinkWasIneffective = true;
			return shouldRestore ? finalPayload : undefined;
		}
		state.lastShrinkWasIneffective = hadPruneArmed && !effective;
		setStatus(ctx, `🔁 retrying · pruned ~${result.removedTokensApprox} tok`);
		notify(
			`Emergency-pruned approximately ${result.removedTokensApprox} tokens from the provider payload before retry.`,
			"warning",
		);
		if (result.shortfallChars > 0 && !effective) {
			const shortfallTokens = Math.round(result.shortfallChars / DEFAULT_CHARS_PER_TOKEN);
			notify(
				`Emergency prune fell short by approximately ${shortfallTokens} tokens — the payload ran out of prunable content before the target was reached.`,
				"warning",
			);
		}
		return finalPayload;
	};

	return { beforeContext, beforeProviderRequest };
}
