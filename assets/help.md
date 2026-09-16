# crewmate

Watch GitHub PR comments (review and conversation) and issues for `@crewmate` mentions and reply with an AI-generated explanation.

## Usage

- `crewmate watch [<target>] [options]` — poll and reply to mentions.
- `crewmate stream [<target>] [options]` — emit new mentions as NDJSON, without invoking a provider or posting replies.

`<target>` is optional inside a git repository whose `origin` remote points to GitHub. Otherwise pass a PR, issue, or repo URL or `owner/repo` shorthand. For GHES, use a full URL. Organization scope is not supported. A repo target watches open PRs and issues by default (add `--closed` to include closed ones); pass a specific URL for a closed item.

## watch options

- `--interval <seconds>` — seconds between polls (default 60).
- `--closed` — for repo targets, also watch closed PRs and issues.
- `--model <model>` — use a specific model.
- `--provider <command>` — provider CLI to use instead of `claude`.
- `--prompt <text>` — prepend custom instructions to the LLM prompt.
- `--timeout <seconds>` — kill a provider call that runs longer than this (default 600).
- `--log` — mirror structured log lines to stderr.
- `--dry-run` — preview replies on stdout without posting to GitHub; state is not persisted.
- `--user <login>` — only reply to comments from this GitHub user (defaults to the active `gh` user).
- `--unsafe-no-user` — reply to comments from any GitHub user (wins over `--user`).
- `--debug` — emit extra poll pipeline detail to the log.

## stream options

- `--interval <seconds>` — seconds between polls (default 60).
- `--closed` — for repo targets, also emit mentions from closed PRs and issues.
- `--log` — mirror structured log lines to stderr.
- `--ack` — post an `eyes` reaction to each new mention and include its `reactionId` in the event.
- `--output-file <path>` — also append each emitted NDJSON line to a file.
- `--since <ISO-timestamp>` — only emit mentions created at or after this timestamp.
- `--user <login>` — only emit mentions from this GitHub user (defaults to the active `gh` user).
- `--unsafe-no-user` — emit mentions from any GitHub user (wins over `--user`).
- `--debug` — emit extra poll pipeline detail to the log.

## Examples

```bash
crewmate watch owner/repo/pull/4
crewmate watch owner/repo --interval 120
crewmate stream owner/repo/pull/4 --ack
```

More docs: <https://github.com/YogliB/crewmate#readme>
