import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureDebugLog, debugLog, resolveDebugSettings } from "../src/debug-log.ts";

test("debug is disabled without the object form", () => {
	assert.deepEqual(resolveDebugSettings({}), { enabled: false });
	assert.deepEqual(resolveDebugSettings({ configEnabled: true }), { enabled: false });
});

test("the debug object enables an explicit relative or absolute path", () => {
	assert.deepEqual(resolveDebugSettings({ configEnabled: true, configPath: "./recover.log" }), {
		enabled: true,
		path: "./recover.log",
	});
});

test("debugLog writes only when enabled and never throws for an unusable sink", () => {
	const path = join(mkdtempSync(join(tmpdir(), "ppie-recover-debug-")), "debug.log");
	configureDebugLog({ enabled: true, path });
	debugLog("smoke.event", { answer: 42 });
	configureDebugLog({ enabled: false });
	assert.match(readFileSync(path, "utf8"), /smoke\.event/);
	configureDebugLog({ enabled: true, path: "/dev/null/impossible/x.log" });
	debugLog("swallowed");
	configureDebugLog({ enabled: false });
});
