# Agent Memory Embedding Provider QA

This folder contains the packaged-app QA playbook for agent-memory embedding
provider selection.

## Required Evidence

The product workflow gate looks for these filenames:

```text
44-agent-memory-embedding-settings.png
agent-memory-embedding-provider-live-qa-output.txt
```

## Manual Run

1. Copy `agent-memory-embedding-provider-manual-qa-evidence.template.md` to
   `agent-memory-embedding-provider-manual-qa-evidence.md`.
2. Verify local embedding mode in the packaged app.
3. Verify native OpenAI-compatible mode using an OS-secret/key-reference path,
   not a plaintext frontend secret.
4. Exercise vector search/recall against disposable memory facts.
5. Capture `44-agent-memory-embedding-settings.png`.
6. Generate the machine-readable output:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\qa\2026-06-10\agent-memory-embedding-provider\agent-memory-embedding-provider-release-qa.ps1 `
  -LocalEmbedding pass `
  -NativeOpenAiCompatible pass `
  -SecretReference pass `
  -VectorSearch pass
```

The helper records packaged-app provenance and artifact references, but it does
not perform live provider calls by itself.
