import type { ProviderSilentHook } from "./hooks.ts";

type RetryAttemptLimit = number | "unlimited";
export type RetryPacing = Readonly<{
	max_attempts: RetryAttemptLimit;
	seconds_before_first_retry: number;
	multiplier_between_attempts: number;
	max_seconds_between_attempts: number;
}>;

export type RetryBehaviorOverride = Readonly<{
	max_attempts?: RetryAttemptLimit;
	seconds_before_first_retry?: number;
	multiplier_between_attempts?: number;
	max_seconds_between_attempts?: number;
	fallback_models?: readonly string[];
}>;

export type ResolvedRetryDefaults = RetryPacing;
export type SmartOverride = RetryBehaviorOverride &
	Readonly<{
		when: Readonly<{ error_codes?: readonly number[]; words?: readonly string[]; words_match?: "any" | "all" }>;
		fallback_models?: readonly string[];
	}>;
export type ResolvedRetryRule = RetryPacing &
	Readonly<{
		rule: string;
		when?: SmartOverride["when"];
		fallbackModels: readonly string[];
		explicit?: RetryBehaviorOverride;
	}>;
export type TrimPayloadConfig =
	| false
	| Readonly<{
			removal_fractions: readonly number[];
			target_priorities: Readonly<{ marked_blocks: number; tool_results: number; assistant_turns: number }>;
			tool_priorities: Readonly<Record<string, number>>;
			block_markers: readonly string[];
			extra_overage_tokens: number;
	  }>;
export type ResolvedRetryPolicy = Readonly<{
	defaultRetry: ResolvedRetryDefaults;
	smartOverrides: readonly SmartOverride[];
	fallbackEnabled: boolean;
	maxFallbackHops: number;
	fallbackCompactionMaxAttempts: number;
	/** Delay before ppie-recover forces its own compaction; 0 when forced compaction is off. */
	forcedCompactionWaitMs: number;
	/** Prune attempts, counted separately from provider retries; 0 when pruning is off. */
	maxPruningAttempts: number;
	trimPayloadOnMemoryOverflow: TrimPayloadConfig;
	dynamicCompactionRatio: number | undefined;
	providerSilentWarningMs: number | undefined;
	providerSilentHook: ProviderSilentHook | undefined;
	compactionWarningMs: number | undefined;
	debugLogPath: string | undefined;
	maximumAttempts: number;
	temporaryRetryFirstDelayMs: number;
	temporaryRetryMaximumDelayMs: number;
	errorRules: readonly ResolvedRetryRule[];
	memoryGuardRemovalFractions: readonly number[];
	compactionStallCheckMs: number;
	compactionStallRetryMs: number;
	debugLogEnabled: boolean;
}>;
