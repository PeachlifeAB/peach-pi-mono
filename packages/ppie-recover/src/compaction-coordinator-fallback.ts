import type { CompactionOutcome } from "./compact.ts";
import {
	activeRequest,
	armStallWatchdog,
	cancelCurrentRequest,
	cancelRecoveryRechecks,
	currentHost,
	isValid,
	markObservedCompacting,
	recoveryKind,
	releaseHost,
	releaseRequest,
	scheduleWarning,
} from "./compaction-coordinator-state.ts";
import type {
	ActiveRequest,
	CoordinatorStore,
	DeferredScheduler,
	DispositionEmitter,
	UnavailableOutcome,
} from "./compaction-coordinator-types.ts";

export type CoordinatorFallback = Readonly<{
	run(request: ActiveRequest): Promise<void>;
	scheduleStart(request: ActiveRequest): void;
	scheduleUnavailable(request: ActiveRequest, outcome: UnavailableOutcome): void;
}>;

export function createCoordinatorFallback(
	store: CoordinatorStore,
	scheduler: DeferredScheduler,
	emitDisposition: DispositionEmitter,
): CoordinatorFallback {
	const observed = (request: ActiveRequest) => markObservedCompacting(store, scheduler, emitDisposition, request);
	const arm = (request: ActiveRequest) => armStallWatchdog(store, scheduler, emitDisposition, request);

	const handleUnavailable = (request: ActiveRequest, outcome: UnavailableOutcome): void => {
		if (activeRequest(store) !== request) return;
		request.cancelUnavailableRecheck = undefined;
		if (!isValid(store, request)) {
			cancelCurrentRequest(store, emitDisposition);
			return;
		}
		if (store.host.kind === "active") {
			observed(request);
			return;
		}
		const unavailable = request.onUnavailable;
		emitDisposition(request, "unavailable", outcome.kind);
		releaseRequest(store, request);
		unavailable(outcome);
	};

	const scheduleUnavailable = (request: ActiveRequest, outcome: UnavailableOutcome): void => {
		cancelRecoveryRechecks(request);
		store.recovery = { kind: "awaiting-unavailable-recheck", request };
		request.cancelUnavailableRecheck = scheduler.defer(request.recheckDelayMs, () =>
			handleUnavailable(request, outcome),
		);
		arm(request);
	};

	const run = async (request: ActiveRequest): Promise<void> => {
		if (activeRequest(store) !== request || request.fallbackStarted) return;
		if (!isValid(store, request)) return cancelCurrentRequest(store, emitDisposition);
		if (store.host.kind === "active") return observed(request);
		const compact = request.compact;
		if (!compact) {
			if (request.requiresObservedCompaction) {
				const unavailable = request.onUnavailable;
				emitDisposition(request, "unavailable", "compaction-required-but-not-observed");
				releaseRequest(store, request);
				unavailable({
					kind: "not-authorized",
					error: new Error(
						"compaction required but no compaction was observed within bounded wait; ppie-recover compaction is not authorized (forced disabled, dynamic ratio not reached)",
					),
				});
				return;
			}
			const continuation = request.onCallerContinuation;
			emitDisposition(request, "caller-continuation", "fallback-disabled");
			releaseRequest(store, request);
			continuation({ kind: "deadline-without-compaction" });
			return;
		}
		request.fallbackStarted = true;
		store.idlePhase = "idle";
		store.recovery = { kind: "awaiting-fallback-result", request };
		arm(request);
		let outcome: CompactionOutcome;
		try {
			outcome = await compact();
		} catch (error) {
			outcome = {
				kind: "failed",
				error: error instanceof Error ? error : new Error(String(error)),
			};
		}
		if (activeRequest(store) !== request) return;
		if (!isValid(store, request)) return cancelCurrentRequest(store, emitDisposition);
		// The compact() await lets host lifecycle events retarget recovery; a
		// locally narrowed kind would be stale, so re-read it through the helper.
		if (recoveryKind(store) === "awaiting-host-idle") return;
		const hostAfterCompact = currentHost(store);
		if (hostAfterCompact.kind === "active") {
			if (
				(outcome.kind === "nothing-to-compact" || outcome.kind === "failed") &&
				request.fallbackLifecycleEpoch === hostAfterCompact.lifecycleEpoch
			) {
				releaseHost(store);
				const unavailable = request.onUnavailable;
				emitDisposition(request, "unavailable", outcome.kind);
				releaseRequest(store, request);
				unavailable(outcome);
				return;
			}
			if (outcome.kind === "completed" || outcome.kind === "already-compacted") {
				store.recovery = { kind: "awaiting-lifecycle", request };
				request.observedLifecycleEpoch = hostAfterCompact.lifecycleEpoch;
				request.onLifecyclePending(outcome);
				arm(request);
				scheduleWarning(
					store,
					scheduler,
					emitDisposition,
					request,
					outcome.kind === "completed"
						? `${request.label}: waiting for compaction lifecycle evidence.`
						: `${request.label}: compaction ownership is unresolved.`,
				);
				return;
			}
			return observed(request);
		}
		if (outcome.kind === "nothing-to-compact" || outcome.kind === "failed") {
			scheduleUnavailable(request, outcome);
			return;
		}
		store.recovery = { kind: "awaiting-lifecycle", request };
		request.onLifecyclePending(outcome);
		arm(request);
		scheduleWarning(
			store,
			scheduler,
			emitDisposition,
			request,
			outcome.kind === "completed"
				? `${request.label}: waiting for compaction lifecycle evidence.`
				: `${request.label}: compaction ownership is unresolved.`,
		);
	};

	const startRecheck = (): void => {
		if (store.recovery.kind !== "awaiting-core-start") return;
		const request = store.recovery.request;
		request.cancelStartRecheck = undefined;
		if (!isValid(store, request)) {
			cancelCurrentRequest(store, emitDisposition);
			return;
		}
		if (store.host.kind === "active") {
			observed(request);
			return;
		}
		void run(request);
	};

	const scheduleStart = (request: ActiveRequest): void => {
		request.cancelStartRecheck?.();
		request.cancelStartRecheck = scheduler.defer(request.startDelayMs ?? request.recheckDelayMs, startRecheck);
	};

	return { run, scheduleStart, scheduleUnavailable };
}
