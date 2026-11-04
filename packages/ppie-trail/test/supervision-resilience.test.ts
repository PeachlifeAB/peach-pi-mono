import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { killProcessTree } from "../src/process-supervision.ts";
import { runWorker } from "../src/worker-process.ts";
import { archiveFixtures } from "./fixture-cleanup.ts";

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories) chmodSync(directory, 0o755);
	archiveFixtures(directories);
});

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function scratchDirectory(name: string): string {
	const scratch = path.resolve("../../.gdog/.scratch/trail-child-cleanup");
	mkdirSync(scratch, { recursive: true });
	const directory = mkdtempSync(path.join(scratch, name));
	directories.push(directory);
	return directory;
}

it.runIf(process.platform !== "win32")("kills a process when the process listing is unavailable", async () => {
	const emptyPath = scratchDirectory("no-ps-");
	const sleeper = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	try {
		vi.stubEnv("PATH", emptyPath);
		expect(() => killProcessTree(sleeper.pid ?? 0)).not.toThrow();
		await expect.poll(() => isRunning(sleeper.pid ?? 0), { timeout: 2000 }).toBe(false);
	} finally {
		if (sleeper.pid && isRunning(sleeper.pid)) process.kill(sleeper.pid, "SIGKILL");
	}
});

it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
	"returns the worker result when the report directory cannot be removed",
	async () => {
		const temporaryRoot = scratchDirectory("locked-tmp-");
		const cwd = scratchDirectory("locked-cwd-");
		const worker = path.join(cwd, "locking-worker.mjs");
		writeFileSync(
			worker,
			[
				'import { chmodSync } from "node:fs";',
				'import path from "node:path";',
				"chmodSync(path.dirname(path.dirname(process.env.PPIE_SPAWN_REPORT_PATH)), 0o555);",
				'process.stdout.write("done");',
			].join("\n"),
		);
		try {
			vi.stubEnv("TMPDIR", temporaryRoot);
			await expect(runWorker(worker, [], "{}", cwd, process.env)).resolves.toBe("done");
		} finally {
			chmodSync(temporaryRoot, 0o755);
		}
	},
	20000,
);
