import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../", import.meta.url));

test("a commit preserves the selected index and leaves unrelated hunks unstaged", () => {
	const scratch = join(repository, ".gdog", ".scratch");
	mkdirSync(scratch, { recursive: true });
	const fixture = mkdtempSync(join(scratch, "partial-staging-"));
	const bin = join(fixture, "bin");
	mkdirSync(bin);
	const pnpm = join(bin, "pnpm");
	writeFileSync(
		pnpm,
		`#!${process.execPath}\n` +
			`import { execFileSync } from 'node:child_process';\n` +
			`import { existsSync, readFileSync } from 'node:fs';\n` +
			`if (process.argv[2] === 'exec' && process.argv[3] === 'lint-staged') {\n` +
			`  execFileSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(join(repository, "node_modules/lint-staged/bin/lint-staged.js"))}, ...process.argv.slice(4)], {stdio: 'inherit'});\n` +
			`} else if (process.argv[2] === 'run' && process.argv[3] === 'check:fast') {\n` +
			`  if (JSON.parse(readFileSync('document.json', 'utf8')).unrelated !== 'before' || existsSync('untracked.json')) process.exit(2);\n` +
			`  if (process.env.FIXTURE_CHECK_FAIL) process.exit(3);\n` +
			`} else { process.exit(4); }\n`,
	);
	chmodSync(pnpm, 0o755);
	const environment = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
	const git = (...args) =>
		execFileSync("git", args, { cwd: fixture, env: environment, encoding: "utf8", stdio: "pipe" });
	git("init", "-q");
	git("config", "user.name", "Hook Fixture");
	git("config", "user.email", "hook@example.invalid");
	git("config", "core.hooksPath", ".git/hooks");
	writeFileSync(join(fixture, ".git/info/exclude"), "bin/\n");
	copyFileSync(join(repository, "lint-staged.config.mjs"), join(fixture, "lint-staged.config.mjs"));
	git("add", "lint-staged.config.mjs");
	const document = join(fixture, "document.json");
	writeFileSync(document, JSON.stringify({ selected: "before", unrelated: "before" }));
	git("add", "document.json");
	git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture");
	writeFileSync(document, JSON.stringify({ selected: "after", unrelated: "before" }));
	git("add", "document.json");
	const selected = git("show", ":document.json");
	const working = JSON.stringify({ selected: "after", unrelated: "after" });
	writeFileSync(document, working);
	writeFileSync(join(fixture, "untracked.json"), "{}\n");
	copyFileSync(join(repository, ".husky", "pre-commit"), join(fixture, ".git", "hooks", "pre-commit"));
	chmodSync(join(fixture, ".git", "hooks", "pre-commit"), 0o755);

	git("commit", "-qm", "selected change");

	assert.equal(git("show", "HEAD:document.json"), selected);
	assert.equal(readFileSync(document, "utf8"), working);
	assert.equal(git("diff", "--name-only").trim(), "document.json");
	assert.equal(readFileSync(join(fixture, "untracked.json"), "utf8"), "{}\n");

	writeFileSync(document, JSON.stringify({ selected: "next", unrelated: "before" }));
	git("add", "document.json");
	const failedIndex = git("show", ":document.json");
	const failedWorking = JSON.stringify({ selected: "next", unrelated: "after" });
	writeFileSync(document, failedWorking);
	const previousCommit = git("rev-parse", "HEAD");
	environment.FIXTURE_CHECK_FAIL = "1";
	assert.throws(() => git("commit", "-qm", "rejected change"));
	assert.equal(git("rev-parse", "HEAD"), previousCommit);
	assert.equal(git("show", ":document.json"), failedIndex);
	assert.equal(readFileSync(document, "utf8"), failedWorking);
	assert.equal(readFileSync(join(fixture, "untracked.json"), "utf8"), "{}\n");
});
