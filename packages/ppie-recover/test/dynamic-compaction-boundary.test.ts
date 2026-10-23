import assert from "node:assert/strict";
import test from "node:test";
import {
	ASSISTANT_AT,
	compactionEntry,
	registerDynamicCompactionForTest as registerDynamicCompaction,
	rewindEntry,
	runLifecycle,
} from "./fakes/dynamic-compaction-lifecycle.ts";
import { CtxFakeCore, PiFakeCore } from "./fakes/pi-fakes.ts";

// Coordination with Pi-core's own compaction boundary. Pi exposes no
// "will compact" signal, so dynamic compaction reads the persisted branch to
// decide whether core already handled the run it captured. Threshold and
// lifecycle behavior lives in dynamic-compaction.test.ts.

test("skips when Pi-core already compacted the captured assistant context", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	ctxCore.branch = [compactionEntry(ASSISTANT_AT + 1)];
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore);

	assert.equal(ctxCore.compactions.length, 0);
});

test("still compacts when the only compaction boundary predates the captured assistant context", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	ctxCore.branch = [compactionEntry(ASSISTANT_AT - 1)];
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore);

	assert.equal(ctxCore.compactions.length, 1);
});

// The reported host behavior (session 019fbdd1): pi-rewind-hook writes a
// `custom` rewind-op entry ~2ms AFTER the compaction entry, so the compaction
// is no longer the branch's last entry. The host's own "already compacted"
// detection inspects only the last entry, mislabels the result, and reports
// "Nothing to compact (session too small)". The boundary guard must therefore
// scan for the newest compaction entry rather than testing the tail.
test("skips when a rewind entry was appended after Pi-core's compaction", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	ctxCore.branch = [compactionEntry(ASSISTANT_AT + 1), rewindEntry(ASSISTANT_AT + 2)];
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore);

	assert.equal(
		ctxCore.compactions.length,
		0,
		"a trailing rewind entry must not hide the compaction boundary and re-trigger a doomed request",
	);
});

// When the guard cannot help — Pi-core compacted but no entry is visible to the
// extension yet — the host rejects the request. The failure must surface and
// must release the in-flight guard.
test("surfaces a host Nothing-to-compact rejection instead of suppressing it", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 87_000;
	ctxCore.contextTokens = 69_600;
	ctxCore.failNextCompact = "Nothing to compact (session too small)";
	registerDynamicCompaction(piCore, 0.8);

	runLifecycle(piCore, ctxCore);
	assert.equal(ctxCore.compactions.length, 1, "the request is made");

	ctxCore.failNextCompact = undefined;
	runLifecycle(piCore, ctxCore);
	assert.equal(ctxCore.compactions.length, 2, "a rejected request must not leave the guard stuck");
});
