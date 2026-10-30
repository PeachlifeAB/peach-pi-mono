import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, realWhich } from "./harness.ts";

const made: string[] = [];

/**
 * A repo whose wiring graph holds `caller.ts` importing `target.ts`, plus
 * `extra` further callers so the cap can be exercised.
 */
function repoWithGraph(extraCallers = 0) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppie-trail-blast-"));
	made.push(dir);
	const nodes: any[] = [
		{ id: "target.ts", name: "target.ts", kind: "file", path: "target.ts" },
		{ id: "target.ts#run", name: "run", kind: "function", path: "target.ts", span: "L1-L3" },
		{ id: "leaf.ts", name: "leaf.ts", kind: "file", path: "leaf.ts" },
	];
	const edges: any[] = [];
	for (let i = 0; i < 1 + extraCallers; i++) {
		const id = `caller${i}.ts`;
		nodes.push({ id, name: id, kind: "file", path: id });
		edges.push({ source: id, target: "target.ts", relation: "imports", confidence: "extracted" });
	}
	const graph = path.join(dir, ".trail", "cache", ".graph");
	fs.mkdirSync(graph, { recursive: true });
	fs.writeFileSync(path.join(graph, "wiring.json"), JSON.stringify({ meta: { version: 1 }, nodes, edges }));
	return dir;
}

afterEach(() => {
	while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

/** A tool result as pi shapes it: the path is in `input`, not `details`. */
const edit = (file: string, isError = false, toolName = "edit") => ({
	toolName,
	isError,
	input: { path: file },
	content: [{ type: "text", text: "edited" }],
});

const appended = (result: any) => (result?.content ?? []).map((c: any) => c.text ?? "").join("\n");

describe("blast radius", () => {
	it("tells the model who depends on the file just edited", async () => {
		const dir = repoWithGraph();
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("tool_result", edit("target.ts"));
		expect(appended(result)).toContain("blast radius");
		expect(appended(result)).toContain("caller0.ts");
	});

	it("caps the list and says how many it left out", async () => {
		const dir = repoWithGraph(10); // 11 callers against a cap of 8
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("tool_result", edit("target.ts"));
		expect(appended(result)).toContain("+3 more");
	});

	it("says nothing for a file nothing depends on", async () => {
		const dir = repoWithGraph();
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("tool_result", edit("leaf.ts"));
		expect(appended(result)).not.toContain("blast radius");
	});

	it("says nothing when the edit failed", async () => {
		const dir = repoWithGraph();
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("tool_result", edit("target.ts", true));
		expect(appended(result)).not.toContain("blast radius");
	});

	it("says nothing about the graph's own files", async () => {
		const dir = repoWithGraph();
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("tool_result", edit(".trail/cache/INDEX.md"));
		expect(appended(result)).not.toContain("blast radius");
	});

	it("says nothing when the repo has no graph", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppie-trail-nograph-"));
		made.push(dir);
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("tool_result", edit("target.ts"));
		expect(appended(result)).not.toContain("blast radius");
	});

	it("reports for a tool pi does not supply", async () => {
		// The bug this exists for: a fixed list of tool names missed `insert` from
		// pi-hashline-edit-pro, so nothing ever fired. Pi is a customizable
		// harness — no list of tool names can be right for every setup.
		const dir = repoWithGraph();
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		for (const tool of ["insert", "replace", "some_future_tool"]) {
			const result = await harness.emit("tool_result", edit("target.ts", false, tool));
			expect(appended(result)).toContain("blast radius");
		}
	});

	it("says nothing when the result names no path", async () => {
		const dir = repoWithGraph();
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("tool_result", {
			toolName: "bash",
			isError: false,
			input: { command: "ls" },
			content: [{ type: "text", text: "a.ts" }],
		});
		expect(result).toBeUndefined();
	});

	it("says nothing about a path the graph does not hold", async () => {
		const dir = repoWithGraph();
		const harness = createHarness({ cwd: dir, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("tool_result", edit("not-in-the-graph.ts"));
		expect(appended(result)).not.toContain("blast radius");
	});
});
