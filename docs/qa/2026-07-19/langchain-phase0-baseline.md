# LangChain migration Phase 0 baseline

Date: 2026-07-19

## Scope

This baseline freezes the backend-neutral Agent Runtime contracts while the
production rollout default remains `legacy`. Every ReAct run now records an
aggregate in `TaskSnapshot.agentRuntimeMetrics`; task-history sanitization
preserves the aggregate for completed-task comparison.

The persisted aggregate contains:

- completed runs / all runs and success rate;
- total and average latency in milliseconds;
- model-call and tool-call counts;
- token usage when the provider reports it (missing usage remains unknown).

## Deterministic legacy fixture

The `caps MCP subtools exposed to ReAct decisions` workflow contract fixture
records the following baseline:

| Metric | Value |
| --- | ---: |
| Runs | 1 |
| Completed runs | 1 |
| Success rate | 100% |
| Model calls | 2 |
| Tool calls | 1 |
| Input tokens | 7 |
| Output tokens | 3 |
| Total tokens | 10 |
| Latency | Recorded from the run clock; intentionally not fixed in the test |

## Verification

```text
corepack pnpm typecheck
PASS

packages/core:
vitest run src/agent-runtime src/agent-react-loop.test.ts src/workflow-executor.test.ts
5 files passed, 205 tests passed

apps/desktop:
vitest run src/agent-runtime src/task-history.test.ts src/app-runtime.test.ts
8 files passed, 128 tests passed
```

The contracts additionally cover observer isolation, missing token usage,
post-tool model failure accounting, exact terminal event ordering, and
task-history round trips.
