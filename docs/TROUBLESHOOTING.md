# Troubleshooting

Common issues when running `crewmate`.

## `crewmate: command not found`

Install the CLI globally:

```bash
npm install -g crewmate
```

If you built from source, make sure `dist/` exists after `nub run build` and run `node dist/bin.js`.

## `gh` is not installed or not logged in

`crewmate` uses the GitHub CLI. Install it and run:

```bash
gh auth login
```

## `claude` is not installed

`crewmate` calls the `claude` command by default to generate explanations and fixes. Install the Claude CLI and make sure it is in your PATH, or use a different provider:

```bash
crewmate watch owner/repo/pull/4 --provider my-llm
```

The provider must be a `claude`-shaped CLI that supports `--version`, `--model`, and `-p`.

## `gh pr checkout` fails

`crewmate` checks out the PR branch before reading a file. It needs a clean working tree. Commit or stash your own changes first.

## `--dry-run` changed my working tree

For single-PR targets, `--dry-run` still runs `gh pr checkout` so it can read the file. It only skips posting replies and committing/pushing. Commit or stash your own changes before running it, or use `crewmate stream` to preview mentions without touching the repo.

## `git push` failed after a fix

`crewmate` commits the fix locally and tries to push it. If the push fails, the commit stays local. Push it manually when the problem is fixed.

## `@crewmate` mention is ignored

`crewmate` handles PR review comments, top-level PR conversation comments, issue bodies, and top-level issue comments that contain `@crewmate`. It ignores replies, its own prefixed responses, previously seen mentions, and users excluded by `--user` or config. Each poll processes every unseen mention, newest first.

## The same conversation or issue mention was answered twice

PR conversation comments and issue bodies/comments do not expose a stable parent id for crewmate's reply. If you delete or reset `<config>/crewmate/state.json`, crewmate may answer them again. Review comments are not affected because crewmate can match replies to their parent.

## Fix was not applied

The PR review or conversation comment must contain both `@crewmate` and the tag `#fix` (case-insensitive) for `--fix` to run. Fixes are disabled for issue, repo, and org targets. If a changed file is unavailable or the configured provider returns no change, `crewmate` replies with the reason.

## Still stuck?

Open an [issue](https://github.com/YogliB/crewmate/issues) or check [CONTRIBUTING.md](CONTRIBUTING.md) for build and development problems.
