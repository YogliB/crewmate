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
- `--fix` — try to generate, commit, and push a fix. The review comment must also contain `fix`.
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
- If a fix is committed but `git push` fails, the commit stays local. Push it yourself once the problem is fixed.

## More docs

- [Contributing](docs/CONTRIBUTING.md) — build, test, and submit changes.
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common runtime issues.
- [Security](docs/SECURITY.md) — how to report vulnerabilities.
- [Changelog](docs/CHANGELOG.md) — what changed.
- [Architecture](docs/ARCHITECTURE.md) — how the code is organized.
- [AGENTS.md](AGENTS.md) — setup and commands for coding agents.

## License

[MIT](LICENSE.md)
