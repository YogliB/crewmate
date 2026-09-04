# crewmate changelog

## [Unreleased]

## [0.5.0]

- Fix `crewmate stream` stdout buffering in non-TTY and piped environments by awaiting each NDJSON line's write callback.
- Add `--output-file <path>` to `crewmate stream` for durable event persistence.
- Treat stdout consumer `EPIPE` as a clean exit while keeping output-file and repo/org sink failures fatal.

## [0.4.0]

- Split agent skills into `crewmate` (the agent-in-charge handler) and `crewmate-stream` (the CLI pump).
- Add `--ack` to `crewmate stream` to post an `eyes` reaction and emit the returned `reactionId` in the NDJSON event.

## [0.3.1]

- `crewmate stream` warns about unsupported flags before resolving the default target.
- Review comment replies now use the prompt in `assets/SYSTEM_PROMPT.md`; the default content is `Follow the review.`
- Fix `toSafePath` to handle symlinked repository roots (e.g., macOS `/var/folders` → `/private/var/folders`).

## [0.3.0]

- Add GitHub issue support with `issue` and `conversation` mention kinds.
- Add `--unsafe-no-user` / `unsafeNoUser` to skip the user filter.

## [0.2.0]

- `crewmate watch` and `crewmate stream` now default to the current GitHub repository when run inside a git working tree with a GitHub `origin` remote.

## [0.1.0]

- `crewmate watch --dry-run` now polls continuously instead of exiting after one iteration.
- Render `--help` output with ANSI terminal styles instead of raw Markdown.
- `--user` defaults to the authenticated `gh` login when omitted.
- Add `--debug` flag and `debug` config key for poll pipeline diagnostics.
- Add an `eyes` reaction to each new mention and swap it to `+1`, `rocket`, or `-1` before the reply.

## [0.0.1]

- Initial release of `crewmate`: `crewmate watch` and `crewmate stream` monitor a single PR, a repo, or an org (including GHES) for `@crewmate` mentions and reply with explanations or generated fixes.

[Unreleased]: https://github.com/YogliB/crewmate/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/YogliB/crewmate/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/YogliB/crewmate/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/YogliB/crewmate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/YogliB/crewmate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/YogliB/crewmate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YogliB/crewmate/releases/tag/v0.1.0
[0.0.1]: https://www.npmjs.com/package/crewmate/v/0.0.1
