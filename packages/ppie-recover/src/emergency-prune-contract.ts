import { MIN_TEXT_KEEP_CHARS, MIN_TEXT_KEEP_CHARS_FLOOR, type PrunePriorities } from "./retry-config.ts";

export function minKeepCharsForAttempt(overflowCount: number): number {
	const halvings = Math.max(0, overflowCount - 1);
	const scaled = MIN_TEXT_KEEP_CHARS / 2 ** halvings;
	return Math.max(MIN_TEXT_KEEP_CHARS_FLOOR, Math.round(scaled));
}

export type EmergencyPruneResult = {
	payload: unknown;
	removedChars: number;
	removedTokensApprox: number;
	shortfallChars: number;
};

export type EmergencyPrunerOptions = {
	getReserveTokens: () => number;
	getPriorities: () => PrunePriorities;
	getMarkers: () => string[];
	getMemoryRemovalFractions?: () => readonly number[];
};

export type EmergencyPruner = {
	rememberOverflow(errorMessage: string, sentPayloadChars?: number): void;
	clear(): void;
	hasBudget(): boolean;
	isMemoryPressureActive(): boolean;
	estimateTokens(chars: number): number;
	apply(payload: unknown, knownOverageTokens?: number): EmergencyPruneResult;
	applyMessagesOnly(payload: unknown, knownOverageTokens?: number): EmergencyPruneResult;
};
