import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LIVE_FAILURE_AFTER_MS, loadSessionHistory, startLiveCodexSession } from "./fakes/codex-live-session.ts";

const LIVE_RETRY_WAIT_SECONDS = 16;
const LIVE_REQUEST_BYTES = 1_284_448;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Live shape from session 01a137cd: the first socket streams, then fails 80 s later with "WebSocket error".
// The retry waits 16 s and opens a second socket, and the turn completes.
test("live timing: a mid-stream WebSocket error after 80 s is retried after 16 s", async () => {
	const live = await startLiveCodexSession({
		history: loadSessionHistory(),
		sockets: ["stream-then-fail-after-live-delay", "complete"],
		retryWaitSeconds: LIVE_RETRY_WAIT_SECONDS,
	});
	try {
		const turn = live.agent.continue();
		await vi.advanceTimersByTimeAsync(LIVE_FAILURE_AFTER_MS);
		expect(live.socketUrls).toHaveLength(1);
		await turn;
		live.piCore.emit("agent_settled", {}, live.ctx);

		await vi.advanceTimersByTimeAsync(LIVE_RETRY_WAIT_SECONDS * 1000);
		await vi.runAllTimersAsync();

		const lastMessage = live.agent.state.messages.at(-1) as { stopReason?: string; errorMessage?: string };
		expect(live.sentBytes[0]).toBeGreaterThanOrEqual(LIVE_REQUEST_BYTES);
		expect(live.httpRequests).toHaveLength(0);
		expect(live.socketUrls).toHaveLength(2);
		expect(live.ctxCore.ui.notifications.filter((n) => n.message.startsWith("Retry attempt"))).toHaveLength(1);
		expect(
			lastMessage.stopReason,
			`turn must complete, got ${lastMessage.stopReason}: ${lastMessage.errorMessage}`,
		).toBe("stop");
	} finally {
		live.dispose();
	}
}, 30_000);
