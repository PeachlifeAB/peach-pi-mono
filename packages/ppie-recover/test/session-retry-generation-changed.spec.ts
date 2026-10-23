import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RETRY_STOP_NOTICE } from "../src/retry-stop-notice.ts";
import { LIVE_FAILURE_AFTER_MS, loadSessionHistory, startLiveCodexSession } from "./fakes/codex-live-session.ts";

const RETRY_WAIT_SECONDS = 16;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The WebSocket fails. A turn is in flight when the retry's wait ends, and the session starts again
// while the retry waits for that turn. The retry must not dispatch on the new generation, and must say so.
test("a retry whose generation changed while it waited for the session shows a stop notice naming continuation_superseded", async () => {
	const live = await startLiveCodexSession({
		history: loadSessionHistory(),
		sockets: ["stream-then-fail-after-live-delay", "complete-late"],
		retryWaitSeconds: RETRY_WAIT_SECONDS,
	});
	try {
		const failedTurn = live.agent.continue();
		await vi.advanceTimersByTimeAsync(LIVE_FAILURE_AFTER_MS);
		await failedTurn;
		live.piCore.emit("agent_settled", {}, live.ctx);

		void live.agent.prompt("user turn in flight across the retry wait");
		await vi.advanceTimersByTimeAsync(RETRY_WAIT_SECONDS * 1000 + 2_000);
		live.piCore.emit("session_start", {}, live.ctx);
		await vi.runAllTimersAsync();

		const warnings = live.ctxCore.ui.notifications.filter((n) => n.level === "warning").map((n) => n.message);
		expect(live.socketUrls).toHaveLength(2);
		expect(warnings).toContain(RETRY_STOP_NOTICE.continuation_superseded);
	} finally {
		live.dispose();
	}
}, 30_000);
