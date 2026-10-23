import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const model = {
	id: "contract-model",
	name: "Contract model",
	api: "openai-completions",
	provider: "contract",
	baseUrl: "http://contract.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8000,
} as Model<"openai-completions">;

function rejectedSummaryStream(): ReturnType<StreamFn> {
	const error = new Error("summarization rejected by memory guard");
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () => Promise.reject(error),
			};
		},
		result: () => Promise.reject(error),
	} as ReturnType<StreamFn>;
}

test("real AgentSession failed manual compaction emits only before_compact to extensions", async () => {
	const observed: string[] = [];
	let beforeSignal: AbortSignal | undefined;
	const extension: ExtensionFactory = (pi) => {
		pi.on("session_before_compact", (event) => {
			observed.push("before");
			beforeSignal = event.signal;
		});
		pi.on("session_compact", () => {
			observed.push("complete");
		});
		pi.on("message_end", () => {
			observed.push("message-end");
		});
	};
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager,
		extensionFactories: [extension],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.inMemory(process.cwd());
	sessionManager.appendMessage({
		role: "user",
		content: "x".repeat(500_000),
		timestamp: Date.now(),
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "y".repeat(100_000) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 120_000,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120_001,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});

	const agent = new Agent({
		initialState: {
			model,
			messages: sessionManager.buildSessionContext().messages,
		},
		streamFn: (() => rejectedSummaryStream()) as StreamFn,
	});
	const modelRuntime = {
		getApiKeyAndHeaders: async () => ({ ok: false, error: "not needed" }),
	} as unknown as ModelRuntime;
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		resourceLoader,
		modelRuntime,
		initialActiveToolNames: [],
	});

	await assert.rejects(session.compact(), /summarization rejected by memory guard/);
	assert.deepEqual(observed, ["before"]);
	assert.equal(beforeSignal?.aborted, false);
});
