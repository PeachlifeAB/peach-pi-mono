// Relative: the loader writes config.schema.json beside every config file it
// reads, regenerated from this build's own schema, so the pointer resolves
// offline and always describes the installed version. A pinned URL described
// whichever release was tagged rather than what validates the file, and the
// config directory is not fixed anyway — PI_CODING_AGENT_DIR moves it.
const RETRY_CONFIG_SCHEMA_URL = "./config.schema.json";

export const DEFAULT_CONFIG = Object.freeze({
	$schema: RETRY_CONFIG_SCHEMA_URL,
	retry: {
		max_attempts: 5,
		seconds_before_first_retry: 16,
		multiplier_between_attempts: 2,
		max_seconds_between_attempts: 1000,
		smart_overrides: [
			{
				// Transport drops and provider overload heal with time. Stopping
				// would end a session that only had to wait, so these retry on the
				// capped curve until the provider answers or the user steps in.
				// Wording mirrors Pi core's own retryable pattern. Listed first so
				// the specific rows below still win.
				when: {
					error_codes: [500, 502, 503, 504, 524, 529],
					words: [
						"terminated",
						"fetch failed",
						"socket hang up",
						"socket connection was closed",
						"other side closed",
						"upstream connect",
						"reset before headers",
						"network error",
						"connection error",
						"connection refused",
						"connection reset",
						"connection lost",
						"timed out",
						"timeout",
						"websocket closed",
						"websocket error",
						"stream ended",
						"ended without",
						"econnrefused",
						"econnreset",
						"etimedout",
						"enotfound",
						"eai_again",
						"getaddrinfo",
						"service unavailable",
						"overloaded",
						"server error",
						"internal error",
						"provider returned error",
					],
					words_match: "any" as const,
				},
				max_attempts: "unlimited" as const,
			},
			{
				// Cloud account, billing and rate limits: a human has to act, so a
				// retry only delays the error.
				when: {
					error_codes: [401, 402, 403, 429],
					words: [
						"forbidden",
						"payment required",
						"insufficient_quota",
						"credits",
						"credit balance",
						"billing",
						"spending limit",
						"access denied",
						"rate_limit",
						"rate limit",
						"too many requests",
					],
					words_match: "any" as const,
				},
				max_attempts: 0,
			},
			{
				when: {
					error_codes: [404],
					words: [
						"invalid api key",
						"invalid authentication",
						"api key not found",
						"missing api key",
						"authentication verification keys",
						"unauthorized",
						"usage limit",
						"model not found",
						"no such model",
						"model does not exist",
						"unsupported model",
						"unsupported parameter",
						"unsupported_value",
						"invalid_argument",
						"malformed",
						"does not support",
						"permission denied",
						"account is not active",
						"operation aborted",
						"aborted by user",
						"user aborted",
						"request aborted",
					],
					words_match: "any" as const,
				},
				max_attempts: 0,
			},
			{
				when: {
					// Resending the same prompt fails the same way. The short window
					// only lets Pi core start its own overflow compaction first, so
					// the two never compact the same overflow twice.
					words: ["overflow", "too long", "context length"],
					words_match: "any" as const,
				},
				seconds_before_first_retry: 5,
				max_attempts: 3,
			},
			{
				when: {
					// Give the server time to free its KV cache before compacting.
					words: ["physical cap", "prefill_memory_exceeded", "memory limit exceeded", "out of memory"],
					words_match: "any" as const,
				},
				seconds_before_first_retry: 30,
				multiplier_between_attempts: 2,
				max_attempts: 3,
			},
			{
				// A server that has wedged a model rejects every acquisition until
				// it restarts, so retrying cannot succeed and only delays the
				// error. This specific rule follows broad retry rules.
				when: {
					error_codes: [409],
					words: ["unload is pending"],
					words_match: "any" as const,
				},
				max_attempts: 0,
			},
		],
	},
	memory_overflow_protection: {
		// Compaction recovers what Pi core cannot (a second overflow, provider
		// memory pressure). Dynamic stays off: Pi core already compacts at its
		// threshold. Pruning stays off: the model would silently see less.
		compaction: {
			enabled: true,
			dynamic: {
				enabled: false,
				at_context_ratio: 0.8,
			},
			forced: {
				enabled: true,
				wait_seconds_before_first_attempt: 30,
				max_attempts: 2,
				warn_after_seconds: 600,
				give_up_after_no_progress_seconds: 180,
				give_up_confirm_seconds: 480,
			},
		},
		prune: {
			enabled: false,
			max_attempts: 1,
			removal_fractions: [0.25, 0.5, 0.75, 0.875],
			target_priorities: {
				marked_blocks: 3,
				tool_results: 2,
				assistant_turns: 1,
			},
			tool_priorities: {},
			block_markers: ["llm wiki", "wiki", "recall"],
			extra_overage_tokens: 2000,
		},
	},
	model_fallback: {
		enabled: false,
		max_hops: 3,
	},
	warnings: {
		provider_silence_seconds: 600,
	},
	debug: false as const,
});
