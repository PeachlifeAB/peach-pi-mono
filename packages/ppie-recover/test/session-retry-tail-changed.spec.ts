import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RETRY_STOP_NOTICE } from "../src/retry-stop-notice.ts";
import { LIVE_FAILURE_AFTER_MS, loadSessionHistory, startLiveCodexSession } from "./fakes/codex-live-session.ts";

const RETRY_WAIT_SECONDS = 16;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The WebSocket fails. A message is appended to the transcript during the retry wait.
// The retry must not dispatch on the changed tail, and the user must see the stop reason.
test("a retry whose transcript tail changed during its wait shows a stop notice naming continuation_superseded", async () => {
	const live = await startLiveCodexSession({
		history: loadSessionHistory(),
		sockets: ["stream-then-fail-after-live-delay", "complete"],
		retryWaitSeconds: RETRY_WAIT_SECONDS,
	});
	try {
		const failedTurn = live.agent.continue();
		await vi.advanceTimersByTimeAsync(LIVE_FAILURE_AFTER_MS);
		await failedTurn;
		live.piCore.emit("agent_settled", {}, live.ctx);

		await vi.advanceTimersByTimeAsync(RETRY_WAIT_SECONDS * 500);
		live.agent.state.messages.push({
			role: "user",
			content: "appended during the retry wait",
			timestamp: Date.now(),
		});
		await vi.advanceTimersByTimeAsync(RETRY_WAIT_SECONDS * 1000);
		await vi.runAllTimersAsync();

		const notices = live.ctxCore.ui.notifications.map((n) => `${n.level}: ${n.message}`);
		console.log("NOTICES", JSON.stringify(notices));
		console.log("SOCKETS", live.socketUrls.length);
		expect(notices).toContain(`warning: ${RETRY_STOP_NOTICE.continuation_superseded}`);
	} finally {
		live.dispose();
	}
}, 30_000);
