import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { shutdownSupervision, supervisedExec } from "../src/process-supervision.ts";
import { runWorker } from "../src/worker-process.ts";
import { archiveFixtures } from "./fixture-cleanup.ts";

const directories: string[] = [];
afterEach(() => archiveFixtures(directories));

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

it.runIf(process.platform !== "win32").each([
	{ outcome: "succeeds", mode: "success" },
	{ outcome: "fails", mode: "failure" },
	{ outcome: "times out", mode: "timeout" },
])(
	"cleans an abandoned SIGTERM-resistant child when its worker $outcome",
	async ({ mode }) => {
		const scratch = path.resolve("../../.gdog/.scratch/trail-child-cleanup");
		mkdirSync(scratch, { recursive: true });
		const cwd = mkdtempSync(path.join(scratch, "worker-"));
		directories.push(cwd);
		const record = path.join(cwd, "descendant.json");
		const fixture = fileURLToPath(new URL("./fixtures/abandoned-worker-child.mjs", import.meta.url));
		try {
			const execution = runWorker(fixture, [mode], JSON.stringify({}), cwd, process.env);
			if (mode === "success") {
				const output = await execution;
				expect(JSON.parse(output)).toEqual(JSON.parse(readFileSync(record, "utf8")));
			} else {
				await expect(execution).rejects.toThrow(mode === "timeout" ? "SIGKILL" : "failed (2)");
			}
			const { pid } = JSON.parse(readFileSync(record, "utf8")) as { pid: number };
			expect(pid).toBeGreaterThan(0);
			await expect.poll(() => isRunning(pid), { timeout: 500 }).toBe(false);
		} finally {
			if (existsSync(record)) {
				const { pid } = JSON.parse(readFileSync(record, "utf8")) as { pid: number };
				if (isRunning(pid)) process.kill(pid, "SIGKILL");
				await expect.poll(() => isRunning(pid), { timeout: 2000 }).toBe(false);
			}
		}
	},
	20000,
);

it("keeps a detached sync child until supervision shuts down", async () => {
	const scratch = path.resolve("../../.gdog/.scratch/trail-child-cleanup");
	mkdirSync(scratch, { recursive: true });
	const cwd = mkdtempSync(path.join(scratch, "sync-"));
	directories.push(cwd);
	const fixture = fileURLToPath(new URL("./fixtures/abandoned-worker-child.mjs", import.meta.url));
	const output = await runWorker(fixture, ["sync"], JSON.stringify({}), cwd, process.env);
	const { pid } = JSON.parse(output) as { pid: number };
	try {
		expect(isRunning(pid)).toBe(true);
		shutdownSupervision();
		await expect.poll(() => isRunning(pid), { timeout: 2000 }).toBe(false);
	} finally {
		if (isRunning(pid)) process.kill(pid, "SIGKILL");
	}
});

it("force-kills a direct command that ignores SIGTERM", async () => {
	const result = await supervisedExec(
		process.execPath,
		["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
		{ timeout: 200 },
	);
	expect(result.killed).toBe(true);
	expect(result.code).not.toBe(0);
});

it.runIf(process.platform !== "win32")("kills a child after its owner exits", async () => {
	const sleeper = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
		detached: true,
		stdio: "ignore",
	});
	sleeper.unref();
	const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	const watchdog = fileURLToPath(new URL("../src/owner-watchdog.mjs", import.meta.url));
	const watcher = spawn(process.execPath, [watchdog, String(sleeper.pid), String(owner.pid)], {
		detached: true,
		stdio: "ignore",
	});
	watcher.unref();
	try {
		process.kill(owner.pid ?? 0, "SIGKILL");
		await expect.poll(() => isRunning(sleeper.pid ?? 0), { timeout: 2000 }).toBe(false);
	} finally {
		for (const pid of [sleeper.pid, watcher.pid]) if (pid && isRunning(pid)) process.kill(pid, "SIGKILL");
	}
});

it("runs the hook worker from an installed node_modules path", async () => {
	const scratch = fileURLToPath(new URL("../../../.gdog/.scratch/", import.meta.url));
	mkdirSync(scratch, { recursive: true });
	const cwd = mkdtempSync(path.join(scratch, "installed-worker-"));
	directories.push(cwd);
	const installed = path.join(cwd, "node_modules", "@peachlife", "ppie-trail", "src");
	mkdirSync(installed, { recursive: true });
	const worker = path.join(installed, "hook-worker.mjs");
	copyFileSync(fileURLToPath(new URL("../src/hook-worker.mjs", import.meta.url)), worker);
	const module = path.join(cwd, "hook-module.mjs");
	writeFileSync(module, "export const main = (event) => process.stdout.write(event);\n");
	await expect(runWorker(worker, [module, "prompt"], "{}", cwd, process.env)).resolves.toBe("prompt");
});
