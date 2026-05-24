# Security Model

Javis is a local-first desktop assistant. The first version is designed to make
every sensitive action visible and interruptible.

## Permission Levels

| Level | Meaning | Can run automatically? |
| --- | --- | --- |
| `read` | Reads information without changing local, remote, or account state. | Yes, with logs. |
| `preview` | Produces a plan, diff, or dry-run without changing state. | Yes, and must be shown to the user. |
| `confirmed_write` | Changes local files, project state, app state, or remote state. | Only after current user approval. |
| `dangerous` | May cause destructive, privileged, irreversible, or credential-related impact. | Rejected by default in v1. |

## Current Native Capabilities

Tauri currently exposes:

- `scan_markdown_documents`: read-only workspace Markdown scan.
- `run_read_only_command`: command execution through a small allowlist.
- `fetch_web_source`: public HTTP(S) source fetch.
- `inspect_project`: read-only package script inspection.
- `plan_pdf_organization`: preview-only PDF move plan for `Downloads`.
- `approve_pdf_organization`: records approval for the current PDF dry-run id.
- `execute_pdf_organization`: confirmed-write PDF moves from an approved plan.
- `propose_code_edit`: preview-only opencode patch proposal with opencode edit,
  shell, and web tools denied.
- `apply_code_patch`: confirmed-write unified diff application after Core
  approval.

## Search And Browser Isolation

Automated technical and code research currently uses `github-cli` search when
available. After Code Agent / OpenCode integration, it should prefer
`expert-vision-software/opencode-intellisearch` through an OpenCode/plugin
adapter. If the primary provider is unavailable or insufficient, Javis may use
an embedded Chrome instance dedicated to the agent as a fallback search backend.

The embedded Chrome fallback must:

- use an isolated Javis-controlled profile
- avoid the user's normal Chrome profile and account sessions
- avoid reading cookies, passwords, private keys, browser history, or credential
  stores
- perform only read-only public source discovery and retrieval
- log when fallback occurs and which sources came from the fallback path

## Shell Rules

Only allowlisted commands can run through the current shell bridge. The
allowlist is deliberately small:

- version checks
- `git status --short`
- selected project check scripts such as `pnpm typecheck`

Commands that install dependencies, publish, delete, reset git state, force
push, or run arbitrary scripts are outside the current v1 boundary.

## File Write Rules

The current write implementations are intentionally narrow:

- PDF organization can move PDF files inside `Downloads` after approval.
- Code Agent can apply an approved unified diff inside the selected workspace.
- Both write paths require a visible confirmed-write approval before execution.
- Both write paths must reject paths outside their allowed scope.

PDF organization rules:

- Only `move` is supported.
- Only PDF files are moved.
- The source and target must stay inside `Downloads`.
- Execution requires a one-time approval id for the current dry-run.
- Execution operations must match the approved dry-run exactly.
- Existing targets are skipped.
- Dry-run conflicts are skipped.
- Directory traversal is rejected.
- Existing target parent directories are canonicalized to avoid path escape.

Code Agent patch rules:

- opencode or provider calls may only produce preview proposals.
- Patch application runs through Javis's native `apply_code_patch` command.
- The patch may touch only the approved changed-file list.
- Parent directory traversal and workspace escape are rejected.
- A product-ready implementation still needs durable approval records, patch
  dry-run validation, base file hashes, and shared native guard helpers.

## Model Credentials

The desktop app currently stores opencode model settings locally so an installed
copy can run without manual CLI configuration. This includes provider id, model
id, API key, and optional base URL. The current implementation persists those
values in app local storage; this is local persistence, not hardened secret
storage. A future release should move API keys into the OS credential store.

The intended hardened shape is to keep provider id, model id, base URL, and a
secret reference in local storage, while storing the actual API key in
Stronghold or the OS credential store.

The API key must only be passed to opencode through per-run configuration. It
must not appear in task history, proposal metadata, screenshots, or diagnostic
logs.

## Code Agent Write Rules

The current Code Agent write path uses opencode only for preview proposals. The
desktop app denies opencode edit, shell, and web tools and applies files only
through Javis's native approved-patch command.

Before any Code Agent backend applies edits:

- The proposal must include a proposal id, workspace path, changed-file list,
  patch text, and patch hash.
- The confirmed-write approval must show the current proposal id, affected
  paths, summary, and patch hash.
- Core must verify the proposal hash before asking for approval and again before
  calling the apply backend.
- The apply result must report the same workspace and only approved files.
- Post-apply verification must run before a successful final state.
- Task history must not persist full patch text; it may keep proposal metadata
  and apply summaries for audit context.

## What Is Rejected by Default

The first version must not:

- Delete files or directories.
- Overwrite existing files.
- Execute untrusted scripts from webpages or model output.
- Read browser cookies, passwords, private keys, or credential stores.
- Publish packages, deploy to production, push forcefully, or alter remote
  repository settings.
- Submit forms, send messages, place orders, or perform payments.

## Audit Expectations

Every tool call should produce visible logs with:

- tool name
- permission level or equivalent summary
- working directory or affected path summary
- result summary
- error message when applicable

For confirmed writes, the final result must include:

- permission decision
- attempted count
- moved/skipped/failed count
- per-file result list

## Current Safety Test Coverage

Rust tests cover the PDF move success path plus these safety boundaries:

- conflicting targets are skipped
- non-move operations are rejected
- non-PDF sources are rejected
- execution without approval is rejected
- changed operations after approval are rejected
- consumed approvals cannot be reused
- parent directory traversal is rejected
- sources outside Downloads are rejected
- targets outside Downloads are rejected
- missing sources are reported as failed
