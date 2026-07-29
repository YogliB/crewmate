# Troubleshooting

Common problems when building or contributing to pickup, and how to resolve them.

## `nub install` fails or `nub` is not found

pickup uses [Nub](https://nubjs.com) as its package manager (see `devEngines.packageManager` in [package.json](../package.json)). Install Nub first, then retry:

```bash
nub install
```

If Nub isn't available in your environment, `devEngines.onFail` is set to `warn`, so npm/pnpm/yarn can be used as a fallback, but scripts in this doc assume `nub`.

## `nub run build` fails or `dist/` is missing

`nub run build` runs [tsdown](https://tsdown.dev) using [tsdown.config.ts](../tsdown.config.ts) to emit `dist/`. If the build fails:

- Confirm Node.js is **20** or later (`node -v`); see `engines` in [package.json](../package.json).
- Run `nub run typecheck` to surface TypeScript errors separately from bundling errors.
- Delete `dist/` and rebuild to rule out stale output.

## `nub run typecheck` reports errors

`nub run typecheck` runs `tsc --noEmit` against the project's TypeScript config. Fix the reported type errors in `src/`; there is no `dist/` type-checking step, so `dist/*.d.ts` is only regenerated on the next build.

## `nub run lint:ci` fails with "New docs/markdown files are not allowed"

This repository blocks new Markdown files outside an explicit allow list via the custom `oxlint-repo-guidelines/no-more-docs` rule (see [scripts/oxlint-repo-guidelines.js](../scripts/oxlint-repo-guidelines.js) and [.oxlintrc.json](../.oxlintrc.json)). If you added a new `.md` file or a file under `docs/`, either:

- Remove it, or
- Add its path to the `allowedDocs` list in [scripts/oxlint-repo-guidelines.js](../scripts/oxlint-repo-guidelines.js) and link it from [AGENTS.md](../AGENTS.md) and, if user-facing, [README.md](../README.md).

## `nub run lint:ci` fails on other rules

`nub run lint:ci` runs `oxlint src` with `denyWarnings: true`, so any warning fails CI. Run `nub run lint` locally to auto-fix what oxlint can, then address the remaining findings manually.

## `nub run format:ci` reports formatting differences

`nub run format:ci` runs `oxfmt --check .`. Run `nub run format` to apply formatting in place, then re-run `nub run format:ci` to confirm.

## The pre-commit hook rejects my commit

The Husky `pre-commit` hook runs lint and format checks automatically (see [docs/CONTRIBUTING.md](CONTRIBUTING.md)). If a hook modifies files to fix formatting, stage the changes and commit again. If it fails outright, run `nub run lint:ci` and `nub run format:ci` locally to see the underlying error.

## Still stuck?

Search existing [issues](https://github.com/YogliB/pickup/issues) or open a new one with the details described in [docs/CONTRIBUTING.md](CONTRIBUTING.md#reporting-bugs). For security-sensitive problems, follow [docs/SECURITY.md](SECURITY.md) instead of opening a public issue.
