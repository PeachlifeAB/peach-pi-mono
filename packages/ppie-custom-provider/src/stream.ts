import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

interface RemoteChunk {
	delta?: string;
	thinking_delta?: string;
	tool_call?: { id: string; name: string };
	tool_call_delta?: { id: string; arguments_delta: string };
	done?: boolean;
	usage?: Record<string, number>;
}

/**
 * Parses one newline-delimited chunk, returning undefined for anything
 * unusable.
 *
 * Deliberately tolerant: a single malformed line is far more likely to be a
 * keep-alive, a comment, or a partial flush than a fatal protocol error, and
 * `JSON.parse` throwing here would abort an otherwise healthy stream mid-answer
 * and discard everything already generated. Fatal conditions (connection loss,
 * non-2xx) are still surfaced by the caller's try/catch.
 */
function parseChunk(line: string): RemoteChunk | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	return parsed as RemoteChunk;
}

interface StreamState {
	output: AssistantMessage;
	thinkingIndex: number;
	textIndex: number;
	toolCallIndex: number;
	toolCallJson: string;
	stopReasonSet: boolean;
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function closeThinking(stream: AssistantMessageEventStream, state: StreamState): void {
	if (state.thinkingIndex === -1) return;
	const block = state.output.content[state.thinkingIndex];
	stream.push({
		type: "thinking_end",
		contentIndex: state.thinkingIndex,
		content: block.type === "thinking" ? block.thinking : "",
		partial: state.output,
	});
	state.thinkingIndex = -1;
}

function appendThinking(chunk: RemoteChunk, stream: AssistantMessageEventStream, state: StreamState): void {
	if (!chunk.thinking_delta) return;
	if (state.thinkingIndex === -1) {
		state.output.content.push({ type: "thinking", thinking: "" });
		state.thinkingIndex = state.output.content.length - 1;
		stream.push({ type: "thinking_start", contentIndex: state.thinkingIndex, partial: state.output });
	}
	const block = state.output.content[state.thinkingIndex];
	if (block.type !== "thinking") return;
	block.thinking += chunk.thinking_delta;
	stream.push({
		type: "thinking_delta",
		contentIndex: state.thinkingIndex,
		delta: chunk.thinking_delta,
		partial: state.output,
	});
}

function appendText(chunk: RemoteChunk, stream: AssistantMessageEventStream, state: StreamState): void {
	if (!chunk.delta) return;
	closeThinking(stream, state);
	if (state.textIndex === -1) {
		state.output.content.push({ type: "text", text: "" });
		state.textIndex = state.output.content.length - 1;
		stream.push({ type: "text_start", contentIndex: state.textIndex, partial: state.output });
	}
	const block = state.output.content[state.textIndex];
	if (block.type !== "text") return;
	block.text += chunk.delta;
	stream.push({ type: "text_delta", contentIndex: state.textIndex, delta: chunk.delta, partial: state.output });
}

function startToolCall(chunk: RemoteChunk, stream: AssistantMessageEventStream, state: StreamState): void {
	if (!chunk.tool_call) return;
	closeThinking(stream, state);
	state.output.content.push({
		type: "toolCall",
		id: chunk.tool_call.id,
		name: chunk.tool_call.name,
		arguments: {},
	});
	state.toolCallIndex = state.output.content.length - 1;
	state.toolCallJson = "";
	stream.push({ type: "toolcall_start", contentIndex: state.toolCallIndex, partial: state.output });
}

function appendToolCallDelta(chunk: RemoteChunk, stream: AssistantMessageEventStream, state: StreamState): void {
	if (!chunk.tool_call_delta || state.toolCallIndex === -1) return;
	state.toolCallJson += chunk.tool_call_delta.arguments_delta;
	const block = state.output.content[state.toolCallIndex];
	if (block.type !== "toolCall") return;
	try {
		block.arguments = JSON.parse(state.toolCallJson);
	} catch {
		// Incomplete JSON while streaming; keep accumulating.
	}
	stream.push({
		type: "toolcall_delta",
		contentIndex: state.toolCallIndex,
		delta: chunk.tool_call_delta.arguments_delta,
		partial: state.output,
	});
}

function updateUsage(chunk: RemoteChunk, model: Model<Api>, state: StreamState): void {
	if (!chunk.usage) return;
	state.output.usage.input = chunk.usage.input_tokens ?? 0;
	state.output.usage.output = chunk.usage.output_tokens ?? 0;
	state.output.usage.cacheRead = chunk.usage.cache_read_tokens ?? 0;
	state.output.usage.cacheWrite = chunk.usage.cache_write_tokens ?? 0;
	state.output.usage.totalTokens =
		state.output.usage.input +
		state.output.usage.output +
		state.output.usage.cacheRead +
		state.output.usage.cacheWrite;
	calculateCost(model, state.output.usage);
}

function finishToolCall(stream: AssistantMessageEventStream, state: StreamState): void {
	if (state.toolCallIndex === -1) return;
	const block = state.output.content[state.toolCallIndex];
	if (block.type !== "toolCall") return;
	stream.push({
		type: "toolcall_end",
		contentIndex: state.toolCallIndex,
		toolCall: { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments },
		partial: state.output,
	});
}

function processChunk(
	chunk: RemoteChunk,
	model: Model<Api>,
	stream: AssistantMessageEventStream,
	state: StreamState,
): void {
	appendThinking(chunk, stream, state);
	appendText(chunk, stream, state);
	startToolCall(chunk, stream, state);
	appendToolCallDelta(chunk, stream, state);
	updateUsage(chunk, model, state);
	if (!chunk.done) return;
	finishToolCall(stream, state);
	state.output.stopReason = state.toolCallIndex !== -1 ? "toolUse" : "stop";
	state.stopReasonSet = true;
}

function finishStream(stream: AssistantMessageEventStream, state: StreamState): void {
	closeThinking(stream, state);
	if (state.textIndex !== -1) {
		const block = state.output.content[state.textIndex];
		stream.push({
			type: "text_end",
			contentIndex: state.textIndex,
			content: block.type === "text" ? block.text : "",
			partial: state.output,
		});
	}
	if (!state.stopReasonSet) throw new Error("Provider stream ended without a stop reason");
	switch (state.output.stopReason) {
		case "stop":
		case "length":
		case "toolUse":
			stream.push({ type: "done", reason: state.output.stopReason, message: state.output });
			stream.end();
			return;
		case "error":
		case "aborted":
			throw new Error(state.output.errorMessage || "An unknown error occurred");
	}
}

/**
 * Custom streaming implementation for the provider's non-standard SSE dialect:
 * one JSON object per line (not `data: ...` framed), with separate delta kinds
 * for text, thinking, and tool-call content so every AssistantMessageEvent
 * variant gets exercised.
 */
export function streamOpenAIGeneric(
	// `Model<Api>` rather than `Model<any>`: this stream serves any api type, but
	// `any` would silently disable checking on every other field of the model.
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const state: StreamState = {
		output: createOutput(model),
		thinkingIndex: -1,
		textIndex: -1,
		toolCallIndex: -1,
		toolCallJson: "",
		stopReasonSet: false,
	};

	(async () => {
		try {
			stream.push({ type: "start", partial: state.output });
			const response = await fetch(`${model.baseUrl}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: model.id, messages: context.messages, stream: true }),
				signal: options?.signal,
			});
			if (!response.body) throw new Error("Provider returned no response body");

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newlineIndex: number;
				// biome-ignore lint/suspicious/noAssignInExpressions: standard buffer-drain idiom; the index must be recomputed each iteration against the shrinking buffer, and hoisting it out would duplicate the indexOf call.
				while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newlineIndex).trim();
					buffer = buffer.slice(newlineIndex + 1);
					if (!line) continue;
					const chunk = parseChunk(line);
					if (chunk) processChunk(chunk, model, stream, state);
				}
			}
			finishStream(stream, state);
		} catch (error) {
			state.output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			state.output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: state.output.stopReason, error: state.output });
			stream.end();
		}
	})();

	return stream;
}
