import { createErrorRuleEngine, pacingDelayMs } from "./error-rule-engine.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";
import { createRuleRetryBudget } from "./rule-retry-budget.ts";

/**
 * Episode-scoped admission policy for the retry engine, driven by the error-rule
 * table: a message is retryable while its resolved rule has attempts left in
 * the current recovery episode. Pacing is the rule's geometric
 * law (seconds_before_first_retry × multiplier^(attempt-1)). The budget is
 * consumed at dispatch time, so a steer or cancel during the wait does not
 * burn the episode's allowance. Owns the rule engine and budget assembly.
 */

export type RetryAdmission = Readonly<{
	isStillRetryable(message: string): boolean;
	/** True when the effective retry policy forbids retries outright. */
	neverRetries(message: string): boolean;
	/** True when retries are allowed in principle but the episode budget is spent. */
	retryBudgetExhausted(message: string): boolean;
	/** Consume the effective retry policy's budget when a retry is dispatched. */
	consumeForRetry(message: string): void;
	delayMsForError(message: string, attempt: number): number;
	maxAttemptsFor(message?: string): number;
	/** Rule key the message resolves to — for notifications and budgets. */
	ruleFor(message: string): string;
	fallbackModelsFor(message: string): readonly string[];
	/** Clear the episode's counters. */
	reset(): void;
}>;

export function createRetryAdmission(input: { policy: ResolvedRetryPolicy }): RetryAdmission {
	const engine = createErrorRuleEngine(input.policy.errorRules);
	const effectiveAttempts = new Map<string, number>();
	const matchFor = (message: string) => {
		const match = engine.resolve(message);
		effectiveAttempts.set(match.rule, match.pacing.max_attempts);
		return match;
	};
	const ruleBudget = createRuleRetryBudget({
		maxAttemptsForRule: (rule) => effectiveAttempts.get(rule) ?? 0,
	});
	const neverRetries = (message: string) => matchFor(message).pacing.max_attempts === 0;
	const exhausted = (message: string) => {
		const match = matchFor(message);
		return !ruleBudget.hasRetryLeft(match.rule);
	};
	const maxAttemptsFor = (message?: string) =>
		message === undefined ? input.policy.maximumAttempts : matchFor(message).pacing.max_attempts;
	return {
		isStillRetryable: (message) => {
			return !neverRetries(message) && !exhausted(message);
		},
		neverRetries,
		retryBudgetExhausted: (message) => !neverRetries(message) && exhausted(message),
		consumeForRetry: (message) => {
			const match = matchFor(message);
			ruleBudget.consume(match.rule);
		},
		delayMsForError: (message, attempt) => {
			const match = matchFor(message);
			return pacingDelayMs(match.pacing, attempt);
		},
		maxAttemptsFor,
		ruleFor: (message) => matchFor(message).rule,
		fallbackModelsFor: (message) => matchFor(message).fallbackModels,
		reset: () => {
			effectiveAttempts.clear();
			ruleBudget.reset();
		},
	};
}
