import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import run from "./index.js";
import { tmpdir } from "node:os";

type Runner = (file: string, args: string[]) => Promise<string>;

const startsWithRepos = (value: string | undefined): boolean =>
	typeof value === "string" && value.startsWith("repos/");

const PR_URL = "https://github.com/owner/repo/pull/123";

const makeExplainRunner = (replies: { claude?: string } = {}): Runner =>
	vi.fn((file: string, args: string[]) => {
		if (file === "gh" && args.at(0) === "api" && startsWithRepos(args.at(1))) {
			return Promise.resolve(
				JSON.stringify([
					{ body: "@pickup hello", id: 1, line: 5, path: "src/index.ts", user: { login: "alice" } },
				]),
			);
		}
		if (file === "gh" && args.at(0) === "pr") {
			return Promise.resolve("");
		}
		if (file === "gh" && args.at(0) === "--version") {
			return Promise.resolve("gh version");
		}
		if (file === "gh" && args.at(0) === "auth") {
			return Promise.resolve("");
		}
		if (file === "claude") {
			return Promise.resolve(replies.claude ?? "");
		}
		if (file === "git" && args.at(0) === "rev-parse") {
			return Promise.resolve("abc123");
		}
		if (file === "git") {
			return Promise.resolve("");
		}
		return Promise.resolve("");
	}) as unknown as Runner;

const makeFixRunner = (
	targetPath: string,
	options: { failOn?: string; fixed?: string } = {},
): Runner =>
	vi.fn((file: string, args: string[]) => {
		if (
			options.failOn &&
			file === options.failOn.split(" ").at(0) &&
			JSON.stringify(args).includes(options.failOn.split(" ").slice(1).join(" "))
		) {
			return Promise.reject(new Error(`${options.failOn} failed`));
		}
		if (file === "gh" && args.at(0) === "api" && startsWithRepos(args.at(1))) {
			return Promise.resolve(
				JSON.stringify([
					{ body: "@pickup fix", id: 1, line: 1, path: targetPath, user: { login: "alice" } },
				]),
			);
		}
		if (file === "gh" && args.at(0) === "pr") {
			return Promise.resolve("");
		}
		if (file === "claude") {
			return Promise.resolve(options.fixed ?? "```\nnew\n```");
		}
		if (file === "git" && args.at(0) === "rev-parse") {
			return Promise.resolve("abc123");
		}
		if (file === "git") {
			return Promise.resolve("");
		}
		if (file === "gh" && args.at(0) === "--version") {
			return Promise.resolve("");
		}
		if (file === "gh" && args.at(0) === "auth") {
			return Promise.resolve("");
		}
		return Promise.resolve("");
	}) as unknown as Runner;

const countCalls = (
	runner: Runner,
	file: string,
	argMatcher: (args: string[]) => boolean,
): number =>
	(runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.filter(
		([calledFile, args]) => calledFile === file && argMatcher(args),
	).length;

describe("run", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("logs a greeting with the provided arguments", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(vi.fn());
		await run(["--pick", "up"]);
		expect(log).toHaveBeenCalledWith("Hello from pickup!", ["--pick", "up"]);
		log.mockRestore();
	});

	it("falls back to process.argv when no arguments are given", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(vi.fn());
		await run();
		expect(log).toHaveBeenCalledWith("Hello from pickup!", expect.any(Array));
		log.mockRestore();
	});

	it("exits with an error when watch is missing a PR URL", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		await run(["watch"]);
		expect(process.exitCode).toBe(1);
		process.exitCode = previousExitCode;
	});

	it("runs the CLI entry point", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(vi.fn());
		await import("./bin.js");
		expect(log).toHaveBeenCalledWith("Hello from pickup!", expect.any(Array));
		log.mockRestore();
	});

	it("handles watch command with flags", async () => {
		const runner = makeExplainRunner({ claude: "It does something." });
		await run(["watch", PR_URL, "--interval", "5", "--user", "alice"], { iterations: 1, runner });
		expect(countCalls(runner, "claude", (args) => args.at(0) === "-p")).toBe(1);
	});

	it("uses default interval when the flag has no value", async () => {
		const runner = makeExplainRunner();
		await run(["watch", PR_URL, "--interval"], { iterations: 1, runner });
		expect(runner).toHaveBeenCalled();
	});

	it("uses default watch options", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("fail"))) as unknown as Runner;
		await expect(run.watch(PR_URL, { runner })).rejects.toThrow("fail");
	});

	it("uses the default runner when none is provided", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		await expect(run(["watch", PR_URL], { iterations: 0 })).resolves.toBeUndefined();
		process.exitCode = previousExitCode;
	});
});

describe("parsePrUrl", () => {
	it("parses a GitHub PR URL", () => {
		expect(run.parsePrUrl(PR_URL)).toEqual({
			host: "github.com",
			number: "123",
			owner: "owner",
			repo: "repo",
		});
	});

	it("throws for a non-pull URL", () => {
		expect(() => run.parsePrUrl("https://github.com/owner/repo/issues/123")).toThrow(TypeError);
	});

	it("throws when the path is too short", () => {
		expect(() => run.parsePrUrl("https://github.com/owner/repo/pull/")).toThrow(TypeError);
	});

	it("throws when the path is too long", () => {
		expect(() => run.parsePrUrl("https://github.com/owner/repo/pull/123/extra")).toThrow(TypeError);
	});
});

describe("exec", () => {
	it("runs a command and returns trimmed stdout", async () => {
		const out = await run.exec("node", ["-e", "console.log('hi')"]);
		expect(out).toBe("hi");
	});

	it("throws when a command fails", async () => {
		await expect(run.exec("node", ["-e", "process.exit(1)"])).rejects.toThrow();
	});
});

describe("findFlag", () => {
	it("returns the value of a flag", () => {
		expect(run.findFlag(["--fix", "--user", "alice"], "--user")).toBe("alice");
	});

	it("returns undefined when the flag is missing", () => {
		expect(run.findFlag(["--fix"], "--user")).toBeUndefined();
	});

	it("returns undefined when the flag has no value", () => {
		expect(run.findFlag(["--fix", "--user"], "--user")).toBeUndefined();
	});
});

describe("state", () => {
	let tempDir = "";
	const statePath = (): string => path.join(tempDir, "state.json");

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("loads an empty state when the file is missing", async () => {
		const state = await run.loadState(statePath());
		expect(state.size).toBe(0);
	});

	it("loads a saved state", async () => {
		const state = new Map<string, number[]>([[PR_URL, [1, 2]]]);
		await run.saveState(state, statePath());
		const loaded = await run.loadState(statePath());
		expect(loaded.get(PR_URL)).toEqual([1, 2]);
	});

	it("ignores malformed values", async () => {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
		await writeFile(statePath(), JSON.stringify({ [PR_URL]: [1, "two", 3] }));
		const loaded = await run.loadState(statePath());
		expect(loaded.get(PR_URL)).toBeUndefined();
	});

	it("warns when the state path is a directory", async () => {
		const dir = path.join(tempDir, "isdir");
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
		await mkdir(dir, { recursive: true });
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const state = await run.loadState(dir);
		expect(state.size).toBe(0);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("falls back to the home directory when XDG_CONFIG_HOME is empty", async () => {
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("HOME", tempDir);
		const state = await run.loadState();
		expect(state).toBeDefined();
	});
});

describe("findNewMention", () => {
	it("returns the newest unseen mention", () => {
		const comments = [
			{ body: "@pickup hello", id: 1 },
			{ body: "@pickup fix", id: 2 },
		];
		const mention = run.findNewMention(comments, []);
		expect(mention).toBeDefined();
		if (mention) {
			expect(mention.id).toBe(2);
		}
	});

	it("ignores already seen mentions", () => {
		expect(run.findNewMention([{ body: "@pickup hello", id: 1 }], [1])).toBeUndefined();
	});

	it("ignores comments without @pickup", () => {
		expect(run.findNewMention([{ body: "hello", id: 1 }], [])).toBeUndefined();
	});

	it("ignores comments with non-numeric ids", () => {
		expect(run.findNewMention([{ body: "@pickup hello", id: "1" }], [])).toBeUndefined();
	});

	it("ignores comments without a body", () => {
		expect(run.findNewMention([{ id: 1 }], [])).toBeUndefined();
	});
});

describe("stripFences", () => {
	it("returns the content unchanged when no fences are present", () => {
		expect(run.stripFences("plain text")).toBe("plain text");
	});

	it("strips a fenced code block", () => {
		expect(run.stripFences("```\ncode\n```")).toBe("code");
	});

	it("returns the content when the fences are on one line", () => {
		expect(run.stripFences("```\n```")).toBe("```\n```");
	});
});

describe("watch", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("polls once and replies to a mention", async () => {
		const runner = makeExplainRunner({ claude: "It does something." });
		await run.watch(PR_URL, { interval: 0, iterations: 1, runner });
		expect(countCalls(runner, "claude", (args) => args.at(0) === "-p")).toBe(1);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(1);
	});

	it("skips mentions from other users", async () => {
		const runner = makeExplainRunner({ claude: "It does something." });
		await run.watch(PR_URL, { allowedUser: "bob", interval: 0, iterations: 1, runner });
		expect(countCalls(runner, "claude", (args) => args.at(0) === "-p")).toBe(0);
	});

	it("sleeps between iterations", async () => {
		const runner = makeExplainRunner({ claude: "It does something." });
		await run.watch(PR_URL, { interval: 0, iterations: 2, runner });
		expect(
			countCalls(runner, "gh", (args) => args.at(0) === "api" && startsWithRepos(args.at(1))),
		).toBe(2);
	});

	it("warns when claude returns an empty explanation", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ claude: "" });
		await run.watch(PR_URL, { interval: 0, iterations: 1, runner });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("handles comments without a user object", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args.at(0) === "api" && startsWithRepos(args.at(1))) {
				return Promise.resolve(
					JSON.stringify([{ body: "@pickup hello", id: 1, line: 1, path: "src/index.ts" }]),
				);
			}
			if (file === "gh" && args.at(0) === "--version") {
				return Promise.resolve("");
			}
			if (file === "gh" && args.at(0) === "auth") {
				return Promise.resolve("");
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: 0, iterations: 1, runner });
		expect(countCalls(runner, "claude", (args) => args.at(0) === "-p")).toBe(1);
	});

	it("handles comments with an invalid login", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args.at(0) === "api" && startsWithRepos(args.at(1))) {
				return Promise.resolve(
					JSON.stringify([
						{ body: "@pickup hello", id: 1, line: 1, path: "src/index.ts", user: { login: 123 } },
					]),
				);
			}
			if (file === "gh" && args.at(0) === "--version") {
				return Promise.resolve("");
			}
			if (file === "gh" && args.at(0) === "auth") {
				return Promise.resolve("");
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: 0, iterations: 1, runner });
		expect(countCalls(runner, "claude", (args) => args.at(0) === "-p")).toBe(1);
	});

	it("handles comments with a null user", async () => {
		const nullUser = JSON.parse('{"user":null}');
		const base = { body: "@pickup hello", id: 1, line: 1, path: "src/index.ts" };
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args.at(0) === "api" && startsWithRepos(args.at(1))) {
				return Promise.resolve(JSON.stringify([Object.assign(base, nullUser)]));
			}
			if (file === "gh" && args.at(0) === "--version") {
				return Promise.resolve("");
			}
			if (file === "gh" && args.at(0) === "auth") {
				return Promise.resolve("");
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: 0, iterations: 1, runner });
		expect(countCalls(runner, "claude", (args) => args.at(0) === "-p")).toBe(1);
	});

	it("can fix a file when requested", async () => {
		const targetPath = path.join(tempDir, "src", "index.ts");
		const targetDir = path.dirname(targetPath);
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
		await mkdir(targetDir, { recursive: true });
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
		await writeFile(targetPath, "old");

		const runner = makeFixRunner(targetPath);
		await run.watch(PR_URL, { allowFix: true, interval: 0, iterations: 1, runner });

		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
		const content = await readFile(targetPath, "utf8");
		expect(content).toBe("new");
	});

	it("reports when the file to fix is missing", async () => {
		const runner = makeFixRunner("/missing/path.ts");
		await run.watch(PR_URL, { allowFix: true, interval: 0, iterations: 1, runner });
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(1);
	});

	it("reports when claude returns an empty fix", async () => {
		const targetPath = path.join(tempDir, "src", "index.ts");
		const targetDir = path.dirname(targetPath);
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
		await mkdir(targetDir, { recursive: true });
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
		await writeFile(targetPath, "old");

		const runner = makeFixRunner(targetPath, { fixed: "```\n\n```" });
		await run.watch(PR_URL, { allowFix: true, interval: 0, iterations: 1, runner });
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(1);
	});

	it("throws when the file cannot be read", async () => {
		const runner = makeFixRunner(tempDir);
		await expect(
			run.watch(PR_URL, { allowFix: true, interval: 0, iterations: 1, runner }),
		).rejects.toThrow();
	});

	it("reports when the fix cannot be committed", async () => {
		const targetPath = path.join(tempDir, "src", "index.ts");
		const targetDir = path.dirname(targetPath);
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
		await mkdir(targetDir, { recursive: true });
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
		await writeFile(targetPath, "old");

		const runner = makeFixRunner(targetPath, { failOn: "git push", fixed: "```\nnew\n```" });
		await expect(
			run.watch(PR_URL, { allowFix: true, interval: 0, iterations: 1, runner }),
		).rejects.toThrow("git push failed");
	});
});
