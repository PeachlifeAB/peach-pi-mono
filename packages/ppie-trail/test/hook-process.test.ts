import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";
import { type HookInput, type HookReply, runHook } from "../src/hook-process.ts";
import { loadTrailFormat } from "../src/installation.ts";
import { archiveFixtures } from "./fixture-cleanup.ts";
import { createHarness, realWhich } from "./harness.ts";

interface HookFixture {
	learning: string;
	source: string;
	unsafeInput: HookInput & { transcript_path: string };
	responses: { title: string; reply: unknown; expected: HookReply }[];
}
const scratch = path.resolve("../../.gdog/.scratch/trail-rename");
const fixture: HookFixture = JSON.parse(
	fs.readFileSync(new URL("./fixtures/hook-learning.example.json", import.meta.url), "utf8"),
);
const directories: string[] = [];
afterEach(() => archiveFixtures(directories));

it("returns upstream pre-edit learnings without claiming a Claude transcript", async () => {
	fs.mkdirSync(scratch, { recursive: true });
	const cwd = fs.mkdtempSync(path.join(scratch, "hook-"));
	directories.push(cwd);
	execFileSync("git", ["init", "--quiet", cwd]);
	const home = path.join(cwd, "home");
	const notes = path.join(cwd, ".trail", "learnings");
	fs.mkdirSync(home);
	fs.mkdirSync(notes, { recursive: true });
	fs.mkdirSync(path.join(cwd, "src"));
	fs.writeFileSync(path.join(cwd, "src", "target.ts"), fixture.source);
	fs.writeFileSync(path.join(notes, "keep-values.md"), fixture.learning);
	const installation = await loadTrailFormat(cwd, realWhich);
	if (!installation) throw new Error("Install @trailhq/trail-code before running formatter integration tests.");
	const root = installation.root;
	const reply = await runHook(
		root,
		"pre-edit",
		{
			cwd,
			session_id: "pi-hook-test",
			tool_name: "Edit",
			tool_input: { file_path: "src/target.ts" },
		},
		{ ...process.env, HOME: home, TRAIL_HOME: path.join(home, ".trail"), DO_NOT_TRACK: "1" },
	);
	expect(reply.context).toContain("Preserve integer values");
	const harness = createHarness({
		cwd,
		exec: realWhich,
		hooks: (event, input) =>
			runHook(root, event, input, {
				...process.env,
				HOME: home,
				TRAIL_HOME: path.join(home, ".trail"),
				DO_NOT_TRACK: "1",
			}),
	});
	await harness.emit("session_start");
	const guarded = await harness.emit("tool_call", { toolName: "replace", input: { path: "src/target.ts" } });
	expect(guarded?.block).toBe(true);
	expect(guarded?.reason).toContain("Preserve integer values");
	await harness.emit("session_shutdown");
});
it("rejects a fabricated Claude transcript before launching a hook", async () => {
	await expect(runHook("/not-installed", "pre-edit", fixture.unsafeInput)).rejects.toThrow("Invalid Pi hook input");
});
function fixtureRoot() {
	fs.mkdirSync(scratch, { recursive: true });
	const root = fs.mkdtempSync(path.join(scratch, "protocol-"));
	directories.push(root);
	const moduleDirectory = path.join(root, "dist", "claude");
	fs.mkdirSync(moduleDirectory, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
	for (const module of ["hooks.js", "statusline.js"])
		fs.copyFileSync(
			new URL("./fixtures/hook-worker-fixture.mjs", import.meta.url),
			path.join(moduleDirectory, module),
		);
	return root;
}

it.each(fixture.responses)("preserves upstream $title", async ({ reply, expected }) => {
	const root = fixtureRoot();
	const result = await runHook(root, "pre-bash", { cwd: root, session_id: "pi-fixture", tool_input: { reply } });
	expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
});

it("pipes the exact payload without terminal input or command arguments", async () => {
	const root = fixtureRoot();
	const input = { cwd: root, session_id: "pi-pipe", tool_input: { echo: true, command: "private command" } };
	const result = await runHook(root, "pre-bash", input, { ...process.env, CLAUDE_PROJECT_DIR: "/wrong-project" });
	const echoed = JSON.parse(result.context ?? "{}");
	expect(echoed.input).toEqual(input);
	expect(echoed.argv).not.toContain("private command");
	expect(echoed.projectDir).toBe(root);
	expect(echoed.terminal).toBe(false);
});

it("rejects invalid upstream output and process failures", async () => {
	const root = fixtureRoot();
	const input = { cwd: root, session_id: "pi-failure" };
	await expect(runHook(root, "pre-bash", { ...input, tool_input: { raw: "not JSON" } })).rejects.toThrow();
	await expect(runHook(root, "pre-bash", { ...input, tool_input: { reply: { systemMessage: 42 } } })).rejects.toThrow(
		"Invalid Trail",
	);
	await expect(runHook(root, "pre-bash", { ...input, tool_input: { error: "fixture crash" } })).rejects.toThrow(
		"fixture crash",
	);
	await expect(runHook(root, "pre-bash", { ...input, cwd: path.join(root, "missing") })).rejects.toThrow();
});

it("accepts quiet hooks and delegates raw status output", async () => {
	const root = fixtureRoot();
	const input = { cwd: root, session_id: "pi-quiet", tool_input: { raw: "" } };
	expect(await runHook(root, "pre-bash", input)).toEqual({});
	expect(await runHook(root, "statusline", { ...input, tool_input: { raw: "Trail status" } })).toEqual({
		status: "Trail status",
	});
});
