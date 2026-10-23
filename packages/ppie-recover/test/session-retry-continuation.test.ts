import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	createSessionRetryContinuationPort,
	installRetrySessionAdapter,
	registerRetryAgentForSessionManager,
} from "../src/pi-agent-session-retry-adapter.ts";

const model = {
	id: "retry-session-model",
	name: "Retry session model",
	api: "openai-completions",
	provider: "contract",
	baseUrl: "http://contract.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8000,
} as Model<"openai-completions">;

function cleanStream(): ReturnType<StreamFn> {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AgentMessage;
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: message };
			yield { type: "done", reason: "stop", message };
		},
		result: () => Promise.resolve(message),
	} as unknown as ReturnType<StreamFn>;
}

test("session-owned retry keeps extension continuations on the session queue", async () => {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let requests = 0;
	const streamFn = (async () => {
		requests++;
		if (requests === 1) await gate;
		return cleanStream();
	}) as StreamFn;
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const initial = { role: "user", content: "retry this", timestamp: Date.now() } as AgentMessage;
	const sessionManager = SessionManager.inMemory(process.cwd());
	const agent = new Agent({ initialState: { model, messages: [initial] }, streamFn });
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		resourceLoader,
		modelRuntime: {} as ModelRuntime,
		initialActiveToolNames: [],
	});
	installRetrySessionAdapter();
	session.subscribe(() => {});
	const port = createSessionRetryContinuationPort(() => sessionManager);

	const retryRun = port.continueCurrent(initial, () => {});
	while (!session.isStreaming) await Promise.resolve();
	await session.prompt("goal continuation", {
		streamingBehavior: "followUp",
		source: "extension",
	});
	release();

	assert.equal(await retryRun, "completed");
	assert.equal(requests, 2);
	assert.equal(
		agent.state.messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("goal continuation"),
		),
		true,
	);
	const requestsAfterGoal = requests;
	assert.equal(await port.continueCurrent(initial, () => assert.fail("stale retry prepared")), "superseded");
	assert.equal(requests, requestsAfterGoal);
});

test("prepare() must not run — and the run must not be entered — when a user prompt already holds Agent#activeRun at the pre-dispatch check", async () => {
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const initial = { role: "user", content: "retry this", timestamp: Date.now() } as AgentMessage;
	const sessionManager = SessionManager.inMemory(process.cwd());
	const streamFn = (async () => cleanStream()) as StreamFn;
	const agent = new Agent({ initialState: { model, messages: [initial] }, streamFn });
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		resourceLoader,
		modelRuntime: {} as ModelRuntime,
		initialActiveToolNames: [],
	});
	installRetrySessionAdapter();
	session.subscribe(() => {});

	// continueCurrent awaits BOTH session.waitForIdle() and
	// session.agent.waitForIdle() before its checks. Firing the competing
	// prompt between those two awaits still gets caught: session.agent.waitForIdle()
	// (Agent#activeRun's own promise) would then await the just-started run
	// and only resolve once it finishes, leaving Agent#signal undefined again
	// by the time continueCurrent's checks run (verified: an earlier draft of
	// this test injected there and asserted "completed", not "superseded").
	// The reachable gap is strictly AFTER both awaits resolve: this fires a
	// real, unawaited agent.prompt() call right after session.agent.waitForIdle()
	// resolves, synchronously setting Agent#activeRun (agent.js
	// runWithLifecycle sets this.activeRun before its own first await) before
	// continueCurrent's own continuation proceeds to its later checks —
	// reproducing the real race deterministically.
	let userPrompt: Promise<void> | undefined;
	const originalAgentWaitForIdle = session.agent.waitForIdle.bind(session.agent);
	session.agent.waitForIdle = async () => {
		await originalAgentWaitForIdle();
		if (!userPrompt) {
			userPrompt = agent.prompt([{ role: "user", content: "user typed this", timestamp: Date.now() }]);
		}
	};

	let continueCalls = 0;
	const originalContinue = session.agent.continue.bind(session.agent);
	session.agent.continue = async () => {
		continueCalls++;
		return originalContinue();
	};

	const port = createSessionRetryContinuationPort(() => sessionManager);

	let prepared = false;
	const result = await port.continueCurrent(initial, () => {
		prepared = true;
	});

	assert.equal(result, "superseded");
	assert.equal(prepared, false, "prepare() must not run for an attempt the occupancy check is about to abort");
	assert.equal(continueCalls, 0, "the run must not be entered while Agent#activeRun is held elsewhere");

	await userPrompt;
});

test("a run.call() error unrelated to the busy-agent race is not swallowed", async () => {
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const initial = { role: "user", content: "retry this", timestamp: Date.now() } as AgentMessage;
	const sessionManager = SessionManager.inMemory(process.cwd());
	const streamFn = (async () => cleanStream()) as StreamFn;
	const agent = new Agent({ initialState: { model, messages: [initial] }, streamFn });
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		resourceLoader,
		modelRuntime: {} as ModelRuntime,
		initialActiveToolNames: [],
	});
	installRetrySessionAdapter();
	session.subscribe(() => {});

	session.agent.continue = async () => {
		throw new Error("some unrelated provider failure");
	};

	const port = createSessionRetryContinuationPort(() => sessionManager);

	await assert.rejects(
		() => port.continueCurrent(initial, () => {}),
		(error: Error) => error.message === "some unrelated provider failure",
	);
});

test("engine.cancel()/isCurrent() going false while continueCurrent awaits idle supersedes it without dispatching", async () => {
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const initial = { role: "user", content: "retry this", timestamp: Date.now() } as AgentMessage;
	const sessionManager = SessionManager.inMemory(process.cwd());
	const streamFn = (async () => cleanStream()) as StreamFn;
	const agent = new Agent({ initialState: { model, messages: [initial] }, streamFn });
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		resourceLoader,
		modelRuntime: {} as ModelRuntime,
		initialActiveToolNames: [],
	});
	installRetrySessionAdapter();
	session.subscribe(() => {});

	const sessionWithPrivateRetry = session as unknown as {
		_runAgentPrompt: (messages: unknown[]) => Promise<void>;
	};
	let runAgentPromptCalls = 0;
	sessionWithPrivateRetry._runAgentPrompt = async () => {
		runAgentPromptCalls++;
	};

	const port = createSessionRetryContinuationPort(() => sessionManager);

	// Simulates retry-input.ts's real cancel path: a user Enter during
	// continueCurrent's waitForIdle calls engine.cancel()/resetTurn(), which
	// agent-retry.ts wires into isCurrent as "!cancelled && generation ===
	// myGeneration". isCurrent going false must supersede the attempt before
	// prepare()/run.call, not just be ignored.
	let prepared = false;
	const result = await port.continueCurrent(
		initial,
		() => {
			prepared = true;
		},
		() => false,
	);

	assert.equal(result, "superseded");
	assert.equal(prepared, false, "prepare() must not run once isCurrent() reports the attempt is stale");
	assert.equal(
		runAgentPromptCalls,
		0,
		"_runAgentPrompt must not be entered once isCurrent() reports the attempt is stale",
	);
});

test("separate session managers keep retry continuations independent", async () => {
	const firstManager = {};
	const secondManager = {};
	let firstRuns = 0;
	let secondRuns = 0;
	registerRetryAgentForSessionManager(firstManager, {} as Agent, {
		continueCurrent: async () => {
			firstRuns++;
			return "completed";
		},
	});
	registerRetryAgentForSessionManager(secondManager, {} as Agent, {
		continueCurrent: async () => {
			secondRuns++;
			return "completed";
		},
	});

	await Promise.all([
		createSessionRetryContinuationPort(() => firstManager).continueCurrent(undefined, () => {}),
		createSessionRetryContinuationPort(() => secondManager).continueCurrent(undefined, () => {}),
	]);

	assert.deepEqual([firstRuns, secondRuns], [1, 1]);
});
