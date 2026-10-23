import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { PI_RUN_LOOP_MEMBERS, resolveContinueFromTail } from "../src/session-run-entry.ts";

// ppie-recover dispatches retries through private AgentSession members. The installed pi must provide them,
// otherwise a retry is announced and silently never sent.
test("the installed pi exposes a run entry the retry continuation can drive", () => {
	assert.notEqual(resolveContinueFromTail(AgentSession.prototype), undefined);
});

test("the installed pi still provides every private member ppie-recover patches or calls", () => {
	const members = ["_prepareRetry", "_emitAgentSettled", ...PI_RUN_LOOP_MEMBERS];
	const missing = members.filter(
		(name) => typeof (AgentSession.prototype as unknown as Record<string, unknown>)[name] !== "function",
	);
	assert.deepEqual(missing, []);
});

test("a pi with neither run entry yields no continuation instead of a silent no-op", () => {
	assert.equal(resolveContinueFromTail({}), undefined);
});
