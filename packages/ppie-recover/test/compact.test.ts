import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCompact } from "../src/compact.ts";

function ctxWithCompact(compact: ExtensionContext["compact"]): ExtensionContext {
	return { compact } as ExtensionContext;
}

const compact = createCompact({ setStatus: () => {}, notify: () => {} });

test("compact returns completed outcome", async () => {
	const outcome = await compact(ctxWithCompact((callbacks) => callbacks?.onComplete?.(undefined as never)));
	assert.deepEqual(outcome, { kind: "completed" });
});

test("compact preserves Already compacted as unresolved ownership", async () => {
	const error = new Error("Already compacted");
	const outcome = await compact(ctxWithCompact((callbacks) => callbacks?.onError?.(error)));
	assert.equal(outcome.kind, "already-compacted");
	assert.equal(outcome.error, error);
});

test("compact distinguishes Nothing to compact and synchronous failure", async () => {
	assert.equal(
		(
			await compact(
				ctxWithCompact((callbacks) => callbacks?.onError?.(new Error("Nothing to compact (session too small)"))),
			)
		).kind,
		"nothing-to-compact",
	);
	assert.equal(
		(
			await compact(
				ctxWithCompact(() => {
					throw new Error("boom");
				}),
			)
		).kind,
		"failed",
	);
});
