#!/usr/bin/env node
// Zero-dep circular-import check — the blocking gate. madge (docs:graph) is the
// visual companion but pulls a bundled TypeScript compiler; this stays free of
// any TS dependency, so it cannot break with a TypeScript version bump. Every
// relative import carries an explicit .ts/.json extension (NodeNext), which
// makes the import graph exactly recoverable with a scan — no compiler needed.
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

const IMPORT = /(?:import|export)\b[^;'"]*?from\s*["'](\.[^"']+)["']/g;

async function buildGraph(roots) {
	const graph = new Map();
	for (const root of roots) {
		for await (const file of glob(`${root}/**/*.ts`)) {
			const abs = resolve(file);
			const source = readFileSync(abs, "utf8");
			const edges = [];
			for (const match of source.matchAll(IMPORT)) {
				const target = resolve(dirname(abs), match[1]);
				if (target.endsWith(".ts")) edges.push(target);
			}
			graph.set(abs, edges);
		}
	}
	return graph;
}

// Tarjan-free DFS: report the first cycle reachable from each node.
function findCycles(graph) {
	const state = new Map(); // node -> "visiting" | "done"
	const cycles = [];
	const stack = [];

	const visit = (node) => {
		state.set(node, "visiting");
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			if (state.get(next) === "visiting") {
				const start = stack.indexOf(next);
				cycles.push([...stack.slice(start), next]);
			} else if (!state.has(next) && graph.has(next)) {
				visit(next);
			}
		}
		stack.pop();
		state.set(node, "done");
	};

	for (const node of graph.keys()) if (!state.has(node)) visit(node);
	return cycles;
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
	process.stderr.write("usage: check-circular.mjs <src-dir> [<src-dir> ...]\n");
	process.exit(2);
}

const cycles = findCycles(await buildGraph(roots));
if (cycles.length === 0) {
	process.stdout.write("✔ no circular imports\n");
	process.exit(0);
}
process.stderr.write(`✖ ${cycles.length} circular import(s):\n`);
for (const cycle of cycles) {
	process.stderr.write(`  ${cycle.map((node) => relative(process.cwd(), node)).join(" → ")}\n`);
}
process.exit(1);
