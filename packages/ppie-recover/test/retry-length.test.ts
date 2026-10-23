import assert from "node:assert/strict";
import test from "node:test";
import { classifyLengthStop } from "../src/length-stop-classification.ts";
import { isKeepaliveFrame } from "../src/retry-utils.ts";

test("classifyLengthStop discriminates on visible output alone (tiny=overflow, large=truncation)", () => {
	const base = {
		minTruncationTextChars: 20,
	} as const;
	assert.equal(
		classifyLengthStop({ ...base, visibleTextChars: 4 }),
		"overflow",
		"tiny output at any fill level is overflow-as-length: compaction is a valid recovery",
	);
	assert.equal(
		classifyLengthStop({ ...base, visibleTextChars: 4000 }),
		"truncation",
		"large output is genuine truncation: follow-up continuation is the right move",
	);
	assert.equal(
		classifyLengthStop({ ...base, visibleTextChars: 0 }),
		"overflow",
		"zero output still classifies as overflow — the lengthOverflowCompacted latch in length-stop.ts is the real stop",
	);
	assert.equal(
		classifyLengthStop({ ...base, visibleTextChars: 19 }),
		"overflow",
		"the truncation threshold is exclusive",
	);
	assert.equal(
		classifyLengthStop({ ...base, visibleTextChars: 20 }),
		"truncation",
		"the truncation threshold is inclusive",
	);
});

test("isKeepaliveFrame identifies oMLX prefill heartbeats, not genuine length stops with output", () => {
	// A true prefill heartbeat has no output tokens and no visible text — the
	// provider is still computing. oMLX sends these with responseModel
	// "keepalive", zero usage, and an empty/delta-only SSE chunk.
	assert.equal(
		isKeepaliveFrame({
			role: "assistant",
			stopReason: "length",
			model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
			responseModel: "keepalive",
			usage: { input: 51_478, cacheRead: 12_288, output: 0 },
		}),
		true,
		"a zero-output frame with responseModel 'keepalive' is a heartbeat",
	);
	// A length stop where the model actually produced output tokens is NOT a
	// heartbeat — it's a genuine length stop that should be handled by
	// handleLengthStop (compact + retry once, or follow-up if large).
	// The predicate also checks for zero output / zero visible text.
	assert.equal(
		isKeepaliveFrame({
			role: "assistant",
			stopReason: "length",
			model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
			responseModel: "keepalive",
			usage: { input: 51_478, cacheRead: 12_288, output: 1 },
			content: [{ type: "text", text: "Now" }],
		}),
		false,
		"a length stop with output=1 and visible text is a genuine length stop, not a heartbeat",
	);
	assert.equal(
		isKeepaliveFrame({
			role: "assistant",
			stopReason: "stop",
			model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
			responseModel: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
			usage: { input: 290, cacheRead: 63_488, output: 5 },
		}),
		false,
		"a real completion where responseModel matches the requested model is not a keepalive",
	);
	assert.equal(
		isKeepaliveFrame({
			role: "assistant",
			stopReason: "stop",
			usage: { input: 100, output: 50 },
		}),
		false,
		"providers that never set responseModel must not be misclassified as keepalive",
	);
});

// Reported live, twice, same session (019f3f88-fc14-759b-a722-fdf763ee480e),
// even after clearing the active /goal and restarting pi — ruling out
// pi-goal or any other extension racing ppie-recover. A memory_guard prefill
// rejection fails BEFORE any tokens stream, so the assistant message has
// stopReason:"error", content:[], usage.output:0, and (on oMLX)
// responseModel:"keepalive" — the exact same zero-output shape as a genuine
// prefill heartbeat. isKeepaliveFrame only checked
// responseModel/usage.output/visibleTextLength, with no stopReason check,
// so this genuine fatal error was silently discarded by onMessageEnd's
// `if (isKeepaliveFrame(message)) return;` guard before errorMessage was
// ever read — zero notification, zero retry, matching the reported
// "not auto healing" symptom exactly.
test("isKeepaliveFrame does NOT misclassify a genuine memory_guard error as a heartbeat, even with zero output and responseModel=keepalive", () => {
	assert.equal(
		isKeepaliveFrame({
			role: "assistant",
			stopReason: "error",
			model: "Qwen3.6-27B-oQ4-mtp",
			responseModel: "keepalive",
			usage: { input: 0, output: 0, cacheRead: 0 },
			content: [],
			errorMessage:
				"Prefill would require ~56.86 GB peak (current 50.07 GB + KV+SDPA 6.79 GB) but static/metal_cap ceiling is 54.00 GB. Raise kernel iogpu.wired_limit_mb in Terminal (currently caps Metal at 60.00 GB), or reduce context length.",
		}),
		false,
		"a zero-output stopReason:error frame is a genuine fatal error, not a heartbeat — a true heartbeat never carries an errorMessage or stopReason:error",
	);
});

test("isKeepaliveFrame does not false-positive on OpenAI/Anthropic returning a dated snapshot for an aliased model request", () => {
	// pi-ai's openai-completions.js sets responseModel whenever a real,
	// parsed completion chunk's model field differs from the requested
	// model.id — this fires for any provider, not just oMLX. OpenAI/Anthropic
	// routinely resolve a requested alias (e.g. "gpt-4") to a dated snapshot
	// id (e.g. "gpt-4-0314") on a completely normal, successful completion.
	// responseModel !== model is true here too, but this is not a heartbeat.
	assert.equal(
		isKeepaliveFrame({
			role: "assistant",
			stopReason: "stop",
			model: "gpt-4",
			responseModel: "gpt-4-0314",
			usage: { input: 500, output: 200 },
		}),
		false,
		"a dated snapshot id for a requested alias is a real completion, not a keepalive",
	);
	assert.equal(
		isKeepaliveFrame({
			role: "assistant",
			stopReason: "stop",
			model: "claude-3-5-sonnet-latest",
			responseModel: "claude-3-5-sonnet-20241022",
			usage: { input: 500, output: 200 },
		}),
		false,
		"Anthropic's -latest alias resolving to a dated snapshot is a real completion, not a keepalive",
	);
});
