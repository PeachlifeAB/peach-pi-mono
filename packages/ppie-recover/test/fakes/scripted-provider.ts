import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export function assistantMessage(stopReason: "error" | "stop", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: stopReason === "stop" ? [{ type: "text", text: "Recovered." }] : [],
		api: "openai-completions",
		provider: "scripted",
		model: "scripted-model",
		usage: {
			input: 0,
			output: stopReason === "stop" ? 5 : 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: stopReason === "stop" ? 5 : 0,
			cost,
		},
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

export function createScriptedProvider(
	sequence: readonly AssistantMessage[],
	outputBudget: Readonly<Record<string, number>> = { max_tokens: 8000 },
): {
	readonly requests: unknown[];
	readonly streamFn: StreamFn;
} {
	const requests: unknown[] = [];
	let index = 0;
	const streamFn: StreamFn = async (model, context, options) => {
		let payload: unknown = { messages: context.messages, ...outputBudget };
		const transformed = await options?.onPayload?.(payload, model);
		if (transformed !== undefined) payload = transformed;
		requests.push(structuredClone(payload));
		const message = sequence[Math.min(index++, sequence.length - 1)];
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else if (message.stopReason === "pending") {
				// pi 0.84 added `pending` to `StopReason`; it is not a terminal reason,
				// so a scripted message carrying it has no `done` event to emit.
				stream.push({ type: "error", reason: "error", error: message });
			} else {
				stream.push({ type: "done", reason: message.stopReason, message });
			}
		});
		return stream;
	};
	return { requests, streamFn };
}
