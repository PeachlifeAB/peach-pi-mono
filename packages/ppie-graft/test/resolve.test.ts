import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bestGraftRoot,
	bestGraftRootChoice,
	graftRootsFromPathBinaries,
	newerVersion,
	versionSkewStatus,
} from "../src/index.ts";

const made: string[] = [];

/** A graft package root at `version`, with dist/claude/format.js present. */
function install(version: string | null, withModule = true) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "graft-install-"));
	made.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		version === null ? "not json" : JSON.stringify({ name: "@nanonets/graft", version }),
	);
	if (withModule) {
		const dist = path.join(root, "dist", "claude");
		fs.mkdirSync(dist, { recursive: true });
		fs.writeFileSync(path.join(dist, "format.js"), "export const marker = 1;\n");
	}
	return root;
}

/** A CLI entry resolving to this package root, as a package-manager bin does. */
function executable(root: string) {
	const cli = path.join(root, "dist", "cli.js");
	fs.mkdirSync(path.dirname(cli), { recursive: true });
	fs.writeFileSync(cli, "#!/usr/bin/env node\n");
	const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "graft-bin-")), "graft");
	made.push(path.dirname(bin));
	fs.symlinkSync(cli, bin);
	return bin;
}

/** A package-manager shim script beside the node_modules holding the package. */
function shimScript(version: string) {
	const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "graft-prefix-"));
	made.push(prefix);
	const root = path.join(prefix, "node_modules", "@nanonets", "graft");
	const dist = path.join(root, "dist", "claude");
	fs.mkdirSync(dist, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@nanonets/graft", version }));
	fs.writeFileSync(path.join(dist, "format.js"), "export const marker = 1;\n");
	const bin = path.join(prefix, "node_modules", ".bin", "graft");
	fs.mkdirSync(path.dirname(bin), { recursive: true });
	fs.writeFileSync(bin, '#!/bin/sh\nexec node "$(dirname "$0")/../@nanonets/graft/dist/bin/graft.js" "$@"\n');
	fs.chmodSync(bin, 0o755);
	return { root, bin };
}

afterEach(() => {
	while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

describe("version comparison", () => {
	it("orders by numeric-dotted release part", () => {
		expect(newerVersion("0.17.0", "0.16.0")).toBe(true);
		expect(newerVersion("0.16.0", "0.17.0")).toBe(false);
		expect(newerVersion("1.0.0", "0.99.99")).toBe(true);
		expect(newerVersion("0.16.0", "0.16.0")).toBe(false);
	});

	it("ignores a prerelease suffix", () => {
		expect(newerVersion("0.17.0-beta.1", "0.16.0")).toBe(true);
	});

	it("lets any known version beat an unreadable one", () => {
		expect(newerVersion("0.1.0", null)).toBe(true);
		expect(newerVersion(null, "0.1.0")).toBe(false);
	});
});

describe("graft root selection", () => {
	it("takes the highest version, not the first candidate", async () => {
		// First-hit resolution pins a user to a stale graft forever: an upgrade
		// installs elsewhere and appears to change nothing (shim-template.ts:15-20).
		const old = install("0.16.0");
		const recent = install("0.17.0");
		expect(bestGraftRoot([old, recent])).toBe(recent);
		expect(bestGraftRoot([recent, old])).toBe(recent);
	});

	it("skips a candidate that has no format.js", async () => {
		const higherButEmpty = install("0.99.0", false);
		const usable = install("0.16.0");
		expect(bestGraftRoot([higherButEmpty, usable])).toBe(usable);
	});

	it("uses an unreadable version only when it is alone", async () => {
		const unreadable = install(null);
		expect(bestGraftRoot([unreadable])).toBe(unreadable);

		const known = install("0.1.0");
		expect(bestGraftRoot([unreadable, known])).toBe(known);
	});

	it("ignores absent and empty candidates", async () => {
		const usable = install("0.16.0");
		expect(bestGraftRoot([null, "", "/nonexistent/path", usable])).toBe(usable);
	});

	it("returns null when nothing is resolvable", async () => {
		expect(bestGraftRoot([null, "/nonexistent/path"])).toBeNull();
	});

	it("keeps searching PATH after a dispatch shim", () => {
		const shim = install("0.18.0", false);
		const usable = install("0.18.0");
		const shimBinary = executable(shim);
		const usableBinary = executable(usable);
		const roots = graftRootsFromPathBinaries(`${shimBinary}\n${usableBinary}`);
		const shimRoot = path.resolve(path.dirname(fs.realpathSync(shimBinary)), "..");
		const usableRoot = path.resolve(path.dirname(fs.realpathSync(usableBinary)), "..");

		expect(roots).toEqual([shimRoot, usableRoot]);
		expect(bestGraftRoot(roots)).toBe(usableRoot);
	});

	it("resolves the install beside a shim script, which is not a symlink", () => {
		// mise and aube put a shim script on PATH, so the binary's real path is
		// the shim itself and the package is reachable only by name from the
		// directory holding it.
		const { root, bin } = shimScript("0.23.1");
		const roots = graftRootsFromPathBinaries(bin);

		// Resolution answers with real paths, and tmpdir is reached through a
		// symlink on macOS.
		expect(roots).toContain(fs.realpathSync(root));
		expect(bestGraftRoot(roots)).toBe(fs.realpathSync(root));
	});

	it("returns no PATH roots for empty output", () => {
		expect(graftRootsFromPathBinaries("")).toEqual([]);
	});
});

describe("selected root version", () => {
	it("reports the chosen root's version, not the first PATH candidate", () => {
		const first = install("0.16.0");
		const chosen = install("0.17.0");
		// The version that matters is the one whose format.js is imported.
		expect(bestGraftRootChoice([first, chosen])).toEqual({ root: chosen, version: "0.17.0" });
	});

	it("reports a null version when the chosen root is unreadable", () => {
		const unreadable = install(null);
		expect(bestGraftRootChoice([unreadable])).toEqual({ root: unreadable, version: null });
	});

	it("reports null for no resolvable candidate", () => {
		expect(bestGraftRootChoice([null, "/nonexistent/path"])).toBeNull();
	});
});

describe("version-skew footer", () => {
	it("names both versions only when they differ", () => {
		expect(versionSkewStatus("0.17.0", "0.16.0")).toBe("formatter 0.17.0 / binary 0.16.0");
		expect(versionSkewStatus("0.17.0", "0.17.0")).toBeNull();
	});

	it("stays silent when either version is unreadable", () => {
		expect(versionSkewStatus(null, "0.16.0")).toBeNull();
		expect(versionSkewStatus("0.17.0", null)).toBeNull();
	});
});
