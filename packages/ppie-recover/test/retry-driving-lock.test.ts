import assert from "node:assert/strict";
import test from "node:test";
import { createStandaloneRetryDrivingLock } from "../src/retry-driving-lock.ts";

test("waiters acquire the retry driving lock on release", async () => {
	const lock = createStandaloneRetryDrivingLock();
	const first = Symbol("first");
	const second = Symbol("second");
	assert.equal(lock.acquire(first), true);
	const acquired = lock.acquireWhenAvailable(second);
	lock.release(first);
	assert.equal(await acquired, true);
	assert.equal(lock.isHeld(second), true);
});

test("an aborted waiter never acquires later", async () => {
	const lock = createStandaloneRetryDrivingLock();
	const first = Symbol("first");
	const second = Symbol("second");
	const abort = new AbortController();
	lock.acquire(first);
	const acquired = lock.acquireWhenAvailable(second, abort.signal);
	abort.abort();
	lock.release(first);
	assert.equal(await acquired, false);
	assert.equal(lock.isHeld(), false);
});
