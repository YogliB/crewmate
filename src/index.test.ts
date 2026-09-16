import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import run from "./index.js";
import { CREWMATE_PREFIX } from "./reply.js";
import type { Logger } from "./log.js";

const mention = (overrides: Record<string, unknown> = {}) =>
	({
		body: "@crewmate hello",
		id: 1,
		kind: "review",
		line: 1,
		path: "a.ts",
		user: { login: "alice" },
		...overrides,
	}) as never;

const failingLogger: Logger = () => Promise.reject(new Error("log broken"));

type Runner = (
	file: string,
	args: string[],
	options?: { env?: Record<string, string | undefined>; timeoutMs?: number },
) => Promise<string>;

const PR_URL = "https://github.com/owner/repo/pull/4";
const ISSUE_URL = "https://github.com/owner/repo/issues/4";

const startsWithRepos = (value: string | undefined): boolean =>
	typeof value === "string" && value.startsWith("repos/");

const findEndpoint = (args: string[]): string | undefined =>
	args.find((arg) => startsWithRepos(arg));

const endpointPath = (endpoint: string): string => endpoint.split("?")[0] ?? endpoint;

const PULLS_COMMENTS_PATTERN = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/;
const ISSUE_BODY_PATTERN = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/;
const ISSUE_COMMENTS_PATTERN = /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/;
const REACTION_PATTERN =
	/^repos\/[^/]+\/[^/]+\/(?:issues|pulls)\/comments\/\d+\/reactions(?:\/\d+)?$|^repos\/[^/]+\/[^/]+\/issues\/\d+\/reactions(?:\/\d+)?$/;

let nextReactionId = 100;
const takeNextReactionId = () => nextReactionId++;

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

type ReviewCommentSpec = {
	body?: string;
	id?: number;
	inReplyToId?: number | null;
	line?: number;
	path?: string;
	user?: string;
	createdAt?: string;
};

const reviewCommentsPage = (specs: ReviewCommentSpec[]): string =>
	JSON.stringify([
		specs.map((spec, index) => ({
			body: spec.body ?? "@crewmate hello",
			created_at: spec.createdAt ?? "2026-09-03T00:00:00.000Z",
			id: spec.id ?? index + 1,
			in_reply_to_id: spec.inReplyToId ?? null,
			line: spec.line ?? 5,
			path: spec.path ?? "src/index.ts",
			user: { login: spec.user ?? "alice" },
		})),
	]);

type RunnerBehavior = {
	answer?: string | Error;
	comments?: ReviewCommentSpec[];
	conversationBody?: string;
	conversationUser?: string;
	failAuth?: boolean;
	failUserLookup?: boolean;
	ghUser?: string;
	issueBody?: string;
	issueNumber?: number;
	prUrl?: string;
	issueUrl?: string;
	rawContent?: string | Error;
	reactionResponse?: string | Error;
	remoteUrl?: string | Error;
	providerName?: string;
	searchFailsPr?: Error;
	searchFailsIssue?: Error;
	searchPrUrls?: string[];
	searchIssueUrls?: string[];
	searchPrItems?: unknown[];
	searchPrNoItems?: boolean;
};

const makeRunner = (behavior: RunnerBehavior = {}): Runner =>
	vi.fn((file: string, args: string[]) => {
		if (file === "gh" && args[0] === "--version") {
			return Promise.resolve("");
		}
		if (file === "gh" && args[0] === "auth") {
			return behavior.failAuth === true
				? Promise.reject(new Error("not logged in"))
				: Promise.resolve("");
		}
		if (file === "gh" && args[0] === "api") {
			if (args.includes("user")) {
				if (behavior.failUserLookup === true) {
					return Promise.reject(new Error("no user"));
				}
				return Promise.resolve(`${behavior.ghUser ?? "alice"}\n`);
			}
			const reactionEndpoint = findEndpoint(args);
			if (
				behavior.reactionResponse !== undefined &&
				reactionEndpoint !== undefined &&
				REACTION_PATTERN.test(endpointPath(reactionEndpoint))
			) {
				return behavior.reactionResponse instanceof Error
					? Promise.reject(behavior.reactionResponse)
					: Promise.resolve(behavior.reactionResponse);
			}
			const reaction = resolveReaction(args);
			if (reaction !== undefined) return Promise.resolve(reaction);
			const searchArg = args.find((arg) => arg.startsWith("search/issues?q="));
			if (searchArg !== undefined) {
				if (searchArg.includes("is%3Apr")) {
					if (behavior.searchFailsPr !== undefined) return Promise.reject(behavior.searchFailsPr);
					if (behavior.searchPrNoItems === true) return Promise.resolve(JSON.stringify([{}]));
					if (behavior.searchPrItems !== undefined) {
						return Promise.resolve(JSON.stringify([{ items: behavior.searchPrItems }]));
					}
					const urls =
						behavior.searchPrUrls ?? (behavior.prUrl === undefined ? [] : [behavior.prUrl]);
					return Promise.resolve(
						JSON.stringify([{ items: urls.map((html_url) => ({ html_url })) }]),
					);
				}
				if (behavior.searchFailsIssue !== undefined) {
					return Promise.reject(behavior.searchFailsIssue);
				}
				const urls =
					behavior.searchIssueUrls ?? (behavior.issueUrl === undefined ? [] : [behavior.issueUrl]);
				return Promise.resolve(JSON.stringify([{ items: urls.map((html_url) => ({ html_url })) }]));
			}
			if (args.includes("Accept: application/vnd.github.raw")) {
				const content = behavior.rawContent ?? "file content";
				return content instanceof Error ? Promise.reject(content) : Promise.resolve(content);
			}
			if (args.includes("POST") || args.includes("DELETE")) {
				return Promise.resolve("");
			}
			const endpoint = findEndpoint(args);
			if (endpoint === undefined) return Promise.resolve("");
			const pathValue = endpointPath(endpoint);
			if (PULLS_COMMENTS_PATTERN.test(pathValue)) {
				return Promise.resolve(reviewCommentsPage(behavior.comments ?? [{}]));
			}
			const issueMatch = ISSUE_BODY_PATTERN.exec(pathValue);
			if (issueMatch) {
				return Promise.resolve(
					JSON.stringify({
						body: behavior.issueBody ?? "",
						number: behavior.issueNumber ?? Number(issueMatch[1]),
						user: { login: behavior.conversationUser ?? "alice" },
					}),
				);
			}
			if (ISSUE_COMMENTS_PATTERN.test(pathValue)) {
				const body = behavior.conversationBody;
				return Promise.resolve(
					body === undefined || body === ""
						? "[]"
						: JSON.stringify([
								[
									{
										body,
										created_at: "2026-09-03T00:00:00.000Z",
										id: 3,
										user: { login: behavior.conversationUser ?? "alice" },
									},
								],
							]),
				);
			}
			return Promise.resolve("");
		}
		if (file === (behavior.providerName ?? "claude")) {
			if (args.includes("-p")) {
				const answer = behavior.answer ?? "It does something.";
				return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
			}
			return Promise.resolve("");
		}
		if (file === "git") {
			if (args[0] === "remote" && args[1] === "get-url") {
				const remote = behavior.remoteUrl ?? "https://github.com/owner/repo.git";
				return remote instanceof Error ? Promise.reject(remote) : Promise.resolve(remote);
			}
			return Promise.resolve("");
		}
		return Promise.resolve("");
	}) as unknown as Runner;

const callsOf = (runner: Runner): [string, string[]][] =>
	(runner as unknown as { mock: { calls: [string, string[]][] } }).mock.calls.map(([f, a]) => [
		f,
		a,
	]);

const silentLogger = (): Logger => () => Promise.resolve();

const collectLogger = (): {
	logger: Logger;
	events: { event: string; fields?: Record<string, unknown> }[];
} => {
	const events: { event: string; fields?: Record<string, unknown> }[] = [];
	return {
		events,
		logger: async (event, fields) => {
			events.push({ event, fields });
		},
	};
};

const mockStdoutWrite = ({ error }: { error?: Error } = {}) =>
	vi.spyOn(process.stdout, "write").mockImplementation(((
		line: unknown,
		encodingOrCallback?: unknown,
		callback?: unknown,
	) => {
		const cb =
			typeof callback === "function"
				? callback
				: typeof encodingOrCallback === "function"
					? encodingOrCallback
					: undefined;
		if (cb) {
			cb(error);
		}
		return true;
	}) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean);

describe("index", () => {
	let tempDir = "";
	let stateFile = "";

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "crewmate-index-"));
		stateFile = path.join(tempDir, "state.json");
		vi.stubEnv("XDG_CONFIG_HOME", tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { force: true, recursive: true });
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	describe("parseTarget", () => {
		it("parses PR URLs, shorthand, ports, and GHES hosts", () => {
			expect(run.parseTarget(PR_URL)).toEqual({
				host: "github.com",
				kind: "pr",
				number: "4",
				owner: "owner",
				repo: "repo",
			});
			expect(run.parseTarget("owner/repo/pull/4")).toEqual({
				host: "github.com",
				kind: "pr",
				number: "4",
				owner: "owner",
				repo: "repo",
			});
			expect(run.parseTarget("https://ghe.example.com:8443/owner/repo/pull/4")).toEqual({
				host: "ghe.example.com",
				kind: "pr",
				number: "4",
				owner: "owner",
				port: "8443",
				repo: "repo",
			});
		});

		it("parses issue URLs and shorthand", () => {
			expect(run.parseTarget(ISSUE_URL)).toEqual({
				host: "github.com",
				kind: "issue",
				number: "4",
				owner: "owner",
				repo: "repo",
			});
			expect(run.parseTarget("owner/repo/issues/4")).toEqual({
				host: "github.com",
				kind: "issue",
				number: "4",
				owner: "owner",
				repo: "repo",
			});
		});

		it("parses repo URLs and shorthand", () => {
			expect(run.parseTarget("https://github.com/owner/repo")).toEqual({
				host: "github.com",
				kind: "repo",
				owner: "owner",
				repo: "repo",
			});
			expect(run.parseTarget("owner/repo")).toEqual({
				host: "github.com",
				kind: "repo",
				owner: "owner",
				repo: "repo",
			});
			expect(run.parseTarget("owner/repo/")).toEqual({
				host: "github.com",
				kind: "repo",
				owner: "owner",
				repo: "repo",
			});
		});

		it("rejects invalid targets", () => {
			expect(() => run.parseTarget("org:myorg")).toThrow("Invalid target");
			expect(() => run.parseTarget("https://github.com/orgs/myorg")).toThrow("Invalid target");
			expect(() => run.parseTarget("https://github.com/owner")).toThrow("Invalid target");
			expect(() => run.parseTarget("https://github.com/owner/repo/pull/abc")).toThrow(
				"Invalid target",
			);
			expect(() => run.parseTarget("https://github.com/../repo")).toThrow("Invalid target");
			expect(() => run.parseTarget("https://github.com/owner/repo/pull/")).toThrow(
				"Invalid target",
			);
			expect(() => run.parseTarget("nope")).toThrow("Invalid target");
			expect(() => run.parseTarget("https://")).toThrow("Invalid target");
			expect(() => run.parseTarget("owner/repo/pull/x")).toThrow("Invalid target");
			expect(() => run.parseTarget("owner/repo/issues/x")).toThrow("Invalid target");
		});
	});

	describe("parsePrUrl", () => {
		it("parses a PR URL and rejects others", () => {
			expect(run.parsePrUrl(PR_URL)).toEqual({
				host: "github.com",
				number: "4",
				owner: "owner",
				repo: "repo",
			});
			expect(run.parsePrUrl("https://ghe.example.com:8443/o/r/pull/1").port).toBe("8443");
			expect(() => run.parsePrUrl("owner/repo")).toThrow("Invalid PR reference");
		});
	});

	describe("parseGitRemoteUrl", () => {
		it("parses https and ssh remotes", () => {
			expect(run.parseGitRemoteUrl("https://github.com/owner/repo.git")).toEqual({
				host: "github.com",
				owner: "owner",
				repo: "repo",
			});
			expect(run.parseGitRemoteUrl("git@github.com:owner/repo.git")).toEqual({
				host: "github.com",
				owner: "owner",
				repo: "repo",
			});
			expect(run.parseGitRemoteUrl("https://ghe.example.com:8443/owner/repo.git")).toEqual({
				host: "ghe.example.com",
				owner: "owner",
				port: "8443",
				repo: "repo",
			});
			expect(run.parseGitRemoteUrl("git@github.com:owner/repo")).toEqual({
				host: "github.com",
				owner: "owner",
				repo: "repo",
			});
		});

		it("returns undefined for unparsable remotes", () => {
			expect(run.parseGitRemoteUrl("https://github.com/owner/repo/extra")).toBeUndefined();
			expect(run.parseGitRemoteUrl("https://github.com/../repo")).toBeUndefined();
			expect(run.parseGitRemoteUrl(":::")).toBeUndefined();
		});
	});

	describe("parseInterval / parseTimeout / findFlag / parseSince", () => {
		it("parses intervals", () => {
			expect(run.parseInterval("30")).toBe(30);
			expect(run.parseInterval("nope")).toBe(60);
			expect(run.parseInterval("0")).toBe(60);
			expect(run.parseInterval(undefined)).toBe(60);
			expect(run.parseInterval(undefined, { fallback: undefined })).toBeUndefined();
			expect(run.parseInterval(["--interval", "45"])).toBe(45);
		});

		it("parses timeouts", () => {
			expect(run.parseTimeout(undefined)).toBeUndefined();
			expect(run.parseTimeout("120")).toBe(120);
			expect(() => run.parseTimeout("nope")).toThrow("Invalid --timeout");
			expect(() => run.parseTimeout("0")).toThrow("Invalid --timeout");
		});

		it("finds flags", () => {
			expect(run.findFlag(["--user", "alice"], "--user")).toBe("alice");
			expect(run.findFlag(["--user=alice"], "--user")).toBe("alice");
			expect(run.findFlag(["--user"], "--user")).toBeUndefined();
			expect(run.findFlag(["--other"], "--user")).toBeUndefined();
		});

		it("parses ISO-8601 since timestamps", () => {
			expect(run.parseSince(undefined)).toBeUndefined();
			expect(run.parseSince("2026-09-01")?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
			expect(run.parseSince("2026-09-01T10:30:00Z")?.toISOString()).toBe(
				"2026-09-01T10:30:00.000Z",
			);
			expect(run.parseSince("2026-09-01T10:30:00.5+02:00")?.toISOString()).toBe(
				"2026-09-01T08:30:00.500Z",
			);
			expect(run.parseSince("2026-09-01T10:30-0230")?.toISOString()).toBe(
				"2026-09-01T13:00:00.000Z",
			);
		});

		it("rejects invalid since timestamps", () => {
			for (const value of [
				"nope",
				"2026-13-01",
				"2026-02-30",
				"2026-09-01T25:00:00Z",
				"2026-09-01T10:61:00Z",
				"2026-09-01T10:30:61Z",
				"2026-09-01T10:30:00+25:00",
				"2026-09-01T10:30:00+00:61",
				"2026-09-01T10:30:00.12.3Z",
				"2026-09-01T10:30:00.abZ",
				"2026-09-01T1:30:00Z",
				"2026-09-01T10:30:00:00Z",
				"2026-09-01T10:30:00ZT10:00",
			]) {
				expect(() => run.parseSince(value)).toThrow("Invalid --since");
			}
		});
	});

	describe("fetchMentions", () => {
		it("fetches review and conversation comments for a PR", async () => {
			const runner = makeRunner({ conversationBody: "@crewmate hi" });
			const mentions = await run.fetchMentions(PR_URL, runner);
			expect(mentions.map((m) => m.kind).toSorted()).toEqual(["conversation", "review"]);
		});

		it("fetches the body and comments for an issue", async () => {
			const runner = makeRunner({ conversationBody: "@crewmate hi", issueBody: "@crewmate body" });
			const mentions = await run.fetchMentions(ISSUE_URL, runner);
			expect(mentions.map((m) => m.kind)).toEqual(["issue", "conversation"]);
		});

		it("omits a malformed issue body", async () => {
			const runner = vi.fn((file: string, args: string[]) => {
				if (file === "gh" && args[0] === "api") {
					if (ISSUE_COMMENTS_PATTERN.test(findEndpoint(args) ?? "")) return Promise.resolve("[]");
					return Promise.resolve(JSON.stringify({ number: "x" }));
				}
				return Promise.resolve("");
			}) as unknown as Runner;
			const mentions = await run.fetchMentions(ISSUE_URL, runner);
			expect(mentions).toEqual([]);
		});

		it("skips malformed comments", async () => {
			const runner = vi.fn((file: string, args: string[]) => {
				if (file === "gh" && args[0] === "api") {
					const endpoint = findEndpoint(args) ?? "";
					if (PULLS_COMMENTS_PATTERN.test(endpointPath(endpoint))) {
						return Promise.resolve(
							JSON.stringify([
								[
									{ id: "x" },
									{ body: "@crewmate hi", id: 1 },
									{ body: "x", id: 2, path: "a", line: 1 },
								],
							]),
						);
					}
					return Promise.resolve("[]");
				}
				return Promise.resolve("");
			}) as unknown as Runner;
			const mentions = await run.fetchMentions(PR_URL, runner);
			expect(mentions).toEqual([expect.objectContaining({ id: 2, kind: "review" })]);
		});

		it("rejects non-item targets", async () => {
			await expect(run.fetchMentions("owner/repo", makeRunner())).rejects.toThrow(
				"Invalid item reference",
			);
		});
	});

	describe("fetchOpenItems", () => {
		it("rejects single-item scopes", async () => {
			await expect(
				run.fetchOpenItems(run.parseTarget(PR_URL), makeRunner(), () => Promise.resolve()),
			).rejects.toThrow("single item");
		});

		it("discovers open PRs and issues through search", async () => {
			const runner = makeRunner({ prUrl: PR_URL, issueUrl: ISSUE_URL });
			const warn = vi.fn();
			const items = await run.fetchOpenItems(run.parseTarget("owner/repo"), runner, warn);
			expect(items).toEqual([PR_URL, ISSUE_URL]);
		});

		it("searches without the open-state filter when includeClosed is set", async () => {
			const runner = makeRunner({ prUrl: PR_URL, issueUrl: ISSUE_URL });
			const items = await run.fetchOpenItems(
				run.parseTarget("owner/repo"),
				runner,
				() => Promise.resolve(),
				true,
			);
			expect(items).toEqual([PR_URL, ISSUE_URL]);
			const queries = callsOf(runner)
				.flatMap(([, args]) => args)
				.filter((arg) => arg.startsWith("search/issues?q="));
			expect(queries).toHaveLength(2);
			expect(queries.some((query) => query.includes("is%3Aopen"))).toBe(false);
		});

		it("uses state=all in the repo fallback when includeClosed is set", async () => {
			const notFound = new Error("HTTP 404: Not Found");
			const runner = vi.fn((file: string, args: string[]) => {
				if (file === "gh" && args[0] === "api") {
					const searchArg = args.find((arg) => arg.startsWith("search/issues?q="));
					if (searchArg !== undefined) return Promise.reject(notFound);
					return Promise.resolve(JSON.stringify([[{ html_url: PR_URL }]]));
				}
				return Promise.resolve("");
			}) as unknown as Runner;
			const items = await run.fetchOpenItems(
				run.parseTarget("owner/repo"),
				runner,
				() => Promise.resolve(),
				true,
			);
			expect(items).toEqual([PR_URL]);
			expect(
				callsOf(runner)
					.flatMap(([, args]) => args)
					.some((arg) => arg.includes("issues?state=all")),
			).toBe(true);
		});

		it("dedupes and warns about invalid search URLs", async () => {
			const runner = makeRunner({ searchPrUrls: [PR_URL, PR_URL, "not a url"] });
			const warn = vi.fn();
			const items = await run.fetchOpenItems(run.parseTarget("owner/repo"), runner, warn);
			expect(items).toEqual([PR_URL]);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("invalid item URL from search"),
				expect.objectContaining({ reason: "search-invalid-url" }),
			);
		});

		it("warns about token scope on 403 and 422", async () => {
			for (const status of [403, 422]) {
				const runner = makeRunner({
					prUrl: PR_URL,
					searchFailsIssue: new Error(`HTTP ${status}`),
				});
				const warn = vi.fn();
				await run.fetchOpenItems(run.parseTarget("owner/repo"), runner, warn);
				expect(warn).toHaveBeenCalledWith(
					"Search failed; verify the token can read private repos on this host",
					expect.objectContaining({ reason: "search-token-scope" }),
				);
			}
		});

		it("warns about generic search failures", async () => {
			const runner = makeRunner({ searchFailsPr: new Error("HTTP 500: boom") });
			const warn = vi.fn();
			await run.fetchOpenItems(run.parseTarget("owner/repo"), runner, warn);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("search failed"),
				expect.objectContaining({ reason: "search-failed" }),
			);
		});

		it("falls back to the issues endpoint when search is unavailable", async () => {
			const notFound = new Error("HTTP 404: Not Found");
			const runner = vi.fn((file: string, args: string[]) => {
				if (file === "gh" && args[0] === "api") {
					const searchArg = args.find((arg) => arg.startsWith("search/issues?q="));
					if (searchArg !== undefined) return Promise.reject(notFound);
					return Promise.resolve(
						JSON.stringify([[{ html_url: PR_URL }, { html_url: "not a url" }, {}]]),
					);
				}
				return Promise.resolve("");
			}) as unknown as Runner;
			const warn = vi.fn();
			const items = await run.fetchOpenItems(run.parseTarget("owner/repo"), runner, warn);
			expect(items).toEqual([PR_URL]);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("invalid item URL from repo fallback"),
				expect.objectContaining({ reason: "fallback-invalid-url" }),
			);
		});

		it("warns when the repo fallback itself fails", async () => {
			const notFound = new Error("HTTP 404: Not Found");
			const runner = vi.fn((file: string, args: string[]) => {
				if (file === "gh" && args[0] === "api") {
					return Promise.reject(
						args.some((arg) => arg.startsWith("search/issues?q="))
							? notFound
							: new Error("HTTP 500: boom"),
					);
				}
				return Promise.resolve("");
			}) as unknown as Runner;
			const warn = vi.fn();
			const items = await run.fetchOpenItems(run.parseTarget("owner/repo"), runner, warn);
			expect(items).toEqual([]);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("repo fallback failed"),
				expect.objectContaining({ reason: "repo-fallback-failed" }),
			);
		});

		it("returns an empty list when nothing is open", async () => {
			const runner = makeRunner();
			const items = await run.fetchOpenItems(run.parseTarget("owner/repo"), runner, () =>
				Promise.resolve(),
			);
			expect(items).toEqual([]);
		});
	});

	describe("findNewMentions", () => {
		it("filters closed, replied, foreign, and prefix comments", () => {
			const comments = [
				mention({ id: 1 }),
				mention({ id: 2, body: "no mention" }),
				mention({ id: 3, body: `${CREWMATE_PREFIX} answer` }),
				mention({ id: 4, inReplyToId: 1 }),
				mention({ id: 5, user: { login: "mallory" } }),
			];
			expect(run.findNewMentions(comments, [], "alice").map((m) => m.id)).toEqual([1]);
			expect(run.findNewMentions(comments, ["review:1"], "alice")).toEqual([]);
			expect(run.findNewMentions(comments, [], undefined).map((m) => m.id)).toEqual([5, 1]);
		});

		it("applies the since filter and sorts newest first", () => {
			const comments = [
				mention({ id: 1, createdAt: "2026-09-01T00:00:00Z" }),
				mention({ id: 2, createdAt: "2026-09-03T00:00:00Z" }),
				mention({ id: 3, createdAt: "not a date" }),
				mention({ id: 4 }),
			];
			const since = new Date("2026-09-02T00:00:00Z");
			expect(run.findNewMentions(comments, [], "alice", false, since).map((m) => m.id)).toEqual([
				4, 2,
			]);
		});

		it("findNewMention returns the newest", () => {
			const comments = [mention({ id: 1 }), mention({ id: 2 })];
			expect(run.findNewMention(comments, [], "alice")?.id).toBe(2);
		});

		it("treats crewmate-replied review comments as handled on fresh state", () => {
			const comments = [
				mention({ id: 1 }),
				mention({ id: 2, body: `${CREWMATE_PREFIX} done`, inReplyToId: 1 }),
			];
			expect(run.findNewMentions(comments, [], "alice", true)).toEqual([]);
			expect(run.findNewMentions(comments, [], "alice", false).map((m) => m.id)).toEqual([1]);
		});
	});

	describe("watch", () => {
		it("passes --closed through to repo-scope queries from the CLI", async () => {
			const runner = makeRunner({ prUrl: PR_URL });
			await run(["watch", "owner/repo", "--closed"], {
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const queries = callsOf(runner)
				.flatMap(([, args]) => args)
				.filter((arg) => arg.startsWith("search/issues?q="));
			expect(queries).toHaveLength(2);
			expect(queries.some((query) => query.includes("is%3Aopen"))).toBe(false);
		});

		it("answers a new mention and records the job as succeeded", async () => {
			const runner = makeRunner();
			await run.watch(PR_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const calls = callsOf(runner);
			expect(calls.find(([, a]) => a.includes("content=eyes"))).toBeDefined();
			expect(
				calls.find(([, a]) =>
					a.some((x) => typeof x === "string" && x.startsWith(`body=${CREWMATE_PREFIX}`)),
				),
			).toBeDefined();
			const state = await run.loadState(stateFile);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
			expect(state.get(PR_URL)?.get("review:1")?.attempts).toBe(1);
		});

		it("skips closed jobs on the next run", async () => {
			const runner = makeRunner();
			const options = {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			};
			await run.watch(PR_URL, options);
			const before = callsOf(runner).length;
			await run.watch(PR_URL, options);
			const after = callsOf(runner).slice(before);
			expect(
				after.find(([, a]) => a.some((x) => typeof x === "string" && x.startsWith("body="))),
			).toBeUndefined();
		});

		it("marks failures for retry and retries them when due", async () => {
			const runner = makeRunner({ answer: new Error("provider down") });
			const options = {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			};
			await run.watch(PR_URL, options);
			let state = await run.loadState(stateFile);
			const failed = state.get(PR_URL)?.get("review:1");
			expect(failed?.status).toBe("failed");
			expect(failed?.attempts).toBe(1);
			expect(typeof failed?.nextAttemptAt).toBe("string");

			await run.watch(PR_URL, options);
			state = await run.loadState(stateFile);
			expect(state.get(PR_URL)?.get("review:1")?.attempts).toBe(1);

			const due = state.get(PR_URL)!;
			due.set("review:1", { ...failed!, nextAttemptAt: "2000-01-01T00:00:00.000Z" });
			await run.saveState(state, stateFile);
			const recovering = makeRunner({ answer: "fixed" });
			await run.watch(PR_URL, { ...options, runner: recovering });
			state = await run.loadState(stateFile);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
			expect(state.get(PR_URL)?.get("review:1")?.attempts).toBe(2);
		});

		it("posts a failure reply after the final attempt", async () => {
			const runner = makeRunner({ answer: new Error("provider down") });
			const options = {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			};
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const state = await run.loadState(stateFile);
				const job = state.get(PR_URL)?.get("review:1");
				if (job !== undefined) {
					state.get(PR_URL)!.set("review:1", { ...job, nextAttemptAt: "2000-01-01T00:00:00.000Z" });
					await run.saveState(state, stateFile);
				}
				await run.watch(PR_URL, options);
			}
			const state = await run.loadState(stateFile);
			const failed = state.get(PR_URL)?.get("review:1");
			expect(failed?.status).toBe("failed");
			expect(failed?.attempts).toBe(3);
			expect(failed?.nextAttemptAt).toBeUndefined();
			const calls = callsOf(runner);
			expect(
				calls.find(([, a]) =>
					a.some((x) => typeof x === "string" && x.includes("Failed to respond after 3 attempts")),
				),
			).toBeDefined();

			const before = callsOf(runner).length;
			await run.watch(PR_URL, options);
			expect(
				callsOf(runner)
					.slice(before)
					.find(([f, a]) => f === "claude" && a.includes("-p")),
			).toBeUndefined();
		});

		it("warns when the failure reply itself fails", async () => {
			const { logger, events } = collectLogger();
			const base = makeRunner({ answer: new Error("provider down") });
			const runner = vi.fn((file: string, args: string[]) => {
				if (
					args.includes("POST") &&
					args.some((a) => typeof a === "string" && a.startsWith("body="))
				) {
					return Promise.reject(new Error("cannot comment"));
				}
				return (base as unknown as (...a: unknown[]) => Promise<string>)(file, args);
			}) as unknown as Runner;
			const state = run.loadState ? await run.loadState(stateFile) : new Map();
			state.set(
				PR_URL,
				new Map([
					[
						"review:1",
						{
							attempts: 2,
							nextAttemptAt: "2000-01-01T00:00:00.000Z",
							status: "failed",
							updatedAt: "2026-09-01T00:00:00.000Z",
						},
					],
				]),
			);
			await run.saveState(state, stateFile);
			await run.watch(PR_URL, { config: {}, iterations: 1, logger, runner, stateFile });
			expect(events).toContainEqual({
				event: "warning",
				fields: expect.objectContaining({ reason: "failure-reply-failed" }),
			});
		});

		it("previews without side effects in dry-run mode", async () => {
			const stdout = mockStdoutWrite();
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runner = makeRunner();
			await run.watch(PR_URL, {
				config: {},
				dryRun: true,
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			expect(stdout).toHaveBeenCalledWith(
				expect.stringContaining("[dry-run] would reply to comment 1"),
			);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Dry-run mode"));
			expect(await run.loadState(stateFile)).toEqual(new Map());
		});

		it("mirrors the dry-run notice through the logger only when --log is set", async () => {
			mockStdoutWrite();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const { logger, events } = collectLogger();
			const runner = makeRunner();
			await run.watch(PR_URL, {
				config: {},
				dryRun: true,
				iterations: 1,
				logger,
				runner,
				stateFile,
				toStderr: true,
			});
			expect(events).toContainEqual({
				event: "info",
				fields: expect.objectContaining({ message: expect.stringContaining("Dry-run mode") }),
			});
		});

		it("pre-marks review comments already answered by crewmate on fresh state", async () => {
			const runner = makeRunner({
				comments: [{ id: 1 }, { body: `${CREWMATE_PREFIX} done`, id: 2, inReplyToId: 1 }],
			});
			await run.watch(PR_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const calls = callsOf(runner);
			expect(calls.find(([f, a]) => f === "claude" && a.includes("-p"))).toBeUndefined();
			const state = await run.loadState(stateFile);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
		});

		it("emits debug stages when debug is enabled", async () => {
			const { logger, events } = collectLogger();
			const runner = makeRunner();
			await run.watch(PR_URL, {
				config: {},
				debug: true,
				iterations: 1,
				logger,
				runner,
				since: new Date("2026-01-01T00:00:00Z"),
				stateFile,
			});
			const stages = events.filter((e) => e.event === "debug").map((e) => e.fields?.stage);
			expect(stages).toEqual(["fetched-comments", "mention-filter", "new-mentions"]);
		});

		it("recovers from a corrupted state file", async () => {
			const { logger, events } = collectLogger();
			await writeFile(stateFile, "corrupted{");
			const runner = makeRunner();
			await run.watch(PR_URL, { config: {}, iterations: 1, logger, runner, stateFile });
			expect(events).toContainEqual({
				event: "warning",
				fields: expect.objectContaining({ reason: "state-corrupted" }),
			});
		});

		it("answers issue mentions", async () => {
			const runner = makeRunner({ issueBody: "@crewmate summarize", conversationBody: "" });
			await run.watch(ISSUE_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const state = await run.loadState(stateFile);
			expect(state.get(ISSUE_URL)?.get("issue:4")?.status).toBe("succeeded");
		});

		it("polls every open item in repo scope", async () => {
			const runner = makeRunner({ prUrl: PR_URL, issueUrl: ISSUE_URL, issueBody: "@crewmate hi" });
			await run.watch("owner/repo", {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const state = await run.loadState(stateFile);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
			expect(state.get(ISSUE_URL)?.get("issue:4")?.status).toBe("succeeded");
		});

		it("warns once when no open items are found", async () => {
			const { logger, events } = collectLogger();
			const runner = makeRunner();
			await run.watch("owner/repo", {
				config: {},
				iterations: 2,
				interval: 0,
				logger,
				runner,
				stateFile,
			});
			const warnings = events.filter(
				(e) => e.event === "warning" && e.fields?.reason === "no-open-items",
			);
			expect(warnings.length).toBe(1);
		});

		it("rethrows poll failures for single items", async () => {
			const base = makeRunner();
			const runner = vi.fn((file: string, args: string[]) => {
				if (
					file === "gh" &&
					args[0] === "api" &&
					PULLS_COMMENTS_PATTERN.test(endpointPath(findEndpoint(args) ?? ""))
				) {
					return Promise.reject(new Error("HTTP 500: boom"));
				}
				return (base as unknown as (...a: unknown[]) => Promise<string>)(file, args);
			}) as unknown as Runner;
			const { logger, events } = collectLogger();
			await expect(
				run.watch(PR_URL, { config: {}, iterations: 1, logger, runner, stateFile }),
			).rejects.toThrow("HTTP 500: boom");
			expect(events).toContainEqual({
				event: "warning",
				fields: expect.objectContaining({ reason: "poll-failed" }),
			});
			expect(events.some((e) => e.event === "error")).toBe(true);
		});

		it("continues after an item failure in repo scope", async () => {
			const base = makeRunner({ prUrl: PR_URL, issueUrl: ISSUE_URL, issueBody: "@crewmate hi" });
			let callCount = 0;
			const runner = vi.fn((file: string, args: string[]) => {
				if (file === "gh" && args[0] === "api") {
					const endpoint = findEndpoint(args) ?? "";
					if (PULLS_COMMENTS_PATTERN.test(endpointPath(endpoint))) {
						callCount += 1;
						return Promise.reject(new Error("HTTP 500: boom"));
					}
				}
				return (base as unknown as (...a: unknown[]) => Promise<string>)(file, args);
			}) as unknown as Runner;
			await run.watch("owner/repo", {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			expect(callCount).toBe(1);
			const state = await run.loadState(stateFile);
			expect(state.get(ISSUE_URL)?.get("issue:4")?.status).toBe("succeeded");
		});

		it("refuses to start when the lock is held", async () => {
			const { acquireLock } = await import("./state.js");
			const release = await acquireLock({ dir: tempDir });
			await expect(
				run.watch(PR_URL, {
					config: {},
					iterations: 1,
					logger: silentLogger(),
					runner: makeRunner(),
					stateFile,
				}),
			).rejects.toThrow("already running");
			await release();
			await run.watch(PR_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner: makeRunner(),
				stateFile,
			});
		});

		it("requires a resolvable user filter", async () => {
			const runner = makeRunner({ failUserLookup: true });
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			await expect(
				run.watch(PR_URL, { config: {}, iterations: 1, logger: silentLogger(), runner, stateFile }),
			).rejects.toThrow("Could not determine a GitHub user");
		});

		it("warns when filtering for a different user than the gh login", async () => {
			const { logger, events } = collectLogger();
			const runner = makeRunner({ ghUser: "alice" });
			await run.watch(PR_URL, {
				allowedUser: "bob",
				config: {},
				iterations: 1,
				logger,
				runner,
				stateFile,
			});
			expect(events).toContainEqual({
				event: "warning",
				fields: expect.objectContaining({ reason: "user-filter-override" }),
			});
		});

		it("ignores mentions from other users by default and honors unsafeNoUser", async () => {
			const runner = makeRunner({ comments: [{ user: "mallory" }] });
			await run.watch(PR_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			expect(callsOf(runner).find(([f, a]) => f === "claude" && a.includes("-p"))).toBeUndefined();

			const openRunner = makeRunner({ comments: [{ user: "mallory" }] });
			await run.watch(PR_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner: openRunner,
				stateFile: path.join(tempDir, "other-state.json"),
				unsafeNoUser: true,
			});
			expect(
				callsOf(openRunner).find(([f, a]) => f === "claude" && a.includes("-p")),
			).toBeDefined();
		});

		it("uses the configured provider, model, prompt, and timeout", async () => {
			const runner = makeRunner({ providerName: "my-llm" });
			await run.watch(PR_URL, {
				config: { model: "opus", prompt: "Be terse", provider: "my-llm", timeoutSeconds: 5 },
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const calls = callsOf(runner);
			const versionCheck = calls.find(([f, a]) => f === "my-llm" && a.includes("--version"));
			expect(versionCheck).toBeDefined();
			const promptCall = calls.find(([f, a]) => f === "my-llm" && a.includes("-p"));
			expect(promptCall?.[1]).toContain("--model");
			expect(promptCall?.[1].at(-1)).toContain("Be terse");
		});

		it("rejects an invalid item reference from repo scope results", async () => {
			const runner = makeRunner({ searchPrUrls: ["https://github.com/owner/repo"] });
			const { logger } = collectLogger();
			await run.watch("owner/repo", {
				config: {},
				iterations: 1,
				logger,
				runner,
				stateFile,
			});
		});
	});

	describe("stream", () => {
		it("emits NDJSON events for new mentions", async () => {
			const stdout = mockStdoutWrite();
			const runner = makeRunner({ conversationBody: "@crewmate hi" });
			await run.stream(PR_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const lines = stdout.mock.calls
				.map(([line]) => String(line))
				.filter((line) => line.includes('"event":"mention"'));
			expect(lines.length).toBe(2);
			const reviewEvent = JSON.parse(lines.find((l) => l.includes('"kind":"review"'))!);
			expect(reviewEvent).toMatchObject({
				commentId: 1,
				kind: "review",
				line: 5,
				number: 4,
				owner: "owner",
				path: "src/index.ts",
				repo: "repo",
				url: PR_URL,
				user: "alice",
			});
			const state = await run.loadState(stateFile);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
		});

		it("acks mentions with an eyes reaction and emits the reactionId", async () => {
			const stdout = mockStdoutWrite();
			const runner = makeRunner();
			await run.stream(PR_URL, {
				ack: true,
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const lines = stdout.mock.calls
				.map(([line]) => String(line))
				.filter((line) => line.includes('"event":"mention"'));
			expect(JSON.parse(lines[0]).reactionId).toBeTypeOf("number");
			expect(callsOf(runner).find(([, a]) => a.includes("content=eyes"))).toBeDefined();
		});

		it("appends events to an output file", async () => {
			mockStdoutWrite();
			const outputFile = path.join(tempDir, "out", "events.ndjson");
			const runner = makeRunner();
			await run.stream(PR_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				outputFile,
				runner,
				stateFile,
			});
			const content = await readFile(outputFile, "utf8");
			expect(content).toContain('"event":"mention"');
		});

		it("treats output failures as fatal and leaves the job running for retry", async () => {
			mockStdoutWrite();
			const outputFile = path.join(tempDir, "blocked", "events.ndjson");
			await mkdir(path.dirname(outputFile), { recursive: true });
			await writeFile(outputFile, "x");
			await chmod(outputFile, 0o400);
			const runner = makeRunner();
			await expect(
				run.stream(PR_URL, {
					config: {},
					iterations: 1,
					logger: silentLogger(),
					outputFile,
					runner,
					stateFile,
				}),
			).rejects.toThrow("output file write failed");
			const state = await run.loadState(stateFile);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("running");
			await chmod(outputFile, 0o600);

			await run.stream(PR_URL, {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				outputFile,
				runner,
				stateFile,
			});
			const after = await run.loadState(stateFile);
			expect(after.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
		});

		it("does not re-emit succeeded mentions", async () => {
			const stdout = mockStdoutWrite();
			const options = {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner: makeRunner(),
				stateFile,
			};
			await run.stream(PR_URL, options);
			const count = stdout.mock.calls.filter(([line]) =>
				String(line).includes('"event":"mention"'),
			).length;
			await run.stream(PR_URL, options);
			const after = stdout.mock.calls.filter(([line]) =>
				String(line).includes('"event":"mention"'),
			).length;
			expect(after).toBe(count);
		});
	});

	describe("cli", () => {
		it("prints the version", async () => {
			const stdout = mockStdoutWrite();
			await run(["--version"]);
			expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/^crewmate\//));
		});

		it("prints help for no args, --help, and subcommand help", async () => {
			const stdout = mockStdoutWrite();
			await run([]);
			await run(["--help"]);
			await run(["watch", "--help"]);
			await run(["stream", "-h"]);
			expect(stdout.mock.calls.length).toBeGreaterThanOrEqual(4);
		});

		it("renders help with ANSI styles on a TTY", async () => {
			const originalIsTTY = process.stdout.isTTY;
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			const stdout = mockStdoutWrite();
			await run(["--help"]);
			expect(stdout).toHaveBeenCalledWith(expect.stringContaining("\x1b[1m"));
			Object.defineProperty(process.stdout, "isTTY", {
				value: originalIsTTY,
				configurable: true,
			});
		});

		it("fails on an unknown command", async () => {
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			await run(["init"]);
			expect(process.exitCode).toBe(1);
			expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Unknown command 'init'"));
		});

		it("warns about unsupported watch flags", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const { logger, events } = collectLogger();
			const runner = makeRunner();
			await run(
				["watch", PR_URL, "--ack", "--json", "--since", "2026-01-01", "--output-file", "x"],
				{
					iterations: 1,
					logger,
					runner,
					stateFile,
				},
			);
			const flagged = events
				.filter((e) => e.event === "warning" && e.fields?.message === "unsupported flag")
				.map((e) => e.fields?.flag);
			expect(flagged).toEqual(["--ack", "--json", "--output-file", "--since"]);
		});

		it("warns about unsupported stream flags", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			mockStdoutWrite();
			const { logger, events } = collectLogger();
			const runner = makeRunner();
			await run(
				[
					"stream",
					PR_URL,
					"--fix",
					"--dry-run",
					"--json",
					"--model",
					"x",
					"--provider",
					"y",
					"--prompt",
					"z",
					"--timeout",
					"5",
				],
				{ iterations: 1, logger, runner, stateFile },
			);
			const flagged = events
				.filter((e) => e.event === "warning" && e.fields?.message === "unsupported flag")
				.map((e) => e.fields?.flag);
			expect(flagged).toEqual([
				"--fix",
				"--dry-run",
				"--json",
				"--model",
				"--provider",
				"--prompt",
				"--timeout",
			]);
		});

		it("rejects a valueless --output-file", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			await run(["stream", PR_URL, "--output-file"], { runner: makeRunner(), stateFile });
			expect(process.exitCode).toBe(1);
		});

		it("rejects an empty --output-file value", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			await run(["stream", PR_URL, "--output-file="], { runner: makeRunner(), stateFile });
			expect(process.exitCode).toBe(1);
		});

		it("rejects a valueless --since", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			await run(["stream", PR_URL, "--since"], { runner: makeRunner(), stateFile });
			expect(process.exitCode).toBe(1);
		});

		it("resolves the default target from the git remote", async () => {
			mockStdoutWrite();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runner = makeRunner({ prUrl: PR_URL });
			await run(["watch"], {
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const state = await run.loadState(stateFile);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
		});

		it("fails when no target can be resolved", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runner = makeRunner({ remoteUrl: new Error("no remote") });
			await run(["watch"], { iterations: 1, logger: silentLogger(), runner, stateFile });
			expect(process.exitCode).toBe(1);
			const runner2 = makeRunner({ remoteUrl: "not-a-url" });
			await run(["stream"], { iterations: 1, logger: silentLogger(), runner: runner2, stateFile });
			expect(process.exitCode).toBe(1);
		});

		it("passes --closed through to repo-scope queries from the CLI", async () => {
			mockStdoutWrite();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runner = makeRunner({ prUrl: PR_URL });
			await run(["stream", "owner/repo", "--closed"], {
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			const queries = callsOf(runner)
				.flatMap(([, args]) => args)
				.filter((arg) => arg.startsWith("search/issues?q="));
			expect(queries).toHaveLength(2);
			expect(queries.some((query) => query.includes("is%3Aopen"))).toBe(false);
		});

		it("runs stream from the CLI", async () => {
			const stdout = mockStdoutWrite();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runner = makeRunner();
			await run(["stream", PR_URL, "--ack"], {
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			expect(
				stdout.mock.calls.filter(([line]) => String(line).includes('"event":"mention"')).length,
			).toBe(1);
		});

		it("exits cleanly on EPIPE", async () => {
			const epipe = new Error("write EPIPE") as NodeJS.ErrnoException;
			epipe.code = "EPIPE";
			mockStdoutWrite({ error: epipe });
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runner = makeRunner();
			await run(["stream", PR_URL], {
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			expect(process.exitCode).toBe(0);
		});

		it("fails on other stdout errors", async () => {
			mockStdoutWrite({ error: new Error("disk full") });
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runner = makeRunner();
			await run(["stream", PR_URL], {
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			expect(process.exitCode).toBe(1);
		});

		it("fails when gh authentication is missing", async () => {
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runner = makeRunner({ failAuth: true });
			await run(["watch", PR_URL], {
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			expect(process.exitCode).toBe(1);
		});

		it("retries gh auth against the plain host on GHES ports", async () => {
			mockStdoutWrite();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			let authCalls = 0;
			const base = makeRunner();
			const runner = vi.fn((file: string, args: string[]) => {
				if (file === "gh" && args[0] === "auth") {
					authCalls += 1;
					return authCalls === 1 ? Promise.reject(new Error("x")) : Promise.resolve("");
				}
				return (base as unknown as (...a: unknown[]) => Promise<string>)(file, args);
			}) as unknown as Runner;
			await run(["watch", "https://ghe.example.com:8443/owner/repo/pull/4"], {
				config: {},
				iterations: 1,
				logger: silentLogger(),
				runner,
				stateFile,
			});
			expect(authCalls).toBe(2);
		});

		it("loads the config file when no config is injected", async () => {
			mockStdoutWrite();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			await mkdir(path.join(tempDir, "crewmate"), { recursive: true });
			await writeFile(
				path.join(tempDir, "crewmate", "config.json"),
				JSON.stringify({ debug: true, log: false, unsafeNoUser: true }),
			);
			const { logger, events } = collectLogger();
			const runner = makeRunner();
			await run(["watch", PR_URL], { iterations: 1, logger, runner, stateFile });
			expect(events.some((e) => e.event === "debug")).toBe(true);
		});

		it("imports bin.js without side effects beyond run", async () => {
			mockStdoutWrite();
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			process.argv = [process.argv[0], "bin.js", "--version"];
			await import("./bin.js");
			expect(process.exitCode).toBeUndefined();
		});
	});

	describe("hardening coverage", () => {
		let hardenDir = "";
		let hardenState = "";

		beforeEach(async () => {
			hardenDir = await mkdtemp(path.join(tmpdir(), "crewmate-cov-"));
			hardenState = path.join(hardenDir, "state.json");
		});

		afterEach(async () => {
			await rm(hardenDir, { force: true, recursive: true });
			vi.unstubAllEnvs();
		});

		it("treats EPIPE on stdout as a clean stop and other stdout errors as failures", () => {
			const previousExitCode = process.exitCode;
			process.exitCode = undefined;
			const epipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
			expect(() => process.stdout.emit("error", epipeError)).not.toThrow();
			expect(process.exitCode).toBe(0);
			expect(() => process.stdout.emit("error", new Error("boom"))).not.toThrow();
			expect(process.exitCode).toBe(1);
			process.exitCode = previousExitCode;
		});

		it("runs commands through the system runner", async () => {
			await expect(run.exec("node", ["-e", "console.log('hi')"])).resolves.toBe("hi\n");
			await expect(
				run.exec("node", ["-e", "console.log(process.env.FOO)"], { env: { FOO: "bar" } }),
			).resolves.toBe("bar\n");
			await expect(
				run.exec("node", ["-e", "setTimeout(() => {}, 100000)"], { timeoutMs: 50 }),
			).rejects.toThrow();
			await expect(run.exec("node", ["-e", "process.exit(3)"])).rejects.toThrow();
		});

		it("rejects remote URLs with invalid owner names", () => {
			expect(run.parseGitRemoteUrl("https://github.com/a%20b/repo")).toBeUndefined();
		});

		it("parses issue and repo URLs on hosts with a port", () => {
			expect(run.parseTarget("https://ghe.example.com:8443/owner/repo/issues/4")).toEqual({
				host: "ghe.example.com",
				kind: "issue",
				number: "4",
				owner: "owner",
				port: "8443",
				repo: "repo",
			});
			expect(run.parseTarget("https://ghe.example.com:8443/owner/repo")).toEqual({
				host: "ghe.example.com",
				kind: "repo",
				owner: "owner",
				port: "8443",
				repo: "repo",
			});
		});

		it("fails when the git remote is empty", async () => {
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const previousExitCode = process.exitCode;
			process.exitCode = undefined;
			try {
				await run(["watch"], {
					iterations: 1,
					lockDir: hardenDir,
					logger: silentLogger(),
					runner: makeRunner({ remoteUrl: "" }),
					stateFile: hardenState,
				});
				expect(process.exitCode).toBe(1);
				expect(write).toHaveBeenCalledWith(expect.stringContaining("Target is required"));
			} finally {
				process.exitCode = previousExitCode;
				write.mockRestore();
			}
		});

		it("fails when no user can be determined for filtering", async () => {
			const runner = makeRunner({ ghUser: "" });
			await expect(
				run.watch(PR_URL, {
					iterations: 1,
					lockDir: hardenDir,
					logger: silentLogger(),
					runner,
					stateFile: hardenState,
				}),
			).rejects.toThrow("Could not determine a GitHub user");
		});

		it("handles search pages without items", async () => {
			const runner = makeRunner({ searchPrNoItems: true });
			await run.watch("https://github.com/owner/repo", {
				iterations: 1,
				lockDir: hardenDir,
				logger: silentLogger(),
				runner,
				stateFile: hardenState,
			});
			const state = await run.loadState(hardenState);
			expect(state.size).toBe(0);
		});

		it("warns about forbidden searches and skips unparseable search failures", async () => {
			const runner = makeRunner({
				searchFailsIssue: new Error("network down"),
				searchFailsPr: new Error("HTTP 403: forbidden"),
			});
			await run.watch("https://github.com/owner/repo", {
				iterations: 1,
				lockDir: hardenDir,
				logger: silentLogger(),
				runner,
				stateFile: hardenState,
			});
			const state = await run.loadState(hardenState);
			expect(state.size).toBe(0);
		});

		it("warns about unprocessable searches", async () => {
			const runner = makeRunner({
				searchFailsIssue: new Error("HTTP 422: unprocessable"),
				searchFailsPr: new Error("HTTP 422: unprocessable"),
			});
			await run.watch("https://github.com/owner/repo", {
				iterations: 1,
				lockDir: hardenDir,
				logger: silentLogger(),
				runner,
				stateFile: hardenState,
			});
		});

		it("writes a dry-run notice to stderr and uses default state and log paths", async () => {
			vi.stubEnv("XDG_CONFIG_HOME", hardenDir);
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				await run.watch(PR_URL, { dryRun: true, iterations: 1, runner: makeRunner() });
				expect(write).toHaveBeenCalledWith(expect.stringContaining("Dry-run mode"));
			} finally {
				write.mockRestore();
			}
		});

		it("ignores stderr write failures for the dry-run notice", async () => {
			vi.stubEnv("XDG_CONFIG_HOME", hardenDir);
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
				throw new Error("stderr closed");
			});
			try {
				await run.watch(PR_URL, { dryRun: true, iterations: 1, runner: makeRunner() });
			} finally {
				write.mockRestore();
			}
		});

		it("streams with the default state path", async () => {
			vi.stubEnv("XDG_CONFIG_HOME", hardenDir);
			mockStdoutWrite();
			try {
				await run.stream(PR_URL, { iterations: 1, logger: silentLogger(), runner: makeRunner() });
				const state = await run.loadState(path.join(hardenDir, "crewmate", "state.json"));
				expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("streams issue mentions with the issue number as comment id", async () => {
			const write = mockStdoutWrite();
			const runner = makeRunner({ issueBody: "@crewmate hi" });
			await run.stream(ISSUE_URL, {
				ack: true,
				iterations: 1,
				lockDir: hardenDir,
				logger: silentLogger(),
				runner,
				stateFile: hardenState,
			});
			const event = JSON.parse(write.mock.calls[0][0] as string) as Record<string, unknown>;
			expect(event.kind).toBe("issue");
			expect(event.commentId).toBe(4);
			write.mockRestore();
		});

		it("warns when the ack reaction returns an unusable response", async () => {
			mockStdoutWrite();
			const messages: string[] = [];
			const logger: Logger = (level, fields) => {
				if (level === "warning") messages.push(String(fields?.message));
				return Promise.resolve();
			};
			for (const reactionResponse of ["", "{}", "not json", new Error("ack refused")]) {
				messages.length = 0;
				await run.stream(PR_URL, {
					ack: true,
					iterations: 1,
					lockDir: hardenDir,
					logger,
					runner: makeRunner({ reactionResponse }),
					stateFile: hardenState,
				});
				expect(messages.some((m) => m.startsWith("failed to set ack reaction"))).toBe(true);
				await rm(hardenState, { force: true });
			}
		});

		it("honors the log profile setting", async () => {
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				await run.watch(PR_URL, {
					config: { log: true },
					iterations: 1,
					lockDir: hardenDir,
					runner: makeRunner(),
					stateFile: hardenState,
				});
				expect(write).toHaveBeenCalled();
			} finally {
				write.mockRestore();
			}
		});

		it("passes watch flags through", async () => {
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const previousExitCode = process.exitCode;
			process.exitCode = undefined;
			try {
				await run(
					[
						"watch",
						PR_URL,
						"--log",
						"--debug",
						"--dry-run",
						"--unsafe-no-user",
						"--user",
						"alice",
						"--prompt",
						"be terse",
						"--model",
						"m",
						"--provider",
						"claude",
						"--timeout",
						"5",
						"--interval",
						"3",
					],
					{ iterations: 1, lockDir: hardenDir, runner: makeRunner(), stateFile: hardenState },
				);
				expect(process.exitCode).toBeUndefined();
			} finally {
				process.exitCode = previousExitCode;
				write.mockRestore();
			}
		});

		it("passes stream flags through", async () => {
			mockStdoutWrite();
			const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const previousExitCode = process.exitCode;
			process.exitCode = undefined;
			const outputFile = path.join(hardenDir, "events.ndjson");
			try {
				await run(
					[
						"stream",
						PR_URL,
						"--log",
						"--debug",
						"--ack",
						"--unsafe-no-user",
						"--user",
						"alice",
						"--interval",
						"2",
						"--since",
						"2026-09-01T00:00:00.000Z",
						"--output-file",
						outputFile,
					],
					{ iterations: 1, lockDir: hardenDir, runner: makeRunner(), stateFile: hardenState },
				);
				expect(process.exitCode).toBeUndefined();
				const content = await readFile(outputFile, "utf8");
				expect(content).toContain('"event":"mention"');
			} finally {
				process.exitCode = previousExitCode;
				stderrWrite.mockRestore();
			}
		});

		it("uses the system runner when none is injected", async () => {
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const previousExitCode = process.exitCode;
			process.exitCode = undefined;
			try {
				await run(["watch", "https://ghe.invalid.example/owner/repo/pull/4"], {
					iterations: 1,
					lockDir: hardenDir,
					logger: silentLogger(),
					stateFile: hardenState,
				});
				expect(process.exitCode).toBe(1);
				await run(["stream", "https://ghe.invalid.example/owner/repo/pull/4"], {
					iterations: 1,
					lockDir: hardenDir,
					logger: silentLogger(),
					stateFile: hardenState,
				});
				expect(process.exitCode).toBe(1);
			} finally {
				process.exitCode = previousExitCode;
				write.mockRestore();
			}
		});

		it("stringifies non-Error failures", async () => {
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const previousExitCode = process.exitCode;
			process.exitCode = undefined;
			try {
				await run(["watch", PR_URL], {
					iterations: 1,
					lockDir: hardenDir,
					logger: silentLogger(),
					runner: (() => Promise.reject("boom")) as unknown as Runner,
					stateFile: hardenState,
				});
				expect(process.exitCode).toBe(1);
				expect(write).toHaveBeenCalledWith("Error: boom\n");
			} finally {
				process.exitCode = previousExitCode;
				write.mockRestore();
			}
		});
	});

	describe("hardening coverage 2", () => {
		let cov2Dir = "";
		let cov2State = "";

		beforeEach(async () => {
			cov2Dir = await mkdtemp(path.join(tmpdir(), "crewmate-cov2-"));
			cov2State = path.join(cov2Dir, "state.json");
		});

		afterEach(async () => {
			await rm(cov2Dir, { force: true, recursive: true });
			vi.unstubAllEnvs();
		});

		it("streams the current repo when no target is provided", async () => {
			const write = mockStdoutWrite();
			const runner = makeRunner({ prUrl: PR_URL });
			await run(["stream"], {
				iterations: 1,
				lockDir: cov2Dir,
				logger: silentLogger(),
				runner,
				stateFile: cov2State,
			});
			expect(write.mock.calls.map((call) => String(call[0])).join("")).toContain(
				'"event":"mention"',
			);
			write.mockRestore();
		});

		it("rejects remote URLs without a path separator", () => {
			expect(run.parseGitRemoteUrl("git@github.com")).toBeUndefined();
		});

		it("stringifies non-Error git remote failures", async () => {
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const previousExitCode = process.exitCode;
			process.exitCode = undefined;
			try {
				await run(["watch"], {
					iterations: 1,
					lockDir: cov2Dir,
					logger: silentLogger(),
					runner: (() => Promise.reject("no remote")) as unknown as Runner,
					stateFile: cov2State,
				});
				expect(process.exitCode).toBe(1);
				expect(write).toHaveBeenCalledWith("Error: Target is required: no remote\n");
			} finally {
				process.exitCode = previousExitCode;
				write.mockRestore();
			}
		});

		it("skips search items without a URL", async () => {
			const runner = makeRunner({ searchPrItems: [{}, { html_url: PR_URL }] });
			await run.watch("https://github.com/owner/repo", {
				iterations: 1,
				lockDir: cov2Dir,
				logger: silentLogger(),
				runner,
				stateFile: cov2State,
			});
			const state = await run.loadState(cov2State);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
		});

		it("does not mirror warnings to stderr when the logger already writes there", async () => {
			const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			try {
				await writeFile(cov2State, "corrupted{");
				await run.watch(PR_URL, {
					iterations: 1,
					lockDir: cov2Dir,
					runner: makeRunner(),
					stateFile: cov2State,
					toStderr: true,
				});
				const stderr = write.mock.calls.map((call) => String(call[0])).join("");
				expect(stderr).toContain("state file is corrupted");
				expect(stderr).not.toContain("Warning:");
			} finally {
				write.mockRestore();
			}
		});

		it("records terminal failures without a failure handler", async () => {
			await run.saveState(
				new Map([
					[
						PR_URL,
						new Map([
							[
								"review:1",
								{
									attempts: 2,
									lastError: "earlier",
									nextAttemptAt: "2000-01-01T00:00:00.000Z",
									status: "failed",
									updatedAt: "2026-09-03T00:00:00.000Z",
								},
							],
						]),
					],
				]),
				cov2State,
			);
			const warn = vi.fn();
			await run.pollMentions(PR_URL, {
				debug: false,
				dryRun: false,
				logger: silentLogger(),
				onMention: async () => {
					throw new Error("boom");
				},
				runner: makeRunner(),
				stateFile: cov2State,
				warn,
			});
			const state = await run.loadState(cov2State);
			const job = state.get(PR_URL)?.get("review:1");
			expect(job?.status).toBe("failed");
			expect(job?.attempts).toBe(3);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("failed permanently"),
				expect.objectContaining({ reason: "mention-failed-terminal" }),
			);
		});

		it("keeps existing jobs when pre-marking crewmate replies", async () => {
			const runner = makeRunner({
				comments: [
					{ body: "@crewmate hello", id: 1 },
					{ body: `${CREWMATE_PREFIX} Done.`, id: 2, inReplyToId: 1 },
				],
			});
			await run.watch(PR_URL, {
				iterations: 1,
				lockDir: cov2Dir,
				logger: silentLogger(),
				runner,
				stateFile: cov2State,
			});
			const state = await run.loadState(cov2State);
			expect(state.get(PR_URL)?.get("review:1")?.status).toBe("succeeded");
			expect(state.get(PR_URL)?.get("review:2")).toBeUndefined();
		});

		it("works without an iterations cap", async () => {
			await expect(
				run.watch(PR_URL, {
					lockDir: cov2Dir,
					logger: silentLogger(),
					runner: makeRunner(),
					stateFile: cov2Dir,
				}),
			).rejects.toThrow();
		});

		it("parses --since values without a timezone as local time", () => {
			expect(run.parseSince("2026-09-01T00:00:00")).toBeInstanceOf(Date);
		});

		it("creates a file logger when neither --log nor a logger is given", async () => {
			vi.stubEnv("XDG_CONFIG_HOME", cov2Dir);
			const previousExitCode = process.exitCode;
			process.exitCode = undefined;
			try {
				await run(["watch", PR_URL], {
					iterations: 1,
					lockDir: cov2Dir,
					runner: makeRunner(),
					stateFile: cov2State,
				});
				expect(process.exitCode).toBeUndefined();
			} finally {
				process.exitCode = previousExitCode;
			}
		});

		it("still rethrows when error logging fails", async () => {
			await expect(
				run.watch(PR_URL, {
					iterations: 1,
					lockDir: cov2Dir,
					logger: failingLogger,
					runner: makeRunner({ failAuth: true }),
					stateFile: cov2State,
				}),
			).rejects.toThrow("not logged in");
		});
	});
});
