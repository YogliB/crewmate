# crewmate changelog

## 0.1.0

- `crewmate watch --dry-run` now polls continuously instead of exiting after one iteration.
- Render `--help` output with ANSI terminal styles instead of raw Markdown.
- `--user` defaults to the authenticated `gh` login when omitted.
- Add `--debug` flag and `debug` config key for poll pipeline diagnostics.
- Add an `eyes` reaction to each new mention and swap it to `+1`, `rocket`, or `-1` before the reply.

## 0.0.1

- Initial release of `crewmate`: `crewmate watch` and `crewmate stream` monitor a single PR, a repo, or an org (including GHES) for `@crewmate` mentions and reply with explanations or generated fixes.
