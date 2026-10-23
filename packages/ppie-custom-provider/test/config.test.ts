import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getAgentDir()` reads the real agent directory, so it is redirected at a temp
 * dir per test. Everything else runs against the real filesystem — the loader's
 * contract is about files on disk, and stubbing `node:fs` would test the mock.
 */
const agentDirMock = vi.hoisted(() => ({ current: "" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => agentDirMock.current,
	CONFIG_DIR_NAME: ".pi",
}));

const { CONFIG_FILE_NAME, DEFAULT_CONFIG, loadConfig, overflowRegExp } = await import("../src/config.ts");

let agentDir: string;
let projectDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-openai-agent-"));
	projectDir = mkdtempSync(join(tmpdir(), "pi-openai-project-"));
	agentDirMock.current = agentDir;
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function writeGlobalConfig(config: unknown): void {
	writeFileSync(join(agentDir, CONFIG_FILE_NAME), typeof config === "string" ? config : JSON.stringify(config));
}

function writeProjectConfig(config: unknown): void {
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	writeFileSync(
		join(projectDir, ".pi", CONFIG_FILE_NAME),
		typeof config === "string" ? config : JSON.stringify(config),
	);
}

describe("loadConfig", () => {
	it("returns defaults when no config file exists", () => {
		expect(loadConfig(projectDir)).toEqual(DEFAULT_CONFIG);
	});

	it("reads the global config file", () => {
		writeGlobalConfig({ baseUrl: "http://global:9000/v1" });

		expect(loadConfig(projectDir).baseUrl).toBe("http://global:9000/v1");
	});

	it("lets the project config override the global one", () => {
		writeGlobalConfig({ baseUrl: "http://global:9000/v1" });
		writeProjectConfig({ baseUrl: "http://project:8000/v1" });

		expect(loadConfig(projectDir).baseUrl).toBe("http://project:8000/v1");
	});

	it("keeps global values the project config does not mention", () => {
		writeGlobalConfig({ baseUrl: "http://global:9000/v1", overflowPattern: "too long" });
		writeProjectConfig({ baseUrl: "http://project:8000/v1" });

		const config = loadConfig(projectDir);

		expect(config.baseUrl).toBe("http://project:8000/v1");
		expect(config.overflowPattern).toBe("too long");
	});

	it("merges nested objects per key rather than replacing them wholesale", () => {
		writeGlobalConfig({ discovery: { enabled: false, path: "/v1/models" } });
		writeProjectConfig({ discovery: { enabled: true } });

		// `path` came from the global file even though the project file set a sibling key.
		expect(loadConfig(projectDir).discovery).toEqual({ enabled: true, path: "/v1/models" });
	});

	it("falls back to defaults on malformed JSON instead of throwing", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		writeGlobalConfig("{ not json");

		expect(loadConfig(projectDir)).toEqual(DEFAULT_CONFIG);
	});

	it("ignores values of the wrong type", () => {
		writeGlobalConfig({ baseUrl: 42, discovery: { enabled: "yes" }, log: { maxBytes: "big" } });

		const config = loadConfig(projectDir);

		expect(config.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
		expect(config.discovery.enabled).toBe(DEFAULT_CONFIG.discovery.enabled);
		expect(config.log.maxBytes).toBe(DEFAULT_CONFIG.log.maxBytes);
	});

	it("ignores an empty baseUrl so the provider always has a usable endpoint", () => {
		writeGlobalConfig({ baseUrl: "   " });

		expect(loadConfig(projectDir).baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
	});

	it("clamps log rotation size into a sane range", () => {
		writeGlobalConfig({ log: { maxBytes: 1 } });

		expect(loadConfig(projectDir).log.maxBytes).toBe(1024);
	});

	it("defaults logging to off", () => {
		expect(loadConfig(projectDir).log.enabled).toBe(false);
	});

	it("defaults compat to empty so pi's own detection runs", () => {
		expect(loadConfig(projectDir).compat).toEqual({});
	});

	it("passes through user-supplied compat overrides", () => {
		writeGlobalConfig({ compat: { supportsStore: false, maxTokensField: "max_tokens" } });

		expect(loadConfig(projectDir).compat).toEqual({ supportsStore: false, maxTokensField: "max_tokens" });
	});

	it("discards an invalid overflow pattern rather than failing to load", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		writeGlobalConfig({ overflowPattern: "unterminated (group" });

		expect(loadConfig(projectDir).overflowPattern).toBe("");
	});
});

describe("overflowRegExp", () => {
	it("is undefined by default so pi's own detection acts alone", () => {
		expect(overflowRegExp(loadConfig(projectDir))).toBeUndefined();
	});

	it("compiles a configured pattern case-insensitively", () => {
		writeGlobalConfig({ overflowPattern: "prompt exceeds maximum context" });

		const pattern = overflowRegExp(loadConfig(projectDir));

		expect(pattern?.test("Error: Prompt Exceeds Maximum Context length")).toBe(true);
		expect(pattern?.test("some unrelated failure")).toBe(false);
	});
});
