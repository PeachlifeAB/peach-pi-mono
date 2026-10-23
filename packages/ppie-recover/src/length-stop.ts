import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionOutcome } from "./compact.ts";
import type { createCompactionCoordinator } from "./compaction-coordinator.ts";
import {
	clampedReplayStop,
	classifyContextPressure,
	classifyGeneratedProgress,
	classifyLengthStop,
	planLengthRecovery,
	usageTokens,
} from "./length-stop-classification.ts";
import type { PendingMessagesGate } from "./pending-messages.ts";
import type { RecoveryBudgetDecision } from "./recovery-budget.ts";
import { type MessageShape, visibleTextLength } from "./retry-utils.ts";
import type { RecoveryStopCause } from "./setting-tips.ts";
import { attemptSuffix } from "./status.ts";

const MIN_LENGTH_RETRY_TEXT_CHARS = 20;
const LENGTH_FOLLOW_UP_PROMPT =
	"Continue exactly from where your previous response stopped. Do not repeat earlier text.";

type NotifyLevel = "info" | "warning" | "error";

const RECENT_BRANCH_SCAN_LIMIT = 20;

type LengthStopHandlerOptions = {
	pi: Pick<ExtensionAPI, "sendUserMessage">;
	setStatus: (ctx: ExtensionContext, value: string, options?: { sticky?: boolean }) => void;
	clearStatus?: (ctx: ExtensionContext) => void;
	showRetryStatus: (ctx: ExtensionContext) => void;
	notify: (message: string, level?: NotifyLevel) => void;
	terminal: (ctx: ExtensionContext, message: string, cause?: RecoveryStopCause) => void;
	compact: (ctx: ExtensionContext) => Promise<CompactionOutcome>;
	consumeRecoveryAttempt: () => RecoveryBudgetDecision;
	peekRecoveryAttempt?: () => { attempt: number; limit: number };
	coordinator: ReturnType<typeof createCompactionCoordinator>;
	getOverflowRetryDelayMs: () => number;
	getCompactionWarningMs: () => number | undefined;
	getCompactionStallCheckMs: () => number;
	getCompactionStallRetryMs: () => number;
	isCurrent?: () => boolean;
	createRequestIsCurrent?: () => () => boolean;
	regenerateLengthOverflow: () => void;
	armOutputHeadroomRestore: () => void;
	pendingMessagesGate: PendingMessagesGate;
};

export type LengthStopHandler = ReturnType<typeof createLengthStopHandler>;

export function createLengthStopHandler({
	pi,
	setStatus,
	clearStatus = () => {},
	showRetryStatus,
	notify,
	terminal,
	compact,
	consumeRecoveryAttempt,
	peekRecoveryAttempt,
	coordinator,
	getOverflowRetryDelayMs,
	getCompactionWarningMs,
	getCompactionStallCheckMs,
	getCompactionStallRetryMs,
	isCurrent = () => true,
	createRequestIsCurrent,
	regenerateLengthOverflow,
	armOutputHeadroomRestore,
	pendingMessagesGate,
}: LengthStopHandlerOptions) {
	let pendingLengthOverflowRetry = false;
	let recoveryGeneration = 0;
	const createCurrentRequestCheck = createRequestIsCurrent ?? (() => isCurrent);
	const consumeBudgetOrStop = (ctx: ExtensionContext) => {
		const decision = consumeRecoveryAttempt();
		if (decision.allowed) return true;
		terminal(
			ctx,
			`Output-limit recovery stopped after ${decision.limit} attempts. Raise output tokens or compact before retrying.`,
		);
		return false;
	};

	const isTinyOverflowShape = (message: MessageShape) =>
		classifyLengthStop({
			visibleTextChars: visibleTextLength(message),
			minTruncationTextChars: MIN_LENGTH_RETRY_TEXT_CHARS,
		}) === "overflow";

	const recentBranchHasTinyLengthStop = (ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch().slice(-RECENT_BRANCH_SCAN_LIMIT);
		return branch.some((entry) => {
			if (!entry || typeof entry !== "object") return false;
			if ((entry as { type?: unknown }).type !== "message") return false;
			const prior = (entry as { message?: unknown }).message as MessageShape;
			return prior.role === "assistant" && prior.stopReason === "length" && isTinyOverflowShape(prior);
		});
	};

	const shouldRecoverTinyStop = (ctx: ExtensionContext, message: MessageShape) =>
		message.stopReason === "stop" &&
		message.role === "assistant" &&
		isTinyOverflowShape(message) &&
		recentBranchHasTinyLengthStop(ctx);

	const sendLengthFollowUp = (ctx: ExtensionContext): void => {
		pendingMessagesGate.runWhenClear(ctx, "Output-limit follow-up", () => {
			setStatus(ctx, "🔁 continuing");
			notify("Output limit reached; continuing with a follow-up turn…", "warning");
			pi.sendUserMessage(LENGTH_FOLLOW_UP_PROMPT, { deliverAs: "followUp" });
		});
	};

	const handle = (ctx: ExtensionContext, message: MessageShape) => {
		const progress = classifyGeneratedProgress(message, MIN_LENGTH_RETRY_TEXT_CHARS);
		const pressure = classifyContextPressure(ctx, message);
		const plan = planLengthRecovery({ progress, pressure });

		if (plan === "conservative-stop") {
			terminal(
				ctx,
				"Output-limit recovery stopped: context headroom is unknown or insufficient for safe continuation.",
			);
			return;
		}

		if (plan === "compact-then-regenerate" || plan === "compact-then-follow-up") {
			const requestGeneration = recoveryGeneration;
			const hostRequestIsCurrent = createCurrentRequestCheck();
			const requestIsCurrent = () => requestGeneration === recoveryGeneration && hostRequestIsCurrent();
			const releasePending = () => {
				if (!requestIsCurrent()) return false;
				pendingLengthOverflowRetry = false;
				return true;
			};
			const compactionAuthorized = false;
			let tokensBeforeCompact: number | undefined;
			let invokedFallback = false;
			const result = coordinator.request({
				owner: "length-overflow",
				label: plan === "compact-then-follow-up" ? "output-limit follow-up" : "output-limit recovery",
				startWhen: "after-agent-settled",
				startDelayMs: getOverflowRetryDelayMs(),
				recheckDelayMs: 0,
				compactionWarningMs: getCompactionWarningMs(),
				stallCheckMs: getCompactionStallCheckMs(),
				stallRetryMs: getCompactionStallRetryMs(),
				isCurrent: requestIsCurrent,
				requiresObservedCompaction: plan === "compact-then-follow-up",
				compact: compactionAuthorized
					? () => {
							invokedFallback = true;
							tokensBeforeCompact = usageTokens(ctx);
							return compact(ctx);
						}
					: undefined,
				onCompactionStarted: () => {
					tokensBeforeCompact = usageTokens(ctx);
				},
				onCallerContinuation: (cause) => {
					if (!releasePending()) return;
					if (plan === "compact-then-follow-up") {
						if (cause.kind !== "compaction-completed")
							return terminal(ctx, "Output-limit follow-up stopped: no compaction was observed.");
						if (!consumeBudgetOrStop(ctx)) return;
						sendLengthFollowUp(ctx);
						return;
					}
					const stop = clampedReplayStop(
						tokensBeforeCompact,
						usageTokens(ctx),
						cause.kind === "compaction-completed",
					);
					if (stop) return terminal(ctx, stop);
					if (!consumeBudgetOrStop(ctx)) return;
					if (invokedFallback) {
						armOutputHeadroomRestore();
					}
					showRetryStatus(ctx);
					regenerateLengthOverflow();
				},
				onCoreContinuation: () => {
					if (!releasePending()) return;
				},
				onUnavailable: (outcome) => {
					if (!releasePending()) return;
					terminal(
						ctx,
						`Output-limit recovery stopped: compaction could not help after a fresh state recheck (${outcome.error.message}).`,
						outcome.kind === "not-authorized" ? "compaction-not-authorized" : undefined,
					);
				},
				onLifecyclePending: () => {},
				onDiagnostic: (message) => notify(message, "warning"),
				onStalled: () => {
					if (!releasePending()) return;
					terminal(
						ctx,
						"Output-limit recovery stopped: compaction lifecycle remained unchanged through both advisory checks.",
					);
				},
				onCancelled: () => {
					releasePending();
				},
				onEnded: () => clearStatus(ctx),
			});
			if (result !== "accepted") return;
			pendingLengthOverflowRetry = true;
			setStatus(ctx, `⏳ waiting for compaction${attemptSuffix(peekRecoveryAttempt?.())}`, { sticky: true });
			notify(
				plan === "compact-then-follow-up"
					? "Output limit reached with reasoning progress; waiting for compaction before follow-up…"
					: "Output limit produced no useful response; waiting for compaction before retry…",
				"warning",
			);
			return;
		}
		if (!consumeBudgetOrStop(ctx)) return;
		sendLengthFollowUp(ctx);
	};

	const reset = () => {
		recoveryGeneration++;
		pendingLengthOverflowRetry = false;
	};

	return {
		handle,
		reset,
		shouldRecoverTinyStop,
		hasPendingLengthOverflowRetry: () => pendingLengthOverflowRetry,
	};
}
