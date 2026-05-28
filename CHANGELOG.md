# Changelog

All notable changes to Javis are documented here. Versions follow
`major.minor.patch` (semantic versioning adapted for Windows MSI constraints:
major/minor ≤ 255, patch ≤ 65535).

## 0.1.0 (2026-05-28)

### Desktop Workbench
- Tauri + React + Vite desktop shell with sidebar navigation (chat / skills / apps / documents / gallery / computer)
- Workspace management with recent paths, browse dialog, and path-based task isolation
- Task history with persistence (SQLite + localStorage fallback)
- Scheduled task engine with enable/disable, crontab-like scheduling, and focus-aware triggering
- Skill marketplace UI showing tools, agents, and MCP server entries
- Model settings panel with provider/model/API key/base URL configuration

### Multi-Agent Workflow Engine
- 10 agent types: commander, file, shell, code, verifier, research, browser, computer, scheduler, chinese-reviewer
- DAG executor with parallel step support (`Promise.allSettled`), deadlock detection
- Commander-driven planning → execution → verification loop
- Shared task context between parallel/sequential steps
- Agent state tracking with queued → running → completed/failed lifecycle
- Workflow blueprints: read-current-project, research-trending-topics, find-local-document, daily-reminder, plan-spring-boot-project

### Core Workflows
- **Read Current Project**: parallel file scan + project inspection + code analysis → verifier synthesis
- **Research**: web search → source fetch → merge & deduplicate → source-backed evidence report
- **Code Review**: git status/diff collection → opencode-backed proposals → confirmed-write patch apply
- **PDF Organization**: Downloads-scoped category inference → dry-run approval card → native guarded moves
- **General Chat**: natural-language fallback when no workflow matches

### Streaming Output
- Rust SSE backend (background thread → Tauri events → frontend `AsyncGenerator`)
- `DeltaReducer` accumulates streaming chunks with configurable update rate
- Stop task support (`cancel_all_model_streams`)

### Model Configuration
- Multi-slot model profiles (primary / secondary / multimodal) with per-agent overrides
- SQLite-persisted model profiles with legacy `modelSettings` auto-migration
- API keys stored via Windows DPAPI / OS credential store (never localStorage)
- Provider cache with `clearProviderCache()` on config change

### Chinese Language Optimization
- Input preprocessor (disambiguates user intent before workflow routing)
- Terminology injection pipeline
- LLM-based Chinese style reviewer agent
- Error localization for Chinese users

### Approval & Security
- Confirmed-write approval model: dry-run preview → user card review → native guard → one-shot consumption
- Approval binding: approval ID × tool name × preview hash × task ID × path containment
- Rust native guards: workspace containment, no traversal, stale hash rejection, wrong extension rejection
- Durable approval records (SQLite) survive restart for pending approvals

### Rust Backend
- `read_file_chunk`: safe file content reading (64KB limit, UTF-8 lossy, line-limited)
- `scan_markdown_documents`, `scan_user_documents`, `scan_user_images`, `scan_installed_apps`
- `list_directory` with canonicalization-based path traversal protection
- `run_read_only_command` with allowlist: node, pnpm, git, cargo, go, python, deno
- `fetch_web_source`, `search_web_sources`
- Code patch engine: proposal generation → verify → apply with git HEAD guard
- `model_api_key_secret`: OS credential store read/write/delete

### Testing
- 210 TypeScript tests (core 91 + desktop 97 + ui 22)
- 75 Rust tests covering approval guards, path traversal, symlink escape, expired records
- Release gate: `pnpm check` = typecheck + Vitest + Rust tests + Rust check + Vite build

### Known Limitations
- `@mention` document references require file paths without spaces (path spaces: known, deferred)
- `classifyDocuments` batches 50 files per LLM call; no incremental re-classification
- `read_file_chunk` limited to 64KB and 200 lines; large files truncated silently
- `allowDowngrades: false` in Tauri config — rollback requires uninstall first
- No code signing in dev builds; signed releases require `build-windows-signed.ps1`
