import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { installRetrySessionAdapter } from "../src/pi-agent-session-retry-adapter.ts";
import { registerRetryVeto } from "../src/retry-veto.ts";

// Pi's _prepareRetry reads its retry settings first; counting that read shows
// whether the host's own retry path ran at all.
function fakeSession() {
	const sessionManager = {};
	let settingsReads = 0;
	const session = {
		sessionManager,
		_retryAttempt: 0,
		settingsManager: {
			getRetrySettings: () => {
				settingsReads++;
				return { enabled: false, maxRetries: 0, baseDelayMs: 0 };
			},
		},
	};
	return { session, sessionManager, reads: () => settingsReads };
}

const prepareRetry = (session: object, message: unknown): Promise<boolean> =>
	(
		AgentSession.prototype as unknown as { _prepareRetry: (this: object, m: unknown) => Promise<boolean> }
	)._prepareRetry.call(session, message);

test("a vetoed error never reaches the host's retry path", async () => {
	installRetrySessionAdapter();
	const { session, sessionManager, reads } = fakeSession();
	registerRetryVeto(sessionManager, (errorMessage) => errorMessage === "429 rate limit");

	assert.equal(await prepareRetry(session, { errorMessage: "429 rate limit" }), false);
	assert.equal(reads(), 0);
});

test("an error the veto allows reaches the host's retry path", async () => {
	installRetrySessionAdapter();
	const { session, sessionManager, reads } = fakeSession();
	registerRetryVeto(sessionManager, () => false);

	await prepareRetry(session, { errorMessage: "fetch failed" });
	assert.equal(reads(), 1);
});
