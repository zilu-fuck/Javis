# Sandbox Implementation Plan

This document describes how to add a Codex-inspired sandbox to Javis while
preserving the current local-first permission model.

## Sources

- OpenAI Codex sandboxing: https://developers.openai.com/codex/concepts/sandboxing
- OpenAI Codex approvals and security: https://developers.openai.com/codex/agent-approvals-security
- OpenAI Codex configuration reference: https://developers.openai.com/codex/config-reference
- OpenAI Codex Windows sandbox: https://developers.openai.com/codex/windows
- OpenAI Codex Linux sandbox notes: https://github.com/openai/codex/blob/main/codex-rs/linux-sandbox/README.md
- Javis current model: `docs/SECURITY_MODEL.md`

## Summary

Javis already has application-level safety boundaries:

- permission levels: `read`, `preview`, `confirmed_write`, and `dangerous`
- native approval bindings with preview hashes
- scoped local reads through selected workspace or scan roots
- narrow file-write paths that reject workspace escape
- browser, terminal, git, code patch, PDF, and computer-use approval brokers
- a small `run_read_only_command` allowlist

The missing layer is an OS-enforced command sandbox. Today, many write paths
are guarded before execution, but spawned processes such as shells, package
scripts, test commands, git helpers, and provider CLIs are not consistently run
inside an operating-system sandbox. The target design is to make every
model-initiated process go through a native sandbox broker.

## Goals

1. Run model-initiated commands and interactive terminal sessions through a
   single native command broker.
2. Enforce filesystem and network boundaries at the OS layer, not only through
   preflight path checks.
3. Keep the existing visible approval flow as the only way to widen scope.
4. Make the default mode useful for development: workspace reads and writes
   allowed, network disabled, sensitive project metadata protected.
5. Fail closed when a platform backend is unavailable or a command cannot be
   sandboxed.

## Completion Boundary

Sandbox implementation work is considered complete when the relevant code paths
are implemented and the automated code/test checks for that milestone pass.
Screenshot-based verification, packaged-app screenshot evidence, and manual UI
capture are outside the implementation completion gate and are left for the user
to run and assess.

## Non-Goals

- Do not replace the existing approval bindings. The sandbox complements them.
- Do not add broad `danger-full-access` automation or a persistent workspace
  setting that disables the sandbox.
- Do not allow package scripts, arbitrary shells, or provider tools to bypass
  the broker.
- Do not implement a temporary workspace sandbox before the command sandbox
  foundation exists.

## Codex-Inspired Model

Codex separates sandbox policy from approval policy:

| Layer | Responsibility |
| --- | --- |
| Sandbox policy | Decide what a process can read, write, execute, and access on the network. |
| Approval policy | Decide whether an attempted scope expansion should ask the user, retry with wider permissions, or fail. |

Javis should use the same split. The sandbox broker answers "can this process do
that?" The existing permission UI answers "should the user allow this
specific escalation?"

## Proposed Modes

These are Javis-internal sandbox modes. They are deliberately adjacent to, but
not identical with, the current Javis permission levels in
`docs/SECURITY_MODEL.md`.

| Mode | Filesystem | Network | Intended Use |
| --- | --- | --- | --- |
| `read_only` | Read workspace and approved scan roots. No writes. | Off by default. | Inspection, planning, static analysis. |
| `workspace_write` | Read workspace; write selected workspace roots; protect sensitive subpaths. | Off by default. | Default development mode. |
| `full_access_manual` | No sandbox. | Inherited from host. | Manual emergency mode only; never persisted or selected by agents. |

The initial product default should be `workspace_write` for approved workspaces
and `read_only` for untrusted or unregistered folders after an OS backend is
available. Before that backend exists, write-capable command execution should
remain blocked even if the desired policy is `workspace_write`.

`confirmed_write` remains a Javis permission level, not a sandbox mode. A
confirmed write should run with `workspace_write` filesystem boundaries plus a
matching approval binding for the planned action.

## Policy Shape

Add a native sandbox policy type in Rust:

```rust
pub(crate) enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    FullAccessManual,
}

pub(crate) struct SandboxPolicy {
    pub(crate) mode: SandboxMode,
    pub(crate) workspace_root: PathBuf,
    pub(crate) writable_roots: Vec<PathBuf>,
    pub(crate) readable_roots: Vec<PathBuf>,
    pub(crate) protected_paths: Vec<PathBuf>,
    pub(crate) network_access: bool,
    pub(crate) approval_required: bool,
    pub(crate) approval: Option<SandboxApprovalScope>,
}

pub(crate) struct SandboxApprovalScope {
    pub(crate) approval_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) tool_name: String,
    pub(crate) preview_hash: String,
}
```

Policy invariants:

- `workspace_root`, `writable_roots`, `readable_roots`, and `protected_paths`
  must be canonicalized before execution.
- `writable_roots` and `readable_roots` must stay under `workspace_root` unless
  a native scan-root id or another explicit trusted-root source grants the root.
- `protected_paths` are always deny-overrides inside otherwise writable roots.
- `approval_required = true` requires a non-empty `approval` scope before the
  command can run.

Default protected paths inside every writable root:

- `.git`
- `.codex`
- `.agents`
- `.claude`
- `.env`
- `.env.*`
- private key and certificate files
- known credential folders already listed in `scan.rs`

The protected path list should be shared with local read/write guards so the
project has one source of truth for sensitive paths.

## Native Broker

Create a new Rust module:

```text
apps/desktop/src-tauri/src/sandbox.rs
```

Primary API:

```rust
pub(crate) struct SandboxCommandRequest {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) policy: SandboxPolicy,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) timeout_ms: Option<u64>,
}

pub(crate) struct SandboxCommandOutput {
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) sandbox: SandboxReport,
}

pub(crate) struct SandboxReport {
    pub(crate) backend: SandboxBackend,
    pub(crate) enforced: bool,
    pub(crate) mode: SandboxMode,
    pub(crate) network_access: bool,
    pub(crate) writable_roots: Vec<String>,
    pub(crate) protected_path_count: usize,
    pub(crate) denial_reason: Option<String>,
}

pub(crate) enum SandboxBackend {
    PolicyOnly,
    WindowsRestrictedToken,
    LinuxBubblewrap,
    MacSeatbelt,
    Unavailable,
}

pub(crate) fn run_sandboxed_command(
    request: SandboxCommandRequest,
) -> Result<SandboxCommandOutput, JavisError>
```

All command execution paths should eventually call this broker:

- `shell::run_read_only_command`
- `terminal::terminal_create`
- code patch `git apply --check`
- code patch `git apply`
- git preview/execute helpers
- provider CLI proposal calls
- local vision worker process starts, if model-controlled inputs become able to
  influence execution

## Platform Backends

### Phase 1: Policy Broker Without OS Sandbox

Implement `sandbox.rs` with strict validation and an explicit
`SandboxBackend::Unavailable` report for anything that needs OS enforcement. This
phase does not claim OS isolation. It gives all callers a single interface and
makes test coverage possible before platform-specific work.

This phase must not broaden command execution. Existing allowlisted read-only
commands may keep running through the broker, but new write-capable, network-
capable, or interactive commands should fail closed until a real backend exists.

Validation:

- `cwd` must canonicalize under the selected workspace.
- executable must not resolve inside the workspace unless explicitly allowed.
- `read_only` rejects commands outside the current small allowlist.
- `workspace_write` returns `SandboxBackend::Unavailable` for commands that need write
  enforcement before the platform backend exists.
- `network_access = false` is only fully enforceable after a platform backend;
  until then, non-allowlisted network-capable commands must not run.
- `full_access_manual` requires explicit manual approval and must not be used
  by agent plans.

### Phase 2: Windows Backend

Javis is currently a Windows-first desktop app, so this is the first real
backend.

Recommended implementation shape:

1. Start with a non-admin backend based on a restricted token, constrained
   environment, canonicalized `cwd`, and a Job Object for process-tree control.
2. Add an elevated optional backend only if Windows requires it for stronger
   ACL or firewall enforcement.
3. Grant write capability only to approved writable roots without permanently
   mutating user ACLs in place. If ACL changes are unavoidable, they must be
   scoped to a dedicated sandbox identity and cleaned up deterministically.
4. Remove or deny write capability for protected paths inside writable roots.
5. When network is disabled, enforce it with the strongest available backend
   capability. If the active backend cannot enforce network denial, the command
   must fail closed instead of running with a warning.
6. For interactive terminal sessions, bind PTY creation to the same sandboxed
   process launcher.

If any step cannot be enforced, the broker must fail closed and report the
missing backend capability.

`SandboxReport.enforced` must mean that OS-level restrictions were actually
applied. Policy-only validation may report `SandboxBackend::PolicyOnly`, but it
must leave `enforced = false` so audit records do not overstate isolation.

### Phase 3: Linux and WSL Backend

Use `bubblewrap` when available.

Expected behavior:

- mount the host filesystem read-only
- bind writable roots back as writable
- bind protected paths as read-only or mask them
- isolate PID and user namespaces
- disable or isolate network when `network_access = false`
- reject symlink-based protected path escapes

If `bubblewrap` is missing, return an unavailable-backend error rather than
running unsandboxed.

### Phase 4: macOS Backend

Use Seatbelt profiles.

Expected behavior:

- allow reads for workspace and configured read roots
- allow writes only for writable roots
- deny writes to protected paths
- deny network by default
- pass a generated profile to the sandboxed process launcher

This should land after Windows and Linux because the current app and QA flow are
Windows-centered.

## Approval Integration

The existing `NativeApprovalBinding` should remain the durable contract between
UI approval and native execution.

Add one shared helper:

```rust
pub(crate) fn require_sandbox_escalation_approval(
    policy: &SandboxPolicy,
    binding: &NativeApprovalBinding,
) -> Result<(), JavisError>
```

Use it when:

- network is requested from a default-off mode
- a command needs `workspace_write` from a `read_only` plan
- a terminal session starts
- terminal input sends Enter or writes text into an interactive process
- a provider CLI or git operation can mutate workspace state

The helper should validate `policy.approval` against the existing
`require_native_approval_binding` contract: approval id, task id, tool name, and
preview hash must match the pending native approval. It must not trust
renderer-provided approval fields without comparing them to the native pending
approval state.

Because `NativeApprovalBinding` fields are private, `sandbox.rs` should not
inspect them directly. The owning module for each operation should either call
`require_native_approval_binding` before constructing the sandbox policy, or
pass the pending binding into a shared helper that delegates to
`require_native_approval_binding`.

Approvals must continue to bind:

- approval id
- task id
- tool name
- preview hash
- affected paths or command summary
- one-shot consumption for high-risk actions

## Permission Controls

The UI may expose three sandbox-specific permission controls in addition to the
existing one-shot approve and deny actions, but each control must map to the
native permission boundary instead of bypassing it.

| Control | Allowed Behavior | Boundary |
| --- | --- | --- |
| Request approval | Create or refresh a dry-run plan and `PermissionRequest`; disable the control when no planner exists for the action. | Must not execute the action. Execution still requires native approval id, task id, tool name, and preview hash checks. |
| Approve for me | May map only to `approved_always` for explicit task-scoped leases, such as selected low-risk Computer Use actions. | The model must never approve its own request. Do not expose this as an enabled action for git stage, commit, push, pull request creation, pull request comments, browser write actions, terminal create/input, or any request with `allowAlways: false`. |
| Full access | May be shown only as a manual escalation request or disabled experimental entry. | Must not be implemented by trusting renderer `permissionMode = "full_access"`. Native commands must continue to reject self-reported full access unless a future manual full-access backend and approval policy explicitly support it. |

Current boundaries already point in this direction: `PermissionDecision`
supports `approved_always`, `PermissionRequest.allowAlways` can disable it for
specific flows, and native browser/terminal write paths reject self-reported
`full_access`, `confirmed_write`, and `read_only` modes in favor of approval
bindings.

The user-facing label for `approved_always` should prefer wording such as
`Allow this task` over `Approve for me`, because approval still belongs to the
user and the permission lease remains scoped by policy.

### Composer Placement

Permission controls belong in the lower control area of the chat input box
(`ChatComposer`), alongside other composer actions. They should not become a
separate floating panel or a primary action cluster inside the task transcript.

Layout requirements:

- The lower composer control area is the action row below the textarea in
  `ChatComposer`, not the attachment/status area above the textarea.
- `Request approval` may appear before a pending permission state exists when
  the current input, selected tool, or draft action has a planner. It creates or
  refreshes the dry-run plan; it must not execute the action.
- One-shot approval, task-scoped approval, and deny controls appear only after a
  pending permission request or native approval preview exists and still matches
  the current task/composer context.
- Manual full-access request controls may appear only as disabled or explicit
  escalation entries until a real full-access backend and approval policy exist.
- Task transcript sections may still show the approval preview, affected paths,
  screenshot preview, risk summary, and final status, but they should not be the
  main place where the user grants permission.
- The controls must remain visually attached to the current input/composer
  context, so the user understands that permission changes affect the current
  task or pending input rather than global app state.
- Disabled controls should stay visible only when they explain an available but
  currently blocked action, such as manual full access before a backend exists.

### Chinese Localization

Permission controls must be localized through the existing workbench locale
layer instead of hard-coded English strings. The Chinese copy should preserve
the security boundary, not merely translate button names literally.

Recommended Chinese labels:

| Internal Meaning | English Label | Chinese Label | Notes |
| --- | --- | --- | --- |
| Create approval plan | Request approval | 请求授权 | Indicates that execution has not happened yet. |
| One-shot approval | Approve | 批准本次 | Applies only to the current preview hash and approval id. |
| Task-scoped lease | Allow this task | 允许本任务 | Prefer this over `替我审批`; the user is granting a scoped lease, not letting the model approve itself. |
| Deny | Deny | 拒绝 | Must leave the operation unexecuted. |
| Manual full access request | Full access | 请求完全访问 | Show only as disabled or manual escalation until a real backend and policy exist; avoid implying that full access is already active. |

Do not expose raw permission identifiers such as `approved_always`,
`confirmed_write`, `full_access_manual`, or `workspace_write` directly in the
Chinese UI. Map them to explanatory localized copy, for example `确认写入`,
`工作区写入`, and `手动完全访问`, with short helper text when the distinction
affects user consent.

Chinese localization is part of the implementation acceptance criteria for any
new permission control. Tests should assert that English and Chinese labels are
present through the locale layer, and that misleading copy such as `替我审批`
does not appear for task-scoped approval leases.

## Current Code Mapping

| Existing Area | Current Guard | Sandbox Migration |
| --- | --- | --- |
| `shell.rs` | Small read-only allowlist and trusted executable resolution. | Keep allowlist; run allowed commands through `sandbox::run_sandboxed_command`. |
| `terminal.rs` | Native approval for terminal create/input. | Launch PTY child through sandbox backend after approval. |
| `code.rs` | Patch hash, changed-file list, workspace path checks, `git apply`. | Run `git apply --check` and `git apply` through sandbox broker. |
| `file_write.rs` | Workspace-relative create-only text writes. | Keep direct write guard; no process sandbox needed unless delegated to external tool. |
| `git.rs` | Git operation previews and approvals. | Route mutating git operations through sandbox broker and protect `.git` unless the specific operation is approved. |
| `browser.rs` | Native approval binding for write-like browser actions. | Keep browser approval model; separate browser profile isolation remains browser-specific. |
| `computer.rs` | Per-action and task approval leases. | Keep out of filesystem sandbox; it controls desktop UI, not command execution. |
| `scan.rs` | Canonicalized root checks and sensitive path filtering. | Share sensitive path helpers with sandbox protected paths. |

When migrating `shell.rs`, keep the existing trusted executable lookup and
`read_only_command_args` hardening. The broker should wrap that behavior, not
replace it with raw `Command::new(program)`.

`code.rs` patch application should receive working-tree write capability only.
It should not receive `.git` write capability. Git stage, commit, push, pull
request creation, and pull request comment operations should each receive
separate narrow capabilities after their existing approval plans are accepted.

## Temporary Workspace Sandbox

`docs/IMPROVEMENT_PLAN.md` already lists "Sandbox Mode" for exploratory write
tasks. That feature should come after the command sandbox.

Design:

1. Create a temporary copy under an ignored product-controlled directory such as
   `.codex-tmp/javis-sandboxes/<task-id>`.
2. Run exploratory writes only inside that temporary root.
3. Show a diff against the real workspace.
4. Require confirmed-write approval before applying the diff to the real
   workspace.
5. Delete or archive the temporary root after completion based on user choice.

Prefer a plain copy for the first version. A Git worktree can share metadata
with the real repository, so it should wait until the `.git` capability model is
defined.

This is useful for large refactors, generated files, and dependency updates,
but it is not a substitute for OS sandboxing because commands inside the temp
workspace can still try to read or write elsewhere.

## Configuration

Add persisted workspace-level settings:

```json
{
  "sandbox": {
    "mode": "workspace_write",
    "networkAccess": false,
    "writableRoots": ["."],
    "protectedPaths": [".git", ".codex", ".agents", ".claude", ".env", ".env.*"]
  }
}
```

Rules:

- Global defaults can only narrow workspace settings unless the user explicitly
  confirms a wider mode.
- Saved workspaces may remember their sandbox mode.
- A task may request escalation, but only the UI approval broker can grant it.
- `full_access_manual` must not be stored in workspace settings and must never
  be selected automatically by model output.

## Audit Events

Every sandboxed process should emit structured audit records:

- command and args summary
- resolved executable path
- cwd
- sandbox mode
- backend name and version/capability report
- writable roots
- protected path count
- network enabled or disabled
- approval id, when used
- exit code
- stdout/stderr truncation metadata
- denial reason, when blocked

This should reuse the existing JSONL audit flow rather than inventing a second
log store.

## Test Plan

Rust unit tests for policy validation:

- rejects `cwd` outside workspace
- rejects executable resolved from workspace by default
- rejects write mode without writable root
- rejects non-allowlisted commands that would need network while
  `network_access = false`
- marks `.git`, `.codex`, `.agents`, `.claude`, and `.env` as protected
- rejects configured writable roots that escape the workspace through symlinks
- requires approval for mode escalation

Rust unit tests for approval integration:

- validates sandbox approval scope against `NativeApprovalBinding`
- rejects mismatched approval id, task id, tool name, or preview hash
- verifies `sandbox.rs` does not duplicate approval-binding internals
- keeps one-shot approval consumption in the existing execute path rather than
  duplicating approval state inside `sandbox.rs`

Rust integration tests where backend is available:

- read-only command can read workspace file and cannot create a file
- workspace-write command can create a file in writable root
- workspace-write command cannot modify protected paths
- network-denied command cannot reach public hosts
- terminal child process inherits the same filesystem restrictions

TypeScript tests:

- runtime shows approval request before sandbox escalation
- denied approval does not call native execute command
- stale preview hash fails closed
- task history records sandbox denial with user-facing error
- permission controls render in the lower `ChatComposer` action row while the
  task transcript keeps only preview/status information
- `Request approval` can render before a pending permission request when a
  planner exists, while approve/deny controls render only for a matching pending
  request or native approval preview
- permission controls render through the locale layer in English and Chinese,
  including `Allow this task` / `允许本任务` and no `替我审批` copy

Manual QA:

These checks are user-run validation, not implementation completion blockers:

- packaged Windows app starts a sandboxed terminal after visible approval
- denied terminal approval leaves no child process
- sandboxed command cannot write outside selected workspace
- sandboxed command cannot edit `.git/config`
- network-denied command fails predictably

## Rollout Plan

1. Add `sandbox.rs` broker, policy structs, and tests without broadening
   existing execution behavior.
2. Route `shell::run_read_only_command` through the broker-mediated path and
   include a sandbox report in the result.
3. Add Windows backend and gate it behind a feature flag.
4. Route terminal create/input through the Windows backend.
5. Route code patch `git apply` through the backend with working-tree write
   capability and protected `.git`.
6. Add narrow git capabilities for stage, commit, push, pull request creation,
   and pull request comments.
7. Turn sandbox backend failures into blocking errors for model-initiated
   commands.
8. Add Linux/WSL bubblewrap backend.
9. Add macOS Seatbelt backend.
10. Add temporary workspace sandbox for exploratory write tasks.

## Open Questions

- Should `.git` be always protected, or should approved git operations receive a
  narrow `.git` write capability?
- Should package installs be allowed only in temporary workspace sandboxes?
- Should network approval be per command, per task, or per trusted workspace?
- How should long-running terminal sessions handle sandbox policy changes after
  creation?
- Should provider CLIs run with a scrubbed environment by default, passing only
  explicit per-run credentials?

## Recommended First Milestone

The first milestone should be narrow:

1. Implement `sandbox.rs` policy validation and a broker-mediated command path
   for existing allowlisted read-only commands.
2. Route `shell::run_read_only_command` through it.
3. Add Rust tests for workspace containment, protected paths, executable
   resolution, and network-disabled policy.
4. Update `docs/SECURITY_MODEL.md` only after the broker is wired, so the docs
   do not claim enforcement before it exists.

This gives Javis a stable integration point without overpromising OS isolation
before the Windows backend is ready.
