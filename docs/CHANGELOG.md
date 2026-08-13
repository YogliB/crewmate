# crewmate changelog

## Unreleased

- Add support for GitHub issues alongside PRs. `watch` and `stream` now accept single-issue targets, and repo and org discovery polls open issues in addition to open PRs. Issue bodies are a new `issue` mention kind; issue comments reuse the `conversation` kind. `#fix` remains disabled for issue and conversation comments.
- Add `--unsafe-no-user` CLI flag and `unsafeNoUser` config key to disable the default user filter. When user filtering is on, `watch` and `stream` require a user (explicit, configured, or authenticated) and will exit with an actionable error if none can be determined.

## 0.2.0

- `crewmate watch` and `crewmate stream` now default to the current GitHub repository when run inside a git working tree with a GitHub `origin` remote.

## 0.1.0

- `crewmate watch --dry-run` now polls continuously instead of exiting after one iteration.
- Render `--help` output with ANSI terminal styles instead of raw Markdown.
- `--user` defaults to the authenticated `gh` login when omitted.
- Add `--debug` flag and `debug` config key for poll pipeline diagnostics.
- Add an `eyes` reaction to each new mention and swap it to `+1`, `rocket`, or `-1` before the reply.

## 0.0.1

- Initial release of `crewmate`: `crewmate watch` and `crewmate stream` monitor a single PR, a repo, or an org (including GHES) for `@crewmate` mentions and reply with explanations or generated fixes.
