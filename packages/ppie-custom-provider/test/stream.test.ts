import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAIGeneric } from "../src/stream.ts";

const model: Model<Api> = {
	id: "fixture-model",
	name: "Fixture Model",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "http://provider.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 },
	contextWindow: 32768,
	maxTokens: 2048,
};

const context: Context = {
	messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
};
const encoder = new TextEncoder();

function stubStream(chunks: string[]): void {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body)),
	);
}

async function collectEvents() {
	const events = [];
	for await (const event of streamOpenAIGeneric(model, context)) events.push(event);
	return events;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamOpenAIGeneric", () => {
	it("streams thinking and text deltas, usage, and a normal completion", async () => {
		stubStream([
			'{"thinking_delta":"reason"}\n',
			'{"thinking_delta":"ing"}\n',
			'{"delta":"answer"}\n',
			'{"usage":{"input_tokens":10,"output_tokens":4}}\n',
			'{"done":true}\n',
		]);

		const events = await collectEvents();
		const done = events.find((event) => event.type === "done");

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(done).toMatchObject({
			type: "done",
			message: {
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "reasoning" },
					{ type: "text", text: "answer" },
				],
				usage: { input: 10, output: 4, totalTokens: 14 },
			},
		});
		expect((done as { message: AssistantMessage }).message.usage.cost.total).toBeCloseTo(0.000018);
	});

	it("assembles tool-call argument deltas and ignores malformed or unrelated chunks", async () => {
		stubStream([
			"not-json\n",
			"\n",
			'{"unknown":"ignored"}\n',
			'{"tool_call":{"id":"call-1","name":"lookup"}}\n',
			'{"tool_call_delta":{"id":"call-1","arguments_delta":"{\\"query\\":"}}\n',
			'{"tool_call_delta":{"id":"call-1","arguments_delta":"\\"weather\\"}"}}\n',
			'{"done":true}\n',
		]);

		const events = await collectEvents();
		const done = events.find((event) => event.type === "done");

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(done).toMatchObject({
			type: "done",
			message: {
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "weather" } }],
			},
		});
	});

	it("turns HTTP failures, missing bodies, and streams without a stop marker into error events", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unavailable", { status: 503 })),
		);
		const httpFailure = await collectEvents();
		expect(httpFailure.at(-1)).toMatchObject({ type: "error", error: { stopReason: "error" } });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null)),
		);
		const missingBody = await collectEvents();
		expect(missingBody.at(-1)).toMatchObject({ type: "error", error: { stopReason: "error" } });

		stubStream(['{"delta":"partial"}\n']);
		const missingStop = await collectEvents();
		expect(missingStop.at(-1)).toMatchObject({ type: "error", error: { stopReason: "error" } });
	});

	it("reports transport rejection as an error event", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("connection refused"))),
		);

		const events = await collectEvents();

		expect(events.at(-1)).toMatchObject({
			type: "error",
			error: { stopReason: "error", errorMessage: "connection refused", content: [] },
		});
	});
});
