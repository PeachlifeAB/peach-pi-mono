import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createRetryEngine, TriggerOptions } from "./agent-retry.ts";
import type { createCompactionCoordinator } from "./compaction-coordinator.ts";
import type { HostCompactionJournal } from "./host-compaction-journal.ts";
import type { createLengthStopHandler } from "./length-stop.ts";
import type { ModelFallbackCoordinator } from "./model-fallback-coordinator.ts";
import type { createOverflowRecovery } from "./overflow-recovery.ts";
import type { createPendingMessagesGate } from "./pending-messages.ts";
import type { RecoveryChainDriver } from "./recovery-chain-driver.ts";
import type { ResponsesOutputBudgetRecovery } from "./responses-output-budget-recovery.ts";
import type { RetryAdmission } from "./retry-admission.ts";
import { registerRetryCommand } from "./retry-command.ts";
import type { Guarded, NotifyLevel } from "./retry-hooks.ts";
import { registerRetryInput } from "./retry-input.ts";
import { registerRetryMessageEnd } from "./retry-message-end.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";
import { registerRetrySessionEvents } from "./retry-session-events.ts";
import type { createWatchdog } from "./watchdog.ts";

export function registerRetryExtensionEvents(options: {
	pi: ExtensionAPI;
	guarded: Guarded;
	driver: RecoveryChainDriver;
	engine: ReturnType<typeof createRetryEngine>;
	fallback: ModelFallbackCoordinator;
	maxFallbackHops: number;
	policy: ResolvedRetryPolicy;
	coordinator: ReturnType<typeof createCompactionCoordinator>;
	hostCompactionJournal: HostCompactionJournal;
	recovery: ReturnType<typeof createOverflowRecovery>;
	watchdog: ReturnType<typeof createWatchdog>;
	lengthStop: ReturnType<typeof createLengthStopHandler>;
	pendingMessagesGate: ReturnType<typeof createPendingMessagesGate>;
	responsesOutputBudget: ResponsesOutputBudgetRecovery;
	setContext: (ctx: ExtensionContext) => void;
	setLatestContext: (ctx: ExtensionContext) => void;
	latestContext: () => ExtensionContext | undefined;
	notify: (message: string, level?: NotifyLevel) => void;
	admission: RetryAdmission;
	onRetriesExhausted?: () => void;
	triggerRetry: (ctx: ExtensionContext, triggerOptions?: TriggerOptions) => void;
	resetSession: () => void;
	resetTurn: (resetBudget?: boolean) => void;
	onProviderProgress: (stopReason: "stop" | "toolUse") => void;
	isUserAborted: () => boolean;
	clearUserAborted: () => void;
	markUserAborted: () => void;
	nextDemandId: () => string;
	yieldToContinuation: () => void;
}): void {
	registerRetryInput(options);
	registerRetrySessionEvents(options);
	registerRetryMessageEnd(options);
	registerRetryCommand({
		pi: options.pi,
		engine: options.engine,
		lengthStop: options.lengthStop,
		recovery: options.recovery,
		policy: options.policy,
		notify: options.notify,
		setNotify: options.setContext,
		clearUserAborted: options.clearUserAborted,
		triggerRetry: options.triggerRetry,
	});
}
