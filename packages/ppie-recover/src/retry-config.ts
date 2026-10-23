// triggerRetry checks ctx.hasPendingMessages() before starting a retry, to
// avoid injecting a retry prompt([]) on top of messages pi-core already has
// queued. Reported live: this check previously silently dropped the ENTIRE
// retry attempt forever with zero notification when pending messages
// existed at that exact instant (e.g. right after a large prior turn) —
// the user just saw the original error and then permanent silence. Now it
// polls at this interval, up to PENDING_MESSAGES_MAX_WAIT_MS, notifying
// once so the stall is visible instead of silent.
export const PENDING_MESSAGES_POLL_MS = 2000;
export const PENDING_MESSAGES_MAX_WAIT_MS = 30_000;

export const STATUS_KEY = "ppie-recover";
export const STATUS_VISIBLE_MS = 8000;

export const DEFAULT_PRUNE_RESERVE_TOKENS = 2000;
export const DEFAULT_CHARS_PER_TOKEN = 4;
export const MIN_TEXT_KEEP_CHARS = 400;
// A repeated no-progress prune stall (shouldStopUnshrunkOverflowReplay in
// retry-utils.ts would otherwise terminal here) means MIN_TEXT_KEEP_CHARS
// was too conservative for how oversized this session actually is — halved
// per stall past the first so later attempts can find real headroom the
// flat floor was withholding, never below this floor: a truncation marker
// plus a shred of context beats a hard terminal, but text pruned to nothing
// is indistinguishable from a dropped message.
export const MIN_TEXT_KEEP_CHARS_FLOOR = 50;
// The reported overage is a real, server-measured token count (parsed fresh
// from each retry's own error message, not guessed) — but converting "N
// tokens to remove" into "how many chars to delete" still goes through the
// flat DEFAULT_CHARS_PER_TOKEN estimate, since ppie-recover prunes an arbitrary
// provider JSON payload by character count and has no access to the actual
// model's tokenizer (this repo targets multiple providers/local models, not
// just one tokenizer family). A flat percentage overshoot on the char
// budget costs a little extra truncation on an already-failing turn in
// exchange for meaningfully reducing how often a second stall is needed at
// all.
export const PRUNE_BUDGET_MARGIN = 0.1;
// Emergency pruning takes content from the MIDDLE of the transcript first:
// the head (first ~20% — system/early framing that defines the task) and the
// tail (last ~30% — the freshest turns the model is actively working from)
// are only touched when the middle band cannot satisfy the target on its own.
// Reported live (2026-07-14, session 019f60ad fork): the previous
// priority-only selection ate the freshest tool output as eagerly as stale
// middle history.
export const PRUNE_BAND_HEAD_FRACTION = 0.2;
export const PRUNE_BAND_TAIL_FRACTION = 0.3;
// Last-resort memory bytes/token estimate only when the provider reports an
// exact predicted-byte overage but omits request KV allocation and context
// length. When KV bytes + kv_len are present, emergency-prune-parse.ts derives
// this ratio from that request instead; observed oMLX values vary enough that a
// fixed ratio otherwise under-prunes badly.
export const DEFAULT_MEMORY_GUARD_BYTES_PER_TOKEN = 128_000;

export type PrunePriorities = {
	marker: number;
	tool: number;
	assistant: number;
	oldUser: number;
	other: number;
	system: number;
	latestUser: number;
};

export const DEFAULT_PRUNE_PRIORITIES: PrunePriorities = {
	marker: 100,
	tool: 95,
	assistant: 70,
	oldUser: 60,
	other: 30,
	system: 25,
	latestUser: 5,
};

export const DEFAULT_PRUNE_MARKERS: string[] = ["llm wiki", "wiki", "recall", "retrieval"];
