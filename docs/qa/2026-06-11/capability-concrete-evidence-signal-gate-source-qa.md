# Capability Concrete Evidence Signal Gate Source QA

Date: 2026-06-11

## Scope

This source-level QA records a stricter product evidence gate for capability
scoring. It does not close `capability-scoring-evidence-ingestion` without
packaged-app evidence.

## Source Changes

- `docs/qa/2026-06-10/capability-scoring-evidence-ingestion/capability-scoring-evidence-ingestion-release-qa.ps1`
  now requires at least one concrete `-EvidenceReference` when evidence refs
  are marked passing.
- The same helper now requires `-RecentFailureRateValue` between 0 and 1 when
  the recent failure-rate check is marked passing.
- `scripts/qa/check-product-workflow-evidence.ps1` now requires the generated
  QA output to include non-empty `EvidenceReferences` and numeric
  `RecentFailureRateValue` fields in addition to pass statuses.

## Verification

Run:

```powershell
node scripts\test-capability-scoring-evidence-ingestion-release-qa.mjs
node scripts\test-check-product-workflow-evidence.mjs
```

Both tests pass with complete fixture evidence. The product workflow inventory
still reports `capability-scoring-evidence-ingestion` as a known blocker until
real packaged-app evidence is captured.
