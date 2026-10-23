import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, type Component, type KeybindingsManager, Text } from "@earendil-works/pi-tui";

class PiOpenAIProviderEditor extends CustomEditor {
	handleInput(data: string): void {
		super.handleInput(data);
	}
}

/** Minimal focusable component so ctx.ui.custom() can capture Enter/Escape. */
class ConfirmPrompt implements Component {
	private readonly text: Text;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: boolean) => void;

	constructor(text: Text, keybindings: KeybindingsManager, done: (result: boolean) => void) {
		this.text = text;
		this.keybindings = keybindings;
		this.done = done;
	}

	render(width: number): string[] {
		return this.text.render(width);
	}

	invalidate(): void {
		this.text.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.confirm")) this.done(true);
		if (this.keybindings.matches(data, "tui.select.cancel")) this.done(false);
	}
}

/**
 * Registers a command exercising the full ctx.ui surface: dialogs (with
 * timeout and AbortSignal), status/widget/footer/title, working
 * message/indicator, editor text/paste, autocomplete provider stacking,
 * tool-expansion state, theme management, custom() with overlay options,
 * and setEditorComponent. Also registers message/entry renderers.
 */
export function registerUiCoverage(pi: ExtensionAPI) {
	pi.registerCommand("ppie-custom-provider-ui-demo", {
		description: "Exercise ctx.ui dialogs, widgets, and status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("No interactive UI available in this mode", "warning");
				return;
			}

			const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);
			const confirmed = await ctx.ui.confirm("Timed Confirmation", "Auto-cancels in 5s. Confirm?", {
				timeout: 5000,
			});

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 5000);
			const name = await ctx.ui.input("Name:", "placeholder", { signal: controller.signal });
			clearTimeout(timeoutId);

			const edited = await ctx.ui.editor("Edit:", "prefilled text");

			ctx.ui.notify(`choice=${choice ?? "none"} confirmed=${confirmed} name=${name ?? "none"}`, "info");

			ctx.ui.setStatus("ppie-custom-provider-ui", "Active");
			ctx.ui.setWorkingMessage("Thinking deeply...");
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setWorkingIndicator({
				frames: [ctx.ui.theme.fg("dim", "·"), ctx.ui.theme.fg("accent", "●")],
				intervalMs: 120,
			});
			ctx.ui.setHiddenThinkingLabel("thinking (hidden)");

			ctx.ui.setWidget("ppie-custom-provider-widget", ["Line 1", "Line 2"]);
			ctx.ui.setWidget("ppie-custom-provider-widget-below", ["Below"], { placement: "belowEditor" });
			ctx.ui.setFooter((_tui, theme) => ({
				render(_width: number) {
					return [theme.fg("dim", "ppie-custom-provider footer")];
				},
				invalidate() {},
			}));
			ctx.ui.setHeader((_tui, theme) => new Text(theme.fg("accent", "ppie-custom-provider"), 0, 0));
			ctx.ui.setTitle("pi - ppie-custom-provider");

			ctx.ui.setEditorText("Prefill text");
			const current = ctx.ui.getEditorText();
			ctx.ui.pasteToEditor("pasted content");

			const wasExpanded = ctx.ui.getToolsExpanded();
			ctx.ui.setToolsExpanded(true);
			ctx.ui.setToolsExpanded(wasExpanded);

			const themes = ctx.ui.getAllThemes();
			const lightTheme = ctx.ui.getTheme("light");
			if (lightTheme) {
				const result = ctx.ui.setTheme(lightTheme);
				if (!result.success) {
					ctx.ui.notify(`Failed: ${result.error}`, "error");
				}
			}

			ctx.ui.notify(`edited=${edited ?? "none"} current=${current} themes=${themes.length}`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-overlay", {
		description: "Show a custom overlay component",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Overlay demo requires interactive mode", "warning");
				return;
			}

			const result = await ctx.ui.custom<boolean>(
				(_tui, theme, keybindings, done) => {
					const text = new Text(theme.fg("accent", "Press the configured confirm or cancel key"), 1, 1);
					return new ConfirmPrompt(text, keybindings, done);
				},
				{
					overlay: true,
					overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
					onHandle: (handle) => {
						handle.focus();
					},
				},
			);

			ctx.ui.notify(`Overlay result: ${result}`, "info");
		},
	});

	pi.registerCommand("ppie-custom-provider-editor", {
		description: "Swap in a custom editor component",
		handler: async (_args, ctx) => {
			const previous = ctx.ui.getEditorComponent();
			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				void previous;
				return new PiOpenAIProviderEditor(tui, theme, keybindings);
			});
		},
	});

	pi.registerCommand("ppie-custom-provider-editor-reset", {
		description: "Restore the default editor",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorComponent(undefined);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: ["#"],
			async getSuggestions(lines, line, col, options) {
				const beforeCursor = (lines[line] ?? "").slice(0, col);
				const match = beforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
				if (!match) {
					return current.getSuggestions(lines, line, col, options);
				}
				return {
					prefix: `#${match[1] ?? ""}`,
					items: [
						{ value: "#ppie-custom-provider", label: "#ppie-custom-provider", description: "Extension marker" },
					],
				};
			},
			applyCompletion(lines, line, col, item, prefix) {
				return current.applyCompletion(lines, line, col, item, prefix);
			},
			shouldTriggerFileCompletion(lines, line, col) {
				return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
			},
		}));
	});

	pi.registerMessageRenderer<{ note?: string }>("ppie-custom-provider-message", (message, options, theme) => {
		let text = theme.fg("accent", `[${message.customType}] `) + message.content;
		if (options.expanded && message.details) {
			text += `\n${theme.fg("dim", JSON.stringify(message.details, null, 2))}`;
		}
		return new Text(text, options.outputPad, 0);
	});

	pi.registerEntryRenderer<{ title: string; count: number }>(
		"ppie-custom-provider-status-card",
		(entry, { expanded }, theme) => {
			const data = entry.data ?? { title: "unknown", count: 0 };
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(`${theme.bold(data.title)}: ${data.count}`));
			if (expanded) {
				box.addChild(new Text(theme.fg("dim", JSON.stringify(data, null, 2))));
			}
			return box;
		},
	);
}
