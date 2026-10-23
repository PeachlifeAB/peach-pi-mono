import { strict as assert } from "node:assert";
import test from "node:test";
import type { CompactionFailureOutcome } from "../src/recovery-chain.ts";
import { failCompaction, recoveryChainHarness, requireAction, startAction } from "./fakes/recovery-chain-harness.ts";

const memoryFailure = {
	type: "failure-observed" as const,
	failureClass: "memory-guard" as const,
	signature: "memory",
};
const contextFailure = {
	type: "failure-observed" as const,
	failureClass: "context-overflow" as const,
	signature: "context",
};

function startOwnCompaction(controller: ReturnType<typeof recoveryChainHarness>["controller"], epoch: number) {
	const action = requireAction(controller, "request-compaction");
	startAction(controller, action);
	controller.observe({
		type: "compaction-started",
		owner: "ppie-recover",
		requestId: action.id,
		lifecycleEpoch: epoch,
	});
	return action;
}

test("successful ppie-recover compaction admits its provider continuation", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const action = startOwnCompaction(controller, 1);
	controller.observe({
		type: "compaction-finished",
		owner: "ppie-recover",
		requestId: action.id,
		lifecycleEpoch: 1,
		outcome: "completed",
		continuationOwner: "ppie-recover",
	});

	const continuation = requireAction(controller, "continue-provider");
	assert.equal(continuation.attempt, 1);
	assert.equal(continuation.trigger, "memory-guard");
});

test("successful external compaction with core continuation admits no ppie-recover action", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	controller.observe({
		type: "compaction-started",
		owner: "external",
		requestId: "core-overflow",
		lifecycleEpoch: 1,
	});
	controller.observe({
		type: "compaction-finished",
		owner: "external",
		requestId: "core-overflow",
		lifecycleEpoch: 1,
		outcome: "completed",
		continuationOwner: "core",
	});

	assert.equal(controller.nextAction(), undefined);
	assert.equal(controller.snapshot()?.status, "recovering");
});

test("successful external compaction without core retry admits ppie-recover continuation", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	controller.observe({
		type: "compaction-started",
		owner: "external",
		requestId: "manual-compact",
		lifecycleEpoch: 2,
	});
	controller.observe({
		type: "compaction-finished",
		owner: "external",
		requestId: "manual-compact",
		lifecycleEpoch: 2,
		outcome: "completed",
		continuationOwner: "ppie-recover",
	});

	assert.equal(requireAction(controller, "continue-provider").attempt, 1);
});

test("duplicate lifecycle events and mismatched finishes are idempotent", () => {
	const { controller, telemetry } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const identity = { owner: "external" as const, requestId: "external-1", lifecycleEpoch: 4 };
	controller.observe({ type: "compaction-started", ...identity });
	controller.observe({ type: "compaction-started", ...identity });
	controller.observe({
		type: "compaction-finished",
		owner: "external",
		requestId: "wrong",
		lifecycleEpoch: 4,
		outcome: "stalled",
	});
	assert.equal(controller.nextAction(), undefined);
	controller.observe({ type: "compaction-finished", ...identity, outcome: "stalled" });
	controller.observe({ type: "compaction-finished", ...identity, outcome: "stalled" });

	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 1);
	assert.equal(telemetry.filter((event) => event.type === "compaction-started").length, 1);
	assert.equal(telemetry.filter((event) => event.type === "compaction-finished").length, 1);
});

test("finish without a matching start is ignored", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const admitted = requireAction(controller, "request-compaction");
	controller.observe({
		type: "compaction-finished",
		owner: "external",
		requestId: "never-started",
		lifecycleEpoch: 1,
		outcome: "unavailable",
	});
	assert.equal(controller.nextAction()?.id, admitted.id);
	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 0);
});

test("a stale superseded ppie-recover action cannot start", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const stale = requireAction(controller, "request-compaction");
	controller.observe({
		type: "compaction-started",
		owner: "external",
		requestId: "external-1",
		lifecycleEpoch: 1,
	});
	controller.observe({
		type: "compaction-started",
		owner: "ppie-recover",
		requestId: stale.id,
		lifecycleEpoch: 2,
	});
	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 1);
});

test("external compaction supersedes delayed attempt 2", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const first = requireAction(controller, "request-compaction");
	startAction(controller, first);
	failCompaction(controller, { owner: "ppie-recover", requestId: first.id, lifecycleEpoch: 1 });
	const delayed = requireAction(controller, "request-compaction");
	assert.equal(delayed.attempt, 2);

	controller.observe({
		type: "compaction-started",
		owner: "external",
		requestId: "external-2",
		lifecycleEpoch: 2,
	});
	assert.equal(controller.nextAction(), undefined);
	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 2);
});

test("external start after own start supersedes its late finish", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const own = startOwnCompaction(controller, 1);
	controller.observe({
		type: "compaction-started",
		owner: "external",
		requestId: "external-2",
		lifecycleEpoch: 2,
	});
	controller.observe({
		type: "compaction-finished",
		owner: "ppie-recover",
		requestId: own.id,
		lifecycleEpoch: 1,
		outcome: "unavailable",
	});
	assert.equal(controller.nextAction(), undefined);
	controller.observe({
		type: "compaction-finished",
		owner: "external",
		requestId: "external-2",
		lifecycleEpoch: 2,
		outcome: "stalled",
	});
	assert.equal(requireAction(controller, "reduce-and-retry").attempt, 1);
});

test("every unresolved compaction outcome consumes one attempt, whatever the trigger", () => {
	// One compaction that did not resolve the overflow costs one attempt whether
	// it failed mid-flight, had nothing to compact, or completed without freeing
	// enough — and both triggers draw on the same budget.
	for (const outcome of ["failed-memory-guard", "unavailable", "aborted", "stalled"] as CompactionFailureOutcome[]) {
		for (const failure of [memoryFailure, contextFailure]) {
			const { controller } = recoveryChainHarness({ forcedCompactionAttempts: 2 });
			controller.observe(failure);
			const action = startOwnCompaction(controller, 1);
			controller.observe({
				type: "compaction-finished",
				owner: "ppie-recover",
				requestId: action.id,
				lifecycleEpoch: 1,
				outcome,
			});
			assert.equal(
				controller.nextAction()?.kind,
				"request-compaction",
				`${failure.failureClass}/${outcome} must keep its second compaction attempt`,
			);
		}
	}
});

test("configured memory compaction counts 1, 2, and 3 are exact", () => {
	for (const limit of [1, 2, 3]) {
		const { controller } = recoveryChainHarness({ forcedCompactionAttempts: limit });
		controller.observe(memoryFailure);
		for (let attempt = 1; attempt <= limit; attempt++) {
			const action = requireAction(controller, "request-compaction");
			assert.equal(action.attempt, attempt);
			startAction(controller, action);
			failCompaction(controller, {
				owner: "ppie-recover",
				requestId: action.id,
				lifecycleEpoch: attempt,
			});
		}
		assert.equal(requireAction(controller, "reduce-and-retry").attempt, 1);
	}
});
