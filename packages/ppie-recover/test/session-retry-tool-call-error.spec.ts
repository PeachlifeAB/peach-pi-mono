import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LIVE_FAILURE_AFTER_MS, loadSessionHistory, startLiveCodexSession } from "./fakes/codex-live-session.ts";

const RETRY_WAIT_SECONDS = 16;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Live shape from session 01a137cd: the WebSocket error interrupts a tool call. Nothing else is running.
// Expected: the retry is announced, waits 16 s with no activity, dispatches, and the turn completes.
test("a WebSocket error raised during a tool call is retried after 16 s with no activity", async () => {
	const live = await startLiveCodexSession({
		history: loadSessionHistory(),
		sockets: ["stream-tool-call-then-fail-after-live-delay", "complete"],
		retryWaitSeconds: RETRY_WAIT_SECONDS,
	});
	try {
		const failedTurn = live.agent.continue();
		await vi.advanceTimersByTimeAsync(LIVE_FAILURE_AFTER_MS);
		await failedTurn;
		live.piCore.emit("agent_settled", {}, live.ctx);

		await vi.advanceTimersByTimeAsync(RETRY_WAIT_SECONDS * 1000);
		await vi.runAllTimersAsync();

		const last = live.agent.state.messages.at(-1) as { stopReason?: string; errorMessage?: string };
		expect(live.ctxCore.ui.notifications.some((n) => n.message.startsWith("Retry attempt 1"))).toBe(true);
		expect(live.socketUrls, live.readDebugLog()).toHaveLength(2);
		expect(last.stopReason, `turn must complete, got ${last.stopReason}: ${last.errorMessage}`).toBe("stop");
	} finally {
		live.dispose();
	}
}, 30_000);
