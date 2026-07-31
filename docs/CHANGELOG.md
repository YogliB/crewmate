# pickup changelog

## Unreleased

- Removed the GitHub Pages site and the `site/` directory; documentation now lives in the repo.
- Rewrote README.md and TROUBLESHOOTING.md to focus on using the CLI.
- Updated AGENTS.md, CONTRIBUTING.md, and ARCHITECTURE.md to remove site references and stay accurate.

## 0.0.1

- Reworked the GitHub Pages landing page: features are inlined and visible on load, the logo renders immediately, htmx was removed, and the GitHub nav link is now an SVG icon with a tooltip.
- Added a GitHub Pages site at https://yoglib.github.io/pickup/ built with Alpine.js and Pico.css, including a README banner.
- Added `pickup watch` shorthand support for PR references in the form `owner/repo/pull/N`.
- Added fresh-install fallback: skips `@pickup` mentions that already have a `🛻 pickup:` reply when state is empty or missing.
- Prefix all pickup replies with `🛻 pickup:` so users can identify the bot without a self-mention.
- Added `pickup watch` to poll a PR for review comments mentioning `@pickup`, reply with explanations, and optionally generate, commit, push, and reply with a fix.
- Added state persistence for seen comment IDs in `$XDG_CONFIG_HOME/pickup/state.json`.
- Initial bare-metal CLI scaffold.
- Added `docs/TROUBLESHOOTING.md` covering common build, lint, and format problems.
