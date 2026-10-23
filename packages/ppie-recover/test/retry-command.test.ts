import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fallbackPolicyDiagnostic, registerRetryCommand } from "../src/retry-command.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";

type CommandSpec = {
	handler: (args: unknown, ctx: ExtensionContext) => Promise<void>;
};

function commandCtx(branch: unknown[]): ExtensionContext {
	return {
		sessionManager: {
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}

test("/retry does not cancel the active retry engine when there is no failed assistant turn", async () => {
	let cancelCount = 0;
	let warning: string | undefined;
	let retryCommand: CommandSpec | undefined;

	registerRetryCommand({
		pi: {
			registerCommand: (name: string, spec: unknown) => {
				if (name === "retry") retryCommand = spec as CommandSpec;
			},
		} as never,
		engine: {
			cancel: () => {
				cancelCount++;
			},
		} as never,
		lengthStop: {} as never,
		recovery: {} as never,
		notify: (message, level) => {
			if (level === "warning") warning = message;
		},
		setNotify: () => {},
		clearUserAborted: () => {},
		triggerRetry: () => {},
	});

	assert.ok(retryCommand, "retry command must be registered");
	await retryCommand.handler(undefined, commandCtx([]));

	assert.equal(warning, "No failed assistant turn to retry.");
	assert.equal(cancelCount, 0);
});

test("/retry cancels the active engine only after finding a retryable failed assistant turn", async () => {
	let cancelCount = 0;
	let triggered = false;
	let retryCommand: CommandSpec | undefined;

	registerRetryCommand({
		pi: {
			registerCommand: (name: string, spec: unknown) => {
				if (name === "retry") retryCommand = spec as CommandSpec;
			},
		} as never,
		engine: {
			cancel: () => {
				cancelCount++;
			},
		} as never,
		lengthStop: {} as never,
		recovery: {} as never,
		notify: () => {},
		setNotify: () => {},
		clearUserAborted: () => {},
		triggerRetry: () => {
			triggered = true;
		},
	});

	assert.ok(retryCommand, "retry command must be registered");
	await retryCommand.handler(
		undefined,
		commandCtx([
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "error",
					errorMessage: "fetch failed",
				},
			},
		]),
	);

	assert.equal(cancelCount, 1);
	assert.equal(triggered, true);
});

test("/retry:doctor warns when multiple ppie-recover-like packages are loaded", async () => {
	let lastLevel: string | undefined;
	let lastMessage: string | undefined;
	let doctor: CommandSpec | undefined;

	registerRetryCommand({
		pi: {
			registerCommand: (name: string, spec: unknown) => {
				if (name === "retry:doctor") doctor = spec as CommandSpec;
			},
			exec: async (_cmd: string, args: string[]) => {
				if (args[0] === "--version") {
					return { stdout: "0.80.6", stderr: "", code: 0, killed: false };
				}
				return {
					stdout: `User packages:
  ../../Developer/ppie-recover
    /Users/sampleuser/Developer/ppie-recover
  ../../Developer/references/ppie-recover
    /Users/sampleuser/Developer/references/ppie-recover
`,
					stderr: "",
					code: 0,
					killed: false,
				};
			},
		} as never,
		engine: {} as never,
		lengthStop: {} as never,
		recovery: {} as never,
		notify: (message, level) => {
			lastMessage = message;
			lastLevel = level;
		},
		setNotify: () => {},
		clearUserAborted: () => {},
		triggerRetry: () => {},
	});

	assert.ok(doctor, "retry:doctor must be registered");
	await doctor.handler(undefined, commandCtx([]));

	assert.equal(lastLevel, "warning");
	assert.match(lastMessage ?? "", /2 ppie-recover-like packages are loaded/);
	assert.match(lastMessage ?? "", /Developer\/ppie-recover/);
	assert.match(lastMessage ?? "", /Developer\/references\/ppie-recover/);
});

test("/retry:doctor reports clean when a single ppie-recover package is loaded", async () => {
	let lastLevel: string | undefined;
	let lastMessage: string | undefined;
	let doctor: CommandSpec | undefined;

	registerRetryCommand({
		pi: {
			registerCommand: (name: string, spec: unknown) => {
				if (name === "retry:doctor") doctor = spec as CommandSpec;
			},
			exec: async (_cmd: string, args: string[]) => {
				if (args[0] === "--version") {
					return { stdout: "0.80.6", stderr: "", code: 0, killed: false };
				}
				return {
					stdout: `User packages:
  ../../Developer/ppie-recover
    /Users/sampleuser/Developer/ppie-recover
`,
					stderr: "",
					code: 0,
					killed: false,
				};
			},
		} as never,
		engine: {} as never,
		lengthStop: {} as never,
		recovery: {} as never,
		notify: (message, level) => {
			lastMessage = message;
			lastLevel = level;
		},
		setNotify: () => {},
		clearUserAborted: () => {},
		triggerRetry: () => {},
	});

	assert.ok(doctor, "retry:doctor must be registered");
	await doctor.handler(undefined, commandCtx([]));

	// Single package → no duplicate warning; host version still surfaced.
	assert.equal(lastLevel, "info");
	assert.doesNotMatch(lastMessage ?? "", /ppie-recover-like packages are loaded/);
	assert.match(lastMessage ?? "", /Host pi version: 0\.80\.6/);
});

test("fallback diagnostics show effective state, hop limit, and per-rule chains", () => {
	const policy = resolveRetryPolicy({
		model_fallback: { enabled: true, max_hops: 4 },
		retry: {
			smart_overrides: [
				{ when: { words: ["unavailable"] }, max_attempts: 0, fallback_models: ["anthropic/backup"] },
			],
		},
	});
	assert.equal(
		fallbackPolicyDiagnostic(policy),
		"Model fallback: enabled; max_hops=4; chains=smart override 1=[anthropic/backup]",
	);
});
