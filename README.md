# pickup

<img src="assets/logo.png" alt="pickup mascot" width="120" />

Watch GitHub PR review comments for `@pickup` mentions and reply with an explanation or a generated fix.

## Before you start

You need:

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated.
- The `claude` command in your PATH.
- A clean git working tree.

## Install

```bash
npm install -g pickup
```

If you are building from source, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Usage

```bash
pickup watch <pr-url-or-shorthand> [options]
```

`<pr-url-or-shorthand>` can be a full URL (`https://github.com/owner/repo/pull/4`) or a shorthand (`owner/repo/pull/4`).

- `--interval <seconds>` — seconds between polls. Default is `60`.
- `--fix` — try to generate, commit, and push a fix. The review comment must also contain the tag `#fix`.
- `--prompt <text>` — prepend custom instructions to the LLM prompt.
- `--dry-run` — preview the reply or fix on stdout without posting to GitHub or committing/pushing.
- `--json` — when used with `--dry-run`, output the preview as JSON.
- `--user <login>` — only reply to comments from this GitHub user.

State (seen comment IDs) is stored in `$XDG_CONFIG_HOME/pickup/state.json`.

## Example

```bash
pickup watch owner/repo/pull/4
pickup watch owner/repo/pull/4 --fix --user myorg-bot
```

## Notes

- Each poll handles the newest unseen `@pickup` mention; the rest wait for the next poll.
- `gh pr checkout` needs a clean working tree, so commit or stash your own changes first.
- `--dry-run` still runs `gh pr checkout` and may change the working tree; it only skips posting replies and committing/pushing fixes.
- If a fix is committed but `git push` fails, the commit stays local. Push it yourself once the problem is fixed.

## TBD

- **Pick your provider**: the `claude` command is hard-coded. Make it pluggable so you can use Cursor, Copilot, Devin, or any other CLI.
- **Stream mode**: run `pickup` as a long-lived watcher that processes comments as they arrive, not only on a poll interval.
- **Agent stream skill**: a skill or guide that teaches an agent to run `pickup` in stream mode and handle comments as they come in.
- **Degit integration**: keep a fast, minimal copy of the target repo in the CLI config folder so agents have code context without a full clone.
- **Observability logs**: write structured logs so it is clear what `pickup` is polling, replying to, and fixing.
- **General PR comments**: right now only review comments on diff lines are handled; conversation comments should be supported too.
- **Listen to repo and org changes**: watch for relevant activity across a repository or organization instead of polling a single PR.
- **`pickup init`**: one-time interactive setup that writes provider, model, and default flags to config.
- **Model selection**: choose which model a provider uses instead of taking the CLI's default.
- **Per-project profiles**: store different provider, model, and default flags per repo in a local or global config.
- **Custom prompts**: override reply style via `--prompt <text>` flag (per-repo config files TBD).
- **Watch multiple PRs**: target a list of PRs, or all open PRs in a repo or org, in one command.

## More docs

- [Contributing](docs/CONTRIBUTING.md) — build, test, and submit changes.
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common runtime issues.
- [Security](docs/SECURITY.md) — how to report vulnerabilities.
- [Changelog](docs/CHANGELOG.md) — what changed.
- [Architecture](docs/ARCHITECTURE.md) — how the code is organized.
- [AGENTS.md](AGENTS.md) — setup and commands for coding agents.

## License

[MIT](LICENSE.md)
