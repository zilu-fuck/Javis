# Capability Repair Priority Inspector Source QA

Date: 2026-06-11

## Scope

Source-level UI evidence only. This QA does not run packaged app evidence ingestion, live workflows, or screenshots.

## Evidence

- `packages/ui/src/components/inspector/AgentDetailPanel.tsx` derives a repair-priority summary from each selected agent's capability score.
- The summary considers implementation, permission readiness, QA/live status, recent failure rate, and permission risk.
- The Inspector displays a `Repair priority` row with a priority label and concise reasons.
- `packages/ui/src/index.test.tsx` verifies a selected agent with missing QA/live evidence and a 25% recent failure rate displays `Repair priority high` with `live evidence, QA evidence, recent failures`.

## Blockers Remaining

- Product workflow evidence ingestion still needs packaged/live artifacts before `capability-scoring-evidence-ingestion` can pass.
- This source QA does not prove real evidence freshness, screenshot rendering, or packaged app behavior.
