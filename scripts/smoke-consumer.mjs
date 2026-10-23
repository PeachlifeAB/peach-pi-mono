#!/usr/bin/env node
// Workspace-level smoke launcher.
//
// Wires a consumer smoke fixture into the
// ppie-recover launcher via a fresh per-consumer git worktree under
// it so existing launcher's invariant -- "config directory becomes the project
// working directory" -- holds without changing the launcher.
//
// Usage:
//   node --import tsx ./scripts/smoke-consumer.ts \
//     --config smoke-config.<consumer>.json \
//     [--branch <git-branch>]
//
// The launcher it shells out to is the only thing that constructs pi's argv;
// this wrapper only arranges files on disk. No session id is faked, no
// project-path is guessed, no forkSessionId is invented.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

function parseArgs(argv) {
	let config;
	let branch;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--config") {
			config = argv[++i];
			if (!config) {
				process.stderr.write("--config requires a path\n");
				process.exit(1);
			}
		} else if (a === "--branch") {
			branch = argv[++i];
			if (!branch) {
				process.stderr.write("--branch requires a value\n");
				process.exit(1);
			}
		} else if (a === "--dry-run") {
			dryRun = true;
		} else if (a === "-h" || a === "--help") {
			process.stdout.write("usage: smoke-consumer.mjs --config <path> [--branch <git-ref>] [--dry-run]\n");
			process.exit(0);
		} else {
			process.stderr.write(`unknown arg: ${a}\n`);
			process.exit(1);
		}
	}
	if (!config) {
		process.stderr.write("--config <path-to-smoke-fixture.json> is required\n");
		process.exit(1);
	}
	return { config, branch, dryRun };
}

const args = parseArgs(process.argv.slice(2));

const repoRoot = (() => {
	try {
		return resolve(dirname(new URL(import.meta.url).pathname), "..");
	} catch (e) {
		process.stderr.write(`fatal: cannot resolve script location: ${e instanceof Error ? e.message : String(e)}\n`);
		process.exit(1);
	}
})();
if (!existsSync(resolve(repoRoot, ".gdog/sense.json"))) {
	process.stderr.write(`fatal: ${repoRoot} is not the pi-peachlife workspace root\n`);
	process.exit(1);
}

const fixturePath = resolve(args.config);
if (!existsSync(fixturePath)) {
	process.stderr.write(`fixture not found: ${fixturePath}\n`);
	process.exit(1);
}

let fixture;
try {
	const raw = readFileSync(fixturePath, "utf8");
	fixture = JSON.parse(raw);
} catch (e) {
	process.stderr.write(`failed to read/parse fixture: ${e instanceof Error ? e.message : String(e)}\n`);
	process.exit(1);
}

// Skills host is a shared absolute directory under the user's skills
// workspace; entries pointing there must not be used to locate the consumer.
const SKILLS_HOST = "$HOME/.agents/skills";

function findGitRoot(start) {
	let cur = dirname(resolve(start));
	while (cur !== dirname(cur)) {
		if (existsSync(`${cur}/.git`)) return cur;
		cur = dirname(cur);
	}
	throw new Error(`no git repo found at or above ${start}`);
}

function findConsumerRepo(fixtureFile, fix) {
	for (const item of fix.load ?? []) {
		const v = item?.value ?? "";
		if (!v.startsWith("/")) continue;
		if (v.startsWith(SKILLS_HOST)) continue;
		return findGitRoot(v);
	}
	// Fallback: walk up from the fixture file's directory.
	return findGitRoot(fixtureFile);
}

const consumerPath = findConsumerRepo(fixturePath, fixture);
if (!existsSync(consumerPath)) {
	process.stderr.write(`consumer not found: ${consumerPath}\n`);
	process.exit(1);
}

function worktreeKey(absProjectPath) {
	const parts = absProjectPath.split("/").filter((s) => s.length > 0);
	return parts.join("--");
}

const worktreeRoot = resolve(repoRoot, ".ppie-recover/consuming-project", worktreeKey(consumerPath));

function git(gitArgs, cwd) {
	const r = spawnSync("git", gitArgs, { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		process.stderr.write(`git ${gitArgs.join(" ")} failed in ${cwd}:\n${r.stderr ?? ""}${r.stdout ?? ""}\n`);
		process.exit(1);
	}
	return (r.stdout ?? "").trim();
}

if (!existsSync(worktreeRoot)) {
	let branch = args.branch;
	if (!branch) {
		branch = git(["rev-parse", "--abbrev-ref", "HEAD"], consumerPath);
	}
	mkdirSync(dirname(worktreeRoot), { recursive: true });
	if (args.dryRun) {
		process.stdout.write(`[dry-run] git worktree add ${worktreeRoot} ${branch} (from ${consumerPath})\n`);
	} else {
		git(["worktree", "add", worktreeRoot, branch], consumerPath);
	}
}

const inWorktreeConfig = resolve(worktreeRoot, ".ppie-recovery-smoke.local.json");
const fixtureCanonical = resolve(fixturePath);
if (existsSync(inWorktreeConfig)) {
	const existing = readFileSync(inWorktreeConfig, "utf8");
	const desired = readFileSync(fixtureCanonical, "utf8");
	if (existing !== desired) {
		if (args.dryRun) {
			process.stdout.write(`[dry-run] would overwrite ${inWorktreeConfig}\n`);
		} else {
			copyFileSync(fixtureCanonical, inWorktreeConfig);
		}
	}
} else if (args.dryRun) {
	process.stdout.write(`[dry-run] would copy ${fixtureCanonical} -> ${inWorktreeConfig}\n`);
} else {
	copyFileSync(fixtureCanonical, inWorktreeConfig);
}

// node:crypto rather than the `shasum` binary, which is macOS/BSD-only and
// absent from most Linux CI images. The old spawn swallowed that failure into
// an empty string, so the manifest would silently record no hash at all.
function shasum256(p) {
	return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const manifestDir = resolve(repoRoot, "log/smoke");
mkdirSync(manifestDir, { recursive: true });
const manifestFile = resolve(manifestDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.wrapper.manifest.json`);

const wrapperManifest = {
	launchedAt: new Date().toISOString(),
	consumerPath,
	worktreePath: worktreeRoot,
	consumerBranch: args.branch ?? null,
	fixturePath: fixtureCanonical,
	forkSessionId: fixture.forkSessionId ?? null,
	loadCount: fixture.load?.length ?? 0,
	profileHash: shasum256(fixtureCanonical),
};
if (!args.dryRun) {
	writeFileSync(manifestFile, JSON.stringify(wrapperManifest, null, 2));
}

process.stdout.write(`Consumer:       ${consumerPath}\n`);
process.stdout.write(`Worktree:       ${worktreeRoot}\n`);
process.stdout.write(`In-worktree cfg:${inWorktreeConfig}\n`);
process.stdout.write(`Wrapper manifest:${manifestFile}\n`);

const launcher = resolve(repoRoot, "ppie-recover/scripts/smoke-real-settings-compaction.sh");
if (!existsSync(launcher)) {
	process.stderr.write(`launcher missing: ${launcher}\n`);
	process.exit(1);
}

if (args.dryRun) {
	process.stdout.write(`[dry-run] would exec: bash ${launcher} --config ${inWorktreeConfig}\n`);
	process.exit(0);
}

const r = spawnSync("bash", [launcher, "--config", inWorktreeConfig], {
	stdio: "inherit",
});
process.exit(r.status ?? 1);
