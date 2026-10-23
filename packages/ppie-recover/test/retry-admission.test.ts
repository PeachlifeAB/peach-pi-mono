import assert from "node:assert/strict";
import test from "node:test";
import { createRetryAdmission } from "../src/retry-admission.ts";
import { DEFAULT_CONFIG } from "../src/retry-config-defaults.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";

const admission = (fragment?: Parameters<typeof resolveRetryPolicy>[0]) =>
	createRetryAdmission({
		policy: resolveRetryPolicy(fragment),
	});

const overflowOverride = DEFAULT_CONFIG.retry.smart_overrides.find((row) =>
	row.when.words?.includes("prefill_memory_exceeded"),
);
const overflowWord = overflowOverride?.when.words?.find((word) => word === "prefill_memory_exceeded");

test("overflow matching a smart override uses that row's max_attempts", () => {
	assert.ok(overflowOverride);
	assert.ok(overflowWord);
	const gate = admission();
	assert.equal(gate.maxAttemptsFor(`400 ${overflowWord}`), overflowOverride.max_attempts);
	assert.equal(gate.neverRetries(`400 ${overflowWord}`), overflowOverride.max_attempts === 0);
});

test("unmatched overflow falls back to retry.max_attempts", () => {
	const gate = admission();
	assert.equal(gate.maxAttemptsFor("predicted peak would require 12 GB"), DEFAULT_CONFIG.retry.max_attempts);
	assert.equal(gate.neverRetries("predicted peak would require 12 GB"), false);
});

test("resolved overflow max_attempts 0 never retries", () => {
	const gate = admission({
		retry: {
			smart_overrides: [{ when: { words: ["overflow"] }, max_attempts: 0 }],
		},
	});
	assert.equal(gate.maxAttemptsFor("context overflow"), 0);
	assert.equal(gate.neverRetries("context overflow"), true);
	assert.equal(gate.isStillRetryable("context overflow"), false);
});

test("admission exposes the first matched fallback chain", () => {
	const gate = admission({
		model_fallback: { enabled: true },
		retry: {
			smart_overrides: [
				{ when: { words: ["unavailable"] }, max_attempts: 0, fallback_models: ["anthropic/backup"] },
			],
		},
	});
	assert.deepEqual(gate.fallbackModelsFor("model unavailable"), ["anthropic/backup"]);
	assert.deepEqual(gate.fallbackModelsFor("other error"), []);
});
