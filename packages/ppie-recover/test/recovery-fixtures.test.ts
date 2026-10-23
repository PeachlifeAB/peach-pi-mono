/**
 * Fixture-based classifier/heartbeat characterization tests.
 *
 * Fixtures are captured verbatim from a redacted local failing-session trace
 * (oMLX / ThinkingCap-Qwen3.6-27B-oQ6e-mtp, 2026-07-07T14:06–14:08Z).
 * Each fixture cites a redacted trace label. Spec-sourced fixtures are labeled.
 *
 * This file only characterizes pure public helper behavior. Recovery-loop
 * behavior is tested through retry(pi) + the real Agent in
 * test/retry-real-interface.spec.ts, not through internal handler calls.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyError } from "../src/error-classifier.ts";
import { isKeepaliveFrame, type MessageShape } from "../src/retry-utils.ts";

// ── Fixtures ──────────────────────────────────────────────────────────

// 64473deb — the only 400 in the session: oMLX prefill memory guard.
const FIXTURE_400_PREFILL = `400: {"message":"oMLX prefill memory guard rejected this prompt: Prefill would require ~63.95 GB peak (current 56.23 GB + KV+SDPA 7.73 GB) but static/metal_cap ceiling is 54.00 GB. Raise kernel iogpu.wired_limit_mb in Terminal (currently caps Metal at 60.00 GB), or reduce context length. To continue, set Memory Guard to aggressive, raise the custom memory guard ceiling, free system memory, or compact/reduce context.","type":"invalid_request_error","param":null,"code":"prefill_memory_exceeded","omlx_code":"prefill_memory_exceeded","estimated_bytes":68669354312,"limit_bytes":57982058496}`;

// fce7c7ec — 1-token length stop with responseModel=keepalive AND visible
// text. Session ids 11be06e7"Now", c710bc21"Let", fce7c7ec"Now",
// 34891a21"The" all share this shape.
const FIXTURE_TINY_LENGTHSTOP: MessageShape = {
	role: "assistant",
	stopReason: "length",
	model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
	responseModel: "keepalive",
	usage: { input: 2360, cacheRead: 106_496, output: 1 },
	content: [
		{
			type: "thinking",
			thinking: "\nNow",
			thinkingSignature: "reasoning_content",
		},
		{ type: "text", text: "\nNow" },
	],
};

// Spec-sourced (no true heartbeat occurred in the session): a zero-output
// prefill heartbeat that MUST be ignored, never recovered.
const FIXTURE_HEARTBEAT: MessageShape = {
	role: "assistant",
	stopReason: "length",
	model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
	responseModel: "keepalive",
	usage: { input: 51_478, cacheRead: 12_288, output: 0 },
	content: [],
};

// ── Inject fake deps + fake ctx via the existing seams ────────────────
// ── CHARACTERIZATION (observed real behavior, green) ─────────────────
// Verified by running the real code, not assumed. The oMLX prefill 400 is
// detected as its OWN "memory_guard" class — not missed. overflow-recovery.ts
// :95-119 routes memory_guard through the SAME prune-then-compact path as
// context_overflow, so it is recovered. (My earlier claim that the classifier
// "missed" it was wrong — corrected by observation.)

test("400 prefill_memory_exceeded is detected as memory_guard (routed to recovery)", () => {
	assert.equal(classifyError(FIXTURE_400_PREFILL), "memory_guard");
});

test("canonical context-overflow 400 is detected as context_overflow", () => {
	assert.equal(
		classifyError(
			'400: {"message":"This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.","type":"invalid_request_error"}',
		),
		"context_overflow",
	);
});

// ── GREEN guards: classifier/heartbeat behavior that must not regress.
// Full recovery-loop behavior lives in test/retry-real-interface.spec.ts,
// where the SUT is the public retry(pi) extension wired through the real Agent.

test("a tiny length stop with responseModel=keepalive and real text is NOT a heartbeat", () => {
	assert.equal(
		isKeepaliveFrame(FIXTURE_TINY_LENGTHSTOP),
		false,
		"the over-match that silently dropped all 4 length stops must stay fixed",
	);
});

test("a true zero-output prefill heartbeat IS ignored", () => {
	assert.equal(isKeepaliveFrame(FIXTURE_HEARTBEAT), true, "a real prefill heartbeat must be skipped, not recovered");
});

test("429 / rate-limit is NEVER recovered (we cannot survive it)", () => {
	assert.equal(classifyError("429 Too Many Requests"), "rate_limit");
	assert.equal(classifyError("Error: rate limit exceeded, retry later"), "rate_limit");
});
