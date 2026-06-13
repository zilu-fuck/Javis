# AGENTS.md — Javis

## Quick Reference

```bash
pnpm dev                    # Tauri desktop dev (Vite + Rust)
pnpm check                  # Full gate: typecheck + test + rust:check + build
pnpm typecheck              # TS only (all packages)
pnpm test                   # Vitest (all packages) + cargo test
pnpm rust:check             # cargo check
pnpm rust:test              # cargo test
pnpm --filter @javis/desktop build   # Frontend bundle only
pnpm desktop:build          # Full Windows installer (NSIS)
```

`pnpm check` is the CI gate. Run it before finishing any non-trivial change.

## Monorepo Layout

```
apps/desktop        → Tauri + React app (@javis/desktop)
  src/              → TS: React UI, persistence, model provider, hooks
  src-tauri/src/    → Rust: native commands, DB, HTTP, sandbox, streaming
packages/core       → Pure TS: types, prompts, routing, agent logic (@javis/core)
packages/tools      → Tool contracts, permission levels (@javis/tools)
packages/ui         → Reusable UI components (@javis/ui)
scripts/            → QA, release, local-vision helpers (Node + PowerShell)
```

## Package Boundaries (enforced, not advisory)

```
apps/desktop → packages/{core, tools, ui}
packages/core → packages/tools
packages/ui   → must NOT depend on core or Tauri
packages/tools → must NOT depend on desktop implementation details
```

**Core vs Desktop**: Anything needing `ModelProvider.complete()`, Tauri invoke, or file I/O lives in `apps/desktop/src/`. `packages/core/` holds only pure data/functions — prompt templates, scoring schemas, terminology, type definitions.

## Native Safety Model

Rust (`src-tauri/src/`) is the final enforcement layer for local writes. Every write-capable command requires:

1. UI confirmed-write approval card
2. Native approval binding (approval ID, tool, preview hash, task ID)
3. Path/scope guard (workspace containment, no traversal)
4. One-shot consumption (approval consumed after first use)

Never bypass this for convenience. See `CONTRIBUTING.md` for the full safety checklist.

## Testing

- **TS tests**: Vitest. Run per-package with `pnpm --filter @javis/core test` or all with `pnpm test`.
- **Rust tests**: `pnpm rust:test` (runs `cargo test` in `apps/desktop/src-tauri`).
- **QA scripts**: `pnpm qa:product-workflows` and `pnpm qa:computer-use` check evidence files, not just unit logic.
- Rust tests cover security edge cases: missing approval, wrong task ID, wrong tool, expired approval, stale hash, path traversal, symlink escape, wrong extension, stale file hash.
- QA evidence goes in `docs/qa/YYYY-MM-DD/`.
- New features require tests. No exceptions.

## TypeScript Config

- `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true` — enforced project-wide via `tsconfig.base.json`.
- Module resolution: `bundler` mode, `ESNext` modules.
- JSX: `react-jsx` (no React import needed).

## Rust Config

- Edition 2021, `rusqlite` with bundled SQLite, `reqwest` with native-tls.
- lib.rs is split into ~21 modules (anthropic, browser, code, database, files, git, shell, streaming, terminal, web, etc.).
- Windows-specific deps gated behind `cfg(windows)` — `windows` and `windows-sys` crates for DPAPI, job objects, accessibility.

## CI

- Runs on `windows-latest` only.
- pnpm 10.32.1, Node 22, Rust stable.
- Single job: `pnpm install --frozen-lockfile` then `pnpm check`.

## Domain Vocabulary

- **Commander**: Main planning agent, coordinates all sub-agents.
- **Agent kinds**: `commander | file | shell | browser | computer | scheduler | research | code | verifier | chinese-reviewer`
- **Permission levels**: `read | preview | confirmed_write | dangerous`
- **Task statuses**: `created → planning → running → waiting_permission → running → verifying → completed`
- **Tool names**: `{category}.{action}` pattern (e.g., `code.inspectRepository`, `file.scanMarkdownDocuments`)
- **Agent prompts**: Bilingual (`en` + `zhCN`) via `AgentPromptSet`
- **Context keys**: Bilingual in `shared-context.ts`

## API Keys

- Desktop uses Windows DPAPI / OS credential store — never localStorage.
- Test scripts read env vars only (`DEEPSEEK_API_KEY`, `JAVIS_OPENCODE_LIVE_API_KEY`).
- Never commit keys, tokens, or secrets. Provider logs must redact sensitive fields.

## Streaming Architecture

End-to-end: Rust SSE backend (background thread → Tauri events) → model-provider AsyncGenerator → eventBus → delta-reducer → `TaskSnapshot.streamingText` → `ThreadView` + `useSmoothStream` typewriter animation. Cancel via `cancel_all_model_streams`. Fallback to non-streaming on failure.

## Persistence

Fully SQLite. Tables: task history, approval records, scheduled tasks, user preferences, JSONL logs, model settings, model profiles. Migration system in `database.rs` with 9 migration sets.
