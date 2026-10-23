import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCompactionSummarizationPayload } from "./compaction-summarization-payload.ts";
import { debugLog } from "./debug-log.ts";
import { isOutputBudgetExhaustion, outputBudgetDialectOf, withOutputBudget } from "./output-budget-dialect.ts";
import { contextWindowOf, type MessageShape } from "./retry-utils.ts";

type PendingOutputBudgetRepair = Readonly<{
	generation: number;
	expectedValue: number;
	targetValue: number;
}>;

type LastObservedRequest = Readonly<{
	generation: number;
	value: number;
	isCompactionSummary: boolean;
}>;

export type ResponsesOutputBudgetRecovery = Readonly<{
	observeOutgoingRequest(payload: unknown, ctx: ExtensionContext): void;
	classifyMessageEnd(message: MessageShape, ctx: ExtensionContext): boolean;
	applyPendingRepair(payload: unknown, ctx: ExtensionContext): unknown;
	onAgentSettled(): void;
	onProviderProgress(): void;
	resetTurn(): void;
	resetSession(): void;
	hasPending(): boolean;
}>;

export function createResponsesOutputBudgetRecovery(options: {
	regenerateLengthOverflow: () => void;
	showRetryStatus: (ctx: ExtensionContext) => void;
	terminal: (ctx: ExtensionContext | undefined, message: string) => void;
	latestContext: () => ExtensionContext | undefined;
}): ResponsesOutputBudgetRecovery {
	let currentGeneration = 0;
	let lastObservedRequest: LastObservedRequest | undefined;
	let pendingRepair: PendingOutputBudgetRepair | undefined;
	let appliedRepairInTurn: PendingOutputBudgetRepair | undefined;

	const clearPending = () => {
		pendingRepair = undefined;
	};

	const resetTurn = () => {
		currentGeneration++;
		clearPending();
		appliedRepairInTurn = undefined;
		lastObservedRequest = undefined;
	};

	const resetSession = () => {
		resetTurn();
	};

	const onProviderProgress = () => {
		clearPending();
		appliedRepairInTurn = undefined;
	};

	const observeOutgoingRequest = (payload: unknown, _ctx: ExtensionContext): void => {
		if (typeof payload !== "object" || payload === null) return;
		const isCompactionSummary = isCompactionSummarizationPayload(payload);
		const outputBudget = outputBudgetDialectOf(payload);
		if (!outputBudget || outputBudget.value <= 0) return;

		lastObservedRequest = {
			generation: currentGeneration,
			value: outputBudget.value,
			isCompactionSummary,
		};
	};

	const classifyMessageEnd = (message: MessageShape, ctx: ExtensionContext): boolean => {
		if (!lastObservedRequest) return false;
		if (lastObservedRequest.generation !== currentGeneration) return false;
		if (lastObservedRequest.isCompactionSummary) return false;
		if (!isOutputBudgetExhaustion(message)) return false;

		const outputTokens = message.usage?.output;
		if (outputTokens !== undefined && outputTokens < lastObservedRequest.value) return false;

		const usage = message.usage;
		const promptTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
		if (promptTokens <= 0) return false;

		const contextWindow = contextWindowOf(ctx);
		if (!contextWindow || contextWindow <= 0) return false;
		const availableOutputTokens = contextWindow - promptTokens;
		if (availableOutputTokens <= lastObservedRequest.value) return false;

		const modelMaxTokens = (ctx.model as { maxTokens?: number } | undefined)?.maxTokens;
		if (typeof modelMaxTokens !== "number" || modelMaxTokens <= lastObservedRequest.value) return false;

		// Guard: Do not perform a second stale repair in the same turn without progress
		if (appliedRepairInTurn !== undefined) {
			options.terminal(
				ctx,
				`Stale output-budget recovery stopped: outgoing request remained constrained to ${lastObservedRequest.value} tokens.`,
			);
			return false;
		}

		const targetValue = Math.min(modelMaxTokens, availableOutputTokens);
		pendingRepair = {
			generation: currentGeneration,
			expectedValue: lastObservedRequest.value,
			targetValue,
		};

		debugLog("responses_output_budget.repair_pending", {
			targetValue,
			availableOutputTokens,
			modelMaxTokens,
			promptTokens,
		});

		return true;
	};

	const applyPendingRepair = (payload: unknown, _ctx: ExtensionContext): unknown => {
		if (typeof payload !== "object" || payload === null) return payload;
		if (isCompactionSummarizationPayload(payload)) return payload;
		if (!pendingRepair || pendingRepair.generation !== currentGeneration) return payload;
		const record = payload as Record<string, unknown>;
		const outputBudget = outputBudgetDialectOf(record);
		if (!outputBudget) return payload;
		if (outputBudget.value !== pendingRepair.expectedValue) {
			clearPending();
			return payload;
		}

		const finalTarget = pendingRepair.targetValue;

		appliedRepairInTurn = pendingRepair;
		clearPending();

		debugLog("responses_output_budget.repair_applied", {
			field: outputBudget.field,
			from: outputBudget.value,
			to: finalTarget,
		});

		return withOutputBudget(record, outputBudget.field, finalTarget);
	};

	const onAgentSettled = (): void => {
		if (!pendingRepair || pendingRepair.generation !== currentGeneration) return;
		const ctx = options.latestContext();
		if (ctx) options.showRetryStatus(ctx);
		options.regenerateLengthOverflow();
	};

	return {
		observeOutgoingRequest,
		classifyMessageEnd,
		applyPendingRepair,
		onAgentSettled,
		onProviderProgress,
		resetTurn,
		resetSession,
		hasPending: () => pendingRepair !== undefined && pendingRepair.generation === currentGeneration,
	};
}
