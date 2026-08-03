import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { readFileSync } from "node:fs";
import process from "node:process";
import { dispatchMention, getLogin, PICKUP_PREFIX, type Runner, stripFences } from "./fix.js";
import { createLogger, type Logger } from "./log.js";
import { loadState, saveState, statePath } from "./state.js";
import { resolveProfile, type Profile } from "./config.js";
import { runInit } from "./init.js";

const CLI_ARGV_OFFSET = 2;
const EXPECTED_PATH_PARTS = 4;
const DEFAULT_INTERVAL_SECONDS = 60;
const MILLISECONDS_PER_SECOND = 1000;
const HELP_PATH = new URL("../assets/help.md", import.meta.url);

const execFilePromise = promisify(execFile);

const exec = async (file: string, args: string[]): Promise<string> => {
	const { stdout } = await execFilePromise(file, args, { encoding: "utf8" });
	return stdout.trim();
};

function showHelp(): void {
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- HELP_PATH is a build-time constant
	process.stdout.write(`\n${readFileSync(HELP_PATH, "utf8")}\n`);
}

const NAME = "[A-Za-z0-9_.-]+";
const PR_SHORTHAND = new RegExp(
	`^(?!\\.\\.?(?:\\/|$))(${NAME})\\/(?!\\.\\.?(?:\\/|$))(${NAME})\\/pull\\/(\\d+)\\/?$`,
);

const parsePrUrl = (
	prUrl: string,
): { host: string; owner: string; repo: string; number: string } => {
	if (/^https?:\/\//i.test(prUrl)) {
		const url = new URL(prUrl);
		const parts = url.pathname.split("/").filter(Boolean);
		const [owner, repo, pull, number] = parts;
		if (
			parts.length !== EXPECTED_PATH_PARTS ||
			pull !== "pull" ||
			typeof owner !== "string" ||
			typeof repo !== "string" ||
			typeof number !== "string"
		) {
			throw new TypeError(`Invalid PR reference: ${prUrl}`);
		}
		return { host: url.hostname, number, owner, repo };
	}

	const shorthand = PR_SHORTHAND.exec(prUrl);
	if (shorthand) {
		const [, owner, repo, number] = shorthand;
		return { host: "github.com", number, owner, repo };
	}

	throw new TypeError(`Invalid PR reference: ${prUrl}`);
};

const fetchReviewComments = async (
	prUrl: string,
	runner: Runner = exec,
): Promise<Record<string, unknown>[]> => {
	const { owner, repo, number } = parsePrUrl(prUrl);
	const out = await runner("gh", [
		"api",
		"--paginate",
		"--slurp",
		`repos/${owner}/${repo}/pulls/${number}/comments`,
	]);
	return (JSON.parse(out) as Record<string, unknown>[][]).flat();
};

const findNewMentions = (
	comments: Record<string, unknown>[],
	seenIds: number[],
	allowedUser?: string,
	isFresh = false,
): Record<string, unknown>[] => {
	const seen = new Set(seenIds);
	const pickupRepliedIds = isFresh
		? new Set(
				comments
					.filter(
						(comment) =>
							typeof comment.body === "string" &&
							comment.body.startsWith(PICKUP_PREFIX) &&
							typeof comment.in_reply_to_id === "number",
					)
					.map((comment) => comment.in_reply_to_id as number),
			)
		: new Set<number>();
	return comments
		.filter(
			(comment) =>
				typeof comment.body === "string" &&
				/(?:^|\W)@pickup\b/i.test(comment.body) &&
				typeof comment.id === "number" &&
				(comment.in_reply_to_id === undefined || comment.in_reply_to_id === null) &&
				typeof comment.path === "string" &&
				typeof comment.line === "number" &&
				!seen.has(comment.id) &&
				!pickupRepliedIds.has(comment.id) &&
				(allowedUser === undefined || getLogin(comment.user) === allowedUser),
		)
		.toSorted((first, second) => (second.id as number) - (first.id as number));
};

const findNewMention = (
	...args: Parameters<typeof findNewMentions>
): Record<string, unknown> | undefined => findNewMentions(...args).at(0);

const respondToMention = async (
	mention: Record<string, unknown>,
	prUrl: string,
	options: {
		allowFix: boolean;
		dryRun: boolean;
		json: boolean;
		logger: Logger;
		model?: string;
		prompt?: string;
		provider?: string;
		repoRoot: string;
		runner: Runner;
		warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
	},
): Promise<void> => {
	const { runner } = options;
	const { owner, repo, number } = parsePrUrl(prUrl);
	const commentId = mention.id as number;
	const commentBody = mention.body as string;
	const ctx = {
		commentId,
		dryRun: options.dryRun,
		json: options.json,
		logger: options.logger,
		model: options.model,
		number,
		owner,
		prompt: options.prompt,
		provider: options.provider,
		repo,
		repoRoot: options.repoRoot,
		runner,
		warn: options.warn,
	};
	await dispatchMention(mention, ctx, { allowFix: options.allowFix, commentBody });
};

const pollIteration = async (
	prUrl: string,
	runner: Runner,
	iteration: {
		allowFix: boolean;
		allowedUser?: string;
		dryRun: boolean;
		index: number;
		interval: number;
		iterations: number;
		json: boolean;
		logger: Logger;
		model?: string;
		prompt?: string;
		provider?: string;
		repoRoot: string;
		warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
	},
): Promise<void> => {
	await iteration.logger("poll", { url: prUrl });
	const state = await loadState(undefined, async () =>
		iteration.warn("state file is corrupted, resetting", { reason: "state-corrupted" }),
	);
	const comments = await fetchReviewComments(prUrl, runner);
	const mentions = findNewMentions(
		comments,
		state.get(prUrl) ?? [],
		iteration.allowedUser,
		state.size === 0,
	);
	for (const mention of mentions) {
		await iteration.logger("mention", {
			allowFix: iteration.allowFix,
			commentId: mention.id as number,
			dryRun: iteration.dryRun,
			user: getLogin(mention.user),
			url: prUrl,
		});
		if (!iteration.dryRun) {
			state.set(prUrl, [...(state.get(prUrl) ?? []), mention.id as number]);
			await saveState(state);
		}
		await respondToMention(mention, prUrl, {
			allowFix: iteration.allowFix,
			dryRun: iteration.dryRun,
			json: iteration.json,
			logger: iteration.logger,
			model: iteration.model,
			prompt: iteration.prompt,
			provider: iteration.provider,
			repoRoot: iteration.repoRoot,
			runner,
			warn: iteration.warn,
		});
	}
	if (iteration.index < iteration.iterations - 1) {
		await setTimeout(iteration.interval * MILLISECONDS_PER_SECOND);
	}
};

const toPrUrl = ({
	host,
	owner,
	repo,
	number,
}: {
	host: string;
	owner: string;
	repo: string;
	number: string;
}): string => `https://${host}/${owner}/${repo}/pull/${number}`;

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

const watch = async (
	prUrl: string,
	options: {
		interval?: number;
		allowFix?: boolean;
		allowedUser?: string;
		config?: Partial<Profile>;
		dryRun?: boolean;
		json?: boolean;
		logger?: Logger;
		model?: string;
		prompt?: string;
		provider?: string;
		runner?: Runner;
		iterations?: number;
		toStderr?: boolean;
	} = {},
): Promise<void> => {
	const runner = options.runner ?? exec;
	let toStderr = options.toStderr ?? false;
	let logger = options.logger ?? createLogger({ toStderr });
	const configWarn = makeWarn(toStderr, logger);
	let normalizedPrUrl = prUrl;
	try {
		const parsed = parsePrUrl(prUrl);
		const { host, owner, repo } = parsed;
		normalizedPrUrl = toPrUrl(parsed);
		await runner("gh", ["--version"]);
		await runner("gh", ["auth", "status", "--hostname", host]);
		const repoRoot = (await runner("git", ["rev-parse", "--show-toplevel"])).trim();
		const profile = options.config ?? (await resolveProfile(owner, repo, repoRoot, configWarn));

		const provider = options.provider ?? profile.provider;
		const model = options.model ?? profile.model;
		const interval = options.interval ?? profile.interval ?? DEFAULT_INTERVAL_SECONDS;
		const allowedUser = options.allowedUser ?? profile.user;
		const prompt = options.prompt ?? profile.prompt;
		const allowFix = options.allowFix ?? profile.fix ?? false;
		const dryRun = options.dryRun ?? profile.dryRun ?? false;
		const json = options.json ?? profile.json ?? false;
		toStderr = options.toStderr ?? profile.log ?? false;
		if (!options.logger) {
			logger = createLogger({ toStderr });
		}
		const warn = makeWarn(toStderr, logger);

		if (json && !dryRun) {
			await warn("json output only applies in dry-run mode", { json });
		}

		await runner(provider || "claude", ["--version"]);

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

		for (let index = 0; index < iterations; index += 1) {
			await pollIteration(normalizedPrUrl, runner, {
				allowFix,
				allowedUser,
				dryRun,
				index,
				interval,
				iterations,
				json,
				logger,
				model,
				prompt,
				provider,
				repoRoot,
				warn,
			});
		}
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

const VALUE_FLAGS = new Set(["--interval", "--user", "--prompt", "--model", "--provider"]);

const parseArgs = (argv: string[]): { booleans: Set<string>; values: Map<string, string> } => {
	const booleans = new Set<string>();
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 1) {
		// oxlint-disable-next-line security/detect-object-injection -- array index read, not property injection
		const arg = argv[i];
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

const runWatch = async (
	rest: string[],
	options: {
		config?: Partial<Profile>;
		iterations?: number;
		logger?: Logger;
		runner?: Runner;
	},
): Promise<void> => {
	const [prUrl, ...flagArgs] = rest;
	if (!prUrl || typeof prUrl !== "string") {
		throw new TypeError("PR reference is required");
	}
	const { booleans, values } = parseArgs(flagArgs);
	const interval = parseInterval(values.get("--interval"), { fallback: undefined });
	const allowFix = booleans.has("--fix") ? true : undefined;
	const dryRun = booleans.has("--dry-run") ? true : undefined;
	const json = booleans.has("--json") ? true : undefined;
	const toStderr = booleans.has("--log") ? true : undefined;
	const allowedUser = values.get("--user");
	const prompt = values.get("--prompt");
	const model = values.get("--model");
	const provider = values.get("--provider");
	await watch(prUrl, {
		allowFix,
		allowedUser,
		config: options.config,
		dryRun,
		interval,
		iterations: options.iterations,
		json,
		logger: options.logger,
		model,
		prompt,
		provider,
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
		findFlag,
		findNewMention,
		findNewMentions,
		getLogin,
		loadState,
		parseInterval,
		parsePrUrl,
		saveState,
		statePath,
		stripFences,
		watch,
	},
);

export default run;
