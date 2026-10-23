import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CompactionOutcome } from "../src/compact.ts";
import { createCompactionCoordinator } from "../src/compaction-coordinator.ts";
import { createOverflowRecovery } from "../src/overflow-recovery.ts";
import { DEFAULT_PRUNE_PRIORITIES } from "../src/retry-config.ts";

const fakeCtx = {} as ExtensionContext;

const completed = (): CompactionOutcome => ({ kind: "completed" });
const defaultCoordinator = () =>
	createCompactionCoordinator({
		defer: (delayMs, callback) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	});
const buildRecovery = (
	overrides: { compact?: () => Promise<CompactionOutcome>; fallbackCompactionMaxAttempts?: number } = {},
) => {
	const coordinator = defaultCoordinator();
	const recovery = createOverflowRecovery({
		getReserveTokens: () => 2000,
		getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
		getMarkers: () => [],
		setStatus: () => {},
		notify: () => {},
		terminal: () => {},
		compact: overrides.compact ?? (async () => completed()),
		coordinator,
		getFallbackCompactionMaxAttempts: () => overrides.fallbackCompactionMaxAttempts ?? 2,
		getCompactionWarningMs: () => undefined,
		isCurrent: () => true,
	});
	return Object.assign(recovery, { coordinator });
};

async function flushAsync() {
	for (let i = 0; i < 5; i++) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
}

describe("overflow-recovery.ts's awaitCoreDeferOrFallback timer behavior", () => {
	// overflow-recovery.ts's awaitCoreDeferOrFallback schedules its
	// defer-wait window via a raw setTimeout (not an injected clock), same
	// as every other timer-driven module in this codebase (status.ts,
	// watchdog.ts, agent-retry.ts). retry-real-interface.spec.ts already
	// tests this same production code deterministically via
	// vi.useFakeTimers; this file used to race real setTimeout(retryDelayMs)
	// against a real wall-clock await-sleep for the SAME code path — a
	// genuine flake risk under CI load (a 20ms timer racing a 30ms sleep
	// can fire late/early nondeterministically). Migrated to Vitest fake
	// timers to match the codebase's one deterministic-timing convention
	// instead of introducing a second, inconsistent one.
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("deferring to core retries automatically once core's own compaction actually happens", async () => {
		const recovery = buildRecovery();
		let retryCalls = 0;

		recovery.awaitCoreDeferOrFallback(undefined, {
			retryDelayMs: 20_000,
			onRetry: () => {
				retryCalls++;
			},
		});

		// Simulate core's own compaction lifecycle firing during the wait window.
		await vi.advanceTimersByTimeAsync(5000);
		recovery.coordinator.onSessionBeforeCompact();
		recovery.coordinator.onSessionCompact({ willRetry: false });

		await vi.advanceTimersByTimeAsync(30_000);
		await flushAsync();

		expect(
			retryCalls,
			"once core's compaction fires within the wait window, ppie-recover must resume the turn automatically",
		).toBe(1);
	});

	// Reported concern: onCompaction() only sets compactedThisTurn = true; it
	// does not clear coreDeferTimer, abort coreDeferAbort, or invoke the
	// stored onRetry callback. The sibling test above cannot tell "retried
	// immediately when core compacted" apart from "retried later, once the
	// original retryDelayMs deadline itself fired and then checked
	// compactedThisTurn" because it advances time all the way past the
	// deadline before asserting. This test isolates that distinction: it
	// asserts retryCalls === 1 the moment onCompaction() fires, WITHOUT ever
	// advancing to the retryDelayMs deadline. If the retry only happens because the
	// deadline timer eventually fires and checks the boolean, this must fail
	// with retryCalls still 0 at this point.
	test("deferring to core retries IMMEDIATELY when core compacts, not only once the wait-window deadline later fires", async () => {
		const recovery = buildRecovery();
		let retryCalls = 0;

		recovery.awaitCoreDeferOrFallback(undefined, {
			retryDelayMs: 20_000,
			onRetry: () => {
				retryCalls++;
			},
		});

		// Core compacts well before the 20s deadline.
		await vi.advanceTimersByTimeAsync(2000);
		recovery.coordinator.onSessionBeforeCompact();
		recovery.coordinator.onSessionCompact({ willRetry: false });
		await flushAsync();

		expect(
			retryCalls,
			"core's own compaction completing must trigger an immediate retry, not wait for the wait-window deadline to also elapse",
		).toBe(1);

		// The deadline timer must also be defused: it must not fire a SECOND
		// retry (or a duplicate compact()) once it would otherwise elapse.
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();

		expect(
			retryCalls,
			"the deadline timer must not fire a second retry after core's compaction already resolved this defer window",
		).toBe(1);
	});

	test("fallback disabled waits once, then continues without calling compact", async () => {
		let compactCalls = 0;
		let retryCalls = 0;
		const recovery = buildRecovery({
			fallbackCompactionMaxAttempts: 0,
			compact: async () => {
				compactCalls++;
				return completed();
			},
		});

		recovery.awaitCoreDeferOrFallback(fakeCtx, {
			retryDelayMs: 10_000,
			onRetry: () => {
				retryCalls++;
			},
		});

		await vi.advanceTimersByTimeAsync(9_999);
		await flushAsync();
		expect(compactCalls).toBe(0);
		expect(retryCalls).toBe(0);

		await vi.advanceTimersByTimeAsync(1);
		await flushAsync();
		expect(compactCalls).toBe(0);
		expect(retryCalls).toBe(1);
	});

	test("context fallback compaction never exceeds configured max_attempts", async () => {
		let compactCalls = 0;
		let retryCalls = 0;
		const recovery = buildRecovery({
			fallbackCompactionMaxAttempts: 1,
			compact: async () => {
				compactCalls++;
				return completed();
			},
		});
		const request = () =>
			recovery.awaitCoreDeferOrFallback(fakeCtx, {
				retryDelayMs: 1,
				onRetry: () => {
					retryCalls++;
				},
			});

		request();
		await vi.advanceTimersByTimeAsync(1);
		await flushAsync();
		expect(compactCalls).toBe(1);
		expect(retryCalls).toBe(0);
		recovery.coordinator.onSessionCompact({ willRetry: false });
		expect(retryCalls).toBe(1);

		request();
		await vi.advanceTimersByTimeAsync(1);
		await flushAsync();
		expect(compactCalls).toBe(1);
		expect(retryCalls).toBe(2);
	});

	test("deferring to core falls back to ppie-recover's own compact() if core never compacts within the wait window", async () => {
		let compactCalls = 0;
		const recovery = buildRecovery({
			compact: async () => {
				compactCalls++;
				return completed();
			},
		});
		let retryCalls = 0;

		recovery.awaitCoreDeferOrFallback(fakeCtx, {
			retryDelayMs: 10_000,
			onRetry: () => {
				retryCalls++;
			},
		});

		await vi.advanceTimersByTimeAsync(40_000);
		await flushAsync();

		expect(
			compactCalls,
			"ppie-recover must not go silent forever — it must request its own compaction if core never did",
		).toBe(1);
		expect(retryCalls).toBe(0);
		recovery.coordinator.onSessionCompact({ willRetry: false });
		expect(retryCalls, "after fallback compaction lifecycle lands, ppie-recover must resume the turn").toBe(1);
	});

	test("resetTurn firing while the fallback compact() is already in flight must not retry/terminal against the abandoned turn", async () => {
		const terminalCalls: string[] = [];
		let releaseCompact: (() => void) | undefined;

		const recovery = createOverflowRecovery({
			getReserveTokens: () => 2000,
			getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
			getMarkers: () => [],
			setStatus: () => {},
			notify: () => {},
			terminal: (_ctx, message) => {
				terminalCalls.push(message);
			},
			// Simulates a slow compact() call: the timer fires and starts
			// awaiting this before resetTurn() runs — the exact window
			// clearTimeout cannot protect, because the callback has already
			// begun executing.
			getFallbackCompactionMaxAttempts: () => 1,
			compact: () =>
				new Promise<CompactionOutcome>((resolve) => {
					releaseCompact = () => resolve(completed());
				}),
		});
		let retryCalls = 0;

		recovery.awaitCoreDeferOrFallback(fakeCtx, {
			retryDelayMs: 5000,
			onRetry: () => {
				retryCalls++;
			},
		});

		// Wait for the timer to fire and compact() to be called (and thus
		// in-flight), then abandon the turn before compact() resolves.
		await vi.advanceTimersByTimeAsync(20_000);
		await flushAsync();
		expect(releaseCompact, "compact() must already be in flight at this point").toBeDefined();
		recovery.resetTurn();
		releaseCompact?.();

		await vi.advanceTimersByTimeAsync(10_000);
		await flushAsync();

		expect(retryCalls, "a fallback compact() that resolves after resetTurn must not retry the abandoned turn").toBe(
			0,
		);
		expect(
			terminalCalls.length,
			"a fallback compact() that resolves after resetTurn must not terminal the abandoned turn either",
		).toBe(0);
	});

	// Reported concern (the narrowed, source-grounded version): core can
	// START its own auto-compaction before the 10s defer deadline but not
	// FINISH (i.e. emit session_compact) until after it. Previously there
	// was no "compaction is currently in progress" state anywhere in
	// overflow-recovery.ts — only compactedThisTurn (complete). When the
	// deadline timer fired mid-way through core's still-running
	// compaction, compactedThisTurn was still false, so the timer's
	// fallback branch called compact(ctx) — a SECOND, redundant compact()
	// call layered on top of core's own still-running one. This is the
	// literal source of the reported "Already compacted" error.
	//
	// The installed pi-coding-agent package exposes exactly the signal
	// needed to close this gap: session_before_compact (fired BEFORE
	// compaction begins, with a reason field) — see
	// node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts.
	// onCompactionStart() wires that signal into overflow-recovery.ts so
	// the fallback branch can see "compaction is already running" and wait
	// for the real completion instead of calling compact(ctx) itself.
	test("core compaction that starts before the defer deadline suppresses the fallback's own redundant compact(ctx) call", async () => {
		let fallbackCompactCalls = 0;
		const coordinator = defaultCoordinator();
		const recovery = createOverflowRecovery({
			getReserveTokens: () => 2000,
			getPriorities: () => DEFAULT_PRUNE_PRIORITIES,
			getMarkers: () => [],
			setStatus: () => {},
			notify: () => {},
			terminal: () => {},
			// This port models a real ctx.compact() call. In production, core's
			// OWN auto-compaction fires this same underlying pi-core mechanism,
			// but NOT through this injected port — so any call recorded here
			// during this test is necessarily ppie-recover's OWN fallback call, not
			// core's.
			compact: async () => {
				fallbackCompactCalls++;
				return completed();
			},
			coordinator,
		});
		let retryCalls = 0;

		recovery.awaitCoreDeferOrFallback(fakeCtx, {
			retryDelayMs: 10_000,
			onRetry: () => {
				retryCalls++;
			},
		});

		// Core signals it has STARTED compacting (session_before_compact),
		// well before the 10s deadline — but has not finished yet.
		await vi.advanceTimersByTimeAsync(2000);
		coordinator.onSessionBeforeCompact();

		// The 10s deadline fires while core's compaction is still running.
		// Without the fix, compactedThisTurn is still false at this instant
		// and the fallback branch calls compact(ctx) redundantly.
		await vi.advanceTimersByTimeAsync(10_000);
		await flushAsync();

		expect(
			fallbackCompactCalls,
			"once core has signalled it started compacting, the deadline timer must not call compact(ctx) itself — it must wait for the real completion instead of racing a redundant call against it",
		).toBe(0);

		// Core's own compaction now genuinely completes.
		coordinator.onSessionCompact({ willRetry: false });
		await flushAsync();

		expect(
			retryCalls,
			"the turn must still resume once core's real completion lands, even though the deadline elapsed first",
		).toBe(1);
		expect(fallbackCompactCalls, "completion must not retroactively trigger a fallback compact() call either").toBe(
			0,
		);
	});
});
