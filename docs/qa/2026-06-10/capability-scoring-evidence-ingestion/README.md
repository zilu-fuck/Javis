# Capability Scoring Evidence Ingestion QA

This folder contains the packaged-app QA playbook for capability scoring product
signals.

## Required Evidence

The product workflow gate looks for these filenames:

```text
45-capability-scoring-evidence-ingestion.png
capability-scoring-evidence-ingestion-qa-output.txt
```

## Manual Run

1. Copy `capability-scoring-evidence-ingestion-manual-qa-evidence.template.md`
   to `capability-scoring-evidence-ingestion-manual-qa-evidence.md`.
2. Verify the packaged app ingests QA evidence, live evidence, evidence
   references, and recent failure-rate signals into capability scoring.
3. Capture `45-capability-scoring-evidence-ingestion.png`.
4. Generate the machine-readable output:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\qa\2026-06-10\capability-scoring-evidence-ingestion\capability-scoring-evidence-ingestion-release-qa.ps1 `
  -QaEvidence pass `
  -LiveEvidence pass `
  -EvidenceRefs pass `
  -RecentFailureRate pass `
  -EvidenceReference docs/qa/YYYY-MM-DD/product-workflows.json#capability-scoring-evidence-ingestion,tool-call-audit://recent-failures/<capability-or-agent> `
  -RecentFailureRateValue 0.25
```

The helper records packaged-app provenance and artifact references, but it does
not fabricate live evidence. Passing evidence-reference and recent-failure-rate
status also requires at least one concrete `-EvidenceReference` value and a
numeric `-RecentFailureRateValue` between 0 and 1.
