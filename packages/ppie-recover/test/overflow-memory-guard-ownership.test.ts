import assert from "node:assert/strict";
import test from "node:test";
import { createHostCompactionJournal } from "../src/host-compaction-journal.ts";
import { createMemoryGuardRecovery } from "../src/overflow-memory-guard.ts";
import { createOverflowRecoveryState, type EmergencyPruner } from "../src/overflow-recovery-types.ts";
import { createRecoveryChainController } from "../src/recovery-chain.ts";
import type { RecoveryChainDriver } from "../src/recovery-chain-driver.ts";
import { createRecoveryChainDriver } from "../src/recovery-chain-driver.ts";

test("a stale coordinator continuation cannot fabricate ppie-recover ownership after host compaction", () => {
	const state = createOverflowRecoveryState();
	state.activeErrorSignature = "memory-guard";
	const journal = createHostCompactionJournal("generation-1");
	const driver = createRecoveryChainDriver(
		createRecoveryChainController({
			generation: "generation-1",
			// Test-scale policy: this file asserts ownership journaling, not the
			// shipped compaction budget (see memory-guard-compaction-retry.test.ts
			// for the config-derived compact-twice contract).
			policy: {
				forcedCompactionAttempts: 2,
				maxPruningAttempts: 1,
				maxProviderRetryAttempts: () => 5,
			},
			delayMsForCompactionAttempt: () => 0,
			nextChainId: () => "chain-1",
		}),
	);
	let coordinatorContinuation = (): void => {};
	let retries = 0;
	const recover = createMemoryGuardRecovery({
		state,
		pruner: { rememberOverflow: () => {} } as unknown as EmergencyPruner,
		driver,
		hostCompactionJournal: journal,
		awaitCompactionOrFallback: (_owner, _label, _ctx, options) => {
			coordinatorContinuation = options.onRetry;
			return "accepted";
		},
		finishObserved: () => {},
		failObserved: () => {},
		notify: () => {},
		terminal: () => {},
	});

	recover(undefined, { onRetry: () => retries++ });
	const identity = journal.started();
	journal.claim({
		started: driver.observeCompactionStarted,
		completed: driver.observeCompactionCompleted,
		failed: driver.observeCompactionFailure,
	});
	journal.completed({ willRetry: false });
	state.externalCompactionIdentity = undefined;
	coordinatorContinuation();

	assert.equal(identity.owner, "external");
	assert.equal(retries, 1);
});

test("a coordinator callback before own invocation cannot synthesize an owned start", () => {
	const state = createOverflowRecoveryState();
	let coordinatorContinuation = (): void => {};
	let ownedStarts = 0;
	const driver = {
		recover: (_failure, _signature, port) => {
			port.requestCompaction(
				{
					id: "chain-1:action-1",
					chainId: "chain-1",
					kind: "request-compaction",
					trigger: "memory-guard",
					attempt: 1,
					delayMs: 0,
				},
				{
					started: () => ownedStarts++,
					completed: () => {},
					failed: () => {},
				},
			);
		},
		observeCompactionStarted: () => {},
		observeCompactionCompleted: () => {},
		observeCompactionFailure: () => {},
		observeContinuation: () => {},
		observeProviderProgress: () => {},
		cancel: () => {},
		changeGeneration: () => {},
		isActive: () => true,
	} satisfies RecoveryChainDriver;
	const recover = createMemoryGuardRecovery({
		state,
		pruner: { rememberOverflow: () => {} } as unknown as EmergencyPruner,
		driver,
		awaitCompactionOrFallback: (_owner, _label, _ctx, options) => {
			coordinatorContinuation = options.onRetry;
			return "accepted";
		},
		finishObserved: () => {},
		failObserved: () => {},
		notify: () => {},
		terminal: () => {},
	});

	recover(undefined, { onRetry: () => {} });
	coordinatorContinuation();

	assert.equal(ownedStarts, 0);
});
