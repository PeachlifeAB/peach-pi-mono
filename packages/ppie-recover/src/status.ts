import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STATUS_KEY, STATUS_VISIBLE_MS } from "./retry-config.ts";
import { isStaleCtxError } from "./retry-utils.ts";

/** " · n/limit" for a recovery wait status; empty when the attempt is unknown. */
export function attemptSuffix(next: { attempt: number; limit: number } | undefined): string {
	if (!next) return "";
	return Number.isFinite(next.limit) ? ` · ${next.attempt}/${next.limit}` : ` · ${next.attempt}`;
}

export function createStatusController() {
	let clearStatusTimer: NodeJS.Timeout | undefined;

	// sticky: a recovery wait owns the status until the next setStatus or
	// clearStatus; the wait can outlast STATUS_VISIBLE_MS by minutes.
	const setStatus = (ctx: ExtensionContext, value: string, options?: { sticky?: boolean }) => {
		if (!ctx.hasUI) return;

		if (clearStatusTimer) clearTimeout(clearStatusTimer);
		clearStatusTimer = undefined;

		ctx.ui.setStatus(STATUS_KEY, value);
		if (options?.sticky) return;

		// The clear callback fires after STATUS_VISIBLE_MS, captured in this
		// closure — if the session is replaced (fork/newSession/
		// switchSession/reload) before it fires, ctx is stale and any access
		// throws. Clearing a status label is inherently best-effort; swallow
		// rather than crash the extension process from a detached timer.
		clearStatusTimer = setTimeout(() => {
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch (err) {
				if (!isStaleCtxError(err)) throw err;
				// stale ctx after session replacement — nothing to clear
			}
		}, STATUS_VISIBLE_MS);
	};

	const showRetryStatus = (ctx: ExtensionContext) => {
		setStatus(ctx, "🔁 retrying");
	};

	const clearStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (clearStatusTimer) clearTimeout(clearStatusTimer);
		clearStatusTimer = undefined;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch (err) {
			if (!isStaleCtxError(err)) throw err;
		}
	};

	return { setStatus, clearStatus, showRetryStatus };
}
