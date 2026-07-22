# LangChain Phase 4 Streaming and Persistence QA

Date: 2026-07-19

## Scope

- The production LangChain runner uses `agent.stream()` when the selected model gateway declares `streamingToolCalls: true`; gateways without that capability keep the non-streaming `agent.invoke()` path.
- `JavisChatModel` text deltas, usage, and tool-call lifecycle events are projected into the existing `TaskSnapshot` streaming fields and logs.
- Structured output uses LangChain provider strategy only when the provider declares native structured output. Other providers use LangChain tool strategy with error auto-retry disabled.
- Workflow checkpoints persist Agent-runtime aggregate metrics and task token usage. Resuming seeds both aggregates instead of resetting them.
- A completed checkpoint skips the completed Commander step. The resume regression test verifies that the LangChain runtime, model loop, and already-executed tool are not called again.

## Streaming acceptance

The real LangChain runner fixture performs one ordered model/tool/model loop through `agent.stream()` and asserts the complete `AgentEvent` sequence. It receives each text delta, usage update, tool request/start/completion, and terminal event exactly once.

The Commander projection fixture asserts these distinct UI text states:

```text
"" -> "Rust " -> "Rust result"
```

It also asserts exactly one planned, one waiting, and one completed log for the same tool-call ID, in that order. The terminal snapshot has `isStreaming: false`, two model calls, one tool call, and the expected combined token total.

## Persistence decision

Phase 4 does not add a LangGraph checkpointer or a Rust custom saver. Javis already owns task-level durable recovery through its workflow checkpoint and SQLite store. Adding a second checkpoint domain would create competing replay boundaries and increase the risk of executing a tool twice.

The current read-only LangChain step is therefore treated as an atomic workflow step:

- checkpoints persist only framework-neutral Javis state;
- completed step IDs are the authoritative replay boundary;
- a resumed completed step does not recreate the Agent runtime or call its tool;
- metrics and token usage remain continuous across the restart.

`pnpm why better-sqlite3` and `pnpm why @langchain/langgraph-checkpoint-sqlite` return no installed dependency. The transitive `@langchain/langgraph-checkpoint` protocol package remains part of LangGraph, but no saver is configured by Javis.

This decision should be revisited only if a future Agent step must resume inside a multi-tool loop. At that point the saver must share Javis approval bindings and idempotency boundaries before write-capable tools are eligible.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --filter @javis/core exec vitest run src/agent-runtime src/workflow-checkpoint.test.ts src/workflow-checkpoint-reconciliation.test.ts src/workflow-executor.test.ts` | PASS — 166 tests |
| `pnpm --filter @javis/desktop exec vitest run src/agent-runtime src/workflow-checkpoint-store.test.ts` | PASS — 51 tests, 1 opt-in live test skipped |
| `pnpm typecheck` plus desktop `tsc --noEmit` | PASS |
| dependency inspection for `better-sqlite3` and the SQLite LangGraph saver | PASS — neither is installed |

The opt-in live test still requires `DEEPSEEK_API_KEY`; missing external credentials are reported as a blocked live acceptance rather than a local pass.
