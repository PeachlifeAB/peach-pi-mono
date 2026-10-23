import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { createRetryEngine } from "../src/agent-retry.ts";
import { configureDebugLog } from "../src/debug-log.ts";
import { registerRetryAgentForSessionManager } from "../src/pi-agent-session-retry-adapter.ts";
import type { RecoveryChainDriver } from "../src/recovery-chain-driver.ts";
import { registerRetryInput } from "../src/retry-input.ts";
import { CtxFakeCore, noOpProxy, PiFakeCore } from "./fakes/pi-fakes.ts";

test("an extension continuation cancels unstarted recovery without taking message custody", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore);
	let observed = 0;
	let engineCancels = 0;
	let recoveryYields = 0;
	let recoveryActive = true;
	const driver = {
		isActive: () => recoveryActive,
		observeContinuation: () => observed++,
	} as unknown as RecoveryChainDriver;
	const engine = {
		isDriving: () => false,
		cancel: () => engineCancels++,
	} as unknown as ReturnType<typeof createRetryEngine>;

	registerRetryInput({
		pi,
		guarded: (_name, handler) => handler,
		driver,
		engine,
		clearUserAborted: () => {},
		resetTurn: () => {},
		nextDemandId: () => "extension-demand-1",
		yieldToContinuation: () => recoveryYields++,
	});
	const result = piCore.emitAndGetResult(
		"input",
		{ type: "input", text: "goal continuation", source: "extension" },
		ctx,
	);

	assert.equal(result, undefined);
	assert.equal(observed, 1);
	assert.equal(engineCancels, 1);
	assert.equal(recoveryYields, 1);
	recoveryActive = false;
	piCore.emitAndGetResult("input", { type: "input", text: "ppie-recover follow-up", source: "extension" }, ctx);
	assert.equal(engineCancels, 1);
	assert.equal(recoveryYields, 1);
	assert.deepEqual(piCore.sentUserMessages, []);
});

// Reported live: while engine.isDriving() was true, AgentSession still
// reported isIdle() — ppie-recover's own drive holds Agent#activeRun, not a
// state the session tracks. The old handler reacted to that mismatch by
// taking custody of the user's message: it steered the text directly onto
// the agent and returned { action: "handled" }, so Pi never processed the
// input natively. But during retry backoff there is no Agent run —
// Agent#signal is undefined: steer() only enqueues, so the correction sat
// stranded in an idle agent's queue, hasPendingMessages() stayed true, and
// pi-core reported "Retry is waiting for pi-core's own queued messages to
// clear…". The discriminator is Agent#signal, not engine.isDriving():
// no run → Pi's native prompt path is safe. Invariant: human input during
// idle backoff cancels ppie-recover's automation and returns undefined so
// Pi's native input path is untouched.
test("human input during retry backoff (driving, session idle, no active run) returns undefined and takes no custody", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore);
	ctxCore.agentIsIdle = true; // session believes idle — the reported mismatch state
	let steerCalls = 0;
	let promptCalls = 0;
	const drivenAgent = {
		signal: undefined, // backoff: no active run (Agent#signal ⇔ activeRun)
		steer: () => steerCalls++,
		prompt: () => {
			promptCalls++;
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		},
	};
	let engineCancels = 0;
	let resetTurnCalls = 0;
	let clearUserAbortedCalls = 0;
	let yieldCalls = 0;
	const driver = {
		isActive: () => false,
		observeContinuation: () => {},
	} as unknown as RecoveryChainDriver;
	const engine = {
		isDriving: () => true,
		cancel: () => engineCancels++,
	} as unknown as ReturnType<typeof createRetryEngine>;

	// The agent IS resolvable through the real adapter's WeakMap — the point
	// is that with no active run the handler must resolve it, see signal
	// undefined, and still take no custody.
	registerRetryAgentForSessionManager(ctxCore.sessionManager, drivenAgent as unknown as Agent, {
		continueCurrent: async () => "unavailable",
	});

	registerRetryInput({
		pi,
		guarded: (_name, handler) => handler,
		driver,
		engine,
		clearUserAborted: () => clearUserAbortedCalls++,
		resetTurn: () => resetTurnCalls++,
		nextDemandId: () => "interactive-demand-1",
		yieldToContinuation: () => yieldCalls++,
	});

	const result = piCore.emitAndGetResult<{ action?: string } | undefined>(
		"input",
		{ type: "input", text: "stop, do something else", source: "interactive" },
		ctx,
	);

	assert.equal(result, undefined, "Pi must keep custody of the input during idle backoff");
	assert.equal(steerCalls, 0, "with no active run, steer would strand the message in an idle agent's queue");
	assert.equal(promptCalls, 0, "Agent.prompt() must never be called from the input handler");
	assert.deepEqual(piCore.sentUserMessages, [], "ppie-recover must never re-send the user's text");
	assert.equal(engineCancels, 1);
	assert.equal(resetTurnCalls, 1);
	assert.equal(clearUserAbortedCalls, 1);
	assert.equal(yieldCalls, 0, "resetTurn already cancels the coordinator, chain, and pending-message gate");
	assert.deepEqual(piCore.runtimeErrors, [], "no host reentrancy error should reach pi core's runtime-error path");
});

// The other side of the Agent#signal discriminator: the session believes
// idle (its bookkeeping does not track ppie-recover's drive) while a real
// Agent run is active — signal defined. Pi's native prompt() would throw
// "Agent is already processing" here, so ppie-recover takes custody: steer
// directly onto the active run, cancel, reset, and report handled.
test("human input against a stale-idle session with an active Agent run is steered onto that run and reported handled", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore);
	ctxCore.agentIsIdle = true; // stale: the session does not track ppie-recover's drive
	let steerCalls = 0;
	const steered: Array<{ content?: Array<{ type?: string; text?: string }> }> = [];
	let promptCalls = 0;
	const drivenAgent = {
		signal: new AbortController().signal, // an active run exists
		steer: (message: unknown) => {
			steerCalls++;
			steered.push(message as { content?: Array<{ type?: string; text?: string }> });
		},
		prompt: () => {
			promptCalls++;
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		},
	};
	const driver = {
		isActive: () => false,
		observeContinuation: () => {},
	} as unknown as RecoveryChainDriver;
	let engineCancels = 0;
	let resetTurnCalls = 0;
	let clearUserAbortedCalls = 0;
	const engine = {
		isDriving: () => true,
		cancel: () => engineCancels++,
	} as unknown as ReturnType<typeof createRetryEngine>;

	registerRetryAgentForSessionManager(ctxCore.sessionManager, drivenAgent as unknown as Agent, {
		continueCurrent: async () => "unavailable",
	});

	registerRetryInput({
		pi,
		guarded: (_name, handler) => handler,
		driver,
		engine,
		clearUserAborted: () => clearUserAbortedCalls++,
		resetTurn: () => resetTurnCalls++,
		nextDemandId: () => "interactive-demand-3",
		yieldToContinuation: () => {},
	});

	const result = piCore.emitAndGetResult<{ action?: string } | undefined>(
		"input",
		{ type: "input", text: "no — take the other approach", source: "interactive" },
		ctx,
	);

	assert.deepEqual(result, { action: "handled" });
	assert.equal(steerCalls, 1, "the message must be steered directly onto the active run");
	assert.equal(promptCalls, 0, "Agent.prompt() must never be called while a run is active");
	assert.equal(steered[0]?.content?.[0]?.text, "no — take the other approach", "the steer must carry the user's text");
	assert.deepEqual(
		piCore.sentUserMessages,
		[],
		"custody is always a direct steer onto the active run; sendUserMessage is never used",
	);
	assert.equal(engineCancels, 1);
	assert.equal(resetTurnCalls, 1);
	assert.equal(clearUserAbortedCalls, 1);
	assert.deepEqual(piCore.runtimeErrors, []);
});

// A recovery chain is active but no agent is resolvable for this session.
// Human input is still observed as an agent-steer continuation, then cancels
// recovery without taking custody.
test("human input while a recovery chain is active is observed as agent-steer, returns undefined, and takes no custody", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore);
	let observed = 0;
	let engineCancels = 0;
	let resetTurnCalls = 0;
	const driver = {
		isActive: () => true,
		observeContinuation: () => observed++,
	} as unknown as RecoveryChainDriver;
	const engine = {
		isDriving: () => true,
		cancel: () => engineCancels++,
	} as unknown as ReturnType<typeof createRetryEngine>;

	registerRetryInput({
		pi,
		guarded: (_name, handler) => handler,
		driver,
		engine,
		clearUserAborted: () => {},
		resetTurn: () => resetTurnCalls++,
		nextDemandId: () => "interactive-demand-2",
		yieldToContinuation: () => {},
	});

	const result = piCore.emitAndGetResult<{ action?: string } | undefined>(
		"input",
		{ type: "input", text: "no, do it this way instead", source: "interactive" },
		ctx,
	);

	assert.equal(result, undefined, "human input must return undefined so Pi keeps custody of it");
	assert.equal(observed, 1, "human input is observed as an agent-steer continuation");
	assert.equal(engineCancels, 1);
	assert.equal(resetTurnCalls, 1, "the generation bump is what closes the active chain");
	assert.deepEqual(piCore.sentUserMessages, []);
});

// Custody unification: session-busy and stale-idle are the same state for
// delivery — an active Agent run exists, so steer() enqueues synchronously
// into that run. The old busy path claimed handled over pi.sendUserMessage,
// which is fire-and-forget through pi's extension wrapper and rejects during
// compaction-controller windows: custody without guaranteed delivery.
test("human input while the session is busy with an active Agent run is steered onto that run, never sent via sendUserMessage", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore);
	ctxCore.agentIsIdle = false; // session believes busy
	let steerCalls = 0;
	const steered: Array<{ content?: Array<{ text?: string }> }> = [];
	const drivenAgent = {
		signal: new AbortController().signal, // an active run exists
		steer: (message: unknown) => {
			steerCalls++;
			steered.push(message as { content?: Array<{ text?: string }> });
		},
	};
	const driver = {
		isActive: () => false,
		observeContinuation: () => {},
	} as unknown as RecoveryChainDriver;
	let engineCancels = 0;
	let resetTurnCalls = 0;
	let clearUserAbortedCalls = 0;
	const engine = {
		isDriving: () => false,
		cancel: () => engineCancels++,
	} as unknown as ReturnType<typeof createRetryEngine>;

	registerRetryAgentForSessionManager(ctxCore.sessionManager, drivenAgent as unknown as Agent, {
		continueCurrent: async () => "unavailable",
	});

	registerRetryInput({
		pi,
		guarded: (_name, handler) => handler,
		driver,
		engine,
		clearUserAborted: () => clearUserAbortedCalls++,
		resetTurn: () => resetTurnCalls++,
		nextDemandId: () => "interactive-demand-4",
		yieldToContinuation: () => {},
	});

	const result = piCore.emitAndGetResult<{ action?: string } | undefined>(
		"input",
		{ type: "input", text: "are you still working on this?", source: "interactive" },
		ctx,
	);

	assert.deepEqual(result, { action: "handled" });
	assert.equal(steerCalls, 1, "the message must be steered directly onto the active run");
	assert.equal(steered[0]?.content?.[0]?.text, "are you still working on this?");
	assert.deepEqual(
		piCore.sentUserMessages,
		[],
		"sendUserMessage is fire-and-forget and must never carry a custody claim",
	);
	assert.equal(engineCancels, 1);
	assert.equal(resetTurnCalls, 1);
	assert.equal(clearUserAbortedCalls, 1);
	assert.deepEqual(piCore.runtimeErrors, []);
});

// Busy/idle desync: the session believes busy but no Agent run exists. No
// guaranteed channel exists — steer() would strand onto an idle Agent and
// sendUserMessage fails silently — so the input must be left to Pi's native
// path, whose prompt() throws loudly to the caller instead of dropping.
test("human input while the session is busy without an active Agent run is left to Pi, never intercepted", () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
	const ctx = noOpProxy(ctxCore);
	ctxCore.agentIsIdle = false; // session believes busy
	let steerCalls = 0;
	const drivenAgent = {
		signal: undefined, // desync: no active run
		steer: () => steerCalls++,
	};
	const driver = {
		isActive: () => false,
		observeContinuation: () => {},
	} as unknown as RecoveryChainDriver;
	let engineCancels = 0;
	let resetTurnCalls = 0;
	const engine = {
		isDriving: () => false,
		cancel: () => engineCancels++,
	} as unknown as ReturnType<typeof createRetryEngine>;

	registerRetryAgentForSessionManager(ctxCore.sessionManager, drivenAgent as unknown as Agent, {
		continueCurrent: async () => "unavailable",
	});

	registerRetryInput({
		pi,
		guarded: (_name, handler) => handler,
		driver,
		engine,
		clearUserAborted: () => {},
		resetTurn: () => resetTurnCalls++,
		nextDemandId: () => "interactive-demand-5",
		yieldToContinuation: () => {},
	});

	const result = piCore.emitAndGetResult<{ action?: string } | undefined>(
		"input",
		{ type: "input", text: "hello?", source: "interactive" },
		ctx,
	);

	assert.equal(result, undefined, "no guaranteed delivery channel exists, so Pi must keep the input");
	assert.equal(steerCalls, 0, "steer onto an idle Agent would strand the message");
	assert.deepEqual(piCore.sentUserMessages, [], "sendUserMessage must never be used for custody");
	assert.equal(engineCancels, 1);
	assert.equal(resetTurnCalls, 1);
	assert.deepEqual(piCore.runtimeErrors, []);
});

// Observability: the input path was the only unlogged custody decision in the
// extension, which made the stranded-message incident invisible in every
// persisted channel. Every received input and every routing decision must
// reach the debug sink.
test("input routing decisions are logged to the debug sink", () => {
	const dir = mkdtempSync(join(tmpdir(), "ppie-recover-input-log-"));
	const logPath = join(dir, "debug.log");
	configureDebugLog({ enabled: true, path: logPath });
	try {
		const piCore = new PiFakeCore();
		const ctxCore = new CtxFakeCore();
		const pi = noOpProxy(piCore) as unknown as ExtensionAPI & PiFakeCore;
		const ctx = noOpProxy(ctxCore);
		ctxCore.agentIsIdle = true;
		const drivenAgent = {
			signal: new AbortController().signal,
			steer: () => {},
		};
		registerRetryAgentForSessionManager(ctxCore.sessionManager, drivenAgent as unknown as Agent, {
			continueCurrent: async () => "unavailable",
		});
		const engine = {
			isDriving: () => true,
			cancel: () => {},
		} as unknown as ReturnType<typeof createRetryEngine>;
		registerRetryInput({
			pi,
			guarded: (_name, handler) => handler,
			driver: { isActive: () => false } as unknown as RecoveryChainDriver,
			engine,
			clearUserAborted: () => {},
			resetTurn: () => {},
			nextDemandId: () => "interactive-demand-6",
			yieldToContinuation: () => {},
		});

		piCore.emitAndGetResult("input", { type: "input", text: "custody me", source: "interactive" }, ctx);

		const log = readFileSync(logPath, "utf8");
		assert.match(log, /input\.received \{[^}]*"sessionIdle":true/);
		assert.match(log, /input\.received \{[^}]*"retryDriving":true/);
		assert.match(log, /input\.received \{[^}]*"agentResolved":true/);
		assert.match(log, /input\.received \{[^}]*"activeRun":true/);
		assert.match(log, /input\.steer_custody/, "the custody decision must be logged");
	} finally {
		configureDebugLog({});
	}
});
