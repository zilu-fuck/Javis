# Capability Repair Priority Source QA

Date: 2026-06-11

## Scope

Source-level ranking only. This QA does not ingest real packaged app evidence, run live workflows, or capture screenshots.

## Evidence

- `packages/core/src/agent-capability.ts` exposes `rankAgentRepairPriorities`.
- The ranking is generic across agents and capability tags; it does not hardcode a single product workflow.
- Inputs are existing `AgentCapabilityScore` records, including implementation status, permission readiness, QA/live status, recent failure rate, permission level, capability tags, gaps, and evidence refs.
- Outputs include priority label, numeric score, reasons, next-evidence hints, capability tags, and evidence refs.
- `packages/core/src/agent-capability.test.ts` verifies blocked QA/live evidence plus recent tool failures rank ahead of ready agents, and missing descriptors plus dangerous permissions become critical repair work.

## Blockers Remaining

- Product UI surfacing of the repair-priority list still needs design and packaged evidence.
- Real product workflow ingestion remains blocked until packaged/live evidence artifacts are captured.
