import type { MessageShape } from "../../src/retry-utils.ts";

function overflowMessage(contextTokens: number, excessTokens: number): string {
	return `Prompt too long: ${contextTokens + excessTokens} tokens exceeds max context window of ${contextTokens} tokens`;
}

function wrappedOverflow(contextTokens: number, excessTokens: number): string {
	const promptTokens = contextTokens + excessTokens;
	return `Error: prompt is too long: ${promptTokens} tokens exceeds the context window of ${contextTokens} tokens (400 ${overflowMessage(contextTokens, excessTokens)})`;
}

function tinyLengthStop(id: string, text: string): MessageShape & { id: string } {
	return {
		id,
		role: "assistant",
		stopReason: "length",
		model: "recovery-test-model",
		responseModel: "keepalive",
		usage: { input: 1_000, cacheRead: 100_000, output: 1 },
		content: [
			{ type: "thinking", thinking: `\n${text}`, thinkingSignature: "reasoning_content" },
			{ type: "text", text: `\n${text}` },
		],
	};
}

const memoryGuard = {
	message: "Synthetic prefill memory guard: estimated bytes exceed the physical cap",
	type: "invalid_request_error",
	code: "prefill_memory_exceeded",
};
const heartbeat: MessageShape = {
	role: "assistant",
	stopReason: "length",
	model: "recovery-test-model",
	responseModel: "keepalive",
	usage: { input: 1_000, cacheRead: 100_000, output: 0 },
	content: [],
};

export const recoveryScenarios = {
	coreMatchedOverflow: `400 ${overflowMessage(100_000, 20_000)}`,
	higherOverflow: wrappedOverflow(100_000, 8_000),
	lowerOverflow: wrappedOverflow(100_000, 4_000),
	marginalOverflow: `400: ${JSON.stringify({
		message: overflowMessage(112_000, 64),
		type: "invalid_request_error",
		param: null,
		code: null,
	})}`,
	fallbackOverflow: `prompt is too long: 120000 tokens exceeds the context window of 112000 tokens (400: ${JSON.stringify(
		{
			message: overflowMessage(112_000, 8_000),
			type: "invalid_request_error",
			param: null,
			code: null,
		},
	)})`,
	compactFailure: "Nothing to compact (session too small)",
	memoryGuard: `400: ${JSON.stringify(memoryGuard)}`,
	bareMemoryGuard: "Prefill would require ~16 GB peak but static/metal_cap ceiling is 8 GB.",
	tinyLengthStops: [
		tinyLengthStop("text-a", "A"),
		tinyLengthStop("text-b", "B"),
		tinyLengthStop("text-c", "C"),
		tinyLengthStop("text-d", "D"),
	],
	heartbeat,
};
