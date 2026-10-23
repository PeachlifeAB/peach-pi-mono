export const RETRY_STOP_REASONS = [
	"cancelled_before_attempt",
	"cancelled_during_delay",
	"stale_after_hook",
	"continuation_superseded",
	"continuation_unavailable",
	"continuation_failed",
] as const;

export type RetryStopReason = (typeof RETRY_STOP_REASONS)[number];

export const RETRY_STOP_NOTICE: Readonly<Record<RetryStopReason, string>> = {
	cancelled_before_attempt: "Retry stopped: a newer prompt or cancel took over before the next attempt.",
	cancelled_during_delay: "Retry stopped during the wait: a newer prompt or cancel took over.",
	stale_after_hook: "Retry stopped: a newer prompt or cancel took over before the retry was sent.",
	continuation_superseded:
		"Retry paused: a prompt was submitted just before the retry could run. Retry again once it clears.",
	continuation_unavailable:
		"Retry stopped: this pi version does not expose the session entry point ppie-recover needs. Update ppie-recover or retry manually.",
	continuation_failed: "Retry stopped: sending the retry failed. Check the provider and retry manually.",
};

export type RetryAttemptOutcome =
	| Readonly<{ status: "continued" }>
	| Readonly<{ status: "exhausted" }>
	| Readonly<{ status: "stopped"; reason: RetryStopReason }>;

export const RETRY_WAITING_NOTICE = "Retry waiting: a turn is still running. The retry is sent when it finishes.";
