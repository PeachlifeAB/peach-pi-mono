import assert from "node:assert/strict";
import test from "node:test";
import { classifyError, isEffectiveReduction, TRANSIENT_RE } from "../src/error-classifier.ts";

test("classifyError splits provider 400 bodies by cause, not status", () => {
	const cases = [
		{
			message:
				"400: This model's maximum context length is 8192 tokens, however you requested 8342 tokens (code: context_length_exceeded)",
			expected: "context_overflow",
		},
		{
			message: "400 Prompt too long: 75,403 tokens exceeds max context window of 72,099 tokens",
			expected: "context_overflow",
		},
		{
			message: "OMLX: 75,403 tokens exceeds max context window of 72,099",
			expected: "context_overflow",
		},
		{
			message: '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
			expected: "context_overflow",
		},
		{
			message:
				"400 context_length_exceeded: unsupported parameter value because maximum context length was exceeded",
			expected: "context_overflow",
		},
		{
			message: "400 prefill_memory_exceeded: estimated bytes 54.92 GB exceeds metal_cap 51.34 GB resident memory",
			expected: "memory_guard",
		},
		{
			message:
				'400: {"message":"oMLX prefill memory guard rejected this prompt: Prefill would require ~61.06 GB peak (current 55.98 GB + KV+SDPA 5.08 GB) but static/metal_cap ceiling is 59.50 GB. Reduce context length.","code":"prefill_memory_exceeded","estimated_bytes":65592857200,"limit_bytes":63887638528}',
			expected: "memory_guard",
		},
		{
			message:
				"Prefill context too large for available memory (preflight safety guard, kv_len=92561, min_chunk=32): predicted peak would require ~44.21 GB (current 43.01 GB + KV 1.02 GB + min-chunk transient 184.27 MB) but prefill safety cap is 43.55 GB (95% of effective ceiling 45.84 GB). Reduce context length, free system memory, or loosen memory_guard_tier (safe → balanced → aggressive).",
			expected: "memory_guard",
		},
		{
			message:
				"Request aborted: process memory limit exceeded (usage 49.6 GB, ceiling 45.8 GB). Reduce context size or lower memory_guard_tier.",
			expected: "memory_guard",
		},
		{
			message:
				"Memory limit exceeded during chunked prefill at 51200/56082 tokens: 46.5GB exceeds physical cap 45.8GB (after reclaim)",
			expected: "memory_guard",
		},
		{
			message: "400 status code (no body)",
			expected: "opaque_overflow",
		},
		{
			message: "400 unsupported parameter: max_tokens does not support true",
			expected: "permanent",
		},
		{
			message: "400 INVALID_ARGUMENT: The request body is malformed",
			expected: "permanent",
		},
		{
			message: "Codex error: The usage limit has been reached",
			expected: "permanent",
		},
		{
			message: "Unable to fetch authentication verification keys.",
			expected: "permanent",
		},
		{
			message: "invalid api key",
			expected: "permanent",
		},
		{
			message:
				'Error: OpenAI API error (403): 403 "You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok."',
			expected: "permanent",
		},
		{
			message: "Error: 402 You need more credits to continue. Add credits to your account balance.",
			expected: "permanent",
		},
		{
			message: '403 "personal-team-blocked:spending-limit"',
			expected: "permanent",
		},
		{
			message: "Error: 403",
			expected: "permanent",
		},
		{
			message: "Your credit balance is too low",
			expected: "permanent",
		},
		{
			message: "You exceeded your current quota, please check your plan and billing details",
			expected: "permanent",
		},
		{
			message: "access limit reached for this api key",
			expected: "permanent",
		},
		{
			message: "429 rate limit: usage limit bucket is cooling down",
			expected: "rate_limit",
		},
		{
			message: "429 rate limit exceeded, retry later",
			expected: "rate_limit",
		},
		{
			message: "Too many requests, please retry",
			expected: "rate_limit",
		},
		{
			message: "Service unavailable: overloaded",
			expected: "transient",
		},
		{
			message: '529 {"type":"overloaded_error"}',
			expected: "transient",
		},
		{
			message: "socket hang up",
			expected: "transient",
		},
		{
			message: "Error: terminated",
			expected: "transient",
		},
		{
			message: "fetch failed: ECONNREFUSED",
			expected: "transient",
		},
		{
			message: "connect ECONNREFUSED 127.0.0.1:8080",
			expected: "transient",
		},
	] as const;

	for (const { message, expected } of cases) {
		assert.equal(classifyError(message), expected, message);
	}
});

test("payload reduction must clear a meaningful fraction of the overage", () => {
	assert.equal(isEffectiveReduction({ reducedTokens: 499, overageTokens: 1000 }), false);
	assert.equal(isEffectiveReduction({ reducedTokens: 500, overageTokens: 1000 }), true);
	assert.equal(isEffectiveReduction({ reducedTokens: 1000, overageTokens: 40_000 }), false);
	assert.equal(isEffectiveReduction({ reducedTokens: 2000, overageTokens: 40_000 }), true);
});

test("transient default is distinguishable from a matched transport error", () => {
	const transportError = "fetch failed: ECONNREFUSED";
	assert.equal(classifyError(transportError), "transient");
	assert.ok(TRANSIENT_RE.test(transportError), "a real transport error must match TRANSIENT_RE explicitly");

	const novelProviderError = "prefill_quantization_mismatch: KV head count differs from config";
	assert.equal(classifyError(novelProviderError), "transient");
	assert.ok(
		!TRANSIENT_RE.test(novelProviderError),
		"an unrecognized provider error falls through to the default, it does not match TRANSIENT_RE",
	);
});
