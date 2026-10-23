import assert from "node:assert/strict";
import test from "node:test";
import { createErrorRuleEngine } from "../src/error-rule-engine.ts";
import { DEFAULT_RETRY_POLICY, resolveRetryPolicy } from "../src/retry-policy.ts";

test("missing config resolves exactly to the shipped defaults", () => {
	assert.deepEqual(resolveRetryPolicy(), DEFAULT_RETRY_POLICY);
	assert.equal(DEFAULT_RETRY_POLICY.defaultRetry.max_attempts, 5);
	assert.equal(DEFAULT_RETRY_POLICY.defaultRetry.seconds_before_first_retry, 16);
	assert.equal(DEFAULT_RETRY_POLICY.fallbackCompactionMaxAttempts, 2);
	assert.equal(DEFAULT_RETRY_POLICY.trimPayloadOnMemoryOverflow, false);
	assert.ok(Object.isFrozen(DEFAULT_RETRY_POLICY));
	assert.ok(Object.isFrozen(DEFAULT_RETRY_POLICY.errorRules));
});

test("configured values override only their direct boundary", () => {
	const policy = resolveRetryPolicy({
		retry: {
			max_attempts: "unlimited",
			seconds_before_first_retry: 1,
		},
		memory_overflow_protection: {
			compaction: {
				enabled: true,
				forced: {
					enabled: true,
					max_attempts: 2,
				},
			},
			prune: { enabled: true, removal_fractions: [0.25, 0.5] },
		},
		warnings: { provider_silence_seconds: 0 },
		debug: { path: "relative.log" },
	});
	assert.equal(policy.defaultRetry.max_attempts, "unlimited");
	assert.equal(policy.temporaryRetryFirstDelayMs, 1000);
	assert.equal(policy.fallbackCompactionMaxAttempts, 2);
	assert.equal(policy.providerSilentWarningMs, undefined);
	assert.equal(policy.debugLogPath, "relative.log");
	assert.ok(Object.isFrozen(policy));
});

test("every compaction timing resolves from configuration, never from a source literal", () => {
	const policy = resolveRetryPolicy({
		memory_overflow_protection: {
			compaction: {
				enabled: true,
				forced: {
					enabled: true,
					wait_seconds_before_first_attempt: 7,
					warn_after_seconds: 11,
					give_up_after_no_progress_seconds: 13,
					give_up_confirm_seconds: 17,
				},
			},
		},
	});
	assert.equal(policy.forcedCompactionWaitMs, 7000);
	assert.equal(policy.compactionWarningMs, 11_000);
	assert.equal(policy.compactionStallCheckMs, 13_000);
	assert.equal(policy.compactionStallRetryMs, 17_000);
});

test("the give-up sequence keeps two independent observation windows", () => {
	// Compaction ships enabled, so the shipped policy arms both windows.
	assert.equal(DEFAULT_RETRY_POLICY.compactionStallCheckMs, 180_000);
	assert.equal(DEFAULT_RETRY_POLICY.compactionStallRetryMs, 480_000);
	const enabled = resolveRetryPolicy({
		memory_overflow_protection: { compaction: { enabled: true, forced: { enabled: true } } },
	});
	assert.equal(enabled.compactionStallCheckMs, 180_000);
	assert.ok(enabled.compactionStallRetryMs > 0, "the confirmation window must not collapse to zero");
	assert.equal(enabled.compactionStallRetryMs, 480_000);
});

test("a zero warning threshold disables the advisory without touching the give-up windows", () => {
	const policy = resolveRetryPolicy({
		memory_overflow_protection: {
			compaction: { enabled: true, forced: { enabled: true, warn_after_seconds: 0 } },
		},
	});
	assert.equal(policy.compactionWarningMs, undefined);
	assert.equal(policy.compactionStallCheckMs, 180_000);
});

test("legacy config never receives a compatibility path", () => {
	assert.throws(() => resolveRetryPolicy({ version: 2, automaticRecovery: {} }), /invalid ppie-recover config/);
});

// Out-of-box admission: a user with no config gets these per-error outcomes.
const shipped = createErrorRuleEngine(DEFAULT_RETRY_POLICY.errorRules);
const admission = (message: string) => {
	const { pacing } = shipped.resolve(message);
	return { attempts: pacing.max_attempts, firstDelayS: pacing.seconds_before_first_retry };
};

test("cloud account and rate-limit failures are never retried by default", () => {
	for (const message of [
		"insufficient_quota: add credits",
		"429 rate limit exceeded",
		"Error: 429",
		'OpenAI API error (403): 403 "You have run out of credits"',
		"404 model not found",
	]) {
		assert.equal(admission(message).attempts, 0, message);
	}
});

test("time-heals transport failures retry without limit on the baseline curve by default", () => {
	for (const message of ["fetch failed", "500 internal server error", "service unavailable", "connection reset"]) {
		assert.deepEqual(admission(message), { attempts: Number.POSITIVE_INFINITY, firstDelayS: 16 }, message);
	}
});

test("context overflow recovers after only Pi core's first-compaction window by default", () => {
	assert.deepEqual(admission("Prompt too long: 190856 tokens exceeds max context window of 73728 tokens"), {
		attempts: 3,
		firstDelayS: 5,
	});
});

test("provider memory pressure waits for the server before recovering by default", () => {
	assert.deepEqual(admission("prefill_memory_exceeded: physical cap 45.8 GB"), { attempts: 3, firstDelayS: 30 });
});
