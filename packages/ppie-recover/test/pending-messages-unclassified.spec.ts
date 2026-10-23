import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPendingMessagesGate } from "../src/pending-messages.ts";

function pendingCtx(pending: boolean): ExtensionContext {
	return {
		hasPendingMessages: () => pending,
	} as unknown as ExtensionContext;
}

describe("pending-messages.ts's createPendingMessagesGate", () => {
	beforeEach(() => {
		vi.useFakeTimers({
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Reported concern: runWhenClear() begins with cancel(), which clears
	// the single shared pollTimer. There is only one pollTimer/deferred-
	// action slot for the whole gate, but retry.ts's triggerRetry and
	// length-stop.ts's truncation-continuation branch both call
	// runWhenClear() on the SAME shared gate instance (see retry.ts wiring
	// both to one createPendingMessagesGate() call). If a second caller
	// invokes runWhenClear() while a first caller's wait is still pending
	// (pi-core's queue has not cleared yet), the first caller's `perform`
	// closure was silently discarded — dropped with no notification, no
	// terminal call, nothing, forever unreachable. This asserts the
	// displaced caller must at minimum reach a VISIBLE outcome (a terminal
	// notification identifying it by its own label) instead of vanishing
	// with zero trace — matching this file's own stated philosophy
	// ("terminal with a visible reason" is used throughout for every other
	// bounded-wait failure mode here).
	test("a second runWhenClear() call must not silently discard a still-pending first caller's deferred action with zero notification", async () => {
		const terminalCalls: string[] = [];
		const gate = createPendingMessagesGate({
			notify: () => {},
			terminal: (_ctx, message) => {
				terminalCalls.push(message);
			},
		});
		const ctx = pendingCtx(true);

		let firstPerformed = false;
		let secondPerformed = false;

		gate.runWhenClear(ctx, "First caller", () => {
			firstPerformed = true;
		});

		// Second caller arrives while the first is still polling (queue
		// never cleared between these two calls) — e.g. a manual /retry
		// while an automatic length-stop follow-up is already waiting on
		// the queue.
		gate.runWhenClear(ctx, "Second caller", () => {
			secondPerformed = true;
		});

		expect(firstPerformed, "the first caller's action must not have run yet (queue was still pending)").toBe(false);
		expect(secondPerformed, "the second caller's action must not have run yet either (queue still pending)").toBe(
			false,
		);
		expect(
			terminalCalls.some((message) => message.includes("First caller")),
			`the displaced first caller must reach a visible terminal outcome identifying itself, not vanish with zero trace; got: ${JSON.stringify(terminalCalls)}`,
		).toBe(true);
	});
});
