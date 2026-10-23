import type { CompactionOutcome } from "./compact.ts";
import type { CompactionRequestOwner, CoordinatorDisposition } from "./coordinator-telemetry.ts";

export type CompactionPhase =
	| "idle"
	| "awaiting-core-start"
	| "observed-compacting"
	| "awaiting-fallback-result"
	| "awaiting-unavailable-recheck"
	| "awaiting-lifecycle"
	| "awaiting-host-idle"
	| "core-owns-continuation"
	| "cancelled";

export type CompactionRequestResult = "accepted" | "already-pending" | "cancelled";

export type DeferredScheduler = Readonly<{
	defer(delayMs: number, callback: () => void): () => void;
}>;

export type UnavailableOutcome =
	| { kind: "nothing-to-compact"; error: Error }
	| { kind: "failed"; error: Error }
	// Compaction was required but ppie-recover is not allowed to start one.
	| { kind: "not-authorized"; error: Error };

type CallerContinuationCause =
	| {
			kind: "compaction-completed";
			lifecycleEpoch: number;
	  }
	| {
			kind: "deadline-without-compaction";
	  };

export type CompactionRequest = {
	owner: CompactionRequestOwner;
	label: string;
	startWhen: "after-agent-settled" | "defer-now";
	startDelayMs?: number;
	recheckDelayMs: number;
	compactionWarningMs: number | undefined;
	stallCheckMs: number;
	stallRetryMs: number;
	signal?: AbortSignal;
	isCurrent: () => boolean;
	/** When true, continuation runs only when an actual compaction lifecycle completed for this request. */
	requiresObservedCompaction?: boolean;
	/** Undefined means observe Pi native recovery, then continue without invoking ctx.compact(). */
	compact?: () => Promise<CompactionOutcome>;
	onCallerContinuation: (cause: CallerContinuationCause) => void;
	onCompactionStarted?: () => void;
	onCoreContinuation: () => void;
	onUnavailable: (outcome: UnavailableOutcome) => void;
	onLifecyclePending: (outcome: { kind: "completed" } | { kind: "already-compacted"; error: Error }) => void;
	onDiagnostic: (message: string) => void;
	onStalled: () => void;
	onCancelled: () => void;
	/** Runs once when the request leaves the coordinator, before its outcome callback. */
	onEnded?: () => void;
};

export type HostCompactionState =
	| { kind: "idle"; lifecycleEpoch: number }
	| {
			kind: "active";
			lifecycleEpoch: number;
			removeAbortListener?: () => void;
	  };

export type ActiveRequest = CompactionRequest & {
	id: number;
	cancelStartRecheck?: () => void;
	cancelUnavailableRecheck?: () => void;
	cancelWarning?: () => void;
	cancelStallStep1?: () => void;
	cancelStallStep2?: () => void;
	removeRequestAbortListener?: () => void;
	fallbackStarted: boolean;
	fallbackLifecycleEpoch?: number;
	startedAfterLifecycleEpoch: number;
	observedLifecycleEpoch?: number;
	attempt: number;
};

export type RecoveryRequestState =
	| { kind: "idle" }
	| { kind: "awaiting-core-start"; request: ActiveRequest }
	| { kind: "observed-compacting"; request: ActiveRequest }
	| { kind: "awaiting-fallback-result"; request: ActiveRequest }
	| { kind: "awaiting-unavailable-recheck"; request: ActiveRequest }
	| { kind: "awaiting-lifecycle"; request: ActiveRequest }
	| { kind: "awaiting-host-idle"; request: ActiveRequest }
	| { kind: "core-owns-continuation"; request: ActiveRequest };

export type CoordinatorStore = {
	host: HostCompactionState;
	recovery: RecoveryRequestState;
	idlePhase: "idle" | "cancelled";
	nextRequestId: number;
	attemptByOwner: Map<CompactionRequestOwner, number>;
};

export type DispositionEmitter = (
	request: Pick<ActiveRequest, "id" | "owner" | "attempt">,
	disposition: CoordinatorDisposition,
	reason: string,
) => void;

export function createCoordinatorStore(): CoordinatorStore {
	return {
		host: { kind: "idle", lifecycleEpoch: 0 },
		recovery: { kind: "idle" },
		idlePhase: "idle",
		nextRequestId: 1,
		attemptByOwner: new Map(),
	};
}
