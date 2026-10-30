import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookBridge } from "./hook-bridge.ts";
import type { HookInput } from "./hook-process.ts";
import { normalizePiTool } from "./pi-dialect.ts";
import type { PiTrace } from "./pi-trace.ts";

interface ToolEvent {
	toolName: string;
	toolCallId?: string;
	input: Record<string, unknown>;
	content?: { type: string; text?: string }[];
	isError?: boolean;
}

export function createHookEvents(pi: ExtensionAPI, current: () => HookBridge | undefined, trace?: PiTrace) {
	let prepared = false;
	let continuing = false;
	function input(ctx: ExtensionContext): HookInput {
		return { cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId() };
	}
	function toolInput(event: ToolEvent, ctx: ExtensionContext): HookInput {
		return {
			...input(ctx),
			tool_use_id: event.toolCallId,
			...normalizePiTool(event.toolName, event.input),
			tool_response: event.content ? { content: event.content, isError: event.isError } : undefined,
		};
	}
	function notices(ctx: ExtensionContext) {
		for (const notice of current()?.takeNotices() ?? []) ctx.ui.notify(notice, "info");
	}
	function failure(ctx: ExtensionContext, error: unknown) {
		const message = `Trail hook failed: ${error instanceof Error ? error.message : String(error)}`;
		ctx.ui.notify(message, "error");
		return message;
	}
	async function status(ctx: ExtensionContext) {
		const bridge = current();
		if (!bridge) return;
		const usage = ctx.getContextUsage();
		const reply = await bridge.status({
			...input(ctx),
			context_window:
				usage?.percent === null || usage?.percent === undefined ? undefined : { used_percentage: usage.percent },
		});
		if (reply.status) ctx.ui.setStatus("ppie-trail", reply.status.replace(/\n/g, " · "));
	}
	pi.on("input", async (event, ctx) => {
		const bridge = current();
		if (!bridge) return;
		try {
			continuing = false;
			const reply = await bridge.prompt({ ...input(ctx), prompt: event.text });
			notices(ctx);
			if (reply.block) {
				ctx.ui.notify(reply.block, "warning");
				return { action: "handled" };
			}
			prepared = true;
			trace?.record(event, ctx);
		} catch (error) {
			failure(ctx, error);
			return { action: "handled" };
		}
	});
	pi.on("tool_call", async (event, ctx) => {
		const bridge = current();
		if (!bridge) return;
		try {
			const reply = await bridge.beforeTool(toolInput(event, ctx));
			notices(ctx);
			if (reply.block) return { block: true, reason: reply.block };
		} catch (error) {
			return { block: true, reason: failure(ctx, error) };
		}
	});
	pi.on("agent_end", async (event, ctx) => {
		const bridge = current();
		if (!bridge) return;
		try {
			const assistant = event.messages.filter((message) => message.role === "assistant").at(-1);
			const text = assistant?.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const reply = await bridge.end({ ...input(ctx), last_assistant_message: text, stop_hook_active: continuing });
			notices(ctx);
			if (reply.block) {
				continuing = true;
				pi.sendMessage({ customType: "trail-hook", content: reply.block, display: false }, { triggerTurn: true });
			}
			await trace?.refresh(ctx);
			await status(ctx);
		} catch (error) {
			failure(ctx, error);
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await current()?.shutdown(input(ctx));
			notices(ctx);
		} catch (error) {
			failure(ctx, error);
		}
	});
	pi.on("session_compact", async (_event, ctx) => {
		try {
			await current()?.start(input(ctx));
			notices(ctx);
		} catch (error) {
			failure(ctx, error);
		}
	});
	return {
		async start(ctx: ExtensionContext) {
			prepared = false;
			continuing = false;
			try {
				await current()?.start(input(ctx));
				notices(ctx);
				await status(ctx);
			} catch (error) {
				failure(ctx, error);
			}
		},
		async beforeAgent(prompt: string | undefined, systemPrompt: string, ctx: ExtensionContext) {
			try {
				if (!prepared && prompt !== undefined) await current()?.prompt({ ...input(ctx), prompt });
				prepared = false;
				notices(ctx);
				const text = current()?.takeContext();
				if (text) return { systemPrompt: `${systemPrompt}\n\n${text}` };
			} catch (error) {
				return { systemPrompt: `${systemPrompt}\n\n${failure(ctx, error)}` };
			}
		},
		async afterTool(event: ToolEvent, ctx: ExtensionContext) {
			try {
				const reply = await current()?.afterTool(toolInput(event, ctx));
				notices(ctx);
				if (reply?.context)
					return { content: [...(event.content ?? []), { type: "text" as const, text: reply.context }] };
			} catch (error) {
				return { content: [...(event.content ?? []), { type: "text" as const, text: failure(ctx, error) }] };
			}
		},
	};
}
