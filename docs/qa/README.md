# QA Evidence

Store dated manual QA evidence folders here.

Use `PRODUCT_WORKFLOWS.md` for the complete-product workflow matrix. The
strict evidence gate is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/qa/check-product-workflow-evidence.ps1 -QaRoot docs/qa/YYYY-MM-DD
```

Use `-AllowKnownBlockers` only for development inventory across all dated
folders.

Recommended layout:

```text
docs/qa/YYYY-MM-DD/
  notes.md
  01-idle-workbench.png
  02-markdown-scan-completed.png
  03-project-inspection-completed.png
  04-research-report-completed.png
  05-pdf-permission-card.png
  06-pdf-approved-result.png
  07-pdf-denied-result.png
  09-search-github-cli-completed.png
  10-search-agent-chrome-fallback-completed.png
  11-search-weak-evidence-failed.png
  12-search-failed-fetch-state.png
  13-search-no-results-state.png
  14-search-live-github-cli-smoke.png
  15-search-live-agent-chrome-smoke.png
  workspace-restart-qa-output.txt
  code-agent-opencode-qa-output.txt
  model-secret-redaction-qa-output.txt
  pdf-durable-approval-qa-output.txt
  code-patch-durable-approval-qa-output.txt
  release-rollback-notes.md
```

Do not commit screenshots that expose private file paths, credentials, or
personal documents unless they have been sanitized.
