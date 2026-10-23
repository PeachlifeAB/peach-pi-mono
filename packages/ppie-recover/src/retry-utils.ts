import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { outputBudgetDialectOf, withOutputBudget } from "./output-budget-dialect.ts";

export type MessageShape = {
	role?: string;
	stopReason?: string;
	rawStopReason?: string;
	errorMessage?: unknown;
	content?: unknown;
	usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; totalTokens?: number };
	provider?: string;
	model?: string;
	responseModel?: string;
};
// pi-coding-agent's ExtensionRunner.assertActive throws this exact message
// on any ExtensionContext access after ctx.newSession()/ctx.fork()/
// ctx.switchSession()/ctx.reload(). Shared so every detached
// closure/timer that captures a ctx (status.ts, watchdog.ts, retry.ts's
// notify) swallows ONLY this specific, expected error — not an unrelated
// bug that happens to throw from the same try block.
export function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("extension ctx is stale");
}

// oMLX emits heartbeat frames while prefilling a long prompt by sending real
// SSE `data:` chunks whose parsed JSON `model` field is the literal string
// "keepalive" (not the requested model id). Per WHATWG HTML §9.2, an SSE
// line beginning with ':' is required to be ignored at the transport, so
// those never surface as chunks; oMLX's heartbeats deliberately use the
// real-chunk path instead and reach ppie-recover as ordinary assistant messages.
//
// The match uses three signals to distinguish a true prefill heartbeat (no
// output content, the provider is still computing) from a genuine length stop
// where the model produced a tiny response and exhausted its token budget.
// Key: Ornith always sets `model: "keepalive"` on its first stream chunk;
// pi-ai captures this into `responseModel` via `output.responseModel ||=
// chunk.model` and NEVER overwrites it — so responseModel is "keepalive" on
// every Ornith message (tool calls, completions, and heartbeats alike). A
// single-condition check on responseModel alone would false-positive on every
// Ornith response, silently dropping length-stop retry handling.
//
// Therefore the predicate requires both:
//   1. `responseModel === "keepalive"` (the oMLX signal)
//   2. `usage.output === 0` AND `visibleTextLength(message) === 0` (no actual
//      model output — the provider is still prefilling)
//
// A genuine length stop where the model produced even 1 token (visible text)
// falls through to `handleLengthStop` and follows the normal overflow path:
// compact → retry once, then terminal if still tiny.
//
// Reported live (session 019f3f88-fc14-759b-a922-fdf763ee480e, reproduced
// twice — including after clearing the active /goal and restarting pi,
// ruling out any other extension racing ppie-recover): a memory_guard prefill
// rejection fails BEFORE any tokens stream, so on oMLX the failure message
// has the EXACT same zero-output shape as a true heartbeat (responseModel
// "keepalive", usage.output 0, empty content) — but stopReason is "error"
// with a real errorMessage, not a heartbeat frame mid-prefill. Without this
// check, onMessageEnd's `if (isKeepaliveFrame(message)) return;` guard
// silently discarded the error before ever reading errorMessage: zero
// notification, zero retry.
export function isKeepaliveFrame(message: MessageShape): boolean {
	if (message.stopReason === "error") return false;

	return message.responseModel === "keepalive" && message.usage?.output === 0 && visibleTextLength(message) === 0;
}

type ContextUsageShape = {
	contextWindow?: number;
};

export function lastAssistantMessage(ctx: ExtensionContext): MessageShape | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];

		if (entry.type !== "message") continue;

		const message = entry.message as MessageShape;

		if (message.role === "assistant" && !isKeepaliveFrame(message)) {
			return message;
		}
	}
}

export function normalizeErrorSignature(errorMessage: string): string {
	return errorMessage
		.toLowerCase()
		.replace(/\d[\d,.]*/g, "#")
		.replace(/\s+/g, " ")
		.trim();
}

export function contextWindowOf(ctx: ExtensionContext | undefined): number | undefined {
	const usage = (ctx as { getContextUsage?: () => ContextUsageShape } | undefined)?.getContextUsage?.();
	const contextWindow = usage?.contextWindow;
	return Number.isFinite(contextWindow) && contextWindow && contextWindow > 0 ? contextWindow : undefined;
}

export function serializedPayloadLength(payload: unknown): number {
	try {
		return JSON.stringify(payload)?.length ?? 0;
	} catch {
		return 0;
	}
}

// Reported live (session 019f3f88-fc14-759b-a722-fdf763ee480e): a flat
// output-token reserve (DEFAULT_PRUNE_RESERVE_TOKENS=2,000) still produced
// max_tokens=1 dead ends on a session whose real per-turn growth (large
// tool-result content) dwarfs any fixed constant. pi-ai's real
// openai-completions.js sets `params.max_tokens` (or
// `params.max_completion_tokens`, depending on provider compat mode) to
// exactly what the server will use to compute remaining headroom after the
// prompt — the actual quantity that determines whether pruning leaves real
// room to respond, not a guessed constant. Reads it directly off the
// outgoing payload so the prune reserve matches the REAL requested output
// budget for this specific request.
export function requestedMaxOutputTokensOf(payload: unknown): number | undefined {
	const budget = outputBudgetDialectOf(payload);
	return budget && budget.value > 0 ? budget.value : undefined;
}

// Reported concern: pi-ai's real provider adapter computes payload.max_tokens
// (or max_completion_tokens) BEFORE before_provider_request ever runs, based
// on headroom against the UNPRUNED prompt size — so a near-full session can
// clamp it down to as little as 1. Emergency pruning only shrinks `messages`;
// it never recomputed max_tokens against the NEWLY FREED headroom, so a
// successfully-pruned request could still go out capped at one token,
// producing a one-token "The" response even though the prompt itself now
// fits with room to spare. Returns a payload with max_tokens/
// max_completion_tokens raised to use the freed headroom when the original
// value was smaller than what pruning actually freed up — bounded so it
// never exceeds contextWindow, and left untouched if the payload carries
// neither field or pruning did not run.
export function restoreOutputHeadroom(
	payload: unknown,
	options: {
		contextWindow: number | undefined;
		prunedPayloadChars: number;
		charsPerToken: number;
		maxRestoredTokens?: number;
	},
): unknown {
	if (typeof payload !== "object" || payload === null) return payload;
	if (!options.contextWindow) return payload;

	const record = payload as Record<string, unknown>;
	const budget = outputBudgetDialectOf(record);
	if (!budget) return payload;

	const currentValue = budget.value;
	const prunedPromptTokens = Math.ceil(options.prunedPayloadChars / options.charsPerToken);
	const freedHeadroomTokens = options.contextWindow - prunedPromptTokens;

	if (freedHeadroomTokens <= currentValue) return payload;

	const desiredRestoredValue =
		options.maxRestoredTokens === undefined
			? freedHeadroomTokens
			: Math.min(freedHeadroomTokens, options.maxRestoredTokens);
	const restoredValue = Math.max(currentValue, desiredRestoredValue);
	return withOutputBudget(record, budget.field, restoredValue);
}

export function visibleTextLength(message: MessageShape): number {
	const content = message.content;
	if (typeof content === "string") return content.trim().length;
	if (!Array.isArray(content)) return 0;

	return content.reduce((total, part) => {
		if (!part || typeof part !== "object") return total;
		if (!("type" in part) || part.type !== "text") return total;
		if (!("text" in part) || typeof part.text !== "string") return total;
		return total + part.text.trim().length;
	}, 0);
}

export { shouldStopUnshrunkOverflowReplay } from "./retry-replay-guard.ts";
