import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { normalizePiSession } from "./pi-dialect.ts";

const schema = JSON.parse(readFileSync(new URL("./pi-trace.schema.json", import.meta.url), "utf8"));

export async function foldPiTrace(root: string, session: { cwd: string }, trailHome: string) {
	const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
	if (!new Ajv2020().compile(schema.$defs.compatibleVersion)(version))
		throw new Error(`Unsupported Trail trace version: ${version}`);
	const { foldEvents } = await import(pathToFileURL(path.join(root, "dist", "trace", "runs.js")).href);
	if (typeof foldEvents !== "function") throw new Error("Trail trace interface unavailable");
	const normalized = normalizePiSession(session);
	const sessionHash = createHash("sha256").update(normalized.sessionId).digest("hex");
	const state = {
		v: 1,
		sessionHash,
		host: "pi",
		tier: "D",
		learn: false,
		scopeKeys: [],
		epoch: 0,
		pendingBoundary: false,
		runs: [] as { toolCalls: number; failedCount: number }[],
		pendingOffer: null,
		offerUsed: false,
		offerUsedBy: null,
		saveRequest: null,
		injected: [],
		credit: [],
		tampered: null,
		updatedAt: new Date().toISOString(),
	};
	const result = foldEvents(state, normalized.events, {
		sessionHash,
		checkout: session.cwd,
		repoKeyOf: () => null,
		trailHome,
		transcriptPath: "",
		marks: [],
		now: new Date(),
	});
	const report = {
		host: state.host,
		tier: state.tier,
		learn: state.learn,
		sessionId: normalized.sessionId,
		leafId: normalized.leafId,
		toolCalls: state.runs.reduce((sum, run) => sum + run.toolCalls, 0),
		failedCount: state.runs.reduce((sum, run) => sum + run.failedCount, 0),
		compactions: result.compactions,
	};
	if (!new Ajv2020().compile(schema)(report)) throw new Error("Invalid Trail Pi trace report");
	return report;
}
