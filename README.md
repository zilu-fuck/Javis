# Javis

Javis is a desktop-first multi-agent assistant prototype built with TypeScript,
React, and Tauri. The project focuses on a visible, auditable task loop:

```text
user goal -> Commander plan -> worker tools -> verifier -> desktop UI result
```

The current project goal is a complete usable desktop product. The verified MVP
workbench is the foundation, not the finish line. Javis remains local-first and
conservative around filesystem writes: high-risk actions must create a dry-run
plan and wait for explicit user approval before execution.

## Current Status

Implemented foundation:

- Desktop workbench layout with sidebar, main thread, agent inspector, and
  activity / confirmations area.
- Read-only Markdown document scan with summaries and verification.
- Project inspection that detects package scripts, recommends start/check
  commands, and runs allowlisted read-only checks.
- URL-based research collection with a source-backed report and explicit
  unknown/unverified notes.
- PDF organization dry-run for `Downloads`, confirmation cards, approved
  move execution, conflict skipping, and execution verification.

Current product-readiness gaps:

- Automated public search is not wired in yet.
- Code Agent / opencode is not integrated yet.
- Completed, failed, and cancelled task history is stored locally with sidebar
  restore and deletion; broader persistence QA is still needed.
- Workspace selection, release signing/versioning, and broader write-tool
  permission enforcement are not complete yet.
- Core runtime is being split into focused modules. Agent definitions, plans,
  route detection, and research report helpers have been extracted; the main
  runtime flow still lives in `packages/core/src/index.ts`.

See [Product Readiness](docs/PRODUCT_READINESS.md) for the current target and
[MVP Status](docs/MVP_STATUS.md) for the completed baseline acceptance matrix.

## Requirements

- Node.js and pnpm
- Rust toolchain
- Windows is the primary target for the current Tauri desktop build

## Quick Start

Install dependencies:

```sh
pnpm install
```

Run the Tauri desktop app:

```sh
pnpm dev
```

Run a frontend-only Vite preview:

```sh
pnpm --filter @javis/desktop dev
```

## Verification

Run the full local check:

```sh
pnpm check
```

Individual checks:

```sh
pnpm typecheck
pnpm --filter @javis/desktop build
pnpm rust:check
pnpm rust:test
```

## Repository Layout

```text
apps/desktop          Tauri + React desktop shell
packages/core         task runtime, planning, agent state, verification
packages/tools        tool contracts and shared tool result types
packages/ui           reusable workbench UI components
docs                  product, architecture, security, and status docs
```

## Safety Model

Javis separates preview actions from writes:

- `read`: may execute immediately and must log results.
- `preview`: creates a plan or dry-run without changing local state.
- `confirmed_write`: requires an explicit current permission request.
- `dangerous`: rejected by default for the first version.

The PDF organization flow demonstrates this model: it first lists source and
target paths, marks conflicts, waits for approval, then moves only the files in
the approved dry-run plan.

## Documentation

- [Documentation Index](docs/README.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Product Readiness](docs/PRODUCT_READINESS.md)
- [MVP Status](docs/MVP_STATUS.md)
- [Security Model](docs/SECURITY_MODEL.md)
- [Manual QA Checklist](docs/QA_CHECKLIST.md)
- [Release Guide](docs/RELEASE.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
