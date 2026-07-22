# LangChain migration Phase 1 protocol evidence

Date: 2026-07-19

## Contract coverage

- Backend-neutral messages, tool specifications, tool calls, responses, usage,
  and stream events are defined in `@javis/core`.
- Typed Tauri commands cover non-stream completion, stream start, and stream
  cancellation.
- OpenAI-compatible and Anthropic fixtures both complete non-stream and stream
  `model -> tool result -> final answer` loops without the legacy JSON ReAct
  decision prompt/parser.
- Native response serialization uses `usage`, matching the TypeScript contract.
- Tool result IDs are bound to their originating tool names and duplicate IDs
  or duplicate results are rejected.
- Interleaved parallel calls, arguments arriving before identity, truncated
  JSON, finish-reason conflicts, unknown tools, and sensitive error payloads
  have explicit regression tests.
- Provider capability selection fails closed to legacy when native Tool Call is
  disabled. Parallel-call hints use three-state serialization: supported
  providers default to `true`, unsupported/unknown providers omit the field,
  and a request may explicitly force `false`.

## Verification

```text
Rust model_chat protocol tests: 21 passed
Desktop Agent Runtime and persistence tests: 74 passed
Core provider and Agent Runtime tests: 45 passed
Core full suite: 55 files, 966 tests passed
Desktop full suite: 75 files, 906 tests passed
Desktop TypeScript compile: passed
```
