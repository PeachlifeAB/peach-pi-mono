import { defineConfig } from "vitest/config";

// Root vitest owns only the vitest-compatible suites. ppie-recover's 37
// *.test.ts files run under `node --test` instead, because they need
// test/hermetic-home-node.ts loaded via `node --import` before any module
// evaluates — vitest has no equivalent pre-module hook. Those are reached by
// `pnpm -r run test`, which is what the root `test` script calls.
//
// Projects (rather than one flat include) so each package resolves its own
// config: ppie-recover's *.spec.ts need a hermetic HOME setup file that only
// makes sense relative to that package.
export default defineConfig({
	test: {
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		// Deliberately not setting passWithNoTests. Vitest exits 1 on an empty
		// match set, which is the only signal that a glob has gone stale.
		projects: ["packages/*"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "lcov"],
			include: ["packages/*/src/**/*.ts"],
			exclude: ["**/node_modules/**", "**/dist/**", "**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"],
		},
	},
});
