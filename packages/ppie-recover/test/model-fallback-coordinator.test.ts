import assert from "node:assert/strict";
import test from "node:test";
import type { RetryContinuationPort } from "../src/agent-retry-types.ts";
import { createModelFallbackCoordinator } from "../src/model-fallback-coordinator.ts";
import type { ModelFallbackRecord, ModelFallbackTerminalRecord } from "../src/model-fallback-sequence.ts";
import { createStandaloneRetryDrivingLock } from "../src/retry-driving-lock.ts";

const tail = { role: "assistant", stopReason: "error" };
type TestModel = { reference: string };

function harness() {
	let currentModel = "openai/primary";
	let available = new Map<string, TestModel>();
	let drops = 0;
	let continuationResult: Awaited<ReturnType<RetryContinuationPort["continueCurrent"]>> = "completed";
	let acceptSwitch = true;
	const rejectedSwitches = new Set<string>();
	let onContinue: (() => void) | undefined;
	const records: ModelFallbackRecord[] = [];
	const switches: string[] = [];
	let now = 1_000;
	const drivingLock = createStandaloneRetryDrivingLock();
	const coordinator = createModelFallbackCoordinator<TestModel>({
		drivingLock,
		continuation: {
			async continueCurrent(expectedTail, prepare, isCurrent) {
				assert.equal(expectedTail, tail);
				if (isCurrent?.() === false) return "superseded";
				if (continuationResult === "completed") prepare();
				onContinue?.();
				return continuationResult;
			},
		},
		currentModel: () => currentModel,
		resolveCandidate: (reference) => available.get(reference),
		setModel: async (model) => {
			switches.push(model.reference);
			if (rejectedSwitches.has(model.reference)) throw new Error(`rejected ${model.reference}`);
			if (acceptSwitch) currentModel = model.reference;
			return acceptSwitch;
		},
		modelReference: (model) => model.reference,
		expectedTail: () => tail,
		dropExpectedTail: () => {
			drops++;
		},
		report: (record) => records.push(record),
		now: () => ++now,
		nextSequenceId: () => "sequence-1",
	});
	return {
		coordinator,
		drivingLock,
		records,
		switches,
		get drops() {
			return drops;
		},
		setAvailable(...references: string[]) {
			available = new Map(references.map((reference) => [reference, { reference }]));
		},
		setCurrent(reference: string) {
			currentModel = reference;
		},
		setContinuationResult(result: typeof continuationResult) {
			continuationResult = result;
		},
		setOnContinue(callback: () => void) {
			onContinue = callback;
		},
		rejectSwitches() {
			acceptSwitch = false;
		},
		rejectSwitch(reference: string) {
			rejectedSwitches.add(reference);
		},
	};
}

const failure = {
	failedModel: "openai/primary",
	fallbackModels: ["anthropic/backup"],
	maxHops: 3,
	reason: "model unavailable",
	status: 503,
} as const;

test("fallback waits for the retry lock, resolves live, switches, and continues without a user message", async () => {
	const h = harness();
	const owner = Symbol("retry");
	h.drivingLock.acquire(owner);
	const routed = h.coordinator.route(failure);
	h.setAvailable("anthropic/backup");
	h.drivingLock.release(owner);
	assert.equal(await routed, "redispatched");
	assert.deepEqual(h.switches, ["anthropic/backup"]);
	assert.equal(h.drops, 1);
	assert.equal(h.records[0]?.outcome, "hop");
	assert.equal(h.records[0]?.servingModel, "anthropic/backup");
});

test("a peer model switch records stand-down and never resolves or switches", async () => {
	const h = harness();
	h.setCurrent("external/router-model");
	h.setAvailable("anthropic/backup");
	assert.equal(await h.coordinator.route(failure), "terminal");
	assert.deepEqual(h.switches, []);
	assert.deepEqual(
		h.records.map((record) => record.outcome),
		["stand-down", "terminated"],
	);
});

test("resolution and switch failures advance without consuming hop budget", async () => {
	const h = harness();
	h.setAvailable("anthropic/rejected");
	const rejected = h.coordinator.route({
		...failure,
		fallbackModels: ["missing/model", "anthropic/rejected"],
	});
	h.rejectSwitches();
	assert.equal(await rejected, "terminal");
	assert.deepEqual(
		h.records.map((record) => record.outcome),
		["resolution-failed", "switch-rejected", "terminated"],
	);
	const terminal = h.records.at(-1) as ModelFallbackTerminalRecord;
	assert.deepEqual(
		terminal.trace.map((record) => [record.outcome, record.candidateModel]),
		[
			["resolution-failed", "missing/model"],
			["switch-rejected", "anthropic/rejected"],
			["terminated", undefined],
		],
	);
	assert.equal(h.coordinator.activeSequence(), undefined);
});

test("a rejected setModel promise records the candidate and advances", async () => {
	const h = harness();
	h.setAvailable("anthropic/rejected", "google/next");
	h.rejectSwitch("anthropic/rejected");
	assert.equal(
		await h.coordinator.route({
			...failure,
			fallbackModels: ["anthropic/rejected", "google/next"],
		}),
		"redispatched",
	);
	assert.deepEqual(h.switches, ["anthropic/rejected", "google/next"]);
	assert.deepEqual(
		h.records.map((record) => record.outcome),
		["switch-rejected", "hop"],
	);
});

test("resolution-only exhaustion names every unresolved candidate in its trace", async () => {
	const h = harness();
	assert.equal(await h.coordinator.route({ ...failure, fallbackModels: ["missing/one", "missing/two"] }), "terminal");
	const terminal = h.records.at(-1) as ModelFallbackTerminalRecord;
	assert.equal(terminal.reason, "resolution-exhausted");
	assert.deepEqual(
		terminal.trace.slice(0, -1).map((record) => record.candidateModel),
		["missing/one", "missing/two"],
	);
});

test("a superseded continuation terminates the active sequence", async () => {
	const h = harness();
	h.setAvailable("anthropic/backup");
	h.setContinuationResult("superseded");
	assert.equal(await h.coordinator.route(failure), "terminal");
	assert.equal(h.records.at(-1)?.reason, "superseded");
	assert.equal(h.drops, 0);
});

test("cancellation while waiting prevents later resolution, switch, and redispatch", async () => {
	const h = harness();
	const owner = Symbol("retry");
	h.drivingLock.acquire(owner);
	const routed = h.coordinator.route(failure);
	h.coordinator.cancel("cancelled");
	h.setAvailable("anthropic/backup");
	h.drivingLock.release(owner);
	assert.equal(await routed, "cancelled");
	assert.deepEqual(h.switches, []);
	assert.equal(h.drops, 0);
	assert.equal(h.records.at(-1)?.reason, "cancelled");
});

test("a failure emitted during continuation is queued until the current route releases the lock", async () => {
	const h = harness();
	h.setAvailable("anthropic/backup", "google/next");
	let nested: ReturnType<typeof h.coordinator.route> | undefined;
	h.setOnContinue(() => {
		if (nested) return;
		nested = h.coordinator.route({
			failedModel: "anthropic/backup",
			fallbackModels: ["google/next"],
			maxHops: 2,
			reason: "rate_limit",
		});
	});
	assert.equal(await h.coordinator.route({ ...failure, maxHops: 2 }), "redispatched");
	assert(nested);
	assert.equal(await nested, "redispatched");
	assert.deepEqual(h.switches, ["anthropic/backup", "google/next"]);
	assert.equal(h.coordinator.activeSequence()?.successfulSwitches, 2);
});

test("re-dispatched failures keep one ledger until the successful hop bound terminates it", async () => {
	const h = harness();
	h.setAvailable("anthropic/backup", "google/next");
	assert.equal(await h.coordinator.route({ ...failure, maxHops: 2 }), "redispatched");
	const sequenceId = h.coordinator.activeSequence()?.sequenceId;
	assert.equal(
		await h.coordinator.route({
			failedModel: "anthropic/backup",
			fallbackModels: ["openai/primary", "google/next"],
			maxHops: 2,
			reason: "rate_limit",
			status: 429,
		}),
		"redispatched",
	);
	assert.equal(h.coordinator.activeSequence()?.sequenceId, sequenceId);
	assert.equal(h.coordinator.activeSequence()?.successfulSwitches, 2);
	assert.deepEqual(h.switches, ["anthropic/backup", "google/next"]);

	assert.equal(
		await h.coordinator.route({
			failedModel: "google/next",
			fallbackModels: ["openai/primary", "anthropic/backup"],
			maxHops: 2,
			reason: "permanent",
			status: 500,
		}),
		"terminal",
	);
	assert.equal(h.records.at(-1)?.reason, "hop-limit");
	const terminal = h.records.at(-1) as ModelFallbackTerminalRecord;
	assert.deepEqual(terminal.trace.slice(0, -1), h.records.slice(0, -1));
	assert.equal(terminal.trace.at(-1)?.outcome, "terminated");
	assert.equal(terminal.trace.at(-1)?.failedModel, "google/next");
	assert.equal(terminal.trace.at(-1)?.status, 500);
});

test("a successful turn discards active sequence state without switching back", async () => {
	const h = harness();
	h.setAvailable("anthropic/backup");
	await h.coordinator.route(failure);
	h.coordinator.succeed();
	assert.equal(h.coordinator.activeSequence(), undefined);
	assert.deepEqual(h.switches, ["anthropic/backup"]);
});

test("an empty fallback chain is inert until a sequence is active", async () => {
	const h = harness();

	assert.equal(await h.coordinator.route({ ...failure, fallbackModels: [] }), "inert");
	assert.equal(h.coordinator.activeSequence(), undefined);
	assert.deepEqual(h.records, []);
});

test("an empty fallback chain terminates an active sequence as provider-exhausted", async () => {
	const h = harness();
	h.setAvailable("anthropic/backup");
	assert.equal(await h.coordinator.route(failure), "redispatched");

	assert.equal(await h.coordinator.route({ ...failure, fallbackModels: [] }), "terminal");
	assert.equal(h.records.at(-1)?.reason, "provider-exhausted");
});
