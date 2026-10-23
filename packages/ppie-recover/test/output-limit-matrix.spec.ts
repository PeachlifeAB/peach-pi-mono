import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import retry from "../src/retry.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";
import { asExtensionApi, asExtensionContext, CtxFakeCore, PiFakeCore } from "./fakes/pi-fakes.ts";
import { registerRetryAgentForSessionManager } from "./fakes/retry-agent.ts";
import { createScriptedProvider } from "./fakes/scripted-provider.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const CONTEXT_WINDOW = 74_000;
const RECORDED_USAGE = { input: 756, cacheRead: 69_632, output: 1 };

function policyFor(mode: "forced" | "dynamic") {
	return resolveRetryPolicy({
		memory_overflow_protection: {
			compaction:
				mode === "forced"
					? {
							enabled: true,
							forced: { enabled: true, max_attempts: 2, wait_seconds_before_first_attempt: 0 },
							dynamic: { enabled: false },
						}
					: {
							enabled: true,
							forced: { enabled: false },
							dynamic: { enabled: true, at_context_ratio: 0.8 },
						},
			prune: { enabled: false },
		},
	});
}

function scripted(stopReason: AssistantMessage["stopReason"], rawStopReason?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "\n..." }],
		api: "openai-completions",
		provider: "scripted",
		model: "scripted-model",
		usage: { ...RECORDED_USAGE, totalTokens: 70_389, cost },
		stopReason,
		...(rawStopReason ? { rawStopReason, errorMessage: "Response incomplete: max_tokens" } : {}),
		timestamp: 0,
	} as AssistantMessage;
}

async function flush() {
	for (let index = 0; index < 8; index++) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
}

function harness(
	mode: "forced" | "dynamic",
	sequence: readonly AssistantMessage[],
	outputBudget: Readonly<Record<string, number>>,
) {
	const provider = createScriptedProvider(sequence, outputBudget);
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = CONTEXT_WINDOW;
	ctxCore.contextTokens = 70_000;
	ctxCore.model = { contextWindow: CONTEXT_WINDOW, maxTokens: 16_384 };
	const pi = asExtensionApi(piCore);
	const ctx = asExtensionContext(ctxCore);
	let compactionCount = 0;
	ctxCore.onCompactStart = () => piCore.emit("session_before_compact", { reason: "extension", willRetry: false }, ctx);
	ctxCore.onCompactComplete = () => {
		compactionCount++;
		const id = `compact-${compactionCount}`;
		ctxCore.branch.push({
			type: "compaction",
			id,
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "offline",
			firstKeptEntryId: "kept",
			tokensBefore: 70_000,
		} as SessionEntry);
		piCore.emit("session_compact", { compactionEntry: { id }, willRetry: false }, ctx);
	};
	retry(pi, { policy: policyFor(mode) });
	const agent = new Agent({
		streamFn: provider.streamFn,
		onPayload: (payload) => piCore.emitAndGetResult("before_provider_request", { payload }, ctx),
	});
	ctxCore.attachAgentState(agent.state);
	registerRetryAgentForSessionManager(ctxCore.sessionManager, agent);
	const prompt = agent.prompt.bind(agent);
	agent.prompt = (async (...args: Parameters<Agent["prompt"]>) => {
		const result = await prompt(...args);
		piCore.emit("agent_end", { messages: agent.state.messages }, ctx);
		piCore.emit("agent_settled", {}, ctx);
		return result;
	}) as Agent["prompt"];
	agent.subscribe((event) => {
		if (event.type === "message_end") piCore.emit("message_end", { msg: event.message }, ctx);
	});
	return { agent, provider, ctxCore, compactions: () => compactionCount };
}

async function settleRecovery() {
	await vi.advanceTimersByTimeAsync(5_000);
	await flush();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-26T04:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

test("forced recovery does not compact or dispatch a clamped request after length-only pressure", async () => {
	const { agent, provider, compactions } = harness("forced", [scripted("length"), scripted("length")], {
		max_tokens: 1,
	});
	await agent.prompt("start");
	await settleRecovery();
	expect(compactions()).toBe(0);
	expect(provider.requests).toHaveLength(1);
});

test("dynamic recovery does not dispatch a clamped request before context reduction", async () => {
	const { agent, provider, compactions } = harness("dynamic", [scripted("length"), scripted("length")], {
		max_tokens: 1,
	});
	await agent.prompt("start");
	await settleRecovery();
	expect(compactions()).toBe(1);
	expect(provider.requests).toHaveLength(1);
});

test("Responses stale one-token budget is repaired without compaction", async () => {
	const { agent, provider, compactions } = harness(
		"forced",
		[scripted("error", "incomplete.max_tokens"), scripted("stop")],
		{ max_output_tokens: 1 },
	);
	await agent.prompt("start");
	await flush();
	expect(compactions()).toBe(0);
	expect(provider.requests).toHaveLength(2);
	expect(provider.requests[1]).toMatchObject({ max_output_tokens: expect.any(Number) });
	expect((provider.requests[1] as { max_output_tokens: number }).max_output_tokens).toBeGreaterThan(1);
});
