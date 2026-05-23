# Javis Desktop

Desktop shell for Javis, built with Tauri, React, and TypeScript.

## Responsibilities

`apps/desktop` owns:

- application bootstrapping
- Tauri command injection
- React workbench mounting
- desktop build configuration

It should not own Commander policy, tool contracts, or reusable UI logic.

## Commands

From the repository root:

```sh
pnpm dev
pnpm --filter @javis/desktop dev
pnpm --filter @javis/desktop build
pnpm --filter @javis/desktop tauri build
```

## Tauri Commands

Native commands are implemented in `src-tauri/src/lib.rs`:

- `scan_markdown_documents`
- `inspect_project`
- `run_read_only_command`
- `fetch_web_source`
- `plan_pdf_organization`
- `approve_pdf_organization`
- `execute_pdf_organization`

All risky commands must be backed by Core permission flow, visible UI state, and
native approval-state checks for the current dry-run.

## Frontend-Only Preview

`pnpm --filter @javis/desktop dev` starts Vite without the real Tauri runtime.
Use it for visual checks only. Native commands require the Tauri app.
