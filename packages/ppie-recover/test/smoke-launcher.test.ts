import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { baseConfig, type LoadItem, runLauncher, scriptPath } from "./fakes/smoke-launcher-harness.ts";

test("child cwd is the config directory (project working directory)", () => {
	const { run, status } = runLauncher({ config: baseConfig() });
	assert.equal(status, 0, "launcher exited non-zero");
	assert.ok(run, "fake pi did not record a run");
	assert.match(run.cwd, /project$/);
});

test("--no-skills and --no-extensions are present when configured", () => {
	const { run } = runLauncher({
		config: baseConfig({
			disableGlobalSkills: true,
			disableGlobalExtensions: true,
		}),
	});
	assert.ok(run);
	assert.ok(run.argv.includes("--no-skills"), `argv missing --no-skills: ${JSON.stringify(run.argv)}`);
	assert.ok(run.argv.includes("--no-extensions"), `argv missing --no-extensions: ${JSON.stringify(run.argv)}`);
});

test("--no-skills / --no-extensions are absent when disabled", () => {
	const { run } = runLauncher({
		config: baseConfig({
			disableGlobalSkills: false,
			disableGlobalExtensions: false,
		}),
	});
	assert.ok(run);
	assert.ok(!run.argv.includes("--no-skills"), `argv unexpectedly has --no-skills: ${JSON.stringify(run.argv)}`);
	assert.ok(
		!run.argv.includes("--no-extensions"),
		`argv unexpectedly has --no-extensions: ${JSON.stringify(run.argv)}`,
	);
});

test("every explicit skill and extension is present and load order is preserved exactly", () => {
	const load: LoadItem[] = [
		{ kind: "extension", value: "npm:@peachlife/ppie-recover" },
		{ kind: "extension", value: "/abs/path/ext-a.ts" },
		{ kind: "skill", value: ".agents/skills/skill-a" },
		{ kind: "skill", value: ".agents/skills/skill-b" },
		{ kind: "extension", value: "npm:other-ext" },
	];
	const { run } = runLauncher({ config: baseConfig({ load }) });
	assert.ok(run);

	// The exact expected ordered argv slice, built from load[] verbatim.
	const expectedOrdered = [
		"--extension",
		"npm:@peachlife/ppie-recover",
		"--extension",
		"/abs/path/ext-a.ts",
		"--skill",
		".agents/skills/skill-a",
		"--skill",
		".agents/skills/skill-b",
		"--extension",
		"npm:other-ext",
	];
	const start = run.argv.findIndex((a, i) => a === "--extension" && run.argv[i + 1] === "npm:@peachlife/ppie-recover");
	assert.notEqual(start, -1, `ordered load slice not found in argv: ${JSON.stringify(run.argv)}`);
	const slice = run.argv.slice(start, start + expectedOrdered.length);
	assert.deepEqual(slice, expectedOrdered, `load order not preserved: got ${JSON.stringify(slice)}`);

	for (const item of load) {
		assert.ok(
			run.argv.includes(item.value),
			`configured ${item.kind} "${item.value}" dropped from argv: ${JSON.stringify(run.argv)}`,
		);
	}
});

test("--fork receives the configured source session id", () => {
	const fork = "11111111-2222-4000-8000-333333333333";
	const { run } = runLauncher({ config: baseConfig({ forkSessionId: fork }) });
	assert.ok(run);
	const idx = run.argv.indexOf("--fork");
	assert.notEqual(idx, -1, "argv missing --fork");
	assert.equal(run.argv[idx + 1], fork, "--fork received the wrong id");
});

test("--mode rpc is always present", () => {
	const { run } = runLauncher({ config: baseConfig() });
	assert.ok(run);
	const idx = run.argv.indexOf("--mode");
	assert.notEqual(idx, -1, "argv missing --mode");
	assert.equal(run.argv[idx + 1], "rpc", "mode must be rpc");
});

test("prompt travels as one exact RPC frame over stdin, not argv", () => {
	const prompt = 'a "quoted" prompt with spaces and $shell metachars; rm -rf';
	const { run } = runLauncher({ config: baseConfig({ prompt }) });
	assert.ok(run);
	assert.ok(!run.argv.includes(prompt), "prompt leaked into argv");
	assert.equal(run.stdin, `${JSON.stringify({ type: "prompt", message: prompt })}\n`);
});

test("independent target overrides are rejected", () => {
	for (const flag of [
		"--session-id",
		"--project-dir",
		"--skill",
		"--extension",
		"--model",
		"--prompt",
		"--mode",
		"--fork",
	]) {
		const { status, stderr } = runLauncher({
			config: baseConfig(),
			args: [flag, "anything"],
		});
		assert.notEqual(status, 0, `${flag} was accepted (status 0)`);
		assert.match(stderr, /rejected.*independent target override/i, `${flag} not reported as rejected`);
	}
});

test("missing --config fails with usage", () => {
	const tmp = mkdtempSync(join(tmpdir(), "ppie-recover-nocfg-"));
	let s = 0;
	let err = "";
	try {
		execFileSync("bash", [scriptPath], {
			env: { ...process.env, PATH: process.env.PATH ?? "" },
			cwd: tmp,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		const ex = e as { status?: number; stderr?: string };
		s = ex.status ?? 1;
		err = `${ex.stderr ?? ""}`;
	}
	rmSync(tmp, { recursive: true, force: true });
	assert.notEqual(s, 0, "missing --config did not fail");
	assert.match(err, /--config/i, "missing --config did not mention --config");
});

test("no timeout argument or hidden default is introduced into argv", () => {
	const { run } = runLauncher({ config: baseConfig() });
	assert.ok(run);
	for (const forbidden of ["--timeout", "--rpc-timeout", "--deadline", "--max-runtime"]) {
		assert.ok(!run.argv.includes(forbidden), `argv injected ${forbidden}: ${JSON.stringify(run.argv)}`);
	}
});

test("invalid config version is rejected", () => {
	const { status } = runLauncher({ config: baseConfig({ version: 2 }) });
	assert.notEqual(status, 0, "config version 2 was accepted");
});

test("non-rpc mode is rejected", () => {
	const { status } = runLauncher({ config: baseConfig({ mode: "print" }) });
	assert.notEqual(status, 0, "non-rpc mode was accepted");
});

test("malformed forkSessionId is rejected", () => {
	const { status } = runLauncher({
		config: baseConfig({ forkSessionId: "not-a-uuid" }),
	});
	assert.notEqual(status, 0, "malformed forkSessionId was accepted");
});

test("empty load list yields a valid minimal argv", () => {
	const { run, status } = runLauncher({ config: baseConfig({ load: [] }) });
	assert.equal(status, 0);
	assert.ok(run);
	assert.ok(run.argv.includes("--fork"));
	assert.ok(run.argv.includes("--mode"));
	assert.equal(run.argv.indexOf("rpc"), run.argv.length - 1, "rpc should be the final argv value");
});
