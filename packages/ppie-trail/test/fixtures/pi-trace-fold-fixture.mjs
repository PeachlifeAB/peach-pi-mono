import assert from "node:assert/strict";

export function foldEvents(state, events, context) {
	assert.equal(state.host, "pi");
	assert.equal(state.tier, "D");
	assert.equal(state.learn, false);
	assert.equal(context.transcriptPath, "");
	state.runs.push({
		toolCalls: events.filter(event => event.kind === "tool_call").length,
		failedCount: events.filter(event => event.kind === "tool_result" && event.isError).length,
	});
	return { compactions: events.filter(event => event.kind === "compaction").length };
}
