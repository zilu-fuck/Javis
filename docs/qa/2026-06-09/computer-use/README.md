# Computer Use Release QA

This folder contains repeatable QA for the Computer Use refactor.

Run after a release build:

```powershell
powershell -ExecutionPolicy Bypass -File docs\qa\2026-06-09\computer-use\computer-use-release-qa.ps1
```

The default script is non-interactive. It launches the packaged desktop app, attaches to WebView2 DevTools, calls the real Tauri Computer Use commands, verifies screenshot/list-windows reads, approval lease behavior, sensitive approval rejection, emergency hotkey command toggling, local-vision fail-open behavior, and the real `yolo26n-ui.onnx` path when present.

It must not write screenshot data URLs to JSON or markdown evidence. The only image artifact is the app window screenshot.

Optional stricter local vision run:

```powershell
powershell -ExecutionPolicy Bypass -File docs\qa\2026-06-09\computer-use\computer-use-release-qa.ps1 -RequireLocalVision
```

Verify existing evidence without launching the app:

```powershell
corepack pnpm qa:computer-use
```

Final 8-scenario acceptance gate, after manual opt-in desktop-action QA has been performed and the checklist rows have been changed to `PASS`:

```powershell
corepack pnpm qa:computer-use:manual
```

Strict manual acceptance also requires a dated evidence note:

```text
computer-use-manual-qa-evidence.md
```

Start from `computer-use-manual-qa-evidence.template.md`, copy it to `computer-use-manual-qa-evidence.md` only for a real manual run, and leave the template in `PENDING` state.

The completed note must record the operator, app version/build or executable, `Result: PASS`, an `Artifacts:` line with `.png`, `.md`, or `.json` evidence references that exist in this QA evidence folder, and each scenario ID (`CU-QA-01` through `CU-QA-08`) marked `PASS` with a concrete `Evidence:` detail line. It must not include screenshot data URLs.

The full 8-scenario acceptance checklist is tracked in:

```text
computer-use-qa-scenarios.md
```

Rows marked `Manual opt-in required` are intentionally not executed by the default QA script because they move the real mouse, type into desktop applications, or open external pages.
