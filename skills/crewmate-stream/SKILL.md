---
name: crewmate-stream
description: Run the crewmate CLI as a headless event pump for @crewmate PR mentions. Use when the user wants to stream @crewmate mentions as NDJSON without invoking an LLM provider or posting replies.
---

# crewmate stream

`crewmate stream <pr-url-or-shorthand>` emits one JSON object per new `@crewmate` mention on stdout. It does not invoke the provider, post replies, or run `gh pr checkout`. It can optionally acknowledge each new mention with an `eyes` reaction.

## Install

If `crewmate` is not installed, install the CLI first:

```bash
npm install -g crewmate
```

If this skill is not installed, add it from the repository:

```bash
npx skills add YogliB/crewmate --skill crewmate-stream
```

You can also copy `skills/crewmate-stream/SKILL.md` from the repository into your agent's skills directory.

In non-TTY / agent shells, `npx` may hang waiting for an install confirmation. Use `npx --yes` so the command proceeds without a TTY:

```bash
npx --yes crewmate stream <pr-url-or-shorthand>
```

## Start the stream

```bash
crewmate stream <pr-url-or-shorthand> [--user <login>] [--interval <seconds>] [--log] [--ack] [--output-file <path>] [--since <ISO-timestamp>]
```

- `<pr-url-or-shorthand>`: `https://github.com/owner/repo/pull/4` or `owner/repo/pull/4`. Can also be an issue, a repo, an org, or a GHES full URL.
- `--user`: only emit mentions from this GitHub login.
- `--interval`: seconds between polls (default 60).
- `--log`: also mirror log lines to stderr.
- `--ack`: post an `eyes` reaction on each new mention and include the returned `reactionId` in the event.
- `--output-file`: also append each emitted NDJSON line to the given file, creating its parent directory if needed.
- `--since`: only emit mentions whose GitHub `created_at` is at or after the given ISO-8601 timestamp. A timestamp without an offset is read as UTC.

## Agent / IDE usage

When running inside an agent shell that filters or captures stdout (for example with `rtk` or a similar token-saving hook), the NDJSON events on stdout may be swallowed. Use `--output-file` and a separate log file so events land on disk no matter what happens to stdout:

```bash
npx --yes crewmate stream <pr-url-or-shorthand> --output-file /tmp/crewmate.ndjson > /tmp/crewmate.log 2>&1
tail -n 0 -f /tmp/crewmate.ndjson
```

- `tail -n 0 -f` starts following from the end, so you do not reprocess the file's existing contents on startup.
- If you must use `tail -f <file>` from the beginning, track the `commentId`s you have already handled and ignore duplicates.
- `--since` can also be used to skip older comments when starting a fresh consumer, for example `--since 2026-09-01T00:00:00Z`.

## Event schema

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

Fields:

- `at`: ISO-8601 timestamp.
- `event`: always `"mention"`.
- `owner`, `repo`, `number`: PR or issue coordinates.
- `commentId`: GitHub comment id (for issue mentions, this is the issue number).
- `reactionId`: id of the `eyes` reaction posted by the CLI when `--ack` is used. The handler should delete this id and post the final reaction.
- `kind`: `"review"`, `"conversation"`, or `"issue"`.
- `user`: comment author's GitHub login (may be empty if unavailable).
- `body`: full comment body.
- `url`: normalized PR or issue URL.
- `path`, `line`: only present for `kind: "review"`.

## Handling mentions

A typical handler loop for an agent receiving `crewmate stream` events:

1. Read `body`, `kind`, `path`, `line` (for `review`), and `number`.
2. Check for `#fix` (case-insensitive). Only `review` and `conversation` comments on a PR support `#fix`.
3. Generate a reply using the agent's own model.
4. Post the reply, prefixing it with `⚓ crewmate:` so crewmate can recognize it.
   - `review`: `gh api --method POST repos/<owner>/<repo>/pulls/<number>/comments/<commentId>/replies -f body=<text>`
   - `conversation` / `issue`: `gh api --method POST repos/<owner>/<repo>/issues/<number>/comments -f body=<text>`
5. Swap the reaction. If `--ack` was used, `reactionId` is in the event:
   - Delete the `eyes` reaction with `gh api --method DELETE repos/<owner>/<repo>/[pulls|issues]/comments/<commentId>/reactions/<reactionId>` (or `repos/<owner>/<repo>/issues/<number>/reactions/<reactionId>` for issues).
   - Post the final reaction: `gh api --method POST repos/<owner>/<repo>/[pulls|issues]/comments/<commentId>/reactions -f content=<emoji>` (or `repos/<owner>/<repo>/issues/<number>/reactions -f content=<emoji>` for issues).
   - Use `+1` for a normal reply, `rocket` for a successful fix, `-1` for an error or no change.
6. Do not double-post. As long as the reply starts with `⚓ crewmate:`, `crewmate stream` will not reprocess it.

## Notes

- `crewmate stream` and `crewmate watch` share the same state file. If an agent is handling the stream, do not also run `crewmate watch` on the same target; it would skip already-seen mentions.
- State is tracked in `$XDG_CONFIG_HOME/crewmate/state.json`.
- `crewmate watch` is the fully autonomous mode and calls an LLM provider. It is not suitable for the agent-in-charge flow.
