# Javis — Local-First Desktop Multi-Agent Workbench

## Project Identity

Javis is a local-first desktop assistant that delegates everyday research and
coding tasks to a team of specialized agents coordinated by the Commander.
The core loop:

```
User Goal → Commander Plan → Agent Tool Execution → Verifier Check → Desktop UI
```

## Architecture Constraints

### Package Boundaries (non-negotiable)

```
apps/desktop → packages/{core, tools, ui}
packages/core → packages/tools
packages/ui   → must NOT depend on Core or Tauri
packages/tools → must NOT depend on desktop implementation details
```

### Core vs Desktop Split

| Layer | Can do | Cannot do |
|---|---|---|
| `packages/core/` | Pure TypeScript types, constants, prompt templates, pure functions | `ModelProvider.complete()`, Tauri invoke, file I/O |
| `apps/desktop/` | Tauri invoke, ModelProvider, actual LLM calls, file I/O | — (can call core pure functions) |

**Rule**: Anything needing `ModelProvider.complete()` lives in `apps/desktop/src/`.
Core only holds pure data/functions (prompt templates, scoring schemas, terminology, type definitions).

### Native Safety Boundary

Rust (`src-tauri/src/lib.rs`) is the final enforcement layer for local writes.
Every write-capable command must go through:

1. UI confirmed-write approval card
2. Native approval binding (approval ID, tool, preview hash, task ID)
3. Path/scope guard (workspace containment, no traversal)
4. One-shot consumption (approval consumed after first use)

## Key Commands

```bash
pnpm dev                 # Start Tauri dev server
pnpm check               # Full validation: typecheck + Vitest + Rust
pnpm -r typecheck        # TypeScript type checking only
pnpm -r --if-present test  # Vitest tests only
pnpm rust:check          # Rust type checking only
pnpm rust:test           # Rust tests only
```

## Code Conventions

- Task statuses: `created → planning → running → waiting_permission → running → verifying → completed`
- Agent kinds: `commander | file | shell | browser | computer | scheduler | research | code | verifier | chinese-reviewer`
- Permission levels: `read | preview | confirmed_write | dangerous`
- Tool names follow `{category}.{action}` pattern (e.g., `code.inspectRepository`, `file.scanMarkdownDocuments`)
- Agent system prompts are bilingual (`en` + `zhCN`) using `AgentPromptSet`
- Context keys in `shared-context.ts` are bilingual (`CONTEXT_KEYS`)
- Chinese review pipeline: input preprocessor → terminology injection → LLM → ChineseReviewer → output

## Test Expectations

- New features require tests (Vitest for TS, Rust tests for native commands)
- `pnpm check` must pass before committing
- Rust tests cover: missing approval, wrong task ID, wrong tool, expired approval, stale hash, path traversal, symlink escape, wrong extension, stale file hash
- QA evidence stored in `docs/qa/YYYY-MM-DD/`

## Security Model

- All write paths → confirmed-write approval → native guard
- API keys: Windows DPAPI / OS credential store (never localStorage)
- localStorage only: provider, model, baseUrl, key reference
- Default deny for dangerous operations
- opencode/Code Agent: proposal only, never writes files directly
- PDF operations: Downloads-scoped, move-only, one-time approval

## Current State (2026-05-27)

- Desktop workbench: implemented and packaged (Windows MSI/NSIS)
- File scan, project inspection, research, PDF organization: implemented
- Code Agent (opencode-backed): fixture QA passes (deny + approve), live DeepSeek QA needs reqwest request debugging
- Chinese optimization: input preprocessor + terminology + reviewer agent done
- Streaming output: Rust SSE backend fully implemented (background thread → Tauri events → frontend AsyncGenerator), task-flow UI consumption TBD
- Persistence: model-settings in SQLite; task history, approval records, workspaces still in localStorage pending migration
- Multi-agent workflow executor: implemented (DAG with parallel step support)
- SQLite infrastructure: database.rs with rusqlite, Tauri commands, migration system, model-settings already migrated
- HTTP client: reqwest 0.12 with native-tls (not ureq — project has never used ureq)
