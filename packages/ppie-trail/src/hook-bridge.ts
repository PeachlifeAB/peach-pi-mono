import type { HookEvent, HookInput, HookReply, HookRunner } from "./hook-process.ts";

export function createHookBridge(run: HookRunner) {
	let context: string[] = [];
	const notices: string[] = [];
	async function invoke(event: HookEvent, input: HookInput) {
		const reply = await run(event, input);
		if (reply.notice) notices.push(reply.notice);
		return reply;
	}
	async function retain(event: HookEvent, input: HookInput) {
		const reply = await invoke(event, input);
		if (reply.context) context.push(reply.context);
		return reply;
	}
	return {
		start: (input: HookInput) => retain("session-start", input),
		prompt: (input: HookInput) => retain("prompt", input),
		async beforeTool(input: HookInput): Promise<HookReply> {
			const shell = input.tool_name === "Bash";
			const edit = input.tool_name === "Edit" || input.tool_name === "Write";
			if (!shell && !edit) return {};
			const reply = await invoke(shell ? "pre-bash" : "pre-edit", input);
			return { ...reply, block: reply.block ?? reply.context };
		},
		async afterTool(input: HookInput): Promise<HookReply> {
			const blocks: string[] = [];
			if (!input.tool_response?.isError && (input.tool_name === "Edit" || input.tool_name === "Write")) {
				const reply = await invoke("post-edit", input);
				if (reply.context) blocks.push(reply.context);
			}
			const savings = await invoke("tool-savings", input);
			if (savings.context) blocks.push(savings.context);
			if (input.tool_response?.isError && input.tool_name === "Bash") {
				const reply = await invoke("post-bash-fail", input);
				if (reply.context) blocks.push(reply.context);
			}
			return { context: blocks.join("\n\n") };
		},
		end: (input: HookInput) => invoke("stop", input),
		shutdown: (input: HookInput) => invoke("session-end", input),
		status: (input: HookInput) => invoke("statusline", input),
		takeContext() {
			const text = context.join("\n\n");
			context = [];
			return text;
		},
		takeNotices() {
			return notices.splice(0);
		},
	};
}

export type HookBridge = ReturnType<typeof createHookBridge>;
