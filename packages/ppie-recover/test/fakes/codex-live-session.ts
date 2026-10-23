import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	AgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installRetrySessionAdapter } from "../../src/pi-agent-session-retry-adapter.ts";
import retry from "../../src/retry.ts";
import { resolveRetryPolicy } from "../../src/retry-policy.ts";
import { asExtensionApi, asExtensionContext, CtxFakeCore, PiFakeCore } from "./pi-fakes.ts";

// Live value from session 01a137cd (provider_transport_failure at line 1148): the failure arrives 80 s after the response starts.
export const LIVE_FAILURE_AFTER_MS = 80_000;

export const codexModel = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 128_000,
} as Model<"openai-codex-responses">;

// Test token only: the provider reads the account id from these claims (same shape as pi-ai's codex tests).
const fakeAccessToken = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
	"utf8",
).toString("base64")}.bbb`;

const streamedEvents = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Recovered" },
];

// A tool call streaming when the socket dies: the failure lands mid-call, as in the live session.
const toolCallEvents = [
	{
		type: "response.output_item.added",
		item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" },
	},
	{ type: "response.function_call_arguments.delta", delta: '{"command":"ls' },
];

const completionEvents = [
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Recovered" }],
		},
	},
	{
		type: "response.done",
		response: {
			status: "completed",
			end_turn: false,
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

// "stall" opens and never answers a request: the turn stays in flight.
// "complete-late" streams a completed response LATE_COMPLETION_MS after the request is sent.
export type SocketScript =
	| "stream-then-fail-after-live-delay"
	| "stream-tool-call-then-fail-after-live-delay"
	| "complete"
	| "complete-late"
	| "stall";
const LATE_COMPLETION_MS = 20_000;
type Listener = (event: unknown) => void;

// Cloud socket double. "stream-then-fail-after-live-delay" streams its first events at once, then fails
// LIVE_FAILURE_AFTER_MS later with "WebSocket error" (eventsEmitted: true in session 01a137cd).
class ScriptedWebSocket {
	private readonly listeners = new Map<string, Set<Listener>>();
	constructor(
		private readonly script: SocketScript,
		private readonly sentBytes: number[],
	) {
		queueMicrotask(() => this.dispatch("open", {}));
	}
	addEventListener(type: string, listener: Listener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		this.listeners.set(type, set);
		set.add(listener);
	}
	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}
	send(data: string): void {
		this.sentBytes.push(new TextEncoder().encode(data).byteLength);
		if (this.script === "stall") return;
		const completes = this.script === "complete" || this.script === "complete-late";
		const streamsToolCall = this.script === "stream-tool-call-then-fail-after-live-delay";
		const events = completes
			? [...streamedEvents, ...completionEvents]
			: streamsToolCall
				? toolCallEvents
				: streamedEvents;
		const deliver = () => {
			for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
		};
		if (this.script === "complete-late") setTimeout(deliver, LATE_COMPLETION_MS);
		else queueMicrotask(deliver);
		if (
			this.script === "stream-then-fail-after-live-delay" ||
			this.script === "stream-tool-call-then-fail-after-live-delay"
		) {
			setTimeout(() => this.dispatch("error", { message: "WebSocket error" }), LIVE_FAILURE_AFTER_MS);
		}
	}
	close(): void {}
	private dispatch(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

/** The message history from session 01a137cd, sanitized (see test/fixtures). */
export function loadSessionHistory(): AgentMessage[] {
	const entries = JSON.parse(
		readFileSync(new URL("../fixtures/session-01a137cd-history.json", import.meta.url), "utf8"),
	) as { message: AgentMessage }[];
	return entries.map((entry) => entry.message);
}

export type LiveCodexSession = {
	agent: Agent;
	session: AgentSession;
	piCore: PiFakeCore;
	ctx: ExtensionContext;
	ctxCore: CtxFakeCore;
	socketUrls: string[];
	sentBytes: number[];
	httpRequests: string[];
	readDebugLog(): string;
	dispose(): void;
};

/**
 * A real AgentSession running the real pi-ai codex provider and the real ppie-recover extension.
 * Only the transport is replaced: each WebSocket follows the next entry of `sockets`, and no HTTP request is sent.
 */
export async function startLiveCodexSession(options: {
	history: AgentMessage[];
	sockets: SocketScript[];
	retryWaitSeconds: number;
	/** pi core settings, e.g. the user's `retry` block; defaults to pi's in-memory defaults. */
	piSettings?: Parameters<typeof SettingsManager.inMemory>[0];
}): Promise<LiveCodexSession> {
	const originalWebSocket = globalThis.WebSocket;
	const originalFetch = globalThis.fetch;
	const socketUrls: string[] = [];
	const sentBytes: number[] = [];
	const httpRequests: string[] = [];
	const debugDir = mkdtempSync(join(tmpdir(), "ppie-recover-live-session-"));
	const debugLogPath = join(debugDir, "debug.log");

	const nextScript = (url: string): SocketScript => {
		socketUrls.push(url);
		return options.sockets[Math.min(socketUrls.length - 1, options.sockets.length - 1)];
	};
	globalThis.WebSocket = class extends ScriptedWebSocket {
		constructor(url: string) {
			super(nextScript(url), sentBytes);
		}
	} as unknown as typeof WebSocket;
	globalThis.fetch = (async (input: unknown) => {
		httpRequests.push(String(input));
		return new Response('{"detail":"stubbed: no network in tests"}', { status: 500 });
	}) as typeof fetch;

	const settingsManager = SettingsManager.inMemory(options.piSettings);
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
	const sessionManager = SessionManager.inMemory(process.cwd());
	// pi 1.2 builds each request from the session manager's projection, so history must be recorded there too.
	for (const message of options.history)
		sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
	const agent = new Agent({
		initialState: { model: codexModel, messages: options.history },
		streamFn: (model, context, streamOptions) =>
			streamSimple(model, context, { ...streamOptions, apiKey: fakeAccessToken }),
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		resourceLoader,
		modelRuntime: {
			hasConfiguredAuth: () => true,
			getModel: () => codexModel,
			resolveModel: async (
				model: Model<"openai-codex-responses">,
				_messages: unknown,
				route: { thinkingLevel?: string },
			) => ({
				model,
				thinkingLevel: route.thinkingLevel,
			}),
		} as unknown as ModelRuntime,
		initialActiveToolNames: [],
	});
	installRetrySessionAdapter();

	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	Object.defineProperty(ctxCore, "sessionManager", { value: sessionManager });
	ctxCore.attachAgentState(agent.state);
	const pi = asExtensionApi(piCore);
	const ctx = asExtensionContext(ctxCore);
	retry(pi, {
		policy: resolveRetryPolicy({
			retry: { seconds_before_first_retry: options.retryWaitSeconds },
			debug: { path: debugLogPath },
		}),
	});
	session.subscribe((event) => {
		if (event.type === "message_start") piCore.emit("message_start", {}, ctx);
		if (event.type === "message_end") piCore.emit("message_end", { msg: event.message }, ctx);
		if (event.type === "agent_end") piCore.emit("agent_end", {}, ctx);
	});

	return {
		agent,
		session,
		piCore,
		ctx,
		ctxCore,
		socketUrls,
		sentBytes,
		httpRequests,
		readDebugLog: () => readFileSync(debugLogPath, "utf8"),
		dispose: () => {
			globalThis.WebSocket = originalWebSocket;
			globalThis.fetch = originalFetch;
			rmSync(debugDir, { recursive: true, force: true });
		},
	};
}
