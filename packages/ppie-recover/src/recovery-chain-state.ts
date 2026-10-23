import type {
	CompactionOwner,
	RecoveryChainAction,
	RecoveryChainSnapshot,
	RecoveryTrigger,
} from "./recovery-chain-types.ts";

type ActiveChainAction = {
	action: RecoveryChainAction;
	started: boolean;
};

type ActiveCompaction = {
	key: string;
	owner: CompactionOwner;
	requestId: string;
	lifecycleEpoch: number;
	trigger: RecoveryTrigger;
	attempt: number;
};

export type RecoveryChainState = {
	id: string;
	generation: string;
	status: "recovering" | "terminal";
	trigger: RecoveryTrigger;
	failureSignature: string;
	actionSequence: number;
	providerRetryAttempts: number;
	compactionAttempts: { contextOverflow: number; memoryGuard: number };
	pruneAttempts: number;
	pendingDemandIds: Set<string>;
	activeAction?: ActiveChainAction;
	activeCompaction?: ActiveCompaction;
	seenCompactionStarts: Set<string>;
	seenCompactionFinishes: Set<string>;
};

export function createRecoveryChainState(input: {
	id: string;
	generation: string;
	trigger: RecoveryTrigger;
	failureSignature: string;
}): RecoveryChainState {
	return {
		...input,
		status: "recovering",
		actionSequence: 0,
		providerRetryAttempts: 0,
		compactionAttempts: { contextOverflow: 0, memoryGuard: 0 },
		pruneAttempts: 0,
		pendingDemandIds: new Set(),
		seenCompactionStarts: new Set(),
		seenCompactionFinishes: new Set(),
	};
}

export function lifecycleKey(input: { owner: CompactionOwner; requestId: string; lifecycleEpoch: number }): string {
	return `${input.owner}:${input.requestId}:${input.lifecycleEpoch}`;
}

export function compactionAttempts(state: RecoveryChainState, trigger: RecoveryTrigger): number {
	return trigger === "memory-guard" ? state.compactionAttempts.memoryGuard : state.compactionAttempts.contextOverflow;
}

export function incrementCompactionAttempts(state: RecoveryChainState, trigger: RecoveryTrigger): number {
	if (trigger === "memory-guard") {
		return ++state.compactionAttempts.memoryGuard;
	}
	return ++state.compactionAttempts.contextOverflow;
}

export function incrementPruneAttempts(state: RecoveryChainState): number {
	return ++state.pruneAttempts;
}

export function nextActionId(state: RecoveryChainState): string {
	return `${state.id}:action-${++state.actionSequence}`;
}

export function snapshotOf(state: RecoveryChainState): RecoveryChainSnapshot {
	const pendingDemandIds = Object.freeze([...state.pendingDemandIds]);
	const attempts = Object.freeze({ ...state.compactionAttempts });
	return Object.freeze({
		id: state.id,
		generation: state.generation,
		status: state.status,

		activeFailure: Object.freeze({
			failureClass: state.trigger,
			signature: state.failureSignature,
		}),
		activeActionId: state.activeAction?.action.id,
		pendingDemandIds,
		providerRetryAttempts: state.providerRetryAttempts,
		compactionAttempts: attempts,
	});
}
