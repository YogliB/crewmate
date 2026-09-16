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

`crewmate` calls the `claude` command by default to generate explanations. Install the Claude CLI and make sure it is in your PATH, or use a different provider:

```bash
crewmate watch owner/repo/pull/4 --provider my-llm
```

The provider must be a `claude`-shaped CLI that supports `--version`, `--model`, and `-p`.

## A provider call seems stuck

`crewmate` kills a provider call that exceeds `--timeout` seconds (default 600) and retries it with backoff. Lower the timeout or investigate the provider itself.

## Another `crewmate` process is already running

`watch` and `stream` take a lock at `<config>/crewmate/lock`. If a previous run crashed, the stale lock is reclaimed automatically; otherwise stop the other process or use a different config directory (`XDG_CONFIG_HOME`).

## `@crewmate` mention is ignored

`crewmate` only replies to comments that contain `@crewmate`, were not written by `crewmate` itself, and (by default) were written by the active `gh` user. Use `--user <login>` or `--unsafe-no-user` to widen the filter, and `--debug` to see why a mention was filtered.

## The same conversation comment was answered twice

General PR conversation comments do not expose a stable parent id. If you delete or reset `<config>/crewmate/state.json`, `crewmate` cannot tell that a conversation comment was already answered, so it may reply again. Review comments are not affected because `crewmate` can match replies to their parent.

## Replies keep failing

A failed reply is retried up to 3 times with an exponential backoff starting at 60 seconds, then `crewmate` posts an error reply to the mention. Check the log for the underlying `gh` or provider error.

## Still stuck?

Open an [issue](https://github.com/YogliB/crewmate/issues) or check [CONTRIBUTING.md](CONTRIBUTING.md) for build and development problems.
