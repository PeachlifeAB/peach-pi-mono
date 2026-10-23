import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, realWhich } from "./harness.ts";

const made: string[] = [];

/**
 * A repo whose graph carries `meta.scopes`, as graft writes them for a
 * workspace with several package.json markers. An empty `scopes` models a
 * single-scope repo.
 */
function repo(scopes: string[], files: string[] = []) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppie-graft-scope-"));
	made.push(dir);
	const graph = path.join(dir, "graft", ".graph");
	fs.mkdirSync(graph, { recursive: true });
	fs.writeFileSync(
		path.join(graph, "wiring.json"),
		JSON.stringify({
			meta: {
				version: 1,
				nodeCount: files.length,
				edgeCount: 0,
				scopes: scopes.map((prefix) => ({ prefix, label: prefix, markers: ["package.json"] })),
			},
			nodes: files.map((p) => ({ id: p, name: path.basename(p), kind: "file", path: p })),
			edges: [],
		}),
	);
	fs.writeFileSync(path.join(dir, "graft", "INDEX.md"), "# graft — repo map\n");
	return dir;
}

afterEach(() => {
	while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

const PACKAGES = ["packages/ppie-graft", "packages/ppie-recover", "packages/ppie-custom-provider"];

const edit = (file: string, isError = false) => ({
	toolName: "edit",
	isError,
	input: { path: file },
	content: [{ type: "text", text: "edited" }],
});

const prompt = { prompt: "how does the session start handler build the graph", systemPrompt: "" };

/** The `--in` value on the last `graft ask`, or undefined when it carried none. */
function askScope(harness: ReturnType<typeof createHarness>): string | undefined {
	const ask = [...harness.calls].reverse().find((c) => c.args[0] === "ask");
	if (!ask) return undefined;
	const at = ask.args.indexOf("--in");
	return at === -1 ? undefined : ask.args[at + 1];
}

describe("scope narrowing", () => {
	it("narrows retrieval to the package of the file just edited", async () => {
		const dir = repo(PACKAGES, ["packages/ppie-graft/src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("packages/ppie-graft/src/index.ts"));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBe("packages/ppie-graft");
	});

	it("follows the edit when the model moves to another package", async () => {
		const dir = repo(PACKAGES, ["packages/ppie-graft/src/index.ts", "packages/ppie-recover/src/retry.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("packages/ppie-graft/src/index.ts"));
		await harness.emit("tool_result", edit("packages/ppie-recover/src/retry.ts"));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBe("packages/ppie-recover");
	});

	it("narrows nothing before any file has been named", async () => {
		const dir = repo(PACKAGES, ["packages/ppie-graft/src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBeUndefined();
	});

	it("ignores a failed tool", async () => {
		// A tool that errored changed nothing, so it says nothing about where the
		// session's attention has moved.
		const dir = repo(PACKAGES, ["packages/ppie-graft/src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("packages/ppie-graft/src/index.ts", true));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBeUndefined();
	});

	it("narrows nothing in a single-scope repo", async () => {
		// One scope is the whole repo: `--in` would filter to everything, and only
		// risks graft's no-match error (scopes.ts:296).
		const dir = repo([], ["src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("src/index.ts"));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBeUndefined();
	});

	it("narrows nothing for a file under no scope", async () => {
		// A root-level file lands on graft's fallback scope, whose prefix is ""
		// (scopes.ts:282) — nothing to narrow to.
		const dir = repo(PACKAGES, ["README.md"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("README.md"));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBeUndefined();
	});

	it("matches on a segment boundary, never a bare prefix", async () => {
		// "packages/ppie-graft" must not claim "packages/ppie-graft-extras"
		// (pathUnderPrefix, scopes.ts:306).
		const dir = repo([...PACKAGES, "packages/ppie-graft-extras"], ["packages/ppie-graft-extras/src/a.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("packages/ppie-graft-extras/src/a.ts"));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBe("packages/ppie-graft-extras");
	});

	it("picks the nearest scope when one nests inside another", async () => {
		// graft sorts its scopes by prefix length descending so the first match is
		// the nearest owner (scopes.ts:270); `meta.scopes` order cannot be assumed.
		const dir = repo(["packages", "packages/ppie-graft"], ["packages/ppie-graft/src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("packages/ppie-graft/src/index.ts"));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBe("packages/ppie-graft");
	});

	it("narrows for a file the graph does not hold yet", async () => {
		// Deliberately unlike the Claude plugin, which skips a lastFile absent from
		// the graph (hooks.ts:217). It searches nodes because Claude hands it a bare
		// filename; a tool result carries the whole path, so a file created this
		// turn still resolves to its package.
		const dir = repo(PACKAGES, ["packages/ppie-graft/src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("packages/ppie-graft/src/brand-new.ts"));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBe("packages/ppie-graft");
	});

	it("is not confused by a basename living in two packages", async () => {
		// The plugin's other skip case (hooks.ts:222): a bare "index.ts" could be
		// either package. Resolving by path rather than by name, there is nothing
		// ambiguous to skip.
		const dir = repo(PACKAGES, ["packages/ppie-graft/src/index.ts", "packages/ppie-recover/src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit("packages/ppie-recover/src/index.ts"));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBe("packages/ppie-recover");
	});

	it("still injects the pack when it narrows nothing", async () => {
		const dir = repo([], ["src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("before_agent_start", prompt);
		expect(harness.calls.some((c) => c.args[0] === "ask")).toBe(true);
	});

	it("takes an absolute path back to its scope", async () => {
		// Tools differ: some report a repo-relative path, some an absolute one.
		const dir = repo(PACKAGES, ["packages/ppie-graft/src/index.ts"]);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("tool_result", edit(path.join(dir, "packages/ppie-graft/src/index.ts")));
		await harness.emit("before_agent_start", prompt);
		expect(askScope(harness)).toBe("packages/ppie-graft");
	});
});
