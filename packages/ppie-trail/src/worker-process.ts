import { spawn } from "node:child_process";

export function runWorker(
	worker: string,
	args: string[],
	input: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [worker, ...args], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 15000,
			killSignal: "SIGKILL",
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.stdin.on("error", reject);
		child.on("close", (code, signal) => {
			if (code !== 0) reject(new Error(`Trail ${args.at(-1)} failed (${signal ?? code}): ${stderr.trim()}`));
			else resolve(stdout.trim());
		});
		child.stdin.end(input);
	});
}
