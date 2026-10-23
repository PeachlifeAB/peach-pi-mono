import assert from "node:assert/strict";
import test from "node:test";
import { coreHandlesOverflow } from "../src/overflow-detection.ts";

test("coreHandlesOverflow mirrors pi core context wording", () => {
	for (const recognised of [
		"prompt is too long: 213462 tokens > 200000 maximum",
		"Your input exceeds the context window of this model",
		"Requested token count exceeds the model's maximum context length of 131072 tokens",
		"context_length_exceeded",
		"Prompt has 128001 tokens, but the configured context size is 128000 tokens",
	]) {
		assert.equal(coreHandlesOverflow(recognised), true, recognised);
	}
});

test("coreHandlesOverflow excludes throttling that resembles overflow", () => {
	assert.equal(coreHandlesOverflow("Throttling error: Too many tokens, please wait before trying again."), false);
	assert.equal(coreHandlesOverflow("429 rate limit exceeded"), false);
});
