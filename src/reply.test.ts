import { describe, expect, it, vi } from "vitest";

const { CREWMATE_PREFIX, errorMessage, getLogin, handleMention, postReply, reactionEndpoint } =
	await import("./reply.js");

type ReplyContext = import("./reply.js").ReplyContext;
type Mention = import("./reply.js").Mention;
type Runner = import("./reply.js").Runner;

const reviewMention = (overrides: Record<string, unknown> = {}): Mention =>
	({
		body: "@crewmate explain",
		id: 1,
		kind: "review",
		line: 5,
		path: "src/index.ts",
		user: { login: "alice" },
		...overrides,
	}) as Mention;

const conversationMention = (overrides: Record<string, unknown> = {}): Mention =>
	({
		body: "@crewmate explain",
		id: 2,
		kind: "conversation",
		user: { login: "alice" },
		...overrides,
	}) as Mention;

const issueMention = (overrides: Record<string, unknown> = {}): Mention =>
	({
		body: "@crewmate explain",
		id: 3,
		kind: "issue",
		user: { login: "alice" },
		...overrides,
	}) as Mention;

const makeCtx = (
	runner: Runner,
	overrides: Partial<ReplyContext> = {},
): {
	ctx: ReplyContext;
	logs: { event: string; fields?: Record<string, unknown> }[];
	warnings: string[];
} => {
	const logs: { event: string; fields?: Record<string, unknown> }[] = [];
	const warnings: string[] = [];
	const ctx: ReplyContext = {
		commentId: 1,
		dryRun: false,
		ghHost: "github.com",
		kind: "review",
		logger: async (event, fields) => {
			logs.push({ event, fields });
		},
		number: "4",
		owner: "owner",
		repo: "repo",
		runner,
		timeoutSeconds: 42,
		warn: async (message) => {
			warnings.push(message);
		},
		...overrides,
	};
	return { ctx, logs, warnings };
};

const providerRunner = (answer: string | Error = "It does something."): Runner =>
	vi.fn((file: string) => {
		if (file === "claude") {
			return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
		}
		return Promise.resolve(JSON.stringify({ id: 7 }));
	}) as unknown as Runner;

describe("reply", () => {
	it("errorMessage formats errors and values", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage("plain")).toBe("plain");
	});

	it("getLogin extracts a login", () => {
		expect(getLogin({ login: "alice" })).toBe("alice");
		expect(getLogin({ login: 1 })).toBe("");
		expect(getLogin(null)).toBe("");
		expect(getLogin("alice")).toBe("");
	});

	it("builds reaction endpoints per kind", () => {
		expect(
			reactionEndpoint({ owner: "o", repo: "r", kind: "issue", number: "4", commentId: 4 }),
		).toBe("repos/o/r/issues/4/reactions");
		expect(
			reactionEndpoint({ owner: "o", repo: "r", kind: "conversation", number: "4", commentId: 9 }),
		).toBe("repos/o/r/issues/comments/9/reactions");
		expect(
			reactionEndpoint({ owner: "o", repo: "r", kind: "review", number: "4", commentId: 9 }, 11),
		).toBe("repos/o/r/pulls/comments/9/reactions/11");
	});

	it("posts a reply with the crewmate prefix and a reaction", async () => {
		const runner = providerRunner();
		const { ctx, logs } = makeCtx(runner);
		await postReply(ctx, "hello", "explain");
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		const reaction = calls.find(([, args]) => args.includes("content=+1"));
		expect(reaction).toBeDefined();
		const reply = calls.find(
			([, args]) =>
				args.includes("POST") && args.some((a) => a === `body=${CREWMATE_PREFIX} hello`),
		);
		expect(reply).toBeDefined();
		expect(logs).toContainEqual({
			event: "reply",
			fields: expect.objectContaining({ failed: false, kind: "explain" }),
		});
	});

	it("posts error replies with a thumbs-down", async () => {
		const runner = providerRunner();
		const { ctx } = makeCtx(runner, { kind: "issue", commentId: 4 });
		await postReply(ctx, "nope", "error");
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.find(([, args]) => args.includes("content=-1"))).toBeDefined();
		const reply = calls.find(([, args]) =>
			args.some((a) => typeof a === "string" && a.startsWith("body=")),
		);
		expect(reply?.[1]).toContain("repos/owner/repo/issues/4/comments");
	});

	it("previews replies and reactions in dry-run mode", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = providerRunner();
		const { ctx, logs } = makeCtx(runner, { dryRun: true, kind: "conversation" });
		await postReply(ctx, "hello", "explain");
		expect(stdout).toHaveBeenCalledWith(
			expect.stringContaining("[dry-run] would post a comment on pull request 4"),
		);
		expect(stdout).toHaveBeenCalledWith(expect.stringContaining("from :none: to :+1:"));
		expect(logs).toContainEqual({
			event: "reply",
			fields: expect.objectContaining({ failed: false }),
		});
		expect((runner as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
		stdout.mockRestore();
	});

	it("removes the reaction and rethrows when the reply post fails", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (
				args.includes("POST") &&
				args.some((a) => typeof a === "string" && a.startsWith("body="))
			) {
				return Promise.reject(new Error("network down"));
			}
			if (args.includes("DELETE")) {
				return Promise.resolve("");
			}
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, logs } = makeCtx(runner);
		await expect(postReply(ctx, "hello", "explain")).rejects.toThrow("network down");
		expect(logs).toContainEqual({
			event: "reply",
			fields: expect.objectContaining({ failed: true, error: "network down" }),
		});
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.find(([, args]) => args.includes("DELETE"))).toBeDefined();
		expect(ctx.reaction).toBeUndefined();
	});

	it("handles review mentions end to end", async () => {
		const runner = providerRunner("A useful explanation.");
		const { ctx, logs } = makeCtx(runner);
		await handleMention(reviewMention(), ctx);
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		const providerCall = calls.find(([file]) => file === "claude");
		expect(providerCall).toBeDefined();
		const args = providerCall![1];
		const promptIndex = args.indexOf("-p");
		expect(args[promptIndex + 1]).toContain("Follow the review.");
		expect(args[promptIndex + 1]).toContain("Review comment: ");
		expect(providerCall![2]).toEqual({ timeoutMs: 42_000 });
		expect(calls.find(([, a]) => a.includes("content=eyes"))).toBeDefined();
		expect(calls.find(([, a]) => a.includes("content=+1"))).toBeDefined();
		expect(calls.find(([, a]) => a.includes("DELETE"))).toBeDefined();
		expect(logs).toContainEqual({
			event: "reply",
			fields: expect.objectContaining({ failed: false, kind: "explain" }),
		});
	});

	it("passes --model to the provider and prepends a custom prompt", async () => {
		const runner = providerRunner("answer");
		const { ctx } = makeCtx(runner, { model: "opus", prompt: "Be terse" });
		await handleMention(conversationMention(), ctx);
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		const providerCall = calls.find(([file]) => file === "claude");
		expect(providerCall![1]).toEqual(
			expect.arrayContaining(["--model", "opus", "-p", expect.stringContaining("Be terse")]),
		);
		expect(providerCall![1].at(-1)).toContain("Conversation comment: ");
	});

	it("uses the issue label for issue bodies", async () => {
		const runner = providerRunner("answer");
		const { ctx } = makeCtx(runner, { kind: "issue", commentId: 4 });
		await handleMention(issueMention(), ctx);
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		const providerCall = calls.find(([file]) => file === "claude");
		expect(providerCall![1].at(-1)).toContain("Issue body: ");
	});

	it("honors a custom provider", async () => {
		const runner = vi.fn((file: string) => {
			if (file === "my-llm") return Promise.resolve("answer");
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx } = makeCtx(runner, { provider: "my-llm" });
		await handleMention(conversationMention(), ctx);
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.find(([file]) => file === "my-llm")).toBeDefined();
		expect(calls.find(([file]) => file === "claude")).toBeUndefined();
	});

	it("throws when the provider returns an empty review explanation", async () => {
		const runner = providerRunner("   ");
		const { ctx } = makeCtx(runner);
		await expect(handleMention(reviewMention(), ctx)).rejects.toThrow(
			"claude returned empty explanation",
		);
	});

	it("throws when the provider returns an empty conversation response", async () => {
		const runner = providerRunner("");
		const { ctx } = makeCtx(runner, { kind: "conversation" });
		await expect(handleMention(conversationMention(), ctx)).rejects.toThrow(
			"claude returned empty conversation response",
		);
	});

	it("replies with a missing-file message when the file is gone", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (args.includes("Accept: application/vnd.github.raw")) {
				return Promise.reject(new Error("HTTP 404: Not Found"));
			}
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await handleMention(reviewMention(), ctx);
		expect(warnings).toContain("file content API failed");
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		expect(
			calls.find(([, a]) =>
				a.some((x) => x === `body=${CREWMATE_PREFIX} Could not find the file.`),
			),
		).toBeDefined();
		expect(calls.find(([file]) => file === "claude")).toBeUndefined();
	});

	it("rethrows unexpected file-content API errors", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (args.includes("Accept: application/vnd.github.raw")) {
				return Promise.reject(new Error("HTTP 500: boom"));
			}
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await expect(handleMention(reviewMention(), ctx)).rejects.toThrow("HTTP 500: boom");
		expect(warnings).toContain("file content API failed");
	});

	it("keeps the eyes reaction when the run ends without a final reaction", async () => {
		const runner = providerRunner(new Error("provider exploded"));
		const { ctx } = makeCtx(runner);
		await expect(handleMention(conversationMention(), ctx)).rejects.toThrow("provider exploded");
		const calls = (runner as unknown as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.find(([, a]) => a.includes("content=eyes"))).toBeDefined();
		expect(calls.find(([, a]) => a.includes("DELETE"))).toBeDefined();
		expect(ctx.reaction).toBeUndefined();
	});

	it("warns when a reaction post returns an empty response", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (args.includes("POST") && args.some((a) => a.includes("/reactions"))) {
				return Promise.resolve("");
			}
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await handleMention(conversationMention(), ctx);
		expect(warnings).toContain("failed to set reaction: empty response");
	});

	it("warns when a reaction post returns a non-numeric id", async () => {
		const runner = vi.fn(() => Promise.resolve(JSON.stringify({ id: "x" }))) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await handleMention(conversationMention(), ctx);
		expect(warnings).toContain("failed to set reaction: response did not contain a numeric id");
	});

	it("warns when a reaction post returns invalid JSON", async () => {
		const runner = vi.fn(() => Promise.resolve("not json")) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await handleMention(conversationMention(), ctx);
		expect(warnings.some((w) => w.startsWith("failed to set reaction:"))).toBe(true);
	});

	it("warns when a reaction post fails outright", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (args.includes("POST") && args.some((a) => a.includes("/reactions"))) {
				return Promise.reject(new Error("reaction refused"));
			}
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await handleMention(conversationMention(), ctx);
		expect(warnings).toContain("failed to set reaction: reaction refused");
	});

	it("warns when removing a reaction fails", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (args.includes("DELETE")) {
				return Promise.reject(new Error("delete refused"));
			}
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await handleMention(conversationMention(), ctx);
		expect(warnings.some((w) => w.startsWith("failed to remove reaction:"))).toBe(true);
	});

	it("warns when removing a reaction without an id", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (args.includes("POST") && args.some((a) => a.includes("/reactions"))) {
				return Promise.resolve("not json");
			}
			if (args.includes("POST")) {
				return Promise.reject(new Error("post failed"));
			}
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await expect(postReply(ctx, "hello", "explain")).rejects.toThrow("post failed");
		expect(warnings).toContain("failed to remove reaction: no reaction id");
	});

	it("previews reaction removal in dry-run mode", async () => {
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const runner = providerRunner("");
		const { ctx } = makeCtx(runner, { dryRun: true });
		await expect(handleMention(conversationMention(), ctx)).rejects.toThrow();
		expect(stdout).toHaveBeenCalledWith(
			expect.stringContaining("[dry-run] would remove reaction :eyes:"),
		);
		stdout.mockRestore();
	});

	it("keeps the final reaction after a successful reply", async () => {
		const runner = providerRunner("answer");
		const { ctx } = makeCtx(runner);
		await handleMention(conversationMention(), ctx);
		expect(ctx.reaction?.emoji).toBe("+1");
	});

	it("warns when removing a reaction fails", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (args.includes("DELETE")) return Promise.reject(new Error("delete refused"));
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await handleMention(conversationMention(), ctx);
		expect(warnings).toContain("failed to remove reaction: delete refused");
	});

	it("prints a dry-run issue reply", async () => {
		const runner = providerRunner();
		const { ctx } = makeCtx(runner, { dryRun: true, kind: "issue" });
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await handleMention(issueMention(), ctx);
			const printed = write.mock.calls.map((call) => String(call[0])).join("");
			expect(printed).toContain("post a comment on issue 4");
		} finally {
			write.mockRestore();
		}
	});

	it("warns when reaction cleanup fails after an error", async () => {
		const runner = vi.fn((file: string, args: string[]) => {
			if (args.includes("DELETE")) return Promise.reject(new Error("cleanup refused"));
			if (file === "claude" && args.includes("-p"))
				return Promise.reject(new Error("provider exploded"));
			return Promise.resolve(JSON.stringify({ id: 7 }));
		}) as unknown as Runner;
		const { ctx, warnings } = makeCtx(runner);
		await expect(handleMention(conversationMention(), ctx)).rejects.toThrow("provider exploded");
		expect(warnings).toContain("failed to remove reaction: cleanup refused");
	});
});
