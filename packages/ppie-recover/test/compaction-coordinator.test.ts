import assert from "node:assert/strict";
import test from "node:test";
import type { CompactionOutcome } from "../src/compact.ts";
import type { CompactionRequest, CoordinatorDispositionEvent } from "../src/compaction-coordinator.ts";
import { createCompactionCoordinator } from "../src/compaction-coordinator.ts";

// Hoists a promise's resolver so a test can settle it after asserting on the
// state observed while it was still pending. Replaces the inline
// `new Promise((r) => (capture = r))` form, which trips
// lint/suspicious/noAssignInExpressions.
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((set, brk) => {
		resolve = set;
		reject = brk;
	});
	return { promise, resolve, reject };
}
function harness(
	telemetry?: { onDisposition: (event: CoordinatorDispositionEvent) => void },
	waitForIdle?: () => Promise<void> | undefined,
) {
	const callbacks: Array<{
		active: boolean;
		delayMs: number;
		callback: () => void;
	}> = [];
	const coordinator = createCompactionCoordinator(
		{
			defer: (delayMs, callback) => {
				const task = { active: true, delayMs, callback };
				callbacks.push(task);
				return () => {
					task.active = false;
				};
			},
		},
		telemetry,
		waitForIdle,
	);
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
		coordinator,
		runDeferred: () => runDelay(),
		runDelay,
	};
}

function request(input: { compact?: () => Promise<CompactionOutcome>; current?: () => boolean; calls: string[] }) {
	return {
		owner: "context-overflow" as const,
		label: "test",
		startWhen: "after-agent-settled" as const,
		recheckDelayMs: 0,
		compactionWarningMs: undefined,
		stallCheckMs: 180_000,
		stallRetryMs: 480_000,
		isCurrent: input.current ?? (() => true),
		compact: input.compact ?? (async () => ({ kind: "completed" as const })),
		onCallerContinuation: () => input.calls.push("caller"),
		onCoreContinuation: () => input.calls.push("core"),
		onUnavailable: (outcome: { kind: string }) => input.calls.push(`unavailable:${outcome.kind}`),
		onLifecyclePending: (outcome: { kind: string }) => input.calls.push(`pending:${outcome.kind}`),
		onDiagnostic: (message: string) => input.calls.push(`diagnostic:${message}`),
		onStalled: () => input.calls.push("stalled"),
		onCancelled: () => input.calls.push("cancelled"),
	};
}

test("core starts before deferred recheck: no fallback compact, caller continues only on lifecycle", async () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	let compactCalls = 0;
	coordinator.request(
		request({
			calls,
			compact: async () => {
				compactCalls++;
				return { kind: "completed" };
			},
		}),
	);
	coordinator.onAgentSettled();
	coordinator.onSessionBeforeCompact();
	runDeferred();
	assert.equal(compactCalls, 0);
	assert.equal(coordinator.phase(), "observed-compacting");
	coordinator.onSessionCompact({ willRetry: false });
	assert.deepEqual(calls, ["caller"]);
});

test("dynamic intent promotes an already-pending recovery request", async () => {
	const { coordinator, runDeferred } = harness();
	const recovery = request({ calls: [] });
	const pending: CompactionRequest = { ...recovery, compact: undefined, startDelayMs: 20 };
	coordinator.request(pending);
	coordinator.onAgentSettled();

	let dynamicCompactions = 0;
	const dynamicCalls: string[] = [];
	const dynamic: CompactionRequest = {
		...request({
			calls: dynamicCalls,
			compact: async () => {
				dynamicCompactions++;
				coordinator.onSessionBeforeCompact();
				coordinator.onSessionCompact({ willRetry: false });
				return { kind: "completed" };
			},
		}),
		owner: "dynamic",
		startWhen: "defer-now",
		startDelayMs: 0,
	};
	assert.equal(coordinator.request(dynamic), "already-pending");

	runDeferred();
	await Promise.resolve();
	assert.equal(dynamicCompactions, 1);
	assert.equal(coordinator.phase(), "idle");
});

test("willRetry true gives core ownership and normal provider request releases state", () => {
	const { coordinator } = harness();
	const calls: string[] = [];
	coordinator.request(request({ calls }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: true });
	assert.deepEqual(calls, ["core"]);
	assert.equal(coordinator.phase(), "core-owns-continuation");
	coordinator.onBeforeProviderRequest({ isCompactionSummary: true });
	assert.equal(coordinator.phase(), "core-owns-continuation");
	coordinator.onBeforeProviderRequest({ isCompactionSummary: false });
	assert.equal(coordinator.phase(), "idle");
});

test("extension-owned fallback rejection releases its unmatched before-compact lifecycle and becomes unavailable", async () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	let finishCompact!: (outcome: CompactionOutcome) => void;
	const compactResult = new Promise<CompactionOutcome>((resolve) => {
		finishCompact = resolve;
	});
	coordinator.request(
		request({
			calls,
			compact: () => compactResult,
		}),
	);
	coordinator.onAgentSettled();
	runDeferred();

	// Real AgentSession.compact() emits session_before_compact before invoking
	// the summarizer. If summarization rejects, it does not emit session_compact
	// and it does not abort the before-compact signal.
	coordinator.onSessionBeforeCompact();
	finishCompact({ kind: "failed", error: new Error("summarization rejected") });
	await Promise.resolve();

	assert.deepEqual(calls, ["unavailable:failed"]);
	assert.equal(coordinator.phase(), "idle");
});

test("fallback Nothing to compact waits for fresh inactive recheck before unavailable action", async () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	coordinator.request(
		request({
			calls,
			compact: async () => ({
				kind: "nothing-to-compact",
				error: new Error("Nothing to compact"),
			}),
		}),
	);
	coordinator.onAgentSettled();
	runDeferred();
	await Promise.resolve();
	assert.equal(coordinator.phase(), "awaiting-unavailable-recheck");
	assert.deepEqual(calls, []);
	runDeferred();
	assert.deepEqual(calls, ["unavailable:nothing-to-compact"]);
});

test("Already compacted fails closed: lifecycle pending/warning only, no unavailable action", async () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	coordinator.request(
		request({
			calls,
			compact: async () => ({
				kind: "already-compacted",
				error: new Error("Already compacted"),
			}),
		}),
	);
	coordinator.onAgentSettled();
	runDeferred();
	await Promise.resolve();
	assert.equal(coordinator.phase(), "awaiting-lifecycle");
	assert.deepEqual(calls, ["pending:already-compacted"]);
	runDeferred();
	assert.deepEqual(calls, ["pending:already-compacted"]);
});

test("fallback-disabled requests continue the caller without requiring observed compaction", () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	coordinator.request({ ...request({ calls }), compact: undefined });
	coordinator.onAgentSettled();
	runDeferred();

	assert.deepEqual(calls, ["caller"]);
});

test("requests requiring observed compaction fail closed when no compact operation exists", () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	coordinator.request({ ...request({ calls }), compact: undefined, requiresObservedCompaction: true });
	coordinator.onAgentSettled();
	runDeferred();

	assert.deepEqual(calls, ["unavailable:not-authorized"]);
});

test("a rejected fallback compact reports unavailable after its deferred recheck", async () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	coordinator.request(
		request({
			calls,
			compact: async () => {
				throw new Error("compact failed");
			},
		}),
	);
	coordinator.onAgentSettled();
	runDeferred();
	await Promise.resolve();
	runDeferred();

	assert.deepEqual(calls, ["unavailable:failed"]);
});

test("stale callback cancels and cannot continue", () => {
	const { coordinator, runDeferred } = harness();
	let current = true;
	const calls: string[] = [];
	coordinator.request(request({ calls, current: () => current }));
	coordinator.onAgentSettled();
	current = false;
	runDeferred();
	assert.deepEqual(calls, ["cancelled"]);
	assert.equal(coordinator.phase(), "cancelled");
});

test("second request while one is active coalesces without cancelling the first", () => {
	const { coordinator } = harness();
	const calls: string[] = [];
	assert.equal(coordinator.request(request({ calls })), "accepted");
	assert.equal(coordinator.request(request({ calls })), "already-pending");
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	assert.deepEqual(calls, ["caller"]);
});
test("recovery continuation owns a coalesced dynamic intent", () => {
	const { coordinator } = harness();
	const dynamicCalls: string[] = [];
	const recoveryCalls: string[] = [];
	const dynamic = { ...request({ calls: dynamicCalls }), owner: "dynamic" as const };

	assert.equal(coordinator.request(dynamic), "accepted");
	assert.equal(coordinator.request(request({ calls: recoveryCalls })), "already-pending");
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });

	assert.deepEqual(dynamicCalls, []);
	assert.deepEqual(recoveryCalls, ["caller"]);
});

test("session_before_compact before a request is remembered and suppresses fallback", () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	let compactCalls = 0;
	coordinator.onSessionBeforeCompact();
	coordinator.request(
		request({
			calls,
			compact: async () => {
				compactCalls++;
				return { kind: "completed" };
			},
		}),
	);
	coordinator.onAgentSettled();
	runDeferred();
	assert.equal(compactCalls, 0);
	assert.equal(coordinator.phase(), "observed-compacting");
	coordinator.onSessionCompact({ willRetry: false });
	assert.deepEqual(calls, ["caller"]);
});

test("request abort immediately cancels active recovery", () => {
	const { coordinator } = harness();
	const calls: string[] = [];
	const aborter = new AbortController();
	coordinator.request({ ...request({ calls }), signal: aborter.signal });
	aborter.abort();
	assert.deepEqual(calls, ["cancelled"]);
	assert.equal(coordinator.phase(), "cancelled");
});

test("old lifecycle signal abort cannot affect a new request", () => {
	const { coordinator } = harness();
	const calls: string[] = [];
	const oldAborter = new AbortController();
	coordinator.onSessionBeforeCompact({ signal: oldAborter.signal });
	coordinator.onSessionCompact({ willRetry: false });
	coordinator.request(request({ calls }));
	oldAborter.abort();
	assert.deepEqual(calls, []);
	assert.equal(coordinator.phase(), "awaiting-core-start");
});

test("host compaction abort reports unavailable when lifecycle completion is missing", async () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	const aborter = new AbortController();
	let finishCompact!: (outcome: CompactionOutcome) => void;
	const compactResult = new Promise<CompactionOutcome>((resolve) => {
		finishCompact = resolve;
	});

	coordinator.request(request({ calls, compact: () => compactResult }));
	coordinator.onAgentSettled();
	runDeferred();
	coordinator.onSessionBeforeCompact({ signal: aborter.signal });
	aborter.abort();
	runDeferred();

	assert.deepEqual(calls, ["unavailable:failed"]);
	finishCompact({ kind: "failed", error: new Error("aborted") });
	await Promise.resolve();
});

test("invalid active request is cancelled and the next request is accepted", () => {
	const { coordinator } = harness();
	let firstCurrent = true;
	const firstCalls: string[] = [];
	const secondCalls: string[] = [];
	assert.equal(coordinator.request(request({ calls: firstCalls, current: () => firstCurrent })), "accepted");
	firstCurrent = false;
	assert.equal(coordinator.request(request({ calls: secondCalls })), "accepted");
	assert.deepEqual(firstCalls, ["cancelled"]);
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	assert.deepEqual(secondCalls, ["caller"]);
});

test("session_compact without matching lifecycle does not resume unrelated request", () => {
	const { coordinator } = harness();
	const calls: string[] = [];
	coordinator.request(request({ calls }));
	coordinator.onSessionCompact({ willRetry: false });
	assert.deepEqual(calls, []);
	assert.equal(coordinator.phase(), "awaiting-core-start");
});

test("willRetry true keeps diagnostic armed until normal provider request", () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	coordinator.request({ ...request({ calls }), compactionWarningMs: 0 });
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: true });
	runDeferred();
	assert(calls.some((call) => call.startsWith("diagnostic:")));
	coordinator.onBeforeProviderRequest({ isCompactionSummary: false });
	assert.equal(coordinator.phase(), "idle");
});

test("unchanged compaction state for 3 minutes then 8 minutes invokes last-resort stalled continuation", () => {
	const { coordinator, runDelay } = harness();
	const calls: string[] = [];
	coordinator.request(request({ calls }));

	runDelay(180_000);
	assert.deepEqual(calls, []);
	assert.equal(coordinator.phase(), "awaiting-core-start");

	runDelay(480_000);
	assert.deepEqual(calls, ["stalled"]);
	assert.equal(coordinator.phase(), "idle");
});

test("state change during the 8-minute step restarts the two-stage stall check", () => {
	const { coordinator, runDelay } = harness();
	const calls: string[] = [];
	coordinator.request(request({ calls }));

	runDelay(180_000);
	coordinator.onSessionBeforeCompact();

	// The old step-2 timer was cancelled by the exact coordinator state change.
	runDelay(480_000);
	assert.deepEqual(calls, []);

	// A fresh 3-minute + 8-minute unchanged interval is required.
	runDelay(180_000);
	runDelay(480_000);
	assert.deepEqual(calls, ["stalled"]);
});

test("normal compaction completion cancels both last-resort timer steps", () => {
	const { coordinator, runDelay } = harness();
	const calls: string[] = [];
	coordinator.request(request({ calls }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });

	runDelay(180_000);
	runDelay(480_000);
	assert.deepEqual(calls, ["caller"]);
});

test("fallback session_compact before compact callback still releases once", async () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	const pendingCompact = deferred<CompactionOutcome>();
	coordinator.request(
		request({
			calls,
			compact: () => pendingCompact.promise,
		}),
	);
	coordinator.onAgentSettled();
	runDeferred();
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	pendingCompact.resolve({ kind: "completed" });
	await Promise.resolve();
	assert.deepEqual(calls, ["caller"]);
});

test("fallback callback before session_compact waits for lifecycle", async () => {
	const { coordinator, runDeferred } = harness();
	const calls: string[] = [];
	coordinator.request(request({ calls, compact: async () => ({ kind: "completed" }) }));
	coordinator.onAgentSettled();
	runDeferred();
	await Promise.resolve();
	assert.deepEqual(calls, ["pending:completed"]);
	coordinator.onSessionCompact({ willRetry: false });
	assert.deepEqual(calls, ["pending:completed", "caller"]);
});

test("telemetry port observes caller-continuation disposition with owner and attempt", () => {
	const events: CoordinatorDispositionEvent[] = [];
	const { coordinator } = harness({ onDisposition: (event) => events.push(event) });
	const calls: string[] = [];
	coordinator.request(request({ calls }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	assert.deepEqual(calls, ["caller"]);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.owner, "context-overflow");
	assert.equal(events[0]?.attempt, 1);
	assert.equal(events[0]?.disposition, "caller-continuation");
});

test("telemetry port observes unavailable disposition with the outcome kind as reason", async () => {
	const events: CoordinatorDispositionEvent[] = [];
	const { coordinator, runDeferred } = harness({ onDisposition: (event) => events.push(event) });
	const calls: string[] = [];
	coordinator.request(
		request({
			calls,
			compact: async () => ({ kind: "nothing-to-compact", error: new Error("x") }),
		}),
	);
	coordinator.onAgentSettled();
	runDeferred();
	await Promise.resolve();
	runDeferred();
	assert.deepEqual(calls, ["unavailable:nothing-to-compact"]);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.disposition, "unavailable");
	assert.equal(events[0]?.reason, "nothing-to-compact");
});

test("telemetry port increments attempt per accepted request on repeated owner recovery", () => {
	const events: CoordinatorDispositionEvent[] = [];
	const { coordinator } = harness({ onDisposition: (event) => events.push(event) });
	const first: string[] = [];
	coordinator.request(request({ calls: first }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	const second: string[] = [];
	coordinator.request(request({ calls: second }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	assert.equal(events.length, 2);
	assert.equal(events[0]?.attempt, 1);
	assert.equal(events[1]?.attempt, 2);
});

test("a rejected-before-accept request does not consume an attempt for the next real request", () => {
	const events: CoordinatorDispositionEvent[] = [];
	const { coordinator } = harness({ onDisposition: (event) => events.push(event) });
	const rejected: string[] = [];
	coordinator.request(request({ calls: rejected, current: () => false }));
	assert.deepEqual(rejected, ["cancelled"]);
	const accepted: string[] = [];
	coordinator.request(request({ calls: accepted }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	assert.equal(events.length, 2);
	assert.equal(events[0]?.disposition, "cancelled");
	assert.equal(events[1]?.disposition, "caller-continuation");
	assert.equal(events[1]?.attempt, 1);
});

test("continuation defers until host idle readiness settles, then runs once", async () => {
	const gate = deferred<void>();
	const { coordinator } = harness(undefined, () => gate.promise);
	const calls: string[] = [];
	coordinator.request(request({ calls }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	assert.deepEqual(calls, []);
	assert.equal(coordinator.phase(), "awaiting-host-idle");
	gate.resolve(undefined);
	await gate.promise;
	assert.deepEqual(calls, ["caller"]);
	assert.equal(coordinator.phase(), "idle");
});

test("cancel while awaiting host idle never continues", async () => {
	const gate = deferred<void>();
	const { coordinator } = harness(undefined, () => gate.promise);
	const calls: string[] = [];
	coordinator.request(request({ calls }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	assert.equal(coordinator.phase(), "awaiting-host-idle");
	coordinator.cancel();
	assert.deepEqual(calls, ["cancelled"]);
	gate.resolve(undefined);
	await gate.promise;
	assert.deepEqual(calls, ["cancelled"]);
	assert.equal(coordinator.phase(), "cancelled");
});

test("host idle readiness failure reports unavailable", async () => {
	const gate = deferred<void>();
	const { coordinator } = harness(undefined, () => gate.promise);
	const calls: string[] = [];
	coordinator.request(request({ calls }));
	coordinator.onSessionBeforeCompact();
	coordinator.onSessionCompact({ willRetry: false });
	gate.reject(new Error("idle wait failed"));
	try {
		await gate.promise;
	} catch {
		// expected rejection; coordinator reports unavailable below
	}
	assert.deepEqual(calls, ["unavailable:failed"]);
	assert.equal(coordinator.phase(), "idle");
});
