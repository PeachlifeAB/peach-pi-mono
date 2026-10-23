import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostCompactionJournal } from "./host-compaction-journal.ts";
import type { EmergencyPruner, NotifyLevel, OverflowRecoveryState } from "./overflow-recovery-types.ts";
import type { CompactionFailureOutcome, CompactionIdentity } from "./recovery-chain.ts";
import type {
	RecoveryChainDriver,
	RecoveryChainExecutionPort,
	RecoveryCompactionLifecycle,
} from "./recovery-chain-driver.ts";
import type { RecoveryStopCause } from "./setting-tips.ts";

export function createMemoryGuardRecovery(options: {
	state: OverflowRecoveryState;
	pruner: EmergencyPruner;
	driver: RecoveryChainDriver;
	hostCompactionJournal?: HostCompactionJournal;
	awaitCompactionOrFallback: (
		owner: "memory-guard",
		label: string,
		ctx: ExtensionContext | undefined,
		options: {
			startWhen?: "after-agent-settled" | "defer-now";
			retryDelayMs?: number;
			onRetry: () => void;
			onCoreContinuation?: () => void;
			onCompactionInvoke?: () => void;
			onMemoryGuardCompactionFailed?: (outcome: CompactionFailureOutcome) => void;
		},
	) => "accepted" | "already-pending" | "cancelled";
	finishObserved: (continuationOwner: "core" | "ppie-recover") => void;
	failObserved: (outcome: CompactionFailureOutcome) => void;
	notify: (message: string, level?: NotifyLevel) => void;
	terminal: (ctx: ExtensionContext, message: string, cause?: RecoveryStopCause) => void;
}) {
	const { state, pruner, driver, awaitCompactionOrFallback, finishObserved, failObserved } = options;

	return (ctx: ExtensionContext | undefined, recovery: { onRetry: (delayAlreadyElapsed: boolean) => void }): void => {
		const executionPort: RecoveryChainExecutionPort = {
			requestCompaction: (action, lifecycle: RecoveryCompactionLifecycle) => {
				let identity: CompactionIdentity | undefined;
				const startOwnedCompaction = (): CompactionIdentity => {
					if (identity) return identity;
					identity = {
						owner: "ppie-recover",
						requestId: action.id,
						lifecycleEpoch: ++state.lifecycleEpoch,
					};
					state.ownedCompactionIdentity = identity;
					state.ownBeforeCompactExpected = true;
					lifecycle.started(identity);
					return identity;
				};
				const complete = (continuationOwner: "core" | "ppie-recover"): void => {
					if (state.externalCompactionIdentity) {
						finishObserved(continuationOwner);
						return;
					}
					if (!identity) return;
					lifecycle.completed(identity, continuationOwner);
					state.ownedCompactionIdentity = undefined;
					state.ownBeforeCompactExpected = false;
				};
				const fail = (outcome: CompactionFailureOutcome): void => {
					if (state.externalCompactionIdentity) {
						failObserved(outcome);
						return;
					}
					lifecycle.failed(startOwnedCompaction(), outcome);
					state.ownedCompactionIdentity = undefined;
					state.ownBeforeCompactExpected = false;
				};
				const result = awaitCompactionOrFallback("memory-guard", "memory-guard recovery", ctx, {
					onRetry: () => complete("ppie-recover"),
					onCoreContinuation: () => complete("core"),
					onCompactionInvoke: startOwnedCompaction,
					onMemoryGuardCompactionFailed: fail,
					startWhen: action.attempt === 1 ? "after-agent-settled" : "defer-now",
					retryDelayMs: action.delayMs,
				});
				if (result !== "accepted") {
					state.ownedCompactionIdentity = undefined;
					state.ownBeforeCompactExpected = false;
					return "not-accepted";
				}
				if (action.attempt > 1) {
					options.notify(
						`Memory pressure persisted; scheduling compaction attempt ${action.attempt} in ${Math.round(action.delayMs / 1000)}s.`,
						"warning",
					);
				}
				return "accepted";
			},
			continueProvider: () => recovery.onRetry(true),
			reduceAndRetry: () => {
				options.notify(
					"Provider memory pressure persisted through configured compaction attempts; emergency-pruning the next bounded retry.",
					"warning",
				);
				pruner.rememberOverflow(state.activeErrorMessage ?? "", state.lastOutgoingPayloadChars);
				recovery.onRetry(false);
			},
			notifyTerminal: (action) => {
				if (ctx) options.terminal(ctx, action.reason, action.cause);
				else options.notify(action.reason, "error");
			},
		};
		driver.recover(
			"memory-guard",
			state.activeErrorMessage ?? state.activeErrorSignature ?? "memory-guard",
			executionPort,
			options.hostCompactionJournal ? (observer) => options.hostCompactionJournal?.claim(observer) : undefined,
		);
	};
}
