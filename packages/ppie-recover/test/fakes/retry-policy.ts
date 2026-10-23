import { DEFAULT_CONFIG } from "../../src/retry-config-defaults.ts";
import { resolveRetryPolicy } from "../../src/retry-policy.ts";

// The reported incidents replayed against this policy were captured under a
// 20s first delay for overflow and memory pressure. Pinning that here keeps
// the recovery mechanics under test independent of the shipped pacing, which
// retry-policy.test.ts covers on its own.
const INCIDENT_FIRST_DELAY_S = 20;
const INCIDENT_ROWS = new Set(["too long", "prefill_memory_exceeded"]);
const incidentOverrides = DEFAULT_CONFIG.retry.smart_overrides.map((row) =>
	row.when.words?.some((word) => INCIDENT_ROWS.has(word))
		? { ...row, seconds_before_first_retry: INCIDENT_FIRST_DELAY_S }
		: row,
);

export function enabledOverflowPolicy(maxAttempts = 5) {
	return resolveRetryPolicy({
		retry: {
			max_attempts: maxAttempts,
			smart_overrides: incidentOverrides,
		},
		memory_overflow_protection: {
			compaction: { enabled: true, forced: { enabled: true } },
			prune: { enabled: true },
		},
	});
}

export const ENABLED_OVERFLOW_POLICY = enabledOverflowPolicy();
