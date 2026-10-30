import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveFixtures } from "./fixture-cleanup.ts";
import { createHarness, realWhich } from "./harness.ts";

const scratch = path.resolve("../../.gdog/.scratch/trail-rename");
const directories: string[] = [];
afterEach(() => archiveFixtures(directories));

describe("Trail migration", () => {
	it("registers the Trail tool", () => {
		expect(createHarness().tool.name).toBe("trail");
	});

	it("uses an existing Trail cache without launching a cold build", async () => {
		fs.mkdirSync(scratch, { recursive: true });
		const cwd = fs.mkdtempSync(path.join(scratch, "cache-"));
		directories.push(cwd);
		fs.mkdirSync(path.join(cwd, ".git"));
		const graph = path.join(cwd, ".trail", "cache", ".graph");
		fs.mkdirSync(graph, { recursive: true });
		fs.writeFileSync(
			path.join(graph, "wiring.json"),
			JSON.stringify({ meta: { nodeCount: 7, edgeCount: 3 }, nodes: [], edges: [] }),
		);
		const harness = createHarness({ cwd, exec: realWhich });
		await harness.emit("session_start");
		expect(harness.spawns).toHaveLength(0);
		expect(harness.status.at(-1)).toContain("7 nodes / 3 edges");
		await harness.runTool({ command: "map" });
		expect(harness.calls.at(-1)?.command).toBe("trail");
	});
	it("injects Trail commands and the resolved cache path into orientation", async () => {
		fs.mkdirSync(scratch, { recursive: true });
		const cwd = fs.mkdtempSync(path.join(scratch, "orientation-"));
		directories.push(cwd);
		const cache = path.join(cwd, ".trail", "cache");
		fs.mkdirSync(cache, { recursive: true });
		fs.writeFileSync(path.join(cache, "INDEX.md"), "# Repository map\n");
		const harness = createHarness({ cwd, exec: realWhich });
		await harness.emit("session_start");
		const result = await harness.emit("before_agent_start", { prompt: "hi", systemPrompt: "" });
		expect(result?.systemPrompt).toContain("trail ask");
		expect(result?.systemPrompt).toContain(".trail/cache");
		expect(result?.systemPrompt).not.toContain("graft ask");
	});

	it("retains upstream discovery of a legacy graph without rebuilding", async () => {
		fs.mkdirSync(scratch, { recursive: true });
		const cwd = fs.mkdtempSync(path.join(scratch, "legacy-"));
		directories.push(cwd);
		fs.mkdirSync(path.join(cwd, ".git"));
		const graph = path.join(cwd, "graft", ".graph");
		fs.mkdirSync(graph, { recursive: true });
		fs.writeFileSync(
			path.join(graph, "wiring.json"),
			JSON.stringify({ meta: { nodeCount: 5, edgeCount: 2 }, nodes: [], edges: [] }),
		);
		const harness = createHarness({ cwd, exec: realWhich });
		await harness.emit("session_start");
		expect(harness.spawns).toHaveLength(0);
		expect(harness.status.at(-1)).toContain("5 nodes / 2 edges");
	});

	it("routes graph freshness to build --check, not the learning check", async () => {
		const harness = createHarness();
		await harness.runTool({ command: "check" });
		expect(harness.calls.at(-1)).toEqual({ command: "trail", args: ["build", "--check"] });
	});
});
