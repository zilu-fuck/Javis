# Capability Product Evidence Ingestion Source QA

Date: 2026-06-10

## Scope

This source-level QA records machine-readable product workflow evidence
ingestion for capability scoring. It does not claim packaged/live capability
scoring readiness.

## Source Changes

- `scripts/qa/check-product-workflow-evidence.ps1` supports `-Json` output with
  scenario statuses and missing evidence details.
- `apps/desktop/src/capability-verification.ts` converts product workflow
  scenario statuses into generic `AgentCapabilityEvidenceRecord` values.
- `apps/desktop/src/capability-verification.ts` also parses the JSON inventory
  emitted by the product workflow gate and rejects malformed inventory payloads.
- Runtime capability verification can now combine product workflow QA/live
  evidence with recent tool-call failure signals.
- `packages/ui/src/components/inspector/AgentDetailPanel.tsx` displays
  capability score signals, recent failure rate, evidence count, up to three
  evidence references, and a remaining-reference count in the inspector.
- `packages/ui/src/index.test.tsx` verifies multiple capability evidence
  references are visible in selected agent details.
- `scripts/qa/check-product-workflow-evidence.ps1` includes
  `capability-scoring-evidence-ingestion` as a known blocker.

## Remaining Blocker

Packaged evidence is still required to prove the inspector displays ingested QA
evidence, live evidence, evidence refs, and recent failure rates.

## Verification

Run:

```powershell
.\node_modules\.bin\vitest.CMD run apps/desktop/src/capability-verification.test.ts
cd packages\ui
..\..\node_modules\.bin\vitest.CMD run src\index.test.tsx
..\..\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.json
cd ..\..
node scripts/test-check-product-workflow-evidence.mjs
```
