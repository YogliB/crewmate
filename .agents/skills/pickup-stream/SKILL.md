---
name: pickup-stream
description: Run pickup in stream mode and handle incoming @pickup PR mentions as NDJSON events. Use when the user wants to poll a PR for pickup mentions, consume the pickup NDJSON stream, or build an agent that responds to review and conversation comments.
---

# pickup stream

`pickup stream <pr-url-or-shorthand>` emits one JSON object per new `@pickup` mention on stdout. It does not invoke the provider, post replies, or run `gh pr checkout`.

## Start the stream

```bash
pickup stream <pr-url-or-shorthand> [--user <login>] [--interval <seconds>] [--log]
```

- `<pr-url-or-shorthand>`: `https://github.com/owner/repo/pull/4` or `owner/repo/pull/4`.
- `--user`: only emit mentions from this GitHub login.
- `--interval`: seconds between polls (default 60).
- `--log`: also mirror log lines to stderr.

## Event schema

```json
{
	"at": "2026-08-05T12:34:56.789Z",
	"event": "mention",
	"owner": "owner",
	"repo": "repo",
	"number": 4,
	"commentId": 123,
	"kind": "review",
	"user": "alice",
	"body": "@pickup explain this line",
	"url": "https://github.com/owner/repo/pull/4",
	"path": "src/index.ts",
	"line": 42
}
```

Fields:

- `at`: ISO-8601 timestamp.
- `event`: always `"mention"`.
- `owner`, `repo`, `number`: PR coordinates.
- `commentId`: GitHub comment id.
- `kind`: `"review"` or `"conversation"`.
- `user`: comment author's GitHub login (may be empty if unavailable).
- `body`: full comment body.
- `url`: normalized PR URL.
- `path`, `line`: only present for `kind: "review"`.

## Handle a mention

1. Parse each NDJSON line as JSON.
2. If `event !== "mention"`, skip.
3. Inspect `body` and `kind`.
4. If `kind === "review"` and `body` matches `#fix` (case-insensitive), run `pickup watch <url> --fix` to generate and push a fix.
5. If `kind === "conversation"` and `body` contains `#fix`, do not attempt a fix — pickup rejects these. Reply with `pickup watch <url>` or post a manual comment.
6. If you only need an explanation, run `pickup watch <url>` to let pickup reply.
7. If you want custom behavior, reply manually:
   - Review comment reply: `gh api repos/<owner>/<repo>/pulls/<number>/comments -f body=<text> -f in_reply_to=<commentId>`.
   - Conversation comment: `gh api repos/<owner>/<repo>/issues/<number>/comments -f body=<text>`.
8. Do not double-post; `pickup` already tracks seen comment ids in `$XDG_CONFIG_HOME/pickup/state.json` and saves state after each stdout write in stream mode.

## Example one-shot handler

```bash
pickup stream owner/repo/pull/4 --user myorg-bot | while IFS= read -r line; do
	event=$(echo "$line" | jq -r '.event')
	[ "$event" = "mention" ] || continue
	url=$(echo "$line" | jq -r '.url')
	kind=$(echo "$line" | jq -r '.kind')
	body=$(echo "$line" | jq -r '.body')
	if [ "$kind" = "review" ] && printf '%s' "$body" | grep -qi '#fix'; then
		pickup watch "$url" --fix
	else
		pickup watch "$url"
	fi
done
```

For custom logic, parse the JSON yourself and call the GitHub CLI directly.
