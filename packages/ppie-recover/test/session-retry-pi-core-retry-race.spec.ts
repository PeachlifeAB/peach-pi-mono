import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LIVE_FAILURE_AFTER_MS, loadSessionHistory, startLiveCodexSession } from "./fakes/codex-live-session.ts";

const PI_RETRY_BASE_DELAY_MS = 30_000;
const RECOVER_RETRY_WAIT_SECONDS = 16;
const SECOND_SOCKET_GRACE_MS = 1_000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The user's ~/.pi/agent/settings.json enables pi core's own retry (3 attempts, 30 s base). pi core classifies
// "WebSocket error" as retryable too, so both retriers see the same failure. The expectation: ppie-recover's own
// retry dispatches after its announced 16 s wait, with nothing else happening.
test("ppie-recover dispatches its announced 16 s retry while pi core auto-retry is enabled", async () => {
	const live = await startLiveCodexSession({
		history: loadSessionHistory(),
		sockets: ["stream-then-fail-after-live-delay", "complete"],
		retryWaitSeconds: RECOVER_RETRY_WAIT_SECONDS,
		piSettings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: PI_RETRY_BASE_DELAY_MS } },
	});
	try {
		const turn = live.session.prompt("continue");
		await vi.advanceTimersByTimeAsync(LIVE_FAILURE_AFTER_MS);
		expect(live.socketUrls).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(RECOVER_RETRY_WAIT_SECONDS * 1000 + SECOND_SOCKET_GRACE_MS);

		const notices = live.ctxCore.ui.notifications.map((n) => n.message);
		expect(
			live.socketUrls,
			`second socket expected 17 s after the failure; notices: ${JSON.stringify(notices)}`,
		).toHaveLength(2);
		await vi.runAllTimersAsync();
		await turn;

		const lastMessage = live.session.agent.state.messages.at(-1) as { stopReason?: string };
		expect(lastMessage.stopReason).toBe("stop");
		expect(live.ctxCore.ui.notifications.map((n) => n.message)).toEqual(["Retry attempt 1 (waiting 16s)…"]);
	} finally {
		live.dispose();
	}
}, 30_000);
