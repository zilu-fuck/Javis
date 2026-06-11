# Commander Planning Rules Source QA

Date: 2026-06-11

## Scope

This source-level QA records generic Commander planning contract hardening for
optimization requests, proposal self-review, and multi-agent handoffs. It does
not claim packaged product readiness or model-behavior proof.

## Source Changes

- `packages/core/src/commander-plan-schema.ts` now tells Commander to clarify
  vague optimization requests by identifying the target artifact and
  optimization dimension before planning edits.
- Risky designs, migrations, and implementations now require an explicit review
  step before execution. The review step must depend on the proposal/design
  output and record unreasonable assumptions, missing evidence, and a revised
  plan or explicit no-change decision.
- Multi-agent handoffs now have a concrete contract: producer steps must write
  `outputContextKey`, receiving steps must list it in `inputContextKeys`, and
  `successCriteria` must name the handoff artifact plus acceptance evidence.
- `packages/core/src/commander-plan-schema.test.ts` locks these rules in the
  English planning prompt.

## Remaining Risk

These rules improve model planning instructions, but product readiness still
requires real workflow evidence that Commander follows them across packaged
tasks and that the UI exposes handoff/review evidence clearly.

## Verification

Run:

```powershell
corepack pnpm --filter @javis/core test -- src/commander-plan-schema.test.ts
```
