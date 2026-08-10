import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "./log.js";

const parseNdjson = (raw: string): Record<string, unknown>[] =>
	raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("Logger", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-logger-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("writes NDJSON to the default log file", async () => {
		const logger = createLogger();
		await logger("poll", { owner: "owner", repo: "repo", number: "123" });

		const raw = await readFile(path.join(tempDir, "crewmate", "crewmate.log"), "utf8");
		const lines = parseNdjson(raw);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			event: "poll",
			owner: "owner",
			repo: "repo",
			number: "123",
		});
		expect(typeof lines[0].at).toBe("string");
	});

	it("falls back to ~/.config when XDG_CONFIG_HOME is unset", async () => {
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("HOME", tempDir);
		const logger = createLogger();
		await logger("poll", {});

		const raw = await readFile(path.join(tempDir, ".config", "crewmate", "crewmate.log"), "utf8");
		const line = parseNdjson(raw)[0];
		expect(line?.event).toBe("poll");
	});

	it("appends multiple log lines", async () => {
		const logger = createLogger();
		await logger("poll", { owner: "owner" });
		await logger("mention", { commentId: 1 });

		const raw = await readFile(path.join(tempDir, "crewmate", "crewmate.log"), "utf8");
		const lines = parseNdjson(raw);

		expect(lines).toHaveLength(2);
		expect(lines[0].event).toBe("poll");
		expect(lines[1].event).toBe("mention");
	});

	it("uses a custom file path", async () => {
		const customFile = path.join(tempDir, "custom.log");
		const logger = createLogger({ filePath: customFile });
		await logger("poll", {});

		const raw = await readFile(customFile, "utf8");
		const line = parseNdjson(raw)[0];
		expect(line?.event).toBe("poll");
	});

	it("does not throw when the log write fails", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = createLogger({ filePath: tempDir });
		await expect(logger("poll", {})).resolves.toBeUndefined();
		expect(write).toHaveBeenCalled();
		write.mockRestore();
	});

	it("does not throw when the log write and stderr warning fail", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
			throw new Error("stderr broken");
		});
		const logger = createLogger({ toStderr: true, filePath: tempDir });
		await expect(logger("poll", {})).resolves.toBeUndefined();
		write.mockRestore();
	});

	it("does not throw when the stderr mirror fails", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
			throw new Error("stderr broken");
		});
		const logger = createLogger({
			toStderr: true,
			filePath: path.join(tempDir, "custom.log"),
		});
		await expect(logger("poll", {})).resolves.toBeUndefined();
		write.mockRestore();
	});

	it("does not let fields overwrite the at timestamp", async () => {
		const logger = createLogger();
		await logger("poll", { at: "overwritten" });

		const raw = await readFile(path.join(tempDir, "crewmate", "crewmate.log"), "utf8");
		const line = parseNdjson(raw)[0];
		expect(line?.at).not.toBe("overwritten");
		expect(typeof line?.at).toBe("string");
	});

	it("mirrors log lines to stderr when toStderr is true", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = createLogger({ toStderr: true });
		await logger("poll", { owner: "owner" });

		expect(write).toHaveBeenCalledWith(expect.stringContaining('"event":"poll"'));
		write.mockRestore();
	});

	it("does not mirror to stderr when toStderr is false", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = createLogger({ toStderr: false });
		await logger("poll", { owner: "owner" });

		expect(write).not.toHaveBeenCalled();
		write.mockRestore();
	});

	it("recovers after a transient mkdir failure", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const blocker = path.join(tempDir, "block");
		await writeFile(blocker, "");
		const filePath = path.join(blocker, "crewmate.log");
		const logger = createLogger({ filePath });

		await expect(logger("poll", {})).resolves.toBeUndefined();
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Warning: crewmate log failed:"));

		await rm(blocker);
		await mkdir(blocker, { recursive: true });
		await logger("poll", {});

		const raw = await readFile(filePath, "utf8");
		const lines = parseNdjson(raw);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.event).toBe("poll");
		write.mockRestore();
	});
});
