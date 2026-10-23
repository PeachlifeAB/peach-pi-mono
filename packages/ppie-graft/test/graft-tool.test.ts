import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

// Every case here is a defect that reached a live session. The tool schema is
// the model's only interface, so each one is a wording or coercion bug, not a
// logic bug — which is exactly why they survived review and not use.
describe("graft tool", () => {
	it("names the subcommand as a parameter, not part of the tool name", () => {
		// A live session called a tool literally named "graft ask" after a
		// parameter description began with "ask:".
		const { tool } = createHarness();
		expect(tool.name).toBe("graft");
		for (const property of Object.values<any>(tool.parameters.properties)) {
			expect(property.description).not.toMatch(/^(ask|grep|map|skeleton|callers):/);
		}
	});

	it("refuses a subcommand that needs a query without one, naming the fix", async () => {
		// graft's own error names --pattern, a flag the model never wrote.
		const harness = createHarness();
		const result = await harness.runTool({ command: "grep" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('{command:"grep", query:"..."}');
		expect(harness.calls).toHaveLength(0);
	});

	it("runs subcommands that take no query", async () => {
		const harness = createHarness();
		await harness.runTool({ command: "map" });
		expect(harness.calls.at(-1)?.args).toContain("map");
	});

	it.each(["true", "True", "TRUE", true])("treats %o as a set boolean flag", async (value) => {
		// Models send booleans as strings, and not always lowercase. Dropping
		// those silently returned no inline source with no error.
		const harness = createHarness();
		await harness.runTool({ command: "ask", query: "how does X work", source: value });
		expect(harness.calls.at(-1)?.args).toContain("--source");
	});

	it.each(["false", "False", undefined])("treats %o as an unset flag", async (value) => {
		const harness = createHarness();
		await harness.runTool({ command: "ask", query: "how does X work", source: value });
		expect(harness.calls.at(-1)?.args).not.toContain("--source");
	});

	it("implies source when full is set, since --full alone is inert", async () => {
		const harness = createHarness();
		await harness.runTool({ command: "ask", query: "how does X work", full: true });
		expect(harness.calls.at(-1)?.args).toEqual(expect.arrayContaining(["--source", "--full"]));
	});
	it("maps every optional subcommand flag and reports streamed progress", async () => {
		const harness = createHarness();
		const updates: string[] = [];

		await harness.tool.execute(
			"id",
			{ command: "ask", query: "how does X work", full: "True", inPath: "packages/ppie-graft", limit: 7 },
			undefined,
			(update: { content: Array<{ text: string }> }) => updates.push(update.content[0].text),
			{},
		);
		expect(harness.calls.at(-1)?.args).toEqual([
			"ask",
			"how does X work",
			"--source",
			"--full",
			"--in",
			"packages/ppie-graft",
			"-n",
			"7",
		]);
		expect(updates[0]).toContain("Running: graft ask");

		await harness.runTool({ command: "grep", query: "stream", fixed: true, inPath: "src" });
		expect(harness.calls.at(-1)?.args).toEqual(["grep", "stream", "--fixed", "--in", "src"]);

		await harness.runTool({ command: "callers", query: "execute", direction: "in", depth: "2" });
		expect(harness.calls.at(-1)?.args).toEqual(["callers", "execute", "--direction", "in", "--depth", "2"]);

		await harness.runTool({ command: "map", limit: 3 });
		expect(harness.calls.at(-1)?.args).toEqual(["map", "--max-dirs", "3"]);
	});

	it("returns early for an aborted query and bounds oversized output", async () => {
		const cancelled = createHarness();
		const result = await cancelled.tool.execute("id", { command: "map" }, AbortSignal.abort(), undefined, {});
		expect(result.content[0].text).toBe("Graft query cancelled.");
		expect(cancelled.calls).toHaveLength(0);

		const longOutput = Array.from({ length: 2001 }, (_, index) => `line ${index}`).join("\n");
		const harness = createHarness({
			exec: () => ({ stdout: longOutput, stderr: "warning", code: 2, killed: true }),
		});
		const output = await harness.runTool({ command: "map" });
		expect(output.content[0].text).toContain("[Output truncated: 2000 of 2002 lines]");
		expect(output.details).toEqual({ exitCode: 2, killed: true });
	});

	it("routes the slash command to map by default and preserves explicit arguments", async () => {
		const harness = createHarness();

		await harness.runCommand("");
		await harness.runCommand("grep packages/ppie-graft");

		expect(harness.calls.map((call) => call.args)).toEqual([["map"], ["grep", "packages/ppie-graft"]]);
		expect(harness.notices).toEqual(["No graft output received", "No graft output received"]);
	});
});
