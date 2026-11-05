import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { ownUntilShutdown, shutdownSupervision } from "../src/process-supervision.ts";

const watchdog = fileURLToPath(new URL("../src/owner-watchdog.mjs", import.meta.url));
const spawned: number[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const pid of spawned.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
});

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function launch(command: string, args: string[]) {
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.unref();
	spawned.push(child.pid ?? 0);
	return child.pid ?? 0;
}

function watchdogsFor(childPid: number): boolean {
	return execFileSync("ps", ["-axo", "command="], { encoding: "utf8" }).includes(`owner-watchdog.mjs ${childPid} `);
}

it.runIf(process.platform !== "win32")("a watchdog exits once its child and the child's group are gone", async () => {
	const owner = launch("sleep", ["60"]);
	const child = launch("sleep", ["0.3"]);
	const guard = launch(process.execPath, [watchdog, String(child), String(owner)]);
	await expect.poll(() => isRunning(guard), { timeout: 2500 }).toBe(false);
	expect(isRunning(owner)).toBe(true);
});

it.runIf(process.platform !== "win32")(
	"a watchdog stays while a grandchild holds the group, then reaps it when the owner dies",
	async () => {
		const owner = launch("sleep", ["60"]);
		const leader = launch("sh", ["-c", "sleep 60 & echo $! > /dev/null; exit 0"]);
		const guard = launch(process.execPath, [watchdog, String(leader), String(owner)]);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(isRunning(guard)).toBe(true);
		process.kill(owner, "SIGKILL");
		await expect.poll(() => isRunning(guard), { timeout: 2500 }).toBe(false);
		expect(execFileSync("ps", ["-axo", "pgid=,command="], { encoding: "utf8" })).not.toMatch(
			new RegExp(`^\\s*${leader}\\s+sleep 60`, "m"),
		);
	},
);

it.runIf(process.platform !== "win32")("shutdown leaves a finished child's recycled pid alone", async () => {
	const child = launch("sleep", ["0.3"]);
	ownUntilShutdown(child);
	await expect.poll(() => watchdogsFor(child), { timeout: 3000 }).toBe(false);
	await new Promise((resolve) => setTimeout(resolve, 100));
	const signalled: number[] = [];
	const original = process.kill.bind(process);
	vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
		if (signal === "SIGKILL") signalled.push(Math.abs(pid));
		return original(pid, signal as never);
	}) as typeof process.kill);
	shutdownSupervision();
	expect(signalled).not.toContain(child);
});

it.runIf(process.platform !== "win32").each([1, 0, -1])(
	"a watchdog handed pid %s exits at once instead of guarding it",
	async (child) => {
		const owner = launch("sleep", ["60"]);
		const guard = launch(process.execPath, [watchdog, String(child), String(owner)]);
		await expect.poll(() => isRunning(guard), { timeout: 1500 }).toBe(false);
		expect(isRunning(owner)).toBe(true);
	},
);
