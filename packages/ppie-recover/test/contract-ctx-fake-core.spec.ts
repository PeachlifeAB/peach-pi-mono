/**
 * Contract test for CtxFakeCore (test/fakes/pi-fakes.ts) against the
 * REAL ExtensionContext type from @earendil-works/pi-coding-agent.
 *
 * Why this exists: CtxFakeCore is hand-written, not generated from the real
 * type, so nothing forces its member signatures to stay in sync with the
 * installed package. This already caught one real drift: the fake's
 * compact()'s onError used to accept `{ message: string }`, but the real
 * CompactOptions.onError is `(error: Error) => void` — an Error instance.
 * That drift was invisible at runtime (src/compact.ts only ever reads
 * `.message`, which both shapes have), so every behavioral test kept
 * passing while the fake silently diverged from what a real pi session
 * actually calls back with. A future compact.ts change that relies on
 * genuine Error behavior (instanceof Error, .stack, .name) would break in
 * production while this repo's tests stayed green — exactly what a
 * contract test exists to catch, at compile time, before that happens.
 *
 * This is a structural (type-level) contract, not a runtime one, for the
 * statically-shaped members. `ui` and `sessionManager` are deliberately
 * excluded from the Pick<ExtensionContext, ...> check below: both are
 * intentionally PARTIAL implementations (ui is a runtime Proxy covering
 * only notify/setStatus; sessionManager implements only getBranch) — real,
 * on-purpose gaps, not drift, so a full structural Pick would fail on
 * members CtxFakeCore never claimed to implement. getBranch's own real
 * signature is still checked explicitly and separately below, since that
 * IS the one sessionManager member ppie-recover's code actually calls
 * (retry-utils.ts's lastAssistantMessage).
 */
import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { CtxFakeCore } from "./fakes/pi-fakes.ts";

// The exact subset of ExtensionContext CtxFakeCore implements with a
// static (non-Proxy, non-partial) shape. If the real type's signature for
// any of these changes (return type, parameter shape, optionality), this
// line fails to compile — the earliest possible signal, well before a
// behavioral test would ever notice.
type CtxFakeCoreContract = Pick<
	ExtensionContext,
	"abort" | "compact" | "getContextUsage" | "hasPendingMessages" | "hasUI" | "isIdle"
>;

// Compile-time-only: if CtxFakeCore ever drops or narrows one of these
// members incompatibly with the real ExtensionContext, this assignment
// fails to typecheck. Never executed.
function _assertCtxFakeCoreSatisfiesContract(fake: CtxFakeCore): CtxFakeCoreContract {
	return fake;
}
void _assertCtxFakeCoreSatisfiesContract;

// Prove the implemented session-manager port has the exact installed
// getBranch signature, including its optional parameter and SessionEntry[]
// result. A broad unknown[] return would fail this assignment.
function _assertGetBranchSignature(fake: CtxFakeCore): ExtensionContext["sessionManager"]["getBranch"] {
	return fake.sessionManager.getBranch;
}
void _assertGetBranchSignature;

test("CtxFakeCore's compact() onError callback receives a real Error, matching pi-coding-agent's CompactOptions.onError — not a plain { message } object", () => {
	const ctxCore = new CtxFakeCore();
	ctxCore.failNextCompact = "boom";

	let captured: unknown;
	let started = false;
	ctxCore.onCompactStart = () => {
		started = true;
	};
	ctxCore.compact({
		onError: (err) => {
			captured = err;
		},
	});

	expect(started).toBe(true);
	expect(ctxCore.compactions).toHaveLength(1);
	expect(captured).toBeInstanceOf(Error);
	expect((captured as Error).message).toBe("boom");
});

test("CtxFakeCore's compact() success callback receives the real CompactionResult shape", () => {
	const ctxCore = new CtxFakeCore();

	let result: CompactionResult | undefined;
	ctxCore.compact({
		onComplete: (completed) => {
			result = completed;
		},
	});

	expect(result).toEqual({
		summary: "fake compaction summary",
		firstKeptEntryId: "fake-first-kept-entry",
		tokensBefore: 1000,
		estimatedTokensAfter: 100,
	});
	expect(ctxCore.compactions).toHaveLength(1);
});

test("CtxFakeCore records compaction start before an unresolved lifecycle", () => {
	const ctxCore = new CtxFakeCore();
	ctxCore.compactNeverSettles = true;
	let started = false;
	ctxCore.onCompactStart = () => {
		started = true;
	};

	ctxCore.compact();

	expect(started).toBe(true);
	expect(ctxCore.compactions).toHaveLength(1);
});

test("CtxFakeCore's getContextUsage() returns the FULL real ContextUsage shape (tokens, contextWindow, percent), not just the contextWindow field ppie-recover's own code happens to read", () => {
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 112_000;

	const usage = ctxCore.getContextUsage();

	expect(usage).toEqual({
		contextWindow: 112_000,
		tokens: null,
		percent: null,
	});
});
