import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		clearMocks: true,
		restoreMocks: true,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "json"],
			include: ["src/**/*.ts"],
			exclude: ["**/node_modules/**", "**/dist/**", "**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"],
		},
	},
});
