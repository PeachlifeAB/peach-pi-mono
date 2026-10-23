// Test hermeticity boundary (CDD): ppie-recover resolves its retry policy from
// the real user config file at `$HOME/.pi/agent/extensions/ppie-recover/config.json`
// (retry-policy-node.ts, defaultRetryConfigPath). Without isolation, a
// developer's live config (e.g. compaction waits of 30s) leaks into the suite
// and breaks fake-timer tests that advance the authored built-in windows
// (10s). Redirect HOME to an empty temp dir for the whole run so homedir()
// finds no config and loadRetryPolicy falls back to the built-in defaults the
// tests were written against. This isolates the environment only — it changes
// no extension logic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const hermeticHome = mkdtempSync(join(tmpdir(), "ppie-recover-hermetic-home-"));

// setupFiles execute before test modules, but beforeAll hooks execute after
// those modules have already been evaluated. Resolve the environment now so
// import-time configuration cannot read the operator's real HOME.
process.env.HOME = hermeticHome;
process.env.USERPROFILE = hermeticHome;

function restoreEnvironment(name: "HOME" | "USERPROFILE", value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

afterAll(() => {
	restoreEnvironment("HOME", previous.HOME);
	restoreEnvironment("USERPROFILE", previous.USERPROFILE);
	rmSync(hermeticHome, { recursive: true, force: true });
});
