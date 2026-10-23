import assert from "node:assert/strict";
import test from "node:test";
import { createCompactionCoordinator } from "../src/compaction-coordinator.ts";

function request(calls: string[], compact: () => Promise<{ kind: "completed" }>) {
	return {
		owner: "memory-guard" as const,
		label: "memory recovery",
		startWhen: "defer-now" as const,
		recheckDelayMs: 0,
		compactionWarningMs: undefined,
		stallCheckMs: 10,
		stallRetryMs: 20,
		isCurrent: () => true,
		compact,
		onCallerContinuation: () => calls.push("caller"),
		onCoreContinuation: () => calls.push("core"),
		onUnavailable: () => calls.push("unavailable"),
		onLifecyclePending: () => calls.push("pending"),
		onDiagnostic: () => {},
		onStalled: () => calls.push("stalled"),
		onCancelled: () => calls.push("cancelled"),
	};
}

test("stalled external lifecycle releases host ownership before the next request", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const coordinator = createCompactionCoordinator({
		defer: (delayMs, callback) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	});
	const firstCalls: string[] = [];
	coordinator.request(request(firstCalls, async () => ({ kind: "completed" })));
	coordinator.onSessionBeforeCompact();

	t.mock.timers.tick(10);
	t.mock.timers.tick(20);
	assert.deepEqual(firstCalls, ["stalled"]);

	let compactCalls = 0;
	const secondCalls: string[] = [];
	coordinator.request(
		request(secondCalls, async () => {
			compactCalls++;
			return { kind: "completed" };
		}),
	);
	t.mock.timers.tick(0);
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(compactCalls, 1, "the stale external host must not capture the next request");
	assert.deepEqual(secondCalls, ["pending"]);
});
