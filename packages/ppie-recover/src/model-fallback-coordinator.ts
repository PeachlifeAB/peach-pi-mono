import type { RetryContinuationPort } from "./agent-retry-types.ts";
import {
	createModelFallbackSequence,
	type ModelFallbackRecord,
	type ModelFallbackSequence,
	recordModelFallbackOutcome,
	selectNextFallbackCandidate,
	terminateModelFallbackSequence,
} from "./model-fallback-sequence.ts";
import type { RetryDrivingLock } from "./retry-driving-lock.ts";

type ModelFallbackRoute = Readonly<{
	failedModel: string;
	fallbackModels: readonly string[];
	maxHops: number;
	reason: string;
	status?: number;
}>;

type ModelFallbackRouteResult = "inert" | "redispatched" | "terminal" | "cancelled" | "superseded";

export type ModelFallbackCoordinator = Readonly<{
	route(input: ModelFallbackRoute): Promise<ModelFallbackRouteResult>;
	cancel(reason: string): void;
	succeed(): void;
	activeSequence(): ModelFallbackSequence | undefined;
	isActive(): boolean;
}>;

export function createModelFallbackCoordinator<Model>(options: {
	drivingLock: RetryDrivingLock;
	continuation: RetryContinuationPort;
	currentModel: () => string | undefined;
	resolveCandidate: (reference: string) => Model | undefined;
	setModel: (model: Model) => Promise<boolean>;
	modelReference: (model: Model) => string;
	expectedTail: () => unknown;
	dropExpectedTail: (expectedTail: unknown) => void;
	report: (record: ModelFallbackRecord) => void;
	now: () => number;
	nextSequenceId: () => string;
}): ModelFallbackCoordinator {
	let active: ModelFallbackSequence | undefined;
	let routeAbort: AbortController | undefined;
	let pendingRoute: { input: ModelFallbackRoute; resolve: (result: ModelFallbackRouteResult) => void } | undefined;
	let lastFailedModel: string | undefined;

	const reportOutcome = (
		sequence: ModelFallbackSequence,
		input: Parameters<typeof recordModelFallbackOutcome>[1],
	): ModelFallbackSequence => {
		const next = recordModelFallbackOutcome(sequence, input);
		active = next;
		const record = next.records.at(-1);
		if (record) options.report(record);
		return next;
	};

	const terminate = (
		sequence: ModelFallbackSequence,
		failedModel: string,
		reason: string,
		cancelled = false,
		status?: number,
	): void => {
		const terminal = terminateModelFallbackSequence(sequence, {
			atMs: options.now(),
			failedModel,
			reason,
			status,
			cancelled,
		});
		active = undefined;
		options.report(terminal.record);
	};

	const exhaustionReason = (sequence: ModelFallbackSequence, selectionReason: string): string => {
		if (selectionReason === "hop-limit") return "hop-limit";
		const resolutionOnly =
			sequence.records.length > 0 && sequence.records.every((record) => record.outcome === "resolution-failed");
		if (resolutionOnly) return "resolution-exhausted";
		return sequence.successfulSwitches > 0 ? "provider-exhausted" : "candidate-exhausted";
	};

	const attemptCandidate = async (
		input: ModelFallbackRoute,
		sequence: ModelFallbackSequence,
		abort: AbortController,
		candidateModel: string,
		candidate: Model,
	) => {
		let switched: boolean;
		try {
			switched = await options.setModel(candidate);
		} catch (error) {
			if (abort.signal.aborted) return { kind: "done", result: "cancelled" } as const;
			const nextSequence = reportOutcome(sequence, {
				atMs: options.now(),
				failedModel: input.failedModel,
				candidateModel,
				outcome: "switch-rejected",
				reason: error instanceof Error ? error.message : String(error),
			});
			return { kind: "continue", sequence: nextSequence } as const;
		}
		if (abort.signal.aborted) return { kind: "done", result: "cancelled" } as const;
		if (!switched) {
			const nextSequence = reportOutcome(sequence, {
				atMs: options.now(),
				failedModel: input.failedModel,
				candidateModel,
				outcome: "switch-rejected",
				reason: "setModel-returned-false",
			});
			return { kind: "continue", sequence: nextSequence } as const;
		}

		const servingModel = options.modelReference(candidate);
		const nextSequence = reportOutcome(sequence, {
			atMs: options.now(),
			failedModel: input.failedModel,
			candidateModel,
			servingModel,
			outcome: "hop",
			reason: input.reason,
			status: input.status,
		});
		const expectedTail = options.expectedTail();
		const continuation = await options.continuation.continueCurrent(
			expectedTail,
			() => options.dropExpectedTail(expectedTail),
			() => !abort.signal.aborted && active === nextSequence,
		);
		if (continuation === "completed") return { kind: "done", result: "redispatched" } as const;
		if (abort.signal.aborted) return { kind: "done", result: "cancelled" } as const;
		terminate(nextSequence, input.failedModel, continuation);
		return { kind: "done", result: "terminal" } as const;
	};

	const driveRoute = async (
		input: ModelFallbackRoute,
		initialSequence: ModelFallbackSequence,
		abort: AbortController,
	): Promise<ModelFallbackRouteResult> => {
		let sequence = initialSequence;
		while (!abort.signal.aborted) {
			if (options.currentModel() !== input.failedModel) {
				sequence = reportOutcome(sequence, {
					atMs: options.now(),
					failedModel: input.failedModel,
					outcome: "stand-down",
					reason: "peer-model-switch",
				});
				terminate(sequence, input.failedModel, "peer-model-switch");
				return "terminal";
			}

			const selection = selectNextFallbackCandidate(sequence, input.fallbackModels, input.maxHops);
			sequence = selection.sequence;
			active = sequence;
			if (selection.kind === "exhausted") {
				terminate(sequence, input.failedModel, exhaustionReason(sequence, selection.reason), false, input.status);
				return "terminal";
			}

			const candidate = options.resolveCandidate(selection.candidateModel);
			if (candidate === undefined) {
				sequence = reportOutcome(sequence, {
					atMs: options.now(),
					failedModel: input.failedModel,
					candidateModel: selection.candidateModel,
					outcome: "resolution-failed",
					reason: "model-unavailable",
				});
				continue;
			}

			if (options.currentModel() !== input.failedModel) continue;
			const attempt = await attemptCandidate(input, sequence, abort, selection.candidateModel, candidate);
			if (attempt.kind === "done") return attempt.result;
			sequence = attempt.sequence;
		}
		return "cancelled";
	};

	const route = async (input: ModelFallbackRoute): Promise<ModelFallbackRouteResult> => {
		if (input.fallbackModels.length === 0 || input.maxHops === 0) {
			if (!active) return "inert";
			terminate(active, input.failedModel, "provider-exhausted", false, input.status);
			return "terminal";
		}
		if (routeAbort !== undefined) {
			pendingRoute?.resolve("superseded");
			return new Promise((resolve) => {
				pendingRoute = { input, resolve };
			});
		}
		lastFailedModel = input.failedModel;
		const sequence =
			active ??
			createModelFallbackSequence({
				sequenceId: options.nextSequenceId(),
				failedModel: input.failedModel,
				startedAtMs: options.now(),
			});
		active = sequence;
		const abort = new AbortController();
		routeAbort = abort;
		const owner = Symbol("ppie-recover-model-fallback");
		if (!(await options.drivingLock.acquireWhenAvailable(owner, abort.signal))) {
			if (routeAbort === abort) routeAbort = undefined;
			return "cancelled";
		}

		try {
			return await driveRoute(input, sequence, abort);
		} finally {
			options.drivingLock.release(owner);
			if (routeAbort === abort) {
				routeAbort = undefined;
				const queued = pendingRoute;
				pendingRoute = undefined;
				if (queued) {
					if (abort.signal.aborted) queued.resolve("cancelled");
					else void route(queued.input).then(queued.resolve);
				}
			}
		}
	};

	return {
		route,
		cancel: (reason) => {
			routeAbort?.abort();
			pendingRoute?.resolve("cancelled");
			pendingRoute = undefined;
			if (active) terminate(active, lastFailedModel ?? active.originatingModel, reason, true);
		},
		succeed: () => {
			active = undefined;
		},
		activeSequence: () => active,
		isActive: () => active !== undefined || routeAbort !== undefined || pendingRoute !== undefined,
	};
}
