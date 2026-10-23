import assert from "node:assert/strict";
import test from "node:test";
import { createErrorRuleEngine, extractStatusCode, pacingDelayMs } from "../src/error-rule-engine.ts";
import { DEFAULT_CONFIG } from "../src/retry-config-defaults.ts";
import { resolveErrorRules } from "../src/retry-config-normalize.ts";
import type { ResolvedRetryRule } from "../src/retry-policy-types.ts";

const engine = createErrorRuleEngine(resolveErrorRules(DEFAULT_CONFIG.retry, DEFAULT_CONFIG.retry.smart_overrides));

test("extractStatusCode finds standalone codes and ignores counts", () => {
	assert.equal(extractStatusCode('OpenAI API error (403): 403 "out of credits"'), 403);
	assert.equal(extractStatusCode("Error: 429"), 429);
	assert.equal(extractStatusCode("OMLX: 75,403 tokens exceeds max context window"), undefined);
	assert.equal(extractStatusCode("requested 8192 tokens"), undefined);
	assert.equal(extractStatusCode("socket hang up"), undefined);
});

test("codes and words pair; the first matching override row wins in table order", () => {
	// Grok's out-of-credits 403 — the 2026-08-19 incident that motivated the table.
	const grok = 'Error: OpenAI API error (403): 403 "You have run out of credits or need a Grok subscription."';
	const match = engine.resolve(grok);
	assert.equal(match.rule, "smart override 2");
	assert.equal(match.pacing.max_attempts, 0);

	// Matches override 2 by code and by words ("rate limit") — same row wins either way.
	assert.equal(engine.resolve("403 rate limit exceeded").rule, "smart override 2");
});

test("later matching rules override only the properties they define", () => {
	const rules = resolveErrorRules(
		{
			max_attempts: 5,
			seconds_before_first_retry: 16,
			multiplier_between_attempts: 2,
			max_seconds_between_attempts: 1000,
		},
		[
			{ when: { words: ["provider"] }, max_attempts: 2, seconds_before_first_retry: 3 },
			{ when: { words: ["rate"] }, multiplier_between_attempts: 4, max_seconds_between_attempts: 9 },
		],
	);
	const match = createErrorRuleEngine(rules).resolve("provider rate limit");
	assert.equal(match.pacing.max_attempts, 2);
	assert.equal(match.pacing.seconds_before_first_retry, 3);
	assert.equal(match.pacing.multiplier_between_attempts, 4);
	assert.equal(match.pacing.max_seconds_between_attempts, 9);
});

test("matched rules return their ordered fallback chain", () => {
	const rules = resolveErrorRules(
		DEFAULT_CONFIG.retry,
		[
			{
				when: { words: ["wedged"] },
				max_attempts: 0,
				fallback_models: ["openai/gpt-5", "anthropic/claude"],
			},
		],
		true,
	);
	const match = createErrorRuleEngine(rules).resolve("model wedged");
	assert.deepEqual(match.fallbackModels, ["openai/gpt-5", "anthropic/claude"]);
});

test("429 is never retried and keeps baseline pacing", () => {
	const match = engine.resolve("429 Too Many Requests");
	assert.equal(match.rule, "smart override 2");
	// Override 2 declares only max_attempts; every pacing field inherits the baseline.
	assert.deepEqual(match.pacing, {
		seconds_before_first_retry: 16,
		multiplier_between_attempts: 2,
		max_attempts: 0,
		max_seconds_between_attempts: 1000,
	});
});

test("overflow words resolve to the overflow override row", () => {
	const match = engine.resolve("context length exceeded");
	assert.equal(match.rule, "smart override 4");
	assert.equal(match.pacing.seconds_before_first_retry, 5);
});

test("never-retry words stop at zero attempts", () => {
	assert.equal(engine.resolve("invalid api key").rule, "smart override 3");
	assert.equal(engine.resolve("invalid api key").pacing.max_attempts, 0);
});

test("words_match all requires every word (inline fixture)", () => {
	const rows: readonly ResolvedRetryRule[] = [
		{
			rule: "both words",
			when: { words: ["limit", "access"], words_match: "all" },
			max_attempts: 3,
			seconds_before_first_retry: 1,
			multiplier_between_attempts: 2,
			max_seconds_between_attempts: 60,
			fallbackModels: [],
		},
		{
			rule: "default",
			max_attempts: 5,
			seconds_before_first_retry: 16,
			multiplier_between_attempts: 2,
			max_seconds_between_attempts: 1000,
			fallbackModels: [],
		},
	];
	const custom = createErrorRuleEngine(rows);
	assert.equal(custom.resolve("access limit reached for this key").rule, "both words");
	assert.notEqual(custom.resolve("token limit exceeded").rule, "both words");
});

test("a status code no row lists resolves to the baseline (no hidden tiers)", () => {
	// Spec: classification and pacing use exactly the configured rows plus the
	// baseline catch-all — no engine-owned HTTP-class rule participates.
	const bare = engine.resolve("Error: 400");
	assert.equal(bare.source, "catch_all");
	assert.equal(bare.rule, "default");
	assert.equal(bare.pacing.max_attempts, 5);

	const teapot = engine.resolve("Error: 418");
	assert.equal(teapot.source, "catch_all");
	assert.deepEqual(teapot.pacing, {
		seconds_before_first_retry: 16,
		multiplier_between_attempts: 2,
		max_attempts: 5,
		max_seconds_between_attempts: 1000,
	});

	const unknown = engine.resolve("prefill_quantization_mismatch: KV head count differs");
	assert.equal(unknown.source, "catch_all");
	assert.equal(unknown.rule, "default");
});

test("time-heals codes and wording retry without limit on the baseline curve", () => {
	for (const message of [
		"Error: 503",
		"terminated",
		"WebSocket closed 1012",
		"Our servers are currently overloaded",
	]) {
		const match = engine.resolve(message);
		assert.equal(match.rule, "smart override 1", message);
		assert.deepEqual(
			match.pacing,
			{
				seconds_before_first_retry: 16,
				multiplier_between_attempts: 2,
				max_attempts: Number.POSITIVE_INFINITY,
				max_seconds_between_attempts: 1000,
			},
			message,
		);
	}
	assert.equal(engine.resolve("429 rate limit, service unavailable").pacing.max_attempts, 0);
});

test("pacing law: first × multiplier^(attempt-1), capped by the row's own max_seconds_between_attempts", () => {
	const memory = engine.resolve("prefill_memory_exceeded").pacing;
	assert.equal(pacingDelayMs(memory, 1), 30_000);
	assert.equal(pacingDelayMs(memory, 2), 60_000);

	const steep = {
		seconds_before_first_retry: 300,
		multiplier_between_attempts: 4,
		max_attempts: 5,
		max_seconds_between_attempts: 400,
	};
	assert.equal(pacingDelayMs(steep, 1), 300_000);
	assert.equal(pacingDelayMs(steep, 2), 400_000); // row cap, not a global ceiling
});

test('max_attempts "unlimited" resolves to Infinity attempts', () => {
	const rows: readonly ResolvedRetryRule[] = [
		{
			rule: "endless",
			when: { words: ["persist"] },
			max_attempts: "unlimited",
			seconds_before_first_retry: 1,
			multiplier_between_attempts: 1,
			max_seconds_between_attempts: 5,
			fallbackModels: [],
		},
		{
			rule: "default",
			max_attempts: 5,
			seconds_before_first_retry: 16,
			multiplier_between_attempts: 2,
			max_seconds_between_attempts: 1000,
			fallbackModels: [],
		},
	];
	const custom = createErrorRuleEngine(rows);
	assert.equal(custom.maxAttemptsFor("persist, please"), Number.POSITIVE_INFINITY);
});

test("maxAttemptsForRuleName covers rows and unknowns via the catch-all", () => {
	assert.equal(engine.maxAttemptsForRuleName("smart override 1"), Number.POSITIVE_INFINITY);
	assert.equal(engine.maxAttemptsForRuleName("smart override 2"), 0);
	assert.equal(engine.maxAttemptsForRuleName("default"), 5);
	assert.equal(engine.maxAttemptsForRuleName("never heard of it"), 5);
});

test("a table without a catch-all row is rejected", () => {
	assert.throws(
		() =>
			createErrorRuleEngine([
				{
					rule: "x",
					when: { error_codes: [500] },
					max_attempts: 1,
					seconds_before_first_retry: 1,
					multiplier_between_attempts: 2,
					max_seconds_between_attempts: 60,
					fallbackModels: [],
				},
			]),
		/catch-all/,
	);
});
