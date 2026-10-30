// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
export function createGraphReader(trailDir: (cwd: string) => string, format: () => any) {
	function graphCounts(cwd: string): { nodes: number; edges: number } | null {
		try {
			const fd = fs.openSync(path.join(trailDir(cwd), ".graph", "wiring.json"), "r");
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

	function blastRadius(cwd: string, file: string): string | null {
		if (!format()?.formatBlastRadius) return null;

		if (path.resolve(cwd, file).startsWith(trailDir(cwd) + path.sep)) return null;
		try {
			const wiring = JSON.parse(fs.readFileSync(path.join(trailDir(cwd), ".graph", "wiring.json"), "utf8"));
			return format().formatBlastRadius(wiring, file);
		} catch {
			return null;
		}
	}

	function staleBanner(cwd: string): string | undefined {
		let indexed: { path: string }[];
		try {
			indexed = JSON.parse(fs.readFileSync(path.join(trailDir(cwd), "manifest.json"), "utf8"))?.files ?? [];
		} catch {
			return undefined;
		}
		let missing = 0;
		for (const ref of indexed) {
			if (!fs.existsSync(path.resolve(cwd, ref.path))) missing++;
		}
		if (!missing) return undefined;
		return (
			`⚠ trail's index may be ahead of your working tree: ${missing} of ${indexed.length} indexed ` +
			"files are not on disk (branch switch or uncommitted move?). If trail names a path that " +
			"isn't there, don't chase it — `trail grep` the symbol to find where it lives now; run `trail build` to refresh."
		);
	}

	function scopeOf(cwd: string, file: string): string | null {
		let scopes: { prefix: string }[];
		try {
			const wiring = JSON.parse(fs.readFileSync(path.join(trailDir(cwd), ".graph", "wiring.json"), "utf8"));
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

	return { graphCounts, blastRadius, staleBanner, scopeOf };
}
