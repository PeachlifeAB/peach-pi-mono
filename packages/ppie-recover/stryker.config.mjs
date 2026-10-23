export default {
	mutate: [
		"src/agent-retry.ts",
		"src/compaction-coordinator-state.ts",
		"src/compaction-coordinator-types.ts",
		"src/compaction-coordinator.ts",
		"src/length-stop.ts",
		"src/recovery-lifecycle.ts",
	],
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	vitest: { configFile: "vitest.config.ts", dir: "." },
	ignorePatterns: ["**/.*", ".*/**"],
	reporters: ["clear-text", "progress", "json"],
	coverageAnalysis: "perTest",
	concurrency: 2,
	timeoutMS: 60_000,
};
