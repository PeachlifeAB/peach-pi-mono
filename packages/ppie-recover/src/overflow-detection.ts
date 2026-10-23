import { getOverflowPatterns } from "@earendil-works/pi-ai";

// Keep the defer-to-core gate aligned with the exact provider patterns used by
// pi-ai/pi-core. Broad provider-body classification remains in
// error-classifier.ts; this module owns only the core-capability check.
const CORE_OVERFLOW_PATTERNS = getOverflowPatterns();

const CORE_NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
	/^(Throttling error|Service unavailable):/i,
	/rate limit/i,
	/too many requests/i,
];

export const coreHandlesOverflow = (errorMessage: string): boolean =>
	!CORE_NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage)) &&
	CORE_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
