# Browser and Terminal Approval Product Gate Source QA

Date: 2026-06-10

## Scope

This source-level QA adds a generic product workflow evidence gate for risky
Browser writes and interactive Terminal start/input flows. It does not claim the
packaged workflow is product-ready.

## Source Changes

- `scripts/qa/check-product-workflow-evidence.ps1` now includes
  `browser-terminal-approvals` as a known blocker.
- The gate requires visible approval evidence for Terminal start, Terminal
  input, and Browser write operations.
- The gate also requires output proving denial fails closed, stale previews are
  rejected, and one-shot execution is enforced.
- `scripts/test-check-product-workflow-evidence.mjs` verifies missing evidence
  reports `BLOCKED browser-terminal-approvals`, and complete fixture evidence
  reports `PASS browser-terminal-approvals`.
- `docs/qa/PRODUCT_WORKFLOWS.md` documents the packaged evidence expected for
  this workflow.

## Remaining Blocker

`browser-terminal-approvals` must stay blocked until real packaged-app evidence
is captured under a dated QA folder. Browser write visible approval UX is still
not product-ready.

## Verification

Run:

```powershell
node scripts/test-check-product-workflow-evidence.mjs
```
