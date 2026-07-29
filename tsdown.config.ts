import { defineConfig } from "tsdown";

export default defineConfig({
	dts: true,
	entry: {
		bin: "src/bin.ts",
		index: "src/index.ts",
	},
	format: ["esm"],
	minify: true,
	outDir: "dist",
	outExtensions: () => ({
		js: ".js",
	}),
	platform: "node",
	sourcemap: false,
	target: "node20",
});
