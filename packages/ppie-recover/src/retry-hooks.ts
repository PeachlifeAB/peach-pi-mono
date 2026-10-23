import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./debug-log.ts";
import { isStaleCtxError } from "./retry-utils.ts";

export type NotifyLevel = "info" | "warning" | "error";
export type Guarded = <Args extends unknown[], Result>(
	label: string,
	handler: (...args: Args) => Result,
) => (...args: Args) => Result | undefined;

export function createGuarded(): Guarded {
	return (label, handler) =>
		(...args) => {
			try {
				return handler(...args);
			} catch (error) {
				if (isStaleCtxError(error)) {
					debugLog(`${label}.stale_ctx_suppressed`);
					return;
				}
				throw error;
			}
		};
}

export function createNotifier() {
	let target: ((message: string, level: NotifyLevel) => void) | undefined;
	const setContext = (ctx: ExtensionContext): void => {
		target = (message, level) => ctx.ui.notify(message, level);
	};
	const notify = (message: string, level: NotifyLevel = "info"): void => {
		try {
			target?.(message, level);
		} catch (error) {
			if (!isStaleCtxError(error)) throw error;
			debugLog("notify.stale_ctx_suppressed", { message });
		}
	};
	return { notify, setContext };
}
