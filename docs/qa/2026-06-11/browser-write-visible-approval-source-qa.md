# Browser Write Visible Approval Source QA

Date: 2026-06-11

## Scope

This source-level QA records the Browser write approval card surface in the
workspace Browser panel and the desktop runtime pending-approval broker. It
does not claim Browser write product readiness.

## Source Changes

- `packages/ui/src/types.ts` defines a generic
  `WorkbenchBrowserWriteApprovalPreview`.
- `packages/ui/src/components/WorkspaceToolPanels.tsx` renders a visible
  Browser write approval card with approve and deny actions.
- The card displays action, session, preview hash, selector, and byte counts,
  but not raw typed text, evaluate expressions, or browser test scripts.
- `packages/ui/src/JavisWorkbench.tsx` and
  `packages/ui/src/components/InspectorPanel.tsx` pass the pending approval
  preview and decision callbacks through to the Browser panel.
- `apps/desktop/src/app-runtime.ts` calls an optional
  `requestBrowserWriteApproval` broker after native planning and before native
  `browser_approve_write`; denial fails closed before execution.
- `apps/desktop/src/App.tsx` maps runtime approval requests into
  `WorkbenchBrowserWriteApprovalPreview`, resolves approve/deny decisions from
  the Browser panel, and stores only selector/hash/byte-count metadata.
- `packages/ui/src/index.test.tsx` verifies the visible card, approve/deny
  callbacks, and redaction of raw Browser input.
- `apps/desktop/src/browser-write-contract.test.ts` verifies the runtime keeps
  Browser writes behind plan, visible approval broker, native approval,
  execution, and audit wiring.

## Remaining Blocker

Browser write tools remain disabled from Commander prompts and generic workflow
dispatch. Product readiness still requires packaged-app evidence for approve,
deny, stale-preview rejection, and one-shot execution.

## Verification

Run:

```powershell
cd packages/ui
..\..\node_modules\.bin\vitest.CMD run src/index.test.tsx
cd ..\..
.\node_modules\.bin\tsc.CMD --noEmit -p packages\ui\tsconfig.json
cd apps\desktop
..\..\node_modules\.bin\vitest.CMD run src\browser-write-contract.test.ts src\browser-audit.test.ts
cd ..\..
.\node_modules\.bin\tsc.CMD --noEmit -p apps\desktop\tsconfig.json
```
