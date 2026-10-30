import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const made: string[] = [];

/** A repo directory, optionally carrying a wiring graph with counts in `meta`. */
function repo(counts?: { nodeCount: number; edgeCount: number }) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppie-trail-bar-"));
	made.push(dir);
	// Build lifecycle tests model real repos, and the session gate only builds
	// inside one — a bare temp dir would now be skipped as a scratch folder.
	fs.mkdirSync(path.join(dir, ".git"));
	if (counts) writeGraph(dir, counts);
	return dir;
}

function trailInstall(version: string) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppie-trail-version-"));
	made.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "@trailhq/trail-code", type: "module", version }),
	);
	const dist = path.join(root, "dist");
	fs.mkdirSync(path.join(dist, "claude"), { recursive: true });
	fs.writeFileSync(path.join(dist, "cli.js"), "#!/usr/bin/env node\n");
	fs.writeFileSync(path.join(dist, "claude", "format.js"), "export const marker = 1;\n");
	const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppie-trail-bin-"));
	made.push(binDir);
	const binary = path.join(binDir, "trail");
	fs.symlinkSync(path.join(dist, "cli.js"), binary);
	return { root, binary };
}

function writeGraph(dir: string, meta: unknown) {
	const graph = path.join(dir, ".trail", "cache", ".graph");
	fs.mkdirSync(graph, { recursive: true });
	// meta first, as trail writes it — the reader takes a prefix, not the file.
	fs.writeFileSync(path.join(graph, "wiring.json"), JSON.stringify({ meta, nodes: [], edges: [] }));
}

afterEach(() => {
	while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

const footer = (harness: ReturnType<typeof createHarness>) => harness.status.at(-1) ?? "";

describe("status footer", () => {
	it("says the repo is being indexed while it has no graph", async () => {
		// A detached build reports no completion, so the bar must reflect state
		// rather than announce it once — Claude's statusline recomputes the same
		// way on every render (format.ts:25).
		const harness = createHarness({ cwd: repo() });
		await harness.emit("session_start");
		expect(footer(harness)).toContain("indexing");
	});

	it("updates the moment the build exits, with nobody typing", async () => {
		// The bug this exists for: an idle session sat at "indexing…" until the
		// user sent a message, because nothing else re-rendered the footer.
		const dir = repo();
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		expect(footer(harness)).toContain("indexing");

		writeGraph(dir, { version: 1, nodeCount: 12, edgeCount: 34 });
		harness.spawns.find((s) => s.args[0] === "build")?.exit(0, null);
		expect(footer(harness)).not.toContain("indexing");
		expect(footer(harness)).toContain("12 nodes");
	});

	it("stops saying so once the graph lands between turns", async () => {
		const dir = repo();
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		expect(footer(harness)).toContain("indexing");

		writeGraph(dir, { version: 1, nodeCount: 12, edgeCount: 34 });
		await harness.emit("before_agent_start", { prompt: "a prompt worth ranking", systemPrompt: "" });
		expect(footer(harness)).not.toContain("indexing");
	});

	it("says a build failed rather than claiming it is still indexing", async () => {
		// A killed or crashed build writes no graph. Without this the footer would
		// say "indexing…" forever for something that is not running.
		const dir = repo();
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		harness.spawns.find((s) => s.args[0] === "build")?.exit(1, null);
		expect(footer(harness)).not.toContain("indexing");
		expect(footer(harness)).toContain("build failed");
	});

	it("reports a build that never started", async () => {
		// A missing binary emits `error`, never `exit`. Without handling it the
		// footer would say "indexing…" forever for a build that never ran — and an
		// unhandled `error` on a ChildProcess is fatal.
		const harness = createHarness({ cwd: repo() });
		await harness.emit("session_start");
		harness.spawns.find((s) => s.args[0] === "build")?.error(new Error("ENOENT"));
		expect(footer(harness)).toContain("build failed");
	});

	it("treats a signalled build as failed", async () => {
		const dir = repo();
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		harness.spawns.find((s) => s.args[0] === "build")?.exit(null, "SIGTERM");
		expect(footer(harness)).toContain("build failed");
	});

	it("carries the graph's own node and edge counts", async () => {
		const harness = createHarness({ cwd: repo({ nodeCount: 13734, edgeCount: 34705 }) });
		await harness.emit("session_start");
		expect(footer(harness)).toContain("13.7k nodes");
		expect(footer(harness)).toContain("34.7k edges");
	});

	it("shows small counts unabbreviated", async () => {
		const harness = createHarness({ cwd: repo({ nodeCount: 38, edgeCount: 47 }) });
		await harness.emit("session_start");
		expect(footer(harness)).toContain("38 nodes");
		expect(footer(harness)).toContain("47 edges");
	});

	it("treats an empty graph as built, not as indexing", async () => {
		// A docs-only repo legitimately has 0 nodes; "not built" is only when the
		// artifact is missing (upstream statusline.ts:9-12).
		const harness = createHarness({ cwd: repo({ nodeCount: 0, edgeCount: 0 }) });
		await harness.emit("session_start");
		expect(footer(harness)).not.toContain("indexing");
		expect(footer(harness)).toContain("0 nodes");
	});

	it("keeps the savings tally beside the counts", async () => {
		const harness = createHarness({ cwd: repo({ nodeCount: 38, edgeCount: 47 }) });
		await harness.emit("session_start");
		await harness.emit("tool_result", {
			content: [{ type: "text", text: "[trail] tokens saved ≈ 54,452 (96%)" }],
		});
		expect(footer(harness)).toContain("38 nodes");
		expect(footer(harness)).toContain("54k");
	});

	it("survives a graph whose counts cannot be read", async () => {
		const dir = repo();
		const graph = path.join(dir, ".trail", "cache", ".graph");
		fs.mkdirSync(graph, { recursive: true });
		fs.writeFileSync(path.join(graph, "wiring.json"), "not json at all");
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		// The artifact exists, so not "indexing"; the counts are simply absent.
		expect(footer(harness)).toContain("trail");
		expect(footer(harness)).not.toContain("indexing");
	});

	it("reports formatter/binary skew and reads the binary version once", async () => {
		const older = trailInstall("0.16.0");
		const newer = trailInstall("0.17.0");
		const harness = createHarness({
			cwd: repo({ nodeCount: 1, edgeCount: 1 }),
			exec: (command, args) => {
				if (command === "which") return { stdout: `${older.binary}\n${newer.binary}\n` };
				if (command === "trail" && args[0] === "--version") return { stdout: "trail 0.16.0\n" };
				return { stdout: "" };
			},
		});
		await harness.emit("session_start");
		await harness.emit("tool_result", { content: [{ type: "text", text: "[trail] tokens saved ≈ 5" }] });
		expect(footer(harness)).toContain("formatter 0.17.0 / binary 0.16.0");
		expect(harness.calls.filter((call) => call.command === "trail" && call.args[0] === "--version")).toHaveLength(1);
	});

	it("stays silent for matching or unreadable versions", async () => {
		for (const binaryOutput of ["trail 0.17.0\n", "not a version\n"]) {
			const install = trailInstall("0.17.0");
			const harness = createHarness({
				cwd: repo({ nodeCount: 1, edgeCount: 1 }),
				exec: (command) => {
					if (command === "which") return { stdout: `${install.binary}\n` };
					if (command === "trail") return { stdout: binaryOutput };
					return { stdout: "" };
				},
			});
			await harness.emit("session_start");
			expect(footer(harness)).not.toContain("formatter");
		}
	});
});
