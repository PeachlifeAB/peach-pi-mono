import { strict as assert } from "node:assert";
import test from "node:test";
import { failCompaction, recoveryChainHarness, requireAction, startAction } from "./fakes/recovery-chain-harness.ts";

const memoryFailure = {
	type: "failure-observed" as const,
	failureClass: "memory-guard" as const,
	signature: "prefill-memory-exceeded",
};

function exhaustCompactions() {
	const harness = recoveryChainHarness({ maxProviderRetryAttempts: 1 });
	const { controller } = harness;
	controller.observe(memoryFailure);
	const first = requireAction(controller, "request-compaction");
	startAction(controller, first);
	failCompaction(controller, { owner: "ppie-recover", requestId: first.id, lifecycleEpoch: 1 });
	const second = requireAction(controller, "request-compaction");
	startAction(controller, second);
	failCompaction(controller, { owner: "ppie-recover", requestId: second.id, lifecycleEpoch: 2 });
	return harness;
}

test("a foreign continuation is demand, not progress, and ppie-recover never owns its text", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const admitted = controller.nextAction();

	controller.observe({
		type: "continuation-observed",
		source: "external-extension",
		demandId: "goal-continuation-1",
	});

	assert.equal(controller.snapshot()?.id, "chain-1");
	assert.deepEqual(controller.snapshot()?.pendingDemandIds, ["goal-continuation-1"]);
	assert.equal(controller.nextAction()?.id, admitted?.id, "continuation must not reset recovery");
	assert.equal(
		JSON.stringify(controller.snapshot()).includes("messageText"),
		false,
		"chain state must never take custody of message text",
	);
});

test("an Agent-steered human continuation is observed without becoming extension custody", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	controller.observe({
		type: "continuation-observed",
		source: "agent-steer",
		demandId: "human-steer-1",
	});

	assert.deepEqual(controller.snapshot()?.pendingDemandIds, ["human-steer-1"]);
	assert.equal(controller.snapshot()?.status, "recovering");
});

test("error or aborted progress never closes or resets an active chain", () => {
	for (const stopReason of ["error", "aborted"] as const) {
		const { controller } = recoveryChainHarness();
		controller.observe(memoryFailure);
		controller.observe({
			type: "provider-progress",
			stopReason,
			hasError: stopReason === "error",
		});
		assert.equal(controller.snapshot()?.id, "chain-1", `${stopReason} must retain the chain`);
	}
});

test("verified clean stop progress closes the chain", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const staleAction = controller.nextAction();
	controller.observe({
		type: "provider-progress",
		stopReason: "stop",
		hasError: false,
	});

	assert.equal(controller.snapshot(), undefined);
	assert.equal(controller.nextAction(), undefined);
	controller.observe({ type: "action-started", actionId: staleAction?.id ?? "missing" });
	assert.equal(controller.snapshot(), undefined, "stale action callback must not reopen the chain");
});

test("verified toolUse progress closes the chain exactly like stop", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	controller.observe({
		type: "provider-progress",
		stopReason: "toolUse",
		hasError: false,
	});
	assert.equal(controller.snapshot(), undefined);
});

test("prune-budget exhaustion admits one visible terminal action", () => {
	const { controller } = exhaustCompactions();
	const reduction = requireAction(controller, "reduce-and-retry");
	startAction(controller, reduction);
	controller.observe({ type: "action-finished", actionId: reduction.id, outcome: "failed" });
	controller.observe(memoryFailure);

	const terminal = requireAction(controller, "notify-terminal");
	assert.match(terminal.reason, /prune attempts/i);
	controller.observe(memoryFailure);
	assert.equal(controller.nextAction()?.id, terminal.id, "terminal notice must not multiply");
});

test("explicit cancellation invalidates every admitted action and closes the chain", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const stale = requireAction(controller, "request-compaction");
	controller.observe({ type: "cancelled", reason: "user-abort" });

	assert.equal(controller.snapshot(), undefined);
	assert.equal(controller.nextAction(), undefined);
	controller.observe({ type: "action-started", actionId: stale.id });
	assert.equal(controller.snapshot(), undefined);
});

test("session generation change invalidates the old chain and gives the next failure a new id", () => {
	const { controller } = recoveryChainHarness();
	controller.observe(memoryFailure);
	const stale = requireAction(controller, "request-compaction");
	controller.observe({ type: "generation-changed", generation: "generation-2" });
	controller.observe({ type: "action-started", actionId: stale.id });
	assert.equal(controller.snapshot(), undefined);

	controller.observe(memoryFailure);
	assert.equal(controller.snapshot()?.id, "chain-2");
	assert.equal(controller.snapshot()?.generation, "generation-2");
});

test("telemetry correlates chain, generation, owner, request, epoch, attempt, and outcome", () => {
	const { controller, telemetry } = recoveryChainHarness();
	controller.observe(memoryFailure);
	failCompaction(controller, { owner: "external", requestId: "external-9", lifecycleEpoch: 12 });

	const finished = telemetry.find((event) => event.type === "compaction-finished");
	assert.deepEqual(
		finished && {
			chainId: finished.chainId,
			generation: finished.generation,
			owner: finished.owner,
			requestId: finished.requestId,
			lifecycleEpoch: finished.lifecycleEpoch,
			attempt: finished.attempt,
			outcome: finished.outcome,
		},
		{
			chainId: "chain-1",
			generation: "generation-1",
			owner: "external",
			requestId: "external-9",
			lifecycleEpoch: 12,
			attempt: 1,
			outcome: "unavailable",
		},
	);
});

test("telemetry distinguishes ppie-recover and observable external ownership", () => {
	for (const owner of ["ppie-recover", "external"] as const) {
		const { controller, telemetry } = recoveryChainHarness();
		controller.observe(memoryFailure);
		failCompaction(controller, { owner, requestId: `${owner}-1`, lifecycleEpoch: 1 });
		assert.equal(telemetry.find((event) => event.type === "compaction-finished")?.owner, owner);
	}
});
