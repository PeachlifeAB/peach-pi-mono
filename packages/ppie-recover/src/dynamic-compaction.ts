import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionOutcome } from "./compact.ts";
import type { createCompactionCoordinator } from "./compaction-coordinator.ts";
import { debugLog } from "./debug-log.ts";

type MessageShape = { role?: unknown; stopReason?: unknown; timestamp?: unknown };

// Errors and aborts stay with their owning recovery paths. A length stop may
// still trigger preventive dynamic compaction when the configured ratio is met.
const RECOVERY_OWNED_STOP_REASONS = ["aborted", "error"];

type TerminalAssistant = { timestamp: number | undefined; stopReason: string | undefined };

/**
 * Capture the run's final assistant message. Pi drains its retry/continuation
 * loop between agent_end and agent_settled, so the message captured here is the
 * one whose context the settled evaluation reasons about.
 */
function readTerminalAssistant(messages: readonly MessageShape[]): TerminalAssistant | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return {
			timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
			stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		};
	}
	return undefined;
}

/**
 * Timestamp of the newest persisted compaction entry, or undefined when the
 * branch holds none. Mirrors the host's own boundary check
 * (agent-session.js `_checkCompaction`): the host rejects an assistant message
 * older than the latest compaction entry rather than relying on usage being
 * reset. An extension cannot reach the host's helper, so it reads the branch
 * through the public ReadonlySessionManager seam.
 */
function latestCompactionAt(ctx: ExtensionContext): number | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!entry || typeof entry !== "object") continue;
		if ((entry as { type?: unknown }).type !== "compaction") continue;
		const timestamp = (entry as { timestamp?: unknown }).timestamp;
		const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : Number(timestamp);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** True when context usage has reached the dynamic compaction ratio. */
function reachedCompactionRatio(ctx: ExtensionContext, ratio: number | undefined): boolean {
	if (ratio === undefined) return false;
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.contextWindow <= 0) return false;
	return usage.tokens >= usage.contextWindow * ratio;
}

export type DynamicCompactionDependencies = {
	coordinator: ReturnType<typeof createCompactionCoordinator>;
	compact: (ctx: ExtensionContext) => Promise<CompactionOutcome>;
	createRequestIsCurrent: () => () => boolean;
	compactionWarningMs: number | undefined;
	stallCheckMs: number;
	stallRetryMs: number;
};

export function registerDynamicCompaction(
	pi: ExtensionAPI,
	compactAtRatio: number | undefined,
	dependencies: DynamicCompactionDependencies,
): void {
	if (compactAtRatio === undefined) return;

	let terminal: TerminalAssistant | undefined;

	// agent_end records only. Evaluation waits until Pi-core has completed its
	// post-agent retry and compaction decisions at agent_settled.
	pi.on("agent_end", (event) => {
		terminal = readTerminalAssistant(event.messages as readonly MessageShape[]);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const captured = terminal;
		if (!captured) return;
		if (captured.stopReason !== undefined && RECOVERY_OWNED_STOP_REASONS.includes(captured.stopReason)) {
			terminal = undefined;
			return;
		}

		const compactedAt = latestCompactionAt(ctx);
		if (compactedAt !== undefined && captured.timestamp !== undefined && compactedAt >= captured.timestamp) {
			terminal = undefined;
			return;
		}

		if (!reachedCompactionRatio(ctx, compactAtRatio)) {
			terminal = undefined;
			return;
		}
		const usage = ctx.getContextUsage();
		const details = {
			lifecycleEvent: "agent_settled",
			ratio: compactAtRatio,
			tokens: usage?.tokens,
			contextWindow: usage?.contextWindow,
		};
		const result = dependencies.coordinator.request({
			owner: "dynamic",
			label: "dynamic threshold compaction",
			startWhen: "defer-now",
			startDelayMs: 0,
			recheckDelayMs: 0,
			compactionWarningMs: dependencies.compactionWarningMs,
			stallCheckMs: dependencies.stallCheckMs,
			stallRetryMs: dependencies.stallRetryMs,
			isCurrent: dependencies.createRequestIsCurrent(),
			compact: async () => {
				const outcome = await dependencies.compact(ctx);
				if (outcome.kind === "completed") debugLog("dynamic_compaction.complete", details);
				else debugLog("dynamic_compaction.error", { ...details, error: outcome.error.message });
				return outcome;
			},
			onCallerContinuation: (cause) => {
				if (cause.kind !== "compaction-completed")
					debugLog("dynamic_compaction.continuation_without_compaction", details);
			},
			onCoreContinuation: () => {},
			onUnavailable: (outcome) => debugLog("dynamic_compaction.unavailable", { ...details, kind: outcome.kind }),
			onLifecyclePending: (outcome) =>
				debugLog("dynamic_compaction.lifecycle_pending", { ...details, kind: outcome.kind }),
			onDiagnostic: (message) => debugLog("dynamic_compaction.diagnostic", { ...details, message }),
			onStalled: () => debugLog("dynamic_compaction.stalled", details),
			onCancelled: () => debugLog("dynamic_compaction.cancelled", details),
		});
		if (result !== "already-pending") terminal = undefined;
		debugLog("dynamic_compaction.trigger", { ...details, coordinatorResult: result });
	});
}
