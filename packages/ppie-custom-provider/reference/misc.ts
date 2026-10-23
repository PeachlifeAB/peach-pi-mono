import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Registers coverage for the remaining ExtensionAPI methods not exercised by
 * events.ts, tools.ts, commands.ts, or ui.ts: registerShortcut, pi.exec,
 * setModel, getThinkingLevel/setThinkingLevel, pi.events, sendMessage,
 * sendUserMessage, appendEntry, setSessionName/getSessionName, setLabel.
 *
 * Not registered by `index.ts`. See the note there: this is reference material,
 * kept typechecked but kept out of real sessions.
 *
 * The `ppie-custom-provider-log` flag previously declared here now lives in
 * `logging.ts`, beside the code that reads it, because it is real product
 * surface rather than demonstration.
 */
export function registerMiscCoverage(pi: ExtensionAPI) {
	// A global, unnamespaced keyspace: pi's own bindings claim nearly every
	// `ctrl+<letter>`, and this one collides with `tui.altScreen.searchPrevious`.
	// Pi resolves the conflict in the extension's favor, so registering this in a
	// real session silently takes the binding away from the user.
	pi.registerShortcut("ctrl+shift+g", {
		description: "Show whether ppie-custom-provider logging is enabled",
		handler: async (ctx) => {
			const enabled = pi.getFlag("ppie-custom-provider-log") === true;
			ctx.ui.notify(`provider logging is ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-exec", {
		description: "Run a shell command via pi.exec",
		handler: async (args, ctx) => {
			const result = await pi.exec("sh", ["-c", args || "echo ok"], { timeout: 5000 });
			ctx.ui.notify(`exit=${result.code} stdout=${result.stdout.trim()}`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-thinking", {
		description: "Report and bump the current thinking level",
		handler: async (_args, ctx) => {
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			const current = pi.getThinkingLevel();
			const nextIndex = (levels.indexOf(current) + 1) % levels.length;
			pi.setThinkingLevel(levels[nextIndex]);
			ctx.ui.notify(`thinking: ${current} -> ${levels[nextIndex]}`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-model", {
		description: "Attempt to switch to a specific model",
		handler: async (args, ctx) => {
			if (!args) {
				ctx.ui.notify("Usage: /ppie-custom-provider-model <provider> <model-id>", "warning");
				return;
			}
			const [providerId, modelId] = args.split(" ");
			const model = modelId ? ctx.modelRegistry.find(providerId, modelId) : undefined;
			if (!model) {
				ctx.ui.notify("Model not found", "error");
				return;
			}
			const success = await pi.setModel(model);
			if (!success) {
				ctx.ui.notify("No API key for this model", "error");
			}
		},
	});

	pi.registerCommand("ppie-custom-provider-broadcast", {
		description: "Emit an inter-extension event and send a session message",
		handler: async (_args, ctx) => {
			pi.events.emit("ppie-custom-provider:ping", { at: Date.now() });

			pi.sendMessage({
				customType: "ppie-custom-provider-message",
				content: "Broadcast from /ppie-custom-provider-broadcast",
				display: true,
				details: {},
			});

			pi.appendEntry("ppie-custom-provider-status-card", { title: "Broadcast sent", count: 1 });

			pi.setSessionName("ppie-custom-provider-demo");
			const name = pi.getSessionName();
			ctx.ui.notify(`Session named: ${name ?? "(none)"}`, "info");

			const leafId = ctx.sessionManager.getLeafId();
			if (leafId) {
				pi.setLabel(leafId, "ppie-custom-provider-checkpoint");
			}
		},
	});

	pi.registerCommand("ppie-custom-provider-follow-up", {
		description: "Send a user message queued as a follow-up",
		handler: async (args) => {
			pi.sendUserMessage(args || "What is 2+2?", { deliverAs: "followUp" });
		},
	});

	const unsubscribe = pi.events.on("ppie-custom-provider:ping", (data) => {
		void data;
	});
	void unsubscribe;
}
