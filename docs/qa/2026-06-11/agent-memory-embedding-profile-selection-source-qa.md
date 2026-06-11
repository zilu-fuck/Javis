# Agent Memory Embedding Profile Selection Source QA

Date: 2026-06-11

## Scope

Source-level UI and preference wiring only. This QA does not call a real embedding provider, run packaged app flows, capture screenshots, or validate live vector search.

## Evidence

- `packages/ui/src/components/ModelSettings.tsx` exposes Agent memory semantic recall settings in Privacy.
- OpenAI-compatible embedding mode keeps manual provider/model/base URL/key reference/dimensions fields.
- When configured OpenAI-compatible model profiles exist, the embedding settings can reuse one profile as a configured source.
- Selecting a configured source updates `agentMemoryEmbeddingProvider`, `agentMemoryEmbeddingModel`, `agentMemoryEmbeddingBaseUrl`, and `agentMemoryEmbeddingApiKeyReference` together.
- `packages/ui/src/components/ModelSettings.test.tsx` verifies the configured-source selection updates runtime preferences without requiring a live provider.

## Blockers Remaining

- `agent-memory-embedding-provider-live` remains blocked until packaged/live evidence proves local embeddings, native OpenAI-compatible embeddings, secret-reference redaction, and vector search.
- This source QA does not prove a provider credential exists or that a live embedding endpoint returns vectors.
