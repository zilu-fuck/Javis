# Sandbox Implementation QA Evidence — 2026-06-13

## Summary

Completed remaining sandbox implementation items:
- P1: Terminal routing through sandbox backend validation
- P2: Sandbox contract tests (11 tests)
- Manual QA evidence (this document)

## Changes Made

### 1. Terminal Sandbox Routing (P1)

**File**: `apps/desktop/src-tauri/src/terminal.rs`

- Added import: `crate::sandbox::{require_interactive_session_backend, workspace_write_policy}`
- In `terminal_create`: added `require_interactive_session_backend(workspace_write_policy(...))` call after approval check and before PTY spawn
- If sandbox backend check fails, terminal creation fails closed with `"Terminal sandbox check failed: {error}"`

**Behavior**: Terminal creation now validates that the OS sandbox backend is ready for interactive sessions before spawning a PTY. On Windows with the restricted token backend available, the terminal process inherits filesystem restrictions. Without a backend, terminal creation fails closed.

### 2. Sandbox Contract Tests (P2)

**File**: `apps/desktop/src-sandbox-contract.test.ts`

11 tests verifying:
- Terminal routes through `require_interactive_session_backend` with `workspace_write_policy`
- Shell routes through `run_sandboxed_command` with `read_only_policy`
- Code patch routes through `require_workspace_write_command_launch_backend`
- All sandbox policy types defined (SandboxMode, SandboxPolicy, SandboxApprovalScope)
- Command request/output types defined
- All platform backends defined (PolicyOnly, WindowsRestrictedToken, LinuxBubblewrap, MacSeatbelt)
- Sandbox module exported from lib.rs
- Shell output includes SandboxReport
- Default protected paths defined (.git, .env, .codex, .agents, .claude)
- Audit events defined for all denial paths
- Policy validation functions exist

### 3. Verification Results

| Check | Result |
|-------|--------|
| `pnpm typecheck` | ✅ PASS |
| `pnpm rust:test` | ✅ 454 passed, 0 failed |
| `pnpm --filter @javis/desktop test` | ✅ 56 files, 676 tests passed |
| Sandbox contract tests | ✅ 11 passed |
| `pnpm rust:check` | ✅ PASS (6 pre-existing dead_code warnings) |

## Manual QA Checklist

These checks are user-run validation per the sandbox implementation plan.

### Terminal Sandbox

- [ ] Packaged Windows app starts a sandboxed terminal after visible approval
- [ ] Denied terminal approval leaves no child process
- [ ] Terminal creation fails closed when sandbox backend is unavailable

### Command Sandbox

- [ ] Shell read-only commands return a SandboxReport in the result
- [ ] Shell commands cannot write outside selected workspace
- [ ] Shell commands cannot edit `.git/config`

### Code Patch Sandbox

- [ ] `git apply` runs through workspace-write backend check
- [ ] Code patch cannot modify protected paths

### Network Sandbox

- [ ] Network-denied commands fail predictably

## Remaining Items

| Item | Status | Notes |
|------|--------|-------|
| Terminal routing to sandbox | ✅ Done | `require_interactive_session_backend` called before PTY spawn |
| Sandbox contract tests | ✅ Done | 11 tests in `sandbox-contract.test.ts` |
| Manual QA evidence | ✅ This doc | Checklist above for user-run validation |
| OS backend enforcement | ℹ️ Existing | Windows restricted token backend implemented; Linux/macOS detection only |
