import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Ajv2020 } from "ajv/dist/2020.js";
import { hashPiInput } from "./pi-dialect.ts";
import { runWorker } from "./worker-process.ts";

interface TraceContext {
	cwd: string;
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getEntries">;
	ui: Pick<ExtensionContext["ui"], "setStatus">;
}
function unavailable(ctx: TraceContext) {
	ctx.ui.setStatus("trail-pi-trace", "Pi trace unavailable · native hooks retained");
}
interface TraceReport {
	host: "pi";
	tier: "D";
	learn: false;
	sessionId: string;
	leafId: string | null;
	toolCalls: number;
	failedCount: number;
	compactions: number;
}
const validate = new Ajv2020().compile<TraceReport>(
	JSON.parse(readFileSync(new URL("./pi-trace.schema.json", import.meta.url), "utf8")),
);
const worker = fileURLToPath(new URL("./pi-trace-worker.ts", import.meta.url));

export function createPiTrace(pi: Pick<ExtensionAPI, "appendEntry">, root: () => string | undefined) {
	return {
		record(event: { text: string; source: string }, ctx: TraceContext) {
			if (!root() || typeof ctx.sessionManager.getEntries !== "function") return;
			try {
				pi.appendEntry("ppie-trail-input", { source: event.source, textSha: hashPiInput(event.text) });
			} catch {
				unavailable(ctx);
			}
		},
		async refresh(ctx: TraceContext) {
			const installed = root();
			if (!installed || typeof ctx.sessionManager.getEntries !== "function") return;
			const snapshot = {
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				leafId: ctx.sessionManager.getLeafId(),
				entries: ctx.sessionManager.getEntries(),
			};
			try {
				const output = await runWorker(worker, [installed], JSON.stringify(snapshot), ctx.cwd, {
					...process.env,
					TRAIL_HOME: path.join(ctx.cwd, ".trail", "cache", "pi"),
				});
				const report: unknown = JSON.parse(output);
				if (!validate(report) || report.sessionId !== snapshot.sessionId || report.leafId !== snapshot.leafId)
					throw new Error("Invalid Pi trace identity");
				if (
					ctx.sessionManager.getSessionId() !== snapshot.sessionId ||
					ctx.sessionManager.getLeafId() !== snapshot.leafId
				)
					return;
				ctx.ui.setStatus(
					"trail-pi-trace",
					`Pi trace: ${report.toolCalls} calls, ${report.failedCount} failed · learning off`,
				);
			} catch {
				if (
					ctx.sessionManager.getSessionId() === snapshot.sessionId &&
					ctx.sessionManager.getLeafId() === snapshot.leafId
				)
					unavailable(ctx);
			}
		},
	};
}
export type PiTrace = ReturnType<typeof createPiTrace>;
