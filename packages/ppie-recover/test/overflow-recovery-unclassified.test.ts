import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactionOutcome } from "../src/compact.ts";
import { createCompactionCoordinator } from "../src/compaction-coordinator.ts";
import { createOverflowRecovery } from "../src/overflow-recovery.ts";
import { DEFAULT_PRUNE_PRIORITIES } from "../src/retry-config.ts";

const completed = (): CompactionOutcome => ({ kind: "completed" });
const defaultCoordinator = () =>
	createCompactionCoordinator({
		defer: (delayMs, callback) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	});
const buildRecovery = (overrides: { compact?: () => Promise<CompactionOutcome> } = {}) =>
	createOverflowRecovery({
		getReserveTokens: () => 2000,
		getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
		getMarkers: () => [],
		setStatus: () => {},
		notify: () => {},
		terminal: () => {},
		compact: overrides.compact ?? (async () => completed()),
		coordinator: defaultCoordinator(),
		getFallbackCompactionMaxAttempts: () => 2,
		getCompactionWarningMs: () => undefined,
		isCurrent: () => true,
	});

test("context-overflow tracking alone never arms memory-only payload trimming", () => {
	const recovery = buildRecovery();
	const ctx = { getContextUsage: () => ({ contextWindow: 1000 }) } as unknown as ExtensionContext;
	const messages = [
		{ role: "assistant", content: "x".repeat(40_000) },
		{ role: "user", content: "continue" },
	] as never;
	const error = "400 Prompt too long: 2000 tokens exceeds max context window of 1000 tokens";

	recovery.classifyAndTrack(error);
	assert.equal(recovery.beforeContext({ messages }, ctx), undefined);
});

test("classifyAndTrack records an unclassified transient fallthrough, not an explicit transport error", () => {
	const recovery = buildRecovery();

	recovery.classifyAndTrack("fetch failed: ECONNREFUSED");
	assert.deepEqual(
		recovery.listUnclassifiedErrors(),
		[],
		"a real transport error matching TRANSIENT_RE must not be recorded as unclassified",
	);

	recovery.classifyAndTrack("prefill_quantization_mismatch: KV head count differs from config 42 vs 64");
	const unclassified = recovery.listUnclassifiedErrors();
	assert.equal(unclassified.length, 1);
	assert.equal(unclassified[0]?.errorClass, "transient");
	assert.equal(unclassified[0]?.signature, "prefill_quantization_mismatch: kv head count differs from config # vs #");
	assert.equal(unclassified[0]?.count, 1);
});

test("classifyAndTrack dedupes repeated unclassified errors by redacted signature and bumps the count", () => {
	const recovery = buildRecovery();

	recovery.classifyAndTrack("novel_provider_error: chunk 111 overran buffer");
	recovery.classifyAndTrack("novel_provider_error: chunk 222 overran buffer");
	recovery.classifyAndTrack("novel_provider_error: chunk 333 overran buffer");

	const unclassified = recovery.listUnclassifiedErrors();
	assert.equal(unclassified.length, 1, "same redacted shape must dedupe");
	assert.equal(unclassified[0]?.count, 3);
});

test("permanent, rate_limit, context_overflow, and memory_guard classifications are never recorded as unclassified", () => {
	const recovery = buildRecovery();

	recovery.classifyAndTrack("invalid api key");
	recovery.classifyAndTrack("429 rate limit exceeded, retry later");
	recovery.classifyAndTrack("400 Prompt too long: 2000 tokens exceeds max context window of 1000 tokens");
	recovery.classifyAndTrack(
		"400 prefill_memory_exceeded: estimated bytes 54.92 GB exceeds metal_cap 51.34 GB resident memory",
	);

	assert.deepEqual(recovery.listUnclassifiedErrors(), []);
});

// Scope note: this proves ONLY that ppie-recover's own dedup guard
// (deferredCoreOverflowSignature) is turn-scoped, not permanent — so a
// terminaled overflow can defer-and-wait again on the next turn if the
// identical error recurs. It says nothing about whether pi-core or another
// extension will have actually compacted/healed the session by then; that is
// an external system this repo cannot observe or control, and is NOT
// asserted here. See the discussion this test was written to settle: can we
// be sure something outside ppie-recover breaks the loop? No — this test shows
// only that ppie-recover itself does not permanently latch the failure.
test("resetTurn clears the defer dedup guard, so an identical recurring overflow re-enters the full defer-and-wait cycle on the next turn", async () => {
	const terminalCalls: string[] = [];
	let deferCount = 0;
	const recovery = createOverflowRecovery({
		getReserveTokens: () => 2000,
		getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
		getMarkers: () => [],
		setStatus: () => {},
		notify: () => {},
		terminal: (_ctx, message) => {
			terminalCalls.push(message);
		},
		compact: async () => ({
			kind: "nothing-to-compact",
			error: new Error("Nothing to compact"),
		}),
	});

	const errorMessage =
		'prompt is too long: 98278 tokens exceeds the context window of 72099 tokens (400: {"message":"Prompt too long: 98278 tokens exceeds max context window of 72099 tokens","type":"invalid_request_error","param":null,"code":null})';

	const deferOnce = () => {
		const { signature } = recovery.classifyAndTrack(errorMessage);
		const deferred = recovery.shouldDeferToCore(errorMessage, signature);
		if (deferred) deferCount++;
		return deferred;
	};

	// Turn 1: first occurrence defers to core as normal.
	assert.equal(deferOnce(), true, "the first occurrence must defer to core");

	// Same turn, same signature: ppie-recover's dedup guard must suppress a
	// second defer-and-wait cycle for the identical error while the turn is
	// still open (this is the mechanism the earlier -- possibly incomplete --
	// "bounded" claim rested on).
	assert.equal(
		deferOnce(),
		false,
		"a second occurrence of the identical signature within the same turn must not re-defer",
	);
	assert.equal(deferCount, 1, "only one defer-and-wait cycle should have started so far");

	// The turn ends (matches retry.ts calling resetTurn() from a fresh
	// pi.on("input", ...) or a non-retryable agent_end) without ever having
	// resolved the overflow.
	recovery.resetTurn();

	// Turn 2: the identical error recurs (e.g. the user sends another message
	// into the still-oversized session). Nothing in ppie-recover's own state
	// prevents this from re-entering the full defer-and-wait cycle again.
	assert.equal(
		deferOnce(),
		true,
		"resetTurn must clear the dedup guard: an identical recurring error on a new turn defers to core again, it is not permanently latched",
	);
	assert.equal(
		deferCount,
		2,
		"ppie-recover has no cross-turn memory that would stop this from repeating indefinitely on its own",
	);
	assert.equal(
		terminalCalls.length,
		0,
		"this test asserts only ppie-recover's own state machine; whether the loop is actually bounded in practice depends on pi-core or another extension eventually compacting, which this repo cannot observe or verify",
	);
});

// Context fallback failure is observable but cannot enter the memory-only trim pipeline.
test("context fallback rejection continues retry without arming memory trimming", async () => {
	let retryCount = 0;
	const terminals: string[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const coordinator = defaultCoordinator();
	const recovery = createOverflowRecovery({
		getReserveTokens: () => 2000,
		getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
		getMarkers: () => [],
		setStatus: () => {},
		notify: (message, level) => notifications.push({ message, level }),
		terminal: (_ctx, message) => terminals.push(message),
		compact: async () => {
			throw new Error("compact exploded");
		},
		coordinator,
		getFallbackCompactionMaxAttempts: () => 1,
	});
	const ctx = {} as ExtensionContext;
	const errorMessage = "prompt is too long: 2000 tokens exceeds the context window of 1000 tokens";
	const { signature } = recovery.classifyAndTrack(errorMessage);

	assert.equal(recovery.shouldDeferToCore(errorMessage, signature), true);
	// Await the retry itself rather than sleeping for a duration that happens
	// to be long enough here. A fixed 10ms wait raced the async compact
	// rejection and failed under Linux CI, where the callback lands later.
	const retried = new Promise<void>((resolve) => {
		recovery.awaitCoreDeferOrFallback(ctx, {
			retryDelayMs: 0,
			onRetry: () => {
				retryCount++;
				resolve();
			},
		});
	});
	coordinator.onAgentSettled();
	await retried;

	assert.equal(retryCount, 1);
	assert.deepEqual(terminals, []);
	assert.ok(
		notifications.some((n) => n.message.includes("compact exploded")),
		`expected compact rejection notification among: ${JSON.stringify(notifications)}`,
	);
	assert.equal(
		notifications.some((n) => n.message.includes("Emergency-pruned")),
		false,
	);
});

// Reported live (session 019f713c-8124-72ee-82da-da51576f1b9b, 2026-07-19
// ~11:20-11:23Z, omt-workspace). A length-overflow (tiny-output length stop)
// compacted successfully; the coordinator drove onCallerContinuation and the
// next provider request went out with a healthy max_tokens (29707). But the
// FOLLOWING regenerated requests carried a stale, shrinking max_tokens
// (1084 -> 1455 -> 706 -> 187) because pi-ai computes max_tokens against the
// still-large post-compaction prompt BEFORE before_provider_request fires.
// Each tiny budget truncated the turn -> stopReason:length -> loop forever.
// restoreOutputHeadroom (the exact medicine) never ran, because it was gated
// behind ppie-recover's PRUNER having removed chars — and on a pure compaction
// continuation the pruner is never armed (no prune, removedChars==0). Debug
// log proved ZERO prune events across the whole window. Fix: length-overflow /
// context caller-continuation arms a one-shot output-headroom restore that
// runs on the NEXT request regardless of whether the pruner also ran.
test("armOutputHeadroomRestore raises a stale-small max_tokens on the next request even when NO prune ran (post-compaction continuation)", () => {
	const recovery = buildRecovery();
	// Large window; the post-compaction prompt is modest, so there is real
	// output headroom the stale max_tokens is failing to use.
	const contextWindow = 112_000;
	const ctx = {
		getContextUsage: () => ({ contextWindow }),
	} as unknown as ExtensionContext;

	// The exact shape length-stop.ts's onCallerContinuation will produce:
	// compaction settled, no prune armed, restore armed one-shot.
	recovery.armOutputHeadroomRestore();

	// A modest post-compaction payload carrying the stale tiny max_tokens
	// pi-ai computed against the pre-compaction prompt (mirrors the live 187).
	const payload = {
		model: "test",
		max_tokens: 187,
		messages: [
			{ role: "user", content: "x".repeat(4_000) },
			{ role: "assistant", content: "continue" },
		],
	};

	const result = recovery.beforeProviderRequest(payload, ctx) as { max_tokens?: number } | undefined;

	assert.ok(result, "the continuation request must be returned, not dropped");
	assert.ok(
		typeof result.max_tokens === "number" && result.max_tokens > 187,
		`max_tokens must be restored above the stale 187 using the freed headroom (got ${result?.max_tokens}) — otherwise the model truncates immediately and re-length-stops forever`,
	);
});

test("armOutputHeadroomRestore is one-shot: it does not keep inflating max_tokens on subsequent normal requests", () => {
	const recovery = buildRecovery();
	const contextWindow = 112_000;
	const ctx = {
		getContextUsage: () => ({ contextWindow }),
	} as unknown as ExtensionContext;

	recovery.armOutputHeadroomRestore();
	const first = { model: "test", max_tokens: 187, messages: [{ role: "user", content: "x" }] };
	recovery.beforeProviderRequest(first, ctx);

	// A later ordinary turn where the caller deliberately set a small
	// max_tokens must be left untouched — the restore was consumed.
	const second = { model: "test", max_tokens: 200, messages: [{ role: "user", content: "y" }] };
	const result = recovery.beforeProviderRequest(second, ctx) as { max_tokens?: number } | undefined;

	assert.equal(
		result?.max_tokens ?? 200,
		200,
		"a normal request after the one-shot restore was consumed must keep its own max_tokens",
	);
});
