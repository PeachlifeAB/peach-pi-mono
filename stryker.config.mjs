export default {
	mutate: ["packages/ppie-graft/src/**/*.ts"],
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	vitest: { configFile: "packages/ppie-graft/vitest.config.ts", dir: "packages/ppie-graft", related: false },
	ignorePatterns: ["**/.*", ".*/**", "unowned/**"],
	reporters: ["clear-text", "progress"],
	thresholds: { high: 80, low: 60, break: 60 },
	concurrency: 2,
	timeoutMS: 60_000,
};
