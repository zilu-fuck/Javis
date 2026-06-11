# Repository Intelligence Package/Live QA

This folder contains the packaged-app QA playbook for repository intelligence
through `code.searchRepository` and `code.traceCallChain`.

The workflow is evidence-driven. Source-level tests prove the contracts and
resolver logic, but they do not close `repo-intelligence-package-live`; the
product gate requires a packaged desktop run with visible key-file and symbol
graph evidence.

## Preconditions

- Run against the packaged Tauri app, not the dev server.
- Use a normal local repository workspace with no secrets in screenshots.
- Keep all evidence files under this folder or another dated
  `docs/qa/YYYY-MM-DD` folder.

## Required Evidence

The product workflow gate looks for these filenames:

```text
42-repo-search-key-files.png
43-repo-trace-symbol-graph.png
repo-intelligence-package-live-qa-output.txt
```

The output file must record:

- packaged app context
- app version or build
- concrete QA date
- artifact references that exist in the QA folder
- key files pass
- symbol graph pass, including cross-file AST/module evidence when script-file
  discovery is available
- resolver pass
- local package hints pass
- external registry evidence pass
- fallback diagnostics pass

## Manual Run

1. Copy `repo-intelligence-manual-qa-evidence.template.md` to
   `repo-intelligence-manual-qa-evidence.md`.
2. Open the packaged desktop app and select a repository workspace.
3. Ask a code task that requires searching before editing and record the key
   files view as `42-repo-search-key-files.png`.
4. Ask or inspect a trace that shows cross-file symbol graph evidence and
   record it as `43-repo-trace-symbol-graph.png`.
5. Confirm resolver/package evidence and fallback diagnostics are visible in
   the task details or QA output.
6. Generate the machine-readable output:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\qa\2026-06-10\repo-intelligence\repo-intelligence-release-qa.ps1
```

7. Re-run the product workflow gate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\check-product-workflow-evidence.ps1 -QaRoot docs\qa\2026-06-10
```

The helper refuses to emit a passing output unless both screenshots and the
completed manual evidence file exist.
