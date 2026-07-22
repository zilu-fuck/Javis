# LangChain Phase 2 Read-only POC QA

Date: 2026-07-19

## Scope

- Exact browser-compatible runtime dependencies: `langchain@1.5.3`, `@langchain/core@1.2.3`, and `@langchain/langgraph@1.4.8`.
- The production POC is limited to the `research` agent and exposes only the current agent's read-only tool descriptors.
- LangChain tools call the shared Core read-only gateway, which validates MCP input schemas before dispatching through the existing Javis ReAct tool executor.
- No LangGraph checkpointer or Node SQLite dependency is configured. `pnpm --filter @javis/desktop why better-sqlite3` returned no dependency.
- Cancellation, model timeout, model-call limit, tool timeout/failure, token usage, and terminal runtime events are covered by automated tests.

## Automated verification

| Check | Result |
| --- | --- |
| `pnpm --filter @javis/core test -- src/agent-runtime src/workflow-executor.test.ts` | PASS — 4 files, 131 tests |
| `pnpm --filter @javis/desktop test -- src/agent-runtime` | PASS — 7 files, 35 tests |
| `cargo test model_chat --lib` | PASS — 22 tests |
| `pnpm --filter @javis/desktop exec tsc --noEmit` | PASS |
| `pnpm desktop:build` | PASS — Vite production bundle, release executable, NSIS installer, and local-vision release resource check |

The packaged executable `apps/desktop/src-tauri/target/release/javis-desktop.exe` remained running after a five-second hidden startup smoke test and was then stopped by the QA command.

Installer artifact:

- Path: `apps/desktop/src-tauri/target/release/bundle/nsis/Javis_0.1.0_x64-setup.exe`
- Size: 132,070,192 bytes
- SHA-256: `D724AFBAC8074A40E1EDD28C460AD3E15DFD44DA7FE3B2A08271F08FC53A5AE4`

## Real-provider acceptance

`pnpm qa:langchain-poc:live` runs an opt-in Vitest harness against a real DeepSeek model. The harness instantiates `createLangChainAgentRuntime` and `JavisChatModel`, dispatches `web.search` through the shared Core read-only gateway, and validates the alias/canonical-name mapping, tool-call ID continuity, tool events, final answer, and usage without printing the API key.

Current environment result: **BLOCKED** — `DEEPSEEK_API_KEY` is not set. The script returned structured status `blocked` and exited non-zero; no fixture or mocked response was substituted for this acceptance item.

The implementation and packaged smoke criteria are complete. Phase 2's external real-model acceptance remains pending until the credential is supplied and the live command passes.
