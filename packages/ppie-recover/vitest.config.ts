import { defineConfig } from "vitest/config";

// Only *.spec.ts here. The 37 *.test.ts files in this package run under
// `node --test` (the test:node script) because they need
// test/hermetic-home-node.ts loaded through `node --import` before any module
// evaluates, so import-time policy resolution cannot read the operator's real
// config. Vitest has no equivalent pre-module hook — setupFiles runs too late.
// Matching *.test.ts here would run them under the wrong runner.
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.spec.ts"],
		setupFiles: ["./test/hermetic-home.setup.ts"],
		clearMocks: true,
		restoreMocks: true,
	},
});
