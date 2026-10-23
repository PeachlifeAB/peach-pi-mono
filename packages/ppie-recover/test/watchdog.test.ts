import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RETRY_POLICY } from "../src/retry-policy.ts";
import { createWatchdog } from "../src/watchdog.ts";
import { asExtensionContext, CtxFakeCore } from "./fakes/pi-fakes.ts";

const WATCHDOG_STALL_TEST_TIMEOUT_MS = 2000;

test("default provider-silence warning timeout is ten minutes", () => {
	assert.equal(DEFAULT_RETRY_POLICY.providerSilentWarningMs, 10 * 60 * 1000);
});

function fakeCtx(isIdle: boolean) {
	const core = new CtxFakeCore();
	core.agentIsIdle = isIdle;
	return { core, ctx: asExtensionContext(core) };
}

test("activity resets the stale watchdog timer before it can fire", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { ctx } = fakeCtx(false);
	let onStallCalls = 0;
	const watchdog = createWatchdog({
		getTimeoutMs: () => 100,
		onStall: () => {
			onStallCalls++;
		},
	});

	watchdog.arm(ctx);
	t.mock.timers.tick(50);
	watchdog.observe(ctx);
	t.mock.timers.tick(50);
	assert.equal(onStallCalls, 0);
	t.mock.timers.tick(50);
	assert.equal(onStallCalls, 1);
});

test("a stall is advisory and never calls ctx.abort", async () => {
	const { core, ctx } = fakeCtx(false);
	let onStallCalls = 0;
	let resolveStall: () => void = () => {};
	const stallObserved = new Promise<void>((resolve) => {
		resolveStall = resolve;
	});
	const watchdog = createWatchdog({
		getTimeoutMs: () => 5,
		onStall: () => {
			onStallCalls++;
			resolveStall();
		},
	});

	watchdog.arm(ctx);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			stallObserved,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("watchdog stall callback did not fire")),
					WATCHDOG_STALL_TEST_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}

	assert.equal(onStallCalls, 1);
	assert.equal(core.abortCallCount, 0);
});

test("watchdog public API contains only lifecycle operations", () => {
	const watchdog = createWatchdog({ getTimeoutMs: () => 0, onStall: () => {} });
	assert.deepEqual(Object.keys(watchdog).sort(), ["arm", "disarm", "observe", "reset"]);
});
