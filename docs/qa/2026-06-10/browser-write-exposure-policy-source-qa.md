# Browser Write Exposure Policy Source QA

Date: 2026-06-10

## Scope

This source-level QA covers the product exposure policy for Browser write tools.

It verifies:

- `browser.click`, `browser.type`, `browser.evaluate`, `browser.runTest`, and
  `browser.upload` remain marked disabled by `isDisabledBrowserWriteToolName`.
- Desktop runtime still filters disabled Browser write descriptors out of the
  Commander planning prompt surface.
- Core workflow execution checks disabled required tools before running generic
  workflow steps, so hardcoded `browser.runTest` workflow steps remain skipped
  until the policy is changed.

## Commands

```powershell
cd E:\Javis
.\node_modules\.bin\vitest.CMD run apps/desktop/src/browser-write-contract.test.ts apps/desktop/src/app-runtime.test.ts packages/core/src/workflow-executor.test.ts packages/core/src/agent-capability.test.ts
```

Result: passed.

## Remaining Gaps

- This does not make Browser writes product-ready.
- Visible approval cards and packaged-app approve/deny/stale-preview/one-shot
  evidence are still required before exposing Browser writes to normal agent
  dispatch.
