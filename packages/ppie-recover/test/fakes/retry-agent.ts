import type { Agent } from "@earendil-works/pi-agent-core";
import { registerRetryAgentForSessionManager as register } from "../../src/pi-agent-session-retry-adapter.ts";

export function registerRetryAgentForSessionManager(sessionManager: object, agent: Agent): void {
	register(sessionManager, agent, {
		async continueCurrent(expectedTail, prepare) {
			await agent.waitForIdle();
			const messages = agent.state.messages;
			if (messages[messages.length - 1] !== expectedTail) return "superseded";
			prepare();
			await agent.prompt([]);
			return "completed";
		},
	});
}
