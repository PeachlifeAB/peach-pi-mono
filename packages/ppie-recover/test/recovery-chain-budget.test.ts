import { strict as assert } from "node:assert";
import test from "node:test";
import { recoveryChainHarness, requireAction, startAction } from "./fakes/recovery-chain-harness.ts";

const memoryFailure = {
	type: "failure-observed" as const,
	failureClass: "memory-guard" as const,
	signature: "memory",
};

function reachReduction(maxPruningAttempts: number) {
	const harness = recoveryChainHarness({ forcedCompactionAttempts: 0, maxPruningAttempts });
	harness.controller.observe(memoryFailure);
	return harness;
}

test("memory pressure stops when both compaction and pruning are disabled", () => {
	const { controller } = recoveryChainHarness({
		forcedCompactionAttempts: 0,
		maxPruningAttempts: 0,
	});
	controller.observe(memoryFailure);
	const terminal = requireAction(controller, "notify-terminal");
	assert.match(terminal.reason, /pruning is disabled/);
});

test("pruning draws on its own budget, not the provider retry budget", () => {
	const { controller } = recoveryChainHarness({
		forcedCompactionAttempts: 0,
		maxPruningAttempts: 3,
		maxProviderRetryAttempts: 1,
	});
	controller.observe(memoryFailure);
	// A provider-retry budget of 1 would once have capped this at a single prune.
	for (let attempt = 1; attempt <= 3; attempt++) {
		const reduction = requireAction(controller, "reduce-and-retry");
		assert.equal(reduction.attempt, attempt);
		startAction(controller, reduction);
		controller.observe({ type: "action-finished", actionId: reduction.id, outcome: "failed" });
	}
	assert.match(requireAction(controller, "notify-terminal").reason, /after 3 prune attempts/);
});

test("the prune budget bounds pruning even when provider retries are unlimited", () => {
	const { controller } = recoveryChainHarness({
		forcedCompactionAttempts: 0,
		maxPruningAttempts: 2,
		maxProviderRetryAttempts: Number.POSITIVE_INFINITY,
	});
	controller.observe(memoryFailure);
	for (let attempt = 1; attempt <= 2; attempt++) {
		const reduction = requireAction(controller, "reduce-and-retry");
		assert.equal(reduction.attempt, attempt);
		startAction(controller, reduction);
		controller.observe({ type: "action-finished", actionId: reduction.id, outcome: "failed" });
	}
	assert.match(requireAction(controller, "notify-terminal").reason, /after 2 prune attempts/);
});

test("provider retry attempt numbers span continuation and reduction actions", () => {
	const { controller } = recoveryChainHarness({ maxProviderRetryAttempts: 2 });
	controller.observe(memoryFailure);
	const compaction = requireAction(controller, "request-compaction");
	startAction(controller, compaction);
	controller.observe({
		type: "compaction-started",
		owner: "ppie-recover",
		requestId: compaction.id,
		lifecycleEpoch: 1,
	});
	controller.observe({
		type: "compaction-finished",
		owner: "ppie-recover",
		requestId: compaction.id,
		lifecycleEpoch: 1,
		outcome: "completed",
		continuationOwner: "ppie-recover",
	});
	const continuation = requireAction(controller, "continue-provider");
	assert.equal(continuation.attempt, 1);
	startAction(controller, continuation);
	controller.observe({ type: "action-finished", actionId: continuation.id, outcome: "failed" });
	// Each domain numbers its own attempts, so the first prune is prune attempt 1
	// rather than a continuation of the provider-retry sequence.
	assert.equal(requireAction(controller, "reduce-and-retry").attempt, 1);
	assert.equal(controller.snapshot()?.providerRetryAttempts, 1, "pruning does not draw down provider retries");
});

test("terminal notification success and failure both close the chain", () => {
	for (const outcome of ["succeeded", "failed"] as const) {
		const { controller, telemetry } = reachReduction(1);
		const reduction = requireAction(controller, "reduce-and-retry");
		startAction(controller, reduction);
		controller.observe({ type: "action-finished", actionId: reduction.id, outcome: "failed" });
		const terminal = requireAction(controller, "notify-terminal");
		startAction(controller, terminal);
		controller.observe({ type: "action-finished", actionId: terminal.id, outcome });

		assert.equal(controller.snapshot(), undefined);
		assert.equal(telemetry.find((event) => event.type === "chain-closed")?.reason, "terminal-notified");
	}
});

test("duplicate continuation demand ids are absorbed", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	for (let i = 0; i < 3; i++) {
		controller.observe({
			type: "continuation-observed",
			source: "external-extension",
			demandId: "goal-1",
		});
	}
	assert.deepEqual(controller.snapshot()?.pendingDemandIds, ["goal-1"]);
});

test("snapshots are frozen defensive values", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const before = controller.snapshot();
	assert(before);
	assert(Object.isFrozen(before));
	assert(Object.isFrozen(before.pendingDemandIds));
	assert(Object.isFrozen(before.compactionAttempts));

	controller.observe({
		type: "continuation-observed",
		source: "agent-steer",
		demandId: "human-1",
	});
	assert.deepEqual(before.pendingDemandIds, []);
	assert.deepEqual(controller.snapshot()?.pendingDemandIds, ["human-1"]);
});

test("snapshot owns the active failure class and signature", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);

	assert.deepEqual(controller.snapshot()?.activeFailure, {
		failureClass: "memory-guard",
		signature: "memory",
	});
});

test("action telemetry contains identity, kind, trigger, attempt, and outcome", () => {
	const { controller, telemetry } = recoveryChainHarness({ forcedCompactionAttempts: 0 });
	controller.observe(memoryFailure);
	const reduction = requireAction(controller, "reduce-and-retry");
	startAction(controller, reduction);
	controller.observe({ type: "action-finished", actionId: reduction.id, outcome: "succeeded" });

	const admitted = telemetry.find((event) => event.type === "action-admitted");
	assert.deepEqual(
		admitted && {
			actionId: admitted.actionId,
			kind: admitted.kind,
			trigger: admitted.trigger,
			attempt: admitted.attempt,
		},
		{
			actionId: reduction.id,
			kind: "reduce-and-retry",
			trigger: "memory-guard",
			attempt: 1,
		},
	);
	assert.equal(telemetry.find((event) => event.type === "action-finished")?.outcome, "succeeded");
});

test("request action failure without lifecycle evidence consumes one compaction attempt", () => {
	const { controller } = recoveryChainHarness({ forcedCompactionAttempts: 1 });
	controller.observe(memoryFailure);
	const request = requireAction(controller, "request-compaction");
	startAction(controller, request);
	controller.observe({ type: "action-finished", actionId: request.id, outcome: "failed" });

	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 1);
	assert.equal(requireAction(controller, "reduce-and-retry").attempt, 1);
});

test("a terminal action is admitted once while repeated failures arrive", () => {
	const { controller } = reachReduction(1);
	const reduction = requireAction(controller, "reduce-and-retry");
	startAction(controller, reduction);
	controller.observe({ type: "action-finished", actionId: reduction.id, outcome: "failed" });
	const terminal = requireAction(controller, "notify-terminal");
	controller.observe(memoryFailure);
	controller.observe(memoryFailure);
	assert.equal(controller.nextAction()?.id, terminal.id);
});
