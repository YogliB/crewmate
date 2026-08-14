import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Logger } from "./log.js";

const FENCE_MARKER = "```";
const FIX_MESSAGE = "fix: address crewmate comment";
const MISSING_FILE_REPLY = "Could not find the file.";
const CREWMATE_PREFIX = "⚓ crewmate:";
const NO_CHANGE_REPLY = "No changes needed.";
const NO_FIX_REPLY = "Could not generate a fix.";

const NO_FILES_CHANGED_REPLY = "No files changed in this PR.";
const NO_FILES_READABLE_REPLY = "Could not read any changed files in this PR.";

const MAX_CONVERSATION_FILES = 50;
const MAX_CONVERSATION_FILE_SIZE = 100_000;

const NO_FIX_IN_ISSUE =
	"I can't apply fixes to issue bodies or comments; only PR review and conversation comments support #fix.";

type MentionBase = {
	id: number;
	body: string;
	user?: unknown;
	inReplyToId?: number;
};

export type Mention =
	| (MentionBase & { kind: "conversation" })
	| (MentionBase & { kind: "issue" })
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
	checkedOut: Set<string>;
	commentId: number;
	dryRun: boolean;
	ghHost: string;
	kind: Mention["kind"];
	logger: Logger;
	model?: string;
	number: string;
	owner: string;
	prUrl: string;
	prompt?: string;
	provider?: string;
	reaction?: { id?: number; emoji: string };
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

const reactionTarget = (ctx: ReplyContext): string =>
	ctx.kind === "issue" ? `issue ${ctx.number}` : `comment ${ctx.commentId}`;

const reactionEndpoint = (ctx: ReplyContext, previousId?: number): string => {
	if (ctx.kind === "issue") {
		return `repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/reactions${previousId === undefined ? "" : `/${previousId}`}`;
	}
	const kind = ctx.kind === "conversation" ? "issues" : "pulls";
	return `repos/${ctx.owner}/${ctx.repo}/${kind}/comments/${ctx.commentId}/reactions${previousId === undefined ? "" : `/${previousId}`}`;
};

const setReaction = async (ctx: ReplyContext, emoji: string): Promise<void> => {
	const base = logContext(ctx, { emoji });
	if (ctx.dryRun) {
		const from = ctx.reaction?.emoji ?? "none";
		process.stdout.write(
			`[dry-run] would change reaction on ${reactionTarget(ctx)} from :${from}: to :${emoji}:\n`,
		);
		ctx.reaction = { emoji };
		return;
	}
	const previousId = ctx.reaction?.id;
	if (previousId !== undefined) {
		try {
			await ctx.runner("gh", ["api", "--method", "DELETE", reactionEndpoint(ctx, previousId)], {
				env: { GH_HOST: ctx.ghHost },
			});
		} catch (error) {
			await ctx.warn(`failed to remove reaction: ${errorMessage(error)}`, {
				...base,
				reactionId: previousId,
			});
		}
	}
	ctx.reaction = { emoji };
	try {
		const output = await ctx.runner(
			"gh",
			["api", "--method", "POST", reactionEndpoint(ctx), "-f", `content=${emoji}`],
			{ env: { GH_HOST: ctx.ghHost } },
		);
		if (output.trim() === "") {
			await ctx.warn("failed to set reaction: empty response", base);
			return;
		}
		try {
			const json = JSON.parse(output) as { id?: unknown };
			if (typeof json.id === "number") {
				ctx.reaction = { id: json.id, emoji };
			} else {
				await ctx.warn("failed to set reaction: response did not contain a numeric id", base);
			}
		} catch (error) {
			await ctx.warn(`failed to set reaction: ${errorMessage(error)}`, base);
		}
	} catch (error) {
		await ctx.warn(`failed to set reaction: ${errorMessage(error)}`, base);
	}
};

const removeReaction = async (ctx: ReplyContext): Promise<void> => {
	const base = logContext(ctx);
	if (ctx.dryRun) {
		process.stdout.write(
			`[dry-run] would remove reaction :${ctx.reaction!.emoji}: from ${reactionTarget(ctx)}\n`,
		);
		ctx.reaction = undefined;
		return;
	}
	if (ctx.reaction?.id === undefined) {
		await ctx.warn("failed to remove reaction: no reaction id", base);
		return;
	}
	try {
		await ctx.runner("gh", ["api", "--method", "DELETE", reactionEndpoint(ctx, ctx.reaction.id)], {
			env: { GH_HOST: ctx.ghHost },
		});
	} catch (error) {
		await ctx.warn(`failed to remove reaction: ${errorMessage(error)}`, {
			...base,
			reactionId: ctx.reaction.id,
		});
	} finally {
		ctx.reaction = undefined;
	}
};

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

const replyTarget = (ctx: ReplyContext): string => {
	if (ctx.kind === "conversation") {
		return `post a comment on pull request ${ctx.number}`;
	}
	if (ctx.kind === "issue") {
		return `post a comment on issue ${ctx.number}`;
	}
	return `reply to comment ${ctx.commentId}`;
};

const replyEndpoint = (ctx: ReplyContext): string => {
	if (ctx.kind === "conversation" || ctx.kind === "issue") {
		return `repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`;
	}
	return `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/comments/${ctx.commentId}/replies`;
};

const postReply = async (
	ctx: ReplyContext,
	body: string,
	kind: "explain" | "error" | "fix" | "nochange",
): Promise<void> => {
	const emoji = kind === "error" ? "-1" : kind === "fix" ? "rocket" : "+1";
	await setReaction(ctx, emoji);
	const prefixedBody = `${CREWMATE_PREFIX} ${body}`;
	const base = logContext(ctx, { kind });
	if (ctx.dryRun) {
		process.stdout.write(`[dry-run] would ${replyTarget(ctx)}:\n${prefixedBody}\n`);
		await ctx.logger("reply", { ...base, failed: false });
		return;
	}
	try {
		await ctx.runner(
			"gh",
			["api", "--method", "POST", replyEndpoint(ctx), "-f", `body=${prefixedBody}`],
			{
				env: { GH_HOST: ctx.ghHost },
			},
		);
		await ctx.logger("reply", { ...base, failed: false });
	} catch (error) {
		await ctx.logger("reply", { ...base, failed: true, error: errorMessage(error) });
		await removeReaction(ctx);
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
	{ silent = false }: { silent?: boolean } = {},
): Promise<{ content: string; found: boolean }> => {
	if (ctx.repoRoot === undefined) {
		if (isUnsafeContentPath(targetPath)) {
			if (!silent) {
				await ctx.warn("invalid target path", {
					path: targetPath,
					reason: "invalid-file-path",
				});
				await postReply(ctx, MISSING_FILE_REPLY, "error");
			}
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
			const message = errorMessage(error);
			if (!message.includes("404") && !message.includes("Not Found")) {
				await ctx.warn("file content API failed", {
					error: message,
					path: targetPath,
					reason: "file-content-api-failed",
				});
				if (!silent) {
					throw error;
				}
			} else if (!silent) {
				await ctx.warn("file content API failed", {
					error: message,
					path: targetPath,
					reason: "file-content-api-failed",
				});
				await postReply(ctx, MISSING_FILE_REPLY, "error");
			}
			return { content: "", found: false };
		}
	}

	if (!ctx.checkedOut.has(ctx.prUrl)) {
		await ctx.runner("gh", ["pr", "checkout", "-R", `${ctx.owner}/${ctx.repo}`, ctx.number], {
			env: { GH_HOST: ctx.ghHost },
		});
		ctx.checkedOut.add(ctx.prUrl);
	}

	let safePath: string;
	try {
		safePath = await toSafePath(targetPath, ctx.repoRoot);
	} catch (error) {
		if (silent) {
			return { content: "", found: false };
		}
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
		if (silent) {
			return { content: "", found: false };
		}
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

const FENCE = /^(\s*)(`{3,})(.*)$/;

const stripFileFixes = (content: string): Map<string, string> => {
	const fixes = new Map<string, string>();
	const lines = content.split("\n");
	const stack: { ticks: number; info: string; start: number }[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		// oxlint-disable-next-line security/detect-object-injection -- i is bounded by lines.length
		const match = FENCE.exec(lines[i]);
		if (!match) {
			continue;
		}
		const ticks = match[2].length;
		const info = match[3].trim();
		if (stack.length === 0) {
			stack.push({ ticks, info, start: i + 1 });
			continue;
		}
		const top = stack[stack.length - 1];
		if (info === "" && ticks >= top.ticks) {
			const opened = stack.pop();
			if (opened !== undefined && stack.length === 0) {
				const blockContent = lines.slice(opened.start, i).join("\n");
				fixes.set(opened.info, blockContent);
			}
			continue;
		}
		if (ticks > top.ticks) {
			stack.push({ ticks, info, start: i + 1 });
		}
	}
	return fixes;
};

type PrFile = { filename: string; status: string };

const fetchPrFiles = async (ctx: ReplyContext): Promise<PrFile[]> => {
	const output = await ctx.runner(
		"gh",
		["api", "--paginate", "--slurp", `repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/files`],
		{ env: { GH_HOST: ctx.ghHost } },
	);
	const pages = JSON.parse(output) as Record<string, unknown>[][];
	return pages
		.flat()
		.filter(
			(file): file is PrFile =>
				typeof file.filename === "string" &&
				typeof file.status === "string" &&
				file.status !== "removed",
		);
};

const isBinaryContent = (content: string): boolean => content.includes("\0");

const readPrFiles = async (
	ctx: ReplyContext,
): Promise<{ files: { filePath: string; content: string }[]; allPaths: string[] }> => {
	let allFiles = await fetchPrFiles(ctx);
	if (allFiles.length > MAX_CONVERSATION_FILES) {
		await ctx.warn("truncating changed file list for conversation prompt", {
			count: allFiles.length,
			max: MAX_CONVERSATION_FILES,
			reason: "too-many-files",
		});
		allFiles = allFiles.slice(0, MAX_CONVERSATION_FILES);
	}
	const allPaths = allFiles.map(({ filename }) => filename);
	const result: { filePath: string; content: string }[] = [];
	for (const { filename } of allFiles) {
		const { content, found } = await readPrFile(ctx, filename, { silent: true });
		if (!found) {
			continue;
		}
		if (isBinaryContent(content) || Buffer.byteLength(content) > MAX_CONVERSATION_FILE_SIZE) {
			await ctx.warn("skipping file for conversation prompt", {
				path: filename,
				reason: isBinaryContent(content) ? "binary" : "too-large",
			});
			continue;
		}
		result.push({ filePath: filename, content });
	}
	return { files: result, allPaths };
};

const generateConversationFix = async (
	ctx: ReplyContext,
	mention: Extract<Mention, { kind: "conversation" }>,
	files: { filePath: string; content: string }[],
	allPaths: string[],
): Promise<string> => {
	const body = mention.body;
	const fileList = allPaths.map((filePath) => `- ${filePath}`).join("\n");
	const fileContents = allPaths
		.map((filePath) => {
			const file = files.find((f) => f.filePath === filePath);
			return file
				? `--- ${filePath} ---\n${file.content}`
				: `--- ${filePath} ---\n<could not read file content>`;
		})
		.join("\n\n");
	const prompt = `Fix the issue described in this PR conversation comment.\nConversation comment: ${JSON.stringify(body)}\nPull request: ${ctx.owner}/${ctx.repo}#${ctx.number}\n\nChanged files:\n${fileList}\n\n${fileContents}\n\nReturn each corrected file as a markdown code block with the file path as the language tag (for example, \`\`\`src/index.ts). Only include files that need to change. If a corrected file should end with a newline, add a blank line before the closing fence. If a file contains triple backticks, use more backticks for the outer fence.`;
	const finalPrompt = [ctx.prompt, prompt].filter(Boolean).join("\n\n");
	return callProvider(ctx, finalPrompt);
};

const looksLikePath = (value: string): boolean =>
	value.includes("/") || value.includes("\\") || value.startsWith("..") || value === "..";

const normalizeConversationFixes = (
	fencedFixes: Map<string, string>,
	files: { filePath: string; content: string }[],
	allPaths: string[],
): { filePath: string; content: string }[] | undefined => {
	const changedPaths = new Set(allPaths);
	const originals = new Map(files.map(({ filePath, content }) => [filePath, content]));
	const fixes: { filePath: string; content: string }[] = [];
	for (const [targetPath, content] of fencedFixes) {
		let filePath = targetPath;
		if (filePath === "" && files.length === 1) {
			filePath = files[0].filePath;
		} else if (files.length === 1 && !changedPaths.has(filePath) && !looksLikePath(filePath)) {
			filePath = files[0].filePath;
		}
		if (filePath === "" || !changedPaths.has(filePath)) {
			return undefined;
		}
		const original = originals.get(filePath);
		if (original === undefined) {
			return undefined;
		}
		const normalizedContent =
			content !== "" && original.endsWith("\n") && !content.endsWith("\n")
				? `${content}\n`
				: content;
		if (normalizedContent === original) {
			continue;
		}
		fixes.push({ filePath, content: normalizedContent });
	}
	return fixes;
};

const isPrUrl = (url: string): boolean => {
	try {
		return new URL(url).pathname.includes("/pull/");
	} catch {
		return false;
	}
};

const handleConversationFix = async (
	mention: Extract<Mention, { kind: "conversation" }>,
	ctx: ReplyContext,
): Promise<void> => {
	if (!isPrUrl(ctx.prUrl)) {
		await ctx.warn(
			"fix requested on a conversation comment that does not belong to a PR; only PR conversation comments support #fix",
			logContext(ctx),
		);
		await postReply(ctx, NO_FIX_IN_ISSUE, "error");
		return;
	}
	const { files, allPaths } = await readPrFiles(ctx);
	if (files.length === 0) {
		await postReply(
			ctx,
			allPaths.length === 0 ? NO_FILES_CHANGED_REPLY : NO_FILES_READABLE_REPLY,
			"error",
		);
		return;
	}
	const fixed = await generateConversationFix(ctx, mention, files, allPaths);
	const fencedFixes = stripFileFixes(fixed);
	if (fencedFixes.size > 0) {
		const fixes = normalizeConversationFixes(fencedFixes, files, allPaths);
		if (fixes === undefined) {
			await postReply(ctx, NO_FIX_REPLY, "error");
			return;
		}
		if (fixes.length === 0) {
			await postReply(ctx, NO_CHANGE_REPLY, "nochange");
			return;
		}
		await applyFixes(ctx, new Map(fixes.map(({ filePath, content }) => [filePath, content])));
		return;
	}
	const stripped = stripFences(fixed);
	if (!stripped || stripped.startsWith(FENCE_MARKER) || stripped.endsWith(FENCE_MARKER)) {
		await postReply(ctx, NO_FIX_REPLY, "error");
		return;
	}
	const fixes = normalizeConversationFixes(new Map([["", stripped]]), files, allPaths);
	if (fixes === undefined || fixes.length === 0) {
		await postReply(
			ctx,
			fixes === undefined ? NO_FIX_REPLY : NO_CHANGE_REPLY,
			fixes === undefined ? "error" : "nochange",
		);
		return;
	}
	await applyFixes(ctx, new Map(fixes.map(({ filePath, content }) => [filePath, content])));
};

const applyFixes = async (ctx: ReplyContext, fixes: Map<string, string>): Promise<void> => {
	if (ctx.repoRoot === undefined) {
		throw new Error("repoRoot is required to apply fixes");
	}
	const entries: { safePath: string; relativePath: string; content: string }[] = [];
	const base = logContext(ctx);
	try {
		for (const [targetPath, content] of fixes) {
			const safePath = await toSafePath(targetPath, ctx.repoRoot);
			const relativePath = path.relative(ctx.repoRoot, safePath);
			entries.push({ safePath, relativePath, content });
		}
	} catch (error) {
		const message = errorMessage(error);
		await ctx.logger("fix", { ...base, sha: null, error: message });
		await postReply(ctx, `Fix failed: ${message}`, "error");
		throw error;
	}
	const paths = entries.map((entry) => entry.relativePath);
	const logPaths = paths.length === 1 ? paths[0] : paths;
	const logBase = logContext(ctx, { path: logPaths });
	if (ctx.dryRun) {
		for (const { safePath, content } of entries) {
			process.stdout.write(`[dry-run] would write fix to ${safePath}:\n${content}\n`);
		}
		await ctx.logger("fix", { ...logBase, sha: null });
		await postReply(ctx, "Fixed.", "fix");
		return;
	}
	try {
		for (const { safePath, content } of entries) {
			// oxlint-disable-next-line security/detect-non-literal-fs-filename -- path validated against the repository root
			await writeFile(safePath, content);
			await ctx.runner("git", ["add", safePath]);
		}
		await ctx.runner("git", ["commit", "-m", FIX_MESSAGE]);
	} catch (error) {
		const message = errorMessage(error);
		await ctx.logger("fix", { ...logBase, sha: null, error: message });
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
		await ctx.logger("fix", { ...logBase, sha: shortHash || null, error: message });
		await postReply(ctx, `Fix failed: ${message}`, "error");
		return;
	}
	await ctx.logger("fix", { ...logBase, sha: shortHash || null });
	await postReply(ctx, shortHash ? `Fixed in ${shortHash}.` : "Fixed.", "fix");
};

export const applyFix = async (
	ctx: ReplyContext,
	targetPath: string,
	stripped: string,
): Promise<void> => {
	await applyFixes(ctx, new Map([[targetPath, stripped]]));
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
	const label = mention.kind === "issue" ? "Issue body" : "Conversation comment";
	const prompt = `${label}: ${JSON.stringify(mention.body)}\n\nRespond to the comment. Return only the response.`;
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
	try {
		await setReaction(ctx, "eyes");
		const wantsFix = allowFix && /#fix\b/i.test(mention.body);
		if (mention.kind === "issue") {
			if (wantsFix) {
				await ctx.warn(
					"fix requested on issue body or comment; only PR review and conversation comments support #fix",
					logContext(ctx),
				);
				await postReply(ctx, NO_FIX_IN_ISSUE, "error");
				return;
			}
			await handleConversation(mention, ctx);
			return;
		}
		if (mention.kind === "conversation") {
			if (wantsFix) {
				await handleConversationFix(mention, ctx);
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
	} finally {
		if (ctx.reaction?.emoji === "eyes") {
			await removeReaction(ctx);
		}
	}
};

export { CREWMATE_PREFIX, stripFences, getLogin, dispatchMention, errorMessage };
