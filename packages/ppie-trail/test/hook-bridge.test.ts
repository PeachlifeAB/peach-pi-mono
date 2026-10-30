import { describe, expect, it } from "vitest";
import { createHookBridge } from "../src/hook-bridge.ts";
import type { HookEvent, HookInput, HookReply, HookRunner } from "../src/hook-process.ts";

const input: HookInput = { cwd: process.cwd(), session_id: "pi-bridge" };
function runner(replies: Partial<Record<HookEvent, HookReply>>) {
	const calls: { event: HookEvent; input: HookInput }[] = [];
	const run: HookRunner = async (event, input) => {
		calls.push({ event, input });
		return replies[event] ?? {};
	};
	return { run, calls };
}

describe("upstream hook bridge", () => {
	it("injects session and prompt context once", async () => {
		const upstream = runner({
			"session-start": { context: "standing learning" },
			prompt: { context: "matching learning" },
		});
		const bridge = createHookBridge(upstream.run);
		await bridge.start(input);
		await bridge.prompt({ ...input, prompt: "edit values" });
		expect(bridge.takeContext()).toBe("standing learning\n\nmatching learning");
		expect(bridge.takeContext()).toBe("");
		expect(upstream.calls.every((call) => !("transcript_path" in call.input))).toBe(true);
	});

	it("preserves upstream command denial", async () => {
		const upstream = runner({ "pre-bash": { block: "run the learning check first" } });
		const bridge = createHookBridge(upstream.run);
		expect(
			(await bridge.beforeTool({ ...input, tool_name: "Bash", tool_input: { command: "git commit" } })).block,
		).toContain("learning check");
	});

	it("returns pre-edit guidance before the edit runs", async () => {
		const bridge = createHookBridge(runner({ "pre-edit": { context: "keep integers" } }).run);
		expect(
			(await bridge.beforeTool({ ...input, tool_name: "Edit", tool_input: { file_path: "values.ts" } })).block,
		).toBe("keep integers");
	});

	it("dispatches failed shell results without calling the edit hook", async () => {
		const upstream = runner({ "post-bash-fail": { context: "recovery guidance" } });
		const bridge = createHookBridge(upstream.run);
		const result = await bridge.afterTool({
			...input,
			tool_name: "Bash",
			tool_response: { content: [], isError: true },
		});
		expect(upstream.calls.map((call) => call.event)).toEqual(["tool-savings", "post-bash-fail"]);
		expect(result.context).toContain("recovery guidance");
	});

	it("runs turn-end and session-end hooks", async () => {
		const upstream = runner({ stop: { block: "finish the required step" } });
		const bridge = createHookBridge(upstream.run);
		expect((await bridge.end(input)).block).toBe("finish the required step");
		await bridge.shutdown(input);
		expect(upstream.calls.map((call) => call.event)).toEqual(["stop", "session-end"]);
	});
});
