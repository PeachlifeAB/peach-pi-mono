import type { Agent } from "@earendil-works/pi-agent-core";
import type { RecoveryBudgetDecision } from "./recovery-budget.ts";
import type { RetryDrivingLock } from "./retry-driving-lock.ts";

// "superseded" covers every freshness check that fails right before driving
// the host's private prompt method: a session/tail mismatch, the caller's own
// isCurrent() going false (e.g. the user steered/cancelled while this port was
// waiting), or a same-tick re-check finding the host's active-run state
// already held by someone else immediately before dispatch. That last check
// is what stops this port from racing the user's own prompt submission into
// the host's non-reentrant prompt-driving call.
export type RetryContinuationPort = Readonly<{
	continueCurrent(
		expectedTail: unknown,
		prepare: () => void,
		isCurrent?: () => boolean,
		/** Called once when dispatch must wait for a running turn to finish. */
		onWaitingForRunningTurn?: () => void,
	): Promise<"completed" | "superseded" | "unavailable">;
}>;

export type RetryEngineOptions = {
	getAgent: () => Agent | null;
	drivingLock: RetryDrivingLock;
	continuation: RetryContinuationPort;
	maxAttempts: () => number;
	consumeRecoveryAttempt?: (message?: string) => RecoveryBudgetDecision;
	baseDelayMs: number;
	maxDelayMs: number;
	isStillRetryable: (errorMessage: string) => boolean;
	delayMsForError?: (errorMessage: string, attempt: number) => number;
	notify?: (message: string, level: "info" | "warning" | "error") => void;
	/** After the retries-exhausted stop is reported, e.g. to show a setting tip. */
	onRetriesExhausted?: () => void;
	preRetryHook?: (attempt: number, errorMessage: string) => Promise<void>;
};

// One-shot options for recovery continuations whose source error may have been
// stripped by Pi core or whose selected retry delay already elapsed while waiting
// for native/fallback recovery.
export type TriggerOptions = {
	fallbackErrorMessage?: string;
	delayAlreadyElapsed?: boolean;
};

export type RetryEngine = {
	trigger(triggerOptions?: TriggerOptions): void;
	cancel(): void;
	newGeneration(): void;
	isDriving(): boolean;
	regenerateLengthOverflow(): void;
};
