import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { hashPiInput } from "../src/pi-dialect.ts";
import { createPiTrace } from "../src/pi-trace.ts";
import { runWorker } from "../src/worker-process.ts";
import { archiveFixtures } from "./fixture-cleanup.ts";

const directories: string[] = [];
afterAll(() => archiveFixtures(directories));
const worker = fileURLToPath(new URL("../src/pi-trace-worker.ts", import.meta.url));
function setup(version = "0.28.0") {
	const scratch = fileURLToPath(new URL("../../../.gdog/.scratch/", import.meta.url));
	mkdirSync(scratch, { recursive: true });
	const cwd = mkdtempSync(path.join(scratch, "pi-trace-test-"));
	directories.push(cwd);
	mkdirSync(path.join(cwd, "dist", "trace"), { recursive: true });
	writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ type: "module", version }));
	cpSync(new URL("./fixtures/pi-trace-fold-fixture.mjs", import.meta.url), path.join(cwd, "dist", "trace", "runs.js"));
	const session = JSON.parse(readFileSync(new URL("./fixtures/pi-session.example.json", import.meta.url), "utf8"));
	session.cwd = cwd;
	const status: (string | undefined)[] = [];
	const receipts: { customType: string; data: unknown }[] = [];
	const ctx = {
		cwd,
		sessionManager: {
			getSessionId: (): string => session.sessionId,
			getLeafId: (): string | null => session.leafId,
			getEntries: () => session.entries,
		},
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				status.push(text);
			},
		},
	};
	const trace = createPiTrace(
		{
			appendEntry: (customType, data) => {
				receipts.push({ customType, data });
			},
		},
		() => cwd,
	);
	return { cwd, session, ctx, trace, status, receipts };
}

describe("isolated Pi trace integration", () => {
	it("records source and a text digest without storing another plaintext copy", () => {
		const { trace, ctx, receipts } = setup();
		trace.record({ source: "interactive", text: "human instruction" }, ctx);
		expect(receipts).toEqual([
			{ customType: "ppie-trail-input", data: { source: "interactive", textSha: hashPiInput("human instruction") } },
		]);
	});

	it("replays snapshots without accumulating calls, then follows the fork's active branch", async () => {
		const { trace, ctx, status, session } = setup();
		await trace.refresh(ctx);
		await trace.refresh(ctx);
		expect(status).toEqual([
			"Pi trace: 1 calls, 1 failed · learning off",
			"Pi trace: 1 calls, 1 failed · learning off",
		]);
		session.sessionId = "pi-fork";
		session.leafId = "other-branch";
		await trace.refresh(ctx);
		expect(status.at(-1)).toBe("Pi trace: 1 calls, 0 failed · learning off");
	});

	it("rejects untested installed versions before loading their private module", async () => {
		const { cwd, session, trace, ctx, status } = setup("0.29.0");
		await expect(runWorker(worker, [cwd], JSON.stringify(session), cwd, process.env)).rejects.toThrow(
			"Unsupported Trail trace version",
		);
		await expect(trace.refresh(ctx)).resolves.toBeUndefined();
		expect(status.at(-1)).toBe("Pi trace unavailable · native hooks retained");
	});

	it("discards results when the active session changes during processing", async () => {
		const { trace, ctx, session, status } = setup();
		const pending = trace.refresh(ctx);
		session.sessionId = "another-session";
		await pending;
		expect(status).toEqual([]);
	});

	it("does not block input when optional receipt persistence fails", () => {
		const { cwd, ctx, status } = setup();
		const trace = createPiTrace(
			{
				appendEntry() {
					throw new Error("fixture disk failure");
				},
			},
			() => cwd,
		);
		expect(() => trace.record({ source: "interactive", text: "human instruction" }, ctx)).not.toThrow();
		expect(status.at(-1)).toBe("Pi trace unavailable · native hooks retained");
	});
});
