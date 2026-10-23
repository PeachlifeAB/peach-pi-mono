import type { createRetryEngine } from "./agent-retry.ts";
import type { createCompactionCoordinator } from "./compaction-coordinator.ts";
import type { HostCompactionJournal } from "./host-compaction-journal.ts";
import type { LengthStopHandler } from "./length-stop.ts";
import type { ModelFallbackCoordinator } from "./model-fallback-coordinator.ts";
import type { createOverflowRecovery } from "./overflow-recovery.ts";
import type { PendingMessagesGate } from "./pending-messages.ts";
import type { RecoveryBudget } from "./recovery-budget.ts";
import type { RecoveryChainDriver } from "./recovery-chain-driver.ts";
import type { ResponsesOutputBudgetRecovery } from "./responses-output-budget-recovery.ts";
import type { RetryAdmission } from "./retry-admission.ts";

/**
 * Owns the three lifetimes recovery state is scoped to:
 * - episode: provider failure → next successful response (budgets, clocks);
 * - turn: user input or abort (episode plus in-flight recovery work);
 * - session: session replace/fork (turn plus engine generation).
 * Long autonomous turns are the norm, so nothing that bounds retries may
 * outlive the episode it was spent in.
 */
export function createRecoveryLifecycle(deps: {
	state: { recoveryGeneration: number; userAborted: boolean };
	recoveryBudget: RecoveryBudget;
	retryAdmission: RetryAdmission;
	recovery: ReturnType<typeof createOverflowRecovery>;
	responsesOutputBudget: ResponsesOutputBudgetRecovery;
	fallback: ModelFallbackCoordinator;
	coordinator: ReturnType<typeof createCompactionCoordinator>;
	lengthStop: LengthStopHandler;
	recoveryChainDriver: RecoveryChainDriver;
	hostCompactionJournal: HostCompactionJournal;
	pendingMessagesGate: PendingMessagesGate;
	sessionWatchdog: { disarm(): void };
	engine: ReturnType<typeof createRetryEngine>;
}) {
	const { state } = deps;
	const resetRecoveryBudgets = (): void => {
		deps.recoveryBudget.reset();
		deps.retryAdmission.reset();
	};
	const onProviderProgress = (stopReason: "stop" | "toolUse"): void => {
		resetRecoveryBudgets();
		deps.engine.cancel();
		deps.coordinator.onProviderProgress();
		deps.lengthStop.reset();
		deps.recovery.onProviderProgress();
		deps.responsesOutputBudget.onProviderProgress();
		if (stopReason === "stop") deps.fallback.succeed();
	};
	const resetTurn = (resetBudget = true): void => {
		state.recoveryGeneration++;
		if (resetBudget) resetRecoveryBudgets();
		deps.coordinator.cancel();
		deps.lengthStop.reset();
		deps.responsesOutputBudget.resetTurn();
		deps.recovery.resetTurn();
		deps.recoveryChainDriver.changeGeneration(`generation-${state.recoveryGeneration}`);
		deps.hostCompactionJournal.changeGeneration(`generation-${state.recoveryGeneration}`);
		deps.pendingMessagesGate.cancel();
		deps.fallback.cancel("reset");
	};
	const resetSession = (): void => {
		state.recoveryGeneration++;
		deps.coordinator.cancel();
		deps.sessionWatchdog.disarm();
		resetTurn();
		deps.responsesOutputBudget.resetSession();
		deps.engine.newGeneration();
		deps.engine.cancel();
		state.userAborted = false;
	};
	return { onProviderProgress, resetTurn, resetSession };
}
