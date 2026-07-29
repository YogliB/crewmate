import { describe, expect, it, vi } from "vitest";
import run from "./index.js";

describe("run", () => {
	it("logs a greeting with the provided arguments", () => {
		const log = vi.spyOn(console, "log").mockImplementation(vi.fn());

		run(["--pick", "up"]);

		expect(log).toHaveBeenCalledWith("Hello from pickup!", ["--pick", "up"]);
		log.mockRestore();
	});

	it("falls back to process.argv when no arguments are given", () => {
		const log = vi.spyOn(console, "log").mockImplementation(vi.fn());

		run();

		expect(log).toHaveBeenCalledWith("Hello from pickup!", expect.any(Array));
		log.mockRestore();
	});

	it("runs the CLI entry point", () => {
		const log = vi.spyOn(console, "log").mockImplementation(vi.fn());

		return import("./bin.js").then(() => {
			expect(log).toHaveBeenCalledWith("Hello from pickup!", expect.any(Array));
			return log.mockRestore();
		});
	});
});
