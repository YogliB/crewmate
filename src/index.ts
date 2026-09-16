import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
	CREWMATE_PREFIX,
	errorMessage,
	getLogin,
	handleMention,
	postReply,
	reactionEndpoint,
	type Mention,
	type ReplyContext,
	type Runner,
} from "./reply.js";

import { createLogger, type Logger } from "./log.js";
import {
	acquireLock,
	isJobClosed,
	isJobDue,
	type Job,
	loadState,
	MAX_ATTEMPTS,
	pruneState,
	retryDelaySeconds,
	saveState,
	statePath,
} from "./state.js";
import { loadConfig, type Profile } from "./config.js";

export type { Mention };

const CLI_ARGV_OFFSET = 2;
const EXPECTED_PATH_PARTS = 4;
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MILLISECONDS_PER_SECOND = 1000;
const HELP_PATH = new URL("../assets/help.md", import.meta.url);

const isEpipeError = (error: unknown): boolean =>
	error instanceof Error && (error as NodeJS.ErrnoException).code === "EPIPE";

class OutputError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OutputError";
	}
}

const isOutputError = (error: unknown): boolean => error instanceof OutputError;

const handleStdoutError = (error: Error) => {
	process.exitCode = isEpipeError(error) ? 0 : 1;
};

process.stdout.on("error", handleStdoutError);

const execFilePromise = promisify(execFile);

const exec: Runner = async (file, args, options) => {
	const { stdout } = await execFilePromise(file, args, {
		encoding: "utf8",
		env: options?.env ? { ...process.env, ...options.env } : process.env,
		...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
	});
	return stdout;
};

function renderHelp(text: string): string {
	const styled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
	const B = styled ? "\x1b[1m" : "";
	const D = styled ? "\x1b[2m" : "";
	const C = styled ? "\x1b[36m" : "";
	const R = styled ? "\x1b[0m" : "";

	return text
		.replace(/^# (.+)$/gm, `${B}$1${R}`)
		.replace(/^## (.+)$/gm, `${B}$1${R}`)
		.replace(/^### `(.+)`$/gm, `${B}$1${R}`)
		.replace(/^### (.+)$/gm, `${B}$1${R}`)
		.replace(/^#### (.+)$/gm, `${D}$1${R}`)
		.replace(/^- /gm, "  • ")
		.replace(/`([^`]+)`/g, `${C}$1${R}`);
}

function showHelp(): void {
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- HELP_PATH is a build-time constant
	process.stdout.write(`\n${renderHelp(readFileSync(HELP_PATH, "utf8"))}\n`);
}

const NAME = "[A-Za-z0-9_.-]+";

const isValidName = (name: string): boolean =>
	new RegExp(`^(?!\\.\\.?(?:\\/|$))(${NAME})$`).test(name) &&
	!new RegExp(`^(?:\\.\\.?)$`).test(name);

const PR_SHORTHAND = new RegExp(
	`^(?!\\.\\.?(?:\\/|$))(${NAME})\\/(?!\\.\\.?(?:\\/|$))(${NAME})\\/pull\\/(\\d+)\\/?$`,
);

const ISSUE_SHORTHAND = new RegExp(
	`^(?!\\.\\.?(?:\\/|$))(${NAME})\\/(?!\\.\\.?(?:\\/|$))(${NAME})\\/issues\\/(\\d+)\\/?$`,
);

const REPO_SHORTHAND = new RegExp(
	`^(?!\\.\\.?(?:\\/|$))(${NAME})\\/(?!\\.\\.?(?:\\/|$))(${NAME})\\/?$`,
);

const parsePrUrl = (
	prUrl: string,
): { host: string; owner: string; port?: string; repo: string; number: string } => {
	const parsed = parseTarget(prUrl);
	if (parsed.kind !== "pr") {
		throw new TypeError(`Invalid PR reference: ${prUrl}`);
	}
	const { host, owner, port, repo, number } = parsed;
	return { host, owner, ...(port === undefined ? {} : { port }), repo, number };
};

const toMention = (raw: Record<string, unknown>, kind: Mention["kind"]): Mention | undefined => {
	if (typeof raw.id !== "number" || typeof raw.body !== "string") return undefined;
	const inReplyToId = typeof raw.in_reply_to_id === "number" ? raw.in_reply_to_id : undefined;
	const createdAt = typeof raw.created_at === "string" ? raw.created_at : undefined;
	if (kind === "conversation" || kind === "issue") {
		return { id: raw.id, body: raw.body, createdAt, user: raw.user, kind, inReplyToId };
	}
	if (typeof raw.path !== "string" || typeof raw.line !== "number") return undefined;
	return {
		id: raw.id,
		body: raw.body,
		createdAt,
		user: raw.user,
		kind: "review",
		path: raw.path,
		line: raw.line,
		inReplyToId,
	};
};

const fetchKind = async (
	owner: string,
	repo: string,
	number: string,
	kind: Mention["kind"],
	hostWithPortValue: string,
	runner: Runner,
): Promise<Mention[]> => {
	const endpoint =
		kind === "conversation"
			? `repos/${owner}/${repo}/issues/${number}/comments`
			: `repos/${owner}/${repo}/pulls/${number}/comments`;
	const output = await runner("gh", ["api", "--paginate", "--slurp", endpoint], {
		env: { GH_HOST: hostWithPortValue },
	});
	return (JSON.parse(output) as Record<string, unknown>[][])
		.flat()
		.map((c) => toMention(c, kind))
		.filter((m): m is Mention => m !== undefined);
};

const fetchIssueBody = async (
	owner: string,
	repo: string,
	number: string,
	hostWithPortValue: string,
	runner: Runner,
): Promise<Mention | undefined> => {
	const output = await runner("gh", ["api", `repos/${owner}/${repo}/issues/${number}`], {
		env: { GH_HOST: hostWithPortValue },
	});
	const issue = JSON.parse(output) as Record<string, unknown>;
	if (typeof issue.number !== "number" || typeof issue.body !== "string") return undefined;
	return toMention({ ...issue, id: issue.number }, "issue");
};

const fetchMentions = async (itemUrl: string, runner: Runner = exec): Promise<Mention[]> => {
	const parsed = parseTarget(itemUrl);
	if (parsed.kind !== "pr" && parsed.kind !== "issue") {
		throw new TypeError(`Invalid item reference: ${itemUrl}`);
	}
	const { host, owner, port, repo, number } = parsed;
	const ghHost = hostWithPort(host, port);
	if (parsed.kind === "issue") {
		const [body, conversation] = await Promise.all([
			fetchIssueBody(owner, repo, number, ghHost, runner),
			fetchKind(owner, repo, number, "conversation", ghHost, runner),
		]);
		return body ? [body, ...conversation] : conversation;
	}
	const [review, conversation] = await Promise.all([
		fetchKind(owner, repo, number, "review", ghHost, runner),
		fetchKind(owner, repo, number, "conversation", ghHost, runner),
	]);
	return [...review, ...conversation];
};

const findCrewmateRepliedIds = (comments: Mention[], isFresh: boolean): Set<string> =>
	isFresh
		? new Set(
				comments.flatMap((comment) =>
					comment.kind === "review" &&
					comment.body.startsWith(CREWMATE_PREFIX) &&
					typeof comment.inReplyToId === "number"
						? [`${comment.kind}:${comment.inReplyToId}`]
						: [],
				),
			)
		: new Set<string>();

type MentionFilterDetails = {
	passes: boolean;
	startsWithPrefix: boolean;
	hasMention: boolean;
	isReply: boolean;
	isClosed: boolean;
	isCrewmateReplied: boolean;
	userAllowed: boolean;
};

const getMentionFilterDetails = (
	comment: Mention,
	closed: Set<string>,
	crewmateRepliedIds: Set<string>,
	allowedUser?: string,
): MentionFilterDetails => {
	const key = `${comment.kind}:${comment.id}`;
	const startsWithPrefix = comment.body.startsWith(CREWMATE_PREFIX);
	const hasMention = /(?:^|\W)@crewmate\b/i.test(comment.body);
	const isReply = comment.inReplyToId !== undefined;
	const isClosed = closed.has(key);
	const isCrewmateReplied = crewmateRepliedIds.has(key);
	const userAllowed = allowedUser === undefined || getLogin(comment.user) === allowedUser;
	return {
		passes:
			!startsWithPrefix && hasMention && !isReply && !isClosed && !isCrewmateReplied && userAllowed,
		startsWithPrefix,
		hasMention,
		isReply,
		isClosed,
		isCrewmateReplied,
		userAllowed,
	};
};

const debugMentionSummary = (mention: Mention) => ({
	createdAt: mention.createdAt,
	id: mention.id,
	kind: mention.kind,
});

const passesSinceFilter = (createdAt: string | undefined, since: Date): boolean => {
	if (createdAt === undefined) return true;
	const parsed = Date.parse(createdAt);
	return !Number.isNaN(parsed) && parsed >= since.getTime();
};

const findNewMentions = (
	comments: Mention[],
	closedIds: string[],
	allowedUser?: string,
	isFresh = false,
	since?: Date,
): Mention[] => {
	const closed = new Set(closedIds);
	const crewmateRepliedIds = findCrewmateRepliedIds(comments, isFresh);
	return comments
		.filter((comment) => {
			const details = getMentionFilterDetails(comment, closed, crewmateRepliedIds, allowedUser);
			if (!details.passes) return false;
			return since === undefined || passesSinceFilter(comment.createdAt, since);
		})
		.toSorted((first, second) => second.id - first.id);
};

const findNewMention = (...args: Parameters<typeof findNewMentions>): Mention | undefined =>
	findNewMentions(...args).at(0);

const hostWithPort = (host: string, port?: string): string => (port ? `${host}:${port}` : host);

const parseGitRemoteUrl = (
	url: string,
): { host: string; owner: string; port?: string; repo: string } | undefined => {
	let normalized = url;
	if (!url.includes("://") && url.includes("@")) {
		const at = url.indexOf("@");
		const colon = url.indexOf(":", at + 1);
		if (colon !== -1) {
			normalized = `ssh://${url.slice(0, at)}@${url.slice(at + 1, colon)}/${url.slice(colon + 1)}`;
		}
	}
	try {
		const parsed = new URL(normalized);
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length !== 2) return undefined;
		const [owner, repoPart] = parts;
		const repo = repoPart.replace(/\.git$/, "");
		if (!isValidName(owner) || !isValidName(repo)) return undefined;
		return {
			host: parsed.hostname,
			owner,
			repo,
			...(parsed.protocol === "https:" && parsed.port ? { port: parsed.port } : {}),
		};
	} catch {
		return undefined;
	}
};

const resolveDefaultTarget = async (runner: Runner): Promise<string> => {
	let remote: string;
	try {
		remote = (await runner("git", ["remote", "get-url", "origin"])).trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new TypeError(`Target is required: ${message}`, { cause: error });
	}
	const parsed = remote ? parseGitRemoteUrl(remote) : undefined;
	if (!parsed) throw new TypeError("Target is required");
	return `https://${hostWithPort(parsed.host, parsed.port)}/${parsed.owner}/${parsed.repo}`;
};

const authenticateHost = async (
	runner: Runner,
	host: string,
	env: { env: { GH_HOST: string } },
): Promise<void> => {
	try {
		await runner("gh", ["auth", "status", "--hostname", host], env);
	} catch (error) {
		const plainHost = host.replace(/:\d+$/, "");
		if (plainHost !== host) {
			await runner("gh", ["auth", "status", "--hostname", plainHost], env);
		} else {
			throw error;
		}
	}
};

const fetchGhUser = async (
	runner: Runner,
	env: { env: { GH_HOST: string } },
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
): Promise<string | undefined> => {
	try {
		const login = (await runner("gh", ["api", "user", "--jq", ".login"], env)).trim();
		return login || undefined;
	} catch (error) {
		await warn(
			"could not determine the authenticated gh user; set --user, add a user to your config, or pass --unsafe-no-user",
			{ error: errorMessage(error), reason: "gh-user-unresolved" },
		);
		return undefined;
	}
};

const toPrUrl = ({
	host,
	owner,
	port,
	repo,
	number,
}: {
	host: string;
	owner: string;
	port?: string;
	repo: string;
	number: string;
}): string => `https://${hostWithPort(host, port)}/${owner}/${repo}/pull/${number}`;

const toIssueUrl = ({
	host,
	owner,
	port,
	repo,
	number,
}: {
	host: string;
	owner: string;
	port?: string;
	repo: string;
	number: string;
}): string => `https://${hostWithPort(host, port)}/${owner}/${repo}/issues/${number}`;

const toItemUrl = (scope: Extract<Scope, { kind: "pr" | "issue" }>): string =>
	scope.kind === "pr" ? toPrUrl(scope) : toIssueUrl(scope);

export type Scope =
	| { kind: "pr"; host: string; owner: string; port?: string; repo: string; number: string }
	| { kind: "issue"; host: string; owner: string; port?: string; repo: string; number: string }
	| { kind: "repo"; host: string; owner: string; port?: string; repo: string };

const parseTarget = (target: string): Scope => {
	if (/^https:\/\//i.test(target)) {
		let url: URL;
		try {
			url = new URL(target);
		} catch {
			throw new TypeError(`Invalid target: ${target}`);
		}
		const parts = url.pathname.split("/").filter(Boolean);
		const [first, second, third, fourth] = parts;

		if (first === "orgs") {
			throw new TypeError(`Invalid target: ${target}`);
		}

		if (
			parts.length === EXPECTED_PATH_PARTS &&
			third === "pull" &&
			typeof first === "string" &&
			typeof second === "string" &&
			typeof fourth === "string" &&
			isValidName(first) &&
			isValidName(second) &&
			/^\d+$/.test(fourth)
		) {
			return {
				kind: "pr",
				host: url.hostname,
				owner: first,
				repo: second,
				number: fourth,
				...(url.port ? { port: url.port } : {}),
			};
		}

		if (
			parts.length === EXPECTED_PATH_PARTS &&
			third === "issues" &&
			typeof first === "string" &&
			typeof second === "string" &&
			typeof fourth === "string" &&
			isValidName(first) &&
			isValidName(second) &&
			/^\d+$/.test(fourth)
		) {
			return {
				kind: "issue",
				host: url.hostname,
				owner: first,
				repo: second,
				number: fourth,
				...(url.port ? { port: url.port } : {}),
			};
		}

		if (
			parts.length === 2 &&
			typeof first === "string" &&
			typeof second === "string" &&
			isValidName(first) &&
			isValidName(second)
		) {
			return {
				kind: "repo",
				host: url.hostname,
				owner: first,
				repo: second,
				...(url.port ? { port: url.port } : {}),
			};
		}

		throw new TypeError(`Invalid target: ${target}`);
	}

	const prShorthand = PR_SHORTHAND.exec(target);
	if (prShorthand) {
		const [, owner, repo, number] = prShorthand;
		return { kind: "pr", host: "github.com", owner, repo, number };
	}

	const issueShorthand = ISSUE_SHORTHAND.exec(target);
	if (issueShorthand) {
		const [, owner, repo, number] = issueShorthand;
		return { kind: "issue", host: "github.com", owner, repo, number };
	}

	const repoShorthand = REPO_SHORTHAND.exec(target);
	if (repoShorthand) {
		const [, owner, repo] = repoShorthand;
		return { kind: "repo", host: "github.com", owner, repo };
	}

	throw new TypeError(`Invalid target: ${target}`);
};

const toScopeItemUrl = (scope: { host: string; port?: string }, url: string): string => {
	const parsed = parseTarget(url);
	if (parsed.kind !== "pr" && parsed.kind !== "issue") {
		throw new TypeError(`Invalid item URL: ${url}`);
	}
	return toItemUrl({ ...parsed, host: scope.host, port: scope.port });
};

const fetchOpenItemsRepoFallback = async (
	scope: Extract<Scope, { kind: "repo" }>,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
	includeClosed: boolean,
): Promise<string[]> => {
	try {
		const state = includeClosed ? "all" : "open";
		const output = await runner(
			"gh",
			["api", "--paginate", "--slurp", `repos/${scope.owner}/${scope.repo}/issues?state=${state}`],
			{ env: { GH_HOST: hostWithPort(scope.host, scope.port) } },
		);
		const pages = JSON.parse(output) as { html_url?: unknown }[][];
		const itemUrls: string[] = [];
		for (const item of pages.flat()) {
			const url = item.html_url;
			if (typeof url !== "string") continue;
			try {
				itemUrls.push(toScopeItemUrl(scope, url));
			} catch {
				await warn(`invalid item URL from repo fallback: ${url}`, {
					reason: "fallback-invalid-url",
					url,
				});
			}
		}
		return itemUrls;
	} catch (error) {
		const message = errorMessage(error);
		await warn(`repo fallback failed: ${message}`, {
			reason: "repo-fallback-failed",
			error: message,
			host: scope.host,
		});
		return [];
	}
};

const searchItemsByQuery = async (
	scope: Extract<Scope, { kind: "repo" }>,
	runner: Runner,
	query: string,
): Promise<string[]> => {
	const encoded = encodeURIComponent(query);
	const output = await runner(
		"gh",
		["api", "--paginate", "--slurp", `search/issues?q=${encoded}`],
		{ env: { GH_HOST: hostWithPort(scope.host, scope.port) } },
	);
	const pages = JSON.parse(output) as { items?: { html_url?: unknown }[] }[];
	const urls: string[] = [];
	for (const page of pages) {
		for (const item of page.items ?? []) {
			const url = item.html_url;
			if (typeof url === "string") urls.push(url);
		}
	}
	return urls;
};

const isNotFound = (error: unknown): boolean => {
	const message = errorMessage(error);
	const match = message.match(/HTTP (\d{3})/);
	return match?.[1] === "404";
};

const warnSearchFailure = async (
	scope: Extract<Scope, { kind: "repo" }>,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
	query: string,
	error: unknown,
): Promise<void> => {
	const message = errorMessage(error);
	const match = message.match(/HTTP (\d{3})/);
	const status = match ? Number(match[1]) : 0;
	if (status === 403 || status === 422) {
		await warn("Search failed; verify the token can read private repos on this host", {
			reason: "search-token-scope",
			host: scope.host,
			query,
		});
	} else {
		await warn(`search failed: ${message}`, {
			reason: "search-failed",
			error: message,
			host: scope.host,
			query,
		});
	}
};

const fetchOpenItems = async (
	scope: Scope,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
	includeClosed = false,
): Promise<string[]> => {
	if (scope.kind !== "repo") {
		throw new Error("fetchOpenItems should not be called for a single item");
	}

	const stateFilter = includeClosed ? "" : " is:open";
	const prQuery = `repo:${scope.owner}/${scope.repo} is:pr${stateFilter}`;
	const issueQuery = `repo:${scope.owner}/${scope.repo} is:issue${stateFilter}`;

	const [prResult, issueResult] = await Promise.allSettled([
		searchItemsByQuery(scope, runner, prQuery),
		searchItemsByQuery(scope, runner, issueQuery),
	]);

	const allUrls: string[] = [];
	if (prResult.status === "fulfilled") allUrls.push(...prResult.value);
	if (issueResult.status === "fulfilled") allUrls.push(...issueResult.value);

	const failures: { query: string; reason: PromiseRejectedResult }[] = [];
	if (prResult.status === "rejected") failures.push({ query: prQuery, reason: prResult });
	if (issueResult.status === "rejected") failures.push({ query: issueQuery, reason: issueResult });

	for (const { query, reason } of failures) {
		if (isNotFound(reason.reason)) continue;
		await warnSearchFailure(scope, warn, query, reason.reason);
	}

	if (allUrls.length > 0) {
		const deduped = [...new Set(allUrls)];
		const itemUrls: string[] = [];
		for (const url of deduped) {
			try {
				itemUrls.push(toScopeItemUrl(scope, url));
			} catch {
				await warn(`invalid item URL from search: ${url}`, { reason: "search-invalid-url", url });
			}
		}
		return itemUrls;
	}

	if (failures.length > 0 && failures.every(({ reason }) => isNotFound(reason.reason))) {
		return fetchOpenItemsRepoFallback(scope, runner, warn, includeClosed);
	}

	return [];
};

const makeWarn =
	(loggerMirrorsToStderr: boolean, log: Logger) =>
	async (message: string, fields: Record<string, unknown> = {}) => {
		if (!loggerMirrorsToStderr) {
			try {
				process.stderr.write(`Warning: ${message}\n`);
			} catch {}
		}
		await log("warning", { ...fields, message });
	};

const ackMention = async (
	mention: Mention,
	owner: string,
	repo: string,
	number: string,
	ghHost: string,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
): Promise<number | undefined> => {
	const commentId = mention.kind === "issue" ? Number(number) : mention.id;
	const base = {
		commentId,
		kind: mention.kind,
		number,
		owner,
		repo,
	};
	try {
		const output = await runner(
			"gh",
			[
				"api",
				"--method",
				"POST",
				reactionEndpoint({ owner, repo, kind: mention.kind, number, commentId }),
				"-f",
				"content=eyes",
			],
			{ env: { GH_HOST: ghHost } },
		);
		if (output.trim() === "") {
			await warn("failed to set ack reaction: empty response", base);
			return undefined;
		}
		try {
			const json = JSON.parse(output) as { id?: unknown };
			if (typeof json.id === "number") {
				return json.id;
			}
			await warn("failed to set ack reaction: response did not contain a numeric id", base);
		} catch (error) {
			await warn(`failed to set ack reaction: ${errorMessage(error)}`, base);
		}
	} catch (error) {
		await warn(`failed to set ack reaction: ${errorMessage(error)}`, base);
	}
	return undefined;
};

type PollOptions = {
	allowedUser?: string;
	debug: boolean;
	dryRun: boolean;
	logger: Logger;
	onMention: (mention: Mention) => Promise<void>;
	onTerminalFailure?: (mention: Mention, error: unknown) => Promise<void>;
	runner: Runner;
	since?: Date;
	stateFile?: string;
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
};

const pollMentions = async (itemUrl: string, options: PollOptions): Promise<void> => {
	await options.logger("poll", { url: itemUrl });
	const jobs = await loadState(options.stateFile, async () =>
		options.warn("state file is corrupted, resetting", { reason: "state-corrupted" }),
	);
	const save = async () => {
		await saveState(jobs, options.stateFile);
	};
	const comments = await fetchMentions(itemUrl, options.runner);
	const targetJobs = jobs.get(itemUrl) ?? new Map<string, Job>();
	jobs.set(itemUrl, targetJobs);
	const isFresh = targetJobs.size === 0;
	const closed = new Set(
		[...targetJobs.entries()].filter(([, job]) => isJobClosed(job)).map(([key]) => key),
	);
	const crewmateRepliedIds = findCrewmateRepliedIds(comments, isFresh);

	if (options.debug) {
		await options.logger("debug", {
			stage: "fetched-comments",
			url: itemUrl,
			count: comments.length,
			comments: comments.map((comment) => ({
				...debugMentionSummary(comment),
				inReplyToId: comment.inReplyToId,
			})),
		});

		const filterDetails = comments.map((comment) => ({
			...debugMentionSummary(comment),
			...getMentionFilterDetails(comment, closed, crewmateRepliedIds, options.allowedUser),
			...(options.since === undefined
				? {}
				: { sincePass: passesSinceFilter(comment.createdAt, options.since) }),
		}));

		await options.logger("debug", {
			stage: "mention-filter",
			url: itemUrl,
			allowedUser: options.allowedUser,
			details: filterDetails,
		});
	}

	const mentions = findNewMentions(
		comments,
		[...closed],
		options.allowedUser,
		isFresh,
		options.since,
	);

	if (options.debug) {
		await options.logger("debug", {
			stage: "new-mentions",
			url: itemUrl,
			count: mentions.length,
			mentions: mentions.map((mention) => debugMentionSummary(mention)),
		});
	}

	for (const mention of mentions) {
		const key = `${mention.kind}:${mention.id}`;
		const job = targetJobs.get(key) ?? {
			attempts: 0,
			status: "pending",
			updatedAt: new Date().toISOString(),
		};
		if (!isJobDue(job, new Date())) {
			await options.logger("skip", { key, reason: "not-due", url: itemUrl });
			continue;
		}
		await options.logger("mention", {
			attempt: job.attempts + 1,
			commentId: mention.id,
			dryRun: options.dryRun,
			kind: mention.kind,
			user: getLogin(mention.user),
			url: itemUrl,
		});
		if (options.dryRun) {
			await options.onMention(mention);
			continue;
		}
		job.status = "running";
		job.attempts += 1;
		job.updatedAt = new Date().toISOString();
		targetJobs.set(key, job);
		await save();
		try {
			await options.onMention(mention);
			job.status = "succeeded";
			delete job.nextAttemptAt;
			delete job.lastError;
			job.updatedAt = new Date().toISOString();
			await save();
			await options.logger("handled", { attempts: job.attempts, key, url: itemUrl });
		} catch (error) {
			if (isEpipeError(error) || isOutputError(error)) {
				throw error;
			}
			const message = errorMessage(error);
			job.status = "failed";
			job.lastError = message;
			job.updatedAt = new Date().toISOString();
			if (job.attempts >= MAX_ATTEMPTS) {
				delete job.nextAttemptAt;
				await save();
				await options.warn(`mention ${key} failed permanently after ${job.attempts} attempts`, {
					error: message,
					key,
					reason: "mention-failed-terminal",
					url: itemUrl,
				});
				if (options.onTerminalFailure !== undefined) {
					await options.onTerminalFailure(mention, error);
				}
			} else {
				job.nextAttemptAt = new Date(
					Date.now() + retryDelaySeconds(job.attempts) * MILLISECONDS_PER_SECOND,
				).toISOString();
				await save();
				await options.warn(`mention ${key} failed, will retry`, {
					attempts: job.attempts,
					error: message,
					key,
					nextAttemptAt: job.nextAttemptAt,
					reason: "mention-failed-retry",
					url: itemUrl,
				});
			}
		}
	}

	if (!options.dryRun && isFresh && crewmateRepliedIds.size > 0) {
		for (const key of crewmateRepliedIds) {
			targetJobs.set(key, {
				attempts: 1,
				status: "succeeded",
				updatedAt: new Date().toISOString(),
			});
		}
		await save();
	}
};

type PollScope = (
	scope: Scope,
	options: {
		includeClosed?: boolean;
		interval: number;
		iterations: number;
		target: string;
	},
	onItem: (itemUrl: string) => Promise<void>,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
) => Promise<void>;

const pollScope: PollScope = async (scope, options, onItem, runner, warn) => {
	let warnedNoOpenItems = false;
	for (let index = 0; index < options.iterations; index += 1) {
		const itemUrls =
			scope.kind === "pr" || scope.kind === "issue"
				? [toItemUrl(scope)]
				: await fetchOpenItems(scope, runner, warn, options.includeClosed);
		if (itemUrls.length === 0) {
			if (!warnedNoOpenItems) {
				warnedNoOpenItems = true;
				await warn("No open items found for the target", {
					reason: "no-open-items",
					target: options.target,
				});
			}
		} else {
			warnedNoOpenItems = false;
			for (const itemUrl of itemUrls) {
				try {
					await onItem(itemUrl);
				} catch (error) {
					if (isEpipeError(error) || isOutputError(error)) {
						throw error;
					}
					const message = errorMessage(error);
					await warn(`poll failed for ${itemUrl}`, {
						error: message,
						itemUrl,
						reason: "poll-failed",
					});
					if (scope.kind === "pr" || scope.kind === "issue") {
						throw error;
					}
				}
			}
		}
		if (index < options.iterations - 1) {
			await setTimeout(options.interval * MILLISECONDS_PER_SECOND);
		}
	}
};

type ScopeRunOptions = {
	ack?: boolean;
	allowedUser?: string;
	config?: Partial<Profile>;
	debug?: boolean;
	dryRun?: boolean;
	includeClosed?: boolean;
	interval?: number;
	iterations?: number;
	logger?: Logger;
	lockDir?: string;
	model?: string;
	outputFile?: string;
	prompt?: string;
	provider?: string;
	runner?: Runner;
	since?: Date;
	stateFile?: string;
	timeoutSeconds?: number;
	toStderr?: boolean;
	unsafeNoUser?: boolean;
};

type ScopeContext = {
	allowedUser: string | undefined;
	debug: boolean;
	dryRun: boolean;
	logger: Logger;
	model: string | undefined;
	prompt: string | undefined;
	provider: string | undefined;
	runner: Runner;
	since: Date | undefined;
	stateFile: string | undefined;
	timeoutSeconds: number;
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
};

const runScope = async (
	target: string,
	options: ScopeRunOptions,
	callbacks: {
		onItem: (ctx: ScopeContext, itemUrl: string) => Promise<void>;
		requiresProvider: boolean;
	},
): Promise<void> => {
	const runner = options.runner ?? exec;
	let toStderr = options.toStderr ?? false;
	let logger = options.logger ?? createLogger({ toStderr });
	const configWarn = makeWarn(toStderr, logger);
	let normalizedItemUrl = target;
	try {
		const scope = parseTarget(target);
		normalizedItemUrl =
			scope.kind === "pr" ? toPrUrl(scope) : scope.kind === "issue" ? toIssueUrl(scope) : target;

		const ghHost = hostWithPort(scope.host, scope.port);
		const ghHostEnv = { env: { GH_HOST: ghHost } };
		await runner("gh", ["--version"], ghHostEnv);
		await authenticateHost(runner, ghHost, ghHostEnv);

		const profile = options.config ?? (await loadConfig(configWarn));

		const unsafeNoUser =
			options.unsafeNoUser ??
			(options.allowedUser === undefined ? profile.unsafeNoUser : false) ??
			false;

		let ghUser: string | undefined;
		if (!unsafeNoUser) {
			ghUser = await fetchGhUser(runner, ghHostEnv, configWarn);
		}

		const provider = options.provider ?? profile.provider;
		const model = options.model ?? profile.model;
		const interval = options.interval ?? profile.interval ?? DEFAULT_INTERVAL_SECONDS;
		const debug = options.debug ?? profile.debug ?? false;
		const prompt = options.prompt ?? profile.prompt;
		const dryRun = options.dryRun ?? false;
		const timeoutSeconds =
			options.timeoutSeconds ?? profile.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
		toStderr = options.toStderr ?? profile.log ?? false;
		if (!options.logger) {
			logger = createLogger({ toStderr });
		}
		const warn = makeWarn(toStderr, logger);

		const allowedUser = unsafeNoUser ? undefined : (options.allowedUser ?? profile.user ?? ghUser);
		if (!unsafeNoUser && allowedUser === undefined) {
			throw new TypeError(
				"Could not determine a GitHub user to filter for. Set --user, add a user to your config, or pass --unsafe-no-user to allow any user.",
			);
		}
		if (ghUser !== undefined && allowedUser !== undefined && allowedUser !== ghUser) {
			await warn(
				`filtering for user ${allowedUser} who is not the authenticated gh user ${ghUser}`,
				{
					allowedUser,
					ghUser,
					reason: "user-filter-override",
				},
			);
		}

		if (callbacks.requiresProvider) {
			await runner(provider || "claude", ["--version"]);
		}

		const iterations = options.iterations ?? Infinity;

		if (dryRun) {
			if (!toStderr) {
				try {
					process.stderr.write(
						"Dry-run mode: no GitHub comments, reactions, or state changes will be made.\n",
					);
				} catch {}
			}
			await logger("info", {
				message: "Dry-run mode: no GitHub comments, reactions, or state changes will be made.",
			});
		}

		const ctx: ScopeContext = {
			allowedUser,
			debug,
			dryRun,
			logger,
			model,
			prompt,
			provider,
			runner,
			since: options.since,
			stateFile: options.stateFile,
			timeoutSeconds,
			warn,
		};

		await pollScope(
			scope,
			{ includeClosed: options.includeClosed ?? false, interval, iterations, target },
			async (itemUrl) => {
				await callbacks.onItem(ctx, itemUrl);
			},
			runner,
			warn,
		);
	} catch (error) {
		if (!isEpipeError(error)) {
			await logger("error", {
				errorType: error instanceof Error ? error.name : "unknown",
				message: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				url: normalizedItemUrl,
			}).catch(() => {});
		}
		throw error;
	}
};

const emitLine = async (line: string, outputFile?: string): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		process.stdout.write(line, (error) => {
			if (error) {
				reject(
					isEpipeError(error)
						? error
						: new OutputError(`stdout write failed: ${error.message}`, { cause: error }),
				);
			} else {
				resolve();
			}
		});
	});
	if (outputFile !== undefined) {
		try {
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- outputFile is provided by the user via CLI
			await fs.mkdir(path.dirname(outputFile), { recursive: true });
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- outputFile is provided by the user via CLI
			await fs.appendFile(outputFile, line, "utf8");
		} catch (error) {
			throw new OutputError(`output file write failed: ${errorMessage(error)}`, { cause: error });
		}
	}
};

const makeReplyContext = (
	ctx: ScopeContext,
	mention: Mention,
	scope: Extract<Scope, { kind: "pr" | "issue" }>,
): ReplyContext => ({
	commentId: mention.kind === "issue" ? Number(scope.number) : mention.id,
	dryRun: ctx.dryRun,
	ghHost: hostWithPort(scope.host, scope.port),
	kind: mention.kind,
	logger: ctx.logger,
	model: ctx.model,
	number: scope.number,
	owner: scope.owner,
	prompt: ctx.prompt,
	provider: ctx.provider,
	repo: scope.repo,
	runner: ctx.runner,
	timeoutSeconds: ctx.timeoutSeconds,
	warn: ctx.warn,
});

const watch = async (target: string, options: ScopeRunOptions = {}): Promise<void> => {
	const release = await acquireLock({
		dir: options.lockDir ?? path.dirname(options.stateFile ?? statePath()),
	});
	try {
		await runScope(target, options, {
			onItem: async (ctx, itemUrl) => {
				const scope = parseTarget(itemUrl) as Extract<Scope, { kind: "issue" | "pr" }>;
				await pollMentions(itemUrl, {
					allowedUser: ctx.allowedUser,
					debug: ctx.debug,
					dryRun: ctx.dryRun,
					logger: ctx.logger,
					onMention: async (mention) => {
						const replyCtx = makeReplyContext(ctx, mention, scope);
						await handleMention(mention, replyCtx);
					},
					onTerminalFailure: async (mention, error) => {
						const replyCtx = makeReplyContext(ctx, mention, scope);
						try {
							await postReply(
								replyCtx,
								`Failed to respond after ${MAX_ATTEMPTS} attempts: ${errorMessage(error)}`,
								"error",
							);
						} catch (replyError) {
							await ctx.warn("failed to post failure reply", {
								error: errorMessage(replyError),
								reason: "failure-reply-failed",
							});
						}
					},
					runner: ctx.runner,
					since: ctx.since,
					stateFile: ctx.stateFile,
					warn: ctx.warn,
				});
			},
			requiresProvider: true,
		});
	} finally {
		await release();
	}
};

const stream = async (target: string, options: ScopeRunOptions = {}): Promise<void> => {
	const release = await acquireLock({
		dir: options.lockDir ?? path.dirname(options.stateFile ?? statePath()),
	});
	try {
		await runScope(target, options, {
			onItem: async (ctx, itemUrl) => {
				const scope = parseTarget(itemUrl) as Extract<Scope, { kind: "issue" | "pr" }>;
				await pollMentions(itemUrl, {
					allowedUser: ctx.allowedUser,
					debug: ctx.debug,
					dryRun: false,
					logger: ctx.logger,
					onMention: async (mention) => {
						let reactionId: number | undefined;
						if (options.ack) {
							reactionId = await ackMention(
								mention,
								scope.owner,
								scope.repo,
								scope.number,
								hostWithPort(scope.host, scope.port),
								ctx.runner,
								ctx.warn,
							);
						}
						const event: Record<string, unknown> = {
							at: new Date().toISOString(),
							event: "mention",
							owner: scope.owner,
							repo: scope.repo,
							number: Number(scope.number),
							commentId: mention.kind === "issue" ? Number(scope.number) : mention.id,
							kind: mention.kind,
							user: getLogin(mention.user),
							body: mention.body,
							url: itemUrl,
						};
						if (reactionId !== undefined) {
							event.reactionId = reactionId;
						}
						if (mention.kind === "review") {
							event.path = mention.path;
							event.line = mention.line;
						}
						const line = JSON.stringify(event) + "\n";
						await emitLine(line, options.outputFile);
					},
					runner: ctx.runner,
					since: ctx.since,
					stateFile: ctx.stateFile,
					warn: ctx.warn,
				});
			},
			requiresProvider: false,
		});
	} finally {
		await release();
	}
};

const VALUE_FLAGS = new Set([
	"--interval",
	"--user",
	"--prompt",
	"--model",
	"--provider",
	"--output-file",
	"--since",
	"--timeout",
]);

const parseArgs = (
	argv: string[],
): { booleans: Set<string>; positionals: string[]; values: Map<string, string> } => {
	const booleans = new Set<string>();
	const positionals: string[] = [];
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		// oxlint-disable-next-line security/detect-object-injection -- array index read, not property injection
		const arg = argv[i];
		if (arg === "-h") {
			booleans.add(arg);
			continue;
		}
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		if (eq !== -1) {
			values.set(arg.slice(0, eq), arg.slice(eq + 1));
			continue;
		}
		if (VALUE_FLAGS.has(arg) && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
			values.set(arg, argv[i + 1]);
			i += 1;
		} else {
			booleans.add(arg);
		}
	}
	return { booleans, positionals, values };
};

const findFlag = (argv: string[], flag: string): string | undefined =>
	parseArgs(argv).values.get(flag);

const parseInterval = (
	input: string | string[] | undefined,
	options: { fallback?: number } = { fallback: DEFAULT_INTERVAL_SECONDS },
): number | undefined => {
	const value = Array.isArray(input) ? findFlag(input, "--interval") : input;
	const fallback = options.fallback;
	if (value === undefined) {
		return fallback;
	}
	const parsed = Math.trunc(Number(value));
	return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
};

const parseTimeout = (input: string | undefined): number | undefined => {
	if (input === undefined) return undefined;
	const parsed = Math.trunc(Number(input));
	if (Number.isNaN(parsed) || parsed <= 0) {
		throw new TypeError(`Invalid --timeout seconds: ${input}`);
	}
	return parsed;
};

const SINCE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SINCE_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;
const SINCE_CLOCK = /^\d{2}$/;
const SINCE_FRACTION = /^\d+$/;

const MINUTE_MILLIS = 60_000;

const padTwoDigits = (value: number): string => String(value).padStart(2, "0");

const zoneOffsetMinutes = (zone: string): number | undefined => {
	if (zone === "Z") return 0;
	const digits = zone.slice(1).replace(":", "");
	const hours = Number(digits.slice(0, 2));
	const minutes = Number(digits.slice(2));
	if (hours > 23 || minutes > 59) return undefined;
	return (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes);
};

const parseSince = (input: string | undefined): Date | undefined => {
	if (input === undefined) return undefined;
	const invalid = `Invalid --since timestamp: ${input} (expected ISO-8601)`;
	const parts = input.split("T");
	const dateMatch = SINCE_DATE.exec(parts[0]);
	if (dateMatch === null || parts.length > 2) throw new TypeError(invalid);
	const [, year, month, day] = dateMatch;
	const dayMillis = Date.UTC(Number(year), Number(month) - 1, Number(day));
	const calendar = new Date(dayMillis);
	const canonical = `${calendar.getUTCFullYear()}-${padTwoDigits(calendar.getUTCMonth() + 1)}-${padTwoDigits(calendar.getUTCDate())}`;
	if (canonical !== `${year}-${month}-${day}`) throw new TypeError(invalid);
	if (parts.length === 1) return new Date(dayMillis);

	let time = parts[1];
	let offsetMinutes = 0;
	const zoneMatch = SINCE_ZONE.exec(time);
	if (zoneMatch !== null) {
		const parsed = zoneOffsetMinutes(zoneMatch[1]);
		if (parsed === undefined) throw new TypeError(invalid);
		offsetMinutes = parsed;
		time = time.slice(0, -zoneMatch[1].length);
	}
	const [clock, fraction, ...extra] = time.split(".");
	const segments = clock.split(":");
	if (
		extra.length > 0 ||
		(fraction !== undefined && !SINCE_FRACTION.test(fraction)) ||
		!(segments.length === 2 || segments.length === 3) ||
		!segments.every((segment) => SINCE_CLOCK.test(segment))
	) {
		throw new TypeError(invalid);
	}
	const hour = Number(segments[0]);
	const minute = Number(segments[1]);
	const second = Number(segments[2] ?? "0");
	if (hour > 23 || minute > 59 || second > 59) throw new TypeError(invalid);
	const fractionMillis = fraction === undefined ? 0 : Number(fraction.padEnd(3, "0").slice(0, 3));
	const millis =
		dayMillis +
		((hour * 60 + minute) * 60 + second) * MILLISECONDS_PER_SECOND +
		fractionMillis -
		offsetMinutes * MINUTE_MILLIS;
	return new Date(millis);
};

const parseRunArgs = (
	rest: string[],
):
	| { kind: "args"; booleans: Set<string>; values: Map<string, string>; target: string | undefined }
	| { kind: "help" } => {
	const { booleans, positionals, values } = parseArgs(rest);
	if (booleans.has("--help") || booleans.has("-h")) {
		showHelp();
		return { kind: "help" };
	}
	const target = positionals[0];
	return { kind: "args", booleans, values, target };
};

const runWatch = async (
	rest: string[],
	options: {
		config?: Partial<Profile>;
		iterations?: number;
		logger?: Logger;
		lockDir?: string;
		runner?: Runner;
		stateFile?: string;
	},
): Promise<void> => {
	const parsed = parseRunArgs(rest);
	if (parsed.kind === "help") {
		return;
	}
	const { booleans, values, target: rawTarget } = parsed;
	const toStderr = booleans.has("--log") ? true : undefined;
	const logger = options.logger ?? createLogger({ toStderr: toStderr ?? false });
	const warn = makeWarn(toStderr ?? false, logger);

	for (const flag of ["--ack", "--json", "--output-file", "--since"]) {
		if (booleans.has(flag) || values.has(flag)) {
			await warn("unsupported flag", { flag });
		}
	}

	const runner = options.runner ?? exec;
	const target = rawTarget || (await resolveDefaultTarget(runner));
	const interval = parseInterval(values.get("--interval"), { fallback: undefined });
	const timeoutSeconds = parseTimeout(values.get("--timeout"));
	const debug = booleans.has("--debug") ? true : undefined;
	const dryRun = booleans.has("--dry-run") ? true : undefined;
	const includeClosed = booleans.has("--closed") ? true : undefined;
	const unsafeNoUser = booleans.has("--unsafe-no-user") ? true : undefined;
	const allowedUser = values.get("--user");
	const prompt = values.get("--prompt");
	const model = values.get("--model");
	const provider = values.get("--provider");
	await watch(target, {
		includeClosed,
		allowedUser,
		config: options.config,
		debug,
		dryRun,
		interval,
		iterations: options.iterations,
		logger: options.logger,
		lockDir: options.lockDir,
		model,
		prompt,
		provider,
		runner: options.runner,
		stateFile: options.stateFile,
		timeoutSeconds,
		toStderr,
		unsafeNoUser,
	});
};

const runStream = async (
	rest: string[],
	options: {
		config?: Partial<Profile>;
		iterations?: number;
		logger?: Logger;
		lockDir?: string;
		runner?: Runner;
		stateFile?: string;
	},
): Promise<void> => {
	const parsed = parseRunArgs(rest);
	if (parsed.kind === "help") {
		return;
	}
	const { booleans, values, target: rawTarget } = parsed;
	const toStderr = booleans.has("--log") ? true : undefined;
	const logger = options.logger ?? createLogger({ toStderr: toStderr ?? false });
	const warn = makeWarn(toStderr ?? false, logger);

	for (const flag of [
		"--fix",
		"--dry-run",
		"--json",
		"--model",
		"--provider",
		"--prompt",
		"--timeout",
	]) {
		if (booleans.has(flag) || values.has(flag)) {
			await warn("unsupported flag", { flag });
		}
	}

	const rawOutputFile = values.get("--output-file");

	if (booleans.has("--output-file")) {
		throw new TypeError("--output-file requires a value");
	}
	if (rawOutputFile === "") {
		throw new TypeError("--output-file path cannot be empty");
	}
	if (booleans.has("--since")) {
		throw new TypeError("--since requires an ISO-8601 timestamp");
	}

	const debug = booleans.has("--debug") ? true : undefined;
	const includeClosed = booleans.has("--closed") ? true : undefined;
	const unsafeNoUser = booleans.has("--unsafe-no-user") ? true : undefined;
	const allowedUser = values.get("--user");
	const interval = parseInterval(values.get("--interval"), { fallback: undefined });
	const outputFile = rawOutputFile;
	const since = parseSince(values.get("--since"));
	const ack = booleans.has("--ack") ? true : undefined;
	const runner = options.runner ?? exec;
	let target = rawTarget;
	if (target === undefined || target === "") {
		target = await resolveDefaultTarget(runner);
	}

	await stream(target, {
		ack,
		includeClosed,
		allowedUser,
		config: options.config,
		debug,
		interval,
		iterations: options.iterations,
		logger: options.logger,
		lockDir: options.lockDir,
		outputFile,
		runner: options.runner,
		since,
		stateFile: options.stateFile,
		toStderr,
		unsafeNoUser,
	});
};

const run = Object.assign(
	async (
		argv: string[] = process.argv.slice(CLI_ARGV_OFFSET),
		options: {
			config?: Partial<Profile>;
			iterations?: number;
			logger?: Logger;
			lockDir?: string;
			runner?: Runner;
			stateFile?: string;
		} = {},
	): Promise<void> => {
		try {
			const [subcommand, ...rest] = argv;
			if (subcommand === "--version" || subcommand === "-v") {
				const packageJson = JSON.parse(
					readFileSync(new URL("../package.json", import.meta.url), "utf8"), // oxlint-disable-line security/detect-non-literal-fs-filename -- package.json is a build-time relative path
				);
				process.stdout.write(`crewmate/${packageJson.version}\n`);
				return;
			}
			if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
				showHelp();
				return;
			}
			if (subcommand === "watch") {
				await runWatch(rest, options);
				return;
			}
			if (subcommand === "stream") {
				await runStream(rest, options);
				return;
			}
			throw new TypeError(`Unknown command '${subcommand}'. Run 'crewmate --help' for usage.`);
		} catch (error) {
			if (isEpipeError(error)) {
				process.exitCode = 0;
				return;
			}
			process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	},
	{
		exec,
		fetchMentions,
		fetchOpenItems,
		findFlag,
		findNewMention,
		findNewMentions,
		getLogin,
		loadState,
		parseGitRemoteUrl,
		parseInterval,
		parsePrUrl,
		parseSince,
		parseTarget,
		pollMentions,
		parseTimeout,
		pruneState,
		saveState,
		statePath,
		stream,
		watch,
	},
);

export default run;
