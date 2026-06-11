# Browser Native Visible Approval Source QA

Date: 2026-06-11

## Scope

This source-level QA records Browser write approvals being tied to visible
Workbench UI approval cards and native browser approval plans. It does not
claim packaged product readiness and does not include screenshots.

## Source Evidence

- `apps/desktop/src/app-runtime.ts` plans Browser writes through
  `browser_plan_write`, requires `requestBrowserWriteApproval`, and only calls
  `browser_approve_write` after an explicit visible decision.
- `apps/desktop/src/App.tsx` brokers pending Browser write approvals into
  `pendingBrowserWriteApproval` state, resolves older pending approvals as
  denied, and exposes approve/deny handlers to the Workbench.
- `packages/ui/src/components/WorkspaceToolPanels.tsx` renders the visible
  Browser approval card with approval id, session id, action summary, preview
  hash, and approve/deny controls.
- `packages/ui/src/index.test.tsx` verifies the Browser approval card renders,
  does not display raw typed text, and dispatches approve/deny callbacks.
- `apps/desktop/src/browser-write-contract.test.ts` locks the source contract
  for native plan/approve wiring, visible approval broker state, audit records,
  and continued disabled agent exposure until packaged QA lands.

## Remaining Blocker

`browser-terminal-approvals` remains blocked until packaged desktop QA captures
the Browser write approval screenshot plus approve, deny, stale-preview,
guard, and one-shot execution evidence.

## Verification

Run:

```powershell
corepack pnpm --filter @javis/desktop test -- src/browser-write-contract.test.ts
corepack pnpm --filter @javis/ui test -- src/index.test.tsx
```
