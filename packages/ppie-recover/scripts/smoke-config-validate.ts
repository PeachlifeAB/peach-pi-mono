#!/usr/bin/env node
// Validate a smoke config JSON file against src/smoke-config-schema.ts (the zod
// source of truth, per ADR 0001's boundary-contract rule) and emit a
// newline-delimited record on stdout for the bash launcher to consume.
//
// Usage:
//   node --import tsx scripts/smoke-config-validate.ts <path-to-config.json>
//
// Exit 0 on success; exit 1 on JSON parse error, schema violation, or missing
// config. Stdout is one line per schema field; nothing else. Stdout
// concat-safe: structured values never contain literal newlines
// (JSON.stringify escapes them), so a newline delimiter is safe.
//
// Bash contract (smoke-real-settings-compaction.sh):
//   line 1: forkSessionId (uuid string)
//   line 2: prompt (string)
//   line 3: disableGlobalSkills ("true" | "false")
//   line 4: disableGlobalExtensions ("true" | "false")
//   line 5: model (string, or empty when omitted)
//   line 6..N+1: load entries as "kind<TAB>value" lines (or absent if load
//                is empty, in which case only the five scalar lines are
//                emitted followed by a single trailing newline)

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { formatSmokeConfigError, smokeConfigSchema } from "../src/smoke-config-schema.ts";

const fail = (msg: string): never => {
	process.stderr.write(`${msg}\n`);
	process.exit(1);
};

const configArg = process.argv[2];
if (typeof configArg !== "string" || configArg.length === 0) {
	fail("usage: smoke-config-validate.ts <path-to-config.json>");
}
const configPath = resolve(configArg);
const configStat = statSync(configPath, { throwIfNoEntry: false });
if (!configStat?.isFile()) {
	fail(`config not found: ${configPath}`);
}

const readConfig = (): unknown => {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (e) {
		return fail(`cannot read config: ${(e as Error).message}`);
	}
	try {
		return JSON.parse(raw);
	} catch (e) {
		return fail(`config is not valid JSON: ${(e as Error).message}`);
	}
};

const result = smokeConfigSchema.safeParse(readConfig());
if (!result.success) {
	process.stderr.write(`${formatSmokeConfigError(result.error, configPath)}\n`);
	process.exit(1);
}
const cfg = result.data;

// Emit the bash-consumable record. Order is fixed.
const out = [
	cfg.forkSessionId,
	cfg.prompt,
	cfg.disableGlobalSkills ? "true" : "false",
	cfg.disableGlobalExtensions ? "true" : "false",
	cfg.model ?? "",
];
for (const item of cfg.load) out.push(`${item.kind}\t${item.value}`);
process.stdout.write(`${out.join("\n")}\n`);
