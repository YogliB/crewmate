---
name: crewmate
description: Run crewmate in stream mode and handle incoming @crewmate PR or issue mentions as NDJSON events. Use when the user wants to poll GitHub targets for crewmate mentions, consume the crewmate NDJSON stream, or build a custom responder.
---

# crewmate stream

`crewmate stream [<target>]` emits one JSON object per new `@crewmate` mention on stdout. It does not invoke the provider, post replies, or run `gh pr checkout`.

## Install

If `crewmate` is not installed, install the CLI first:

```bash
npm install -g crewmate
```

If this skill is not installed, add it from the repository:

```bash
npx skills add YogliB/crewmate --skill crewmate
```

You can also copy `.agents/skills/crewmate/SKILL.md` from the repository into your agent's skills directory.

## Start the stream

```bash
crewmate stream [<target>] [--user <login>] [--unsafe-no-user] [--interval <seconds>] [--log] [--debug]
```

- `<target>`: a PR, issue, repository, organization, or GHES URL. It defaults to the current repository from its `origin` remote.
- `--user`: only emit mentions from this GitHub login. It defaults to the active `gh` user when unset.
- `--unsafe-no-user`: emit mentions from any GitHub user.
- `--interval`: seconds between polls (default 60).
- `--log`: also mirror log lines to stderr.
- `--debug`: add poll-pipeline details to the structured log.

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
- `commentId`: GitHub comment id, or the issue number for an issue body.
- `kind`: `"review"`, `"conversation"`, or `"issue"`.
- `user`: comment author's GitHub login (may be empty if unavailable).
- `body`: full comment body.
- `url`: normalized PR or issue URL.
- `path`, `line`: only present for `kind: "review"`.

## Handle a mention

1. Parse each NDJSON line as JSON.
2. If `event !== "mention"`, skip.
3. Inspect `body` and `kind`.
4. If you want `crewmate` to reply, explain, or fix, run `crewmate watch <url>` or `crewmate watch <url> --fix` **instead of** `crewmate stream`. `crewmate stream` and `crewmate watch` share the same state file, so a mention emitted by stream is already marked as seen and `crewmate watch` would skip it.
5. If you are building a custom responder on top of `crewmate stream`, reply manually:
   - Review comment reply: `gh api repos/<owner>/<repo>/pulls/<number>/comments/<commentId>/replies -f body=<text>`.
   - PR conversation or issue reply: `gh api repos/<owner>/<repo>/issues/<number>/comments -f body=<text>`.
6. Do not double-post; `crewmate` tracks seen comment ids in `<config>/crewmate/state.json` and saves state after each stdout write in stream mode. `<config>` is `$XDG_CONFIG_HOME` when set and otherwise the current user's `.config` directory.

## Example one-shot handler

A custom responder that posts a manual reply. This is useful when you want different behavior from `crewmate watch`.

```bash
crewmate stream owner/repo/pull/4 --user myorg-bot | while IFS= read -r line; do
	event=$(echo "$line" | jq -r '.event')
	[ "$event" = "mention" ] || continue

	owner=$(echo "$line" | jq -r '.owner')
	repo=$(echo "$line" | jq -r '.repo')
	number=$(echo "$line" | jq -r '.number')
	commentId=$(echo "$line" | jq -r '.commentId')
	kind=$(echo "$line" | jq -r '.kind')
	body=$(echo "$line" | jq -r '.body')

	if [ "$kind" = "review" ] && printf '%s' "$body" | grep -qi '#fix'; then
		# Generate and apply your own fix, then reply to the review comment.
		reply="Got it — I'll push a fix for this."
		gh api "repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies" -f "body=${reply}"
	else
		reply="Looking into this."
		if [ "$kind" = "review" ]; then
			gh api "repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies" -f "body=${reply}"
		else
			gh api "repos/${owner}/${repo}/issues/${number}/comments" -f "body=${reply}"
		fi
	fi
done
```

If you just want `crewmate` to reply or fix, use `crewmate watch` instead.
