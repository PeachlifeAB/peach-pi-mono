import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OpenAIProviderConfig } from "./config.ts";
import { logEvent, resolveLoggingEnabled } from "./logging.ts";

const OVERFLOW_INSTRUCTIONS = "Recent messages were summarized to stay within the context window.";

function ignoreStaleContext(action: () => void): void {
	try {
		action();
	} catch (error) {
		if (error instanceof Error && error.message.includes("extension ctx is stale")) return;
		throw error;
	}
}

/**
 * Registers a handler for every documented lifecycle/session/agent/model/tool
 * event not already covered by legacy-provider.ts's `message_end` handler.
 */
export function registerEventCoverage(pi: ExtensionAPI, config: OpenAIProviderConfig) {
	const loggingEnabled = resolveLoggingEnabled(pi, config);

	// Startup events.
	// `project_trust` must return a decision — it is the one event a logger
	// cannot observe passively, so the log call lives here in the real handler.
	pi.on("project_trust", async (event, ctx) => {
		logEvent(loggingEnabled, config, event.cwd, "project_trust", event);
		if (!ctx.hasUI) return { trusted: "undecided" };
		const trusted = await ctx.ui.confirm("Trust project?", event.cwd);
		return { trusted: trusted ? "yes" : "undecided" };
	});

	pi.on("resources_discover", async (_event, _ctx) => {
		return { skillPaths: [], promptPaths: [], themePaths: [] };
	});

	// Session events.
	pi.on("session_start", async (event, ctx) => {
		ignoreStaleContext(() => {
			ctx.ui.setStatus(
				"ppie-custom-provider-session",
				`session_start: ${event.reason}${event.previousSessionFile ? ` (from ${event.previousSessionFile})` : ""}`,
			);
		});
	});

	pi.on("session_info_changed", async (_event, _ctx) => {});

	pi.on("session_before_switch", async (_event, _ctx) => {
		return {};
	});

	pi.on("session_before_fork", async (_event, _ctx) => {
		return {};
	});

	pi.on("session_before_compact", async (event, _ctx) => {
		if (event.reason === "overflow") {
			return {
				compaction: {
					summary: OVERFLOW_INSTRUCTIONS,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		}
		return {};
	});

	pi.on("session_compact", async (_event, _ctx) => {});

	pi.on("session_before_tree", async (_event, _ctx) => {
		return {};
	});

	pi.on("session_tree", async (_event, _ctx) => {});

	pi.on("session_shutdown", async (_event, _ctx) => {
		// Idempotent teardown point for session-scoped resources started in session_start.
	});

	// Agent events.
	pi.on("before_agent_start", async (event, _ctx) => {
		// Demonstrates reading systemPromptOptions without mutating it.
		const toolCount = event.systemPromptOptions.selectedTools?.length ?? 0;
		return {
			systemPrompt: `${event.systemPrompt}\n\n(ppie-custom-provider: ${toolCount} tools active)`,
		};
	});

	pi.on("agent_start", async (_event, _ctx) => {});

	pi.on("agent_end", async (_event, _ctx) => {});

	pi.on("agent_settled", async (_event, ctx) => {
		ignoreStaleContext(() => ctx.ui.setStatus("ppie-custom-provider-session", undefined));
	});

	pi.on("turn_start", async (_event, _ctx) => {});

	pi.on("turn_end", async (_event, _ctx) => {});

	// Message events. `message_end` overflow normalization lives in legacy-provider.ts.
	pi.on("message_start", async (_event, _ctx) => {});

	pi.on("message_update", async (_event, _ctx) => {});

	// Tool execution lifecycle (distinct from tool_call/tool_result, which can mutate).
	pi.on("tool_execution_start", async (_event, _ctx) => {});

	pi.on("tool_execution_update", async (_event, _ctx) => {});

	pi.on("tool_execution_end", async (_event, _ctx) => {});

	// Provider/model events.
	pi.on("context", async (event, _ctx) => {
		return { messages: event.messages };
	});

	pi.on("before_provider_headers", (event, ctx) => {
		ignoreStaleContext(() => {
			event.headers["x-ppie-custom-provider-session-id"] = ctx.sessionManager.getSessionId();
		});
	});

	// `before_provider_request` and `after_provider_response` are handled in
	// `logging.ts`, which shows both what they carry and what returning a value
	// from `before_provider_request` does (it replaces the outgoing payload).
	// pi supports multiple handlers per event, so registering them there rather
	// than here is a placement choice, not a constraint.

	pi.on("model_select", async (_event, _ctx) => {});

	pi.on("thinking_level_select", async (_event, _ctx) => {});

	// Tool call/result interception (distinct from the execution lifecycle events above).
	pi.on("tool_call", async (_event, _ctx) => {
		return { block: false };
	});

	pi.on("tool_result", async (_event, _ctx) => {
		return {};
	});

	// User bash and input.
	pi.on("user_bash", () => {});

	pi.on("input", async (_event, _ctx) => {
		return { action: "continue" as const };
	});
}
