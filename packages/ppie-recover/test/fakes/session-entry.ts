import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
let nextSessionEntryId = 0;

export function fakeAssistantSessionEntry(
	input: Readonly<{
		content: AssistantMessage["content"];
		stopReason: AssistantMessage["stopReason"];
		errorMessage?: string;
	}>,
): SessionEntry {
	const id = `fake-session-entry-${++nextSessionEntryId}`;
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: input.content,
			api: "openai-completions",
			provider: "fake",
			model: "fake",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: input.stopReason,
			errorMessage: input.errorMessage,
			timestamp: 0,
		},
	};
}
