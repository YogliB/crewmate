import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: vi.fn(actual.homedir) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

const {
	acquireLock,
	isJobClosed,
	isJobDue,
	loadState,
	lockPath,
	MAX_ATTEMPTS,
	pruneState,
	retryDelaySeconds,
	saveState,
	statePath,
} = await import("./state.js");

type Job = import("./state.js").Job;
type JobMap = Awaited<ReturnType<typeof loadState>>;

const TARGET = "https://github.com/owner/repo/pull/1";
const OTHER_TARGET = "https://github.com/owner/repo/pull/2";

const job = (overrides: Partial<Job> = {}): Job => ({
	attempts: 1,
	status: "succeeded",
	updatedAt: "2026-09-01T00:00:00.000Z",
	...overrides,
});

const stateWith = (entries: Record<string, Record<string, Job>>): JobMap =>
	new Map(Object.entries(entries).map(([target, jobs]) => [target, new Map(Object.entries(jobs))]));

const alive = (p: number) => {
	try {
		process.kill(p, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const eexist = () => {
	const error = new Error("EEXIST") as NodeJS.ErrnoException;
	error.code = "EEXIST";
	return Promise.reject(error);
};

describe("state", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-state-"));
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
			expect(statePath()).toBe(path.join(tempDir, "crewmate", "state.json"));
			expect(lockPath()).toBe(path.join(tempDir, "crewmate", "lock"));
		});

		it("uses HOME", () => {
			vi.stubEnv("XDG_CONFIG_HOME", "");
			vi.stubEnv("HOME", tempDir);
			expect(statePath()).toBe(path.join(tempDir, ".config", "crewmate", "state.json"));
		});

		it("uses USERPROFILE when HOME is unset", () => {
			vi.stubEnv("XDG_CONFIG_HOME", "");
			vi.stubEnv("HOME", "");
			vi.stubEnv("USERPROFILE", tempDir);
			expect(statePath()).toBe(path.join(tempDir, ".config", "crewmate", "state.json"));
		});

		it("falls back to os.homedir()", () => {
			vi.stubEnv("XDG_CONFIG_HOME", "");
			vi.stubEnv("HOME", "");
			vi.stubEnv("USERPROFILE", "");
			vi.mocked(homedir).mockReturnValueOnce(tempDir);
			expect(statePath()).toBe(path.join(tempDir, ".config", "crewmate", "state.json"));
		});

		it("falls back to the current directory when os.homedir() throws", () => {
			vi.stubEnv("XDG_CONFIG_HOME", "");
			vi.stubEnv("HOME", "");
			vi.stubEnv("USERPROFILE", "");
			vi.mocked(homedir).mockImplementationOnce(() => {
				throw new Error("no home");
			});
			expect(statePath()).toBe(path.join(process.cwd(), ".config", "crewmate", "state.json"));
		});
	});

	describe("job helpers", () => {
		it("computes exponential retry delays", () => {
			expect(retryDelaySeconds(1)).toBe(60);
			expect(retryDelaySeconds(2)).toBe(120);
			expect(retryDelaySeconds(3)).toBe(240);
		});

		it("closes succeeded jobs and failed jobs that exhausted attempts", () => {
			expect(isJobClosed(job())).toBe(true);
			expect(isJobClosed(job({ status: "failed", attempts: MAX_ATTEMPTS }))).toBe(true);
			expect(isJobClosed(job({ status: "failed", attempts: MAX_ATTEMPTS - 1 }))).toBe(false);
			expect(isJobClosed(job({ status: "pending", attempts: 0 }))).toBe(false);
			expect(isJobClosed(job({ status: "running", attempts: 1 }))).toBe(false);
		});

		it("is due when open and the next attempt time has passed", () => {
			const now = new Date("2026-09-10T00:00:00.000Z");
			expect(isJobDue(job({ status: "pending", attempts: 0 }), now)).toBe(true);
			expect(isJobDue(job({ status: "running" }), now)).toBe(true);
			expect(isJobDue(job(), now)).toBe(false);
			expect(
				isJobDue(job({ status: "failed", nextAttemptAt: "2026-09-10T00:00:00.000Z" }), now),
			).toBe(true);
			expect(
				isJobDue(job({ status: "failed", nextAttemptAt: "2026-09-10T00:01:00.000Z" }), now),
			).toBe(false);
		});
	});

	describe("load and save", () => {
		it("loads an empty state when the file is missing", async () => {
			const state = await loadState(path.join(tempDir, "state.json"));
			expect(state.size).toBe(0);
		});

		it("rethrows non-ENOENT read errors", async () => {
			const filePath = path.join(tempDir, "state.json");
			await mkdir(filePath);
			await expect(loadState(filePath)).rejects.toThrow();
		});

		it("round-trips jobs", async () => {
			const filePath = path.join(tempDir, "state.json");
			const state = stateWith({
				[TARGET]: {
					"review:1": job(),
					"conversation:2": job({
						attempts: 2,
						lastError: "boom",
						nextAttemptAt: "2026-09-10T00:00:00.000Z",
						status: "failed",
					}),
				},
			});
			await saveState(state, filePath);
			const loaded = await loadState(filePath);
			expect(Object.fromEntries(loaded.get(TARGET)!)).toEqual({
				"review:1": job(),
				"conversation:2": job({
					attempts: 2,
					lastError: "boom",
					nextAttemptAt: "2026-09-10T00:00:00.000Z",
					status: "failed",
				}),
			});
			const raw = JSON.parse(await readFile(filePath, "utf8"));
			expect(raw.version).toBe(2);
		});

		it("migrates the v1 seen-id array format to succeeded jobs", async () => {
			const filePath = path.join(tempDir, "state.json");
			await writeFile(
				filePath,
				JSON.stringify({
					[TARGET]: ["review:1", 2, "conversation:3", "bogus", "issue:4"],
					[OTHER_TARGET]: [],
				}),
			);
			const state = await loadState(filePath);
			expect(state.has(OTHER_TARGET)).toBe(false);
			const jobs = state.get(TARGET)!;
			expect([...jobs.keys()].toSorted()).toEqual([
				"conversation:3",
				"issue:4",
				"review:1",
				"review:2",
			]);
			expect(jobs.get("review:1")!.status).toBe("succeeded");
		});

		it("drops invalid v2 entries", async () => {
			const filePath = path.join(tempDir, "state.json");
			await writeFile(
				filePath,
				JSON.stringify({
					version: 2,
					targets: {
						[TARGET]: {
							"review:1": {
								status: "succeeded",
								attempts: 1,
								updatedAt: "2026-09-01T00:00:00.000Z",
							},
							"review:2": { status: "bogus", attempts: 1, updatedAt: "2026-09-01T00:00:00.000Z" },
							"review:3": {
								status: "pending",
								attempts: -1,
								updatedAt: "2026-09-01T00:00:00.000Z",
							},
							"review:4": {
								status: "pending",
								attempts: 1.5,
								updatedAt: "2026-09-01T00:00:00.000Z",
							},
							"review:5": {
								status: "pending",
								attempts: "1",
								updatedAt: "2026-09-01T00:00:00.000Z",
							},
							"review:6": { status: "pending", attempts: 1 },
							"review:7": "nope",
							"not-a-key": { status: "pending", attempts: 0, updatedAt: "x" },
						},
						[OTHER_TARGET]: "nope",
					},
				}),
			);
			const state = await loadState(filePath);
			expect(state.has(OTHER_TARGET)).toBe(false);
			expect([...state.get(TARGET)!.keys()]).toEqual(["review:1"]);
		});

		it("resets and reports when the file is corrupted", async () => {
			const filePath = path.join(tempDir, "state.json");
			await writeFile(filePath, "not json");
			const onCorrupt = vi.fn();
			const state = await loadState(filePath, onCorrupt);
			expect(state.size).toBe(0);
			expect(onCorrupt).toHaveBeenCalledOnce();
		});

		it("resets and reports when the file is not an object", async () => {
			const filePath = path.join(tempDir, "state.json");
			await writeFile(filePath, JSON.stringify([1, 2, 3]));
			const onCorrupt = vi.fn();
			const state = await loadState(filePath, onCorrupt);
			expect(state.size).toBe(0);
			expect(onCorrupt).toHaveBeenCalledOnce();
		});

		it("warns to stderr by default on corruption", async () => {
			const filePath = path.join(tempDir, "state.json");
			await writeFile(filePath, "nope");
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			await loadState(filePath);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("corrupted"));
			stderr.mockRestore();
		});

		it("writes atomically through a temp file and cleans it up on failure", async () => {
			const filePath = path.join(tempDir, "state.json");
			const state = stateWith({ [TARGET]: { "review:1": job() } });
			await saveState(state, filePath);
			const tmpPath = `${filePath}.${process.pid}.tmp`;
			await expect(readFile(tmpPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("removes the temp file when the rename fails", async () => {
			const filePath = path.join(tempDir, "state.json");
			const blockingDir = path.join(tempDir, "state.json");
			await saveState(stateWith({ [TARGET]: { "review:1": job() } }), filePath);
			await rm(blockingDir);
			await mkdir(blockingDir);
			const state = stateWith({ [TARGET]: { "review:1": job() } });
			await expect(saveState(state, filePath)).rejects.toThrow();
			const tmpPath = `${filePath}.${process.pid}.tmp`;
			await expect(readFile(tmpPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	describe("prune", () => {
		it("ignores temp cleanup failure when the temp path is a directory", async () => {
			await mkdir(path.join(tempDir, `state.json.${process.pid}.tmp`));
			await expect(saveState(new Map(), path.join(tempDir, "state.json"))).rejects.toThrow();
		});

		it("keeps everything at or under the cap", () => {
			const state = stateWith({ [TARGET]: { "review:1": job() } });
			pruneState(state, 5);
			expect(state.get(TARGET)!.size).toBe(1);
		});

		it("drops the oldest closed jobs first and keeps open jobs", () => {
			const jobs: Record<string, Job> = {};
			for (let index = 1; index <= 6; index += 1) {
				jobs[`review:${index}`] = job({
					updatedAt: `2026-09-0${index}T00:00:00.000Z`,
				});
			}
			jobs["review:2"] = job({
				status: "pending",
				attempts: 0,
				updatedAt: "2026-09-02T00:00:00.000Z",
			});
			const state = stateWith({ [TARGET]: jobs });
			pruneState(state, 4);
			const keys = [...state.get(TARGET)!.keys()];
			expect(keys).toContain("review:2");
			expect(keys).not.toContain("review:1");
			expect(keys).not.toContain("review:3");
			expect(keys.length).toBe(4);
		});

		it("keeps all open jobs even past the cap", () => {
			const jobs: Record<string, Job> = {};
			for (let index = 1; index <= 5; index += 1) {
				jobs[`review:${index}`] = job({
					status: "pending",
					attempts: 0,
					updatedAt: `2026-09-0${index}T00:00:00.000Z`,
				});
			}
			const state = stateWith({ [TARGET]: jobs });
			pruneState(state, 2);
			expect(state.get(TARGET)!.size).toBe(5);
		});
	});

	describe("lock", () => {
		it("acquires and releases the lock", async () => {
			const release = await acquireLock({ dir: tempDir });
			expect(await readFile(path.join(tempDir, "lock", "pid"), "utf8")).toBe(String(process.pid));
			await release();
			await expect(readFile(path.join(tempDir, "lock", "pid"), "utf8")).rejects.toMatchObject({
				code: "ENOENT",
			});
		});

		it("refuses when a live process holds the lock", async () => {
			await mkdir(path.join(tempDir, "lock"));
			await writeFile(path.join(tempDir, "lock", "pid"), String(process.pid));
			await expect(acquireLock({ dir: tempDir, isProcessAlive: () => true })).rejects.toThrow(
				"already running",
			);
		});

		it("reclaims the lock when the holder is dead", async () => {
			await mkdir(path.join(tempDir, "lock"));
			await writeFile(path.join(tempDir, "lock", "pid"), "999999");
			const release = await acquireLock({ dir: tempDir, isProcessAlive: () => false });
			expect(await readFile(path.join(tempDir, "lock", "pid"), "utf8")).toBe(String(process.pid));
			await release();
		});

		it("reclaims the lock when the pid file is unreadable", async () => {
			await mkdir(path.join(tempDir, "lock"));
			const release = await acquireLock({ dir: tempDir });
			await release();
		});

		it("reclaims the lock when the pid file is not a number", async () => {
			await mkdir(path.join(tempDir, "lock"));
			await writeFile(path.join(tempDir, "lock", "pid"), "abc");
			const release = await acquireLock({ dir: tempDir, isProcessAlive: () => false });
			await release();
		});

		it("treats EPERM as alive in the default liveness check", async () => {
			const pid = process.pid;
			expect(alive(pid)).toBe(true);
			expect(alive(999999)).toBe(false);
		});

		it("rethrows unexpected mkdir errors", async () => {
			const lockParent = path.join(tempDir, "file");
			await writeFile(lockParent, "x");
			await expect(acquireLock({ dir: lockParent })).rejects.toThrow();
		});

		it("rethrows unexpected lock mkdir errors", async () => {
			const dir = path.join(tempDir, "ro");
			await mkdir(dir);
			await chmod(dir, 0o555);
			try {
				await expect(acquireLock({ dir })).rejects.toThrow();
			} finally {
				await chmod(dir, 0o755);
			}
		});

		it("reports when the lock cannot be claimed twice", async () => {
			await mkdir(path.join(tempDir, "lock"));
			await writeFile(path.join(tempDir, "lock", "pid"), "999999");
			vi.mocked(mkdir).mockImplementationOnce(eexist).mockImplementationOnce(eexist);
			await expect(acquireLock({ dir: tempDir, isProcessAlive: () => false })).rejects.toThrow(
				"could not acquire crewmate lock",
			);
		});

		it("refuses when the current process holds the lock under the default liveness check", async () => {
			const release = await acquireLock({ dir: tempDir });
			await expect(acquireLock({ dir: tempDir })).rejects.toThrow("already running");
			await release();
		});

		it("reclaims the lock from a dead pid under the default liveness check", async () => {
			await mkdir(path.join(tempDir, "lock"));
			await writeFile(path.join(tempDir, "lock", "pid"), "999999");
			const release = await acquireLock({ dir: tempDir });
			await release();
		});

		it("treats an unkillable pid as alive under the default liveness check", async () => {
			await mkdir(path.join(tempDir, "lock"));
			await writeFile(path.join(tempDir, "lock", "pid"), "1");
			await expect(acquireLock({ dir: tempDir })).rejects.toThrow("already running");
			await rm(path.join(tempDir, "lock"), { force: true, recursive: true });
		});

		it("uses the default state directory for the lock", async () => {
			vi.stubEnv("XDG_CONFIG_HOME", tempDir);
			const release = await acquireLock();
			expect(await readFile(path.join(tempDir, "crewmate", "lock", "pid"), "utf8")).toBe(
				String(process.pid),
			);
			await release();
			vi.unstubAllEnvs();
		});

		it("cleans up the temp file even when its removal fails", async () => {
			await chmod(tempDir, 0o555);
			try {
				await expect(saveState(new Map(), path.join(tempDir, "state.json"))).rejects.toThrow();
			} finally {
				await chmod(tempDir, 0o755);
			}
		});

		it("ignores failures when releasing the lock", async () => {
			const dir = path.join(tempDir, "sub");
			await mkdir(dir, { recursive: true });
			const release = await acquireLock({ dir });
			await chmod(dir, 0o555);
			try {
				await release();
				expect(await readFile(path.join(dir, "lock", "pid"), "utf8")).toBe(String(process.pid));
			} finally {
				await chmod(dir, 0o755);
			}
		});
	});
});
