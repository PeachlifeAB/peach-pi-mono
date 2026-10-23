import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRetryEngine, type TriggerOptions } from "./agent-retry.ts";
import { createCompact } from "./compact.ts";
import { createCompactionCoordinator } from "./compaction-coordinator.ts";
import { configureDebugLog, debugLog } from "./debug-log.ts";
import { registerDynamicCompaction } from "./dynamic-compaction.ts";
import { combineLifecycleWatchers, createProviderSilentHookWatcher } from "./hooks.ts";
import { createHostCompactionJournal } from "./host-compaction-journal.ts";
import { createPendingMessagesGate } from "./pending-messages.ts";
import {
	agentForManager,
	createHostIdleWaitForSessionManager,
	createRetryDrivingLockForSessionManager,
	createSessionRetryContinuationPort,
} from "./pi-agent-session-retry-adapter.ts";
import { createRecoveryBudget } from "./recovery-budget.ts";
import type { RecoveryChainTelemetryPort } from "./recovery-chain.ts";
import { createRuntimeRecoveryChainDriver } from "./recovery-chain-driver.ts";
import { createRecoveryLifecycle } from "./recovery-lifecycle.ts";
import { createResponsesOutputBudgetRecovery } from "./responses-output-budget-recovery.ts";
import { createRetryAdmission } from "./retry-admission.ts";
import type { Guarded, NotifyLevel } from "./retry-hooks.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";
import { registerRetryExtensionEvents } from "./retry-register.ts";
import { notifyTip, type RecoveryStopCause, reportYield } from "./setting-tips.ts";
import { createStatusController } from "./status.ts";
import { createWatchdog, providerSilentNotice } from "./watchdog.ts";
import { wireLengthStop, wireRecovery } from "./wire-recovery.ts";

export type RetryRuntimeState = {
	userAborted: boolean;
	latestCtx: ExtensionContext | undefined;
	recoveryGeneration: number;
	continuationDemandId: number;
};

type RetryRuntimeOptions = Readonly<{
	pi: ExtensionAPI;
	policy: ResolvedRetryPolicy;
	recoveryTelemetry?: RecoveryChainTelemetryPort;
	guarded: Guarded;
	notify: (message: string, level?: NotifyLevel) => void;
	setNotifyContext: (ctx: ExtensionContext) => void;
	state: RetryRuntimeState;
}>;

export function registerRetryRuntime(options: RetryRuntimeOptions): void {
	const { pi, policy, guarded, notify, setNotifyContext, state } = options;
	configureDebugLog({ enabled: policy.debugLogEnabled, path: policy.debugLogPath });
	const retryAdmission = createRetryAdmission({ policy });
	const recoveryBudget = createRecoveryBudget(retryAdmission.maxAttemptsFor);
	const recoveryChainDriver = createRuntimeRecoveryChainDriver({
		policy,
		admission: retryAdmission,
		telemetry: options.recoveryTelemetry,
	});
	const hostCompactionJournal = createHostCompactionJournal("generation-0");
	const { setStatus, clearStatus, showRetryStatus } = createStatusController();
	const watchdog = createWatchdog({
		getTimeoutMs: () => policy.providerSilentWarningMs ?? 0,
		onStall: (ctx) => {
			setStatus(ctx, "⚠️ provider silent");
			notify(providerSilentNotice(policy.providerSilentWarningMs ?? 0), "warning");
			debugLog("watchdog.provider_silent", {
				silent_seconds: Math.round((policy.providerSilentWarningMs ?? 0) / 1000),
			});
		},
	});
	const hookWatcher = createProviderSilentHookWatcher({ hook: policy.providerSilentHook, notify });
	const sessionWatchdog = combineLifecycleWatchers(watchdog, hookWatcher);
	let yieldedGeneration = -1;
	const terminal = (_ctx: ExtensionContext | undefined, message: string, _cause?: RecoveryStopCause): void => {
		if (yieldedGeneration === state.recoveryGeneration) return;
		yieldedGeneration = state.recoveryGeneration;
		reportYield(notify, policy, message, _cause);
	};
	const compact = createCompact({ setStatus, notify });
	const coordinator = createCompactionCoordinator(
		{
			defer: (delayMs, callback) => {
				const timer = setTimeout(callback, Math.max(0, delayMs));
				return () => clearTimeout(timer);
			},
		},
		{ onDisposition: (event) => debugLog("coordinator.disposition", event) },
		createHostIdleWaitForSessionManager(() => state.latestCtx?.sessionManager),
	);
	const pendingMessagesGate = createPendingMessagesGate({ notify, terminal });
	const createRequestIsCurrent = () => {
		const generation = state.recoveryGeneration;
		return () => generation === state.recoveryGeneration;
	};
	const drivingLock = createRetryDrivingLockForSessionManager(() => state.latestCtx?.sessionManager);
	const continuation = createSessionRetryContinuationPort(() => state.latestCtx?.sessionManager);
	const { recovery, fallback } = wireRecovery({
		pi,
		policy,
		setStatus,
		clearStatus,
		peekRecoveryAttempt: recoveryBudget.peek,
		notify,
		terminal,
		compact,
		coordinator,
		drivingLock,
		continuation,
		recoveryChainDriver,
		hostCompactionJournal,
		latestContext: () => state.latestCtx,
		createRequestIsCurrent,
	});
	const engine = createRetryEngine({
		getAgent: () => (state.latestCtx ? agentForManager(state.latestCtx.sessionManager) : null),
		drivingLock,
		continuation,
		maxAttempts: () => policy.maximumAttempts,
		consumeRecoveryAttempt: recoveryBudget.consume,
		baseDelayMs: policy.temporaryRetryFirstDelayMs,
		maxDelayMs: policy.temporaryRetryMaximumDelayMs,
		isStillRetryable: retryAdmission.isStillRetryable,
		delayMsForError: retryAdmission.delayMsForError,
		notify,
		onRetriesExhausted: () => notifyTip(notify, policy, "retries-exhausted"),
		preRetryHook: async (_attempt, message) => {
			retryAdmission.consumeForRetry(message);
		},
	});
	const triggerRetry = (ctx: ExtensionContext, triggerOptions?: TriggerOptions): void => {
		debugLog("trigger_retry.requested", { hasPendingMessages: ctx.hasPendingMessages() });
		pendingMessagesGate.runWhenClear(ctx, "Retry", () => {
			showRetryStatus(ctx);
			engine.trigger(triggerOptions);
		});
	};
	const lengthStop = wireLengthStop({
		pi,
		policy,
		setStatus,
		clearStatus,
		showRetryStatus,
		notify,
		terminal,
		compact,
		coordinator,
		recoveryBudget,
		retryAdmission,
		recovery,
		engine,
		pendingMessagesGate,
		createRequestIsCurrent,
	});
	const responsesOutputBudget = createResponsesOutputBudgetRecovery({
		regenerateLengthOverflow: engine.regenerateLengthOverflow,
		showRetryStatus,
		terminal,
		latestContext: () => state.latestCtx,
	});
	const { onProviderProgress, resetTurn, resetSession } = createRecoveryLifecycle({
		state,
		recoveryBudget,
		retryAdmission,
		recovery,
		responsesOutputBudget,
		fallback,
		coordinator,
		lengthStop,
		recoveryChainDriver,
		hostCompactionJournal,
		pendingMessagesGate,
		sessionWatchdog,
		engine,
	});
	registerRetryExtensionEvents({
		pi,
		guarded,
		driver: recoveryChainDriver,
		engine,
		fallback,
		maxFallbackHops: policy.maxFallbackHops,
		policy,
		coordinator,
		hostCompactionJournal,
		recovery,
		watchdog: sessionWatchdog,
		lengthStop,
		pendingMessagesGate,
		responsesOutputBudget,
		setContext: setNotifyContext,
		setLatestContext: (ctx) => {
			state.latestCtx = ctx;
		},
		latestContext: () => state.latestCtx,
		notify,
		admission: retryAdmission,
		onRetriesExhausted: () => notifyTip(notify, policy, "retries-exhausted"),
		triggerRetry,
		resetSession,
		resetTurn,
		onProviderProgress,
		isUserAborted: () => state.userAborted,
		clearUserAborted: () => {
			state.userAborted = false;
		},
		markUserAborted: () => {
			state.userAborted = true;
		},
		yieldToContinuation: () => {
			coordinator.cancel();
			recoveryChainDriver.cancel("foreign-continuation");
			pendingMessagesGate.cancel();
			fallback.cancel("external-continuation");
		},
		nextDemandId: () => `continuation-${++state.continuationDemandId}`,
	});
	registerDynamicCompaction(pi, policy.dynamicCompactionRatio, {
		coordinator,
		compact,
		createRequestIsCurrent,
		compactionWarningMs: policy.compactionWarningMs,
		stallCheckMs: policy.compactionStallCheckMs,
		stallRetryMs: policy.compactionStallRetryMs,
	});
}
