// @ts-nocheck
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGraphReader } from "./graph.ts";
import { createHookBridge, type HookBridge } from "./hook-bridge.ts";
import { createHookEvents } from "./hook-events.ts";
import { type HookRunner, runHook } from "./hook-process.ts";
import { binaryVersion, loadTrailFormat, versionSkewStatus } from "./installation.ts";
import { createPiTrace } from "./pi-trace.ts";
import { registerTrailTool } from "./tool.ts";

const MIN_PROMPT_CHARS = 12;
export default function (
	pi: any,
	dependencies: { hooks: (root: string) => HookRunner | undefined; formatRoots?: readonly string[] } = {
		hooks: (root) => (event, input) => runHook(root, event, input),
	},
) {
	let upstream: HookBridge | undefined;
	let installedRoot: string | undefined;
	const trace = createPiTrace(pi, () => installedRoot);
	const upstreamEvents = createHookEvents(pi, () => upstream, trace);
	let totalTokensSaved = 0;
	let trailFormat: any = null;

	let rootVersion: string | null = null;
	let binaryVersionSeen: string | null = null;

	let session: any = { injectedPointers: [], nudges: 0 };
	let oriented = false;
	let buildFailed = false;
	let activeScope: string | null = null;

	const spawn = pi.spawn ?? nodeSpawn;

	function abbreviate(n: number, decimals = 0): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 10_000) return `${(n / 1000).toFixed(decimals).replace(/\.0$/, "")}k`;
		return n.toLocaleString("sv-SE");
	}

	function updateStatusline(ctx: any) {
		if (!ctx?.ui) return;
		const cwd = ctx?.cwd || process.cwd();
		const segments = ["🌱 trail"];
		if (!hasGraph(cwd)) {
			segments.push(buildFailed ? "build failed — run trail build" : "indexing…");
		} else {
			const counts = graphCounts(cwd);
			if (counts) segments.push(`${abbreviate(counts.nodes, 1)} nodes / ${abbreviate(counts.edges, 1)} edges`);
		}
		const skew = versionSkewStatus(rootVersion, binaryVersionSeen);
		if (skew) segments.push(skew);
		if (totalTokensSaved > 0) segments.push(`~${abbreviate(totalTokensSaved)} saved`);
		ctx.ui.setStatus("ppie-trail", segments.join(" · "));
	}
	let mapDirFor: ((cwd: string) => string) | undefined;
	const trailDir = (cwd: string) => mapDirFor?.(cwd) ?? path.join(cwd, ".trail", "cache");
	const { graphCounts, blastRadius, staleBanner, scopeOf } = createGraphReader(trailDir, () => trailFormat);
	const indexPath = (cwd: string) => path.join(trailDir(cwd), "INDEX.md");

	const hasGraph = (cwd: string) =>
		fs.existsSync(path.join(trailDir(cwd), ".graph", "wiring.json")) ||
		fs.existsSync(path.join(trailDir(cwd), "workspace.json"));
	async function runTrail(cwd: string, args: string[]) {
		try {
			return await pi.exec("trail", args, { timeout: 15000, cwd });
		} catch {
			return null;
		}
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		totalTokensSaved = 0;
		session = { injectedPointers: [], nudges: 0 };
		oriented = false;
		activeScope = null;
		updateStatusline(ctx);
		const cwd = ctx?.cwd || process.cwd();

		const loaded = await loadTrailFormat(cwd, pi.exec, dependencies.formatRoots);
		installedRoot = loaded?.root;
		trailFormat = loaded?.format ?? null;
		mapDirFor = loaded?.mapDirFor;
		const hookRunner = loaded?.root ? dependencies.hooks(loaded.root) : undefined;
		upstream = hookRunner ? createHookBridge(hookRunner) : undefined;
		rootVersion = loaded?.rootVersion ?? null;
		binaryVersionSeen = await binaryVersion(pi.exec);
		updateStatusline(ctx);
		if (upstream) await upstreamEvents.start(ctx);

		if (!fs.existsSync(path.join(cwd, ".git"))) return;
		if (hasGraph(cwd)) return;

		buildFailed = false;
		const build = spawn("trail", ["build", cwd], { stdio: "ignore" });
		const finished = (ok: boolean) => {
			buildFailed = !ok || !hasGraph(cwd);
			updateStatusline(ctx);
		};
		build.on("exit", (code: number | null) => finished(code === 0));

		build.on("error", () => finished(false));
	});

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		if (upstream) return upstreamEvents.beforeAgent(event.prompt, event.systemPrompt, ctx);
		const cwd = ctx?.cwd || process.cwd();

		updateStatusline(ctx);
		if (!trailFormat || !fs.existsSync(indexPath(cwd))) return;
		const blocks: string[] = [];
		if (!oriented) {
			oriented = true;
			try {
				const index = fs.readFileSync(indexPath(cwd), "utf8");
				blocks.push(
					trailFormat.formatOrientation(
						index,
						undefined,
						staleBanner(cwd),
						0,
						false,
						"",
						path.relative(cwd, trailDir(cwd)),
					),
				);
			} catch {}
		}
		const prompt = String(event?.prompt ?? "").trim();
		if (prompt.length >= MIN_PROMPT_CHARS) {
			const scope = activeScope ? ["--in", activeScope] : [];
			const res = await runTrail(cwd, ["ask", prompt, cwd, "--json", "-n", "3", ...scope]);
			if (res?.stdout) {
				try {
					const pack = trailFormat.relevantRetrieval(JSON.parse(res.stdout), session);
					if (pack) blocks.push(pack);
				} catch {}
			}
		}
		if (!blocks.length) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
	});

	pi.on("tool_result", async (event: any, ctx: any) => {
		if (upstream) return upstreamEvents.afterTool(event, ctx);
		if (!Array.isArray(event?.content)) return;

		if (!event.isError) {
			const cwd = ctx?.cwd || process.cwd();
			const file = String(event?.input?.path ?? "");
			if (file) activeScope = scopeOf(cwd, file) ?? activeScope;
			const report = file && blastRadius(cwd, file);
			if (report) {
				return { content: [...event.content, { type: "text", text: report }] };
			}
		}
		for (const item of event.content) {
			if (item?.type === "text" && typeof item.text === "string") {
				const match = item.text.match(/\[trail\] tokens saved ≈ (\d+[\d,]*)/i);
				if (match) {
					const count = parseInt(match[1].replace(/,/g, ""), 10);
					if (!Number.isNaN(count)) {
						totalTokensSaved += count;
						updateStatusline(ctx);
					}
				}
			}
		}
	});
	registerTrailTool(pi);
}
