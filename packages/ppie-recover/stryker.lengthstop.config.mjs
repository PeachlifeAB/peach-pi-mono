export default {
	mutate: ["src/length-stop.ts"],
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	vitest: { configFile: "vitest.config.ts", dir: "." },
	ignorePatterns: ["**/.*", ".*/**"],
	reporters: ["clear-text", "progress-append-only"],
	coverageAnalysis: "perTest",
	concurrency: 2,
	timeoutMS: 60_000,
};
