#!/usr/bin/env node
// Guards against the failure mode that made this monorepo's gate meaningless:
// a stale glob matches zero files and the tool still exits 0. Measured on this
// repo before the fix — biome reported "Checked 1 file" and exit 0 while every
// package went unlinted. vitest and tsc happen to fail loudly on an empty set,
// but biome does not, and a green gate that inspected nothing is worse than a
// red one. So the package set is asserted here, once, before any tool runs.
//
// Zero-dep on purpose: this must keep working across toolchain bumps, since it
// is the check that tells you whether the rest of the checks are real.
//
// A second invariant, for the same reason: a gate that scans what it should not
// is as misleading as one that scans nothing. Regenerable output and private
// state stay out of every scanner's file list, and the mechanism that re-admits
// one is a `!` line: an unanchored pattern matches at any depth, so five copied
// .ignore files each re-admitted a graft card directory — 509 generated files —
// past the anchored /graft/ rules that exist to keep them out.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const PACKAGES_DIR = "packages";

let globScopeFailed = false;

function fail(message) {
	process.stderr.write(`✖ ${message}\n`);
	process.exitCode = 1;
}

function failGlobScope(message) {
	globScopeFailed = true;
	fail(message);
}

// The filesystem is the source of truth: a directory holding a package.json.
const onDisk = readdirSync(PACKAGES_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(PACKAGES_DIR, entry.name, "package.json")))
	.map((entry) => entry.name)
	.sort();

if (onDisk.length === 0) {
	failGlobScope(`no packages found under ${PACKAGES_DIR}/ — nothing would be checked`);
	process.exit(1);
}

// Each config declares where packages live. A glob naming a directory that does
// not exist is the specific defect this catches.
const declaredGlobs = [
	["pnpm-workspace.yaml", /^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm],
	["biome.json", /"(packages[^"]*)"/g],
	["vitest.config.ts", /"(packages[^"]*)"/g],
	["tsconfig.base.json", /"(packages[^"]*)"/g],
];

for (const [file, pattern] of declaredGlobs) {
	if (!existsSync(file)) {
		failGlobScope(`${file} is missing — the gate cannot confirm its scope`);
		continue;
	}
	const source = readFileSync(file, "utf8");
	for (const [, glob] of source.matchAll(pattern)) {
		if (!glob.startsWith("packages")) continue;
		// Everything up to the first wildcard must be a real directory.
		const literalPrefix = glob.split("*")[0].replace(/\/$/, "");
		if (literalPrefix && literalPrefix !== PACKAGES_DIR && !existsSync(literalPrefix)) {
			failGlobScope(`${file}: glob "${glob}" resolves to "${literalPrefix}", which does not exist`);
		}
	}
}

// Directory names the root .gitignore reserves: single-segment, non-glob
// patterns. Derived, not listed, so the policy keeps one owner.
function reservedDirNames() {
	const names = new Set();
	for (const line of readFileSync(".gitignore", "utf8").split("\n")) {
		const pattern = line.trim().replace(/^\//, "").replace(/\/$/, "");
		if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) continue;
		if (pattern.includes("*") || pattern.includes("/")) continue;
		names.add(pattern);
	}
	return names;
}

const NEVER_WALKED = new Set([".git", ...reservedDirNames()]);
const IGNORE_FILES = new Set([".gitignore", ".ignore", ".fdignore"]);
const MAX_DEPTH = 6;

const ignoreFiles = [];
const survey = (dir, depth) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (NEVER_WALKED.has(entry.name)) continue;
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (depth < MAX_DEPTH) survey(entryPath, depth + 1);
		} else if (IGNORE_FILES.has(entry.name)) {
			ignoreFiles.push(entryPath);
		}
	}
};
survey(".", 0);

for (const file of ignoreFiles) {
	readFileSync(file, "utf8")
		.split("\n")
		.forEach((line, index) => {
			if (!line.trim().startsWith("!")) return;
			const reserved = line.trim().slice(1).replace(/^\//, "").split("/")[0];
			if (NEVER_WALKED.has(reserved)) {
				fail(`${file}:${index + 1} re-admits the reserved tree "${reserved}" — no scanner may walk it`);
			}
		});
}

if (process.exitCode === 1) {
	if (globScopeFailed) process.stderr.write("\nA glob pointing at a missing directory silently checks nothing.\n");
	process.exit(1);
}

process.stdout.write(`✔ ${onDisk.length} package(s) in scope: ${onDisk.join(", ")}\n`);
process.stdout.write(`✔ ${ignoreFiles.length} ignore file(s) checked; no reserved tree re-admitted\n`);
