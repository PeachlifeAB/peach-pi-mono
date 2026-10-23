import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
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

const model = {
	id: "deepseek-chat",
	name: "DeepSeek Chat",
	api: "openai-responses",
	provider: "ds4-flash",
	baseUrl: "http://scripted.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 127_000,
	maxTokens: 4096,
} as Model<"openai-responses">;

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

test("real AgentSession retries and repairs Response incomplete: max_tokens", { timeout: 5000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-responses-host-"));
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(projectDir);
	mkdirSync(agentDir);
	const configPath = join(root, "ppie-recover.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			memory_overflow_protection: {
				compaction: {
					enabled: true,
					dynamic: { enabled: true, at_context_ratio: 0.9 },
					forced: { enabled: false },
				},
				prune: { enabled: false },
			},
			model_fallback: { enabled: false },
		}),
	);
	const policy = loadRetryPolicy({ explicitPath: configPath });
	const extension: ExtensionFactory = (pi) => retry(pi, { policy });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager,
		extensionFactories: [extension],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const requests: Array<Record<string, unknown>> = [];
	let requestCount = 0;
	let resolveSecondRequest: (() => void) | undefined;
	const secondRequest = new Promise<void>((resolve) => {
		resolveSecondRequest = resolve;
	});
	const streamFn: StreamFn = async (_model, context, options) => {
		requestCount++;
		let payload: unknown = { messages: context.messages, max_tokens: 16 };
		payload = (await options?.onPayload?.(payload, _model)) ?? payload;
		requests.push(structuredClone(payload as Record<string, unknown>));
		if (requestCount === 2) resolveSecondRequest?.();
		const message =
			requestCount === 1
				? {
						role: "assistant" as const,
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "error" as const,
						rawStopReason: "incomplete.max_tokens",
						errorMessage: "Response incomplete: max_tokens",
						usage: {
							input: 0,
							output: 16,
							cacheRead: 123_046,
							cacheWrite: 273,
							totalTokens: 123_335,
							cost: zeroCost,
						},
						timestamp: Date.now(),
					}
				: {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: "Recovered." }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "stop" as const,
						usage: {
							input: 0,
							output: 5,
							cacheRead: 123_046,
							cacheWrite: 273,
							totalTokens: 123_324,
							cost: zeroCost,
						},
						timestamp: Date.now(),
					};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push(
				message.stopReason === "error"
					? { type: "error", reason: "error", error: message }
					: { type: "done", reason: "stop", message },
			);
		});
		return stream;
	};

	const sessionManager = SessionManager.inMemory(projectDir);
	const extensionRunnerRef: {
		current?: { hasHandlers(name: string): boolean; emitBeforeProviderRequest(payload: unknown): Promise<unknown> };
	} = {};
	const agent = new Agent({
		initialState: { model, messages: [] },
		streamFn,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			return runner?.hasHandlers("before_provider_request") ? runner.emitBeforeProviderRequest(payload) : payload;
		},
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
		extensionRunnerRef: extensionRunnerRef as never,
	});

	try {
		await session.prompt("start turn");
		await secondRequest;
		await session.waitForIdle();
		assert.equal(requests.length, 2, "the real host lifecycle triggered exactly one repaired request");
		assert.equal(requests[0].max_tokens, 16);
		assert.equal(requests[1].max_tokens, 3681, "repair used the live 127k headroom from the reported session");
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
