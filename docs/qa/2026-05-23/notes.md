# QA Notes

Date: 2026-05-23

Branch: master

Commit: f252e69

Operating system: Microsoft Windows NT 10.0.26200.0

Scope:

- Documentation maturity pass.
- Full native Tauri release build QA.
- Packaged Tauri build evidence.
- Permission and confirmed-write review for PDF organization.
- Search-backed research product QA fixture pass.

Commands:

```sh
pnpm check
git diff --check
pnpm --filter @javis/desktop tauri build
powershell -ExecutionPolicy Bypass -File docs/qa/2026-05-23/native-qa.ps1
powershell -ExecutionPolicy Bypass -File docs/qa/2026-05-23/research-search-qa.ps1
powershell -ExecutionPolicy Bypass -File docs/qa/2026-05-23/research-live-smoke-qa.ps1
```

Command output:

- `pnpm-check.txt`
- `git-diff-check.txt`
- `tauri-build.txt`
- `native-qa-output.txt`
- `research-search-qa-output.txt`
- `research-live-smoke-qa-output.txt`

Command status:

- `pnpm check`: pass
- `git diff --check`: pass
- `pnpm --filter @javis/desktop tauri build`: pass
- `native-qa.ps1`: pass
- `research-search-qa.ps1`: pass
- `research-live-smoke-qa.ps1`: pass for live `github-cli` smoke.
- `git diff --check` output contains only Git LF-to-CRLF working-copy warnings;
  the command exited successfully.

Evidence:

- `01-native-idle-workbench.png`: release app idle workbench.
- `02-markdown-scan-completed.png`: Markdown scan completed.
- `03-project-inspection-completed.png`: project scripts and read-only checks completed.
- `04-research-report-completed.png`: public HTTPS source-backed research report.
- `05-pdf-permission-card.png`: confirmed-write permission card before approval.
- `06-pdf-approved-result.png`: approved PDF move completed with moved files.
- `06b-pdf-conflict-skipped.png`: PDF target conflict skipped without overwrite.
- `07-pdf-denied-result.png`: denied PDF move left files unchanged.
- `08-failed-verification-state.png`: expected failed verification for an empty source.
- `09-search-github-cli-completed.png`: search-backed research completed with
  three fixture sources labelled `github-cli`.
- `10-search-agent-chrome-fallback-completed.png`: search-backed research
  completed with three fixture sources labelled `agent-chrome`.
- `11-search-weak-evidence-failed.png`: searched source with empty evidence
  produced failed verification.
- `12-search-failed-fetch-state.png`: searched source candidate fetch failure
  produced a failed search state with fallback guidance.
- `13-search-no-results-state.png`: search provider returned no candidates and
  the UI showed the no-results failure state.
- `14-search-live-github-cli-smoke.png`: live `github-cli` provider smoke using
  public GitHub repository search.
- `qa-contact-sheet.png`: contact sheet for visual review.
- Packaged artifacts:
  - `apps/desktop/src-tauri/target/release/bundle/msi/Javis_0.1.0_x64_en-US.msi`
  - `apps/desktop/src-tauri/target/release/bundle/nsis/Javis_0.1.0_x64-setup.exe`

Scenario status:

| Scenario | Status | Notes |
| --- | --- | --- |
| Idle workbench | Pass | Captured from the packaged release app. |
| Markdown scan | Pass | Paths, modified times, sizes, purpose text, and verified final state shown. |
| Project inspection | Pass | Scripts detected and allowlisted read-only checks completed. |
| Research report | Pass | Uses `https://example.com` and `https://www.iana.org/domains/reserved`. |
| PDF permission card | Pass | Dry-run lists source and target paths before approval. |
| PDF approved execution | Pass | Approval moved the listed disposable PDFs. |
| PDF conflict skip | Pass | Existing target caused `0 moved, 1 skipped`; no overwrite occurred. |
| PDF denied no-op | Pass | Denial recorded and no write was executed. |
| Failed verification state | Pass | Empty local source produced the expected failed verification state. |
| Search-backed research with github-cli provider | Pass | Fixture search returned three local public sources labelled `github-cli`; report completed with provider metadata. |
| Search-backed research with Agent Chrome provider | Pass | Fixture search returned three local public sources labelled `agent-chrome`; report completed with provider metadata. |
| Search weak evidence | Pass | Empty searched source produced failed verification with `0/1 searched sources`. |
| Search failed fetch | Pass | Missing searched source produced a failed search state with manual URL fallback guidance. |
| Search no results | Pass | Empty fixture search produced `Research search returned no sources`. |
| Live github-cli search smoke | Pass | Live `gh search repos research` path returned public sources and displayed `github-cli` provider metadata. |

Manual QA verdict: pass for the documented MVP release scenarios.

Notes:

- `native-qa.ps1` launches the packaged release executable with WebView2 remote
  debugging enabled, drives the UI through the app surface, and captures the
  release-window screenshots.
- The failed verification screenshot is intentional and covers the failure-state
  requirement in `docs/QA_CHECKLIST.md`.
- `research-search-qa.ps1` uses the `JAVIS_QA_MODE=1` +
  `JAVIS_SEARCH_FIXTURE_PATH` QA-only bridge to make search provider states
  repeatable without relying on live public search availability. It verifies the
  packaged release executable's fixture-driven search UI/backend flow, provider
  metadata display, source fetching, weak evidence, failed fetch, and no-results
  states. Live `github-cli` and Agent Chrome provider smoke QA remains separate
  product-readiness work.
- `research-live-smoke-qa.ps1` covers live `github-cli` provider smoke only.
  Live Agent Chrome fallback smoke still needs a stable public-provider pass.
- Security/permissions review applies because PDF confirmed-write code changed.
  `SECURITY_MODEL.md` and `PERMISSIONS.md` were reviewed against the current
  implementation; Rust tests cover move success, conflict skip, missing
  approval rejection, changed dry-run rejection, one-time approval consumption,
  non-move rejection, non-PDF rejection, traversal rejection,
  source/target-outside-Downloads rejection, Windows package-manager command
  shims, and missing-source failure.
