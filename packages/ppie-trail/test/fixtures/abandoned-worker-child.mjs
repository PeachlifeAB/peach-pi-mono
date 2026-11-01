import { fork, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const persistent = process.argv.includes("descendant") || process.argv.includes("sync-run.js");
if (persistent) {
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
	if (process.send) process.send({ ready: true });
} else if (process.argv[2] === "sync") {
	const child = spawn(process.execPath, [fileURLToPath(new URL(import.meta.url)), "sync-run.js"], { detached: true, stdio: "ignore" });
	writeFileSync("descendant.json", JSON.stringify({ pid: child.pid }));
	child.unref();
	process.stdout.write(JSON.stringify({ pid: child.pid }));
} else {
	const child = fork(new URL(import.meta.url), ["descendant"], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	writeFileSync("descendant.json", JSON.stringify({ pid: child.pid }));
	child.once("message", () => {
		child.disconnect();
		child.unref();
		process.stdout.write(JSON.stringify({ pid: child.pid }));
		if (process.argv[2] === "failure") process.exitCode = 2;
		if (process.argv[2] === "timeout") setInterval(() => {}, 1000);
	});
}
