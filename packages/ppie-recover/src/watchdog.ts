import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStaleCtxError } from "./retry-utils.ts";

type WatchdogOptions = {
	getTimeoutMs: () => number;
	onStall: (ctx: ExtensionContext) => void;
};
// Detects provider-stream silence and reports it via onStall. Deliberately
// does not abort the run itself: an extension has no authority to destroy
// activeRun state it doesn't own or coordinate with pi-core or other
// extensions (no provenance, no consent). The user retains their own cancel
// path; this is purely advisory.
export function createWatchdog({ getTimeoutMs, onStall }: WatchdogOptions) {
	let timer: NodeJS.Timeout | undefined;
	let active = false;

	const disarm = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		active = false;
	};

	const arm = (ctx: ExtensionContext) => {
		disarm();

		const timeoutMs = getTimeoutMs();
		if (timeoutMs === 0) return;

		active = true;

		timer = setTimeout(() => {
			timer = undefined;
			active = false;

			// ctx is captured in this closure; if the session was replaced
			// (fork/newSession/switchSession/reload) between arm() and this
			// callback firing, any ctx access throws "extension ctx is
			// stale". disarm() on session_shutdown races this timer firing
			// first — best-effort advisory, so swallow rather than crash.
			try {
				if (ctx.isIdle()) return;
				onStall(ctx);
			} catch (err) {
				if (!isStaleCtxError(err)) throw err;
				// stale ctx after session replacement — nothing to observe
			}
		}, timeoutMs);
	};

	const observe = (ctx: ExtensionContext) => {
		if (!active) return;

		if (ctx.isIdle()) {
			disarm();
			return;
		}

		arm(ctx);
	};

	const reset = () => {
		disarm();
	};

	return {
		arm,
		disarm,
		observe,
		reset,
	};
}

export function providerSilentNotice(silentMs: number): string {
	return `Provider silent for ${Math.round(silentMs / 1000)}s with no stream progress. Still waiting; cancel to stop.`;
}
