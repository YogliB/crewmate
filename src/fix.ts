import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Logger } from "./log.js";

const FENCE_MARKER = "```";
const FIX_MESSAGE = "fix: address pickup comment";
const MISSING_FILE_REPLY = "Could not find the file.";
const PICKUP_PREFIX = "🛻 pickup:";
const NO_CHANGE_REPLY = "No changes needed.";
const NO_FIX_REPLY = "Could not generate a fix.";

const isOutsideRepo = (repoRoot: string, resolved: string): boolean => {
	const relative = path.relative(repoRoot, resolved);
	return relative.startsWith("..") || path.isAbsolute(relative) || resolved === repoRoot;
};

const toSafePath = async (targetPath: string, repoRoot: string): Promise<string> => {
	const resolved = path.resolve(repoRoot, targetPath);
	if (isOutsideRepo(repoRoot, resolved)) {
		throw new Error("Invalid target path");
	}
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- resolved is validated against the repository root before realpath
		const realResolved = await realpath(resolved);
		if (isOutsideRepo(repoRoot, realResolved)) {
			throw new Error("Invalid target path");
		}
		return realResolved;
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code !== "ENOENT") {
			throw new Error("Invalid target path", { cause: error });
		}
	}
	const parent = path.dirname(resolved);
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- parent is derived from a path validated against the repository root
	const realParent = await realpath(parent);
	const realResolved = path.join(realParent, path.basename(resolved));
	if (isOutsideRepo(repoRoot, realResolved)) {
		throw new Error("Invalid target path");
	}
	return realResolved;
};

type Runner = (file: string, args: string[]) => Promise<string>;

type ReplyContext = {
	commentId: number;
	dryRun?: boolean;
	json?: boolean;
	logger: Logger;
	model?: string;
	number: string;
	owner: string;
	prompt?: string;
	provider?: string;
	repo: string;
	repoRoot: string;
	runner: Runner;
	warn?: (message: string, fields?: Record<string, unknown>) => Promise<void>;
};

const logContext = (
	ctx: ReplyContext,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	...extra,
	commentId: ctx.commentId,
	dryRun: ctx.dryRun ?? false,
	number: ctx.number,
	owner: ctx.owner,
	repo: ctx.repo,
});

const stripFences = (content: string): string => {
	const trimmed = content.trim();
	if (!trimmed.startsWith(FENCE_MARKER) || !trimmed.endsWith(FENCE_MARKER)) {
		return trimmed;
	}
	const firstNewline = trimmed.indexOf("\n");
	const lastNewline = trimmed.lastIndexOf("\n");
	if (firstNewline === -1 || lastNewline === -1 || firstNewline >= lastNewline) {
		return trimmed;
	}
	return trimmed.slice(firstNewline + 1, lastNewline).trim();
};

const postReply = async (
	ctx: ReplyContext,
	body: string,
	kind: "explain" | "error" | "fix" | "nochange",
): Promise<void> => {
	const prefixedBody = `${PICKUP_PREFIX} ${body}`;
	const base = logContext(ctx, { kind });
	if (ctx.dryRun) {
		if (ctx.json) {
			process.stdout.write(
				JSON.stringify({ action: "reply", commentId: ctx.commentId, body: prefixedBody }) + "\n",
			);
		} else {
			process.stdout.write(`[dry-run] would reply to comment ${ctx.commentId}:\n${prefixedBody}\n`);
		}
		await ctx.logger("reply", { ...base, failed: false });
		return;
	}
	try {
		await ctx.runner("gh", [
			"api",
			"--method",
			"POST",
			`repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/comments/${ctx.commentId}/replies`,
			"-f",
			`body=${prefixedBody}`,
		]);
		await ctx.logger("reply", { ...base, failed: false });
	} catch (error) {
		await ctx.logger("reply", { ...base, failed: true, error: String(error) });
		throw error;
	}
};

const callProvider = (ctx: ReplyContext, finalPrompt: string): Promise<string> =>
	ctx.runner(
		ctx.provider || "claude",
		ctx.model ? ["--model", ctx.model, "-p", finalPrompt] : ["-p", finalPrompt],
	);

const handleExplain = async (
	mention: Record<string, unknown>,
	ctx: ReplyContext,
): Promise<void> => {
	const targetPath = mention.path as string;
	const line = mention.line as number;
	const { content, found } = await readPrFile(ctx, targetPath);
	if (!found) {
		return;
	}
	const body = mention.body as string;
	const prompt = `Review comment: ${JSON.stringify(body)}\nTarget file: ${JSON.stringify(targetPath)}\nLine: ${line}\nFile content: ${JSON.stringify(content)}\n\nExplain what the line does in this PR. Return only the explanation.`;
	const finalPrompt = ctx.prompt ? `${ctx.prompt}\n\n${prompt}` : prompt;
	const answer = await callProvider(ctx, finalPrompt);
	if (!answer) {
		const message = `${ctx.provider || "claude"} returned empty explanation`;
		await ctx.warn(message, logContext(ctx, { kind: "explain", reason: "empty" }));
		return;
	}
	await postReply(ctx, answer, "explain");
};

const readPrFile = async (
	ctx: ReplyContext,
	targetPath: string,
): Promise<{ content: string; found: boolean }> => {
	await ctx.runner("gh", ["pr", "checkout", "-R", `${ctx.owner}/${ctx.repo}`, ctx.number]);
	let safePath: string;
	try {
		safePath = await toSafePath(targetPath, ctx.repoRoot);
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			await postReply(ctx, MISSING_FILE_REPLY, "error");
			return { content: "", found: false };
		}
		throw error;
	}
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- path validated against the repository root
		const content = await readFile(safePath, "utf8");
		return { content, found: true };
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT") {
			await postReply(ctx, MISSING_FILE_REPLY, "error");
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
	const body = mention.body as string;
	const prompt = `Fix the issue described in this review comment.\nReview comment: ${JSON.stringify(body)}\nTarget file: ${JSON.stringify(targetPath)}\nLine: ${line}\nFile content: ${JSON.stringify(content)}\n\nReturn only the corrected file content. Do not wrap it in markdown.`;
	const finalPrompt = ctx.prompt ? `${ctx.prompt}\n\n${prompt}` : prompt;
	const fixed = await callProvider(ctx, finalPrompt);
	const stripped = stripFences(fixed);
	if (!stripped) {
		await postReply(ctx, NO_FIX_REPLY, "error");
		return "";
	}
	return stripped;
};

const applyFix = async (ctx: ReplyContext, targetPath: string, stripped: string): Promise<void> => {
	const safePath = await toSafePath(targetPath, ctx.repoRoot);
	const relativePath = path.relative(ctx.repoRoot, safePath);
	const base = logContext(ctx, { path: relativePath });
	if (ctx.dryRun) {
		if (ctx.json) {
			process.stdout.write(
				JSON.stringify({ action: "fix", content: stripped, path: safePath }) + "\n",
			);
		} else {
			process.stdout.write(`[dry-run] would write fix to ${safePath}:\n${stripped}\n`);
		}
		await ctx.logger("fix", { ...base, sha: null });
		await ctx.logger("reply", { ...logContext(ctx), kind: "fix", failed: false });
		return;
	}
	let shortHash = "";
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- path validated against the repository root
		await writeFile(safePath, stripped);
		await ctx.runner("git", ["add", safePath]);
		await ctx.runner("git", ["commit", "-m", FIX_MESSAGE]);
		shortHash = await ctx.runner("git", ["rev-parse", "--short", "HEAD"]);
	} catch (error) {
		const message = String(error).replace(/^Error: /u, "");
		await ctx.logger("fix", { ...base, sha: null, error: message });
		await postReply(ctx, `Fix failed: ${message}`, "error");
		throw error;
	}
	try {
		await ctx.runner("git", ["push"]);
	} catch (error) {
		const message = String(error).replace(/^Error: /u, "");
		await ctx.logger("fix", { ...base, sha: shortHash, error: message });
		await postReply(ctx, `Fix failed: ${message}`, "error");
		return;
	}
	await ctx.logger("fix", { ...base, sha: shortHash });
	await postReply(ctx, `Fixed in ${shortHash}.`, "fix");
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
	if (fixed === content) {
		await postReply(ctx, NO_CHANGE_REPLY, "nochange");
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
	if (allowFix && /#fix/i.test(commentBody)) {
		await handleFix(mention, ctx);
	} else {
		await handleExplain(mention, ctx);
	}
};

export { PICKUP_PREFIX, type Runner, stripFences, getLogin, dispatchMention };
