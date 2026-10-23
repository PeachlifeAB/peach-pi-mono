import {
	type EmergencyPruneResult,
	type EmergencyPruner,
	type EmergencyPrunerOptions,
	minKeepCharsForAttempt,
} from "./emergency-prune-contract.ts";
import { parseMemoryGuardOverageTokens, parseOverflowTokens } from "./emergency-prune-parse.ts";
import { pruneProviderPayload, pruneProviderPayloadMessagesOnly } from "./emergency-prune-payload.ts";
import { classifyError } from "./error-classifier.ts";
import { memoryRemovalFloorTokens } from "./memory-prune-policy.ts";
import { DEFAULT_CHARS_PER_TOKEN, DEFAULT_PRUNE_PRIORITIES, PRUNE_BUDGET_MARGIN } from "./retry-config.ts";

export function createEmergencyPruner(options: EmergencyPrunerOptions): EmergencyPruner {
	let active = false;
	let budgetChars = 0;
	let overflowCount = 0;
	let memoryPruneAttempt = 0;
	let activeCause: "memory-pressure" | "other" = "other";
	// Emergency pruning is request-local: the context hook returns a smaller
	// message array for one provider call but does not mutate session history.
	// If that call still fails, the next call starts from the original history,
	// so its target must include what the previous request already removed plus
	// the newly reported residual overage. Without this accumulator, repeated
	// memory/context failures replayed the same prune forever. Store this in
	// token units, not chars: charsPerToken is recalibrated from each fresh
	// server-reported prompt count, so carrying raw chars across a recalibration
	// can reinterpret a ~29K-token removal as ~88K tokens.
	let removedForPreviousRequestTokens = 0;
	// Session-level calibration, not per-turn state: survives clear() on
	// purpose, since the payload-shape/token relationship does not reset
	// between turns.
	let charsPerToken = DEFAULT_CHARS_PER_TOKEN;

	const tokensToChars = (tokens: number) => tokens * charsPerToken;
	const estimateTokens = (chars: number) => Math.ceil(chars / charsPerToken);

	const reserveChars = () => tokensToChars(options.getReserveTokens());

	const targetCharsFor = (payload: unknown, knownOverageTokens?: number) => {
		const knownOverageChars = knownOverageTokens === undefined ? 0 : overageBudgetChars(knownOverageTokens);
		const serializedChars = (() => {
			try {
				return JSON.stringify(payload)?.length ?? 0;
			} catch {
				return 0;
			}
		})();
		const baselineTokens = estimateTokens(serializedChars);
		const memoryFloorChars =
			activeCause === "memory-pressure"
				? tokensToChars(
						memoryRemovalFloorTokens(baselineTokens, memoryPruneAttempt, options.getMemoryRemovalFractions?.()),
					)
				: 0;
		return Math.max(budgetChars > 0 ? budgetChars : reserveChars(), knownOverageChars, memoryFloorChars);
	};

	const applyWith = (
		payload: unknown,
		knownOverageTokens: number | undefined,
		prune: typeof pruneProviderPayload,
		keepShortfallActive: boolean,
	): EmergencyPruneResult => {
		if (!active || budgetChars <= 0) {
			return {
				payload,
				removedChars: 0,
				removedTokensApprox: 0,
				shortfallChars: 0,
			};
		}

		// The caller knows the actual outgoing-payload overage at this boundary;
		// use it as a floor so each configured cumulative fraction removes enough
		// to clear provider-measured pressure plus reserve/margin.
		const targetChars = targetCharsFor(payload, knownOverageTokens);
		const priorities = options.getPriorities() ?? DEFAULT_PRUNE_PRIORITIES;
		const markers = options.getMarkers().map((marker) => marker.toLowerCase());

		const result = prune(payload, targetChars, priorities, markers, minKeepCharsForAttempt(overflowCount));
		const shortfallChars = Math.max(0, targetChars - result.removedChars);
		removedForPreviousRequestTokens += result.removedChars / charsPerToken;

		if (keepShortfallActive && shortfallChars > 0) {
			active = true;
			budgetChars = shortfallChars;
		} else {
			active = false;
		}

		return {
			payload: result.payload,
			removedChars: result.removedChars,
			removedTokensApprox: Math.round(result.removedChars / charsPerToken),
			shortfallChars,
		};
	};

	// The prune target is the ACTUAL overage plus the reserve (a small buffer
	// so the retry lands on the right side of the limit) and the estimation
	// margin — never multiplied by the attempt count: a repeat of the same
	// overflow does not make the payload any more oversized, it means the
	// previous prune under-delivered, which the monotonic Math.max below and
	// shouldStopUnshrunkOverflowReplay already handle.
	const overageBudgetChars = (overageTokens: number) =>
		tokensToChars((overageTokens + options.getReserveTokens()) * (1 + PRUNE_BUDGET_MARGIN));

	return {
		rememberOverflow(errorMessage: string, sentPayloadChars?: number) {
			active = true;
			overflowCount++;
			activeCause = classifyError(errorMessage) === "memory_guard" ? "memory-pressure" : "other";
			if (activeCause === "memory-pressure") memoryPruneAttempt++;
			const priorRequestRemovalTokens = removedForPreviousRequestTokens;
			removedForPreviousRequestTokens = 0;

			const parsed = parseOverflowTokens(errorMessage);

			if (parsed) {
				if (sentPayloadChars !== undefined && sentPayloadChars > 0) {
					const ratio = sentPayloadChars / parsed.promptTokens;
					// Sanity bounds: a ratio outside 1..16 chars/token means the
					// caller's char measurement does not describe this request.
					if (ratio >= 1 && ratio <= 16) charsPerToken = ratio;
				}
				const overageTokens = Math.max(0, parsed.promptTokens - parsed.contextWindow);
				budgetChars = Math.max(
					budgetChars,
					tokensToChars(priorRequestRemovalTokens) + overageBudgetChars(overageTokens),
				);
				return;
			}

			const memoryOverageTokens = parseMemoryGuardOverageTokens(errorMessage);

			if (memoryOverageTokens !== undefined) {
				budgetChars = Math.max(
					budgetChars,
					tokensToChars(priorRequestRemovalTokens) + overageBudgetChars(memoryOverageTokens),
				);
				return;
			}

			// Dynamic memory ceilings can reject a request while reporting current
			// usage below the reclaimability-derived ceiling; that terse shape omits
			// the request's predicted allocation, so usage-ceiling is not an
			// overage. Memory pressure uses the cumulative multiplicative baseline
			// floor computed at apply-time; this blind budget only carries the prior
			// achieved removal plus reserve. Non-memory blind probes retain their
			// attempt-scaled reserve behavior.
			const blindIncrementTokens =
				activeCause === "memory-pressure" ? options.getReserveTokens() : options.getReserveTokens() * overflowCount;
			budgetChars = Math.max(budgetChars, tokensToChars(priorRequestRemovalTokens + blindIncrementTokens));
		},

		estimateTokens,

		clear() {
			active = false;
			budgetChars = 0;
			overflowCount = 0;
			memoryPruneAttempt = 0;
			activeCause = "other";
			removedForPreviousRequestTokens = 0;
		},

		hasBudget() {
			return active;
		},

		isMemoryPressureActive() {
			return active && activeCause === "memory-pressure";
		},

		apply(payload: unknown, knownOverageTokens?: number): EmergencyPruneResult {
			return applyWith(payload, knownOverageTokens, pruneProviderPayload, false);
		},

		applyMessagesOnly(payload: unknown, knownOverageTokens?: number): EmergencyPruneResult {
			return applyWith(payload, knownOverageTokens, pruneProviderPayloadMessagesOnly, true);
		},
	};
}
