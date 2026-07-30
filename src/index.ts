import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";

const CLI_ARGV_OFFSET = 2;

const execFilePromise = promisify(execFile);

type Runner = (file: string, args: string[]) => Promise<string>;

const statePath = (): string =>
	path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "pickup", "state.json");

const exec = async (file: string, args: string[]): Promise<string> => {
	const { stdout } = await execFilePromise(file, args, { encoding: "utf8" });
	return stdout.trim();
};

const parsePrUrl = (
	prUrl: string,
): { host: string; owner: string; repo: string; number: string } => {
	const url = new URL(prUrl);
	const parts = url.pathname.split("/").filter(Boolean);
	const owner = parts.at(0);
	const repo = parts.at(1);
	const pull = parts.at(2);
	const number = parts.at(3);
	if (
		parts.length !== 4 ||
		pull !== "pull" ||
		typeof owner !== "string" ||
		typeof repo !== "string" ||
		typeof number !== "string"
	) {
		throw new TypeError(`Invalid PR URL: ${prUrl}`);
	}
	return { host: url.hostname, number, owner, repo };
};

const fetchReviewComments = async (
	prUrl: string,
	runner: Runner = exec,
): Promise<Record<string, unknown>[]> => {
	const { owner, repo, number } = parsePrUrl(prUrl);
	const out = await runner("gh", ["api", `repos/${owner}/${repo}/pulls/${number}/comments`]);
	return JSON.parse(out) as Record<string, unknown>[];
};

const findNewMention = (
	comments: Record<string, unknown>[],
	seenIds: number[],
): Record<string, unknown> | undefined => {
	const seen = new Set(seenIds);
	return comments
		.filter(
			(comment) =>
				typeof comment.body === "string" &&
				comment.body.includes("@pickup") &&
				typeof comment.id === "number" &&
				!seen.has(comment.id),
		)
		.toSorted((first, second) => (second.id as number) - (first.id as number))[0];
};

const loadState = async (filePath = statePath()): Promise<Map<string, number[]>> => {
	const state = new Map<string, number[]>();
	let raw = "";
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state path is internal (XDG_CONFIG_HOME/homedir), not user input
		raw = await readFile(filePath, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			return state;
		}
		process.stderr.write(
			`Warning: could not read state file, resetting: ${(error as Error).message}\n`,
		);
		return state;
	}
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	for (const [key, value] of Object.entries(parsed)) {
		if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
			state.set(key, value as number[]);
		}
	}
	return state;
};

const saveState = async (state: Map<string, number[]>, filePath = statePath()): Promise<void> => {
	const dir = path.join(filePath, "..");
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state dir is internal (XDG_CONFIG_HOME/homedir), not user input
	await mkdir(dir, { recursive: true });
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- state path is internal (XDG_CONFIG_HOME/homedir), not user input
	await writeFile(
		filePath,
		JSON.stringify(Object.fromEntries(state), (_key, value) => value, "\t"),
	);
};

const postReply = async (
	ctx: { commentId: number; number: string; owner: string; repo: string; runner: Runner },
	body: string,
): Promise<void> => {
	await ctx.runner("gh", [
		"api",
		"--method",
		"POST",
		`repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/comments/${ctx.commentId}/replies`,
		"-f",
		`body=${body}`,
	]);
};

const stripFences = (content: string): string => {
	const trimmed = content.trim();
	const FENCE = "```";
	if (!trimmed.startsWith(FENCE) || !trimmed.endsWith(FENCE)) {
		return trimmed;
	}
	const firstNewline = trimmed.indexOf("\n");
	const lastNewline = trimmed.lastIndexOf("\n");
	if (firstNewline === -1 || lastNewline === -1 || firstNewline >= lastNewline) {
		return trimmed;
	}
	return trimmed.slice(firstNewline + 1, lastNewline).trim();
};

const handleExplain = async (
	mention: Record<string, unknown>,
	ctx: { commentId: number; number: string; owner: string; repo: string; runner: Runner },
): Promise<void> => {
	const targetPath = mention.path as string;
	const line = mention.line as number;
	const prompt = `Explain what line ${line} in ${targetPath} does in this PR. The review comment is: ${ctx.commentId}`;
	const answer = await ctx.runner("claude", ["-p", prompt]);
	if (!answer) {
		process.stderr.write("Warning: claude returned empty explanation\n");
		return;
	}
	await postReply(ctx, answer);
};

const handleFix = async (
	mention: Record<string, unknown>,
	ctx: { commentId: number; number: string; owner: string; repo: string; runner: Runner },
): Promise<void> => {
	const targetPath = mention.path as string;
	const line = mention.line as number;
	await ctx.runner("gh", ["pr", "checkout", ctx.number]);

	let content = "";
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- target file is from the PR working tree, not raw user input
		content = await readFile(targetPath, "utf8");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			await postReply(ctx, "Could not find the file to fix.");
			return;
		}
		throw error;
	}

	const prompt = `Fix the issue described in this review comment: ${ctx.commentId}\n\nCurrent content of ${targetPath} (line ${line}):\n\n${content}\n\nReturn only the corrected file content. Do not wrap it in markdown.`;
	const fixed = await ctx.runner("claude", ["-p", prompt]);
	const stripped = stripFences(fixed);
	if (!stripped) {
		await postReply(ctx, "Could not generate a fix.");
		return;
	}

	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- writing back to the checked-out PR working tree
		await writeFile(targetPath, stripped);
		await ctx.runner("git", ["add", targetPath]);
		await ctx.runner("git", ["commit", "-m", "fix: address @pickup comment"]);
		await ctx.runner("git", ["push"]);
		const shortHash = await ctx.runner("git", ["rev-parse", "--short", "HEAD"]);
		await postReply(ctx, `Fixed in ${shortHash}.`);
	} catch (error) {
		const { message } = error as Error;
		await postReply(ctx, `Fix failed: ${message}`);
		throw error;
	}
};

const respondToMention = async (
	mention: Record<string, unknown>,
	prUrl: string,
	options: { allowFix: boolean; allowedUser?: string; runner: Runner },
): Promise<void> => {
	const { runner } = options;
	const { owner, repo, number } = parsePrUrl(prUrl);
	const commentId = mention.id as number;
	const commentBody = mention.body as string;
	const user = mention.user as { login?: string } | undefined;
	const commentUser =
		typeof user === "object" && user !== null && typeof user.login === "string" ? user.login : "";

	if (typeof options.allowedUser === "string" && commentUser !== options.allowedUser) {
		return;
	}

	const ctx = { commentId, number, owner, repo, runner };
	await (options.allowFix && commentBody.toLowerCase().includes("fix")
		? handleFix(mention, ctx)
		: handleExplain(mention, ctx));
};

const preflight = async (prUrl: string, runner: Runner = exec): Promise<void> => {
	const { host } = parsePrUrl(prUrl);
	await runner("gh", ["--version"]);
	await runner("claude", ["--version"]);
	await runner("gh", ["auth", "status", "--hostname", host]);
};

const watch = async (
	prUrl: string,
	options: {
		interval?: number;
		allowFix?: boolean;
		allowedUser?: string;
		runner?: Runner;
		iterations?: number;
	} = {},
): Promise<void> => {
	const runner = options.runner ?? exec;
	const interval = options.interval ?? 60;
	const iterations = options.iterations ?? Infinity;
	await preflight(prUrl, runner);
	for (let index = 0; index < iterations; index += 1) {
		const state = await loadState();
		const comments = await fetchReviewComments(prUrl, runner);
		const mention = findNewMention(comments, state.get(prUrl) ?? []);
		if (mention) {
			await respondToMention(mention, prUrl, {
				allowFix: options.allowFix ?? false,
				allowedUser: options.allowedUser,
				runner,
			});
			state.set(prUrl, [...(state.get(prUrl) ?? []), mention.id as number]);
			await saveState(state);
		}
		if (index < iterations - 1) {
			await setTimeout(interval * 1000);
		}
	}
};

const findFlag = (argv: string[], flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	if (index === -1 || index + 1 >= argv.length) {
		return;
	}
	return argv.at(index + 1);
};

const run = Object.assign(
	async (
		argv: string[] = process.argv.slice(CLI_ARGV_OFFSET),
		options: { iterations?: number; runner?: Runner } = {},
	): Promise<void> => {
		try {
			const [subcommand, ...rest] = argv;
			if (subcommand === "watch") {
				const [prUrl, ...flagArgs] = rest;
				if (typeof prUrl !== "string") {
					throw new TypeError("PR URL is required");
				}
				const interval = Math.trunc(Number(findFlag(flagArgs, "--interval") ?? "60"));
				const allowFix = flagArgs.includes("--fix");
				const allowedUser = findFlag(flagArgs, "--user");
				await watch(prUrl, {
					allowFix,
					allowedUser,
					interval,
					iterations: options.iterations,
					runner: options.runner,
				});
				return;
			}
			// eslint-disable-next-line no-console
			console.log("Hello from pickup!", argv);
		} catch (error) {
			process.stderr.write(`Error: ${(error as Error).message}\n`);
			process.exitCode = 1;
		}
	},
	{ exec, findFlag, findNewMention, loadState, parsePrUrl, saveState, stripFences, watch },
);

export default run;
