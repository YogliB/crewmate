# AGENTS.md

Agent-facing entry point for this repo. For the open format, see [agents.md](https://agents.md/).

## Quick links

| Topic                | Where to look                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Agent rules          | [@caveman.md](.agents/rules/caveman.md), [@ponytail.md](.agents/rules/ponytail.md), [@rtk.md](.agents/rules/rtk.md) |
| Agent skills         | [@crewmate](.agents/skills/crewmate/SKILL.md), [@documentation](.agents/skills/documentation/SKILL.md)              |
| System prompt        | [assets/SYSTEM_PROMPT.md](assets/SYSTEM_PROMPT.md)                                                                  |
| User-facing CLI docs | [README.md](README.md)                                                                                              |
| How to contribute    | [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)                                                                        |
| Common CLI problems  | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)                                                                  |
| Security reporting   | [docs/SECURITY.md](docs/SECURITY.md)                                                                                |
| Release notes        | [docs/CHANGELOG.md](docs/CHANGELOG.md)                                                                              |
| Architecture         | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                        |
| License              | [LICENSE.md](LICENSE.md)                                                                                            |

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

- `src/index.ts` — CLI, watch loop, and `stream`.
- `src/bin.ts` — executable entry point.
- `src/fix.ts` — generating replies and applying fixes.
- `src/config.ts` — resolving global and per-repo config profiles.
- `src/init.ts` — interactive `crewmate init` setup.
- `src/log.ts` — structured logging.
- `src/state.ts` — persisting seen comment IDs.
- `dist/` — build output.
- `assets/help.md` — help text shown by `--help`.
- `assets/SYSTEM_PROMPT.md` — default system prompt for review comment replies.
- `assets/config.schema.json` — JSON schema for config files.

## Lint and format

CI and the pre-commit hook run `oxlint` and `oxfmt`. `nub run format` fixes most issues. CI and the pre-push hook also run `jscpd` (`nub run duplicates:ci`) and `knip` (`nub run knip:ci`) to catch duplication and unused dependencies. A custom `oxlint-repo-guidelines/no-more-docs` rule blocks new Markdown or `docs/` files that are not in the allow-list. Add to [scripts/oxlint-repo-guidelines.js](scripts/oxlint-repo-guidelines.js) and update this file if a new doc is needed.

## Documentation

Keep docs short, clear, and concise. `AGENTS.md` is a condensed version of the human docs in `docs/`; link to the full doc when detail is needed. For new Markdown or `docs/` files, add them to `scripts/oxlint-repo-guidelines.js`, `AGENTS.md`, and `README.md` so the `no-more-docs` rule stays green.

## Pull requests

Keep changes focused. Run `nub run build`, `nub run typecheck`, `nub run format:ci`, `nub run lint:ci`, `nub run duplicates:ci`, `nub run knip:ci`, and `nub run test:ci` before opening a PR. Squash to a single commit, write a Conventional Commit message, and fill in [.github/pull_request_template.md](.github/pull_request_template.md).
