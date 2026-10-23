/**
 * A recovery episode spans one provider failure to the next successful
 * response. Retry budgets and the episode clock belong to that episode, not
 * to the user turn: an autonomous turn with many successful LLM calls must
 * never inherit the cost of failures it already recovered from.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type AssistantFixture,
	cleanStop,
	errorMessage,
	harness,
	lastAssistantStop,
	promptOnce,
} from "./fakes/real-agent-harness.ts";

const TRANSIENT = "terminated";
const SLOW_TOOL = "slow_task";
const SLOW_TOOL_MS = 16 * 60_000;
const RULE_ATTEMPTS = 5;
const UNRECOGNIZED = "Unexpected provider failure";
const OUTAGE_FAILURES = 12;
const TIME_HEALS_FAILURES = [
	"terminated",
	"WebSocket closed 1012",
	"Codex error: Our servers are currently overloaded. Please try again later",
	"503 service unavailable",
	"fetch failed",
];

function toolUse(id: string): AssistantFixture {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: SLOW_TOOL, arguments: {} }],
		model: "gpt-6.1-sol",
		stopReason: "toolUse",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
	};
}

function slowTool(durationMs: number): AgentTool {
	return {
		name: SLOW_TOOL,
		label: SLOW_TOOL,
		description: "Long-running tool",
		parameters: { type: "object", properties: {} } as never,
		execute: async () => {
			await new Promise((resolve) => setTimeout(resolve, durationMs));
			return { content: [{ type: "text", text: "done" }], details: undefined };
		},
	};
}

async function runFor(ms: number) {
	const stepMs = 30_000;
	for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
		await vi.advanceTimersByTimeAsync(stepMs);
	}
}

function gaveUp(ctxCore: ReturnType<typeof harness>["ctxCore"]) {
	return ctxCore.ui.notifications.some((n) => n.message.includes("gave up"));
}

describe("recovery episode ends at provider progress", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		vi.setSystemTime(new Date("2026-10-02T18:23:41.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("a transient error after a long healthy stretch is retried, not given up", async () => {
		const { agent, provider, ctxCore } = harness([
			errorMessage(TRANSIENT),
			toolUse("call_slow"),
			errorMessage(TRANSIENT),
			cleanStop(),
		]);
		agent.state.tools = [slowTool(SLOW_TOOL_MS)];

		await promptOnce(agent);
		await runFor(SLOW_TOOL_MS + 10 * 60_000);

		expect(gaveUp(ctxCore)).toBe(false);
		expect(provider.requests).toHaveLength(4);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("transient errors separated by successful responses never exhaust the rule budget", async () => {
		const recovered = Array.from({ length: RULE_ATTEMPTS + 1 }, (_, round) => [
			errorMessage(TRANSIENT),
			toolUse(`call_${round}`),
		]).flat();
		const { agent, provider, ctxCore } = harness([...recovered, cleanStop()]);
		agent.state.tools = [slowTool(0)];

		await promptOnce(agent);
		await runFor(30 * 60_000);

		expect(gaveUp(ctxCore)).toBe(false);
		expect(provider.requests).toHaveLength(recovered.length + 1);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("unrecognized failures without progress stay bounded by the baseline budget", async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(UNRECOGNIZED)]);

		await promptOnce(agent);
		await runFor(60 * 60_000);

		expect(provider.requests).toHaveLength(1 + RULE_ATTEMPTS);
		expect(gaveUp(ctxCore)).toBe(true);
	});

	test.each(TIME_HEALS_FAILURES)("a time-heals outage (%s) is retried until the provider returns", async (failure) => {
		const outage = Array.from({ length: OUTAGE_FAILURES }, () => errorMessage(failure));
		const { agent, provider, ctxCore } = harness([...outage, cleanStop()]);

		await promptOnce(agent);
		await runFor(OUTAGE_FAILURES * 1000 * 1000);

		expect(gaveUp(ctxCore)).toBe(false);
		expect(provider.requests).toHaveLength(OUTAGE_FAILURES + 1);
		expect(lastAssistantStop(agent)).toBe("stop");
	});
});
