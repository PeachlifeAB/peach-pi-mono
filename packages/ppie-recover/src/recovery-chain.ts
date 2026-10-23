export type {
	CompactionFailureOutcome,
	CompactionIdentity,
	ContinuationOwner,
	RecoveryChainAction,
	RecoveryChainController,
	RecoveryChainPolicy,
	RecoveryChainTelemetryEvent,
	RecoveryChainTelemetryPort,
	RecoveryFailureClass,
} from "./recovery-chain-types.ts";

import { admitNextRecovery, admitProviderAction } from "./recovery-chain-admission.ts";
import {
	compactionAttempts,
	createRecoveryChainState,
	incrementCompactionAttempts,
	lifecycleKey,
	type RecoveryChainState,
	snapshotOf,
} from "./recovery-chain-state.ts";
import type {
	RecoveryActionOutcome,
	RecoveryChainAction,
	RecoveryChainController,
	RecoveryChainEvent,
	RecoveryChainPolicy,
	RecoveryChainTelemetryEvent,
	RecoveryChainTelemetryPort,
	RecoveryTrigger,
} from "./recovery-chain-types.ts";

type RecoveryChainControllerOptions = Readonly<{
	generation: string;
	policy: RecoveryChainPolicy;
	delayMsForCompactionAttempt: (trigger: RecoveryTrigger, attempt: number, failureMessage: string) => number;
	nextChainId: () => string;
	telemetry?: RecoveryChainTelemetryPort;
}>;

function validatePolicy(policy: RecoveryChainPolicy): void {
	if (typeof policy.maxProviderRetryAttempts !== "function") {
		throw new Error("recovery-chain policy maxProviderRetryAttempts must be a function");
	}
	for (const [name, value] of Object.entries({
		forcedCompactionAttempts: policy.forcedCompactionAttempts,
		maxPruningAttempts: policy.maxPruningAttempts,
	})) {
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`recovery-chain policy ${name} must be a finite non-negative number`);
		}
	}
}

export function createRecoveryChainController(options: RecoveryChainControllerOptions): RecoveryChainController {
	validatePolicy(options.policy);
	let generation = options.generation;
	let state: RecoveryChainState | undefined;

	const emit = (event: RecoveryChainTelemetryEvent): void => {
		try {
			options.telemetry?.onEvent(Object.freeze(event));
		} catch {
			// Diagnostics are observational and cannot take recovery down.
		}
	};
	const telemetryBase = (current: RecoveryChainState) => ({
		chainId: current.id,
		generation: current.generation,
	});
	const close = (reason: "verified-progress" | "cancelled" | "generation-changed" | "terminal-notified"): void => {
		if (!state) return;
		emit({ type: "chain-closed", ...telemetryBase(state), reason });
		state = undefined;
	};
	const admit = (action: RecoveryChainAction): void => {
		if (!state) return;
		state.activeAction = { action: Object.freeze(action), started: false };
		emit({
			type: "action-admitted",
			...telemetryBase(state),
			actionId: action.id,
			kind: action.kind,
			trigger: "trigger" in action ? action.trigger : undefined,
			attempt: "attempt" in action ? action.attempt : undefined,
		});
	};
	const admitNext = (trigger: RecoveryTrigger): void => {
		if (!state) return;
		const attempt = compactionAttempts(state, trigger) + 1;
		const delayMs = options.delayMsForCompactionAttempt(trigger, attempt, state.failureSignature);
		if (!Number.isFinite(delayMs) || delayMs < 0) {
			throw new Error("recovery-chain compaction delay must be a finite non-negative number");
		}
		const action = admitNextRecovery(state, options.policy, trigger, delayMs);
		if (action) admit(action);
	};
	const admitProvider = (trigger: RecoveryTrigger, kind: "continue-provider" | "reduce-and-retry"): void => {
		if (state) admit(admitProviderAction(state, options.policy, trigger, kind));
	};
	const open = (trigger: RecoveryTrigger, signature: string): void => {
		state = createRecoveryChainState({
			id: options.nextChainId(),
			generation,
			trigger,
			failureSignature: signature,
		});
		emit({ type: "chain-opened", ...telemetryBase(state), trigger });
		admitNext(trigger);
	};
	const settleCompactionFailure = (trigger: RecoveryTrigger): void => {
		if (!state) return;
		state.trigger = trigger;
		admitNext(trigger);
	};
	const finishAction = (outcome: RecoveryActionOutcome): void => {
		if (!state?.activeAction) return;
		const { action } = state.activeAction;
		emit({
			type: "action-finished",
			...telemetryBase(state),
			actionId: action.id,
			kind: action.kind,
			outcome,
		});
		state.activeAction = undefined;
		if (action.kind === "notify-terminal") {
			close("terminal-notified");
			return;
		}
		if (action.kind === "request-compaction") {
			if (outcome === "failed") {
				const used = compactionAttempts(state, action.trigger);
				if (used < action.attempt) incrementCompactionAttempts(state, action.trigger);
				settleCompactionFailure(action.trigger);
			}
			return;
		}
		if (outcome === "failed") admitProvider(action.trigger, "reduce-and-retry");
		else if (outcome === "cancelled") close("cancelled");
	};

	const observeControlEvent = (event: RecoveryChainEvent): boolean => {
		switch (event.type) {
			case "generation-changed":
				close("generation-changed");
				generation = event.generation;
				return true;
			case "cancelled":
				close("cancelled");
				return true;
			case "failure-observed":
				if (!state) {
					open(event.failureClass, event.signature);
					return true;
				}
				if (state.status === "terminal" || state.activeAction || state.activeCompaction) return true;
				state.trigger = event.failureClass;
				state.failureSignature = event.signature;
				admitNext(event.failureClass);
				return true;
			default:
				return false;
		}
	};
	const observeActivityEvent = (event: RecoveryChainEvent): boolean => {
		const current = state;
		if (!current) return false;
		switch (event.type) {
			case "continuation-observed":
				current.pendingDemandIds.add(event.demandId);
				emit({ ...telemetryBase(current), ...event });
				return true;
			case "provider-progress":
				if (!event.hasError && (event.stopReason === "stop" || event.stopReason === "toolUse")) {
					close("verified-progress");
				}
				return true;
			case "action-started":
				if (current.activeAction?.action.id === event.actionId) current.activeAction.started = true;
				return true;
			case "action-finished":
				if (current.activeAction?.action.id === event.actionId) finishAction(event.outcome);
				return true;
			default:
				return false;
		}
	};
	const observeCompactionEvent = (event: RecoveryChainEvent): void => {
		if (event.type !== "compaction-started" && event.type !== "compaction-finished") return;
		const current = state;
		if (!current) return;
		const key = lifecycleKey(event);
		if (event.type === "compaction-started") {
			if (current.seenCompactionStarts.has(key)) return;
			const ownAction = current.activeAction?.action;
			if (
				event.owner === "ppie-recover" &&
				event.requestId.startsWith(`${current.id}:action-`) &&
				(ownAction?.kind !== "request-compaction" || ownAction.id !== event.requestId)
			) {
				return;
			}
			current.seenCompactionStarts.add(key);
			if (event.owner === "external") current.activeAction = undefined;
			const attempt = incrementCompactionAttempts(current, current.trigger);
			current.activeCompaction = { key, ...event, trigger: current.trigger, attempt };
			emit({ ...telemetryBase(current), ...event, attempt });
			return;
		}
		if (current.seenCompactionFinishes.has(key) || current.activeCompaction?.key !== key) return;
		const active = current.activeCompaction;
		current.seenCompactionFinishes.add(key);
		current.activeCompaction = undefined;
		if (current.activeAction?.action.kind === "request-compaction") current.activeAction = undefined;
		const finished: RecoveryChainTelemetryEvent = {
			type: "compaction-finished",
			...telemetryBase(current),
			owner: event.owner,
			requestId: event.requestId,
			lifecycleEpoch: event.lifecycleEpoch,
			attempt: active.attempt,
			outcome: event.outcome,
			continuationOwner: event.outcome === "completed" ? event.continuationOwner : undefined,
		};
		emit(finished);
		if (event.outcome === "completed") {
			if (event.continuationOwner === "ppie-recover") admitProvider(active.trigger, "continue-provider");
			return;
		}
		settleCompactionFailure(active.trigger);
	};
	const observe = (event: RecoveryChainEvent): void => {
		if (observeControlEvent(event) || !state || observeActivityEvent(event)) return;
		observeCompactionEvent(event);
	};

	return {
		observe,
		nextAction: () => (state?.activeAction && !state.activeAction.started ? state.activeAction.action : undefined),
		snapshot: () => (state ? snapshotOf(state) : undefined),
	};
}
