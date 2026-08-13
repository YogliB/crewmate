# Monkey-testing crewmate with `devin` as the provider

This is a throwaway learning log from an end-to-end monkey-test of the `crewmate` CLI. It is intentionally not merged.

## What we did

1. Built `crewmate` from source (`nub run build`).
2. Created a local `devin` provider shim that mimics the real `devin` CLI (`--version`, `--model <m>`, `-p <prompt>`) so the sandbox would not need a live AI round-trip.
3. Opened an unmerged dummy PR (#66) and a throwaway issue (#67) against `YogliB/crewmate`.
4. Added `@crewmate` mentions:
   - a PR conversation comment,
   - two review comments on `assets/monkeytest.txt` (one for explanation, one with `#fix`).
5. Ran the CLI through `stream`, `watch --dry-run`, and full `watch` modes with multiple flag combinations.
6. Spawned parallel subagents for `stream` scopes, `watch` variations, edge cases, and the actual fix-pushing run.

## Key findings

### Provider interface

- The real `devin` CLI already speaks the same shape as `claude` for this purpose: `devin --version`, `devin --model <MODEL> -p <PROMPT>`.
- `crewmate` invokes the provider with `[--model <m>] -p <prompt>` and uses the stdout as the reply/fix.
- For `--fix`, `crewmate` strips any markdown fences around the returned content and writes the whole file.

### `watch` behavior

- `watch` polls forever. There is no `--once` / `--iterations` flag, so use a timeout or Ctrl-C.
- `--dry-run` still calls the provider and still runs `gh pr checkout`, but it does **not** save state. This means a long `--dry-run` will re-explain / re-fix the same comments every poll.
- On a real `watch --fix` run:
  - `crewmate` sets an `eyes` reaction first, then swaps it for `+1` (explain/conversation) or `rocket` (fix).
  - It replies with `⚓ crewmate: <response>`.
  - For `#fix` review comments, it writes the file, commits with `fix: address crewmate comment`, and pushes.
- `allowFix` is silently disabled for repo/org/issue scope; only single-PR `watch` can generate fixes.

### `stream` behavior

- `stream` emits one JSON object per new mention and writes state after each emit, so it does not re-emit the same mention.
- It does **not** call the provider or post replies; it is safe to run in a CI-like pipeline.
- Repo and org scope use the GitHub search API to find open PRs/issues; large scopes may hit rate limits.
- Org-scope search emits non-NDJSON warnings to stdout (e.g. `Search failed; verify the token can read private repos on this host`), so `stream` output is not always pure NDJSON.
- `runStream` resolves the default target **before** printing unsupported-flag warnings, so the warnings do not appear when `stream` is run outside a git repo without a target.

### Mention filtering

- By default, `crewmate` filters to the active `gh` user. `--user` overrides it; `--unsafe-no-user` disables it.
- If `--user` points to someone other than the current `gh` user, a warning is emitted.
- Review comments that are already replies from `crewmate` (`body.startsWith("⚓ crewmate:")` and `inReplyToId`) are tracked so the original mention is not reprocessed.
- Conversation and issue comments do **not** have a reliable parent id, so they can be reprocessed if state is lost (matches the README caveat).

### Config precedence

1. CLI flags.
2. `.crewmate.json` in the repository root (only consulted for single-PR `watch`/`stream` inside that repo).
3. Global `$XDG_CONFIG_HOME/crewmate/config.json` (`profiles[owner/repo]` overrides `defaults`).

### `init`

- `crewmate init` is strictly interactive (requires a TTY). It writes the global config with the answers.
- Empty answers for `model`, `interval`, `user`, `prompt` use defaults; empty for `fix` defaults to `false`; empty for `provider` defaults to `claude`.

### Target parsing and scope

- Supported targets:
  - PR: `owner/repo/pull/N` or full URL.
  - Issue: `owner/repo/issues/N` or full URL.
  - Repo: `owner/repo` or full URL.
  - Org: `org:myorg` or `https://github.com/orgs/myorg`.
- Running inside a git repo with a GitHub `origin` defaults to that repo.
- Single-PR `watch` for a non-existent PR fails with a 404 poll failure, not a "no open items" warning, because single PRs bypass `fetchOpenItems`.

### GitHub / git quirks

- Creating diff-level review comments via `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments` requires `position` (diff position, 1-indexed), not `line`/`subject_type`, at least with the schema exposed by `gh`/`gh api` for this repository.
- `gh pr checkout` requires a clean working tree; a dirty tree produces a clear error.
- The review comments remain attached to their original commit, while the pushed fix moves the PR head forward.

### Surprises / gotchas

- `--dry-run` not saving state means repeated dry runs are noisy; use a short timeout.
- The provider is called with `--version` during `watch` startup; a provider that fails here aborts the run before any polling.
- `watch --fix` pushes a commit to the PR branch; the PR head moves, but the review comments remain attached to their original commit.
- `crewmate` adds `⚓ crewmate:` to all replies, so the replies themselves do not re-trigger mentions (they lack `@crewmate`).
- A real `watch` run on an issue posts a comment on the issue and sets a `+1` reaction on the issue body.

## Successful commands

```bash
# build
nub run build

# stream a PR
XDG_CONFIG_HOME=/tmp/crewmate-monkeytest/config \
PATH=/tmp/devin-shim:$PATH \
  node dist/bin.js stream https://github.com/YogliB/crewmate/pull/66 --debug

# dry-run watch with fix
XDG_CONFIG_HOME=/tmp/crewmate-monkeytest/config \
PATH=/tmp/devin-shim:$PATH \
  node dist/bin.js watch https://github.com/YogliB/crewmate/pull/66 --dry-run --fix --debug --prompt "Be concise"

# real watch (posts replies and pushes a commit)
XDG_CONFIG_HOME=/tmp/crewmate-monkeytest/config \
PATH=/tmp/devin-shim:$PATH \
  node dist/bin.js watch https://github.com/YogliB/crewmate/pull/66 --fix --log

# real watch on an issue
XDG_CONFIG_HOME=/tmp/crewmate-monkeytest/config-issue \
PATH=/tmp/devin-shim:$PATH \
  node dist/bin.js watch https://github.com/YogliB/crewmate/issues/67 --log

# interactive setup
XDG_CONFIG_HOME=/tmp/crewmate-monkeytest/config node dist/bin.js init
```

## Artifacts left in the playground

- PR #66 — unmerged, now contains real crewmate replies, reactions, and a pushed fix commit.
- Issue #67 — opened for a single `watch` test and then closed.
