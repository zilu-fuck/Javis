# QA Notes

Date: 2026-05-24

Operating system: Microsoft Windows NT 10.0.26200.0

Scope:

- Workspace native directory picker readiness.
- Recent workspace persistence after a real packaged desktop app restart.
- Code Agent opencode proposal/apply QA through the packaged desktop app.
- Durable PDF approval restore approve/deny/expiry QA through the packaged
  desktop app.

Commands:

```sh
pnpm --filter @javis/desktop test
pnpm --filter @javis/ui test
pnpm --filter @javis/desktop build
pnpm --filter @javis/desktop tauri build
powershell -ExecutionPolicy Bypass -File docs/qa/2026-05-24/workspace-restart-qa.ps1
powershell -ExecutionPolicy Bypass -File docs/qa/2026-05-24/code-agent-opencode-qa.ps1
powershell -ExecutionPolicy Bypass -File docs/qa/2026-05-24/pdf-durable-approval-qa.ps1
```

Command output:

- `workspace-restart-qa-output.txt`
- `code-agent-opencode-qa-output.txt`
- `pdf-durable-approval-qa-output.txt`

Command status:

- `pnpm --filter @javis/desktop test`: pass
- `pnpm --filter @javis/ui test`: pass
- `pnpm --filter @javis/desktop build`: pass
- `pnpm --filter @javis/desktop tauri build`: pass
- `workspace-restart-qa.ps1`: pass
- `code-agent-opencode-qa.ps1`: pass for fixture proposal deny/apply in the
  current rerun. Earlier live DeepSeek-compatible provider evidence reached
  proposal generation but did not return a parseable patch proposal before any
  write approval was requested. Live smoke is now blocked until QA can inject
  temporary credentials without writing them to localStorage.
- `pdf-durable-approval-qa.ps1`: pass for restored PDF approval approve,
  restored deny, and expired-record fail-closed behavior after packaged app
  restart.

Evidence:

- `01-workspace-recent-before-restart.png`: packaged desktop app after a completed
  workspace-aware project inspection, with `E:\Javis` visible in recent
  workspaces.
- `02-workspace-recent-after-restart.png`: packaged desktop app after closing and
  relaunching, with `E:\Javis` restored as the active workspace and visible in
  recent workspaces.
- `workspace-restart-qa-output.txt`: confirms `javis.recentWorkspaces.v1`
  contained `["E:\\Javis"]` before and after restart.
- `16-code-agent-proposal-before-deny.png`: packaged app shows the opencode
  patch proposal and confirmed-write approval request before denial.
- `16-code-agent-denied-before-deny.png`: denial keeps the patch as a preview
  and leaves the fixture file at `hello reviewed`.
- `18-code-agent-proposal-before-approve.png`: packaged app shows the same
  fixture proposal before approval.
- `18-code-agent-approved-before-approve.png`: approval applies only the
  proposed `src/message.txt` patch and records a successful post-apply
  `git diff --check`.
- `20-code-agent-live-proposal-failed.png`: earlier live DeepSeek-compatible
  settings reached the opencode proposal phase and failed before write
  approval, with no file application attempted.
- `code-agent-opencode-qa-output.txt`: records the current fixture deny/apply
  pass. Live provider credentials were not present in this rerun; future live
  runs require a non-localStorage credential injection path.
- `21-pdf-durable-approval-restored.png`: packaged app relaunch restores a
  pending PDF organization approval from `javis.approvalRecords.v1`.
- `22-pdf-durable-approval-approved.png`: approving the restored card completes
  the PDF organization task.
- `23-pdf-durable-approval-deny-restored.png`: packaged app relaunch restores a
  separate pending PDF organization approval for the deny path.
- `24-pdf-durable-approval-denied.png`: denying the restored card completes
  without moving or modifying the PDF.
- `25-pdf-durable-approval-expired.png`: packaged app relaunch marks an expired
  pending durable approval as expired without restoring a permission card.
- `pdf-durable-approval-qa-output.txt`: confirms the source PDF no longer
  exists and the approved target PDF exists for approve, the source remains and
  no target exists for deny and expiry, and durable approval records resolve as
  `approved`, `denied`, and `expired` with expected preview hashes.

Manual QA verdict: pass for workspace selection, recent-workspace restart
persistence, fixture-backed Code Agent proposal/apply safety, and durable PDF
approval restore approve/deny/expiry. Live DeepSeek-compatible provider QA
remains open until the hardened fallback path is rerun with temporary
credentials.

Notes:

- `workspace-restart-qa.ps1` launches the packaged release executable with
  WebView2 remote debugging enabled, drives the real desktop UI, closes the
  process, relaunches it, and captures native-window screenshots.
- The native directory picker is implemented through the Tauri dialog plugin.
  This pass verifies the released app includes the workspace controls and
  restart persistence evidence. The script does not automate the OS folder
  picker dialog itself because that native modal is intentionally outside the
  WebView DOM.
- `code-agent-opencode-qa.ps1` creates a temporary local git repository under
  the QA folder, launches the packaged app with WebView2 remote debugging,
  drives both preview and confirmed-write permission buttons, and deletes the
  temporary repository after the pass.
- `pdf-durable-approval-qa.ps1` creates a temporary PDF under Downloads,
  injects a scoped pending durable approval record, restarts the packaged app,
  exercises approve, deny, and expired-record paths, verifies the file effects
  and durable record status for each path, captures screenshots, and removes
  the temporary files.
- During this QA pass, `git status --short` parsing truncated paths with a
  leading status-space (for example ` M src/message.txt`). The parser now reads
  the path after the two status columns, and a regression test covers that
  shape.
- During this QA pass, proposal backend failures were initially surfaced as
  diff verification failures. Core now reports them as `Code Agent patch
  proposal failed`, which keeps provider/runtime failures distinguishable from
  `git diff --check` failures.
- The native proposal runner now has a 90-second timeout, an
  OpenAI-compatible fallback for DeepSeek/custom providers, fenced/pretty JSON
  parsing, and approved-file binding so provider output cannot expand beyond
  the reviewed diff file list.
