import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import retry from "../../src/retry.ts";
import { CtxFakeCore, noOpProxy, PiFakeCore } from "./pi-fakes.ts";
import { registerRetryAgentForSessionManager } from "./retry-agent.ts";
import { ENABLED_OVERFLOW_POLICY } from "./retry-policy.ts";

export const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export type AssistantFixture = {
	role?: string;
	content?: unknown;
	model?: string;
	responseModel?: string;
	stopReason?: string;
	errorMessage?: unknown;
	usage?: Record<string, unknown>;
};

export function cleanStop(): AssistantFixture {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
		stopReason: "stop",
		usage: {
			input: 2360,
			cacheRead: 106_496,
			output: 5,
			cacheWrite: 0,
			totalTokens: 0,
			cost,
		},
	};
}

export function tinyStopI(): AssistantFixture {
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "\nI",
				thinkingSignature: "reasoning_content",
			},
			{ type: "text", text: "\n\nI" },
		],
		model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
		responseModel: "keepalive",
		stopReason: "stop",
		usage: {
			input: 2301,
			output: 5,
			cacheRead: 83_968,
			cacheWrite: 0,
			totalTokens: 86_274,
			cost,
		},
	};
}

export function errorMessage(errorMessage: string): AssistantFixture {
	return {
		role: "assistant",
		content: [],
		model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
		stopReason: "error",
		errorMessage,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost,
		},
	};
}

export function largeLengthTruncation(): AssistantFixture {
	return {
		role: "assistant",
		stopReason: "length",
		model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
		content: [{ type: "text", text: "x".repeat(4000) }],
		usage: { input: 1000, output: 4000 },
	};
}

export function streamFor(message: AssistantFixture) {
	const stopReason = message.stopReason ?? "stop";
	const terminal =
		stopReason === "error"
			? { type: "error", reason: "error", error: message }
			: { type: "done", reason: stopReason, message };
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: message };
			yield terminal;
		},
		result: () => Promise.resolve(message),
	};
}

// pi-agent-core's Agent has NO built-in concept of "before_provider_request"
// — that event is a pi-coding-agent-level hook. The REAL wiring, traced
// through the installed packages:
//   1. agent.js: AgentOptions.onPayload -> config.onPayload
//      (createLoopConfig, agent.js:286).
//   2. agent-loop.js:186-193: streamFunction(model, llmContext, {...config,
//      apiKey, signal}) — onPayload rides along INSIDE the options object
//      passed as the THIRD argument to the injected StreamFn. pi-agent-core
//      itself never calls onPayload directly.
//   3. The REAL provider adapter is what invokes it — e.g. pi-ai's
//      openai-completions.js:77-81 (oMLX's real adapter, OpenAI-compatible):
//      `params = buildParams(...); const nextParams = await
//      options?.onPayload?.(params, model); if (nextParams !== undefined)
//      params = nextParams;` — onPayload receives the REAL, already-built
//      request params (not the raw AgentMessage[] array), and its return
//      value (if defined) REPLACES the outgoing params.
//   4. pi-coding-agent's sdk.js:200-205 supplies the onPayload that calls
//      extensionRunner.emitBeforeProviderRequest(payload) — the bridge to
//      ppie-recover's own before_provider_request handler.
//
// This fake's streamFn used to ignore its own third parameter entirely,
// so onPayload NEVER FIRED — every "real Agent" test in this suite was
// silently not exercising before_provider_request through the real Agent
// at all, no matter how the harness was wired at the Agent-options level.
// Fixed: this fake now reads options.onPayload itself and calls it with a
// realistic params object built from the real context.messages, exactly
// mirroring openai-completions.js's real contract (params replaced if
// onPayload returns non-undefined).
class ProviderFake {
	readonly requests: unknown[] = [];
	// Real oMLX/openai-completions requests always carry max_tokens (or
	// max_completion_tokens) in the payload (buildParams in pi-ai's
	// openai-completions.js) — this fake must too, since
	// requestedMaxOutputTokensOf(payload) (overflow-recovery.ts) reads it
	// directly off the payload instead of guessing. Configurable per test
	// (some tests want to prove the getReserveTokens() fallback when it's
	// absent).
	maxTokens: number | undefined = 8000;
	constructor(private readonly sequence: AssistantFixture[]) {}
	readonly streamFn = async (
		_model: unknown,
		context: { messages: unknown[] },
		options?: {
			onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
		},
	) => {
		let params: unknown = {
			messages: context.messages,
			...(this.maxTokens === undefined ? {} : { max_tokens: this.maxTokens }),
		};
		const nextParams = await options?.onPayload?.(params, _model);
		if (nextParams !== undefined) params = nextParams;
		this.requests.push(structuredClone(params));

		const message = this.sequence[Math.min(this.requests.length - 1, this.sequence.length - 1)];
		return streamFor(message);
	};
}

export function harness(sequence: AssistantFixture[], policy = ENABLED_OVERFLOW_POLICY) {
	const provider = new ProviderFake(sequence);
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.model = { maxTokens: provider.maxTokens };
	const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore) as unknown as CtxFakeCore;
	ctxCore.onCompactStart = () => pi.emit("session_before_compact", { reason: "extension", willRetry: false }, ctx);
	ctxCore.onCompactComplete = () => pi.emit("session_compact", { compactionEntry: { id: "fake-compact" } }, ctx);

	retry(pi, { policy });
	const agent = new Agent({
		streamFn: provider.streamFn as unknown as StreamFn,
		onPayload: (payload: unknown) => pi.emitAndGetResult<unknown>("before_provider_request", { payload }, ctx),
	});
	ctxCore.attachAgentState(agent.state);
	registerRetryAgentForSessionManager(ctxCore.sessionManager, agent);
	const originalPrompt = agent.prompt.bind(agent);
	agent.prompt = (async (...args: Parameters<Agent["prompt"]>) => {
		const result = await originalPrompt(...args);
		pi.emit("agent_end", {}, ctx);
		pi.emit("agent_settled", {}, ctx);
		return result;
	}) as Agent["prompt"];
	agent.subscribe((event: { type: string; message?: unknown }) => {
		if (event.type === "message_end") {
			pi.emit("message_end", { msg: event.message }, ctx);
		}
	});

	return { agent, provider, pi, piCore, ctx, ctxCore };
}

export function emitCompactionComplete(pi: ExtensionAPI & PiFakeCore, ctx: CtxFakeCore, id = "core") {
	pi.emit("session_before_compact", { reason: "overflow" }, ctx);
	pi.emit("session_compact", { compactionEntry: { id } }, ctx);
}

export async function flushAsync() {
	for (let i = 0; i < 5; i++) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
}

export async function promptOnce(agent: Agent) {
	await agent.prompt("hi");
	await flushAsync();
}

export function lastAssistantStop(agent: Agent) {
	return (
		agent.state.messages.filter((message) => message.role === "assistant").at(-1) as
			| { stopReason?: string }
			| undefined
	)?.stopReason;
}
