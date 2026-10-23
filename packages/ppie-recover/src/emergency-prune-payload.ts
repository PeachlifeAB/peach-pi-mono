import { type GenericRecord, isRecord, truncateTextRemovingChars } from "./emergency-prune-message.ts";
import { pruneMessagesByChars } from "./emergency-prune-text.ts";
import { MIN_TEXT_KEEP_CHARS, type PrunePriorities } from "./retry-config.ts";

function prunePromptLikeString(
	value: unknown,
	targetRemoveChars: number,
	minKeepChars: number,
): { value: unknown; removedChars: number } {
	if (typeof value !== "string") {
		return { value, removedChars: 0 };
	}

	// A whole prompt/input string is structurally different from a single
	// message body: the front usually holds system framing/instructions
	// that define how the model should behave at all. Losing that in the
	// no-marker fallback is worse than losing older content from the tail
	// — keepFrom: "head" preserves the pre-existing, safer behavior for
	// this call site specifically (see truncateTextRemovingChars's doc).
	const result = truncateTextRemovingChars(value, targetRemoveChars, minKeepChars, "head");

	return {
		value: result.text,
		removedChars: result.removedChars,
	};
}

function pruneDescriptionFields(
	value: unknown,
	targetRemoveChars: number,
	minKeepChars: number,
): { value: unknown; removedChars: number } {
	if (targetRemoveChars <= 0) {
		return { value, removedChars: 0 };
	}

	if (Array.isArray(value)) {
		let removedChars = 0;
		let changed = false;

		const next = value.map((item) => {
			if (removedChars >= targetRemoveChars) return item;

			const result = pruneDescriptionFields(item, targetRemoveChars - removedChars, minKeepChars);

			if (result.removedChars > 0) {
				changed = true;
				removedChars += result.removedChars;
				return result.value;
			}

			return item;
		});

		return {
			value: changed ? next : value,
			removedChars,
		};
	}

	if (!isRecord(value)) {
		return { value, removedChars: 0 };
	}

	let removedChars = 0;
	let changed = false;
	const next: GenericRecord = { ...value };

	for (const [key, child] of Object.entries(value)) {
		if (removedChars >= targetRemoveChars) break;

		if (key === "description" && typeof child === "string") {
			// A tool schema's description is short framing text stating the
			// tool's purpose, not turn-based content with a conclusion at
			// the end — closer to a prompt than a message body. keepFrom:
			// "head" for the same reason as prunePromptLikeString above.
			const result = truncateTextRemovingChars(child, targetRemoveChars - removedChars, minKeepChars, "head");

			if (result.removedChars > 0) {
				next[key] = result.text;
				removedChars += result.removedChars;
				changed = true;
			}

			continue;
		}

		if (isRecord(child) || Array.isArray(child)) {
			const result = pruneDescriptionFields(child, targetRemoveChars - removedChars, minKeepChars);

			if (result.removedChars > 0) {
				next[key] = result.value;
				removedChars += result.removedChars;
				changed = true;
			}
		}
	}

	return {
		value: changed ? next : value,
		removedChars,
	};
}

function pruneMessageFields(
	payload: unknown,
	targetRemoveChars: number,
	priorities: PrunePriorities,
	markers: string[],
	minKeepChars?: number,
): { payload: unknown; removedChars: number } {
	if (targetRemoveChars <= 0 || !isRecord(payload)) {
		return { payload, removedChars: 0 };
	}

	let nextPayload: GenericRecord = { ...payload };
	let removedChars = 0;

	if (Array.isArray(nextPayload.messages)) {
		const result = pruneMessagesByChars(nextPayload.messages, targetRemoveChars, priorities, markers, minKeepChars);

		if (result.removedChars > 0) {
			nextPayload = { ...nextPayload, messages: result.messages };
			removedChars += result.removedChars;
		}
	}

	return { payload: removedChars > 0 ? nextPayload : payload, removedChars };
}

export function pruneProviderPayloadMessagesOnly(
	payload: unknown,
	targetRemoveChars: number,
	priorities: PrunePriorities,
	markers: string[],
	minKeepChars?: number,
): { payload: unknown; removedChars: number } {
	return pruneMessageFields(payload, targetRemoveChars, priorities, markers, minKeepChars);
}

export function pruneProviderPayload(
	payload: unknown,
	targetRemoveChars: number,
	priorities: PrunePriorities,
	markers: string[],
	minKeepChars?: number,
): { payload: unknown; removedChars: number } {
	if (targetRemoveChars <= 0 || !isRecord(payload)) {
		return { payload, removedChars: 0 };
	}

	let nextPayload: GenericRecord = { ...payload };
	let removedChars = 0;

	const remaining = () => targetRemoveChars - removedChars;

	const messageResult = pruneMessageFields(nextPayload, remaining(), priorities, markers, minKeepChars);
	if (messageResult.removedChars > 0) {
		nextPayload = messageResult.payload as GenericRecord;
		removedChars += messageResult.removedChars;
	}

	if (Array.isArray(nextPayload.input) && remaining() > 0) {
		const result = pruneMessagesByChars(nextPayload.input, remaining(), priorities, markers, minKeepChars);

		if (result.removedChars > 0) {
			nextPayload = { ...nextPayload, input: result.messages };
			removedChars += result.removedChars;
		}
	}

	if (typeof nextPayload.prompt === "string" && remaining() > 0) {
		const result = prunePromptLikeString(nextPayload.prompt, remaining(), minKeepChars ?? MIN_TEXT_KEEP_CHARS);

		if (result.removedChars > 0) {
			nextPayload = { ...nextPayload, prompt: result.value };
			removedChars += result.removedChars;
		}
	}

	if (typeof nextPayload.input === "string" && remaining() > 0) {
		const result = prunePromptLikeString(nextPayload.input, remaining(), minKeepChars ?? MIN_TEXT_KEEP_CHARS);

		if (result.removedChars > 0) {
			nextPayload = { ...nextPayload, input: result.value };
			removedChars += result.removedChars;
		}
	}

	if (Array.isArray(nextPayload.tools) && remaining() > 0) {
		const result = pruneDescriptionFields(nextPayload.tools, remaining(), minKeepChars ?? MIN_TEXT_KEEP_CHARS);

		if (result.removedChars > 0) {
			nextPayload = { ...nextPayload, tools: result.value };
			removedChars += result.removedChars;
		}
	}

	return {
		payload: removedChars > 0 ? nextPayload : payload,
		removedChars,
	};
}
