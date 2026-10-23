import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRetryEngine, type RetryEngine } from "../src/agent-retry.ts";
import type { RetryContinuationPort } from "../src/agent-retry-types.ts";
import { createPendingMessagesGate } from "../src/pending-messages.ts";
import { PENDING_MESSAGES_MAX_WAIT_MS } from "../src/retry-config.ts";
import { createStandaloneRetryDrivingLock } from "../src/retry-driving-lock.ts";
import { sleepUntilRetry } from "../src/retry-sleep.ts";
import { RETRY_STOP_NOTICE, RETRY_STOP_REASONS, type RetryStopReason } from "../src/retry-stop-notice.ts";

const unusedStreamFn = (() => {
	throw new Error("test streamFn should not be called");
}) as StreamFn;

function attachAgent(messages: AgentMessage[]): Agent & {
	state: { messages: AgentMessage[] };
	prompt: (messages: []) => Promise<void>;
	waitForIdle: () => Promise<void>;
} {
	const agent = new Agent({
		streamFn: unusedStreamFn,
	}) as Agent & {
		state: { messages: AgentMessage[] };
		prompt: (messages: []) => Promise<void>;
		waitForIdle: () => Promise<void>;
	};
	agent.state.messages = messages;
	agent.waitForIdle = async () => {};
	agent.subscribe(() => {});
	return agent;
}

function continuationFor(agent: Agent): RetryContinuationPort {
	return {
		async continueCurrent(expectedTail, prepare) {
			const messages = agent.state.messages;
			if (messages[messages.length - 1] !== expectedTail) return "superseded";
			prepare();
			await agent.prompt([]);
			return "completed";
		},
	};
}
function createTestRetryEngine(
	agent: Agent,
	overrides: Partial<Parameters<typeof createRetryEngine>[0]> = {},
): RetryEngine {
	return createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 1,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: () => true,
		...overrides,
	});
}

function retryErrorMessage(errorMessage: string): AgentMessage {
	return {
		role: "assistant",
		stopReason: "error",
		errorMessage,
	} as AgentMessage;
}

async function waitForIdle(engine: RetryEngine): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (!engine.isDriving()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`retry engine did not become idle within 2s; isDriving=${engine.isDriving()}`);
}

function withManualTimeouts<T>(run: (fireNext: (elapsedMs?: number) => void) => T): T {
	const callbacks: Array<() => void> = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalNow = Date.now;
	let now = 0;
	globalThis.setTimeout = ((callback: () => void) => {
		callbacks.push(callback);
		return {} as NodeJS.Timeout;
	}) as unknown as typeof globalThis.setTimeout;
	Date.now = () => now;

	try {
		return run((elapsedMs = 0) => {
			const callback = callbacks.shift();
			assert.ok(callback, "expected a scheduled polling callback");
			now += elapsedMs;
			callback();
		});
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		Date.now = originalNow;
	}
}

test("pending-message polling runs the deferred action when the queue clears", () => {
	withManualTimeouts((fireNext) => {
		let pending = true;
		let performed = 0;
		const ctx = { hasPendingMessages: () => pending } as unknown as ExtensionContext;
		const gate = createPendingMessagesGate({ notify: () => {}, terminal: () => {} });

		gate.runWhenClear(ctx, "retry", () => {
			performed += 1;
		});
		pending = false;
		fireNext();

		assert.equal(performed, 1);
		assert.equal(gate.hasPending(), false);
	});
});

test("pending-message polling terminates after the bounded wait", () => {
	withManualTimeouts((fireNext) => {
		const terminalMessages: string[] = [];
		const gate = createPendingMessagesGate({
			notify: () => {},
			terminal: (_ctx, message) => terminalMessages.push(message),
		});

		gate.runWhenClear({ hasPendingMessages: () => true } as unknown as ExtensionContext, "retry", () => {});
		fireNext(PENDING_MESSAGES_MAX_WAIT_MS);

		assert.equal(terminalMessages.length, 1);
		assert.match(terminalMessages[0] ?? "", /still had queued messages after 30s/);
		assert.equal(gate.hasPending(), false);
	});
});

test("pending-message polling swallows only a stale context error", () => {
	withManualTimeouts((fireNext) => {
		let calls = 0;
		const ctx = {
			hasPendingMessages: () => {
				calls += 1;
				if (calls === 1) return true;
				throw new Error("extension ctx is stale");
			},
		} as unknown as ExtensionContext;
		const gate = createPendingMessagesGate({ notify: () => {}, terminal: () => {} });

		gate.runWhenClear(ctx, "retry", () => {});
		fireNext();

		assert.equal(gate.hasPending(), true);
		gate.cancel();
		assert.equal(gate.hasPending(), false);
	});
});

test("delayAlreadyElapsed bypasses exactly one selected retry delay", async () => {
	let promptCount = 0;
	const notices: string[] = [];
	const agent = attachAgent([retryErrorMessage("context overflow")]);
	agent.prompt = async () => {
		promptCount++;
	};
	const engine = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 1,
		baseDelayMs: 60_000,
		maxDelayMs: 60_000,
		isStillRetryable: () => true,
		delayMsForError: () => 60_000,
		notify: (message) => notices.push(message),
	});

	engine.trigger({ delayAlreadyElapsed: true });
	await waitForIdle(engine);

	assert.equal(promptCount, 1);
	assert.equal(
		notices.some((message) => message.includes("waiting 0s")),
		true,
	);
});

test("terminal cancel in preRetryHook sends zero further prompt calls even with maxAttempts=0", async () => {
	let promptCount = 0;
	let engine: RetryEngine;
	const agent = attachAgent([retryErrorMessage("prompt too long")]);
	agent.prompt = async () => {
		promptCount++;
	};

	engine = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 0,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: () => true,
		preRetryHook: async () => engine.cancel(),
	});

	engine.trigger();
	await waitForIdle(engine);
	assert.equal(promptCount, 0);
});

test("maxAttempts=0 keeps retrying stable rate-limit errors until explicitly cancelled", async () => {
	let promptCount = 0;
	let engine: RetryEngine;
	const agent = attachAgent([retryErrorMessage("429 rate limit")]);
	agent.prompt = async () => {
		promptCount++;
		agent.state.messages.push(retryErrorMessage("429 rate limit"));
		if (promptCount === 3) engine.cancel();
	};

	engine = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 0,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: () => true,
	});

	engine.trigger();
	await waitForIdle(engine);
	assert.equal(promptCount, 3);
});

test("sleepUntilRetry uses one abortable delay and deterministic cleanup", async () => {
	const startedAt = Date.now();
	const cancelled = await sleepUntilRetry(10, () => false);
	const elapsed = Date.now() - startedAt;

	assert.equal(cancelled, false);
	assert.ok(elapsed < 80, `10ms retry delay should not round up to 100ms: ${elapsed}ms`);

	const controller = new AbortController();
	const pending = sleepUntilRetry(10_000, () => false, controller.signal);
	controller.abort();
	assert.equal(await pending, true);
});

// Reported concern: engineIsDriving is a MODULE-GLOBAL boolean, not scoped
// per-engine-instance. Each engine method's `finally` only clears it when
// `generation === myGeneration` (agent-retry.ts:160, :247). A session
// reset (retry.ts's resetSession -> engine.newGeneration()) bumps the
// generation while a retry loop from the PRIOR generation is still
// in-flight (e.g. blocked mid-await inside a slow preRetryHook/compact).
// When that stale operation's async work finally settles, its `finally`
// sees generation !== myGeneration and refuses to clear engineIsDriving —
// permanently wedging the lock for every future trigger()/
// regenerateLengthOverflow() call on this engine, since a fresh
// newGeneration() bump does not reset the boolean either. This must NOT
// happen: a generation change should hand the lock back for the new
// generation to use.
test("two retry-engine instances do not treat another engine's generation 0 lock as their own", async () => {
	let releaseFirstHook: (() => void) | undefined;
	const agent = attachAgent([retryErrorMessage("rate limit exceeded")]);
	let promptCount = 0;
	agent.prompt = async () => {
		promptCount++;
	};

	const first = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 1,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: () => true,
		preRetryHook: () =>
			new Promise<void>((resolve) => {
				releaseFirstHook = resolve;
			}),
	});
	const second = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 1,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: () => true,
	});

	first.trigger();
	const hookArmedDeadline = Date.now() + 2000;
	while (!releaseFirstHook && Date.now() < hookArmedDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(releaseFirstHook, "first engine must hold the retry lock");

	second.trigger();
	await waitForIdle(second);
	assert.equal(promptCount, 1);

	first.cancel();
	releaseFirstHook();
	await waitForIdle(first);
});

test("newGeneration() while trigger() is in flight must not permanently wedge engineIsDriving for later generations", async () => {
	let releaseSlowHook: (() => void) | undefined;
	let hookCalls = 0;
	const agent = attachAgent([retryErrorMessage("rate limit exceeded")]);
	agent.prompt = async () => {
		agent.state.messages.push(retryErrorMessage("rate limit exceeded"));
	};

	const engine = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 0,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: () => true,
		// Simulates a slow preRetryHook (e.g. a real compact() await) that is
		// still pending when the session gets reset out from under it. Only
		// the FIRST (abandoned) generation's call hangs; a later generation's
		// own retry loop must be able to make progress through this same
		// hook without also hanging, or this test could not tell "the lock
		// is free" apart from "the hook never resolves".
		preRetryHook: () => {
			hookCalls++;
			if (hookCalls === 1) {
				return new Promise<void>((resolve) => {
					releaseSlowHook = resolve;
				});
			}
			return Promise.resolve();
		},
	});

	engine.trigger();

	// Let the engine reach the in-flight preRetryHook await.
	const hookArmedDeadline = Date.now() + 2000;
	while (!releaseSlowHook && Date.now() < hookArmedDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(releaseSlowHook, "engine must reach the in-flight preRetryHook");
	assert.equal(engine.isDriving(), true);

	// Simulate retry.ts's resetSession(): a new session generation begins
	// while the old generation's retry loop is still parked in the hook.
	engine.newGeneration();
	engine.cancel();

	// The abandoned generation's hook now settles; let its `finally` drain.
	releaseSlowHook?.();
	await new Promise((resolve) => setTimeout(resolve, 20));

	// Prove the lock is actually usable, not just numerically false: a
	// fresh trigger() on the new generation must be able to drive a retry
	// to completion, not silently no-op because the module-global lock is
	// still (incorrectly) held by the abandoned generation.
	let promptCountAfterReset = 0;
	agent.prompt = async () => {
		promptCountAfterReset++;
		agent.state.messages.push(retryErrorMessage("rate limit exceeded"));
		if (promptCountAfterReset === 1) engine.cancel();
	};
	engine.trigger();
	await waitForIdle(engine);
	assert.equal(
		promptCountAfterReset,
		1,
		"a new generation must still be able to drive a retry after the prior generation released the lock",
	);
});

// Reported concern: registerRetryCommand's manual "/retry" handler
// (retry-command.ts) does `engine.cancel()` immediately followed by
// `triggerRetry(ctx)` (-> engine.trigger()), in the SAME synchronous tick,
// with no generation bump. If the engine is already driving (parked
// mid-preRetryHook from an earlier automatic retry), cancel() only flips
// the shared `cancelled` flag — the in-flight operation's lock release
// happens later, in its own `finally`, once it notices `cancelled` and
// unwinds. The synchronously-following trigger() call sees the lock still
// held and silently no-ops: the old run's abandonment is real (it will
// exit on its next check), but the NEW retry intent triggered by the user
// is simply dropped on the floor, with no error, no retry, and no restart
// of the loop once the old run finishes unwinding.
test("cancel() immediately followed by trigger() in the same tick must not silently drop the new retry intent", async () => {
	let releaseSlowHook: (() => void) | undefined;
	let hookCalls = 0;
	const agent = attachAgent([retryErrorMessage("rate limit exceeded")]);
	let promptCount = 0;
	agent.prompt = async () => {
		promptCount++;
		agent.state.messages.push(retryErrorMessage("rate limit exceeded"));
		if (promptCount === 1) engine.cancel();
	};

	const engine = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 0,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: () => true,
		preRetryHook: () => {
			hookCalls++;
			if (hookCalls === 1) {
				return new Promise<void>((resolve) => {
					releaseSlowHook = resolve;
				});
			}
			return Promise.resolve();
		},
	});

	engine.trigger();

	const hookArmedDeadline = Date.now() + 2000;
	while (!releaseSlowHook && Date.now() < hookArmedDeadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(releaseSlowHook, "engine must reach the in-flight preRetryHook");

	// This mirrors retry-command.ts's manual /retry handler exactly:
	// cancel() then trigger() synchronously, same generation.
	engine.cancel();
	engine.trigger();

	// Now let the abandoned first run's hook resolve and unwind.
	releaseSlowHook?.();

	await waitForIdle(engine);
	assert.equal(
		promptCount,
		1,
		"the user's manual /retry (cancel-then-trigger) must still result in exactly one real retry attempt, not zero",
	);
});

// Reported concern: regenerateLengthOverflow() drops the trailing assistant
// message BEFORE calling agent.prompt([]). The old comment claimed "prompt
// failure leaves the truncated turn in place" — but the drop already
// happened by then, so a prompt() failure actually LEFT THE MESSAGE
// PERMANENTLY GONE from the transcript, contradicting the comment and
// silently losing a real transcript entry.
test("a queued trigger preserves its detached overflow error after the active drive finishes", async () => {
	let releaseSlowHook: (() => void) | undefined;
	let hookCalls = 0;
	let promptCount = 0;
	const agent = attachAgent([retryErrorMessage("prompt is too long")]);
	const engine = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 1,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: (message) => message === "prompt is too long",
		preRetryHook: () => {
			hookCalls++;
			if (hookCalls !== 1) return Promise.resolve();
			return new Promise<void>((resolve) => {
				releaseSlowHook = resolve;
			});
		},
	});
	agent.prompt = async () => {
		promptCount++;
		if (promptCount === 1) {
			agent.state.messages = [{ role: "user", content: "continue" }] as AgentMessage[];
			return;
		}
		engine.cancel();
	};

	engine.trigger();
	const armed = Date.now() + 2000;
	while (!releaseSlowHook && Date.now() < armed) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(releaseSlowHook, "the first drive must reach the held retry hook");

	engine.trigger({ fallbackErrorMessage: "prompt is too long" });
	releaseSlowHook();
	await waitForIdle(engine);

	assert.equal(
		promptCount,
		2,
		"the queued drive must use its detached overflow error after the prior drive leaves a user tail",
	);
});

test("regenerateLengthOverflow restores the dropped trailing message if agent.prompt() fails", async () => {
	const tinyMessage = {
		role: "assistant",
		stopReason: "length",
		content: [{ type: "text", text: "x" }],
	} as AgentMessage;
	const agent = attachAgent([tinyMessage]);
	agent.prompt = async () => {
		throw new Error("provider unreachable");
	};

	const engine = createRetryEngine({
		getAgent: () => agent,
		continuation: continuationFor(agent),
		drivingLock: createStandaloneRetryDrivingLock(),
		maxAttempts: () => 0,
		baseDelayMs: 0,
		maxDelayMs: 0,
		isStillRetryable: () => true,
	});

	engine.regenerateLengthOverflow();

	const deadline = Date.now() + 2000;
	while (engine.isDriving() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}

	assert.deepEqual(
		agent.state.messages,
		[tinyMessage],
		"a failed prompt() must restore the dropped trailing message instead of silently losing it from the transcript",
	);
});

test("retry driving locks are owner-scoped, so stale async releases cannot clear a newer run", () => {
	const lock = createStandaloneRetryDrivingLock();
	const oldOwner = Symbol("old run");
	const newOwner = Symbol("new run");

	assert.equal(lock.acquire(oldOwner), true);
	assert.equal(lock.isHeld(oldOwner), true);
	assert.equal(lock.acquire(newOwner), false);

	lock.release(oldOwner);
	assert.equal(lock.acquire(newOwner), true);
	assert.equal(lock.isHeld(newOwner), true);

	lock.release(oldOwner);
	assert.equal(lock.isHeld(newOwner), true, "a stale release from an old run must not clear the current owner");

	lock.release(newOwner);
	assert.equal(lock.isHeld(), false);
});

test("a denied recovery budget reports exhaustion without calling the provider", async () => {
	let promptCount = 0;
	let exhaustedCount = 0;
	const notices: Array<{ message: string; level: string | undefined }> = [];
	const agent = attachAgent([retryErrorMessage("provider error")]);
	agent.prompt = async () => {
		promptCount += 1;
	};
	const engine = createTestRetryEngine(agent, {
		consumeRecoveryAttempt: () => ({ allowed: false, attempt: 1, limit: 1 }),
		notify: (message, level) => notices.push({ message, level }),
		onRetriesExhausted: () => {
			exhaustedCount += 1;
		},
	});

	engine.trigger();
	await waitForIdle(engine);

	assert.equal(promptCount, 0);
	assert.equal(exhaustedCount, 1);
	assert.equal(notices[0]?.level, "error");
	assert.match(notices[0]?.message ?? "", /Automatic recovery stopped/);
});

test("a rejected pre-retry hook does not prevent the recovery attempt", async () => {
	let promptCount = 0;
	const agent = attachAgent([retryErrorMessage("provider error")]);
	agent.prompt = async () => {
		promptCount += 1;
	};
	const engine = createTestRetryEngine(agent, {
		preRetryHook: async () => {
			throw new Error("hook unavailable");
		},
	});

	engine.trigger();
	await waitForIdle(engine);

	assert.equal(promptCount, 1);
});

type StopScenario = {
	reason: RetryStopReason;
	continuation: (engine: () => RetryEngine | undefined) => RetryContinuationPort;
	overrides?: (engine: () => RetryEngine | undefined) => Partial<Parameters<typeof createRetryEngine>[0]>;
};

const stopScenarios: readonly StopScenario[] = [
	{
		reason: "continuation_superseded",
		continuation: () => ({
			async continueCurrent() {
				return "superseded";
			},
		}),
	},
	{
		reason: "continuation_unavailable",
		continuation: () => ({
			async continueCurrent() {
				return "unavailable";
			},
		}),
	},
	{
		reason: "continuation_failed",
		continuation: () => ({
			async continueCurrent() {
				throw new Error("transport closed");
			},
		}),
	},
	{
		reason: "cancelled_during_delay",
		continuation: () => ({
			async continueCurrent() {
				return "completed";
			},
		}),
		overrides: (engine) => ({
			delayMsForError: () => 60_000,
			notify: (message) => {
				if (message.startsWith("Retry attempt")) engine()?.cancel();
			},
		}),
	},
	{
		reason: "stale_after_hook",
		continuation: () => ({
			async continueCurrent() {
				return "completed";
			},
		}),
		overrides: (engine) => ({
			preRetryHook: async () => {
				engine()?.cancel();
			},
		}),
	},
	{
		reason: "cancelled_before_attempt",
		continuation: (engine) => ({
			async continueCurrent() {
				engine()?.cancel();
				return "completed";
			},
		}),
	},
];

for (const scenario of stopScenarios) {
	test(`a ${scenario.reason} stop after an announced retry shows its visible notice`, async () => {
		let promptCount = 0;
		const notices: Array<{ message: string; level: string | undefined }> = [];
		let engineRef: RetryEngine | undefined;
		const agent = attachAgent([retryErrorMessage("WebSocket error")]);
		agent.prompt = async () => {
			promptCount += 1;
		};
		const overrides = scenario.overrides?.(() => engineRef) ?? {};
		const engine = createTestRetryEngine(agent, {
			continuation: scenario.continuation(() => engineRef),
			...overrides,
			notify: (message, level) => {
				notices.push({ message, level });
				overrides.notify?.(message, level);
			},
		});
		engineRef = engine;

		engine.trigger();
		await waitForIdle(engine);

		const stopNotices = notices.filter((notice) => notice.level === "warning");
		assert.deepEqual(
			stopNotices.map((notice) => notice.message),
			[RETRY_STOP_NOTICE[scenario.reason]],
		);
		assert.ok(promptCount <= 1, "a stopped recovery must not dispatch more than one provider request");
	});
}

test("every stop reason has a scenario that proves its visible notice", () => {
	assert.deepEqual(stopScenarios.map((scenario) => scenario.reason).sort(), [...RETRY_STOP_REASONS].sort());
});

test("a non-retryable error stops silently without a stop notice", async () => {
	const notices: Array<{ message: string; level: string | undefined }> = [];
	const agent = attachAgent([retryErrorMessage("invalid api key")]);
	const engine = createTestRetryEngine(agent, {
		isStillRetryable: () => false,
		notify: (message, level) => notices.push({ message, level }),
	});

	engine.trigger();
	await waitForIdle(engine);

	assert.deepEqual(notices, []);
});

test("a cancel before any announced attempt stays silent", async () => {
	const notices: Array<{ message: string; level: string | undefined }> = [];
	const agent = attachAgent([retryErrorMessage("WebSocket error")]);
	let engineRef: RetryEngine | undefined;
	agent.waitForIdle = async () => {
		engineRef?.cancel();
	};
	const engine = createTestRetryEngine(agent, {
		notify: (message, level) => notices.push({ message, level }),
	});
	engineRef = engine;

	engine.trigger();
	await waitForIdle(engine);

	assert.deepEqual(
		notices.filter((notice) => notice.level === "warning"),
		[],
	);
});
