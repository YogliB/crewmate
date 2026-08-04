import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});

const { loadState, saveState, statePath } = await import("./state.js");

describe("state", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-state-"));
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	describe("path resolution", () => {
		afterEach(() => {
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

	describe("load and save", () => {
		it("loads an empty state when the file is missing", async () => {
			const state = await loadState(path.join(tempDir, "state.json"));
			expect(state.size).toBe(0);
		});

		it("saves and loads string state keys", async () => {
			const testStatePath = path.join(tempDir, "state.json");
			const state = new Map<string, string[]>([
				["https://github.com/owner/repo/pull/1", ["review:1", "conversation:2"]],
			]);
			await saveState(state, testStatePath);
			const loaded = await loadState(testStatePath);
			expect(loaded.get("https://github.com/owner/repo/pull/1")).toEqual([
				"review:1",
				"conversation:2",
			]);
		});

		it("migrates legacy number state keys to review prefix", async () => {
			const testStatePath = path.join(tempDir, "state.json");
			await writeFile(
				testStatePath,
				JSON.stringify({ "https://github.com/owner/repo/pull/1": [1, 2] }),
			);
			const loaded = await loadState(testStatePath);
			expect(loaded.get("https://github.com/owner/repo/pull/1")).toEqual(["review:1", "review:2"]);
		});

		it("handles a mixed legacy and migrated array", async () => {
			const testStatePath = path.join(tempDir, "state.json");
			await writeFile(
				testStatePath,
				JSON.stringify({
					"https://github.com/owner/repo/pull/1": [1, "conversation:3", "invalid", 2],
				}),
			);
			const loaded = await loadState(testStatePath);
			expect(loaded.get("https://github.com/owner/repo/pull/1")).toEqual([
				"review:1",
				"conversation:3",
				"review:2",
			]);
		});

		it("ignores malformed values", async () => {
			const testStatePath = path.join(tempDir, "state.json");
			await writeFile(
				testStatePath,
				JSON.stringify({
					"https://github.com/owner/repo/pull/1": ["nope", true, {}, null, undefined],
				}),
			);
			const loaded = await loadState(testStatePath);
			expect(loaded.get("https://github.com/owner/repo/pull/1")).toBeUndefined();
		});

		it("resets when the state file is not an object", async () => {
			const testStatePath = path.join(tempDir, "state.json");
			await writeFile(testStatePath, JSON.stringify(["https://github.com/owner/repo/pull/1"]));
			const loaded = await loadState(testStatePath);
			expect(loaded.size).toBe(0);
		});

		it("ignores non-array state values", async () => {
			const testStatePath = path.join(tempDir, "state.json");
			await writeFile(
				testStatePath,
				JSON.stringify({
					"https://github.com/owner/repo/pull/1": 123,
					"https://github.com/owner/repo/pull/2": { not: "an array" },
				}),
			);
			const loaded = await loadState(testStatePath);
			expect(loaded.size).toBe(0);
		});
	});
});
