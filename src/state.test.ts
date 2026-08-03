import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});

const { statePath } = await import("./state.js");

describe("state path resolution", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-state-"));
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
		vi.mocked(homedir).mockRestore();
	});

	it("uses XDG_CONFIG_HOME", () => {
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
		expect(statePath()).toBe(path.join(tempDir, "pickup", "state.json"));
	});

	it("uses HOME", () => {
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("HOME", tempDir);
		expect(statePath()).toBe(path.join(tempDir, ".config", "pickup", "state.json"));
	});

	it("falls back to os.homedir()", () => {
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("HOME", "");
		vi.mocked(homedir).mockReturnValueOnce(tempDir);
		expect(statePath()).toBe(path.join(tempDir, ".config", "pickup", "state.json"));
	});

	it("falls back to the current directory when os.homedir() throws", () => {
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("HOME", "");
		vi.mocked(homedir).mockImplementationOnce(() => {
			throw new Error("no home");
		});
		expect(statePath()).toBe(path.join(process.cwd(), ".config", "pickup", "state.json"));
	});
});
