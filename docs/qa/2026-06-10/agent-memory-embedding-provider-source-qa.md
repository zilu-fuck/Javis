# Agent Memory Embedding Provider Source QA

Date: 2026-06-10

## Scope

This source-level QA records runtime wiring for agent-memory embedding provider
selection. It does not claim packaged/live provider readiness.

## Source Changes

- `apps/desktop/src/agent-memory-embedding-provider.ts` now supports a native
  OpenAI-compatible embedding executor dependency.
- `apps/desktop/src-tauri/src/lib.rs` adds `embed_model_texts`, which reads the
  configured model API key by reference on the native side and calls
  `/embeddings`.
- `apps/desktop/src/App.tsx` now creates the agent-memory embedding provider
  from current runtime preferences instead of hardcoding local embeddings.
- `scripts/qa/check-product-workflow-evidence.ps1` now includes
  `agent-memory-embedding-provider-live` as a known blocker.

## Security Notes

The frontend passes provider id, model, base URL, key reference, and texts to
native code. It does not receive or log the API key. The native command returns
only vectors.

## Remaining Blocker

Packaged/live evidence is still required for local embeddings,
OpenAI-compatible embeddings, secret-reference redaction, and vector search.

## Verification

Run:

```powershell
.\node_modules\.bin\vitest.CMD run apps/desktop/src/agent-memory-embedding-provider.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p apps\desktop\tsconfig.json
cargo test creates_openai_compatible_embeddings_endpoint
node scripts/test-check-product-workflow-evidence.mjs
```
