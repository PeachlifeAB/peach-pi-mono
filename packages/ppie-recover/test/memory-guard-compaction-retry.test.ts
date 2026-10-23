import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionOutcome } from "../src/compact.ts";
import { createCompactionCoordinator } from "../src/compaction-coordinator.ts";
import { createErrorRuleEngine } from "../src/error-rule-engine.ts";
import { createOverflowRecovery } from "../src/overflow-recovery.ts";
import { createRecoveryChainController } from "../src/recovery-chain.ts";
import { createRecoveryChainDriver } from "../src/recovery-chain-driver.ts";
import type { PrunePriorities } from "../src/retry-config.ts";
import { enabledOverflowPolicy } from "./fakes/retry-policy.ts";

// Fake defer scheduler — mirrors test/compaction-coordinator.test.ts's harness.
// NO real timers: callbacks are recorded with their requested delay and only
// fire when the test explicitly runs them via runDelay/runDeferred.
function fakeScheduler() {
	const callbacks: Array<{
		active: boolean;
		delayMs: number;
		callback: () => void;
	}> = [];
	const defer = (delayMs: number, callback: () => void) => {
		const task = { active: true, delayMs, callback };
		callbacks.push(task);
		return () => {
			task.active = false;
		};
	};
	const runDelay = (delayMs?: number) => {
		const active = callbacks.filter((task) => task.active);
		const selectedDelay = delayMs ?? Math.min(...active.map((task) => task.delayMs));
		const selected = callbacks.filter((task) => task.active && task.delayMs === selectedDelay);
		for (const task of selected) {
			task.active = false;
			task.callback();
		}
	};
	return {
		defer,
		callbacks,
		runDeferred: () => runDelay(),
		runDelay,
		pendingDelays: () => callbacks.filter((t) => t.active).map((t) => t.delayMs),
	};
}

// Every policy number in this file comes from a resolved config, the same
// wiring retry.ts uses in production: delays from the error-rule engine over
// policy.errorRules, compaction budget and unavailable-action from the
// compiled memory_overflow_protection knobs. No hardcoded "compact twice" literals.
const POLICY = enabledOverflowPolicy();
const MEMORY_GUARD_MESSAGE =
	"400 prefill_memory_exceeded: estimated bytes 54.92 GB exceeds metal_cap 51.34 GB resident memory";
const overflowEngine = createErrorRuleEngine(POLICY.errorRules);
const FIRST_OVERFLOW_RETRY_DELAY_MS = overflowEngine.delayMsFor(MEMORY_GUARD_MESSAGE, 1);
const SECOND_OVERFLOW_RETRY_DELAY_MS = overflowEngine.delayMsFor(MEMORY_GUARD_MESSAGE, 2);
const TRIM = POLICY.trimPayloadOnMemoryOverflow;
const PRUNE_PRIORITIES: PrunePriorities =
	TRIM === false
		? { marker: 0, tool: 0, assistant: 0, oldUser: 0, other: 0, system: 0, latestUser: 0 }
		: {
				marker: TRIM.target_priorities.marked_blocks,
				tool: TRIM.target_priorities.tool_results,
				assistant: TRIM.target_priorities.assistant_turns,
				oldUser: 0,
				other: 0,
				system: 0,
				latestUser: 0,
			};

// The coordinator chains multiple 0ms-delay defers around a single async
// compact() call (start recheck -> fallback compact -> unavailable
// recheck). Drain all pending 0ms tasks, yielding a microtask turn between
// each drain so compact()'s promise settles before the next defer fires.
async function settleZeroDelayChain(scheduler: {
	pendingDelays: () => number[];
	runDelay: (delayMs?: number) => void;
}) {
	for (let guard = 0; guard < 20; guard++) {
		await Promise.resolve();
		await Promise.resolve();
		if (!scheduler.pendingDelays().includes(0)) return;
		scheduler.runDelay(0);
	}
}

function buildHarness(compactImpl: () => Promise<CompactionOutcome>) {
	const scheduler = fakeScheduler();
	const coordinator = createCompactionCoordinator({ defer: scheduler.defer });
	const notifications: Array<{ message: string; level?: string }> = [];
	const terminals: string[] = [];
	let retryCount = 0;
	let nextChainId = 0;
	const recoveryChainDriver = createRecoveryChainDriver(
		createRecoveryChainController({
			generation: "test-generation",
			policy: {
				forcedCompactionAttempts: POLICY.fallbackCompactionMaxAttempts,
				maxPruningAttempts: POLICY.maxPruningAttempts,
				maxProviderRetryAttempts: () => POLICY.maximumAttempts,
			},
			delayMsForCompactionAttempt: (_trigger, attempt, failureMessage) =>
				overflowEngine.delayMsFor(failureMessage, attempt),
			nextChainId: () => `test-chain-${++nextChainId}`,
		}),
	);
	const recovery = createOverflowRecovery({
		getReserveTokens: () => (TRIM === false ? 0 : TRIM.extra_overage_tokens),
		getPriorities: () => PRUNE_PRIORITIES,
		getMarkers: () => (TRIM === false ? [] : [...TRIM.block_markers]),
		setStatus: () => {},
		notify: (message, level) => notifications.push({ message, level }),
		terminal: (_ctx, message) => terminals.push(message),
		compact: compactImpl,
		coordinator,
		getFallbackCompactionMaxAttempts: () => POLICY.fallbackCompactionMaxAttempts,
		getCompactionWarningMs: () => POLICY.compactionWarningMs,
		getCompactionStallCheckMs: () => POLICY.compactionStallCheckMs,
		getCompactionStallRetryMs: () => POLICY.compactionStallRetryMs,
		recoveryChainDriver,
		isCurrent: () => true,
	});
	const ctx = {} as ExtensionContext;
	const errorMessage = MEMORY_GUARD_MESSAGE;
	const triggerMemoryGuard = () => {
		recovery.classifyAndTrack(errorMessage);
		recovery.recoverMemoryGuard(ctx, {
			onRetry: () => {
				retryCount++;
			},
		});
	};
	return {
		recovery,
		coordinator,
		scheduler,
		notifications,
		terminals,
		triggerMemoryGuard,
		getRetryCount: () => retryCount,
	};
}

test("first failed compaction schedules a second attempt at the configured delay, with no prune yet", async () => {
	let compactCalls = 0;
	const h = buildHarness(async () => {
		compactCalls++;
		return { kind: "failed", error: new Error("compaction backend exploded") };
	});

	h.triggerMemoryGuard();
	h.coordinator.onAgentSettled();
	assert.deepEqual(
		h.scheduler.pendingDelays().filter((delay) => delay !== POLICY.compactionStallCheckMs),
		[FIRST_OVERFLOW_RETRY_DELAY_MS],
	);
	h.scheduler.runDelay(FIRST_OVERFLOW_RETRY_DELAY_MS);
	await settleZeroDelayChain(h.scheduler);

	assert.equal(compactCalls, 1, "exactly one compaction attempt so far");
	assert.equal(h.getRetryCount(), 0, "must NOT prune-and-retry yet after only one failed attempt");

	const pendingDelays = h.scheduler.pendingDelays();
	assert.ok(
		pendingDelays.includes(SECOND_OVERFLOW_RETRY_DELAY_MS),
		`expected a scheduled second compaction attempt at ${SECOND_OVERFLOW_RETRY_DELAY_MS}ms among pending delays: ${JSON.stringify(pendingDelays)}`,
	);

	// The second attempt waits on the same selected geometric retry curve, then
	// failure becomes immediately available to the reduction action.
	h.scheduler.runDelay(SECOND_OVERFLOW_RETRY_DELAY_MS);
	await settleZeroDelayChain(h.scheduler);

	assert.equal(compactCalls, 2, "a second compaction attempt must have run");
	assert.equal(h.getRetryCount(), 1, "only after the SECOND attempt also fails may emergency prune + retry run");
});

test("a re-entrant memory_guard error while attempt 2 is already scheduled must be absorbed, not prune underneath the pending compaction", async () => {
	// User-reported live incident (session 019f713c): after "scheduling
	// attempt 2/2 in 480s", the in-flight provider retry failed AGAIN with a
	// memory_guard before the deferred second compaction could fire. That
	// re-entered recoverMemoryGuard, saw attempts already at max, and
	// emergency-pruned — so the scheduled second compaction was outrun and
	// never observed. Contract: while a memory-guard compaction attempt is
	// still pending/scheduled, a fresh identical memory_guard is ABSORBED
	// (compaction is already coming); no prune, no duplicate attempt.
	let compactCalls = 0;
	const h = buildHarness(async () => {
		compactCalls++;
		return { kind: "failed", error: new Error("compaction backend exploded") };
	});

	// Attempt 1 fails → attempt 2 is scheduled at the configured delay.
	h.triggerMemoryGuard();
	h.coordinator.onAgentSettled();
	h.scheduler.runDelay(FIRST_OVERFLOW_RETRY_DELAY_MS);
	await settleZeroDelayChain(h.scheduler);
	assert.equal(compactCalls, 1, "attempt 1 ran");
	assert.equal(h.getRetryCount(), 0, "no prune after only attempt 1");
	assert.ok(
		h.scheduler.pendingDelays().includes(SECOND_OVERFLOW_RETRY_DELAY_MS),
		"attempt 2 must be scheduled at the configured delay",
	);

	// A re-entrant memory_guard arrives BEFORE the deferred attempt 2 fires.
	h.triggerMemoryGuard();

	assert.equal(
		h.getRetryCount(),
		0,
		"re-entrant memory_guard must NOT emergency-prune while attempt 2 is still pending",
	);
	assert.equal(compactCalls, 1, "re-entrant memory_guard must NOT start a duplicate compaction attempt");
	assert.ok(
		h.scheduler.pendingDelays().includes(SECOND_OVERFLOW_RETRY_DELAY_MS),
		"the originally-scheduled attempt 2 must still be pending after absorption",
	);

	// The originally-scheduled second attempt still fires and drives the chain.
	h.scheduler.runDelay(SECOND_OVERFLOW_RETRY_DELAY_MS);
	await settleZeroDelayChain(h.scheduler);
	assert.equal(compactCalls, 2, "the deferred second compaction still ran");
	assert.equal(h.getRetryCount(), 1, "only after the second attempt also fails may emergency prune run");
});

test("core compaction resolving the memory-guard window must not leave a stale pending flag that cancels a later foreign request", () => {
	const h = buildHarness(async () => ({
		kind: "failed",
		error: new Error("compaction backend exploded"),
	}));

	h.triggerMemoryGuard();
	// Core's own compaction runs during the awaiting-core-start window and
	// completes: the coordinator releases the memory-guard request via
	// onCoreContinuation — no memory-guard request is outstanding anymore.
	h.coordinator.onSessionBeforeCompact({});
	h.coordinator.onSessionCompact({ willRetry: false });

	// A different owner now takes the coordinator.
	let foreignCancelled = false;
	const result = h.coordinator.request({
		owner: "context-overflow",
		label: "foreign request",
		startWhen: "after-agent-settled",
		recheckDelayMs: 0,
		compactionWarningMs: undefined,
		stallCheckMs: POLICY.compactionStallCheckMs,
		stallRetryMs: POLICY.compactionStallRetryMs,
		isCurrent: () => true,
		compact: async () => ({ kind: "completed" }),
		onCallerContinuation: () => {},
		onCoreContinuation: () => {},
		onUnavailable: () => {},
		onLifecyclePending: () => {},
		onDiagnostic: () => {},
		onStalled: () => {},
		onCancelled: () => {
			foreignCancelled = true;
		},
	});
	assert.equal(result, "accepted");

	// Provider progress after the core compaction already closed the
	// memory-guard chain: it must reset the counter but must NOT cancel the
	// foreign owner's outstanding request through a stale pending flag.
	h.recovery.onProviderProgress();
	assert.equal(
		foreignCancelled,
		false,
		"stale memory-guard pending flag cancelled an unrelated owner's coordinator request",
	);
});

test("onProviderProgress resets the attempt counter so the next memory_guard starts fresh at attempt 1", async () => {
	let compactCalls = 0;
	const h = buildHarness(async () => {
		compactCalls++;
		return { kind: "failed", error: new Error("compaction backend exploded") };
	});

	h.triggerMemoryGuard();
	h.coordinator.onAgentSettled();
	h.scheduler.runDelay(FIRST_OVERFLOW_RETRY_DELAY_MS);
	await settleZeroDelayChain(h.scheduler);
	assert.equal(compactCalls, 1);
	assert.equal(h.getRetryCount(), 0, "still on attempt 1, no prune yet");

	// A successful provider turn arrives before the deferred retry fires.
	h.recovery.onProviderProgress();

	// A brand-new memory_guard now must start over at attempt 1 (immediate
	// after-agent-settled compaction), not skip straight to prune.
	h.triggerMemoryGuard();
	h.coordinator.onAgentSettled();
	h.scheduler.runDelay(FIRST_OVERFLOW_RETRY_DELAY_MS);
	await settleZeroDelayChain(h.scheduler);

	assert.equal(compactCalls, 2, "reset counter means this is treated as a fresh attempt 1, not attempt 2");
	assert.equal(h.getRetryCount(), 0, "a fresh attempt 1 failure must not prune immediately either");
});

test("a memory_guard arriving while another owner holds the coordinator must not leave the pending flag stuck true", async () => {
	// ChatGPT review finding: memoryGuardCompactionPending used to be set
	// optimistically BEFORE coordinator.request(). If a different owner (a
	// context-overflow compaction) already holds the coordinator, the
	// memory-guard request comes back "already-pending" and none of the
	// per-request callbacks fire — so the flag would stay true forever,
	// suppressing every future memory-guard recovery (via the re-entrancy
	// guard) and letting onProviderProgress.cancel() tear down the unrelated
	// owner's request. Contract: the flag is owned only when the memory-guard
	// request is actually "accepted".
	const h = buildHarness(async () => ({ kind: "completed" }));

	// A foreign context-overflow owner takes the coordinator first and keeps
	// it (its start recheck is deferred, so the request stays valid/active).
	let foreignCancelled = false;
	const foreign = h.coordinator.request({
		owner: "context-overflow",
		label: "foreign overflow",
		startWhen: "defer-now",
		recheckDelayMs: 60_000,
		compactionWarningMs: undefined,
		stallCheckMs: POLICY.compactionStallCheckMs,
		stallRetryMs: POLICY.compactionStallRetryMs,
		isCurrent: () => true,
		compact: async () => ({ kind: "completed" }),
		onCallerContinuation: () => {},
		onCoreContinuation: () => {},
		onUnavailable: () => {},
		onLifecyclePending: () => {},
		onDiagnostic: () => {},
		onStalled: () => {},
		onCancelled: () => {
			foreignCancelled = true;
		},
	});
	assert.equal(foreign, "accepted");

	// A memory_guard now fires. Its coordinator request is "already-pending"
	// (the foreign owner still holds it), so no memory-guard compaction is
	// owned. The pending flag must NOT stick true.
	h.triggerMemoryGuard();

	// Provider progress must reset counters but must NOT cancel the foreign
	// owner's outstanding request through a stale memory-guard pending flag.
	h.recovery.onProviderProgress();
	assert.equal(foreignCancelled, false, "a stale memory-guard pending flag cancelled an unrelated owner's request");
});

test("an already-pending rejection does not burn a memory-guard attempt", async () => {
	// Counter-burn regression: recoverMemoryGuard must increment its attempt
	// counter only when the coordinator actually accepts the request. If a
	// foreign owner holds the coordinator, the memory-guard request comes back
	// "already-pending" — no compaction runs — and the attempt must NOT be
	// consumed, otherwise two such rejections would emergency-prune having
	// never compacted once.
	let compactCalls = 0;
	const h = buildHarness(async () => {
		compactCalls++;
		return { kind: "failed", error: new Error("compaction backend exploded") };
	});

	// Foreign owner holds the coordinator across two memory_guard arrivals.
	const foreign = () =>
		h.coordinator.request({
			owner: "context-overflow",
			label: "foreign overflow",
			startWhen: "defer-now",
			recheckDelayMs: 60_000,
			compactionWarningMs: undefined,
			stallCheckMs: POLICY.compactionStallCheckMs,
			stallRetryMs: POLICY.compactionStallRetryMs,
			isCurrent: () => true,
			compact: async () => ({ kind: "completed" }),
			onCallerContinuation: () => {},
			onCoreContinuation: () => {},
			onUnavailable: () => {},
			onLifecyclePending: () => {},
			onDiagnostic: () => {},
			onStalled: () => {},
			onCancelled: () => {},
		});
	assert.equal(foreign(), "accepted");

	// Two memory_guards arrive while the foreign owner blocks them. If either
	// burned an attempt, the counter would reach the max of 2.
	h.triggerMemoryGuard();
	h.triggerMemoryGuard();
	assert.equal(compactCalls, 0, "no memory-guard compaction ran while blocked");
	assert.equal(h.getRetryCount(), 0, "no prune while blocked");

	// Free the coordinator: a fresh memory_guard must now run as attempt 1 —
	// its compaction actually starts — proving no attempt was burned.
	h.coordinator.cancel();
	h.triggerMemoryGuard();
	h.coordinator.onAgentSettled();
	h.scheduler.runDelay(FIRST_OVERFLOW_RETRY_DELAY_MS);
	await settleZeroDelayChain(h.scheduler);
	assert.equal(
		compactCalls,
		1,
		"the fresh memory_guard ran as attempt 1 (compaction started), so no attempt was burned by the rejections",
	);
	assert.equal(h.getRetryCount(), 0, "attempt 1 alone must not prune");
});
