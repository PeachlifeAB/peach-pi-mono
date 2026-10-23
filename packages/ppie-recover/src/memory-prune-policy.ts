export const MEMORY_REMOVAL_FRACTIONS = Object.freeze([0.25, 0.5, 0.75, 0.875]);

export function memoryRemovalFloorTokens(
	baselineTokens: number,
	memoryPruneAttempt: number,
	fractions: readonly number[] = MEMORY_REMOVAL_FRACTIONS,
): number {
	if (baselineTokens <= 0 || memoryPruneAttempt <= 0) return 0;
	const index = Math.min(memoryPruneAttempt - 1, fractions.length - 1);
	return Math.ceil(baselineTokens * fractions[index]);
}
