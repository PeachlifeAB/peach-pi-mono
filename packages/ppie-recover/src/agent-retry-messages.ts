import type { Agent } from "@earendil-works/pi-agent-core";

export type RetryMessage = {
	role?: string;
	stopReason?: string;
	errorMessage?: unknown;
	content?: unknown;
	toolCalls?: unknown;
};

function isRetryableAssistantStop(stopReason: string | undefined): boolean {
	return stopReason === "error" || stopReason === "aborted";
}

function isProgressMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const value = message as RetryMessage;
	if (value.role === "assistant") return !isRetryableAssistantStop(value.stopReason);
	return value.role === "tool" || value.role === "toolResult";
}

export function createRetryMessages(getAgent: () => Agent | null) {
	const trailing = (): RetryMessage | undefined => {
		const messages = getAgent()?.state.messages;
		const last = messages?.[messages.length - 1] as RetryMessage | undefined;
		return last?.role === "assistant" && isRetryableAssistantStop(last.stopReason) ? last : undefined;
	};
	const dropTrailing = (message: RetryMessage): void => {
		const agent = getAgent();
		if (!(agent && isRetryableAssistantStop(message.stopReason))) return;
		const messages = agent.state.messages;
		if (messages[messages.length - 1] === message) {
			agent.state.messages = messages.slice(0, -1);
		}
	};
	const madeProgressSince = (startIndex: number): boolean =>
		(getAgent()?.state.messages ?? []).slice(startIndex).some(isProgressMessage);
	return { dropTrailing, madeProgressSince, trailing };
}
