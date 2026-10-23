import {
	getMessageTextLength,
	roleOf,
	textOf,
	toolCallIdsOf,
	toolResultCallIdOf,
	truncateMessageRemovingChars,
} from "./emergency-prune-message.ts";
import {
	MIN_TEXT_KEEP_CHARS,
	PRUNE_BAND_HEAD_FRACTION,
	PRUNE_BAND_TAIL_FRACTION,
	type PrunePriorities,
} from "./retry-config.ts";

function candidatePriority(
	message: unknown,
	index: number,
	lastUserIndex: number,
	priorities: PrunePriorities,
	markers: string[],
): number {
	const role = roleOf(message);
	const text = textOf(message).toLowerCase();

	if (markers.length > 0 && markers.some((marker) => text.includes(marker))) {
		return priorities.marker;
	}

	if (role === "tool" || role === "toolResult") return priorities.tool;
	if (role === "assistant") return priorities.assistant;
	if (role === "user" && index !== lastUserIndex) return priorities.oldUser;
	if (role === "system") return priorities.system;
	if (role === "user") return priorities.latestUser;

	return priorities.other;
}

function findLastUserIndex(messages: unknown[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (roleOf(messages[index]) === "user") return index;
	}

	return -1;
}

// Which indices a pass may take content from. `total` is re-evaluated every
// iteration because whole-message drops shrink the list.
type IndexFilter = (index: number, total: number) => boolean;

// The middle band: everything after the head (first ~20% — system/early
// framing that defines the task) and before the tail (last ~30% — the
// freshest turns the model is actively working from).
const inMiddleBand: IndexFilter = (index, total) => {
	const headCount = Math.ceil(total * PRUNE_BAND_HEAD_FRACTION);
	const tailCount = Math.ceil(total * PRUNE_BAND_TAIL_FRACTION);
	return index >= headCount && index < total - tailCount;
};

const anywhere: IndexFilter = () => true;

type PruneState = {
	messages: unknown[];
	removedChars: number;
};

function truncatePass(
	state: PruneState,
	targetRemoveChars: number,
	priorities: PrunePriorities,
	markers: string[],
	minKeepChars: number,
	allowed: IndexFilter,
): void {
	while (state.removedChars < targetRemoveChars) {
		const messages = state.messages;
		const lastUserIndex = findLastUserIndex(messages);

		let bestIndex = -1;
		let bestPriority = -1;
		let bestLength = 0;

		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			const length = getMessageTextLength(message);

			if (length <= minKeepChars) continue;

			const priority = candidatePriority(message, index, lastUserIndex, priorities, markers);

			// Marker-matched messages are user-flagged noise wherever they sit —
			// they bypass the band filter so they are always consumed first,
			// before band placement even comes into play.
			if (priority !== priorities.marker && !allowed(index, messages.length)) {
				continue;
			}

			if (priority > bestPriority || (priority === bestPriority && length > bestLength)) {
				bestIndex = index;
				bestPriority = priority;
				bestLength = length;
			}
		}

		if (bestIndex === -1) return;

		const remaining = targetRemoveChars - state.removedChars;
		const removeFromThis = Math.min(Math.max(remaining, 1000), Math.max(0, bestLength - minKeepChars));

		const result = truncateMessageRemovingChars(messages[bestIndex], removeFromThis, minKeepChars);

		if (result.removedChars <= 0) return;

		messages[bestIndex] = result.message;
		state.removedChars += result.removedChars;
	}
}

function dropPass(
	state: PruneState,
	targetRemoveChars: number,
	priorities: PrunePriorities,
	markers: string[],
	allowed: IndexFilter,
): void {
	while (state.removedChars < targetRemoveChars && state.messages.length > 2) {
		const messages = state.messages;
		const lastUserIndex = findLastUserIndex(messages);
		let dropIndex = -1;
		let bestPriority = -1;
		let bestLength = 0;

		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			const role = roleOf(message);

			if (index === lastUserIndex) continue;
			if (role === "system") continue;

			const priority = candidatePriority(message, index, lastUserIndex, priorities, markers);

			if (priority !== priorities.marker && !allowed(index, messages.length)) {
				continue;
			}

			const length = getMessageTextLength(message);
			if (priority > bestPriority || (priority === bestPriority && length > bestLength)) {
				dropIndex = index;
				bestPriority = priority;
				bestLength = length;
			}
		}

		if (dropIndex === -1) return;

		// A toolCall (content block in an assistant message) and its
		// toolResult (a separate message referencing that call's id) must be
		// dropped TOGETHER — dropping only one half leaves a dangling
		// toolCallId that most OpenAI-compatible APIs reject outright. This
		// must be the FULL transitive closure, not just one hop: an
		// assistant message can carry multiple toolCalls, so dropping it
		// can pull in several toolResults, each of which is itself just a
		// plain message with no further links — but if a dropped message
		// pulls in ANOTHER assistant message (e.g. a toolResult's structure
		// evolves to reference more calls later), that message's own
		// toolCalls must also be chased. Repeat until a full pass adds
		// nothing new. The closure deliberately IGNORES the band filter:
		// dropping only half of a pair produces a payload the API rejects,
		// so correctness wins over placement preference.
		const dropIndices = new Set([dropIndex]);
		let grew = true;
		while (grew) {
			grew = false;

			const knownCallIds = new Set<string>();
			const knownResultCallIds = new Set<string>();
			for (const index of dropIndices) {
				for (const id of toolCallIdsOf(messages[index])) {
					knownCallIds.add(id);
				}
				const resultCallId = toolResultCallIdOf(messages[index]);
				if (resultCallId) knownResultCallIds.add(resultCallId);
			}

			for (let index = 0; index < messages.length; index++) {
				if (dropIndices.has(index)) continue;

				const resultCallId = toolResultCallIdOf(messages[index]);
				const callIds = toolCallIdsOf(messages[index]);

				const linked =
					(resultCallId && knownCallIds.has(resultCallId)) || callIds.some((id) => knownResultCallIds.has(id));

				if (linked) {
					dropIndices.add(index);
					grew = true;
				}
			}
		}

		for (const index of dropIndices) {
			state.removedChars += getMessageTextLength(messages[index]);
		}
		state.messages = messages.filter((_, index) => !dropIndices.has(index));
	}
}

export function pruneMessagesByChars(
	messages: unknown[],
	targetRemoveChars: number,
	priorities: PrunePriorities,
	markers: string[],
	minKeepChars: number = MIN_TEXT_KEEP_CHARS,
): { messages: unknown[]; removedChars: number } {
	const state: PruneState = { messages: messages.slice(), removedChars: 0 };

	// Middle band (~20%-70%) first: the head holds system/early framing and
	// the tail the freshest turns. Only when the band cannot satisfy the
	// target do the fallback passes touch the rest — a stranded recovery is
	// strictly worse than a placement-preference violation.
	truncatePass(state, targetRemoveChars, priorities, markers, minKeepChars, inMiddleBand);
	dropPass(state, targetRemoveChars, priorities, markers, inMiddleBand);
	truncatePass(state, targetRemoveChars, priorities, markers, minKeepChars, anywhere);
	dropPass(state, targetRemoveChars, priorities, markers, anywhere);

	return { messages: state.messages, removedChars: state.removedChars };
}
