// @ts-nocheck
import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const nodeRequire = createRequire(import.meta.url);

const DEFAULT_MAX_BYTES = 50 * 1024; // 50 KiB
const DEFAULT_MAX_LINES = 2000;

// Claude's UserPromptSubmit hook ignores prompts below this (hooks.ts:20): a
// three-word prompt has nothing for the ranker to match on.
const MIN_PROMPT_CHARS = 12;

/** The module every candidate must actually contain to be usable. */
const FORMAT_MODULE = path.join("dist", "claude", "format.js");

/** The installed package every candidate root belongs to. */
const GRAFT_PACKAGE = "@nanonets/graft";

/** A graft package root's version, or null when unreadable. */
function versionOf(root: string): string | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || null;
	} catch {
		return null;
	}
}

/**
 * Numeric-dotted compare of the release part; an unreadable version loses to any
 * known one. Ported from graft's own shim (shim-template.js:124).
 */
export function newerVersion(a: string | null, b: string | null): boolean {
	if (!a) return false;
	if (!b) return true;
	const parts = (v: string) =>
		String(v)
			.split("-")[0]
			.split(".")
			.map((n) => Number(n) || 0);
	const pa = parts(a);
	const pb = parts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) return d > 0;
	}
	return false;
}

/**
 * The highest-versioned candidate that actually carries format.js, or null.
 *
 * Highest version, not first hit: graft's shim resolves this way because
 * first-hit "silently pinned users to a stale graft forever" — the upgraded
 * install is not the one loaded, so `npm i -g @nanonets/graft@latest` appears to
 * work and changes nothing (shim-template.ts:15-20).
 */
/** The chosen root together with its version, or null when nothing resolves. */
export function bestGraftRootChoice(
	candidates: (string | null | undefined)[],
): { root: string; version: string | null } | null {
	let bestRoot: string | null = null;
	let bestVer: string | null = null;
	for (const root of candidates) {
		if (!root || !fs.existsSync(path.join(root, FORMAT_MODULE))) continue;
		const version = versionOf(root);
		if (bestRoot === null || newerVersion(version, bestVer)) {
			bestRoot = root;
			bestVer = version;
		}
	}
	return bestRoot === null ? null : { root: bestRoot, version: bestVer };
}

/** The chosen root alone, for callers that do not need its version. */
export function bestGraftRoot(candidates: (string | null | undefined)[]): string | null {
	return bestGraftRootChoice(candidates)?.root ?? null;
}
/** Where a package root is, given a base whose node_modules is searched. */
function fromPkg(base: string): string | null {
	try {
		return path.dirname(nodeRequire.resolve(`${GRAFT_PACKAGE}/package.json`, { paths: [base] }));
	} catch {
		return null;
	}
}

/** The nearest package.json above `file` that names graft, or null. */
function packageAbove(file: string): string | null {
	let dir = path.dirname(file);
	for (let level = 0; level < 6; dir = path.dirname(dir), level++) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			if (pkg.name === GRAFT_PACKAGE) return dir;
		} catch {
			// No readable package.json at this level.
		}
	}
	return null;
}

/**
 * Package-root candidates derived from every executable `which -a graft`
 * reports. Two mechanisms, as graft's shipped shim uses (shim-template.ts,
 * `onPath`): the package resolved by name from the directory holding the
 * binary, which covers a shim script beside its node_modules, and the nearest
 * package.json above the binary's real path, which covers a bin symlinked into
 * the package.
 */
export function graftRootsFromPathBinaries(output: string): string[] {
	const roots = new Set<string>();
	for (const binary of output.split(/\r?\n/)) {
		if (!binary) continue;
		const beside = fromPkg(path.dirname(binary));
		if (beside) roots.add(beside);
		try {
			const above = packageAbove(fs.realpathSync(binary));
			if (above) roots.add(above);
		} catch {
			// A PATH entry can disappear between lookup and resolution.
		}
	}
	return [...roots];
}

/**
 * graft's own dist/claude/format.js — the strength and novelty gates that decide
 * whether a retrieval pack earns its place in the prompt, plus the orientation
 * directive. Imported rather than reimplemented so the thresholds cannot drift
 * from upstream. format.js is pure formatting; hooks.js is deliberately NOT
 * imported (it reads fd 0, which in a TUI is pi's own terminal input).
 *
 * Candidate order and selection mirror graft's shipped shim
 * (dist/claude/shim-template.js, `entry`): cheap candidates first, `npm root -g`
 * only when all of them miss, and the highest version wins throughout.
 */
async function loadGraftFormat(cwd: string, exec: any): Promise<{ format: any; rootVersion: string | null } | null> {
	// The binary pi already runs. Upstream's shim has an absolute path stamped in
	// by `graft init` (hosts/claude-global.ts); pi has no such step, so the
	// symlink on PATH stands in for it. A candidate like any other — ranked by
	// version, not taken first. Without it a homebrew install is unreachable:
	// its node_modules is not the Node install's own lib dir.
	let pathRoots: string[] = [];
	try {
		const bins = String((await exec("which", ["-a", "graft"], { timeout: 5000 }))?.stdout ?? "");
		pathRoots = graftRootsFromPathBinaries(bins);
	} catch {
		// graft not on PATH
	}

	const cheap = [
		...pathRoots,
		fromPkg(cwd),
		fromPkg(process.cwd()),
		// The Node install's own lib dir. Without it, switching Node versions
		// (nvm, volta) strands the session on whichever copy it finds first.
		fromPkg(path.join(path.dirname(process.execPath), "..", "lib")),
	];

	let choice = bestGraftRootChoice(cheap);

	if (!choice) {
		// npm's answer for the global dir, layout-agnostic across Homebrew, volta
		// and Windows — it finds an install whose bin never reached PATH. Shelled
		// out to only when every cheap candidate missed.
		try {
			const res = await exec("npm", ["root", "-g"], { timeout: 5000 });
			const global = String(res?.stdout ?? "").trim();
			if (global) choice = bestGraftRootChoice([path.join(global, "@nanonets", "graft")]);
		} catch {
			// npm unavailable
		}
	}

	if (!choice) return null;
	return {
		format: await import(pathToFileURL(path.join(choice.root, FORMAT_MODULE)).href),
		rootVersion: choice.version,
	};
}

/**
 * The version the `graft` binary on PATH reports, or null when it cannot be
 * read. Read once per session: the answer cannot change mid-session without an
 * install happening under the running process, and a subprocess per turn would
 * cost more than the footer it feeds.
 */
async function binaryVersion(exec: any): Promise<string | null> {
	try {
		const res = await exec("graft", ["--version"], { timeout: 5000 });
		const out = String(res?.stdout ?? "").trim();
		const match = out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
		return match ? match[0] : null;
	} catch {
		return null;
	}
}

/** Footer segment for a formatter/binary mismatch; silence means healthy or unknown. */
export function versionSkewStatus(rootVersion: string | null, binaryVersion: string | null): string | null {
	if (!rootVersion || !binaryVersion || rootVersion === binaryVersion) return null;
	return `formatter ${rootVersion} / binary ${binaryVersion}`;
}

function truncateOutput(content: string, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES) {
	const lines = content.split("\n");
	const totalLines = lines.length;
	const totalBytes = Buffer.byteLength(content, "utf8");

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return { content, truncated: false };
	}

	const sliceLines = lines.slice(0, maxLines);
	let truncatedContent = sliceLines.join("\n");

	while (Buffer.byteLength(truncatedContent, "utf8") > maxBytes && sliceLines.length > 0) {
		sliceLines.pop();
		truncatedContent = sliceLines.join("\n");
	}

	return {
		content: `${truncatedContent}\n\n[Output truncated: ${sliceLines.length} of ${totalLines} lines]`,
		truncated: true,
	};
}

export default function (pi: any) {
	let totalTokensSaved = 0;
	let graftFormat: any = null;
	// The two versions the footer compares: the install whose format.js was
	// imported, and the binary every `graft` subprocess actually runs. They can
	// disagree, and a silently-skipped retrieval pack reads as a healthy session
	// unless the mismatch is said out loud.
	let rootVersion: string | null = null;
	let binaryVersionSeen: string | null = null;
	// Mirrors Claude's per-session SessionState: the novelty gate in
	// relevantRetrieval drops pointers already shown this session.
	let session: any = { injectedPointers: [], nudges: 0 };
	let oriented = false;
	let buildFailed = false;
	/** Scope prefix of the last file a tool touched; null until one has. */
	let activeScope: string | null = null;
	// Injected so a test can drive the child's exit; pi's own API has no seam for
	// a background process.
	const spawn = pi.spawn ?? nodeSpawn;

	/**
	 * Millions read as noise in a footer. `graft map` alone reports its baseline as
	 * "every indexed file read whole" (2.8M in a 1424-file repo), so a running
	 * total outgrows the bar it lives in. Abbreviate rather than cap: the figure
	 * stays graft's own, which is what the model is asked to report.
	 */
	function abbreviate(n: number, decimals = 0): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 10_000) return `${(n / 1000).toFixed(decimals).replace(/\.0$/, "")}k`;
		return n.toLocaleString("sv-SE");
	}

	/**
	 * The graph's own node and edge counts, without parsing it.
	 *
	 * graft writes `meta` first, so a 4KB prefix carries both counts: 1ms against
	 * 37ms to parse a 16MB wiring.json, and the footer is rebuilt every turn.
	 * Null when the counts cannot be read — the graph is still built, it just
	 * cannot say how big it is.
	 */
	function graphCounts(cwd: string): { nodes: number; edges: number } | null {
		try {
			const fd = fs.openSync(path.join(graftDir(cwd), ".graph", "wiring.json"), "r");
			const buf = Buffer.alloc(4096);
			const read = fs.readSync(fd, buf, 0, 4096, 0);
			fs.closeSync(fd);
			const head = buf.subarray(0, read).toString("utf8");
			const nodes = head.match(/"nodeCount":\s*(\d+)/);
			const edges = head.match(/"edgeCount":\s*(\d+)/);
			if (!nodes || !edges) return null;
			return { nodes: Number(nodes[1]), edges: Number(edges[1]) };
		} catch {
			return null;
		}
	}

	/**
	 * Rebuilt from the graph on every call, mirroring Claude's statusline
	 * (format.ts:25) — which is recomputed on each render rather than announced.
	 * That matters here: the cold build is detached and reports no completion, so
	 * a one-shot "indexing…" notice could never correct itself once it finished.
	 */
	function updateStatusline(ctx: any) {
		if (!ctx?.ui) return;
		const cwd = ctx?.cwd || process.cwd();
		const segments = ["🌱 graft"];

		if (!hasGraph(cwd)) {
			// A build that exited without writing a graph is not still running.
			segments.push(buildFailed ? "build failed — run graft build" : "indexing…");
		} else {
			// An empty graph is still a graph — a docs-only repo legitimately has 0
			// nodes (upstream statusline.ts:9-12).
			// One decimal on the counts: 13.7k reads as a size, 14k as a guess.
			const counts = graphCounts(cwd);
			if (counts) segments.push(`${abbreviate(counts.nodes, 1)} nodes / ${abbreviate(counts.edges, 1)} edges`);
		}

		const skew = versionSkewStatus(rootVersion, binaryVersionSeen);
		if (skew) segments.push(skew);
		if (totalTokensSaved > 0) segments.push(`~${abbreviate(totalTokensSaved)} saved`);
		ctx.ui.setStatus("ppie-graft", segments.join(" · "));
	}

	const graftDir = (cwd: string) => path.join(cwd, "graft");
	const indexPath = (cwd: string) => path.join(graftDir(cwd), "INDEX.md");

	/**
	 * Mirrors graft's own hasGraftIndex (graph/root.ts:23). A repo's graph is its
	 * wiring graph; a workspace parent's graph is its children index, with the
	 * nodes in the children — testing for either alone rebuilds the other shape
	 * on every session.
	 */
	const hasGraph = (cwd: string) =>
		fs.existsSync(path.join(graftDir(cwd), ".graph", "wiring.json")) ||
		fs.existsSync(path.join(graftDir(cwd), "workspace.json"));

	async function runGraft(cwd: string, args: string[]) {
		try {
			return await pi.exec("graft", args, { timeout: 15000, cwd });
		} catch {
			return null;
		}
	}

	// 1. Session start: reset the tally, and index a repo that has never been
	//    indexed. Claude's plugin builds nothing in a session — its session-start
	//    hook reads the graph and emits orientation (hooks.ts:397), and the cold
	//    build belongs to `graft init`, which the user runs and watches
	//    (init.ts:44). Pi has no `graft init`, so this covers it.
	pi.on("session_start", async (_event: any, ctx: any) => {
		totalTokensSaved = 0;
		session = { injectedPointers: [], nudges: 0 };
		oriented = false;
		activeScope = null;
		updateStatusline(ctx);

		const cwd = ctx?.cwd || process.cwd();
		// Both versions are read here, once per session: the chosen root's, from the
		// install whose format.js is imported, and the binary's own, from a single
		// `graft --version`. A mismatch is reported rather than resolved — highest
		// version is the resolution rule, and silently downgrading to match the
		// binary would undo it.
		const loaded = await loadGraftFormat(cwd, pi.exec);
		graftFormat = loaded?.format ?? null;
		rootVersion = loaded?.rootVersion ?? null;
		binaryVersionSeen = await binaryVersion(pi.exec);
		updateStatusline(ctx);
		// A directory outside a git repo is not a project — ask-session scratch
		// folders, /tmp, $HOME. Building there stamps a 1-node stub graph into the
		// session and lets the orientation describe an "indexed repo" that is
		// nothing of the kind; cloned or checked-out repos always carry .git.
		if (!fs.existsSync(path.join(cwd, ".git"))) return;
		if (hasGraph(cwd)) return;

		// In the background and unbudgeted. A cold build is 24.8s on a 1424-file
		// repo, so awaiting it stalls the session opening, and any timeout is a
		// guess about the largest repo anyone opens — one that kills the build
		// silently when wrong. pi.exec expresses neither: it awaits and kills.
		//
		// The child is kept rather than detached. Detaching would discard `exit`,
		// the one signal that says the build finished, and an idle session would
		// sit at "indexing…" until the user happened to type. Claude never faces
		// this — its build is a synchronous `graft init` the user watches, and its
		// statusline is a command the host re-runs (settings-merge.ts:5). The cost
		// is that closing pi mid-build loses it; the next session rebuilds.
		buildFailed = false;
		const build = spawn("graft", ["build", cwd], { stdio: "ignore" });
		const finished = (ok: boolean) => {
			buildFailed = !ok || !hasGraph(cwd);
			updateStatusline(ctx);
		};
		// A signal gives code null; either way, no graph means no success.
		build.on("exit", (code: number | null) => finished(code === 0));
		// `exit` never fires when the binary is missing — only `error`, which is
		// also fatal if left unhandled. Without this the footer would say
		// "indexing…" forever for a build that never started.
		build.on("error", () => finished(false));
	});

	// 2. The system-prompt seam. Pi has no cached session prompt, so this one
	//    handler carries what Claude splits across two hooks:
	//      - SessionStart -> the full orientation, once (cached input for Claude,
	//        first-turn-only here).
	//      - UserPromptSubmit -> a pointers-only retrieval pack per turn, gated by
	//        graft's own strength/novelty rules (hooks.ts:437-461).
	//    It also covers PostCompact for free: firing every turn means the
	//    orientation survives compaction (capability matrix C29).
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const cwd = ctx?.cwd || process.cwd();
		// Before the early return: this is the per-turn tick that lets the footer
		// notice a detached build has landed.
		updateStatusline(ctx);
		if (!graftFormat || !fs.existsSync(indexPath(cwd))) return;

		const blocks: string[] = [];

		if (!oriented) {
			oriented = true;
			try {
				const index = fs.readFileSync(indexPath(cwd), "utf8");
				blocks.push(graftFormat.formatOrientation(index, undefined, staleBanner(cwd)));
			} catch {
				// No INDEX.md despite a graft/ dir — skip orientation, keep retrieval.
			}
		}

		const prompt = String(event?.prompt ?? "").trim();
		if (prompt.length >= MIN_PROMPT_CHARS) {
			// No --source: per-turn tokens are fresh full-price input, so the pack
			// carries locators and the model pulls spans itself (hooks.ts:441-443).
			// In a monorepo, weight the pack toward the package being worked on;
			// `--in` filters before scoring (cli.ts:578).
			const scope = activeScope ? ["--in", activeScope] : [];
			const res = await runGraft(cwd, ["ask", prompt, cwd, "--json", "-n", "3", ...scope]);
			if (res?.stdout) {
				try {
					const pack = graftFormat.relevantRetrieval(JSON.parse(res.stdout), session);
					if (pack) blocks.push(pack);
				} catch {
					// Unparseable ask output — stay silent rather than inject noise.
				}
			}
		}

		if (!blocks.length) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
	});

	/**
	 * Who depends on a file a tool just named. A pure read of the wiring graph
	 * already on disk — no subprocess — formatted by graft's own
	 * formatBlastRadius so the cap and wording match the Claude plugin
	 * (format.ts:68). Null whenever there is nothing to say.
	 */
	function blastRadius(cwd: string, file: string): string | null {
		if (!graftFormat?.formatBlastRadius) return null;
		// The graph's own artifacts are written by every build; reporting on them
		// would fire on graft's own output rather than the model's work.
		if (path.resolve(cwd, file).startsWith(graftDir(cwd) + path.sep)) return null;
		try {
			const wiring = JSON.parse(fs.readFileSync(path.join(graftDir(cwd), ".graph", "wiring.json"), "utf8"));
			return graftFormat.formatBlastRadius(wiring, file);
		} catch {
			// No graph, or one this graft cannot read — say nothing.
			return null;
		}
	}

	/**
	 * How many files the deep layer recorded have since left the working tree —
	 * the "index built on a different tree" case: a branch switch, a checkout, an
	 * unpulled move. An existence check only, never a read or a hash, which is
	 * what makes it safe on the first turn (check.ts:122-140). Null when there is
	 * no manifest to compare against: the deep layer is optional, and its absence
	 * is not staleness.
	 *
	 * Deliberately not `graft check`: that exits non-zero merely because the deep
	 * layer is unbuilt, while saying the wiring graph is the source of truth. Read
	 * as a staleness signal it showed a permanent false banner advising a build
	 * that could not clear it.
	 */
	function staleBanner(cwd: string): string | undefined {
		let indexed: { path: string }[];
		try {
			indexed = JSON.parse(fs.readFileSync(path.join(graftDir(cwd), "manifest.json"), "utf8"))?.files ?? [];
		} catch {
			return undefined;
		}
		let missing = 0;
		for (const ref of indexed) {
			if (!fs.existsSync(path.resolve(cwd, ref.path))) missing++;
		}
		if (!missing) return undefined;
		return (
			`⚠ graft's index may be ahead of your working tree: ${missing} of ${indexed.length} indexed ` +
			"files are not on disk (branch switch or uncommitted move?). If graft names a path that " +
			"isn't there, don't chase it — `graft grep` the symbol to find where it lives now; run `graft build` to refresh."
		);
	}

	/**
	 * The scope prefix owning `file`, or null when narrowing would say nothing:
	 * a single-scope repo, or a file under graft's fallback root scope (prefix
	 * "", scopes.ts:282). Mirrors `scopeOf` — nearest owner first, matched on a
	 * segment boundary so "packages/ppie-graft" cannot claim
	 * "packages/ppie-graft-extras" (scopes.ts:277, :306). Graft sorts its scopes
	 * longest-prefix-first when it writes them (scopes.ts:270); sort again
	 * rather than trust the order that reaches us.
	 */
	function scopeOf(cwd: string, file: string): string | null {
		let scopes: { prefix: string }[];
		try {
			const wiring = JSON.parse(fs.readFileSync(path.join(graftDir(cwd), ".graph", "wiring.json"), "utf8"));
			scopes = wiring?.meta?.scopes ?? [];
		} catch {
			return null;
		}
		if (scopes.length < 2) return null;
		const rel = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join("/");
		const sorted = [...scopes].sort((a, b) => b.prefix.length - a.prefix.length);
		for (const { prefix } of sorted) {
			if (prefix && (rel === prefix || rel.startsWith(`${prefix}/`))) return prefix;
		}
		return null;
	}

	// 3. Claude's two PostToolUse matchers on pi's single tool_result seam
	//    (capability matrix C11, "strong"): sum the savings footer graft prints,
	//    and report the fan-in of a file the model just edited.
	//
	//    No dirty tracking, and no rebuild anywhere: every graft query refreshes
	//    the graph before answering ("[graft] refreshed the graph (N files
	//    changed)"). Upstream's post-turn sync exists to refresh the markdown
	//    cards under graft/, which this extension never reads.
	pi.on("tool_result", async (event: any, ctx: any) => {
		if (!Array.isArray(event?.content)) return;

		// Keyed on the path, never on the tool name. Pi is a customizable harness:
		// a list of editing tools missed `insert` and `replace` from
		// pi-hashline-edit-pro (src/insert.ts:169, src/replace.ts:262) and would
		// miss whatever is installed next. Any successful result naming a file the
		// graph holds earns the report — the graph is the filter, and a read that
		// earns one is informative rather than wrong.
		//
		// The path is on the tool input; EditToolDetails carries only a diff.
		if (!event.isError) {
			const cwd = ctx?.cwd || process.cwd();
			const file = String(event?.input?.path ?? "");
			// Where the session's attention is, for the next turn's retrieval.
			if (file) activeScope = scopeOf(cwd, file) ?? activeScope;
			const report = file && blastRadius(cwd, file);
			if (report) {
				return { content: [...event.content, { type: "text", text: report }] };
			}
		}

		for (const item of event.content) {
			if (item?.type === "text" && typeof item.text === "string") {
				const match = item.text.match(/\[graft\] tokens saved ≈ (\d+[\d,]*)/i);
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

	// 4. Register standard graft tool with JSON schema definition
	pi.registerTool({
		name: "graft",
		label: "Graft Context",
		// The model reaches for a shell-shaped call ("grep -n foo -w .") unless the
		// split between `command` and `query` is spelled out with an example.
		description:
			"Query the codebase graph before reading raw source files. The tool name is exactly `graft`; the subcommand is a parameter, not part of the name. Pass it " +
			"in `command` and its argument in `query` — never a shell string. " +
			'E.g. {command:"grep", query:"assert_unloaded"} or {command:"ask", query:"how does X work", source:true}. ' +
			"ask=locate+understand, grep=every occurrence, skeleton=one file's API (query is the path), " +
			"callers=who uses a symbol, map=repo orientation (no query), check=graph freshness, build=reindex.",
		promptSnippet: "Query repository architecture graph, symbols, and dependencies via graft",
		// Call discipline lives here as well as in the injected orientation: these
		// bullets sit next to the tool in the prompt, and a traced session showed the
		// model re-asking `ask` four times with reworded queries when only the
		// orientation carried the rule.
		promptGuidelines: [
			"Use graft for repo architecture questions, tracing call hierarchies, or finding exact symbol lines instead of grepping whole files.",
			"One call usually answers it. If a result is weak, switch tool — grep for every occurrence, callers for who-uses, skeleton for a file's API — never re-ask ask with reworded phrasing.",
			"Act on what a graft result gives you: it carries exact file:line, so go straight to that span instead of reading the file whole.",
			"Always report the tokens saved figure at the end of turns where graft is used.",
		],
		parameters: {
			type: "object",
			required: ["command"],
			properties: {
				command: {
					type: "string",
					enum: ["ask", "grep", "skeleton", "callers", "map", "check", "build"],
					description: "The graft sub-command to run",
				},
				query: {
					type: "string",
					description: "Search query, question, symbol name, or target file path",
				},
				direction: {
					type: "string",
					enum: ["in", "out"],
					description: "Caller direction ('in' for who-calls, 'out' for dependencies)",
				},
				depth: {
					type: "string",
					description: "Call graph depth: '1', '2', or 'all'",
				},
				inPath: {
					type: "string",
					description: "Narrow scope to directory subtree (--in <path>)",
				},
				source: {
					type: "boolean",
					description:
						"With command=ask, inlines the code at each hit so the result is the answer and no file needs reopening. Use it by default.",
				},
				full: {
					type: "boolean",
					description:
						"With command=ask, requests whole definition spans. Currently a no-op in graft 0.16.0 — an excerpt ending in '(+N more lines; open <file>:L<a>-L<b>)' already names the exact span, so read that line range directly instead.",
				},
				fixed: {
					type: "boolean",
					description: "Fixed string match (for 'grep')",
				},
				limit: {
					type: "integer",
					description:
						"With command=ask, the maximum number of results (default 8). With command=map, the maximum subdirectories listed per package (default 16), not the number of packages.",
				},
			},
		},
		async execute(_toolCallId: string, params: any, signal: any, onUpdate: any, _ctx: any) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Graft query cancelled." }] };
			}

			const NEEDS_QUERY: Record<string, string> = {
				ask: "a question or task",
				grep: "a literal or pattern to search for",
				skeleton: "a file path",
				callers: "a symbol name",
			};
			const needed = NEEDS_QUERY[params.command];
			if (needed && !String(params.query ?? "").trim()) {
				return {
					content: [
						{
							type: "text",
							text:
								`graft ${params.command} needs ${needed} in the \`query\` parameter. ` +
								`Retry as {command:"${params.command}", query:"..."}.`,
						},
					],
					isError: true,
				};
			}

			const args: string[] = [params.command];

			if (params.query) {
				const cleanQuery = params.query.startsWith("@") ? params.query.slice(1) : params.query;
				args.push(cleanQuery);
			}

			// Models send booleans as strings, and not always lowercase: a live session
			// sent "True" (Python-style). Silently dropping those loses the flag.
			const flag = (v: unknown) => v === true || (typeof v === "string" && v.toLowerCase() === "true");

			if (params.command === "ask") {
				if (flag(params.source) || flag(params.full)) args.push("--source");
				if (flag(params.full)) args.push("--full");
				if (params.inPath) args.push("--in", params.inPath);
				if (params.limit) args.push("-n", String(params.limit));
			} else if (params.command === "grep") {
				if (flag(params.fixed)) args.push("--fixed");
				if (params.inPath) args.push("--in", params.inPath);
			} else if (params.command === "callers") {
				if (params.direction) args.push("--direction", params.direction);
				if (params.depth) args.push("--depth", params.depth);
			} else if (params.command === "map" && params.limit) {
				args.push("--max-dirs", String(params.limit));
			}

			onUpdate?.({
				content: [{ type: "text", text: `Running: graft ${args.join(" ")}...` }],
			});

			const res = await pi.exec("graft", args, { signal, timeout: 15000 });
			const raw = (res.stdout || "") + (res.stderr ? `\n${res.stderr}` : "");
			const { content } = truncateOutput(raw);

			return {
				content: [{ type: "text", text: content }],
				details: { exitCode: res.code, killed: res.killed },
			};
		},
	});

	// 4. Register slash command
	pi.registerCommand("ppie-graft", {
		description: "Run a graft command and inspect repository graph state",
		handler: async (args: string, ctx: any) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const res = await pi.exec("graft", parts.length > 0 ? parts : ["map"]);
			ctx.ui?.notify?.(res.stdout || res.stderr || "No graft output received", "info");
		},
	});
}
