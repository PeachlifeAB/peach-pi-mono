import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createRetryEngine, type RetryEngine } from "../src/agent-retry.ts";
import { createRecoveryBudget } from "../src/recovery-budget.ts";
import { createRetryAdmission } from "../src/retry-admission.ts";
import { createStandaloneRetryDrivingLock } from "../src/retry-driving-lock.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";
import { RETRY_STOP_NOTICE } from "../src/retry-stop-notice.ts";

const failure: AssistantMessage = {
	role: "assistant",
	api: "openai-completions",
	provider: "fixture",
	model: "fixture",
	content: [],
	stopReason: "error",
	errorMessage: "policy-fixture failure",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 0,
};

const cases: ReadonlyArray<{
	name: string;
	override?: number | "unlimited";
	expectedDispatches: number;
	expectedLimit: number;
}> = [
	{ name: "unmatched errors use the finite default", expectedDispatches: 5, expectedLimit: 5 },
	{ name: "a finite matching rule owns its lower limit", override: 3, expectedDispatches: 3, expectedLimit: 3 },
	{ name: "zero explicitly forbids retries", override: 0, expectedDispatches: 0, expectedLimit: 0 },
	{
		name: "explicit unlimited overrides remain cancellable",
		override: "unlimited",
		expectedDispatches: 6,
		expectedLimit: Infinity,
	},
];

for (const scenario of cases) {
	test(scenario.name, async () => {
		const policy = resolveRetryPolicy({
			retry: {
				max_attempts: 5,
				...(scenario.override === undefined
					? {}
					: { smart_overrides: [{ when: { words: ["policy-fixture"] }, max_attempts: scenario.override }] }),
			},
		});
		const admission = createRetryAdmission({ policy });
		const budget = createRecoveryBudget(admission.maxAttemptsFor);
		const agent = new Agent({
			initialState: { messages: [failure] },
			streamFn: () => {
				throw new Error("The continuation port owns provider I/O in this test");
			},
		});
		const lock = createStandaloneRetryDrivingLock();
		const notifications: string[] = [];
		let dispatches = 0;
		let engine: RetryEngine;
		await new Promise<void>((resolve) => {
			engine = createRetryEngine({
				getAgent: () => agent,
				drivingLock: {
					...lock,
					release: (owner) => {
						lock.release(owner);
						resolve();
					},
				},
				continuation: {
					continueCurrent: async (_tail, prepare, isCurrent) => {
						if (isCurrent?.() === false) return "superseded";
						prepare();
						dispatches++;
						agent.state.messages.push(failure);
						if (scenario.override === "unlimited" && dispatches === scenario.expectedDispatches) engine.cancel();
						return "completed";
					},
				},
				maxAttempts: () => policy.maximumAttempts,
				consumeRecoveryAttempt: budget.consume,
				isStillRetryable: admission.isStillRetryable,
				preRetryHook: async (_attempt, message) => admission.consumeForRetry(message),
				baseDelayMs: 0,
				maxDelayMs: 0,
				notify: (message) => notifications.push(message),
			});
			engine.trigger();
		});
		assert.equal(dispatches, scenario.expectedDispatches);
		assert.equal(budget.used(), scenario.expectedDispatches);
		assert.equal(admission.maxAttemptsFor(failure.errorMessage), scenario.expectedLimit);
		const attemptNotices = notifications.filter((message) => message.startsWith("Retry attempt"));
		assert.equal(attemptNotices.length, scenario.expectedDispatches);
		if (scenario.override === "unlimited") {
			assert.equal(notifications.at(-1), RETRY_STOP_NOTICE.cancelled_before_attempt);
		}
		for (const [index, message] of attemptNotices.entries()) {
			const limitSuffix = Number.isFinite(scenario.expectedLimit) ? `/${scenario.expectedLimit}` : "";
			assert.equal(message, `Retry attempt ${index + 1}${limitSuffix} (waiting 0s)…`);
		}
	});
}

test("cancellation also retires triggers queued behind the active retry", async () => {
	const policy = resolveRetryPolicy();
	const admission = createRetryAdmission({ policy });
	const budget = createRecoveryBudget(admission.maxAttemptsFor);
	const agent = new Agent({
		initialState: { messages: [failure] },
		streamFn: () => {
			throw new Error("The continuation port owns provider I/O in this test");
		},
	});
	const lock = createStandaloneRetryDrivingLock();
	let engine: RetryEngine;
	await new Promise<void>((resolve) => {
		engine = createRetryEngine({
			getAgent: () => agent,
			drivingLock: {
				...lock,
				release: (owner) => {
					lock.release(owner);
					resolve();
				},
			},
			continuation: { continueCurrent: async () => "superseded" },
			maxAttempts: () => policy.maximumAttempts,
			consumeRecoveryAttempt: budget.consume,
			isStillRetryable: admission.isStillRetryable,
			baseDelayMs: 0,
			maxDelayMs: 0,
		});
		engine.trigger();
		engine.trigger();
		engine.cancel();
	});
	try {
		assert.equal(engine!.isDriving(), false);
		assert.equal(budget.used(), 0);
	} finally {
		engine!.cancel();
	}
});
