import { strict as assert } from "node:assert";
import test from "node:test";
import { createRecoveryChainController, type RecoveryChainPolicy } from "../src/recovery-chain.ts";
import { createRecoveryChainDriver, type RecoveryChainExecutionPort } from "../src/recovery-chain-driver.ts";

const policy: RecoveryChainPolicy = {
	forcedCompactionAttempts: 2,
	maxPruningAttempts: 1,
	maxProviderRetryAttempts: () => 4,
};

function harness() {
	const controller = createRecoveryChainController({
		generation: "generation-1",
		policy,
		delayMsForCompactionAttempt: () => 0,
		nextChainId: () => "chain-1",
	});
	return { controller, driver: createRecoveryChainDriver(controller) };
}

function rejectingPort(calls: string[]): RecoveryChainExecutionPort {
	return {
		requestCompaction: (action) => {
			calls.push(action.id);
			return "not-accepted";
		},
		continueProvider: () => {},
		reduceAndRetry: () => {},
		notifyTerminal: () => {},
	};
}

test("a rejected compaction request remains admitted without burning its attempt", () => {
	const { controller, driver } = harness();
	const calls: string[] = [];
	const port = rejectingPort(calls);

	driver.recover("memory-guard", "memory-signature", port);
	const stillAdmitted = controller.nextAction();
	assert.equal(stillAdmitted?.kind, "request-compaction");
	assert.equal(stillAdmitted?.attempt, 1);
	assert.equal(controller.snapshot()?.compactionAttempts.memoryGuard, 0);

	driver.recover("memory-guard", "memory-signature", port);
	assert.deepEqual(calls, ["chain-1:action-1", "chain-1:action-1"]);
});
