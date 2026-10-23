import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import process from "node:process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as z from "zod";
import { canonicalModelReference } from "./model-fallback-model.ts";
import type { NotifyLevel } from "./retry-hooks.ts";
import { isStaleCtxError } from "./retry-utils.ts";

export const PROVIDER_SILENT_EVENT = "provider_silent" as const;
const HOOK_EVENTS = [PROVIDER_SILENT_EVENT] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

export const hookEntry = z
	.object({
		after_seconds: z.number().finite().gt(0).describe("Silence duration before this hook runs."),
		command: z.string().min(1).describe("Shell command run with the CloudEvents envelope on stdin."),
		timeout_seconds: z
			.number()
			.finite()
			.gt(0)
			.default(30)
			.describe("Maximum command runtime before its process group is killed."),
	})
	.strict();

export type ProviderSilentHook = Readonly<{
	after_seconds: number;
	command: string;
	timeout_seconds: number;
}>;

type Notify = (message: string, level?: NotifyLevel) => void;
type ProviderSilentData = Readonly<{ silent_seconds: number; model: string }>;
type CloudEvent = Readonly<{
	specversion: "1.0";
	id: string;
	source: "urn:pi:recover";
	type: `dev.peachlife.ppie-recover.${HookEvent}`;
	time: string;
	data: ProviderSilentData;
}>;

function stderrTail(stderr: string): string {
	return stderr.length <= 500 ? stderr : stderr.slice(-500);
}

function createEnvelope(data: ProviderSilentData): CloudEvent {
	return {
		specversion: "1.0",
		id: randomUUID(),
		source: "urn:pi:recover",
		type: `dev.peachlife.ppie-recover.${PROVIDER_SILENT_EVENT}`,
		time: new Date().toISOString(),
		data,
	};
}

function hookEnvironment(data: ProviderSilentData): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: homedir(),
		PI_RECOVER_EVENT: PROVIDER_SILENT_EVENT,
		PI_RECOVER_SILENT_SECONDS: String(data.silent_seconds),
		PI_RECOVER_MODEL: data.model,
	};
}

export async function runProviderSilentHook(input: {
	hook: ProviderSilentHook;
	data: ProviderSilentData;
	notify: Notify;
}): Promise<void> {
	const envelope = createEnvelope(input.data);
	try {
		const { spawn } = await import("node:child_process");
		const child = spawn(input.hook.command, {
			shell: true,
			detached: true,
			cwd: homedir(),
			env: hookEnvironment(input.data),
			stdio: ["pipe", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = stderrTail(`${stderr}${chunk.toString()}`);
		});
		const outcome = await new Promise<Readonly<{ timedOut: boolean; exitCode: number | null }>>((resolve, reject) => {
			let settled = false;
			const finish = (result: Readonly<{ timedOut: boolean; exitCode: number | null }>) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(result);
			};
			const timeout = setTimeout(() => {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				} catch {
					// A process that already exited needs no further handling.
				}
				finish({ timedOut: true, exitCode: null });
			}, input.hook.timeout_seconds * 1000);
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (exitCode) => finish({ timedOut: false, exitCode }));
			child.stdin?.end(JSON.stringify(envelope));
		});
		if (outcome.timedOut) {
			input.notify("ppie-recover provider_silent hook timed out and was killed", "warning");
			return;
		}
		if (outcome.exitCode !== 0) {
			const detail = stderrTail(stderr).trim();
			input.notify(
				`ppie-recover provider_silent hook exited ${outcome.exitCode}${detail ? `: ${detail}` : ""}`,
				"warning",
			);
		}
	} catch (error) {
		input.notify(
			`ppie-recover provider_silent hook failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}

export function createProviderSilentHookWatcher(input: { hook: ProviderSilentHook | undefined; notify: Notify }) {
	let timer: NodeJS.Timeout | undefined;
	let active = false;

	const disarm = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		active = false;
	};
	const arm = (ctx: ExtensionContext): void => {
		disarm();
		const hook = input.hook;
		if (!hook) return;
		active = true;
		timer = setTimeout(() => {
			timer = undefined;
			active = false;
			try {
				if (ctx.isIdle()) return;
				const data = {
					silent_seconds: hook.after_seconds,
					model: ctx.model ? canonicalModelReference(ctx.model) : "",
				};
				void runProviderSilentHook({ hook, data, notify: input.notify });
			} catch (error) {
				if (!isStaleCtxError(error)) throw error;
			}
		}, hook.after_seconds * 1000);
	};
	const observe = (ctx: ExtensionContext): void => {
		if (!active) return;
		if (ctx.isIdle()) {
			disarm();
			return;
		}
		arm(ctx);
	};

	return { arm, disarm, observe, reset: disarm };
}

export type LifecycleWatcher = Readonly<{
	arm(ctx: ExtensionContext): void;
	disarm(): void;
	observe(ctx: ExtensionContext): void;
	reset(): void;
}>;

export function combineLifecycleWatchers(primary: LifecycleWatcher, secondary: LifecycleWatcher): LifecycleWatcher {
	return {
		arm: (ctx) => {
			primary.arm(ctx);
			secondary.arm(ctx);
		},
		disarm: () => {
			primary.disarm();
			secondary.disarm();
		},
		observe: (ctx) => {
			primary.observe(ctx);
			secondary.observe(ctx);
		},
		reset: () => {
			primary.reset();
			secondary.reset();
		},
	};
}
