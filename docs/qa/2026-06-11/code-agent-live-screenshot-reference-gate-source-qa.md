# Code Agent Live Screenshot Reference Gate Source QA

Date: 2026-06-11

## Scope

This source-level QA tightens Code Agent live-provider evidence binding. It does
not run a real live provider.

## Source Changes

- `scripts/qa/check-product-workflow-evidence.ps1` now requires
  `code-agent-opencode-qa-output.txt` to reference
  `20-code-agent-live-proposal-before-approve.png` and the approved live apply
  screenshot.
- `scripts/test-check-product-workflow-evidence.mjs` includes a negative
  fixture where the live screenshots exist in the QA folder but the output does
  not reference them; `code-agent-live-provider` must remain blocked.

## Remaining Blocker

`code-agent-live-provider` remains blocked until a packaged desktop run with a
real configured provider produces a passing live proposal/apply result and the
QA output references the live screenshots.

## Verification

Run:

```powershell
cd E:\Javis
node scripts\test-check-product-workflow-evidence.mjs
```
