import { execFileSync } from "node:child_process";
import type { HookRunner } from "../src/hook-process.ts";
import register from "../src/index.ts";

/**
 * Answers `which trail` for real, leaving every other command stubbed. Tests
 * that need trail's own format.js loaded pass this; the rest keep exec inert.
 */
export function realWhich(command: string, args: string[]) {
	if (command !== "which") return { stdout: "", stderr: "", code: 0, killed: false };
	try {
		const stdout = execFileSync("which", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return { stdout, stderr: "", code: 0, killed: false };
	} catch {
		return { stdout: "", stderr: "", code: 1, killed: false };
	}
}

interface ExecCall {
	command: string;
	args: string[];
}

interface SpawnCall {
	command: string;
	args: string[];
	options: Record<string, unknown> | undefined;
	/** Fires the child's exit handler, as node would when the build ends. */
	exit: (code: number | null, signal?: string | null) => void;
	/** Fires the child's error handler, as node does when the binary is missing. */
	error: (err: Error) => void;
}

interface HarnessOptions {
	hooks?: HookRunner;
	/** The session directory handlers see. Defaults to the process cwd. */
	cwd?: string;
	exec?: (command: string, args: string[]) => unknown;
}

/**
 * A stand-in for pi's extension context. The extension reaches the outside world
 * through `on`, `exec`, `registerTool`, `registerCommand` and — for work that
 * must outlive a handler — an injected `spawn`. Capturing those is enough to
 * drive every handler without a live session.
 */
export function createHarness(options: HarnessOptions = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
	const calls: ExecCall[] = [];
	const spawns: SpawnCall[] = [];
	const status: (string | undefined)[] = [];
	const notices: string[] = [];
	const messages: { message: unknown; options: unknown }[] = [];
	let tool: any;
	let command: any;

	const pi = {
		sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerTool: (definition: any) => {
			tool = definition;
		},
		registerCommand: (_name: string, definition: any) => {
			command = definition;
		},
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args });
			return options.exec?.(command, args) ?? { stdout: "", stderr: "", code: 0, killed: false };
		},
		// The seam for the background build. Production injects
		// node:child_process.spawn; here it records the call and hands back a stub
		// whose `exit` a test can fire, which pi.exec could not express.
		spawn: (command: string, args: string[], spawnOptions?: Record<string, unknown>) => {
			const call: SpawnCall = { command, args, options: spawnOptions, exit: () => {}, error: () => {} };
			spawns.push(call);
			return {
				on: (event: string, handler: any) => {
					if (event === "exit") call.exit = handler;
					if (event === "error") call.error = handler;
				},
			};
		},
	};
	register(pi, { hooks: () => options.hooks, formatRoots: [] });

	const ctx = {
		sessionManager: { getSessionId: () => "pi-harness" },
		getContextUsage: () => undefined,
		cwd: options.cwd ?? process.cwd(),
		ui: {
			setStatus: (_key: string, text: string | undefined) => status.push(text),
			notify: (text: string) => notices.push(text),
		},
	};

	return {
		calls,
		spawns,
		status,
		notices,
		messages,
		get tool() {
			return tool;
		},
		emit: (event: string, payload: any = {}) => handlers.get(event)?.(payload, ctx),
		runTool: (params: any) => tool.execute("id", params, undefined, undefined, ctx),
		runCommand: (args: string) => command.handler(args, ctx),
	};
}
