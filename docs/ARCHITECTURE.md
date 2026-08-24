# Architecture Overview

`crewmate` is a small TypeScript CLI that polls a GitHub PR or issue for review comments, issue bodies, or issue comments mentioning `@crewmate`, then replies with an explanation or a generated fix.

## Project Structure

```text
./
├── src/
│   ├── index.ts   # public API, CLI dispatch, and polling
│   ├── bin.ts     # executable entry point
│   ├── config.ts  # global and per-repository configuration
│   ├── fix.ts     # reply generation and fix application
│   ├── init.ts    # interactive global configuration setup
│   ├── log.ts     # structured logging
│   └── state.ts   # persistent seen-comment state
├── dist/          # minified Node 24 ESM and declarations from tsdown
├── assets/
│   ├── config.schema.json  # global and repository config schema
│   ├── help.md             # help text shown for --help
│   ├── logo.webp           # README mascot
│   └── SYSTEM_PROMPT.md    # default review explanation prompt
├── docs/          # user and contributor documentation
├── scripts/
│   └── oxlint-repo-guidelines.js  # custom oxlint rule guarding doc sprawl
├── package.json   # scripts, metadata, and release config
├── tsdown.config.ts  # build configuration
└── .github/workflows/  # quality, build, security, PR-quality, and publish automation
```

## Data Flow

```text
[review comment, issue body, or issue comment on GitHub] --gh api--> [src/index.ts] --provider CLI--> [reply or fix] --gh api--> [posted reply]
                                                                                       |
                                                                                       v
                                                                                [src/log.ts] --> <config>/crewmate/crewmate.log
```

`src/index.ts` fetches comments with `gh api`. For a repo or org scope it first discovers open PRs and open issues via the `search/issues` endpoint (with a fallback to `repos/<owner>/<repo>/issues` on older GHES), then processes every unseen `@crewmate` mention, newest first, and either:

- calls `src/fix.ts` to explain the line or respond to a conversation/issue comment, or
- calls `src/fix.ts` to generate and apply a fix when the comment contains `#fix` and `--fix` is enabled. For review comments `src/fix.ts` uses the comment's `path` and `line`; for PR conversation comments it fetches the PR's changed files from the GitHub API and asks the provider to return the corrected file content.

With `--dry-run`, the generated reply or fix is written to stdout as a human-readable preview instead of posting to GitHub or committing/pushing.

`src/index.ts` also implements `crewmate stream`, which emits new `@crewmate` mentions as NDJSON to stdout without invoking a provider or posting replies. The poll loop is shared between `watch` and `stream`: `watch` saves state before replying to avoid duplicate posts, while `stream` saves state after writing stdout to avoid event loss.

## Public API

`src/index.ts` exports a callable default function that dispatches CLI-style arguments. The same export exposes `watch`, `stream`, and parsing, discovery, reply, and state helpers. `Mention` and `Scope` are named type exports.

## State

Seen comment IDs are stored in `<config>/crewmate/state.json` as a JSON map of item URLs to arrays of comment IDs. Issue bodies use the state key `issue:<number>` because an issue body has no separate comment id. The file is read at the start of each poll. `watch` writes state before posting a reply so an error does not reprocess the same mention; `stream` writes it after emitting stdout. In `--dry-run` mode, state is not written.

## External Dependencies

- `gh` — GitHub CLI, used for API calls and `gh pr checkout`.
- A `claude`-shaped provider CLI — `claude` by default, used to generate explanations and fixes.
- `git` — used to commit and push fixes.

## Security Notes

No web server or stored credentials. GitHub access and authentication go through `gh`; model requests go through the configured provider CLI. See [docs/SECURITY.md](SECURITY.md) for reporting vulnerabilities.
