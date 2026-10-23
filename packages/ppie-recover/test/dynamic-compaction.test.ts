import assert from "node:assert/strict";
import test from "node:test";
import type { CompactionRequest } from "../src/compaction-coordinator.ts";
import {
	type DynamicCompactionDependencies,
	registerDynamicCompaction as registerDynamicCompactionProduction,
} from "../src/dynamic-compaction.ts";
import {
	ASSISTANT_AT,
	completedRun,
	registerDynamicCompactionForTest as registerDynamicCompaction,
	runLifecycle,
} from "./fakes/dynamic-compaction-lifecycle.ts";
import { asExtensionApi, asExtensionContext, CtxFakeCore, PiFakeCore } from "./fakes/pi-fakes.ts";

// Threshold and lifecycle behavior. Coordination with Pi-core's own compaction
// boundary lives in dynamic-compaction-boundary.test.ts.

test("compacts at the configured fraction of the active model context window", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 200_000;
	ctxCore.contextTokens = 160_000;
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore);

	assert.equal(ctxCore.compactions.length, 1);
});

test("enqueues ratio-triggered compaction through the shared coordinator", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 200_000;
	ctxCore.contextTokens = 160_000;
	const requests: CompactionRequest[] = [];
	const coordinator = {
		request(request: CompactionRequest) {
			requests.push(request);
			return "accepted" as const;
		},
	} as DynamicCompactionDependencies["coordinator"];
	registerDynamicCompactionProduction(asExtensionApi(piCore), 0.8, {
		coordinator,
		compact: async () => ({ kind: "completed" }),
		createRequestIsCurrent: () => () => true,
		compactionWarningMs: undefined,
		stallCheckMs: 100,
		stallRetryMs: 100,
	});

	runLifecycle(piCore, ctxCore);

	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.owner, "dynamic");
	assert.equal(requests[0]?.startWhen, "defer-now");
	assert.equal(ctxCore.compactions.length, 0, "the dynamic module does not bypass the coordinator");
});

test("uses the active model context window after a model switch", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	registerDynamicCompaction(piCore, 0.8);

	ctxCore.contextWindow = 128_000;
	ctxCore.contextTokens = 102_400;
	runLifecycle(piCore, ctxCore);

	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_599;
	runLifecycle(piCore, ctxCore);
	assert.equal(ctxCore.compactions.length, 1);

	ctxCore.contextTokens = 69_600;
	runLifecycle(piCore, ctxCore);
	assert.equal(ctxCore.compactions.length, 2);
});

// The reported failure (session 019fbdd1): compacting from an agent_end handler
// races Pi-core's own post-agent threshold compaction, because Pi awaits
// agent_end handlers BEFORE _handlePostAgentRun() runs its threshold check. The
// detached request then resolves against an already-compacted session and fails.
test("does not compact during agent_end, turn_end, or before a terminal assistant message", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	registerDynamicCompaction(piCore, 0.8);

	piCore.emit("turn_end", {}, asExtensionContext(ctxCore));
	piCore.emit("agent_end", completedRun(), asExtensionContext(ctxCore));
	assert.equal(ctxCore.compactions.length, 0, "agent_end must only capture, never compact");

	piCore.emit("agent_settled", {}, asExtensionContext(ctxCore));
	assert.equal(ctxCore.compactions.length, 1);
});

test("does not compact at a settled checkpoint with no preceding agent_end capture", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	registerDynamicCompaction(piCore, 0.8);

	piCore.emit("agent_settled", {}, asExtensionContext(ctxCore));

	assert.equal(ctxCore.compactions.length, 0);
});

test("does not compact when settled usage has unknown tokens", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = null;
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore);

	assert.equal(ctxCore.compactions.length, 0);
});

test("dynamic threshold still compacts at ratio after a length stop", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore, completedRun("length"));

	assert.equal(ctxCore.compactions.length, 1);
});

// Pi-core evaluates retry before compaction in _handlePostAgentRun(), and a
// retry continuation is a SEPARATE agent run: the failed attempt emits its own
// agent_end, core retries via agent.continue(), and the successful attempt
// emits a second agent_end. Only then does agent_settled arrive.
test("evaluates the final post-retry run rather than the failed run that preceded it", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	registerDynamicCompaction(piCore, 0.8);

	piCore.emit("agent_end", completedRun("error", ASSISTANT_AT - 10), asExtensionContext(ctxCore));
	piCore.emit("agent_end", completedRun("stop", ASSISTANT_AT), asExtensionContext(ctxCore));
	piCore.emit("agent_settled", {}, asExtensionContext(ctxCore));

	assert.equal(ctxCore.compactions.length, 1);
});

test("does not compact when the final post-retry run is still a recovery-owned failure", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	registerDynamicCompaction(piCore, 0.8);

	piCore.emit("agent_end", completedRun("error", ASSISTANT_AT - 10), asExtensionContext(ctxCore));
	piCore.emit("agent_end", completedRun("error", ASSISTANT_AT), asExtensionContext(ctxCore));
	piCore.emit("agent_settled", {}, asExtensionContext(ctxCore));

	assert.equal(ctxCore.compactions.length, 0);
});

test("prevents a second dynamic compaction while the first is in flight", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	ctxCore.compactNeverSettles = true;
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore);
	runLifecycle(piCore, ctxCore);

	assert.equal(ctxCore.compactions.length, 1);
});

// A run that settles while an earlier dynamic compaction is unsettled must not
// be discarded: its context still exceeds the threshold. Once the in-flight
// request completes, the next settled checkpoint has to evaluate it rather than
// silently skip a run that was never assessed.
test("a run captured during an in-flight compaction is still evaluated once that request completes", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	ctxCore.compactNeverSettles = true;
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore);
	assert.equal(ctxCore.compactions.length, 1, "first run compacts");

	// A second run completes and settles while the first request is unsettled.
	// This capture is the ONLY one outstanding when the guard later releases —
	// no further agent_end follows to mask it — so discarding it here is
	// observable as a run that never gets evaluated.
	runLifecycle(piCore, ctxCore);
	assert.equal(ctxCore.compactions.length, 1, "no duplicate request while one is in flight");

	ctxCore.compactNeverSettles = false;
	ctxCore.settleHeldCompaction();
	piCore.emit("agent_settled", {}, asExtensionContext(ctxCore));

	assert.equal(ctxCore.compactions.length, 2, "a run captured during the in-flight request is still evaluated");
});
