import assert from "node:assert/strict";
import test from "node:test";
import { retryConfigJsonSchema } from "../src/retry-config-schema.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";
import { DEFAULT_RETRY_POLICY } from "../src/retry-policy-default.ts";
import type { ResolvedRetryPolicy } from "../src/retry-policy-types.ts";

const on = (compaction: Record<string, unknown>) => ({
	memory_overflow_protection: { compaction: { enabled: true, ...compaction } },
});

const pruneOn = (prune: Record<string, unknown>) => ({
	memory_overflow_protection: { prune: { enabled: true, ...prune } },
});

type ConfigCase = Readonly<{
	userPath: string;
	fragment: Record<string, unknown>;
	read: (policy: ResolvedRetryPolicy) => unknown;
	defaultValue: unknown;
}>;

const CASES: readonly ConfigCase[] = [
	{
		userPath: "retry.max_attempts",
		fragment: { retry: { max_attempts: "unlimited" } },
		read: (policy) => policy.defaultRetry.max_attempts,
		defaultValue: DEFAULT_RETRY_POLICY.defaultRetry.max_attempts,
	},
	{
		userPath: "retry.seconds_before_first_retry",
		fragment: { retry: { seconds_before_first_retry: 1 } },
		read: (policy) => policy.temporaryRetryFirstDelayMs,
		defaultValue: DEFAULT_RETRY_POLICY.temporaryRetryFirstDelayMs,
	},
	{
		userPath: "retry.multiplier_between_attempts",
		fragment: { retry: { multiplier_between_attempts: 3 } },
		read: (policy) => policy.defaultRetry.multiplier_between_attempts,
		defaultValue: DEFAULT_RETRY_POLICY.defaultRetry.multiplier_between_attempts,
	},
	{
		userPath: "retry.max_seconds_between_attempts",
		fragment: { retry: { max_seconds_between_attempts: 1 } },
		read: (policy) => policy.temporaryRetryMaximumDelayMs,
		defaultValue: DEFAULT_RETRY_POLICY.temporaryRetryMaximumDelayMs,
	},
	{
		userPath: "retry.smart_overrides",
		fragment: { retry: { smart_overrides: [{ when: { error_codes: [418] }, max_attempts: 1 }] } },
		read: (policy) => policy.smartOverrides.length,
		defaultValue: DEFAULT_RETRY_POLICY.smartOverrides.length,
	},
	{
		userPath: "model_fallback.enabled",
		fragment: { model_fallback: { enabled: true } },
		read: (policy) => policy.fallbackEnabled,
		defaultValue: DEFAULT_RETRY_POLICY.fallbackEnabled,
	},
	{
		userPath: "model_fallback.max_hops",
		fragment: { model_fallback: { enabled: true, max_hops: 7 } },
		read: (policy) => policy.maxFallbackHops,
		defaultValue: DEFAULT_RETRY_POLICY.maxFallbackHops,
	},
	{
		userPath: "memory_overflow_protection.compaction.enabled",
		// Ships on; turning it off is the observable change.
		fragment: { memory_overflow_protection: { compaction: { enabled: false } } },
		read: (policy) => policy.fallbackCompactionMaxAttempts,
		defaultValue: DEFAULT_RETRY_POLICY.fallbackCompactionMaxAttempts,
	},
	{
		userPath: "memory_overflow_protection.compaction.dynamic.enabled",
		fragment: on({ dynamic: { enabled: true } }),
		read: (policy) => policy.dynamicCompactionRatio,
		defaultValue: DEFAULT_RETRY_POLICY.dynamicCompactionRatio,
	},
	{
		userPath: "memory_overflow_protection.compaction.dynamic.at_context_ratio",
		fragment: on({ dynamic: { enabled: true, at_context_ratio: 0.5 } }),
		read: (policy) => policy.dynamicCompactionRatio,
		defaultValue: DEFAULT_RETRY_POLICY.dynamicCompactionRatio,
	},
	{
		userPath: "memory_overflow_protection.compaction.forced.enabled",
		fragment: on({ forced: { enabled: false } }),
		read: (policy) => policy.fallbackCompactionMaxAttempts,
		defaultValue: DEFAULT_RETRY_POLICY.fallbackCompactionMaxAttempts,
	},
	{
		userPath: "memory_overflow_protection.compaction.forced.max_attempts",
		fragment: on({ forced: { enabled: true, max_attempts: 7 } }),
		read: (policy) => policy.fallbackCompactionMaxAttempts,
		defaultValue: DEFAULT_RETRY_POLICY.fallbackCompactionMaxAttempts,
	},
	{
		userPath: "memory_overflow_protection.compaction.forced.wait_seconds_before_first_attempt",
		fragment: on({ forced: { enabled: true, wait_seconds_before_first_attempt: 7 } }),
		read: (policy) => policy.forcedCompactionWaitMs,
		defaultValue: DEFAULT_RETRY_POLICY.forcedCompactionWaitMs,
	},
	{
		userPath: "memory_overflow_protection.compaction.forced.warn_after_seconds",
		fragment: on({ forced: { warn_after_seconds: 11 } }),
		read: (policy) => policy.compactionWarningMs,
		defaultValue: DEFAULT_RETRY_POLICY.compactionWarningMs,
	},
	{
		userPath: "memory_overflow_protection.compaction.forced.give_up_after_no_progress_seconds",
		fragment: on({ forced: { give_up_after_no_progress_seconds: 13 } }),
		read: (policy) => policy.compactionStallCheckMs,
		defaultValue: DEFAULT_RETRY_POLICY.compactionStallCheckMs,
	},
	{
		userPath: "memory_overflow_protection.compaction.forced.give_up_confirm_seconds",
		fragment: on({ forced: { give_up_confirm_seconds: 17 } }),
		read: (policy) => policy.compactionStallRetryMs,
		defaultValue: DEFAULT_RETRY_POLICY.compactionStallRetryMs,
	},
	{
		userPath: "memory_overflow_protection.prune.enabled",
		fragment: pruneOn({}),
		read: (policy) => policy.maxPruningAttempts,
		defaultValue: DEFAULT_RETRY_POLICY.maxPruningAttempts,
	},
	{
		userPath: "memory_overflow_protection.prune.max_attempts",
		fragment: pruneOn({ max_attempts: 4 }),
		read: (policy) => policy.maxPruningAttempts,
		defaultValue: DEFAULT_RETRY_POLICY.maxPruningAttempts,
	},
	{
		userPath: "memory_overflow_protection.prune.removal_fractions",
		fragment: pruneOn({ removal_fractions: [0.25] }),
		read: (policy) => policy.trimPayloadOnMemoryOverflow,
		defaultValue: DEFAULT_RETRY_POLICY.trimPayloadOnMemoryOverflow,
	},
	{
		userPath: "memory_overflow_protection.prune.target_priorities.marked_blocks",
		fragment: pruneOn({ target_priorities: { marked_blocks: 9 } }),
		read: (policy) =>
			policy.trimPayloadOnMemoryOverflow === false
				? undefined
				: policy.trimPayloadOnMemoryOverflow.target_priorities.marked_blocks,
		defaultValue: 3,
	},
	{
		userPath: "memory_overflow_protection.prune.target_priorities.tool_results",
		fragment: pruneOn({ target_priorities: { tool_results: 9 } }),
		read: (policy) =>
			policy.trimPayloadOnMemoryOverflow === false
				? undefined
				: policy.trimPayloadOnMemoryOverflow.target_priorities.tool_results,
		defaultValue: 2,
	},
	{
		userPath: "memory_overflow_protection.prune.target_priorities.assistant_turns",
		fragment: pruneOn({ target_priorities: { assistant_turns: 9 } }),
		read: (policy) =>
			policy.trimPayloadOnMemoryOverflow === false
				? undefined
				: policy.trimPayloadOnMemoryOverflow.target_priorities.assistant_turns,
		defaultValue: 1,
	},
	{
		userPath: "memory_overflow_protection.prune.tool_priorities",
		fragment: pruneOn({ tool_priorities: { bash: 5 } }),
		read: (policy) =>
			policy.trimPayloadOnMemoryOverflow === false
				? undefined
				: policy.trimPayloadOnMemoryOverflow.tool_priorities.bash,
		defaultValue: undefined,
	},
	{
		userPath: "memory_overflow_protection.prune.block_markers",
		fragment: pruneOn({ block_markers: ["only"] }),
		read: (policy) =>
			policy.trimPayloadOnMemoryOverflow === false
				? undefined
				: policy.trimPayloadOnMemoryOverflow.block_markers.join(","),
		defaultValue: "llm wiki,wiki,recall",
	},
	{
		userPath: "memory_overflow_protection.prune.extra_overage_tokens",
		fragment: pruneOn({ extra_overage_tokens: 55 }),
		read: (policy) =>
			policy.trimPayloadOnMemoryOverflow === false
				? undefined
				: policy.trimPayloadOnMemoryOverflow.extra_overage_tokens,
		defaultValue: 2000,
	},
	{
		userPath: "hooks.provider_silent.after_seconds",
		fragment: { hooks: { provider_silent: { after_seconds: 1, command: "true" } } },
		read: (policy) => policy.providerSilentHook?.after_seconds,
		defaultValue: undefined,
	},
	{
		userPath: "hooks.provider_silent.command",
		fragment: { hooks: { provider_silent: { after_seconds: 1, command: "echo hook" } } },
		read: (policy) => policy.providerSilentHook?.command,
		defaultValue: undefined,
	},
	{
		userPath: "hooks.provider_silent.timeout_seconds",
		fragment: { hooks: { provider_silent: { after_seconds: 1, command: "true", timeout_seconds: 2 } } },
		read: (policy) => policy.providerSilentHook?.timeout_seconds,
		defaultValue: undefined,
	},
	{
		userPath: "warnings.provider_silence_seconds",
		fragment: { warnings: { provider_silence_seconds: 1 } },
		read: (policy) => policy.providerSilentWarningMs,
		defaultValue: DEFAULT_RETRY_POLICY.providerSilentWarningMs,
	},
	{
		userPath: "debug",
		fragment: { debug: { path: "relative.log" } },
		read: (policy) => policy.debugLogPath,
		defaultValue: DEFAULT_RETRY_POLICY.debugLogPath,
	},
];

function schemaLeafPaths(node: unknown, prefix: string, paths: Set<string>): void {
	if (typeof node !== "object" || node === null) return;
	const record = node as Record<string, unknown>;
	const properties = record.properties as Record<string, unknown> | undefined;
	if (properties === undefined) return;
	for (const [key, child] of Object.entries(properties)) {
		const path = prefix === "" ? key : `${prefix}.${key}`;
		const childRecord = (child ?? {}) as Record<string, unknown>;
		if (childRecord.properties !== undefined) schemaLeafPaths(child, path, paths);
		else paths.add(path);
	}
}

test("every config leaf that normalizes into the resolved policy is effective", () => {
	for (const { userPath, fragment, read, defaultValue } of CASES) {
		const value = read(resolveRetryPolicy(fragment));
		assert.notEqual(value, defaultValue, `${userPath}: normalized value must differ from the default`);
		assert.notEqual(value, undefined, `${userPath}: resolved value must not be undefined`);
	}
});

test("the case table covers every leaf path in the generated config schema", () => {
	const paths = new Set<string>();
	schemaLeafPaths(retryConfigJsonSchema, "", paths);
	paths.delete("$schema");
	const covered = new Set(CASES.map((entry) => entry.userPath));
	assert.deepEqual([...paths].filter((path) => !covered.has(path)).sort(), []);
	assert.deepEqual([...covered].filter((path) => !paths.has(path)).sort(), []);
});

test("configured smart overrides replace the shipped table", () => {
	const policy = resolveRetryPolicy({
		retry: { smart_overrides: [{ when: { error_codes: [429] }, max_attempts: 0 }] },
	});
	assert.deepEqual(policy.smartOverrides, [{ when: { error_codes: [429] }, max_attempts: 0 }]);
});

test("model fallback is a total bypass when disabled and preserves chains when enabled", () => {
	const config = {
		retry: {
			smart_overrides: [
				{ when: { words: ["wedged"] }, max_attempts: 0, fallback_models: ["openai/gpt-5", "anthropic/claude"] },
			],
		},
	};
	const disabled = resolveRetryPolicy({ ...config, model_fallback: { enabled: false, max_hops: 9 } });
	assert.equal(disabled.maxFallbackHops, 0);
	assert.deepEqual(
		disabled.errorRules.flatMap((rule) => rule.fallbackModels),
		[],
	);
	const enabled = resolveRetryPolicy({ ...config, model_fallback: { enabled: true, max_hops: 99 } });
	assert.equal(enabled.maxFallbackHops, 10);
	assert.deepEqual(enabled.errorRules[0]?.fallbackModels, ["openai/gpt-5", "anthropic/claude"]);
});

test("the compaction switch contains only compaction; pruning has its own gate", () => {
	const policy = resolveRetryPolicy({
		memory_overflow_protection: {
			compaction: { enabled: false, dynamic: { enabled: true }, forced: { enabled: true, max_attempts: 9 } },
			prune: { enabled: true, max_attempts: 4 },
		},
	});
	assert.equal(policy.dynamicCompactionRatio, undefined);
	assert.equal(policy.fallbackCompactionMaxAttempts, 0);
	assert.equal(policy.maxPruningAttempts, 4);
	assert.notEqual(policy.trimPayloadOnMemoryOverflow, false);
});

test("legacy nesting and unordered prune fractions are rejected", () => {
	assert.throws(
		() => resolveRetryPolicy({ memory_overflow_protection: { compaction: { forced: { experimental: {} } } } }),
		/unknown key/,
	);
	assert.throws(() => resolveRetryPolicy(pruneOn({ removal_fractions: [0.5, 0.25] })), /must be strictly increasing/);
});
