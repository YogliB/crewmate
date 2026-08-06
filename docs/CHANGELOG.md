# pickup changelog

## Unreleased

- Add repo and org scope support to `pickup watch` and `pickup stream`. Targets can be a single PR (`owner/repo/pull/4`), a repo (`owner/repo`), or an org (`org:myorg`). GHES hosts are supported via full URLs.
- Discover open PRs via the GitHub `search/issues` API, with a fallback to `repos/<owner>/<repo>/pulls` for repo scope on older GHES.
- File content for scope-mode explanations is fetched from the GitHub raw content API instead of requiring a local clone.
- `--fix` is disabled for repo and org scope targets and a warning is logged when requested.
