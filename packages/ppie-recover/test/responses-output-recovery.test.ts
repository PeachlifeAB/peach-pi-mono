import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompactionCoordinator } from "../src/compaction-coordinator.ts";
import { createLengthStopHandler } from "../src/length-stop.ts";
import { OUTPUT_BUDGET_FIELDS } from "../src/output-budget-dialect.ts";
import { createResponsesOutputBudgetRecovery } from "../src/responses-output-budget-recovery.ts";
import { registerRetryMessageEnd } from "../src/retry-message-end.ts";
import { type MessageShape, requestedMaxOutputTokensOf, restoreOutputHeadroom } from "../src/retry-utils.ts";

function createMessageEndHarness(overrides?: {
	responsesOutputBudget?: ReturnType<typeof createResponsesOutputBudgetRecovery>;
}) {
	let lengthStopHandled: MessageShape | undefined;
	let genericRetried = false;
	const notifications: string[] = [];
	let messageEndHandler: ((event: { message: MessageShape }, ctx: ExtensionContext) => void) | undefined;

	const budget =
		overrides?.responsesOutputBudget ??
		({
			classifyMessageEnd: () => false,
			onProviderProgress: () => {},
		} as unknown as ReturnType<typeof createResponsesOutputBudgetRecovery>);

	registerRetryMessageEnd({
		pi: {
			on: (_event: string, handler: unknown) => {
				messageEndHandler = handler as typeof messageEndHandler;
			},
		} as never,
		guarded: ((_name: string, handler: unknown) => handler) as never,
		engine: { cancel: () => {} } as never,
		fallback: {
			route: async () => "redispatched",
			activeSequence: () => undefined,
			succeed: () => {},
			cancel: () => {},
			isActive: () => false,
		} as never,
		maxFallbackHops: 0,
		lengthStop: {
			shouldRecoverTinyStop: () => false,
			handle: (_ctx: ExtensionContext, message: MessageShape) => {
				lengthStopHandled = message;
			},
		} as never,
		responsesOutputBudget: budget,
		recovery: {
			classifyAndTrack: () => ({ signature: "test" }),
			shouldDeferToCore: () => false,
			awaitCoreDeferOrFallback: () => {},
		} as never,
		watchdog: { disarm: () => {} } as never,
		setContext: () => {},
		setLatestContext: () => {},
		notify: (msg: string) => {
			notifications.push(msg);
		},
		triggerRetry: () => {
			genericRetried = true;
		},
		resetTurn: () => {},
		onProviderProgress: () => budget.onProviderProgress(),
		admission: {
			neverRetries: () => false,
			retryBudgetExhausted: () => false,
			fallbackModelsFor: () => [],
			ruleFor: () => "catch-all",
		} as never,
		isUserAborted: () => false,
		markUserAborted: () => {},
	});

	const ctx = {
		sessionManager: { getBranch: () => [] },
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow: 127_000 }),
	} as unknown as ExtensionContext;

	return {
		emit: (msg: MessageShape) => messageEndHandler!({ message: msg }, ctx),
		getHandled: () => lengthStopHandled,
		isGenericRetried: () => genericRetried,
		getNotifications: () => notifications,
	};
}

// ---------------------------------------------------------------------------
// Routing tests (preserved as routing verification)
// ---------------------------------------------------------------------------

test("Routing: Responses incomplete reason 'max_tokens' routes through lengthStop when not eligible for budget recovery", () => {
	const harness = createMessageEndHarness();

	const responsesOutputExhaustedMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "Response incomplete: max_tokens",
		content: [],
	};

	harness.emit(responsesOutputExhaustedMessage);

	assert.ok(
		harness.getHandled() !== undefined,
		"Responses incomplete: max_tokens routes to lengthStop handler when budget recovery does not claim it",
	);
	assert.equal(harness.isGenericRetried(), false, "Must NOT trigger generic retry for Responses output exhaustion");
	assert.equal(
		harness.getNotifications().some((n) => n.includes("Unrecognized provider error")),
		false,
		"Must NOT notify 'Unrecognized provider error'",
	);
});

test("Routing: Responses output exhaustion detected via structured rawStopReason 'incomplete.max_tokens'", () => {
	const harness = createMessageEndHarness();

	const structuredExhaustionMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		errorMessage: "Response incomplete: max_tokens",
		content: [],
	};

	harness.emit(structuredExhaustionMessage);

	assert.ok(
		harness.getHandled() !== undefined,
		"Structured rawStopReason 'incomplete.max_tokens' routes to lengthStop handler",
	);
	assert.equal(harness.isGenericRetried(), false);
});

test("Routing: Responses output exhaustion detected via structured rawStopReason 'incomplete.max_output_tokens'", () => {
	const harness = createMessageEndHarness();

	const structuredCanonicalMessage: MessageShape = {
		role: "assistant",
		stopReason: "length",
		rawStopReason: "incomplete.max_output_tokens",
		content: [],
	};

	harness.emit(structuredCanonicalMessage);

	assert.ok(
		harness.getHandled() !== undefined,
		"Structured rawStopReason 'incomplete.max_output_tokens' routes to lengthStop handler",
	);
	assert.equal(harness.isGenericRetried(), false);
});

test("Routing: Responses incomplete reason that is NOT output exhaustion retains generic/unrelated error handling", () => {
	const harness = createMessageEndHarness();

	const contentFilterMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "Response incomplete: content_filter",
		content: [],
	};

	harness.emit(contentFilterMessage);

	assert.equal(harness.getHandled(), undefined, "Content filter incomplete reason must NOT route to lengthStop");
	assert.equal(harness.isGenericRetried(), true, "Content filter must retain existing retry handling");
});

// ---------------------------------------------------------------------------
// Low-level helper tests
// ---------------------------------------------------------------------------

test("Helper: requestedMaxOutputTokensOf supports Responses max_output_tokens field", () => {
	const responsesPayload = {
		model: "gpt-4o",
		max_output_tokens: 16,
		messages: [{ role: "user", content: "hello" }],
	};

	const tokens = requestedMaxOutputTokensOf(responsesPayload);
	assert.equal(tokens, 16, "requestedMaxOutputTokensOf recognizes max_output_tokens field");
});

test("Helper: restoreOutputHeadroom honors caller-supplied ceiling", () => {
	const responsesPayload = {
		model: "gpt-4o",
		max_output_tokens: 16,
		messages: [{ role: "user", content: "hello" }],
	};

	const restored = restoreOutputHeadroom(responsesPayload, {
		contextWindow: 128_000,
		prunedPayloadChars: 20_000,
		charsPerToken: 4,
		maxRestoredTokens: 4_096,
	}) as { max_output_tokens?: number } | undefined;

	assert.ok(restored, "Payload returned");
	assert.equal(typeof restored.max_output_tokens, "number", "max_output_tokens preserved and restored as number");
	assert.equal(restored.max_output_tokens, 4_096, "max_output_tokens restored to caller-supplied ceiling");
});

// ---------------------------------------------------------------------------
// Gherkin Acceptance Scenarios for Dedicated Stale Output Budget Recovery
// ---------------------------------------------------------------------------

function setupRecoveryHarness(options?: { contextWindow?: number; modelMaxTokens?: number }) {
	const contextWindow = options?.contextWindow ?? 127_000;
	const modelMaxTokens = options?.modelMaxTokens ?? 4096;
	const terminals: string[] = [];
	const retryStatuses: string[] = [];
	let regenerations = 0;

	const ctx = {
		model: { maxTokens: modelMaxTokens },
		getContextUsage: () => ({ contextWindow }),
	} as unknown as ExtensionContext;

	const recovery = createResponsesOutputBudgetRecovery({
		regenerateLengthOverflow: () => {
			regenerations++;
		},
		showRetryStatus: () => {
			retryStatuses.push("retry-status");
		},
		terminal: (_c, msg) => {
			terminals.push(msg);
		},
		latestContext: () => ctx,
	});

	return { recovery, ctx, terminals, retryStatuses, getRegenerations: () => regenerations };
}

test("Scenario: Recover the observed DS4 max_tokens alias with cacheWrite usage", () => {
	const { recovery, ctx, getRegenerations } = setupRecoveryHarness({
		contextWindow: 127_000,
		modelMaxTokens: 32_000,
	});

	// Given the actual DS4 Responses-compatible request uses max_tokens 16.
	const request1 = {
		model: "deepseek-v4.1-flash",
		max_tokens: 16,
		messages: [{ role: "user", content: "x".repeat(120_000) }],
	};
	recovery.observeOutgoingRequest(request1, ctx);

	// When provider request 1 ends with rawStopReason incomplete.max_tokens,
	// cacheWrite 31142, output 16.
	const response1: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		errorMessage: "Response incomplete: max_tokens",
		usage: {
			input: 0,
			cacheRead: 0,
			cacheWrite: 31_142,
			output: 16,
		},
		content: [],
	};

	const claimed = recovery.classifyMessageEnd(response1, ctx);
	assert.equal(claimed, true, "stale-output-budget recovery claims the DS4 alias failure");
	assert.equal(recovery.hasPending(), true, "repair is pending");

	// When the agent settles
	recovery.onAgentSettled();
	assert.equal(getRegenerations(), 1, "exactly one regeneration scheduled on agent_settled");

	// And normal provider request 2 is prepared with the same field.
	const request2 = {
		model: "deepseek-v4.1-flash",
		max_tokens: 16,
		messages: [{ role: "user", content: "x".repeat(120_000) }],
	};
	const repaired = recovery.applyPendingRepair(request2, ctx) as { max_tokens: number };

	// Then provider request 2 restores the model's configured output budget.
	assert.equal(repaired.max_tokens, 32_000, "repaired request contains configured model output budget");
	assert.equal(recovery.hasPending(), false, "pending repair is cleared upon application");

	// When provider request 2 succeeds
	recovery.onProviderProgress();
	assert.equal(recovery.hasPending(), false, "state remains clear after progress");
});

test("Scenario Outline: Repair the outgoing provider dialect field", () => {
	for (const field of OUTPUT_BUDGET_FIELDS) {
		const { recovery, ctx } = setupRecoveryHarness({ contextWindow: 127_000, modelMaxTokens: 8_192 });
		const exhaustedBudget = 23;
		recovery.observeOutgoingRequest({ model: "test", [field]: exhaustedBudget }, ctx);
		assert.equal(
			recovery.classifyMessageEnd(
				{
					role: "assistant",
					stopReason: "error",
					rawStopReason: "incomplete.max_tokens",
					usage: { input: 1_000, output: exhaustedBudget },
				},
				ctx,
			),
			true,
			`claims exhausted ${field}`,
		);
		const repaired = recovery.applyPendingRepair({ model: "test", [field]: exhaustedBudget }, ctx) as Record<
			string,
			unknown
		>;
		assert.equal(repaired[field], 8_192, `repairs ${field}`);
	}
});

test("Scenario: Repair follows the regenerated request dialect", () => {
	const { recovery, ctx } = setupRecoveryHarness({ contextWindow: 127_000, modelMaxTokens: 8_192 });
	const sourceField = OUTPUT_BUDGET_FIELDS[2];
	const regeneratedField = OUTPUT_BUDGET_FIELDS[1];
	const exhaustedBudget = 23;
	recovery.observeOutgoingRequest({ model: "test", [sourceField]: exhaustedBudget }, ctx);
	assert.equal(
		recovery.classifyMessageEnd(
			{
				role: "assistant",
				stopReason: "error",
				rawStopReason: "incomplete.max_tokens",
				usage: { input: 1_000, output: exhaustedBudget },
			},
			ctx,
		),
		true,
	);
	const repaired = recovery.applyPendingRepair({ model: "test", [regeneratedField]: exhaustedBudget }, ctx) as Record<
		string,
		unknown
	>;
	assert.equal(repaired[regeneratedField], 8_192);
	assert.equal(repaired[sourceField], undefined);
});

test("Scenario Outline: Recognize structured Responses exhaustion reasons", () => {
	for (const reason of ["incomplete.max_tokens", "incomplete.max_output_tokens"]) {
		const { recovery, ctx } = setupRecoveryHarness();
		recovery.observeOutgoingRequest({ model: "test", max_output_tokens: 16 }, ctx);

		const response: MessageShape = {
			role: "assistant",
			stopReason: "error",
			rawStopReason: reason,
			usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 16 },
		};

		const claimed = recovery.classifyMessageEnd(response, ctx);
		assert.equal(claimed, true, `enters stale-output-budget recovery for reason: ${reason}`);
	}
});

test("Scenario: Do not repair when fresh usage proves no safe headroom", () => {
	const { recovery, ctx } = setupRecoveryHarness({
		contextWindow: 127_000,
		modelMaxTokens: 4096,
	});

	recovery.observeOutgoingRequest({ model: "test", max_output_tokens: 16 }, ctx);

	// Fresh prompt usage leaves fewer tokens than the exhausted outgoing cap.
	const response: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: { input: 126_990, output: 16 },
	};

	const claimed = recovery.classifyMessageEnd(response, ctx);
	assert.equal(claimed, false, "does not arm stale repair when no safe headroom exists");
	assert.equal(recovery.hasPending(), false);
});

test("Scenario: Preserve a model-level intentional 16-token limit", () => {
	const { recovery, ctx } = setupRecoveryHarness({
		contextWindow: 127_000,
		modelMaxTokens: 16, // Intentional model-level limit
	});

	recovery.observeOutgoingRequest({ model: "test", max_output_tokens: 16 }, ctx);

	const response: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: { input: 10_000, output: 16 },
	};

	const claimed = recovery.classifyMessageEnd(response, ctx);
	assert.equal(claimed, false, "preserves intentional model-level 16-token limit");
	assert.equal(recovery.hasPending(), false);
});

test("Scenario: Do not perform a second stale repair without progress", () => {
	const { recovery, ctx, terminals } = setupRecoveryHarness();

	recovery.observeOutgoingRequest({ model: "test", max_output_tokens: 16 }, ctx);
	recovery.classifyMessageEnd(
		{
			role: "assistant",
			stopReason: "error",
			rawStopReason: "incomplete.max_tokens",
			usage: { input: 10_000, output: 16 },
		},
		ctx,
	);

	// Apply repair once
	recovery.applyPendingRepair({ model: "test", max_output_tokens: 16 }, ctx);

	// Next request goes out but is still clamped to 16
	recovery.observeOutgoingRequest({ model: "test", max_output_tokens: 16 }, ctx);

	// Same failure recurs
	const secondAttempt = recovery.classifyMessageEnd(
		{
			role: "assistant",
			stopReason: "error",
			rawStopReason: "incomplete.max_tokens",
			usage: { input: 10_000, output: 16 },
		},
		ctx,
	);

	assert.equal(secondAttempt, false, "refuses second repair without progress");
	assert.equal(terminals.length, 1, "terminates with actionable diagnostic");
	assert.ok(terminals[0].includes("Stale output-budget recovery stopped"));
});

test("Scenario: A healthy repaired cap exhausting is treated as provider progress", () => {
	const { recovery, ctx } = setupRecoveryHarness();

	recovery.observeOutgoingRequest({ model: "test", max_output_tokens: 16 }, ctx);
	recovery.classifyMessageEnd(
		{
			role: "assistant",
			stopReason: "error",
			rawStopReason: "incomplete.max_tokens",
			usage: { input: 10_000, output: 16 },
		},
		ctx,
	);

	// Repair applied: raises to 4096
	recovery.applyPendingRepair({ model: "test", max_output_tokens: 16 }, ctx);

	// Provider produces 4096 tokens (healthy progress)
	recovery.onProviderProgress();
	assert.equal(recovery.hasPending(), false, "repair state cleared");
});

test("Scenario: A summarization request cannot consume a pending repair", () => {
	const { recovery, ctx } = setupRecoveryHarness();

	recovery.observeOutgoingRequest({ model: "test", max_output_tokens: 16 }, ctx);
	recovery.classifyMessageEnd(
		{
			role: "assistant",
			stopReason: "error",
			rawStopReason: "incomplete.max_tokens",
			usage: { input: 10_000, output: 16 },
		},
		ctx,
	);

	assert.equal(recovery.hasPending(), true);

	// Summarization payload arrives
	const summaryPayload = {
		model: "test",
		max_output_tokens: 16,
		messages: [{ role: "system", content: "You are a context summarization assistant..." }],
	};

	const summaryResult = recovery.applyPendingRepair(summaryPayload, ctx) as { max_output_tokens: number };
	assert.equal(summaryResult.max_output_tokens, 16, "summarization request is not modified");
	assert.equal(recovery.hasPending(), true, "repair remains pending for the normal request");

	// Next normal request arrives
	const normalPayload = {
		model: "test",
		max_output_tokens: 16,
		messages: [{ role: "user", content: "hello" }],
	};
	const normalResult = recovery.applyPendingRepair(normalPayload, ctx) as { max_output_tokens: number };
	assert.equal(normalResult.max_output_tokens, 4096, "normal request consumes the repair");
	assert.equal(recovery.hasPending(), false);
});

test("Scenario: Reset cancels a stale repair", () => {
	const { recovery, ctx } = setupRecoveryHarness();

	recovery.observeOutgoingRequest({ model: "test", max_output_tokens: 16 }, ctx);
	recovery.classifyMessageEnd(
		{
			role: "assistant",
			stopReason: "error",
			rawStopReason: "incomplete.max_tokens",
			usage: { input: 10_000, output: 16 },
		},
		ctx,
	);

	assert.equal(recovery.hasPending(), true);

	// User input or session replace triggers resetTurn
	recovery.resetTurn();
	assert.equal(recovery.hasPending(), false, "pending repair cancelled by reset");

	// Subsequent request remains untouched
	const payload = { model: "test", max_output_tokens: 16 };
	const result = recovery.applyPendingRepair(payload, ctx) as { max_output_tokens: number };
	assert.equal(result.max_output_tokens, 16, "subsequent request is not modified");
});

// ---------------------------------------------------------------------------
// Real Agent integration test (two-request repair under actual disabled config)
// ---------------------------------------------------------------------------

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import retry from "../src/retry.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";
import { CtxFakeCore, noOpProxy, PiFakeCore } from "./fakes/pi-fakes.ts";
import { registerRetryAgentForSessionManager } from "./fakes/retry-agent.ts";

test("Integration: real Agent two-request repair under disabled forced/prune configuration", async () => {
	const requests: Array<Record<string, unknown>> = [];
	let requestCount = 0;

	const streamFn = async (
		_model: unknown,
		context: { messages: unknown[] },
		options?: { onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown> },
	) => {
		requestCount++;
		let payload: unknown = {
			messages: context.messages,
			max_output_tokens: 16, // Pi clamps to 16 on request 1
		};
		const transformed = await options?.onPayload?.(payload, _model);
		if (transformed !== undefined) payload = transformed;
		requests.push(structuredClone(payload as Record<string, unknown>));

		if (requestCount === 1) {
			const res = {
				role: "assistant" as const,
				content: [],
				api: "openai-responses" as const,
				provider: "ds4-flash",
				model: "deepseek-v4.1-flash",
				stopReason: "error" as const,
				rawStopReason: "incomplete.max_tokens",
				errorMessage: "Response incomplete: max_tokens",
				usage: {
					input: 0,
					output: 16,
					cacheRead: 0,
					cacheWrite: 31_142,
					totalTokens: 31_158,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", reason: res.stopReason, message: res };
				},
				result: () => Promise.resolve(res),
			};
		}

		// Request 2 succeeds
		const res2 = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Success!" }],
			api: "openai-responses" as const,
			provider: "ds4-flash",
			model: "deepseek-v4.1-flash",
			stopReason: "stop" as const,
			usage: {
				input: 0,
				output: 20,
				cacheRead: 31_142,
				cacheWrite: 0,
				totalTokens: 31_162,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", reason: res2.stopReason, message: res2 };
			},
			result: () => Promise.resolve(res2),
		};
	};

	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 127_000;
	ctxCore.model = {
		id: "deepseek-v4.1-flash",
		provider: "ds4-flash",
		api: "openai-responses",
		contextWindow: 127_000,
		maxTokens: 4096,
	};

	const pi = noOpProxy(piCore) as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore) as unknown as CtxFakeCore;

	// Actual user policy: forced compaction disabled, prune disabled, model fallback disabled
	retry(pi, {
		policy: resolveRetryPolicy({
			retry: { max_attempts: 5 },
			memory_overflow_protection: {
				compaction: {
					enabled: true,
					dynamic: { enabled: true, at_context_ratio: 0.9 },
					forced: { enabled: false },
				},
				prune: { enabled: false },
			},
			model_fallback: { enabled: false },
		}),
	});

	const agent = new Agent({
		streamFn: streamFn as unknown as StreamFn,
		onPayload: (payload: unknown) => pi.emitAndGetResult<unknown>("before_provider_request", { payload }, ctx),
	});

	ctxCore.attachAgentState(agent.state);
	registerRetryAgentForSessionManager(ctxCore.sessionManager, agent);

	const originalPrompt = agent.prompt.bind(agent);
	agent.prompt = (async (...args: Parameters<Agent["prompt"]>) => {
		const result = await originalPrompt(...args);
		pi.emit("agent_end", { messages: agent.state.messages }, ctx);
		pi.emit("agent_settled", {}, ctx);
		return result;
	}) as Agent["prompt"];

	agent.subscribe((event: { type: string; message?: unknown }) => {
		if (event.type === "message_end") {
			pi.emit("message_end", { msg: event.message }, ctx);
		}
	});

	await agent.prompt("start turn");
	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(requests.length, 2, "Agent executed exactly 2 requests: initial + repaired");
	assert.equal(requests[0].max_output_tokens, 16, "Request 1 contained clamped 16 tokens");
	assert.equal(requests[1].max_output_tokens, 4096, "Request 2 was repaired to model.maxTokens 4096");
	assert.equal(ctxCore.compactions.length, 0, "No forced or unprompted compaction was requested");
});

// ---------------------------------------------------------------------------
// 2D Recovery Planner & Reasoning Truncation across Compaction Scenarios
// ---------------------------------------------------------------------------

import {
	classifyContextPressure,
	classifyGeneratedProgress,
	planLengthRecovery,
} from "../src/length-stop-classification.ts";

test("Feature: Continue reasoning-only output after threshold compaction", () => {
	const contextWindow = 127_000;
	const ctx = {
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow }),
	} as unknown as ExtensionContext;

	// Given the request output budget is greater than 16
	// And prompt usage is 118384 tokens
	// And output usage is 4563 tokens
	// And the response contains thinking but no visible text
	// And rawStopReason is "incomplete.max_tokens"
	const reasoningMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: {
			input: 0,
			cacheRead: 118_308,
			cacheWrite: 76,
			output: 4563,
		},
		content: [
			{
				type: "thinking",
				thinking: "Reasoning progress...".repeat(500),
			},
		],
	};

	const progress = classifyGeneratedProgress(reasoningMessage, 20);
	const pressure = classifyContextPressure(ctx, reasoningMessage);
	const plan = planLengthRecovery({
		progress,
		pressure,
	});

	// Then stale-16-budget recovery is not selected
	// And generic retry is not selected
	// And the response is classified as substantial progress under context pressure -> compact-then-follow-up
	assert.equal(progress, "substantial", "4563 output tokens classifies as substantial progress");
	assert.equal(pressure, "needs-compaction", "122947 tokens leaves < 4096 safety allowance, requiring compaction");
	assert.equal(
		plan,
		"compact-then-follow-up",
		"plans compact-then-follow-up rather than blind regeneration or immediate follow-up",
	);
});

test("Scenario: Substantial reasoning with ample headroom follows up directly without compaction", () => {
	const contextWindow = 127_000;
	const ctx = {
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow }),
	} as unknown as ExtensionContext;

	const ampleHeadroomMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: {
			input: 10_000,
			cacheRead: 0,
			cacheWrite: 0,
			output: 4000,
		},
		content: [{ type: "thinking", thinking: "Ample headroom reasoning..." }],
	};

	const progress = classifyGeneratedProgress(ampleHeadroomMessage, 20);
	const pressure = classifyContextPressure(ctx, ampleHeadroomMessage);
	const plan = planLengthRecovery({
		progress,
		pressure,
	});

	assert.equal(progress, "substantial");
	assert.equal(pressure, "has-headroom");
	assert.equal(plan, "follow-up-now", "ample headroom allows immediate follow-up");
});

test("Scenario: Tiny output under real context pressure compacts and regenerates", () => {
	const contextWindow = 127_000;
	const ctx = {
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow }),
	} as unknown as ExtensionContext;

	const tinyFullContextMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: {
			input: 125_000,
			output: 5,
		},
		content: [],
	};

	const progress = classifyGeneratedProgress(tinyFullContextMessage, 20);
	const pressure = classifyContextPressure(ctx, tinyFullContextMessage);
	const plan = planLengthRecovery({
		progress,
		pressure,
	});

	assert.equal(progress, "tiny");
	assert.equal(pressure, "needs-compaction");
	assert.equal(plan, "compact-then-regenerate", "tiny output under pressure compacts then regenerates");
});

test("Scenario: Unknown context headroom conservatively stops without blind replay", () => {
	const ctx = {
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;

	const unknownMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		content: [{ type: "thinking", thinking: "Unknown context..." }],
	};

	const progress = classifyGeneratedProgress(unknownMessage, 20);
	const pressure = classifyContextPressure(ctx, unknownMessage);
	const plan = planLengthRecovery({
		progress,
		pressure,
	});

	assert.equal(pressure, "unknown");
	assert.equal(plan, "conservative-stop", "unknown pressure halts conservatively");
});

// ---------------------------------------------------------------------------
// Compaction-gated follow-up recovery acceptance scenarios
// ---------------------------------------------------------------------------

test("Scenario: A deadline without compaction cannot permit follow-up", async () => {
	const callbacks: Array<{ active: boolean; delayMs: number; callback: () => void }> = [];
	const coordinator = createCompactionCoordinator({
		defer: (delayMs, callback) => {
			const task = { active: true, delayMs, callback };
			callbacks.push(task);
			return () => {
				task.active = false;
			};
		},
	});

	let followUpSent = false;
	const terminals: string[] = [];
	const causes: unknown[] = [];

	const handler = createLengthStopHandler({
		pi: {
			sendUserMessage: () => {
				followUpSent = true;
			},
		},
		setStatus: () => {},
		showRetryStatus: () => {},
		notify: () => {},
		terminal: (_c, msg, cause) => {
			terminals.push(msg);
			causes.push(cause);
		},
		compact: async () => ({ kind: "nothing-to-compact", error: new Error("no forced compaction") }),
		consumeRecoveryAttempt: () => ({ allowed: true, attempt: 1, limit: 5 }),
		coordinator,
		getOverflowRetryDelayMs: () => 10,
		getCompactionWarningMs: () => undefined,
		getCompactionStallCheckMs: () => 180_000,
		getCompactionStallRetryMs: () => 480_000,
		isCurrent: () => true,
		regenerateLengthOverflow: () => {},
		armOutputHeadroomRestore: () => {},
		pendingMessagesGate: {
			runWhenClear: (_ctx, _label, action) => action(),
			hasPending: () => false,
			cancel: () => {},
		},
	});

	const contextWindow = 127_000;
	const ctx = {
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow }),
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;

	// Substantial reasoning output requires compaction
	const reasoningMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: {
			input: 0,
			cacheRead: 118_308,
			cacheWrite: 76,
			output: 4563,
		},
		content: [{ type: "thinking", thinking: "x".repeat(16_000) }],
	};

	handler.handle(ctx, reasoningMessage);

	// The coordinator deadline runs (startDelayMs=10) with no compaction observed
	coordinator.onAgentSettled();
	for (const task of callbacks.filter((t) => t.active)) {
		task.active = false;
		task.callback();
	}
	await Promise.resolve();

	// Then no follow-up is queued, and recovery terminates with an actionable diagnostic
	assert.equal(followUpSent, false, "no follow-up is queued without observed compaction");
	assert.ok(terminals.length > 0, "terminates with actionable diagnostic");
	assert.ok(terminals[0].includes("no compaction was observed"));
	// The stop names forced compaction as the setting that could have continued it.
	assert.deepEqual(causes, ["compaction-not-authorized"]);
});

test("Scenario: External compaction permits one follow-up", async () => {
	const callbacks: Array<{ active: boolean; delayMs: number; callback: () => void }> = [];
	const coordinator = createCompactionCoordinator({
		defer: (delayMs, callback) => {
			const task = { active: true, delayMs, callback };
			callbacks.push(task);
			return () => {
				task.active = false;
			};
		},
	});

	let followUpSent = false;
	const terminals: string[] = [];

	const handler = createLengthStopHandler({
		pi: {
			sendUserMessage: (_msg, opts) => {
				followUpSent = true;
				assert.equal((opts as { deliverAs?: string })?.deliverAs, "followUp");
			},
		},
		setStatus: () => {},
		showRetryStatus: () => {},
		notify: () => {},
		terminal: (_c, msg) => {
			terminals.push(msg);
		},
		compact: async () => ({ kind: "nothing-to-compact", error: new Error("no forced compaction") }),
		consumeRecoveryAttempt: () => ({ allowed: true, attempt: 1, limit: 5 }),
		coordinator,
		getOverflowRetryDelayMs: () => 10,
		getCompactionWarningMs: () => undefined,
		getCompactionStallCheckMs: () => 180_000,
		getCompactionStallRetryMs: () => 480_000,
		isCurrent: () => true,
		regenerateLengthOverflow: () => {},
		armOutputHeadroomRestore: () => {},
		pendingMessagesGate: {
			runWhenClear: (_ctx, _label, action) => action(),
			hasPending: () => false,
			cancel: () => {},
		},
	});

	const contextWindow = 127_000;
	const ctx = {
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow }),
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;

	const reasoningMessage: MessageShape = {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: {
			input: 0,
			cacheRead: 118_308,
			cacheWrite: 76,
			output: 4563,
		},
		content: [{ type: "thinking", thinking: "x".repeat(16_000) }],
	};

	handler.handle(ctx, reasoningMessage);

	// External compaction starts and completes with willRetry: false
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });

	assert.equal(followUpSent, true, "exactly one follow-up queued on observed compaction completion");
	assert.equal(terminals.length, 0, "no error terminated");
});

test("Scenario: Core-owned continuation is not duplicated", async () => {
	const coordinator = createCompactionCoordinator({
		defer: () => () => {},
	});

	let followUpSent = false;
	const handler = createLengthStopHandler({
		pi: {
			sendUserMessage: () => {
				followUpSent = true;
			},
		},
		setStatus: () => {},
		showRetryStatus: () => {},
		notify: () => {},
		terminal: () => {},
		compact: async () => ({ kind: "nothing-to-compact", error: new Error("no forced compaction") }),
		consumeRecoveryAttempt: () => ({ allowed: true, attempt: 1, limit: 5 }),
		coordinator,
		getOverflowRetryDelayMs: () => 10,
		getCompactionWarningMs: () => undefined,
		getCompactionStallCheckMs: () => 180_000,
		getCompactionStallRetryMs: () => 480_000,
		isCurrent: () => true,
		regenerateLengthOverflow: () => {},
		armOutputHeadroomRestore: () => {},
		pendingMessagesGate: {
			runWhenClear: (_ctx, _label, action) => action(),
			hasPending: () => false,
			cancel: () => {},
		},
	});

	const ctx = {
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow: 127_000 }),
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;

	handler.handle(ctx, {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: { input: 0, cacheRead: 118_308, cacheWrite: 76, output: 4563 },
		content: [{ type: "thinking", thinking: "x".repeat(16_000) }],
	});

	// External compaction completes with willRetry: true (core will self-retry)
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: true });

	assert.equal(followUpSent, false, "ppie-recover queues no duplicate follow-up when core willRetry is true");
});

test("Scenario: An old compaction cannot satisfy a new request", async () => {
	const callbacks: Array<{ active: boolean; delayMs: number; callback: () => void }> = [];
	const coordinator = createCompactionCoordinator({
		defer: (delayMs, callback) => {
			const task = { active: true, delayMs, callback };
			callbacks.push(task);
			return () => {
				task.active = false;
			};
		},
	});

	// Given a compaction completed before the recovery request began (lifecycleEpoch becomes 1)
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });

	let followUpSent = false;
	const terminals: string[] = [];

	const handler = createLengthStopHandler({
		pi: {
			sendUserMessage: () => {
				followUpSent = true;
			},
		},
		setStatus: () => {},
		showRetryStatus: () => {},
		notify: () => {},
		terminal: (_c, msg) => {
			terminals.push(msg);
		},
		compact: async () => ({ kind: "nothing-to-compact", error: new Error("no forced compaction") }),
		consumeRecoveryAttempt: () => ({ allowed: true, attempt: 1, limit: 5 }),
		coordinator,
		getOverflowRetryDelayMs: () => 10,
		getCompactionWarningMs: () => undefined,
		getCompactionStallCheckMs: () => 180_000,
		getCompactionStallRetryMs: () => 480_000,
		isCurrent: () => true,
		regenerateLengthOverflow: () => {},
		armOutputHeadroomRestore: () => {},
		pendingMessagesGate: {
			runWhenClear: (_ctx, _label, action) => action(),
			hasPending: () => false,
			cancel: () => {},
		},
	});

	const ctx = {
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow: 127_000 }),
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;

	// When recovery request starts now
	handler.handle(ctx, {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: { input: 0, cacheRead: 118_308, cacheWrite: 76, output: 4563 },
		content: [{ type: "thinking", thinking: "x".repeat(16_000) }],
	});

	// And no newer compaction occurs; deadline runs
	coordinator.onAgentSettled();
	for (const task of callbacks.filter((t) => t.active)) {
		task.active = false;
		task.callback();
	}
	await Promise.resolve();

	// Then the old lifecycle epoch does not authorize a follow-up
	assert.equal(followUpSent, false, "old compaction lifecycle cannot authorize new request");
	assert.ok(terminals.length > 0);
	assert.ok(terminals[0].includes("no compaction was observed"));
});

test("Scenario: Reset invalidates a pending compact-then-follow-up", async () => {
	const coordinator = createCompactionCoordinator({
		defer: () => () => {},
	});

	let followUpSent = false;
	const handler = createLengthStopHandler({
		pi: {
			sendUserMessage: () => {
				followUpSent = true;
			},
		},
		setStatus: () => {},
		showRetryStatus: () => {},
		notify: () => {},
		terminal: () => {},
		compact: async () => ({ kind: "nothing-to-compact", error: new Error("no forced compaction") }),
		consumeRecoveryAttempt: () => ({ allowed: true, attempt: 1, limit: 5 }),
		coordinator,
		getOverflowRetryDelayMs: () => 10,
		getCompactionWarningMs: () => undefined,
		getCompactionStallCheckMs: () => 180_000,
		getCompactionStallRetryMs: () => 480_000,
		isCurrent: () => true,
		regenerateLengthOverflow: () => {},
		armOutputHeadroomRestore: () => {},
		pendingMessagesGate: {
			runWhenClear: (_ctx, _label, action) => action(),
			hasPending: () => false,
			cancel: () => {},
		},
	});

	const ctx = {
		model: { maxTokens: 4096 },
		getContextUsage: () => ({ contextWindow: 127_000 }),
		sessionManager: { getBranch: () => [] },
	} as unknown as ExtensionContext;

	handler.handle(ctx, {
		role: "assistant",
		stopReason: "error",
		rawStopReason: "incomplete.max_tokens",
		usage: { input: 0, cacheRead: 118_308, cacheWrite: 76, output: 4563 },
		content: [{ type: "thinking", thinking: "x".repeat(16_000) }],
	});

	assert.equal(handler.hasPendingLengthOverflowRetry(), true, "recovery is pending");

	// Reset occurs before compaction completes
	handler.reset();
	assert.equal(handler.hasPendingLengthOverflowRetry(), false, "pending state cleared");

	// Compaction later completes
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });

	assert.equal(followUpSent, false, "no follow-up is queued after reset");
});
