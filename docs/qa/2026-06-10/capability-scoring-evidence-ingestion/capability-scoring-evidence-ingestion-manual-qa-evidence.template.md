# Capability Scoring Evidence Ingestion Manual QA Evidence Template

Date: YYYY-MM-DD
Operator: <operator name>
Build: <app version, build id, or executable path>
Result: PENDING
Artifacts: 45-capability-scoring-evidence-ingestion.png, capability-scoring-evidence-ingestion-qa-output.txt

## Scenario Results

- CAPABILITY-QA-01: PENDING
  Evidence: Product QA evidence changed the relevant capability score/status.

- CAPABILITY-QA-02: PENDING
  Evidence: Live evidence changed the relevant capability score/status.

- CAPABILITY-QA-03: PENDING
  Evidence: Inspector displayed concrete evidence references:
  <qa/live evidence ref>, <recent failure evidence ref>

- CAPABILITY-QA-04: PENDING
  Evidence: Recent failure-rate signal was visible and affected scoring.
  Numeric value observed: <0.00-1.00>

## Notes

- Replace every `PENDING` with `PASS` only after packaged-app behavior is
  verified.
- Keep concrete artifact references, but do not paste secrets or raw logs.
