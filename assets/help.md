# crewmate

A CLI that watches GitHub PR comments (review and conversation) for `@crewmate` mentions and replies with explanations or generated fixes.

## Commands

### `crewmate watch <target> [options]`

`<target>` can be:

- A single PR: `https://github.com/owner/repo/pull/4` or `owner/repo/pull/4`.
- A repository: `https://github.com/owner/repo` or `owner/repo`.
- An organization: `https://github.com/orgs/myorg` or `org:myorg`.
- For GHES, use a full URL for the host (`https://ghe.example.com/owner/repo`).

#### Options

- `--interval <seconds>` Seconds between polls (default: 60)
- `--fix` Attempt to apply a generated fix and push a commit. The review comment body must also contain the tag `#fix` (case-insensitive).
- `--model <model>` Use a specific model for explanations and fixes.
- `--provider <command>` Use a specific provider CLI instead of the default `claude`.
- `--prompt <text>` Prepend custom instructions to the LLM prompt.
- `--log` Also mirror structured log lines to stderr.
- `--dry-run` Preview the reply or fix on stdout without posting to GitHub or committing/pushing. Defaults to one iteration.
- `--user <login>` Only respond to comments from this GitHub login (defaults to the active `gh` user when omitted and not set in config)
- `--debug` Emit extra poll pipeline detail (fetched comments, mention-filter results, new mentions) to the log.

`--fix` is only supported for single-PR targets. It is disabled for repo or org scope.

### `crewmate stream <target> [options]`

Emit new `@crewmate` mentions as NDJSON to stdout without invoking the provider or posting replies. Use this to feed an agent or another pipeline.

`<target>` can be a single PR, a repo, an org, or a GHES full URL, the same as for `watch`.

#### Options

- `--interval <seconds>` Seconds between polls (default: 60)
- `--log` Also mirror structured log lines to stderr.
- `--user <login>` Only emit mentions from this GitHub login (defaults to the active `gh` user when omitted and not set in config)
- `--debug` Emit extra poll pipeline detail (fetched comments, mention-filter results, new mentions) to the log.

Each emitted line is a JSON object with `at`, `event`, `owner`, `repo`, `number`, `commentId`, `kind`, `user`, `body`, `url`, and for review comments `path` and `line`. State is saved after the line is written, so a restart re-fetches but does not re-emit already seen mentions.

### `crewmate init`

Interactive one-time setup that prompts for `provider`, `model`, `interval`, `user`, `prompt`, and `fix` defaults, then writes them to `$XDG_CONFIG_HOME/crewmate/config.json`.

## Configuration

Configuration is read from:

- `$XDG_CONFIG_HOME/crewmate/config.json` for global defaults and per-repo profiles.
- `.crewmate.json` in the repository root for per-repo overrides.

CLI flags win, then per-repo `.crewmate.json`, then the global config. In the global file, `profiles["owner/repo"]` takes precedence over `defaults`.

`.crewmate.json` is consulted when `crewmate watch` or `crewmate stream` is run on a single PR inside that repository's working tree. `crewmate watch` in `repo` or `org` scope runs outside the target repository and uses only the global config.

State is persisted in `$XDG_CONFIG_HOME/crewmate/state.json`.
Structured logs are always appended to `$XDG_CONFIG_HOME/crewmate/crewmate.log`; use `--log` to also mirror them to stderr.
Log events include `poll`, `mention`, `reply`, `fix`, `warning`, `error`, `info`, and `debug`; see the README for the full schema.

## Caveats

- The default LLM provider is `claude`. Set a different one with `--provider <command>` or in your config; it must be a `claude`-shaped CLI (`--version`, `--model`, `-p`).
- `--fix` only works for single-PR review comments and the comment body must contain the tag `#fix`.
- Repo and org scope discover open PRs with the GitHub search API; large scopes may hit rate limits. Use a longer `--interval` for big organizations.
- `--fix` is disabled for repo and org scope; only single-PR mode can generate and push fixes.
- Scope mode fetches file content from the GitHub API, so it does not need a local clone.
- Each poll processes every new unseen `@crewmate` mention; additional polls handle comments added after the current poll.
- For single-PR targets, run from a clean repository; `gh pr checkout` will fail if the working tree has uncommitted changes.
- For single-PR targets, `--dry-run` still runs `gh pr checkout`; it only skips posting replies and committing/pushing fixes.
- If `git push` fails after a fix is committed, the commit remains local and must be pushed manually.
- `--provider` expects a CLI with the same flags as `claude` (`--version`, `--model`, `-p`).
- General PR conversation comments are handled too. Conversation replies are not threaded, do not support `#fix`, and cannot be matched to their original mention on a fresh install, so they may be reprocessed if state is lost.
