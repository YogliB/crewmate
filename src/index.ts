import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { readFileSync } from "node:fs";
import process from "node:process";
import {
	dispatchMention,
	errorMessage,
	getLogin,
	PICKUP_PREFIX,
	type Mention,
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

const execFilePromise = promisify(execFile);

const exec: Runner = async (file, args, options) => {
	const { stdout } = await execFilePromise(file, args, {
		encoding: "utf8",
		env: options?.env ? { ...process.env, ...options.env } : process.env,
	});
	return stdout;
};

function showHelp(): void {
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- HELP_PATH is a build-time constant
	process.stdout.write(`\n${readFileSync(HELP_PATH, "utf8")}\n`);
}

const NAME = "[A-Za-z0-9_.-]+";

const isValidName = (name: string): boolean =>
	new RegExp(`^(?!\\.\\.?(?:\\/|$))(${NAME})$`).test(name) &&
	!new RegExp(`^(?:\\.\\.?)$`).test(name);

const PR_SHORTHAND = new RegExp(
	`^(?!\\.\\.?(?:\\/|$))(${NAME})\\/(?!\\.\\.?(?:\\/|$))(${NAME})\\/pull\\/(\\d+)\\/?$`,
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
	if (kind === "conversation") {
		return { id: raw.id, body: raw.body, user: raw.user, kind: "conversation", inReplyToId };
	}
	if (typeof raw.path !== "string" || typeof raw.line !== "number") return undefined;
	return {
		id: raw.id,
		body: raw.body,
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

const fetchMentions = async (prUrl: string, runner: Runner = exec): Promise<Mention[]> => {
	const { host, owner, port, repo, number } = parsePrUrl(prUrl);
	const ghHost = hostWithPort(host, port);
	const [review, conversation] = await Promise.all([
		fetchKind(owner, repo, number, "review", ghHost, runner),
		fetchKind(owner, repo, number, "conversation", ghHost, runner),
	]);
	return [...review, ...conversation];
};

// ponytail: conversation comments do not expose a parent id, so a fresh state cannot
// suppress already-answered conversation mentions. Scope the fallback to review threads only.
const findPickupRepliedIds = (comments: Mention[], isFresh: boolean): Set<string> =>
	isFresh
		? new Set(
				comments.flatMap((comment) =>
					comment.kind === "review" &&
					comment.body.startsWith(PICKUP_PREFIX) &&
					typeof comment.inReplyToId === "number"
						? [`${comment.kind}:${comment.inReplyToId}`]
						: [],
				),
			)
		: new Set<string>();

const findNewMentions = (
	comments: Mention[],
	seenIds: string[],
	allowedUser?: string,
	isFresh = false,
): Mention[] => {
	const seen = new Set(seenIds);
	const pickupRepliedIds = findPickupRepliedIds(comments, isFresh);
	return (
		comments
			.filter(
				(comment) =>
					!comment.body.startsWith(PICKUP_PREFIX) &&
					/(?:^|\W)@pickup\b/i.test(comment.body) &&
					comment.inReplyToId === undefined &&
					!seen.has(`${comment.kind}:${comment.id}`) &&
					!pickupRepliedIds.has(`${comment.kind}:${comment.id}`) &&
					(allowedUser === undefined || getLogin(comment.user) === allowedUser),
			)
			// ponytail: review and issue comment ids may come from different sequences; sorting by id is
			// a coarse proxy for newest-first. Per-kind ordering is preserved by creation time in practice.
			.toSorted((first, second) => second.id - first.id)
	);
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
	const { host, owner, port, repo, number } = parsePrUrl(prUrl);
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

const pollMentions = async (
	prUrl: string,
	options: {
		allowFix?: boolean;
		allowedUser?: string;
		dryRun: boolean;
		logger: Logger;
		onMention: (mention: Mention, checkedOut: Set<string>) => Promise<void>;
		runner: Runner;
		saveAfterEmit: boolean;
		warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
	},
): Promise<void> => {
	await options.logger("poll", { url: prUrl });
	const state = await loadState(undefined, async () =>
		options.warn("state file is corrupted, resetting", { reason: "state-corrupted" }),
	);
	const comments = await fetchMentions(prUrl, options.runner);
	const isFresh = (state.get(prUrl)?.length ?? 0) === 0;
	const pickupRepliedIds = findPickupRepliedIds(comments, isFresh);
	const mentions = findNewMentions(comments, state.get(prUrl) ?? [], options.allowedUser, isFresh);
	// Each poll cycle gets a fresh checkout set so a long-running watch re-syncs
	// the PR branch once per poll while still avoiding repeated checkouts for
	// multiple mentions handled in the same cycle.
	const checkedOut = new Set<string>();
	// Dry-run polls are intentionally stateless so a preview does not advance
	// the persistent seen-mention cursor.
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
	if (!options.dryRun && isFresh && pickupRepliedIds.size > 0) {
		const existing = new Set(state.get(prUrl) ?? []);
		for (const id of pickupRepliedIds) {
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
	onPr: (prUrl: string) => Promise<void>,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
) => Promise<void>;

const pollScope: PollScope = async (scope, options, onPr, runner, warn) => {
	let warnedNoOpenPrs = false;
	for (let index = 0; index < options.iterations; index += 1) {
		const prUrls = scope.kind === "pr" ? [toPrUrl(scope)] : await fetchOpenPrs(scope, runner, warn);
		if (prUrls.length === 0) {
			if (!warnedNoOpenPrs) {
				warnedNoOpenPrs = true;
				await warn("No open PRs found for the target", {
					reason: "no-open-prs",
					target: options.target,
				});
			}
		} else {
			for (const prUrl of prUrls) {
				try {
					await onPr(prUrl);
				} catch (error) {
					const message = errorMessage(error);
					await warn(`poll failed for ${prUrl}`, {
						error: message,
						prUrl,
						reason: "pr-poll-failed",
					});
					if (scope.kind === "pr") {
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

const toScopePrUrl = (scope: { host: string; port?: string }, url: string): string => {
	const parsed = parsePrUrl(url);
	return toPrUrl({ ...parsed, host: scope.host, port: scope.port });
};

export type Scope =
	| { kind: "pr"; host: string; owner: string; port?: string; repo: string; number: string }
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

	const repoShorthand = REPO_SHORTHAND.exec(target);
	if (repoShorthand) {
		const [, owner, repo] = repoShorthand;
		return { kind: "repo", host: "github.com", owner, repo };
	}

	throw new TypeError(`Invalid target: ${target}`);
};

const fetchOpenPrsRepoFallback = async (
	scope: RepoScope,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
): Promise<string[]> => {
	try {
		const output = await runner(
			"gh",
			["api", "--paginate", "--slurp", `repos/${scope.owner}/${scope.repo}/pulls?state=open`],
			{ env: { GH_HOST: hostWithPort(scope.host, scope.port) } },
		);
		const pages = JSON.parse(output) as { html_url?: unknown }[][];
		const prUrls: string[] = [];
		for (const pr of pages.flat()) {
			const url = pr.html_url;
			if (typeof url !== "string") continue;
			try {
				prUrls.push(toScopePrUrl(scope, url));
			} catch {
				await warn(`invalid PR URL from repo fallback: ${url}`, {
					reason: "fallback-invalid-url",
					url,
				});
			}
		}
		return prUrls;
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

const fetchOpenPrs = async (
	scope: Scope,
	runner: Runner,
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>,
): Promise<string[]> => {
	if (scope.kind === "pr") {
		throw new Error("fetchOpenPrs should not be called for a single PR");
	}

	let query: string;
	if (scope.kind === "repo") {
		query = `repo:${scope.owner}/${scope.repo} is:pr is:open`;
	} else {
		query = `org:${scope.org} is:pr is:open`;
	}
	const encoded = encodeURIComponent(query);
	try {
		const output = await runner(
			"gh",
			["api", "--paginate", "--slurp", `search/issues?q=${encoded}`],
			{ env: { GH_HOST: hostWithPort(scope.host, scope.port) } },
		);
		const pages = JSON.parse(output) as { items?: { html_url?: unknown }[] }[];
		const prUrls: string[] = [];
		for (const page of pages) {
			for (const item of page.items ?? []) {
				const url = item.html_url;
				if (typeof url !== "string") continue;
				try {
					prUrls.push(toScopePrUrl(scope, url));
				} catch {
					await warn(`invalid PR URL from search: ${url}`, { reason: "search-invalid-url", url });
				}
			}
		}
		return prUrls;
	} catch (error) {
		const message = errorMessage(error);
		const statusMatch = message.match(/HTTP (\d{3})/);
		const status = statusMatch ? Number(statusMatch[1]) : 0;
		if (status === 404) {
			if (scope.kind === "repo") {
				return fetchOpenPrsRepoFallback(scope, runner, warn);
			}
			throw new Error("org scope requires GHES 3.x+ search/issues", { cause: error });
		}
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
		return [];
	}
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

type ScopeRunOptions = {
	allowFix?: boolean;
	allowedUser?: string;
	config?: Partial<Profile>;
	dryRun?: boolean;
	interval?: number;
	iterations?: number;
	logger?: Logger;
	model?: string;
	prompt?: string;
	provider?: string;
	runner?: Runner;
	toStderr?: boolean;
};

type ScopeContext = {
	allowFix: boolean;
	allowedUser: string | undefined;
	dryRun: boolean;
	logger: Logger;
	model: string | undefined;
	prompt: string | undefined;
	provider: string | undefined;
	repoRoot: string | undefined;
	runner: Runner;
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
};

const runScope = async (
	target: string,
	options: ScopeRunOptions,
	callbacks: {
		onPr: (ctx: ScopeContext, prUrl: string) => Promise<void>;
		requiresGitForPr: boolean;
		requiresProvider: boolean;
	},
): Promise<void> => {
	const runner = options.runner ?? exec;
	let toStderr = options.toStderr ?? false;
	let logger = options.logger ?? createLogger({ toStderr });
	const configWarn = makeWarn(toStderr, logger);
	let normalizedPrUrl = target;
	try {
		const scope = parseTarget(target);
		normalizedPrUrl = scope.kind === "pr" ? toPrUrl(scope) : target;

		let repoRoot: string | undefined;
		let profile: Partial<Profile>;
		const ghHost = hostWithPort(scope.host, scope.port);
		const ghHostEnv = { env: { GH_HOST: ghHost } };
		if (scope.kind === "pr") {
			await runner("gh", ["--version"], ghHostEnv);
			await runner("gh", ["auth", "status"], ghHostEnv);
			try {
				repoRoot = (await runner("git", ["rev-parse", "--show-toplevel"])).trim() || undefined;
			} catch {
				if (callbacks.requiresGitForPr) {
					throw new Error("watch requires a git working tree");
				}
			}

			profile =
				options.config ?? (await resolveProfile(scope.owner, scope.repo, repoRoot, configWarn));
		} else {
			const owner = scope.kind === "org" ? scope.org : scope.owner;
			const repo = scope.kind === "org" ? undefined : scope.repo;
			profile = options.config ?? (await resolveProfile(owner, repo, undefined, configWarn));
		}

		const provider = options.provider ?? profile.provider;
		const model = options.model ?? profile.model;
		const interval = options.interval ?? profile.interval ?? DEFAULT_INTERVAL_SECONDS;
		const allowedUser = options.allowedUser ?? profile.user;
		const prompt = options.prompt ?? profile.prompt;
		let allowFix = options.allowFix ?? profile.fix ?? false;
		const dryRun = options.dryRun ?? profile.dryRun ?? false;
		toStderr = options.toStderr ?? profile.log ?? false;
		if (!options.logger) {
			logger = createLogger({ toStderr });
		}
		const warn = makeWarn(toStderr, logger);

		if (scope.kind !== "pr" && allowFix) {
			await warn("fix is not supported for repo/org scope targets; disabling", {
				reason: "scope-fix-disabled",
				target,
			});
			allowFix = false;
		}

		if (scope.kind !== "pr") {
			await runner("gh", ["--version"], ghHostEnv);
			await runner("gh", ["auth", "status"], ghHostEnv);
		}
		if (callbacks.requiresProvider) {
			await runner(provider || "claude", ["--version"]);
		}

		const iterations = options.iterations ?? (dryRun ? 1 : Infinity);

		if (dryRun) {
			if (!toStderr) {
				try {
					process.stderr.write(
						"Dry-run mode: no GitHub comments or git add/commit/push will be made.\n",
					);
				} catch {}
			}
			await logger("info", {
				message: "Dry-run mode: no GitHub comments or git add/commit/push will be made.",
			});
		}

		const ctx: ScopeContext = {
			allowFix,
			allowedUser,
			dryRun,
			logger,
			model,
			prompt,
			provider,
			repoRoot,
			runner,
			warn,
		};

		await pollScope(
			scope,
			{ interval, iterations, target },
			async (prUrl) => {
				await callbacks.onPr(ctx, prUrl);
			},
			runner,
			warn,
		);
	} catch (error) {
		await logger("error", {
			errorType: error instanceof Error ? error.name : "unknown",
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			url: normalizedPrUrl,
		}).catch(() => {});
		throw error;
	}
};

const watch = async (
	target: string,
	options: {
		interval?: number;
		allowFix?: boolean;
		allowedUser?: string;
		config?: Partial<Profile>;
		dryRun?: boolean;
		logger?: Logger;
		model?: string;
		prompt?: string;
		provider?: string;
		runner?: Runner;
		iterations?: number;
		toStderr?: boolean;
	} = {},
): Promise<void> => {
	await runScope(target, options, {
		onPr: async (ctx, prUrl) => {
			await pollMentions(prUrl, {
				allowFix: ctx.allowFix,
				allowedUser: ctx.allowedUser,
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
		allowedUser?: string;
		config?: Partial<Profile>;
		interval?: number;
		iterations?: number;
		logger?: Logger;
		runner?: Runner;
		toStderr?: boolean;
	} = {},
): Promise<void> => {
	await runScope(
		target,
		{ ...options, allowFix: false, dryRun: false },
		{
			onPr: async (ctx, prUrl) => {
				const parsed = parsePrUrl(prUrl);
				// State is saved after stdout is written. If the emit fails, the
				// mention may appear again on the next poll/run; consumers deduplicate
				// by `commentId` if at-least-once delivery is a problem.
				await pollMentions(prUrl, {
					allowFix: false,
					allowedUser: ctx.allowedUser,
					dryRun: false,
					logger: ctx.logger,
					onMention: async (mention, _checkedOut) => {
						const event: Record<string, unknown> = {
							at: new Date().toISOString(),
							event: "mention",
							owner: parsed.owner,
							repo: parsed.repo,
							number: Number(parsed.number),
							commentId: mention.id,
							kind: mention.kind,
							user: getLogin(mention.user),
							body: mention.body,
							url: prUrl,
						};
						if (mention.kind === "review") {
							event.path = mention.path;
							event.line = mention.line;
						}
						process.stdout.write(JSON.stringify(event) + "\n");
					},
					runner: ctx.runner,
					saveAfterEmit: true,
					warn: ctx.warn,
				});
			},
			requiresGitForPr: false,
			requiresProvider: false,
		},
	);
};

const VALUE_FLAGS = new Set(["--interval", "--user", "--prompt", "--model", "--provider"]);

const parseArgs = (argv: string[]): { booleans: Set<string>; values: Map<string, string> } => {
	const booleans = new Set<string>();
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		// oxlint-disable-next-line security/detect-object-injection -- array index read, not property injection
		const arg = argv[i];
		if (arg === "-h") {
			booleans.add(arg);
			continue;
		}
		if (!arg.startsWith("--")) {
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
	return { booleans, values };
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

const parseRunArgs = (
	rest: string[],
):
	| { kind: "args"; booleans: Set<string>; values: Map<string, string>; target: string }
	| { kind: "help" } => {
	const [target, ...flagArgs] = rest;
	if (target === "--help" || target === "-h") {
		showHelp();
		return { kind: "help" };
	}
	if (!target || typeof target !== "string") {
		throw new TypeError("Target is required");
	}
	const { booleans, values } = parseArgs(flagArgs);
	if (booleans.has("--help") || booleans.has("-h")) {
		showHelp();
		return { kind: "help" };
	}
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
	const { booleans, values, target } = parsed;
	const interval = parseInterval(values.get("--interval"), { fallback: undefined });
	const allowFix = booleans.has("--fix") ? true : undefined;
	const dryRun = booleans.has("--dry-run") ? true : undefined;
	const toStderr = booleans.has("--log") ? true : undefined;
	const allowedUser = values.get("--user");
	const prompt = values.get("--prompt");
	const model = values.get("--model");
	const provider = values.get("--provider");
	await watch(target, {
		allowFix,
		allowedUser,
		config: options.config,
		dryRun,
		interval,
		iterations: options.iterations,
		logger: options.logger,
		model,
		prompt,
		provider,
		runner: options.runner,
		toStderr,
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
	const { booleans, values, target } = parsed;
	const interval = parseInterval(values.get("--interval"), { fallback: undefined });
	const toStderr = booleans.has("--log") ? true : undefined;
	const allowedUser = values.get("--user");

	const logger = options.logger ?? createLogger({ toStderr: toStderr ?? false });
	const warn = makeWarn(toStderr ?? false, logger);

	for (const flag of ["--fix", "--dry-run", "--json", "--model", "--provider", "--prompt"]) {
		if (booleans.has(flag) || values.has(flag)) {
			await warn("unsupported flag", { flag });
		}
	}

	await stream(target, {
		allowedUser,
		config: options.config,
		interval,
		iterations: options.iterations,
		logger: options.logger,
		runner: options.runner,
		toStderr,
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
			if (subcommand === "--help" || subcommand === "-h") {
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
			console.log("Hello from pickup!", argv);
		} catch (error) {
			process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	},
	{
		exec,
		fetchOpenPrs,
		findFlag,
		findNewMention,
		findNewMentions,
		getLogin,
		loadState,
		parseInterval,
		parsePrUrl,
		parseTarget,
		saveState,
		statePath,
		stream,
		stripFences,
		watch,
	},
);

export default run;
