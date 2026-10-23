import assert from "node:assert/strict";
import test from "node:test";
import { shouldStopUnshrunkOverflowReplay } from "../src/retry-utils.ts";

const base = {
	activeErrorSignature: "signature",
	lastErrorSignature: "signature",
	currentPayloadChars: 100,
	lastSentPayloadChars: 100,
};

test("time-healing classes permit identical payload retries", () => {
	for (const errorClass of ["rate_limit", "transient"] as const) {
		assert.equal(shouldStopUnshrunkOverflowReplay({ ...base, errorClass }), false);
	}
});

test("persistent context overflow classes stop an identical signature and payload replay", () => {
	for (const errorClass of ["context_overflow", "opaque_overflow"] as const) {
		assert.equal(shouldStopUnshrunkOverflowReplay({ ...base, errorClass }), true);
	}
});

test("memory pressure retries remain governed by the bounded recovery chain", () => {
	assert.equal(shouldStopUnshrunkOverflowReplay({ ...base, errorClass: "memory_guard" }), false);
});

test("overflow replay remains allowed when payload or signature changed", () => {
	assert.equal(
		shouldStopUnshrunkOverflowReplay({
			...base,
			errorClass: "context_overflow",
			currentPayloadChars: 90,
		}),
		false,
	);
	assert.equal(
		shouldStopUnshrunkOverflowReplay({
			...base,
			errorClass: "context_overflow",
			activeErrorSignature: "new-signature",
		}),
		false,
	);
	assert.equal(
		shouldStopUnshrunkOverflowReplay({
			...base,
			errorClass: "context_overflow",
			lastErrorSignature: undefined,
		}),
		false,
	);
});
