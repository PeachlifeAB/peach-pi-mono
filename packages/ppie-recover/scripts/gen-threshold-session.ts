/**
 * Generate a Pi session that sits just under a model's dynamic-compaction
 * threshold, so ONE real prompt crosses it.
 *
 * Why not fill with real content: the host does not sum per-entry token
 * counts. `getContextUsage()` calls `estimateContextTokens()`, which prefers
 * the LAST assistant message's reported `usage` and only estimates messages
 * after it (pi-coding-agent `core/compaction/compaction.js`). A single
 * assistant entry whose `usage` reports the target therefore reproduces the
 * boundary exactly, without generating ~90K tokens of live model output.
 *
 * The generated session is a real, schema-valid session file — the host reads
 * it through its own SessionManager. What it does NOT do is prove the token
 * accounting of real content; it fixes the reported usage so the threshold
 * arithmetic and lifecycle ordering can be observed deterministically.
 *
 * Usage:
 *   node --import tsx scripts/gen-threshold-session.ts \
 *     --project <abs-project-dir> --tokens 92000 \
 *     --provider ppie-custom-provider --model Carnice-V2-27b-MLX-mixed_3_6
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
	const args: Args = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`Missing value for ${token}`);
		}
		args[token.slice(2)] = value;
		index += 1;
	}
	return args;
}

function required(args: Args, name: string): string {
	const value = args[name];
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

/**
 * Pi stores sessions under a directory whose name is the project path with
 * each "/" replaced by "-", prefixed with "-" and suffixed with "--". The
 * path's own leading "/" supplies the second leading dash. Derived from the
 * live store: /Users/x/Developer/unowned/codegraph becomes
 * --Users-x-Developer-unowned-codegraph--
 */
function sessionDirFor(projectPath: string): string {
	return join(homedir(), ".pi", "agent", "sessions", `-${projectPath.replaceAll("/", "-")}--`);
}

function uuidV7(): string {
	const hex = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
	return [hex.slice(0, 8), hex.slice(8, 12), `7${hex.slice(13, 16)}`, hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

const args = parseArgs(process.argv.slice(2));
const projectPath = required(args, "project");
const provider = required(args, "provider");
const model = required(args, "model");
const tokens = Number(required(args, "tokens"));
if (!Number.isFinite(tokens) || tokens <= 0) throw new Error("--tokens must be a positive number");

const sessionId = uuidV7();
const started = new Date();
const at = (offsetMs: number) => new Date(started.getTime() + offsetMs).toISOString();

// The session entry's id IS the session id Pi resolves `--fork <id>` against;
// it must be the full uuid, not a truncated entry id. Message entries use
// short ids, matching the real store.
const sessionEntryId = sessionId;
const userId = uuidV7().slice(0, 8);
const assistantId = uuidV7().slice(0, 8);

// The assistant's reported usage IS the context size the host will read back.
// cacheRead carries the bulk, mirroring a long real session whose history is
// almost entirely cached (calculateContextTokens sums input+output+cache*).
const entries = [
	{
		type: "session",
		version: 3,
		id: sessionEntryId,
		timestamp: at(0),
		cwd: projectPath,
	},
	{
		type: "message",
		id: userId,
		parentId: sessionEntryId,
		timestamp: at(1000),
		message: {
			role: "user",
			content: "Explore this repository and summarize what the tooling does.",
		},
	},
	{
		type: "message",
		id: assistantId,
		parentId: userId,
		timestamp: at(2000),
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text: "I explored the repository and summarized the tooling. Ask a follow-up to continue.",
				},
			],
			provider,
			model,
			usage: {
				input: 1_024,
				output: 512,
				cacheRead: Math.max(0, tokens - 1_536),
				cacheWrite: 0,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: started.getTime() + 2000,
		},
	},
];

const dir = sessionDirFor(projectPath);
mkdirSync(dir, { recursive: true });
const stamp = started.toISOString().replaceAll(":", "-").replace(".", "-");
const file = join(dir, `${stamp}_${sessionId}.jsonl`);
writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

process.stdout.write(`${sessionId}\n${file}\n`);
