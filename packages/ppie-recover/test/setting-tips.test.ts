import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RETRY_POLICY, resolveRetryPolicy } from "../src/retry-policy.ts";
import { reportYield, settingTip } from "../src/setting-tips.ts";

// A stopped recovery names the one disabled setting that could have continued
// it, and says why that setting is off by default. No tip when it is on.

test("prune disabled: the tip names prune.enabled and why it is off", () => {
	const tip = settingTip(DEFAULT_RETRY_POLICY, "prune-disabled");
	assert.ok(tip);
	assert.ok(tip?.includes("memory_overflow_protection.prune.enabled: true"), tip);
	assert.ok(tip?.includes("less context"), tip);
});

test("prune enabled: no tip", () => {
	const policy = resolveRetryPolicy({ memory_overflow_protection: { prune: { enabled: true } } });
	assert.equal(settingTip(policy, "prune-disabled"), undefined);
});

test("compaction turned off: the tip names both compaction switches", () => {
	const policy = resolveRetryPolicy({
		memory_overflow_protection: { compaction: { forced: { enabled: false } } },
	});
	const tip = settingTip(policy, "compaction-not-authorized");
	assert.ok(tip);
	assert.ok(tip?.includes("memory_overflow_protection.compaction.forced.enabled: true"), tip);
	assert.ok(tip?.includes("compaction.enabled"), tip);
});

test("forced compaction on: no compaction tip", () => {
	assert.equal(settingTip(DEFAULT_RETRY_POLICY, "compaction-not-authorized"), undefined);
});

test("model fallback disabled: the tip names model_fallback.enabled and its model list", () => {
	const tip = settingTip(DEFAULT_RETRY_POLICY, "retries-exhausted");
	assert.ok(tip);
	assert.ok(tip?.includes("model_fallback.enabled: true"), tip);
	assert.ok(tip?.includes("fallback models"), tip);
});

test("model fallback enabled: no fallback tip", () => {
	const policy = resolveRetryPolicy({ model_fallback: { enabled: true } });
	assert.equal(settingTip(policy, "retries-exhausted"), undefined);
});

test("a yield reports its reason and optional setting tip in one info notification", () => {
	const shown: Array<[string, string | undefined]> = [];
	reportYield(
		(message, level) => shown.push([message, level]),
		DEFAULT_RETRY_POLICY,
		"Recovery yielded.",
		"prune-disabled",
	);
	assert.deepEqual(
		shown.map(([, level]) => level),
		["info"],
	);
	assert.ok(shown[0]?.[0].includes("yielded control"));
	assert.ok(shown[0]?.[0].includes("Recovery yielded."));
	assert.ok(shown[0]?.[0].includes("memory_overflow_protection.prune.enabled: true"));
});

test("a yield without a cause reports only one info notification", () => {
	const shown: Array<[string, string | undefined]> = [];
	reportYield(
		(message, level) => shown.push([message, level]),
		DEFAULT_RETRY_POLICY,
		"Cannot continue safely.",
		undefined,
	);
	assert.equal(shown.length, 1);
	assert.equal(shown[0]?.[1], "info");
	assert.ok(shown[0]?.[0].includes("Cannot continue safely."));
});
