# Tech Stack

The current product stack is:

```text
TypeScript + React + Tauri + Rust
```

## Responsibilities

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Desktop UI | React, TypeScript, Vite | Workbench layout, task input, state display, confirmation controls. |
| Core runtime | TypeScript | Routing, plans, agent snapshots, permission state, verification summaries. |
| Tool contracts | TypeScript | Shared file, shell, web, project, permission, and report types. |
| Native bridge | Tauri, Rust | Filesystem access, process checks, HTTP fetch, safety enforcement. |
| Code proposal backend | opencode native CLI | Proposal-only patch generation; writes still go through Javis confirmed-write apply. |
| Tests | Vitest, Cargo test | Core behavior tests and native command safety tests. |

## Why This Stack

React is the fastest path to a rich desktop workbench with visible task state,
confirmation cards, logs, and agent panels.

TypeScript keeps Core, tools, and UI contracts close together. It also leaves a
straightforward path to model SDKs, MCP clients, and future orchestration
libraries.

Tauri gives the project a small desktop shell with a clear native boundary.
Rust is used where local filesystem and process access need stricter handling.

## Current Package Split

```text
apps/desktop          Tauri + React desktop app
packages/core         task runtime and orchestration
packages/tools        tool contracts and shared helpers
packages/ui           reusable workbench UI components
docs                  product, security, QA, and development docs
```

## Product Completion Technology

The following are required for complete product usability, but are not all
implemented yet:

- Search provider integration for research.
- opencode-backed Code Agent. The initial Windows proposal adapter and bundled
  native opencode binary are implemented; live provider QA remains required.
- SQLite or another local persistence layer for task history.
- A reusable confirmed-write approval mechanism.
- Build signing and release artifact verification.

The following remain optional until a specific product workflow needs them:

- LangGraph or another workflow engine.
- MCP server/client adapters.
- Editable agent graph UI.

Add these only when they solve a documented milestone and can stay inside the
existing permission model.
