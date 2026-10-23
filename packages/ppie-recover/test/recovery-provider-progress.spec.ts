import { afterEach, beforeEach, expect, test, vi } from "vitest";
import retry from "../src/retry.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";
import { asExtensionApi, asExtensionContext, CtxFakeCore, PiFakeCore } from "./fakes/pi-fakes.ts";
import { cleanStop, errorMessage, promptOnce, harness as realAgentHarness } from "./fakes/real-agent-harness.ts";

const lengthResponse = {
	role: "assistant",
	stopReason: "length",
	content: [{ type: "thinking", thinking: "\n" }],
	usage: { input: 1850, cacheRead: 69632, cacheWrite: 0, output: 1, totalTokens: 71483 },
	timestamp: Date.parse("2026-10-06T13:44:54.929Z"),
};

function harness() {
	const pi = new PiFakeCore();
	const core = new CtxFakeCore();
	core.model = { contextWindow: 73900, maxTokens: 16384 };
	core.contextWindow = 73900;
	core.contextTokens = 60873;
	const ctx = asExtensionContext(core);
	retry(asExtensionApi(pi), {
		policy: resolveRetryPolicy({
			retry: { seconds_before_first_retry: 16 },
			memory_overflow_protection: {
				compaction: { enabled: true, dynamic: { enabled: false }, forced: { enabled: false } },
				prune: { enabled: false },
			},
		}),
	});
	const emit = (event: string, payload: object) => pi.emit(event, payload, ctx);
	return { pi, core, emit };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

for (const stopReason of ["stop", "toolUse"] as const) {
	test(`${stopReason} retires queued length recovery before its deadline`, async () => {
		const h = harness();
		h.emit("message_end", { msg: lengthResponse });
		h.emit("agent_settled", {});
		expect(h.core.ui.status.some((s) => s.includes("⏳ waiting for compaction"))).toBe(true);
		const notificationsBeforeSuccess = h.core.ui.notifications.length;
		h.emit("message_end", {
			msg: {
				role: "assistant",
				stopReason,
				content: [{ type: "text", text: "Recovered response with real progress" }],
			},
		});
		await vi.advanceTimersByTimeAsync(700_000);
		expect(h.core.ui.notifications.slice(notificationsBeforeSuccess)).toEqual([]);
		expect(h.core.compactions).toHaveLength(0);
		expect(h.pi.sentUserMessages).toHaveLength(0);
		expect(h.core.abortCallCount).toBe(0);
	});
}

test("completed host compaction measures reduction from its own start", async () => {
	const h = harness();
	h.emit("message_end", { msg: lengthResponse });
	h.emit("session_before_compact", { reason: "manual", willRetry: false });
	h.core.contextTokens = 30_000;
	h.emit("session_compact", { willRetry: false });
	await vi.advanceTimersByTimeAsync(0);
	expect(h.core.ui.notifications.some(({ message }) => message.includes("context was not reduced"))).toBe(false);
	expect(h.core.ui.status).toContain("🔁 retrying");
});

test("a superseded retry wait cannot consume the next episode's rule budget", async () => {
	const failure = "Unexpected provider failure";
	const h = realAgentHarness(
		[errorMessage(failure), cleanStop(), ...Array.from({ length: 10 }, () => errorMessage(failure))],
		resolveRetryPolicy({ retry: { seconds_before_first_retry: 16 } }),
	);
	await promptOnce(h.agent);
	await promptOnce(h.agent);
	await vi.advanceTimersByTimeAsync(16_000);
	await promptOnce(h.agent);
	await vi.advanceTimersByTimeAsync(1_000_000);
	expect(h.provider.requests).toHaveLength(8);
});

test("healthy tool progress cancels a follow-up waiting behind host messages", async () => {
	const h = harness();
	h.core.pendingMessages = true;
	h.emit("message_end", {
		msg: {
			role: "assistant",
			stopReason: "length",
			content: [{ type: "text", text: "x".repeat(4000) }],
			usage: { input: 60_000, output: 4000, cacheRead: 0, cacheWrite: 0, totalTokens: 64_000 },
		},
	});
	h.emit("session_before_compact", { reason: "manual", willRetry: false });
	h.core.contextTokens = 30_000;
	h.emit("session_compact", { willRetry: false });
	await vi.advanceTimersByTimeAsync(0);
	expect(h.core.ui.notifications.some(({ message }) => message.includes("queued messages"))).toBe(true);
	h.emit("message_end", {
		msg: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Healthy progress" }] },
	});
	h.core.pendingMessages = false;
	await vi.advanceTimersByTimeAsync(1000);
	expect(h.pi.sentUserMessages).toEqual([]);
});
