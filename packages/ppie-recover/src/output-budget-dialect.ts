export const OUTPUT_BUDGET_FIELDS = ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const;
export type OutputBudgetField = (typeof OUTPUT_BUDGET_FIELDS)[number];

const RESPONSES_OUTPUT_LIMIT_REASONS = ["incomplete.max_tokens", "incomplete.max_output_tokens"] as const;
const RESPONSES_ERROR_PREFIX = "response incomplete: ";
const INCOMPLETE_REASON_PREFIX = "incomplete.";

export function outputBudgetDialectOf(payload: unknown): { field: OutputBudgetField; value: number } | undefined {
	if (typeof payload !== "object" || payload === null) return;
	const record = payload as Record<string, unknown>;
	for (const field of OUTPUT_BUDGET_FIELDS) {
		const value = record[field];
		if (typeof value === "number" && Number.isFinite(value)) return { field, value };
	}
}

export function outputBudgetValuesOf(payload: unknown): Partial<Record<OutputBudgetField, unknown>> {
	if (typeof payload !== "object" || payload === null) return {};
	const record = payload as Record<string, unknown>;
	return Object.fromEntries(OUTPUT_BUDGET_FIELDS.map((field) => [field, record[field]]));
}

export function withOutputBudget(
	payload: Record<string, unknown>,
	field: OutputBudgetField,
	value: number,
): Record<string, unknown> {
	return { ...payload, [field]: value };
}

export function isOutputBudgetExhaustion(message: {
	rawStopReason?: string;
	stopReason?: string;
	errorMessage?: unknown;
}): boolean {
	if (RESPONSES_OUTPUT_LIMIT_REASONS.some((reason) => reason === message.rawStopReason)) return true;
	if (message.stopReason !== "error" || typeof message.errorMessage !== "string") return false;
	const error = message.errorMessage.toLowerCase();
	return RESPONSES_OUTPUT_LIMIT_REASONS.some((reason) =>
		error.includes(`${RESPONSES_ERROR_PREFIX}${reason.slice(INCOMPLETE_REASON_PREFIX.length)}`),
	);
}
