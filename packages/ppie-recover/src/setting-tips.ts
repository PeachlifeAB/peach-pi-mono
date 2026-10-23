import type { ResolvedRetryPolicy } from "./retry-policy-types.ts";

/** Why a recovery stopped, when a disabled setting could have continued it. */
export type RecoveryStopCause = "prune-disabled" | "compaction-not-authorized" | "retries-exhausted";

/**
 * One tip naming the disabled setting that could have continued a stopped
 * recovery, and why it is off by default; undefined when it is already on.
 */
export function settingTip(policy: ResolvedRetryPolicy, cause: RecoveryStopCause): string | undefined {
	switch (cause) {
		case "prune-disabled":
			if (policy.maxPruningAttempts > 0) return undefined;
			return "Tip: memory_overflow_protection.prune.enabled: true lets ppie-recover trim the next request and keep going. It is off by default because the model then sees less context for that retry; session history is not changed.";
		case "compaction-not-authorized":
			if (policy.fallbackCompactionMaxAttempts > 0) return undefined;
			return "Tip: memory_overflow_protection.compaction.forced.enabled: true (with compaction.enabled: true) lets ppie-recover compact on its own. Both are on by default; this config turned one off.";
		case "retries-exhausted":
			if (policy.fallbackEnabled) return undefined;
			return "Tip: model_fallback.enabled: true continues on another model when retries run out. It is off by default because it needs fallback models only you can choose.";
	}
}

type NotifyStop = (message: string, level?: "info" | "warning" | "error") => void;

/** Report why recovery stopped, then the setting tip for that cause, if any. */
/** Report a yield and its optional setting tip as one info notification. */
export function reportYield(
	notify: NotifyStop,
	policy: ResolvedRetryPolicy,
	message: string,
	cause: RecoveryStopCause | undefined,
): void {
	const tip = cause === undefined ? undefined : settingTip(policy, cause);
	const details = tip === undefined ? message : `${message} ${tip}`;
	notify(`ppie-recover yielded control to Pi-core and other extensions: ${details}`, "info");
}

/** Show the setting tip for a stop whose reason was already reported. */
export function notifyTip(notify: NotifyStop, policy: ResolvedRetryPolicy, cause: RecoveryStopCause): void {
	const tip = settingTip(policy, cause);
	if (tip) notify(tip, "info");
}
