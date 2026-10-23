import assert from "node:assert/strict";
import test from "node:test";
import {
	createModelFallbackSequence,
	recordModelFallbackOutcome,
	selectNextFallbackCandidate,
	terminateModelFallbackSequence,
} from "../src/model-fallback-sequence.ts";

const start = Date.parse("2026-01-01T00:00:00.000Z");

function sequence(id = "sequence-a") {
	return createModelFallbackSequence({ sequenceId: id, failedModel: "openai/primary", startedAtMs: start });
}

test("candidate visits prevent cycles and remain sequence-local", () => {
	const first = selectNextFallbackCandidate(sequence(), ["openai/primary", "anthropic/backup"], 3);
	assert.equal(first.kind, "candidate");
	if (first.kind !== "candidate") return;
	assert.equal(first.candidateModel, "anthropic/backup");

	const exhausted = selectNextFallbackCandidate(first.sequence, ["anthropic/backup", "openai/primary"], 3);
	assert.equal(exhausted.kind, "exhausted");
	assert.equal(exhausted.reason, "chain-exhausted");

	const independent = selectNextFallbackCandidate(sequence("sequence-b"), ["anthropic/backup"], 3);
	assert.equal(independent.kind, "candidate");
});

test("only successful switches consume hop budget", () => {
	const resolution = recordModelFallbackOutcome(sequence(), {
		atMs: start + 10,
		failedModel: "openai/primary",
		candidateModel: "missing/model",
		outcome: "resolution-failed",
		reason: "model is unavailable",
	});
	const rejected = recordModelFallbackOutcome(resolution, {
		atMs: start + 20,
		failedModel: "openai/primary",
		candidateModel: "anthropic/backup",
		outcome: "switch-rejected",
		reason: "setModel returned false",
	});
	const hopped = recordModelFallbackOutcome(rejected, {
		atMs: start + 30,
		failedModel: "openai/primary",
		candidateModel: "anthropic/backup",
		servingModel: "anthropic/backup",
		outcome: "hop",
		reason: "model switched",
	});

	assert.equal(resolution.successfulSwitches, 0);
	assert.equal(rejected.successfulSwitches, 0);
	assert.equal(hopped.successfulSwitches, 1);
	assert.equal(hopped.records.at(-1)?.hopIndex, 1);
	assert(Object.isFrozen(hopped.records));
});

test("hop limit stops traversal before another candidate is visited", () => {
	const hopped = recordModelFallbackOutcome(sequence(), {
		atMs: start + 30,
		failedModel: "openai/primary",
		candidateModel: "anthropic/backup",
		servingModel: "anthropic/backup",
		outcome: "hop",
		reason: "model switched",
	});
	const result = selectNextFallbackCandidate(hopped, ["google/next"], 1);
	assert.deepEqual(result, { kind: "exhausted", sequence: hopped, reason: "hop-limit" });
	assert.equal(hopped.visitedModels.has("google/next"), false);
});

test("terminal records carry the complete ordered immutable trace", () => {
	const failed = recordModelFallbackOutcome(sequence(), {
		atMs: start + 10,
		failedModel: "openai/primary",
		candidateModel: "missing/model",
		outcome: "resolution-failed",
		reason: "not found",
		status: 404,
	});
	const terminated = terminateModelFallbackSequence(failed, {
		atMs: start + 20,
		failedModel: "openai/primary",
		reason: "resolution-exhausted",
	});

	assert.equal(terminated.sequence.state, "terminal");
	assert.equal(terminated.record.outcome, "terminated");
	assert.deepEqual(terminated.record.trace.slice(0, -1), failed.records);
	assert.deepEqual(terminated.record.trace.at(-1), {
		sequenceId: "sequence-a",
		timestamp: "2026-01-01T00:00:00.020Z",
		hopIndex: 0,
		failedModel: "openai/primary",
		candidateModel: undefined,
		servingModel: undefined,
		outcome: "terminated",
		reason: "resolution-exhausted",
		status: undefined,
		elapsedMs: 20,
	});
	assert(Object.isFrozen(terminated.record.trace));
	assert.equal(terminated.record.elapsedMs, 20);
});
