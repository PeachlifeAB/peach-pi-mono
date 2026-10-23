import { describe, expect, it } from "vitest";
import { parseModelsPayload, resolveDimensions } from "../src/models.ts";

describe("resolveDimensions", () => {
	it("uses the dimensions the server reports", () => {
		expect(resolveDimensions({ id: "m", context_window: 32000, max_tokens: 8192 })).toEqual({
			contextWindow: 32000,
			maxTokens: 8192,
		});
	});

	it("falls back to 16384 output tokens, matching pi rather than the old 4096 cap", () => {
		// The regression this pins: 4096 silently capped every discovered model at a
		// quarter of pi's own ceiling.
		expect(resolveDimensions({ id: "m", context_window: 200000 }).maxTokens).toBe(16384);
	});

	it("falls back to a 128000 context window when the server reports none", () => {
		expect(resolveDimensions({ id: "m" }).contextWindow).toBe(128000);
	});

	it("rejects a non-positive reported context window instead of trusting it", () => {
		expect(resolveDimensions({ id: "m", context_window: 0 }).contextWindow).toBe(128000);
		expect(resolveDimensions({ id: "m", context_window: -1 }).contextWindow).toBe(128000);
	});

	it("rejects a non-positive reported output ceiling", () => {
		expect(resolveDimensions({ id: "m", context_window: 32000, max_tokens: 0 }).maxTokens).toBe(16384);
	});

	it("never lets the output ceiling exceed the context window", () => {
		expect(resolveDimensions({ id: "m", context_window: 4096 }).maxTokens).toBe(4096);
		expect(resolveDimensions({ id: "m", context_window: 2048, max_tokens: 99999 }).maxTokens).toBe(2048);
	});
});

describe("parseModelsPayload", () => {
	it("reads the standard OpenAI-compatible listing shape", () => {
		const models = parseModelsPayload({
			data: [{ id: "a", name: "Model A", context_window: 8192, max_tokens: 1024 }],
		});

		expect(models).toEqual([{ id: "a", name: "Model A", context_window: 8192, max_tokens: 1024 }]);
	});

	it("drops entries with no usable id rather than registering id: undefined", () => {
		const models = parseModelsPayload({ data: [{ id: "a" }, { name: "no id" }, { id: "" }, { id: 42 }, null] });

		expect(models.map((model) => model.id)).toEqual(["a"]);
	});

	it("ignores fields of the wrong type instead of passing them through", () => {
		const models = parseModelsPayload({ data: [{ id: "a", name: 1, context_window: "big", max_tokens: null }] });

		expect(models).toEqual([{ id: "a", name: undefined, context_window: undefined, max_tokens: undefined }]);
	});

	it("returns nothing for payloads that are not a listing", () => {
		expect(parseModelsPayload({})).toEqual([]);
		expect(parseModelsPayload({ data: "nope" })).toEqual([]);
		expect(parseModelsPayload(null)).toEqual([]);
		expect(parseModelsPayload([])).toEqual([]);
	});
});

describe("context window field names", () => {
	// vLLM-style servers (omlx among them) report `max_model_len`; reading only
	// `context_window` silently gave every such model the 128000 fallback.
	it("reads max_model_len when the server reports it", () => {
		expect(resolveDimensions({ id: "a", max_model_len: 87000 }).contextWindow).toBe(87000);
	});

	it("reads context_length when the server reports it", () => {
		expect(resolveDimensions({ id: "a", context_length: 32768 }).contextWindow).toBe(32768);
	});

	it("prefers context_window when several names are present", () => {
		expect(resolveDimensions({ id: "a", context_window: 4096, max_model_len: 87000 }).contextWindow).toBe(4096);
	});

	it("skips a non-positive value and falls through to the next name", () => {
		expect(resolveDimensions({ id: "a", context_window: 0, max_model_len: 87000 }).contextWindow).toBe(87000);
	});

	it("keeps max_model_len through payload parsing", () => {
		const [model] = parseModelsPayload({ data: [{ id: "a", max_model_len: 87000 }] });
		expect(resolveDimensions(model!).contextWindow).toBe(87000);
	});
});
