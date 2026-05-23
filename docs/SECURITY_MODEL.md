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

## Shell Rules

Only allowlisted commands can run through the current shell bridge. The
allowlist is deliberately small:

- version checks
- `git status --short`
- selected project check scripts such as `pnpm typecheck`

Commands that install dependencies, publish, delete, reset git state, force
push, or run arbitrary scripts are outside the current v1 boundary.

## File Write Rules

The current write implementation is intentionally narrow:

- Only the PDF organization flow writes.
- Only `move` is supported.
- Only PDF files are moved.
- The source and target must stay inside `Downloads`.
- Execution requires a one-time approval id for the current dry-run.
- Execution operations must match the approved dry-run exactly.
- Existing targets are skipped.
- Dry-run conflicts are skipped.
- Directory traversal is rejected.
- Existing target parent directories are canonicalized to avoid path escape.

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
