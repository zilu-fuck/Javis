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

- **称呼规则**：每次回答或总结之前，必须以"哥哥"作为称呼开头。
- Task statuses: `created → planning → running → waiting_permission → running → verifying → completed`
- Agent kinds: `commander | file | shell | browser | computer | scheduler | research | code | verifier | chinese-reviewer`
- Permission levels: `read | preview | confirmed_write | dangerous`
- Tool names follow `{category}.{action}` pattern (e.g., `code.inspectRepository`, `file.scanMarkdownDocuments`)
- Agent system prompts are bilingual (`en` + `zhCN`) using `AgentPromptSet`
- Context keys in `shared-context.ts` are bilingual (`CONTEXT_KEYS`)
- Chinese review pipeline: input preprocessor → terminology injection → LLM → ChineseReviewer → output

## Dual-Model Setup

This project uses two models simultaneously:

| Role | Model | Provider | Purpose |
|---|---|---|---|
| **Commander** (current session) | `deepseek-v4-pro` | DeepSeek API | Main conversation, planning, coordination |
| **Sub-agents** (via CLI) | `mimo-v2.5-pro` | Xiaomi Mimo (`token-plan-cn.xiaomimimo.com`) | Code review, research, file analysis |

### Sub-Agent Routing

When delegating work to sub-agents, do NOT use the built-in `Agent` tool (it runs on DeepSeek).
Instead, route through the Mimo CLI wrapper:

```bash
# Argument mode
bash ~/.claude/scripts/mimo-agent.sh "self-contained prompt"

# Stdin mode (for long prompts with special characters)
echo "self-contained prompt" | bash ~/.claude/scripts/mimo-agent.sh
```

**Why**: The Mimo terminal has stronger file analysis and reasoning capabilities at a lower cost, so offloading sub-agent work there saves DeepSeek quota for planning and coordination.

**Key constraints**:
- `claude -p` is stateless — every prompt must be fully self-contained (include file paths, context, expected output format)
- The Mimo instance runs as a one-shot process; it cannot ask follow-up questions
- Shell env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) from the current session override settings.json `env`, so the wrapper script explicitly exports Mimo config and unsets DeepSeek vars

### Script Location

`~/.claude/scripts/mimo-agent.sh` — exports Mimo API config, unsets DeepSeek vars, runs `claude -p --model mimo-v2.5-pro`.

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

## Current State (2026-05-30)

- Desktop workbench: implemented and packaged (Windows MSI/NSIS), custom titlebar with drag regions
- File scan, project inspection, research, PDF organization: implemented
- AI file classification: classifyDocuments with LLM, 8 predefined categories, progress callbacks
- RAG-lite: @document references in chat input inject file content into prompts
- Code Agent (opencode-backed): fixture QA passes (deny + approve), live DeepSeek QA needs reqwest request debugging
- Chinese optimization: input preprocessor + terminology injection + ChineseReviewer agent done
- Streaming output: end-to-end complete — Rust SSE backend (background thread → Tauri events), model-provider AsyncGenerator wrapping, eventBus → delta-reducer → TaskSnapshot.streamingText, ThreadView StreamingMessage + useSmoothStream typewriter animation, cancel via cancel_all_model_streams, automatic fallback to non-streaming on failure
- Persistence: fully migrated to SQLite — task history, approval records, scheduled tasks, user preferences, JSONL logs, model settings, model profiles
- Multi-agent workflow executor: implemented (DAG with parallel step support via Promise.allSettled)
- Agent Capability Model: capability tags per agent kind, ModelRequirements (prefersVision, prefersCode, minContextTokens)
- Model Profile system: 3 configurable slots (primary/secondary/tertiary), capability-aware profile scoring
- ProviderAdapter: abstracted provider protocol (OpenAI, DeepSeek, Anthropic adapters)
- Custom workspace registration: workspace definitions (JSON) with agents, workflows, routes, dynamic sidebar nav
- Architecture analysis: AGENT_ARCHITECTURE_ANALYSIS.md — Plan 1/5, Multi-Agent 4/5, HITL 2/5
- SQLite infrastructure: database.rs with rusqlite, Tauri commands, migration system, 9 migration sets
- HTTP client: reqwest 0.12 with native-tls
- **5.29**: lib.rs module split (42 files, +6332/-4269), JavisError enum + module-level tests, P0-1 streaming UI consumption + integration tests + eventBus leak fix
- **5.30**: quality hardening sprint — complete
  - P0-1: Hook test coverage — 4 files, 28 tests (use-scanned-data 12, use-task-runtime 6, use-scheduled-tasks 5, use-model-profiles 4)
  - P0-2: Manual QA — 8 scenarios validated via Tauri dev app + CDP, 6 screenshots, evidence in `docs/qa/2026-05-30/`
  - P0-3: Docs updated — CLAUDE.md current state, task plan, QA report
  - P1-1: JavisError migration — code.rs 20 functions + `require_native_approval_binding` → Permission variant
  - P1-2: Dead code + clippy — 14 warnings fixed (scan/pdf/lib/workspace/web/code), 2 remaining (scan.rs too-many-args)
  - Final: 430 Vitest + 125 Rust = 555 total tests, pnpm check green
