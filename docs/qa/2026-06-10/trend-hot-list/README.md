# Structured Hot-List Research QA

This folder contains the packaged-app QA playbook for typed hot-list research
through `trend.fetchHotList`.

The workflow is intentionally evidence-driven. A source-level unit test or a
copied fixture is not enough to close `trend-hot-list-live`; the product gate
requires a packaged desktop run with a real provider response, provider/source
metadata, diagnostics, and a visible research report.

## Preconditions

- Run against the packaged Tauri app, not the dev server.
- Use a non-sensitive public hot-list provider.
- Do not paste private cookies, tokens, or account-only data into evidence.
- Keep all evidence files under this folder or another dated
  `docs/qa/YYYY-MM-DD` folder.

## Required Evidence

The product workflow gate looks for these filenames:

```text
38-trend-hot-list-report.png
trend-hot-list-live-qa-output.txt
```

The output file must record:

- packaged app context
- app version or build
- concrete QA date
- artifact references that exist in the QA folder
- `toolName: "trend.fetchHotList"`
- a non-empty provider id
- requested count `20`
- non-empty item count
- source URL
- completed diagnostics
- research report sources

## Manual Run

1. Copy `trend-hot-list-manual-qa-evidence.template.md` to
   `trend-hot-list-manual-qa-evidence.md`.
2. Open the packaged desktop app and select a normal workspace.
3. Ask for a top-20 hot-list research task, for example a public trending-list
   summary.
4. Confirm the task used the typed hot-list tool, not only generic web search.
5. Capture the completed report as `38-trend-hot-list-report.png`.
6. Generate the machine-readable output:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\qa\2026-06-10\trend-hot-list\trend-hot-list-release-qa.ps1 `
  -Provider <provider-id> `
  -RequestedCount 20 `
  -ItemCount <actual-item-count> `
  -SourceUrl <source-url>
```

7. Re-run the product workflow gate:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\qa\check-product-workflow-evidence.ps1 -QaRoot docs\qa\2026-06-10
```

The helper script refuses to emit a passing output unless the required
screenshot and completed manual evidence file exist, and it writes the
packaged-app provenance fields required by the product gate.
