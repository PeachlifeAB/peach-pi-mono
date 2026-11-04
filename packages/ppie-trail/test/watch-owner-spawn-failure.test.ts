import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: () => {
		const failedSpawn = Object.assign(new EventEmitter(), { pid: undefined, unref: () => {} });
		queueMicrotask(() => failedSpawn.emit("error", new Error("spawn EAGAIN")));
		return failedSpawn;
	},
}));

it("keeps running when the watchdog cannot be started", async () => {
	const { watchOwner } = await import("../src/process-supervision.ts");
	expect(() => watchOwner(123456)).not.toThrow();
	await new Promise((resolve) => setImmediate(resolve));
});
