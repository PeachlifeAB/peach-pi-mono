import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

interface PiEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	customType?: string;
	data?: unknown;
	message?: Record<string, unknown>;
}
interface PiSession {
	sessionId: string;
	cwd: string;
	leafId: string | null;
	entries: PiEntry[];
}
interface EventIdentity {
	at: string;
	uuid: string;
}
type PiTraceEvent = EventIdentity &
	(
		| { kind: "typed" | "injected" | "assistant"; text: string }
		| { kind: "compaction" }
		| { kind: "tool_call"; id: string; name: string; input: Record<string, unknown>; cwd: string }
		| { kind: "tool_result"; id: string; ok: boolean; isError: boolean; text: string }
	);
const validate = new Ajv2020().compile<PiSession>(
	JSON.parse(readFileSync(new URL("./pi-session.schema.json", import.meta.url), "utf8")),
);

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashPiInput(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: unknown) =>
			record(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("\n");
}

function ancestry(session: PiSession): PiEntry[] {
	const entries = new Map<string, PiEntry>();
	for (const entry of session.entries) {
		if (entries.has(entry.id)) throw new Error("Duplicate Pi entry id");
		entries.set(entry.id, entry);
	}
	const branch: PiEntry[] = [];
	const seen = new Set<string>();
	let leaf = session.leafId;
	while (leaf !== null) {
		if (seen.has(leaf)) throw new Error("Cyclic Pi ancestry");
		seen.add(leaf);
		const entry = entries.get(leaf);
		if (!entry) throw new Error("Missing Pi ancestor");
		if (!Number.isFinite(Date.parse(entry.timestamp))) throw new Error("Invalid Pi timestamp");
		branch.push(entry);
		leaf = entry.parentId;
	}
	return branch.reverse();
}

export function normalizePiTool(toolName: string, input: Record<string, unknown>) {
	const name = toolName.toLowerCase();
	const file = input.path ?? input.file_path;
	const tool_name =
		name === "bash" ? "Bash" : name === "read" ? "Read" : name === "write" ? "Write" : file ? "Edit" : toolName;
	return { tool_name, tool_input: { ...input, ...(typeof file === "string" ? { file_path: file } : {}) } };
}
export function normalizePiSession(input: unknown) {
	if (!validate(input)) throw new Error("Invalid Pi session snapshot");
	const events: PiTraceEvent[] = [];
	const receipts: unknown[] = [];
	for (const entry of ancestry(input)) {
		const identity = { at: entry.timestamp, uuid: entry.id };
		if (entry.type === "custom" && entry.customType === "ppie-trail-input") {
			receipts.push(entry.data);
			continue;
		}
		if (entry.type === "compaction") {
			events.push({ ...identity, kind: "compaction" });
			continue;
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "user") {
			const receipt = receipts.shift();
			const content = text(message.content);
			const human =
				content.length > 0 &&
				record(receipt) &&
				receipt.source === "interactive" &&
				receipt.textSha === hashPiInput(content);
			events.push({ ...identity, kind: human ? "typed" : "injected", text: content });
		} else if (message.role === "assistant") {
			const content = text(message.content);
			if (content) events.push({ ...identity, kind: "assistant", text: content });
			if (!Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (!record(part) || part.type !== "toolCall") continue;
				if (typeof part.id !== "string" || typeof part.name !== "string" || !record(part.arguments))
					throw new Error("Invalid Pi tool call");
				const tool = normalizePiTool(part.name, part.arguments);
				events.push({
					...identity,
					kind: "tool_call",
					id: part.id,
					name: tool.tool_name,
					input: tool.tool_input,
					cwd: input.cwd,
				});
			}
		} else if (message.role === "toolResult") {
			if (typeof message.toolCallId !== "string" || typeof message.isError !== "boolean")
				throw new Error("Invalid Pi tool result");
			events.push({
				...identity,
				kind: "tool_result",
				id: message.toolCallId,
				ok: !message.isError,
				isError: message.isError,
				text: text(message.content),
			});
		}
	}
	return { host: "pi" as const, sessionId: input.sessionId, leafId: input.leafId, events };
}
