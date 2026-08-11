# crewmate changelog

## Unreleased

- Render `--help` output with ANSI terminal styles instead of raw Markdown.
- `--user` defaults to the authenticated `gh` login when omitted.
- Add `--debug` flag and `debug` config key for poll pipeline diagnostics.
- Add an `eyes` acknowledgement reaction to each new `@crewmate` mention and swap it for `+1`, `rocket`, or `-1` before posting the reply.

## 0.0.1

- Initial release of `crewmate`: `crewmate watch` and `crewmate stream` monitor a single PR, a repo, or an org (including GHES) for `@crewmate` mentions and reply with explanations or generated fixes.
