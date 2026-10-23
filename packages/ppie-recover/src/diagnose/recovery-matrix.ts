import type { ErrorClass } from "../error-classifier.ts";

/**
 * Declarative map of every `ErrorClass` to the hook that handles it, the actions
 * it may take, and the config keys that tune them.
 *
 * **Deliberately unreferenced.** Nothing imports `RECOVERY_MATRIX` yet: it is
 * intended input to the recovery-chain controller (PPMONO-3), which is specified
 * but not built. It is kept here rather than deleted or moved to `reference/`
 * because it is the data that implementation consumes, and it belongs beside the
 * `diagnose/` subtree it describes.
 *
 * It is not inert. Keying on `ErrorClass` means adding or renaming an error class
 * fails `typecheck` here until this map is updated, so the matrix cannot silently
 * drift out of step with the classifier.
 *
 * Reassess if PPMONO-3 is abandoned or lands without consuming it — at that point
 * this is either documentation that belongs in `docs/`, or genuinely dead.
 */
export type RecoveryMatrix = Record<
	ErrorClass,
	{
		hook: string;
		actions: string[];
		configKeys: string[];
	}
>;

export const RECOVERY_MATRIX: RecoveryMatrix = {
	memory_guard: {
		hook: "message_end → recoverMemoryGuard",
		actions: ["compact-first", "wait (retry with delay)", "emergency-prune"],
		configKeys: [
			"retry.smart_overrides",
			"memory_overflow_protection.trim_payload_on_memory_overflow.removal_fractions",
			"memory_overflow_protection.fallback_compaction.max_attempts",
		],
	},
	context_overflow: {
		hook: "overflow detection → compact (unidirectional)",
		actions: ["initiate compaction", "wait for completion", "retry request"],
		configKeys: ["memory_overflow_protection.fallback_compaction.max_attempts", "warnings.compaction_stall_seconds"],
	},
	opaque_overflow: {
		hook: "4xx (no body) detection → trim + retry",
		actions: ["trim context window", "reduce output headroom", "retry"],
		configKeys: ["retry.seconds_before_first_retry", "retry.max_seconds_between_attempts"],
	},
	rate_limit: {
		hook: "429/throttle wording → smart override 1 (one patient retry)",
		actions: ["wait (multiplier × first delay)", "single retry", "stop and report if repeated"],
		configKeys: ["retry.smart_overrides"],
	},
	transient: {
		hook: "network/stream/overload error → exponential backoff",
		actions: ["wait", "retry with backoff"],
		configKeys: ["retry.seconds_before_first_retry", "retry.max_seconds_between_attempts", "retry.max_attempts"],
	},
	permanent: {
		hook: "none (terminal; smart override 3 (max_attempts: 0))",
		actions: ["stop", "report error"],
		configKeys: [],
	},
};
