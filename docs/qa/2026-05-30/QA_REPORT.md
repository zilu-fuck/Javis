# QA Report - 2026-05-30

## Scope

Validated the 8 product workflow scenarios requested for the Tauri desktop app using:

- Dev launch command: `cd apps/desktop && pnpm tauri dev`
- Screenshot directory: `docs/qa/2026-05-30/`
- UI automation over WebView2 CDP
- Vitest and Rust tests for Tauri command contracts and workflow behavior

## Results Matrix

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Model Profile configuration | Partial pass | UI opened in dev app and screenshots captured before/after restart. Vitest confirms `save_model_api_key_secret`/delete invoke contract for profiles. CDP could not directly call Tauri globals, so live DPAPI file inspection was not completed from the UI script. |
| 2 | AI file classification | Pass at contract level, partial UI | `local-knowledge.test.ts` and `use-scanned-data.test.ts` cover `scan_all_user_files`, event-driven scan completion, and classification fallback/progress. Dev app document view screenshot captured. Live LLM classification was not run. |
| 3 | RAG-lite document chat | Pass at code path level | `App.tsx` resolves `@file` references via `readFileChunk` and `injectDocumentContext`; QA source file created as `rag-lite-source.txt`. Direct dev-console invoke was unavailable because global Tauri API is not exposed. |
| 4 | ProviderAdapter switching | Pass at contract level | `model-provider.test.ts` confirms provider-specific `complete_model_prompt` and `stream_model_prompt_start` requests are built and invoked. Live provider call was not run with real credentials. |
| 5 | Streaming output | Pass at unit/infra level | `model-provider.test.ts`, `use-task-runtime.test.ts`, and core streaming tests cover stream start, listener ordering, chunk accumulation, and snapshot merging. No live SSE provider run. |
| 6 | Streaming cancel | Pass at unit/infra level | `app-runtime.ts` calls `cancel_all_model_streams` on stop/dispose; Rust command is registered; tests cover cancellation state paths. No live provider cancellation run. |
| 7 | Workflow parallel execution | Pass | `workflow-dag-executor.test.ts` confirms independent DAG steps start in the same batch and execute via `Promise.allSettled`. |
| 8 | Custom workspace CRUD | Pass at backend/contract level, partial UI | Rust `cargo test` covers workspace command implementation/registration; `workspace-loader.ts` invokes load/save/delete commands. Dev app sidebar screenshot captured; no direct CDP invoke due missing global Tauri API. |

## Commands Run

```powershell
pnpm --filter @javis/core test -- workflow-dag-executor.test.ts
pnpm --filter @javis/desktop test -- local-knowledge.test.ts model-provider.test.ts use-model-profiles.test.ts use-scanned-data.test.ts use-task-runtime.test.ts
cargo test # in apps/desktop/src-tauri
powershell -NoProfile -ExecutionPolicy Bypass -File docs/qa/2026-05-30/product-workflows-dev-qa.ps1
```

All test commands completed successfully:

- Core: 1 file, 8 tests passed.
- Desktop: 5 files, 32 tests passed.
- Rust/Tauri: `cargo test` exited 0.

## Screenshots

- `01-model-profiles-configured.png`
- `02-model-profiles-restored.png`
- `03-documents-scan-classify-view.png`
- `04-rag-lite-document-reference.png`
- `05-streaming-cancel-chat-view.png`
- `06-workspace-crud-sidebar.png`

## Known Limitation

The dev WebView target did not expose `window.__TAURI__` or `window.__TAURI_INTERNALS__` to CDP (`hasTauri=false`, `hasInvoke=false` in `product-workflows-dev-qa-results.json`). Because of that, the automation script could capture UI evidence but could not directly invoke Tauri commands from the console. I treated those direct-invoke checks as not executed, and used existing Rust/Vitest coverage for command-level evidence instead.
