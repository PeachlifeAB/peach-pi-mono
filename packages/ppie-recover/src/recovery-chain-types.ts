import type { RecoveryStopCause } from "./setting-tips.ts";

export type RecoveryFailureClass = "context-overflow" | "memory-guard";
export type RecoveryTrigger = RecoveryFailureClass;
export type CompactionOwner = "ppie-recover" | "external";
export type ContinuationOwner = "core" | "ppie-recover";
export type RecoveryActionOutcome = "succeeded" | "failed" | "cancelled";
export type CompactionFailureOutcome = "failed-memory-guard" | "unavailable" | "aborted" | "stalled";

export type RecoveryChainPolicy = Readonly<{
	/** Forced compactions before recovery falls through to pruning. Governs every trigger. */
	forcedCompactionAttempts: number;
	/** Prune attempts, counted separately from provider retries. 0 disables pruning. */
	maxPruningAttempts: number;
	maxProviderRetryAttempts: (failureSignature: string) => number;
}>;

type ActionBase = Readonly<{
	id: string;
	chainId: string;
}>;

export type RecoveryChainAction =
	| (ActionBase & {
			readonly kind: "request-compaction";
			readonly trigger: RecoveryTrigger;
			readonly attempt: number;
			readonly delayMs: number;
	  })
	| (ActionBase & {
			readonly kind: "continue-provider";
			readonly trigger: RecoveryTrigger;
			readonly attempt: number;
	  })
	| (ActionBase & {
			readonly kind: "reduce-and-retry";
			readonly trigger: RecoveryTrigger;
			readonly attempt: number;
			readonly pipeline: "reduction";
	  })
	| (ActionBase & {
			readonly kind: "notify-terminal";
			readonly reason: string;
			/** Set when a disabled setting could have continued this chain. */
			readonly cause?: RecoveryStopCause;
	  });

export type CompactionIdentity = Readonly<{
	owner: CompactionOwner;
	requestId: string;
	lifecycleEpoch: number;
}>;

export type RecoveryChainEvent =
	| Readonly<{
			type: "failure-observed";
			failureClass: RecoveryFailureClass;
			signature: string;
	  }>
	| Readonly<{ type: "action-started"; actionId: string }>
	| Readonly<{
			type: "action-finished";
			actionId: string;
			outcome: RecoveryActionOutcome;
	  }>
	| ({ readonly type: "compaction-started" } & CompactionIdentity)
	| ({
			readonly type: "compaction-finished";
			readonly outcome: "completed";
			readonly continuationOwner: ContinuationOwner;
	  } & CompactionIdentity)
	| ({
			readonly type: "compaction-finished";
			readonly outcome: CompactionFailureOutcome;
	  } & CompactionIdentity)
	| Readonly<{
			type: "continuation-observed";
			source: "agent-steer" | "external-extension";
			demandId: string;
	  }>
	| Readonly<{
			type: "provider-progress";
			stopReason: "stop" | "toolUse" | "error" | "aborted";
			hasError: boolean;
	  }>
	| Readonly<{ type: "cancelled"; reason: string }>
	| Readonly<{ type: "generation-changed"; generation: string }>;

export type RecoveryChainSnapshot = Readonly<{
	id: string;
	generation: string;
	status: "recovering" | "terminal";

	activeFailure: Readonly<{
		failureClass: RecoveryFailureClass;
		signature: string;
	}>;
	activeActionId: string | undefined;
	pendingDemandIds: readonly string[];
	providerRetryAttempts: number;
	compactionAttempts: Readonly<{
		contextOverflow: number;
		memoryGuard: number;
	}>;
}>;

type TelemetryBase = Readonly<{ chainId: string; generation: string }>;
type CompactionTelemetry = TelemetryBase & CompactionIdentity & Readonly<{ attempt: number }>;

type RecoveryChainClosureReason = "verified-progress" | "cancelled" | "generation-changed" | "terminal-notified";

export type RecoveryChainTelemetryEvent =
	| (TelemetryBase & Readonly<{ type: "chain-opened"; trigger: RecoveryTrigger }>)
	| (TelemetryBase & Readonly<{ type: "chain-closed"; reason: RecoveryChainClosureReason }>)
	| (TelemetryBase &
			Readonly<{
				type: "action-admitted";
				actionId: string;
				kind: RecoveryChainAction["kind"];
				trigger?: RecoveryTrigger;
				attempt?: number;
			}>)
	| (TelemetryBase &
			Readonly<{
				type: "action-finished";
				actionId: string;
				kind: RecoveryChainAction["kind"];
				outcome: RecoveryActionOutcome;
			}>)
	| (TelemetryBase &
			Readonly<{
				type: "continuation-observed";
				source: "agent-steer" | "external-extension";
				demandId: string;
			}>)
	| (CompactionTelemetry & Readonly<{ type: "compaction-started" }>)
	| (CompactionTelemetry &
			Readonly<{
				type: "compaction-finished";
				outcome: "completed" | CompactionFailureOutcome;
				continuationOwner?: ContinuationOwner;
			}>);

export type RecoveryChainTelemetryPort = Readonly<{
	onEvent(event: RecoveryChainTelemetryEvent): void;
}>;

export type RecoveryChainController = Readonly<{
	observe(event: RecoveryChainEvent): void;
	nextAction(): RecoveryChainAction | undefined;
	snapshot(): RecoveryChainSnapshot | undefined;
}>;
