import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import run from "./index.js";
import { PICKUP_PREFIX, applyFix } from "./fix.js";
import { createLogger, type Logger } from "./log.js";
import { homedir, tmpdir } from "node:os";
import type { Mention } from "./index.js";
import * as config from "./config.js";

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

const warnFn = (logger: Logger) => async (message: string, fields?: Record<string, unknown>) => {
	await logger("warning", { ...fields, message });
};

const getPrompt = (runner: Runner, provider = "claude"): string | undefined => {
	const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
		([file, args]) => file === provider && args.includes("-p"),
	);
	const index = call?.[1].indexOf("-p");
	return typeof index === "number" && index >= 0 ? call?.[1].at(index + 1) : undefined;
};

const findEndpoint = (args: string[]): string | undefined =>
	args.find((arg) => typeof arg === "string" && startsWithRepos(arg));

const conversationComments = (body?: string): string =>
	body === undefined || body === ""
		? "[]"
		: JSON.stringify([[{ body, id: THIRD_ID, user: { login: "alice" } }]]);

const resolveGhExplain = (
	args: string[],
	request: { body?: string; conversationBody?: string; path?: string } = {},
): Promise<string> => {
	const [command] = args;
	if (command === "api" && args.some((arg) => startsWithRepos(arg))) {
		if (args.includes("POST")) {
			return Promise.resolve("");
		}
		const endpoint = findEndpoint(args);
		if (endpoint?.includes("/pulls/")) {
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
		if (endpoint?.includes("/issues/")) {
			return Promise.resolve(conversationComments(request.conversationBody));
		}
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
	request: {
		answer?: string;
		body?: string;
		conversationBody?: string;
		path?: string;
		provider?: string;
	} = {},
): Promise<string> => {
	if (file === (request.provider || "claude")) {
		return Promise.resolve(request.answer ?? "");
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
	request: {
		answer?: string;
		body?: string;
		conversationBody?: string;
		path?: string;
		provider?: string;
	} = {},
): Runner =>
	vi.fn((file: string, args: string[]) => resolveExplain(file, args, request)) as unknown as Runner;

const makeMultiMentionRunner = (
	options: { conversationBody?: string; failOn?: string; provider?: string } = {},
): Runner =>
	vi.fn((file: string, args: string[]) => {
		if (options.failOn && willFail(file, args, options.failOn)) {
			return Promise.reject(new Error(`${options.failOn} failed`));
		}
		const [command] = args;
		if (file === (options.provider || "claude")) {
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
				const endpoint = findEndpoint(args);
				if (endpoint?.includes("/pulls/")) {
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
				if (endpoint?.includes("/issues/")) {
					return Promise.resolve(conversationComments(options.conversationBody));
				}
			}
		}
		return Promise.resolve("");
	}) as unknown as Runner;

const resolveGhFix = (
	args: string[],
	request: { body?: string; conversationBody?: string; targetPath: string } = { targetPath: "" },
): Promise<string> => {
	const [command] = args;
	if (command === "api" && args.some((arg) => startsWithRepos(arg))) {
		if (args.includes("POST")) {
			return Promise.resolve("");
		}
		const endpoint = findEndpoint(args);
		if (endpoint?.includes("/pulls/")) {
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
		if (endpoint?.includes("/issues/")) {
			return Promise.resolve(conversationComments(request.conversationBody));
		}
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
	request: {
		body?: string;
		conversationBody?: string;
		failOn?: string;
		fixed?: string;
		targetPath: string;
		provider?: string;
	},
): Promise<string> => {
	if (willFail(file, args, request.failOn)) {
		return Promise.reject(new Error(`${request.failOn} failed`));
	}
	if (file === "gh") {
		return resolveGhFix(args, request);
	}
	if (file === (request.provider || "claude")) {
		return Promise.resolve(request.fixed ?? "```\nnew\n```");
	}
	if (file === "git") {
		return resolveGit(args);
	}
	return Promise.resolve("");
};

const makeFixRunner = (
	targetPath: string,
	options: {
		body?: string;
		conversationBody?: string;
		failOn?: string;
		fixed?: string;
		provider?: string;
	} = {},
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

describe("run init", () => {
	it("dispatches to init and exits when not in a TTY", async () => {
		const previousExitCode = process.exitCode;
		const previousIsTTY = process.stdin.isTTY;
		process.exitCode = NO_EXIT_CODE;
		process.stdin.isTTY = false;
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await run(["init"]);
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(write).toHaveBeenCalledWith("init requires an interactive terminal\n");
		process.exitCode = previousExitCode;
		process.stdin.isTTY = previousIsTTY;
		write.mockRestore();
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
		vi.unstubAllEnvs();
	});

	it("exits with an error when watch is missing a PR URL", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await run(["watch"]);
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		process.exitCode = previousExitCode;
	});

	it("exits with an error when watch rejects a non-Error", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = vi.fn(() => Promise.reject("string error")) as unknown as Runner;
		await run(["watch", PR_URL], { iterations: FIRST_ITERATION, runner });

		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(write).toHaveBeenCalledWith("Error: string error\n");
		write.mockRestore();
		process.exitCode = previousExitCode;
	});

	it("exits with an error when watch has an empty PR URL", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await run(["watch", ""]);
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		process.exitCode = previousExitCode;
	});

	it("exits with an error when watch is not in a git working tree", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (
				file === "git" &&
				args[0] === "rev-parse" &&
				args.at(SECOND_INDEX) === "--show-toplevel"
			) {
				return Promise.reject(new Error("not a git repo"));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await run(["watch", PR_URL], { runner });
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(stderr).toHaveBeenCalledWith("Error: watch requires a git working tree\n");
		stderr.mockRestore();
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
		vi.unstubAllEnvs();
	});

	it("handles watch command with flags", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
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

	it("ignores an invalid CLI interval so config can apply", async () => {
		const runner = makeExplainRunner();
		await run(["watch", PR_URL, "--interval", "bad"], { iterations: FIRST_ITERATION, runner });
		expect(run.parseInterval(["--interval", "bad"], { fallback: undefined })).toBeUndefined();
	});

	it("uses default watch options", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("fail"))) as unknown as Runner;
		await expect(run.watch(PR_URL, { runner })).rejects.toThrow("fail");
	});

	it("uses Infinity iterations by default and runs the loop", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api") {
				return Promise.reject(new Error("api fail"));
			}
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth" || args[0] === "pr")) {
				return Promise.resolve("");
			}
			if (file === "claude") {
				return Promise.resolve("");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await expect(run.watch(PR_URL, { runner })).rejects.toThrow("api fail");
		expect(countCalls(runner, "gh", (args) => args[0] === "api")).toBe(TWO_CALLS);
	});

	it("uses the default runner when none is provided", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await expect(run(["watch", PR_URL], { iterations: NO_ITERATIONS })).resolves.toBeUndefined();
		process.exitCode = previousExitCode;
	});

	it("passes a custom prompt to claude", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--prompt", "BE_TERSE"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(getPrompt(runner)?.startsWith("BE_TERSE\n\n")).toBe(true);
	});

	it("uses the default prompt when --prompt is missing", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL], { iterations: FIRST_ITERATION, runner });
		expect(getPrompt(runner)?.startsWith("Review comment:")).toBe(true);
	});

	it("ignores --prompt when the value is another flag", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--prompt", "--fix"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const prompt = getPrompt(runner);
		expect(prompt?.startsWith("Review comment:")).toBe(true);
		expect(prompt?.startsWith("BE_TERSE\n\n")).toBe(false);
	});

	it("does not let an extra word after --dry-run disable dry-run", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--dry-run", "extra"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
	});

	it("does not let an extra word after --log disable stderr mirroring", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--log", "/tmp/x.log"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(write).toHaveBeenCalledWith(expect.stringContaining('"event":"poll"'));
		write.mockRestore();
	});

	it("passes a model to claude", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, {
			iterations: FIRST_ITERATION,
			model: "claude-sonnet-4-20250514",
			runner,
		});
		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "claude" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["--model", "claude-sonnet-4-20250514", "-p", expect.any(String)]);
	});

	it("passes a model via the CLI", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--model", "claude-sonnet-4-20250514"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "claude" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["--model", "claude-sonnet-4-20250514", "-p", expect.any(String)]);
	});

	it("ignores --model when the value is another flag", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--model", "--fix"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "claude" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["-p", expect.any(String)]);
	});

	it("calls claude without a model when the model option is missing", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, { iterations: FIRST_ITERATION, runner });
		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "claude" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["-p", expect.any(String)]);
	});

	it("uses a custom provider for explanation", async () => {
		const runner = makeExplainRunner({ answer: "It does something.", provider: "my-llm" });
		await run.watch(PR_URL, {
			iterations: FIRST_ITERATION,
			provider: "my-llm",
			runner,
		});
		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "my-llm" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["-p", expect.any(String)]);
	});

	it("passes a provider via the CLI", async () => {
		const runner = makeExplainRunner({ answer: "It does something.", provider: "my-llm" });
		await run(["watch", PR_URL, "--provider", "my-llm"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "my-llm" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["-p", expect.any(String)]);
	});

	it("ignores --provider when the value is another flag", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--provider", "--fix"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "claude" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["-p", expect.any(String)]);
	});

	it("calls the provider for --version during watch initialization", async () => {
		const runner = makeExplainRunner({ answer: "", provider: "my-llm" });
		await run.watch(PR_URL, { iterations: FIRST_ITERATION, provider: "my-llm", runner });
		expect(countCalls(runner, "my-llm", (args) => args.at(FIRST_INDEX) === "--version")).toBe(
			FIRST_CALL,
		);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "--version")).toBe(
			NO_CALLS,
		);
	});

	it("passes a model to a custom provider", async () => {
		const runner = makeExplainRunner({ answer: "It does something.", provider: "my-llm" });
		await run.watch(PR_URL, {
			iterations: FIRST_ITERATION,
			model: "claude-sonnet-4-20250514",
			provider: "my-llm",
			runner,
		});
		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "my-llm" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["--model", "claude-sonnet-4-20250514", "-p", expect.any(String)]);
	});

	it("warns when a custom provider returns an empty explanation", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ answer: "", provider: "my-llm" });
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			provider: "my-llm",
			runner,
		});
		expect(warn).toHaveBeenCalledWith("Warning: my-llm returned empty explanation\n");
		warn.mockRestore();
	});

	it("prints help for watch --help", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["watch", "--help"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("pickup watch"));
		write.mockRestore();
	});

	it("prints help for watch PR_URL --help", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["watch", PR_URL, "--help"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("pickup watch"));
		write.mockRestore();
	});
});

describe("run stream missing", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("exits with an error when stream is missing a PR URL", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await run(["stream"]);
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		process.exitCode = previousExitCode;
	});

	it("exits with an error when stream has an empty PR URL", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await run(["stream", ""]);
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		process.exitCode = previousExitCode;
	});
});

describe("run stream flags", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("emits one NDJSON line per new mention", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		expect(calls.some((line) => line.includes('"commentId":1'))).toBe(true);
		write.mockRestore();
	});

	it("does not invoke the provider", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
	});

	it("does not post replies or run gh pr checkout", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
	});

	it("saves state after emitting", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["review:1"]);
	});

	it("saves state for every new mention in a multi-mention poll", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeMultiMentionRunner({ conversationBody: "@pickup hi" });
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		const events = calls
			.filter((line) => line.includes('"event":"mention"'))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toHaveLength(3);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["conversation:3", "review:2", "review:1"]);
		write.mockRestore();
	});

	it("does not re-emit mentions that are already in state", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeMultiMentionRunner({ conversationBody: "@pickup hi" });
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const firstCalls = write.mock.calls.map(([line]) => line as string).length;
		expect(firstCalls).toBeGreaterThan(0);
		write.mockClear();
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const secondCalls = write.mock.calls.map(([line]) => line as string);
		expect(secondCalls.some((line) => line.includes('"event":"mention"'))).toBe(false);
		write.mockRestore();
	});

	it("respects --user", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL, "--user", "bob"], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(false);
		write.mockRestore();
	});

	it("warns on unsupported flags", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(
			[
				"stream",
				PR_URL,
				"--fix",
				"--model",
				"best",
				"--provider",
				"my-llm",
				"--prompt",
				"custom",
				"--dry-run",
				"--json",
			],
			{
				iterations: FIRST_ITERATION,
				logger,
				runner,
			},
		);
		for (const flag of ["--fix", "--model", "--provider", "--prompt", "--dry-run", "--json"]) {
			expect(logger).toHaveBeenCalledWith(
				"warning",
				expect.objectContaining({ message: "unsupported flag", flag }),
			);
		}
	});

	it("warns on unsupported flags when passed as booleans", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL, "--model", "--provider", "--prompt"], {
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		for (const flag of ["--model", "--provider", "--prompt"]) {
			expect(logger).toHaveBeenCalledWith(
				"warning",
				expect.objectContaining({ message: "unsupported flag", flag }),
			);
		}
	});

	it("passes options.iterations to stream", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL], {
			config: { interval: 0 },
			iterations: TWO_ITERATIONS,
			runner,
		});
		expect(
			countCalls(
				runner,
				"gh",
				(args) =>
					args.at(FIRST_INDEX) === "api" &&
					!args.includes("--method") &&
					args.some((arg) => startsWithRepos(arg)),
			),
		).toBe(4);
	});

	it("defaults to Infinity iterations and runs more than one", async () => {
		let apiCalls = 0;
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				apiCalls += 1;
				if (apiCalls > 2) {
					return Promise.reject(new Error("second iteration"));
				}
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
						],
					]),
				);
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(JSON.stringify([[]]));
			}
			if (file === "git") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await expect(run.stream(PR_URL, { interval: NO_INTERVAL, runner })).rejects.toThrow(
			"second iteration",
		);
		expect(apiCalls).toBeGreaterThan(2);
	});

	it("can run outside a git working tree", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const resolveProfile = vi.spyOn(config, "resolveProfile").mockResolvedValue({});
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
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
						],
					]),
				);
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(JSON.stringify([[]]));
			}
			if (
				file === "git" &&
				command === "rev-parse" &&
				args.at(SECOND_INDEX) === "--show-toplevel"
			) {
				return Promise.reject(new Error("not a git repo"));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "rev-parse")).toBe(
			FIRST_CALL,
		);
		expect(resolveProfile).toHaveBeenCalledWith("owner", "repo", undefined, expect.any(Function));
		resolveProfile.mockRestore();
		write.mockRestore();
	});

	it("prints help for stream --help", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["stream", "--help"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("pickup stream"));
		write.mockRestore();
	});

	it("prints help for stream PR_URL --help", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["stream", PR_URL, "--help"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("pickup stream"));
		write.mockRestore();
	});

	it("uses the default runner when none is provided", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await expect(run(["stream", PR_URL], { iterations: NO_ITERATIONS })).resolves.toBeUndefined();
		process.exitCode = previousExitCode;
	});

	it("treats an empty git root as outside a working tree", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
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
						],
					]),
				);
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(JSON.stringify([[]]));
			}
			if (
				file === "git" &&
				command === "rev-parse" &&
				args.at(SECOND_INDEX) === "--show-toplevel"
			) {
				return Promise.resolve("");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		write.mockRestore();
	});

	it("emits a conversation mention without path or line", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({
			answer: "It does something.",
			body: "thanks",
			conversationBody: "@pickup hello",
		});
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		const events = calls
			.filter((line) => line.includes('"event":"mention"'))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const conversation = events.find((event) => event.kind === "conversation");
		expect(conversation).toBeDefined();
		expect(conversation).not.toHaveProperty("path");
		expect(conversation).not.toHaveProperty("line");
		write.mockRestore();
	});

	it("mirrors logs to stderr with --log", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL, "--log"], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		write.mockRestore();
	});

	it("does not let an extra word after --log disable stderr mirroring", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL, "--log", "/tmp/x.log"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		write.mockRestore();
	});

	it("throws non-Error failures", async () => {
		const runner = vi.fn(() => Promise.reject("string error")) as unknown as Runner;
		const logger = vi.fn((event: string) => {
			if (event === "error") {
				return Promise.reject(new Error("logger failed"));
			}
			return Promise.resolve();
		}) as unknown as Logger;
		await expect(
			run.stream(PR_URL, {
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				logger,
				runner,
			}),
		).rejects.toThrow("string error");
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

	it("returns an empty quoted value as-is", () => {
		expect(run.findFlag(["--user", ""], "--user")).toBe("");
	});

	it("returns a value passed with --flag=value", () => {
		expect(run.findFlag(["--user=alice"], "--user")).toBe("alice");
	});

	it("ignores non-flag tokens", () => {
		expect(run.findFlag(["foo", "--user", "alice"], "--user")).toBe("alice");
	});
});

describe("parseInterval", () => {
	it("parses a valid interval", () => {
		expect(run.parseInterval(["--interval", "5"])).toBe(5);
	});

	it("parses a string value", () => {
		expect(run.parseInterval("5")).toBe(5);
	});

	it("defaults when the flag is missing", () => {
		expect(run.parseInterval([])).toBe(60);
	});

	it("defaults when the input is undefined", () => {
		expect(run.parseInterval(undefined)).toBe(60);
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

	it("returns undefined for invalid input when no fallback", () => {
		expect(run.parseInterval(["--interval", "bad"], { fallback: undefined })).toBeUndefined();
	});

	it("returns undefined for non-positive input when no fallback", () => {
		expect(run.parseInterval(["--interval", "0"], { fallback: undefined })).toBeUndefined();
	});
});

describe("state errors", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
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

	it("falls back to os.homedir() when HOME is also empty", async () => {
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("HOME", "");
		const state = await run.loadState();
		expect(state).toBeDefined();
		expect(run.statePath()).toBe(path.join(homedir(), ".config", "pickup", "state.json"));
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
		const comments: Mention[] = [
			{
				body: "@pickup hello",
				id: FIRST_ID,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
			{
				body: "@pickup fix",
				id: SECOND_ID,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
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
						inReplyToId: undefined,
						kind: "review",
						line: FIRST_LINE,
						path: "src/index.ts",
						user: { login: "alice" },
					},
				],
				["review:1"],
			),
		).toBeUndefined();
	});

	it("ignores comments without @pickup", () => {
		expect(
			run.findNewMention(
				[
					{
						body: "hello",
						id: FIRST_ID,
						kind: "review",
						line: FIRST_LINE,
						path: "src/index.ts",
						user: { login: "alice" },
					},
				],
				[],
			),
		).toBeUndefined();
	});

	it("ignores comments without a body", () => {
		expect(
			run.findNewMention(
				[
					{
						body: "",
						id: FIRST_ID,
						kind: "review",
						line: FIRST_LINE,
						path: "src/index.ts",
						user: { login: "alice" },
					},
				],
				[],
			),
		).toBeUndefined();
	});

	it("returns the newest mention when comments are out of order", () => {
		const comments: Mention[] = [
			{
				body: "@pickup hello",
				id: FIRST_ID,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
			{
				body: "@pickup fix",
				id: THIRD_ID,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
			{
				body: "@pickup hi",
				id: SECOND_ID,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
		];
		const mention = run.findNewMention(comments, []);
		expect(mention).toBeDefined();
		if (mention) {
			expect(mention.id).toBe(THIRD_ID);
		}
	});

	it("ignores @pickup as a substring", () => {
		expect(
			run.findNewMention(
				[
					{
						body: "foo@pickup hello",
						id: FIRST_ID,
						kind: "review",
						line: FIRST_LINE,
						path: "src/index.ts",
						user: { login: "alice" },
					},
				],
				[],
			),
		).toBeUndefined();
	});

	it("matches @pickup inside parentheses", () => {
		const mention = run.findNewMention(
			[
				{
					body: "(@pickup)",
					id: FIRST_ID,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "alice" },
				},
			],
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
						inReplyToId: SECOND_ID,
						kind: "review",
						line: FIRST_LINE,
						path: "src/index.ts",
						user: { login: "alice" },
					},
				],
				[],
			),
		).toBeUndefined();
	});

	it("matches top-level comments that have inReplyToId: undefined", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@pickup hello",
					id: FIRST_ID,
					inReplyToId: undefined,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "alice" },
				},
			],
			[],
		);
		expect(mention).toBeDefined();
		expect(mention?.id).toBe(FIRST_ID);
	});

	it("skips a fresh install mention that already has a pickup reply (sync)", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@pickup hello",
					id: FIRST_ID,
					inReplyToId: undefined,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "alice" },
				},
				{
					body: `${PICKUP_PREFIX} done`,
					id: SECOND_ID,
					inReplyToId: FIRST_ID,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "pickup" },
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
					inReplyToId: undefined,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "alice" },
				},
				{
					body: "thanks",
					id: SECOND_ID,
					inReplyToId: FIRST_ID,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "alice" },
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
					inReplyToId: undefined,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "alice" },
				},
				{
					body: `${PICKUP_PREFIX} done`,
					id: SECOND_ID,
					inReplyToId: FIRST_ID,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "pickup" },
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
		const comments: Mention[] = [
			{
				body: "@pickup hello",
				id: FIRST_ID,
				inReplyToId: undefined,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
			{
				body: "@pickup fix",
				id: SECOND_ID,
				inReplyToId: undefined,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
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
		vi.unstubAllEnvs();
	});

	it("polls once and replies to a mention", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["review:1"]);
	});

	it("skips mentions from other users", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
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

	it("warns when the provider returns an empty explanation", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ answer: "" });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("treats a PR as fresh even when state has other PRs", async () => {
		const otherPr = "https://github.com/other/repo/pull/1";
		await run.saveState(new Map([[otherPr, ["review:1"]]]), run.statePath());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "gh" && args.at(0) === "api") {
				if (args.some((arg) => arg.includes("/pulls/"))) {
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
				if (args.some((arg) => arg.includes("/issues/"))) {
					return Promise.resolve("[]");
				}
			}
			if (file === "git") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
	});

	it("keeps suppressed pickup replies out of the next poll", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "gh" && args.at(0) === "api") {
				const endpoint = findEndpoint(args);
				if (endpoint?.includes("/pulls/")) {
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
				if (endpoint?.includes("/issues/")) {
					return Promise.resolve(
						JSON.stringify([
							[
								{
									body: "@pickup hi",
									id: THIRD_ID,
									user: { login: "alice" },
								},
							],
						]),
					);
				}
			}
			if (file === "gh" && (args.at(0) === "--version" || args.at(0) === "auth")) {
				return Promise.resolve("");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;

		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: TWO_ITERATIONS,
			runner,
		});

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(expect.arrayContaining(["conversation:3", "review:1"]));
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
		expect(state.get(PR_URL)).toEqual(["review:2", "review:1"]);
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
		expect(state.get(PR_URL)).toEqual(["review:2", "review:1"]);
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
		vi.unstubAllEnvs();
	});

	it("handles comments without a user object", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
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
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(JSON.stringify([[]]));
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
		vi.unstubAllEnvs();
	});

	it("handles comments with an invalid login", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
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
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(JSON.stringify([[]]));
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
		vi.unstubAllEnvs();
	});

	it("handles comments with a null user", async () => {
		const nullUser = JSON.parse('{"user":null}');
		const base = { body: "@pickup hello", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" };
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(JSON.stringify([[Object.assign(base, nullUser)]]));
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(JSON.stringify([[]]));
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
		vi.unstubAllEnvs();
	});

	it("sleeps between iterations", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
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
		).toBe(4);
	});

	it("does not reprocess a mention in the second iteration", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: TWO_ITERATIONS, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});

	it("skips a fresh install mention that already has a pickup reply (async)", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
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
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(JSON.stringify([[]]));
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
		vi.unstubAllEnvs();
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

		const lines = await parseLogFile(tempDir);
		expect(lines.some((line) => line.event === "fix" && line.dryRun === false)).toBe(true);
	});

	it("continues when the short hash cannot be read", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "git" && args.at(0) === "rev-parse" && args.at(1) === "--short") {
				return Promise.reject(new Error("rev-parse failed"));
			}
			return resolveFix(file, args, { targetPath, fixed: "```\nnew\n```" });
		}) as unknown as Runner;
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
		const postCall = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([file, args]) => file === "gh" && args.includes("POST"));
		expect(JSON.stringify(postCall?.[1])).toContain("Fixed.");
		const lines = await parseLogFile(tempDir);
		const fixLine = lines.find((line) => line.event === "fix" && line.dryRun === false);
		expect(fixLine?.sha).toBeNull();
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

	it("does not treat #fixme as a fix request in review comments", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, { body: "@pickup #fixme", fixed: "new" });
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

	it("passes a custom prompt when fixing", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath);
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			prompt: "FIX_STYLE",
			runner,
		});

		expect(getPrompt(runner)?.startsWith("FIX_STYLE\n\n")).toBe(true);
	});

	it("passes a model when fixing", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath);
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			model: "claude-sonnet-4-20250514",
			runner,
		});

		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "claude" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["--model", "claude-sonnet-4-20250514", "-p", expect.any(String)]);
	});

	it("passes a model via the CLI when fixing", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath);
		await run(["watch", PR_URL, "--fix", "--model", "claude-sonnet-4-20250514"], {
			iterations: FIRST_ITERATION,
			runner,
		});

		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "claude" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["--model", "claude-sonnet-4-20250514", "-p", expect.any(String)]);
	});

	it("passes a provider when fixing", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, { provider: "my-llm" });
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			provider: "my-llm",
			runner,
		});

		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "my-llm" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["-p", expect.any(String)]);
	});

	it("passes a provider via the CLI when fixing", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, { provider: "my-llm" });
		await run(["watch", PR_URL, "--fix", "--provider", "my-llm"], {
			iterations: FIRST_ITERATION,
			runner,
		});

		const call = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.find(
			([file, args]) => file === "my-llm" && args.includes("-p"),
		);
		expect(call?.[1]).toEqual(["-p", expect.any(String)]);
	});
});

const lastDryRunWrite = (write: { mock: { calls: unknown[][] } }): string =>
	(write.mock.calls.at(-1) as [string])[0];

describe("watch dry-run", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
		process.chdir(tempDir);
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "example");
	});

	afterEach(async () => {
		process.chdir(ORIGINAL_CWD);
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("defaults dry-run to one iteration", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, { dryRun: true, interval: NO_INTERVAL, runner });

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(write).toHaveBeenCalled();
		write.mockRestore();
	});

	it("logs dry-run info without plain stderr when --log is set", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--dry-run", "--log"], { iterations: FIRST_ITERATION, runner });

		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"info"'))).toBe(true);
		expect(calls.some((line) => line.startsWith("Dry-run mode:"))).toBe(false);
		write.mockRestore();
	});

	it("explain dry-run produces human-readable preview", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, {
			dryRun: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(FIRST_CALL);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);

		const output = lastDryRunWrite(write);
		expect(output).toContain("would reply to comment");
		expect(output).toContain("It does something.");
		write.mockRestore();

		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toBeUndefined();
	});

	it("fix dry-run produces human-readable preview", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(vi.fn());
		const targetPath = path.join("src", "index.ts");
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath);
		await run.watch(PR_URL, {
			allowFix: true,
			dryRun: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "add")).toBe(NO_CALLS);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "commit")).toBe(NO_CALLS);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "push")).toBe(NO_CALLS);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(FIRST_CALL);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);

		const content = await readFile(path.resolve(targetPath), "utf8");
		expect(content).toBe("old");

		const output = lastDryRunWrite(write);
		expect(output).toContain("would write fix to");
		expect(output).toContain(targetPath);
		expect(output).toContain("new");
		write.mockRestore();
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
		vi.unstubAllEnvs();
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
		vi.unstubAllEnvs();
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
		vi.unstubAllEnvs();
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

	it("reports when the fix cannot be pushed and the short hash is missing", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "git" && args.at(0) === "rev-parse" && args.at(1) === "--short") {
				return Promise.reject("rev-parse failed");
			}
			if (file === "git" && args.at(0) === "push") {
				return Promise.reject("git push failed");
			}
			return resolveFix(file, args, { targetPath, fixed: "```\nnew\n```" });
		}) as unknown as Runner;
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

describe("conversation comments", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("replies to a conversation mention through the issues endpoint", async () => {
		const runner = makeExplainRunner({
			answer: "It does something.",
			body: "hello",
			conversationBody: "@pickup hello",
		});
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);

		const postCall = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([file, args]) => file === "gh" && args.includes("POST"));
		expect(postCall?.[1].some((arg) => /\/issues\/\d+\/comments/.test(arg))).toBe(true);
		expect(postCall?.[1].some((arg) => /\/pulls\/.*\/comments\/.*\/replies/.test(arg))).toBe(false);

		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["conversation:3"]);
	});

	it("warns and skips git commands for a conversation #fix with --fix", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeFixRunner("src/index.ts", {
			body: "hello",
			conversationBody: "@pickup #fix",
			fixed: "No problem.",
		});
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(NO_CALLS);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "add")).toBe(NO_CALLS);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "commit")).toBe(NO_CALLS);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "push")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("fix requested on conversation comment"),
		);
		warn.mockRestore();
	});

	it("does not treat #fixme as a fix request in conversation comments", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeFixRunner("src/index.ts", {
			body: "hello",
			conversationBody: "@pickup #fixme",
			fixed: "No problem.",
		});
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
		expect(warn).not.toHaveBeenCalled();
		expect(getPrompt(runner)).toMatch(/#fixme/);
		warn.mockRestore();
	});

	it("keeps #fix in conversation comments when --fix is not set", async () => {
		const runner = makeFixRunner("src/index.ts", {
			body: "hello",
			conversationBody: "@pickup #fix",
			fixed: "No problem.",
		});
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(getPrompt(runner)).toMatch(/#fix\b/);
	});

	it("processes a mixed poll of review and conversation mentions", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
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
						],
					]),
				);
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@pickup hi",
								id: SECOND_ID,
								user: { login: "alice" },
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

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(TWO_CALLS);

		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["conversation:2", "review:1"]);
	});

	it("posts review replies to the pulls comments replies endpoint", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		const postCall = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([file, args]) => file === "gh" && args.includes("POST"));
		expect(postCall?.[1].some((arg) => /\/pulls\/\d+\/comments\/\d+\/replies/.test(arg))).toBe(
			true,
		);
	});

	it("passes a custom prompt to a conversation mention", async () => {
		const runner = makeExplainRunner({
			answer: "It does something.",
			body: "",
			conversationBody: "@pickup hello",
		});
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			prompt: "CUSTOM",
			runner,
		});
		expect(getPrompt(runner)?.startsWith("CUSTOM\n\n")).toBe(true);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});

	it("warns when the provider returns an empty conversation response", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({
			answer: "",
			body: "",
			conversationBody: "@pickup hello",
		});
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(warn).toHaveBeenCalledWith("Warning: claude returned empty conversation response\n");
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
		warn.mockRestore();
	});

	it("warns when a custom provider returns an empty conversation response", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({
			answer: "",
			body: "",
			conversationBody: "@pickup hello",
			provider: "my-llm",
		});
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			provider: "my-llm",
			runner,
		});
		expect(warn).toHaveBeenCalledWith("Warning: my-llm returned empty conversation response\n");
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
		warn.mockRestore();
	});

	it("filters malformed conversation comments", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(JSON.stringify([[]]));
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(
					JSON.stringify([[[{ body: "@pickup hello", id: "3", user: { login: "alice" } }]]]),
				);
			}
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "claude" && command === "--version") {
				return Promise.resolve("");
			}
			if (file === "git" && command === "rev-parse") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;

		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toBeUndefined();
	});

	it("filters malformed review comments", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@pickup hello",
								id: FIRST_ID,
								in_reply_to_id: null,
								line: FIRST_LINE,
								path: 123,
								user: { login: "alice" },
							},
						],
					]),
				);
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(JSON.stringify([[]]));
			}
			if (file === "gh" && (command === "--version" || command === "auth")) {
				return Promise.resolve("");
			}
			if (file === "claude" && command === "--version") {
				return Promise.resolve("");
			}
			if (file === "git" && command === "rev-parse") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;

		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toBeUndefined();
	});
});

describe("run help", () => {
	it("prints help when --help is requested", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["--help"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Commands"));
		write.mockRestore();
	});

	it("prints help when -h is requested", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["-h"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Commands"));
		write.mockRestore();
	});
});

const logFilePath = (tempDir: string): string => path.join(tempDir, "pickup", "pickup.log");

const parseNdjson = (raw: string): Record<string, unknown>[] =>
	raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);

const parseLogFile = async (tempDir: string): Promise<Record<string, unknown>[]> =>
	parseNdjson(await readFile(logFilePath(tempDir), "utf8"));

describe("logs", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-logs-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("writes structured logs to file", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL], { iterations: FIRST_ITERATION, runner });

		const lines = await parseLogFile(tempDir);
		expect(lines.some((line) => line.event === "poll")).toBe(true);
		expect(lines.some((line) => line.event === "mention" && line.commentId === FIRST_ID)).toBe(
			true,
		);
		expect(lines.some((line) => line.event === "reply" && line.kind === "explain")).toBe(true);
	});

	it("mirrors logs to stderr with --log", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--log"], { iterations: FIRST_ITERATION, runner });

		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"poll"'))).toBe(true);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		expect(calls.some((line) => line.includes('"event":"reply"'))).toBe(true);
		write.mockRestore();
	});

	it("logs a warning when the provider returns an empty explanation", async () => {
		const runner = makeExplainRunner({ answer: "" });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		const lines = await parseLogFile(tempDir);
		expect(lines.some((line) => line.event === "warning" && line.reason === "empty")).toBe(true);
	});

	it("mirrors warnings to stderr with --log", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "" });
		await run(["watch", PR_URL, "--log"], { iterations: FIRST_ITERATION, runner });

		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"warning"'))).toBe(true);
		write.mockRestore();
	});

	it("logs a warning when the state file is corrupted", async () => {
		await mkdir(path.join(tempDir, "pickup"), { recursive: true });
		await writeFile(path.join(tempDir, "pickup", "state.json"), "not json");
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		const lines = await parseLogFile(tempDir);
		expect(
			lines.some((line) => line.event === "warning" && line.reason === "state-corrupted"),
		).toBe(true);
	});

	it("logs errors when the watch loop fails", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("boom"))) as unknown as Runner;
		await expect(
			run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner }),
		).rejects.toThrow("boom");

		const lines = await parseLogFile(tempDir);
		expect(
			lines.some(
				(line) => line.event === "error" && line.message === "boom" && line.errorType === "Error",
			),
		).toBe(true);
	});

	it("does not mask the original error when the error logger throws", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("boom"))) as unknown as Runner;
		const logger = vi.fn(async (event: string) => {
			if (event === "error") {
				throw new Error("logger failed");
			}
			return undefined;
		}) as unknown as Logger;
		await expect(
			run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, logger, runner }),
		).rejects.toThrow("boom");
	});

	it("logs non-Error watch failures", async () => {
		const runner = vi.fn(() => Promise.reject("string boom")) as unknown as Runner;
		await expect(
			run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner }),
		).rejects.toBe("string boom");

		const lines = await parseLogFile(tempDir);
		expect(
			lines.some(
				(line) =>
					line.event === "error" && line.message === "string boom" && line.errorType === "unknown",
			),
		).toBe(true);
	});

	it("uses the default logger with toStderr", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			toStderr: true,
			runner,
		});

		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"poll"'))).toBe(true);
		write.mockRestore();
	});

	it("uses a provided logger", async () => {
		const customFile = path.join(tempDir, "custom.log");
		const logger = createLogger({ filePath: customFile });
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});

		const raw = await readFile(customFile, "utf8");
		const lines = parseNdjson(raw);
		expect(lines.some((line) => line.event === "poll")).toBe(true);
	});

	it("logs invalid PR reference errors", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		const runner = vi.fn(() => Promise.reject(new Error("should not run"))) as unknown as Runner;

		try {
			await run(["watch", "not-a-pr"], { iterations: NO_ITERATIONS, runner });

			const lines = await parseLogFile(tempDir);
			expect(lines.some((line) => line.event === "error" && line.url === "not-a-pr")).toBe(true);
			expect(process.exitCode).toBe(ERROR_EXIT_CODE);
			expect(runner).not.toHaveBeenCalled();
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("logs failed reply attempts", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			if (file === "gh" && args.includes("POST")) {
				return Promise.reject(new Error("post failed"));
			}
			return resolveGhExplain(args);
		}) as unknown as Runner;

		await expect(
			run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner }),
		).rejects.toThrow("post failed");

		const lines = await parseLogFile(tempDir);
		expect(lines.some((line) => line.event === "reply" && line.failed === true)).toBe(true);
	});
});

describe("watch config", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-config-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
		process.chdir(tempDir);
		await mkdir(path.join(tempDir, "src"), { recursive: true });
		await writeFile(path.join(tempDir, "src", "index.ts"), "old", "utf8");
	});

	afterEach(async () => {
		process.chdir(ORIGINAL_CWD);
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("uses a config provider", async () => {
		const runner = makeMultiMentionRunner();
		await run(["watch", PR_URL], {
			config: { provider: "my-llm" },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "my-llm", (args) => args[0] === "--version")).toBe(FIRST_CALL);
		expect(countCalls(runner, "claude", (args) => args[0] === "--version")).toBe(NO_CALLS);
	});

	it("loads config from repo and global config files", async () => {
		await writeFile(
			path.join(tempDir, ".pickup.json"),
			JSON.stringify({ prompt: "repo prompt", provider: "my-llm" }),
			"utf8",
		);
		await mkdir(path.join(tempDir, "pickup"), { recursive: true });
		await writeFile(
			path.join(tempDir, "pickup", "config.json"),
			JSON.stringify({ defaults: { interval: 30 } }),
			"utf8",
		);
		const runner = makeMultiMentionRunner();
		await run(["watch", PR_URL], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(getPrompt(runner, "my-llm")).toMatch(/^repo prompt/);
	});

	it("warns on malformed repo config and keeps valid fields", async () => {
		const runner = makeMultiMentionRunner();
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		await writeFile(
			path.join(tempDir, ".pickup.json"),
			JSON.stringify({ prompt: "repo prompt", interval: "fast" }),
			"utf8",
		);
		await run(["watch", PR_URL], { iterations: FIRST_ITERATION, logger, runner });
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ message: "invalid type for interval" }),
		);
		expect(getPrompt(runner, "claude")).toMatch(/^repo prompt/);
	});

	it("uses a config prompt", async () => {
		const runner = makeMultiMentionRunner();
		await run.watch(PR_URL, {
			config: { prompt: "be terse", provider: "my-llm" },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(getPrompt(runner, "my-llm")).toMatch(/^be terse/);
	});

	it("uses a config user filter", async () => {
		const runner = makeMultiMentionRunner();
		await run.watch(PR_URL, {
			config: { user: "bob" },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
	});

	it("uses a config fix flag", async () => {
		const targetPath = path.join("src", "index.ts");
		const runner = makeFixRunner(targetPath, { provider: "my-llm" });
		await run.watch(PR_URL, {
			config: { fix: true, provider: "my-llm" },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args[0] === "pr" && args[1] === "checkout")).toBe(
			FIRST_CALL,
		);
	});

	it("lets CLI flags override config", async () => {
		const runner = makeMultiMentionRunner();
		await run(["watch", PR_URL, "--prompt", "cli prompt", "--provider", "claude"], {
			config: { prompt: "config prompt", provider: "my-llm" },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(getPrompt(runner, "claude")).toMatch(/^cli prompt/);
		expect(countCalls(runner, "my-llm", (args) => args[0] === "--version")).toBe(NO_CALLS);
	});

	it("uses a config dry-run flag", async () => {
		const runner = makeMultiMentionRunner();
		await run.watch(PR_URL, {
			config: { dryRun: true },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
	});

	it("uses a config log flag", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = makeMultiMentionRunner();
		await run.watch(PR_URL, {
			config: { log: true, provider: "my-llm" },
			iterations: FIRST_ITERATION,
			runner,
		});
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(
			calls.some(
				(line) =>
					line.includes('"event":"poll"') ||
					line.includes('"event":"mention"') ||
					line.includes('"event":"reply"'),
			),
		).toBe(true);
		write.mockRestore();
	});
});

describe("scope targets", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "pickup-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	const REPO_TARGET = "owner/repo";
	const ORG_TARGET = "org:myorg";
	const GHES_REPO_URL = "https://ghe.example.com/owner/repo";
	const SCOPE_PR_URL = "https://github.com/owner/repo/pull/1";

	it("parses a full GHES repo URL", () => {
		expect(run.parseTarget(GHES_REPO_URL)).toEqual({
			kind: "repo",
			host: "ghe.example.com",
			owner: "owner",
			repo: "repo",
		});
	});

	it("parses an org full URL", () => {
		expect(run.parseTarget("https://ghe.example.com/orgs/myorg")).toEqual({
			kind: "org",
			host: "ghe.example.com",
			org: "myorg",
		});
	});

	it("parses a repo shorthand", () => {
		expect(run.parseTarget(REPO_TARGET)).toEqual({
			kind: "repo",
			host: "github.com",
			owner: "owner",
			repo: "repo",
		});
	});

	it("parses an org shorthand", () => {
		expect(run.parseTarget(ORG_TARGET)).toEqual({
			kind: "org",
			host: "github.com",
			org: "myorg",
		});
	});

	it("parses a PR shorthand", () => {
		expect(run.parseTarget("owner/repo/pull/123")).toEqual({
			kind: "pr",
			host: "github.com",
			owner: "owner",
			repo: "repo",
			number: "123",
		});
	});

	it("throws for an invalid bare word", () => {
		expect(() => run.parseTarget("not-a-pr")).toThrow("Invalid target: not-a-pr");
	});

	it("throws for an unsupported URL", () => {
		expect(() => run.parseTarget("https://github.com/orgs/myorg/projects/1")).toThrow(
			"Invalid target: https://github.com/orgs/myorg/projects/1",
		);
	});

	it("throws for an invalid org shorthand", () => {
		expect(() => run.parseTarget("org:")).toThrow("Invalid target: org:");
		expect(() => run.parseTarget("org:my org")).toThrow("Invalid target: org:my org");
	});

	it("fetchOpenPrs searches for open PRs in a repo", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (
				file === "gh" &&
				args[0] === "api" &&
				args.some((arg) => arg.startsWith("search/issues?q="))
			) {
				return Promise.resolve(
					JSON.stringify([
						{
							items: [{ html_url: SCOPE_PR_URL }, { html_url: "not-a-url" }],
						},
					]),
				);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([SCOPE_PR_URL]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "search-invalid-url" }),
		);
	});

	it("fetchOpenPrs searches for open PRs in an org", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args.some((arg) => arg.startsWith("search/issues?q="))) {
				const encoded = encodeURIComponent("org:myorg is:pr is:open");
				if (args.some((arg) => arg === `search/issues?q=${encoded}`)) {
					return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_PR_URL }] }]));
				}
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(ORG_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([SCOPE_PR_URL]);
	});

	it("fetchOpenPrs passes --hostname for GHES", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api") {
				expect(args).toContain("--hostname");
				expect(args).toContain("ghe.example.com");
				return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_PR_URL }] }]));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(GHES_REPO_URL);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([SCOPE_PR_URL]);
	});

	it("fetchOpenPrs warns and returns empty on 403/422", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("HTTP 403"))) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "search-token-scope" }),
		);
	});

	it("fetchOpenPrs falls back to pulls endpoint on 404 for repo scope", async () => {
		let callCount = 0;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file !== "gh" || args[0] !== "api") return Promise.resolve("");
			callCount += 1;
			if (callCount === 1) {
				return Promise.reject(new Error("Not Found"));
			}
			return Promise.resolve(
				JSON.stringify([
					[
						{
							html_url: SCOPE_PR_URL,
						},
					],
				]),
			);
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([SCOPE_PR_URL]);
		expect(callCount).toBe(TWO_CALLS);
	});

	it("fetchOpenPrs throws on 404 for org scope", async () => {
		const runner = vi.fn(() =>
			Promise.reject(new Error("HTTP 404: Not Found")),
		) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(ORG_TARGET);
		await expect(run.fetchOpenPrs(scope, runner, warn)).rejects.toThrow(
			"org scope requires GHES 3.x+ search/issues",
		);
	});

	it("fetchOpenPrs throws when called for a single PR", async () => {
		const runner = vi.fn(() => Promise.resolve("")) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget("owner/repo/pull/1");
		await expect(run.fetchOpenPrs(scope, runner, warn)).rejects.toThrow(
			"fetchOpenPrs should not be called for a single PR",
		);
	});

	it("fetchOpenPrs warns on a generic search failure", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("HTTP 500: Boom"))) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "search-failed" }),
		);
	});

	it("fetchOpenPrs repo fallback warns on invalid PR URLs", async () => {
		let callCount = 0;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file !== "gh" || args[0] !== "api") return Promise.resolve("");
			callCount += 1;
			if (callCount === 1) {
				return Promise.reject(new Error("Not Found"));
			}
			return Promise.resolve(
				JSON.stringify([[{ html_url: "not-a-pr-url" }, { html_url: SCOPE_PR_URL }]]),
			);
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([SCOPE_PR_URL]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "fallback-invalid-url" }),
		);
	});

	it("fetchOpenPrs repo fallback returns empty on failure", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("Not Found"))) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "repo-fallback-failed" }),
		);
	});

	it("fetchOpenPrs repo fallback coerces a non-Error failure", async () => {
		const runner = vi.fn(() => Promise.reject("Not Found")) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "repo-fallback-failed" }),
		);
	});

	it("fetchOpenPrs returns empty when search has no items", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (
				file === "gh" &&
				args[0] === "api" &&
				args.some((arg) => arg.startsWith("search/issues?q="))
			) {
				return Promise.resolve(JSON.stringify([{}]));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual([]);
	});

	const makeScopeRunner = ({
		prUrl = SCOPE_PR_URL,
		rawContent = "example",
		body = "@pickup hello",
	}: {
		prUrl?: string;
		rawContent?: string;
		body?: string;
	} = {}): Runner =>
		vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && args[0] === "api") {
				if (args.some((arg) => arg.startsWith("search/issues?q="))) {
					return Promise.resolve(JSON.stringify([{ items: [{ html_url: prUrl }] }]));
				}
				if (args.includes("Accept: application/vnd.github.raw")) {
					return Promise.resolve(rawContent);
				}
				if (args.includes("POST")) {
					return Promise.resolve("");
				}
				const endpoint = args.find((arg) => arg.startsWith("repos/"));
				if (endpoint?.includes("/pulls/")) {
					return Promise.resolve(
						JSON.stringify([
							[
								{
									body,
									id: FIRST_ID,
									in_reply_to_id: null,
									line: FIRST_LINE,
									path: "src/index.ts",
									user: { login: "alice" },
								},
							],
						]),
					);
				}
				if (endpoint?.includes("/issues/")) {
					return Promise.resolve("[]");
				}
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;

	it("watches a repo scope and replies to mentions", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner();
		await run.watch(REPO_TARGET, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});

	it("watches an org scope and replies to mentions", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner();
		await run.watch(ORG_TARGET, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
	});

	it("watches a repo scope with multiple open PRs", async () => {
		const SCOPE_PR_URL_2 = "https://github.com/owner/repo/pull/2";
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && args[0] === "api") {
				if (args.some((arg) => arg.startsWith("search/issues?q="))) {
					return Promise.resolve(
						JSON.stringify([{ items: [{ html_url: SCOPE_PR_URL }, { html_url: SCOPE_PR_URL_2 }] }]),
					);
				}
				if (args.includes("Accept: application/vnd.github.raw")) {
					return Promise.resolve("example");
				}
				if (args.includes("POST")) {
					return Promise.resolve("");
				}
				const endpoint = args.find((arg) => arg.startsWith("repos/"));
				if (endpoint?.includes("/pulls/")) {
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
							],
						]),
					);
				}
				if (endpoint?.includes("/issues/")) {
					return Promise.resolve("[]");
				}
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(REPO_TARGET, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(TWO_CALLS);
	});

	it("passes --hostname for GHES repo scope", async () => {
		const runner = makeScopeRunner({
			prUrl: "https://ghe.example.com/owner/repo/pull/1",
		});
		await run.watch(GHES_REPO_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		const ghCalls = (runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls;
		expect(
			ghCalls.some(
				([, args]) =>
					args[0] === "auth" && args.includes("--hostname") && args.includes("ghe.example.com"),
			),
		).toBe(true);
		expect(
			ghCalls.some(
				([, args]) =>
					args[0] === "api" && args.includes("--hostname") && args.includes("ghe.example.com"),
			),
		).toBe(true);
	});

	it("disables --fix for repo scope and logs a warning", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner({ body: "@pickup #fix" });
		await run.watch(REPO_TARGET, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "scope-fix-disabled" }),
		);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "add")).toBe(NO_CALLS);
	});

	it("streams a repo scope and emits one line per discovered PR", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeScopeRunner();
		await run(["stream", REPO_TARGET], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(NO_CALLS);
		write.mockRestore();
	});

	it("streams an org scope and passes --hostname", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeScopeRunner({ prUrl: "https://ghe.example.com/owner/repo/pull/1" });
		await run(["stream", "https://ghe.example.com/orgs/myorg"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		expect(
			(runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.some(
				([, args]) =>
					args[0] === "api" && args.includes("--hostname") && args.includes("ghe.example.com"),
			),
		).toBe(true);
		write.mockRestore();
	});

	it("falls back to missing file reply when the raw content API fails", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && args[0] === "api") {
				if (args.some((arg) => arg.startsWith("search/issues?q="))) {
					return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_PR_URL }] }]));
				}
				if (args.includes("Accept: application/vnd.github.raw")) {
					return Promise.reject(new Error("Not Found"));
				}
				if (args.includes("POST")) {
					return Promise.resolve("");
				}
				const endpoint = args.find((arg) => arg.startsWith("repos/"));
				if (endpoint?.includes("/pulls/")) {
					return Promise.resolve(
						JSON.stringify([
							[
								{
									body: "@pickup hello",
									id: FIRST_ID,
									in_reply_to_id: null,
									line: FIRST_LINE,
									path: "missing.ts",
									user: { login: "alice" },
								},
							],
						]),
					);
				}
				if (endpoint?.includes("/issues/")) {
					return Promise.resolve("[]");
				}
			}
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(REPO_TARGET, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "file-content-api-failed" }),
		);
		expect(countCalls(runner, "gh", (args) => args.includes("POST"))).toBe(FIRST_CALL);
	});
});

describe("applyFix", () => {
	it("throws when repoRoot is missing", async () => {
		await expect(
			applyFix(
				{ repoRoot: undefined } as unknown as Parameters<typeof applyFix>[0],
				"src/index.ts",
				"fixed",
			),
		).rejects.toThrow("repoRoot is required to apply fixes");
	});
});
