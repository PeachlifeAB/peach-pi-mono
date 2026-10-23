import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createRetryEngine } from "./agent-retry.ts";
import type { createCompactionCoordinator } from "./compaction-coordinator.ts";
import { isCompactionSummarizationPayload } from "./compaction-summarization-payload.ts";
import { debugLog } from "./debug-log.ts";
import type { HostCompactionJournal } from "./host-compaction-journal.ts";
import type { createLengthStopHandler } from "./length-stop.ts";
import type { ModelFallbackCoordinator } from "./model-fallback-coordinator.ts";
import { outputBudgetValuesOf } from "./output-budget-dialect.ts";
import type { createOverflowRecovery } from "./overflow-recovery.ts";
import type { createPendingMessagesGate } from "./pending-messages.ts";
import type { RecoveryChainDriver } from "./recovery-chain-driver.ts";
import type { ResponsesOutputBudgetRecovery } from "./responses-output-budget-recovery.ts";
import type { Guarded } from "./retry-hooks.ts";
import type { createWatchdog } from "./watchdog.ts";

export function registerRetrySessionEvents(options: {
	pi: ExtensionAPI;
	guarded: Guarded;
	coordinator: ReturnType<typeof createCompactionCoordinator>;
	driver: RecoveryChainDriver;
	hostCompactionJournal: HostCompactionJournal;
	recovery: ReturnType<typeof createOverflowRecovery>;
	watchdog: ReturnType<typeof createWatchdog>;
	engine: ReturnType<typeof createRetryEngine>;
	fallback: ModelFallbackCoordinator;
	lengthStop: ReturnType<typeof createLengthStopHandler>;
	pendingMessagesGate: ReturnType<typeof createPendingMessagesGate>;
	responsesOutputBudget: ResponsesOutputBudgetRecovery;
	setContext: (ctx: ExtensionContext) => void;
	setLatestContext: (ctx: ExtensionContext) => void;
	resetSession: () => void;
	resetTurn: (resetBudget?: boolean) => void;
}): void {
	const { pi, guarded, coordinator, recovery, watchdog } = options;
	const claimHostCompactions = (): void =>
		options.hostCompactionJournal.claim({
			started: options.driver.observeCompactionStarted,
			completed: options.driver.observeCompactionCompleted,
			failed: options.driver.observeCompactionFailure,
		});
	pi.on("session_start", guarded("session_start", options.resetSession));
	pi.on("session_shutdown", guarded("session_shutdown", options.resetSession));
	pi.on(
		"session_before_compact",
		guarded("session_before_compact", (event, ctx) => {
			ctx.sessionManager.getBranch();
			debugLog("session_before_compact.received", {
				reason: (event as { reason?: unknown }).reason,
				willRetry: (event as { willRetry?: unknown }).willRetry,
			});
			const identity = recovery.onCompactionStart(event as { signal?: AbortSignal });
			options.hostCompactionJournal.started({ identity, signal: event.signal });
			if (options.driver.isActive()) claimHostCompactions();
			coordinator.onSessionBeforeCompact(event as { signal?: AbortSignal });
		}),
	);
	pi.on(
		"session_compact",
		guarded("session_compact", (event, ctx) => {
			ctx.sessionManager.getBranch();
			debugLog("session_compact.received", {
				hasCompactionEntry: !!(event as { compactionEntry?: unknown }).compactionEntry,
			});
			const coreWillSelfRetry = event.willRetry === true;
			options.hostCompactionJournal.completed({ willRetry: coreWillSelfRetry });
			recovery.onCompaction(coreWillSelfRetry);
			coordinator.onSessionCompact({ willRetry: coreWillSelfRetry });
		}),
	);
	pi.on(
		"context",
		guarded("context", (event, ctx) => recovery.beforeContext(event, ctx)),
	);
	pi.on(
		"before_provider_request",
		guarded("before_provider_request", (event, ctx) => {
			options.setContext(ctx);
			options.setLatestContext(ctx);
			watchdog.arm(ctx);
			const payload = (event as { payload?: unknown }).payload;
			debugLog("before_provider_request.payload_shape", {
				keys: payload && typeof payload === "object" ? Object.keys(payload as object) : typeof payload,
				outputBudget: outputBudgetValuesOf(payload),
			});
			coordinator.onBeforeProviderRequest({
				isCompactionSummary: isCompactionSummarizationPayload(payload),
			});
			options.responsesOutputBudget.observeOutgoingRequest(payload, ctx);
			const repairedPayload = options.responsesOutputBudget.applyPendingRepair(payload, ctx);
			const finalPayload = repairedPayload ?? payload;
			const overflowResult = recovery.beforeProviderRequest(finalPayload, ctx);
			return overflowResult !== undefined
				? overflowResult
				: repairedPayload !== payload
					? repairedPayload
					: undefined;
		}),
	);
	pi.on(
		"after_provider_response",
		guarded("after_provider_response", (_event, ctx) => watchdog.observe(ctx)),
	);
	pi.on(
		"message_start",
		guarded("message_start", (_event, ctx) => watchdog.observe(ctx)),
	);
	pi.on(
		"message_update",
		guarded("message_update", (_event, ctx) => {
			watchdog.observe(ctx);
		}),
	);
	pi.on(
		"agent_end",
		guarded("agent_end", (_event, ctx) => {
			options.setContext(ctx);
			watchdog.disarm();
		}),
	);
	pi.on(
		"agent_settled",
		guarded("agent_settled", (_event, ctx) => {
			options.setContext(ctx);
			watchdog.disarm();
			coordinator.onAgentSettled();
			options.responsesOutputBudget.onAgentSettled();
			if (
				!(
					options.engine.isDriving() ||
					options.fallback.isActive() ||
					options.lengthStop.hasPendingLengthOverflowRetry() ||
					options.responsesOutputBudget.hasPending() ||
					recovery.hasPendingCoreDefer() ||
					options.pendingMessagesGate.hasPending()
				)
			) {
				options.resetTurn(false);
			}
		}),
	);
}
