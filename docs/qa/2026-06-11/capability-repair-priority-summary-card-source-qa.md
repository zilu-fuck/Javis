# Capability Repair Priority Summary Card Source QA

Date: 2026-06-11

## Scope

Source-level UI evidence only. This QA does not run a packaged app, ingest real live evidence, or capture screenshots.

## Evidence

- `packages/ui/src/components/AgentSummaryCard.tsx` derives a compact capability badge from each agent's capability score.
- The badge shows `ready <score>` when there are no open repair signals, otherwise `repair <priority>`.
- The priority considers implementation, permission readiness, QA/live status, recent failure rate, and permission risk.
- `packages/ui/src/index.test.tsx` verifies an agent summary card with missing QA/live evidence and 25% recent failures displays `repair high`.
- `apps/desktop/src/App.css` adds stable badge styling for ready, low/medium, and high/critical states.

## Blockers Remaining

- Packaged screenshot evidence is still required before the capability scoring workflow can pass product QA.
- This source QA does not prove real product workflow evidence ingestion or evidence freshness.
