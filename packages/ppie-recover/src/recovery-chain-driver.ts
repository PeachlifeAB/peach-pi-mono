import { debugLog } from "./debug-log.ts";
import {
	type CompactionFailureOutcome,
	type CompactionIdentity,
	type ContinuationOwner,
	createRecoveryChainController,
	type RecoveryChainAction,
	type RecoveryChainController,
	type RecoveryChainTelemetryPort,
	type RecoveryFailureClass,
} from "./recovery-chain.ts";
import type { RetryAdmission } from "./retry-admission.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";

type CompactionAction = Extract<RecoveryChainAction, { kind: "request-compaction" }>;
type ContinuationAction = Extract<RecoveryChainAction, { kind: "continue-provider" }>;
type ReductionAction = Extract<RecoveryChainAction, { kind: "reduce-and-retry" }>;
type TerminalAction = Extract<RecoveryChainAction, { kind: "notify-terminal" }>;

export type RecoveryCompactionLifecycle = Readonly<{
	started(identity: CompactionIdentity): void;
	completed(identity: CompactionIdentity, continuationOwner: ContinuationOwner): void;
	failed(identity: CompactionIdentity, outcome: CompactionFailureOutcome): void;
}>;

export type RecoveryChainExecutionPort = Readonly<{
	requestCompaction(action: CompactionAction, lifecycle: RecoveryCompactionLifecycle): "accepted" | "not-accepted";
	continueProvider(action: ContinuationAction): void;
	reduceAndRetry(action: ReductionAction): void;
	notifyTerminal(action: TerminalAction): void;
}>;

export type RecoveryChainDriver = Readonly<{
	recover(
		failureClass: RecoveryFailureClass,
		signature: string,
		port: RecoveryChainExecutionPort,
		replayCompactions?: (lifecycle: RecoveryCompactionLifecycle) => void,
	): void;
	observeCompactionStarted(identity: CompactionIdentity): void;
	observeCompactionCompleted(identity: CompactionIdentity, continuationOwner: ContinuationOwner): void;
	observeCompactionFailure(identity: CompactionIdentity, outcome: CompactionFailureOutcome): void;
	observeContinuation(source: "agent-steer" | "external-extension", demandId: string): void;
	observeProviderProgress(input: { stopReason: "stop" | "toolUse" | "error" | "aborted"; hasError: boolean }): void;
	cancel(reason: string): void;
	changeGeneration(generation: string): void;
	isActive(): boolean;
}>;

export function createRecoveryChainDriver(controller: RecoveryChainController): RecoveryChainDriver {
	let currentPort: RecoveryChainExecutionPort | undefined;

	const drive = (): void => {
		const port = currentPort;
		const action = controller.nextAction();
		if (!port || !action) return;
		try {
			if (action.kind === "request-compaction") {
				const lifecycle: RecoveryCompactionLifecycle = {
					started: (identity) => controller.observe({ type: "compaction-started", ...identity }),
					completed: (identity, continuationOwner) => {
						controller.observe({
							type: "compaction-finished",
							...identity,
							outcome: "completed",
							continuationOwner,
						});
						drive();
					},
					failed: (identity, outcome) => {
						controller.observe({ type: "compaction-finished", ...identity, outcome });
						drive();
					},
				};
				if (port.requestCompaction(action, lifecycle) === "accepted") {
					controller.observe({ type: "action-started", actionId: action.id });
				}
				return;
			}

			controller.observe({ type: "action-started", actionId: action.id });
			if (action.kind === "notify-terminal") port.notifyTerminal(action);
			else if (action.kind === "continue-provider") port.continueProvider(action);
			else port.reduceAndRetry(action);
			controller.observe({ type: "action-finished", actionId: action.id, outcome: "succeeded" });
		} catch {
			controller.observe({ type: "action-finished", actionId: action.id, outcome: "failed" });
			drive();
		}
	};

	return {
		recover: (failureClass, signature, port, replayCompactions) => {
			currentPort = port;
			controller.observe({ type: "failure-observed", failureClass, signature });
			replayCompactions?.({
				started: (identity) => controller.observe({ type: "compaction-started", ...identity }),
				completed: (identity, continuationOwner) =>
					controller.observe({
						type: "compaction-finished",
						...identity,
						outcome: "completed",
						continuationOwner,
					}),
				failed: (identity, outcome) => controller.observe({ type: "compaction-finished", ...identity, outcome }),
			});
			drive();
		},
		observeCompactionStarted: (identity) => {
			controller.observe({ type: "compaction-started", ...identity });
		},
		observeCompactionCompleted: (identity, continuationOwner) => {
			controller.observe({
				type: "compaction-finished",
				...identity,
				outcome: "completed",
				continuationOwner,
			});
			drive();
		},
		observeCompactionFailure: (identity, outcome) => {
			controller.observe({ type: "compaction-finished", ...identity, outcome });
			drive();
		},
		observeContinuation: (source, demandId) => {
			controller.observe({ type: "continuation-observed", source, demandId });
		},
		observeProviderProgress: (input) => {
			controller.observe({ type: "provider-progress", ...input });
		},
		cancel: (reason) => controller.observe({ type: "cancelled", reason }),
		changeGeneration: (next) => controller.observe({ type: "generation-changed", generation: next }),
		isActive: () => controller.snapshot() !== undefined,
	};
}

/** The recovery chain as the runtime wires it: policy budgets, pacing from the retry rules. */
export function createRuntimeRecoveryChainDriver(input: {
	policy: ResolvedRetryPolicy;
	admission: Pick<RetryAdmission, "maxAttemptsFor" | "delayMsForError">;
	telemetry?: RecoveryChainTelemetryPort;
}): RecoveryChainDriver {
	const { policy, admission, telemetry } = input;
	let nextRecoveryChainId = 0;
	const controller = createRecoveryChainController({
		generation: "generation-0",
		policy: {
			forcedCompactionAttempts: policy.fallbackCompactionMaxAttempts,
			maxPruningAttempts: policy.maxPruningAttempts,
			maxProviderRetryAttempts: admission.maxAttemptsFor,
		},
		delayMsForCompactionAttempt: (_trigger, attempt, failureMessage) =>
			admission.delayMsForError(failureMessage, attempt),
		nextChainId: () => `recovery-chain-${++nextRecoveryChainId}`,
		telemetry: {
			onEvent: (event) => {
				debugLog("recovery_chain.event", event);
				telemetry?.onEvent(event);
			},
		},
	});
	return createRecoveryChainDriver(controller);
}
