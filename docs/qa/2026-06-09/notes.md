# QA Notes - 2026-06-09

## Computer Use

Evidence folder:

```text
docs/qa/2026-06-09/computer-use
```

Release QA status: PASS.

Package readiness check: PASS, without running installer packaging.

Additional checks:

- `corepack pnpm check` passed.
- `corepack pnpm qa:computer-use` passed.
- `node scripts/check-local-vision-release-resources.mjs` passed.
- `computer-use` workflow metadata is marked `partial`, matching the implemented-but-not-fully-manual-QA-complete state.
- The 8-scenario acceptance checklist is tracked in `computer-use/computer-use-qa-scenarios.md`; full desktop-action rows are still manual opt-in and not yet full PASS.
- Release QA now checks dangerous `computer.keyCombo` approval preflight rejection without executing the key combo.
- QA JSON/report checks reject screenshot data URLs, raw foreground window titles, and raw app body text samples.
- Core tests now assert Computer Use action tool names stay aligned across model output schema, tool descriptors, and the Computer Agent dispatch surface.
- Desktop contract tests now assert Computer Use action tools stay registered in Tauri, bridged through app-runtime, and described with the expected Computer Agent ownership and permission level.
- Commander prompt MCP subtool caps now also apply after planner descriptor metadata is stripped, preventing capped MCP subtools from reappearing through Agent allowed tool lists.
- `scripts/qa/check-computer-use-evidence.ps1 -RequireManualScenarioPass` now acts as the final manual 8-scenario gate and fails until every scenario row is marked `PASS`.
- Strict manual acceptance now also requires the manual evidence note to record `Result: PASS` and each `CU-QA-xx` scenario as `PASS`, preventing a non-PASS manual run or partial scenario evidence from satisfying the final gate.
- `corepack pnpm qa:computer-use` now first runs `scripts/test-check-computer-use-evidence.mjs`, covering default non-overclaim mode, strict manual-gate failure, and strict all-PASS success with synthetic evidence.

Covered by `computer-use-release-qa.ps1`:

- Packaged desktop app launch and WebView2 DevTools attach.
- Native desktop screenshot read and screenshot health check.
- Native window enumeration.
- Scoped Computer Use task approval lease creation and cancellation.
- Session-wide approval rejection for sensitive `computer.type`.
- Dangerous `computer.keyCombo` approval preflight rejection.
- Emergency hotkey command enable/disable.
- Local vision missing-model fail-open path.
- Real `yolo26n-ui.onnx` detection path through ONNX Runtime.

Non-interactive QA intentionally does not click or type into the desktop. Full OS-action scenarios remain manual opt-in in `computer-use/README.md`.
