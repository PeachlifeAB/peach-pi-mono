import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizePiSession } from "../src/pi-dialect.ts";

interface SessionFixture {
	sessionId: string;
	cwd: string;
	leafId: string;
	entries: Record<string, unknown>[];
}
interface EventMarker {
	kind: string;
	uuid?: string;
}
const fixture: SessionFixture = JSON.parse(
	readFileSync(new URL("./fixtures/pi-session.example.json", import.meta.url), "utf8"),
);
const kinds = (events: EventMarker[], kind: string) => events.filter((event) => event.kind === kind);

describe("extension-owned Pi dialect", () => {
	it("consumes a genuine input receipt once, even when injected text is identical", () => {
		const result = normalizePiSession(fixture);
		expect(kinds(result.events, "typed")).toEqual([
			{ kind: "typed", text: "Fix the failing test", at: "2026-10-30T21:00:01.000Z", uuid: "human" },
		]);
		expect(kinds(result.events, "injected")).toEqual([
			{ kind: "injected", text: "Fix the failing test", at: "2026-10-30T21:00:04.000Z", uuid: "injected" },
		]);
	});

	it("selects the active ancestry instead of reading all file entries as one conversation", () => {
		const result = normalizePiSession(fixture);
		expect(result.events.map((event: EventMarker) => event.uuid)).toEqual([
			"human",
			"call",
			"result",
			"injected",
			"compact",
		]);
		expect(kinds(result.events, "tool_call")).toEqual([
			{
				kind: "tool_call",
				id: "bash-1",
				name: "Bash",
				input: { command: "pnpm test" },
				cwd: fixture.cwd,
				at: "2026-10-30T21:00:02.000Z",
				uuid: "call",
			},
		]);
	});

	it("preserves tool failure evidence and compaction", () => {
		const { events } = normalizePiSession(fixture);
		expect(kinds(events, "tool_result")).toEqual([
			{
				kind: "tool_result",
				id: "bash-1",
				ok: false,
				isError: true,
				text: "Fixture test failed",
				at: "2026-10-30T21:00:03.000Z",
				uuid: "result",
			},
		]);
		expect(kinds(events, "compaction")).toEqual([
			{ kind: "compaction", at: "2026-10-30T21:00:06.000Z", uuid: "compact" },
		]);
	});

	it("keeps fork identity and selects the fork's own active leaf", () => {
		const result = normalizePiSession({ ...fixture, sessionId: "pi-fork", leafId: "other-branch" });
		expect(result).toMatchObject({ host: "pi", sessionId: "pi-fork", leafId: "other-branch" });
		expect(kinds(result.events, "tool_call")).toEqual([
			{
				kind: "tool_call",
				id: "off-branch-call",
				name: "Bash",
				input: { command: "git push" },
				cwd: fixture.cwd,
				at: "2026-10-30T21:00:05.000Z",
				uuid: "other-branch",
			},
		]);
	});

	it("does not infer human intent from old messages without genuine receipts", () => {
		const entries = fixture.entries.map((entry) =>
			entry.id === "receipt" ? { ...entry, customType: "another-extension" } : entry,
		);
		expect(kinds(normalizePiSession({ ...fixture, entries }).events, "typed")).toEqual([]);
	});

	it("does not treat extension or unverified RPC input as interactive human input", () => {
		for (const source of ["extension", "rpc"]) {
			const entries = fixture.entries.map((entry) =>
				entry.id === "receipt"
					? {
							...entry,
							data: { source, textSha: "caedf2c0a1b485cb0ba3b135056262a3bce5d8b63510726dc9977b09b1fda648" },
						}
					: entry,
			);
			expect(kinds(normalizePiSession({ ...fixture, entries }).events, "typed")).toEqual([]);
		}
	});

	it("rejects a broken or cyclic active ancestry rather than inventing a history", () => {
		expect(() => normalizePiSession({ ...fixture, leafId: "missing" })).toThrow();
		const entries = fixture.entries.map((entry) =>
			entry.id === "receipt" ? { ...entry, parentId: "compact" } : entry,
		);
		expect(() => normalizePiSession({ ...fixture, entries })).toThrow();
	});

	it("uses the same tool and file-path translation as native hooks", () => {
		const entries = fixture.entries.map((entry) =>
			entry.id === "call"
				? {
						...entry,
						message: {
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "write-1",
									name: "write",
									arguments: { path: "src/model.ts", content: "fixture" },
								},
							],
						},
					}
				: entry,
		);
		expect(kinds(normalizePiSession({ ...fixture, entries }).events, "tool_call")).toEqual([
			{
				kind: "tool_call",
				id: "write-1",
				name: "Write",
				input: { path: "src/model.ts", file_path: "src/model.ts", content: "fixture" },
				cwd: fixture.cwd,
				at: "2026-10-30T21:00:02.000Z",
				uuid: "call",
			},
		]);
	});
});
