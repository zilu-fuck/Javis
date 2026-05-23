# Permissions And Safety

This document defines the product-level permission model. Implementation details
for the current filesystem checks are summarized in `SECURITY_MODEL.md`.

## Principles

- Read-only actions may run when they are visible and logged.
- Preview actions may inspect state and produce a dry-run.
- Writes require explicit approval for the current dry-run.
- Confirmed writes must be bound to the current dry-run, not just to a command
  name.
- Dangerous actions are rejected by default.
- Verification must state what evidence was checked.
- Permission decisions must not become broad reusable grants.

## Permission Levels

| Level | Meaning | MVP behavior |
| --- | --- | --- |
| `read` | Observe local or public data without changing it. | Allowed and logged. |
| `preview` | Produce a plan or dry-run without changing state. | Allowed and logged. |
| `confirmed_write` | Change local state after approval. | Requires a pending permission card. |
| `dangerous` | Broad, destructive, or account-changing action. | Rejected or deferred. |

## Dry-Run Requirements

A dry-run must include:

- Operation name.
- Affected paths or command preview.
- Risk summary.
- Whether the action is reversible.
- Conflict information when available.

The user should be able to deny the dry-run and receive a no-op result.

For confirmed-write execution, the native command must reject missing approval,
stale approval ids, reused approvals, or operations that differ from the
approved dry-run.

## PDF Organization Policy

The current confirmed-write flow is PDF organization in Downloads.

Allowed:

- Move PDF files.
- Create target parent directories inside Downloads when needed.
- Skip conflicting targets.

Rejected:

- Non-PDF moves.
- Delete, overwrite, copy, create, or modify operations in this flow.
- Source or target paths outside Downloads.
- Parent directory traversal.
- Escapes through existing target parent symlinks.

## Shell Policy

The Shell Tool is read-only in the MVP. It is intended for version checks,
package manager checks, git status, and recommended project check commands that
fit the allowlist.

General shell execution, package installation, deletion, network mutation, and
privileged commands are outside the MVP permission model.

## Web Policy

The Web Tool fetches user-provided public URLs and may search for public source
candidates through configured read-only providers. It should preserve source
URL, title when available, fetched timestamp, excerpt, and provider metadata
when search is used.

## UI Requirements

Permission UI must show:

- Action title.
- Reason approval is needed.
- Dry-run summary.
- Affected paths or command preview.
- Approve and deny controls.
- Final approved or denied result.

No confirmed write should happen without a visible pending permission request.

## Audit Requirements

Every task should leave enough current-session evidence for a user to answer:

- What did Javis plan?
- Which tools ran?
- What did the user approve or deny?
- What changed?
- How was completion verified?
