# crewmate changelog

## [Unreleased]

## [0.7.0]

- Add `--closed` to include closed PRs and issues in repository scope. Passing a specific PR or issue URL works regardless of state.
- Remove the built-in fix machinery: the `--fix` flag, `#fix` tag handling, `fix`/`nochange` reply kinds, and the `fix` log event. `crewmate` replies with explanations only; pair `crewmate stream` with an agent to apply changes.
- Remove `crewmate init`.
- Remove organization scope targets (`org:<name>` and org URLs).
- Remove per-repo `.crewmate.json` and global `defaults`/`profiles`. Config is now a single flat `<config>/crewmate/config.json`; removed keys (`fix`, `dryRun`, `defaults`, `profiles`) are warned about and ignored.
- Add job-based state with `pending`/`running`/`succeeded`/`failed` statuses, retries with exponential backoff (up to 3 attempts), and an error reply posted after the final attempt.
- Write state atomically and prune each target to at most 500 tracked mentions. State files from 0.6.0 are migrated on load.
- Add a per-config-directory lock so only one `watch`/`stream` process runs at a time.
- Add `--timeout` / `timeoutSeconds` to kill provider calls that run too long (default 600 seconds).
- Rotate `crewmate.log` to `crewmate.log.1` when it exceeds 1 MB.
- `crewmate watch` no longer runs `gh pr checkout`, `git commit`, or `git push`; PR file contents are read through the GitHub API, so a clean working tree is no longer required.

## [0.6.0]

- Add `crewmate stream --since <ISO-timestamp>` to skip older mentions.
- Improve `crewmate stream` docs for agent/IDE use, including `npx --yes`, `--output-file`, `tail -n 0 -f`, and a response-loop example.

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

[Unreleased]: https://github.com/YogliB/crewmate/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/YogliB/crewmate/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/YogliB/crewmate/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/YogliB/crewmate/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/YogliB/crewmate/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/YogliB/crewmate/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/YogliB/crewmate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/YogliB/crewmate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YogliB/crewmate/releases/tag/v0.1.0
[0.0.1]: https://www.npmjs.com/package/crewmate/v/0.0.1
