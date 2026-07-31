# Contributing to pickup

Thanks for helping out. Keep changes focused and open an issue first if you are planning something large.

## What you need

- Node.js **24** or later
- [Nub](https://nubjs.com) (see `devEngines.packageManager` in [package.json](../package.json))

## Getting started

```bash
git clone https://github.com/YogliB/pickup.git
cd pickup
nub install
nub run build
```

## Before submitting

Run the same checks that run in CI:

```bash
nub run build
nub run typecheck
nub run format:ci
nub run lint:ci
nub run test:ci
```

`nub run lint` and `nub run format` will auto-fix most issues; `nub run lint:ci` and `nub run format:ci` only report them.

## Common problems

### `nub install` fails

Install [Nub](https://nubjs.com) first. If Nub is not available, `devEngines.onFail` is set to `warn`, so npm/pnpm/yarn can be used as a fallback.

### `nub run build` fails

- Make sure you are on Node 24+ (`node -v`).
- Run `nub run typecheck` to separate TypeScript errors from bundling errors.
- Delete `dist/` and rebuild.

### `nub run lint:ci` reports "New docs/markdown files are not allowed"

The custom `oxlint-repo-guidelines/no-more-docs` rule blocks new Markdown or `docs/` files that are not in the allow-list. Remove the file or add it to [scripts/oxlint-repo-guidelines.js](../scripts/oxlint-repo-guidelines.js) and link it from [AGENTS.md](../AGENTS.md) and [README.md](../README.md).

### The pre-commit hook rejects my commit

Husky runs `nub run lint:ci` and `nub run format:ci` before each commit. If it fixes formatting, stage the changes and commit again.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject` in the imperative. Add a body when the motivation is not obvious.

## Security

Do not open public issues for security problems. See [docs/SECURITY.md](SECURITY.md) for the reporting process.
