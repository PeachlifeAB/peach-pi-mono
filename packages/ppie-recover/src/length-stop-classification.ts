import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contextWindowOf, type MessageShape, visibleTextLength } from "./retry-utils.ts";

export type LengthStopClass = "overflow" | "truncation";

export type LengthStopInput = {
	visibleTextChars: number;
	minTruncationTextChars: number;
};

// Visible output is the observable contract: tiny means no output headroom;
// substantial means the response itself was truncated. Shared recovery budget
// bounds autonomous retries instead of guessing provider memory from fullness.
export function classifyLengthStop({ visibleTextChars, minTruncationTextChars }: LengthStopInput): LengthStopClass {
	return visibleTextChars < minTruncationTextChars ? "overflow" : "truncation";
}

export type GeneratedProgress = "tiny" | "substantial";
export type ContextPressure = "has-headroom" | "needs-compaction" | "unknown";
export type LengthRecoveryPlan =
	| "compact-then-regenerate"
	| "follow-up-now"
	| "compact-then-follow-up"
	| "conservative-stop";

export function classifyGeneratedProgress(message: MessageShape, minTruncationTextChars: number): GeneratedProgress {
	// 1. Visible text progress
	if (visibleTextLength(message) >= minTruncationTextChars) {
		return "substantial";
	}

	// Usage is authoritative when the provider reports generated tokens.
	const outputTokens = message.usage?.output;
	if (typeof outputTokens === "number" && outputTokens >= minTruncationTextChars) return "substantial";

	// Without usage, require the same threshold from captured reasoning content.
	if (outputTokens === undefined) {
		const content = message.content;
		if (Array.isArray(content)) {
			const thinkingChars = content.reduce((sum, p) => {
				if (
					p &&
					typeof p === "object" &&
					"type" in p &&
					p.type === "thinking" &&
					"thinking" in p &&
					typeof p.thinking === "string"
				) {
					return sum + p.thinking.trim().length;
				}
				return sum;
			}, 0);
			if (thinkingChars >= minTruncationTextChars) {
				return "substantial";
			}
		}
	}

	return "tiny";
}

export function classifyContextPressure(ctx: ExtensionContext, message: MessageShape): ContextPressure {
	const contextWindow = contextWindowOf(ctx);
	if (!contextWindow || contextWindow <= 0) {
		return "unknown";
	}

	const usage = message.usage;
	if (!usage) {
		return "unknown";
	}

	const totalTokens =
		typeof usage.totalTokens === "number" && usage.totalTokens > 0
			? usage.totalTokens
			: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);

	if (totalTokens <= 0) {
		return "unknown";
	}

	const remaining = contextWindow - totalTokens;
	const modelMaxTokens = (ctx.model as { maxTokens?: number } | undefined)?.maxTokens;
	if (typeof modelMaxTokens !== "number" || modelMaxTokens <= 0) return "unknown";
	return remaining > modelMaxTokens ? "has-headroom" : "needs-compaction";
}

export function planLengthRecovery(input: {
	progress: GeneratedProgress;
	pressure: ContextPressure;
}): LengthRecoveryPlan {
	if (input.progress === "substantial") {
		if (input.pressure === "has-headroom") return "follow-up-now";
		if (input.pressure === "needs-compaction") return "compact-then-follow-up";
		return "conservative-stop";
	}
	// progress === "tiny"
	if (input.pressure === "needs-compaction") return "compact-then-regenerate";
	if (input.pressure === "has-headroom") return "compact-then-regenerate";
	return "conservative-stop";
}

const contextWasReduced = (before: number | undefined, after: number | undefined): boolean =>
	before !== undefined && after !== undefined && after < before;

const maySendAfterCompaction = (before: number | undefined, after: number | undefined, completed: boolean): boolean =>
	completed && ((before === undefined && after === undefined) || contextWasReduced(before, after));

export function usageTokens(ctx: ExtensionContext): number | undefined {
	const tokens = ctx.getContextUsage?.()?.tokens;
	return typeof tokens === "number" && tokens > 0 ? tokens : undefined;
}

export function clampedReplayStop(
	before: number | undefined,
	after: number | undefined,
	completed: boolean,
): string | undefined {
	return maySendAfterCompaction(before, after, completed)
		? undefined
		: "Output-limit recovery stopped: context was not reduced, so the request was not sent.";
}
