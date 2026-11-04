import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const watchdog = fileURLToPath(new URL("./owner-watchdog.mjs", import.meta.url));
const owned = new Set<number>();
const watchdogs = new Map<number, number>();

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ESRCH" || code === "EPERM") return false;
		throw error;
	}
}

function descendants(pid: number): number[] {
	if (process.platform === "win32") return [];
	let output: string;
	try {
		output = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
	} catch {
		return [];
	}
	const children = new Map<number, number[]>();
	for (const line of output.split("\n")) {
		const [child, parent] = line.trim().split(/\s+/).map(Number);
		if (!child || !parent) continue;
		const list = children.get(parent) ?? [];
		list.push(child);
		children.set(parent, list);
	}
	const result: number[] = [];
	const pending = [...(children.get(pid) ?? [])];
	while (pending.length) {
		const next = pending.pop();
		if (next === undefined) continue;
		result.push(next);
		pending.push(...(children.get(next) ?? []));
	}
	return result;
}

export function killProcessTree(pid: number, keep: ReadonlySet<number> = new Set()): void {
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
		return;
	}
	for (const target of [pid, ...descendants(pid)].filter((target) => !keep.has(target))) {
		try {
			process.kill(-target, "SIGKILL");
		} catch {}
		try {
			process.kill(target, "SIGKILL");
		} catch {}
	}
}

export function watchOwner(childPid: number, ownerPid = process.pid): void {
	const child = spawn(process.execPath, [watchdog, String(childPid), String(ownerPid)], {
		detached: process.platform !== "win32",
		stdio: "ignore",
	});
	child.on("error", () => {});
	child.unref();
	if (child.pid) watchdogs.set(childPid, child.pid);
}

export function stopWatching(childPid: number): void {
	const watcher = watchdogs.get(childPid);
	watchdogs.delete(childPid);
	owned.delete(childPid);
	if (watcher) killProcessTree(watcher);
}

export function ownUntilShutdown(pid: number): void {
	owned.add(pid);
	watchOwner(pid);
}

export function shutdownSupervision(): void {
	for (const pid of [...owned, ...watchdogs.keys()]) killProcessTree(pid);
	for (const watcher of watchdogs.values()) killProcessTree(watcher);
	owned.clear();
	watchdogs.clear();
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export function supervisedExec(
	command: string,
	args: string[],
	options: { cwd?: string; timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const isolate = process.platform !== "win32";
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			detached: isolate,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (child.pid) watchOwner(child.pid);
		let stdout = "";
		let stderr = "";
		let killed = false;
		const stop = () => {
			if (killed || child.pid === undefined) return;
			killed = true;
			killProcessTree(child.pid);
		};
		const timer = options.timeout && options.timeout > 0 ? setTimeout(stop, options.timeout) : undefined;
		if (options.signal?.aborted) stop();
		else options.signal?.addEventListener("abort", stop, { once: true });
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const finish = (code: number | null) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", stop);
			if (child.pid) stopWatching(child.pid);
			resolve({ stdout, stderr, code: code ?? (killed ? 1 : 0), killed });
		};
		child.once("close", finish);
		child.once("error", () => finish(1));
	});
}

export function adoptReportedChildren(reports: { pid: number; args: string[] }[]): void {
	for (const report of reports) {
		if (!isRunning(report.pid)) continue;
		if (report.args.some((arg) => arg.includes("sync-run"))) ownUntilShutdown(report.pid);
		else killProcessTree(report.pid);
	}
}
