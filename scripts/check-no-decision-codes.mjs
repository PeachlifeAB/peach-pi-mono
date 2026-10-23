#!/usr/bin/env node
// Zero-dep standing guard against decision-code contamination in committed *.ts.
//
//   node scripts/check-no-decision-codes.mjs packages/*/src packages/*/test
//
// Walks each root, reads every *.ts, and flags any parenthesized, case-sensitive
// decision-code citation — the transient plan/phase numbering that orphans as soon
// as its design doc leaves the tree.
//
// RULE
//   Decision-codes belong in docs/adr/, never in committed .ts. A comment that
//   says "see Phase 7.2" is dead the moment that plan is superseded. Reword it to
//   state the contract in place: present-tense rationale, no dangling referent.
//
// WHY PARENTHESIZED + CASE-SENSITIVE (not a bare-token sweep)
//   Broadening to bare `Phase N` / `Slice N` / `FR#` collides with legitimate plan
//   fixtures that live in *.ts test data — fixture headings, stage-label strings,
//   ISO timestamps, artifact-path fixtures. Requiring parens plus an uppercase or
//   digit token self-filters every one of those:
//     - `## Phase 1: alpha` fixture headings have no parens
//     - lowercase `phase N/M` stage labels fail the uppercase gate
//     - `(c1)` / `(c2)` scenario IDs are lowercase
//     - ISO `...T08:00...` timestamps are outside `(T#)`
//     - bare artifact-path strings carry no parens
//
// WHY *.ts-ONLY (no allowlist)
//   Every legitimate decision-code use is in .md — ADRs, SKILL.md, CHANGELOG.md,
//   README.md. Scoping to *.ts auto-excludes them all, so there is no rotting
//   allowlist to maintain. .md files are never scanned.
//
// Exit 0 = clean; exit 1 = violation(s); exit 2 = usage error.
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { relative, resolve } from "node:path";
import process from "node:process";

// Canonical detection seam. Parens and case-sensitivity are what keep this at
// exactly the contamination shape while rejecting plan-fixture false positives.
const DECISION_CODE =
	/\((C\d+|T\d+|D\d+|G\d+|FR\d+|A\d+|M\d+|Slice \d+|Phase [A-Z0-9.]+|Problem \d+|Decision \d+|concern-[A-Z])/;

const roots = process.argv.slice(2);
if (roots.length === 0) {
	process.stderr.write("usage: check-no-decision-codes.mjs <dir> [<dir> ...]\n");
	process.exit(2);
}

let scanned = 0;
const violations = [];

for (const root of roots) {
	for await (const file of glob(`${root}/**/*.ts`, { exclude: (name) => name === "node_modules" })) {
		const abs = resolve(file);
		scanned++;
		const lines = readFileSync(abs, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(DECISION_CODE);
			if (match) {
				violations.push(`${relative(process.cwd(), abs)}:${i + 1}: (${match[1]})`);
			}
		}
	}
}

if (violations.length === 0) {
	process.stdout.write(`✔ no decision-code citations (${scanned} file${scanned === 1 ? "" : "s"})\n`);
	process.exit(0);
}

process.stderr.write(`✖ ${violations.length} parenthesized decision-code citation(s) in committed *.ts:\n`);
for (const violation of violations) {
	process.stderr.write(`  ${violation}\n`);
}
process.stderr.write("\nDecision-codes belong in docs/adr/. Reword the comment to state the contract in place.\n");
process.exit(1);
