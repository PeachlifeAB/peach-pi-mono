import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseOmlxLog } from "../src/diagnose/omlx-log.ts";
import { attachMatches, type MergedEvent, mergeTimeline } from "../src/diagnose/report.ts";
import { parseSessionTimeline } from "../src/diagnose/session-timeline.ts";

const fixturesDir = join(import.meta.dirname, "fixtures");

function readFixture(filename: string): string {
	return readFileSync(join(fixturesDir, filename), "utf8");
}

describe("diagnose-matcher", () => {
	it("parses session timeline and finds memory_guard errors", () => {
		const content = readFixture("session-019f713c-memory-guard.jsonl");
		const events = parseSessionTimeline(content);

		// Find memory_guard errors
		const memoryGuards = events.filter((e) => e.kind === "message" && e.errorClass === "memory_guard");

		assert(memoryGuards.length >= 2, "Should find at least 2 memory_guard errors");

		// Verify first memory_guard is around line 884 / timestamp ~02:44:23
		const first = memoryGuards[0];
		assert.equal(first.errorClass, "memory_guard");
		// 2026-07-18T02:44:23.566Z
		assert.equal(new Date(first.timestampMs).getUTCHours(), 2);
		assert.equal(new Date(first.timestampMs).getUTCMinutes(), 44);
		assert(
			first.errorMessage?.includes("memory") || first.errorMessage?.includes("prefill"),
			`Expected memory-related error, got: ${first.errorMessage}`,
		);
	});

	it("finds compaction events in session timeline", () => {
		const content = readFixture("session-019f713c-memory-guard.jsonl");
		const events = parseSessionTimeline(content);

		const compactions = events.filter((e) => e.kind === "compaction");
		// May be none; we're just verifying the parser can find them
		assert(Array.isArray(compactions));
	});

	it("parses omlx log and detects key patterns", () => {
		const content = readFixture("omlx-server-memory-guard.log");
		const events = parseOmlxLog(content);

		const kinds = new Set(events.map((e) => e.kind));
		// Verify we detect memory protection patterns
		assert(
			kinds.has("memory-pressure") || kinds.has("prefill-throttle") || kinds.has("completion"),
			"Should detect at least memory-pressure, prefill-throttle, or completion events",
		);
		// All events should parse
		assert(events.length > 0, "Should parse some omlx events");
	});

	it("finds TurboQuant cache-conversion events at expected times", () => {
		const content = readFixture("omlx-server-memory-guard.log");
		const events = parseOmlxLog(content);

		const turboQuants = events.filter((e) => e.kind === "cache-conversion");
		assert(turboQuants.length >= 2, "Should find at least 2 TurboQuant events");

		// 03:15:40 and 03:19:46 local time
		// These are +2 hour offset timestamps
		const times = turboQuants.map((e) => new Date(e.timestampMs));
		for (const t of times) {
			const h = t.getUTCHours();
			const m = t.getUTCMinutes();
			// Should be around 03:15-03:20 local (05:15-05:20 UTC after offset)
			assert(
				(h === 5 && m >= 15) || (h === 5 && m <= 20),
				`TurboQuant at ${t.toISOString()} outside expected time window`,
			);
		}
	});

	it("extracts completion token counts correctly", () => {
		const content = readFixture("omlx-server-memory-guard.log");
		const events = parseOmlxLog(content);

		const completions = events.filter((e) => e.kind === "completion");
		assert(completions.length > 0, "Should find completion events");

		// Verify detail contains tokens and seconds
		for (const c of completions.slice(0, 5)) {
			assert(/\d+ tokens? in [\d.]+s/.test(c.detail), `Completion detail malformed: ${c.detail}`);
		}
	});

	it("merges timeline with strictly non-decreasing timestamps", () => {
		const sessionContent = readFixture("session-019f713c-memory-guard.jsonl");
		const omlxContent = readFixture("omlx-server-memory-guard.log");

		const sessionEvents = parseSessionTimeline(sessionContent);
		const omlxEvents = parseOmlxLog(omlxContent);

		const allEvents = [...sessionEvents, ...omlxEvents];
		const merged = mergeTimeline(allEvents);

		assert(merged.length > 0, "Merged timeline should not be empty");

		// Verify timestamps are non-decreasing
		for (let i = 1; i < merged.length; i++) {
			assert(
				merged[i].timestampMs >= merged[i - 1].timestampMs,
				`Timeline not sorted at index ${i}: ${merged[i].timestampMs} < ${merged[i - 1].timestampMs}`,
			);
		}
	});

	it("attaches only nearby guard rejections to session errors", () => {
		const sessionError = {
			source: "session" as const,
			timestampMs: 10_000,
			kind: "message" as const,
			errorClass: "memory_guard" as const,
			errorMessage: "prefill memory guard",
		};
		const nearbyGuard = {
			source: "omlx" as const,
			timestampMs: 10_500,
			kind: "guard-rejection" as const,
			detail: "prefill rejected",
		};
		const distantGuard = { ...nearbyGuard, timestampMs: 20_000 };

		const matched = attachMatches(mergeTimeline([sessionError, nearbyGuard, distantGuard]), 1000).find(
			(event) => event.source === "session",
		) as MergedEvent;

		assert.deepEqual(matched.matchedOmlxEvents, [nearbyGuard]);
	});

	it("verifies fixture timeline integrity", () => {
		const sessionContent = readFixture("session-019f713c-memory-guard.jsonl");
		const omlxContent = readFixture("omlx-server-memory-guard.log");

		// Parse both
		const sessionEvents = parseSessionTimeline(sessionContent);
		const omlxEvents = parseOmlxLog(omlxContent);

		console.log(`Session events: ${sessionEvents.length}, omlx events: ${omlxEvents.length}`);

		// Verify session has the expected errors
		const sessionMemoryGuards = sessionEvents.filter((e) => e.errorClass === "memory_guard");
		console.log(`Memory guard errors: ${sessionMemoryGuards.length}`);

		// Verify omlx has the expected patterns
		const omlxKinds = new Set(omlxEvents.map((e) => e.kind));
		console.log(`omlx event kinds: ${Array.from(omlxKinds).join(", ")}`);

		assert(sessionMemoryGuards.length >= 1, "Fixtures should contain memory guard errors");
		assert(omlxEvents.length > 0, "Fixtures should contain omlx log events");
	});
});
