/**
 * Real public-interface tests with deterministic time.
 *
 * Public SUT: retry(pi) + the REAL Agent from @earendil-works/pi-agent-core.
 * Dependency-injection-testing skill applied:
 * - Ports: provider streamFn, pi host event bus, ExtensionContext/ui/compact.
 * - Fakes: stateful fakes for those ports.
 * - Fixtures: synthetic scenarios from test/fakes/recovery-scenarios.ts.
 * - Time: Vitest virtual timers; no wall sleeps.
 * - Assertions: observable Agent state + fake adapter state, not source text.
 */

import process from "node:process";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createErrorRuleEngine } from "../src/error-rule-engine.ts";
import retry from "../src/retry.ts";
import { DEFAULT_RETRY_POLICY, resolveRetryPolicy } from "../src/retry-policy.ts";

// Compaction ships on; these cases cover a user who turned it off.
const COMPACTION_OFF_POLICY = resolveRetryPolicy({ memory_overflow_protection: { compaction: { enabled: false } } });

import { CtxFakeCore, noOpProxy, PiFakeCore } from "./fakes/pi-fakes.ts";
import {
	type AssistantFixture,
	cleanStop,
	cost,
	emitCompactionComplete,
	errorMessage,
	flushAsync,
	harness,
	largeLengthTruncation,
	lastAssistantStop,
	promptOnce,
	streamFor,
	tinyStopI,
} from "./fakes/real-agent-harness.ts";
import { recoveryScenarios } from "./fakes/recovery-scenarios.ts";
import { registerRetryAgentForSessionManager } from "./fakes/retry-agent.ts";
import { ENABLED_OVERFLOW_POLICY, enabledOverflowPolicy } from "./fakes/retry-policy.ts";
import { fakeAssistantSessionEntry } from "./fakes/session-entry.ts";

const CORE_TERMINAL_OVERFLOW_FAILURE =
	'prompt is too long: 1625504 tokens exceeds the context window of 112000 tokens (400: {"message":"Prompt too long: 1625504 tokens exceeds max context window of 112000 tokens","type":"invalid_request_error","param":null,"code":null})\n\nContext overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.';

// ppie-recover classifies this as context_overflow; no pi-ai pattern matches it, so core never claims it.
const CORE_UNRECOGNIZED_OVERFLOW = "400 Request has 180854 tokens; max context window of 72099 tokens";

describe("retry(pi) real public interface via real Agent", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
		});
		vi.setSystemTime(new Date("2026-07-08T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	for (const fixture of recoveryScenarios.tinyLengthStops) {
		test(`1-token length stop ${fixture.id} heals after core compaction`, async () => {
			const { agent, provider, pi, ctx, ctxCore } = harness([fixture, cleanStop()]);

			await promptOnce(agent);
			expect(provider.requests).toHaveLength(1);
			expect(lastAssistantStop(agent)).toBe("length");

			emitCompactionComplete(pi, ctx);
			await flushAsync();

			expect(provider.requests).toHaveLength(2);
			expect(lastAssistantStop(agent)).toBe("stop");
			expect(ctxCore.compactions).toHaveLength(0);
		});
	}

	test("keepalive-with-real-output is not swallowed before recovery", async () => {
		const { agent, provider, pi, ctx } = harness([recoveryScenarios.tinyLengthStops[2], cleanStop()]);

		await promptOnce(agent);
		emitCompactionComplete(pi, ctx);
		await flushAsync();

		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("zero-output heartbeat contract is ignored, not healed", async () => {
		const { agent, provider, pi, ctx } = harness([recoveryScenarios.heartbeat as AssistantFixture, cleanStop()]);

		await promptOnce(agent);
		emitCompactionComplete(pi, ctx);
		await flushAsync();

		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("length");
	});

	test("length-only pressure does not force compact after the recovery wait", async () => {
		const { agent, provider, ctxCore } = harness([recoveryScenarios.tinyLengthStops[0], cleanStop()]);

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();

		expect(ctxCore.compactions).toHaveLength(0);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("length");
	});

	// (An earlier test here asserted the same engine-driving rescue delivered
	// via pi.sendUserMessage({ deliverAs: "steer" }) — deleted: that channel is
	// exactly what pi core rejects in this state; the test below owns the
	// full contract, transcript delivery included.)
	// Reported live (oh-my-tokens session 019f7aa6): the guard above DID fire
	// and re-delivered the human's message via pi.sendUserMessage(...,
	// { deliverAs: "steer" }) — but the message was STILL lost, with the UI
	// showing `Extension "<runtime>" error: Agent is already processing a
	// prompt. Use steer() or followUp() to queue messages, or wait for
	// completion.` Root cause is pi core's routing: AgentSession.sendUserMessage
	// maps deliverAs → prompt({ streamingBehavior }), but AgentSession.prompt
	// honors streamingBehavior only `if (this.isStreaming)` (agent-session.js).
	// In the engine-driving state AgentSession believes it is idle, so the
	// explicit "steer" is silently discarded, the call falls through to
	// Agent.prompt(), Agent.activeRun is set by ppie-recover's own drive, and it
	// throws (pi-agent-core agent.js). bindCore's wrapper swallows the
	// rejection as a "<runtime>" error — so the rescue path itself drops the
	// message. The delivery must reach the Agent's steering queue directly and
	// survive into the transcript.
	test("rescued human input while the engine drives the Agent must reach the transcript — sendUserMessage steer routing rejects in this state", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const piCore = new PiFakeCore();
		const ctxCore = new CtxFakeCore();
		ctxCore.model = { maxTokens: 8_000 };
		const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
		const ctx = noOpProxy(ctxCore) as unknown as CtxFakeCore;
		ctxCore.onCompactStart = () => pi.emit("session_before_compact", { reason: "extension" }, ctx);
		ctxCore.onCompactComplete = () => pi.emit("session_compact", { compactionEntry: { id: "rescue-compact" } }, ctx);
		retry(pi, { policy: ENABLED_OVERFLOW_POLICY });

		const sequence = [recoveryScenarios.tinyLengthStops[0], cleanStop()];
		let call = 0;
		const streamFn = async (
			model: unknown,
			context: { messages: unknown[] },
			options?: {
				onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
			},
		) => {
			call++;
			let params: unknown = {
				messages: context.messages,
				max_tokens: 8000,
			};
			const next = await options?.onPayload?.(params, model);
			if (next !== undefined) params = next;
			if (call === 2) await gate; // hold ppie-recover's regeneration run in flight
			return streamFor(sequence[Math.min(call - 1, sequence.length - 1)]);
		};

		const agent = new Agent({ streamFn: streamFn as unknown as StreamFn });
		ctxCore.attachAgentState(agent.state);
		registerRetryAgentForSessionManager(ctxCore.sessionManager, agent);
		agent.subscribe((event: { type: string; message?: unknown }) => {
			if (event.type === "message_end") {
				pi.emit("message_end", { msg: event.message }, ctx);
			}
		});

		// Faithful pi core routing for this state: AgentSession believes it is
		// idle (isStreaming false), so deliverAs "steer" is discarded and the
		// call reaches Agent.prompt, which rejects because ppie-recover's own
		// agent.prompt([]) run holds Agent.activeRun.
		piCore.deliverUserMessage = () => {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		};

		await agent.prompt("hi");
		pi.emit("agent_settled", {}, ctx);
		await flushAsync();
		expect(call).toBe(1);

		// A host-owned compaction releases the output-limit continuation.
		emitCompactionComplete(pi, ctx, "rescue-compact");
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(0);
			await Promise.resolve();
		}
		expect(call).toBe(2);

		const result = pi.emitAndGetResult<{ action?: string }>(
			"input",
			{
				type: "input",
				text: "stop, do something else instead",
				source: "interactive",
			},
			ctx,
		);
		expect(result?.action).toBe("handled");

		release();
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(0);
			await Promise.resolve();
		}

		expect(
			piCore.runtimeErrors,
			"the rescue delivery must not die in pi core's '<runtime>' catch — that is the reported silent loss",
		).toHaveLength(0);
		const transcriptTexts = agent.state.messages
			.filter((m) => m.role === "user")
			.map((m) => {
				const content = (m as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
				return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
			});
		expect(
			transcriptTexts.some((t: string) => t.includes("stop, do something else instead")),
			"the human's message must survive into the Agent transcript, not just be claimed as handled",
		).toBe(true);
	});

	// Length-stop fallback is intentionally compaction-only: payload trimming
	// is reserved for classified provider memory pressure.
	test("length-stop recovery refuses to start a second compaction when core remains in progress past its bound", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([recoveryScenarios.tinyLengthStops[0], cleanStop()]);

		await promptOnce(agent);
		pi.emit("session_before_compact", { reason: "overflow" }, ctx);

		await vi.advanceTimersByTimeAsync(80_000);
		await flushAsync();

		expect(ctxCore.compactions).toHaveLength(0);
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("refusing to start a second compaction"))).toBe(
			false,
		);
	});

	test("a compaction completed before a length-only stop cannot authorize a retry", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([recoveryScenarios.tinyLengthStops[0], cleanStop()]);

		emitCompactionComplete(pi, ctx, "manual");
		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(40_000);
		await flushAsync();

		expect(ctxCore.compactions).toHaveLength(0);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("length");
	});

	test("length-only pressure yields without retry, compaction, or trimming", async () => {
		const { agent, provider, ctxCore } = harness([recoveryScenarios.tinyLengthStops[0], cleanStop()]);

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("length");
		expect(ctxCore.compactions).toHaveLength(0);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("compaction could not help"))).toBe(false);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("Emergency-pruned"))).toBe(false);
	});

	test("length-only output pressure yields once without stopping the turn", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness(
			[recoveryScenarios.tinyLengthStops[0]],
			enabledOverflowPolicy(2),
		);
		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();

		pi.emit("message_end", { message: recoveryScenarios.tinyLengthStops[0] }, ctx);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("length");
		expect(
			ctxCore.ui.notifications.some(
				(notification) => notification.level === "error" || notification.message.includes("retry stopped"),
			),
		).toBe(false);
		expect(
			ctxCore.ui.notifications.filter(
				(notification) => notification.level === "info" && notification.message.toLowerCase().includes("yield"),
			),
		).toHaveLength(1);
	});

	test("context overflow never arms memory-only trimming in the context hook", () => {
		const { pi, ctx, ctxCore } = harness([cleanStop()]);
		ctxCore.contextWindow = 97_000;
		pi.emit(
			"message_end",
			{ msg: errorMessage("prompt is too long: 115704 tokens exceeds the context window of 97000 tokens") },
			ctx,
		);
		const messages = [
			{ role: "system", content: "keep system" },
			{ role: "tool", content: "tool-result ".repeat(30_000) },
			{ role: "assistant", content: "assistant-history ".repeat(10_000) },
			{ role: "user", content: "latest user stays useful" },
		];

		const result = pi.emitAndGetResult<{ messages?: unknown[] }>("context", { messages }, ctx);

		expect(result).toBeUndefined();
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("Emergency-pruned"))).toBe(false);
	});

	test("does not self-drive after an overflow compaction core is already retrying (willRetry:true)", async () => {
		// Core marks an overflow compaction `willRetry: true` when its own
		// post-run loop will call agent.continue(). ppie-recover must only clean up
		// its defer state, not concurrently call agent.prompt([]).
		const { agent, provider, pi, ctx, ctxCore } = harness([
			errorMessage(recoveryScenarios.coreMatchedOverflow),
			cleanStop(),
		]);
		ctxCore.contextWindow = 97_000;

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("error");

		const requestsBeforeCoreRetry = provider.requests.length;
		pi.emit("session_before_compact", { reason: "overflow" }, ctx);
		pi.emit(
			"session_compact",
			{
				compactionEntry: { id: "core" },
				reason: "overflow",
				willRetry: true,
			},
			ctx,
		);
		await flushAsync();

		expect(
			provider.requests.length,
			"ppie-recover must not self-drive agent.prompt([]) when core will call agent.continue()",
		).toBe(requestsBeforeCoreRetry);

		pi.emitAndGetResult<unknown>(
			"before_provider_request",
			{
				payload: {
					messages: [
						{
							role: "system",
							content: "You are a context summarization assistant.",
						},
					],
				},
			},
			ctx,
		);
		expect(provider.requests).toHaveLength(requestsBeforeCoreRetry);

		// Model core's own next step after compaction. It must be the sole
		// driver and complete without colliding with a ppie-recover active run.
		agent.state.messages = [{ role: "user", content: "retry me" }] as never;
		await expect(agent.continue()).resolves.toBeUndefined();
		await flushAsync();
		expect(provider.requests).toHaveLength(requestsBeforeCoreRetry + 1);
	});

	// THE LIVE SILENT DEATH (session 019f60ad-f136-7d0a-abfa-a6b3a5553017,
	// oh-my-tokens, 2026-07-14 12:55:38Z; verified against the real omlx
	// server log — the failing 400 was that session's LAST request ever).
	// Real pi-core behavior on a willRetry-eligible overflow error
	// (agent-session.js _checkCompaction): it REMOVES the trailing assistant
	// error from agent.state.messages ("we don't want it in context for the
	// retry"), then calls _runAutoCompaction — which, when
	// prepareCompaction() returns null (session too small), silently
	// `return false`s: no compaction_start/compaction_end, no
	// session_compact, no retry, and NO restore of the removed message.
	// Core abandons the turn AND strips the very trailing error ppie-recover's
	// engine keys its retry decision on. ppie-recover's defer fallback then ran
	// compact() (visibly failing "Nothing to compact"), armed the prune
	// budget, called onRetry — and the engine found a toolResult/user tail,
	// no retryable assistant, and silently dropped the whole recovery: no
	// notification, no provider request, nothing. The turn died with a
	// fully-armed prune budget that could have healed it (live overage was
	// 1,353 tokens vs ~16.7K prunable).
	test("core strips the trailing overflow error and silently declines to compact (session too small): the defer fallback must still drive a pruned retry", async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(recoveryScenarios.coreMatchedOverflow), cleanStop()]);
		ctxCore.contextWindow = 72_099;

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("error");

		// The fake models real core's overflow path: it strips the trailing
		// assistant error before silently declining compaction, without a
		// session_compact completion event.
		ctxCore.stripTrailingAssistantOnOverflow = true;
		ctxCore.failNextCompact = "Nothing to compact (session too small)";

		// ppie-recover's defer window elapses; fallback compact() fails; a fresh inactive recheck then releases prune/retry.
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		// The rule table paces the retry itself ("input too large": 20s first wait).
		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();

		expect(
			provider.requests.length,
			"the armed emergency-prune retry must still reach the provider even though core removed the trailing assistant error",
		).toBe(2);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("context fallback failure continues the bounded retry without memory trimming", async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(recoveryScenarios.fallbackOverflow), cleanStop()]);
		ctxCore.contextWindow = 112_000;
		expect(recoveryScenarios.tinyLengthStops[0].stopReason).toBe("length");
		agent.state.messages = [
			{ role: "user", content: "x".repeat(260_000) },
			{ role: "assistant", content: "y".repeat(230_000) },
		] as never;
		ctxCore.failNextCompact = recoveryScenarios.compactFailure;

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("Emergency-pruned"))).toBe(false);
	});

	test("marginal context_overflow on a real, organically large Agent history: the retry must actually succeed, not just shrink the payload by SOME amount", async () => {
		// Seed a real, large accumulated history — the same rough shape a
		// live session builds up across several tool-call rounds: multiple
		// user/assistant/toolResult turns, each carrying real bulk text
		// (mirroring ctx_read's file-content-sized tool results seen in the
		// real reported session), not one single oversized blob.
		const bulkToolResultText = "line of real file content\n".repeat(1500); // ~40K chars per tool result
		const seededMessages: unknown[] = [];
		for (let round = 0; round < 8; round++) {
			seededMessages.push({
				role: "assistant",
				content: [
					{ type: "text", text: `Reading file batch ${round}` },
					{
						type: "toolCall",
						id: `call_${round}`,
						name: "ctx_read",
						arguments: {},
					},
				],
			});
			seededMessages.push({
				role: "toolResult",
				toolCallId: `call_${round}`,
				toolName: "ctx_read",
				content: [{ type: "text", text: bulkToolResultText }],
			});
		}

		const { agent, provider, ctxCore } = harness([errorMessage(recoveryScenarios.marginalOverflow), cleanStop()]);

		ctxCore.contextWindow = 112_000;
		// Seed the REAL Agent's message history directly — this is what
		// onPayload/before_provider_request will actually serialize on
		// every subsequent request, unlike the hand-typed payloads in the
		// two tests above.
		agent.state.messages = seededMessages as never;

		// The error rules pace the context_overflow retry at 20s ("input too large"),
		// so the full sequence (preRetryHook's compaction/prune attempt and the
		// second provider call) runs once the fake clock passes that wait.
		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();
		// THE REAL ASSERTION the two synthetic tests above never make: the
		// retry must actually reach a successful "stop", not merely produce
		// SOME reduction in payload size. If emergency pruning's budget
		// (computed from the error string's reported 353-token overage,
		// escalated by knownOverageTokens against the REAL live payload)
		// is still insufficient against this realistic ~320K-char seeded
		// history, this assertion fails — exactly the gap the user
		// reported: "Emergency-pruned approximately 4000 tokens" not being
		// enough.
		expect(
			provider.requests.length,
			`expected the retry to actually reach the provider again after pruning; requests so far: ${provider.requests.length}`,
		).toBeGreaterThan(1);
		expect(
			lastAssistantStop(agent),
			"expected the retry to actually succeed against the real seeded payload, not just attempt one more (possibly still-oversized) request",
		).toBe("stop");
	});

	// Restart repro, session 019f3f88-fc14-759b-a722-fdf763ee480e lines 401-404:
	// user typed "continue" after many tiny length stops, then oMLX returned a
	// near-empty assistant with stopReason:"stop" and content "I". Current
	// retry.ts only handles stopReason error/aborted/length, so this success-coded
	// useless continuation is treated as done and no recovery runs.
	test("prior length stops do not authorize recovery compaction for a tiny success-coded stop", async () => {
		const { agent, provider, ctxCore } = harness([tinyStopI(), cleanStop()]);
		ctxCore.branch = [
			fakeAssistantSessionEntry({ content: [{ type: "text", text: "\nThe" }], stopReason: "length" }),
			fakeAssistantSessionEntry({ content: [{ type: "text", text: "\nThe" }], stopReason: "length" }),
		];

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(40_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("agent_end alone does not authorize tiny-stop recovery compaction", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([tinyStopI(), tinyStopI(), cleanStop()]);
		ctxCore.branch = [
			fakeAssistantSessionEntry({ content: [{ type: "text", text: "\nThe" }], stopReason: "length" }),
		];

		await promptOnce(agent);
		pi.emit("agent_end", {}, ctx);
		await vi.advanceTimersByTimeAsync(40_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);

		pi.emit("agent_end", {}, ctx);
		await vi.advanceTimersByTimeAsync(40_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	// Reported concern: onMessageEnd passes handleLengthStop a COPY of the
	// real message with stopReason forced to "length" —
	// `handleLengthStop(ctx, { ...message, stopReason: "length" })` — but
	// the real trailing Agent message's own stopReason genuinely stays
	// "stop" (tinyStopI()'s real shape). agent-retry.ts's
	// regenerateLengthOverflow() reads the REAL Agent message directly from
	// agent.state.messages, not the copy, and only drops the trailing
	// message when `last.stopReason === "length"` — which is never true
	// for a real "stop"-coded tiny message. So the tiny message is left in
	// place instead of being dropped before the regeneration re-prompt,
	// producing continuation-like behavior instead of a clean regeneration.
	test("a tiny success-coded ('stop') length-overflow recovery must drop the trailing message before regenerating, not leave it in place", async () => {
		const { agent, pi, ctx, ctxCore } = harness([tinyStopI(), cleanStop()]);

		ctxCore.branch = [
			fakeAssistantSessionEntry({
				content: [{ type: "text", text: "\nThe" }],
				stopReason: "length",
			}),
		];

		await promptOnce(agent);
		const tinyStopMessageCountBefore = agent.state.messages.filter(
			(m) => (m as { responseModel?: string }).responseModel === "keepalive",
		).length;
		expect(
			tinyStopMessageCountBefore,
			"the tiny stop-coded message must be present in Agent state before recovery runs",
		).toBe(1);

		// Core auto-compacts within the wait window — regeneration runs.
		emitCompactionComplete(pi, ctx);
		await flushAsync();

		const tinyStopMessageCountAfter = agent.state.messages.filter(
			(m) => (m as { responseModel?: string }).responseModel === "keepalive",
		).length;
		expect(
			tinyStopMessageCountAfter,
			"the real tiny stop-coded trailing message must be dropped before regenerating — leaving it in place produces continuation-like behavior instead of a clean regeneration",
		).toBe(0);
	});

	test("length-only stop never invokes a compaction callback that could hang", async () => {
		const { agent, provider, ctxCore } = harness([tinyStopI(), cleanStop()]);
		ctxCore.branch = [
			fakeAssistantSessionEntry({ content: [{ type: "text", text: "\nThe" }], stopReason: "length" }),
		];
		ctxCore.compactNeverSettles = true;

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(30_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(650_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("compaction lifecycle remained unchanged"))).toBe(
			false,
		);
	});

	test("core compaction inside the 20s window cancels forced compact", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([recoveryScenarios.tinyLengthStops[1], cleanStop()]);

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(300);
		emitCompactionComplete(pi, ctx);
		await flushAsync();
		expect(provider.requests).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(0);
	});

	test("compaction disabled does not send the clamped request", async () => {
		const { agent, provider, ctxCore } = harness(
			[recoveryScenarios.tinyLengthStops[0], cleanStop()],
			COMPACTION_OFF_POLICY,
		);
		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);
	});

	test("compaction disabled yields memory pressure without compacting or trimming", async () => {
		const memoryGuard = "400 prefill_memory_exceeded: predicted peak exceeds the available memory ceiling";
		const { agent, provider, ctxCore } = harness([errorMessage(memoryGuard)], COMPACTION_OFF_POLICY);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("pruning is disabled"))).toBe(true);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("Emergency-pruned"))).toBe(false);
		// The stop names the disabled setting that could have continued it.
		const tips = ctxCore.ui.notifications.filter(
			(n) => n.level === "info" && n.message.includes("memory_overflow_protection.prune.enabled: true"),
		);
		expect(tips.map((n) => n.message.includes("memory_overflow_protection.prune.enabled: true"))).toEqual([true]);
	});

	test("preflight safety-guard wording routes directly to memory compaction, never generic retry", async () => {
		const preflightSafetyGuard =
			"Prefill context too large for available memory (preflight safety guard, kv_len=92561, min_chunk=32): predicted peak would require ~44.21 GB (current 43.01 GB + KV 1.02 GB + min-chunk transient 184.27 MB) but prefill safety cap is 43.55 GB (95% of effective ceiling 45.84 GB). Reduce context length, free system memory, or loosen memory_guard_tier (safe → balanced → aggressive).";
		const { agent, provider, ctxCore } = harness([errorMessage(preflightSafetyGuard), cleanStop()]);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("Unrecognized provider error"))).toBe(false);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("waiting for compaction before retry"))).toBe(
			true,
		);

		// Fallback compaction uses the selected overflow retry delay.
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(1);
	});

	test("memory_guard that arrives during an existing retry cancels the generic loop and lets compaction own the next step", async () => {
		const { agent, provider, ctxCore } = harness([
			errorMessage(CORE_UNRECOGNIZED_OVERFLOW),
			errorMessage(recoveryScenarios.memoryGuard),
			cleanStop(),
		]);

		await promptOnce(agent);
		// First hop (context overflow, "too long" wording) paces on overflow override: 20s.
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("error");

		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(1);
		// The 20s selected delay gated compaction; provider continuation is immediate.
		expect(provider.requests).toHaveLength(3);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("real Agent + AgentSession-contract compaction port: summarizer rejection releases ownership and prune-retries without session_compact", async () => {
		const processMemoryGuard =
			"Request aborted: process memory limit exceeded (usage 49.7 GB, ceiling 51.3 GB). Reduce context size or lower memory_guard_tier.";
		const summarizerMemoryGuard =
			'Summarization failed: 400: {"message":"Prefill context too large for available memory (preflight safety guard, kv_len=17600, min_chunk=32): predicted peak would require ~50.71 GB (current 49.63 GB + KV 1.07 GB + min-chunk transient 5.53 MB) but prefill safety cap is 48.77 GB","code":"prefill_memory_exceeded","estimated_bytes":54444253734,"limit_bytes":52369621811}';
		const { agent, provider, ctxCore } = harness([errorMessage(processMemoryGuard), cleanStop()]);
		ctxCore.contextWindow = 500_000;
		agent.state.messages = [
			{ role: "user", content: "x".repeat(220_000) },
			{ role: "assistant", content: "y".repeat(100_000) },
		] as never;
		// Both compaction attempts' summarizers are memory-rejected, so
		// compact-twice is exhausted and recovery must fall through to a pruned
		// provider retry.
		ctxCore.failAllCompacts = summarizerMemoryGuard;

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(1);
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("compaction is still active"))).toBe(false);

		// Compaction attempt 1's summarizer was itself memory-rejected. That
		// failed attempt releases ownership without a session_compact, and
		// compact-twice runs the deferred second attempt before pruning; only
		// after both are exhausted does the prune-retry reach the provider.
		await vi.advanceTimersByTimeAsync(64_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(2);
		expect(ctxCore.compactions).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
		const pruneNotice = ctxCore.ui.notifications.find((n) => n.message.includes("Emergency-pruned"))?.message;
		expect(pruneNotice).toBeDefined();
		const removedTokens = Number(pruneNotice?.match(/approximately (\d+)/)?.[1]);
		expect(removedTokens).toBeGreaterThan(15_000);
	});

	test("memory guard compacts twice (spread out), retries between, then prunes as last resort", async () => {
		const preflightSafetyGuard =
			"Prefill context too large for available memory (preflight safety guard, kv_len=92561, min_chunk=32): predicted peak would require ~44.21 GB (current 43.01 GB + KV 1.02 GB + min-chunk transient 184.27 MB) but prefill safety cap is 43.55 GB.";
		const processMemoryGuard =
			"Request aborted: process memory limit exceeded (usage 49.7 GB, ceiling 45.8 GB). Reduce context size or lower memory_guard_tier.";
		const pacing = createErrorRuleEngine(ENABLED_OVERFLOW_POLICY.errorRules);
		const firstDelayMs = pacing.delayMsFor(preflightSafetyGuard, 1);
		const secondDelayMs = pacing.delayMsFor(processMemoryGuard, 2);
		const thirdDelayMs = pacing.delayMsFor(processMemoryGuard, 3);
		const { agent, provider, ctxCore } = harness([
			errorMessage(preflightSafetyGuard),
			errorMessage(processMemoryGuard),
			errorMessage(processMemoryGuard),
			cleanStop(),
		]);
		agent.state.messages = [
			{ role: "user", content: "x".repeat(220_000) },
			{ role: "assistant", content: "y".repeat(100_000) },
		] as never;

		await promptOnce(agent);
		expect(ctxCore.compactions).toHaveLength(0);
		expect(provider.requests).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(firstDelayMs);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(1);
		expect(provider.requests).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(secondDelayMs - 1);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(1);
		expect(provider.requests).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(2);
		expect(provider.requests).toHaveLength(3);

		// Both configured compactions are exhausted. Reduction is a fresh third
		// attempt and receives the same resolved rule's next delay.
		await vi.advanceTimersByTimeAsync(thirdDelayMs - 1);
		await flushAsync();
		expect(provider.requests).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		await flushAsync();
		expect(provider.requests).toHaveLength(4);
		expect(lastAssistantStop(agent)).toBe("stop");
		expect(ctxCore.compactions).toHaveLength(2);
		expect(
			ctxCore.ui.notifications.filter((n) => n.message.includes("Emergency-pruned")).length,
		).toBeGreaterThanOrEqual(1);
	});

	test("memory_guard 400 64473deb compacts first, then heals after retry backoff", async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(recoveryScenarios.memoryGuard), cleanStop()]);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("error");

		expect(ctxCore.compactions).toHaveLength(0);
		expect(provider.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(1);
		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	// Reported live TWICE, same session (019f3f88-fc14-759b-a722-fdf763ee480e)
	// — the second time after clearing the active /goal and restarting pi
	// entirely, ruling out any other extension racing ppie-recover. A memory_guard
	// prefill rejection fails BEFORE any tokens stream, so on oMLX the failure
	// message has content:[], usage.output:0, and responseModel:"keepalive" —
	// structurally identical to a true prefill heartbeat. isKeepaliveFrame
	// used to check only responseModel/usage.output/visibleTextLength, so
	// onMessageEnd's `if (isKeepaliveFrame(message)) return;` guard silently
	// discarded this genuine fatal error before errorMessage was ever read:
	// zero notification, zero retry — exactly the reported "not auto healing"
	// symptom. Fixed with a stopReason==="error" check in isKeepaliveFrame.
	test("bare-prose memory_guard error with responseModel=keepalive and zero output is NOT dropped as a heartbeat — it retries", async () => {
		const { agent, provider, ctxCore } = harness([
			{
				role: "assistant",
				content: [],
				model: "Qwen3.6-27B-oQ4-mtp",
				responseModel: "keepalive",
				stopReason: "error",
				errorMessage: recoveryScenarios.bareMemoryGuard,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost,
				},
			},
			cleanStop(),
		]);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("error");

		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	// Reported live (session 019f3f88-fc14-759b-a722-fdf763ee480e): a memory_guard
	// 400 ("Prefill would require ~54.70 GB peak ... but static/metal_cap
	// ceiling is 54.00 GB") after a large prior turn ("add todos for each and
	// fix them", 106543 input tokens) produced NO visible retry at all — no
	// "Retry attempt" notification, no second provider request, nothing.
	// Traced: triggerRetry(ctx) (retry.ts) runs SYNCHRONOUSLY inside the
	// message_end handler, at the moment the error first arrives.
	// ctx.hasPendingMessages() being true at THAT instant (plausible right
	// after a large prior turn) used to `return` immediately — no retry
	// loop started, no notification, permanent silence. Fixed via
	// pending-messages.ts's createPendingMessagesGate, shared with
	// length-stop.ts's identical (second, DRY-violating) occurrence of the
	// same bug: notify once, poll until the queue clears, THEN run the
	// retry — or terminal with a visible reason if it never clears.
	test("a memory_guard error with ctx.hasPendingMessages() true at message_end time notifies, waits, then retries once the queue clears", async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(recoveryScenarios.memoryGuard), cleanStop()]);

		// Simulate the real-world condition: pi-core still has pending
		// messages queued (e.g. from a large prior turn) at the exact
		// moment message_end fires for the new error.
		ctxCore.pendingMessages = true;

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("error");

		// Memory-guard recovery now gives compaction the first chance to heal;
		// only the post-compaction retry is gated on pending messages.
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(1);
		expect(
			ctxCore.ui.notifications.some((n) => n.message.includes("waiting for pi-core's own queued messages")),
		).toBe(true);

		// The retry loop must not have started yet — pending messages are
		// still there and the poll hasn't found them clear.
		await vi.advanceTimersByTimeAsync(1000);
		await flushAsync();
		expect(provider.requests).toHaveLength(1);

		// The queue clears; the next poll tick (every 2s) must pick that up
		// and actually run the retry.
		ctxCore.pendingMessages = false;
		await vi.advanceTimersByTimeAsync(2000);
		await flushAsync();
		// The rule-paced wait ("input too large": 20s) applies once the gate lets
		// the retry through.
		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("a memory_guard error with a permanently pending queue yields visibly after the bounded wait", async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(recoveryScenarios.memoryGuard), cleanStop()]);

		ctxCore.pendingMessages = true;

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);

		// Compaction gets the first chance to heal, then the queued retry waits
		// for pending messages. Queue never clears — advance past compaction's
		// 20s overflow delay plus PENDING_MESSAGES_MAX_WAIT_MS (30s).
		await vi.advanceTimersByTimeAsync(52_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(1);
		expect(
			ctxCore.ui.notifications.some((n) => n.level === "info" && n.message.includes("ppie-recover yielded control")),
		).toBe(true);
	});

	// Second, DRY-violating occurrence of the identical bug, in
	// length-stop.ts's large-output truncation branch (genuine truncation,
	// not the tiny-output overflow class — see classifyLengthStop). Same
	// fix, same shared createPendingMessagesGate.
	test("a large-output length-stop follow-up with ctx.hasPendingMessages() true notifies, waits, then sends the follow-up once the queue clears", async () => {
		const largeTruncation = largeLengthTruncation();
		const { agent, piCore, ctxCore } = harness([largeTruncation, cleanStop()]);
		ctxCore.contextWindow = 10_000;
		ctxCore.model = { maxTokens: 4_096 };

		ctxCore.pendingMessages = true;

		await promptOnce(agent);
		expect(lastAssistantStop(agent)).toBe("length");
		expect(piCore.sentUserMessages).toHaveLength(0);
		expect(
			ctxCore.ui.notifications.some((n) => n.message.includes("waiting for pi-core's own queued messages")),
		).toBe(true);

		ctxCore.pendingMessages = false;
		await vi.advanceTimersByTimeAsync(2000);
		await flushAsync();

		expect(piCore.sentUserMessages).toHaveLength(1);
		expect(piCore.sentUserMessages[0]?.options).toEqual({
			deliverAs: "followUp",
		});
		expect(ctxCore.ui.status).toContain("🔁 continuing");
		expect(ctxCore.ui.notifications).toContainEqual({
			message: "Output limit reached; continuing with a follow-up turn…",
			level: "warning",
		});
	});

	test("large-output length-stop follow-ups use max_attempts default of 5", async () => {
		const largeTruncation = largeLengthTruncation();
		const { agent, pi, ctx, piCore, ctxCore } = harness([largeTruncation]);
		ctxCore.contextWindow = 10_000;
		ctxCore.model = { maxTokens: 4_096 };

		await promptOnce(agent);
		for (let i = 0; i < 4; i++) {
			pi.emit("message_end", { message: largeTruncation }, ctx);
		}
		expect(piCore.sentUserMessages).toHaveLength(5);

		pi.emit("message_end", { message: largeTruncation }, ctx);
		expect(piCore.sentUserMessages).toHaveLength(5);
		expect(
			ctx.ui.notifications.some((n) => n.message.includes("Output-limit recovery stopped after 5 attempts")),
		).toBe(true);
	});

	test("large-output length-stop follow-ups honor max_attempts", async () => {
		const largeTruncation = largeLengthTruncation();
		const { agent, pi, ctx, piCore, ctxCore } = harness([largeTruncation], enabledOverflowPolicy(2));
		ctxCore.contextWindow = 10_000;
		ctxCore.model = { maxTokens: 4_096 };

		await promptOnce(agent);
		pi.emit("message_end", { message: largeTruncation }, ctx);
		expect(piCore.sentUserMessages).toHaveLength(2);

		pi.emit("message_end", { message: largeTruncation }, ctx);
		expect(piCore.sentUserMessages).toHaveLength(2);
		expect(
			ctx.ui.notifications.some((n) => n.message.includes("Output-limit recovery stopped after 2 attempts")),
		).toBe(true);
	});

	test(`context overflow with provider wording defers to core compaction`, async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(recoveryScenarios.higherOverflow), cleanStop()]);

		await promptOnce(agent);
		// pi-ai 1.2 matches "Prompt too long" (without "is"), so core owns this overflow and
		// ppie-recover defers to it; the request is retried once compaction has run.
		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
		expect(ctxCore.compactions).toHaveLength(1);
	});

	test(`context overflow in wording pi core does not match retries without deferring to core (catch-all pacing)`, async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(CORE_UNRECOGNIZED_OVERFLOW), cleanStop()]);

		await promptOnce(agent);
		// pi-ai does not match this wording, so ppie-recover classifies it as context_overflow itself
		// and paces it on the input-too-large override (20s).
		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
		expect(ctxCore.compactions).toHaveLength(0);
	});

	test("compaction disabled observes Pi but never calls ctx.compact", async () => {
		const { agent, provider, ctxCore } = harness(
			[errorMessage(recoveryScenarios.lowerOverflow), cleanStop()],
			COMPACTION_OFF_POLICY,
		);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(4_999);
		await flushAsync();
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);

		// The shipped 5s overflow window elapsed while observing Pi. The provider
		// continuation is immediate after that boundary — no second retry timer.
		await vi.advanceTimersByTimeAsync(1);
		await flushAsync();
		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
		expect(ctxCore.compactions).toHaveLength(0);
	});

	for (const reportedOverflow of [
		{
			name: "core-matched",
			error: recoveryScenarios.coreMatchedOverflow,
		},
		{
			name: "lower-excess",
			error: recoveryScenarios.lowerOverflow,
		},
	]) {
		test(`core-matched context overflow ${reportedOverflow.name} uses the selected 20s fallback delay, then retries`, async () => {
			const { agent, provider, ctxCore } = harness([errorMessage(reportedOverflow.error), cleanStop()]);

			await promptOnce(agent);
			expect(provider.requests).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(19_999);
			await flushAsync();
			expect(ctxCore.compactions).toHaveLength(0);
			expect(provider.requests).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(1);
			await flushAsync();
			expect(ctxCore.compactions).toHaveLength(1);
			// The selected delay gated fallback compaction, so continuation is immediate.
			expect(provider.requests).toHaveLength(2);
			expect(lastAssistantStop(agent)).toBe("stop");
		});
	}

	test("agent_settled must not cancel a pending core-defer fallback recovery", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([
			errorMessage(recoveryScenarios.coreMatchedOverflow),
			cleanStop(),
		]);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);

		pi.emit("agent_settled", {}, ctx);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();

		expect(ctxCore.compactions).toHaveLength(1);
		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("stale session_before_compact from an old session cannot suppress a new recovery fallback", async () => {
		const { agent, provider, pi, ctxCore } = harness([
			errorMessage(recoveryScenarios.coreMatchedOverflow),
			cleanStop(),
		]);
		const oldCtxCore = new CtxFakeCore();
		oldCtxCore.markStale();
		const oldCtx = noOpProxy(oldCtxCore) as unknown as CtxFakeCore;

		pi.emit("session_before_compact", { reason: "old-session" }, oldCtx);
		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		// + the rule-paced retry wait ("input too large": 20s).
		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();

		expect(ctxCore.compactions).toHaveLength(1);
		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
	});

	test("context-overflow recovery refuses to start a second compaction when core remains in progress past the defer bound", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([
			errorMessage(recoveryScenarios.coreMatchedOverflow),
			cleanStop(),
		]);

		await promptOnce(agent);
		pi.emit("session_before_compact", { reason: "overflow" }, ctx);

		await vi.advanceTimersByTimeAsync(40_000);
		await flushAsync();

		expect(ctxCore.compactions).toHaveLength(0);
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("refusing to start a second compaction"))).toBe(
			false,
		);
	});

	test("context overflow does not double-compact when core compacts during the defer window", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([
			errorMessage(recoveryScenarios.coreMatchedOverflow),
			cleanStop(),
		]);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);
		emitCompactionComplete(pi, ctx);

		await vi.advanceTimersByTimeAsync(10_000);
		await flushAsync();
		expect(ctxCore.compactions).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();
		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
		expect(ctxCore.compactions).toHaveLength(0);
	});

	// Reported concern (narrowed): core can START its own auto-compaction
	// BEFORE the 10s defer deadline but not FINISH (emit session_compact)
	// until AFTER it — the literal "Already compacted" race, since the old
	// deadline callback had no way to know compaction was already running
	// and called its own fallback ctx.compact() on top of it. Wired via
	// pi-coding-agent's real session_before_compact event (fires before
	// compaction begins) through retry.ts -> recovery.onCompactionStart().
	test("session_before_compact firing before the defer deadline prevents a redundant fallback compact() when session_compact lands after it", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([
			errorMessage(recoveryScenarios.coreMatchedOverflow),
			cleanStop(),
		]);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.compactions).toHaveLength(0);

		// Core signals it has STARTED compacting, well before the 10s
		// deadline — but has not finished yet (no session_compact yet).
		await vi.advanceTimersByTimeAsync(2000);
		pi.emit("session_before_compact", { reason: "overflow" }, ctx);

		// The 10s defer deadline elapses while core's compaction is still
		// running. Without the fix, this would call ctx.compact() itself,
		// racing core's own still-in-flight compaction.
		await vi.advanceTimersByTimeAsync(10_000);
		await flushAsync();
		expect(
			ctxCore.compactions,
			"ppie-recover must not call its own fallback compact() once core has signalled it already started compacting",
		).toHaveLength(0);

		// Core's compaction genuinely completes after the deadline.
		emitCompactionComplete(pi, ctx);
		await flushAsync();
		// + the rule-paced retry wait ("input too large": 20s).
		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
		expect(
			ctxCore.compactions,
			"only core's own real compaction must be recorded — no redundant ppie-recover fallback compaction",
		).toHaveLength(0);
	});

	test("core terminal overflow-recovery failure is taken over by ppie-recover instead of deferring to core again", async () => {
		const { agent, provider, ctxCore } = harness([errorMessage(CORE_TERMINAL_OVERFLOW_FAILURE), cleanStop()]);

		await promptOnce(agent);
		await flushAsync();
		// "Context overflow recovery failed" matches the "overflow" word → "input too
		// large" paces the takeover retry (20s).
		await vi.advanceTimersByTimeAsync(21_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(2);
		expect(lastAssistantStop(agent)).toBe("stop");
		expect(ctxCore.compactions).toHaveLength(0);
	});

	// Reported live via scripts/smoke-real-settings-compaction.sh: `pi --fork
	// <session-id>` replaces the session mid-run. retry.ts's message_end/
	// before_provider_request/agent_end handlers each capture ctx in a
	// `notifyFn = (m, l) => ctx.ui.notify(m, l)` closure. session_shutdown
	// (reason: "fork") fires and retry.ts's resetSession() runs, but it never
	// clears notifyFn/latestCtx — so a still-in-flight retry backoff that
	// later calls notify(...) uses the OLD ctx from before the fork, which
	// pi-coding-agent's ExtensionRunner.assertActive throws on: "This
	// extension ctx is stale after session replacement or reload." This
	// crashed the extension process before ppie-recover could classify or defer
	// the overflow that triggered the retry in the first place — see
	// docs/pi-extension-hooks.md's session_shutdown row and
	// docs/smoke-testing.md.
	test("a session fork mid-retry-backoff must not crash on a stale captured ctx", async () => {
		const { agent, provider, pi, ctx, ctxCore } = harness([errorMessage(recoveryScenarios.memoryGuard), cleanStop()]);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("error");

		// The session is replaced mid-backoff (pi --fork). pi-core fires
		// session_shutdown with reason: "fork" and the OLD ctx becomes stale
		// from this point on — any further access must throw, matching real
		// ExtensionRunner behavior.
		pi.emit("session_shutdown", { reason: "fork" }, ctx);
		ctxCore.markStale();

		// The retry engine's own 8s backoff for the memory_guard error is
		// still in flight and will fire regardless of the fork. Its
		// notify(...) calls run detached inside agent-retry.ts's `void
		// (async () => {...})()` retry loop, outside any try/catch — a throw
		// there becomes an unhandled promise rejection, which vitest surfaces
		// as an unhandledRejection event rather than a normal thrown
		// exception from advanceTimersByTimeAsync. Capture it explicitly.
		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			await vi.advanceTimersByTimeAsync(8000);
			await flushAsync();
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(
			unhandled,
			`retry.ts must not throw on a stale ctx after session_shutdown(reason: "fork") — got: ${unhandled.map(String).join("; ")}`,
		).toHaveLength(0);
	});

	// Reported live via scripts/smoke-real-settings-compaction.sh: a real
	// `pi --fork <session-id>` run crashed BEFORE any [ppie-recover] debug line
	// appeared, meaning the crash happened synchronously inside a handler,
	// not a deferred timer. agent_end's ctx argument can already be stale by
	// the time the handler body runs (pi-core can fire agent_end for a
	// completing turn in the same tick a fork/newSession/switchSession/
	// reload replaces the session) — lastAssistantMessage(ctx) reads
	// ctx.sessionManager.getBranch() unguarded, which throws immediately.
	test("agent_end firing with an already-stale ctx must not crash synchronously", () => {
		const { pi, ctx, ctxCore } = harness([cleanStop()]);

		ctxCore.markStale();

		expect(() => {
			pi.emit("agent_end", {}, ctx);
		}).not.toThrow();
	});

	// GGDSD-grounded, per exhaustive live instrumentation (session
	// 019f3f88-fc14-759b-a722-fdf763ee480e smoke-test investigation): the
	// reported "max_tokens=1"/"Emergency-pruned ~4000 tokens, still not
	// enough" failure traces to pi-coding-agent's OWN internal compaction
	// summarization sub-call (compaction.js's generateSummary), not the
	// main turn's request. Verified via installed-package source
	// (compaction.js:443-468, compaction/utils.js:150's real
	// SUMMARIZATION_SYSTEM_PROMPT constant) that this sub-call:
	//   1. Uses this.agent.streamFn — the SAME streamFn as normal turns,
	//      which IS wired through onPayload/emitBeforeProviderRequest
	//      (sdk.js), so it genuinely fires before_provider_request.
	//   2. Sets context.systemPrompt = SUMMARIZATION_SYSTEM_PROMPT, which
	//      openai-completions.js's convertMessages (line 684-687) turns
	//      into payload.messages[0] = { role: "system"|"developer",
	//      content: <the summarization prompt> } — a REAL, inspectable
	//      signal already present on the payload before_provider_request
	//      receives (BeforeProviderRequestEvent only exposes
	//      { type, payload } per pi-coding-agent's own types.d.ts — no
	//      call-purpose field, so this message-content signal is the only
	//      one currently available).
	//   3. Sets maxTokens = Math.floor(0.8 * reserveTokens) — legitimately
	//      tiny (often 1) when the session is near-full, which is exactly
	//      when overflow recovery is active. This is EXPECTED, correct
	//      behavior for a short summarization prompt, not a bug in the
	//      request itself.
	//
	// The real defect this test proves: overflow-recovery.ts's
	// beforeProviderRequest has no way to recognize this shape and
	// currently treats it identically to the main turn's request — if an
	// emergency-prune budget happens to be armed (as it legitimately would
	// be, mid-recovery, exactly when compaction also fires), it prunes the
	// compaction call's small summarization-prompt payload using logic
	// designed for a 100K+-token conversation, corrupting a request that
	// was never oversized in the way the pruner assumes.
	test("a compaction summarization sub-call (real content-shape: system message = SUMMARIZATION_SYSTEM_PROMPT) must NOT be pruned like the main turn's request, even when an emergency-prune budget is armed", () => {
		const { pi, ctx, ctxCore } = harness([cleanStop()]);

		ctxCore.contextWindow = 112_000;

		// Arm the emergency-prune budget exactly as the real reported
		// scenario does: a length-overflow fallback (or a parseable
		// context_overflow error) arms it mid-recovery — the same window
		// during which pi-core's own compaction summarization sub-call can
		// also fire before_provider_request.
		pi.emit(
			"message_end",
			{
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "prompt is too long: 113426 tokens exceeds the context window of 112000 tokens",
				},
			},
			ctx,
		);

		// Real shape verified against compaction/utils.js's actual
		// SUMMARIZATION_SYSTEM_PROMPT constant and
		// openai-completions.js:684-687's convertMessages: a compaction
		// sub-call's payload has a system message whose content IS that
		// exact constant, and a single user message wrapping
		// <conversation>${serializeConversation(...)}</conversation> — the
		// FULL conversation being summarized (compaction.js's generateSummary,
		// promptText). This is exactly why compaction fires in the first
		// place: the session is nearly full, so this serialized text is
		// itself typically 100K+ tokens — large enough to trigger
		// emergency-prune's pruning threshold, unlike a short placeholder.
		const compactionSubCallPayload = {
			model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
			messages: [
				{
					role: "system",
					content:
						"You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.",
				},
				{
					role: "user",
					content: `<conversation>\n${"real serialized turn content, tool calls, and file reads from the session being compacted\n".repeat(4000)}</conversation>\n\nThe messages above are a conversation to summarize.`,
				},
			],
			max_tokens: 1,
			stream: true,
		};

		const originalPayload = structuredClone(compactionSubCallPayload);
		const returned = pi.emitAndGetResult<unknown>(
			"before_provider_request",
			{ payload: compactionSubCallPayload },
			ctx,
		);

		// THE REAL ASSERTION: a compaction sub-call must reach the provider
		// completely unmodified — pruning it corrupts a request that was
		// never the thing overflowing in the first place. `returned` must
		// either be undefined (no mutation) or deep-equal the original
		// payload; it must NOT come back smaller/pruned.
		const finalPayload = returned ?? compactionSubCallPayload;
		expect(compactionSubCallPayload).toEqual(originalPayload);
		expect(
			finalPayload,
			`a compaction summarization sub-call's payload must not be pruned — got: ${JSON.stringify(finalPayload).slice(0, 300)}`,
		).toEqual(originalPayload);
	});

	test("exhausted provider retries name model fallback as the setting that could continue", async () => {
		const { agent, provider, ctxCore } = harness(
			[
				errorMessage("Unexpected provider failure"),
				errorMessage("Unexpected provider failure"),
				errorMessage("Unexpected provider failure"),
			],
			enabledOverflowPolicy(1),
		);

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(120_000);
		await flushAsync();

		expect(provider.requests).toHaveLength(2);
		const tips = ctxCore.ui.notifications.filter((n) => n.level === "info" && n.message.startsWith("Tip:"));
		expect(tips.map((n) => n.message.includes("model_fallback.enabled: true"))).toEqual([true]);
	});

	test("429 FreeUsageLimitError is not retried — a human has to act", async () => {
		const rateLimitError =
			'429: {"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}';
		const { agent, provider, ctxCore } = harness([errorMessage(rateLimitError), errorMessage(rateLimitError)]);

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(60_000);
		await flushAsync();

		expect(lastAssistantStop(agent)).toBe("error");
		// The shipped account row resolves 429 and rate-limit wording to max_attempts 0.
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("Non-retryable error (not retried)"))).toBe(true);
		// A human has to act; no ppie-recover setting would help.
		expect(ctxCore.ui.notifications.some((n) => n.message.startsWith("Tip:"))).toBe(false);
	});

	test("provider Operation aborted error text is non-retryable when it arrives as stopReason=error", async () => {
		const { agent, provider, ctxCore } = harness([errorMessage("Operation aborted"), cleanStop()]);

		await promptOnce(agent);
		await vi.advanceTimersByTimeAsync(60_000);
		await flushAsync();

		expect(lastAssistantStop(agent)).toBe("error");
		expect(provider.requests).toHaveLength(1);
		expect(ctxCore.ui.notifications.some((n) => n.message.includes("Non-retryable error (not retried)"))).toBe(true);
	});

	test("user abort (stopReason=aborted) is respected — no retry, engine cancelled", async () => {
		// GIVEN: a sequence where the provider returns an abort message
		const abortMessage: AssistantFixture = {
			role: "assistant",
			content: [],
			model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
			stopReason: "aborted",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost,
			},
		};

		// WHEN: user prompts the agent
		const { agent, provider } = harness([abortMessage]);
		await promptOnce(agent);

		// THEN: the agent's last message has stopReason=aborted
		expect(lastAssistantStop(agent)).toBe("aborted");

		// AND: only one request was made (no retry)
		expect(provider.requests).toHaveLength(1);

		// AND: the abort is respected — no recovery path entered
		// (if retry had been attempted, provider.requests would have >1 entries)
	});

	test("user abort during queued length retry clears the queued compaction/retry", async () => {
		const abortMessage: AssistantFixture = {
			role: "assistant",
			content: [],
			model: "ThinkingCap-Qwen3.6-27B-oQ6e-mtp",
			stopReason: "aborted",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost,
			},
		};
		const { agent, provider, pi, ctx, ctxCore } = harness([recoveryScenarios.tinyLengthStops[0], cleanStop()]);

		await promptOnce(agent);
		expect(provider.requests).toHaveLength(1);
		expect(lastAssistantStop(agent)).toBe("length");

		pi.emit("message_end", { message: abortMessage }, ctx);
		await flushAsync();

		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();

		// Abort must clear the already-queued length-overflow timeout. If it does
		// not, the 20s timeout forces compaction and may regenerate the turn.
		expect(ctxCore.compactions).toHaveLength(0);
		expect(provider.requests).toHaveLength(1); // The user interrupted; no setting could have continued it.
		expect(ctxCore.ui.notifications.some((n) => n.message.startsWith("Tip:"))).toBe(false);
	});

	// Reported live: a real human typed messages while a continuation-driven
	// run was active and each one errored immediately with pi-core's "Agent is
	// already processing. Specify streamingBehavior ('steer' or 'followUp')
	// to queue the message." — thrown by AgentSession.prompt()
	// (dist/core/agent-session.js) when the caller supplied no
	// streamingBehavior. ExtensionRunner.emitInput fires BEFORE that throw and
	// returns early on { action: "handled" }, so this hook is the one place an
	// extension can rescue such input.
	//
	// The rescue channel matters: pi.sendUserMessage is fire-and-forget
	// through the extension wrapper (a rejection surfaces only as a "<runtime>"
	// extension error, invisible to the caller) and AgentSession.sendUserMessage
	// maps deliverAs → prompt({ streamingBehavior }), which honors it only while
	// the session is streaming and rejects while a compaction controller is
	// clearing. The only custody channel with guaranteed delivery is
	// Agent.steer() — a synchronous enqueue into the active run's steering
	// queue, drained at the next step boundary.
	//
	// This asserts: human input (source !== "extension") arriving while an
	// Agent run is active, with no caller-supplied streamingBehavior, is
	// steered directly onto the active run, reported handled, and reaches the
	// transcript — never sent via sendUserMessage, never left to pi-core's
	// unguarded prompt() throw.
	test("real human input while an Agent run is active with no streamingBehavior is steered onto that run and reaches the transcript", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const piCore = new PiFakeCore();
		const ctxCore = new CtxFakeCore();
		const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
		const ctx = noOpProxy(ctxCore) as unknown as CtxFakeCore;
		retry(pi, { policy: DEFAULT_RETRY_POLICY });

		const sequence = [cleanStop(), cleanStop()];
		let call = 0;
		const streamFn = async (
			model: unknown,
			context: { messages: unknown[] },
			options?: {
				onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
			},
		) => {
			call++;
			let params: unknown = {
				messages: context.messages,
				max_tokens: 8000,
			};
			const next = await options?.onPayload?.(params, model);
			if (next !== undefined) params = next;
			if (call === 1) await gate; // hold the agent's own run in flight
			return streamFor(sequence[Math.min(call - 1, sequence.length - 1)]);
		};

		const agent = new Agent({ streamFn: streamFn as unknown as StreamFn });
		ctxCore.attachAgentState(agent.state);
		registerRetryAgentForSessionManager(ctxCore.sessionManager, agent);
		agent.subscribe((event: { type: string; message?: unknown }) => {
			if (event.type === "message_end") {
				pi.emit("message_end", { msg: event.message }, ctx);
			}
		});

		ctxCore.agentIsIdle = false; // session believes busy

		const run = agent.prompt("hi");
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(0);
			await Promise.resolve();
		}
		expect(call).toBe(1); // the run is parked on the gate: Agent#signal defined

		const result = pi.emitAndGetResult<{ action?: string }>(
			"input",
			{ type: "input", text: "are you still working on this?", source: "interactive", streamingBehavior: undefined },
			ctx,
		);
		expect(result?.action).toBe("handled");
		expect(
			piCore.sentUserMessages,
			"custody must be a direct Agent.steer() — sendUserMessage is fire-and-forget and must never carry a custody claim",
		).toHaveLength(0);

		release();
		await run;
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(0);
			await Promise.resolve();
		}

		const userTexts = agent.state.messages
			.filter((message) => message.role === "user")
			.map((message) => (message.content as Array<{ text?: string }>)[0]?.text);
		expect(userTexts).toContain("are you still working on this?");
	});

	// Busy/idle desync: the session believes busy but the Agent holds no active
	// run. No guaranteed channel exists — steer() onto an idle Agent strands the
	// message, and sendUserMessage fails silently — so the input must be left to
	// pi-core's native path, whose prompt() throws loudly to the caller instead
	// of dropping the message.
	test("real human input while the session believes busy but no Agent run is active is left to pi-core (never intercepted)", async () => {
		const { piCore, ctx, ctxCore } = harness([cleanStop()]);

		ctxCore.agentIsIdle = false;

		const result = piCore.emitAndGetResult<{ action: string } | undefined>(
			"input",
			{
				type: "input",
				text: "hello?",
				source: "interactive",
				streamingBehavior: undefined,
			},
			ctx,
		);

		expect(result).toBeUndefined();
		expect(piCore.sentUserMessages).toHaveLength(0);
	});

	// The same input arriving from ppie-recover's OWN synthetic prompts (source
	// "extension") must NOT be intercepted — those calls always pass their
	// own streamingBehavior correctly already (agent-retry.ts's
	// agent.prompt([]), length-stop.ts's pi.sendUserMessage), and
	// re-routing them here would double-send.
	test("input from source 'extension' is never intercepted, even while the agent is busy", async () => {
		const { piCore, ctx, ctxCore } = harness([cleanStop()]);

		ctxCore.agentIsIdle = false;

		const result = piCore.emitAndGetResult<{ action: string } | undefined>(
			"input",
			{
				type: "input",
				text: "synthetic continuation",
				source: "extension",
				streamingBehavior: undefined,
			},
			ctx,
		);

		expect(
			result?.action,
			"an extension-sourced input must fall through unclaimed (action: continue, or no handled result)",
		).not.toBe("handled");
		expect(piCore.sentUserMessages).toHaveLength(0);
	});

	// When the agent IS idle, pi-core's real prompt() never reaches the
	// throwing branch at all — retry.ts must not intercept in that case,
	// or it would bypass slash-command/prompt-template expansion that
	// plain session.prompt() does and sendUserMessage does not.
	test("real human input while the agent is idle is left alone (not intercepted)", async () => {
		const { piCore, ctx, ctxCore } = harness([cleanStop()]);

		ctxCore.agentIsIdle = true;

		const result = piCore.emitAndGetResult<{ action: string } | undefined>(
			"input",
			{
				type: "input",
				text: "/some-slash-command",
				source: "interactive",
				streamingBehavior: undefined,
			},
			ctx,
		);

		expect(result?.action, "idle input must be left for pi-core's normal prompt() handling, not hijacked").not.toBe(
			"handled",
		);
		expect(piCore.sentUserMessages).toHaveLength(0);
	});

	test("terminal provider failure smoke-routes through the pinned real Agent client", async () => {
		const policy = resolveRetryPolicy({
			model_fallback: { enabled: true, max_hops: 2 },
			retry: {
				smart_overrides: [
					{ when: { words: ["unload is pending"] }, max_attempts: 0, fallback_models: ["anthropic/backup"] },
					{
						when: { words: ["quota frozen"] },
						max_attempts: 0,
						fallback_models: ["omlx/wedged", "google/next"],
					},
				],
			},
		});
		const failed = { ...errorMessage("409 unload is pending"), provider: "omlx", model: "wedged" };
		const failedAgain = { ...errorMessage("429 quota frozen"), provider: "anthropic", model: "backup" };
		const h = harness([failed, failedAgain, cleanStop()], policy);
		const primary = { provider: "omlx", id: "wedged" };
		const backup = { provider: "anthropic", id: "backup" };
		const final = { provider: "google", id: "next" };
		h.ctxCore.model = primary;
		h.ctxCore.scopedModels = [{ model: backup }, { model: final }];
		h.piCore.setModelHandler = async (model) => {
			h.ctxCore.model = model;
			return true;
		};

		await promptOnce(h.agent);

		expect(h.provider.requests).toHaveLength(3);
		expect(h.ctxCore.model).toBe(final);
		expect(h.piCore.sentUserMessages).toHaveLength(0);
		expect(h.piCore.customEntries).toHaveLength(2);
		expect(h.piCore.customEntries).toMatchObject([
			{
				customType: "ppie-recover:model-fallback",
				data: {
					failedModel: "omlx/wedged",
					servingModel: "anthropic/backup",
					outcome: "hop",
				},
			},
			{
				customType: "ppie-recover:model-fallback",
				data: {
					failedModel: "anthropic/backup",
					servingModel: "google/next",
					outcome: "hop",
				},
			},
		]);
	});
});
