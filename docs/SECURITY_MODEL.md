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
- `read_file_chunk`: read-only text context injection limited to selected
  workspace or scanned resource roots, with symlink, sensitive path, and text
  extension checks.
- `read_image_data_url`: read-only image loading limited to selected workspace
  roots, with symlink, sensitive path, supported-image, and size checks.
- `run_read_only_command`: command execution through a small allowlist.
- `fetch_web_source`: public HTTP(S) source fetch with loopback/private IP,
  metadata host, redirect, and DNS-resolution private address checks.
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
- reject loopback/private literal hosts and public hostnames that resolve to
  loopback/private addresses, except explicit localhost navigation in a bound
  app session
- keep click, type, evaluate, upload, and test execution disabled until a
  native approval binding exists
- log when fallback occurs and which sources came from the fallback path

## Shell Rules

Only allowlisted commands can run through the current shell bridge. The
allowlist is deliberately small:

- version checks
- selected read-only git inspection commands such as `git status --short`,
  `git diff`, and `git log`

Project-defined scripts such as `pnpm test`, `pnpm typecheck`, `npm test`, and
`yarn test` are not read-only because the workspace controls their command
bodies. Commands that install dependencies, publish, delete, reset git state,
force push, run arbitrary scripts, or open an interactive terminal are outside
the current v1 boundary unless they go through a future native approval broker.

## Local Read Rules

Local file context reads are read-only but still scoped:

- `read_file_chunk` requires a non-empty selected workspace or scanned resource
  root and verifies containment after canonicalization.
- `read_image_data_url` requires a selected workspace root for local paths.
- Both commands reject symlinks and sensitive path components such as `.ssh`,
  `.aws`, browser credential stores, `.env`, private keys, and certificate/key
  file extensions.
- Text reads are limited to common text extensions and 64 KB / 200 lines by
  default.
- Image reads are limited to supported image extensions and 10 MB.

The current renderer still passes the allowed roots into the native commands.
The hardened target is a native root registry or scan-result id so renderer
input can reference, but not mint, read scopes.

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

The desktop app currently stores non-secret opencode model settings locally so
an installed copy can run without manual CLI configuration. This includes
provider id, model id, and optional base URL. New saves do not persist API keys
in app local storage, and legacy stored keys are cleared when model settings are
loaded. Until Stronghold or OS credential storage is added, API keys are
session-only and must be re-entered after restart.

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
