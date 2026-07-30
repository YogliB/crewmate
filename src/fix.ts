import { readFile, writeFile } from "node:fs/promises";

const NOT_FOUND_INDEX = -1;
const STEP = 1;
const FENCE_MARKER = "```";
const FIX_MESSAGE = "fix: address @pickup comment";
const MISSING_FILE_REPLY = "Could not find the file to fix.";
const NO_FIX_REPLY = "Could not generate a fix.";
const EMPTY_EXPLANATION_WARNING = "Warning: claude returned empty explanation\n";

type Runner = (file: string, args: string[]) => Promise<string>;

type ReplyContext = {
	commentId: number;
	number: string;
	owner: string;
	repo: string;
	runner: Runner;
};

const stripFences = (content: string): string => {
	const trimmed = content.trim();
	if (!trimmed.startsWith(FENCE_MARKER) || !trimmed.endsWith(FENCE_MARKER)) {
		return trimmed;
	}
	const firstNewline = trimmed.indexOf("\n");
	const lastNewline = trimmed.lastIndexOf("\n");
	if (
		firstNewline === NOT_FOUND_INDEX ||
		lastNewline === NOT_FOUND_INDEX ||
		firstNewline >= lastNewline
	) {
		return trimmed;
	}
	return trimmed.slice(firstNewline + STEP, lastNewline).trim();
};

const postReply = async (ctx: ReplyContext, body: string): Promise<void> => {
	await ctx.runner("gh", [
		"api",
		"--method",
		"POST",
		`repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/comments/${ctx.commentId}/replies`,
		"-f",
		`body=${body}`,
	]);
};

const handleExplain = async (
	mention: Record<string, unknown>,
	ctx: ReplyContext,
): Promise<void> => {
	const targetPath = mention.path as string;
	const line = mention.line as number;
	const prompt = `Explain what line ${line} in ${targetPath} does in this PR. The review comment is: ${ctx.commentId}`;
	const answer = await ctx.runner("claude", ["-p", prompt]);
	if (!answer) {
		process.stderr.write(EMPTY_EXPLANATION_WARNING);
		return;
	}
	await postReply(ctx, answer);
};

const readPrFile = async (
	ctx: ReplyContext,
	targetPath: string,
): Promise<{ content: string; found: boolean }> => {
	await ctx.runner("gh", ["pr", "checkout", ctx.number]);
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- target file is from the PR working tree, not raw user input
		const content = await readFile(targetPath, "utf8");
		return { content, found: true };
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			await postReply(ctx, MISSING_FILE_REPLY);
			return { content: "", found: false };
		}
		throw error;
	}
};

const generateFix = async (
	ctx: ReplyContext,
	{
		mention,
		targetPath,
		content,
	}: { content: string; mention: Record<string, unknown>; targetPath: string },
): Promise<string> => {
	const line = mention.line as number;
	const prompt = `Fix the issue described in this review comment: ${ctx.commentId}\n\nCurrent content of ${targetPath} (line ${line}):\n\n${content}\n\nReturn only the corrected file content. Do not wrap it in markdown.`;
	const fixed = await ctx.runner("claude", ["-p", prompt]);
	const stripped = stripFences(fixed);
	if (!stripped) {
		await postReply(ctx, NO_FIX_REPLY);
		return "";
	}
	return stripped;
};

const applyFix = async (ctx: ReplyContext, targetPath: string, stripped: string): Promise<void> => {
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- writing back to the checked-out PR working tree
		await writeFile(targetPath, stripped);
		await ctx.runner("git", ["add", targetPath]);
		await ctx.runner("git", ["commit", "-m", FIX_MESSAGE]);
		await ctx.runner("git", ["push"]);
		const shortHash = await ctx.runner("git", ["rev-parse", "--short", "HEAD"]);
		await postReply(ctx, `Fixed in ${shortHash}.`);
	} catch (error) {
		const { message } = error as Error;
		await postReply(ctx, `Fix failed: ${message}`);
		throw error;
	}
};

const handleFix = async (mention: Record<string, unknown>, ctx: ReplyContext): Promise<void> => {
	const targetPath = mention.path as string;
	const { content, found } = await readPrFile(ctx, targetPath);
	if (!found) {
		return;
	}
	const fixed = await generateFix(ctx, { content, mention, targetPath });
	if (!fixed) {
		return;
	}
	await applyFix(ctx, targetPath, fixed);
};

const getLogin = (user: unknown): string => {
	if (typeof user !== "object" || !user) {
		return "";
	}
	const record = user as Record<string, unknown>;
	if (typeof record.login === "string") {
		return record.login;
	}
	return "";
};

const dispatchMention = async (
	mention: Record<string, unknown>,
	ctx: ReplyContext,
	{ allowFix, commentBody }: { allowFix: boolean; commentBody: string },
): Promise<void> => {
	if (allowFix && commentBody.toLowerCase().includes("fix")) {
		await handleFix(mention, ctx);
	} else {
		await handleExplain(mention, ctx);
	}
};

export { type Runner, stripFences, getLogin, dispatchMention };
