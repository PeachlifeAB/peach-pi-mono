import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CompactionOutcome } from "../../src/compact.ts";
import type { CompactionRequest } from "../../src/compaction-coordinator.ts";
import type { DynamicCompactionDependencies } from "../../src/dynamic-compaction.ts";
import { registerDynamicCompaction } from "../../src/dynamic-compaction.ts";
import { asExtensionApi, asExtensionContext, type CtxFakeCore, type PiFakeCore } from "./pi-fakes.ts";

/**
 * Shared lifecycle drivers for the dynamic-compaction suites. Dynamic
 * compaction spans two Pi lifecycle events, so every test needs the same
 * agent_end-then-agent_settled sequence and the same branch-entry shapes.
 */

// Timestamp of the terminal assistant message every completed run carries.
// Boundary tests position compaction entries relative to this value.
export const ASSISTANT_AT = 1_000;

/** A completed run: one assistant message with the given stop reason. */
export const completedRun = (stopReason = "stop", timestamp = ASSISTANT_AT) => ({
	messages: [{ role: "assistant", stopReason, timestamp }],
});

/**
 * One full agent run: Pi emits agent_end, drains its retry/continuation loop,
 * then emits agent_settled. Dynamic compaction may only act on the second.
 */
export const runLifecycle = (piCore: PiFakeCore, ctxCore: CtxFakeCore, event = completedRun()) => {
	piCore.emit("agent_end", event, asExtensionContext(ctxCore));
	piCore.emit("agent_settled", {}, asExtensionContext(ctxCore));
};

export function registerDynamicCompactionForTest(piCore: PiFakeCore, ratio: number): CompactionRequest[] {
	const requests: CompactionRequest[] = [];
	let pending: CompactionRequest | undefined;
	let compactStarted = false;
	const coordinator = {
		request(request: CompactionRequest) {
			if (pending) return "already-pending" as const;
			pending = request;
			requests.push(request);
			return "accepted" as const;
		},
	} as DynamicCompactionDependencies["coordinator"];
	const dependencies: DynamicCompactionDependencies = {
		coordinator,
		compact: (ctx) =>
			new Promise<CompactionOutcome>((resolve) => {
				ctx.compact({
					onComplete: () => {
						pending?.onCallerContinuation({ kind: "compaction-completed", lifecycleEpoch: 0 });
						pending = undefined;
						compactStarted = false;
						resolve({ kind: "completed" });
					},
					onError: (error) => {
						pending?.onUnavailable({ kind: "failed", error });
						pending = undefined;
						compactStarted = false;
						resolve({ kind: "failed", error });
					},
				});
			}),
		createRequestIsCurrent: () => () => true,
		compactionWarningMs: undefined,
		stallCheckMs: 180_000,
		stallRetryMs: 480_000,
	};
	registerDynamicCompaction(asExtensionApi(piCore), ratio, dependencies);
	piCore.on("agent_settled", () => {
		const active = pending;
		if (active && !compactStarted) {
			compactStarted = true;
			void active.compact?.();
		}
	});
	return requests;
}

/** A persisted compaction boundary entry. */
export const compactionEntry = (timestamp: number) =>
	({
		type: "compaction",
		id: `compaction-${timestamp}`,
		parentId: undefined,
		timestamp: new Date(timestamp).toISOString(),
		summary: "",
	}) as unknown as SessionEntry;

/**
 * A rewind bookkeeping entry of the kind pi-rewind-hook appends immediately
 * after a compaction, displacing it from the branch tail.
 */
export const rewindEntry = (timestamp: number) =>
	({
		type: "custom",
		customType: "rewind-op",
		id: `rewind-${timestamp}`,
		parentId: undefined,
		timestamp: new Date(timestamp).toISOString(),
		data: { v: 2, snapshots: [], bindings: [] },
	}) as unknown as SessionEntry;
