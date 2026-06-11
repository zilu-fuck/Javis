# Terminal Native Visible Approval Source QA

Date: 2026-06-11

## Scope

This source-level QA records the interactive Terminal visible approval surface
being tied to native terminal approval plans. It does not claim packaged product
readiness.

## Source Changes

- `packages/ui/src/types.ts` adds optional `planCreate`, `executeCreate`,
  `planInput`, and `executeInput` methods to `WorkbenchTerminalService`.
- `packages/ui/src/components/WorkspaceToolPanels.tsx` prepares a native
  `terminal_plan_create` approval before enabling terminal start, and displays
  the approval id plus preview hash in the Terminal card.
- Buffered terminal input now prepares a native `terminal_plan_input` approval
  before enabling send, and displays the native approval id plus preview hash.
- Raw terminal input remains component-local for execution and is not displayed
  in the approval card.
- `apps/desktop/src/App.tsx` implements the plan/execute split while keeping
  the legacy `create` and `input` wrappers for compatibility.
- `apps/desktop/src/terminal-approval-contract.test.ts` locks the desktop
  source contract for plan, native approval, execution, and audit wiring.

## Remaining Blocker

`browser-terminal-approvals` remains blocked until packaged desktop QA captures
Terminal start/input approval screenshots plus approve, deny, stale-preview,
guard, and one-shot execution evidence.

## Verification

Run:

```powershell
cd packages\ui
..\..\node_modules\.bin\vitest.CMD run src\index.test.tsx
..\..\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.json
cd ..\..\apps\desktop
..\..\node_modules\.bin\vitest.CMD run src\terminal-audit.test.ts src\terminal-approval-contract.test.ts
..\..\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.json
```
