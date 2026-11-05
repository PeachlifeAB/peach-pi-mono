import { afterEach, expect, it, vi } from "vitest";
import { killProcessTree } from "../src/process-supervision.ts";

afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform !== "win32").each([1, 0, -1, Number.NaN, 1.5])(
	"refuses to signal pid %s because it could reach unrelated processes",
	(pid) => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		killProcessTree(pid);
		expect(kill).not.toHaveBeenCalled();
	},
);
