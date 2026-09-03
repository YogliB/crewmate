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

## Start the stream

```bash
crewmate stream <pr-url-or-shorthand> [--user <login>] [--interval <seconds>] [--log] [--ack] [--output-file <path>]
```

- `<pr-url-or-shorthand>`: `https://github.com/owner/repo/pull/4` or `owner/repo/pull/4`. Can also be an issue, a repo, an org, or a GHES full URL.
- `--user`: only emit mentions from this GitHub login.
- `--interval`: seconds between polls (default 60).
- `--log`: also mirror log lines to stderr.
- `--ack`: post an `eyes` reaction on each new mention and include the returned `reactionId` in the event.
- `--output-file`: also append each emitted NDJSON line to the given file, creating its parent directory if needed.

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

## Notes

- `crewmate stream` and `crewmate watch` share the same state file. If an agent is handling the stream, do not also run `crewmate watch` on the same target; it would skip already-seen mentions.
- State is tracked in `$XDG_CONFIG_HOME/crewmate/state.json`.
- `crewmate watch` is the fully autonomous mode and calls an LLM provider. It is not suitable for the agent-in-charge flow.
