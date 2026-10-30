// @ts-nocheck
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const nodeRequire = createRequire(import.meta.url);
const FORMAT_MODULE = path.join("dist", "claude", "format.js");

const TRAIL_PACKAGE = "@trailhq/trail-code";

function versionOf(root: string): string | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || null;
	} catch {
		return null;
	}
}

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

export function bestTrailRootChoice(
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

export function bestTrailRoot(candidates: (string | null | undefined)[]): string | null {
	return bestTrailRootChoice(candidates)?.root ?? null;
}
function fromPkg(base: string): string | null {
	try {
		return path.dirname(nodeRequire.resolve(`${TRAIL_PACKAGE}/package.json`, { paths: [base] }));
	} catch {
		return null;
	}
}

function packageAbove(file: string): string | null {
	let dir = path.dirname(file);
	for (let level = 0; level < 6; dir = path.dirname(dir), level++) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			if (pkg.name === TRAIL_PACKAGE) return dir;
		} catch {}
	}
	return null;
}

export function trailRootsFromPathBinaries(output: string): string[] {
	const roots = new Set<string>();
	for (const binary of output.split(/\r?\n/)) {
		if (!binary) continue;
		const beside = fromPkg(path.dirname(binary));
		if (beside) roots.add(beside);
		try {
			const above = packageAbove(fs.realpathSync(binary));
			if (above) roots.add(above);
		} catch {}
	}
	return [...roots];
}

export async function loadTrailFormat(
	cwd: string,
	exec: any,
	fallbackRoots?: readonly string[],
): Promise<{ format: any; rootVersion: string | null; root: string; mapDirFor?: (cwd: string) => string } | null> {
	let pathRoots: string[] = [];
	try {
		const bins = String((await exec("which", ["-a", "trail"], { timeout: 5000 }))?.stdout ?? "");
		pathRoots = trailRootsFromPathBinaries(bins);
	} catch {}
	const cheap = [
		...pathRoots,
		...(fallbackRoots ?? [
			fromPkg(cwd),
			fromPkg(process.cwd()),
			fromPkg(path.join(path.dirname(process.execPath), "..", "lib")),
		]),
	];
	let choice = bestTrailRootChoice(cheap);
	if (!choice) {
		try {
			const res = await exec("npm", ["root", "-g"], { timeout: 5000 });
			const global = String(res?.stdout ?? "").trim();
			if (global) choice = bestTrailRootChoice([path.join(global, "@trailhq", "trail-code")]);
		} catch {}
	}
	if (!choice) return null;
	const format = await import(pathToFileURL(path.join(choice.root, FORMAT_MODULE)).href);
	const brandPath = path.join(choice.root, "dist", "brand.js");
	const inBrand = fs.existsSync(brandPath)
		? (await import(pathToFileURL(brandPath).href)).inBrand
		: (text: string) => text;
	const brandedFormat = { ...format };
	for (const name of ["formatOrientation", "formatBlastRadius", "relevantRetrieval"]) {
		if (typeof format[name] !== "function") continue;
		brandedFormat[name] = (...args: any[]) => {
			const result = format[name](...args);
			return typeof result === "string" ? inBrand(result, "trail") : result;
		};
	}
	const mapPath = path.join(choice.root, "dist", "context", "map-dir.js");
	const mapDirFor = fs.existsSync(mapPath) ? (await import(pathToFileURL(mapPath).href)).mapDirFor : undefined;
	return {
		format: brandedFormat,
		mapDirFor,
		rootVersion: choice.version,
		root: choice.root,
	};
}

export async function binaryVersion(exec: any): Promise<string | null> {
	try {
		const res = await exec("trail", ["--version"], { timeout: 5000 });
		const out = String(res?.stdout ?? "").trim();
		const match = out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
		return match ? match[0] : null;
	} catch {
		return null;
	}
}

export function versionSkewStatus(rootVersion: string | null, binaryVersion: string | null): string | null {
	if (!rootVersion || !binaryVersion || rootVersion === binaryVersion) return null;
	return `formatter ${rootVersion} / binary ${binaryVersion}`;
}
