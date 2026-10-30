export default {
	mutate: ["packages/ppie-trail/src/**/*.ts"],
	testRunner: "vitest",
	plugins: ["@stryker-mutator/vitest-runner"],
	symlinkNodeModules: false,
	buildCommand: "pnpm install --offline --frozen-lockfile",
	vitest: { configFile: "packages/ppie-trail/vitest.config.ts", dir: "packages/ppie-trail", related: false },
	ignorePatterns: ["**/.*", ".*/**", "unowned/**", "**/graft", "**/log", "**/reports", "**/coverage", "**/dist", "**/codegraph", "**/__pycache__"],
	reporters: ["clear-text", "progress"],
	thresholds: { high: 80, low: 60, break: 60 },
	concurrency: 2,
	timeoutMS: 60_000,
};
