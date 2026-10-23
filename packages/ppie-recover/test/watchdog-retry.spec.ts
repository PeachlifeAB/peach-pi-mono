import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import retry from "../src/retry.ts";
import { resolveRetryPolicy } from "../src/retry-policy.ts";
import { providerSilentNotice } from "../src/watchdog.ts";
import { asExtensionApi, asExtensionContext, CtxFakeCore, PiFakeCore } from "./fakes/pi-fakes.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("provider silence shows a visible warning, logs diagnostics, and does not abort", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ppie-recover-watchdog-"));
	try {
		const piCore = new PiFakeCore();
		const ctxCore = new CtxFakeCore();
		ctxCore.agentIsIdle = false;
		const ctx = asExtensionContext(ctxCore);
		retry(asExtensionApi(piCore), {
			policy: resolveRetryPolicy({
				warnings: { provider_silence_seconds: 300 },
				debug: { path: join(dir, "debug.log") },
			}),
		});

		piCore.emitAndGetResult("before_provider_request", { payload: { messages: [], max_tokens: 1000 } }, ctx);
		await vi.advanceTimersByTimeAsync(300_000);

		expect(ctxCore.abortCallCount).toBe(0);
		expect(ctxCore.ui.status).toContain("⚠️ provider silent");
		expect(ctxCore.ui.notifications).toEqual([{ message: providerSilentNotice(300_000), level: "warning" }]);
		expect(readFileSync(join(dir, "debug.log"), "utf8")).toContain("watchdog.provider_silent");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a retry request that never streams warns at the default ten-minute threshold, once, without aborting", async () => {
	const piCore = new PiFakeCore();
	const ctxCore = new CtxFakeCore();
	ctxCore.agentIsIdle = false;
	const ctx = asExtensionContext(ctxCore);
	retry(asExtensionApi(piCore), { policy: resolveRetryPolicy({}) });

	piCore.emitAndGetResult("before_provider_request", { payload: { messages: [], max_tokens: 1000 } }, ctx);
	await vi.advanceTimersByTimeAsync(599_000);
	expect(ctxCore.ui.notifications).toEqual([]);

	await vi.advanceTimersByTimeAsync(1_000);
	await vi.advanceTimersByTimeAsync(600_000);

	expect(ctxCore.abortCallCount).toBe(0);
	expect(ctxCore.ui.notifications).toEqual([{ message: providerSilentNotice(600_000), level: "warning" }]);
});
