import { strict as assert } from "node:assert";
import test from "node:test";
import { failCompaction, recoveryChainHarness, requireAction, startAction } from "./fakes/recovery-chain-harness.ts";

const memoryFailure = {
	type: "failure-observed" as const,
	failureClass: "memory-guard" as const,
	signature: "prefill-memory-exceeded",
};
const contextFailure = {
	type: "failure-observed" as const,
	failureClass: "context-overflow" as const,
	signature: "137382-over-137000",
};

// RETRY-2 executable specification: only ppie-recover actions are governed.
// Core and foreign activity is observed and counted, never vetoed.

test("a memory-guard failure opens one chain and admits immediate compaction attempt 1", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);

	const action = requireAction(controller, "request-compaction");
	assert.deepEqual(
		{ attempt: action.attempt, delayMs: action.delayMs, trigger: action.trigger },
		{ attempt: 1, delayMs: 0, trigger: "memory-guard" },
	);
	assert.equal(controller.snapshot()?.id, "chain-1");
});

test("duplicate memory failures are absorbed while one ppie-recover action is admitted", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const first = requireAction(controller, "request-compaction");

	controller.observe(memoryFailure);
	controller.observe(memoryFailure);

	assert.equal(controller.nextAction()?.id, first.id, "duplicates must not replace the admitted action");
	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 0);
});

test("a failed ppie-recover compaction admits delayed attempt 2 and no reduction", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const first = requireAction(controller, "request-compaction");
	startAction(controller, first);
	failCompaction(controller, {
		owner: "ppie-recover",
		requestId: first.id,
		lifecycleEpoch: 1,
	});

	const second = requireAction(controller, "request-compaction");
	assert.deepEqual(
		{ attempt: second.attempt, delayMs: second.delayMs, trigger: second.trigger },
		{ attempt: 2, delayMs: 30_000, trigger: "memory-guard" },
	);
	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 1);
});

test("re-entrant failure cannot outrun a scheduled second compaction", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const first = requireAction(controller, "request-compaction");
	startAction(controller, first);
	failCompaction(controller, {
		owner: "ppie-recover",
		requestId: first.id,
		lifecycleEpoch: 1,
	});
	const scheduled = requireAction(controller, "request-compaction");

	controller.observe(memoryFailure);

	assert.equal(controller.nextAction()?.id, scheduled.id);
	assert.equal(controller.nextAction()?.kind, "request-compaction");
});

test("only after two failed memory compactions may the reduction pipeline be requested", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const first = requireAction(controller, "request-compaction");
	startAction(controller, first);
	failCompaction(controller, { owner: "ppie-recover", requestId: first.id, lifecycleEpoch: 1 });
	const second = requireAction(controller, "request-compaction");
	startAction(controller, second);
	failCompaction(controller, { owner: "ppie-recover", requestId: second.id, lifecycleEpoch: 2 });

	const reduction = requireAction(controller, "reduce-and-retry");
	assert.equal(reduction.trigger, "memory-guard");
	assert.equal(reduction.pipeline, "reduction");
	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 2);
});

test("an external compaction that starts first supersedes the unstarted ppie-recover request", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const staleOwnAction = requireAction(controller, "request-compaction");

	controller.observe({
		type: "compaction-started",
		owner: "external",
		requestId: "external-1",
		lifecycleEpoch: 7,
	});

	assert.notEqual(controller.nextAction()?.id, staleOwnAction.id);
	assert.equal(controller.nextAction(), undefined, "external compaction owns the active attempt");
});

test("a bounded external unavailable outcome counts as attempt 1", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	failCompaction(controller, { owner: "external", requestId: "external-1", lifecycleEpoch: 7 });

	const next = requireAction(controller, "request-compaction");
	assert.equal(next.attempt, 2);
	assert.equal(next.delayMs, 30_000);
	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 1);
});

test("duplicate external finish events are counted once", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const identity = { owner: "external" as const, requestId: "external-1", lifecycleEpoch: 8 };
	controller.observe({ type: "compaction-started", ...identity });
	controller.observe({ type: "compaction-finished", ...identity, outcome: "stalled" });
	controller.observe({ type: "compaction-finished", ...identity, outcome: "stalled" });

	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 1);
	assert.equal(requireAction(controller, "request-compaction").attempt, 2);
});

test("context-overflow keeps its own ledger and gets the configured compaction budget", () => {
	// One shared budget governs every trigger. Context overflow previously ran on
	// a hardcoded single attempt while memory pressure was configurable.
	const { controller } = recoveryChainHarness({ forcedCompactionAttempts: 2 });
	controller.observe(contextFailure);
	for (let attempt = 1; attempt <= 2; attempt++) {
		const compact = requireAction(controller, "request-compaction");
		assert.equal(compact.attempt, attempt);
		startAction(controller, compact);
		controller.observe({
			type: "compaction-started",
			owner: "ppie-recover",
			requestId: compact.id,
			lifecycleEpoch: attempt,
		});
		controller.observe({
			type: "compaction-finished",
			owner: "ppie-recover",
			requestId: compact.id,
			lifecycleEpoch: attempt,
			outcome: "unavailable",
		});
	}

	const reduction = requireAction(controller, "reduce-and-retry");
	assert.equal(reduction.trigger, "context-overflow");
	assert.deepEqual(
		controller.snapshot()?.compactionAttempts,
		{ contextOverflow: 2, memoryGuard: 0 },
		"the two triggers still count separately",
	);
});

test("a started ppie-recover action is the sole admitted action until it settles", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const action = requireAction(controller, "request-compaction");
	startAction(controller, action);
	controller.observe(contextFailure);
	controller.observe(memoryFailure);

	assert.equal(controller.snapshot()?.activeActionId, action.id);
	assert.equal(controller.nextAction(), undefined, "no overlapping action may be admitted");
});
