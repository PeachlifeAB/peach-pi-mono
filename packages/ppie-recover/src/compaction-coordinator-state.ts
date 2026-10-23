import type {
	ActiveRequest,
	CompactionRequest,
	CoordinatorStore,
	DeferredScheduler,
	DispositionEmitter,
	HostCompactionState,
	RecoveryRequestState,
} from "./compaction-coordinator-types.ts";

export function activeRequest(store: CoordinatorStore): ActiveRequest | undefined {
	return store.recovery.kind === "idle" ? undefined : store.recovery.request;
}
export function promoteRecoveryContinuation(current: ActiveRequest, next: CompactionRequest): void {
	if (current.owner !== "dynamic" || next.owner === "dynamic") return;
	const onEnded = current.onEnded;
	current.owner = next.owner;
	current.label = next.label;
	current.onCompactionStarted = next.onCompactionStarted;
	current.onEnded = () => {
		try {
			onEnded?.();
		} finally {
			next.onEnded?.();
		}
	};
	current.onCallerContinuation = next.onCallerContinuation;
	current.onCoreContinuation = next.onCoreContinuation;
	current.onUnavailable = next.onUnavailable;
	current.onLifecyclePending = next.onLifecyclePending;
	current.onDiagnostic = next.onDiagnostic;
	current.onStalled = next.onStalled;
	current.onCancelled = next.onCancelled;
}

export function currentHost(store: CoordinatorStore): HostCompactionState {
	return store.host;
}

export function isValid(store: CoordinatorStore, request = activeRequest(store)): boolean {
	return !!request && request.isCurrent() && !request.signal?.aborted;
}

// Returns the current recovery kind without control-flow narrowing: callers
// that awaited between reads must re-derive it, because async boundaries let
// host lifecycle events retarget recovery while the old narrowed type stays
// in scope.
export function recoveryKind(store: CoordinatorStore): RecoveryRequestState["kind"] {
	return store.recovery.kind;
}

export function cancelRecoveryRechecks(request = undefined as ActiveRequest | undefined): void {
	request?.cancelStartRecheck?.();
	request?.cancelUnavailableRecheck?.();
	if (request) {
		request.cancelStartRecheck = undefined;
		request.cancelUnavailableRecheck = undefined;
	}
}

function cancelLifecycleWarning(request = undefined as ActiveRequest | undefined): void {
	request?.cancelWarning?.();
	if (request) request.cancelWarning = undefined;
}

function cancelStallWatchdog(request = undefined as ActiveRequest | undefined): void {
	request?.cancelStallStep1?.();
	request?.cancelStallStep2?.();
	if (request) {
		request.cancelStallStep1 = undefined;
		request.cancelStallStep2 = undefined;
	}
}

function cleanupRequest(request: ActiveRequest): void {
	const ended = request.onEnded;
	request.onEnded = undefined;
	ended?.();
	cancelRecoveryRechecks(request);
	cancelLifecycleWarning(request);
	cancelStallWatchdog(request);
	request.removeRequestAbortListener?.();
	request.removeRequestAbortListener = undefined;
}

export function releaseRequest(store: CoordinatorStore, request = activeRequest(store)): void {
	if (request) cleanupRequest(request);
	store.recovery = { kind: "idle" };
	store.idlePhase = "idle";
}

export function cancelCurrentRequest(store: CoordinatorStore, emitDisposition: DispositionEmitter): void {
	const request = activeRequest(store);
	if (!request) return;
	cleanupRequest(request);
	store.recovery = { kind: "idle" };
	store.idlePhase = "cancelled";
	emitDisposition(request, "cancelled", "explicit-cancel");
	request.onCancelled();
}

export function releaseHost(store: CoordinatorStore): void {
	if (store.host.kind === "active") store.host.removeAbortListener?.();
	const lifecycleEpoch = store.host.lifecycleEpoch;
	store.host = { kind: "idle", lifecycleEpoch };
}

export function cancelCoordinator(store: CoordinatorStore, emitDisposition: DispositionEmitter): void {
	cancelCurrentRequest(store, emitDisposition);
	releaseHost(store);
}

function stateSnapshot(store: CoordinatorStore, request: ActiveRequest) {
	return {
		requestId: request.id,
		recoveryKind: store.recovery.kind,
		hostKind: store.host.kind,
		lifecycleEpoch: store.host.lifecycleEpoch,
		fallbackStarted: request.fallbackStarted,
		observedLifecycleEpoch: request.observedLifecycleEpoch,
	};
}

function sameSnapshot(left: ReturnType<typeof stateSnapshot>, right: ReturnType<typeof stateSnapshot>): boolean {
	return (
		left.requestId === right.requestId &&
		left.recoveryKind === right.recoveryKind &&
		left.hostKind === right.hostKind &&
		left.lifecycleEpoch === right.lifecycleEpoch &&
		left.fallbackStarted === right.fallbackStarted &&
		left.observedLifecycleEpoch === right.observedLifecycleEpoch
	);
}

export function armStallWatchdog(
	store: CoordinatorStore,
	scheduler: DeferredScheduler,
	emitDisposition: DispositionEmitter,
	request: ActiveRequest,
): void {
	if (activeRequest(store) !== request || !isValid(store, request)) return;
	cancelStallWatchdog(request);
	// A zero window disables the watchdog rather than firing it immediately.
	// The give-up sequence exists to bound a stalled compaction; with both
	// stages at zero it would arm and expire inside one macrotask, continuing
	// the caller before its own defer window ever elapsed.
	if (request.stallCheckMs <= 0 || request.stallRetryMs <= 0) return;
	const step1Snapshot = stateSnapshot(store, request);
	request.cancelStallStep1 = scheduler.defer(request.stallCheckMs, () => {
		request.cancelStallStep1 = undefined;
		if (activeRequest(store) !== request) return;
		if (!isValid(store, request)) return cancelCurrentRequest(store, emitDisposition);
		if (!sameSnapshot(step1Snapshot, stateSnapshot(store, request))) {
			armStallWatchdog(store, scheduler, emitDisposition, request);
			return;
		}
		const step2Snapshot = stateSnapshot(store, request);
		request.cancelStallStep2 = scheduler.defer(request.stallRetryMs, () => {
			request.cancelStallStep2 = undefined;
			if (activeRequest(store) !== request) return;
			if (!isValid(store, request)) return cancelCurrentRequest(store, emitDisposition);
			if (!sameSnapshot(step2Snapshot, stateSnapshot(store, request))) {
				armStallWatchdog(store, scheduler, emitDisposition, request);
				return;
			}
			const stalled = request.onStalled;
			emitDisposition(request, "stalled", "stalled-no-state-change");
			releaseHost(store);
			releaseRequest(store, request);
			stalled();
		});
	});
}

export function scheduleWarning(
	store: CoordinatorStore,
	scheduler: DeferredScheduler,
	emitDisposition: DispositionEmitter,
	request: ActiveRequest,
	message: string,
): void {
	if (request.compactionWarningMs === undefined) return;
	request.cancelWarning?.();
	request.cancelWarning = scheduler.defer(request.compactionWarningMs, () => {
		if (activeRequest(store) !== request) return;
		if (!isValid(store, request)) return cancelCurrentRequest(store, emitDisposition);
		request.onDiagnostic(message);
	});
}

export function markObservedCompacting(
	store: CoordinatorStore,
	scheduler: DeferredScheduler,
	emitDisposition: DispositionEmitter,
	request: ActiveRequest,
): void {
	if (!isValid(store, request)) {
		cancelCurrentRequest(store, emitDisposition);
		return;
	}
	if (store.host.kind === "active" && request.observedLifecycleEpoch !== store.host.lifecycleEpoch) {
		request.onCompactionStarted?.();
	}
	request.observedLifecycleEpoch =
		store.host.kind === "active" ? store.host.lifecycleEpoch : request.observedLifecycleEpoch;
	cancelRecoveryRechecks(request);
	store.recovery = { kind: "observed-compacting", request };
	scheduleWarning(store, scheduler, emitDisposition, request, `${request.label}: compaction is still active.`);
	armStallWatchdog(store, scheduler, emitDisposition, request);
}
