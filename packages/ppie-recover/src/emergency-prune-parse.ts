import { DEFAULT_MEMORY_GUARD_BYTES_PER_TOKEN } from "./retry-config.ts";

function parseIntTokenCount(value: string | undefined): number | undefined {
	if (!value) return;
	const parsed = Number(value.replace(/,/g, ""));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function validOverflowTokens(input: {
	promptTokens: number | undefined;
	contextWindow: number | undefined;
}): { promptTokens: number; contextWindow: number } | undefined {
	if (!(input.promptTokens && input.contextWindow)) return;
	return {
		promptTokens: input.promptTokens,
		contextWindow: input.contextWindow,
	};
}

function parseBytesField(errorMessage: string, fieldName: "estimated_bytes" | "limit_bytes"): number | undefined {
	const match = errorMessage.match(new RegExp(`"${fieldName}"\\s*:\\s*(\\d+)`));
	if (!match) return;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

// Label precedes the number, e.g. "ceiling is 59.50 GB" or "metal_cap 51.34 GB".
function parseGbAfterLabel(errorMessage: string, label: string): number | undefined {
	const match = errorMessage.match(new RegExp(`${label}[^\\d]*?(\\d+(?:\\.\\d+)?)\\s*GB`, "i"));
	if (!match) return;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

// Number precedes the label, e.g. "~61.06 GB peak" or "54.92 GB exceeds".
function parseGbBeforeLabel(errorMessage: string, label: string): number | undefined {
	const match = errorMessage.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*GB\\s*${label}`, "i"));
	if (!match) return;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

// oMLX prefill memory guard rejects a prompt based on predicted resident-memory
// peak (current process footprint + this request's KV/SDPA cache) vs. a
// static/dynamic ceiling. Prefers the exact JSON estimated_bytes/limit_bytes
// fields; falls back to prose parsing across the known oMLX phrasings:
//   "Prefill would require ~61.06 GB peak (current 55.98 GB ...) ceiling is 59.50 GB"
//   "estimated bytes 54.92 GB exceeds metal_cap 51.34 GB"
//   "46.5GB exceeds physical cap 45.8GB"
// A terse process-memory `usage X, ceiling Y` provides a usable current
// overage only when usage > ceiling. When usage <= ceiling, the rejected
// request's omitted predicted allocation caused the failure, so that shape is
// opaque despite the dynamic reclaimability-derived admission ceiling.
// A parsed peak <= ceiling is treated as a parse failure (a real rejection is
// only sent when peak > ceiling), not as "no overage" — silently swallowing it
// hides mis-parses behind the flat-reserve fallback.
export function parseMemoryGuardOverageBytes(errorMessage: string): number | undefined {
	const estimatedBytes = parseBytesField(errorMessage, "estimated_bytes");
	const limitBytes = parseBytesField(errorMessage, "limit_bytes");
	if (estimatedBytes !== undefined && limitBytes !== undefined) {
		if (estimatedBytes <= limitBytes) return;
		return estimatedBytes - limitBytes;
	}

	const peakGb =
		parseGbBeforeLabel(errorMessage, "peak") ??
		parseGbAfterLabel(errorMessage, "usage") ??
		parseGbAfterLabel(errorMessage, "would require") ??
		parseGbBeforeLabel(errorMessage, "exceeds");
	const ceilingGb =
		parseGbAfterLabel(errorMessage, "ceiling is") ??
		parseGbAfterLabel(errorMessage, "safety cap is") ??
		parseGbAfterLabel(errorMessage, "physical cap") ??
		parseGbAfterLabel(errorMessage, "metal_cap") ??
		parseGbAfterLabel(errorMessage, "ceiling");
	if (peakGb === undefined || ceilingGb === undefined) return;
	if (peakGb <= ceilingGb) return;

	return (peakGb - ceilingGb) * 1024 ** 3;
}

function parseRequestKvBytesPerToken(errorMessage: string): number | undefined {
	const kvLengthMatch = errorMessage.match(/kv_len\s*=\s*(\d+)/i);
	const kvAllocationMatch = errorMessage.match(/\bKV(?:\+SDPA)?\s*(\d+(?:\.\d+)?)\s*(GB|MB)\b/i);
	if (!(kvLengthMatch && kvAllocationMatch)) return;
	const kvLength = Number(kvLengthMatch[1]);
	const kvAllocation = Number(kvAllocationMatch[1]);
	if (!Number.isFinite(kvLength) || kvLength <= 0 || !Number.isFinite(kvAllocation) || kvAllocation <= 0) {
		return;
	}
	const unitBytes = kvAllocationMatch[2].toUpperCase() === "GB" ? 1024 ** 3 : 1024 ** 2;
	return (kvAllocation * unitBytes) / kvLength;
}

export function parseMemoryGuardOverageTokens(
	errorMessage: string,
	fallbackBytesPerToken = DEFAULT_MEMORY_GUARD_BYTES_PER_TOKEN,
): number | undefined {
	const overageBytes = parseMemoryGuardOverageBytes(errorMessage);
	if (overageBytes === undefined) return;
	const bytesPerToken = parseRequestKvBytesPerToken(errorMessage) ?? fallbackBytesPerToken;
	if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) return;
	return Math.ceil(overageBytes / bytesPerToken);
}

export function parseOverflowTokens(errorMessage: string): { promptTokens: number; contextWindow: number } | undefined {
	const omlx = errorMessage.match(
		/(\d[\d,]*)\s+tokens?\s+exceeds\s+(?:max(?:imum)?\s+)?context\s+window\s+of\s+(\d[\d,]*)\s+tokens?/i,
	);
	if (omlx) {
		return validOverflowTokens({
			promptTokens: parseIntTokenCount(omlx[1]),
			contextWindow: parseIntTokenCount(omlx[2]),
		});
	}

	const openAi = errorMessage.match(/maximum context length is (\d[\d,]*) tokens.*?requested (\d[\d,]*)/i);
	if (openAi) {
		return validOverflowTokens({
			contextWindow: parseIntTokenCount(openAi[1]),
			promptTokens: parseIntTokenCount(openAi[2]),
		});
	}

	const anthropic = errorMessage.match(/context limit:\s*(\d[\d,]*)\s*\+\s*(\d[\d,]*)\s*>\s*(\d[\d,]*)/i);
	if (anthropic) {
		const left = parseIntTokenCount(anthropic[1]);
		const right = parseIntTokenCount(anthropic[2]);
		return validOverflowTokens({
			promptTokens: left !== undefined && right !== undefined ? left + right : undefined,
			contextWindow: parseIntTokenCount(anthropic[3]),
		});
	}
}
