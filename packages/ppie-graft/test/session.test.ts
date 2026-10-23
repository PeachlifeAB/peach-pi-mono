import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.ts";

describe("savings tally", () => {
	const footer = (text: string) => ({ type: "text", text });

	it("sums the figure graft reports across calls", async () => {
		const harness = createHarness();
		await harness.emit("tool_result", { content: [footer("[graft] tokens saved ≈ 54,452 (96%)")] });
		await harness.emit("tool_result", { content: [footer("[graft] tokens saved ≈ 43,343 (93%)")] });
		expect(harness.status.at(-1)).toContain("98k");
	});

	it("abbreviates millions, which `graft map` reaches on its own", async () => {
		// map's baseline is "every indexed file read whole" — 2.8M in a large
		// repo, which outgrows the status bar it lives in.
		const harness = createHarness();
		await harness.emit("tool_result", { content: [footer("[graft] tokens saved ≈ 2,801,303 (100%)")] });
		expect(harness.status.at(-1)).toContain("2.8M");
	});

	it("ignores output carrying no savings figure", async () => {
		const harness = createHarness();
		await harness.emit("tool_result", { content: [footer('no hits for "foo"')] });
		expect(harness.status.at(-1)).toBeUndefined();
	});
});

// Graph upkeep lives in build.test.ts: the cold build and its absence after an
// edit are both about the spawn seam, which this file's harness does not touch.
