import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Runs the agent from the current transcript tail, with the session's own busy/settled bookkeeping. */
export type ContinueFromTail = (session: AgentSession) => Promise<void>;

type RunLoopMembers = {
	_agentRunAbortRequested: boolean;
	_isAgentRunActive: boolean;
	_handlePostAgentRun(): Promise<boolean>;
	_runBeforeSettleBoundary(): Promise<boolean>;
	_emitAgentSettled(): Promise<void>;
};

/** Private AgentSession members each pi generation must provide for a retry to be dispatched. */
export const PI_RUN_LOOP_MEMBERS = [
	"_handlePostAgentRun",
	"_runBeforeSettleBoundary",
	"_emitAgentSettled",
] as const satisfies readonly (keyof RunLoopMembers)[];

const hasFunctions = (target: object, names: readonly string[]): boolean =>
	names.every((name) => typeof (target as Record<string, unknown>)[name] === "function");

/**
 * pi 1.x starts runs through `_startRun(trigger)`, which always prepends a starting message. A retry has none, so
 * the same post-run loop `_startRun` drives (`_handlePostAgentRun` → `agent.continue()` →
 * `_runBeforeSettleBoundary`) is run from the transcript tail.
 * Returns undefined when the installed pi lacks those members.
 */
export function resolveContinueFromTail(sessionPrototype: object): ContinueFromTail | undefined {
	if (!hasFunctions(sessionPrototype, PI_RUN_LOOP_MEMBERS)) return undefined;
	return async (session) => {
		const run = session as unknown as RunLoopMembers;
		run._isAgentRunActive = true;
		run._agentRunAbortRequested = false;
		try {
			await session.agent.continue();
			while (!run._agentRunAbortRequested) {
				if (await run._handlePostAgentRun()) {
					if (run._agentRunAbortRequested) break;
					await session.agent.continue();
					continue;
				}
				if (run._agentRunAbortRequested || !(await run._runBeforeSettleBoundary())) break;
				if (run._agentRunAbortRequested) break;
				await session.agent.continue();
			}
		} finally {
			await run._emitAgentSettled();
		}
	};
}
