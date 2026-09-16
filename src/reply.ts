import { readFile } from "node:fs/promises";
import { type Logger } from "./log.js";

const CREWMATE_PREFIX = "⚓ crewmate:";
const MISSING_FILE_REPLY = "Could not find the file.";

const SYSTEM_PROMPT_PATH = new URL("../assets/SYSTEM_PROMPT.md", import.meta.url);

type MentionBase = {
	body: string;
	createdAt?: string;
	id: number;
	inReplyToId?: number;
	user?: unknown;
};

export type Mention =
	| (MentionBase & { kind: "conversation" })
	| (MentionBase & { kind: "issue" })
	| (MentionBase & { kind: "review"; line: number; path: string });

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export type Runner = (
	file: string,
	args: string[],
	options?: { env?: Record<string, string | undefined>; timeoutMs?: number },
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
	reaction?: { emoji: string; id?: number };
	repo: string;
	runner: Runner;
	timeoutSeconds: number;
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

type ReactionTarget = {
	commentId: number;
	kind: Mention["kind"];
	number: string;
	owner: string;
	repo: string;
};

const reactionTarget = ({ kind, number, commentId }: ReactionTarget): string =>
	kind === "issue" ? `issue ${number}` : `comment ${commentId}`;

const reactionEndpoint = (
	{ owner, repo, kind, number, commentId }: ReactionTarget,
	previousId?: number,
): string => {
	const suffix = previousId === undefined ? "" : `/${previousId}`;
	if (kind === "issue") {
		return `repos/${owner}/${repo}/issues/${number}/reactions${suffix}`;
	}
	const subpath = kind === "conversation" ? "issues" : "pulls";
	return `repos/${owner}/${repo}/${subpath}/comments/${commentId}/reactions${suffix}`;
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
	kind: "error" | "explain",
): Promise<void> => {
	const emoji = kind === "error" ? "-1" : "+1";
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
		{ timeoutMs: ctx.timeoutSeconds * 1000 },
	);
	return answer.trim();
};

const encodeContentPath = (targetPath: string): string =>
	targetPath
		.split("/")
		.filter((segment) => segment !== "")
		.map(encodeURIComponent)
		.join("/");

const readRemotePrFile = async (
	ctx: ReplyContext,
	targetPath: string,
): Promise<{ content: string; found: boolean }> => {
	try {
		const content = await ctx.runner(
			"gh",
			[
				"api",
				"-H",
				"Accept: application/vnd.github.raw",
				`repos/${ctx.owner}/${ctx.repo}/contents/${encodeContentPath(targetPath)}?ref=refs/pull/${ctx.number}/head`,
			],
			{ env: { GH_HOST: ctx.ghHost } },
		);
		return { content, found: true };
	} catch (error) {
		const message = errorMessage(error);
		if (message.includes("404") || message.includes("Not Found")) {
			await ctx.warn("file content API failed", {
				error: message,
				path: targetPath,
				reason: "file-content-api-failed",
			});
			await postReply(ctx, MISSING_FILE_REPLY, "error");
			return { content: "", found: false };
		}
		await ctx.warn("file content API failed", {
			error: message,
			path: targetPath,
			reason: "file-content-api-failed",
		});
		throw error;
	}
};

type ReviewMention = Extract<Mention, { kind: "review" }>;

const handleReview = async (mention: ReviewMention, ctx: ReplyContext): Promise<void> => {
	const { content, found } = await readRemotePrFile(ctx, mention.path);
	if (!found) {
		return;
	}
	// oxlint-disable-next-line security/detect-non-literal-fs-filename -- SYSTEM_PROMPT_PATH is a build-time constant
	const systemPrompt = (await readFile(SYSTEM_PROMPT_PATH, "utf8")).trim();
	const prompt = `${systemPrompt}\n\nReview comment: ${JSON.stringify(mention.body)}\nTarget file: ${JSON.stringify(mention.path)}\nLine: ${mention.line}\nFile content: ${JSON.stringify(content)}`;
	const finalPrompt = ctx.prompt ? `${ctx.prompt}\n\n${prompt}` : prompt;
	const answer = await callProvider(ctx, finalPrompt);
	if (!answer) {
		throw new Error(`${ctx.provider || "claude"} returned empty explanation`);
	}
	await postReply(ctx, answer, "explain");
};

const handleConversation = async (mention: Mention, ctx: ReplyContext): Promise<void> => {
	const label = mention.kind === "issue" ? "Issue body" : "Conversation comment";
	const prompt = `${label}: ${JSON.stringify(mention.body)}\n\nRespond to the comment. Return only the response.`;
	const finalPrompt = ctx.prompt ? `${ctx.prompt}\n\n${prompt}` : prompt;
	const answer = await callProvider(ctx, finalPrompt);
	if (!answer) {
		throw new Error(`${ctx.provider || "claude"} returned empty conversation response`);
	}
	await postReply(ctx, answer, "explain");
};

const handleMention = async (mention: Mention, ctx: ReplyContext): Promise<void> => {
	try {
		await setReaction(ctx, "eyes");
		if (mention.kind === "review") {
			await handleReview(mention, ctx);
		} else {
			await handleConversation(mention, ctx);
		}
	} finally {
		if (ctx.reaction?.emoji === "eyes") {
			await removeReaction(ctx);
		}
	}
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

export {
	CREWMATE_PREFIX,
	errorMessage,
	getLogin,
	handleMention,
	postReply,
	reactionEndpoint,
	type ReplyContext,
};
