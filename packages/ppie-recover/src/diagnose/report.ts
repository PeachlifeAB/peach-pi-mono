import type { OmlxEvent } from "./omlx-log.ts";
import type { SessionEvent } from "./session-timeline.ts";

export type DebugEvent = Readonly<{
	source: "ppie-recover" | "pi-omlx-picker";
	timestampMs: number;
	detail: string;
}>;

export type MergedEvent = Readonly<
	(SessionEvent | OmlxEvent | DebugEvent) & {
		matchedOmlxEvents?: OmlxEvent[];
	}
>;

export function mergeTimeline(events: Array<SessionEvent | OmlxEvent | DebugEvent>): MergedEvent[] {
	return [...events].sort((a, b) => a.timestampMs - b.timestampMs);
}

export function attachMatches(timeline: MergedEvent[], matchWindowMs = 90_000): MergedEvent[] {
	return timeline.map((event) => {
		if (event.source !== "session" || event.kind !== "message" || !event.errorClass) return event;

		const matched = timeline.filter((candidate) => {
			if (candidate.source !== "omlx" || candidate.kind !== "guard-rejection") return false;
			return Math.abs(candidate.timestampMs - event.timestampMs) <= matchWindowMs;
		});

		return matched.length === 0 ? event : { ...event, matchedOmlxEvents: matched as OmlxEvent[] };
	});
}
