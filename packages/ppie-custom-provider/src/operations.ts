import { access, readFile } from "node:fs/promises";
import {
	type BashOperations,
	createBashTool,
	createLocalBashOperations,
	createReadTool,
	type ExtensionAPI,
	type ReadOperations,
} from "@earendil-works/pi-coding-agent";

/**
 * Pluggable tool operations — pi's mechanism for delegating built-in tool work
 * to another execution environment (SSH, a container, a micro-VM) without
 * reimplementing the tools themselves.
 *
 * Three distinct seams are shown here:
 *
 *   1. `ReadOperations`  — swap the filesystem behind the built-in `read` tool.
 *   2. `BashSpawnHook`   — keep local execution but rewrite command/cwd/env.
 *   3. `BashOperations`  — replace command execution entirely, optionally
 *                          wrapping pi's own local backend.
 *
 * Everything is gated behind `PI_OPENAI_PROVIDER_ENABLE_OPERATIONS=1` so the example
 * never silently takes over the real `read`/`bash` tools in a normal session.
 */

const ENABLE_ENV = "PI_OPENAI_PROVIDER_ENABLE_OPERATIONS";

/** Prefix marking paths this example serves from its own in-memory store. */
const VIRTUAL_PREFIX = "/virtual/";

const VIRTUAL_FILES = new Map<string, string>([
	["/virtual/readme.txt", "This file is served by a custom ReadOperations implementation.\n"],
]);

/**
 * A `ReadOperations` that serves `/virtual/*` from memory and falls through to
 * the real filesystem for everything else. A remote implementation would swap
 * these two calls for `sshExec(...)` instead.
 */
function createVirtualReadOperations(): ReadOperations {
	return {
		async readFile(absolutePath) {
			const virtual = VIRTUAL_FILES.get(absolutePath);
			if (virtual !== undefined) return Buffer.from(virtual, "utf8");
			return readFile(absolutePath);
		},
		// Must throw when unreadable — the read tool treats a rejection as "no access".
		async access(absolutePath) {
			if (VIRTUAL_FILES.has(absolutePath)) return;
			await access(absolutePath);
		},
		// Optional: returning null/undefined marks the path as a non-image.
		async detectImageMimeType(absolutePath) {
			return absolutePath.startsWith(VIRTUAL_PREFIX) ? null : undefined;
		},
	};
}

/**
 * A `BashOperations` that wraps pi's own local backend rather than respawning
 * processes by hand. This is the documented way to intercept command execution
 * while keeping pi's shell resolution, streaming, and process-tree termination.
 */
function createLoggingBashOperations(): BashOperations {
	const local = createLocalBashOperations();
	return {
		exec(command, cwd, options) {
			// Wrap the command, then hand off to the built-in implementation.
			return local.exec(`# ppie-custom-provider\n${command}`, cwd, options);
		},
	};
}

/**
 * Registers built-in tool overrides that delegate to custom operations.
 *
 * Note both tools are registered by *spreading a factory result*: `createReadTool`
 * and `createBashTool` return a complete tool, so overriding one is a matter of
 * constructing it with different operations and re-registering it under the same
 * name. Renderers are inherited per slot — omitting `renderCall`/`renderResult`
 * keeps the built-in syntax highlighting and diff rendering.
 */
export function registerOperationsCoverage(pi: ExtensionAPI) {
	if (process.env[ENABLE_ENV] !== "1") return;

	pi.on("session_start", (_event, ctx) => {
		// 1. `read` backed by custom ReadOperations.
		const readTool = createReadTool(ctx.cwd, {
			operations: createVirtualReadOperations(),
			autoResizeImages: true,
		});

		pi.registerTool({
			...readTool,
			async execute(toolCallId, params, signal, onUpdate) {
				return readTool.execute(toolCallId, params, signal, onUpdate);
			},
		});

		// 2. `bash` with a spawn hook: local execution, adjusted command/cwd/env.
		//    The hook runs AFTER pi injects PI_SESSION_ID/PI_MODEL/etc., so
		//    spreading `env` preserves them.
		const bashTool = createBashTool(ctx.cwd, {
			operations: createLoggingBashOperations(),
			exposeSessionEnvironment: true,
			spawnHook: ({ command, cwd, env }) => ({
				command,
				cwd,
				env: { ...env, PI_OPENAI_PROVIDER_EXTENSION: "1" },
			}),
		});

		pi.registerTool({
			...bashTool,
			async execute(toolCallId, params, signal, onUpdate) {
				return bashTool.execute(toolCallId, params, signal, onUpdate);
			},
		});
	});

	// 3. `user_bash` (the `!` / `!!` prefix) routed through the same wrapper.
	//    Returning `{ operations }` lets pi drive its normal bash UI against a
	//    different backend; returning `{ result }` would bypass execution entirely.
	pi.on("user_bash", (_event, _ctx) => {
		return { operations: createLoggingBashOperations() };
	});
}
