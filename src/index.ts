import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
	dispatchMention,
	errorMessage,
	getLogin,
	CREWMATE_PREFIX,
	type Mention,
	reactionEndpoint,
	type Runner,
	stripFences,
} from "./fix.js";

import { createLogger, type Logger } from "./log.js";
import { loadState, saveState, statePath } from "./state.js";
import { resolveProfile, type Profile } from "./config.js";
import { runInit } from "./init.js";

export type { Mention };

const CLI_ARGV_OFFSET = 2;
const EXPECTED_PATH_PARTS = 4;
const DEFAULT_INTERVAL_SECONDS = 60;
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

const parsePrUrl = (
	prUrl: string,
): { host: string; owner: string; port?: string; repo: string; number: string } => {
	if (/^https?:\/\//i.test(prUrl)) {
		const url = new URL(prUrl);
		const parts = url.pathname.split("/").filter(Boolean);
		const [owner, repo, pull, number] = parts;
		if (
			parts.length !== EXPECTED_PATH_PARTS ||
			pull !== "pull" ||
			typeof owner !== "string" ||
			typeof repo !== "string" ||
			typeof number !== "string" ||
			!isValidName(owner) ||
			!isValidName(repo) ||
			!/^\d+$/.test(number)
		) {
			throw new TypeError(`Invalid PR reference: ${prUrl}`);
		}
		return { host: url.hostname, number, owner, repo, ...(url.port ? { port: url.port } : {}) };
	}

	const shorthand = PR_SHORTHAND.exec(prUrl);
	if (shorthand) {
		const [, owner, repo, number] = shorthand;
		return { host: "github.com", number, owner, repo };
	}

	throw new TypeError(`Invalid PR reference: ${prUrl}`);
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
	hostWithPort: string,
	runner: Runner,
): Promise<Mention[]> => {
	const endpoint =
		kind === "conversation"
			? `repos/${owner}/${repo}/issues/${number}/comments`
			: `repos/${owner}/${repo}/pulls/${number}/comments`;
	const output = await runner("gh", ["api", "--paginate", "--slurp", endpoint], {
		env: { GH_HOST: hostWithPort },
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
	hostWithPort: string,
	runner: Runner,
): Promise<Mention | undefined> => {
	const output = await runner("gh", ["api", `repos/${owner}/${repo}/issues/${number}`], {
		env: { GH_HOST: hostWithPort },
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
	isSeen: boolean;
	isCrewmateReplied: boolean;
	userAllowed: boolean;
};

const getMentionFilterDetails = (
	comment: Mention,
	seen: Set<string>,
	crewmateRepliedIds: Set<string>,
	allowedUser?: string,
): MentionFilterDetails => {
	const key = `${comment.kind}:${comment.id}`;
	const startsWithPrefix = comment.body.startsWith(CREWMATE_PREFIX);
	const hasMention = /(?:^|\W)@crewmate\b/i.test(comment.body);
	const isReply = comment.inReplyToId !== undefined;
	const isSeen = seen.has(key);
	const isCrewmateReplied = crewmateRepliedIds.has(key);
	const userAllowed = allowedUser === undefined || getLogin(comment.user) === allowedUser;
	return {
		passes:
			!startsWithPrefix && hasMention && !isReply && !isSeen && !isCrewmateReplied && userAllowed,
		startsWithPrefix,
		hasMention,
		isReply,
		isSeen,
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
	seenIds: string[],
	allowedUser?: string,
	isFresh = false,
	since?: Date,
): Mention[] => {
	const seen = new Set(seenIds);
	const crewmateRepliedIds = findCrewmateRepliedIds(comments, isFresh);
	return comments
		.filter((comment) => {
			const details = getMentionFilterDetails(comment, seen, crewmateRepliedIds, allowedUser);
			if (!details.passes) return false;
			return since === undefined || passesSinceFilter(comment.createdAt, since);
		})
		.toSorted((first, second) => second.id - first.id);
};

const findNewMention = (...args: Parameters<typeof findNewMentions>): Mention | undefined =>
	findNewMentions(...args).at(0);

const respondToMention = async (
	mention: Mention,
	prUrl: string,
	options: {
		allowFix: boolean;
		checkedOut: Set<string>;
		dryRun: boolean;
		logger: Logger;
		model?: string;
		prompt?: string;
		provider?: string;
		repoRoot?: string;
		runner: Runner;
		warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
	},
): Promise<void> => {
	const { runner } = options;
	const parsed = parseTarget(prUrl);
	if (parsed.kind !== "pr" && parsed.kind !== "issue") {
		throw new TypeError(`Invalid item reference: ${prUrl}`);
	}
	const { host, owner, port, repo, number } = parsed;
	const commentId = mention.id;
	const ctx = {
		checkedOut: options.checkedOut,
		commentId,
		dryRun: options.dryRun,
		ghHost: hostWithPort(host, port),
		kind: mention.kind,
		logger: options.logger,
		model: options.model,
		number,
		owner,
		prUrl,
		prompt: options.prompt,
		provider: options.provider,
		repo,
		repoRoot: options.repoRoot,
		runner,
		warn: options.warn,
	};
	await dispatchMention(mention, ctx, { allowFix: options.allowFix });
};

const saveMention = async (
	state: Map<string, string[]>,
	prUrl: string,
	mention: Mention,
): Promise<void> => {
	const stateKey = `${mention.kind}:${mention.id}`;
	state.set(prUrl, [...(state.get(prUrl) ?? []), stateKey]);
	await saveState(state);
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

const pollMentions = async (
	prUrl: string,
	options: {
		allowFix?: boolean;
		allowedUser?: string;
		debug?: boolean;
		dryRun: boolean;
		logger: Logger;
		onMention: (mention: Mention, checkedOut: Set<string>) => Promise<void>;
		runner: Runner;
		saveAfterEmit: boolean;
		since?: Date;
		warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
	},
): Promise<void> => {
	await options.logger("poll", { url: prUrl });
	const state = await loadState(undefined, async () =>
		options.warn("state file is corrupted, resetting", { reason: "state-corrupted" }),
	);
	const comments = await fetchMentions(prUrl, options.runner);
	const isFresh = (state.get(prUrl)?.length ?? 0) === 0;
	const seen = new Set(state.get(prUrl) ?? []);
	const crewmateRepliedIds = findCrewmateRepliedIds(comments, isFresh);

	if (options.debug) {
		await options.logger("debug", {
			stage: "fetched-comments",
			url: prUrl,
			count: comments.length,
			comments: comments.map((comment) => ({
				...debugMentionSummary(comment),
				inReplyToId: comment.inReplyToId,
			})),
		});

		const filterDetails = comments.map((comment) => ({
			...debugMentionSummary(comment),
			...getMentionFilterDetails(comment, seen, crewmateRepliedIds, options.allowedUser),
			...(options.since === undefined
				? {}
				: { sincePass: passesSinceFilter(comment.createdAt, options.since) }),
		}));

		await options.logger("debug", {
			stage: "mention-filter",
			url: prUrl,
			allowedUser: options.allowedUser,
			details: filterDetails,
		});
	}

	const mentions = findNewMentions(
		comments,
		[...seen],
		options.allowedUser,
		isFresh,
		options.since,
	);

	if (options.debug) {
		await options.logger("debug", {
			stage: "new-mentions",
			url: prUrl,
			count: mentions.length,
			mentions: mentions.map((mention) => debugMentionSummary(mention)),
		});
	}

	const checkedOut = new Set<string>();
	for (const mention of mentions) {
		await options.logger("mention", {
			allowFix: options.allowFix,
			commentId: mention.id,
			dryRun: options.dryRun,
			kind: mention.kind,
			user: getLogin(mention.user),
			url: prUrl,
		});
		if (!options.dryRun && !options.saveAfterEmit) {
			await saveMention(state, prUrl, mention);
		}
		await options.onMention(mention, checkedOut);
		if (!options.dryRun && options.saveAfterEmit) {
			await saveMention(state, prUrl, mention);
		}
	}
	if (!options.dryRun && isFresh && crewmateRepliedIds.size > 0) {
		const existing = new Set(state.get(prUrl) ?? []);
		for (const id of crewmateRepliedIds) {
			existing.add(id);
		}
		state.set(prUrl, [...existing]);
		await saveState(state);
	}
};

type PollScope = (
	scope: Scope,
	options: {
		interval: number;
		iterations: number;
		target: string;
	},
	onPr: (prUrl: string, scope: Scope) => Promise<void>,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
) => Promise<void>;

const pollScope: PollScope = async (scope, options, onPr, runner, warn) => {
	let warnedNoOpenItems = false;
	for (let index = 0; index < options.iterations; index += 1) {
		const itemUrls =
			scope.kind === "pr" || scope.kind === "issue"
				? [toItemUrl(scope)]
				: await fetchOpenItems(scope, runner, warn);
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
					await onPr(itemUrl, scope);
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
	| { kind: "repo"; host: string; owner: string; port?: string; repo: string }
	| { kind: "org"; host: string; org: string; port?: string };

type RepoScope = Extract<Scope, { kind: "repo" }>;

const REPO_SHORTHAND = new RegExp(
	`^(?!\\.\\.?(?:\\/|$))(${NAME})\\/(?!\\.\\.?(?:\\/|$))(${NAME})\\/?$`,
);

const parseTarget = (target: string): Scope => {
	if (target.startsWith("org:")) {
		const org = target.slice(4).replace(/\/$/, "");
		if (!isValidName(org)) {
			throw new TypeError(`Invalid target: ${target}`);
		}
		return { kind: "org", host: "github.com", org };
	}

	if (/^https:\/\//i.test(target)) {
		let url: URL;
		try {
			url = new URL(target);
		} catch {
			throw new TypeError(`Invalid target: ${target}`);
		}
		const parts = url.pathname.split("/").filter(Boolean);
		const [first, second, third, fourth] = parts;

		if (
			parts.length === 2 &&
			first === "orgs" &&
			typeof second === "string" &&
			isValidName(second)
		) {
			return {
				kind: "org",
				host: url.hostname,
				org: second,
				...(url.port ? { port: url.port } : {}),
			};
		}

		if (
			parts.length === 4 &&
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
			parts.length === 4 &&
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
	scope: RepoScope,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
): Promise<string[]> => {
	try {
		const output = await runner(
			"gh",
			["api", "--paginate", "--slurp", `repos/${scope.owner}/${scope.repo}/issues?state=open`],
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
	scope: Extract<Scope, { kind: "repo" | "org" }>,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
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
	scope: Extract<Scope, { kind: "repo" | "org" }>,
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
): Promise<string[]> => {
	if (scope.kind === "pr" || scope.kind === "issue") {
		throw new Error("fetchOpenItems should not be called for a single item");
	}

	const prQuery =
		scope.kind === "repo"
			? `repo:${scope.owner}/${scope.repo} is:pr is:open`
			: `org:${scope.org} is:pr is:open`;
	const issueQuery =
		scope.kind === "repo"
			? `repo:${scope.owner}/${scope.repo} is:issue is:open`
			: `org:${scope.org} is:issue is:open`;

	const [prResult, issueResult] = await Promise.allSettled([
		searchItemsByQuery(scope, runner, warn, prQuery),
		searchItemsByQuery(scope, runner, warn, issueQuery),
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
		if (scope.kind === "repo") {
			return fetchOpenItemsRepoFallback(scope, runner, warn);
		}
		throw new Error("org scope requires GHES 3.x+ search/issues");
	}

	return [];
};

const fetchOpenPrs = fetchOpenItems;

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

type ScopeRunOptions = {
	allowFix?: boolean;
	allowedUser?: string;
	config?: Partial<Profile>;
	debug?: boolean;
	dryRun?: boolean;
	interval?: number;
	iterations?: number;
	logger?: Logger;
	model?: string;
	prompt?: string;
	provider?: string;
	runner?: Runner;
	since?: Date;
	toStderr?: boolean;
	unsafeNoUser?: boolean;
};

type ScopeContext = {
	allowFix: boolean;
	allowedUser: string | undefined;
	debug: boolean;
	dryRun: boolean;
	logger: Logger;
	model: string | undefined;
	prompt: string | undefined;
	provider: string | undefined;
	repoRoot: string | undefined;
	runner: Runner;
	since: Date | undefined;
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
};

const runScope = async (
	target: string,
	options: ScopeRunOptions,
	callbacks: {
		onPr: (ctx: ScopeContext, prUrl: string, scope: Scope) => Promise<void>;
		requiresGitForPr: boolean;
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

		let repoRoot: string | undefined;
		let profile: Partial<Profile>;
		const ghHost = hostWithPort(scope.host, scope.port);
		const ghHostEnv = { env: { GH_HOST: ghHost } };
		await runner("gh", ["--version"], ghHostEnv);
		await authenticateHost(runner, ghHost, ghHostEnv);

		if (scope.kind === "pr") {
			try {
				repoRoot = (await runner("git", ["rev-parse", "--show-toplevel"])).trim() || undefined;
			} catch {
				if (callbacks.requiresGitForPr) {
					throw new Error("watch requires a git working tree");
				}
			}

			profile =
				options.config ?? (await resolveProfile(scope.owner, scope.repo, repoRoot, configWarn));
		} else if (scope.kind === "issue") {
			profile =
				options.config ?? (await resolveProfile(scope.owner, scope.repo, undefined, configWarn));
		} else {
			const owner = scope.kind === "org" ? scope.org : scope.owner;
			const repo = scope.kind === "org" ? undefined : scope.repo;
			profile = options.config ?? (await resolveProfile(owner, repo, undefined, configWarn));
		}
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
		let allowFix = options.allowFix ?? profile.fix ?? false;
		const dryRun = options.dryRun ?? profile.dryRun ?? false;
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

		if (scope.kind !== "pr" && allowFix) {
			await warn("fix is not supported for repo, org, or issue scope targets; disabling", {
				reason: "scope-fix-disabled",
				target,
			});
			allowFix = false;
		}

		if (callbacks.requiresProvider) {
			await runner(provider || "claude", ["--version"]);
		}

		const iterations = options.iterations ?? Infinity;

		if (dryRun) {
			if (!toStderr) {
				try {
					process.stderr.write(
						"Dry-run mode: no GitHub comments, reactions, or git add/commit/push will be made.\n",
					);
				} catch {}
			}
			await logger("info", {
				message:
					"Dry-run mode: no GitHub comments, reactions, or git add/commit/push will be made.",
			});
		}

		const ctx: ScopeContext = {
			allowFix,
			allowedUser,
			debug,
			dryRun,
			logger,
			model,
			prompt,
			provider,
			repoRoot,
			runner,
			since: options.since,
			warn,
		};

		await pollScope(
			scope,
			{ interval, iterations, target },
			async (prUrl, pollScopeScope) => {
				await callbacks.onPr(ctx, prUrl, pollScopeScope);
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

const watch = async (
	target: string,
	options: {
		interval?: number;
		allowFix?: boolean;
		allowedUser?: string;
		config?: Partial<Profile>;
		debug?: boolean;
		dryRun?: boolean;
		logger?: Logger;
		model?: string;
		prompt?: string;
		provider?: string;
		runner?: Runner;
		iterations?: number;
		since?: Date;
		toStderr?: boolean;
		unsafeNoUser?: boolean;
	} = {},
): Promise<void> => {
	await runScope(target, options, {
		onPr: async (ctx, prUrl, _scope) => {
			await pollMentions(prUrl, {
				allowFix: ctx.allowFix,
				allowedUser: ctx.allowedUser,
				debug: ctx.debug,
				dryRun: ctx.dryRun,
				logger: ctx.logger,
				onMention: (mention, checkedOut) =>
					respondToMention(mention, prUrl, {
						allowFix: ctx.allowFix,
						checkedOut,
						dryRun: ctx.dryRun,
						logger: ctx.logger,
						model: ctx.model,
						prompt: ctx.prompt,
						provider: ctx.provider,
						repoRoot: ctx.repoRoot,
						runner: ctx.runner,
						warn: ctx.warn,
					}),
				runner: ctx.runner,
				saveAfterEmit: false,
				since: ctx.since,
				warn: ctx.warn,
			});
		},
		requiresGitForPr: true,
		requiresProvider: true,
	});
};

const stream = async (
	target: string,
	options: {
		ack?: boolean;
		allowedUser?: string;
		config?: Partial<Profile>;
		debug?: boolean;
		interval?: number;
		iterations?: number;
		logger?: Logger;
		outputFile?: string;
		runner?: Runner;
		since?: Date;
		toStderr?: boolean;
		unsafeNoUser?: boolean;
	} = {},
): Promise<void> => {
	await runScope(
		target,
		{ ...options, allowFix: false, dryRun: false },
		{
			onPr: async (ctx, prUrl) => {
				const parsed = parseTarget(prUrl) as Extract<Scope, { kind: "pr" | "issue" }>;
				const ghHost = hostWithPort(parsed.host, parsed.port);
				await pollMentions(prUrl, {
					allowFix: false,
					allowedUser: ctx.allowedUser,
					debug: ctx.debug,
					dryRun: false,
					logger: ctx.logger,
					onMention: async (mention, _checkedOut) => {
						let reactionId: number | undefined;
						if (options.ack) {
							reactionId = await ackMention(
								mention,
								parsed.owner,
								parsed.repo,
								parsed.number,
								ghHost,
								ctx.runner,
								ctx.warn,
							);
						}
						const event: Record<string, unknown> = {
							at: new Date().toISOString(),
							event: "mention",
							owner: parsed.owner,
							repo: parsed.repo,
							number: Number(parsed.number),
							commentId: mention.kind === "issue" ? Number(parsed.number) : mention.id,
							kind: mention.kind,
							user: getLogin(mention.user),
							body: mention.body,
							url: prUrl,
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
					saveAfterEmit: true,
					since: ctx.since,
					warn: ctx.warn,
				});
			},
			requiresGitForPr: false,
			requiresProvider: false,
		},
	);
};

const VALUE_FLAGS = new Set([
	"--interval",
	"--user",
	"--prompt",
	"--model",
	"--provider",
	"--output-file",
	"--since",
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
		runner?: Runner;
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
	const allowFix = booleans.has("--fix") ? true : undefined;
	const debug = booleans.has("--debug") ? true : undefined;
	const dryRun = booleans.has("--dry-run") ? true : undefined;
	const unsafeNoUser = booleans.has("--unsafe-no-user") ? true : undefined;
	const allowedUser = values.get("--user");
	const prompt = values.get("--prompt");
	const model = values.get("--model");
	const provider = values.get("--provider");
	await watch(target, {
		allowFix,
		allowedUser,
		config: options.config,
		debug,
		dryRun,
		interval,
		iterations: options.iterations,
		logger: options.logger,
		model,
		prompt,
		provider,
		runner: options.runner,
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
		runner?: Runner;
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

	for (const flag of ["--fix", "--dry-run", "--json", "--model", "--provider", "--prompt"]) {
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

	const runner = options.runner ?? exec;
	const target = rawTarget || (await resolveDefaultTarget(runner));
	const interval = parseInterval(values.get("--interval"), { fallback: undefined });
	const since = parseSince(values.get("--since"));
	const ack = booleans.has("--ack") ? true : undefined;
	const debug = booleans.has("--debug") ? true : undefined;
	const unsafeNoUser = booleans.has("--unsafe-no-user") ? true : undefined;
	const allowedUser = values.get("--user");
	const outputFile = rawOutputFile;

	await stream(target, {
		ack,
		allowedUser,
		config: options.config,
		debug,
		interval,
		iterations: options.iterations,
		logger: options.logger,
		outputFile,
		runner: options.runner,
		since,
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
			runner?: Runner;
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
			if (subcommand === "init") {
				await runInit();
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
		fetchOpenPrs,
		findFlag,
		findNewMention,
		findNewMentions,
		getLogin,
		loadState,
		parseGitRemoteUrl,
		parseInterval,
		parsePrUrl,
		parseTarget,
		respondToMention,
		saveState,
		statePath,
		stream,
		stripFences,
		watch,
	},
);

export default run;
