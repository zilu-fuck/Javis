# Terminal Visible Approval Source QA

Date: 2026-06-10

## Scope

This source-level QA covers visible Terminal approval UI in the workbench tool
panel.

It verifies:

- Interactive Terminal creation is gated by a visible "Approve and start" card.
- The terminal service is not called before the start approval is visible and
  accepted.
- The Terminal start card now displays the native approval id and preview hash
  from `terminal_plan_create` before execution.
- Interactive Terminal input is buffered into a visible approval card that
  shows byte count, hash, and Enter status rather than raw input text.
- The Terminal input card now displays the native approval id and preview hash
  from `terminal_plan_input` before execution.

## Commands

```powershell
cd E:\Javis\packages\ui
.\node_modules\.bin\tsc.CMD --noEmit
```

Result: passed.

```powershell
cd E:\Javis\packages\ui
..\..\node_modules\.bin\vitest.CMD run src/index.test.tsx
```

Result: passed, 1 file / 91 tests.

## Remaining Gaps

- This is source-level UI evidence only, not packaged-app evidence.
- Browser write visible approval is covered separately in
  `docs/qa/2026-06-11/browser-write-visible-approval-source-qa.md`.
- Native Terminal plan/execute UI wiring is covered separately in
  `docs/qa/2026-06-11/terminal-native-visible-approval-source-qa.md`.
- Terminal packaged approve/deny/stale-preview/one-shot evidence remains open.
