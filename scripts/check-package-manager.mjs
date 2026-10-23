#!/usr/bin/env node
// Fails an install driven by anything other than pnpm, before resolution starts.
//
// This workspace resolves dependency versions through a `catalog:` in
// pnpm-workspace.yaml. `catalog:` is a pnpm protocol, so npm cannot resolve it
// and dies with `EUNSUPPORTEDPROTOCOL — Unsupported URL Type "catalog:"`, which
// names neither the cause nor the fix. The root `packageManager` field declares
// pnpm correctly, but only Corepack-aware tools honour it; npm ignores the field
// entirely, so nothing stops the command from running. Hence this guard.
//
// Zero-dep on purpose: it runs before node_modules exists.
import process from "node:process";

// npm sets npm_config_user_agent on every lifecycle script it runs; pnpm and
// yarn set it too, each naming themselves first. Absent means the script was
// invoked directly (`node scripts/...`), which is not an install worth blocking.
const userAgent = process.env.npm_config_user_agent;
if (!userAgent) process.exit(0);

const agent = userAgent.split("/")[0];
if (agent === "pnpm") process.exit(0);

// pnpm delegates some lifecycle work to npm internally. Bail out rather than
// block when pnpm is demonstrably the outer runner, so the guard cannot break
// a legitimate pnpm install.
if (process.env.npm_config_frozen_lockfile !== undefined) process.exit(0);

process.stderr.write(
	`\n✖ This workspace requires pnpm — ${agent} cannot install it.\n\n` +
		`  Dependency versions resolve through a "catalog:" in pnpm-workspace.yaml,\n` +
		`  which is a pnpm-only protocol. ${agent} fails on it with an opaque\n` +
		`  EUNSUPPORTEDPROTOCOL error partway through resolution.\n\n` +
		`  Use:  pnpm install\n\n` +
		`  If pnpm is not installed:  corepack enable && corepack prepare --activate\n\n`,
);
process.exit(1);
