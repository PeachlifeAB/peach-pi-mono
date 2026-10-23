import { MIN_TEXT_KEEP_CHARS } from "./retry-config.ts";

export type GenericRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is GenericRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function roleOf(message: unknown): string {
	if (!isRecord(message)) return "";
	return typeof message.role === "string" ? message.role : "";
}

export function textOf(message: unknown): string {
	if (!isRecord(message)) return "";

	const content = message.content;

	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!isRecord(part)) return "";
			if (part.type === "text" && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.join("\n");
}

// toolCall ids an assistant message's content array carries — a toolCall is
// a content block ({ type: "toolCall", id, name, arguments }), matching
// pi-agent-core's AgentToolCall shape, not a separate top-level field.
export function toolCallIdsOf(message: unknown): string[] {
	if (!isRecord(message)) return [];

	const content = message.content;
	if (!Array.isArray(content)) return [];

	return content
		.filter(
			(part): part is GenericRecord & { id: string } =>
				isRecord(part) && part.type === "toolCall" && typeof part.id === "string",
		)
		.map((part) => part.id);
}

// The toolCallId a toolResult message references, or undefined.
export function toolResultCallIdOf(message: unknown): string | undefined {
	if (!isRecord(message)) return;
	return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

export function getMessageTextLength(message: unknown): number {
	if (!isRecord(message)) return 0;

	const content = message.content;

	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;

	return content.reduce((sum, part) => {
		if (!isRecord(part)) return sum;
		if (part.type === "text" && typeof part.text === "string") {
			return sum + part.text.length;
		}
		return sum;
	}, 0);
}

export function truncateTextRemovingChars(
	text: string,
	removeChars: number,
	minKeepChars: number = MIN_TEXT_KEEP_CHARS,
	// Which end the NO-MARKER FALLBACK keeps when there isn't enough room
	// for a marker + real head/tail split (see keepBudget <= minKeepChars
	// below). Message bodies (assistant turns, tool results) usually carry
	// their most useful content at the tail (a conclusion/result), so
	// "tail" is the right default there. A raw whole-prompt/input STRING is
	// structurally different: the front typically holds system framing/
	// instructions that define how the model should behave at all — losing
	// that is worse than losing old conversation history, so
	// prunePromptLikeString (emergency-prune-payload.ts) passes "head"
	// explicitly to keep the safer, more conservative pre-existing
	// behavior for that call site.
	keepFrom: "head" | "tail" = "tail",
): { text: string; removedChars: number } {
	if (removeChars <= 0 || text.length <= minKeepChars) {
		return { text, removedChars: 0 };
	}

	const marker =
		"\n\n[... truncated by ppie-recover emergency context pruner to fit the model context window ...]\n\n";

	const targetLength = Math.max(minKeepChars, text.length - removeChars);

	if (targetLength >= text.length) {
		return { text, removedChars: 0 };
	}

	const keepBudget = Math.max(0, targetLength - marker.length);

	if (keepBudget <= minKeepChars) {
		// Not enough room for the marker AND minKeepChars of real content —
		// drop the marker rather than let it silently eat into (or replace
		// entirely) the floor this function promises to honor. A shred of
		// real content beats a bare marker with nothing behind it.
		const next = keepFrom === "tail" ? text.slice(text.length - minKeepChars) : text.slice(0, minKeepChars);

		return {
			text: next,
			removedChars: Math.max(0, text.length - next.length),
		};
	}

	const headChars = Math.min(1000, Math.floor(keepBudget * 0.25));
	const tailChars = Math.max(0, keepBudget - headChars);

	const next = text.slice(0, headChars) + marker + (tailChars > 0 ? text.slice(text.length - tailChars) : "");

	return {
		text: next,
		removedChars: Math.max(0, text.length - next.length),
	};
}

export function truncateMessageRemovingChars(
	message: unknown,
	removeChars: number,
	minKeepChars: number = MIN_TEXT_KEEP_CHARS,
): { message: unknown; removedChars: number } {
	if (!isRecord(message)) return { message, removedChars: 0 };

	const content = message.content;

	if (typeof content === "string") {
		const result = truncateTextRemovingChars(content, removeChars, minKeepChars);

		if (result.removedChars <= 0) {
			return { message, removedChars: 0 };
		}

		return {
			message: { ...message, content: result.text },
			removedChars: result.removedChars,
		};
	}

	if (!Array.isArray(content)) return { message, removedChars: 0 };

	let largestTextPartIndex = -1;
	let largestTextPartLength = 0;

	for (let index = 0; index < content.length; index++) {
		const part = content[index];

		if (!isRecord(part)) continue;
		if (part.type !== "text" || typeof part.text !== "string") continue;

		if (part.text.length > largestTextPartLength) {
			largestTextPartLength = part.text.length;
			largestTextPartIndex = index;
		}
	}

	if (largestTextPartIndex === -1 || largestTextPartLength <= minKeepChars) {
		return { message, removedChars: 0 };
	}

	const part = content[largestTextPartIndex];

	if (!isRecord(part) || typeof part.text !== "string") {
		return { message, removedChars: 0 };
	}

	const result = truncateTextRemovingChars(part.text, removeChars, minKeepChars);

	if (result.removedChars <= 0) {
		return { message, removedChars: 0 };
	}

	const nextContent = content.map((item, index) =>
		index === largestTextPartIndex && isRecord(item) ? { ...item, text: result.text } : item,
	);

	return {
		message: { ...message, content: nextContent },
		removedChars: result.removedChars,
	};
}
