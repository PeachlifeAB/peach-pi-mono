import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RecoveryChainTelemetryEvent } from "../src/recovery-chain.ts";
import retry from "../src/retry.ts";
import { asExtensionApi, asExtensionContext, CtxFakeCore, PiFakeCore } from "./fakes/pi-fakes.ts";
import { registerRetryAgentForSessionManager } from "./fakes/retry-agent.ts";
import { ENABLED_OVERFLOW_POLICY } from "./fakes/retry-policy.ts";
import { assistantMessage, createScriptedProvider } from "./fakes/scripted-provider.ts";

const mainMemoryGuard =
	"Request aborted: process memory limit exceeded (usage 57.7 GB, ceiling 55.86 GB). Reduce context size.";
const ownSummaryMemoryGuard =
	'Summarization failed: 400: {"message":"Prefill context too large for available memory","code":"prefill_memory_exceeded"}';

async function flushAsync() {
	for (let index = 0; index < 12; index++) {
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-07-19T17:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

test("RETRY-2 replay yields to an external continuation during host compaction", async () => {
	const provider = createScriptedProvider([assistantMessage("error", mainMemoryGuard), assistantMessage("stop")]);
	const telemetry: RecoveryChainTelemetryEvent[] = [];
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.contextWindow = 500_000;
	ctxCore.failAllCompacts = ownSummaryMemoryGuard;
	const pi = asExtensionApi(piCore);
	const ctx = asExtensionContext(ctxCore);
	retry(pi, { policy: ENABLED_OVERFLOW_POLICY, recoveryTelemetry: { onEvent: (event) => telemetry.push(event) } });

	const agent = new Agent({
		streamFn: provider.streamFn,
		onPayload: (payload) => piCore.emitAndGetResult("before_provider_request", { payload }, ctx),
	});
	agent.state.messages = [{ role: "user", content: "x".repeat(320_000), timestamp: 0 }];
	ctxCore.attachAgentState(agent.state);
	registerRetryAgentForSessionManager(ctxCore.sessionManager, agent);
	agent.subscribe((event) => {
		if (event.type === "message_end") {
			piCore.emit("message_end", { msg: event.message }, ctx);
		}
	});
	ctxCore.onCompactStart = () => {
		piCore.emit(
			"session_before_compact",
			{ reason: "manual", willRetry: false, signal: new AbortController().signal },
			ctx,
		);
	};

	// Main provider failure opens the chain. Keep the zero-delay own fallback
	// queued until the externally-owned host lifecycle starts.
	await agent.prompt("start");
	piCore.emit("agent_end", {}, ctx);
	piCore.emit("agent_settled", {}, ctx);
	expect(provider.requests).toHaveLength(1);

	// This is the full public extension surface available for an auto-compaction
	// summary: start is visible, failed completion is not. No fake summary
	// provider request or assistant message_end is synthesized.
	piCore.emit(
		"session_before_compact",
		{ reason: "overflow", willRetry: true, signal: new AbortController().signal },
		ctx,
	);

	// A foreign extension continuation is observed but remains host-owned.
	// ppie-recover yields its unstarted recovery work instead of racing Goal.
	piCore.emit("input", { text: "Goal continuing", source: "extension" }, ctx);
	expect(provider.requests).toHaveLength(1);
	const eventCountAfterYield = telemetry.length;

	await vi.advanceTimersByTimeAsync(720_000);
	await flushAsync();

	expect(ctxCore.compactions).toHaveLength(0);
	expect(provider.requests).toHaveLength(1);
	expect(ctxCore.ui.notifications.filter((notice) => notice.message.includes("Emergency-pruned"))).toHaveLength(0);
	expect(piCore.runtimeErrors).toHaveLength(0);
	expect(telemetry.filter((event) => event.type === "chain-opened")).toHaveLength(1);
	expect(
		telemetry.filter((event) => event.type === "continuation-observed" && event.source === "external-extension"),
	).toHaveLength(1);
	expect(telemetry.find((event) => event.type === "chain-closed")?.reason).toBe("cancelled");
	expect(JSON.stringify(telemetry)).not.toContain("Goal continuing");
	expect(telemetry).toHaveLength(eventCountAfterYield);
});
