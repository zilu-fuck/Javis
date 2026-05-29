# P0-2a Static Function QA Checklist

> Run with `pnpm dev` (Tauri desktop). Check off each scenario and capture screenshots.

## Scenarios

| # | Scenario | Steps | Expected | Result |
|---|----------|-------|----------|--------|
| 1 | Model Profile config | Settings → configure 3 slots → restart | 3 slots retained, agents use correct slots | ⬜ |
| 2 | Agent Capability matching | Create code task vs research task | Different agents use different models | ⬜ |
| 3 | AI file classification | Scan project directory → view category labels | Files auto-classified, filterable | ⬜ |
| 4 | RAG-lite document chat | Chat input `@` → select file → ask question | AI responds based on doc content | ⬜ |
| 5 | ProviderAdapter switching | Settings → switch provider | Works without code changes | ⬜ |
| 6 | User preferences persistence | Change language/thinking mode → restart | Retained after restart | ⬜ |
| 7 | JSONL log import | First startup triggers migration | Old JSONL data in SQLite | ⬜ |
| 8 | Workflow parallel execution | Trigger read-current-project, observe step timing | DAG parallel steps fire together | ⬜ |
| 9 | Desktop UI Chrome | Titlebar minimize/maximize/close/drag | All operations normal | ⬜ |

## P0-2b Streaming Scenario

| # | Scenario | Steps | Expected | Result |
|---|----------|-------|----------|--------|
| 10 | Context Ring streaming | Streaming chat → observe token ring | Ring updates in real-time | ⬜ |
