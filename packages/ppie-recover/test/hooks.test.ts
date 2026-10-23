import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { Ajv } from "ajv";
import { createProviderSilentHookWatcher, runProviderSilentHook } from "../src/hooks.ts";
import retry from "../src/retry.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";
import { projectRetryConfigPath, resolveRetryPolicyLayers } from "../src/retry-policy-node.ts";
import { asExtensionApi, asExtensionContext, CtxFakeCore, PiFakeCore } from "./fakes/pi-fakes.ts";

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const commandFor = (scriptPath: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;

function writeScript(path: string, source: string): void {
	writeFileSync(path, source, { mode: 0o700 });
}

async function waitForFile(path: string): Promise<void> {
	if (existsSync(path)) return;
	await new Promise<void>((resolve, reject) => {
		let watcher: ReturnType<typeof watch> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			watcher?.close();
			if (error) reject(error);
			else resolve();
		};

		watcher = watch(dirname(path), () => {
			if (!existsSync(path)) return;
			finish();
		});
		watcher.once("error", finish);
		timeout = setTimeout(() => finish(new Error(`timed out waiting for ${path}`)), 15_000);
		if (existsSync(path)) finish();
	});
}

test("provider_silent hook fires once with a CloudEvents envelope and scrubbed environment", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ppie-recover-hook-"));
	const previousSecret = process.env.SECRET_SHOULD_NOT_LEAK;
	try {
		const output = join(dir, "output.json");
		const script = join(dir, "capture.mjs");
		writeScript(
			script,
			`import { writeFileSync } from "node:fs"; let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => writeFileSync(${JSON.stringify(output)}, JSON.stringify({ event: JSON.parse(input), cwd: process.cwd(), env: process.env })));`,
		);
		const notifications: string[] = [];
		process.env.SECRET_SHOULD_NOT_LEAK = "sentinel";
		const ctxCore = new CtxFakeCore();
		ctxCore.agentIsIdle = false;
		const watcher = createProviderSilentHookWatcher({
			hook: { after_seconds: 0.01, command: commandFor(script), timeout_seconds: 10 },
			notify: (message) => notifications.push(message),
		});
		watcher.arm(asExtensionContext(ctxCore));
		await waitForFile(output);
		watcher.observe(asExtensionContext(ctxCore));
		await delay(40);

		const captured = JSON.parse(readFileSync(output, "utf8")) as {
			event: unknown;
			cwd: string;
			env: NodeJS.ProcessEnv;
		};
		const schema = JSON.parse(readFileSync(new URL("./fixtures/cloudevents.json", import.meta.url), "utf8"));
		const validate = new Ajv({ validateFormats: false }).compile(schema);
		assert.equal(validate(captured.event), true, JSON.stringify(validate.errors));
		assert.deepEqual(captured.event, {
			specversion: "1.0",
			id: (captured.event as { id: string }).id,
			source: "urn:pi:recover",
			type: "dev.peachlife.ppie-recover.provider_silent",
			time: (captured.event as { time: string }).time,
			data: { silent_seconds: 0.01, model: "" },
		});
		assert.equal(realpathSync(captured.cwd), realpathSync(homedir()));
		assert.equal(captured.env.PI_RECOVER_EVENT, "provider_silent");
		assert.equal(captured.env.PI_RECOVER_SILENT_SECONDS, "0.01");
		assert.equal(captured.env.PI_RECOVER_MODEL, "");
		assert.equal(captured.env.SECRET_SHOULD_NOT_LEAK, undefined);
		assert.deepEqual(notifications, []);
	} finally {
		if (previousSecret === undefined) delete process.env.SECRET_SHOULD_NOT_LEAK;
		else process.env.SECRET_SHOULD_NOT_LEAK = previousSecret;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("retry arms the hook timer independently of the advisory warning", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ppie-recover-runtime-hook-"));
	try {
		const output = join(dir, "fired");
		const script = join(dir, "write.mjs");
		writeScript(
			script,
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(output)}, "hooked");`,
		);
		const piCore = new PiFakeCore();
		const ctxCore = new CtxFakeCore();
		ctxCore.agentIsIdle = false;
		retry(asExtensionApi(piCore), {
			policy: resolveRetryPolicy({
				warnings: { provider_silence_seconds: 0 },
				hooks: { provider_silent: { after_seconds: 0.01, command: commandFor(script) } },
			}),
		});
		piCore.emitAndGetResult(
			"before_provider_request",
			{ payload: { messages: [], max_tokens: 1000 } },
			asExtensionContext(ctxCore),
		);
		await waitForFile(output);
		assert.equal(readFileSync(output, "utf8"), "hooked");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hook failures notify once, and timeouts kill the process group", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ppie-recover-hook-timeout-"));
	try {
		const failure = join(dir, "failure.mjs");
		writeScript(failure, 'process.stderr.write("broken"); process.exit(2);');
		const notifications: string[] = [];
		await runProviderSilentHook({
			hook: { after_seconds: 1, command: commandFor(failure), timeout_seconds: 5 },
			data: { silent_seconds: 1, model: "model/id" },
			notify: (message) => notifications.push(message),
		});
		assert.equal(notifications.length, 1);
		assert.match(notifications[0] ?? "", /exited 2: broken/);

		const sentinel = join(dir, "survived-timeout");
		const hanging = join(dir, "hanging.mjs");
		writeScript(
			hanging,
			`import { writeFileSync } from "node:fs"; setTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, "alive"), 200);`,
		);
		await runProviderSilentHook({
			hook: { after_seconds: 1, command: commandFor(hanging), timeout_seconds: 0.02 },
			data: { silent_seconds: 1, model: "model/id" },
			notify: (message) => notifications.push(message),
		});
		await delay(250);
		assert.equal(existsSync(sentinel), false);
		assert.match(notifications[1] ?? "", /timed out and was killed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a hook declared only by an untrusted project never runs", async () => {
	const root = mkdtempSync(join(tmpdir(), "ppie-recover-untrusted-hook-"));
	try {
		const project = join(root, "project");
		const configPath = projectRetryConfigPath(project);
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({ hooks: { provider_silent: { after_seconds: 0.01, command: "false" } } }),
		);
		const report = resolveRetryPolicyLayers({
			home: join(root, "home"),
			env: {},
			project: { cwd: project, trusted: false },
		});
		const ctxCore = new CtxFakeCore();
		ctxCore.agentIsIdle = false;
		const notifications: string[] = [];
		const watcher = createProviderSilentHookWatcher({
			hook: report.policy.providerSilentHook,
			notify: (message) => notifications.push(message),
		});
		watcher.arm(asExtensionContext(ctxCore));
		await delay(40);
		assert.deepEqual(notifications, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
