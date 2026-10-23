import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/**
 * Registers commands exercising registerCommand (with argument completions),
 * pi.getCommands, and the ExtensionCommandContext session-control methods:
 * getSystemPromptOptions, waitForIdle, newSession, fork, navigateTree,
 * switchSession, reload.
 */
export function registerCommandCoverage(pi: ExtensionAPI) {
	pi.registerCommand("ppie-custom-provider-stats", {
		description: "Show session entry count and active tool count",
		handler: async (_args, ctx) => {
			const entryCount = ctx.sessionManager.getEntries().length;
			const toolCount = pi.getActiveTools().length;
			ctx.ui.notify(`${entryCount} entries, ${toolCount} active tools`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-deploy", {
		description: "Demonstrates argument autocompletion",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const envs = ["dev", "staging", "prod"];
			const items = envs.filter((env) => env.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			ctx.ui.notify(`Deploying: ${args || "(no target)"}`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-commands", {
		description: "List available slash commands via pi.getCommands()",
		handler: async (_args, ctx) => {
			const commands = pi.getCommands();
			ctx.ui.notify(`${commands.length} commands available`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-prompt-options", {
		description: "Inspect the base system prompt construction options",
		handler: async (_args, ctx) => {
			const options = ctx.getSystemPromptOptions();
			const contextPaths = options.contextFiles?.map((file) => file.path) ?? [];
			ctx.ui.notify(`${contextPaths.length} context files loaded`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-wait-idle", {
		description: "Wait for the agent to fully settle before continuing",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			ctx.ui.notify("Agent is idle", "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-handoff", {
		description: "Start a fresh session and continue there",
		handler: async (_args, ctx) => {
			const kickoff = "Continue in the replacement session";
			const result = await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				setup: async (sm) => {
					sm.appendMessage({
						role: "user",
						content: [{ type: "text", text: "Context from previous session..." }],
						timestamp: Date.now(),
					});
				},
				withSession: async (sessionCtx) => {
					await sessionCtx.sendUserMessage(kickoff);
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("New session cancelled", "warning");
			}
		},
	});

	pi.registerCommand("ppie-custom-provider-fork", {
		description: "Fork the session at the given entry id",
		handler: async (args, ctx) => {
			if (!args) {
				ctx.ui.notify("Usage: /ppie-custom-provider-fork <entry-id>", "warning");
				return;
			}
			const result = await ctx.fork(args, {
				position: "before",
				withSession: async (sessionCtx) => {
					sessionCtx.ui.notify("Now in the forked session", "info");
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("Fork cancelled", "warning");
			}
		},
	});

	pi.registerCommand("ppie-custom-provider-navigate", {
		description: "Navigate to a different point in the session tree",
		handler: async (args, ctx) => {
			if (!args) {
				ctx.ui.notify("Usage: /ppie-custom-provider-navigate <entry-id>", "warning");
				return;
			}
			const result = await ctx.navigateTree(args, {
				summarize: true,
				customInstructions: "Focus on error handling changes",
				replaceInstructions: false,
				label: "ppie-custom-provider-checkpoint",
			});
			if (result.cancelled) {
				ctx.ui.notify("Navigation cancelled", "warning");
			}
		},
	});

	pi.registerCommand("ppie-custom-provider-switch", {
		description: "Switch to another session file",
		handler: async (args, ctx) => {
			if (!args) {
				ctx.ui.notify("Usage: /ppie-custom-provider-switch <session-path>", "warning");
				return;
			}
			const result = await ctx.switchSession(args, {
				withSession: async (sessionCtx) => {
					await sessionCtx.sendUserMessage("Resume work in the replacement session");
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("Switch cancelled", "warning");
			}
		},
	});

	pi.registerCommand("ppie-custom-provider-reload", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			await ctx.reload();
			return;
		},
	});
}
