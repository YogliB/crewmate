# Architecture Overview

`crewmate` is a small TypeScript CLI that polls a GitHub PR for review comments mentioning `@crewmate`, then replies with an explanation or a generated fix.

## Project Structure

```text
./
├── src/
│   ├── index.ts   # CLI and watch loop
│   ├── bin.ts     # executable entry point
│   ├── fix.ts     # reply generation and fix application
│   ├── log.ts     # structured logging
│   └── state.ts   # persistent seen-comment state
├── dist/          # built ESM output from tsdown
├── assets/
│   ├── help.md    # help text shown for --help
│   └── logo.png   # README mascot
├── docs/          # user and contributor documentation
├── scripts/
│   └── oxlint-repo-guidelines.js  # custom oxlint rule guarding doc sprawl
├── package.json   # scripts, metadata, and release config
├── tsdown.config.ts  # build configuration
└── .github/workflows/  # CI checks (lint, format, duplicates, knip, typecheck, test, security)
```

## Data Flow

```text
[review comment on GitHub] --gh api--> [src/index.ts] --claude--> [reply or fix] --gh api--> [posted reply]
                                                                                  |
                                                                                  v
                                                                           [src/log.ts] --> $XDG_CONFIG_HOME/crewmate/crewmate.log
```

`src/index.ts` fetches comments with `gh api`. For a repo or org scope it first discovers open PRs via the `search/issues` endpoint (with a fallback to `repos/<owner>/<repo>/pulls` on older GHES), then for each PR it finds the newest unseen `@crewmate` mention and either:

- calls `src/fix.ts` to explain the line, or
- calls `src/fix.ts` to generate and apply a fix when the comment contains `#fix` and `--fix` is enabled.

With `--dry-run`, the generated reply or fix is written to stdout as a human-readable preview instead of posting to GitHub or committing/pushing.

`src/index.ts` also implements `crewmate stream`, which emits new `@crewmate` mentions as NDJSON to stdout without invoking a provider or posting replies. The poll loop is shared between `watch` and `stream`: `watch` saves state before replying to avoid duplicate posts, while `stream` saves state after writing stdout to avoid event loss.

## State

Seen comment IDs are stored in `$XDG_CONFIG_HOME/crewmate/state.json` as a JSON map of PR URLs to arrays of comment IDs. The file is read at the start of each poll and written before any reply is posted, so an error does not reprocess the same comment. In `--dry-run` mode, state is not written.

## External Dependencies

- `gh` — GitHub CLI, used for API calls and `gh pr checkout`.
- `claude` — Claude CLI, used to generate explanations and fixes.
- `git` — used to commit and push fixes.

## Security Notes

No web server, no stored credentials, and no network calls from the process itself. The GitHub token comes from the `gh` CLI environment. See [docs/SECURITY.md](SECURITY.md) for reporting vulnerabilities.
