import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, realWhich } from "./harness.ts";

const made: string[] = [];

/**
 * A repo with a graph, and optionally the deep layer's manifest listing
 * `indexed` paths. `present` are the ones actually written to disk, so a path
 * indexed but not present is one the working tree has moved or removed.
 */
function repo(options: { indexed?: string[]; present?: string[] } = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppie-graft-stale-"));
	made.push(dir);
	const graph = path.join(dir, "graft", ".graph");
	fs.mkdirSync(graph, { recursive: true });
	fs.writeFileSync(
		path.join(graph, "wiring.json"),
		JSON.stringify({ meta: { version: 1, nodeCount: 1, edgeCount: 0, scopes: [] }, nodes: [], edges: [] }),
	);
	fs.writeFileSync(path.join(dir, "graft", "INDEX.md"), "# graft — repo map\n");
	if (options.indexed) {
		fs.writeFileSync(
			path.join(dir, "graft", "manifest.json"),
			JSON.stringify({ files: options.indexed.map((p) => ({ path: p })) }),
		);
	}
	for (const p of options.present ?? []) {
		fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), "");
	}
	return dir;
}

afterEach(() => {
	while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

const prompt = { prompt: "how does the session start handler build the graph", systemPrompt: "" };

const injected = (result: any) => String(result?.systemPrompt ?? "");

describe("staleness banner", () => {
	it("warns when indexed files are no longer on disk", async () => {
		const dir = repo({ indexed: ["src/a.ts", "src/b.ts"], present: ["src/a.ts"] });
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("before_agent_start", prompt);
		expect(injected(result)).toContain("1 of 2");
	});

	it("says nothing when every indexed file is present", async () => {
		const dir = repo({ indexed: ["src/a.ts"], present: ["src/a.ts"] });
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("before_agent_start", prompt);
		expect(injected(result)).not.toContain("ahead of your working tree");
	});

	it("says nothing when the deep layer was never built", async () => {
		// The bug this exists for: `graft check` exits non-zero on a repo with no
		// deep layer, which is not staleness — its own output says the wiring graph
		// is the source of truth. Reading that exit code showed a false banner on
		// every session, and the build it advised would not have cleared it.
		const dir = repo();
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("before_agent_start", prompt);
		expect(injected(result)).not.toContain("ahead of your working tree");
	});

	it("starts no process to decide", async () => {
		// Upstream calls indexFreshness in-process (hooks.ts:409), an existence
		// check it documents as safe on a hot path (check.ts:124). A subprocess on
		// the first turn of every session buys nothing a stat cannot.
		const dir = repo({ indexed: ["src/a.ts", "src/b.ts"], present: ["src/a.ts"] });
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		await harness.emit("before_agent_start", prompt);
		expect(harness.calls.some((c) => c.args[0] === "check")).toBe(false);
	});

	it("survives an unreadable manifest", async () => {
		const dir = repo({ present: ["src/a.ts"] });
		fs.writeFileSync(path.join(dir, "graft", "manifest.json"), "not json at all");
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("before_agent_start", prompt);
		expect(injected(result)).not.toContain("ahead of your working tree");
	});
});
