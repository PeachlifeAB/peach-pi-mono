import assert from "node:assert/strict";
import test from "node:test";
import { parseMemoryGuardOverageBytes, parseMemoryGuardOverageTokens } from "../src/emergency-prune-parse.ts";

const proseOnlyError =
	"oMLX prefill memory guard rejected this prompt: Prefill would require ~61.06 GB peak (current 55.98 GB + KV+SDPA 5.08 GB) but static/metal_cap ceiling is 59.50 GB. Reduce context length.";

const estimatedBytesMetalCapError =
	"400 prefill_memory_exceeded: estimated bytes 54.92 GB exceeds metal_cap 51.34 GB resident memory";

const jsonFieldsError =
	'400: {"message":"oMLX prefill memory guard rejected this prompt: Prefill would require ~61.06 GB peak (current 55.98 GB + KV+SDPA 5.08 GB) but static/metal_cap ceiling is 59.50 GB.","code":"prefill_memory_exceeded","estimated_bytes":65592857200,"limit_bytes":63887638528}';

const preflightSafetyGuardError =
	"Prefill context too large for available memory (preflight safety guard, kv_len=92561, min_chunk=32): predicted peak would require ~44.21 GB (current 43.01 GB + KV 1.02 GB + min-chunk transient 184.27 MB) but prefill safety cap is 43.55 GB (95% of effective ceiling 45.84 GB).";

const reportedCompactionGuardError =
	'Summarization failed: 400: {"message":"Prefill context too large for available memory (preflight safety guard, kv_len=17600, min_chunk=32): predicted peak would require ~50.71 GB (current 49.63 GB + KV 1.07 GB + min-chunk transient 5.53 MB) but prefill safety cap is 48.77 GB","code":"prefill_memory_exceeded","estimated_bytes":54444253734,"limit_bytes":52369621811}';

test("JSON estimated_bytes/limit_bytes fields win over prose when both are present", () => {
	const overage = parseMemoryGuardOverageBytes(jsonFieldsError);
	assert.equal(overage, 65_592_857_200 - 63_887_638_528);
});

test("JSON estimated_bytes/limit_bytes returns undefined when estimate does not exceed limit", () => {
	const overage = parseMemoryGuardOverageBytes(
		'400: {"message":"memory guard shape with stale non-overage fields","code":"prefill_memory_exceeded","estimated_bytes":1000,"limit_bytes":1000}',
	);
	assert.equal(overage, undefined);
});

test("prose-only 'peak (current X GB + ...) ceiling is Y GB' shape parses the peak, not the current baseline", () => {
	const overage = parseMemoryGuardOverageBytes(proseOnlyError);
	assert.ok(overage !== undefined, "parser must not silently give up on the real oMLX prose shape");
	const expectedOverageBytes = (61.06 - 59.5) * 1024 ** 3;
	assert.ok(
		Math.abs((overage ?? 0) - expectedOverageBytes) < 0.05 * 1024 ** 3,
		`expected ~${expectedOverageBytes} bytes (61.06GB peak - 59.50GB ceiling), got ${overage}`,
	);
});

test("terse process usage above ceiling provides a current overage, while usage below ceiling remains opaque", () => {
	assert.equal(
		parseMemoryGuardOverageBytes("process memory limit exceeded (usage 49.8 GB, ceiling 45.8 GB)"),
		4 * 1024 ** 3,
	);
	assert.equal(
		parseMemoryGuardOverageBytes("process memory limit exceeded (usage 49.6 GB, ceiling 51.3 GB)"),
		undefined,
	);
});

test("preflight safety guard parses predicted peak against prefill safety cap", () => {
	const overage = parseMemoryGuardOverageBytes(preflightSafetyGuardError);
	const expectedOverageBytes = (44.21 - 43.55) * 1024 ** 3;
	assert.ok(
		Math.abs((overage ?? 0) - expectedOverageBytes) < 0.05 * 1024 ** 3,
		`expected ~${expectedOverageBytes} bytes, got ${overage}`,
	);
});

test("request KV allocation calibrates memory overage tokens instead of assuming an unsafe fixed bytes/token ratio", () => {
	const overageTokens = parseMemoryGuardOverageTokens(reportedCompactionGuardError);
	assert.equal(overageTokens, 31_782);
});

test("preflight KV evidence sizes the required context reduction from the provider's own request", () => {
	const overageTokens = parseMemoryGuardOverageTokens(preflightSafetyGuardError);
	assert.equal(overageTokens, 59_893);
});

test("'estimated bytes X GB exceeds metal_cap Y GB' prose shape is parsed", () => {
	const overage = parseMemoryGuardOverageBytes(estimatedBytesMetalCapError);
	assert.ok(overage !== undefined, "parser must handle the estimated-bytes/metal_cap prose shape");
	const expectedOverageBytes = (54.92 - 51.34) * 1024 ** 3;
	assert.ok(
		Math.abs((overage ?? 0) - expectedOverageBytes) < 0.05 * 1024 ** 3,
		`expected ~${expectedOverageBytes} bytes, got ${overage}`,
	);
});
