import { expect, test } from "vitest";
import { loadSessionHistory, startLiveCodexSession } from "./fakes/codex-live-session.ts";

// Your expectation, on real timers: the WebSocket error is noticed, no activity happens during the 16 s wait,
// so ppie-recover must dispatch the retry. A red result here means the real clock path does not retry.
test("real clock: a WebSocket error with no activity during the 16 s wait is retried", async () => {
	const live = await startLiveCodexSession({
		history: loadSessionHistory(),
		sockets: ["stream-then-fail-after-live-delay", "complete"],
		retryWaitSeconds: 16,
	});
	try {
		const failedTurn = live.agent.continue();
		await failedTurn;
		live.piCore.emit("agent_settled", {}, live.ctx);

		const deadline = Date.now() + 110_000;
		while (live.socketUrls.length < 2 && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 250));

		expect(live.ctxCore.ui.notifications.some((n) => n.message.startsWith("Retry attempt 1"))).toBe(true);
		expect(live.socketUrls, live.readDebugLog()).toHaveLength(2);
	} finally {
		live.dispose();
	}
}, 130_000);
