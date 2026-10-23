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
	id: "compaction-continuation",
	name: "Compaction continuation",
	api: "openai-completions",
	provider: "scripted",
	baseUrl: "http://scripted.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 74_000,
	maxTokens: 16_000,
} as Model<"openai-completions">;

function assistant(text: string, stopReason: "stop" | "length", input: number, output: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input + output,
			cost: { ...model.cost, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

for (const owner of ["recovery", "external"] as const) {
	test(`${owner} compaction handles a length-only result correctly`, {
		timeout: 5000,
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "ppie-recover-continuation-"));
		const projectDir = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(projectDir);
		mkdirSync(agentDir);
		const configPath = join(root, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				retry: { smart_overrides: [{ when: { words: ["context overflow"] }, seconds_before_first_retry: 0 }] },
				memory_overflow_protection: { compaction: { enabled: true, forced: { enabled: owner === "recovery" } } },
				debug: false,
			}),
		);
		const policy = loadRetryPolicy({ explicitPath: configPath });
		let finishResolve!: () => void;
		const finished = new Promise<void>((resolve) => {
			finishResolve = resolve;
		});
		const errors: string[] = [];
		const events: string[] = [];
		let session: AgentSession;
		const observer: ExtensionFactory = (pi) => {
			pi.on("session_before_compact", (event) => {
				events.push("before");
				// Same public hook used by custom compactors; no summary network request.
				return {
					compaction: {
						summary: "Offline summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
			pi.on("session_compact", () => {
				events.push(`compact:busy=${session.isCompacting}`);
			});
			pi.on("agent_settled", () => {
				const last = session.agent.state.messages.at(-1);
				if (last?.role === "assistant" && last.stopReason === "stop") finishResolve();
			});
		};
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false, reserveTokens: 26_000, keepRecentTokens: 14_000 },
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
		sessionManager.appendMessage({ role: "user", content: "u".repeat(100_000), timestamp: Date.now() - 2 });
		sessionManager.appendMessage(assistant("a".repeat(100_000), "stop", 49_999, 1));
		const scripted = createScriptedProvider([
			assistant("unfinished answer with substantial progress", "length", 69_772, 390),
			assistant("Recovered", "stop", 100, 10),
		]);
		const agent = new Agent({
			initialState: { model, messages: sessionManager.buildSessionContext().messages },
			streamFn: scripted.streamFn,
		});
		const modelRuntime = {
			hasConfiguredAuth: () => true,
			checkAuth: async () => undefined,
			isUsingOAuth: () => false,
			getAuth: async () => undefined,
		} as unknown as ModelRuntime;
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: projectDir,
			resourceLoader,
			modelRuntime,
			initialActiveToolNames: [],
		});
		session.subscribe((event) => {
			if (event.type === "compaction_end") events.push(`end:busy=${session.isCompacting}`);
		});
		await session.bindExtensions({
			onError: (error) => {
				errors.push(error.error);
				finishResolve();
			},
		});
		try {
			await session.prompt("Continue working");
			if (owner === "external") {
				await session.compact();
				await finished;
			}
			await session.waitForIdle();
			assert.deepEqual(errors, []);
			if (owner === "recovery") {
				assert.deepEqual(events, []);
				assert.equal(scripted.requests.length, 1);
			} else {
				assert.deepEqual(events, ["before", "compact:busy=true", "end:busy=false"]);
				assert.equal(scripted.requests.length, 2);
			}
			const followUps = sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes(
							"Continue exactly from where your previous response stopped",
						),
				);
			assert.equal(followUps.length, owner === "external" ? 1 : 0);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
}
