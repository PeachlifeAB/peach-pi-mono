import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adoptReportedChildren, killProcessTree, stopWatching, watchOwner } from "./process-supervision.ts";

const preload = fileURLToPath(new URL("./spawn-report-preload.cjs", import.meta.url));

export function runWorker(
	worker: string,
	args: string[],
	input: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const isolateProcessGroup = process.platform !== "win32";
		const reportPath = `${cwd}/.spawn-report.ndjson`;
		const child = spawn(process.execPath, ["--require", preload, worker, ...args], {
			cwd,
			env: { ...env, PPIE_SPAWN_REPORT_PATH: reportPath },
			detached: isolateProcessGroup,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 15000,
			killSignal: "SIGKILL",
		});
		if (child.pid) watchOwner(child.pid);
		let stdout = "";
		let stderr = "";
		const reports: { pid: number; args: string[] }[] = [];
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		let settled = false;
		function finish(error?: Error) {
			if (settled) return;
			settled = true;
			try {
				const text = readFileSync(reportPath, "utf8");
				for (const line of text.split("\n"))
					if (line) reports.push(JSON.parse(line) as { pid: number; args: string[] });
			} catch {}
			const keep = new Set(
				reports.filter((report) => report.args.some((arg) => arg.includes("sync-run"))).map((report) => report.pid),
			);
			if (child.pid) {
				killProcessTree(child.pid, keep);
				stopWatching(child.pid);
			}
			adoptReportedChildren(reports);
			if (error) reject(error);
		}
		child.on("error", (error) => finish(error));
		child.stdin?.on("error", (error) => finish(error));
		child.on("close", (code, signal) => {
			finish();
			if (code !== 0) reject(new Error(`Trail ${args.at(-1)} failed (${signal ?? code}): ${stderr.trim()}`));
			else resolve(stdout.trim());
		});
		child.stdin?.end(input);
	});
}
