export type ErrorClass =
	| "permanent"
	| "rate_limit"
	| "context_overflow"
	| "memory_guard"
	| "opaque_overflow"
	| "transient";

const MIN_EFFECTIVE_REDUCTION_TOKENS = 500;
const MIN_EFFECTIVE_REDUCTION_RATIO = 0.05;

// True throttling only (user decision 2026-08-19): classified as rate_limit so
// the first smart override (max_attempts: 1) can apply. Overload wording
// ("service unavailable", "overloaded", 529) is deliberately NOT here — it is
const RATE_LIMIT_RE = /rate limit|too many requests|\b429\b|throttl/i;

// Payment/access denial is unrecoverable: no recovery action can add credits
// or lift an access block, and retrying only prolongs the user-facing blocker.
// Checked before RATE_LIMIT_RE so a 403 that also mentions a limit (xAI
// "personal-team-blocked:spending-limit") cannot be mistaken for throttling.
// Status codes use digit/comma boundaries so token counts like "75,403" do
// not match; context-overflow phrasing is additionally checked earlier.
const PAYMENT_STATUS_CODE_RE = /(?<![\d,.])(?:401|402|403)(?!\d)/;
const PAYMENT_ACCESS_RE =
	/forbidden|payment required|access denied|insufficient[_ ]?quota|\bquota\b|\bcredits?\b|credit balance|run out of credits|subscription|billing|spending[ _-]?limit/i;

function isPaymentAccessDenied(message: string): boolean {
	if (PAYMENT_STATUS_CODE_RE.test(message)) return true;
	if (PAYMENT_ACCESS_RE.test(message)) return true;
	// "limit" together with "access" (user heuristic): an access limit is a
	// policy denial, not a cooldown bucket.
	return /\blimit\b/i.test(message) && /\baccess\b/i.test(message);
}
const MEMORY_GUARD_RE =
	/prefill_memory_exceeded|prefill context too large for available memory|preflight safety guard|preflight safety cap|predicted peak would require|memory limit exceeded|process memory limit exceeded|physical cap|metal_cap|estimated\s+bytes|resident|out of memory|\boom\b/i;
const CONTEXT_OVERFLOW_RE =
	/prompt is too long|prompt too long|request_too_large|payload too large|^\s*413\b|maximum context length|exceeds? (?:the )?context window|context[_ ]length[_ ]exceeded|reduce the length of (?:the |your )?messages|input token count.*exceeds|too many tokens|token limit exceeded|longer than the model'?s context|max(?:imum)? context window|\d[\d,]*\s*tokens?\s+exceeds/i;
const OPAQUE_OVERFLOW_RE = /^\s*4(?:00|13)\b.*\(no body\)/i;
const ABORT_RE = /operation aborted|aborted by user|user aborted|request aborted/i;
const PERMANENT_RE =
	/invalid api key|invalid authentication|api key not found|missing api key|authentication verification keys|unauthorized|usage limit|model not found|no such model|model does not exist|unsupported[ _-]?model|unsupported parameter|unsupported_value|invalid_argument|malformed|does not support|permission denied|insufficient_quota|account is not active/i;
// Explicit transport/network/stream transient errors. Mirrors pi core's
// RETRYABLE_PROVIDER_ERROR_PATTERN (pi-ai/utils/retry.ts) so transient
// classification does not lean on the catch-all fallback. After a local server
// (e.g. oMLX) restart these surface as "terminated", "fetch failed",
// "ECONNREFUSED", etc. — time-heals: retry with exponential backoff.
// Provider overload ("service unavailable", "overloaded", 529) lives here too:
// capacity pressure heals with time and keeps the standard backoff.
export const TRANSIENT_RE =
	/terminated|fetch failed|socket hang up|other side closed|upstream connect|reset before headers|network error|connection (?:refused|reset|lost|error)|timed out|timeout|websocket (?:closed|error)|ended without|stream ended|http2 request did not get a response|econnrefused|econnreset|epipe|etimedout|ehostunreach|enetunreach|service unavailable|overloaded|\b529\b/i;

export function classifyError(message: string): ErrorClass {
	if (!message) return "transient";
	if (MEMORY_GUARD_RE.test(message)) return "memory_guard";
	if (ABORT_RE.test(message)) return "permanent";
	if (CONTEXT_OVERFLOW_RE.test(message)) return "context_overflow";
	if (OPAQUE_OVERFLOW_RE.test(message)) return "opaque_overflow";
	if (isPaymentAccessDenied(message)) return "permanent";
	if (RATE_LIMIT_RE.test(message)) return "rate_limit";
	if (PERMANENT_RE.test(message)) return "permanent";
	if (TRANSIENT_RE.test(message)) return "transient";
	return "transient";
}

export function isEffectiveReduction(input: { reducedTokens: number; overageTokens: number }): boolean {
	const required = Math.max(MIN_EFFECTIVE_REDUCTION_TOKENS, input.overageTokens * MIN_EFFECTIVE_REDUCTION_RATIO);
	return input.reducedTokens >= required;
}
