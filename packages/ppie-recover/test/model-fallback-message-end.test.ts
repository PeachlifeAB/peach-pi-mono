import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerRetryMessageEnd } from "../src/retry-message-end.ts";

type MessageEndHandler = (event: { message: unknown }, ctx: ExtensionContext) => void;

function harness(input: {
	neverRetries: boolean;
	exhausted: boolean;
	maxHops: number;
	fallbackModels: readonly string[];
}) {
	let handler: MessageEndHandler | undefined;
	const routes: unknown[] = [];
	const notifications: string[] = [];
	registerRetryMessageEnd({
		pi: {
			on: (_event: string, next: MessageEndHandler) => {
				handler = next;
			},
		} as never,
		guarded: ((_name: string, next: MessageEndHandler) => next) as never,
		engine: { cancel: () => undefined } as never,
		fallback: {
			route: async (route: unknown) => {
				routes.push(route);
				return "redispatched";
			},
			activeSequence: () => undefined,
			succeed: () => undefined,
			cancel: () => undefined,
			isActive: () => false,
		} as never,
		maxFallbackHops: input.maxHops,
		lengthStop: { shouldRecoverTinyStop: () => false, handle: () => undefined } as never,
		responsesOutputBudget: {
			classifyMessageEnd: () => false,
		} as never,
		recovery: {
			classifyAndTrack: () => ({ signature: "model-not-found" }),
		} as never,
		watchdog: { disarm: () => undefined } as never,
		setContext: () => undefined,
		setLatestContext: () => undefined,
		notify: (message: string) => notifications.push(message),
		triggerRetry: () => undefined,
		resetTurn: () => undefined,
		onProviderProgress: () => undefined,
		admission: {
			neverRetries: () => input.neverRetries,
			retryBudgetExhausted: () => input.exhausted,
			fallbackModelsFor: () => input.fallbackModels,
			ruleFor: () => "terminal rule",
		} as never,
		isUserAborted: () => false,
		markUserAborted: () => undefined,
	});
	const ctx = {
		model: { provider: "external", id: "peer" },
		sessionManager: {},
	} as unknown as ExtensionContext;
	return {
		routes,
		notifications,
		emit() {
			assert.ok(handler);
			handler(
				{
					message: {
						role: "assistant",
						stopReason: "error",
						errorMessage: "503 model not found",
						provider: "openai",
						model: "primary",
					},
				},
				ctx,
			);
		},
	};
}

test("both terminal branches route the failed message model after in-place recovery ends", () => {
	for (const terminal of [
		{ neverRetries: true, exhausted: false },
		{ neverRetries: false, exhausted: true },
	]) {
		const h = harness({ ...terminal, maxHops: 3, fallbackModels: ["anthropic/backup"] });
		h.emit();
		assert.deepEqual(h.routes, [
			{
				failedModel: "openai/primary",
				fallbackModels: ["anthropic/backup"],
				maxHops: 3,
				reason: "permanent",
				status: 503,
			},
		]);
		assert.deepEqual(h.notifications, []);
	}
});

test("disabled fallback and empty matched chains preserve terminal notification behavior", () => {
	for (const config of [
		{ maxHops: 0, fallbackModels: ["anthropic/backup"] },
		{ maxHops: 3, fallbackModels: [] },
	]) {
		const h = harness({ neverRetries: true, exhausted: false, ...config });
		h.emit();
		assert.deepEqual(h.routes, []);
		assert.equal(h.notifications.length, 1);
		assert.match(h.notifications[0] ?? "", /Non-retryable error/);
	}
});
