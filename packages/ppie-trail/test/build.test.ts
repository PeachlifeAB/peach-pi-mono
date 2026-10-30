import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

const made: string[] = [];

/**
 * A repo directory, optionally carrying a trail graph. The artifacts are the
 * ones upstream's `hasTrailIndex` tests (graph/root.ts:23): a built repo's
 * wiring graph, or a workspace parent's children index.
 */
function repo(withGraph: boolean, artifact = ".graph/wiring.json", git = true) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppie-trail-"));
	made.push(dir);
	if (git) fs.mkdirSync(path.join(dir, ".git"));
	if (withGraph) {
		const file = path.join(dir, ".trail", "cache", artifact);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{}\n");
	}
	return dir;
}

afterEach(() => {
	while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

const builds = (harness: ReturnType<typeof createHarness>) =>
	harness.spawns.filter((spawn) => spawn.args[0] === "build");

describe("cold build", () => {
	it("starts one build when the repo has no graph", async () => {
		const dir = repo(false);
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		expect(builds(harness)).toHaveLength(1);
	});

	it("never builds a directory outside a git repo", async () => {
		// Scratch homes — ask-session folders, /tmp, $HOME — are not projects. A
		// build there stamps a stub graph (1 node) into every session and injects
		// an orientation that says "indexed repo", which reads as a lie.
		const dir = repo(false, ".graph/wiring.json", false);
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		expect(builds(harness)).toHaveLength(0);
	});

	it("names the session's directory, not pi's process cwd", async () => {
		// pi.exec inherits pi's own cwd, so every trail call must name its
		// directory or a session started elsewhere builds the wrong repo.
		const dir = repo(false);
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		expect(builds(harness)[0]?.args[1]).toBe(dir);
	});

	it("does not build a repo that already has a graph", async () => {
		const dir = repo(true);
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		expect(builds(harness)).toHaveLength(0);
	});

	it("treats a workspace parent's workspace.json as a graph", async () => {
		// A workspace parent's graph IS its workspace.json — the nodes live in the
		// children — so testing for a wiring graph alone rebuilds it every session.
		const dir = repo(true, "workspace.json");
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		expect(builds(harness)).toHaveLength(0);
	});

	it("gives the build no deadline", async () => {
		// A cold build is 24.8s on a 1424-file repo. Any timeout is a guess about
		// the largest repo anyone opens, and exceeding it kills the build silently.
		const dir = repo(false);
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		const build = builds(harness)[0];
		expect(build?.options?.stdio).toBe("ignore");
		expect(build?.options?.timeout).toBeUndefined();
	});

	it("keeps the child, so its exit can be observed", async () => {
		// Detaching would discard the one event that says the build finished, and
		// an idle session would sit at "indexing…" until the user typed.
		const dir = repo(false);
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		expect(builds(harness)[0]?.options?.detached).toBeFalsy();
	});

	it("announces nothing; the footer carries the state", async () => {
		const harness = createHarness({ cwd: repo(false) });
		await harness.emit("session_start");
		expect(harness.notices).toHaveLength(0);
	});
});

describe("no rebuild after edits", () => {
	it("never rebuilds: every trail query refreshes the graph itself", async () => {
		// Verified against trail 0.16.0 — a symbol appended without a build is
		// found, reporting "[trail] refreshed the graph (1 file changed)".
		const dir = repo(true);
		const harness = createHarness({ cwd: dir });
		await harness.emit("session_start");
		await harness.emit("tool_result", { toolName: "edit", isError: false, content: [] });
		await harness.emit("agent_settled");
		expect(builds(harness)).toHaveLength(0);
		expect(harness.calls.filter((call) => call.args[0] === "build")).toHaveLength(0);
	});
});
