export type RecoveryBudgetDecision =
	| { allowed: true; attempt: number; limit: number }
	| { allowed: false; attempt: number; limit: number };

export type RecoveryBudget = {
	consume(message?: string): RecoveryBudgetDecision;
	/** The attempt the next consume() would take, without taking it. */
	peek(message?: string): { attempt: number; limit: number };
	reset(): void;
	used(): number;
};

export function createRecoveryBudget(maxAttempts: (message?: string) => number): RecoveryBudget {
	let used = 0;
	return {
		consume(message?: string) {
			const limit = maxAttempts(message);
			if (limit === 0 || (Number.isFinite(limit) && used >= limit)) {
				return { allowed: false, attempt: used + 1, limit };
			}
			used++;
			return { allowed: true, attempt: used, limit };
		},
		peek: (message?: string) => ({ attempt: used + 1, limit: maxAttempts(message) }),
		reset() {
			used = 0;
		},
		used: () => used,
	};
}
