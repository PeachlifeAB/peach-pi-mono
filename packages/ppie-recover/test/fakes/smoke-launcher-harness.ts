import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "../..");
export const scriptPath = join(repoRoot, "scripts", "smoke-real-settings-compaction.sh");

export type LoadItem = { kind: "extension" | "skill"; value: string };

export type FakeRun = {
	readonly argv: string[];
	readonly cwd: string;
	readonly stdin: string;
};

type RunOptions = {
	readonly config: Record<string, unknown>;
	readonly args?: string[];
	readonly env?: Record<string, string>;
};

function writeFakePi(binDir: string): void {
	const recorder = join(binDir, "recorder.mjs");
	writeFileSync(
		recorder,
		[
			"import { writeFileSync } from 'node:fs';",
			"const out = process.env.PI_SMOKE_RECORDER;",
			"if (!out) process.exit(0);",
			"process.stdin.setEncoding('utf8');",
			"let stdin = '';",
			"for await (const chunk of process.stdin) stdin += chunk;",
			"const body = JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin });",
			"writeFileSync(out, body);",
		].join("\n"),
	);
	writeFileSync(
		join(binDir, "pi"),
		["#!/usr/bin/env bash", "set -euo pipefail", `node "${recorder}" "$@"`].join("\n"),
		{ mode: 0o755 },
	);
	writeFileSync(join(binDir, "curl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
}

export function runLauncher(opts: RunOptions): {
	readonly status: number;
	readonly stderr: string;
	readonly run?: FakeRun;
} {
	const tmp = mkdtempSync(join(tmpdir(), "ppie-recover-smoke-launch-"));
	const binDir = join(tmp, "bin");
	const projectDir = join(tmp, "project");
	mkdirSync(binDir);
	mkdirSync(projectDir);
	const resultFile = join(tmp, "run.json");
	writeFakePi(binDir);

	const configPath = join(projectDir, ".ppie-recover-smoke.local.json");
	writeFileSync(configPath, JSON.stringify(opts.config));
	const env: Record<string, string> = {
		...process.env,
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		OMLX_API_KEY: "fake-key-for-launcher-test",
		OMLX_BASE_URL: "http://127.0.0.1:1",
		HOME: tmp,
		PI_SMOKE_RECORDER: resultFile,
		...opts.env,
	};

	let status = 0;
	let stderr = "";
	try {
		const out = execFileSync("bash", [scriptPath, "--config", configPath, ...(opts.args ?? [])], {
			env,
			cwd: projectDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		stderr = out;
	} catch (error) {
		const failure = error as { status?: number; stderr?: string; stdout?: string };
		status = failure.status ?? 1;
		stderr = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}`;
	}

	let run: FakeRun | undefined;
	try {
		run = JSON.parse(readFileSync(resultFile, "utf8")) as FakeRun;
	} catch {
		run = undefined;
	}
	rmSync(tmp, { recursive: true, force: true });
	return { status, stderr, run };
}

export function baseConfig(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		version: 1,
		forkSessionId: "00000000-0000-4000-8000-000000000000",
		prompt: "reproduce",
		mode: "rpc",
		disableGlobalSkills: true,
		disableGlobalExtensions: true,
		load: [] as LoadItem[],
		...overrides,
	};
}
