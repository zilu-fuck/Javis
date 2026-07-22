# LangChain Phase 3 Commander Rollout QA

Date: 2026-07-19

## Scope

- `executeStepWithReAct` selects an `AgentRuntime` backend with both the assigned Agent kind and the current task ID.
- Legacy remains the default and rollback path.
- `javis.agentRuntimeRollout` accepts bounded JSON arrays named `agentKinds` and `taskIds`. A matching Agent kind or exact task ID opts the read-only step into LangChain.
- The Phase 2 `javis.agentRuntimeBackend=langchain` research-only switch remains backward compatible.
- A provider that explicitly disables native Tool Call always resolves to legacy, regardless of rollout flags.
- LangChain steps continue to use only read descriptors through the shared gateway; this phase does not expand permissions.
- Phase 3 explicitly sends `parallelToolCalls: false`, preserving the legacy loop's deterministic sequential artifact semantics until ordered multi-call aggregation is designed.

Example controlled rollout value:

```json
{
  "agentKinds": ["research", "code"],
  "taskIds": ["task-canary-001"]
}
```

Malformed, oversized, or non-array rollout values fail closed and do not enable additional Agents or tasks.

## Semantic parity

The desktop Commander parity test runs identical research input against the legacy loop and the real `createLangChainAgentRuntime`/`JavisChatModel` path for:

- completion: one read tool call, persisted context output, matching handoff state, completed task;
- failure: with recovery disabled for the parity fixture, no tool call, failed task and `task.failed` event;
- `request_input`: with recovery disabled for the parity fixture, requested key retained in logs, no output artifact, failed task and `task.failed` event.
- invalid `request_input`: duplicate keys fail the whole run in both backends instead of being filtered or silently deduplicated.

Both backends now use the same bounded request-input validator, including the 16-key limit, duplicate/format rejection, and live registered-Agent check. The real parity test compares the complete durable event-kind sequence, task status, tool-call count, output artifact payload, handoff status, and request-input signal. Successful workflows emit and persist `task.completed`; failed and request-input workflows end in `task.failed`. Core seam tests separately verify replan counts and confirm missing input context fails before backend selection or AgentRuntime creation.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @javis/core exec vitest run src/workflow-executor.test.ts` | PASS — 123 tests |
| `pnpm --filter @javis/desktop exec vitest run src/agent-runtime/create-agent-runtime.test.ts` | PASS — 9 tests |
| `pnpm --filter @javis/desktop exec vitest run src/agent-runtime` | PASS — 44 tests, 1 opt-in live test skipped |
| `pnpm typecheck` | PASS |

Independent Phase 3 review and any resulting fixes are recorded by the task handoff before Phase 4 begins.
