import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionOutcome } from "./compact.ts";
import type { createCompactionCoordinator } from "./compaction-coordinator.ts";
import { debugLog } from "./debug-log.ts";
import { classifyError } from "./error-classifier.ts";
import type { EmergencyPruner, NotifyLevel, OverflowRecoveryState } from "./overflow-recovery-types.ts";
import type { CompactionFailureOutcome, CompactionIdentity } from "./recovery-chain.ts";
import type { RecoveryChainDriver } from "./recovery-chain-driver.ts";

type AwaitCompactionOptions = {
	startWhen?: "after-agent-settled" | "defer-now";
	retryDelayMs?: number;
	errorMessage?: string;
	onRetry: () => void;
	onCoreContinuation?: () => void;
	onCompactionInvoke?: () => void;
	onMemoryGuardCompactionFailed?: (outcome: CompactionFailureOutcome) => void;
};

export function createOverflowCompaction(options: {
	state: OverflowRecoveryState;
	pruner: EmergencyPruner;
	coordinator: ReturnType<typeof createCompactionCoordinator>;
	recoveryChainDriver?: RecoveryChainDriver;
	notify: (message: string, level?: NotifyLevel) => void;
	waitStatus: (ctx: ExtensionContext, waitMs: number, errorMessage?: string) => () => void;
	compact: (ctx: ExtensionContext) => Promise<CompactionOutcome>;
	fallbackCompactionMaxAttempts: (ctx: ExtensionContext | undefined) => number;
	forcedCompactionWaitMs: () => number;
	compactionWarningMs: () => number | undefined;
	compactionStallCheckMs: () => number;
	compactionStallRetryMs: () => number;
	createCurrentRequestCheck: () => () => boolean;
}) {
	const {
		state,
		pruner,
		coordinator,
		recoveryChainDriver,
		notify,
		waitStatus,
		compact,
		fallbackCompactionMaxAttempts,
		forcedCompactionWaitMs,
		compactionWarningMs,
		compactionStallCheckMs,
		compactionStallRetryMs,
		createCurrentRequestCheck,
	} = options;

	const finishObserved = (continuationOwner: "core" | "ppie-recover"): void => {
		const identity = state.externalCompactionIdentity ?? state.ownedCompactionIdentity;
		if (!identity) return;
		recoveryChainDriver?.observeCompactionCompleted(identity, continuationOwner);
		state.externalCompactionIdentity = undefined;
		state.ownedCompactionIdentity = undefined;
		state.ownBeforeCompactExpected = false;
	};
	const failObserved = (outcome: CompactionFailureOutcome): void => {
		const identity = state.externalCompactionIdentity ?? state.ownedCompactionIdentity;
		if (!identity) return;
		recoveryChainDriver?.observeCompactionFailure(identity, outcome);
		state.externalCompactionIdentity = undefined;
		state.ownedCompactionIdentity = undefined;
		state.ownBeforeCompactExpected = false;
	};
	const onCompactionStart = (event?: { signal?: AbortSignal }): CompactionIdentity => {
		state.compactionInProgress = true;
		let identity = state.ownBeforeCompactExpected ? state.ownedCompactionIdentity : undefined;
		state.ownBeforeCompactExpected = false;
		if (!identity) {
			identity = {
				owner: "external",
				requestId: `external-compaction-${state.lifecycleEpoch + 1}`,
				lifecycleEpoch: ++state.lifecycleEpoch,
			};
			state.externalCompactionIdentity = identity;
		}
		event?.signal?.addEventListener(
			"abort",
			() => {
				state.compactionInProgress = false;
			},
			{ once: true },
		);
		return identity;
	};
	const onProviderProgress = (): void => {
		if (state.memoryGuardCompactionPending) coordinator.cancel();
		state.memoryGuardCompactionPending = false;
		state.pendingCoreDefer = false;
		state.contextFallbackCompactionAttempts = 0;
		recoveryChainDriver?.observeProviderProgress({
			stopReason: "stop",
			hasError: false,
		});
		pruner.clear();
		state.lastShrinkWasIneffective = false;
		state.lastContextPruneRemovedContent = false;
	};
	const onCompaction = (coreWillSelfRetry = false): void => {
		debugLog("recovery.on_compaction", {
			coreWillSelfRetry,
			pendingCoreDefer: state.pendingCoreDefer,
		});
		pruner.clear();
		state.lastShrinkWasIneffective = false;
		state.lastContextPruneRemovedContent = false;
		state.compactionInProgress = false;
		state.pendingCoreDefer = false;
		state.ownedCompactionIdentity = undefined;
		state.externalCompactionIdentity = undefined;
		state.ownBeforeCompactExpected = false;
	};
	const resetTurn = (): void => {
		state.lastShrinkWasIneffective = false;
		state.lastSentPayloadChars = undefined;
		state.lastErrorSignature = undefined;
		state.activeErrorSignature = undefined;
		state.activeErrorClass = undefined;
		state.activeErrorMessage = undefined;
		state.lastContextPruneRemovedContent = false;
		state.outputHeadroomRestoreArmed = false;
		state.deferredCoreOverflowSignature = undefined;
		state.compactionInProgress = false;
		state.pendingCoreDefer = false;
		state.memoryGuardCompactionPending = false;
		state.contextFallbackCompactionAttempts = 0;
		state.ownedCompactionIdentity = undefined;
		state.externalCompactionIdentity = undefined;
		state.ownBeforeCompactExpected = false;
		recoveryChainDriver?.cancel("turn-reset");
		pruner.clear();
	};
	const awaitCompactionOrFallback = (
		owner: "context-overflow" | "memory-guard",
		label: string,
		ctx: ExtensionContext | undefined,
		requestOptions: AwaitCompactionOptions,
	) => {
		const isMemoryGuard = owner === "memory-guard";
		// forced.enabled:false resolves the budget to 0 (compact withheld) unless
		// the dynamic ratio is reached, which authorizes one compaction.
		const budget = fallbackCompactionMaxAttempts(ctx);
		const mayInvokeFallback = budget > 0 && (isMemoryGuard || state.contextFallbackCompactionAttempts < budget);
		if (isMemoryGuard) {
			notify("Recoverable provider memory pressure; waiting for compaction before retry.", "warning");
		}
		// The wait before forcing is a compaction concern with its own key; it was
		// previously borrowed from the caller's retry delay. While it runs the
		// coordinator defers to any compaction another party has already started.
		//
		// Whether to defer at all stays keyed on the caller naming a delay: the
		// configured wait supplies a duration, never the decision. Keying the
		// branch on the resolved value instead would send every caller down the
		// agent-settled path whenever compaction is disabled, since the master
		// switch resolves this wait to zero.
		const waitMs = requestOptions.retryDelayMs ?? forcedCompactionWaitMs();
		const endWait = ctx ? waitStatus(ctx, waitMs, requestOptions.errorMessage) : undefined;
		const result = coordinator.request({
			owner,
			label,
			startWhen:
				requestOptions.startWhen ??
				(requestOptions.retryDelayMs === undefined ? "after-agent-settled" : "defer-now"),
			startDelayMs: waitMs,
			recheckDelayMs: 0,
			compactionWarningMs: compactionWarningMs(),
			stallCheckMs: compactionStallCheckMs(),
			stallRetryMs: compactionStallRetryMs(),
			isCurrent: createCurrentRequestCheck(),
			compact: mayInvokeFallback
				? () => {
						if (!isMemoryGuard) state.contextFallbackCompactionAttempts++;
						requestOptions.onCompactionInvoke?.();
						return ctx
							? compact(ctx)
							: Promise.resolve({
									kind: "failed" as const,
									error: new Error("no context available for fallback compaction"),
								});
					}
				: undefined,
			onCallerContinuation: (_cause) => {
				state.pendingCoreDefer = false;
				state.memoryGuardCompactionPending = false;
				requestOptions.onRetry();
			},
			onCoreContinuation: () => {
				state.pendingCoreDefer = false;
				requestOptions.onCoreContinuation?.();
			},
			onUnavailable: (outcome) => {
				state.pendingCoreDefer = false;
				state.memoryGuardCompactionPending = false;
				state.compactionInProgress = false;
				debugLog(isMemoryGuard ? "memory_guard.unavailable" : "core_defer.unavailable", {
					kind: outcome.kind,
				});
				if (isMemoryGuard) {
					const failure =
						classifyError(outcome.error.message) === "memory_guard" ? "failed-memory-guard" : "unavailable";
					requestOptions.onMemoryGuardCompactionFailed?.(failure);
					return;
				}
				notify(
					`${label}: fallback compaction could not help (${outcome.error.message}); continuing the bounded provider retry without trimming.`,
					"warning",
				);
				requestOptions.onRetry();
			},
			onLifecyclePending: (outcome) =>
				debugLog(isMemoryGuard ? "memory_guard.lifecycle_pending" : "core_defer.lifecycle_pending", {
					kind: outcome.kind,
				}),
			onDiagnostic: (message) => notify(message, "warning"),
			onStalled: () => {
				state.pendingCoreDefer = false;
				state.memoryGuardCompactionPending = false;
				state.compactionInProgress = false;
				if (isMemoryGuard) return requestOptions.onMemoryGuardCompactionFailed?.("stalled");
				notify(
					`${label}: compaction lifecycle stalled; continuing the bounded provider retry without trimming.`,
					"warning",
				);
				requestOptions.onRetry();
			},
			onCancelled: () => {
				state.pendingCoreDefer = false;
				state.memoryGuardCompactionPending = false;
			},
			onEnded: endWait,
		});
		if (result !== "accepted") endWait?.();
		state.pendingCoreDefer = result === "accepted";
		if (isMemoryGuard) state.memoryGuardCompactionPending = result === "accepted";
		return result;
	};
	return {
		awaitCompactionOrFallback,
		failObserved,
		finishObserved,
		onCompaction,
		onCompactionStart,
		onProviderProgress,
		resetTurn,
	};
}
