import assert from "node:assert/strict";
import test from "node:test";
import { createCompactionCoordinator } from "../src/compaction-coordinator.ts";
import { createLengthStopHandler } from "../src/length-stop.ts";
import { createOverflowRecovery } from "../src/overflow-recovery.ts";
import { createRecoveryBudget } from "../src/recovery-budget.ts";
import { DEFAULT_PRUNE_PRIORITIES, STATUS_VISIBLE_MS } from "../src/retry-config.ts";
import { createStatusController } from "../src/status.ts";
import { asExtensionContext, CtxFakeCore } from "./fakes/pi-fakes.ts";

// A recovery wait can outlast STATUS_VISIBLE_MS by minutes (first-retry delay
// for context overflow is user-configurable, 60-90s in practice). The wait
// status must stay visible and say which attempt it is.

test("sticky status survives the visibility timeout; plain status does not", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const core = new CtxFakeCore();
	const ctx = asExtensionContext(core);
	const { setStatus, clearStatus } = createStatusController();

	setStatus(ctx, "⏳ waiting", { sticky: true });
	t.mock.timers.tick(STATUS_VISIBLE_MS * 10);
	assert.deepEqual(core.ui.status, ["⏳ waiting"]);

	clearStatus(ctx);
	assert.deepEqual(core.ui.status, ["⏳ waiting", undefined]);

	setStatus(ctx, "🔁 retrying");
	t.mock.timers.tick(STATUS_VISIBLE_MS);
	assert.deepEqual(core.ui.status, ["⏳ waiting", undefined, "🔁 retrying", undefined]);
});

test("peek reports the next attempt without consuming it", () => {
	const budget = createRecoveryBudget(() => 5);
	assert.deepEqual(budget.peek(), { attempt: 1, limit: 5 });
	assert.equal(budget.used(), 0);
	budget.consume();
	assert.deepEqual(budget.peek(), { attempt: 2, limit: 5 });
});

function lengthStopHarness() {
	const core = new CtxFakeCore();
	core.contextWindow = 127_000;
	core.model = { maxTokens: 4096 };
	const ctx = asExtensionContext(core);
	const coordinator = createCompactionCoordinator({ defer: () => () => {} });
	const { setStatus, clearStatus } = createStatusController();
	const budget = createRecoveryBudget(() => 5);
	const handler = createLengthStopHandler({
		pi: { sendUserMessage: () => {} },
		setStatus,
		clearStatus,
		showRetryStatus: () => {},
		notify: () => {},
		terminal: () => {},
		compact: async () => ({ kind: "completed" }),
		consumeRecoveryAttempt: budget.consume,
		peekRecoveryAttempt: budget.peek,
		coordinator,
		getOverflowRetryDelayMs: () => 90_000,
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
	const stop = () =>
		handler.handle(ctx, {
			role: "assistant",
			stopReason: "error",
			rawStopReason: "incomplete.max_tokens",
			usage: { input: 0, cacheRead: 118_308, cacheWrite: 76, output: 4563 },
			content: [{ type: "thinking", thinking: "x".repeat(16_000) }],
		});
	return { core, coordinator, stop };
}

test("length-stop wait status shows the attempt and stays through the wait", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { core, stop } = lengthStopHarness();

	stop();
	t.mock.timers.tick(60_000);

	assert.deepEqual(core.ui.status, ["⏳ waiting for compaction · 1/5"]);
});

function overflowHarness() {
	const core = new CtxFakeCore();
	const ctx = asExtensionContext(core);
	const coordinator = createCompactionCoordinator({ defer: () => () => {} });
	const { setStatus, clearStatus } = createStatusController();
	const budget = createRecoveryBudget(() => 5);
	const recovery = createOverflowRecovery({
		getReserveTokens: () => 0,
		getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
		getMarkers: () => [],
		setStatus,
		clearStatus,
		peekRecoveryAttempt: budget.peek,
		notify: () => {},
		terminal: () => {},
		compact: async () => ({ kind: "completed" }),
		coordinator,
		getFallbackCompactionMaxAttempts: () => 1,
		isCurrent: () => true,
	});
	const overflow = () =>
		recovery.awaitCoreDeferOrFallback(ctx, {
			retryDelayMs: 90_000,
			errorMessage: "Prompt too long: 190856 tokens exceeds max context window of 73728 tokens",
			onRetry: () => {},
		});
	return { core, coordinator, overflow };
}

test("context-overflow wait status shows delay and attempt and stays through the wait", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { core, overflow } = overflowHarness();

	overflow();
	t.mock.timers.tick(60_000);

	assert.deepEqual(core.ui.status, ["⏳ waiting for compaction (90s) · 1/5"]);
});

test("cancelling the context-overflow wait clears its sticky status", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { core, coordinator, overflow } = overflowHarness();

	overflow();
	coordinator.cancel();

	assert.deepEqual(core.ui.status, ["⏳ waiting for compaction (90s) · 1/5", undefined]);
});

test("cancelling the recovery wait clears its sticky status", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { core, coordinator, stop } = lengthStopHarness();

	stop();
	coordinator.cancel();

	assert.deepEqual(core.ui.status, ["⏳ waiting for compaction · 1/5", undefined]);
});
