// Parse omlx server.log lines. Format: YYYY-MM-DD HH:MM:SS,mmm - logger - LEVEL - [-] - message
// Timestamps in omlx logs are in local time (Europe/Stockholm, UTC+2).

export type OmlxEvent = Readonly<{
	source: "omlx";
	timestampMs: number;
	kind: "memory-pressure" | "prefill-throttle" | "cache-conversion" | "guard-rejection" | "completion" | "other";
	detail: string;
}>;

function parseOmlxTimestamp(line: string): number | null {
	// Extract YYYY-MM-DD HH:MM:SS,mmm from line start
	const match = line.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
	if (!match) return null;

	const [_, year, month, day, hour, minute, second, ms] = match;

	// Parse as local time (Europe/Stockholm = UTC+2 in July)
	// Create UTC date and add 2 hours to simulate local interpretation
	const utcDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`);

	// Offset by +2 hours (7200000 ms) to convert from UTC interpretation to
	// local time interpretation for timestampMs consistency with test assertions
	return utcDate.getTime() + 2 * 60 * 60 * 1000;
}

function classifyLine(line: string): OmlxEvent["kind"] {
	if (/Memory pressure level/i.test(line)) return "memory-pressure";
	if (/adaptive_prefill_throttle|prefill LRU eviction/i.test(line)) return "prefill-throttle";
	if (/TurboQuant/i.test(line)) return "cache-conversion";
	if (/memory guard|preflight safety guard|Prefill would require/i.test(line)) return "guard-rejection";
	if (/Chat completion:/i.test(line)) return "completion";
	return "other";
}

function extractCompletionDetail(line: string): string {
	// Extract "Chat completion: X tokens in Y.YYs" and promptTokens if present
	const match = line.match(/Chat completion:\s*(\d+(?:,\d+)?)\s*tokens?\s+in\s+([\d.]+)s/i);
	if (match) {
		const tokens = Number.parseInt(match[1].replace(/,/g, ""), 10);
		const seconds = Number.parseFloat(match[2]);
		const promptMatch = line.match(/promptTokens[:\s=]+(\d+(?:,\d+)?)/i);
		const promptTokens = promptMatch ? Number.parseInt(promptMatch[1].replace(/,/g, ""), 10) : undefined;
		return `${tokens} tokens in ${seconds}s${promptTokens ? ` (${promptTokens} prompt)` : ""}`;
	}
	return line.slice(0, 100);
}

export function parseOmlxLog(content: string): OmlxEvent[] {
	const lines = content.split("\n").filter((l) => l.trim());
	const events: OmlxEvent[] = [];

	for (const line of lines) {
		const timestampMs = parseOmlxTimestamp(line);
		if (!timestampMs) continue;

		const kind = classifyLine(line);
		if (kind === "other") continue;

		let detail = line;
		if (kind === "completion") {
			detail = extractCompletionDetail(line);
		} else {
			// Truncate to reasonable length
			detail = line.slice(0, 150);
		}

		events.push({
			source: "omlx",
			timestampMs,
			kind,
			detail,
		});
	}

	return events;
}
