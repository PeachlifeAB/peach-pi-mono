import {
	compactionAttempts,
	incrementPruneAttempts,
	nextActionId,
	type RecoveryChainState,
} from "./recovery-chain-state.ts";
import type { RecoveryChainAction, RecoveryChainPolicy, RecoveryTrigger } from "./recovery-chain-types.ts";
import type { RecoveryStopCause } from "./setting-tips.ts";

function terminalAction(state: RecoveryChainState, reason: string, cause?: RecoveryStopCause): RecoveryChainAction {
	state.status = "terminal";
	return {
		id: nextActionId(state),
		chainId: state.id,
		kind: "notify-terminal",
		reason,
		...(cause ? { cause } : {}),
	};
}

/**
 * Recovery is divided into three domains, each owning its own errors and its own
 * counter: plain provider retries, forced compaction, and pruning. No domain's
 * budget is drawn down by another's attempts, so making compaction more patient
 * can never starve pruning.
 */
export function admitProviderAction(
	state: RecoveryChainState,
	policy: RecoveryChainPolicy,
	trigger: RecoveryTrigger,
	kind: "continue-provider" | "reduce-and-retry",
): RecoveryChainAction {
	if (kind === "reduce-and-retry") {
		if (state.pruneAttempts >= policy.maxPruningAttempts) {
			return policy.maxPruningAttempts === 0
				? terminalAction(
						state,
						"Recovery stopped: forced compaction is exhausted or disabled and pruning is disabled.",
						"prune-disabled",
					)
				: terminalAction(state, `Recovery stopped after ${policy.maxPruningAttempts} prune attempts.`);
		}
		const attempt = incrementPruneAttempts(state);
		return { id: nextActionId(state), chainId: state.id, trigger, attempt, kind, pipeline: "reduction" };
	}
	const limit = policy.maxProviderRetryAttempts(state.failureSignature);
	if (limit === 0 || (Number.isFinite(limit) && state.providerRetryAttempts >= limit)) {
		return terminalAction(state, `Recovery budget exhausted after ${limit} provider retry attempts.`);
	}
	const attempt = ++state.providerRetryAttempts;
	return { id: nextActionId(state), chainId: state.id, trigger, attempt, kind };
}

/**
 * One budget for every trigger. A token-window overflow and a provider memory
 * ceiling are different problems, but "how many forced compactions before giving
 * up" has one answer; the former per-trigger split left context overflow on a
 * hardcoded single attempt while memory pressure was configurable.
 */
function compactionLimit(policy: RecoveryChainPolicy): number {
	return policy.forcedCompactionAttempts;
}

export function admitNextRecovery(
	state: RecoveryChainState,
	policy: RecoveryChainPolicy,
	trigger: RecoveryTrigger,
	delayMs: number,
): RecoveryChainAction | undefined {
	if (state.activeAction || state.activeCompaction || state.status === "terminal") return undefined;
	const used = compactionAttempts(state, trigger);
	// The compaction counter only ever increments, so once the budget is spent
	// every later admission takes the prune branch: recovery never returns to
	// compaction after pruning has begun.
	if (used >= compactionLimit(policy)) {
		return admitProviderAction(state, policy, trigger, "reduce-and-retry");
	}
	const attempt = used + 1;
	return {
		id: nextActionId(state),
		chainId: state.id,
		kind: "request-compaction",
		trigger,
		attempt,
		delayMs,
	};
}
