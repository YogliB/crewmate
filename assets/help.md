# pickup

A CLI that watches GitHub PR review comments for `@pickup` mentions and replies with explanations or generated fixes.

## Usage

`pickup watch <pr-url-or-shorthand> [options]`

`<pr-url-or-shorthand>` can be a full URL (`https://github.com/owner/repo/pull/4`) or a shorthand (`owner/repo/pull/4`).

## Options

- `--interval <seconds>` Seconds between polls (default: 60)
- `--fix` Attempt to apply a generated fix and push a commit. The review comment body must also contain the tag `#fix` (case-insensitive).
- `--user <login>` Only respond to comments from this GitHub login

State is persisted in `$XDG_CONFIG_HOME/pickup/state.json`.

## Caveats

- Each poll processes every new unseen `@pickup` mention; additional polls handle comments added after the current poll.
- Run from a clean repository; `gh pr checkout` will fail if the working tree has uncommitted changes.
- If `git push` fails after a fix is committed, the commit remains local and must be pushed manually.
