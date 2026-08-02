# pickup

A CLI that watches GitHub PR review comments for `@pickup` mentions and replies with explanations or generated fixes.

## Usage

`pickup watch <pr-url-or-shorthand> [options]`

`<pr-url-or-shorthand>` can be a full URL (`https://github.com/owner/repo/pull/4`) or a shorthand (`owner/repo/pull/4`).

## Options

- `--interval <seconds>` Seconds between polls (default: 60)
- `--fix` Attempt to apply a generated fix and push a commit. The review comment body must also contain the tag `#fix` (case-insensitive).
- `--dry-run` Preview the reply or fix on stdout without posting to GitHub or committing/pushing.
- `--json` When used with `--dry-run`, output the preview as JSON.
- `--user <login>` Only respond to comments from this GitHub login

State is persisted in `$XDG_CONFIG_HOME/pickup/state.json`.

## Caveats

- Each poll processes every new unseen `@pickup` mention; additional polls handle comments added after the current poll.
- Run from a clean repository; `gh pr checkout` will fail if the working tree has uncommitted changes.
- `--dry-run` still runs `gh pr checkout`; it only skips posting replies and committing/pushing fixes.
- If `git push` fails after a fix is committed, the commit remains local and must be pushed manually.
