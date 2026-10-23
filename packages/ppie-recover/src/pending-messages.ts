import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PENDING_MESSAGES_MAX_WAIT_MS, PENDING_MESSAGES_POLL_MS } from "./retry-config.ts";
import { isStaleCtxError } from "./retry-utils.ts";

type NotifyLevel = "info" | "warning" | "error";

type RunWhenClearOptions = {
	notify: (message: string, level?: NotifyLevel) => void;
	terminal: (ctx: ExtensionContext, message: string) => void;
};

export type PendingMessagesGate = ReturnType<typeof createPendingMessagesGate>;

// ctx.hasPendingMessages() exists so a retry/follow-up prompt([]) is never
// injected on top of messages pi-core already has queued. Reported live:
// checking it once and silently `return`-ing on true DROPPED THE ENTIRE
// RETRY ATTEMPT FOREVER with zero notification whenever pending messages
// happened to exist at that exact instant (e.g. right after a large prior
// turn) — the user saw the original error, then permanent silence, with no
// visible reason recovery never started. Two call sites had this identical
// bug: retry.ts's triggerRetry and length-stop.ts's truncation-continuation
// branch. This factors out one shared, testable mechanism: notify once,
// poll until the queue clears (bounded), then run the deferred action — or
// terminal with a visible reason if it never clears in time.
export function createPendingMessagesGate({ notify, terminal }: RunWhenClearOptions) {
	let pollTimer: NodeJS.Timeout | undefined;
	// The caller currently occupying the single poll slot, if any. There is
	// only one pollTimer for the whole gate, but two real call sites share
	// one gate instance (retry.ts's triggerRetry and length-stop.ts's
	// truncation-continuation branch) — a second runWhenClear() while the
	// first is still waiting used to silently discard the first caller's
	// deferred action with zero notification. Tracking the waiter lets
	// cancel() distinguish "displaced by a new caller" (must notify) from
	// "genuinely cancelled" (e.g. resetTurn — no displaced caller to
	// notify).
	let pendingWaiter: { ctx: ExtensionContext; label: string } | undefined;

	const cancel = () => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
		pendingWaiter = undefined;
	};

	// Runs `perform()` immediately if ctx.hasPendingMessages() is false.
	// Otherwise notifies once, then polls every PENDING_MESSAGES_POLL_MS
	// (bounded by PENDING_MESSAGES_MAX_WAIT_MS) until it clears, running
	// `perform()` then — or calling `terminal()` with a visible reason if
	// the window elapses first. `label` distinguishes the two real call
	// sites (retry vs. length-stop follow-up) in the terminal message.
	const runWhenClear = (ctx: ExtensionContext, label: string, perform: () => void) => {
		const displaced = pendingWaiter;
		cancel();
		if (displaced) {
			terminal(
				displaced.ctx,
				`${displaced.label} stopped: superseded by a new "${label}" request before pi-core's queued messages cleared.`,
			);
		}

		if (!ctx.hasPendingMessages()) {
			perform();
			return;
		}

		pendingWaiter = { ctx, label };

		notify(`${label} is waiting for pi-core's own queued messages to clear before continuing…`, "warning");

		const startedAt = Date.now();

		const poll = () => {
			pollTimer = undefined;

			let stillPending: boolean;
			try {
				stillPending = ctx.hasPendingMessages();
			} catch (err) {
				if (!isStaleCtxError(err)) throw err;
				return;
			}

			if (!stillPending) {
				pendingWaiter = undefined;
				perform();
				return;
			}

			if (Date.now() - startedAt >= PENDING_MESSAGES_MAX_WAIT_MS) {
				pendingWaiter = undefined;
				terminal(
					ctx,
					`${label} stopped: pi-core still had queued messages after ${Math.round(PENDING_MESSAGES_MAX_WAIT_MS / 1000)}s. Retry the turn manually once the queue clears.`,
				);
				return;
			}

			pollTimer = setTimeout(poll, PENDING_MESSAGES_POLL_MS);
		};

		pollTimer = setTimeout(poll, PENDING_MESSAGES_POLL_MS);
	};

	return {
		runWhenClear,
		cancel,
		hasPending: () => pendingWaiter !== undefined || pollTimer !== undefined,
	};
}
