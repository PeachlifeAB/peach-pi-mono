import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { retryConfigSchemaPath, retryConfigSchemaText } from "../scripts/gen-retry-config-schema.ts";
import { normalizeRetryConfig } from "../src/retry-config-normalize.ts";
import {
	DEFAULT_CONFIG,
	formatRetryConfigError,
	retryConfigJsonSchema,
	retryConfigSchema,
} from "../src/retry-config-schema.ts";

test("accepts the canonical instance", () => {
	assert.equal(retryConfigSchema.safeParse(DEFAULT_CONFIG).success, true);
});

test("accepts every optional boundary", () => {
	assert.equal(
		retryConfigSchema.safeParse({
			retry: {
				max_attempts: "unlimited",
				smart_overrides: [
					{ when: { words: ["x"] }, max_attempts: 0, fallback_models: ["openai/gpt-5", "anthropic/claude"] },
				],
			},
			memory_overflow_protection: {
				compaction: {
					enabled: true,
					dynamic: { enabled: true, at_context_ratio: 0.8 },
					forced: {
						enabled: true,
						wait_seconds_before_first_attempt: 30,
						max_attempts: 2,
						warn_after_seconds: 600,
						give_up_after_no_progress_seconds: 180,
						give_up_confirm_seconds: 480,
					},
				},
				prune: { enabled: true, max_attempts: 1, removal_fractions: [0.25, 0.5] },
			},
			model_fallback: { enabled: true, max_hops: 7 },
			warnings: { provider_silence_seconds: 0 },
			debug: { path: "./debug.log" },
		}).success,
		true,
	);
});

test("model fallback boundaries stay strict and canonical", () => {
	for (const config of [
		{ model_fallback: { enabled: true, nope: true } },
		{ nope: { enabled: true } },
		{ retry: { smart_overrides: [{ when: { words: ["x"] }, max_attempts: 0, fallback_models: [] }] } },
		{ retry: { smart_overrides: [{ when: { words: ["x"] }, max_attempts: 0, fallback_models: ["bare-model"] }] } },
		{ retry: { smart_overrides: [{ when: { words: ["x"] }, max_attempts: 0, fallback_models: ["/missing"] }] } },
		{ retry: { smart_overrides: [{ when: { words: ["x"] }, max_attempts: 0, fallback_models: ["provider/"] }] } },
		{
			retry: {
				smart_overrides: [
					{ when: { words: ["x"] }, max_attempts: 0, fallback_models: ["provider/model"], nope: true },
				],
			},
		},
	])
		assert.equal(retryConfigSchema.safeParse(config).success, false);
});

test("rejects removed keys and invalid states", () => {
	for (const config of [
		{ version: 1 },
		{ automaticRecovery: {} },
		{ retry: { reset_after_streamed_tokens: 0 } },
		{ retry: { smart_overrides: [{ when: { words: ["x"] }, reset_after_streamed_tokens: 5 }] } },
		{ debug: { enabled: true } },
		{ hooks: { unknown: { after_seconds: 1, command: "true" } } },
		{ retry: { smart_overrides: [{ when: {}, max_attempts: 1 }] } },
		{ retry: { smart_overrides: [{ when: { words: ["x"] } }] } },
		{ memory_overflow_protection: { dynamic_compaction: { at_context_ratio: 0.8 } } },
		{ memory_overflow_protection: { compaction: { forced: { max_attempts: 0 } } } },
		{ memory_overflow_protection: { compaction: { forced: { experimental: { prune: {} } } } } },
		{ memory_overflow_protection: { compaction: { forced: { give_up_waiting: {} } } } },
		{ memory_overflow_protection: { prune: { max_pruning_attempts: 0 } } },
		{ memory_overflow_protection: { compaction: { dynamic: true } } },
	])
		assert.equal(retryConfigSchema.safeParse(config).success, false);
});

test("the runtime refinement rejects unordered fractions", () => {
	const result = retryConfigSchema.safeParse({
		memory_overflow_protection: { prune: { removal_fractions: [0.5, 0.25] } },
	});
	assert.equal(result.success, true);
	if (result.success) assert.throws(() => normalizeRetryConfig(result.data));
});

test("format errors and generated schema remain current", () => {
	const parsed = retryConfigSchema.safeParse({ nope: true });
	assert.equal(parsed.success, false);
	if (!parsed.success) assert.match(formatRetryConfigError(parsed.error), /nope/);
	assert.equal(retryConfigJsonSchema.type, "object");
	assert.equal(readFileSync(retryConfigSchemaPath, "utf8"), retryConfigSchemaText);
});

test("accepts underscore-prefixed metadata at every configuration boundary", () => {
	const result = retryConfigSchema.safeParse({
		_comment: { purpose: "provider recovery", values: [1, true, null] },
		retry: {
			_notes: ["documented inline"],
			smart_overrides: [
				{
					_rule: { provider: "oMLX" },
					when: { words: ["rate limit"], _error_codes: "provider-specific meanings" },
					max_attempts: 1,
				},
			],
		},
	});
	assert.equal(result.success, true);
});

test("accepts every retry behavior property in a smart override", () => {
	const result = retryConfigSchema.safeParse({
		retry: {
			max_attempts: 900,
			seconds_before_first_retry: 1,
			multiplier_between_attempts: 3,
			max_seconds_between_attempts: 12,
			smart_overrides: [
				{
					when: { words: ["rate limit"] },
					max_attempts: 900,
					seconds_before_first_retry: 2,
					multiplier_between_attempts: 4,
					max_seconds_between_attempts: 24,
					fallback_models: ["openai/backup"],
				},
			],
		},
	});
	assert.equal(result.success, true);
});

test("still rejects a typo in a non-metadata property", () => {
	const result = retryConfigSchema.safeParse({ retry: { error_codse: [429] } });
	assert.equal(result.success, false);
});

test("generated JSON Schema matches metadata and strict-key behavior", () => {
	const schema = JSON.parse(readFileSync(retryConfigSchemaPath, "utf8"));
	const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
	const valid = {
		_comment: { purpose: "provider recovery", values: [1, true, null] },
		retry: {
			_notes: ["documented inline"],
			smart_overrides: [{ when: { words: ["rate limit"], _error_codes: { provider: "oMLX" } }, max_attempts: 1 }],
		},
	};
	assert.equal(validate(valid), true);
	assert.equal(
		validate({ retry: { smart_overrides: [{ when: { words: ["x"] }, error_codse: [429], max_attempts: 1 }] } }),
		false,
	);
});
