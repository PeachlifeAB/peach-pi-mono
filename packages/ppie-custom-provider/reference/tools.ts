import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	formatSize,
	isBashToolResult,
	isToolCallEventType,
	keyHint,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const noteSchema = Type.Object({
	action: StringEnum(["list", "add"] as const),
	text: Type.Optional(Type.String()),
});

export type NoteToolInput = Static<typeof noteSchema>;

const editFileSchema = Type.Object({
	path: Type.String(),
	oldText: Type.String(),
	newText: Type.String(),
});

const SEARCHABLE_TOOL_NAMES = new Set(["ppie-custom-provider_fetch_status"]);

/** Narrows an unknown value to an indexable object, excluding null and arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the `notes` array out of an unknown tool-result `details` payload.
 * `details` is typed as unknown at the session-history boundary, so every
 * element is checked rather than assumed to be a string array.
 */
function extractNotes(details: unknown): string[] | undefined {
	if (!isRecord(details)) return undefined;
	const { notes } = details;
	if (!Array.isArray(notes)) return undefined;
	return notes.every((note) => typeof note === "string") ? notes : undefined;
}

/**
 * Registers custom tools that exercise: promptSnippet/promptGuidelines,
 * prepareArguments, onUpdate streaming, terminate, renderShell "self",
 * renderCall/renderResult with shared context.state, StringEnum params,
 * withFileMutationQueue, output truncation utilities, dynamic tool loading
 * (search_tools pattern), and overriding a built-in tool (read).
 */
export function registerToolCoverage(pi: ExtensionAPI) {
	let notes: string[] = [];

	pi.on("session_start", async (_event, ctx) => {
		notes = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "ppie-custom-provider_notes"
			) {
				notes = extractNotes(entry.message.details) ?? notes;
			}
		}
	});

	pi.registerTool({
		name: "ppie-custom-provider_notes",
		label: "Notes",
		description: "List or add notes kept for this session",
		promptSnippet: "List or add short text notes",
		promptGuidelines: ["Use ppie-custom-provider_notes when the user asks to jot down or recall a note."],
		parameters: noteSchema,
		// Runs BEFORE schema validation, so `args` is genuinely unknown: it is
		// whatever the model emitted. This shim only rewrites the one legacy shape
		// it recognises ({note} -> {text}) and otherwise passes the value through
		// untouched, letting pi's schema validation reject anything invalid. The
		// single unavoidable assertion is on the pass-through, where the value is
		// returned exactly as received rather than being vouched for.
		// The explicit `: NoteToolInput` return annotation is load-bearing: it makes
		// the compiler check each returned object against the schema type instead of
		// inferring a wider union that would only fail at the assignment.
		prepareArguments(args): NoteToolInput {
			if (!isRecord(args)) return args as NoteToolInput;

			const { note, action, text } = args;
			const needsRewrite = typeof note === "string" && text === undefined;
			if (!needsRewrite) return args as NoteToolInput;

			// Build the result explicitly instead of spreading `args`; a spread would
			// widen `action` back to `string` and reintroduce the unsound cast.
			return {
				action: action === "list" ? "list" : "add",
				text: note,
			};
		},
		async execute(_toolCallId, params, _signal, onUpdate) {
			onUpdate?.({ content: [{ type: "text", text: "Working..." }], details: { notes } });

			if (params.action === "add" && params.text) {
				notes = [...notes, params.text];
			}

			return {
				content: [{ type: "text", text: params.action === "list" ? notes.join("\n") || "(no notes)" : "Added" }],
				details: { notes },
			};
		},
		renderCall(args, theme, context) {
			// `lastComponent` is `Component | undefined` — reusing it avoids
			// reallocating on every redraw, but it is only ours to reuse if it really
			// is the Text we returned last time, so check rather than assert.
			const previous = context.lastComponent;
			const text = previous instanceof Text ? previous : new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("ppie-custom-provider_notes "))}${theme.fg("muted", args.action)}`,
			);
			return text;
		},
		renderResult(result, { expanded }, theme, _context) {
			const notesFromResult = extractNotes(result.details);
			let text = theme.fg("success", "done");
			if (expanded && notesFromResult) {
				text += `\n${notesFromResult.map((n) => `  ${theme.fg("dim", n)}`).join("\n")}`;
			} else if (!expanded) {
				text += ` (${keyHint("app.tools.expand", "to expand")})`;
			}
			return new Text(text, 0, 0);
		},
	});

	// Mutates a file via read-modify-write; queued so it can't race the built-in edit tool.
	pi.registerTool({
		name: "ppie-custom-provider_replace",
		label: "Replace Text",
		description: "Replace exact text in a file",
		parameters: editFileSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absolutePath = resolve(ctx.cwd, params.path);
			return withFileMutationQueue(absolutePath, async () => {
				await mkdir(dirname(absolutePath), { recursive: true });
				const current = await readFile(absolutePath, "utf8").catch(() => "");
				const next = current.replace(params.oldText, params.newText);
				await writeFile(absolutePath, next, "utf8");
				return {
					content: [{ type: "text", text: `Updated ${params.path}` }],
					details: {},
				};
			});
		},
	});

	// Wraps arbitrary large output and applies the documented truncation utilities.
	pi.registerTool({
		name: "ppie-custom-provider_dump",
		label: "Dump",
		description: "Return a large block of text, truncated to the documented limits",
		parameters: Type.Object({ text: Type.String() }),
		renderShell: "self",
		async execute(_toolCallId, params) {
			const truncation = truncateHead(params.text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let result = truncation.content;
			if (truncation.truncated) {
				result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
			}
			return { content: [{ type: "text", text: result }], details: {} };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("accent", "ppie-custom-provider_dump"), 0, 0);
		},
	});

	// Terminating tool: signals the agent to stop after this batch.
	pi.registerTool({
		name: "ppie-custom-provider_finish",
		label: "Finish",
		description: "Signal that the task is complete and no further LLM turn is needed",
		parameters: Type.Object({ summary: Type.String() }),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: params.summary }],
				details: {},
				terminate: true,
			};
		},
	});

	// Dynamic tool loading: a lazily-activated tool plus its loader.
	pi.registerTool({
		name: "ppie-custom-provider_fetch_status",
		label: "Fetch Status",
		description: "Report the extension's fetch status",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "idle" }], details: {} };
		},
	});

	pi.registerTool({
		name: "ppie-custom-provider_search_tools",
		label: "Search Tools",
		description: "Search for and enable ppie-custom-provider tools relevant to a task",
		promptSnippet: "Search for additional ppie-custom-provider tools when needed",
		promptGuidelines: ["Use ppie-custom-provider_search_tools when a task needs a capability not currently active."],
		parameters: Type.Object({ query: Type.String() }),
		async execute(_toolCallId, params) {
			const matches = pi
				.getAllTools()
				.filter((tool) => SEARCHABLE_TOOL_NAMES.has(tool.name))
				.filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(params.query.toLowerCase()))
				.map((tool) => tool.name);

			const active = pi.getActiveTools();
			const added = matches.filter((name) => !active.includes(name));
			if (added.length > 0) pi.setActiveTools([...new Set([...active, ...added])]);

			return {
				content: [
					{ type: "text", text: added.length > 0 ? `Loaded: ${added.join(", ")}` : "No new tools matched" },
				],
				details: { matches, added },
			};
		},
	});

	pi.on("session_start", () => {
		const initialTools = pi.getActiveTools().filter((name) => !SEARCHABLE_TOOL_NAMES.has(name));
		pi.setActiveTools([...new Set([...initialTools, "ppie-custom-provider_search_tools"])]);
	});

	// Read-only observer over tool_call/tool_result for the built-in bash tool.
	pi.on("tool_call", (event) => {
		if (isToolCallEventType("bash", event)) {
			void event.input.command;
		}
	});

	pi.on("tool_result", (event) => {
		if (isBashToolResult(event)) {
			void event.details;
		}
	});
}
