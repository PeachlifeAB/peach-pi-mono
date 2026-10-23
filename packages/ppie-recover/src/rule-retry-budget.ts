/**
 * Per-rule retry counters for one recovery episode. A rule's max_attempts is
 * consumed only by errors classified into it; "unlimited" is never capped.
 * There is no wall-clock ceiling: user input always cancels recovery, and a
 * finite rule is already bounded by its count and capped backoff.
 */

type RuleRetryBudget = Readonly<{
	/** Whether another retry may be scheduled for this rule in this episode. */
	hasRetryLeft(rule: string): boolean;
	/** Record that a retry for this rule has actually been dispatched. */
	consume(rule: string): void;
	/** Retries consumed for this rule in this episode (telemetry/tests). */
	used(rule: string): number;
	/** Clear the episode's counters. */
	reset(): void;
}>;

export function createRuleRetryBudget(input: { maxAttemptsForRule: (rule: string) => number }): RuleRetryBudget {
	const usedByRule = new Map<string, number>();

	return {
		hasRetryLeft: (rule) => (usedByRule.get(rule) ?? 0) < Math.max(0, input.maxAttemptsForRule(rule)),
		consume: (rule) => {
			usedByRule.set(rule, (usedByRule.get(rule) ?? 0) + 1);
		},
		used: (rule) => usedByRule.get(rule) ?? 0,
		reset: () => {
			usedByRule.clear();
		},
	};
}
