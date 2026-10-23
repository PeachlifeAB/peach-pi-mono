import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
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
import { assistantMessage, createScriptedProvider } from "./fakes/scripted-provider.ts";

// A max_attempts: 0 rule must hold for Pi's own auto-retry too: ppie-recover
// reporting "not retried" while the host retries anyway is a lie to the user.

const model = {
	id: "scripted-model",
	name: "Core retry veto",
	api: "openai-completions",
	provider: "scripted",
	baseUrl: "http://scripted.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8000,
} as Model<"openai-completions">;

async function runOnce(errorMessage: string, smartOverrides: unknown[]): Promise<number> {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-core-veto-"));
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(projectDir);
	mkdirSync(agentDir);
	const configPath = join(root, "ppie-recover.json");
	writeFileSync(configPath, JSON.stringify({ retry: { smart_overrides: smartOverrides } }));
	const policy = loadRetryPolicy({ explicitPath: configPath });

	let settled = false;
	const observer: ExtensionFactory = (pi) => {
		pi.on("agent_settled", () => {
			settled = true;
		});
	};
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager,
		extensionFactories: [(pi) => retry(pi, { policy }), observer],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const sessionManager = SessionManager.inMemory(projectDir);
	const scripted = createScriptedProvider([assistantMessage("error", errorMessage), assistantMessage("stop")]);
	const agent = new Agent({ initialState: { model, messages: [] }, streamFn: scripted.streamFn });
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: projectDir,
		resourceLoader,
		modelRuntime: {
			hasConfiguredAuth: () => true,
			checkAuth: async () => undefined,
			isUsingOAuth: () => false,
			getAuth: async () => undefined,
		} as unknown as ModelRuntime,
		initialActiveToolNames: [],
	});
	try {
		await session.prompt("hello");
		for (let i = 0; i < 100 && !settled; i++) await new Promise((r) => setTimeout(r, 10));
		// Let any retry the host scheduled (1ms backoff) reach the provider.
		await new Promise((r) => setTimeout(r, 50));
		return scripted.requests.length;
	} finally {
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

test("a max_attempts: 0 rule stops Pi's own retry of a rate limit", { timeout: 5000 }, async () => {
	const requests = await runOnce("429 rate limit exceeded", [{ when: { words: ["rate limit"] }, max_attempts: 0 }]);
	assert.equal(requests, 1);
});

test("a retryable transport failure still reaches a retry", { timeout: 5000 }, async () => {
	const requests = await runOnce("fetch failed", [{ when: { words: ["unrelated wording"] }, max_attempts: 0 }]);
	assert.ok(requests >= 2, `expected a retry, saw ${requests} request(s)`);
});
