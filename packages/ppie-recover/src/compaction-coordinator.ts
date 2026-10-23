import { createCoordinatorFallback } from "./compaction-coordinator-fallback.ts";
import {
	activeRequest,
	armStallWatchdog,
	cancelCoordinator,
	cancelCurrentRequest,
	cancelRecoveryRechecks,
	isValid,
	markObservedCompacting,
	promoteRecoveryContinuation,
	releaseRequest,
	scheduleWarning,
} from "./compaction-coordinator-state.ts";
import {
	type ActiveRequest,
	type CompactionPhase,
	type CompactionRequest,
	type CompactionRequestResult,
	createCoordinatorStore,
	type DeferredScheduler,
	type DispositionEmitter,
	type HostCompactionState,
} from "./compaction-coordinator-types.ts";
import { type CoordinatorTelemetryPort, createDispositionEmitter } from "./coordinator-telemetry.ts";

export type {
	CompactionPhase,
	CompactionRequest,
	CompactionRequestResult,
	DeferredScheduler,
} from "./compaction-coordinator-types.ts";
export type {
	CoordinatorDispositionEvent,
	CoordinatorTelemetryPort,
} from "./coordinator-telemetry.ts";

export function createCompactionCoordinator(
	scheduler: DeferredScheduler,
	telemetry?: CoordinatorTelemetryPort,
	waitForIdle?: () => Promise<void> | undefined,
) {
	const store = createCoordinatorStore();
	const emitDisposition = createDispositionEmitter(telemetry) as DispositionEmitter;
	const fallback = createCoordinatorFallback(store, scheduler, emitDisposition);
	const observed = (request: ActiveRequest) => markObservedCompacting(store, scheduler, emitDisposition, request);
	const arm = (request: ActiveRequest) => armStallWatchdog(store, scheduler, emitDisposition, request);

	const request = (next: CompactionRequest): CompactionRequestResult => {
		const current = activeRequest(store);
		if (current) {
			if (isValid(store, current)) {
				const previousIsCurrent = current.isCurrent;
				current.isCurrent = () => previousIsCurrent() && next.isCurrent();
				if (!current.compact && next.compact) current.compact = next.compact;
				current.requiresObservedCompaction = Boolean(
					current.requiresObservedCompaction || next.requiresObservedCompaction,
				);
				if (next.startWhen === "defer-now") {
					current.startWhen = "defer-now";
					current.startDelayMs = Math.min(current.startDelayMs ?? 0, next.startDelayMs ?? 0);
					current.recheckDelayMs = Math.min(current.recheckDelayMs, next.recheckDelayMs);
				}
				promoteRecoveryContinuation(current, next);
				if (store.recovery.kind === "awaiting-core-start" && current.startWhen === "defer-now") {
					cancelRecoveryRechecks(current);
					if (store.host.kind === "active") observed(current);
					else fallback.scheduleStart(current);
				}
				return "already-pending";
			}
			cancelCurrentRequest(store, emitDisposition);
		}
		const nextAttempt = (store.attemptByOwner.get(next.owner) ?? 0) + 1;
		const active: ActiveRequest = {
			...next,
			id: store.nextRequestId++,
			fallbackStarted: false,
			startedAfterLifecycleEpoch: store.host.lifecycleEpoch,
			attempt: nextAttempt,
		};
		if (next.signal?.aborted || !next.isCurrent()) {
			emitDisposition(active, "cancelled", "rejected-before-accept");
			next.onCancelled();
			return "cancelled";
		}
		store.attemptByOwner.set(next.owner, nextAttempt);
		if (next.signal) {
			const onAbort = () => {
				if (activeRequest(store) === active) cancelCurrentRequest(store, emitDisposition);
			};
			next.signal.addEventListener("abort", onAbort, { once: true });
			active.removeRequestAbortListener = () => next.signal?.removeEventListener("abort", onAbort);
		}
		store.idlePhase = "idle";
		store.recovery = { kind: "awaiting-core-start", request: active };
		arm(active);
		if (store.host.kind === "active") {
			observed(active);
			return "accepted";
		}
		if (next.startWhen === "defer-now") fallback.scheduleStart(active);
		return "accepted";
	};

	const onAgentSettled = (): void => {
		if (store.recovery.kind !== "awaiting-core-start") return;
		const current = store.recovery.request;
		if (!isValid(store, current)) {
			cancelCurrentRequest(store, emitDisposition);
			return;
		}
		if (store.host.kind === "active") {
			observed(current);
			return;
		}
		fallback.scheduleStart(current);
	};

	const onSessionBeforeCompact = (event?: { signal?: AbortSignal }): void => {
		if (store.host.kind === "active") store.host.removeAbortListener?.();
		const lifecycleEpoch = store.host.lifecycleEpoch + 1;
		const nextHost: HostCompactionState = { kind: "active", lifecycleEpoch };
		store.host = nextHost;
		if (event?.signal) {
			const onAbort = () => {
				if (store.host !== nextHost) return;
				store.host.removeAbortListener?.();
				store.host = { kind: "idle", lifecycleEpoch };
				const current = activeRequest(store);
				if (!current || current.observedLifecycleEpoch !== lifecycleEpoch) return;
				if (!isValid(store, current)) {
					cancelCurrentRequest(store, emitDisposition);
					return;
				}
				fallback.scheduleUnavailable(current, {
					kind: "failed",
					error: new Error("compaction aborted before lifecycle completion"),
				});
			};
			event.signal.addEventListener("abort", onAbort, { once: true });
			nextHost.removeAbortListener = () => event.signal?.removeEventListener("abort", onAbort);
		}
		const current = activeRequest(store);
		if (!current) return;
		if (current.fallbackStarted && store.recovery.kind === "awaiting-fallback-result") {
			current.fallbackLifecycleEpoch = lifecycleEpoch;
		}
		observed(current);
	};

	const onSessionCompact = (event: { willRetry?: boolean }): void => {
		const completedEpoch = store.host.lifecycleEpoch;
		if (store.host.kind === "active") store.host.removeAbortListener?.();
		store.host = { kind: "idle", lifecycleEpoch: completedEpoch };
		const current = activeRequest(store);
		if (!current) return;
		if (!isValid(store, current)) {
			cancelCurrentRequest(store, emitDisposition);
			return;
		}
		const matches =
			current.observedLifecycleEpoch === undefined
				? store.recovery.kind === "awaiting-lifecycle"
				: current.observedLifecycleEpoch === completedEpoch;
		if (!matches) return;
		if (event.willRetry === true) {
			store.recovery = { kind: "core-owns-continuation", request: current };
			cancelRecoveryRechecks(current);
			arm(current);
			scheduleWarning(
				store,
				scheduler,
				emitDisposition,
				current,
				`${current.label}: waiting for core-owned provider retry after compaction.`,
			);
			emitDisposition(current, "core-continuation", "willRetry");
			current.onCoreContinuation();
			return;
		}
		const continueCaller = () => {
			if (!isValid(store, current)) return cancelCurrentRequest(store, emitDisposition);
			emitDisposition(current, "caller-continuation", "compaction-settled");
			releaseRequest(store, current);
			current.onCallerContinuation({ kind: "compaction-completed", lifecycleEpoch: completedEpoch });
		};
		if (store.recovery.kind === "awaiting-host-idle") return;
		const ready = waitForIdle?.();
		if (!ready) {
			continueCaller();
			return;
		}
		// session_compact precedes the host clearing its compaction controller.
		// Do not await from the event hook: the host must finish emitting it first.
		const waiting = { kind: "awaiting-host-idle" as const, request: current };
		store.recovery = waiting;
		cancelRecoveryRechecks(current);
		arm(current);
		void (async () => {
			try {
				await ready;
			} catch (error) {
				if (store.recovery !== waiting) return;
				if (!isValid(store, current)) return cancelCurrentRequest(store, emitDisposition);
				emitDisposition(current, "unavailable", "host-idle-failed");
				releaseRequest(store, current);
				current.onUnavailable({ kind: "failed", error: error instanceof Error ? error : new Error(String(error)) });
				return;
			}
			if (store.recovery === waiting) continueCaller();
		})();
	};

	const onBeforeProviderRequest = (input: { isCompactionSummary: boolean }): void => {
		if (store.recovery.kind !== "core-owns-continuation" || input.isCompactionSummary) return;
		releaseRequest(store, store.recovery.request);
	};

	return {
		cancel: () => cancelCoordinator(store, emitDisposition),
		onProviderProgress: () => {
			const current = activeRequest(store);
			if (current && current.owner !== "dynamic") cancelCurrentRequest(store, emitDisposition);
		},
		phase: (): CompactionPhase => (store.recovery.kind === "idle" ? store.idlePhase : store.recovery.kind),
		hasActiveRequest: () => store.recovery.kind !== "idle",
		onAgentSettled,
		onBeforeProviderRequest,
		onSessionBeforeCompact,
		onSessionCompact,
		request,
	};
}
