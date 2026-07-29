# AGENTS.md

Instructions and entry points for coding agents working on this repository. For the open format background, see [agents.md](https://agents.md/).

## Documentation sync

Treat **AGENTS.md** as the agent-facing index for [README.md](README.md), [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md), [docs/SECURITY.md](docs/SECURITY.md), and [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md). Keep it aligned with those docs when workflow, release, or navigation facts change.

## Agent index

| Topic                                    | Where to look                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Keeping human docs and this file aligned | [Documentation sync](#documentation-sync)                                                                |
| User-facing behavior, CLI usage          | [README.md](README.md)                                                                                   |
| License text                             | [LICENSE.md](LICENSE.md)                                                                                 |
| Contributing flow, commit style          | [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)                                                             |
| Security policy and reporting            | [docs/SECURITY.md](docs/SECURITY.md)                                                                     |
| Community expectations                   | [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md)                                                       |
| Architecture overview                    | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                             |
| Release notes                            | [docs/CHANGELOG.md](docs/CHANGELOG.md)                                                                   |
| Library and CLI implementation           | [src/index.ts](src/index.ts), [src/bin.ts](src/bin.ts)                                                   |
| tsdown build                             | [tsdown.config.ts](tsdown.config.ts)                                                                     |
| Lint/format rules and custom docs rule   | [.oxlintrc.json](.oxlintrc.json), [scripts/oxlint-repo-guidelines.js](scripts/oxlint-repo-guidelines.js) |
| npm scripts and package metadata         | [package.json](package.json)                                                                             |

## Project overview

See [README.md](README.md) for the user-facing overview and [package.json](package.json) for runtime/build metadata.

## Setup commands

```bash
nub install
nub run build
```

## Development workflow

See [package.json](package.json) for the build, dev, lint, and format scripts. Source of truth for behavior is `src/`; the published artifact is under `dist/` after build.

## Testing instructions

No test suite exists yet. Add tests alongside new behavior and document the runner here once one is introduced.

## Lint and format

`nub run lint:ci` runs `oxlint`, `nub run format:ci` runs `oxfmt --check`. A `scripts/oxlint-repo-guidelines.js` custom rule (`oxlint-repo-guidelines/no-more-docs`) blocks new Markdown/`docs/` files that are not explicitly allow-listed, keeping documentation sprawl in check. Both lint and format run automatically via the `pre-commit` husky hook.

## Build and release

`nub run build` emits `dist/` via tsdown. There is no publish workflow yet.

## Pull requests and commits

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for PR shape and commit conventions. Add unreleased notes to [docs/CHANGELOG.md](docs/CHANGELOG.md) for user-facing changes.
