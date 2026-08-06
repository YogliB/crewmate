# pickup

<img src="assets/logo.png" alt="pickup mascot" width="120" />

Watch GitHub PR comments (review and conversation) for `@pickup` mentions and reply with an explanation or a generated fix.

## Before you start

You need:

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated.
- A `claude`-shaped CLI in your PATH (default is `claude`; use `--provider` to swap).
- A clean git working tree.

## Install

```bash
npm install -g pickup
```

If you are building from source, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Usage

```bash
pickup watch <target> [options]
pickup stream <target> [options]
pickup init
```

`<target>` can be:

- A single PR: `https://github.com/owner/repo/pull/4` or `owner/repo/pull/4`.
- A repository: `https://github.com/owner/repo` or `owner/repo`.
- An organization: `https://github.com/orgs/myorg` or `org:myorg`.
- A GHES instance: use a full URL (`https://ghe.example.com/owner/repo`).

`pickup init` is an interactive one-time setup that writes `provider`, `model`, `interval`, `user`, `prompt`, and `fix` defaults to `<config>/pickup/config.json`.

### `pickup watch`

- `--interval <seconds>` — seconds between polls. Default is `60`.
- `--fix` — try to generate, commit, and push a fix. The review comment must also contain the tag `#fix`.
- `--model <model>` — use a specific model for explanations and fixes.
- `--provider <command>` — use a specific provider CLI instead of `claude`.
- `--prompt <text>` — prepend custom instructions to the LLM prompt.
- `--log` — mirror structured log lines to stderr as well as writing them to the log file.
- `--dry-run` — preview the reply or fix on stdout without posting to GitHub or committing/pushing. Dry-run defaults to one iteration.
- `--user <login>` — only reply to comments from this GitHub user.

`--fix` only works for single-PR targets. It is disabled for repo or org scope.

### `pickup stream`

Emit new `@pickup` mentions as NDJSON to stdout without invoking a provider or posting replies. Use this to feed an agent or another pipeline.

- `--interval <seconds>` — seconds between polls. Default is `60`.
- `--log` — mirror structured log lines to stderr as well as writing them to the log file.
- `--user <login>` — only emit mentions from this GitHub user.

`pickup stream` can run outside a git working tree and uses only the global config. The `<target>` can be a single PR, a repo, an org, or a GHES full URL. Each emitted line is a JSON object with `at`, `event`, `owner`, `repo`, `number`, `commentId`, `kind`, `user`, `body`, `url`, and `path`/`line` for review comments.

State (seen comment IDs) is stored in `<config>/pickup/state.json` and logs in `<config>/pickup/pickup.log`, where `<config>` is `$XDG_CONFIG_HOME`, `$HOME/.config` (or `%USERPROFILE%/.config` on Windows), or the current working directory if none of those are set.
Structured logs are appended on a best-effort basis; the file is not rotated or truncated. Use `--log` to also mirror each log line to stderr.

## Configuration

Set defaults and per-repo overrides in two JSON files.

- Global config: `<config>/pickup/config.json` — global `defaults` plus `profiles` keyed by `owner/repo`.
- Per-repo config: `.pickup.json` in the repository root.

Precedence, strongest first:

1. CLI flags.
2. Per-repo `.pickup.json`.
3. Global config (defaults are merged first, then the matching `profiles["owner/repo"]` overrides any overlapping fields).

Both files use the same profile keys: `provider`, `model`, `interval`, `user`, `prompt`, `fix`, `dryRun`, and `log`. Unknown keys are ignored. Invalid types for known keys are warned and ignored. In the global file, the `profiles` map keys (owner/repo) are matched case-insensitively. See `assets/config.schema.json` for the full schema; point your IDE at it for validation and autocomplete.

Example `.pickup.json`:

```json
{
	"$schema": "https://raw.githubusercontent.com/YogliB/pickup/main/assets/config.schema.json",
	"provider": "my-llm",
	"prompt": "Be terse"
}
```

Example global `config.json`:

```json
{
	"$schema": "https://raw.githubusercontent.com/YogliB/pickup/main/assets/config.schema.json",
	"defaults": { "interval": 120 },
	"profiles": { "myorg/myrepo": { "provider": "my-llm" } }
}
```

## Log events

Each line in `pickup.log` is an NDJSON object with an `at` ISO-8601 timestamp and an `event` field. Events include:

- `poll` — started a poll iteration.
- `mention` — found a new `@pickup` mention.
- `reply` — posted or would post a comment reply (`kind: explain|fix|error|nochange`, `failed` on errors).
- `fix` — wrote or would write a file fix (`sha` when committed).
- `warning` — a recoverable problem such as an empty provider response or corrupted state file.
- `error` — an unhandled failure that stops the watch loop (`errorType`, `message`, `stack`).
- `info` — a notice such as dry-run mode.

Additional fields vary by event (e.g., `owner`, `repo`, `number`, `commentId`, `url`, `path`).

## Example

```bash
pickup watch owner/repo/pull/4
pickup watch owner/repo/pull/4 --fix --user myorg-bot
```

## Notes

- Each poll processes every new unseen `@pickup` mention; additional polls handle comments added after the current poll.
- `gh pr checkout` needs a clean working tree, so commit or stash your own changes first.
- `--dry-run` still runs `gh pr checkout` and may change the working tree; it only skips posting replies and committing/pushing fixes.
- If a fix is committed but `git push` fails, the commit stays local. Push it yourself once the problem is fixed.
- `--provider` expects a `claude`-shaped CLI (`--version`, `--model`, `-p`). Wrap other tools in a shim.
- General PR conversation comments are handled in addition to diff-level review comments. Conversation replies are not threaded, do not support `#fix`, and cannot be linked to their original mention on a fresh install (missing parent id), so they may be reprocessed if state is lost.

## TBD

- **Degit integration**: keep a fast, minimal copy of the target repo in the CLI config folder so agents have code context without a full clone.
- **Listen to issues alongside PR mentions**: respond to `@pickup` mentions in issue bodies and comments, not just pull request review threads.
- **Allow `#fix` from general PR conversation comments**: support generating and applying fixes from top-level PR comments, not only from diff-level review comments.
- **Init-time model selection**: when running `pickup init`, query the configured provider for its available models and let the user select one.

## More docs

- [Contributing](docs/CONTRIBUTING.md) — build, test, and submit changes.
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common runtime issues.
- [Security](docs/SECURITY.md) — how to report vulnerabilities.
- [Changelog](docs/CHANGELOG.md) — what changed.
- [Architecture](docs/ARCHITECTURE.md) — how the code is organized.
- [AGENTS.md](AGENTS.md) — setup and commands for coding agents.

## License

[MIT](LICENSE.md)
