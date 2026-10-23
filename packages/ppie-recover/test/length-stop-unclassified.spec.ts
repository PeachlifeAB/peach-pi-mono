import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CompactionOutcome } from "../src/compact.ts";
import { createCompactionCoordinator } from "../src/compaction-coordinator.ts";
import { createLengthStopHandler } from "../src/length-stop.ts";
import { createOverflowRecovery } from "../src/overflow-recovery.ts";
import { createPendingMessagesGate } from "../src/pending-messages.ts";
import { createRecoveryBudget } from "../src/recovery-budget.ts";
import { DEFAULT_PRUNE_PRIORITIES } from "../src/retry-config.ts";
import type { MessageShape } from "../src/retry-utils.ts";

const fakeCtx = {
	model: { maxTokens: 128 },
	getContextUsage: () => ({ contextWindow: 1_000 }),
	sessionManager: { getBranch: () => [] },
} as unknown as ExtensionContext;

const tinyLengthMessage: MessageShape = {
	role: "assistant",
	stopReason: "length",
	content: [{ type: "text", text: "x" }],
	usage: { input: 999, output: 1 },
};

const failed = (): CompactionOutcome => ({
	kind: "failed",
	error: new Error("boom"),
});
const defaultCoordinator = () =>
	createCompactionCoordinator({
		defer: (delayMs, callback) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	});
function buildHandler(overrides: {
	compact?: (ctx: ExtensionContext) => Promise<CompactionOutcome>;
	regenerateLengthOverflow?: () => void;
	armOutputHeadroomRestore?: () => void;
	coordinator?: ReturnType<typeof createCompactionCoordinator>;
	recoveryBudget?: ReturnType<typeof createRecoveryBudget>;
}) {
	const notifications: string[] = [];
	const terminals: string[] = [];
	const coordinator = overrides.coordinator ?? defaultCoordinator();
	return {
		notifications,
		terminals,
		coordinator,
		handler: createLengthStopHandler({
			pi: { sendUserMessage: () => {} },
			setStatus: () => {},
			showRetryStatus: () => {},
			notify: (message) => notifications.push(message),
			terminal: (_ctx, message) => terminals.push(message),
			compact: overrides.compact ?? (async () => failed()),
			consumeRecoveryAttempt: overrides.recoveryBudget?.consume ?? (() => ({ allowed: true, attempt: 1, limit: 5 })),
			coordinator,
			getOverflowRetryDelayMs: () => 10,
			getCompactionWarningMs: () => undefined,
			getCompactionStallCheckMs: () => 180_000,
			getCompactionStallRetryMs: () => 480_000,
			isCurrent: () => true,
			regenerateLengthOverflow: overrides.regenerateLengthOverflow ?? (() => {}),
			armOutputHeadroomRestore: overrides.armOutputHeadroomRestore ?? (() => {}),
			pendingMessagesGate: createPendingMessagesGate({
				notify: () => {},
				terminal: () => {},
			}),
		}),
	};
}

async function flushAsync() {
	for (let i = 0; i < 5; i++) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
}

function buildRecovery(coordinator: ReturnType<typeof createCompactionCoordinator>) {
	return createOverflowRecovery({
		getReserveTokens: () => 2000,
		getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
		getMarkers: () => [],
		setStatus: () => {},
		notify: () => {},
		terminal: () => {},
		compact: async () => failed(),
		coordinator,
		isCurrent: () => true,
	});
}

describe("length-stop.ts recovery sequencing", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("context recovery active -> length stop does not strand a local pending flag", () => {
		const coordinator = defaultCoordinator();
		const recovery = buildRecovery(coordinator);
		const { handler } = buildHandler({ coordinator });

		recovery.awaitCoreDeferOrFallback(fakeCtx, {
			retryDelayMs: 10,
			onRetry: () => {},
		});
		expect(recovery.hasPendingCoreDefer()).toBe(true);

		handler.handle(fakeCtx, tinyLengthMessage);
		expect(handler.hasPendingLengthOverflowRetry()).toBe(false);
	});

	test("length-only pressure does not request recovery fallback compaction", async () => {
		const ctx = {
			...fakeCtx,
			getContextUsage: () => ({ contextWindow: 1_000, tokens: 950, percent: 95 }),
		} as ExtensionContext;
		let compactCalls = 0;
		let regenerateCalls = 0;
		const { handler, coordinator, terminals } = buildHandler({
			compact: async () => {
				compactCalls++;
				return failed();
			},
			regenerateLengthOverflow: () => {
				regenerateCalls++;
			},
		});

		handler.handle(ctx, tinyLengthMessage);
		await vi.advanceTimersByTimeAsync(10);
		await flushAsync();

		expect(coordinator.hasActiveRequest()).toBe(true);
		expect(compactCalls).toBe(0);
		expect(regenerateCalls).toBe(0);
		expect(terminals).toHaveLength(0);
	});

	test("one-token length stops never spend recovery budget without observed compaction", async () => {
		const ctx = {
			...fakeCtx,
			getContextUsage: () => ({ contextWindow: 1_000, tokens: 950, percent: 95 }),
		} as ExtensionContext;
		const budget = createRecoveryBudget(() => 5);
		const compact = vi.fn(async () => failed());
		const regenerate = vi.fn();
		const { handler, coordinator } = buildHandler({
			compact,
			recoveryBudget: budget,
			regenerateLengthOverflow: regenerate,
		});

		handler.handle(ctx, tinyLengthMessage);
		coordinator.onAgentSettled();
		await vi.advanceTimersByTimeAsync(20_010);
		await flushAsync();

		expect(compact).not.toHaveBeenCalled();
		expect(budget.used()).toBe(0);
		expect(regenerate).not.toHaveBeenCalled();
	});

	test("tool progress does not authorize fallback compaction for a length-only stop", async () => {
		const branch: Array<{ type: string; id: string; message?: MessageShape }> = [];
		const ctx = {
			...fakeCtx,
			getContextUsage: () => ({ contextWindow: 1_000, tokens: 950, percent: 95 }),
			sessionManager: { getBranch: () => branch },
		} as ExtensionContext;
		const coordinator = defaultCoordinator();
		let compactCalls = 0;
		const { handler } = buildHandler({
			coordinator,
			compact: async () => {
				compactCalls++;
				return failed();
			},
		});

		handler.handle(ctx, tinyLengthMessage);
		coordinator.onAgentSettled();
		await vi.advanceTimersByTimeAsync(10);
		branch.push({ type: "message", id: "work", message: { role: "toolResult" } });
		handler.handle(ctx, tinyLengthMessage);
		coordinator.onAgentSettled();
		await vi.advanceTimersByTimeAsync(10);

		expect(compactCalls).toBe(0);
	});
	test("length recovery active -> context overflow does not strand a local pending flag", () => {
		const coordinator = defaultCoordinator();
		const recovery = buildRecovery(coordinator);
		const { handler } = buildHandler({ coordinator });

		handler.handle(fakeCtx, tinyLengthMessage);
		expect(handler.hasPendingLengthOverflowRetry()).toBe(true);

		recovery.awaitCoreDeferOrFallback(fakeCtx, {
			retryDelayMs: 10,
			onRetry: () => {},
		});
		expect(recovery.hasPendingCoreDefer()).toBe(false);
	});
});
