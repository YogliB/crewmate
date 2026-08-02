import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { readFileSync } from "node:fs";
import process from "node:process";
import { dispatchMention, getLogin, PICKUP_PREFIX, type Runner, stripFences } from "./fix.js";
import { loadState, saveState, statePath } from "./state.js";

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
	// eslint-disable-next-line security/detect-non-literal-fs-filename
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

const preflight = async (prUrl: string, runner: Runner = exec): Promise<string> => {
	const { host } = parsePrUrl(prUrl);
	await runner("gh", ["--version"]);
	await runner("claude", ["--version"]);
	await runner("gh", ["auth", "status", "--hostname", host]);
	const repoRoot = (await runner("git", ["rev-parse", "--show-toplevel"])).trim();
	return repoRoot;
};

const respondToMention = async (
	mention: Record<string, unknown>,
	prUrl: string,
	options: {
		allowFix: boolean;
		dryRun?: boolean;
		json?: boolean;
		prompt?: string;
		repoRoot: string;
		runner: Runner;
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
		number,
		owner,
		prompt: options.prompt,
		repo,
		repoRoot: options.repoRoot,
		runner,
	};
	await dispatchMention(mention, ctx, { allowFix: options.allowFix, commentBody });
};

const pollIteration = async (
	prUrl: string,
	runner: Runner,
	iteration: {
		allowFix: boolean;
		allowedUser?: string;
		dryRun?: boolean;
		index: number;
		interval: number;
		iterations: number;
		json?: boolean;
		prompt?: string;
		repoRoot: string;
	},
): Promise<void> => {
	const state = await loadState();
	const comments = await fetchReviewComments(prUrl, runner);
	const mentions = findNewMentions(
		comments,
		state.get(prUrl) ?? [],
		iteration.allowedUser,
		state.size === 0,
	);
	for (const mention of mentions) {
		// ponytail: persist seen ID before acting so an error does not reprocess the same mention.
		// If one respondToMention throws, the loop aborts; remaining unseen mentions are handled on the next poll.
		// In dry-run, state is not saved so a later real run can still post.
		if (!iteration.dryRun) {
			state.set(prUrl, [...(state.get(prUrl) ?? []), mention.id as number]);
			await saveState(state);
		}
		await respondToMention(mention, prUrl, {
			allowFix: iteration.allowFix,
			dryRun: iteration.dryRun,
			json: iteration.json,
			prompt: iteration.prompt,
			repoRoot: iteration.repoRoot,
			runner,
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

const watch = async (
	prUrl: string,
	options: {
		interval?: number;
		allowFix?: boolean;
		allowedUser?: string;
		dryRun?: boolean;
		json?: boolean;
		prompt?: string;
		runner?: Runner;
		iterations?: number;
	} = {},
): Promise<void> => {
	const runner = options.runner ?? exec;
	const interval = options.interval ?? DEFAULT_INTERVAL_SECONDS;
	const iterations = options.iterations ?? (options.dryRun ? 1 : Infinity); // Infinity polls until the process is interrupted; dry-run previews once
	if (options.dryRun) {
		process.stderr.write("Dry-run mode: no GitHub comments or git add/commit/push will be made.\n");
	}
	const normalizedPrUrl = toPrUrl(parsePrUrl(prUrl));
	const repoRoot = await preflight(normalizedPrUrl, runner);
	for (let index = 0; index < iterations; index += 1) {
		await pollIteration(normalizedPrUrl, runner, {
			allowFix: options.allowFix ?? false,
			allowedUser: options.allowedUser,
			dryRun: options.dryRun,
			index,
			interval,
			iterations,
			json: options.json,
			prompt: options.prompt,
			repoRoot,
		});
	}
};

const findFlag = (argv: string[], flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	if (index === -1 || index + 1 >= argv.length) {
		return;
	}
	const value = argv.at(index + 1) as string;
	if (value.startsWith("-")) {
		return;
	}
	return value;
};

const parseInterval = (flagArgs: string[]): number => {
	const value = findFlag(flagArgs, "--interval");
	const parsed = value === undefined ? DEFAULT_INTERVAL_SECONDS : Math.trunc(Number(value));
	return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_INTERVAL_SECONDS : parsed;
};

const runWatch = async (
	rest: string[],
	options: { iterations?: number; runner?: Runner },
): Promise<void> => {
	const [prUrl, ...flagArgs] = rest;
	if (!prUrl || typeof prUrl !== "string") {
		throw new TypeError("PR reference is required");
	}
	const interval = parseInterval(flagArgs);
	const allowFix = flagArgs.includes("--fix");
	const dryRun = flagArgs.includes("--dry-run");
	const json = flagArgs.includes("--json");
	const allowedUser = findFlag(flagArgs, "--user");
	const prompt = findFlag(flagArgs, "--prompt");
	await watch(prUrl, {
		allowFix,
		allowedUser,
		dryRun,
		interval,
		iterations: options.iterations,
		json,
		prompt,
		runner: options.runner,
	});
};

const run = Object.assign(
	async (
		argv: string[] = process.argv.slice(CLI_ARGV_OFFSET),
		options: { iterations?: number; runner?: Runner } = {},
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
			// eslint-disable-next-line no-console
			console.log("Hello from pickup!", argv);
		} catch (error) {
			process.stderr.write(`Error: ${(error as Error).message}\n`);
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
