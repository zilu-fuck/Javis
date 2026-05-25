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
cargo test
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
  current rerun. The fixture apply path now preserves provider patch bodies
  exactly, including the trailing newline required by `git apply`. Live
  DeepSeek-compatible provider smoke still needs a fresh rerun with temporary
  credentials after the prompt/parser/apply hardening.
- `pdf-durable-approval-qa.ps1`: pass for restored PDF approval approve,
  restored deny, and expired-record fail-closed behavior after packaged app
  restart.
- `code-patch-durable-approval-qa.ps1`: pass for restored Code Patch approval
  approve/apply, restored deny, and expired-record fail-closed behavior after
  packaged app restart.
- `cargo test`: pass after adding native approval tool-name and preview-hash
  binding checks for PDF organization and Code Patch apply.
- 2026-05-25 rerun: `pnpm --filter @javis/desktop tauri build` passed, and
  `code-agent-opencode-qa.ps1` passed fixture proposal deny/apply. Live provider
  remained fail-closed with `LiveProviderConfigured: false` because no temporary
  API key was supplied.
- 2026-05-25 unit/build rerun: `pnpm --filter @javis/desktop test`,
  `pnpm --filter @javis/desktop build`, `pnpm --filter @javis/ui typecheck`,
  `pnpm --filter @javis/core test`, and `cargo test` passed after durable
  approval restore began recomputing dry-run binding hashes. A follow-up
  review pass tightened Code Patch restore to compare against the canonical
  `createCodeApplyDryRun` shape, and the desktop/Rust validation suite was
  rerun successfully.

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
- `20-code-agent-live-proposal-failed.png`: live DeepSeek-compatible settings
  reached the opencode proposal phase through native secret-reference credential
  injection and failed before write approval, with no file application
  attempted.
- `code-agent-opencode-qa-output.txt`: records the current fixture deny/apply
  pass. The output records provider/model/status when live credentials are
  supplied, but never the temporary API key.
- 2026-05-25 `code-agent-opencode-qa-output.txt`: records
  `LiveProviderConfigured: false`, `LiveCredentialStorageEnabled: false`, and
  `LiveResult: null`; no live write approval was requested and no live apply was
  attempted.
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
- `26-code-patch-durable-approval-restored.png`: packaged app relaunch restores
  a pending Code Agent patch approval from `javis.approvalRecords.v1`.
- `27-code-patch-durable-approval-approved.png`: restored Code Patch approval
  applies the persisted proposal and passes post-apply `git diff --check`.
- `28-code-patch-durable-approval-deny-restored.png`: packaged app relaunch
  restores a separate pending Code Patch approval for the deny path.
- `29-code-patch-durable-approval-denied.png`: denied restored Code Patch
  approval leaves the file unchanged.
- `30-code-patch-durable-approval-expired.png`: expired Code Patch approval
  fails closed without restoring a permission card.
- `code-patch-durable-approval-qa-output.txt`: confirms the approved path
  changes `src/message.txt` to `hello approved`, deny and expiry leave it at
  `hello reviewed`, and durable approval records resolve as `approved`,
  `denied`, and `expired` with expected preview hashes.

Manual QA verdict: pass for workspace selection, recent-workspace restart
persistence, fixture-backed Code Agent proposal/apply safety, durable PDF
approval restore approve/deny/expiry, and durable Code Patch approval restore
approve/apply/deny/expiry. Live DeepSeek-compatible provider QA should be rerun
with temporary credentials before live approved apply can be considered.

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
  drives both preview and confirmed-write permission buttons, injects live
  credentials through the native model API key secret command when live
  environment variables are present, and deletes the temporary repository after
  the pass.
- `pdf-durable-approval-qa.ps1` creates a temporary PDF under Downloads,
  injects a scoped pending durable approval record, restarts the packaged app,
  exercises approve, deny, and expired-record paths, verifies the file effects
  and durable record status for each path, captures screenshots, and removes
  the temporary files.
- `code-patch-durable-approval-qa.ps1` creates temporary git workspaces under
  the QA folder, injects scoped pending Code Patch durable approval records
  with persisted proposal payloads, restarts the packaged app, exercises
  approve/apply, deny, and expired-record paths, verifies file effects and
  durable record status, captures screenshots, and removes the temporary
  workspaces.
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
- Native approval binding now also records and checks tool name plus preview
  hash for the PDF organization and Code Patch write paths. Rust tests cover
  stale PDF preview hashes and Code Patch tool/preview binding mismatches.
- Durable approval restore now recomputes the dry-run binding hash instead of
  trusting the persisted `permissionRequest.bindingHash`, and Code Patch
  approval records fail closed when the persisted proposal payload no longer
  matches the canonical apply dry-run.
- During this QA pass, the Code Agent fixture apply path exposed that provider
  patch JSON must be preserved exactly. The parser now keeps the patch body
  trailing newline instead of trimming it before hash calculation and
  `git apply`.
