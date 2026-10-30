// @ts-nocheck
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;
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

export function registerTrailTool(pi: any) {
	pi.registerTool({
		name: "trail",
		label: "Trail Context",

		description:
			"Query the codebase graph before reading raw source files. The tool name is exactly `trail`; the subcommand is a parameter, not part of the name. Pass it " +
			"in `command` and its argument in `query` — never a shell string. " +
			'E.g. {command:"grep", query:"assert_unloaded"} or {command:"ask", query:"how does X work", source:true}. ' +
			"ask=locate+understand, grep=every occurrence, skeleton=one file's API (query is the path), " +
			"callers=who uses a symbol, map=repo orientation (no query), check=graph freshness, build=reindex.",
		promptSnippet: "Query repository architecture graph, symbols, and dependencies via trail",

		promptGuidelines: [
			"Use trail for repo architecture questions, tracing call hierarchies, or finding exact symbol lines instead of grepping whole files.",
			"One call usually answers it. If a result is weak, switch tool — grep for every occurrence, callers for who-uses, skeleton for a file's API — never re-ask ask with reworded phrasing.",
			"Act on what a trail result gives you: it carries exact file:line, so go straight to that span instead of reading the file whole.",
			"Always report the tokens saved figure at the end of turns where trail is used.",
		],
		parameters: {
			type: "object",
			required: ["command"],
			properties: {
				command: {
					type: "string",
					enum: ["ask", "grep", "skeleton", "callers", "map", "check", "build"],
					description: "The trail sub-command to run",
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
						"With command=ask, requests whole definition spans. Currently a no-op in trail 0.16.0 — an excerpt ending in '(+N more lines; open <file>:L<a>-L<b>)' already names the exact span, so read that line range directly instead.",
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
				return { content: [{ type: "text", text: "Trail query cancelled." }] };
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
								`trail ${params.command} needs ${needed} in the \`query\` parameter. ` +
								`Retry as {command:"${params.command}", query:"..."}.`,
						},
					],
					isError: true,
				};
			}
			const args: string[] = params.command === "check" ? ["build", "--check"] : [params.command];
			if (params.query) {
				const cleanQuery = params.query.startsWith("@") ? params.query.slice(1) : params.query;
				args.push(cleanQuery);
			}

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
				content: [{ type: "text", text: `Running: trail ${args.join(" ")}...` }],
			});
			const res = await pi.exec("trail", args, { signal, timeout: 15000 });
			const raw = (res.stdout || "") + (res.stderr ? `\n${res.stderr}` : "");
			const { content } = truncateOutput(raw);
			return {
				content: [{ type: "text", text: content }],
				details: { exitCode: res.code, killed: res.killed },
			};
		},
	});
	pi.registerCommand("ppie-trail", {
		description: "Run a trail command and inspect repository graph state",
		handler: async (args: string, ctx: any) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const res = await pi.exec("trail", parts.length > 0 ? parts : ["map"]);
			ctx.ui?.notify?.(res.stdout || res.stderr || "No trail output received", "info");
		},
	});
}
