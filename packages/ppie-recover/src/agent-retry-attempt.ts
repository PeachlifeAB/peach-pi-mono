import type { RetryMessage } from "./agent-retry-messages.ts";
import type { RetryEngineOptions } from "./agent-retry-types.ts";
import { debugLog } from "./debug-log.ts";
import { sleepUntilRetry } from "./retry-sleep.ts";
import type { RetryAttemptOutcome } from "./retry-stop-notice.ts";
import { RETRY_WAITING_NOTICE } from "./retry-stop-notice.ts";

type RetryLoopState = {
	consecutiveNoProgressAttempts: number;
	fallbackErrorMessage: string | undefined;
	delayAlreadyElapsed: boolean;
};

type RetryCandidate = {
	retryMessage: RetryMessage | undefined;
	expectedTail: unknown;
	errorMessage: string;
};

type RetryMessages = {
	dropTrailing(message: RetryMessage): void;
	madeProgressSince(startIndex: number): boolean;
};

type RetryAttemptInput = {
	candidate: RetryCandidate;
	state: RetryLoopState;
	agent: NonNullable<ReturnType<RetryEngineOptions["getAgent"]>>;
	options: RetryEngineOptions;
	isStale: () => boolean;
	signal: AbortSignal;
	retryMessages: RetryMessages;
	calcDelay: (errorMessage: string, attempt: number) => number;
};

export async function executeRetryAttempt(input: RetryAttemptInput): Promise<RetryAttemptOutcome> {
	const { candidate, state, agent, options, isStale, signal, retryMessages, calcDelay } = input;
	const budget = options.consumeRecoveryAttempt?.(candidate.errorMessage) ?? {
		allowed: true as const,
		attempt: state.consecutiveNoProgressAttempts + 1,
		limit: options.maxAttempts(),
	};
	if (!budget.allowed) {
		options.notify?.(
			`Automatic recovery stopped after the configured ${budget.limit} provider retries. Increase retry.max_attempts or reduce retained context to continue.`,
			"error",
		);
		options.onRetriesExhausted?.();
		return { status: "exhausted" };
	}

	state.consecutiveNoProgressAttempts++;
	const delay = state.delayAlreadyElapsed ? 0 : calcDelay(candidate.errorMessage, budget.attempt);
	state.delayAlreadyElapsed = false;
	const limitSuffix = Number.isFinite(budget.limit) ? `/${budget.limit}` : "";
	options.notify?.(`Retry attempt ${budget.attempt}${limitSuffix} (waiting ${Math.round(delay / 1000)}s)…`, "info");
	if (await sleepUntilRetry(delay, isStale, signal)) {
		debugLog("engine.run.cancelled_during_delay");
		return { status: "stopped", reason: "cancelled_during_delay" };
	}

	if (options.preRetryHook) {
		try {
			await options.preRetryHook(state.consecutiveNoProgressAttempts, candidate.errorMessage);
		} catch {
			// A hook failure does not abort recovery.
		}
	}
	if (isStale()) {
		debugLog("engine.run.cancelled_after_hook");
		return { status: "stopped", reason: "stale_after_hook" };
	}

	let startIndex = agent.state.messages.length;
	try {
		debugLog("engine.run.continue_start");
		const result = await options.continuation.continueCurrent(
			candidate.expectedTail,
			() => {
				if (candidate.retryMessage !== undefined) retryMessages.dropTrailing(candidate.retryMessage);
				startIndex = agent.state.messages.length;
			},
			() => !isStale(),
			() => options.notify?.(RETRY_WAITING_NOTICE, "warning"),
		);
		if (result === "superseded") {
			debugLog("engine.run.superseded", { result });
			return { status: "stopped", reason: "continuation_superseded" };
		}
		if (result === "unavailable") {
			debugLog("engine.run.unavailable", { result });
			return { status: "stopped", reason: "continuation_unavailable" };
		}
	} catch (error) {
		debugLog("engine.run.continuation_threw", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "stopped", reason: "continuation_failed" };
	}

	if (retryMessages.madeProgressSince(startIndex)) state.consecutiveNoProgressAttempts = 0;
	return { status: "continued" };
}
