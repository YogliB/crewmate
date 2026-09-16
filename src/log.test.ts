import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const { createLogger } = await import("./log.js");

describe("log", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-log-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("appends NDJSON lines to the default log path", async () => {
		const logger = createLogger();
		await logger("poll", { url: "https://example.com" });
		const content = await readFile(path.join(tempDir, "crewmate", "crewmate.log"), "utf8");
		const line = JSON.parse(content.trim());
		expect(line.event).toBe("poll");
		expect(line.url).toBe("https://example.com");
		expect(typeof line.at).toBe("string");
	});

	it("mirrors lines to stderr when toStderr is set", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = createLogger({ filePath: path.join(tempDir, "log.ndjson"), toStderr: true });
		await logger("info", { message: "hi" });
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"event":"info"'));
	});

	it("warns to stderr when the log write fails", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = createLogger({ filePath: path.join(tempDir, "missing", "deep", "x", "\0bad") });
		await logger("info", { message: "hi" });
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Warning: crewmate log failed"));
	});

	it("warns as NDJSON when the log write fails and toStderr is set", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = createLogger({
			filePath: path.join(tempDir, "missing", "deep", "x", "\0bad"),
			toStderr: true,
		});
		await logger("info", { message: "hi" });
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"event":"warning"'));
	});

	it("survives stderr itself failing", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => {
			throw new Error("stderr closed");
		});
		const logger = createLogger({
			filePath: path.join(tempDir, "missing", "deep", "x", "\0bad"),
			toStderr: true,
		});
		await expect(logger("info", { message: "hi" })).resolves.toBeUndefined();
	});

	it("survives stderr failing on the mirror path", async () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => {
			throw new Error("stderr closed");
		});
		const logger = createLogger({ filePath: path.join(tempDir, "log.ndjson"), toStderr: true });
		await expect(logger("info", { message: "hi" })).resolves.toBeUndefined();
	});

	it("rotates the log once it exceeds the size cap", async () => {
		const filePath = path.join(tempDir, "log.ndjson");
		await writeFile(filePath, "x".repeat(2048));
		const logger = createLogger({ filePath, maxBytes: 1024 });
		await logger("info", { message: "after rotation" });
		const rotated = await readFile(`${filePath}.1`, "utf8");
		expect(rotated).toBe("x".repeat(2048));
		const fresh = await readFile(filePath, "utf8");
		expect(fresh).toContain("after rotation");
		expect(fresh).not.toContain("x".repeat(2048));
	});

	it("does not rotate under the cap", async () => {
		const filePath = path.join(tempDir, "log.ndjson");
		await writeFile(filePath, "small\n");
		const logger = createLogger({ filePath, maxBytes: 1024 });
		await logger("info", { message: "hi" });
		await expect(readFile(`${filePath}.1`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		const content = await readFile(filePath, "utf8");
		expect(content).toContain("small");
		expect(content).toContain('"event":"info"');
	});

	it("tolerates a failed rotation and still appends", async () => {
		const filePath = path.join(tempDir, "log.ndjson");
		await writeFile(filePath, "x".repeat(2048));
		await writeFile(`${filePath}.1`, "backup");
		const logger = createLogger({ filePath, maxBytes: 1024 });
		await logger("info", { message: "second rotation" });
		expect(await readFile(`${filePath}.1`, "utf8")).toBe("x".repeat(2048));
	});
});
