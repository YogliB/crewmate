# Architecture Overview

`crewmate` is a small TypeScript CLI that polls a GitHub PR, issue, or repo for review comments, issue bodies, or issue comments mentioning `@crewmate`, then replies with an AI-generated explanation.

## Project Structure

```text
./
├── src/
│   ├── index.ts   # CLI, poll loop, and job runner
│   ├── bin.ts     # executable entry point
│   ├── config.ts  # flat user config file loading
│   ├── reply.ts   # reply generation via the provider
│   ├── log.ts     # structured logging with rotation
│   └── state.ts   # durable job state (atomic writes, locking, retries, pruning)
├── dist/          # built ESM output from tsdown
├── assets/
│   ├── help.md             # help text shown for --help
│   ├── SYSTEM_PROMPT.md    # default prompt for review comment replies
│   ├── config.schema.json  # JSON schema for config.json
│   └── logo.webp           # README mascot
├── skills/        # agent skills (crewmate, crewmate-stream)
├── docs/          # user and contributor documentation
├── scripts/
│   ├── oxlint-repo-guidelines.js  # custom oxlint rule guarding doc sprawl
│   └── oxlint-no-comment.js       # custom oxlint rule rejecting code comments
├── package.json   # scripts, metadata, and release config
├── tsdown.config.ts  # build configuration
└── .github/workflows/  # CI (quality, verification, security, anti-slop) and release/publish on tags
```

## Data Flow

```text
[review comment, issue body, or issue comment on GitHub] --gh api--> [src/index.ts] --provider--> [reply] --gh api--> [posted reply]
                                                                              |
                                                                              v
                                                                       [src/log.ts] --> $XDG_CONFIG_HOME/crewmate/crewmate.log
```

`src/index.ts` fetches comments with `gh api`. For a repo scope it first discovers open PRs and open issues via the `search/issues` endpoint (with a fallback to `repos/<owner>/<repo>/issues` on older GHES). Each new `@crewmate` mention becomes a **job** in the state file; the poll loop then runs pending jobs by calling `src/reply.ts` to generate an explanation with the provider CLI and post it as a comment reply. With `--dry-run`, the generated reply is written to stdout as a human-readable preview instead of posting to GitHub.

`src/index.ts` also implements `crewmate stream`, which emits new `@crewmate` mentions as NDJSON to stdout without invoking a provider or posting replies. With `--ack`, the stream also posts an `eyes` reaction to each new mention and emits the returned `reactionId`, giving an agent an immediate ack it can replace with a final reaction.

The poll loop is shared between `watch` and `stream`. Both mark a job `running` (and count the attempt) before handling it, and `succeeded` or `failed` after. A crash mid-job leaves it `running`, and the next poll retries it; `stream` saves `succeeded` only after writing stdout to avoid event loss. Failed jobs are retried with an exponential backoff (60s, 120s) up to 3 attempts; a job that exhausts its attempts gets an error reply posted to the mention.

## State

Mention jobs are stored in `$XDG_CONFIG_HOME/crewmate/state.json` as a versioned JSON map of item URLs to jobs (`status`, `attempts`, `updatedAt`, `nextAttemptAt`, `lastError`). Job keys are `<kind>:<id>` (`review`, `conversation`, or `issue`); issue bodies use `issue:<number>` because an issue body has no separate comment id. Writes are atomic (temporary file + rename), each target keeps at most 500 jobs (oldest finished jobs are pruned), and state files written by crewmate 0.6.0 and earlier (plain comment-id arrays) are migrated on load. In `--dry-run` mode, state is not written.

Both `watch` and `stream` take a lock directory at `$XDG_CONFIG_HOME/crewmate/lock` so only one process per config directory runs at a time; a stale lock from a dead process is reclaimed.

## External Dependencies

- `gh` — GitHub CLI, used for all API calls.
- `claude` — Claude CLI (default provider), used to generate explanations.
- `git` — used only to resolve the default target from the `origin` remote.

## Security Notes

No web server, no stored credentials, and no network calls from the process itself. The GitHub token comes from the `gh` CLI environment. See [docs/SECURITY.md](SECURITY.md) for reporting vulnerabilities.
