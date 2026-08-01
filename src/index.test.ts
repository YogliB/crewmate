import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import run from "./index.js";
import { PICKUP_PREFIX } from "./fix.js";
import { tmpdir } from "node:os";

type Runner = (file: string, args: string[]) => Promise<string>;

const startsWithRepos = (value: string | undefined): boolean =>
	typeof value === "string" && value.startsWith("repos/");

const PR_URL = "https://github.com/owner/repo/pull/123";
const FIRST_INDEX = 0;
const SECOND_INDEX = 1;
const FIRST_ID = 1;
const SECOND_ID = 2;
const THIRD_ID = 3;
const FIRST_LINE = 1;
const EXPLANATION_LINE = 5;
const INVALID_LOGIN = 123;
const NO_ITERATIONS = 0;
const FIRST_ITERATION = 1;
const TWO_ITERATIONS = 2;
const NO_INTERVAL = 0;
const NO_CALLS = 0;
const FIRST_CALL = 1;
const TWO_CALLS = 2;
const NO_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const ORIGINAL_CWD = process.cwd();

const countCalls = (
	runner: Runner,
	file: string,
	argMatcher: (args: string[]) => boolean,
): number =>
	(runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.filter(
		([calledFile, args]) => calledFile === file && argMatcher(args),
	).length;

const resolveGhExplain = (
	args: string[],
	request: { body?: string; path?: string } = {},
): Promise<string> => {
	const [command] = args;
	if (command === "api" && args.some((arg) => startsWithRepos(arg))) {
		return Promise.resolve(
			JSON.stringify([
				[
					{
						body: request.body ?? "@pickup hello",
						id: FIRST_ID,
						in_reply_to_id: null,
						line: EXPLANATION_LINE,
						path: request.path ?? "src/index.ts",
						user: { login: "alice" },
					},
				],
			]),
		);
	}
	return Promise.resolve("");
};

const resolveGit = (args: string[]): Promise<string> => {
	const [command, subcommand] = args;
	if (command === "rev-parse" && subcommand === "--show-toplevel") {
		return Promise.resolve(process.cwd());
	}
	if (command === "rev-parse" && subcommand === "--short") {
		return Promise.resolve("abc123");
	}
	return Promise.resolve("");
};

const resolveExplain = (
	file: string,
	args: string[],
	request: { body?: string; claude?: string; path?: string } = {},
): Promise<string> => {
	if (file === "claude") {
		return Promise.resolve(request.claude ?? "");
	}
	if (file === "git") {
		return resolveGit(args);
	}
	if (file === "gh") {
		return resolveGhExplain(args, request);
	}
	return Promise.resolve("");
};

const makeExplainRunner = (
	request: { body?: string; claude?: string; path?: string } = {},
): Runner =>
	vi.fn((file: string, args: string[]) => resolveExplain(file, args, request)) as unknown as Runner;
const makeMultiMentionRunner = (options: { failOn?: string } = {}): Runner =>
	vi.fn((file: string, args: string[]) => {
		if (options.failOn && willFail(file, args, options.failOn)) {
			return Promise.reject(new Error(`${options.failOn} failed`));
		}
		const [command] = args;
		if (file === "claude") {
			return Promise.resolve("It does something.");
		}
		if (file === "git") {
			return resolveGit(args);
		}
		if (file === "gh") {
			if (command === "pr") {
				return Promise.resolve("");
			}
			if (command === "--version" || command === "auth") {
				return Promise.resolve("");
			}
			if (command === "api" && args.some((arg) => startsWithRepos(arg))) {
				if (args.includes("POST")) {
					return Promise.resolve("");
				}
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@pickup hello",
								id: FIRST_ID,
								in_reply_to_id: null,
								line: EXPLANATION_LINE,
								path: "src/index.ts",
								user: { login: "alice" },
							},
							{
								body: "@pickup hi",
								id: SECOND_ID,
								in_reply_to_id: null,
								line: EXPLANATION_LINE,
								path: "src/index.ts",
								user: { login: "alice" },
							},
						],
					]),
				);
			}
		}
		return Promise.resolve("");
	}) as unknown as Runner;

const resolveGhFix = (
	args: string[],
	request: { body?: string; targetPath: string },
): Promise<string> => {
	const [command] = args;
	if (command === "api" && args.some((arg) => startsWithRepos(arg))) {
		return Promise.resolve(
			JSON.stringify([
				[
					{
						body: request.body ?? "@pickup #fix",
						id: FIRST_ID,
						in_reply_to_id: null,
						line: FIRST_LINE,
						path: request.targetPath,
						user: { login: "alice" },
					},
				],
			]),
		);
	}
	if (command === "pr") {
		return Promise.resolve("");
	}
	return Promise.resolve("");
};

const willFail = (file: string, args: string[], failOn: string | undefined): boolean => {
	if (!failOn) {
		return false;
	}
	const [command, ...rest] = failOn.split(" ");
	return file === command && JSON.stringify(args).includes(rest.join(" "));
};

const resolveFix = (
	file: string,
	args: string[],
	request: { body?: string; failOn?: string; fixed?: string; targetPath: string },
): Promise<string> => {
	if (willFail(file, args, request.failOn)) {
		return Promise.reject(new Error(`${request.failOn} failed`));
	}
	if (file === "gh") {
		return resolveGhFix(args, request);
	}
	if (file === "claude") {
		return Promise.resolve(request.fixed ?? "```\nnew\n```");
	}
	if (file === "git") {
		return resolveGit(args);
	}
	return Promise.resolve("");
};

const makeFixRunner = (
	targetPath: string,
	options: { body?: string; failOn?: string; fixed?: string } = {},
): Runner =>
	vi.fn((file: string, args: string[]) =>
		resolveFix(file, args, { targetPath, ...options }),
	) as unknown as Runner;

describe("run default", () => {
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

	it("runs the CLI entry point", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(vi.fn());
		await import("./bin.js");
		expect(log).toHaveBeenCalledWith("Hello from pickup!", expect.any(Array));
		log.mockRestore();
	});
});

describe("run watch missing", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("exits with an error when watch is missing a PR URL", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await run(["watch"]);
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		process.exitCode = previousExitCode;
	});

	it("exits with an error when watch has an empty PR URL", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await run(["watch", ""]);
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		process.exitCode = previousExitCode;
	});
});

describe("run watch flags", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("handles watch command with flags", async () => {
		const runner = makeExplainRunner({ claude: "It does something." });
		await run(["watch", PR_URL, "--interval", "5", "--user", "alice"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});

	it("uses default interval when the flag has no value", async () => {
		const runner = makeExplainRunner();
		await run(["watch", PR_URL, "--interval"], { iterations: FIRST_ITERATION, runner });
		expect(run.parseInterval(["--interval"])).toBe(60);
	});

	it("uses default watch options", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("fail"))) as unknown as Runner;
		await expect(run.watch(PR_URL, { runner })).rejects.toThrow("fail");
	});

	it("uses the default runner when none is provided", async () => {
		// test the run watch path without a provided runner
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await expect(run(["watch", PR_URL], { iterations: NO_ITERATIONS })).resolves.toBeUndefined();
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

	it("parses a PR shorthand", () => {
		expect(run.parsePrUrl("owner/repo/pull/123")).toEqual({
			host: "github.com",
			number: "123",
			owner: "owner",
			repo: "repo",
		});
	});

	it("parses an uppercase HTTPS URL", () => {
		expect(run.parsePrUrl("HTTPS://github.com/owner/repo/pull/123")).toEqual({
			host: "github.com",
			number: "123",
			owner: "owner",
			repo: "repo",
		});
	});

	it("parses a shorthand whose owner starts with 'http'", () => {
		expect(run.parsePrUrl("httpie/cli/pull/123")).toEqual({
			host: "github.com",
			number: "123",
			owner: "httpie",
			repo: "cli",
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

	it("throws for an invalid shorthand", () => {
		expect(() => run.parsePrUrl("owner/repo/123")).toThrow(TypeError);
	});

	it("throws for a shorthand with unsafe owner characters", () => {
		expect(() => run.parsePrUrl("../repo/pull/123")).toThrow(TypeError);
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

	it("returns undefined when the flag value is another flag", () => {
		expect(run.findFlag(["--user", "--fix"], "--user")).toBeUndefined();
	});
});

describe("parseInterval", () => {
	it("parses a valid interval", () => {
		expect(run.parseInterval(["--interval", "5"])).toBe(5);
	});

	it("defaults when the flag is missing", () => {
		expect(run.parseInterval([])).toBe(60);
	});

	it("defaults when the flag value is invalid", () => {
		expect(run.parseInterval(["--interval", "bad"])).toBe(60);
	});

	it("defaults when the flag value is not positive", () => {
		expect(run.parseInterval(["--interval", "0"])).toBe(60);
	});

	it("truncates a float interval", () => {
		expect(run.parseInterval(["--interval", "5.5"])).toBe(5);
	});
});

describe("state load", () => {
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
		expect(state.size).toBe(NO_CALLS);
	});

	it("loads a saved state", async () => {
		const state = new Map<string, number[]>([[PR_URL, [FIRST_ID, SECOND_ID]]]);
		await run.saveState(state, statePath());
		const loaded = await run.loadState(statePath());
		expect(loaded.get(PR_URL)).toEqual([FIRST_ID, SECOND_ID]);
	});

	it("ignores malformed values", async () => {
		await writeFile(statePath(), JSON.stringify({ [PR_URL]: [FIRST_ID, "two", THIRD_ID] }));
		const loaded = await run.loadState(statePath());
		expect(loaded.get(PR_URL)).toBeUndefined();
	});

	it("resets when the state file is not an object", async () => {
		await writeFile(statePath(), JSON.stringify([PR_URL]));
		const loaded = await run.loadState(statePath());
		expect(loaded.size).toBe(NO_CALLS);
	});
});

describe("state errors", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("throws when the state path is not a readable file", async () => {
		const dir = path.join(tempDir, "isdir");
		await mkdir(dir, { recursive: true });
		await expect(run.loadState(dir)).rejects.toThrow();
	});

	it("falls back to the home directory when XDG_CONFIG_HOME is empty", async () => {
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("HOME", tempDir);
		const state = await run.loadState();
		expect(state).toBeDefined();
		expect(run.statePath()).toBe(path.join(tempDir, ".config", "pickup", "state.json"));
	});

	it("warns and resets when the state file is corrupted", async () => {
		const stateFile = path.join(tempDir, "state.json");
		await writeFile(stateFile, "not json");
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const state = await run.loadState(stateFile);
		expect(state.size).toBe(NO_CALLS);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe("findNewMention", () => {
	it("returns the newest unseen mention", () => {
		const comments = [
			{ body: "@pickup hello", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" },
			{ body: "@pickup fix", id: SECOND_ID, line: FIRST_LINE, path: "src/index.ts" },
		];
		const mention = run.findNewMention(comments, []);
		expect(mention).toBeDefined();
		if (mention) {
			expect(mention.id).toBe(SECOND_ID);
		}
	});

	it("ignores already seen mentions", () => {
		expect(
			run.findNewMention(
				[
					{
						body: "@pickup hello",
						id: FIRST_ID,
						in_reply_to_id: null,
						line: FIRST_LINE,
						path: "src/index.ts",
					},
				],
				[FIRST_ID],
			),
		).toBeUndefined();
	});

	it("ignores comments without @pickup", () => {
		expect(
			run.findNewMention(
				[{ body: "hello", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" }],
				[],
			),
		).toBeUndefined();
	});

	it("ignores comments with non-numeric ids", () => {
		expect(
			run.findNewMention(
				[{ body: "@pickup hello", id: "1", line: FIRST_LINE, path: "src/index.ts" }],
				[],
			),
		).toBeUndefined();
	});

	it("ignores comments without a body", () => {
		expect(run.findNewMention([{ id: FIRST_ID }], [])).toBeUndefined();
	});

	it("returns the newest mention when comments are out of order", () => {
		const comments = [
			{ body: "@pickup hello", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" },
			{ body: "@pickup fix", id: THIRD_ID, line: FIRST_LINE, path: "src/index.ts" },
			{ body: "@pickup hi", id: SECOND_ID, line: FIRST_LINE, path: "src/index.ts" },
		];
		const mention = run.findNewMention(comments, []);
		expect(mention).toBeDefined();
		if (mention) {
			expect(mention.id).toBe(THIRD_ID);
		}
	});

	it("ignores comments without a path or line", () => {
		expect(run.findNewMention([{ body: "@pickup hello", id: FIRST_ID }], [])).toBeUndefined();
	});

	it("ignores @pickup as a substring", () => {
		expect(
			run.findNewMention(
				[{ body: "foo@pickup hello", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" }],
				[],
			),
		).toBeUndefined();
	});

	it("matches @pickup inside parentheses", () => {
		const mention = run.findNewMention(
			[{ body: "(@pickup)", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" }],
			[],
		);
		expect(mention).toBeDefined();
		expect(mention?.id).toBe(FIRST_ID);
	});

	it("ignores reply comments", () => {
		expect(
			run.findNewMention(
				[
					{
						body: "@pickup hello",
						id: FIRST_ID,
						in_reply_to_id: SECOND_ID,
						line: FIRST_LINE,
						path: "src/index.ts",
					},
				],
				[],
			),
		).toBeUndefined();
	});

	it("matches top-level comments that have in_reply_to_id: null", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@pickup hello",
					id: FIRST_ID,
					in_reply_to_id: null,
					line: FIRST_LINE,
					path: "src/index.ts",
				},
			],
			[],
		);
		expect(mention).toBeDefined();
		expect(mention?.id).toBe(FIRST_ID);
	});

	it("skips a fresh install mention that already has a pickup reply", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@pickup hello",
					id: FIRST_ID,
					in_reply_to_id: null,
					line: FIRST_LINE,
					path: "src/index.ts",
				},
				{
					body: `${PICKUP_PREFIX} done`,
					id: SECOND_ID,
					in_reply_to_id: FIRST_ID,
					line: FIRST_LINE,
					path: "src/index.ts",
				},
			],
			[],
			undefined,
			true,
		);
		expect(mention).toBeUndefined();
	});

	it("does not skip a fresh install mention with a non-pickup reply", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@pickup hello",
					id: FIRST_ID,
					in_reply_to_id: null,
					line: FIRST_LINE,
					path: "src/index.ts",
				},
				{
					body: "thanks",
					id: SECOND_ID,
					in_reply_to_id: FIRST_ID,
					line: FIRST_LINE,
					path: "src/index.ts",
				},
			],
			[],
			undefined,
			true,
		);
		expect(mention).toBeDefined();
		expect(mention?.id).toBe(FIRST_ID);
	});

	it("does not use the pickup reply fallback when not fresh", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@pickup hello",
					id: FIRST_ID,
					in_reply_to_id: null,
					line: FIRST_LINE,
					path: "src/index.ts",
				},
				{
					body: `${PICKUP_PREFIX} done`,
					id: SECOND_ID,
					in_reply_to_id: FIRST_ID,
					line: FIRST_LINE,
					path: "src/index.ts",
				},
			],
			[],
			undefined,
			false,
		);
		expect(mention).toBeDefined();
		expect(mention?.id).toBe(FIRST_ID);
	});
});

describe("findNewMentions", () => {
	it("returns all new mentions sorted by id descending", () => {
		const comments = [
			{ body: "@pickup hello", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" },
			{ body: "@pickup fix", id: SECOND_ID, line: FIRST_LINE, path: "src/index.ts" },
		];
		const mentions = run.findNewMentions(comments, []);
		expect(mentions).toHaveLength(TWO_CALLS);
		expect(mentions[0].id).toBe(SECOND_ID);
		expect(mentions[1].id).toBe(FIRST_ID);
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

describe("watch explain", () => {
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
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual([FIRST_ID]);
	});

	it("skips mentions from other users", async () => {
		const runner = makeExplainRunner({ claude: "It does something." });
		await run.watch(PR_URL, {
			allowedUser: "bob",
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toBeUndefined();
	});

	it("warns when claude returns an empty explanation", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ claude: "" });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("reports when the file to explain is missing", async () => {
		const runner = makeExplainRunner({ path: "missing.ts" });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});
	it("polls once and replies to all new mentions", async () => {
		const runner = makeMultiMentionRunner();
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(TWO_CALLS);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual([SECOND_ID, FIRST_ID]);
	});
	it("saves state for the handled mentions when one fails", async () => {
		const runner = makeMultiMentionRunner({ failOn: "claude @pickup hello" });
		await expect(
			run.watch(PR_URL, {
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				runner,
			}),
		).rejects.toThrow();
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual([SECOND_ID, FIRST_ID]);
	});
});

describe("getLogin", () => {
	it("returns the login for a valid user", () => {
		expect(run.getLogin({ login: "alice" })).toBe("alice");
	});

	it("returns empty for a missing user", () => {
		expect(run.getLogin(undefined)).toBe("");
	});

	it("returns empty for a null user", () => {
		expect(run.getLogin(null)).toBe("");
	});

	it("returns empty for an invalid login", () => {
		expect(run.getLogin({ login: INVALID_LOGIN })).toBe("");
	});
});

describe("watch users missing", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("handles comments without a user object", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			if (file === "gh" && command === "api" && args.some((arg) => startsWithRepos(arg))) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@pickup hello",
								id: FIRST_ID,
								in_reply_to_id: null,
								line: FIRST_LINE,
								path: "src/index.ts",
							},
						],
					]),
				);
			}
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});
});

describe("watch users invalid", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("handles comments with an invalid login", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			if (file === "gh" && command === "api" && args.some((arg) => startsWithRepos(arg))) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@pickup hello",
								id: FIRST_ID,
								line: FIRST_LINE,
								path: "src/index.ts",
								user: { login: INVALID_LOGIN },
							},
						],
					]),
				);
			}
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});
});

describe("watch users null", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("handles comments with a null user", async () => {
		const nullUser = JSON.parse('{"user":null}');
		const base = { body: "@pickup hello", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" };
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			if (file === "gh" && command === "api" && args.some((arg) => startsWithRepos(arg))) {
				return Promise.resolve(JSON.stringify([[Object.assign(base, nullUser)]]));
			}
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});
});

describe("watch iterations", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
	});

	it("sleeps between iterations", async () => {
		const runner = makeExplainRunner({ claude: "It does something." });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: TWO_ITERATIONS, runner });
		expect(
			countCalls(
				runner,
				"gh",
				(args) =>
					args.at(FIRST_INDEX) === "api" &&
					!args.includes("--method") &&
					args.some((arg) => startsWithRepos(arg)),
			),
		).toBe(TWO_CALLS);
	});

	it("does not reprocess a mention in the second iteration", async () => {
		const runner = makeExplainRunner({ claude: "It does something." });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: TWO_ITERATIONS, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});

	it("skips a fresh install mention that already has a pickup reply", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			if (file === "gh" && command === "api" && args.some((arg) => startsWithRepos(arg))) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@pickup hello",
								id: FIRST_ID,
								in_reply_to_id: null,
								line: FIRST_LINE,
								path: "src/index.ts",
								user: { login: "alice" },
							},
							{
								body: `${PICKUP_PREFIX} done`,
								id: SECOND_ID,
								in_reply_to_id: FIRST_ID,
								line: FIRST_LINE,
								path: "src/index.ts",
								user: { login: "pickup" },
							},
						],
					]),
				);
			}
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
	});
});

describe("watch fix success", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(ORIGINAL_CWD);
		await rm(tempDir, { force: true, recursive: true });
	});

	it("can fix a file when requested", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath);
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		const content = await readFile(path.resolve(targetPath), "utf8");
		expect(content).toBe("new");
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(FIRST_CALL);
	});

	it("explains instead of fixing when the comment body does not contain the #fix tag", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, { body: "@pickup fix", fixed: "new" });
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "add")).toBe(NO_CALLS);
	});

	it("skips the fix when the generated content is unchanged", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, { fixed: "old" });
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "add")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});
});

describe("watch fix missing", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(ORIGINAL_CWD);
		await rm(tempDir, { force: true, recursive: true });
	});

	it("reports when the file to fix is missing", async () => {
		const runner = makeFixRunner("missing.ts");
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});
});

describe("watch fix empty", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(ORIGINAL_CWD);
		await rm(tempDir, { force: true, recursive: true });
	});

	it("reports when claude returns an empty fix", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, { fixed: "```\n\n```" });
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});
});

describe("watch fix errors", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(ORIGINAL_CWD);
		await rm(tempDir, { force: true, recursive: true });
	});

	it("rejects paths outside the repository", async () => {
		const runner = makeFixRunner("/etc/passwd");
		await expect(
			run.watch(PR_URL, {
				allowFix: true,
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				runner,
			}),
		).rejects.toThrow("Invalid target path");
	});

	it("throws when the file cannot be read", async () => {
		await mkdir("src", { recursive: true });
		const runner = makeFixRunner("src");
		await expect(
			run.watch(PR_URL, {
				allowFix: true,
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				runner,
			}),
		).rejects.toThrow();
	});

	it("rejects paths that form a symlink loop", async () => {
		await symlink("loop", "loop");
		const runner = makeFixRunner("loop/file");
		await expect(
			run.watch(PR_URL, {
				allowFix: true,
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				runner,
			}),
		).rejects.toThrow("Invalid target path");
	});

	it("rejects paths that resolve outside the repository through a symlink", async () => {
		await symlink("/etc", "link");
		const runner = makeFixRunner("link/nonexistent");
		await expect(
			run.watch(PR_URL, {
				allowFix: true,
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				runner,
			}),
		).rejects.toThrow("Invalid target path");
	});

	it("rejects a final path component that is a symlink outside the repository", async () => {
		await symlink("/etc/passwd", "link");
		const runner = makeFixRunner("link");
		await expect(
			run.watch(PR_URL, {
				allowFix: true,
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				runner,
			}),
		).rejects.toThrow("Invalid target path");
	});

	it("reports when the target file is missing", async () => {
		const runner = makeFixRunner("missing/file.ts");
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});

	it("reports when the target file is missing in an existing directory", async () => {
		await mkdir("src", { recursive: true });
		const runner = makeFixRunner("src/missing.ts");
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});

	it("reports when the fix cannot be pushed", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, { failOn: "git push", fixed: "```\nnew\n```" });
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});

	it("reports when the fix cannot be committed", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, { failOn: "git commit", fixed: "```\nnew\n```" });
		await expect(
			run.watch(PR_URL, {
				allowFix: true,
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				runner,
			}),
		).rejects.toThrow();
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});
});

describe("run help", () => {
	it("prints help when --help is requested", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["--help"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Usage"));
		write.mockRestore();
	});

	it("prints help when -h is requested", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["-h"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Usage"));
		write.mockRestore();
	});
});
