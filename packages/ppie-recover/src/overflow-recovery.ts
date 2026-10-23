import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompactionCoordinator } from "./compaction-coordinator.ts";
import { createEmergencyPruner } from "./emergency-prune.ts";
import { createOverflowClassification } from "./overflow-classification.ts";
import { createOverflowCompaction } from "./overflow-compaction.ts";
import { createMemoryGuardRecovery } from "./overflow-memory-guard.ts";
import { createOverflowPayloadController } from "./overflow-payload.ts";
import { createOverflowRecoveryState, type OverflowRecoveryOptions } from "./overflow-recovery-types.ts";
import { DEFAULT_RETRY_POLICY } from "./retry-policy.ts";
import { attemptSuffix } from "./status.ts";

export type OverflowRecovery = ReturnType<typeof createOverflowRecovery>;

export function createOverflowRecovery(options: OverflowRecoveryOptions) {
	const {
		getReserveTokens,
		getPriorities,
		getMarkers,
		getMemoryRemovalFractions,
		setStatus,
		notify,
		terminal,
		compact,
		recoveryChainDriver,
		hostCompactionJournal,
	} = options;
	const coordinator =
		options.coordinator ??
		createCompactionCoordinator({
			defer: (delayMs, callback) => {
				const timer = setTimeout(callback, Math.max(0, delayMs));
				return () => clearTimeout(timer);
			},
		});
	const state = createOverflowRecoveryState();
	const pruner = createEmergencyPruner({
		getReserveTokens,
		getPriorities,
		getMarkers,
		getMemoryRemovalFractions,
	});
	const payload = createOverflowPayloadController({
		state,
		pruner,
		getReserveTokens,
		setStatus,
		notify,
		terminal,
	});
	const classification = createOverflowClassification({ state });
	const compaction = createOverflowCompaction({
		state,
		pruner,
		coordinator,
		recoveryChainDriver,
		notify,
		waitStatus: (ctx, waitMs, errorMessage) => {
			const next = errorMessage === undefined ? undefined : options.peekRecoveryAttempt?.(errorMessage);
			setStatus(ctx, `⏳ waiting for compaction (${Math.round(waitMs / 1000)}s)${attemptSuffix(next)}`, {
				sticky: true,
			});
			return () => options.clearStatus?.(ctx);
		},
		compact,
		fallbackCompactionMaxAttempts:
			options.getFallbackCompactionMaxAttempts ?? (() => DEFAULT_RETRY_POLICY.fallbackCompactionMaxAttempts),
		forcedCompactionWaitMs: options.getForcedCompactionWaitMs ?? (() => DEFAULT_RETRY_POLICY.forcedCompactionWaitMs),
		compactionWarningMs: options.getCompactionWarningMs ?? (() => undefined),
		compactionStallCheckMs: options.getCompactionStallCheckMs ?? (() => DEFAULT_RETRY_POLICY.compactionStallCheckMs),
		compactionStallRetryMs: options.getCompactionStallRetryMs ?? (() => DEFAULT_RETRY_POLICY.compactionStallRetryMs),
		createCurrentRequestCheck: options.createRequestIsCurrent ?? (() => options.isCurrent ?? (() => true)),
	});

	const awaitCoreDeferOrFallback = (
		ctx: ExtensionContext | undefined,
		request: { retryDelayMs?: number; errorMessage?: string; onRetry: () => void },
	): void => {
		compaction.awaitCompactionOrFallback("context-overflow", "context recovery", ctx, request);
	};
	const recoverMemoryGuard = recoveryChainDriver
		? createMemoryGuardRecovery({
				state,
				pruner,
				driver: recoveryChainDriver,
				hostCompactionJournal,
				awaitCompactionOrFallback: compaction.awaitCompactionOrFallback,
				finishObserved: compaction.finishObserved,
				failObserved: compaction.failObserved,
				notify,
				terminal,
			})
		: () => {
				throw new Error("memory-guard recovery requires an injected recovery-chain driver");
			};

	const armOutputHeadroomRestore = (): void => {
		state.outputHeadroomRestoreArmed = true;
	};
	const hasPendingCoreDefer = (): boolean => state.pendingCoreDefer;
	const hasActiveMemoryGuardChain = (): boolean =>
		(recoveryChainDriver?.isActive() ?? false) || state.memoryGuardCompactionPending;

	return {
		armOutputHeadroomRestore,
		awaitCoreDeferOrFallback,
		beforeContext: payload.beforeContext,
		beforeProviderRequest: payload.beforeProviderRequest,
		classifyAndTrack: classification.classifyAndTrack,
		hasActiveMemoryGuardChain,
		hasPendingCoreDefer,
		listUnclassifiedErrors: classification.listUnclassifiedErrors,
		onCompaction: compaction.onCompaction,
		onCompactionStart: compaction.onCompactionStart,
		onProviderProgress: () => {
			hostCompactionJournal?.clear();
			compaction.onProviderProgress();
		},
		recoverMemoryGuard,
		resetTurn: compaction.resetTurn,
		shouldDeferToCore: classification.shouldDeferToCore,
	};
}
