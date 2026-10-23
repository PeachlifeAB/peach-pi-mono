import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionOutcome } from "./compact.ts";
import type { createCompactionCoordinator } from "./compaction-coordinator.ts";
import type { createEmergencyPruner } from "./emergency-prune.ts";
import type { ErrorClass } from "./error-classifier.ts";
import type { HostCompactionJournal } from "./host-compaction-journal.ts";
import type { CompactionIdentity } from "./recovery-chain.ts";
import type { RecoveryChainDriver } from "./recovery-chain-driver.ts";
import type { PrunePriorities } from "./retry-config.ts";
import type { RecoveryStopCause } from "./setting-tips.ts";

export type NotifyLevel = "info" | "warning" | "error";

export type OverflowRecoveryOptions = {
	getReserveTokens: () => number;
	getPriorities: () => PrunePriorities;
	getMarkers: () => string[];
	getMemoryRemovalFractions?: () => readonly number[];
	setStatus: (ctx: ExtensionContext, value: string, options?: { sticky?: boolean }) => void;
	clearStatus?: (ctx: ExtensionContext) => void;
	peekRecoveryAttempt?: (message?: string) => { attempt: number; limit: number };
	notify: (message: string, level?: NotifyLevel) => void;
	terminal: (ctx: ExtensionContext, message: string, cause?: RecoveryStopCause) => void;
	compact: (ctx: ExtensionContext) => Promise<CompactionOutcome>;
	getFallbackCompactionMaxAttempts?: (ctx: ExtensionContext | undefined) => number;
	getForcedCompactionWaitMs?: () => number;
	coordinator?: ReturnType<typeof createCompactionCoordinator>;
	getCompactionWarningMs?: () => number | undefined;
	getCompactionStallCheckMs?: () => number;
	getCompactionStallRetryMs?: () => number;
	recoveryChainDriver?: RecoveryChainDriver;
	hostCompactionJournal?: HostCompactionJournal;
	isCurrent?: () => boolean;
	createRequestIsCurrent?: () => () => boolean;
};

export type UnclassifiedErrorRecord = {
	errorClass: ErrorClass;
	signature: string;
	count: number;
};

export type OverflowRecoveryState = {
	lastSentPayloadChars?: number;
	lastOutgoingPayloadChars?: number;
	lastErrorSignature?: string;
	activeErrorSignature?: string;
	activeErrorClass?: ErrorClass;
	activeErrorMessage?: string;
	lastShrinkWasIneffective: boolean;
	lastContextPruneRemovedContent: boolean;
	outputHeadroomRestoreArmed: boolean;
	deferredCoreOverflowSignature?: string;
	pendingCoreDefer: boolean;
	memoryGuardCompactionPending: boolean;
	contextFallbackCompactionAttempts: number;
	lifecycleEpoch: number;
	ownBeforeCompactExpected: boolean;
	ownedCompactionIdentity?: CompactionIdentity;
	externalCompactionIdentity?: CompactionIdentity;
	compactionInProgress: boolean;
	unclassifiedErrors: Map<string, UnclassifiedErrorRecord>;
};

export type EmergencyPruner = ReturnType<typeof createEmergencyPruner>;

export function createOverflowRecoveryState(): OverflowRecoveryState {
	return {
		lastShrinkWasIneffective: false,
		lastContextPruneRemovedContent: false,
		outputHeadroomRestoreArmed: false,
		pendingCoreDefer: false,
		memoryGuardCompactionPending: false,
		contextFallbackCompactionAttempts: 0,
		lifecycleEpoch: 0,
		ownBeforeCompactExpected: false,
		compactionInProgress: false,
		unclassifiedErrors: new Map(),
	};
}
