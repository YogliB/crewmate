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

`pickup` calls the `claude` command to generate explanations and fixes. Install the Claude CLI and make sure it is in your PATH.

## `gh pr checkout` fails

`pickup` checks out the PR branch before reading a file. It needs a clean working tree. Commit or stash your own changes first.

## `git push` failed after a fix

`pickup` commits the fix locally and tries to push it. If the push fails, the commit stays local. Push it manually when the problem is fixed.

## `@pickup` mention is ignored

`pickup` only replies to review comments (not replies) that contain `@pickup` and were not written by `pickup` itself. The newest unseen mention is handled on each poll; older ones wait for the next poll.

## Fix was not applied

The review comment must contain both `@pickup` and `fix` (case-insensitive) for `--fix` to run. If the file is missing or `claude` returns no change, `pickup` replies with the reason.

## Still stuck?

Open an [issue](https://github.com/YogliB/pickup/issues) or check [CONTRIBUTING.md](CONTRIBUTING.md) for build and development problems.
