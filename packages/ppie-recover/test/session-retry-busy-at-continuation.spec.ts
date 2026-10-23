import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LIVE_FAILURE_AFTER_MS, loadSessionHistory, startLiveCodexSession } from "./fakes/codex-live-session.ts";

const RETRY_WAIT_SECONDS = 16;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The WebSocket fails. A second turn is in flight when the retry's wait ends (it never answers).
// The retry must not dispatch silently: the user must see that it is blocked.
test("a retry blocked by a turn in flight at the end of its wait shows a visible notice", async () => {
	const live = await startLiveCodexSession({
		history: loadSessionHistory(),
		sockets: ["stream-then-fail-after-live-delay", "stall"],
		retryWaitSeconds: RETRY_WAIT_SECONDS,
	});
	try {
		const failedTurn = live.agent.continue();
		await vi.advanceTimersByTimeAsync(LIVE_FAILURE_AFTER_MS);
		await failedTurn;
		live.piCore.emit("agent_settled", {}, live.ctx);

		void live.agent.prompt("user turn that stays in flight");
		await vi.advanceTimersByTimeAsync(RETRY_WAIT_SECONDS * 1000 + 60_000);

		const messages = live.ctxCore.ui.notifications.map((n) => n.message);
		expect(live.socketUrls).toHaveLength(2);
		expect(messages.filter((m) => m.startsWith("Retry attempt"))).toHaveLength(1);
		expect(
			messages.some((m) => /retry/i.test(m) && !m.startsWith("Retry attempt")),
			`notices: ${JSON.stringify(messages)}`,
		).toBe(true);
	} finally {
		live.dispose();
	}
}, 30_000);
