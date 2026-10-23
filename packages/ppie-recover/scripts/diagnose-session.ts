#!/usr/bin/env node

// This is a lossy diagnostic view, not a session backup.
// It emits only PI failures, OMLX incidents, and the -C records around them.
// It drops unrelated session messages and unrelated OMLX log entries.
// It drops token usage, costs, cache counts, response IDs, and most metadata.
// It drops tool-result details, including duplicated truncation payloads.
// It drops assistant thinking unless that thinking itself contains "error".
// It reduces tool calls to their name, ID, and a short argument preview.
// It clips chat and tool text to 100 characters around each "error" match.
// It shows at most three error excerpts per text field and omits the rest.
// Read the original PI session and OMLX log when you need full evidence.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

interface Entry {
	at: number;
	incident: boolean;
	record: JsonObject;
}

const DEFAULT_OMLX_LOG = join(homedir(), ".omlx", "logs", "server.log");

const ERROR_RADIUS = 100;
const MAX_ERROR_WINDOWS = 3;

const OMLX_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[,.](\d{1,6}))?\s+-\s+(.*)$/;

const OMLX_LEVEL_PATTERN = /^(.+?)\s+-\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+-\s+(?:\[[^\]]*]\s+-\s+)?(.*)$/;

function main(): void {
	const args = process.argv.slice(2);
	const contextLines = 1;
	let sessionPath: string | undefined;
	let omlxPath = DEFAULT_OMLX_LOG;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];

		if (argument === "-C" || argument === "--context-lines") {
			index += 1;
			continue;
		}

		if (argument === "--omlx") {
			omlxPath = args[index + 1] ?? DEFAULT_OMLX_LOG;
			index += 1;
			continue;
		}

		if (!argument.startsWith("-")) {
			sessionPath = argument;
		}
	}

	if (!sessionPath) {
		process.stderr.write("Usage: diagnose-session.ts <session.jsonl> [-C N] [--omlx <path>]\n");
		process.exitCode = 2;
		return;
	}

	if (!existsSync(sessionPath)) {
		process.stderr.write(`Session file not found: ${sessionPath}\n`);
		process.exitCode = 2;
		return;
	}

	const piEntries = readPiEntries(sessionPath);
	const omlxEntries = existsSync(omlxPath) ? readOmlxEntries(omlxPath) : [];

	if (!existsSync(omlxPath) && omlxPath !== DEFAULT_OMLX_LOG) {
		process.stderr.write(`OMLX log not found: ${omlxPath}\n`);
	}

	const piIncidents = piEntries.filter((entry) => entry.incident).length;
	const omlxIncidents = omlxEntries.filter((entry) => entry.incident).length;

	process.stderr.write(
		`--- FILTERED DIAGNOSTIC VIEW ---\n` +
			`Original PI session: ${sessionPath}\n` +
			`OMLX log: ${omlxPath}\n` +
			`PI entries: ${piEntries.length}; PI incidents: ${piIncidents}\n` +
			`OMLX entries: ${omlxEntries.length}; OMLX incidents: ${omlxIncidents}\n` +
			`Stdout below is strict JSONL. Use the original files for full evidence.\n\n`,
	);

	const timeline = [...selectWithContext(piEntries, contextLines), ...selectWithContext(omlxEntries, contextLines)]
		.map((entry, order) => ({ entry, order }))
		.sort((left, right) => left.entry.at - right.entry.at || left.order - right.order);

	for (const { entry } of timeline) {
		process.stdout.write(`${JSON.stringify(entry.record)}\n`);
	}

	process.stderr.write(
		`\n--- END FILTERED DIAGNOSTIC VIEW ---\n` +
			`Original PI session: ${sessionPath}\n` +
			`OMLX log: ${omlxPath}\n` +
			`Use the original files for full evidence.\n`,
	);
}

function readPiEntries(sessionPath: string): Entry[] {
	const entries: Entry[] = [];
	const lines = readFileSync(sessionPath, "utf8").split(/\r?\n/);

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index].trim();

		if (!line) {
			continue;
		}

		let event: unknown;

		try {
			event = JSON.parse(line);
		} catch {
			process.stderr.write(`Skipping invalid PI JSON: ${sessionPath}:${index + 1}\n`);
			continue;
		}

		if (!isJsonObject(event)) {
			continue;
		}

		const at = piTimestamp(event);

		if (at === undefined) {
			continue;
		}

		const incidentKind = piIncidentKind(event);

		entries.push({
			at,
			incident: incidentKind !== undefined,
			record: compactPiEvent(event, at, incidentKind),
		});
	}

	return entries;
}

function readOmlxEntries(omlxPath: string): Entry[] {
	const entries: Entry[] = [];
	const content = readFileSync(omlxPath, "utf8");
	let current: Entry | undefined;

	for (const line of content.split(/\r?\n/)) {
		if (!line) {
			continue;
		}

		const header = parseOmlxHeader(line);

		if (header) {
			const level = omlxLevel(header.message);
			const incident = isOmlxIncident(header.message, level);

			current = {
				at: header.at,
				incident,
				record: {
					source: "OMLX",
					kind: incident ? "ERROR" : "CONTEXT",
					normalizedDate: new Date(header.at).toISOString(),
					type: "log",
					level,
					message: excerptAroundError(header.message),
				},
			};

			entries.push(current);
			continue;
		}

		if (current) {
			const previousMessage = current.record.message;

			current.record.message = typeof previousMessage === "string" ? `${previousMessage}\n${line}` : line;
		}
	}

	return entries;
}

function parseOmlxHeader(line: string): { at: number; message: string } | undefined {
	const match = OMLX_TIMESTAMP_PATTERN.exec(line);

	if (!match) {
		return undefined;
	}

	const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, payload] = match;

	const milliseconds = Number(`${fractionText ?? ""}000`.slice(0, 3));

	const at = new Date(
		Number(yearText),
		Number(monthText) - 1,
		Number(dayText),
		Number(hourText),
		Number(minuteText),
		Number(secondText),
		milliseconds,
	).getTime();

	if (!Number.isFinite(at)) {
		return undefined;
	}

	return {
		at,
		message: payload ?? "",
	};
}

function omlxLevel(message: string): string {
	const match = OMLX_LEVEL_PATTERN.exec(message);
	return match?.[2] ?? "LOG";
}

function isOmlxIncident(message: string, level: string): boolean {
	if (level === "ERROR" || level === "CRITICAL") {
		return true;
	}

	return /(?:\b(?:error|exception|traceback|fatal|failed|failure|rejected|reject|oom)\b|out of memory|memory guard|preflight rejected|memory pressure level: .*-> hard)/i.test(
		message,
	);
}

function selectWithContext(entries: Entry[], contextLines: number): Entry[] {
	const selected = new Set<number>();

	for (let index = 0; index < entries.length; index += 1) {
		if (!entries[index].incident) {
			continue;
		}

		const start = Math.max(0, index - contextLines);
		const end = Math.min(entries.length - 1, index + contextLines);

		for (let contextIndex = start; contextIndex <= end; contextIndex += 1) {
			selected.add(contextIndex);
		}
	}

	return entries.filter((_, index) => selected.has(index));
}

function piTimestamp(event: JsonObject): number | undefined {
	const outerTimestamp = timestampMs(event.timestamp);

	if (outerTimestamp !== undefined) {
		return outerTimestamp;
	}

	const message = asJsonObject(event.message);
	return message ? timestampMs(message.timestamp) : undefined;
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 10_000_000_000 ? value * 1_000 : value;
	}

	if (typeof value === "string") {
		const parsed = Date.parse(value);

		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
}

function piIncidentKind(event: JsonObject): string | undefined {
	if (stringField(event, "type") === "compaction") {
		return "COMPACTION";
	}

	const message = asJsonObject(event.message);

	if (message?.isError === true) {
		return "TOOL";
	}

	if (message?.stopReason === "length") {
		return "LENGTH";
	}

	if (message?.stopReason === "error") {
		return "ASSISTANT";
	}

	if (message?.stopReason === "aborted") {
		return "ABORTED";
	}

	if (typeof message?.errorMessage === "string" && message.errorMessage.trim().length > 0) {
		return "ASSISTANT";
	}

	if (typeof event.errorMessage === "string" && event.errorMessage.trim().length > 0) {
		return "ASSISTANT";
	}

	return undefined;
}

function compactPiEvent(event: JsonObject, timestampMs: number, incidentKind: string | undefined): JsonObject {
	const isCompaction = incidentKind === "COMPACTION";
	const record: JsonObject = {
		source: "PI",
		kind: isCompaction ? "COMPACTION" : incidentKind ? "ERROR" : "CONTEXT",
		normalizedDate: new Date(timestampMs).toISOString(),
		eventType: stringField(event, "type") ?? "event",
	};

	const id = stringField(event, "id");
	const parentId = stringField(event, "parentId");

	if (id) {
		record.id = id;
	}

	if (parentId) {
		record.parentId = parentId;
	}

	if (incidentKind && !isCompaction) {
		record.errorKind = incidentKind;
	}

	const message = asJsonObject(event.message);

	if (!message) {
		return record;
	}

	const role = stringField(message, "role");
	const provider = stringField(message, "provider");
	const model = stringField(message, "model");
	const stopReason = stringField(message, "stopReason");
	const toolName = stringField(message, "toolName");
	const toolCallId = stringField(message, "toolCallId");
	const errorMessage = stringField(message, "errorMessage") ?? stringField(event, "errorMessage");

	if (role) {
		record.role = role;
	}

	if (provider) {
		record.provider = provider;
	}

	if (model) {
		record.model = model;
	}

	if (stopReason) {
		record.stopReason = stopReason;
	}

	if (toolName) {
		record.toolName = toolName;
	}

	if (toolCallId) {
		record.toolCallId = toolCallId;
	}

	if (typeof message.isError === "boolean") {
		record.isError = message.isError;
	}

	if (errorMessage) {
		record.errorMessage = excerptAroundError(errorMessage);
	}

	const content = compactContent(message.content, incidentKind !== undefined && !isCompaction);

	if (content.length > 0) {
		record.content = content;
	}

	return record;
}

function compactContent(content: unknown, includeErrorThinking: boolean): JsonObject[] {
	const blocks: unknown[] = Array.isArray(content)
		? content
		: typeof content === "string"
			? [{ type: "text", text: content }]
			: [];

	const compacted: JsonObject[] = [];

	for (const rawBlock of blocks) {
		const block = asJsonObject(rawBlock);

		if (!block) {
			continue;
		}

		const type = stringField(block, "type");

		if (type === "text") {
			const text = stringField(block, "text");

			if (text) {
				compacted.push({
					type: "text",
					text: excerptAroundError(text),
				});
			}
		}

		if (type === "thinking" && includeErrorThinking) {
			const thinking = stringField(block, "thinking");

			if (thinking && /error/i.test(thinking)) {
				compacted.push({
					type: "thinking",
					text: excerptAroundError(thinking),
				});
			}
		}

		if (type === "toolCall") {
			const toolCall: JsonObject = {
				type: "toolCall",
			};

			const id = stringField(block, "id");
			const name = stringField(block, "name");
			const argumentsObject = asJsonObject(block.arguments);

			if (id) {
				toolCall.id = id;
			}

			if (name) {
				toolCall.name = name;
			}

			if (argumentsObject) {
				const encodedArguments = JSON.stringify(argumentsObject);

				if (encodedArguments) {
					toolCall.arguments = plainPreview(encodedArguments);
				}
			}

			compacted.push(toolCall);
		}

		if (compacted.length >= 8) {
			compacted.push({
				type: "truncated",
				text: "Additional content blocks omitted",
			});
			break;
		}
	}

	return compacted;
}

function excerptAroundError(value: string): string {
	const text = normalizeText(value);

	if (text.length <= ERROR_RADIUS * 2) {
		return text;
	}

	const lower = text.toLowerCase();
	const offsets: number[] = [];
	let searchFrom = 0;

	while (true) {
		const offset = lower.indexOf("error", searchFrom);

		if (offset === -1) {
			break;
		}

		offsets.push(offset);
		searchFrom = offset + "error".length;
	}

	if (offsets.length === 0) {
		const omitted = text.length - ERROR_RADIUS * 2;

		return [
			text.slice(0, ERROR_RADIUS),
			`… [${omitted} chars omitted; no "error" match] …`,
			text.slice(-ERROR_RADIUS),
		].join(" ");
	}

	const selectedOffsets = offsets.slice(0, MAX_ERROR_WINDOWS);
	const ranges: Array<[number, number]> = [];

	for (const offset of selectedOffsets) {
		const start = Math.max(0, offset - ERROR_RADIUS);
		const end = Math.min(text.length, offset + "error".length + ERROR_RADIUS);

		const previous = ranges[ranges.length - 1];

		if (previous && start <= previous[1]) {
			previous[1] = Math.max(previous[1], end);
		} else {
			ranges.push([start, end]);
		}
	}

	const parts: string[] = [];
	let cursor = 0;

	for (const [start, end] of ranges) {
		if (start > cursor) {
			parts.push("…");
		}

		parts.push(text.slice(start, end));
		cursor = end;
	}

	if (cursor < text.length) {
		parts.push("…");
	}

	if (offsets.length > selectedOffsets.length) {
		parts.push(`[${offsets.length} "error" matches; first ${selectedOffsets.length} windows shown]`);
	}

	return parts.join(" ");
}

function plainPreview(value: string, maximum = 240): string {
	const text = normalizeText(value);

	if (text.length <= maximum) {
		return text;
	}

	const side = Math.floor(maximum / 2);
	const omitted = text.length - side * 2;

	return [text.slice(0, side), `… [${omitted} chars omitted] …`, text.slice(-side)].join(" ");
}

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function stringField(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

function asJsonObject(value: unknown): JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

try {
	main();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 2;
}
