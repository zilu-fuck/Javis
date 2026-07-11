# MiMo + YOLO Live QA Error Fix Notes

Date: 2026-06-16T17:52:13+08:00

## Error 1: empty MiMo content after first call

Root cause: MiMo v2.5 spent the short max_tokens=900 budget on easoning_content, so message.content was empty and the response stopped with inish_reason=length.

Fix: Computer Use completion requests now pass disableThinking: true for MiMo/DeepSeek-like providers or base URLs. The native OpenAI-compatible request body serializes this as "thinking": { "type": "disabled" } only when explicitly requested.

Regression coverage:
- pps/desktop/src/computer-use-loop.test.ts checks hosted MiMo Computer Use calls pass disableThinking: true.
- pps/desktop/src-tauri/src/lib.rs checks the OpenAI-compatible body emits 	hinking.type = disabled when requested.

## Error 2: MiMo retry wrapped JSON in markdown and used bare action shape

Root cause: the live QA script used strict ConvertFrom-Json directly, so fenced JSON was reported as invalid. Product parsing already strips full JSON fences, but MiMo also returned ction.tool = "click" with x/y on the action object instead of 	ool = "computer.click" plus params.

Fix: Computer Use action parsing now normalizes bare tool names to computer.* and treats non-null top-level action fields as params when params is absent. Fenced JSON remains accepted.

Regression coverage:
- packages/core/src/computer-use-types.test.ts includes a MiMo-style fenced click response matching the live retry shape.

## Validation Run

- corepack pnpm --filter @javis/core exec vitest run src/computer-use-types.test.ts src/provider-adapter.test.ts PASS
- corepack pnpm --filter @javis/desktop exec vitest run src/model-provider.test.ts src/computer-use-loop.test.ts PASS
- corepack pnpm typecheck PASS
- cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml openai_compatible_completion_body_disables_thinking_when_requested --lib PASS
- cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml PASS
