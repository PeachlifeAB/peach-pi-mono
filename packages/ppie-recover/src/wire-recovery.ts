import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { createRetryEngine } from "./agent-retry.ts";
import type { RetryContinuationPort } from "./agent-retry-types.ts";
import type { createCompact } from "./compact.ts";
import type { createCompactionCoordinator } from "./compaction-coordinator.ts";
import { debugLog } from "./debug-log.ts";
import type { HostCompactionJournal } from "./host-compaction-journal.ts";
import { createLengthStopHandler } from "./length-stop.ts";
import { createModelFallbackCoordinator, type ModelFallbackCoordinator } from "./model-fallback-coordinator.ts";
import {
	canonicalModelReference,
	resolveFallbackCandidate,
	withoutExpectedFailedAssistantTail,
} from "./model-fallback-model.ts";
import { createModelFallbackReporter } from "./model-fallback-reporting.ts";
import { createOverflowRecovery } from "./overflow-recovery.ts";
import type { createPendingMessagesGate } from "./pending-messages.ts";
import { agentForManager } from "./pi-agent-session-retry-adapter.ts";
import type { RecoveryBudget } from "./recovery-budget.ts";
import type { RecoveryChainDriver } from "./recovery-chain-driver.ts";
import type { RetryAdmission } from "./retry-admission.ts";
import type { PrunePriorities } from "./retry-config.ts";
import type { RetryDrivingLock } from "./retry-driving-lock.ts";
import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";
import type { RecoveryStopCause } from "./setting-tips.ts";
import type { createStatusController } from "./status.ts";

type StatusController = ReturnType<typeof createStatusController>;
type CtxGetter = () => ExtensionContext | undefined;
type Notify = (message: string, level?: "info" | "warning" | "error") => void;
type Terminal = (ctx: ExtensionContext | undefined, message: string, cause?: RecoveryStopCause) => void;

type WireRecoveryDeps = {
	pi: ExtensionAPI;
	policy: ResolvedRetryPolicy;
	setStatus: StatusController["setStatus"];
	clearStatus: StatusController["clearStatus"];
	peekRecoveryAttempt: RecoveryBudget["peek"];
	notify: Notify;
	terminal: Terminal;
	compact: ReturnType<typeof createCompact>;
	coordinator: ReturnType<typeof createCompactionCoordinator>;
	drivingLock: RetryDrivingLock;
	continuation: RetryContinuationPort;
	recoveryChainDriver: RecoveryChainDriver;
	hostCompactionJournal: HostCompactionJournal;
	latestContext: CtxGetter;
	createRequestIsCurrent: () => () => boolean;
};

type WiredRecovery = {
	recovery: ReturnType<typeof createOverflowRecovery>;
	fallback: ModelFallbackCoordinator;
};

export function wireRecovery(deps: WireRecoveryDeps): WiredRecovery {
	const { pi, policy, setStatus, notify, terminal, compact, coordinator } = deps;
	const trim = policy.trimPayloadOnMemoryOverflow;
	const priorities: PrunePriorities = {
		marker: trim === false ? 0 : trim.target_priorities.marked_blocks,
		tool: trim === false ? 0 : trim.target_priorities.tool_results,
		assistant: trim === false ? 0 : trim.target_priorities.assistant_turns,
		oldUser: 0,
		other: 0,
		system: 0,
		latestUser: 0,
	};
	const recovery = createOverflowRecovery({
		getReserveTokens: () => (trim === false ? 0 : trim.extra_overage_tokens),
		getPriorities: () => priorities,
		getMarkers: () => (trim === false ? [] : [...trim.block_markers]),
		getMemoryRemovalFractions: () => (trim === false ? [] : trim.removal_fractions),
		setStatus,
		clearStatus: deps.clearStatus,
		peekRecoveryAttempt: deps.peekRecoveryAttempt,
		notify,
		terminal,
		compact,
		coordinator,
		getFallbackCompactionMaxAttempts: () => policy.fallbackCompactionMaxAttempts,
		getForcedCompactionWaitMs: () => policy.forcedCompactionWaitMs,
		getCompactionWarningMs: () => policy.compactionWarningMs,
		getCompactionStallCheckMs: () => policy.compactionStallCheckMs,
		getCompactionStallRetryMs: () => policy.compactionStallRetryMs,
		recoveryChainDriver: deps.recoveryChainDriver,
		hostCompactionJournal: deps.hostCompactionJournal,
		createRequestIsCurrent: deps.createRequestIsCurrent,
	});
	const reportFallback = createModelFallbackReporter({
		pi,
		mode: () => deps.latestContext()?.mode ?? "print",
	});
	const fallback = createModelFallbackCoordinator({
		drivingLock: deps.drivingLock,
		continuation: deps.continuation,
		currentModel: () => {
			const ctx = deps.latestContext();
			return ctx?.model ? canonicalModelReference(ctx.model) : undefined;
		},
		resolveCandidate: (reference) => {
			const ctx = deps.latestContext();
			if (!ctx) return undefined;
			const availableModels = ctx.scopedModels.length === 0 ? ctx.modelRegistry.getAvailable() : [];
			return resolveFallbackCandidate(reference, ctx.scopedModels, availableModels);
		},
		setModel: (model) => pi.setModel(model),
		modelReference: canonicalModelReference,
		expectedTail: () => {
			const ctx = deps.latestContext();
			const agent = ctx ? agentForManager(ctx.sessionManager) : null;
			return agent?.state.messages.at(-1);
		},
		dropExpectedTail: (expectedTail) => {
			const ctx = deps.latestContext();
			const agent = ctx ? agentForManager(ctx.sessionManager) : null;
			if (!agent) return;
			agent.state.messages = withoutExpectedFailedAssistantTail(agent.state.messages, expectedTail);
		},
		report: (record) => {
			debugLog("model_fallback.record", record);
			reportFallback(record);
		},
		now: Date.now,
		nextSequenceId: randomUUID,
	});
	return { recovery, fallback };
}

type WireLengthStopDeps = {
	pi: ExtensionAPI;
	policy: ResolvedRetryPolicy;
	setStatus: StatusController["setStatus"];
	clearStatus: StatusController["clearStatus"];
	showRetryStatus: StatusController["showRetryStatus"];
	notify: Notify;
	terminal: Terminal;
	compact: ReturnType<typeof createCompact>;
	coordinator: ReturnType<typeof createCompactionCoordinator>;
	recoveryBudget: RecoveryBudget;
	retryAdmission: RetryAdmission;
	recovery: ReturnType<typeof createOverflowRecovery>;
	engine: ReturnType<typeof createRetryEngine>;
	pendingMessagesGate: ReturnType<typeof createPendingMessagesGate>;
	createRequestIsCurrent: () => () => boolean;
};

export function wireLengthStop(deps: WireLengthStopDeps): ReturnType<typeof createLengthStopHandler> {
	const { pi, policy, recovery, engine } = deps;
	return createLengthStopHandler({
		pi,
		setStatus: deps.setStatus,
		clearStatus: deps.clearStatus,
		showRetryStatus: deps.showRetryStatus,
		notify: deps.notify,
		terminal: deps.terminal,
		compact: deps.compact,
		consumeRecoveryAttempt: deps.recoveryBudget.consume,
		peekRecoveryAttempt: () => deps.recoveryBudget.peek(),
		coordinator: deps.coordinator,
		getOverflowRetryDelayMs: () => deps.retryAdmission.delayMsForError("context overflow", 1),
		getCompactionWarningMs: () => policy.compactionWarningMs,
		getCompactionStallCheckMs: () => policy.compactionStallCheckMs,
		getCompactionStallRetryMs: () => policy.compactionStallRetryMs,
		createRequestIsCurrent: deps.createRequestIsCurrent,
		regenerateLengthOverflow: engine.regenerateLengthOverflow,
		armOutputHeadroomRestore: recovery.armOutputHeadroomRestore,
		pendingMessagesGate: deps.pendingMessagesGate,
	});
}
