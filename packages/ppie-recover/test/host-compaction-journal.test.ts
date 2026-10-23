import assert from "node:assert/strict";
import test from "node:test";
import { createHostCompactionJournal } from "../src/host-compaction-journal.ts";
import type { CompactionIdentity } from "../src/recovery-chain.ts";
import { createRecoveryChainController } from "../src/recovery-chain.ts";
import { createRecoveryChainDriver } from "../src/recovery-chain-driver.ts";

test("a completed host compaction is claimed exactly once after recovery opens", () => {
	const journal = createHostCompactionJournal("generation-1");
	const observed: string[] = [];

	journal.started();
	journal.completed({ willRetry: false });

	journal.claim({
		started: (identity) => observed.push(`started:${identity.requestId}`),
		completed: (identity, owner) => observed.push(`completed:${identity.requestId}:${owner}`),
		failed: () => assert.fail("completed lifecycle must not replay as failed"),
	});
	journal.claim({
		started: () => assert.fail("claimed lifecycle must not replay twice"),
		completed: () => assert.fail("claimed lifecycle must not replay twice"),
		failed: () => assert.fail("claimed lifecycle must not replay twice"),
	});

	assert.deepEqual(observed, ["started:host-compaction-1", "completed:host-compaction-1:ppie-recover"]);
});

test("generation changes discard stale host compaction lifecycles", () => {
	const journal = createHostCompactionJournal("generation-1");
	let replayed: CompactionIdentity | undefined;

	journal.started();
	journal.completed({ willRetry: false });
	journal.changeGeneration("generation-2");
	journal.claim({
		started: (identity) => {
			replayed = identity;
		},
		completed: () => {},
		failed: () => {},
	});

	assert.equal(replayed, undefined);
});

test("recovery claims a completed host lifecycle before requesting another compaction", () => {
	const journal = createHostCompactionJournal("generation-1");
	journal.started();
	journal.completed({ willRetry: false });
	const controller = createRecoveryChainController({
		generation: "generation-1",
		policy: {
			forcedCompactionAttempts: 2,
			maxPruningAttempts: 1,
			maxProviderRetryAttempts: () => 5,
		},
		delayMsForCompactionAttempt: () => 0,
		nextChainId: () => "chain-1",
	});
	const driver = createRecoveryChainDriver(controller);
	let compactionRequests = 0;
	let continuations = 0;

	driver.recover(
		"memory-guard",
		"memory-guard-signature",
		{
			requestCompaction: () => {
				compactionRequests++;
				return "accepted";
			},
			continueProvider: () => {
				continuations++;
			},
			reduceAndRetry: () => assert.fail("completed compaction must not prune"),
			notifyTerminal: () => assert.fail("completed compaction must not terminate"),
		},
		(observer) => journal.claim(observer),
	);

	assert.equal(compactionRequests, 0);
	assert.equal(continuations, 1);
});
