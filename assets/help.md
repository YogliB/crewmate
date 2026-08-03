# pickup

A CLI that watches GitHub PR review comments for `@pickup` mentions and replies with explanations or generated fixes.

## Usage

`pickup watch <pr-url-or-shorthand> [options]`

`<pr-url-or-shorthand>` can be a full URL (`https://github.com/owner/repo/pull/4`) or a shorthand (`owner/repo/pull/4`).

## Options

- `--interval <seconds>` Seconds between polls (default: 60)
- `--fix` Attempt to apply a generated fix and push a commit. The review comment body must also contain the tag `#fix` (case-insensitive).
- `--model <model>` Use a specific model for explanations and fixes.
- `--provider <command>` Use a specific provider CLI instead of `claude`.
- `--prompt <text>` Prepend custom instructions to the LLM prompt.
- `--log` Also mirror structured log lines to stderr.
- `--dry-run` Preview the reply or fix on stdout without posting to GitHub or committing/pushing. Defaults to one iteration.
- `--json` When used with `--dry-run`, output the preview as JSON. Without `--dry-run` it is ignored and a warning is logged.
- `--user <login>` Only respond to comments from this GitHub login

Configuration is read from:

- `$XDG_CONFIG_HOME/pickup/config.json` for global defaults and per-repo profiles.
- `.pickup.json` in the repository root for per-repo overrides.

CLI flags win, then per-repo `.pickup.json`, then the global config. In the global file, `profiles["owner/repo"]` takes precedence over `defaults`.

State is persisted in `$XDG_CONFIG_HOME/pickup/state.json`.
Structured logs are always appended to `$XDG_CONFIG_HOME/pickup/pickup.log`; use `--log` to also mirror them to stderr.
Log events include `poll`, `mention`, `reply`, `fix`, `warning`, `error`, and `info`; see the README for the full schema.

## Caveats

- Each poll processes every new unseen `@pickup` mention; additional polls handle comments added after the current poll.
- Run from a clean repository; `gh pr checkout` will fail if the working tree has uncommitted changes.
- `--dry-run` still runs `gh pr checkout`; it only skips posting replies and committing/pushing fixes.
- If `git push` fails after a fix is committed, the commit remains local and must be pushed manually.
- `--provider` expects a CLI with the same flags as `claude` (`--version`, `--model`, `-p`).
