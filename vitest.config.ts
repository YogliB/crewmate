import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			all: true,
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts"],
			reporter: ["text", "lcov", "json"],
			thresholds: {
				perFile: true,
				statements: 100,
				branches: 100,
				functions: 100,
				lines: 100,
			},
		},
	},
});
