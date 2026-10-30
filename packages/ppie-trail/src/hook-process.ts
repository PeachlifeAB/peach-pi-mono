import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { runWorker } from "./worker-process.ts";

export type HookEvent =
	| "session-start"
	| "prompt"
	| "pre-edit"
	| "pre-bash"
	| "post-edit"
	| "tool-savings"
	| "post-bash-fail"
	| "stop"
	| "session-end"
	| "statusline";

export interface HookInput {
	cwd: string;
	session_id: string;
	prompt?: string;
	tool_name?: string;
	tool_use_id?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: { content: { type: string; text?: string }[]; isError?: boolean };
	last_assistant_message?: string;
	stop_hook_active?: boolean;
	context_window?: { used_percentage: number };
}

interface UpstreamReply {
	decision?: string;
	reason?: string;
	systemMessage?: string;
	hookSpecificOutput?: {
		additionalContext?: string;
		permissionDecision?: "allow" | "ask" | "deny";
		permissionDecisionReason?: string;
	};
}

export interface HookReply {
	context?: string;
	notice?: string;
	block?: string;
	status?: string;
}

export type HookRunner = (event: HookEvent, input: HookInput) => Promise<HookReply>;
const worker = fileURLToPath(new URL("./hook-worker.ts", import.meta.url));
const schema = JSON.parse(readFileSync(new URL("./hook-output.schema.json", import.meta.url), "utf8"));
const validator = new Ajv2020();
const validate = validator.compile<UpstreamReply>(schema);
const validateInput = validator.compile<HookInput>({ ...schema.$defs.input, $schema: schema.$schema });

export async function runHook(
	root: string,
	event: HookEvent,
	input: HookInput,
	env: NodeJS.ProcessEnv = process.env,
): Promise<HookReply> {
	const serializedInput = JSON.stringify(input);
	if (!validateInput(JSON.parse(serializedInput)))
		throw new Error(`Invalid Pi hook input: ${JSON.stringify(validateInput.errors)}`);
	const module = event === "statusline" ? "statusline.js" : "hooks.js";
	const modulePath = path.join(root, "dist", "claude", module);
	const output = await runWorker(worker, [modulePath, event], serializedInput, input.cwd, {
		...env,
		TRAIL_INVOKED_AS: "trail",
		CLAUDE_PROJECT_DIR: input.cwd,
	});
	if (event === "statusline") return { status: output };
	if (!output) return {};
	const reply: unknown = JSON.parse(output);
	if (!validate(reply)) throw new Error(`Invalid Trail ${event} response: ${JSON.stringify(validate.errors)}`);
	const specific = reply.hookSpecificOutput;
	const denied = specific?.permissionDecision === "deny" || specific?.permissionDecision === "ask";
	return {
		context: specific?.additionalContext,
		notice: reply.systemMessage,
		block:
			reply.decision === "block" || denied
				? reply.reason || specific?.permissionDecisionReason || "Trail requires approval."
				: undefined,
	};
}
