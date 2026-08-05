# Plan: Add `pickup stream` subcommand and remove `--json`

**Shape:** One repo, one PR.

## Goal

Add `pickup stream` as a new subcommand that emits new `@pickup` mentions as NDJSON to stdout without invoking the provider or posting replies. Refactor the poll loop into a shared `pollMentions` helper used by both `watch` and `stream`. Remove the dry-run-only `--json` flag to simplify the CLI surface.

## Files

`src/index.ts`
`src/fix.ts`
`src/config.ts`
`src/index.test.ts`
`src/config.test.ts`
`assets/help.md`
`README.md`
`docs/ARCHITECTURE.md`
`docs/CHANGELOG.md`
`assets/config.schema.json`

## Context

`pickup` has `watch` and `init`. `watch` currently polls via `pollIteration`, which calls `respondToMention` → `dispatchMention` and may invoke a provider and `gh pr checkout`. `fetchMentions` and `findNewMentions` are local helpers in `src/index.ts`.

`Mention` shape from `src/fix.ts`:

```ts
export type Mention =
	| (MentionBase & { kind: "conversation" })
	| (MentionBase & { kind: "review"; path: string; line: number });
```

`getLogin` extracts `user?.login`. State is a map of PR URLs to `kind:id` strings. The logger writes NDJSON to `pickup.log` and optionally mirrors to stderr.

`Profile` currently includes `json?: boolean` and `dryRun?: boolean`. `--json` only works with `--dry-run`:

```ts
if (ctx.dryRun) {
	if (ctx.json) {
		process.stdout.write(JSON.stringify(json) + "\n");
	} else {
		process.stdout.write(`[dry-run] would ...`);
	}
}
```

The poll loop in `watch`:

```ts
const iterations = options.iterations ?? (dryRun ? 1 : Infinity);
for (let index = 0; index < iterations; index += 1) {
  await pollIteration(normalizedPrUrl, runner, { ... });
}
```

`findNewMentions` filters for comments with `inReplyToId === undefined`. The current `pollIteration` seeds fresh state with `pickupRepliedIds` to avoid re-emitting already-answered review comments.

`VALUE_FLAGS` in `src/index.ts` makes `--provider`, `--model`, `--prompt`, `--user`, `--interval` value-form flags. `runStream` must also check the `values` map when warning about unsupported flags.

`run` passes `options.config`, `options.runner`, `options.logger`, and `options.iterations` to subcommands.

Verification: `nub run build`, `typecheck`, `test:ci`, `lint:ci`, `format:ci`, `duplicates:ci`, `knip:ci`.

## Scope

- **In Scope:**
  - Add `pickup stream <pr-url-or-shorthand> [options]`.
  - `stream` emits one NDJSON line per new `@pickup` mention to stdout, saves state, and does nothing else.
  - Extract a shared `pollMentions` helper used by `watch` and `stream`.
  - `stream` supports `--interval`, `--user`, `--log`, and `--help`.
  - Remove the `--json` flag, `Profile.json`, and JSON dry-run output branches.
  - Update docs, schema, and tests.
- **Out of Scope:**
  - Agent skill guide as a new `.agents/skills/...` file.
  - True push/webhook streaming.
  - Log file format changes.

## Risks

- **`pollMentions` refactor could change `watch` behavior.** Mitigation: keep existing `watch` tests passing; add new `stream` tests.
- **Removing `--json` is a breaking change.** Mitigation: project is unreleased; document in `docs/CHANGELOG.md` and `README.md`.
- **`stream` NDJSON becomes an API contract.** Mitigation: keep shape minimal with an `event` field.
- **State corruption may cause re-emission.** Mitigation: reuse existing `loadState` corrupt reset.
- **Event loss vs. duplication trade-off.** Mitigation: `stream` saves state _after_ writing stdout; agents can deduplicate by `commentId`.

## Dependencies

- None beyond existing `gh`, `git`, and repo tooling.

## Priority

High (directly requested).

## Logging / Observability

- `stream` logs `poll` and `mention` to `pickup.log` and stderr when `--log` is set.
- `stream` writes NDJSON to stdout; this is command output, not a log event.

## Branch setup

- [ ] `git checkout main` then `git pull`
- [ ] `git checkout -b yogev/pickup-stream`

## Implementation Plan (TODOs)

- [ ] **Step 1: Add `stream` subcommand entry point**
  - [ ] Add `stream` to `run` dispatch in `src/index.ts`.
  - [ ] Add `runStream` parsing `prUrl`, `--interval`, `--user`, `--log`, accepting `options.config`, `options.runner`, `options.logger`, `options.iterations`; error on missing `prUrl`; warn on unsupported flags (`--fix`, `--model`, `--provider`, `--prompt`, `--dry-run`, `--json`) by checking both booleans and values maps.
  - [ ] Export `stream` from `run` for tests.
- [ ] **Step 2: Extract shared `pollMentions` helper**
  - [ ] Define `pollMentions(prUrl, { runner, iterations, interval, allowedUser, logger, warn, onMention, dryRun, saveAfterEmit })` in `src/index.ts`.
  - [ ] Implement: load state, `fetchMentions`, seed `pickupRepliedIds` on fresh state, `findNewMentions`, call `onMention`, save state before `onMention` when `!saveAfterEmit` / after `onMention` when `saveAfterEmit`, sleep.
  - [ ] Refactor `watch` to use `pollMentions` with `onMention` that calls `respondToMention`; `saveAfterEmit` defaults to `false` so `watch` keeps its existing save-before-reply behavior.
- [ ] **Step 3: Implement `stream` polling**
  - [ ] Add `stream` command setup: `gh --version`, `gh auth status --hostname <host>`, optional `git rev-parse --show-toplevel`.
  - [ ] Update `resolveProfile` to accept optional `repoRoot`; skip repo config when undefined.
  - [ ] Call `pollMentions` with `saveAfterEmit: true` and `onMention` that writes NDJSON to stdout:
    ```json
    {
    	"at": "<ISO-8601>",
    	"event": "mention",
    	"owner": "...",
    	"repo": "...",
    	"number": 123,
    	"commentId": 456,
    	"kind": "review",
    	"user": "alice",
    	"body": "...",
    	"path": "...",
    	"line": 42,
    	"url": "..."
    }
    ```
    `number` is `Number(number)`; `path`/`line` only for `kind === "review"`; `inReplyToId` is omitted because `findNewMentions` already filters those out.
  - [ ] Ensure `stream` never invokes a provider, `gh pr checkout`, or `gh api POST`.
- [ ] **Step 4: Remove `--json`**
  - [ ] Remove `json` from `Profile` and `PROFILE_KEYS` in `src/config.ts`.
  - [ ] Remove `json` from `assets/config.schema.json`.
  - [ ] Remove `json` parsing in `runWatch` and `watch` options.
  - [ ] Remove `json` from `ReplyContext` and `respondToMention` in `src/index.ts`.
  - [ ] Remove `ctx.json` branches in `postReply` and `applyFix` dry-run in `src/fix.ts`.
- [ ] **Step 5: Update tests**
  - [ ] Add `src/index.test.ts` tests for `stream`: emits NDJSON per new mention, no provider call, no `gh api POST`, no `gh pr checkout`, saves state, respects `--user`, `run` passes `options.iterations` to `runStream`, defaults to `Infinity` iterations.
  - [ ] Remove or update existing `--json` tests in `src/index.test.ts`.
  - [ ] Update `src/config.test.ts` if it tests `json`.
- [ ] **Step 6: Update documentation**
  - [ ] Update `assets/help.md` for `pickup stream` and remove `--json`.
  - [ ] Update `README.md` for `pickup stream`, remove `--json`, update TBD (remove "Stream mode" bullet, keep "Agent stream skill").
  - [ ] Update `docs/ARCHITECTURE.md` to describe `stream` and remove the `--json` dry-run sentence.
  - [ ] Update `docs/CHANGELOG.md` with the breaking change and new command.

## Delivery

- [ ] Commit with a Conventional Commit message per `AGENTS.md`.
- [ ] Push only if repository policy requires a remote branch.

## Docs

- `assets/help.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/CHANGELOG.md`

## Testing

- New unit tests in `src/index.test.ts` for `stream`.
- Updated `src/index.test.ts` for `--json` removal.
- Updated `src/config.test.ts` if it tests `json`.
- `nub run test:ci`, `typecheck`, `lint:ci` pass.

## Verification

- [ ] `nub run build`
- [ ] `nub run typecheck`
- [ ] `nub run test:ci`
- [ ] `nub run lint:ci`
- [ ] `nub run format:ci`
- [ ] `nub run duplicates:ci`
- [ ] `nub run knip:ci`

## Acceptance

- [ ] `pickup stream owner/repo/pull/4` emits one NDJSON line per new `@pickup` mention.
- [ ] `pickup stream` does not invoke the provider, post replies, or run `gh pr checkout`.
- [ ] `pickup stream` saves state after stdout and does not re-emit seen mentions on a clean restart.
- [ ] `pickup stream` can run outside a git working tree (uses global config only).
- [ ] `pickup watch --dry-run` still prints a human-readable preview.
- [ ] `--json` is removed from CLI, help, README, schema, and config.

## References

- `AGENTS.md` for CI commands and commit conventions.
- `src/index.ts`, `src/fix.ts`, `src/config.ts`, `src/log.ts`, `src/state.ts` for existing behavior.
