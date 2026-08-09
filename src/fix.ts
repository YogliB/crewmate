import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Logger } from "./log.js";

const FENCE_MARKER = "```";
const FIX_MESSAGE = "fix: address pickup comment";
const MISSING_FILE_REPLY = "Could not find the file.";
const PICKUP_PREFIX = "🛻 pickup:";
const NO_CHANGE_REPLY = "No changes needed.";
const NO_FIX_REPLY = "Could not generate a fix.";

const NO_FIX_IN_CONVERSATION =
	"I can't apply fixes to conversation comments; only review comments on diff lines support #fix.";

type MentionBase = {
	id: number;
	body: string;
	user?: unknown;
	inReplyToId?: number;
};

export type Mention =
	| (MentionBase & { kind: "conversation" })
	| (MentionBase & { kind: "review"; path: string; line: number });

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isOutsideRepo = (repoRoot: string, resolved: string): boolean => {
	const relative = path.relative(repoRoot, resolved);
	return relative.startsWith("..") || path.isAbsolute(relative) || resolved === repoRoot;
};

const isUnsafeContentPath = (targetPath: string): boolean =>
	path.isAbsolute(targetPath) ||
	targetPath.includes("\\") ||
	/(?:^|\/)\.\.?(?:\/|$)/.test(targetPath);

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

export type Runner = (
	file: string,
	args: string[],
	options?: { env?: Record<string, string | undefined> },
) => Promise<string>;

type ReplyContext = {
	commentId: number;
	dryRun: boolean;
	ghHost: string;
	kind: Mention["kind"];
	logger: Logger;
	model?: string;
	number: string;
	owner: string;
	prompt?: string;
	provider?: string;
	repo: string;
	repoRoot?: string;
	runner: Runner;
	warn: (message: string, fields?: Record<string, unknown>) => Promise<void>;
};

const logContext = (
	ctx: ReplyContext,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	...extra,
	commentId: ctx.commentId,
	dryRun: ctx.dryRun,
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
	const dryRunLabel =
		ctx.kind === "conversation"
			? `post a comment on pull request ${ctx.number}`
			: `reply to comment ${ctx.commentId}`;
	if (ctx.dryRun) {
		process.stdout.write(`[dry-run] would ${dryRunLabel}:\n${prefixedBody}\n`);
		await ctx.logger("reply", { ...base, failed: false });
		return;
	}
	const endpoint =
		ctx.kind === "conversation"
			? `repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`
			: `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/comments/${ctx.commentId}/replies`;
	try {
		await ctx.runner("gh", ["api", "--method", "POST", endpoint, "-f", `body=${prefixedBody}`], {
			env: { GH_HOST: ctx.ghHost },
		});
		await ctx.logger("reply", { ...base, failed: false });
	} catch (error) {
		await ctx.logger("reply", { ...base, failed: true, error: errorMessage(error) });
		throw error;
	}
};

const callProvider = async (ctx: ReplyContext, finalPrompt: string): Promise<string> => {
	const answer = await ctx.runner(
		ctx.provider || "claude",
		ctx.model ? ["--model", ctx.model, "-p", finalPrompt] : ["-p", finalPrompt],
	);
	return answer.trim();
};

type ReviewMention = Extract<Mention, { kind: "review" }>;

const handleExplain = async (mention: ReviewMention, ctx: ReplyContext): Promise<void> => {
	const { content, found } = await readPrFile(ctx, mention.path);
	if (!found) {
		return;
	}
	const body = mention.body;
	const prompt = `Review comment: ${JSON.stringify(body)}\nTarget file: ${JSON.stringify(mention.path)}\nLine: ${mention.line}\nFile content: ${JSON.stringify(content)}\n\nExplain what the line does in this PR. Return only the explanation.`;
	const finalPrompt = ctx.prompt ? `${ctx.prompt}\n\n${prompt}` : prompt;
	const answer = await callProvider(ctx, finalPrompt);
	if (!answer) {
		const message = `${ctx.provider || "claude"} returned empty explanation`;
		await ctx.warn(message, logContext(ctx, { kind: "explain", reason: "empty" }));
		return;
	}
	await postReply(ctx, answer, "explain");
};

const encodeContentPath = (targetPath: string): string =>
	targetPath
		.split("/")
		.filter((segment) => segment !== "")
		.map(encodeURIComponent)
		.join("/");

const readPrFile = async (
	ctx: ReplyContext,
	targetPath: string,
): Promise<{ content: string; found: boolean }> => {
	if (ctx.repoRoot === undefined) {
		if (isUnsafeContentPath(targetPath)) {
			await ctx.warn("invalid target path", {
				path: targetPath,
				reason: "invalid-file-path",
			});
			await postReply(ctx, MISSING_FILE_REPLY, "error");
			return { content: "", found: false };
		}
		const encodedPath = encodeContentPath(targetPath);
		try {
			const content = await ctx.runner(
				"gh",
				[
					"api",
					"-H",
					"Accept: application/vnd.github.raw",
					`repos/${ctx.owner}/${ctx.repo}/contents/${encodedPath}?ref=refs/pull/${ctx.number}/head`,
				],
				{ env: { GH_HOST: ctx.ghHost } },
			);
			return { content, found: true };
		} catch (error) {
			await ctx.warn("file content API failed", {
				error: errorMessage(error),
				path: targetPath,
				reason: "file-content-api-failed",
			});
			await postReply(ctx, MISSING_FILE_REPLY, "error");
			return { content: "", found: false };
		}
	}

	await ctx.runner("gh", ["pr", "checkout", "-R", `${ctx.owner}/${ctx.repo}`, ctx.number], {
		env: { GH_HOST: ctx.ghHost },
	});
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
	{ content, mention }: { content: string; mention: ReviewMention },
): Promise<string> => {
	const body = mention.body;
	const prompt = `Fix the issue described in this review comment.\nReview comment: ${JSON.stringify(body)}\nTarget file: ${JSON.stringify(mention.path)}\nLine: ${mention.line}\nFile content: ${JSON.stringify(content)}\n\nReturn only the corrected file content. Do not wrap it in markdown.`;
	const finalPrompt = ctx.prompt ? `${ctx.prompt}\n\n${prompt}` : prompt;
	const fixed = await callProvider(ctx, finalPrompt);
	const stripped = stripFences(fixed);
	if (!stripped) {
		await postReply(ctx, NO_FIX_REPLY, "error");
		return "";
	}
	return stripped;
};

export const applyFix = async (
	ctx: ReplyContext,
	targetPath: string,
	stripped: string,
): Promise<void> => {
	if (ctx.repoRoot === undefined) {
		throw new Error("repoRoot is required to apply fixes");
	}
	const safePath = await toSafePath(targetPath, ctx.repoRoot);
	const relativePath = path.relative(ctx.repoRoot, safePath);
	const base = logContext(ctx, { path: relativePath });
	if (ctx.dryRun) {
		process.stdout.write(`[dry-run] would write fix to ${safePath}:\n${stripped}\n`);
		await ctx.logger("fix", { ...base, sha: null });
		await ctx.logger("reply", { ...logContext(ctx), kind: "fix", failed: false });
		return;
	}
	try {
		// oxlint-disable-next-line security/detect-non-literal-fs-filename -- path validated against the repository root
		await writeFile(safePath, stripped);
		await ctx.runner("git", ["add", safePath]);
		await ctx.runner("git", ["commit", "-m", FIX_MESSAGE]);
	} catch (error) {
		const message = errorMessage(error);
		await ctx.logger("fix", { ...base, sha: null, error: message });
		await postReply(ctx, `Fix failed: ${message}`, "error");
		throw error;
	}
	let shortHash = "";
	try {
		shortHash = (await ctx.runner("git", ["rev-parse", "--short", "HEAD"])).trim();
	} catch {
		shortHash = "";
	}
	try {
		await ctx.runner("git", ["push"]);
	} catch (error) {
		const message = errorMessage(error);
		await ctx.logger("fix", { ...base, sha: shortHash || null, error: message });
		await postReply(ctx, `Fix failed: ${message}`, "error");
		return;
	}
	await ctx.logger("fix", { ...base, sha: shortHash || null });
	await postReply(ctx, shortHash ? `Fixed in ${shortHash}.` : "Fixed.", "fix");
};

const handleFix = async (mention: ReviewMention, ctx: ReplyContext): Promise<void> => {
	const { content, found } = await readPrFile(ctx, mention.path);
	if (!found) {
		return;
	}
	const fixed = await generateFix(ctx, { content, mention });
	if (!fixed) {
		return;
	}
	if (fixed === content) {
		await postReply(ctx, NO_CHANGE_REPLY, "nochange");
		return;
	}
	await applyFix(ctx, mention.path, fixed);
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

const handleConversation = async (mention: Mention, ctx: ReplyContext): Promise<void> => {
	const prompt = `Conversation comment: ${JSON.stringify(mention.body)}\n\nRespond to the comment. Return only the response.`;
	const finalPrompt = ctx.prompt ? `${ctx.prompt}\n\n${prompt}` : prompt;
	const answer = await callProvider(ctx, finalPrompt);
	if (!answer) {
		const message = `${ctx.provider || "claude"} returned empty conversation response`;
		await ctx.warn(message, logContext(ctx, { kind: "explain", reason: "empty" }));
		return;
	}
	await postReply(ctx, answer, "explain");
};

const dispatchMention = async (
	mention: Mention,
	ctx: ReplyContext,
	{ allowFix }: { allowFix: boolean },
): Promise<void> => {
	const wantsFix = allowFix && /#fix\b/i.test(mention.body);
	if (mention.kind === "conversation") {
		if (wantsFix) {
			await ctx.warn(
				"fix requested on conversation comment; only review comments can be fixed",
				logContext(ctx),
			);
			await postReply(ctx, NO_FIX_IN_CONVERSATION, "error");
			return;
		}
		await handleConversation(mention, ctx);
		return;
	}
	if (wantsFix) {
		await handleFix(mention, ctx);
	} else {
		await handleExplain(mention, ctx);
	}
};

export { PICKUP_PREFIX, stripFences, getLogin, dispatchMention, errorMessage };
