# Architecture Overview

This document describes the actual architecture of pickup: currently a minimal TypeScript CLI scaffold with a single placeholder entry point, pending real functionality.

## 1. Project Structure

```text
./
├── AGENTS.md         # Agent-oriented repo guidance
├── src/
│   ├── index.ts      # Public library entrypoint
│   └── bin.ts        # CLI entrypoint
├── dist/             # Built ESM output and type declarations
├── README.md         # User-facing usage and setup guide
├── docs/
│   ├── ARCHITECTURE.md    # Repository overview and structure
│   ├── CHANGELOG.md       # Release notes
│   ├── CODE_OF_CONDUCT.md # Community expectations
│   ├── CONTRIBUTING.md    # Contributor workflow and validation commands
│   ├── SECURITY.md        # Security policy and reporting process
│   └── TROUBLESHOOTING.md # Common build/lint/format problems and fixes
├── scripts/
│   └── oxlint-repo-guidelines.js  # Custom oxlint rule blocking undeclared doc files
├── tsdown.config.ts   # Build configuration
└── package.json       # Scripts, package metadata, and release config
```

## 2. High-Level System Diagram

```text
[User/CLI] -> [src/bin.ts] -> [src/index.ts]
```

There is no orchestration layer yet: `src/bin.ts` calls straight into `src/index.ts`.

## 3. Core Components

### 3.1. CLI Entry Point

Name: CLI runner

Description: Invokes the library entrypoint. No argument parsing exists yet.

Technologies: TypeScript, Node standard library

Deployment: Built into the published `pickup` executable and run locally via Node 20+.

### 3.2. Library entrypoint

Name: `run()`

Description: Placeholder implementation that prints a greeting; replace with real CLI behavior as the project grows.

Technologies: TypeScript, Node standard library

Deployment: Bundled into the published library entrypoint.

## 4. Data Stores

None. The project has no persistent state.

## 5. External Integrations / APIs

None yet.

## 6. Deployment & Infrastructure

Cloud Provider: None. The project is a locally executed CLI/library.

Build and release use tsdown to emit `dist/` ESM output and type declarations. Development uses [Nub](https://nubjs.com), targeting Node 20+.

## 7. Security Considerations

No application login flow, no persisted state, and no network calls yet. See [docs/SECURITY.md](SECURITY.md) for the reporting process.
