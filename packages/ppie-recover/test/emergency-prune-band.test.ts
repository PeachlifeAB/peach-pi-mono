import assert from "node:assert/strict";
import test from "node:test";
import { createEmergencyPruner } from "../src/emergency-prune.ts";
import { pruneMessagesByChars } from "../src/emergency-prune-text.ts";
import { DEFAULT_PRUNE_PRIORITIES, DEFAULT_PRUNE_RESERVE_TOKENS, PRUNE_BUDGET_MARGIN } from "../src/retry-config.ts";

// Grounded in the 2026-07-14 oh-my-tokens smoke runs (session 019f60ad fork,
// omlx server log): the pruner claimed ~16.7K tokens removed on every
// attempt while the server-observed prompt only moved 124471 -> 102832 ->
// 102794 -> 102769 against a 97000-token window. Two wrong values compounded:
// the char budget multiplied the parsed overage by the attempt count
// (over-pruning small overages, and still starving when chars/4
// underestimated the real payload), and placement was priority-only — the
// freshest tool output was eaten as eagerly as stale middle history.
// The contract under test: remove the ACTUAL overage plus a small buffer,
// taken from the middle band (~20%-70%) of the transcript, protecting the
// head (system/early framing) and the recent tail.

const pruneOptions = {
	getReserveTokens: () => DEFAULT_PRUNE_RESERVE_TOKENS,
	getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
	getMarkers: () => [] as string[],
};

const OMLX_OVERFLOW_124K = "400: Prompt too long: 124471 tokens exceeds max context window of 97000 tokens";
const OVERAGE_TOKENS = 124_471 - 97_000;

// Ten messages: indices 0-1 are the head 20%, indices 7-9 the tail 30%,
// leaving 2..6 as the prunable middle band.
function tenMessages() {
	return [
		{ role: "system", content: "system framing. ".repeat(400) },
		{ role: "user", content: "first ask. ".repeat(400) },
		{ role: "assistant", content: "old answer. ".repeat(800) },
		{ role: "toolResult", content: "old tool output. ".repeat(800) },
		{ role: "assistant", content: "middle answer. ".repeat(800) },
		{ role: "toolResult", content: "middle tool output. ".repeat(800) },
		{ role: "user", content: "middle ask. ".repeat(800) },
		{ role: "assistant", content: "recent answer. ".repeat(800) },
		{ role: "toolResult", content: "fresh tool output. ".repeat(800) },
		{ role: "user", content: "latest ask. ".repeat(400) },
	];
}

function amplePayload() {
	const messages: Array<{ role: string; content: string }> = [{ role: "system", content: "framing. ".repeat(100) }];
	for (let i = 0; i < 30; i++) {
		messages.push({
			role: i % 2 === 0 ? "assistant" : "toolResult",
			content: `bulk turn ${i}. `.repeat(4000),
		});
	}
	messages.push({ role: "user", content: "latest ask" });
	return { messages };
}

test("pruning removes from the 20-70% middle band and leaves the head and recent tail untouched", () => {
	const messages = tenMessages();
	const before = JSON.parse(JSON.stringify(messages)) as unknown[];

	const result = pruneMessagesByChars(messages, 6000, DEFAULT_PRUNE_PRIORITIES, []);

	assert.ok(result.removedChars >= 6000, `must satisfy the target from the band (removed ${result.removedChars})`);
	for (const index of [0, 1, 7, 8, 9]) {
		assert.deepEqual(
			result.messages[index],
			before[index],
			`head/tail message ${index} must be untouched while the band can satisfy the target`,
		);
	}
	const bandChanged = [2, 3, 4, 5, 6].some(
		(index) => JSON.stringify(result.messages[index]) !== JSON.stringify(before[index]),
	);
	assert.ok(bandChanged, "the removal must have come from the middle band");
});

test("when the band alone cannot satisfy the target the pruner falls back to the rest instead of stranding recovery", () => {
	// Two messages: head=1, tail=1 — the band is empty. Recovery still beats
	// placement preference: the payload must shrink anyway.
	const messages = [
		{ role: "user", content: "ask. ".repeat(2000) },
		{ role: "assistant", content: "answer. ".repeat(2000) },
	];

	const result = pruneMessagesByChars(messages, 4000, DEFAULT_PRUNE_PRIORITIES, []);

	assert.ok(result.removedChars >= 4000, `band-empty payloads must still prune (removed ${result.removedChars})`);
});

test("parsed budget targets the actual overage plus reserve and margin — repeat overflows do not inflate it", () => {
	const pruner = createEmergencyPruner(pruneOptions);
	pruner.rememberOverflow(OMLX_OVERFLOW_124K);
	pruner.rememberOverflow(OMLX_OVERFLOW_124K);
	pruner.rememberOverflow(OMLX_OVERFLOW_124K);

	const result = pruner.apply(amplePayload());

	const expectedChars = (OVERAGE_TOKENS + DEFAULT_PRUNE_RESERVE_TOKENS) * (1 + PRUNE_BUDGET_MARGIN) * 4;
	assert.ok(
		result.removedChars >= expectedChars,
		`must remove at least overage+reserve+margin (${result.removedChars} < ${expectedChars})`,
	);
	assert.ok(
		result.removedChars <= expectedChars * 1.1 + 2000,
		`repeat overflows of the same error must not multiply the target (${result.removedChars} > ~${Math.round(expectedChars)})`,
	);
});

test("cumulative removals stay in token units when chars-per-token recalibrates", () => {
	const pruner = createEmergencyPruner(pruneOptions);
	pruner.rememberOverflow(OMLX_OVERFLOW_124K);
	const first = pruner.apply(amplePayload());

	// Recalibrate the next failed request from 4 to 2 chars/token. Carrying the
	// first removal as raw chars would incorrectly double its token meaning and
	// produce roughly a 3x target instead of prior-removal + residual (~2x).
	pruner.rememberOverflow(OMLX_OVERFLOW_124K, 124_471 * 2);
	const second = pruner.apply(amplePayload());

	assert.ok(second.removedTokensApprox > first.removedTokensApprox * 1.7);
	assert.ok(
		second.removedTokensApprox < first.removedTokensApprox * 2.4,
		`recalibration must not reinterpret prior removed chars as extra tokens (${first.removedTokensApprox} -> ${second.removedTokensApprox})`,
	);
});

test("token-to-char conversion calibrates from the observed failed request instead of assuming 4 chars per token", () => {
	const pruner = createEmergencyPruner(pruneOptions);
	// The failed request's serialized payload measured ~2.5 chars per
	// server-counted token (dense JSON) — the flat 4-chars/token guess would
	// over-convert the overage by 60%.
	pruner.rememberOverflow(OMLX_OVERFLOW_124K, 124_471 * 2.5);

	const result = pruner.apply(amplePayload());

	const expectedChars = (OVERAGE_TOKENS + DEFAULT_PRUNE_RESERVE_TOKENS) * (1 + PRUNE_BUDGET_MARGIN) * 2.5;
	assert.ok(
		result.removedChars >= expectedChars,
		`calibrated budget must still cover the true overage (${result.removedChars} < ${expectedChars})`,
	);
	assert.ok(
		result.removedChars <= expectedChars * 1.15 + 2000,
		`calibrated budget must not fall back to the flat 4-chars/token guess (${result.removedChars} vs expected ~${Math.round(expectedChars)})`,
	);
});

test("estimateTokens uses the calibrated ratio so payload-size overage math matches server truth", () => {
	const pruner = createEmergencyPruner(pruneOptions);
	pruner.rememberOverflow(OMLX_OVERFLOW_124K, 124_471 * 2.5);

	assert.equal(pruner.estimateTokens(25_000), Math.ceil(25_000 / 2.5));
});
