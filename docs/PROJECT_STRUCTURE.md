# Project Structure

This repository is a pnpm workspace with a Tauri desktop app and shared
TypeScript packages.

## Current Layout

```text
Javis/
  apps/
    desktop/
      src/
      src-tauri/
      package.json

  packages/
    core/
      src/
        agents.ts
        index.ts
        index.test.ts
        plans.ts
        research.ts
        routing.ts
      package.json

    tools/
      src/index.ts
      package.json

    ui/
      src/index.tsx
      package.json

  docs/
  README.md
  CONTRIBUTING.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
```

## Ownership

### `apps/desktop`

Owns application bootstrapping, Tauri command injection, and React mounting.
The desktop app adapts native commands into the tool interfaces expected by
Core.

### `apps/desktop/src-tauri`

Owns native commands:

- `scan_markdown_documents`
- `inspect_project`
- `run_read_only_command`
- `fetch_web_source`
- `plan_pdf_organization`
- `approve_pdf_organization`
- `execute_pdf_organization`

This layer enforces local safety checks for filesystem and process access.

### `packages/core`

Owns task orchestration and user-visible task state. Public consumers should
import through `@javis/core`; internal files may change as the runtime is split.

### `packages/tools`

Owns shared tool contracts and pure helper logic. It should not call Tauri or
Node process APIs directly.

### `packages/ui`

Owns reusable React components for the workbench. Components should remain
presentational and receive actions through props.

### `docs`

Owns current operating documentation plus archived design context. The current
source of truth starts with `docs/README.md`, `docs/MVP_STATUS.md`,
`docs/DEVELOPMENT.md`, `docs/SECURITY_MODEL.md`, and `docs/ROADMAP.md`.

## Dependency Rules

- `apps/desktop` may depend on `packages/core`, `packages/tools`, and
  `packages/ui`.
- `packages/core` may depend on `packages/tools`.
- `packages/ui` should not depend on Core or Tauri.
- `packages/tools` should stay independent from desktop implementation details.
- Native commands stay inside `apps/desktop/src-tauri`.

When adding new code, preserve this direction unless a design document is
updated with the reason for changing it.
