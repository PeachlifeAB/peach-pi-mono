import { executeRetryAttempt } from "./agent-retry-attempt.ts";
import { createRetryMessages, type RetryMessage } from "./agent-retry-messages.ts";
import type { RetryEngine, RetryEngineOptions, TriggerOptions } from "./agent-retry-types.ts";
import { debugLog } from "./debug-log.ts";
import { RETRY_STOP_NOTICE, type RetryStopReason } from "./retry-stop-notice.ts";

export type { RetryEngine, RetryEngineOptions, TriggerOptions } from "./agent-retry-types.ts";

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

type RetryRunInput = {
	agent: NonNullable<ReturnType<RetryEngineOptions["getAgent"]>>;
	options: RetryEngineOptions;
	triggerOptions: TriggerOptions | undefined;
	generation: number;
	signal: AbortSignal;
	isStale: () => boolean;
	retryMessages: ReturnType<typeof createRetryMessages>;
	calcDelay: (errorMessage: string, attempt: number) => number;
};

function selectRetryCandidate(
	agent: RetryRunInput["agent"],
	retryMessages: RetryRunInput["retryMessages"],
	state: RetryLoopState,
): RetryCandidate | undefined {
	const retryMessage = retryMessages.trailing();
	let expectedTail: unknown = retryMessage;
	const detachedErrorMessage = retryMessage === undefined ? state.fallbackErrorMessage : undefined;
	state.fallbackErrorMessage = undefined;

	if (retryMessage === undefined) {
		const last = agent.state.messages.at(-1) as RetryMessage | undefined;
		expectedTail = last;
		const isContinueTail = last?.role === "user" || last?.role === "toolResult" || last?.role === "tool";
		if (detachedErrorMessage === undefined || !isContinueTail) {
			debugLog("engine.run.no_trailing_retry_message", {
				lastRole: last?.role,
				lastStop: last?.stopReason,
				hadDetachedError: detachedErrorMessage !== undefined,
			});
			return;
		}
		debugLog("engine.run.detached_error_retry", { lastRole: last?.role });
	}

	return {
		retryMessage,
		expectedTail,
		errorMessage: retryMessage
			? typeof retryMessage.errorMessage === "string"
				? retryMessage.errorMessage
				: ""
			: (detachedErrorMessage as string),
	};
}

async function driveRetryLoop(input: RetryRunInput): Promise<void> {
	const { agent, options, triggerOptions, generation, signal, isStale, retryMessages, calcDelay } = input;
	debugLog("engine.run.start", { generation });
	await agent.waitForIdle();
	debugLog("engine.run.idle");

	const state: RetryLoopState = {
		consecutiveNoProgressAttempts: 0,
		fallbackErrorMessage: triggerOptions?.fallbackErrorMessage,
		delayAlreadyElapsed: triggerOptions?.delayAlreadyElapsed === true,
	};
	let announcedAttempts = 0;
	const stopVisibly = (reason: RetryStopReason) => {
		debugLog("engine.run.stopped", { reason });
		options.notify?.(RETRY_STOP_NOTICE[reason], "warning");
	};
	while (true) {
		if (isStale()) {
			const retryStillPending = announcedAttempts > 0 && retryMessages.trailing() !== undefined;
			if (retryStillPending) stopVisibly("cancelled_before_attempt");
			else debugLog("engine.run.cancelled_before_attempt");
			return;
		}
		const candidate = selectRetryCandidate(agent, retryMessages, state);
		if (!candidate) return;
		if (!options.isStillRetryable(candidate.errorMessage)) {
			debugLog("engine.run.not_retryable", { errorHead: candidate.errorMessage.slice(0, 80) });
			return;
		}
		const outcome = await executeRetryAttempt({
			candidate,
			state,
			agent,
			options,
			isStale,
			signal,
			retryMessages,
			calcDelay,
		});
		if (outcome.status === "exhausted") return;
		announcedAttempts++;
		if (outcome.status === "stopped") {
			stopVisibly(outcome.reason);
			return;
		}
	}
}
export function createRetryEngine(options: RetryEngineOptions): RetryEngine {
	let generation = 0;
	let cancelled = false;
	let pendingTrigger = false;
	let pendingTriggerOptions: TriggerOptions | undefined;
	let activeAbortController: AbortController | undefined;
	let activeLockOwner: symbol | undefined;

	const ownsDrivingLock = () => activeLockOwner !== undefined && options.drivingLock.isHeld(activeLockOwner);

	const activeAgent = options.getAgent;
	const retryMessages = createRetryMessages(activeAgent);

	const calcDelay = (errorMessage: string, attempt: number): number =>
		options.delayMsForError?.(errorMessage, attempt) ??
		Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));

	const regenerateLengthOverflow = () => {
		const agent = activeAgent();
		if (!agent || ownsDrivingLock()) return;
		const lockOwner = Symbol("ppie-recover-length-overflow-run");
		if (!options.drivingLock.acquire(lockOwner)) return;
		activeLockOwner = lockOwner;
		const myGeneration = generation;
		cancelled = false;
		void (async () => {
			let droppedLast: (typeof agent.state.messages)[number] | undefined;
			try {
				if (cancelled || generation !== myGeneration) return;
				const messages = agent.state.messages;
				const last = messages.at(-1);
				const result = await options.continuation.continueCurrent(
					last,
					() => {
						if ((last as RetryMessage | undefined)?.role !== "assistant") return;
						droppedLast = last;
						agent.state.messages = messages.slice(0, -1);
					},
					() => !cancelled && generation === myGeneration,
				);
				if (result !== "completed") debugLog("engine.regenerate.superseded", { result });
			} catch {
				if (droppedLast) {
					agent.state.messages = [...agent.state.messages, droppedLast];
				}
			} finally {
				options.drivingLock.release(lockOwner);
				if (activeLockOwner === lockOwner) activeLockOwner = undefined;
			}
		})();
	};

	const trigger = (triggerOptions?: TriggerOptions) => {
		const agent = activeAgent();
		if (!agent) {
			debugLog("engine.trigger.no_agent");
			return;
		}
		if (ownsDrivingLock()) {
			debugLog("engine.trigger.already_driving", { generation });
			pendingTrigger = true;
			pendingTriggerOptions = triggerOptions;
			return;
		}

		const lockOwner = Symbol("ppie-recover-trigger-run");
		if (!options.drivingLock.acquire(lockOwner)) {
			debugLog("engine.trigger.lock_busy", { generation });
			pendingTrigger = true;
			pendingTriggerOptions = triggerOptions;
			return;
		}
		activeLockOwner = lockOwner;

		const myGeneration = generation;
		activeAbortController?.abort();
		activeAbortController = new AbortController();
		cancelled = false;
		pendingTrigger = false;
		pendingTriggerOptions = undefined;

		void driveRetryLoop({
			agent,
			options,
			triggerOptions,
			generation: myGeneration,
			signal: activeAbortController.signal,
			isStale: () => cancelled || generation !== myGeneration,
			retryMessages,
			calcDelay,
		}).finally(() => {
			options.drivingLock.release(lockOwner);
			if (activeLockOwner === lockOwner) activeLockOwner = undefined;
			if (generation === myGeneration) activeAbortController = undefined;
			if (pendingTrigger && generation === myGeneration) {
				const nextTriggerOptions = pendingTriggerOptions;
				pendingTrigger = false;
				pendingTriggerOptions = undefined;
				trigger(nextTriggerOptions);
			}
		});
	};

	return {
		isDriving: ownsDrivingLock,

		newGeneration: () => {
			generation++;
			if (activeLockOwner !== undefined) {
				options.drivingLock.release(activeLockOwner);
				activeLockOwner = undefined;
			}
		},

		cancel: () => {
			cancelled = true;
			pendingTrigger = false;
			pendingTriggerOptions = undefined;
			activeAbortController?.abort();
		},

		regenerateLengthOverflow,

		trigger,
	};
}
