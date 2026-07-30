# pickup changelog

## Unreleased

- Added `pickup watch` shorthand support for PR references in the form `owner/repo/pull/N`.
- Added fresh-install fallback: skips `@pickup` mentions that already have a `🛻 pickup:` reply when state is empty or missing.
- Prefix all pickup replies with `🛻 pickup:` so users can identify the bot without a self-mention.
- Added `pickup watch` to poll a PR for review comments mentioning `@pickup`, reply with explanations, and optionally generate, commit, push, and reply with a fix.
- Added state persistence for seen comment IDs in `$XDG_CONFIG_HOME/pickup/state.json`.
- Initial bare-metal CLI scaffold.
- Added `docs/TROUBLESHOOTING.md` covering common build, lint, and format problems.
