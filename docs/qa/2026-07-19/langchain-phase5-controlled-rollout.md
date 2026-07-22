# LangChain Phase 5 controlled rollout QA

Date: 2026-07-19

## Implemented scope

- Commander ReAct routes now report the actual backend by provider, Agent kind,
  and task permission type (`read` or `preview`). Intentional legacy routes are
  excluded from the rollout fallback denominator.
- Routing observations distinguish LangChain, legacy fallback, and unavailable
  runtime outcomes. Fallback reasons cover provider capability, missing runtime
  factories, runtime initialization failures, and eligible-tool failures.
- Observation IDs use `runId:stepId:attempt-N` (or a bounded hash prefix for
  unusually long IDs). Checkpoint restore continues the attempt sequence, and
  durable `agent.runtime_routed` events use a deterministic event ID. The event
  is structural, so runtime-event compaction retains it for later aggregation.
- Routing metrics are carried by `TaskSnapshot`, workflow checkpoints, and task
  history. Checkpoint and task-history readers reject malformed counts, rates,
  duplicate dimensions/reasons, and duplicate observation IDs.
- The migrated gateway accepts only `read` and explicitly selected `preview`
  descriptors. `confirmed_write` and `dangerous` are rejected unconditionally at
  runtime, including if an untyped caller injects those levels into configuration.
- Direct deterministic workflows continue to bypass Agent runtime routing.

## Fail-closed rollout configuration

`javis.agentRuntimeRollout` must identify both the rollout scope and an exact
provider/model profile that has been verified outside the application. Preview
also requires an exact tool-name allowlist. Example:

```json
{
  "agentKinds": ["file"],
  "taskIds": ["task-canary-001"],
  "permissionLevels": ["read", "preview"],
  "previewToolNames": ["file.planPdfOrganization"],
  "verifiedModelProfiles": [
    { "provider": "openai", "model": "gpt-canary-verified" }
  ]
}
```

An Agent/task match without an exact verified profile remains legacy. An unknown
provider remains legacy even if its name appears in `verifiedModelProfiles`; it
cannot inherit the generic OpenAI adapter's optimistic capability defaults.
Capability-only preview steps remain legacy because they do not declare an exact
`toolName`. The global `javis.agentRuntimeBackend=langchain` switch expands only
read routes and still requires the exact verified profile list above.

## Provider evidence

The typed gateway and Rust protocol fixtures cover OpenAI, DeepSeek, and
Anthropic request/response formats, including provider-native tool calls and
streaming argument events. These fixtures validate protocol implementation, not
a live endpoint/model profile. A profile must not be added to
`verifiedModelProfiles` until its non-streaming and streaming
model → tool → model → final loop passes with real credentials.

The opt-in DeepSeek live test remains skipped when `DEEPSEEK_API_KEY` is absent.
No live provider/model claim is made by this QA record.

## Verification completed in this iteration

| Check | Result |
| --- | --- |
| Core strict typecheck | PASS |
| Desktop strict typecheck | PASS |
| Independent review rerun, Core | PASS — 132 tests |
| Independent review rerun, Desktop | PASS — 55 tests |
| `pnpm check` after review fixes | PASS — Tools 9, UI 199, Core 978, Desktop 936 + 1 skipped, Rust 563 |
| `pnpm qa:computer-use` | PASS |
| `pnpm qa:product-workflows` | PASS inventory checker; known live/package evidence blockers remain |

Focused coverage includes explicit preview dispatch, write hard-deny, provider
and model fail-closed selection, fallback denominator/reasons, durable routing
events, checkpoint/event resume deduplication, malformed persistence inputs, and
direct workflow regression.

## Legacy deletion gate

The legacy ReAct loop is intentionally retained. Phase 5 deletion remains
blocked until all of the following are complete:

1. Every rollout-targeted provider/model profile passes real non-streaming and
   streaming native Tool Call acceptance.
2. Packaged UI restart QA proves a completed step is not replayed and only its
   downstream step resumes, with SQLite checkpoint/event evidence.
3. Product workflow and computer-use QA blockers are cleared.
4. A final static reference gate reports no production references to
   `runAgentReActLoop`, `reactDecideNext`, `buildReActDecisionPrompt`, or
   `parseAgentReActDecision`.

Until those gates pass, unsupported or untargeted paths must keep the legacy
backend; removing it would turn controlled fallback into a production outage.
