import { describe, expect, it } from "vitest";
import type { HookEvent, HookInput, HookReply, HookRunner } from "../src/hook-process.ts";
import { createHarness, realWhich } from "./harness.ts";

function integration(replies: Partial<Record<HookEvent, HookReply>>, fail?: HookEvent) {
	const calls: { event: HookEvent; input: HookInput }[] = [];
	const hooks: HookRunner = async (event, input) => {
		calls.push({ event, input });
		if (event === fail) throw new Error("fixture hook failure");
		return replies[event] ?? {};
	};
	return { harness: createHarness({ exec: realWhich, hooks }), calls };
}

describe("Pi hook lifecycle", () => {
	it("adds upstream context once and shows notices", async () => {
		const { harness, calls } = integration({
			"session-start": { context: "standing guidance", notice: "ready" },
			prompt: { context: "prompt guidance" },
		});
		await harness.emit("session_start");
		await harness.emit("input", { text: "update values", source: "interactive" });
		const result = await harness.emit("before_agent_start", { prompt: "update values", systemPrompt: "base" });
		expect(result?.systemPrompt).toContain("standing guidance\n\nprompt guidance");
		expect(calls.filter((call) => call.event === "prompt")).toHaveLength(1);
		expect(harness.notices).toContain("ready");
		expect(calls.every((call) => !("transcript_path" in call.input))).toBe(true);
	});

	it("blocks a shell command when upstream denies it", async () => {
		const { harness } = integration({ "pre-bash": { block: "run trail check" } });
		await harness.emit("session_start");
		expect(await harness.emit("tool_call", { toolName: "bash", input: { command: "git commit" } })).toEqual({
			block: true,
			reason: "run trail check",
		});
	});

	it("fails closed when the command guard cannot run", async () => {
		const { harness } = integration({}, "pre-bash");
		await harness.emit("session_start");
		const result = await harness.emit("tool_call", { toolName: "bash", input: { command: "git commit" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("fixture hook failure");
		expect(harness.notices.at(-1)).toContain("fixture hook failure");
	});

	it("delivers learnings before edits and overlap context after edits", async () => {
		const { harness } = integration({
			"pre-edit": { context: "read this learning before editing" },
			"post-edit": { context: "teammate overlap" },
		});
		await harness.emit("session_start");
		const edit = { toolName: "replace", input: { path: "values.ts" }, content: [{ type: "text", text: "changed" }] };
		expect((await harness.emit("tool_call", edit))?.reason).toContain("before editing");
		expect((await harness.emit("tool_result", edit))?.content.at(-1).text).toContain("teammate overlap");
	});

	it("continues a blocked stop and dispatches shutdown", async () => {
		const { harness, calls } = integration({
			stop: { block: "complete the required step" },
			statusline: { status: "Trail upstream status" },
		});
		await harness.emit("session_start");
		await harness.emit("agent_end", { messages: [] });
		expect(harness.messages.at(-1)).toEqual({
			message: { customType: "trail-hook", content: "complete the required step", display: false },
			options: { triggerTurn: true },
		});
		expect(harness.status.at(-1)).toBe("Trail upstream status");
		await harness.emit("session_shutdown");
		expect(calls.at(-1)?.event).toBe("session-end");
	});
});
