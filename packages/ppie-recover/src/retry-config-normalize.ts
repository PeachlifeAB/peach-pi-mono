import { DEFAULT_CONFIG } from "./retry-config-defaults.ts";
import type { PiRetryUserConfig } from "./retry-config-schema.ts";
import type {
	ResolvedRetryDefaults,
	ResolvedRetryPolicy,
	ResolvedRetryRule,
	RetryBehaviorOverride,
	SmartOverride,
	TrimPayloadConfig,
} from "./retry-policy-types.ts";

const asNumber = (value: number | "unlimited") => (value === "unlimited" ? Number.POSITIVE_INFINITY : value);

const explicitRetryProperties = (row: SmartOverride, fallbackEnabled: boolean): RetryBehaviorOverride => ({
	...(row.max_attempts !== undefined ? { max_attempts: row.max_attempts } : {}),
	...(row.seconds_before_first_retry !== undefined
		? { seconds_before_first_retry: row.seconds_before_first_retry }
		: {}),
	...(row.multiplier_between_attempts !== undefined
		? { multiplier_between_attempts: row.multiplier_between_attempts }
		: {}),
	...(row.max_seconds_between_attempts !== undefined
		? { max_seconds_between_attempts: row.max_seconds_between_attempts }
		: {}),
	...(fallbackEnabled && row.fallback_models !== undefined ? { fallback_models: row.fallback_models } : {}),
});

/**
 * Fully resolved rule rows retain which properties each row explicitly supplied.
 * The unnamed catch-all ("default") row is always last.
 */
export function resolveErrorRules(
	baseline: ResolvedRetryDefaults,
	overrides: readonly SmartOverride[],
	fallbackEnabled = false,
): readonly ResolvedRetryRule[] {
	return Object.freeze([
		...overrides.map((row, index) =>
			Object.freeze({
				rule: `smart override ${index + 1}`,
				when: Object.freeze({ ...row.when }),
				max_attempts: row.max_attempts ?? baseline.max_attempts,
				seconds_before_first_retry: row.seconds_before_first_retry ?? baseline.seconds_before_first_retry,
				multiplier_between_attempts: row.multiplier_between_attempts ?? baseline.multiplier_between_attempts,
				max_seconds_between_attempts: row.max_seconds_between_attempts ?? baseline.max_seconds_between_attempts,
				fallbackModels: Object.freeze(fallbackEnabled ? [...(row.fallback_models ?? [])] : []),
				explicit: Object.freeze(explicitRetryProperties(row, fallbackEnabled)),
			}),
		),
		Object.freeze({
			rule: "default",
			max_attempts: baseline.max_attempts,
			seconds_before_first_retry: baseline.seconds_before_first_retry,
			multiplier_between_attempts: baseline.multiplier_between_attempts,
			max_seconds_between_attempts: baseline.max_seconds_between_attempts,
			fallbackModels: Object.freeze([]),
			explicit: Object.freeze({}),
		}),
	]);
}

export function normalizeRetryConfig(config: PiRetryUserConfig): ResolvedRetryPolicy {
	const retry = config.retry;
	const { smart_overrides: shippedOverrides, ...shippedBaseline } = DEFAULT_CONFIG.retry;
	const { smart_overrides: configuredOverrides, ...configuredBaseline } = retry ?? {};
	const baseline = { ...shippedBaseline, ...configuredBaseline };
	const shippedMop = DEFAULT_CONFIG.memory_overflow_protection;
	const configuredMop = config.memory_overflow_protection;
	// The compaction master switch is a trust boundary: when it is off ppie-recover
	// reads no value below it, so every compaction-derived field resolves to its
	// inert sentinel and no nested flag — advisory ones included — can re-enable
	// a part. The sibling prune group is NOT governed by it: pruning has its own
	// enabled gate, mirroring the recovery chain's three independent domains.
	const compaction = {
		...shippedMop.compaction,
		...configuredMop?.compaction,
		dynamic: { ...shippedMop.compaction.dynamic, ...configuredMop?.compaction?.dynamic },
		forced: { ...shippedMop.compaction.forced, ...configuredMop?.compaction?.forced },
	};
	const compactionEnabled = compaction.enabled;
	const prune = {
		...shippedMop.prune,
		...configuredMop?.prune,
		target_priorities: {
			...shippedMop.prune.target_priorities,
			...configuredMop?.prune?.target_priorities,
		},
	};
	const pruneEnabled = prune.enabled;
	const trimPayloadOnMemoryOverflow: TrimPayloadConfig = !pruneEnabled
		? false
		: Object.freeze({
				removal_fractions: Object.freeze([...prune.removal_fractions]),
				target_priorities: Object.freeze({ ...prune.target_priorities }),
				tool_priorities: Object.freeze({ ...prune.tool_priorities }),
				block_markers: Object.freeze([...prune.block_markers]),
				extra_overage_tokens: prune.extra_overage_tokens,
			});
	const fractions = prune.removal_fractions;
	if (!fractions.every((value, index) => index === 0 || value > fractions[index - 1])) {
		throw new Error("config.memory_overflow_protection.prune.removal_fractions: must be strictly increasing");
	}
	const warnings = { ...DEFAULT_CONFIG.warnings, ...config.warnings };
	const providerSilentHook = config.hooks?.provider_silent && Object.freeze({ ...config.hooks.provider_silent });
	const smartOverrides: readonly SmartOverride[] = configuredOverrides ?? shippedOverrides;
	const fallback = { ...DEFAULT_CONFIG.model_fallback, ...config.model_fallback };
	const fallbackEnabled = fallback.enabled;
	const maxFallbackHops = fallbackEnabled ? Math.min(10, Math.max(1, fallback.max_hops)) : 0;
	const normalizedSmartOverrides = Object.freeze(
		smartOverrides.map((row) => {
			const { fallback_models: fallbackModels, ...retryOverride } = row;
			return Object.freeze({
				...retryOverride,
				when: Object.freeze({ ...row.when }),
				...(fallbackEnabled && fallbackModels ? { fallback_models: Object.freeze([...fallbackModels]) } : {}),
			});
		}),
	);
	return Object.freeze({
		defaultRetry: Object.freeze(baseline),
		smartOverrides: normalizedSmartOverrides,
		fallbackEnabled,
		maxFallbackHops,
		fallbackCompactionMaxAttempts:
			compactionEnabled && compaction.forced.enabled ? compaction.forced.max_attempts : 0,
		forcedCompactionWaitMs:
			compactionEnabled && compaction.forced.enabled
				? compaction.forced.wait_seconds_before_first_attempt * 1000
				: 0,
		maxPruningAttempts: pruneEnabled ? prune.max_attempts : 0,
		trimPayloadOnMemoryOverflow,
		dynamicCompactionRatio:
			compactionEnabled && compaction.dynamic.enabled ? compaction.dynamic.at_context_ratio : undefined,
		providerSilentWarningMs:
			warnings.provider_silence_seconds === 0 ? undefined : warnings.provider_silence_seconds * 1000,
		providerSilentHook,
		compactionWarningMs:
			!compactionEnabled || compaction.forced.warn_after_seconds === 0
				? undefined
				: compaction.forced.warn_after_seconds * 1000,
		debugLogPath: config.debug === false || config.debug === undefined ? undefined : config.debug.path,
		maximumAttempts: asNumber(baseline.max_attempts),
		temporaryRetryFirstDelayMs: baseline.seconds_before_first_retry * 1000,
		temporaryRetryMaximumDelayMs: baseline.max_seconds_between_attempts * 1000,
		errorRules: resolveErrorRules(baseline, normalizedSmartOverrides, fallbackEnabled),
		memoryGuardRemovalFractions:
			trimPayloadOnMemoryOverflow === false ? Object.freeze([]) : trimPayloadOnMemoryOverflow.removal_fractions,
		compactionStallCheckMs: compactionEnabled ? compaction.forced.give_up_after_no_progress_seconds * 1000 : 0,
		compactionStallRetryMs: compactionEnabled ? compaction.forced.give_up_confirm_seconds * 1000 : 0,
		debugLogEnabled: config.debug !== false && config.debug !== undefined,
	});
}
