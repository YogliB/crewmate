# AGENTS.md

Agent-facing entry point for this repo. For the open format, see [agents.md](https://agents.md/).

## Quick links

| Topic                | Where to look                                 |
| -------------------- | --------------------------------------------- |
| User-facing CLI docs | [README.md](../README.md)                     |
| How to contribute    | [docs/CONTRIBUTING.md](CONTRIBUTING.md)       |
| Common CLI problems  | [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| Security reporting   | [docs/SECURITY.md](SECURITY.md)               |
| Release notes        | [docs/CHANGELOG.md](CHANGELOG.md)             |
| Architecture         | [docs/ARCHITECTURE.md](ARCHITECTURE.md)       |
| License              | [LICENSE.md](../LICENSE.md)                   |

## Setup

Install dependencies and build:

```bash
nub install
nub run build
```

## Common commands

- `nub run build` — bundle `src/` into `dist/` with tsdown.
- `nub run typecheck` — run `tsc --noEmit`.
- `nub run lint` / `nub run lint:ci` — run oxlint; use `lint` for auto-fix.
- `nub run format` / `nub run format:ci` — run oxfmt; use `format` to apply.
- `nub run duplicates:ci` — run jscpd to detect code duplication.
- `nub run knip:ci` — find unused dependencies and exports with knip.
- `nub run test` / `nub run test:ci` — run vitest with or without coverage.

## Project layout

- `src/index.ts` — CLI and watch loop.
- `src/bin.ts` — executable entry point.
- `src/fix.ts` — generating replies and applying fixes.
- `src/log.ts` — structured logging.
- `src/state.ts` — persisting seen comment IDs.
- `dist/` — build output.
- `assets/help.md` — help text shown by `--help`.

## Lint and format

CI and the pre-commit hook run `oxlint` and `oxfmt`. `nub run format` fixes most issues. CI and the pre-push hook also run `jscpd` (`nub run duplicates:ci`) and `knip` (`nub run knip:ci`) to catch duplication and unused dependencies. A custom `oxlint-repo-guidelines/no-more-docs` rule blocks new Markdown or `docs/` files that are not in the allow-list. Add to [scripts/oxlint-repo-guidelines.js](../scripts/oxlint-repo-guidelines.js) and update this file if a new doc is needed.

## Pull requests

Keep changes focused. Run `nub run build`, `nub run typecheck`, `nub run format:ci`, `nub run lint:ci`, `nub run duplicates:ci`, `nub run knip:ci`, and `nub run test:ci` before opening a PR. Squash to a single commit and write a Conventional Commit message.
