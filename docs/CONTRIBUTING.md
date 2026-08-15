# Contributing to crewmate

Thanks for helping out. Keep changes focused and open an issue first if you are planning something large.

## What you need

- Node.js **24** or later
- [Nub](https://nubjs.com) (see `devEngines.packageManager` in [package.json](../package.json))

## Getting started

```bash
git clone https://github.com/YogliB/crewmate.git
cd crewmate
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
nub run duplicates:ci
nub run knip:ci
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

Husky's pre-commit hook runs `lint-staged`, which runs `oxfmt` and `oxlint` on staged files. If it fixes formatting, stage the changes and commit again.

### The pre-push hook fails

Husky's pre-push hook runs `nub run typecheck`, `nub run duplicates:ci`, and `nub run knip:ci`.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject` in the imperative. Add a body when the motivation is not obvious.

## Documentation style

Keep docs short, clear, and concise. Avoid long explanations when a short sentence will do. Use active voice and focus on what the reader needs to do or know. This applies to README entries, changelog bullets, help text, and agent-facing docs.

## Security

Do not open public issues for security problems. See [docs/SECURITY.md](SECURITY.md) for the reporting process.
