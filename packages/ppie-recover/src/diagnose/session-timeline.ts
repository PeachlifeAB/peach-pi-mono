import { classifyError, type ErrorClass } from "../error-classifier.ts";

export type SessionEvent = Readonly<{
	source: "session";
	timestampMs: number;
	kind: "message" | "compaction" | "session" | "model_change" | "custom";
	role?: string;
	stopReason?: string;
	errorClass?: ErrorClass;
	errorMessage?: string;
}>;

export function parseSessionTimeline(jsonlContent: string): SessionEvent[] {
	const lines = jsonlContent.split("\n").filter((l) => l.trim());
	const events: SessionEvent[] = [];

	for (const line of lines) {
		try {
			const obj = JSON.parse(line) as {
				type: string;
				timestamp: string;
				message?: {
					role?: string;
					stopReason?: string;
					errorMessage?: string;
				};
			};

			const timestampMs = new Date(obj.timestamp).getTime();

			if (obj.type === "message" && obj.message) {
				const errorMessage = obj.message.errorMessage;
				const errorClass = errorMessage ? classifyError(errorMessage) : undefined;

				events.push({
					source: "session",
					timestampMs,
					kind: "message",
					role: obj.message.role,
					stopReason: obj.message.stopReason,
					errorClass,
					errorMessage,
				});
			} else if (obj.type === "compaction") {
				events.push({
					source: "session",
					timestampMs,
					kind: "compaction",
				});
			} else if (obj.type === "session") {
				events.push({
					source: "session",
					timestampMs,
					kind: "session",
				});
			} else if (obj.type === "model_change") {
				events.push({
					source: "session",
					timestampMs,
					kind: "model_change",
				});
			}
		} catch {
			// skip unparseable lines
		}
	}

	return events;
}
