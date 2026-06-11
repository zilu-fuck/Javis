# Terminal Approval Audit Source QA

Date: 2026-06-10

## Scope

This source-level QA covers interactive Terminal create/input approval and
tool-call audit wiring.

It verifies:

- Desktop `WorkbenchTerminalService.create` uses native
  `terminal_plan_create` -> `terminal_approve` -> `terminal_create`.
- Desktop `WorkbenchTerminalService.input` uses native
  `terminal_plan_input` -> `terminal_approve` -> `terminal_input`.
- Terminal plan, execution, and failure audit records use generic
  `ToolCallAuditRecord` persistence shape.
- Terminal input audit summaries store byte count/hash metadata rather than raw
  input text.

## Commands

```powershell
cd E:\Javis\apps\desktop
.\node_modules\.bin\tsc.CMD --noEmit
```

Result: passed.

```powershell
cd E:\Javis
.\node_modules\.bin\vitest.CMD run apps/desktop/src/terminal-audit.test.ts apps/desktop/src/tool-call-audit.test.ts apps/desktop/src/capability-verification.test.ts
```

Result: passed, 3 files / 21 tests.

## Remaining Gaps

- This is source-level evidence only, not packaged-app evidence.
- Terminal create/input still need visible approval cards instead of being
  treated as product-ready.
- Browser write audit records remain open.
