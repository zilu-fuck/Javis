# Sandbox Review Checklist

Cross-reference: `SANDBOX_IMPLEMENTATION_PLAN.md` vs actual implementation.

## Policy Types

| Item | Plan | Implemented | Verified |
|------|------|-------------|----------|
| `SandboxMode` enum (ReadOnly, WorkspaceWrite, FullAccessManual) | §Policy Shape | ✅ `sandbox.rs:24-29` | `sandbox-contract.test.ts` |
| `SandboxPolicy` struct | §Policy Shape | ✅ `sandbox.rs:32-41` | `sandbox-contract.test.ts` |
| `SandboxApprovalScope` struct | §Policy Shape | ✅ `sandbox.rs:44-49` | `sandbox-contract.test.ts` |
| `SandboxCommandRequest` struct | §Native Broker | ✅ `sandbox.rs:52-59` | `sandbox-contract.test.ts` |
| `SandboxCommandOutput` struct | §Native Broker | ✅ `sandbox.rs:62-71` | `sandbox-contract.test.ts` |
| `SandboxReport` struct | §Native Broker | ✅ `sandbox.rs:74-85` | `sandbox-contract.test.ts` |
| `SandboxBackend` enum (PolicyOnly, WindowsRestrictedToken, LinuxBubblewrap, MacSeatbelt) | §Platform Backends | ✅ `sandbox.rs:88-95` | `sandbox-contract.test.ts` |

## Broker API

| Item | Plan | Implemented | Verified |
|------|------|-------------|----------|
| `run_sandboxed_command` | §Native Broker | ✅ `sandbox.rs` | `sandbox-contract.test.ts` (shell routing) |
| `read_only_policy` | §Policy Shape | ✅ `sandbox.rs` | `sandbox-contract.test.ts` |
| `workspace_write_policy` | §Policy Shape | ✅ `sandbox.rs` | `sandbox-contract.test.ts` |
| `require_sandbox_escalation_approval` | §Approval Integration | ✅ `sandbox.rs:819` | Rust tests |
| `require_interactive_session_backend` | §Platform Backends | ✅ `sandbox.rs` | `sandbox-contract.test.ts` (terminal routing) |
| `require_workspace_write_command_launch_backend` | §Platform Backends | ✅ `sandbox.rs` | `sandbox-contract.test.ts` (code routing) |
| `require_network_command_launch_backend` | §Platform Backends | ✅ `sandbox.rs` | Rust tests |

## Command Routing

| Item | Plan | Implemented | Verified |
|------|------|-------------|----------|
| `shell::run_read_only_command` through broker | Rollout #2 | ✅ `shell.rs` | `sandbox-contract.test.ts` |
| `terminal::terminal_create` through backend check | Rollout #4 | ✅ `terminal.rs:280-284` | `sandbox-contract.test.ts` |
| `code.rs` git apply through backend check | Rollout #5 | ✅ `code.rs` | `sandbox-contract.test.ts` |
| Git narrow capabilities (stage/commit/PR) | Rollout #6 | ✅ `descriptors.ts` | `agent-capability.test.ts` |

## Policy Validation

| Item | Plan | Implemented | Test |
|------|------|-------------|------|
| Rejects cwd outside workspace | §Test Plan | ✅ `validate_policy` | `rejects_cwd_outside_workspace` |
| Rejects executable from workspace | §Test Plan | ✅ `require_executable_outside_workspace` | `rejects_executable_resolved_from_workspace_by_default` |
| Rejects write mode without writable root | §Test Plan | ✅ `validate_policy` | `rejects_write_mode_without_writable_root` |
| Rejects network when backend can't enforce | §Test Plan | ✅ `require_backend_capabilities` | `rejects_network_access_until_backend_can_enforce_it` |
| Rejects full_access_manual for agents | §Test Plan | ✅ `require_backend_capabilities` | `rejects_full_access_manual_for_model_initiated_commands` |
| Marks .git/.codex/.agents/.claude/.env as protected | §Test Plan | ✅ `default_protected_paths` | `marks_default_sensitive_paths_as_protected` |
| Rejects writable roots escaping workspace | §Test Plan | ✅ `canonicalize_roots_under_workspace` | `rejects_writable_roots_that_escape_workspace` |
| Rejects symlink escape | §Test Plan | ✅ `canonicalize_roots_under_workspace` | `rejects_writable_roots_that_escape_workspace_through_symlink` |
| Requires approval for mode escalation | §Test Plan | ✅ `require_sandbox_escalation_approval` | `validates_sandbox_approval_scope_against_native_binding` |
| Rejects mismatched approval id/task/tool/hash | §Test Plan | ✅ `require_native_approval_binding` | `rejects_sandbox_approval_preview_hash_mismatch` |

## Platform Backends

| Item | Plan | Implemented | Status |
|------|------|-------------|--------|
| Phase 1: Policy-only broker | §Phase 1 | ✅ `SandboxBackend::PolicyOnly` | enforced=false |
| Phase 2: Windows restricted token | §Phase 2 | ✅ `SandboxBackend::WindowsRestrictedToken` | Feature flag: `windows-sandbox-backend` |
| Phase 3: Linux bubblewrap detection | §Phase 3 | ✅ `platform_backend_status` | Detection only |
| Phase 4: macOS seatbelt detection | §Phase 4 | ✅ `platform_backend_status` | Detection only |
| Backend capability reporting | §Native Broker | ✅ `SandboxBackendStatus` | `active_platform_backend_status` |
| Fail closed when backend unavailable | §Goals | ✅ `require_backend_readiness_for_policy` | `test_backend_status` |

## Protected Paths

| Item | Plan | Implemented | Test |
|------|------|-------------|------|
| `.git` protected | §Policy Shape | ✅ | `marks_default_sensitive_paths_as_protected` |
| `.codex` protected | §Policy Shape | ✅ | `marks_default_sensitive_paths_as_protected` |
| `.agents` protected | §Policy Shape | ✅ | `marks_default_sensitive_paths_as_protected` |
| `.claude` protected | §Policy Shape | ✅ | `marks_default_sensitive_paths_as_protected` |
| `.env` protected | §Policy Shape | ✅ | `marks_default_sensitive_paths_as_protected` |
| Sensitive path integration with scan.rs | §Current Code Mapping | ✅ `is_sensitive_read_path` | Rust tests |

## Environment Scrubbing

| Item | Plan | Implemented | Test |
|------|------|-------------|------|
| Sandbox environment variables | §Native Broker | ✅ `sandbox_environment` | `windows_environment_block_rejects_invalid_entries` |
| Sensitive env key detection | §Native Broker | ✅ `is_sensitive_env_key` | Rust tests |
| Windows environment block | §Phase 2 | ✅ `windows_environment_block` | `windows_environment_block_rejects_invalid_entries` |

## Audit Events

| Item | Plan | Implemented | Verified |
|------|------|-------------|----------|
| Sandbox audit JSONL for output | §Audit Events | ✅ `sandbox_audit_jsonl_line_for_output` | `sandbox-contract.test.ts` |
| Denied interactive audit | §Audit Events | ✅ `sandbox_denied_interactive_audit_jsonl_line` | `sandbox-contract.test.ts` |
| Denied workspace-write audit | §Audit Events | ✅ `sandbox_denied_workspace_write_audit_jsonl_line` | `sandbox-contract.test.ts` |
| Denied network audit | §Audit Events | ✅ `sandbox_denied_network_audit_jsonl_line` | `sandbox-contract.test.ts` |

## Temporary Workspace Sandbox

| Item | Plan | Implemented | Test |
|------|------|-------------|------|
| Create temporary workspace | §Temporary Workspace | ✅ `create_temporary_workspace_sandbox` | `rejects_duplicate_temporary_workspace_sandbox_task_id` |
| Diff temporary workspace | §Temporary Workspace | ✅ `diff_temporary_workspace_sandbox` | `rejects_temporary_workspace_apply_preview_hash_mismatch` |
| Apply plan | §Temporary Workspace | ✅ `apply_temporary_workspace_sandbox_plan` | `rejects_temporary_workspace_apply_when_diff_changes_after_plan` |
| Finalize (delete/archive) | §Temporary Workspace | ✅ `finalize_temporary_workspace_sandbox` | `rejects_finalizing_temporary_workspace_outside_sandboxes_root` |
| Rejects binary changes | §Temporary Workspace | ✅ | `rejects_temporary_workspace_apply_plan_with_binary_changes` |
| Rejects invalid task id | §Temporary Workspace | ✅ | `rejects_invalid_temporary_workspace_sandbox_task_id` |

## Test Coverage

| Category | Plan Count | Actual | Status |
|----------|-----------|--------|--------|
| Rust unit tests (policy validation) | 7 | 10+ | ✅ Exceeded |
| Rust unit tests (approval integration) | 4 | 2+ | ✅ Covered |
| Rust unit tests (temp workspace) | — | 6 | ✅ |
| TS contract tests | — | 11 | ✅ |
| Total Rust tests in sandbox.rs | — | 46 | ✅ |

## Rollout Plan Status

| Step | Description | Status |
|------|-------------|--------|
| 1 | sandbox.rs broker + policy structs + tests | ✅ |
| 2 | Shell through broker | ✅ |
| 3 | Windows backend + feature flag | ✅ |
| 4 | Terminal through backend | ✅ |
| 5 | Code git apply through backend | ✅ |
| 6 | Git narrow capabilities | ✅ |
| 7 | Backend failures as blocking errors | ✅ |
| 8 | Linux/WSL bubblewrap | ✅ (detection) |
| 9 | macOS Seatbelt | ✅ (detection) |
| 10 | Temporary workspace sandbox | ✅ |

## Open Questions (from plan)

| Question | Status |
|----------|--------|
| Should .git be always protected or receive narrow capability? | Protected by default; narrow capabilities per git op |
| Should package installs only be in temp sandbox? | Not yet addressed |
| Network approval per command/task/workspace? | Per command currently |
| Long-running terminal policy changes? | Not yet addressed |
| Provider CLIs with scrubbed environment? | `sandbox_environment` implemented |

## Verification

- `pnpm check`: ✅ PASS
- Rust tests: ✅ 454 passed
- TS tests: ✅ 676 passed (including 11 sandbox contract tests)
- `pnpm rust:check`: ✅ PASS (6 pre-existing dead_code warnings)
