# Development Guide

## Setup

Install JavaScript dependencies from the repository root:

```sh
pnpm install
```

Make sure the Rust toolchain is available:

```sh
cargo --version
```

## Running

Run the desktop app:

```sh
pnpm dev
```

Run only the React/Vite frontend:

```sh
pnpm --filter @javis/desktop dev
```

The frontend-only preview cannot call real Tauri commands. Use it for layout
checks, not native tool verification.

## Verification Commands

Full local check:

```sh
pnpm check
```

Individual checks:

```sh
pnpm typecheck
pnpm --filter @javis/core test
pnpm --filter @javis/desktop build
pnpm rust:check
pnpm rust:test
```

Before handing off work, run at least:

```sh
pnpm typecheck
pnpm test
```

## Architecture Boundaries

Keep dependencies one-way:

```text
apps/desktop -> packages/ui
apps/desktop -> packages/core -> packages/tools
apps/desktop -> apps/desktop/src-tauri commands
```

Rules:

- `packages/ui` receives props and callbacks only. It must not call Tauri,
  shell, filesystem, or model APIs.
- `packages/core` owns task lifecycle, routing, agent snapshots, and verifier
  summaries. It depends on tool interfaces, not Tauri commands.
- `packages/tools` owns shared tool contracts and permission-level vocabulary.
- `src-tauri` owns native execution and low-level safety checks. It should not
  contain Commander or Agent policy logic.

## Adding a New Tool

1. Add the shared request/result types to `packages/tools`.
2. Add a tool method to the relevant tool interface.
3. Register the capability in `initialToolDescriptors`.
4. Add a Tauri command only if native access is needed.
5. Inject the implementation from `apps/desktop/src/App.tsx`.
6. Route it from `packages/core` through a visible task plan.
7. Add UI display only through `packages/ui` props.
8. Add tests for risky native behavior.

## Testing Strategy

- Use Vitest for TypeScript package behavior tests.
- Keep Core tests focused on observable snapshots and tool calls.
- Use Rust unit tests for native filesystem safety boundaries.
- Prefer small fake tool implementations over broad integration fixtures.

## Safety Checklist for File Operations

Any operation that writes, moves, deletes, or overwrites files must:

- Create a dry-run first.
- Include source paths, target paths, operation type, and conflict state.
- Show a permission request in the UI.
- Execute only the current approved dry-run.
- Re-check paths and conflicts before writing.
- Report moved/skipped/failed results.
- Avoid deleting files in the first version.

## Manual Smoke Test

After major UI or runtime changes:

1. Start `pnpm --filter @javis/desktop dev`.
2. Open the local Vite URL.
3. Confirm the workbench renders:
   - Main Thread
   - Agent / Context Inspector
   - Activity / Logs / Confirmations
   - Composer
4. Check browser console for errors.
5. Run `pnpm check` before final handoff.
