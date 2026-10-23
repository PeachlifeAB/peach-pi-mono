import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import retry from "../src/retry.ts";
import { loadRetryPolicy } from "../src/retry-policy-node.ts";
import { createScriptedProvider } from "./fakes/scripted-provider.ts";

const model = {
	id: "dynamic-compaction-contract",
	name: "Dynamic compaction contract",
	api: "openai-completions",
	provider: "scripted",
	baseUrl: "http://scripted.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8000,
} as Model<"openai-completions">;

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistant(text: string, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: Math.max(0, totalTokens - 1),
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: zeroCost,
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type Harness = {
	readonly session: AgentSession;
	readonly events: string[];
	readonly requests: unknown[];
	cleanup(): void;
};

async function createHarness(coreCompactionEnabled: boolean): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-dynamic-host-"));
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(projectDir);
	mkdirSync(agentDir);

	const configPath = join(root, "ppie-recover.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			memory_overflow_protection: {
				compaction: { enabled: true, dynamic: { enabled: true, at_context_ratio: 0.8 } },
			},
		}),
	);
	const policy = loadRetryPolicy({ explicitPath: configPath });
	const retryWithPolicy: ExtensionFactory = (pi) => retry(pi, { policy });

	const events: string[] = [];
	const observer: ExtensionFactory = (pi) => {
		pi.on("agent_end", () => {
			events.push("agent_end");
		});
		pi.on("agent_settled", () => {
			events.push("agent_settled");
		});
		pi.on("session_before_compact", (event) => {
			events.push(`before:${event.reason}`);
		});
		pi.on("session_compact", (event) => {
			events.push(`compact:${event.reason}`);
		});
	};
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: coreCompactionEnabled,
			reserveTokens: coreCompactionEnabled ? 40_000 : 16_384,
			keepRecentTokens: 1000,
		},
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager,
		extensionFactories: [retryWithPolicy, observer],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.inMemory(projectDir);
	sessionManager.appendMessage({
		role: "user",
		content: "u".repeat(100_000),
		timestamp: Date.now() - 2,
	});
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "a".repeat(100_000) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 49_999,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50_000,
			cost: zeroCost,
		},
		stopReason: "stop",
		timestamp: Date.now() - 1,
	});

	const scripted = createScriptedProvider([
		assistant("terminal response", 102_400),
		assistant("compaction summary", 100),
		assistant("post-core response", 100),
	]);
	const agent = new Agent({
		initialState: {
			model,
			messages: sessionManager.buildSessionContext().messages,
		},
		streamFn: scripted.streamFn,
	});
	const modelRuntime = {
		hasConfiguredAuth: () => true,
		checkAuth: async () => undefined,
		isUsingOAuth: () => false,
		getAuth: async () => undefined,
	} as unknown as ModelRuntime;
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: projectDir,
		resourceLoader,
		modelRuntime,
		initialActiveToolNames: [],
	});

	return {
		session,
		events,
		requests: scripted.requests,
		cleanup() {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function waitForEvent(events: readonly string[], expected: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (events.includes(expected)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${expected}; observed ${JSON.stringify(events)}`);
}

test("dynamic threshold compacts exactly once after the real host settles", { timeout: 5000 }, async () => {
	const harness = await createHarness(false);
	try {
		await harness.session.prompt("complete one terminal response");
		await waitForEvent(harness.events, "compact:manual");

		assert.deepEqual(
			harness.events.filter((event) => event === "before:manual"),
			["before:manual"],
		);
		assert.equal(harness.events.filter((event) => event === "compact:manual").length, 1);
		assert.ok(harness.events.indexOf("agent_end") < harness.events.indexOf("agent_settled"));
		assert.equal(harness.requests.length, 2);
	} finally {
		harness.cleanup();
	}
});

test("Pi-core threshold compaction is not duplicated at settled", { timeout: 5000 }, async () => {
	const harness = await createHarness(true);
	try {
		await harness.session.prompt("complete one terminal response");
		await waitForEvent(harness.events, "agent_settled");

		assert.equal(harness.events.filter((event) => event === "before:threshold").length, 1);
		assert.equal(harness.events.filter((event) => event === "compact:threshold").length, 1);
		assert.equal(harness.events.filter((event) => event === "before:manual").length, 0);
		assert.equal(harness.requests.length, 2);
	} finally {
		harness.cleanup();
	}
});
