import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import retry from "../src/retry.ts";
import { DEFAULT_CONFIG } from "../src/retry-config-defaults.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";
import { CtxFakeCore, noOpProxy, PiFakeCore } from "./fakes/pi-fakes.ts";
import { registerRetryAgentForSessionManager } from "./fakes/retry-agent.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const memoryError =
	"Request aborted: process memory limit exceeded (usage 49.6 GB, ceiling 51.3 GB). Reduce context size.";

function message(stopReason: "error" | "stop") {
	return {
		role: "assistant" as const,
		content: stopReason === "stop" ? [{ type: "text" as const, text: "Done." }] : [],
		api: "openai-completions" as const,
		provider: "capacity-fake",
		model: "capacity-model",
		usage: {
			input: 0,
			output: stopReason === "stop" ? 1 : 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost,
		},
		stopReason,
		timestamp: Date.now(),
		...(stopReason === "error" ? { errorMessage: memoryError } : {}),
	};
}

function streamFor(result: ReturnType<typeof message>) {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: result };
			yield {
				type: "done",
				reason: result.stopReason,
				message: result,
			};
		},
		result: () => Promise.resolve(result),
	};
}

class CapacityProvider {
	readonly requests: unknown[] = [];
	baselineTokens = 0;
	capacityTokens = 0;

	readonly streamFn = async (
		_model: unknown,
		context: { messages: unknown[] },
		options?: {
			onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
		},
	) => {
		let payload: unknown = { messages: context.messages, max_tokens: 8000 };
		const transformed = await options?.onPayload?.(payload, _model);
		if (transformed !== undefined) payload = transformed;
		this.requests.push(structuredClone(payload));
		const tokens = Math.ceil((JSON.stringify(payload)?.length ?? 0) / 4);
		if (this.baselineTokens === 0) {
			this.baselineTokens = tokens;
			this.capacityTokens = Math.floor(tokens * 0.45);
		}
		return streamFor(message(tokens <= this.capacityTokens ? "stop" : "error"));
	};
}

async function flushAsync() {
	for (let index = 0; index < 5; index++) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("real Agent recovery succeeds only when cumulative pruning crosses provider capacity", async () => {
	const provider = new CapacityProvider();
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 500_000;
	const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore) as unknown as CtxFakeCore;
	ctxCore.onCompactStart = () => pi.emit("session_before_compact", { reason: "extension" }, ctx);
	ctxCore.onCompactComplete = () => pi.emit("session_compact", { compactionEntry: { id: "capacity-compact" } }, ctx);

	const defaultAttempts = DEFAULT_CONFIG.retry.max_attempts;
	const overflowWords = [...DEFAULT_CONFIG.retry.smart_overrides[1].when.words];
	retry(pi, {
		policy: resolveRetryPolicy({
			retry: {
				max_attempts: defaultAttempts,
				smart_overrides: [{ when: { words: overflowWords }, max_attempts: defaultAttempts }],
			},
			memory_overflow_protection: {
				compaction: {
					enabled: true,
					forced: {
						enabled: true,
						// The ladder under test escalates 0.75 -> 0.50 -> 0.25, so it needs
						// three prune attempts; the default of 1 stops after the first.
					},
				},
				prune: { enabled: true, max_attempts: 3 },
			},
		}),
	});
	const agent = new Agent({
		streamFn: provider.streamFn as unknown as StreamFn,
		onPayload: (payload: unknown) => pi.emitAndGetResult<unknown>("before_provider_request", { payload }, ctx),
	});
	agent.state.messages = [
		{ role: "system", content: "preserve system framing" },
		{ role: "assistant", content: "x".repeat(400_000) },
		{ role: "user", content: "continue" },
	] as never;
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

	await agent.prompt("start");
	await flushAsync();
	expect(provider.requests).toHaveLength(1);
	expect(ctxCore.compactions).toHaveLength(0);
	await vi.advanceTimersByTimeAsync(20_000);
	await flushAsync();
	expect(ctxCore.compactions).toHaveLength(1);

	// Drive every scheduled recovery step to completion. Compact-twice runs two
	// unpruned compaction retries first, then progressive emergency pruning.
	for (let step = 0; step < 12; step++) {
		await vi.advanceTimersByTimeAsync(64_000);
		await flushAsync();
	}

	const sizes = provider.requests.map((payload) => Math.ceil((JSON.stringify(payload)?.length ?? 0) / 4));
	// req0 initial + req1/req2 the two unpruned compaction retries (all above
	// capacity), then progressive prunes 0.75 → 0.50 → 0.25 of the original,
	// the last of which finally fits.
	expect(sizes).toHaveLength(6);
	expect(sizes[0]).toBeGreaterThan(provider.capacityTokens);
	expect(sizes[1]).toBeGreaterThan(provider.capacityTokens);
	expect(sizes[2]).toBeGreaterThan(provider.capacityTokens);
	expect(sizes[3] / sizes[0]).toBeCloseTo(0.75, 1);
	expect(sizes[4] / sizes[0]).toBeCloseTo(0.5, 1);
	expect(sizes[5] / sizes[0]).toBeCloseTo(0.25, 1);
	expect(sizes[5]).toBeLessThanOrEqual(provider.capacityTokens);
});
