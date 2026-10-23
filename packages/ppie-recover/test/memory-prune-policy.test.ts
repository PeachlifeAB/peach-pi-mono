import assert from "node:assert/strict";
import test from "node:test";
import { createEmergencyPruner } from "../src/emergency-prune.ts";
import { MEMORY_REMOVAL_FRACTIONS, memoryRemovalFloorTokens } from "../src/memory-prune-policy.ts";
import { DEFAULT_PRUNE_MARKERS, DEFAULT_PRUNE_PRIORITIES } from "../src/retry-config.ts";

const opaqueMemoryFailure =
	"Request aborted: process memory limit exceeded (usage 49.6 GB, ceiling 51.3 GB). Reduce context size.";

function tokenSize(payload: unknown): number {
	return Math.ceil((JSON.stringify(payload)?.length ?? 0) / 4);
}

function originalPayload() {
	return {
		messages: [
			{ role: "system", content: "preserve system framing" },
			{ role: "assistant", content: "x".repeat(400_000) },
			{ role: "user", content: "continue" },
		],
		max_tokens: 8000,
	};
}

test("memory pressure removal floor progresses 25%, 50%, 75%, then 87.5%", () => {
	assert.deepEqual(MEMORY_REMOVAL_FRACTIONS, [0.25, 0.5, 0.75, 0.875]);
	assert.deepEqual(
		[1, 2, 3, 4, 5].map((attempt) => memoryRemovalFloorTokens(100_000, attempt)),
		[25_000, 50_000, 75_000, 87_500, 87_500],
	);
});

test("stateful capacity provider succeeds only after transformed payload crosses its real threshold", () => {
	const pruner = createEmergencyPruner({
		getReserveTokens: () => 2000,
		getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
		getMarkers: () => DEFAULT_PRUNE_MARKERS,
	});
	const baseline = tokenSize(originalPayload());
	const capacity = Math.floor(baseline * 0.45);
	const observedRemainingTokens: number[] = [];

	for (let attempt = 1; attempt <= 4; attempt++) {
		pruner.rememberOverflow(opaqueMemoryFailure);
		const transformed = pruner.apply(originalPayload()).payload;
		const remaining = tokenSize(transformed);
		observedRemainingTokens.push(remaining);
		if (remaining <= capacity) break;
	}

	assert.equal(observedRemainingTokens.length, 3);
	assert.ok(observedRemainingTokens[0] > capacity);
	assert.ok(observedRemainingTokens[1] > capacity);
	assert.ok(observedRemainingTokens[2] <= capacity);
	for (const [index, expectedRetainedFraction] of [0.75, 0.5, 0.25].entries()) {
		const actualRetainedFraction = observedRemainingTokens[index] / baseline;
		assert.ok(
			Math.abs(actualRetainedFraction - expectedRetainedFraction) < 0.03,
			`attempt ${index + 1} retained ${actualRetainedFraction}; expected approximately ${expectedRetainedFraction}`,
		);
	}
	assert.ok(
		observedRemainingTokens[0] > observedRemainingTokens[1] &&
			observedRemainingTokens[1] > observedRemainingTokens[2],
		`each failed request must cause a strictly smaller real payload: ${observedRemainingTokens.join(", ")}`,
	);
});
