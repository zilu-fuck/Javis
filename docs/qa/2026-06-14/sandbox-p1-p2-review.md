# Sandbox P1/P2 Review

Date: 2026-06-14

## Scope

This review covers the sandbox implementation against `docs/SANDBOX_IMPLEMENTATION_PLAN.md`,
with emphasis on P1/P2 gaps from the latest code review.

## Verified Commands

```text
corepack pnpm check
```

Result: pass.

## Current Enforcement Status

| Area | Status | Evidence |
| --- | --- | --- |
| Read-only shell commands | Pass | `shell::run_read_only_command` routes through `sandbox::run_sandboxed_command`; `pnpm check` includes shell and sandbox tests. |
| Code patch apply | Fail-closed until OS backend is ready | `code::apply_code_patch` consumes native approval and calls sandboxed `git apply`; sandbox tests assert approved writes are blocked when backend cannot enforce policy. |
| Git mutating operations | Fail-closed until OS backend is ready | stage/commit/push/PR comment paths use approval + sandboxed git/gh command helpers. |
| Temporary workspace apply | Pass for approval binding | apply plan is generated natively, approved with `NativeApprovalBinding`, re-diffed before apply, and consumed once. |
| Interactive terminal | Fail-closed | `require_interactive_session_backend` returns a blocking error after readiness checks because a sandboxed PTY launcher is not implemented yet. |
| Windows filesystem boundary | Not implemented | Windows backend reports filesystem boundary unavailable, so workspace-write commands cannot run as OS-enforced sandboxed writes. |
| Windows network denial | Not implemented | Windows backend reports network boundary unavailable, so network-denied commands remain blocked when enforcement is required. |
| Backend status reporting | Pass | `sandbox_backend_status` exposes current backend availability and boundary support to the frontend. |
| Workspace sandbox settings persistence | Pass for schema/repository | `WORKSPACE_SETTINGS_MIGRATIONS` is registered at startup; repository tests cover round-trip and malformed JSON sanitization. |

## Remaining Product Gaps

- Implement a Windows backend that can truthfully set `can_restrict_filesystem=true`
  and `can_deny_network=true` without permanent host ACL mutation.
- Implement a PTY launcher that creates the interactive shell inside the same
  sandbox boundary instead of opening a normal PTY after approval.
- Wire saved workspace sandbox settings into the native policy construction path.
  The table, repository, startup migration, and frontend-safe backend status API now
  exist, but Rust command policies still use current defaults unless individual
  commands pass explicit policy values.
- Add runtime QA on an environment with the backend available:
  - sandboxed command cannot write outside selected workspace
  - sandboxed command cannot edit `.git/config`
  - network-denied command cannot reach a public host
  - packaged Windows app starts a sandboxed terminal after visible approval
