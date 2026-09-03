---
name: crewmate
description: Respond to a @crewmate mention as the agent-in-charge. Use when a crewmate stream event is received or the user wants to reply to, explain, or fix a PR review, conversation, or issue comment.
---

# crewmate

This skill makes the agent the handler for `@crewmate` mentions. The `crewmate` CLI streams events; the agent reads each event and decides what to do.

Do not run `crewmate watch` in this mode. `watch` invokes a provider CLI and is meant for fully autonomous runs. The agent is the provider here.

## What you will receive

A single NDJSON event from `crewmate stream` or `crewmate stream <url> --ack`:

```json
{
	"at": "2026-08-05T12:34:56.789Z",
	"event": "mention",
	"owner": "owner",
	"repo": "repo",
	"number": 4,
	"commentId": 123,
	"reactionId": 456,
	"kind": "review",
	"user": "alice",
	"body": "@crewmate explain this line",
	"url": "https://github.com/owner/repo/pull/4",
	"path": "src/index.ts",
	"line": 42
}
```

## Handler flow

1. **Skip non-mention events.** If `event !== "mention"`, ignore.
2. **Read the comment.** Use `body`, `kind`, `path`, `line` (for `review`), and `number`.
3. **Check for `#fix`.** A `#fix` tag in the body (case-insensitive) means the user wants a code change. Only `review` and `conversation` comments on a PR can be fixed; issue mentions cannot.
4. **Fetch context.**
   - `review`: get the file at `path` from the local checkout, or from the PR head with `gh api repos/<owner>/<repo>/contents/<path>?ref=refs/pull/<number>/head -H "Accept: application/vnd.github.raw"`.
   - `conversation`: get the PR's changed files with `gh api repos/<owner>/<repo>/pulls/<number>/files?per_page=100`, then read each file's content.
   - `issue`: no file context needed.
5. **Generate the answer.** Use the agent's own model. Do not shell out to `claude -p` or `crewmate watch`. For review comments, `assets/SYSTEM_PROMPT.md` is a good starting point.
6. **Post the reply.** Prefix it with `⚓ crewmate:` so `crewmate` can recognize its own replies. Use the correct endpoint:
   - `review`: `gh api --method POST repos/<owner>/<repo>/pulls/<number>/comments/<commentId>/replies -f body=<text>`
   - `conversation` / `issue`: `gh api --method POST repos/<owner>/<repo>/issues/<number>/comments -f body=<text>`
7. **Manage the reaction.**
   - If the stream was started with `--ack`, it already posted an `eyes` reaction and gave you `reactionId`.
   - Delete it with `gh api --method DELETE repos/<owner>/<repo>/.../reactions/<reactionId>` (use the same endpoint the CLI used).
   - Post the final reaction: `gh api --method POST repos/<owner>/<repo>/.../reactions -f content=<emoji>`.
   - Use `+1` for a normal reply, `rocket` for a successful fix, `-1` for an error or no change.
8. **Apply a fix if requested.**
   - For a `review` fix: write the corrected file content to `path` in the local checkout, then `git add`, `git commit -m "fix: address crewmate comment"`, `git push`. If there is no checkout, post the corrected content as a reply instead.
   - For a `conversation` fix: `gh pr checkout -R <owner>/<repo> <number>`, then apply the same flow to the changed files.
9. **Do not double-post.** `crewmate stream` already marks the mention as seen. As long as your reply starts with `⚓ crewmate:`, it should not be reprocessed.

## Start the stream

If no stream is running, start it with:

```bash
crewmate stream <pr-url-or-shorthand> --ack
```

Then process each line. The `--ack` flag is recommended so the human sees an `eyes` reaction while the agent is thinking.

## Common endpoints

- Review comment reply: `gh api --method POST repos/<owner>/<repo>/pulls/<number>/comments/<commentId>/replies -f body=<text>`
- Conversation / issue comment: `gh api --method POST repos/<owner>/<repo>/issues/<number>/comments -f body=<text>`
- Delete a reaction: `gh api --method DELETE repos/<owner>/<repo>/[pulls|issues]/comments/<commentId>/reactions/<reactionId>` or `repos/<owner>/<repo>/issues/<number>/reactions/<reactionId>`
- Post a reaction: `gh api --method POST repos/<owner>/<repo>/[pulls|issues]/comments/<commentId>/reactions -f content=<emoji>` or `repos/<owner>/<repo>/issues/<number>/reactions -f content=<emoji>`
