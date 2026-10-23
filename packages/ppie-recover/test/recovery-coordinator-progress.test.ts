import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { type CompactionRequest, createCompactionCoordinator } from "../src/compaction-coordinator.ts";
import type { CompactionRequestOwner } from "../src/coordinator-telemetry.ts";

function harness(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const calls: string[] = [];
	const coordinator = createCompactionCoordinator({
		defer: (delayMs, callback) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	});
	const request = (owner: CompactionRequestOwner): CompactionRequest => ({
		owner,
		label: owner,
		startWhen: "after-agent-settled",
		startDelayMs: 16_000,
		recheckDelayMs: 0,
		compactionWarningMs: undefined,
		stallCheckMs: 180_000,
		stallRetryMs: 120_000,
		isCurrent: () => true,
		onCompactionStarted: () => calls.push(`started:${owner}`),
		onCallerContinuation: () => calls.push(`caller:${owner}`),
		onCoreContinuation: () => calls.push(`core:${owner}`),
		onUnavailable: () => calls.push(`unavailable:${owner}`),
		onLifecyclePending: () => calls.push(`pending:${owner}`),
		onDiagnostic: () => calls.push(`diagnostic:${owner}`),
		onStalled: () => calls.push(`stalled:${owner}`),
		onCancelled: () => calls.push(`cancelled:${owner}`),
		onEnded: () => calls.push(`ended:${owner}`),
	});
	return { coordinator, calls, request };
}

for (const owner of ["context-overflow", "length-overflow", "memory-guard"] as const) {
	test(`progress retires ${owner} without releasing an active host compaction`, (t) => {
		const h = harness(t);
		h.coordinator.request(h.request(owner));
		h.coordinator.onSessionBeforeCompact({ signal: new AbortController().signal });
		h.coordinator.onProviderProgress();
		h.coordinator.onProviderProgress();
		t.mock.timers.tick(700_000);
		assert.equal(h.coordinator.hasActiveRequest(), false);
		assert.deepEqual(h.calls, [`started:${owner}`, `ended:${owner}`, `cancelled:${owner}`]);
		h.coordinator.request(h.request("dynamic"));
		assert.equal(h.coordinator.phase(), "observed-compacting");
		h.coordinator.cancel();
	});
}

test("progress preserves independently owned dynamic compaction", (t) => {
	const h = harness(t);
	h.coordinator.request(h.request("dynamic"));
	h.coordinator.onSessionBeforeCompact({ signal: new AbortController().signal });
	h.coordinator.onProviderProgress();
	assert.equal(h.coordinator.phase(), "observed-compacting");
	assert.deepEqual(h.calls, ["started:dynamic"]);
	h.coordinator.cancel();
});

test("a coalesced recovery owns the compaction-start callback and both end cleanups", (t) => {
	const h = harness(t);
	h.coordinator.request(h.request("dynamic"));
	h.coordinator.request(h.request("length-overflow"));
	h.coordinator.onSessionBeforeCompact({ signal: new AbortController().signal });
	h.coordinator.onProviderProgress();
	assert.equal(h.coordinator.hasActiveRequest(), false);
	assert.deepEqual(h.calls, [
		"started:length-overflow",
		"ended:dynamic",
		"ended:length-overflow",
		"cancelled:length-overflow",
	]);
});
