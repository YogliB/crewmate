# Plan: Repo and org scope for `pickup watch`/`stream`

**Shape:** One repo, one PR.

## Goal

Add repo (`owner/repo`) and org (`org:<org>`) scope support to `pickup watch` and `pickup stream`. Support private repos on github.com and public/private repos on GitHub Enterprise by passing the parsed host to `gh` CLI calls. For repo/org scope, explain reviews by fetching file content from the GitHub API; `--fix` is disabled.

## Files

`src/index.ts`
`src/fix.ts`
`assets/help.md`
`README.md`
`docs/ARCHITECTURE.md`
`docs/CHANGELOG.md`
`src/index.test.ts`

## Context

- `src/index.ts` `parsePrUrl` parses a single PR: full URL or `owner/repo/pull/N`, returns `{ host, owner, repo, number }`. `host` defaults to `github.com`.
- `fetchMentions` calls `gh api --paginate --slurp repos/{owner}/{repo}/pulls/{number}/comments` and `.../issues/{number}/comments`. It does **not** currently pass `--hostname`; Step 3 adds it.
- `src/fix.ts` `ReplyContext` is currently `{ ..., repoRoot: string, runner }`. `readPrFile` runs `gh pr checkout -R {owner}/{repo} {number}` then reads from `repoRoot`. `postReply` calls `gh api --method POST repos/{owner}/{repo}/...`. Neither currently passes `--hostname`.
- Scope target syntax:
  - Repo: `owner/repo` or `https://<host>/<owner>/<repo>`.
  - Org: `org:<org>` or `https://<host>/orgs/<org>`.
  - PR: `owner/repo/pull/N` or `https://<host>/<owner>/<repo>/pull/N`.
  - Shorthands default `host` to `github.com`. For GHES, use a full URL.
- Discovery uses `gh api --hostname <host> --paginate --slurp 'search/issues?q=<encoded>'` with query `repo:<owner>/<repo> is:pr is:open` or `org:<org> is:pr is:open`. Response is an array of page objects; each has `.items[].html_url`.
- Raw file content for scope-mode explanations uses `gh api --hostname <host> -H 'Accept: application/vnd.github.raw' 'repos/<owner>/<repo>/contents/<encoded-path>?ref=refs/pull/<number>/head'`. Path segments are `encodeURIComponent`ed individually; the `?ref=` value is not encoded.
- State is `Map<prUrl, commentId[]>` in `state.json` (existing). Scope targets are **not** state keys; each discovered PR URL gets its own state entry, exactly like single-PR mode.

## Scope

- **In scope:**
  - Parse repo/org/PR targets and distinguish them.
  - Discover open PRs via GitHub search API.
  - Update `watch` and `stream` to poll all discovered PRs.
  - Add `host` to `ReplyContext` and pass `--hostname` to `gh api`/`auth status`; update `gh pr checkout -R` to include host.
  - Make `repoRoot` optional; use GitHub raw content API when it is undefined.
  - Disable `--fix` for scope.
  - Update help, README, architecture, changelog, tests.
- **Out of scope:**
  - `--fix` for repo/org scope.
  - Per-repo `.pickup.json` for scope (use global config only when `repoRoot` is undefined).

## Risks

- **Rate limits:** Scope mode fetches comments for every open PR. For large repos/orgs, this can exhaust the token's quota. Mitigation: document that large scopes should use a longer `--interval` and that `stream` can be used for a read-only pipeline; keep default `60` seconds for small repos.
- **Private repos missing from search:** If the token lacks `repo` scope, search omits private repos or returns 403/422. Mitigation: document the token must have `repo` scope; in `fetchOpenPrs`, detect 403/422 and log a warning that says "Search failed; verify the token can read private repos on this host."
- **Raw content API fails:** `refs/pull/{n}/head` may not exist or the file may exceed API limits. Mitigation: catch `gh api` failure, call `postReply(ctx, MISSING_FILE_REPLY, "error")`, and return `{ content: "", found: false }`. The mention is still processed and saved to state.
- **Old GHES without `search/issues`:** `search/issues` requires GHES 3.x+. For older GHES, repo scope falls back to `gh api --hostname <host> repos/<owner>/<repo>/pulls?state=open` (returns an array of PR objects; use `html_url` on each). Org scope is not supported and throws a clear error.

## Dependencies

- `gh` CLI with `api`, `auth status`, `pr checkout`.
- Authenticated token with `repo` scope for private repos.
- GitHub Enterprise Server 3.x+ for `search/issues`; repo-scope fallback works on older versions, org scope does not.

## Priority

High.

## Logging / Observability

- `pollMentions` already logs `logger("poll", { url: prUrl })` once per PR; keep that.
- When `--fix` is requested with a scope, log `logger("warning", { reason: "scope-fix-disabled", message: "fix is not supported for repo/org scope targets; disabling", target: scope })` before any `gh` or git calls.
- In the `readPrFile` API fallback, on failure log `logger("warning", { reason: "file-content-api-failed", path: targetPath, error: errorMessage })`, then call `postReply(ctx, MISSING_FILE_REPLY, "error")` and return.

## Branch setup

- [ ] `git checkout main && git pull`
- [ ] `git checkout -b yogev/repo-org-scope`

## Implementation Plan (TODOs)

- [ ] **Step 1: Parse and normalize targets**
  - [ ] Define a `Scope` type in `src/index.ts` and export it: `{ kind: "pr" | "repo" | "org"; host: string; owner?: string; repo?: string; org?: string; number?: string }`.
  - [ ] Add `parseTarget(target: string): Scope` in `src/index.ts`. Supports:
    - `https://<host>/<owner>/<repo>/pull/<n>` -> `pr`
    - `https://<host>/<owner>/<repo>` -> `repo`
    - `https://<host>/orgs/<org>` -> `org`
    - `<owner>/<repo>/pull/<n>` -> `pr`
    - `<owner>/<repo>` -> `repo`
    - `org:<org>` -> `org`
    - Shorthands default `host` to `github.com`.
  - [ ] Throw `TypeError("Invalid target: ...")` for bare words, too many path segments, or unsupported URLs.
  - [ ] Add unit tests for `parseTarget`: full GHES repo URL, org full URL, `owner/repo` shorthand, `org:myorg`, `owner/repo/pull/123`, invalid bare word.
- [ ] **Step 2: Discover open PRs for a scope**
  - [ ] Add `fetchOpenPrs(scope, runner, warn)` in `src/index.ts`.
  - [ ] Build the search query, `encodeURIComponent` it, and call `gh api --hostname <host> --paginate --slurp 'search/issues?q=<query>'`.
  - [ ] Wrap the `gh` call in `try/catch`. On 403/422, log a token-scope warning and return `[]`. On other failures, log the error and return `[]`.
  - [ ] Parse the slurped response as `{ items: { html_url: string }[] }[]`; flatten and validate each `html_url` with `parsePrUrl`. Log the URL and error for any invalid item and drop it.
  - [ ] Add unit tests for `fetchOpenPrs` with repo and org queries, GHES `--hostname`, and empty/error results.
  - [ ] **2b. Fallback for older GHES repo scope:** If the search endpoint returns a "not found" style error and the scope is a repo, fall back to `gh api --hostname <host> --paginate --slurp repos/<owner>/<repo>/pulls?state=open` (each page is an array of PR objects with `html_url`). For org scope on older GHES, throw a clear `Error("org scope requires GHES 3.x+ search/issues")`.
- [ ] **Step 3: Thread `host` through `gh` calls**
  - [ ] **3a** Update `ReplyContext` in `src/fix.ts`: add `host: string` and make `repoRoot?: string`.
  - [ ] **3b** In `src/index.ts`, update `fetchMentions(prUrl, runner)` to parse `host` from `prUrl` via `parsePrUrl` and pass it to `fetchKind(owner, repo, number, kind, host, runner)`. `fetchKind` adds `--hostname <host>` to its `gh api` args.
  - [ ] **3c** Update `postReply` in `src/fix.ts` to pass `["--hostname", host, ...]` to `gh api --method POST` (endpoint path remains `repos/{owner}/{repo}/...`).
  - [ ] **3d** Update `readPrFile` in `src/fix.ts`:
    - Add `encodeContentPath(path: string): string` that splits by `/`, `encodeURIComponent`s each segment, and rejoins.
    - If `ctx.repoRoot` is undefined, fetch raw content via `gh api --hostname <host> -H 'Accept: application/vnd.github.raw' repos/<owner>/<repo>/contents/<encoded-path>?ref=refs/pull/<number>/head`; on failure call `postReply(ctx, MISSING_FILE_REPLY, "error")` and return `{ content: "", found: false }`.
    - For the local path, use `gh pr checkout -R <host>/<owner>/<repo> <number>` (`gh` accepts the `[HOST/]OWNER/REPO` form; `gh pr checkout` has no `--hostname` flag) and then read from `ctx.repoRoot`.
  - [ ] Add `host` to the `ReplyContext` built in `respondToMention` (`src/index.ts` around the existing ctx object).
- [ ] **Step 4: Update `watch` for scope**
  - [ ] **4a** In `watch`, call `parseTarget(prUrl)` first. Resolve `allowFix` from CLI flags and profile (`allowFix = options.allowFix ?? profile.fix ?? false`). If the target is a scope and `allowFix` is true, log the `scope-fix-disabled` warning and set `allowFix = false` before any `gh` or git calls.
  - [ ] **4b** Call `gh auth status --hostname <host>` and `gh --version`. For a single PR, keep the existing git working-tree requirement; for a scope, make the working tree optional. If `git rev-parse` fails for a scope, set `repoRoot = undefined` and use global config only.
  - [ ] **4c** For a scope, call `fetchOpenPrs` and then loop over `prUrls` calling `pollMentions` for each. For a single PR, call `pollMentions` as before. Pass `host` through to `respondToMention`.
- [ ] **Step 5: Update `stream` for scope**
  - [ ] Call `parseTarget(target)` and then `fetchOpenPrs`.
  - [ ] Loop over the discovered PR URLs and call `pollMentions` for each.
  - [ ] Keep `repoRoot` optional and `allowFix` false. Log `poll` once per PR.
- [ ] **Step 6: Update CLI entry points**
  - [ ] In `runWatch` and `runStream`, rename the first positional argument from `prUrl` to `target`; update error messages to "Target is required".
  - [ ] Ensure `--fix` remains disallowed for `stream`.
- [ ] **Step 7: Update documentation**
  - [ ] `assets/help.md`: document scope targets and the `--fix` limitation.
  - [ ] `README.md`: remove the "Listen to repo and org changes" and "Watch multiple PRs" TBD bullets; add a short note that scope mode does not support `--fix`.
  - [ ] `docs/ARCHITECTURE.md`: note that `watch`/`stream` can discover open PRs via `search/issues` before polling.
  - [ ] `docs/CHANGELOG.md`: add a breaking-change/new-feature entry for scope support and the `--fix` limitation.
- [ ] **Step 8: Add and update tests**
  - [ ] Update the mocked `gh` runner in `src/index.test.ts` to handle:
    - `search/issues` endpoint.
    - `--hostname` in `gh api`, `gh auth status`, and `gh pr checkout` args.
    - raw content API (`-H Accept: application/vnd.github.raw`, `repos/.../contents/...?ref=refs/pull/.../head`).
  - [ ] Add tests for `watch`/`stream` with repo and org scope, including GHES host in `gh` args.
  - [ ] Add tests for the raw content API fallback through `watch`/`stream` mocks (keep all tests in `src/index.test.ts` to match the existing pattern; no new `src/fix.test.ts`).
- [ ] **Step 9: Verification**
  - [ ] Run `nub run typecheck`.
  - [ ] Run `nub run lint:ci`.
  - [ ] Run `nub run format:ci`.
  - [ ] Run `nub run test:ci`.
  - [ ] Run `nub run build`.

## Delivery

- [ ] Commit with a Conventional Commit message (if policy allows).
- [ ] Push to remote (if policy requires).

## Docs

- `assets/help.md`
- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/CHANGELOG.md`

## Testing

- Unit tests for `parseTarget` and `fetchOpenPrs`.
- Integration-style tests for scope `watch`/`stream` and raw content fallback using the existing mocked `gh` runner pattern in `src/index.test.ts`.

## Verification

- [ ] `nub run typecheck`
- [ ] `nub run lint:ci`
- [ ] `nub run format:ci`
- [ ] `nub run test:ci`
- [ ] `nub run build`
- [ ] Manual dry-run: `pickup stream owner/repo --dry-run` and `pickup watch org:myorg --dry-run`.

## Acceptance

- [ ] `pickup watch owner/repo` and `pickup stream owner/repo` discover all open PRs in that repo and process `@pickup` mentions.
- [ ] `pickup watch org:myorg` and `pickup stream org:myorg` discover open PRs across the org, subject to token permissions.
- [ ] Full GHES URLs (`https://ghe.example.com/owner/repo`, `https://ghe.example.com/orgs/myorg`) pass `--hostname ghe.example.com` to `gh api` and `-R ghe.example.com/owner/repo` to `gh pr checkout`.
- [ ] Private repos are discoverable when the `gh` token has `repo` access.
- [ ] `--fix` is disabled for any scope target and a warning is logged.
- [ ] State is correctly saved/loaded for each discovered PR URL.
- [ ] Existing single-PR `pickup watch <pr-url>` works unchanged; `ReplyContext` is only constructed in `src/index.ts`, so making `repoRoot` optional is an internal-only change.

## Fallback Plan

If `search/issues` is unavailable on a GHES instance, repo scope falls back to `gh api --hostname <host> repos/<owner>/<repo>/pulls?state=open` (response is an array of PR objects; use `html_url` on each object). Org scope is not supported on older GHES and throws a clear error. If raw content fetch fails for a scope-mode review comment, fall back to posting `MISSING_FILE_REPLY`.

## References

- GitHub search API: https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#search-issues-and-pull-requests
- GitHub contents raw API: https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content

## Complexity Check

- Implementation TODO count: 9 top-level steps (Step 1-Step 9), ~28 sub-tasks
- Total checklist items: ~35
- Depth: 2
- Cross-deps: `host` is threaded through `src/index.ts` and `src/fix.ts`; this is a single-repo internal change.
- **Decision:** Proceed (single repo, single PR).
