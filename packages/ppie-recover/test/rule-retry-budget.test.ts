import assert from "node:assert/strict";
import test from "node:test";
import { createRuleRetryBudget } from "../src/rule-retry-budget.ts";

test("per-rule counters are isolated", () => {
	const budget = createRuleRetryBudget({
		maxAttemptsForRule: (rule) => (rule === "rate limit or throttle" ? 1 : 5),
	});
	assert.equal(budget.hasRetryLeft("rate limit or throttle"), true);
	budget.consume("rate limit or throttle");
	assert.equal(budget.hasRetryLeft("rate limit or throttle"), false);
	assert.equal(budget.used("rate limit or throttle"), 1);
	assert.equal(budget.hasRetryLeft("anything else"), true);
});

test("max_attempts 0 rules never have budget", () => {
	const budget = createRuleRetryBudget({ maxAttemptsForRule: () => 0 });
	assert.equal(budget.hasRetryLeft("payment denied"), false);
});

test("unlimited rules never run out", () => {
	const budget = createRuleRetryBudget({ maxAttemptsForRule: () => Number.POSITIVE_INFINITY });
	for (let attempt = 0; attempt < 10_000; attempt++) budget.consume("time heals");
	assert.equal(budget.hasRetryLeft("time heals"), true);
});

test("reset clears the episode's counters", () => {
	const budget = createRuleRetryBudget({ maxAttemptsForRule: () => 1 });
	budget.consume("anything else");
	assert.equal(budget.hasRetryLeft("anything else"), false);

	budget.reset();
	assert.equal(budget.used("anything else"), 0);
	assert.equal(budget.hasRetryLeft("anything else"), true);
});
