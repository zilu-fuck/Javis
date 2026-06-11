# Browser and Terminal Approval QA

This folder contains the packaged-app QA playbook for Browser write actions and
interactive Terminal start/input approval workflows.

The workflow is intentionally manual because it can type into a browser page or
send input to an interactive terminal session.

## Required Evidence

The product workflow gate looks for these filenames:

```text
39-terminal-start-approval-card.png
40-terminal-input-approval-card.png
41-browser-write-approval-card.png
browser-terminal-approval-qa-output.txt
```

## Manual Run

1. Copy `browser-terminal-approval-manual-qa-evidence.template.md` to
   `browser-terminal-approval-manual-qa-evidence.md`.
2. Use a disposable local page and a disposable terminal command.
3. Capture each required screenshot with the exact filename above.
4. Mark every scenario as `PASS` only after the packaged app behavior is
   verified.
5. Generate the machine-readable output:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs\qa\2026-06-10\browser-terminal-approvals\browser-terminal-approval-release-qa.ps1 `
  -TerminalStart pass `
  -TerminalInput pass `
  -BrowserWrite pass `
  -Denial pass `
  -StalePreview pass `
  -OneShot pass
```

The helper refuses to emit a passing output unless all required screenshots and
the completed manual evidence file exist. The output records packaged-app
provenance (`PackagedApp`, `AppVersion`, `QaDate`) and an `Artifacts` list; every
referenced artifact must exist in the QA evidence folder before the product
workflow gate can mark `browser-terminal-approvals` as passing.
