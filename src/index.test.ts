import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import run from "./index.js";
import { CREWMATE_PREFIX, applyFix, dispatchMention } from "./fix.js";
import { createLogger, type Logger } from "./log.js";
import { homedir, tmpdir } from "node:os";
import type { Mention } from "./index.js";
import * as config from "./config.js";

type Runner = (
	file: string,
	args: string[],
	options?: { env?: Record<string, string | undefined> },
) => Promise<string>;

const startsWithRepos = (value: string | undefined): boolean =>
	typeof value === "string" && value.startsWith("repos/");

const PR_URL = "https://github.com/owner/repo/pull/123";
const REPO_TARGET = "owner/repo";
const ISSUE_URL = "https://github.com/owner/repo/issues/4";
const FIRST_INDEX = 0;
const SECOND_INDEX = 1;
const FIRST_ID = 1;
const SECOND_ID = 2;
const THIRD_ID = 3;
let nextReactionId = 100;
const takeNextReactionId = () => nextReactionId++;
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
const THREE_CALLS = 3;
const FOUR_CALLS = 4;
const NO_EXIT_CODE = 0;
const ERROR_EXIT_CODE = 1;
const ORIGINAL_CWD = process.cwd();

const countCalls = (
	runner: Runner,
	file: string,
	argMatcher?: (args: string[], options?: { env?: Record<string, string | undefined> }) => boolean,
): number =>
	(
		runner as unknown as {
			mock: { calls: [string, string[], { env?: Record<string, string | undefined> }?][] };
		}
	).mock.calls.filter(
		([calledFile, args, options]) =>
			calledFile === file && (argMatcher === undefined || argMatcher(args, options)),
	).length;

const isReplyPost = (args: string[]): boolean =>
	args.includes("POST") && args.some((arg) => typeof arg === "string" && arg.startsWith("body="));

const isReactionPost = (args: string[]): boolean => {
	const endpoint = findEndpoint(args);
	return args.includes("POST") && !!endpoint?.includes("/reactions");
};

const isReactionDelete = (args: string[]): boolean => {
	const endpoint = findEndpoint(args);
	return args.includes("DELETE") && !!endpoint?.includes("/reactions");
};

const getReactionEmoji = (args: string[]): string | undefined => {
	const content = args.find((arg) => typeof arg === "string" && arg.startsWith("content="));
	return content?.slice("content=".length);
};

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

const endpointPath = (endpoint: string): string => endpoint.split("?")[0] ?? endpoint;

const PULLS_COMMENTS_PATTERN = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/;
const PULLS_FILES_PATTERN = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/;
const ISSUE_BODY_PATTERN = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/;
const ISSUE_COMMENTS_PATTERN = /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/;
const REACTION_PATTERN =
	/^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/comments\/\d+\/reactions(?:\/\d+)?$|^repos\/[^/]+\/[^/]+\/issues\/\d+\/reactions(?:\/\d+)?$/;

const resolveReaction = (args: string[]): string | undefined => {
	const endpoint = findEndpoint(args);
	if (endpoint === undefined || !REACTION_PATTERN.test(endpointPath(endpoint))) {
		return undefined;
	}
	if (args.includes("POST")) {
		return JSON.stringify({ id: takeNextReactionId() });
	}
	if (args.includes("DELETE")) {
		return "";
	}
	return undefined;
};

const conversationComments = (body?: string, user = "alice"): string =>
	body === undefined || body === ""
		? "[]"
		: JSON.stringify([[{ body, id: THIRD_ID, user: { login: user } }]]);

const issueBodyResponse = (body: string, number: number, user = "alice"): string =>
	JSON.stringify({ number, body, user: { login: user } });

const resolveGhExplain = (
	args: string[],
	request: {
		body?: string;
		conversationBody?: string;
		issueBody?: string;
		path?: string;
		user?: string;
	} = {},
): Promise<string> => {
	const [command] = args;
	if (command === "api" && args.includes("user")) {
		return Promise.resolve("alice");
	}
	if (command === "api" && args.some((arg) => startsWithRepos(arg))) {
		const reaction = resolveReaction(args);
		if (reaction !== undefined) return Promise.resolve(reaction);
		const endpoint = findEndpoint(args);
		if (endpoint === undefined) return Promise.resolve("");
		if (args.includes("POST") || args.includes("DELETE")) {
			return Promise.resolve("");
		}
		const endpointPathValue = endpointPath(endpoint);
		if (PULLS_COMMENTS_PATTERN.test(endpointPathValue)) {
			return Promise.resolve(
				JSON.stringify([
					[
						{
							body: request.body ?? "@crewmate hello",
							id: FIRST_ID,
							in_reply_to_id: null,
							line: EXPLANATION_LINE,
							path: request.path ?? "src/index.ts",
							user: { login: request.user ?? "alice" },
						},
					],
				]),
			);
		}
		const issueMatch = ISSUE_BODY_PATTERN.exec(endpointPathValue);
		if (issueMatch) {
			const number = Number(issueMatch[1]);
			return Promise.resolve(
				issueBodyResponse(
					request.issueBody ?? request.conversationBody ?? "@crewmate hello",
					number,
					request.user,
				),
			);
		}
		if (ISSUE_COMMENTS_PATTERN.test(endpointPathValue)) {
			return Promise.resolve(conversationComments(request.conversationBody, request.user));
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
	if (command === "remote" && subcommand === "get-url" && args.at(2) === "origin") {
		return Promise.resolve("https://github.com/owner/repo.git");
	}
	return Promise.resolve("");
};

const makeScopeRunner = ({
	prUrl = PR_URL,
	issueUrl,
	rawContent = "example",
	body = "@crewmate hello",
	filePath = "src/index.ts",
	conversationBody,
	issueBody = "",
	user = "alice",
}: {
	prUrl?: string;
	issueUrl?: string;
	rawContent?: string;
	body?: string;
	filePath?: string;
	conversationBody?: string;
	issueBody?: string;
	user?: string;
} = {}): Runner =>
	vi.fn((file: string, args: string[]) => {
		if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
			return Promise.resolve("");
		}
		if (file === "gh" && args[0] === "api") {
			if (args.includes("user")) {
				return Promise.resolve("alice");
			}
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			const searchArg = args.find((arg) => arg.startsWith("search/issues?q="));
			if (searchArg !== undefined) {
				if (searchArg.includes("is%3Apr")) {
					return JSON.stringify([{ items: [{ html_url: prUrl }] }]);
				}
				if (searchArg.includes("is%3Aissue") && issueUrl) {
					return JSON.stringify([{ items: [{ html_url: issueUrl }] }]);
				}
				return JSON.stringify([{ items: [] }]);
			}
			if (args.includes("Accept: application/vnd.github.raw")) {
				return Promise.resolve(rawContent);
			}
			if (args.includes("POST")) {
				return Promise.resolve("");
			}
			const endpoint = findEndpoint(args);
			if (endpoint === undefined) return Promise.resolve("");
			const endpointPathValue = endpointPath(endpoint);
			if (PULLS_COMMENTS_PATTERN.test(endpointPathValue)) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body,
								id: FIRST_ID,
								in_reply_to_id: null,
								line: FIRST_LINE,
								path: filePath,
								user: { login: user },
							},
						],
					]),
				);
			}
			const issueMatch = ISSUE_BODY_PATTERN.exec(endpointPathValue);
			if (issueMatch) {
				const number = Number(issueMatch[1]);
				return Promise.resolve(issueBodyResponse(issueBody, number, user));
			}
			if (ISSUE_COMMENTS_PATTERN.test(endpointPathValue)) {
				return Promise.resolve(conversationComments(conversationBody, user));
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

const resolveExplain = (
	file: string,
	args: string[],
	request: {
		answer?: string;
		body?: string;
		conversationBody?: string;
		issueBody?: string;
		path?: string;
		provider?: string;
		user?: string;
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
		issueBody?: string;
		path?: string;
		provider?: string;
		user?: string;
	} = {},
): Runner =>
	vi.fn((file: string, args: string[]) => resolveExplain(file, args, request)) as unknown as Runner;

const makeMultiMentionRunner = (
	options: {
		conversationBody?: string;
		failOn?: string;
		issueBody?: string;
		provider?: string;
		user?: string;
	} = {},
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
			if (command === "api" && args.includes("user")) {
				return Promise.resolve("alice");
			}
			if (command === "api" && args.some((arg) => startsWithRepos(arg))) {
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
				const endpoint = findEndpoint(args);
				if (endpoint === undefined) return Promise.resolve("");
				if (args.includes("POST") || args.includes("DELETE")) {
					return Promise.resolve("");
				}
				const endpointPathValue = endpointPath(endpoint);
				if (PULLS_COMMENTS_PATTERN.test(endpointPathValue)) {
					return Promise.resolve(
						JSON.stringify([
							[
								{
									body: "@crewmate hello",
									id: FIRST_ID,
									in_reply_to_id: null,
									line: EXPLANATION_LINE,
									path: "src/index.ts",
									user: { login: options.user ?? "alice" },
								},
								{
									body: "@crewmate hi",
									id: SECOND_ID,
									in_reply_to_id: null,
									line: EXPLANATION_LINE,
									path: "src/index.ts",
									user: { login: options.user ?? "alice" },
								},
							],
						]),
					);
				}
				const issueMatch = ISSUE_BODY_PATTERN.exec(endpointPathValue);
				if (issueMatch) {
					const number = Number(issueMatch[1]);
					return Promise.resolve(issueBodyResponse(options.issueBody ?? "", number, options.user));
				}
				if (ISSUE_COMMENTS_PATTERN.test(endpointPathValue)) {
					return Promise.resolve(conversationComments(options.conversationBody, options.user));
				}
			}
		}
		return Promise.resolve("");
	}) as unknown as Runner;

const resolveGhFix = (
	args: string[],
	request: {
		body?: string;
		conversationBody?: string;
		issueBody?: string;
		targetPath: string;
		user?: string;
	} = {
		targetPath: "",
	},
): Promise<string> => {
	const [command] = args;
	if (command === "api" && args.includes("user")) {
		return Promise.resolve("alice");
	}
	if (command === "api" && args.some((arg) => startsWithRepos(arg))) {
		const reaction = resolveReaction(args);
		if (reaction !== undefined) return Promise.resolve(reaction);
		const endpoint = findEndpoint(args);
		if (endpoint === undefined) return Promise.resolve("");
		if (args.includes("POST") || args.includes("DELETE")) {
			return Promise.resolve("");
		}
		const endpointPathValue = endpointPath(endpoint);
		if (PULLS_COMMENTS_PATTERN.test(endpointPathValue)) {
			return Promise.resolve(
				JSON.stringify([
					[
						{
							body: request.body ?? "@crewmate #fix",
							id: FIRST_ID,
							in_reply_to_id: null,
							line: FIRST_LINE,
							path: request.targetPath,
							user: { login: request.user ?? "alice" },
						},
					],
				]),
			);
		}
		if (PULLS_FILES_PATTERN.test(endpointPathValue)) {
			return Promise.resolve(
				JSON.stringify([{ filename: request.targetPath, status: "modified" }]),
			);
		}
		const issueMatch = ISSUE_BODY_PATTERN.exec(endpointPathValue);
		if (issueMatch) {
			const number = Number(issueMatch[1]);
			return Promise.resolve(
				issueBodyResponse(
					request.issueBody ?? request.body ?? request.conversationBody ?? "@crewmate #fix",
					number,
					request.user,
				),
			);
		}
		if (ISSUE_COMMENTS_PATTERN.test(endpointPathValue)) {
			return Promise.resolve(conversationComments(request.conversationBody, request.user));
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
		issueBody?: string;
		targetPath: string;
		provider?: string;
		user?: string;
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
		issueBody?: string;
		provider?: string;
		user?: string;
	} = {},
): Runner =>
	vi.fn((file: string, args: string[]) =>
		resolveFix(file, args, { targetPath, ...options }),
	) as unknown as Runner;

describe("run dispatch", () => {
	it("prints the version for --version", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["--version"]);
		expect(write).toHaveBeenCalledWith("crewmate/0.3.1\n");
		write.mockRestore();
	});

	it("prints the version for -v", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["-v"]);
		expect(write).toHaveBeenCalledWith("crewmate/0.3.1\n");
		write.mockRestore();
	});

	it("shows help when no subcommand is given", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		await run([]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Commands"));
		expect(process.exitCode).toBe(NO_EXIT_CODE);
		process.exitCode = previousExitCode;
		write.mockRestore();
	});

	it("shows an error for an unknown subcommand", async () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		try {
			await run(["unknown"]);
		} finally {
			expect(write).toHaveBeenCalledWith(
				"Error: Unknown command 'unknown'. Run 'crewmate --help' for usage.\n",
			);
			expect(process.exitCode).toBe(ERROR_EXIT_CODE);
			process.exitCode = previousExitCode;
			write.mockRestore();
		}
	});

	it("runs the CLI entry point", async () => {
		const previousArgv = process.argv;
		const previousExitCode = process.exitCode;
		process.argv = ["node", "crewmate", "--version"];
		process.exitCode = NO_EXIT_CODE;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.resetModules();
		await import("./bin.js");
		expect(write).toHaveBeenCalledWith("crewmate/0.3.1\n");
		process.argv = previousArgv;
		process.exitCode = previousExitCode;
		write.mockRestore();
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
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("watches the current repo when no target is provided", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner();
		await run(["watch"], { iterations: FIRST_ITERATION, runner, logger });
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
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

	it("watches the current repo when an empty target is provided", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner();
		await run(["watch", ""], { iterations: FIRST_ITERATION, runner, logger });
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});

	it("exits with an error when no target is provided and the origin remote is missing", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "git" && args[0] === "remote") {
				return Promise.reject(new Error("No such remote 'origin'"));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run(["watch"], { runner });
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(stderr).toHaveBeenCalledWith("Error: Target is required: No such remote 'origin'\n");
		stderr.mockRestore();
		process.exitCode = previousExitCode;
	});

	it("exits with an error when the origin remote lookup rejects a non-Error", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "git" && args[0] === "remote") {
				return Promise.reject("not an error");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run(["watch"], { runner });
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(stderr).toHaveBeenCalledWith("Error: Target is required: not an error\n");
		stderr.mockRestore();
		process.exitCode = previousExitCode;
	});

	it("exits with an error when no target is provided and the origin remote is empty", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "git" && args[0] === "remote") {
				return Promise.resolve("");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run(["watch"], { runner });
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(stderr).toHaveBeenCalledWith("Error: Target is required\n");
		stderr.mockRestore();
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
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
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
		await expect(run.watch(PR_URL, { allowedUser: "alice", runner })).rejects.toThrow("api fail");
		expect(countCalls(runner, "gh", (args) => args[0] === "api")).toBe(THREE_CALLS);
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
		expect(getPrompt(runner)).toMatch(/Review comment:/);
	});

	it("ignores --prompt when the value is another flag", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--prompt", "--fix"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const prompt = getPrompt(runner);
		expect(prompt).toMatch(/Review comment:/);
		expect(prompt).not.toMatch(/^BE_TERSE\n\n/);
	});

	it("does not let an extra word after --dry-run disable dry-run", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--dry-run", "extra"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
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
		expect(write).toHaveBeenCalledWith(expect.stringContaining("crewmate watch"));
		write.mockRestore();
	});

	it("prints help for watch PR_URL --help", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["watch", PR_URL, "--help"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("crewmate watch"));
		write.mockRestore();
	});

	it("allows --unsafe-no-user to disable the user filter", async () => {
		const runner = makeExplainRunner({ answer: "It does something.", user: "bob" });
		await run(["watch", PR_URL, "--unsafe-no-user"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});

	it("makes --unsafe-no-user override --user", async () => {
		const runner = makeExplainRunner({ answer: "It does something.", user: "charlie" });
		await run(["watch", PR_URL, "--user", "bob", "--unsafe-no-user"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});

	it("makes --user override a config unsafeNoUser flag", async () => {
		const runner = makeMultiMentionRunner({ user: "alice" });
		await run(["watch", PR_URL, "--user", "bob"], {
			config: { unsafeNoUser: true },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
	});

	it("exits when the gh user cannot be determined and no filter is set", async () => {
		const previousExitCode = process.exitCode;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.resolve("");
			}
			return resolveExplain(file, args, {});
		}) as unknown as Runner;
		process.exitCode = NO_EXIT_CODE;
		await run(["watch", PR_URL], { iterations: FIRST_ITERATION, runner });
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("Could not determine a GitHub user"),
		);
		stderr.mockRestore();
		process.exitCode = previousExitCode;
	});

	it("proceeds when --unsafe-no-user is set and gh user is missing", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.resolve("");
			}
			return resolveExplain(file, args, { answer: "It does something.", user: "bob" });
		}) as unknown as Runner;
		await run(["watch", PR_URL, "--unsafe-no-user"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});
});

describe("run stream missing", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("streams the current repo when no target is provided", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeScopeRunner();
		await run(["stream"], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		expect(calls.some((line) => line.includes('"commentId":1'))).toBe(true);
		write.mockRestore();
	});

	it("streams the current repo when an empty target is provided", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeScopeRunner();
		await run(["stream", ""], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		expect(calls.some((line) => line.includes('"commentId":1'))).toBe(true);
		write.mockRestore();
	});

	it("exits with an error when no target is provided and the origin remote is missing", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "git" && args[0] === "remote") {
				return Promise.reject(new Error("No such remote 'origin'"));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run(["stream"], { runner });
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(stderr).toHaveBeenCalledWith("Error: Target is required: No such remote 'origin'\n");
		stderr.mockRestore();
		process.exitCode = previousExitCode;
	});
});

describe("run stream flags", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "--version")).toBe(
			NO_CALLS,
		);
	});

	it("does not post replies or run gh pr checkout", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
	});

	it("saves state after emitting", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["review:1"]);
	});

	it("emits an issue mention with kind issue and commentId equal to the issue number", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ issueBody: "@crewmate hello" });
		await run(["stream", ISSUE_URL], { iterations: FIRST_ITERATION, runner });
		const calls = write.mock.calls.map(([line]) => line as string);
		const events = calls
			.filter((line) => line.includes('"event":"mention"'))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			commentId: 4,
			kind: "issue",
			number: 4,
			owner: "owner",
			repo: "repo",
		});
		const state = await run.loadState(run.statePath());
		expect(state.get(ISSUE_URL)).toEqual(["issue:4"]);
		write.mockRestore();
	});

	it("saves state for every new mention in a multi-mention poll", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeMultiMentionRunner({ conversationBody: "@crewmate hi" });
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
		const runner = makeMultiMentionRunner({ conversationBody: "@crewmate hi" });
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

	it("writes unsupported flag warnings to stderr and not stdout", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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
				runner,
			},
		);
		const flags = ["--fix", "--model", "--provider", "--prompt", "--dry-run", "--json"];
		const stderrCalls = stderr.mock.calls.map(([line]) => line as string);
		const warningCalls = stderrCalls.filter((line) => line.includes("Warning: unsupported flag"));
		expect(warningCalls).toHaveLength(flags.length);
		for (const index of flags.keys()) {
			expect(warningCalls[index]).toContain("Warning: unsupported flag");
		}
		const stdoutCalls = stdout.mock.calls.map(([line]) => line as string);
		expect(
			stdoutCalls.some((line) => line.includes("Warning:") || line.includes("unsupported flag")),
		).toBe(false);
		stdout.mockRestore();
		stderr.mockRestore();
	});

	it("warns on unsupported flags before failing to resolve the default target", async () => {
		const previousExitCode = process.exitCode;
		process.exitCode = NO_EXIT_CODE;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "git" && args[0] === "remote") {
				return Promise.reject(new Error("No such remote 'origin'"));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run(
			[
				"stream",
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
			{ runner },
		);
		const calls = stderr.mock.calls.map(([line]) => line as string);
		const warningCalls = calls.filter((line) => line.includes("Warning: unsupported flag"));
		expect(warningCalls).toHaveLength(6);
		expect(calls.at(-1)).toBe("Error: Target is required: No such remote 'origin'\n");
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		stderr.mockRestore();
		process.exitCode = previousExitCode;
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
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				apiCalls += 1;
				if (apiCalls > 2) {
					return Promise.reject(new Error("second iteration"));
				}
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@crewmate hello",
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
		await expect(
			run.stream(PR_URL, { allowedUser: "alice", interval: NO_INTERVAL, runner }),
		).rejects.toThrow("second iteration");
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
			if (file === "gh" && command === "api" && args.includes("user")) {
				return Promise.resolve("alice");
			}
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@crewmate hello",
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
		expect(write).toHaveBeenCalledWith(expect.stringContaining("crewmate stream"));
		write.mockRestore();
	});

	it("prints help for stream PR_URL --help", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await run(["stream", PR_URL, "--help"]);
		expect(write).toHaveBeenCalledWith(expect.stringContaining("crewmate stream"));
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
			if (file === "gh" && command === "api" && args.includes("user")) {
				return Promise.resolve("alice");
			}
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@crewmate hello",
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
			conversationBody: "@crewmate hello",
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

	it("allows --unsafe-no-user to emit mentions from any user", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ user: "bob" });
		await run(["stream", PR_URL, "--unsafe-no-user"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		write.mockRestore();
	});

	it("makes --unsafe-no-user override --user for stream", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ user: "charlie" });
		await run(["stream", PR_URL, "--user", "bob", "--unsafe-no-user"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		write.mockRestore();
	});

	it("makes --user override a config unsafeNoUser flag for stream", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeExplainRunner({ user: "alice" });
		await run(["stream", PR_URL, "--user", "bob"], {
			config: { unsafeNoUser: true },
			iterations: FIRST_ITERATION,
			runner,
		});
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(false);
		write.mockRestore();
	});

	it("exits when the gh user cannot be determined in stream mode", async () => {
		const previousExitCode = process.exitCode;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.resolve("");
			}
			return resolveExplain(file, args, {});
		}) as unknown as Runner;
		process.exitCode = NO_EXIT_CODE;
		await run(["stream", PR_URL], { iterations: FIRST_ITERATION, runner });
		expect(process.exitCode).toBe(ERROR_EXIT_CODE);
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining("Could not determine a GitHub user"),
		);
		stderr.mockRestore();
		process.exitCode = previousExitCode;
	});

	it("proceeds in stream mode when --unsafe-no-user is set and gh user is missing", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.resolve("");
			}
			return resolveExplain(file, args, { user: "bob" });
		}) as unknown as Runner;
		await run(["stream", PR_URL, "--unsafe-no-user"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		write.mockRestore();
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

	it("preserves a non-default port in a GHES PR URL", () => {
		expect(run.parsePrUrl("https://ghe.example.com:8443/owner/repo/pull/1")).toEqual({
			host: "ghe.example.com",
			number: "1",
			owner: "owner",
			port: "8443",
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

	it("parses an HTTP URL returned by an API", () => {
		expect(run.parsePrUrl("http://ghe.example.com/owner/repo/pull/1")).toEqual({
			host: "ghe.example.com",
			number: "1",
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

	it("throws for an invalid shorthand", () => {
		expect(() => run.parsePrUrl("owner/repo/123")).toThrow(TypeError);
	});

	it("throws for a shorthand with unsafe owner characters", () => {
		expect(() => run.parsePrUrl("../repo/pull/123")).toThrow(TypeError);
	});

	it("throws when the PR number is not numeric", () => {
		expect(() => run.parsePrUrl("https://github.com/owner/repo/pull/abc")).toThrow(TypeError);
	});
});

describe("exec", () => {
	it("runs a command and returns untrimmed stdout", async () => {
		const out = await run.exec("node", ["-e", "console.log('hi')"]);
		expect(out).toBe("hi\n");
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

describe("parseGitRemoteUrl", () => {
	it("parses an HTTPS GitHub remote", () => {
		expect(run.parseGitRemoteUrl("https://github.com/owner/repo.git")).toEqual({
			host: "github.com",
			owner: "owner",
			repo: "repo",
		});
	});

	it("parses an HTTPS remote without the .git suffix", () => {
		expect(run.parseGitRemoteUrl("https://github.com/owner/repo")).toEqual({
			host: "github.com",
			owner: "owner",
			repo: "repo",
		});
	});

	it("parses an SSH remote", () => {
		expect(run.parseGitRemoteUrl("git@github.com:owner/repo.git")).toEqual({
			host: "github.com",
			owner: "owner",
			repo: "repo",
		});
	});

	it("preserves a non-default port", () => {
		expect(run.parseGitRemoteUrl("https://ghe.example.com:8443/owner/repo.git")).toEqual({
			host: "ghe.example.com",
			port: "8443",
			owner: "owner",
			repo: "repo",
		});
	});

	it("returns undefined for an unparseable remote", () => {
		expect(run.parseGitRemoteUrl("not-a-url")).toBeUndefined();
	});

	it("returns undefined for a remote with only an owner", () => {
		expect(run.parseGitRemoteUrl("https://github.com/owner")).toBeUndefined();
	});

	it("returns undefined for a remote that resolves to an invalid name", () => {
		expect(run.parseGitRemoteUrl("https://github.com/owner/.git")).toBeUndefined();
	});

	it("returns undefined for a remote with extra path segments", () => {
		expect(run.parseGitRemoteUrl("https://github.com/owner/repo/extra")).toBeUndefined();
	});

	it("ignores the port for an SSH remote", () => {
		expect(run.parseGitRemoteUrl("ssh://git@ghe.example.com:122/owner/repo.git")).toEqual({
			host: "ghe.example.com",
			owner: "owner",
			repo: "repo",
		});
	});

	it("returns undefined for an SCP-style remote without a colon", () => {
		expect(run.parseGitRemoteUrl("git@github.com/owner/repo.git")).toBeUndefined();
	});
});

describe("state errors", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
		expect(run.statePath()).toBe(path.join(tempDir, ".config", "crewmate", "state.json"));
	});

	it("falls back to os.homedir() when HOME is also empty", async () => {
		vi.stubEnv("XDG_CONFIG_HOME", "");
		vi.stubEnv("HOME", "");
		const state = await run.loadState();
		expect(state).toBeDefined();
		expect(run.statePath()).toBe(path.join(homedir(), ".config", "crewmate", "state.json"));
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
				body: "@crewmate hello",
				id: FIRST_ID,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
			{
				body: "@crewmate fix",
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
						body: "@crewmate hello",
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

	it("ignores comments without @crewmate", () => {
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
				body: "@crewmate hello",
				id: FIRST_ID,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
			{
				body: "@crewmate fix",
				id: THIRD_ID,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
			{
				body: "@crewmate hi",
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

	it("ignores @crewmate as a substring", () => {
		expect(
			run.findNewMention(
				[
					{
						body: "foo@crewmate hello",
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

	it("matches @crewmate inside parentheses", () => {
		const mention = run.findNewMention(
			[
				{
					body: "(@crewmate)",
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
						body: "@crewmate hello",
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
					body: "@crewmate hello",
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

	it("skips a fresh install mention that already has a crewmate reply (sync)", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@crewmate hello",
					id: FIRST_ID,
					inReplyToId: undefined,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "alice" },
				},
				{
					body: `${CREWMATE_PREFIX} done`,
					id: SECOND_ID,
					inReplyToId: FIRST_ID,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "crewmate" },
				},
			],
			[],
			undefined,
			true,
		);
		expect(mention).toBeUndefined();
	});

	it("does not skip a fresh install mention with a non-crewmate reply", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@crewmate hello",
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

	it("does not use the crewmate reply fallback when not fresh", () => {
		const mention = run.findNewMention(
			[
				{
					body: "@crewmate hello",
					id: FIRST_ID,
					inReplyToId: undefined,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "alice" },
				},
				{
					body: `${CREWMATE_PREFIX} done`,
					id: SECOND_ID,
					inReplyToId: FIRST_ID,
					kind: "review",
					line: FIRST_LINE,
					path: "src/index.ts",
					user: { login: "crewmate" },
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
				body: "@crewmate hello",
				id: FIRST_ID,
				inReplyToId: undefined,
				kind: "review",
				line: FIRST_LINE,
				path: "src/index.ts",
				user: { login: "alice" },
			},
			{
				body: "@crewmate fix",
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
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);

		const reactionPosts = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.filter(([file, args]) => file === "gh" && isReactionPost(args));
		expect(reactionPosts).toHaveLength(2);
		expect(getReactionEmoji(reactionPosts[0][1])).toBe("eyes");
		expect(getReactionEmoji(reactionPosts[1][1])).toBe("+1");

		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["review:1"]);
	});

	it("warns and continues when the reaction delete fails", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args.includes("DELETE")) {
				return Promise.reject(new Error("delete failed"));
			}
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			return resolveExplain(file, args, { answer: "It does something." });
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		const mockRunner = runner as unknown as {
			mock: {
				calls: [string, string[]][];
				results: { value: Promise<string> }[];
			};
		};

		const eyesIndex = mockRunner.mock.calls.findIndex(
			([file, args]) =>
				file === "gh" &&
				args.includes("POST") &&
				args.some((arg) => typeof arg === "string" && arg.includes("/reactions")),
		);
		expect(eyesIndex).toBeGreaterThanOrEqual(0);
		const eyesResult = await mockRunner.mock.results[eyesIndex].value;
		const eyes = JSON.parse(eyesResult) as { id: number };
		expect(typeof eyes.id).toBe("number");

		const eyesId = eyes.id;
		expect(
			mockRunner.mock.calls.some(
				([file, args]) =>
					file === "gh" &&
					args.includes("DELETE") &&
					args.some((arg) => typeof arg === "string" && arg.endsWith(`/reactions/${eyesId}`)),
			),
		).toBe(true);

		const reactionCalls = mockRunner.mock.calls.filter(
			([file, args]) =>
				file === "gh" && args.some((arg) => typeof arg === "string" && arg.includes("/reactions")),
		);
		const lastReaction = reactionCalls.at(-1);
		expect(lastReaction?.[1].some((arg) => typeof arg === "string" && arg === "content=+1")).toBe(
			true,
		);

		expect(countCalls(runner, "gh", isReplyPost)).toBe(FIRST_CALL);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to remove reaction"));
		warn.mockRestore();
	});

	it("emits debug log events when debug mode is enabled", async () => {
		const logger = vi.fn() as unknown as Logger & {
			mock: { calls: [string, Record<string, unknown>][] };
		};
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
			debug: true,
			logger,
		});
		const calls = logger.mock.calls.filter(([level]) => level === "debug");
		expect(calls).toHaveLength(3);
		expect(calls[0][1]).toMatchObject({ stage: "fetched-comments" });
		expect(calls[1][1]).toMatchObject({ stage: "mention-filter" });
		expect(calls[2][1]).toMatchObject({ stage: "new-mentions" });
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

	it("defaults allowedUser to the authenticated gh user when --user is not set", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.resolve("alice\n");
			}
			return resolveExplain(file, args, { answer: "It does something." });
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});

	it("skips mentions from other users when the authenticated gh user differs", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.resolve("bob\n");
			}
			return resolveExplain(file, args, { answer: "It does something." });
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
	});

	it("warns when the authenticated gh user cannot be determined", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.reject(new Error("not logged in"));
			}
			return resolveExplain(file, args, { answer: "It does something." });
		}) as unknown as Runner;
		await expect(
			run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner }),
		).rejects.toThrow("Could not determine a GitHub user");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("could not determine the authenticated gh user"),
		);
		warn.mockRestore();
	});

	it("warns when the provider returns an empty explanation", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ answer: "" });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(warn).toHaveBeenCalled();
		expect(
			countCalls(
				runner,
				"gh",
				(args) =>
					args.includes("DELETE") &&
					args.some((arg) => typeof arg === "string" && arg.includes("/reactions")),
			),
		).toBe(FIRST_CALL);
		warn.mockRestore();
	});

	it("warns when removing the initial reaction fails", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args.includes("DELETE")) {
				return Promise.reject(new Error("delete failed"));
			}
			return resolveExplain(file, args, { answer: "" });
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("failed to remove reaction: delete failed"),
		);
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
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
				if (args.some((arg) => arg.includes("/pulls/"))) {
					return Promise.resolve(
						JSON.stringify([
							[
								{
									body: "@crewmate hello",
									id: FIRST_ID,
									in_reply_to_id: null,
									line: FIRST_LINE,
									path: "src/index.ts",
									user: { login: "alice" },
								},
								{
									body: `${CREWMATE_PREFIX} done`,
									id: SECOND_ID,
									in_reply_to_id: FIRST_ID,
									line: FIRST_LINE,
									path: "src/index.ts",
									user: { login: "crewmate" },
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
		await run.watch(PR_URL, {
			allowedUser: "alice",
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
	});

	it("keeps suppressed crewmate replies out of the next poll", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "gh" && args.at(0) === "api") {
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
				const endpoint = findEndpoint(args);
				if (endpoint?.includes("/pulls/")) {
					return Promise.resolve(
						JSON.stringify([
							[
								{
									body: "@crewmate hello",
									id: FIRST_ID,
									in_reply_to_id: null,
									line: FIRST_LINE,
									path: "src/index.ts",
									user: { login: "alice" },
								},
								{
									body: `${CREWMATE_PREFIX} done`,
									id: SECOND_ID,
									in_reply_to_id: FIRST_ID,
									line: FIRST_LINE,
									path: "src/index.ts",
									user: { login: "crewmate" },
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
									body: "@crewmate hi",
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
			allowedUser: "alice",
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
	});
	it("polls once and replies to all new mentions", async () => {
		const runner = makeMultiMentionRunner();
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(TWO_CALLS);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["review:2", "review:1"]);
	});
	it("saves state for the handled mentions when one fails", async () => {
		const runner = makeMultiMentionRunner({ failOn: "claude @crewmate hello" });
		await expect(
			run.watch(PR_URL, {
				interval: NO_INTERVAL,
				iterations: FIRST_ITERATION,
				runner,
			}),
		).rejects.toThrow();
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["review:2", "review:1"]);
	});

	it("preserves a non-default port in a GHES PR URL", async () => {
		const runner = makeMultiMentionRunner();
		const ghesUrl = "https://ghe.example.com:8443/owner/repo/pull/1";
		await run.watch(ghesUrl, { iterations: 1, runner });
		expect(
			countCalls(runner, "gh", (args, options) => options?.env?.GH_HOST === "ghe.example.com:8443"),
		).toBeGreaterThanOrEqual(1);
		expect(countCalls(runner, "gh", (args) => args.includes("--hostname"))).toBeGreaterThanOrEqual(
			1,
		);
	});

	it("falls back to host without port when gh auth status --hostname with port fails", async () => {
		const runner = makeMultiMentionRunner({ failOn: "gh ghe.example.com:8443" });
		const ghesUrl = "https://ghe.example.com:8443/owner/repo/pull/1";
		await run.watch(ghesUrl, { iterations: 1, runner });
		expect(
			countCalls(runner, "gh", (args, options) => options?.env?.GH_HOST === "ghe.example.com:8443"),
		).toBeGreaterThanOrEqual(1);
		expect(countCalls(runner, "gh", (args) => args.includes("--hostname"))).toBe(2);
	});

	it("throws when gh auth status --hostname fails without a port", async () => {
		const runner = makeMultiMentionRunner({ failOn: "gh --hostname" });
		await expect(run.watch(PR_URL, { iterations: 1, runner })).rejects.toThrow();
	});

	it("warns when the initial reaction post returns an empty response", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			if (file === "gh") {
				const endpoint = findEndpoint(args);
				if (endpoint?.includes("/reactions") && args.includes("POST")) {
					return Promise.resolve("");
				}
				return resolveGhExplain(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "gh", isReplyPost)).toBe(FIRST_CALL);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("failed to set reaction: empty response"),
		);
		warn.mockRestore();
	});

	it("warns when the initial reaction post returns a non-numeric id", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			if (file === "gh") {
				const endpoint = findEndpoint(args);
				if (endpoint?.includes("/reactions") && args.includes("POST")) {
					return Promise.resolve(JSON.stringify({ id: "abc" }));
				}
				return resolveGhExplain(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "gh", isReplyPost)).toBe(FIRST_CALL);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("failed to set reaction: response did not contain a numeric id"),
		);
		warn.mockRestore();
	});

	it("warns when the initial reaction post returns invalid json", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			if (file === "gh") {
				const endpoint = findEndpoint(args);
				if (endpoint?.includes("/reactions") && args.includes("POST")) {
					return Promise.resolve("not json");
				}
				return resolveGhExplain(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "gh", isReplyPost)).toBe(FIRST_CALL);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to set reaction:"));
		warn.mockRestore();
	});

	it("warns when the initial reaction post fails", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			if (file === "gh") {
				const endpoint = findEndpoint(args);
				if (endpoint?.includes("/reactions") && args.includes("POST")) {
					return Promise.reject(new Error("reaction post failed"));
				}
				return resolveGhExplain(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "gh", isReplyPost)).toBe(FIRST_CALL);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("failed to set reaction: reaction post failed"),
		);
		warn.mockRestore();
	});

	it("warns when the swap reaction post fails after a successful eyes reaction", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "claude") {
				return Promise.resolve("It does something.");
			}
			if (file === "git") {
				return resolveGit(args);
			}
			if (file === "gh") {
				const endpoint = findEndpoint(args);
				const emoji = getReactionEmoji(args);
				if (endpoint?.includes("/reactions") && args.includes("POST")) {
					if (emoji === "+1") {
						return Promise.reject(new Error("+1 reaction post failed"));
					}
					return Promise.resolve(JSON.stringify({ id: takeNextReactionId() }));
				}
				return resolveGhExplain(args);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(countCalls(runner, "gh", isReplyPost)).toBe(FIRST_CALL);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("failed to set reaction: +1 reaction post failed"),
		);
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("failed to remove reaction"));
		expect(
			countCalls(runner, "gh", (args) => {
				const endpoint = findEndpoint(args);
				return args.includes("DELETE") && !!endpoint?.includes("/reactions");
			}),
		).toBe(FIRST_CALL);
		warn.mockRestore();
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
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@crewmate hello",
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
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
			unsafeNoUser: true,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});
});

describe("watch users invalid", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@crewmate hello",
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
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
			unsafeNoUser: true,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});
});

describe("watch users null", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("handles comments with a null user", async () => {
		const nullUser = JSON.parse('{"user":null}');
		const base = { body: "@crewmate hello", id: FIRST_ID, line: FIRST_LINE, path: "src/index.ts" };
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
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
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
			unsafeNoUser: true,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});
});

describe("run iterations flag", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("bounds watch and stream polling", async () => {
		const watchRunner = makeExplainRunner({ answer: "It does something." });
		await run(["watch", PR_URL, "--iterations", String(TWO_ITERATIONS)], {
			config: { interval: NO_INTERVAL },
			runner: watchRunner,
		});
		expect(
			countCalls(
				watchRunner,
				"gh",
				(args) =>
					args.at(FIRST_INDEX) === "api" &&
					!args.includes("--method") &&
					args.some((arg) => startsWithRepos(arg)),
			),
		).toBe(FOUR_CALLS);

		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const streamRunner = makeScopeRunner();
		await run(["stream", REPO_TARGET, `--iterations=${TWO_ITERATIONS}`], {
			config: { interval: NO_INTERVAL },
			runner: streamRunner,
		});
		expect(
			countCalls(
				streamRunner,
				"gh",
				(args) =>
					args.at(FIRST_INDEX) === "api" && args.some((arg) => arg.startsWith("search/issues?q=")),
			),
		).toBe(FOUR_CALLS);
		write.mockRestore();
	});

	it("fails when watch or stream iterations value is missing", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		try {
			for (const [subcommand, target] of [
				["watch", PR_URL],
				["stream", REPO_TARGET],
			]) {
				process.exitCode = NO_EXIT_CODE;
				await run([subcommand, target, "--iterations"]);
				expect(process.exitCode).toBe(ERROR_EXIT_CODE);
			}
			expect(stderr).toHaveBeenCalledTimes(TWO_CALLS);
			expect(stderr).toHaveBeenCalledWith("Error: --iterations requires a value.\n");
		} finally {
			stderr.mockRestore();
			process.exitCode = previousExitCode;
		}
	});

	it("fails when watch or stream iterations value is invalid", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const previousExitCode = process.exitCode;
		try {
			for (const [subcommand, target] of [
				["watch", PR_URL],
				["stream", REPO_TARGET],
			]) {
				process.exitCode = NO_EXIT_CODE;
				await run([subcommand, target, "--iterations", "1.5"]);
				expect(process.exitCode).toBe(ERROR_EXIT_CODE);
			}
			expect(stderr).toHaveBeenCalledTimes(TWO_CALLS);
			expect(stderr).toHaveBeenCalledWith("Error: --iterations must be a positive integer.\n");
		} finally {
			stderr.mockRestore();
			process.exitCode = previousExitCode;
		}
	});
});

describe("watch iterations", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
	});

	it("skips a fresh install mention that already has a crewmate reply (async)", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@crewmate hello",
								id: FIRST_ID,
								in_reply_to_id: null,
								line: FIRST_LINE,
								path: "src/index.ts",
								user: { login: "alice" },
							},
							{
								body: `${CREWMATE_PREFIX} done`,
								id: SECOND_ID,
								in_reply_to_id: FIRST_ID,
								line: FIRST_LINE,
								path: "src/index.ts",
								user: { login: "crewmate" },
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
		await run.watch(PR_URL, {
			allowedUser: "alice",
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
	});
});

describe("watch fix success", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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

		const reactionPosts = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.filter(([file, args]) => file === "gh" && isReactionPost(args));
		expect(reactionPosts).toHaveLength(2);
		expect(getReactionEmoji(reactionPosts[0][1])).toBe("eyes");
		expect(getReactionEmoji(reactionPosts[1][1])).toBe("rocket");

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

		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		const postCall = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([file, args]) => file === "gh" && isReplyPost(args));
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

		const runner = makeFixRunner(targetPath, { body: "@crewmate fix", fixed: "new" });
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

		const runner = makeFixRunner(targetPath, { body: "@crewmate #fixme", fixed: "new" });
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);

		const reactionPosts = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.filter(([file, args]) => file === "gh" && isReactionPost(args));
		expect(reactionPosts).toHaveLength(2);
		expect(getReactionEmoji(reactionPosts[0][1])).toBe("eyes");
		expect(getReactionEmoji(reactionPosts[1][1])).toBe("+1");
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

describe("watch dry-run", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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

	it("dry-run polls for two iterations", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, {
			dryRun: true,
			interval: NO_INTERVAL,
			iterations: TWO_ITERATIONS,
			runner,
		});

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
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

		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(FIRST_CALL);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);

		const output = write.mock.calls.map(([line]) => line as string).join("");
		const changeLines = output
			.split("\n")
			.filter((line) => line.startsWith("[dry-run] would change reaction"));
		expect(changeLines).toHaveLength(2);
		expect(changeLines[0]).toContain(":none: to :eyes:");
		expect(changeLines[1]).toContain(":eyes: to :+1:");

		const replyIndex = output.indexOf("would reply to comment");
		const secondChangeIndex = output.indexOf(changeLines[1]);
		expect(replyIndex).toBeGreaterThan(secondChangeIndex);

		write.mockRestore();

		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toBeUndefined();
	});

	it("removes the eyes reaction in dry-run when the provider returns empty", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({ answer: "" });
		await run.watch(PR_URL, {
			dryRun: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		const output = write.mock.calls.map(([line]) => line as string).join("");
		expect(output).toContain("[dry-run] would change reaction on comment 1 from :none: to :eyes:");
		expect(output).toContain("[dry-run] would remove reaction :eyes: from comment 1");
		expect(output).not.toContain("would reply to comment");
		write.mockRestore();
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

		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
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

		const output = write.mock.calls.map(([line]) => line as string).join("");
		expect(output).toContain("would write fix to");
		expect(output).toContain(targetPath);
		expect(output).toContain("new");
		expect(output).toContain("[dry-run] would change reaction on comment 1 from :none: to :eyes:");
		expect(output).toContain(
			"[dry-run] would change reaction on comment 1 from :eyes: to :rocket:",
		);
		expect(output).toContain("[dry-run] would reply to comment 1:");
		write.mockRestore();
	});

	it("conversation dry-run produces human-readable preview", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({
			answer: "It does something.",
			conversationBody: "@crewmate hello",
		});
		await run.watch(PR_URL, {
			dryRun: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		const output = write.mock.calls.map(([line]) => line as string).join("");
		expect(output).toContain("[dry-run] would change reaction on comment 3 from :none: to :eyes:");
		expect(output).toContain("[dry-run] would change reaction on comment 3 from :eyes: to :+1:");
		expect(output).toContain("would post a comment on pull request 123:");
		write.mockRestore();

		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toBeUndefined();
	});

	it("issue dry-run produces human-readable preview", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({
			answer: "It does something.",
			issueBody: "@crewmate hello",
		});
		await run.watch(ISSUE_URL, {
			dryRun: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		const output = write.mock.calls.map(([line]) => line as string).join("");
		expect(output).toContain("[dry-run] would change reaction on issue 4 from :none: to :eyes:");
		expect(output).toContain("[dry-run] would change reaction on issue 4 from :eyes: to :+1:");
		expect(output).toContain("would post a comment on issue 4:");
		write.mockRestore();

		const state = await run.loadState(run.statePath());
		expect(state.get(ISSUE_URL)).toBeUndefined();
	});
});

describe("watch fix missing", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
	});
});

describe("watch fix empty", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
	});
});

describe("watch fix errors", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
	});
});

describe("watch issue", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	it("replies to the issue body and a conversation comment", async () => {
		const runner = makeExplainRunner({
			answer: "It does something.",
			conversationBody: "@crewmate hi",
			issueBody: "@crewmate hello",
		});
		await run.watch(ISSUE_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(TWO_CALLS);
		const state = await run.loadState(run.statePath());
		expect(state.get(ISSUE_URL)).toEqual(["issue:4", "conversation:3"]);
	});

	it("disables #fix on the issue body", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeFixRunner("src/index.ts", {
			issueBody: "@crewmate #fix",
			fixed: "No problem.",
		});
		await run.watch(ISSUE_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
			toStderr: true,
		});

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(NO_CALLS);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "add")).toBe(NO_CALLS);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "scope-fix-disabled" }),
		);
	});
});

describe("conversation comments", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
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

	it("replies to a PR conversation comment through the issues endpoint", async () => {
		const runner = makeExplainRunner({
			answer: "It does something.",
			body: "hello",
			conversationBody: "@crewmate hello",
		});
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);

		const postCall = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([file, args]) => file === "gh" && isReplyPost(args));
		expect(postCall?.[1].some((arg) => /\/issues\/\d+\/comments/.test(arg))).toBe(true);
		expect(postCall?.[1].some((arg) => /\/pulls\/.*\/comments\/.*\/replies/.test(arg))).toBe(false);

		const reactionPosts = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.filter(([file, args]) => file === "gh" && isReactionPost(args));
		expect(reactionPosts).toHaveLength(2);
		expect(
			reactionPosts.every(([_, args]) => findEndpoint(args)?.includes("/issues/comments/")),
		).toBe(true);
		expect(
			reactionPosts.some(([_, args]) => findEndpoint(args)?.includes("/pulls/comments/")),
		).toBe(false);
		expect(getReactionEmoji(reactionPosts[0][1])).toBe("eyes");
		expect(getReactionEmoji(reactionPosts[1][1])).toBe("+1");

		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["conversation:3"]);
	});

	it("applies a fix from a conversation #fix with --fix", async () => {
		const targetPath = path.join("src", "index.ts");
		const targetDir = path.resolve("src");
		await mkdir(targetDir, { recursive: true });
		await writeFile(path.resolve(targetPath), "old");

		const runner = makeFixRunner(targetPath, {
			body: "hello",
			conversationBody: "@crewmate #fix",
		});
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		const content = await readFile(path.resolve(targetPath), "utf8");
		expect(content).toBe("new");
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(FIRST_CALL);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "add")).toBe(FIRST_CALL);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "commit")).toBe(FIRST_CALL);
		expect(countCalls(runner, "git", (args) => args.at(FIRST_INDEX) === "push")).toBe(FIRST_CALL);

		const reactionPosts = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.filter(([file, args]) => file === "gh" && isReactionPost(args));
		expect(reactionPosts).toHaveLength(2);
		expect(
			reactionPosts.every(([_, args]) => findEndpoint(args)?.includes("/issues/comments/")),
		).toBe(true);
		expect(getReactionEmoji(reactionPosts[0][1])).toBe("eyes");
		expect(getReactionEmoji(reactionPosts[1][1])).toBe("rocket");
	});

	it("does not treat #fixme as a fix request in conversation comments", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeFixRunner("src/index.ts", {
			body: "hello",
			conversationBody: "@crewmate #fixme",
			fixed: "No problem.",
		});
		await run.watch(PR_URL, {
			allowFix: true,
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
			toStderr: true,
		});

		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
		expect(logger).not.toHaveBeenCalledWith("warning", expect.anything());
		expect(getPrompt(runner)).toMatch(/#fixme/);
	});

	it("keeps #fix in conversation comments when --fix is not set", async () => {
		const runner = makeFixRunner("src/index.ts", {
			body: "hello",
			conversationBody: "@crewmate #fix",
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
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@crewmate hello",
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
								body: "@crewmate hi",
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

		await run.watch(PR_URL, {
			allowedUser: "alice",
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(TWO_CALLS);

		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toEqual(["conversation:2", "review:1"]);
	});

	it("posts review replies to the pulls comments replies endpoint", async () => {
		const runner = makeExplainRunner({ answer: "It does something." });
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });

		const postCall = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([file, args]) => file === "gh" && isReplyPost(args));
		expect(postCall?.[1].some((arg) => /\/pulls\/\d+\/comments\/\d+\/replies/.test(arg))).toBe(
			true,
		);
	});

	it("passes a custom prompt to a conversation mention", async () => {
		const runner = makeExplainRunner({
			answer: "It does something.",
			body: "",
			conversationBody: "@crewmate hello",
		});
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			prompt: "CUSTOM",
			runner,
		});
		expect(getPrompt(runner)?.startsWith("CUSTOM\n\n")).toBe(true);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
	});

	it("warns when the provider returns an empty conversation response", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({
			answer: "",
			body: "",
			conversationBody: "@crewmate hello",
		});
		await run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner });
		expect(warn).toHaveBeenCalledWith("Warning: claude returned empty conversation response\n");
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
		warn.mockRestore();
	});

	it("warns when a custom provider returns an empty conversation response", async () => {
		const warn = vi.spyOn(process.stderr, "write").mockImplementation(vi.fn());
		const runner = makeExplainRunner({
			answer: "",
			body: "",
			conversationBody: "@crewmate hello",
			provider: "my-llm",
		});
		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			provider: "my-llm",
			runner,
		});
		expect(warn).toHaveBeenCalledWith("Warning: my-llm returned empty conversation response\n");
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
		warn.mockRestore();
	});

	it("filters malformed conversation comments", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(JSON.stringify([[]]));
			}
			if (file === "gh" && command === "api" && endpoint?.includes("/issues/")) {
				return Promise.resolve(
					JSON.stringify([[[{ body: "@crewmate hello", id: "3", user: { login: "alice" } }]]]),
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

		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
			unsafeNoUser: true,
		});

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
		const state = await run.loadState(run.statePath());
		expect(state.get(PR_URL)).toBeUndefined();
	});

	it("filters malformed review comments", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "api" && endpoint?.includes("/pulls/")) {
				return Promise.resolve(
					JSON.stringify([
						[
							{
								body: "@crewmate hello",
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

		await run.watch(PR_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
			unsafeNoUser: true,
		});

		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
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

	it("prints help when -h is passed after a target", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = vi.fn(() => Promise.resolve("")) as unknown as Runner;
		await run(["watch", PR_URL, "-h"], { runner });
		expect(write).toHaveBeenCalledWith(expect.stringContaining("Commands"));
		expect(countCalls(runner, "gh")).toBe(0);
		write.mockRestore();
	});

	it("renders help as ANSI-styled text in a TTY", async () => {
		const previousIsTTY = process.stdout.isTTY;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		process.stdout.isTTY = true;
		await run(["--help"]);
		const output = String(write.mock.calls[0][0]);
		expect(output).toContain("Commands");
		expect(output).not.toContain("## Commands");
		expect(output).toContain("\x1b[1m");
		expect(output).toContain("\x1b[36m");
		expect(output).toContain("  • ");
		process.stdout.isTTY = previousIsTTY;
		write.mockRestore();
	});

	it("renders help without ANSI when output is not a TTY", async () => {
		const previousIsTTY = process.stdout.isTTY;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		process.stdout.isTTY = false;
		await run(["--help"]);
		const output = String(write.mock.calls[0][0]);
		expect(output).toContain("Commands");
		expect(output).not.toContain("## Commands");
		expect(output).not.toContain("\x1b[");
		process.stdout.isTTY = previousIsTTY;
		write.mockRestore();
	});

	it("renders help without ANSI when NO_COLOR is set", async () => {
		const previousIsTTY = process.stdout.isTTY;
		const previousNoColor = process.env.NO_COLOR;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		process.stdout.isTTY = true;
		process.env.NO_COLOR = "1";
		await run(["--help"]);
		const output = String(write.mock.calls[0][0]);
		expect(output).toContain("Commands");
		expect(output).not.toContain("## Commands");
		expect(output).not.toContain("\x1b[");
		process.stdout.isTTY = previousIsTTY;
		process.env.NO_COLOR = previousNoColor;
		write.mockRestore();
	});
});

const logFilePath = (tempDir: string): string => path.join(tempDir, "crewmate", "crewmate.log");

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
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-logs-"));
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
		await mkdir(path.join(tempDir, "crewmate"), { recursive: true });
		await writeFile(path.join(tempDir, "crewmate", "state.json"), "not json");
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
			if (file === "gh" && isReplyPost(args)) {
				return Promise.reject(new Error("post failed"));
			}
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			return resolveGhExplain(args);
		}) as unknown as Runner;

		await expect(
			run.watch(PR_URL, { interval: NO_INTERVAL, iterations: FIRST_ITERATION, runner }),
		).rejects.toThrow("post failed");

		const lines = await parseLogFile(tempDir);
		expect(lines.some((line) => line.event === "reply" && line.failed === true)).toBe(true);
		expect(countCalls(runner, "gh", isReactionPost)).toBe(TWO_CALLS);
		expect(countCalls(runner, "gh", isReactionDelete)).toBe(TWO_CALLS);
	});
});

describe("watch config", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-config-"));
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
			path.join(tempDir, ".crewmate.json"),
			JSON.stringify({ prompt: "repo prompt", provider: "my-llm" }),
			"utf8",
		);
		await mkdir(path.join(tempDir, "crewmate"), { recursive: true });
		await writeFile(
			path.join(tempDir, "crewmate", "config.json"),
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
			path.join(tempDir, ".crewmate.json"),
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
	});

	it("warns when the config user does not match the authenticated gh user", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeMultiMentionRunner({ user: "alice" });
		await run.watch(PR_URL, {
			config: { user: "bob" },
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({
				message: "filtering for user bob who is not the authenticated gh user alice",
				allowedUser: "bob",
				ghUser: "alice",
			}),
		);
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
		expect(
			(runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.some(
				([, args]) =>
					args[0] === "pr" &&
					args[1] === "checkout" &&
					args[2] === "-R" &&
					args[3] === "owner/repo",
			),
		).toBe(true);
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
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

	it("uses a config unsafeNoUser flag", async () => {
		const runner = makeMultiMentionRunner({ user: "alice" });
		await run.watch(PR_URL, {
			config: { unsafeNoUser: true, user: "bob" },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
	});

	it("exits when gh user is missing and no filter is configured", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.resolve("");
			}
			return resolveExplain(file, args, { user: "bob" });
		}) as unknown as Runner;
		await expect(run.watch(PR_URL, { iterations: FIRST_ITERATION, runner })).rejects.toThrow(
			"Could not determine a GitHub user",
		);
	});

	it("proceeds with config unsafeNoUser when gh user is missing", async () => {
		const baseRunner = makeMultiMentionRunner({ user: "bob" });
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && args[0] === "api" && args.includes("user")) {
				return Promise.resolve("");
			}
			return baseRunner(file, args);
		}) as unknown as Runner;
		await run.watch(PR_URL, {
			config: { unsafeNoUser: true },
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
	});
});

describe("scope targets", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	const ORG_TARGET = "org:myorg";
	const GHES_REPO_URL = "https://ghe.example.com/owner/repo";
	const SCOPE_PR_URL = "https://github.com/owner/repo/pull/1";
	const SCOPE_ISSUE_URL = "https://github.com/owner/repo/issues/2";

	it("parses a full GHES repo URL", () => {
		expect(run.parseTarget(GHES_REPO_URL)).toEqual({
			kind: "repo",
			host: "ghe.example.com",
			owner: "owner",
			repo: "repo",
		});
	});

	it("preserves a non-default port in a GHES repo URL", () => {
		expect(run.parseTarget("https://ghe.example.com:8443/owner/repo")).toEqual({
			kind: "repo",
			host: "ghe.example.com",
			owner: "owner",
			port: "8443",
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

	it("preserves a non-default port in a GHES org URL", () => {
		expect(run.parseTarget("https://ghe.example.com:8443/orgs/myorg")).toEqual({
			kind: "org",
			host: "ghe.example.com",
			org: "myorg",
			port: "8443",
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

	it("preserves a non-default port in a GHES PR URL", () => {
		expect(run.parseTarget("https://ghe.example.com:8443/owner/repo/pull/1")).toEqual({
			kind: "pr",
			host: "ghe.example.com",
			owner: "owner",
			port: "8443",
			repo: "repo",
			number: "1",
		});
	});

	it("parses an issue shorthand", () => {
		expect(run.parseTarget("owner/repo/issues/4")).toEqual({
			kind: "issue",
			host: "github.com",
			owner: "owner",
			repo: "repo",
			number: "4",
		});
	});

	it("parses a full GitHub issue URL", () => {
		expect(run.parseTarget("https://github.com/owner/repo/issues/4")).toEqual({
			kind: "issue",
			host: "github.com",
			owner: "owner",
			repo: "repo",
			number: "4",
		});
	});

	it("preserves a non-default port in a GHES issue URL", () => {
		expect(run.parseTarget("https://ghe.example.com:8443/owner/repo/issues/1")).toEqual({
			kind: "issue",
			host: "ghe.example.com",
			owner: "owner",
			port: "8443",
			repo: "repo",
			number: "1",
		});
	});

	it("fetchMentions returns an issue mention plus conversation comments", async () => {
		const runner = makeExplainRunner({
			issueBody: "@crewmate hello",
			conversationBody: "@crewmate hi",
		});
		const mentions = await run.fetchMentions("https://github.com/owner/repo/issues/4", runner);
		expect(mentions).toHaveLength(2);
		expect(
			mentions.some(
				(mention) =>
					mention.kind === "issue" && mention.id === 4 && mention.body === "@crewmate hello",
			),
		).toBe(true);
		expect(
			mentions.some(
				(mention) =>
					mention.kind === "conversation" &&
					mention.id === THIRD_ID &&
					mention.body === "@crewmate hi",
			),
		).toBe(true);
	});

	it("fetchMentions throws for a non-item URL", async () => {
		const runner = makeExplainRunner();
		await expect(run.fetchMentions("https://github.com/owner/repo", runner)).rejects.toThrow(
			"Invalid item reference: https://github.com/owner/repo",
		);
	});

	it("respondToMention throws for a non-item URL", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeExplainRunner();
		const warn = warnFn(logger);
		await expect(
			run.respondToMention(
				{ body: "@crewmate hello", id: FIRST_ID, kind: "review" } as Mention,
				"https://github.com/owner/repo",
				{ allowFix: false, checkedOut: new Set(), dryRun: false, logger, runner, warn },
			),
		).rejects.toThrow("Invalid item reference: https://github.com/owner/repo");
	});

	it("fetchMentions falls back to conversation comments when the issue body is malformed", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (
				file === "gh" &&
				args.at(FIRST_INDEX) === "api" &&
				args.some((arg) => startsWithRepos(arg))
			) {
				const endpoint = findEndpoint(args);
				if (endpoint === undefined) return Promise.resolve("");
				const endpointPathValue = endpointPath(endpoint);
				if (ISSUE_BODY_PATTERN.test(endpointPathValue)) return Promise.resolve("{}");
				if (ISSUE_COMMENTS_PATTERN.test(endpointPathValue)) {
					return Promise.resolve(conversationComments("@crewmate hi"));
				}
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const mentions = await run.fetchMentions("https://github.com/owner/repo/issues/4", runner);
		expect(mentions).toHaveLength(1);
		expect(mentions[0]).toMatchObject({ kind: "conversation", body: "@crewmate hi", id: THIRD_ID });
	});

	it("throws for an invalid bare word", () => {
		expect(() => run.parseTarget("not-a-pr")).toThrow("Invalid target: not-a-pr");
	});

	it("throws for an unsupported URL", () => {
		expect(() => run.parseTarget("https://github.com/orgs/myorg/projects/1")).toThrow(
			"Invalid target: https://github.com/orgs/myorg/projects/1",
		);
	});

	it("throws for a malformed URL", () => {
		expect(() => run.parseTarget("https://")).toThrow("Invalid target: https://");
	});

	it("throws for an invalid org shorthand", () => {
		expect(() => run.parseTarget("org:")).toThrow("Invalid target: org:");
		expect(() => run.parseTarget("org:my org")).toThrow("Invalid target: org:my org");
	});

	it("throws for an owner or repo containing path metacharacters in a URL", () => {
		expect(() => run.parseTarget("https://github.com/%2e%2e/repo")).toThrow(TypeError);
		expect(() => run.parseTarget("https://github.com/foo%2fbar/pull/1")).toThrow(TypeError);
		expect(() => run.parseTarget("https://github.com/../repo")).toThrow(TypeError);
		expect(() => run.parseTarget("https://github.com/orgs/%2e%2e")).toThrow(TypeError);
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
							items: [{ html_url: SCOPE_PR_URL }, { html_url: 123 }, { html_url: "not-a-url" }],
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

	it("fetchOpenPrs sets GH_HOST for GHES", async () => {
		const runner = vi.fn(
			(file: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
				if (file === "gh" && args[0] === "api") {
					const reaction = resolveReaction(args);
					if (reaction !== undefined) return Promise.resolve(reaction);
					expect(options?.env?.GH_HOST).toBe("ghe.example.com");
					expect(args).not.toContain("--hostname");
					return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_PR_URL }] }]));
				}
				return Promise.resolve("");
			},
		) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(GHES_REPO_URL);
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual(["https://ghe.example.com/owner/repo/pull/1"]);
	});

	it("fetchOpenPrs preserves a non-default GHES port", async () => {
		const runner = vi.fn(
			(file: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
				if (file === "gh" && args[0] === "api") {
					const reaction = resolveReaction(args);
					if (reaction !== undefined) return Promise.resolve(reaction);
					expect(options?.env?.GH_HOST).toBe("ghe.example.com:8443");
					expect(args).not.toContain("--hostname");
					return Promise.resolve(
						JSON.stringify([
							{
								items: [{ html_url: "https://ghe.example.com/owner/repo/pull/1" }],
							},
						]),
					);
				}
				return Promise.resolve("");
			},
		) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget("https://ghe.example.com:8443/owner/repo");
		const prUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(prUrls).toEqual(["https://ghe.example.com:8443/owner/repo/pull/1"]);
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

	it("fetchOpenPrs falls back to issues endpoint on 404 and returns both PR and issue URLs", async () => {
		let callCount = 0;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file !== "gh" || args[0] !== "api") return Promise.resolve("");
			callCount += 1;
			if (args.some((arg) => arg.startsWith("search/issues?q="))) {
				return Promise.reject(new Error("HTTP 404: Not Found"));
			}
			if (args.some((arg) => arg.startsWith("repos/owner/repo/issues?state=open"))) {
				return Promise.resolve(
					JSON.stringify([[{ html_url: SCOPE_PR_URL }, { html_url: SCOPE_ISSUE_URL }]]),
				);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const itemUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(itemUrls).toEqual([SCOPE_PR_URL, SCOPE_ISSUE_URL]);
		expect(callCount).toBe(THREE_CALLS);
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
			"fetchOpenItems should not be called for a single item",
		);
	});

	it("fetchOpenItems returns empty when both search queries fail", async () => {
		const runner = vi.fn(() => Promise.reject(new Error("Boom"))) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const itemUrls = await run.fetchOpenItems(scope, runner, warn);
		expect(itemUrls).toEqual([]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "search-failed" }),
		);
	});

	it("fetchOpenPrs repo fallback warns on invalid item URLs", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (file !== "gh" || args[0] !== "api") return Promise.resolve("");
			if (args.some((arg) => arg.startsWith("search/issues?q="))) {
				return Promise.reject(new Error("HTTP 404: Not Found"));
			}
			if (args.some((arg) => arg.startsWith("repos/owner/repo/issues?state=open"))) {
				return Promise.resolve(
					JSON.stringify([
						[
							{ html_url: undefined },
							{ html_url: "https://github.com/owner/repo" },
							{ html_url: SCOPE_PR_URL },
						],
					]),
				);
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const itemUrls = await run.fetchOpenPrs(scope, runner, warn);
		expect(itemUrls).toEqual([SCOPE_PR_URL]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "fallback-invalid-url" }),
		);
	});

	it("fetchOpenPrs repo fallback returns empty on failure", async () => {
		const runner = vi.fn(() =>
			Promise.reject(new Error("HTTP 404: Not Found")),
		) as unknown as Runner;
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
		const runner = vi.fn(() => Promise.reject("HTTP 404: Not Found")) as unknown as Runner;
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

	it("fetchOpenItems returns both PR and issue URLs from search and deduplicates", async () => {
		const prQuery = `search/issues?q=${encodeURIComponent("repo:owner/repo is:pr is:open")}`;
		const issueQuery = `search/issues?q=${encodeURIComponent("repo:owner/repo is:issue is:open")}`;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file !== "gh" || args[0] !== "api") return Promise.resolve("");
			if (args.some((arg) => arg === prQuery)) {
				return Promise.resolve(
					JSON.stringify([{ items: [{ html_url: SCOPE_PR_URL }, { html_url: SCOPE_ISSUE_URL }] }]),
				);
			}
			if (args.some((arg) => arg === issueQuery)) {
				return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_ISSUE_URL }] }]));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const itemUrls = await run.fetchOpenItems(scope, runner, warn);
		expect(itemUrls).toEqual([SCOPE_PR_URL, SCOPE_ISSUE_URL]);
	});

	it("fetchOpenItems warns and continues when one search query fails but the other succeeds", async () => {
		const prQuery = `search/issues?q=${encodeURIComponent("repo:owner/repo is:pr is:open")}`;
		const issueQuery = `search/issues?q=${encodeURIComponent("repo:owner/repo is:issue is:open")}`;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file !== "gh" || args[0] !== "api") return Promise.resolve("");
			if (args.some((arg) => arg === prQuery)) {
				return Promise.reject(new Error("Boom"));
			}
			if (args.some((arg) => arg === issueQuery)) {
				return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_ISSUE_URL }] }]));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = warnFn(logger);
		const scope = run.parseTarget(REPO_TARGET);
		const itemUrls = await run.fetchOpenItems(scope, runner, warn);
		expect(itemUrls).toEqual([SCOPE_ISSUE_URL]);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "search-failed" }),
		);
	});

	it("watches a repo scope and processes a mixed PR and issue discovery", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner({
			issueUrl: SCOPE_ISSUE_URL,
			issueBody: "@crewmate hello",
		});
		await run.watch(REPO_TARGET, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(TWO_CALLS);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(NO_CALLS);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
	});

	it("watches a repo scope and replies to mentions", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner();
		await run.watch(REPO_TARGET, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(FIRST_CALL);
	});

	it("watches with the --debug CLI flag and emits debug log events", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger & {
			mock: { calls: [string, Record<string, unknown>][] };
		};
		const runner = makeScopeRunner();
		await run(["watch", REPO_TARGET, "--debug"], {
			iterations: FIRST_ITERATION,
			runner,
			logger,
		});
		const debugCalls = logger.mock.calls.filter(([level]) => level === "debug");
		expect(debugCalls.length).toBeGreaterThan(0);
		expect(
			debugCalls.some(([, fields]) => (fields as { stage: string }).stage === "new-mentions"),
		).toBe(true);
	});

	it("rejects an unsafe review file path outside a git tree", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner({ filePath: "../etc/passwd" });
		await run.watch(REPO_TARGET, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(
			countCalls(runner, "gh", (args) => args.includes("Accept: application/vnd.github.raw")),
		).toBe(NO_CALLS);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(NO_CALLS);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "invalid-file-path" }),
		);
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
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
	});

	it("watches an org scope with both PRs and issues", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner({
			issueUrl: SCOPE_ISSUE_URL,
			issueBody: "@crewmate hello",
		});
		await run.watch(ORG_TARGET, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			logger,
			runner,
		});
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(TWO_CALLS);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(NO_CALLS);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
	});

	it("watches a repo scope with multiple open PRs", async () => {
		const SCOPE_PR_URL_2 = "https://github.com/owner/repo/pull/2";
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && args[0] === "api") {
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
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
									body: "@crewmate hello",
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
			unsafeNoUser: true,
		});
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(TWO_CALLS);
	});

	it("watches a repo scope with both PRs and issues", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && args[0] === "api") {
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
				const searchArg = args.find((arg) => arg.startsWith("search/issues?q="));
				if (searchArg !== undefined) {
					if (searchArg.includes("is%3Apr")) {
						return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_PR_URL }] }]));
					}
					if (searchArg.includes("is%3Aissue")) {
						return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_ISSUE_URL }] }]));
					}
					return Promise.resolve(JSON.stringify([{ items: [] }]));
				}
				if (args.includes("Accept: application/vnd.github.raw")) {
					return Promise.resolve("example");
				}
				if (args.includes("POST")) {
					return Promise.resolve("");
				}
				const endpoint = findEndpoint(args);
				if (endpoint === undefined) return Promise.resolve("");
				const endpointPathValue = endpointPath(endpoint);
				if (PULLS_COMMENTS_PATTERN.test(endpointPathValue)) {
					return Promise.resolve(
						JSON.stringify([
							[
								{
									body: "@crewmate hello",
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
				const issueMatch = ISSUE_BODY_PATTERN.exec(endpointPathValue);
				if (issueMatch) {
					return Promise.resolve(
						issueBodyResponse("@crewmate hello", Number(issueMatch[1]), "alice"),
					);
				}
				if (ISSUE_COMMENTS_PATTERN.test(endpointPathValue)) {
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
			unsafeNoUser: true,
		});
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(TWO_CALLS);
		expect(countCalls(runner, "gh", (args) => args.at(FIRST_INDEX) === "pr")).toBe(NO_CALLS);
		expect(
			countCalls(
				runner,
				"gh",
				(args) => args.at(FIRST_INDEX) === "pr" && args.at(SECOND_INDEX) === "checkout",
			),
		).toBe(NO_CALLS);
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "-p")).toBe(TWO_CALLS);
	});

	it("continues polling when one repo scope PR fails", async () => {
		const SCOPE_PR_URL_2 = "https://github.com/owner/repo/pull/2";
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && args[0] === "api") {
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
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
				if (endpoint?.includes("/pulls/1/comments")) {
					return Promise.reject(new Error("HTTP 404: Not Found"));
				}
				if (endpoint?.includes("/pulls/")) {
					return Promise.resolve(
						JSON.stringify([
							[
								{
									body: "@crewmate hello",
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
			unsafeNoUser: true,
		});
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "poll-failed" }),
		);
	});

	it("watches a repo scope with no open PRs", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (
				file === "gh" &&
				args[0] === "api" &&
				args.some((arg) => arg.startsWith("search/issues?q="))
			) {
				return Promise.resolve(JSON.stringify([{ items: [] }]));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.watch(REPO_TARGET, {
			interval: NO_INTERVAL,
			iterations: TWO_CALLS,
			logger,
			runner,
			unsafeNoUser: true,
		});
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "no-open-items" }),
		);
	});

	it("sets GH_HOST for GHES repo scope", async () => {
		const runner = makeScopeRunner({
			prUrl: "https://ghe.example.com/owner/repo/pull/1",
		});
		await run.watch(GHES_REPO_URL, {
			interval: NO_INTERVAL,
			iterations: FIRST_ITERATION,
			runner,
		});
		expect(
			countCalls(
				runner,
				"gh",
				(args, options) => args[0] === "auth" && options?.env?.GH_HOST === "ghe.example.com",
			),
		).toBeGreaterThanOrEqual(1);
		expect(
			countCalls(
				runner,
				"gh",
				(args, options) => args[0] === "api" && options?.env?.GH_HOST === "ghe.example.com",
			),
		).toBeGreaterThanOrEqual(1);
	});

	it("disables --fix for repo scope and logs a warning", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeScopeRunner({ body: "@crewmate #fix" });
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
		expect(countCalls(runner, "claude", (args) => args.at(FIRST_INDEX) === "--version")).toBe(
			NO_CALLS,
		);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(NO_CALLS);
		write.mockRestore();
	});

	it("streams with --debug and emits debug log events", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const logger = vi.fn() as unknown as Logger & {
			mock: { calls: [string, Record<string, unknown>][] };
		};
		const runner = makeScopeRunner();
		await run(["stream", REPO_TARGET, "--debug"], { iterations: FIRST_ITERATION, runner, logger });
		const debugCalls = logger.mock.calls.filter(([level]) => level === "debug");
		expect(debugCalls.length).toBeGreaterThan(0);
		expect(
			debugCalls.some(([, fields]) => (fields as { stage: string }).stage === "new-mentions"),
		).toBe(true);
		write.mockRestore();
	});

	it("streams an org scope and sets GH_HOST", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = makeScopeRunner({ prUrl: "https://ghe.example.com/owner/repo/pull/1" });
		await run(["stream", "https://ghe.example.com/orgs/myorg"], {
			iterations: FIRST_ITERATION,
			runner,
		});
		const calls = write.mock.calls.map(([line]) => line as string);
		expect(calls.some((line) => line.includes('"event":"mention"'))).toBe(true);
		expect(
			countCalls(
				runner,
				"gh",
				(args, options) => args[0] === "api" && options?.env?.GH_HOST === "ghe.example.com",
			),
		).toBeGreaterThanOrEqual(1);
		write.mockRestore();
	});

	it("streams a repo scope with no open PRs", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (
				file === "gh" &&
				args[0] === "api" &&
				args.some((arg) => arg.startsWith("search/issues?q="))
			) {
				return Promise.resolve(JSON.stringify([{ items: [] }]));
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		await run.stream(REPO_TARGET, {
			interval: NO_INTERVAL,
			iterations: TWO_CALLS,
			logger,
			runner,
			unsafeNoUser: true,
		});
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "no-open-items" }),
		);
	});

	it("falls back to missing file reply when the raw content API fails", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && args[0] === "api") {
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
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
									body: "@crewmate hello",
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
			unsafeNoUser: true,
		});
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "file-content-api-failed" }),
		);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(FIRST_CALL);
	});

	it("warns and continues on non-404 raw content API failures", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && (args[0] === "--version" || args[0] === "auth")) {
				return Promise.resolve("");
			}
			if (file === "gh" && args[0] === "api") {
				const reaction = resolveReaction(args);
				if (reaction !== undefined) return Promise.resolve(reaction);
				if (args.some((arg) => arg.startsWith("search/issues?q="))) {
					return Promise.resolve(JSON.stringify([{ items: [{ html_url: SCOPE_PR_URL }] }]));
				}
				if (args.includes("Accept: application/vnd.github.raw")) {
					return Promise.reject(new Error("rate limit"));
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
									body: "@crewmate hello",
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
			unsafeNoUser: true,
		});
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "file-content-api-failed" }),
		);
		expect(countCalls(runner, "gh", (args) => isReplyPost(args))).toBe(0);
		expect(logger).toHaveBeenCalledWith(
			"warning",
			expect.objectContaining({ reason: "poll-failed" }),
		);
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

describe("dispatchMention reaction cleanup", () => {
	it("warns when removing an eyes reaction that has no id", async () => {
		const warn = vi.fn() as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn() as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			if (file === "gh" && isReactionPost(args)) {
				return Promise.reject(new Error("reaction post failed"));
			}
			if (file === "claude") {
				return Promise.resolve("");
			}
			return Promise.resolve("");
		}) as unknown as Runner;
		const ctx = {
			checkedOut: new Set<string>(),
			commentId: FIRST_ID,
			dryRun: false,
			ghHost: "github.com",
			kind: "conversation" as const,
			logger,
			number: "123",
			owner: "owner",
			prUrl: PR_URL,
			repo: "repo",
			reaction: { emoji: "eyes" },
			runner,
			warn,
		};
		await dispatchMention({ id: FIRST_ID, body: "@crewmate hello", kind: "conversation" }, ctx, {
			allowFix: false,
		});
		expect(warn).toHaveBeenCalledWith(
			"failed to remove reaction: no reaction id",
			expect.any(Object),
		);
	});
});

describe("dispatchMention conversation fix", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-"));
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
		process.chdir(tempDir);
	});

	afterEach(async () => {
		process.chdir(ORIGINAL_CWD);
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
	});

	const makeConversationFixRunner = ({
		files = ["src/index.ts"],
		fixed = "```\nnew\n```",
	}: {
		files?: string[];
		fixed?: string;
	} = {}): Runner =>
		vi.fn((file: string, args: string[]) => {
			const [command] = args;
			const endpoint = findEndpoint(args);
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && command === "pr") return Promise.resolve("");
			if (file === "gh" && command === "api") {
				if (endpoint?.includes("/reactions")) return Promise.resolve(JSON.stringify({ id: 1 }));
				if (PULLS_FILES_PATTERN.test(endpointPath(endpoint))) {
					return Promise.resolve(
						JSON.stringify(files.map((filename) => ({ filename, status: "modified" }))),
					);
				}
			}
			if (file === "claude") return Promise.resolve(fixed);
			if (file === "git") return resolveGit(args);
			return Promise.resolve("");
		}) as unknown as Runner;

	const makeConversationFixCtx = (
		runner: Runner,
		warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
		logger: Logger,
		overrides: Record<string, unknown> = {},
	) => ({
		checkedOut: new Set<string>(),
		commentId: FIRST_ID,
		dryRun: false,
		ghHost: "github.com",
		kind: "conversation" as const,
		logger,
		number: "123",
		owner: "owner",
		prUrl: PR_URL,
		repo: "repo",
		repoRoot: tempDir,
		runner,
		warn,
		...overrides,
	});

	const dispatchConversationFix = async ({
		fixed,
		files,
	}: {
		fixed: string;
		files?: string[];
	}): Promise<Runner> => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const runner = makeConversationFixRunner({ files, fixed });
		const ctx = makeConversationFixCtx(runner, warn, logger);
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});
		return runner;
	};

	it("reports when the provider returns empty for a conversation #fix", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const runner = await dispatchConversationFix({ fixed: "" });

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("Could not generate a fix.");
	});

	it("reports when the provider returns plain text for a multi-file conversation #fix", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		await writeFile(path.resolve("src", "other.ts"), "old");
		const runner = await dispatchConversationFix({
			files: ["src/index.ts", "src/other.ts"],
			fixed: "plain text",
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("Could not generate a fix.");
	});

	it("rejects an unsafe path returned for a conversation #fix", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const runner = await dispatchConversationFix({ fixed: "```../outside\nnew\n```" });

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("Could not generate a fix.");
	});

	it("rejects a path that is not a changed file in this PR", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const runner = await dispatchConversationFix({
			files: ["src/index.ts"],
			fixed: "```src/not-changed.ts\nnew\n```",
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("Could not generate a fix.");
	});

	it("applies a plain provider response to the only changed file", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		await dispatchConversationFix({ fixed: "new" });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("new");
	});

	it("applies a fenced provider response with no language tag", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		await dispatchConversationFix({ fixed: "```\nnew\n```" });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("new");
	});

	it("applies a fenced provider response with a language tag when there is one changed file", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		await dispatchConversationFix({ fixed: "```typescript\nnew\n```" });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("new");
	});

	it("rejects a fix for an unreadable changed file", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		await writeFile(path.resolve("binary.ts"), Buffer.from([0]));
		const runner = await dispatchConversationFix({
			files: ["src/index.ts", "binary.ts"],
			fixed: "```binary.ts\nnew\n```",
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("Could not generate a fix.");
	});

	it("preserves the original file's trailing newline when the provider omits it", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old\n");
		await dispatchConversationFix({ fixed: "new" });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("new\n");
	});

	it("allows the provider to return an empty file", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old\n");
		await dispatchConversationFix({ fixed: "```src/index.ts\n\n```" });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("");
	});

	it("includes unreadable changed files in the conversation prompt", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		await dispatchConversationFix({
			files: ["src/index.ts", "src/missing.ts"],
			fixed: "```src/index.ts\nnew\n```",
		});

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("new");
	});

	it("applies multiple fenced fixes returned by the provider", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		await writeFile(path.resolve("src", "other.ts"), "old");
		const runner = await dispatchConversationFix({
			files: ["src/index.ts", "src/other.ts"],
			fixed: "```src/index.ts\nnew1\n```\n```src/other.ts\nnew2\n```",
		});

		const content1 = await readFile(path.resolve("src", "index.ts"), "utf8");
		const content2 = await readFile(path.resolve("src", "other.ts"), "utf8");
		expect(content1).toBe("new1");
		expect(content2).toBe("new2");
		const commits = countCalls(runner, "git", (args) => args.at(0) === "commit");
		expect(commits).toBe(FIRST_CALL);
	});

	it("reports when the changed files cannot be read", async () => {
		const runner = await dispatchConversationFix({
			files: ["missing.ts"],
			fixed: "```\nnew\n```",
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"Could not read any changed files in this PR.",
		);
	});

	it("reports when there are no changed files in this PR", async () => {
		const runner = await dispatchConversationFix({ files: [], fixed: "```\nnew\n```" });

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("No files changed in this PR.");
	});

	it("handles nested fences when parsing provider responses", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const outer = "````";
		const inner = "```foo";
		const fixed = `${outer}\n${inner}\nnew\n${outer}\n\`\`\``;
		await dispatchConversationFix({ fixed });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe(`${inner}\nnew`);
	});

	it("preserves empty-info inner fences that are shorter than the outer fence", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const fixed = "````\n```\ninner\n```\nnew\n````";
		await dispatchConversationFix({ fixed });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("```\ninner\n```\nnew");
	});

	it("preserves nested code blocks that use more backticks", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const fixed = "```src/index.ts\nouter\n````inner\ninner\n````\nnew\n```";
		await dispatchConversationFix({ fixed });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("outer\n````inner\ninner\n````\nnew");
	});

	it("reports no changes needed when the provider returns the same fenced content", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const runner = await dispatchConversationFix({ fixed: "```\nold\n```" });

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("No changes needed.");
		const reactionCalls = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.filter(
			([f, a]) => f === "gh" && REACTION_PATTERN.test(endpointPath(findEndpoint(a) ?? "")),
		);
		expect(reactionCalls.at(-1)?.[1].join(" ")).toContain("content=+1");
	});

	it("reports no changes needed when the provider returns the same plain content", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const runner = await dispatchConversationFix({ fixed: "old" });

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("No changes needed.");
		const reactionCalls = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.filter(
			([f, a]) => f === "gh" && REACTION_PATTERN.test(endpointPath(findEndpoint(a) ?? "")),
		);
		expect(reactionCalls.at(-1)?.[1].join(" ")).toContain("content=+1");
	});

	it("reports and throws when applyFix receives a path outside the repo", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const runner = makeConversationFixRunner({});
		const ctx = makeConversationFixCtx(runner, warn, logger);
		await expect(applyFix(ctx, "../outside", "new")).rejects.toThrow("Invalid target path");
		expect(logger).toHaveBeenCalledWith(
			"fix",
			expect.objectContaining({ error: "Invalid target path" }),
		);
	});

	it("reports when the changed files cannot be read in a missing directory", async () => {
		const runner = await dispatchConversationFix({
			files: ["missing/missing.ts"],
			fixed: "```\nnew\n```",
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"Could not read any changed files in this PR.",
		);
	});

	it("silently skips unsafe files when reading changed files without a checkout", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const runner = makeConversationFixRunner({ files: ["../etc/passwd"] });
		const ctx = makeConversationFixCtx(runner, warn, logger, { repoRoot: undefined });
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"Could not read any changed files in this PR.",
		);
	});

	it("silently skips missing files when reading changed files without a checkout", async () => {
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const runner = vi.fn((file: string, args: string[]) => {
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && PULLS_FILES_PATTERN.test(endpointPath(findEndpoint(args) ?? ""))) {
				return Promise.resolve(JSON.stringify([{ filename: "src/index.ts", status: "modified" }]));
			}
			if (file === "gh" && args.includes("Accept: application/vnd.github.raw")) {
				return Promise.reject(new Error("Not Found"));
			}
			if (file === "claude") return Promise.resolve("```\nnew\n```");
			if (file === "git") return resolveGit(args);
			return Promise.resolve("");
		}) as unknown as Runner;
		const ctx = makeConversationFixCtx(runner, warn, logger, { repoRoot: undefined });
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"Could not read any changed files in this PR.",
		);
	});

	it("caps the number of changed files considered for a conversation fix", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const files = Array.from({ length: 51 }, (_, i) => `f${i}.ts`);
		const runner = makeConversationFixRunner({ files, fixed: "" });
		const ctx = makeConversationFixCtx(runner, warn, logger);
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		expect(warn).toHaveBeenCalledWith(
			"truncating changed file list for conversation prompt",
			expect.any(Object),
		);
		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"Could not read any changed files in this PR.",
		);
	});

	it("skips files that are too large for the conversation prompt", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		await writeFile(path.resolve("large.ts"), Buffer.alloc(1_000_000, "a"));
		const runner = makeConversationFixRunner({ files: ["large.ts"], fixed: "" });
		const ctx = makeConversationFixCtx(runner, warn, logger);
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		expect(warn).toHaveBeenCalledWith(
			"skipping file for conversation prompt",
			expect.objectContaining({ reason: "too-large" }),
		);
		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"Could not read any changed files in this PR.",
		);
	});

	it("skips binary files when reading changed files", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		await writeFile(path.resolve("binary.ts"), Buffer.from([0, 1, 2]));
		const runner = makeConversationFixRunner({ files: ["binary.ts"], fixed: "" });
		const ctx = makeConversationFixCtx(runner, warn, logger);
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		expect(warn).toHaveBeenCalledWith(
			"skipping file for conversation prompt",
			expect.objectContaining({ reason: "binary" }),
		);
		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"Could not read any changed files in this PR.",
		);
	});

	it("silently skips directories when reading changed files from a checkout", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		await mkdir(path.resolve("src"), { recursive: true });
		await mkdir(path.resolve("src", "dir"));
		const runner = makeConversationFixRunner({ files: ["src/dir"], fixed: "" });
		const ctx = makeConversationFixCtx(runner, warn, logger);
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"Could not read any changed files in this PR.",
		);
	});

	it("skips files that are too large from the GitHub API", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && PULLS_FILES_PATTERN.test(endpointPath(findEndpoint(args) ?? ""))) {
				return Promise.resolve(JSON.stringify([{ filename: "large.ts", status: "modified" }]));
			}
			if (file === "gh" && args.includes("Accept: application/vnd.github.raw")) {
				return Promise.resolve("a".repeat(200_000));
			}
			if (file === "claude") return Promise.resolve("");
			if (file === "git") return resolveGit(args);
			return Promise.resolve("");
		}) as unknown as Runner;
		const ctx = makeConversationFixCtx(runner, warn, logger, { repoRoot: undefined });
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		expect(warn).toHaveBeenCalledWith(
			"skipping file for conversation prompt",
			expect.objectContaining({ path: "large.ts", reason: "too-large" }),
		);
	});

	it("rejects an unclosed fenced response for a conversation fix", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const runner = await dispatchConversationFix({ fixed: "```\nnew" });

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("Could not generate a fix.");
	});

	it("applies a fenced response with leading spaces on the fence lines", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		await dispatchConversationFix({ fixed: "  ```src/index.ts\nnew\n  ```" });

		const content = await readFile(path.resolve("src", "index.ts"), "utf8");
		expect(content).toBe("new");
	});

	it("continues when a raw content API call fails for a changed file without a checkout", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && PULLS_FILES_PATTERN.test(endpointPath(findEndpoint(args) ?? ""))) {
				return Promise.resolve(
					JSON.stringify([
						{ filename: "src/index.ts", status: "modified" },
						{ filename: "src/missing.ts", status: "modified" },
					]),
				);
			}
			if (file === "gh" && args.includes("Accept: application/vnd.github.raw")) {
				const endpoint = findEndpoint(args) ?? "";
				if (endpoint.includes("src/index.ts")) return Promise.resolve("old");
				return Promise.reject(new Error("rate limit"));
			}
			if (file === "claude") return Promise.resolve("");
			if (file === "git") return resolveGit(args);
			return Promise.resolve("");
		}) as unknown as Runner;
		const ctx = makeConversationFixCtx(runner, warn, logger, { repoRoot: undefined });
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		expect(warn).toHaveBeenCalledWith(
			"file content API failed",
			expect.objectContaining({ path: "src/missing.ts", reason: "file-content-api-failed" }),
		);
		const claudeCall = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "claude" && a[0] === "-p");
		expect(claudeCall).toBeDefined();
		expect(JSON.stringify(claudeCall?.[1])).toContain("--- src/index.ts ---\\nold");
		expect(JSON.stringify(claudeCall?.[1])).toContain(
			"--- src/missing.ts ---\\n<could not read file content>",
		);
	});

	it("previews a conversation #fix in dry-run mode", async () => {
		await mkdir(path.resolve("src"), { recursive: true });
		await writeFile(path.resolve("src", "index.ts"), "old");
		const write = vi.spyOn(process.stdout, "write").mockImplementation(vi.fn());
		const runner = makeConversationFixRunner({
			fixed: "```src/index.ts\nnew\n```",
		});
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const ctx = makeConversationFixCtx(runner, warn, logger, { dryRun: true });
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		const output = write.mock.calls.map(([line]) => line as string).join("");
		expect(output).toContain("would write fix to");
		expect(output).toContain("new");
		write.mockRestore();
	});

	it("rejects a conversation fix for an invalid PR URL", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = makeConversationFixRunner({});
		const ctx = makeConversationFixCtx(runner, warn, logger, {
			prUrl: "not-a-url",
			repoRoot: undefined,
		});
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("I can't apply fixes");
	});

	it("rejects a fix requested on an issue body", async () => {
		const warn = vi.fn() as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && args.includes("/reactions"))
				return Promise.resolve(JSON.stringify({ id: 1 }));
			if (file === "gh" && args.includes("/issues/4/comments")) return Promise.resolve("[]");
			if (file === "gh" && args.includes("/issues/"))
				return Promise.resolve(issueBodyResponse("@crewmate #fix", 4));
			if (file === "claude") return Promise.resolve("No problem.");
			if (file === "git") return resolveGit(args);
			return Promise.resolve("");
		}) as unknown as Runner;
		const ctx = makeConversationFixCtx(runner, warn, logger, {
			kind: "issue" as const,
			number: "4",
			prUrl: ISSUE_URL,
			repoRoot: undefined,
		});
		await dispatchMention({ id: 4, body: "@crewmate #fix", kind: "issue" }, ctx, {
			allowFix: true,
		});
		expect(warn).toHaveBeenCalledWith(
			"fix requested on issue body or comment; only PR review and conversation comments support #fix",
			expect.any(Object),
		);
		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("I can't apply fixes");
	});

	it("rejects a fix requested on an issue comment", async () => {
		const warn = vi.fn() as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && args.includes("/reactions"))
				return Promise.resolve(JSON.stringify({ id: 1 }));
			if (file === "gh" && args.includes("/issues/4/comments")) return Promise.resolve("[]");
			if (file === "gh" && args.includes("/issues/"))
				return Promise.resolve(issueBodyResponse("@crewmate #fix", 4));
			if (file === "claude") return Promise.resolve("No problem.");
			if (file === "git") return resolveGit(args);
			return Promise.resolve("");
		}) as unknown as Runner;
		const ctx = makeConversationFixCtx(runner, warn, logger, {
			kind: "conversation" as const,
			number: "4",
			prUrl: ISSUE_URL,
			repoRoot: undefined,
		});
		await dispatchMention({ id: 4, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});
		expect(warn).toHaveBeenCalledWith(
			"fix requested on a conversation comment that does not belong to a PR; only PR conversation comments support #fix",
			expect.any(Object),
		);
		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain("I can't apply fixes");
	});

	it("rejects a plain conversation fix without a local checkout", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && PULLS_FILES_PATTERN.test(endpointPath(findEndpoint(args) ?? ""))) {
				return Promise.resolve(JSON.stringify([{ filename: "src/index.ts", status: "modified" }]));
			}
			if (file === "gh" && args.includes("Accept: application/vnd.github.raw")) {
				return Promise.resolve("old");
			}
			if (file === "claude") return Promise.resolve("new");
			if (file === "git") return resolveGit(args);
			return Promise.resolve("");
		}) as unknown as Runner;
		const ctx = makeConversationFixCtx(runner, warn, logger, { repoRoot: undefined });
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		expect(warn).toHaveBeenCalledWith(
			"conversation fix requested without a local checkout",
			expect.any(Object),
		);
		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"A local PR checkout is required to apply conversation fixes.",
		);
	});

	it("rejects a conversation fix without a local checkout", async () => {
		const warn = vi.fn(() => Promise.resolve()) as unknown as (
			message: string,
			fields?: Record<string, unknown>,
		) => Promise<void>;
		const logger = vi.fn(() => Promise.resolve()) as unknown as Logger;
		const runner = vi.fn((file: string, args: string[]) => {
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			if (file === "gh" && PULLS_FILES_PATTERN.test(endpointPath(findEndpoint(args) ?? ""))) {
				return Promise.resolve(JSON.stringify([{ filename: "src/index.ts", status: "modified" }]));
			}
			if (file === "gh" && args.includes("Accept: application/vnd.github.raw")) {
				return Promise.resolve("old");
			}
			if (file === "claude") return Promise.resolve("```src/index.ts\nnew\n```");
			if (file === "git") return resolveGit(args);
			return Promise.resolve("");
		}) as unknown as Runner;
		const ctx = makeConversationFixCtx(runner, warn, logger, { repoRoot: undefined });
		await dispatchMention({ id: FIRST_ID, body: "@crewmate #fix", kind: "conversation" }, ctx, {
			allowFix: true,
		});

		expect(warn).toHaveBeenCalledWith(
			"conversation fix requested without a local checkout",
			expect.any(Object),
		);
		const replyPost = (
			runner as unknown as { mock: { calls: [string, string[]][] } }
		).mock.calls.find(([f, a]) => f === "gh" && isReplyPost(a));
		expect(JSON.stringify(replyPost?.[1])).toContain(
			"A local PR checkout is required to apply conversation fixes.",
		);
	});
});
