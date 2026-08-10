# Troubleshooting

Common issues when running `pickup`.

## `pickup: command not found`

Install the CLI globally:

```bash
npm install -g pickup
```

If you built from source, make sure `dist/` exists after `nub run build` and run `node dist/bin.js`.

## `gh` is not installed or not logged in

`pickup` uses the GitHub CLI. Install it and run:

```bash
gh auth login
```

## `claude` is not installed

`pickup` calls the `claude` command by default to generate explanations and fixes. Install the Claude CLI and make sure it is in your PATH, or use a different provider:

```bash
pickup watch owner/repo/pull/4 --provider my-llm
```

The provider must be a `claude`-shaped CLI that supports `--version`, `--model`, and `-p`.

## `gh pr checkout` fails

`pickup` checks out the PR branch before reading a file. It needs a clean working tree. Commit or stash your own changes first.

## `--dry-run` changed my working tree

For single-PR targets, `--dry-run` still runs `gh pr checkout` so it can read the file. It only skips posting replies and committing/pushing. Commit or stash your own changes before running it, or use `pickup stream` to preview mentions without touching the repo.

## `git push` failed after a fix

`pickup` commits the fix locally and tries to push it. If the push fails, the commit stays local. Push it manually when the problem is fixed.

## `@pickup` mention is ignored

`pickup` only replies to review comments (not replies) that contain `@pickup` and were not written by `pickup` itself. The newest unseen mention is handled on each poll; older ones wait for the next poll.

## The same conversation comment was answered twice

General PR conversation comments do not expose a stable parent id. If you delete or reset `<config>/pickup/state.json`, `pickup` cannot tell that a conversation comment was already answered, so it may reply again. Review comments are not affected because `pickup` can match replies to their parent.

## Fix was not applied

The review comment must contain both `@pickup` and the tag `#fix` (case-insensitive) for `--fix` to run. If the file is missing or `claude` returns no change, `pickup` replies with the reason.

## Still stuck?

Open an [issue](https://github.com/YogliB/pickup/issues) or check [CONTRIBUTING.md](CONTRIBUTING.md) for build and development problems.
