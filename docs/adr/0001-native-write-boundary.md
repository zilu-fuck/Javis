# ADR 0001: Native Write Boundary for Sandbox, Terminal, and Git Approvals

## Status

Accepted on 2026-06-14.

## Context

Javis runs local agents that can inspect repositories, propose code changes, open
terminals, and perform Git operations. These actions cross different risk
levels:

- read-only inspection should be low friction but still auditable;
- workspace writes must not rely on frontend state alone;
- terminal and Git operations can mutate files, credentials, remotes, or the
  user's working tree;
- pending approvals may survive UI refreshes and must be revalidated before use.

The project already has a native approval model in Rust. The remaining question
is where enforcement lives and how sandbox, terminal, and Git flows share the
same safety boundary.

## Decision

Rust is the final enforcement layer for write-capable local actions.

Sandbox, terminal, and Git write flows must use the same native pattern:

1. The UI shows a visible approval card with the planned action and preview.
2. Rust records a native approval binding containing task id, tool name, preview
   hash, and scoped action data.
3. Execution revalidates the approval binding, path scope, preview hash, and
   current state before doing work.
4. The approval is consumed once and cannot be replayed.
5. If the required OS sandbox backend is unavailable, workspace-write and
   interactive terminal execution fail closed instead of falling back to an
   unsandboxed command.

The sandbox broker owns policy evaluation for read-only, workspace-write,
network, and interactive-session launch readiness. Terminal creation checks the
interactive-session backend before spawning a PTY. Git stage, commit, push, PR
creation, and PR comment flows use native plan/approve/execute paths with
preview hash binding and one-shot consumption.

Temporary workspace sandboxes are allowed as a review mechanism, but they do not
replace OS sandbox enforcement. Applying copied-workspace changes back to the
real workspace still requires native approval and rejects stale diffs or binary
changes.

## Consequences

- Frontend permission state is advisory; native approval is authoritative.
- Write-capable commands may be blocked on platforms where the enforcing backend
  is not ready. This is intentional fail-closed behavior.
- Git and terminal UX must expose enough preview detail for informed approval.
- Tests should cover stale preview hashes, wrong task ids, wrong tools, path
  escapes, approval replay, backend unavailability, and restore-after-restart
  cases.
- Future OS-specific sandbox backends can be added behind the same broker
  contract without changing the UI approval model.

## References

- `docs/SECURITY_MODEL.md`
- `docs/SANDBOX_IMPLEMENTATION_PLAN.md`
- `docs/qa/2026-06-14/sandbox-p1-p2-review.md`
- `apps/desktop/src-tauri/src/sandbox.rs`
- `apps/desktop/src-tauri/src/terminal.rs`
- `apps/desktop/src-tauri/src/git.rs`
