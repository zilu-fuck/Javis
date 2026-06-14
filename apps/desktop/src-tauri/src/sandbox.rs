use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    approve_native_approval_binding, create_approval_id, create_fnv1a_hash,
    create_native_approval_binding,
    error::JavisError,
    normalize_path, require_native_approval_binding,
    scan::is_sensitive_read_path,
    shell::{
        is_allowed_read_only_command, is_retryable_windows_process_initialization_exit,
        read_only_command_args, resolve_trusted_read_only_executable,
    },
    NativeApprovalBinding,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    #[allow(dead_code)]
    FullAccessManual,
}

#[derive(Clone, Debug)]
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

#[derive(Clone, Debug)]
pub(crate) struct SandboxApprovalScope {
    pub(crate) approval_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) tool_name: String,
    pub(crate) preview_hash: String,
}

#[derive(Clone, Debug)]
pub(crate) struct SandboxCommandRequest {
    pub(crate) program: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) policy: SandboxPolicy,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) stdin: Option<Vec<u8>>,
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxCommandOutput {
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) sandbox: SandboxReport,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxReport {
    pub(crate) backend: SandboxBackend,
    pub(crate) backend_status: SandboxBackendStatus,
    pub(crate) enforced: bool,
    pub(crate) mode: SandboxMode,
    pub(crate) network_access: bool,
    pub(crate) writable_roots: Vec<String>,
    pub(crate) protected_path_count: usize,
    pub(crate) denial_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SandboxAuditEvent {
    kind: &'static str,
    task_id: Option<String>,
    command: String,
    cwd: String,
    sandbox_mode: SandboxMode,
    backend: SandboxBackend,
    backend_status: SandboxBackendStatus,
    enforced: bool,
    network_access: bool,
    writable_roots: Vec<String>,
    protected_path_count: usize,
    approval_id: Option<String>,
    exit_code: Option<i32>,
    stdout_bytes: usize,
    stderr_bytes: usize,
    stdout_truncated: bool,
    stderr_truncated: bool,
    denial_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SandboxBackend {
    PolicyOnly,
    WindowsRestrictedToken,
    #[allow(dead_code)]
    LinuxBubblewrap,
    #[allow(dead_code)]
    MacSeatbelt,
    #[allow(dead_code)]
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxBackendStatus {
    pub(crate) backend: SandboxBackend,
    pub(crate) available: bool,
    pub(crate) can_spawn: bool,
    pub(crate) can_control_process_tree: bool,
    pub(crate) can_create_restricted_token: bool,
    pub(crate) can_launch_restricted_process: bool,
    pub(crate) can_evaluate_filesystem_policy: bool,
    pub(crate) can_evaluate_network_policy: bool,
    pub(crate) can_restrict_filesystem: bool,
    pub(crate) can_deny_network: bool,
    pub(crate) filesystem_boundary: SandboxBoundaryStatus,
    pub(crate) network_boundary: SandboxBoundaryStatus,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxBoundaryStatus {
    pub(crate) strategy: SandboxBoundaryStrategy,
    pub(crate) available: bool,
    pub(crate) mutates_host_state: bool,
    pub(crate) reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SandboxBoundaryStrategy {
    #[allow(dead_code)]
    WindowsAppContainer,
    #[allow(dead_code)]
    WindowsDedicatedIdentityAcl,
    #[allow(dead_code)]
    WindowsFirewallRule,
    #[allow(dead_code)]
    WindowsIntegrityLevel,
    #[allow(dead_code)]
    WindowsDisabledNetworkSid,
    #[allow(dead_code)]
    LinuxBubblewrap,
    #[allow(dead_code)]
    MacSeatbelt,
    NotImplemented,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SandboxBackendAssessment {
    requirement_label: &'static str,
    missing_capabilities: Vec<&'static str>,
    status: SandboxBackendStatus,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
struct SandboxLaunchPlan {
    command: String,
    executable: PathBuf,
    args: Vec<String>,
    windows_command_line: String,
    windows_command_line_wide: Vec<u16>,
    windows_cwd_wide: Vec<u16>,
    environment: Vec<(String, String)>,
    windows_environment_block: Vec<u16>,
    cwd: PathBuf,
    mode: SandboxMode,
    network_access: bool,
    network_policy: SandboxNetworkPolicy,
    readable_roots: Vec<PathBuf>,
    writable_roots: Vec<PathBuf>,
    protected_paths: Vec<PathBuf>,
    filesystem_rules: Vec<SandboxFilesystemRule>,
    windows_enforcement_manifest: WindowsSandboxEnforcementManifest,
    protected_path_count: usize,
    backend: SandboxBackendAssessment,
    launch_readiness: SandboxLaunchReadiness,
    stdin: Option<Vec<u8>>,
}

const TEMP_WORKSPACE_APPLY_TOOL_NAME: &str = "sandbox.tempWorkspaceApply";

#[derive(Default)]
pub(crate) struct TemporaryWorkspaceApplyApprovalState {
    pending: Option<PendingTemporaryWorkspaceApplyApproval>,
}

struct PendingTemporaryWorkspaceApplyApproval {
    binding: NativeApprovalBinding,
    plan: TemporaryWorkspaceApplyPlan,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporaryWorkspaceSandbox {
    pub(crate) task_id: String,
    pub(crate) real_workspace_root: PathBuf,
    pub(crate) sandbox_root: PathBuf,
    pub(crate) copied_files: usize,
    pub(crate) copied_directories: usize,
    pub(crate) skipped_entries: usize,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporaryWorkspaceDiff {
    pub(crate) real_workspace_root: PathBuf,
    pub(crate) sandbox_root: PathBuf,
    pub(crate) changed_files: Vec<TemporaryWorkspaceDiffFile>,
    pub(crate) unified_diff: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporaryWorkspaceDiffFile {
    pub(crate) path: PathBuf,
    pub(crate) change: TemporaryWorkspaceDiffChange,
    pub(crate) text_diff: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TemporaryWorkspaceDiffChange {
    Added,
    Modified,
    Deleted,
    BinaryChanged,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporaryWorkspaceApplyPlan {
    pub(crate) real_workspace_root: PathBuf,
    pub(crate) sandbox_root: PathBuf,
    pub(crate) changed_files: Vec<PathBuf>,
    pub(crate) preview_hash: String,
    pub(crate) unified_diff: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) approval_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) task_id: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporaryWorkspaceApplyResult {
    pub(crate) applied_files: usize,
    pub(crate) deleted_files: usize,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TemporaryWorkspaceFinalizeMode {
    Delete,
    Archive,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemporaryWorkspaceFinalizeResult {
    pub(crate) mode: TemporaryWorkspaceFinalizeMode,
    pub(crate) sandbox_root: PathBuf,
    pub(crate) archived_to: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowsSandboxEnforcementManifest {
    requires_job_object: bool,
    requires_restricted_token: bool,
    requires_filesystem_boundary: bool,
    requires_network_boundary: bool,
    allow_permanent_acl_mutation: bool,
    filesystem_rules: Vec<WindowsSandboxFilesystemRule>,
    network_policy: SandboxNetworkPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WindowsSandboxFilesystemRule {
    access: SandboxFilesystemAccess,
    path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SandboxLaunchReadiness {
    ready: bool,
    blocked_reasons: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SandboxFilesystemRule {
    access: SandboxFilesystemAccess,
    path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SandboxFilesystemAccess {
    Deny,
    ReadOnly,
    ReadWrite,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SandboxNetworkPolicy {
    DenyAll,
    AllowAll,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SandboxBackendRequirement {
    label: &'static str,
    requires_spawn: bool,
    requires_filesystem_restriction: bool,
    requires_network_denial: bool,
}

struct ValidatedPolicy {
    mode: SandboxMode,
    workspace_root: PathBuf,
    readable_roots: Vec<PathBuf>,
    writable_roots: Vec<PathBuf>,
    protected_paths: Vec<PathBuf>,
    network_access: bool,
}

#[allow(dead_code)]
#[derive(Default)]
struct TemporaryWorkspaceCopyStats {
    copied_files: usize,
    copied_directories: usize,
    skipped_entries: usize,
}

impl SandboxBackendRequirement {
    fn workspace_write_command() -> Self {
        Self {
            label: "workspace_write_command",
            requires_spawn: true,
            requires_filesystem_restriction: true,
            requires_network_denial: false,
        }
    }

    fn network_command() -> Self {
        Self {
            label: "network_command",
            requires_spawn: true,
            requires_filesystem_restriction: true,
            requires_network_denial: false,
        }
    }

    fn interactive_session() -> Self {
        Self {
            label: "interactive_session",
            requires_spawn: true,
            requires_filesystem_restriction: true,
            requires_network_denial: false,
        }
    }

    fn manual_full_access() -> Self {
        Self {
            label: "manual_full_access",
            requires_spawn: true,
            requires_filesystem_restriction: false,
            requires_network_denial: false,
        }
    }
}

pub(crate) fn read_only_policy(workspace_root: &Path) -> SandboxPolicy {
    SandboxPolicy {
        mode: SandboxMode::ReadOnly,
        workspace_root: workspace_root.to_path_buf(),
        writable_roots: Vec::new(),
        readable_roots: vec![workspace_root.to_path_buf()],
        protected_paths: default_protected_paths(workspace_root),
        network_access: false,
        approval_required: false,
        approval: None,
    }
}

pub(crate) fn workspace_write_policy(
    workspace_root: &Path,
    writable_roots: Vec<PathBuf>,
) -> SandboxPolicy {
    SandboxPolicy {
        mode: SandboxMode::WorkspaceWrite,
        workspace_root: workspace_root.to_path_buf(),
        writable_roots,
        readable_roots: vec![workspace_root.to_path_buf()],
        protected_paths: default_protected_paths(workspace_root),
        network_access: false,
        approval_required: false,
        approval: None,
    }
}

#[allow(dead_code)]
pub(crate) fn create_temporary_workspace_sandbox(
    workspace_root: &Path,
    task_id: &str,
) -> Result<TemporaryWorkspaceSandbox, JavisError> {
    let real_workspace_root = canonicalize_existing_dir(workspace_root, "workspace root")?;
    let task_id = sanitize_temporary_sandbox_task_id(task_id)?;
    let sandboxes_root = temporary_workspace_sandboxes_root(&real_workspace_root);
    let sandbox_root = sandboxes_root.join(&task_id);
    if sandbox_root.exists() {
        return Err(JavisError::Validation(format!(
            "Temporary workspace sandbox already exists for task {task_id}."
        )));
    }
    fs::create_dir_all(&sandbox_root).map_err(|error| {
        JavisError::Io(format!(
            "Could not create temporary workspace sandbox {}: {error}",
            normalize_path(&sandbox_root)
        ))
    })?;
    let mut stats = TemporaryWorkspaceCopyStats::default();
    copy_workspace_into_temporary_sandbox(&real_workspace_root, &sandbox_root, &mut stats)?;
    Ok(TemporaryWorkspaceSandbox {
        task_id,
        real_workspace_root,
        sandbox_root,
        copied_files: stats.copied_files,
        copied_directories: stats.copied_directories,
        skipped_entries: stats.skipped_entries,
    })
}

#[allow(dead_code)]
pub(crate) fn diff_temporary_workspace_sandbox(
    real_workspace_root: &Path,
    sandbox_root: &Path,
) -> Result<TemporaryWorkspaceDiff, JavisError> {
    let real_workspace_root = canonicalize_existing_dir(real_workspace_root, "workspace root")?;
    let sandbox_root = canonicalize_existing_dir(sandbox_root, "temporary workspace root")?;
    if !sandbox_root.starts_with(temporary_workspace_sandboxes_root(&real_workspace_root)) {
        return Err(JavisError::Permission(
            "Temporary workspace diff root must be under .codex-tmp/javis-sandboxes.".into(),
        ));
    }
    let real_files = collect_temporary_workspace_relative_files(&real_workspace_root)?;
    let sandbox_files = collect_temporary_workspace_relative_files(&sandbox_root)?;
    let mut paths = BTreeSet::new();
    paths.extend(real_files.iter().cloned());
    paths.extend(sandbox_files.iter().cloned());

    let mut changed_files = Vec::new();
    let mut unified_parts = Vec::new();
    for path in paths {
        let real_path = real_workspace_root.join(&path);
        let sandbox_path = sandbox_root.join(&path);
        let real_exists = real_path.is_file();
        let sandbox_exists = sandbox_path.is_file();
        let (change, text_diff) = match (real_exists, sandbox_exists) {
            (true, true) => {
                let real_bytes = fs::read(&real_path).map_err(|error| {
                    JavisError::Io(format!(
                        "Could not read real workspace file {}: {error}",
                        normalize_path(&real_path)
                    ))
                })?;
                let sandbox_bytes = fs::read(&sandbox_path).map_err(|error| {
                    JavisError::Io(format!(
                        "Could not read temporary workspace file {}: {error}",
                        normalize_path(&sandbox_path)
                    ))
                })?;
                if real_bytes == sandbox_bytes {
                    continue;
                }
                match (
                    String::from_utf8(real_bytes),
                    String::from_utf8(sandbox_bytes),
                ) {
                    (Ok(before), Ok(after)) => (
                        TemporaryWorkspaceDiffChange::Modified,
                        Some(temporary_workspace_file_diff(
                            &path,
                            Some(&before),
                            Some(&after),
                        )),
                    ),
                    _ => (TemporaryWorkspaceDiffChange::BinaryChanged, None),
                }
            }
            (false, true) => {
                let sandbox_bytes = fs::read(&sandbox_path).map_err(|error| {
                    JavisError::Io(format!(
                        "Could not read temporary workspace file {}: {error}",
                        normalize_path(&sandbox_path)
                    ))
                })?;
                match String::from_utf8(sandbox_bytes) {
                    Ok(after) => (
                        TemporaryWorkspaceDiffChange::Added,
                        Some(temporary_workspace_file_diff(&path, None, Some(&after))),
                    ),
                    Err(_) => (TemporaryWorkspaceDiffChange::BinaryChanged, None),
                }
            }
            (true, false) => {
                let real_bytes = fs::read(&real_path).map_err(|error| {
                    JavisError::Io(format!(
                        "Could not read real workspace file {}: {error}",
                        normalize_path(&real_path)
                    ))
                })?;
                match String::from_utf8(real_bytes) {
                    Ok(before) => (
                        TemporaryWorkspaceDiffChange::Deleted,
                        Some(temporary_workspace_file_diff(&path, Some(&before), None)),
                    ),
                    Err(_) => (TemporaryWorkspaceDiffChange::BinaryChanged, None),
                }
            }
            (false, false) => continue,
        };
        if let Some(diff) = &text_diff {
            unified_parts.push(diff.clone());
        }
        changed_files.push(TemporaryWorkspaceDiffFile {
            path,
            change,
            text_diff,
        });
    }

    Ok(TemporaryWorkspaceDiff {
        real_workspace_root,
        sandbox_root,
        changed_files,
        unified_diff: unified_parts.join("\n"),
    })
}

#[allow(dead_code)]
pub(crate) fn create_temporary_workspace_apply_plan(
    diff: &TemporaryWorkspaceDiff,
) -> Result<TemporaryWorkspaceApplyPlan, JavisError> {
    if diff
        .changed_files
        .iter()
        .any(|file| matches!(file.change, TemporaryWorkspaceDiffChange::BinaryChanged))
    {
        return Err(JavisError::Validation(
            "Temporary workspace apply plan cannot include binary changes yet.".into(),
        ));
    }
    let changed_files = diff
        .changed_files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let preview_hash = temporary_workspace_apply_preview_hash(&changed_files, &diff.unified_diff);
    Ok(TemporaryWorkspaceApplyPlan {
        real_workspace_root: diff.real_workspace_root.clone(),
        sandbox_root: diff.sandbox_root.clone(),
        changed_files,
        preview_hash,
        unified_diff: diff.unified_diff.clone(),
        approval_id: None,
        task_id: None,
    })
}

#[allow(dead_code)]
pub(crate) fn apply_temporary_workspace_sandbox_plan(
    plan: &TemporaryWorkspaceApplyPlan,
    approved_changed_files: &[PathBuf],
    approved_preview_hash: &str,
) -> Result<TemporaryWorkspaceApplyResult, JavisError> {
    if approved_preview_hash != plan.preview_hash {
        return Err(JavisError::Permission(
            "Temporary workspace apply preview hash does not match approval.".into(),
        ));
    }
    if approved_changed_files != plan.changed_files.as_slice() {
        return Err(JavisError::Permission(
            "Temporary workspace apply changed files do not match approval.".into(),
        ));
    }
    let current_diff =
        diff_temporary_workspace_sandbox(&plan.real_workspace_root, &plan.sandbox_root)?;
    let current_plan = create_temporary_workspace_apply_plan(&current_diff)?;
    if current_plan.preview_hash != plan.preview_hash
        || current_plan.changed_files != plan.changed_files
        || current_plan.unified_diff != plan.unified_diff
    {
        return Err(JavisError::Permission(
            "Temporary workspace diff changed before apply.".into(),
        ));
    }

    let mut applied_files = 0;
    let mut deleted_files = 0;
    for file in current_diff.changed_files {
        let real_path = plan.real_workspace_root.join(&file.path);
        let sandbox_path = plan.sandbox_root.join(&file.path);
        match file.change {
            TemporaryWorkspaceDiffChange::Added | TemporaryWorkspaceDiffChange::Modified => {
                if let Some(parent) = real_path.parent() {
                    fs::create_dir_all(parent).map_err(|error| {
                        JavisError::Io(format!(
                            "Could not create temporary workspace apply parent {}: {error}",
                            normalize_path(parent)
                        ))
                    })?;
                }
                fs::copy(&sandbox_path, &real_path).map_err(|error| {
                    JavisError::Io(format!(
                        "Could not apply temporary workspace file {} to {}: {error}",
                        normalize_path(&sandbox_path),
                        normalize_path(&real_path)
                    ))
                })?;
                applied_files += 1;
            }
            TemporaryWorkspaceDiffChange::Deleted => {
                fs::remove_file(&real_path).map_err(|error| {
                    JavisError::Io(format!(
                        "Could not delete real workspace file {}: {error}",
                        normalize_path(&real_path)
                    ))
                })?;
                deleted_files += 1;
            }
            TemporaryWorkspaceDiffChange::BinaryChanged => {
                return Err(JavisError::Validation(
                    "Temporary workspace apply cannot include binary changes yet.".into(),
                ));
            }
        }
    }
    Ok(TemporaryWorkspaceApplyResult {
        applied_files,
        deleted_files,
    })
}

fn approve_temporary_workspace_apply(
    approval_state: &Mutex<TemporaryWorkspaceApplyApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), JavisError> {
    let mut state = approval_state.lock().map_err(|_| {
        JavisError::Internal("Temporary workspace approval state could not be locked.".into())
    })?;
    let Some(pending) = state.pending.as_mut() else {
        return Err(JavisError::Permission(
            "No pending temporary workspace apply approval exists.".into(),
        ));
    };
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        TEMP_WORKSPACE_APPLY_TOOL_NAME,
        task_id,
        &pending.plan.preview_hash,
        "Temporary workspace apply approval id does not match the pending plan.",
    )
    .map_err(JavisError::Permission)
}

fn take_approved_temporary_workspace_apply(
    approval_state: &Mutex<TemporaryWorkspaceApplyApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
    current_plan: &TemporaryWorkspaceApplyPlan,
) -> Result<TemporaryWorkspaceApplyPlan, JavisError> {
    let mut state = approval_state.lock().map_err(|_| {
        JavisError::Internal("Temporary workspace approval state could not be locked.".into())
    })?;
    let Some(pending) = state.pending.as_ref() else {
        return Err(JavisError::Permission(
            "No approved temporary workspace apply plan is pending.".into(),
        ));
    };
    if pending.plan.real_workspace_root != current_plan.real_workspace_root
        || pending.plan.sandbox_root != current_plan.sandbox_root
        || pending.plan.changed_files != current_plan.changed_files
        || pending.plan.preview_hash != current_plan.preview_hash
        || pending.plan.unified_diff != current_plan.unified_diff
    {
        return Err(JavisError::Permission(
            "Temporary workspace diff changed before apply.".into(),
        ));
    }
    require_native_approval_binding(
        &pending.binding,
        approval_id,
        TEMP_WORKSPACE_APPLY_TOOL_NAME,
        task_id,
        &current_plan.preview_hash,
        "Temporary workspace apply approval id does not match the approved plan.",
        "Temporary workspace apply has not been approved.",
    )?;
    state
        .pending
        .take()
        .map(|pending| pending.plan)
        .ok_or_else(|| {
            JavisError::Permission("No approved temporary workspace apply plan is pending.".into())
        })
}

#[allow(dead_code)]
pub(crate) fn finalize_temporary_workspace_sandbox(
    real_workspace_root: &Path,
    sandbox_root: &Path,
    mode: TemporaryWorkspaceFinalizeMode,
) -> Result<TemporaryWorkspaceFinalizeResult, JavisError> {
    let real_workspace_root = canonicalize_existing_dir(real_workspace_root, "workspace root")?;
    let sandbox_root = canonicalize_existing_dir(sandbox_root, "temporary workspace sandbox root")?;
    let sandboxes_root = temporary_workspace_sandboxes_root(&real_workspace_root);
    require_temporary_workspace_sandbox_root(&real_workspace_root, &sandbox_root)?;
    match mode {
        TemporaryWorkspaceFinalizeMode::Delete => {
            fs::remove_dir_all(&sandbox_root).map_err(|error| {
                JavisError::Io(format!(
                    "Could not delete temporary workspace sandbox {}: {error}",
                    normalize_path(&sandbox_root)
                ))
            })?;
            Ok(TemporaryWorkspaceFinalizeResult {
                mode,
                sandbox_root,
                archived_to: None,
            })
        }
        TemporaryWorkspaceFinalizeMode::Archive => {
            let task_id = sandbox_root
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| {
                    JavisError::Validation(
                        "Temporary workspace sandbox root must have a task directory name.".into(),
                    )
                })?;
            let archived_to = unique_temporary_workspace_archive_path(&sandboxes_root, task_id)?;
            fs::rename(&sandbox_root, &archived_to).map_err(|error| {
                JavisError::Io(format!(
                    "Could not archive temporary workspace sandbox {} to {}: {error}",
                    normalize_path(&sandbox_root),
                    normalize_path(&archived_to)
                ))
            })?;
            Ok(TemporaryWorkspaceFinalizeResult {
                mode,
                sandbox_root,
                archived_to: Some(archived_to),
            })
        }
    }
}

#[allow(dead_code)]
fn temporary_workspace_sandboxes_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".codex-tmp").join("javis-sandboxes")
}

#[allow(dead_code)]
fn require_temporary_workspace_sandbox_root(
    real_workspace_root: &Path,
    sandbox_root: &Path,
) -> Result<(), JavisError> {
    let sandboxes_root = temporary_workspace_sandboxes_root(real_workspace_root);
    let canonical_sandboxes_root = if sandboxes_root.exists() {
        fs::canonicalize(&sandboxes_root).map_err(|error| {
            JavisError::Io(format!(
                "Could not resolve temporary workspace sandboxes root {}: {error}",
                normalize_path(&sandboxes_root)
            ))
        })?
    } else {
        sandboxes_root
    };
    if sandbox_root == canonical_sandboxes_root
        || !sandbox_root.starts_with(&canonical_sandboxes_root)
    {
        return Err(JavisError::Permission(
            "Temporary workspace sandbox root must be under .codex-tmp/javis-sandboxes.".into(),
        ));
    }
    Ok(())
}

#[allow(dead_code)]
fn unique_temporary_workspace_archive_path(
    sandboxes_root: &Path,
    task_id: &str,
) -> Result<PathBuf, JavisError> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            JavisError::Internal(format!("System clock is before Unix epoch: {error}"))
        })?
        .as_secs();
    for suffix in 0..1000 {
        let candidate = sandboxes_root.join(format!("{task_id}-archived-{stamp}-{suffix}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(JavisError::Validation(
        "Could not find an available temporary workspace archive path.".into(),
    ))
}

#[allow(dead_code)]
fn sanitize_temporary_sandbox_task_id(task_id: &str) -> Result<String, JavisError> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err(JavisError::Validation(
            "Temporary workspace sandbox task id is required.".into(),
        ));
    }
    let sanitized = task_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('.')
        .trim_matches('-')
        .chars()
        .take(80)
        .collect::<String>();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return Err(JavisError::Validation(
            "Temporary workspace sandbox task id is invalid.".into(),
        ));
    }
    Ok(sanitized)
}

// ---- Tauri command wrappers for temporary workspace sandbox ----

#[tauri::command]
pub(crate) fn temp_workspace_sandbox_create(
    workspace_root: String,
    task_id: String,
) -> Result<TemporaryWorkspaceSandbox, String> {
    let root = PathBuf::from(&workspace_root);
    create_temporary_workspace_sandbox(&root, &task_id).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn temp_workspace_sandbox_diff(
    real_workspace_root: String,
    sandbox_root: String,
) -> Result<TemporaryWorkspaceDiff, String> {
    diff_temporary_workspace_sandbox(Path::new(&real_workspace_root), Path::new(&sandbox_root))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn temp_workspace_sandbox_diff_and_plan(
    approval_state: tauri::State<'_, Mutex<TemporaryWorkspaceApplyApprovalState>>,
    real_workspace_root: String,
    sandbox_root: String,
    task_id: Option<String>,
) -> Result<TemporaryWorkspaceApplyPlan, String> {
    let diff =
        diff_temporary_workspace_sandbox(Path::new(&real_workspace_root), Path::new(&sandbox_root))
            .map_err(|error| error.to_string())?;
    let mut plan =
        create_temporary_workspace_apply_plan(&diff).map_err(|error| error.to_string())?;
    let approval_id = create_approval_id();
    plan.approval_id = Some(approval_id.clone());
    plan.task_id = task_id.clone();
    let binding = create_native_approval_binding(
        approval_id,
        TEMP_WORKSPACE_APPLY_TOOL_NAME,
        task_id.unwrap_or_default(),
        plan.preview_hash.clone(),
        false,
    );
    let mut state = approval_state
        .lock()
        .map_err(|_| "Temporary workspace approval state could not be locked.".to_string())?;
    state.pending = Some(PendingTemporaryWorkspaceApplyApproval {
        binding,
        plan: plan.clone(),
    });
    Ok(plan)
}

#[tauri::command]
pub(crate) fn temp_workspace_sandbox_approve_apply(
    approval_state: tauri::State<'_, Mutex<TemporaryWorkspaceApplyApprovalState>>,
    approval_id: String,
    task_id: Option<String>,
) -> Result<(), String> {
    approve_temporary_workspace_apply(&approval_state, &approval_id, task_id.as_deref())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn temp_workspace_sandbox_apply(
    approval_state: tauri::State<'_, Mutex<TemporaryWorkspaceApplyApprovalState>>,
    real_workspace_root: String,
    sandbox_root: String,
    approval_id: String,
    task_id: Option<String>,
) -> Result<TemporaryWorkspaceApplyResult, String> {
    let diff =
        diff_temporary_workspace_sandbox(Path::new(&real_workspace_root), Path::new(&sandbox_root))
            .map_err(|error| error.to_string())?;
    let current_plan =
        create_temporary_workspace_apply_plan(&diff).map_err(|error| error.to_string())?;
    let approved_plan = take_approved_temporary_workspace_apply(
        &approval_state,
        &approval_id,
        task_id.as_deref(),
        &current_plan,
    )
    .map_err(|error| error.to_string())?;
    apply_temporary_workspace_sandbox_plan(
        &approved_plan,
        &approved_plan.changed_files,
        &approved_plan.preview_hash,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn temp_workspace_sandbox_finalize(
    real_workspace_root: String,
    sandbox_root: String,
    mode: String,
) -> Result<TemporaryWorkspaceFinalizeResult, String> {
    let finalize_mode = match mode.as_str() {
        "delete" => TemporaryWorkspaceFinalizeMode::Delete,
        "archive" => TemporaryWorkspaceFinalizeMode::Archive,
        other => {
            return Err(format!(
                "Invalid finalize mode '{}'. Use 'delete' or 'archive'.",
                other
            ))
        }
    };
    finalize_temporary_workspace_sandbox(
        Path::new(&real_workspace_root),
        Path::new(&sandbox_root),
        finalize_mode,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn run_sandboxed_command(
    request: SandboxCommandRequest,
) -> Result<SandboxCommandOutput, JavisError> {
    let policy = validate_policy(request.policy.clone())?;
    let cwd = canonicalize_existing_dir(&request.cwd, "command cwd")?;
    if !cwd.starts_with(&policy.workspace_root) {
        return Err(JavisError::Permission(
            "Sandbox command cwd must stay inside the selected workspace.".into(),
        ));
    }

    match policy.mode {
        SandboxMode::ReadOnly => {
            if request.timeout_ms.is_some() {
                return Err(JavisError::Validation(
                    "Sandbox command timeouts require a platform backend.".into(),
                ));
            }
            if !is_allowed_read_only_command(&request.program, &request.args) {
                return Err(JavisError::Permission(
                    "Command is not in the first-version read-only allowlist.".into(),
                ));
            }
            run_policy_only_read_only_command(request, policy, cwd)
        }
        SandboxMode::WorkspaceWrite => {
            let plan = build_sandbox_launch_plan(
                &request,
                SandboxBackendRequirement::workspace_write_command(),
            )?;
            require_launch_plan_ready(
                "Workspace-write commands require an OS sandbox backend.",
                &plan,
            )?;
            let timeout = request.timeout_ms.unwrap_or(30_000).min(300_000) as u32;
            launch_ready_sandbox_plan(&plan, timeout)
        }
        SandboxMode::FullAccessManual => require_backend_capabilities(
            "Full access is not available to model-initiated commands.",
            SandboxBackendRequirement::manual_full_access(),
        )
        .map(|_| unreachable!("full-access launcher is not implemented")),
    }
}

#[allow(dead_code)]
pub(crate) fn run_sandboxed_network_command(
    request: SandboxCommandRequest,
) -> Result<SandboxCommandOutput, JavisError> {
    if !request.policy.network_access {
        return Err(JavisError::Validation(
            "Network command launch requires network_access=true.".into(),
        ));
    }
    let plan = build_sandbox_launch_plan(&request, SandboxBackendRequirement::network_command())?;
    if !plan.network_access {
        return Err(JavisError::Validation(
            "Network command launch requires network_access=true.".into(),
        ));
    }
    require_launch_plan_ready(
        "Network-capable commands require an OS sandbox backend.",
        &plan,
    )?;
    let timeout = request.timeout_ms.unwrap_or(30_000).min(300_000) as u32;
    launch_ready_sandbox_plan(&plan, timeout)
}

fn launch_ready_sandbox_plan(
    plan: &SandboxLaunchPlan,
    timeout: u32,
) -> Result<SandboxCommandOutput, JavisError> {
    #[cfg(target_os = "windows")]
    {
        let output = launch_windows_sandboxed_process(plan, timeout)?;
        if is_retryable_windows_process_initialization_exit(output.exit_code) {
            return launch_windows_sandboxed_process(plan, timeout);
        }
        Ok(output)
    }
    #[cfg(target_os = "linux")]
    {
        launch_linux_bubblewrap_process(plan, timeout)
    }
    #[cfg(target_os = "macos")]
    {
        launch_macos_seatbelt_process(plan, timeout)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Err(JavisError::Internal(
            "Sandbox launcher is not available on this platform.".into(),
        ))
    }
}

#[allow(dead_code)]
pub(crate) fn require_sandbox_escalation_approval(
    policy: &SandboxPolicy,
    binding: &NativeApprovalBinding,
) -> Result<(), JavisError> {
    let Some(approval) = &policy.approval else {
        return Err(JavisError::Permission(
            "Sandbox escalation requires a native approval scope.".into(),
        ));
    };
    require_native_approval_binding(
        binding,
        &approval.approval_id,
        &approval.tool_name,
        approval.task_id.as_deref(),
        &approval.preview_hash,
        "Sandbox approval id does not match the approved operation.",
        "Sandbox escalation has not been approved.",
    )
}

#[allow(dead_code)]
pub(crate) fn require_interactive_session_backend(policy: SandboxPolicy) -> Result<(), JavisError> {
    let policy = validate_policy(policy)?;
    require_backend_readiness_for_policy(
        "Interactive sessions require an OS sandbox backend.",
        &policy,
        SandboxBackendRequirement::interactive_session(),
    )?;
    Err(JavisError::Permission(
        "Interactive sandbox launcher is not implemented yet; refusing raw PTY spawn.".into(),
    ))
}

#[allow(dead_code)]
pub(crate) fn require_workspace_write_command_launch_backend(
    program: String,
    args: Vec<String>,
    cwd: &Path,
    policy: SandboxPolicy,
) -> Result<(), JavisError> {
    let request = SandboxCommandRequest {
        program,
        args,
        cwd: cwd.to_path_buf(),
        policy,
        env: Vec::new(),
        stdin: None,
        timeout_ms: None,
    };
    let plan = build_sandbox_launch_plan(
        &request,
        SandboxBackendRequirement::workspace_write_command(),
    )?;
    if !matches!(plan.mode, SandboxMode::WorkspaceWrite) {
        return Err(JavisError::Validation(
            "Workspace-write command launch requires workspace_write mode.".into(),
        ));
    }
    require_launch_plan_ready(
        "Workspace-write commands require an OS sandbox backend.",
        &plan,
    )?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn require_network_command_launch_backend(
    program: String,
    args: Vec<String>,
    cwd: &Path,
    policy: SandboxPolicy,
) -> Result<(), JavisError> {
    if !policy.network_access {
        return Err(JavisError::Validation(
            "Network command launch requires network_access=true.".into(),
        ));
    }
    let request = SandboxCommandRequest {
        program,
        args,
        cwd: cwd.to_path_buf(),
        policy,
        env: Vec::new(),
        stdin: None,
        timeout_ms: None,
    };
    let plan = build_sandbox_launch_plan(&request, SandboxBackendRequirement::network_command())?;
    if !plan.network_access {
        return Err(JavisError::Validation(
            "Network command launch requires network_access=true.".into(),
        ));
    }
    require_launch_plan_ready(
        "Network-capable commands require an OS sandbox backend.",
        &plan,
    )?;
    Ok(())
}

fn run_policy_only_read_only_command(
    request: SandboxCommandRequest,
    policy: ValidatedPolicy,
    cwd: PathBuf,
) -> Result<SandboxCommandOutput, JavisError> {
    if policy.network_access {
        let assessment = assess_backend_capabilities(SandboxBackendRequirement::network_command());
        let filesystem_rules = compile_filesystem_rules(&policy);
        let network_policy = compile_network_policy(&policy);
        let manifest = compile_windows_enforcement_manifest(&filesystem_rules, &network_policy);
        let readiness = sandbox_launch_readiness(&assessment, &manifest);
        return Err(backend_capability_error(
            "Network access requires an OS sandbox backend.",
            &assessment,
            Some(&readiness),
        ));
    }
    let executable = resolve_trusted_read_only_executable(&request.program, &cwd)
        .map_err(JavisError::Permission)?;
    require_executable_outside_workspace(&executable, &policy.workspace_root)?;
    let safe_args = read_only_command_args(&request.program, &request.args);
    let environment = sandbox_environment_with_overrides(&request.env)?;
    let mut output = run_policy_only_process(&executable, &safe_args, &cwd, &environment)?;
    if is_retryable_windows_process_initialization_exit(output.status.code()) {
        output = run_policy_only_process(&executable, &safe_args, &cwd, &environment)?;
    }

    Ok(SandboxCommandOutput {
        command: command_summary(&request.program, &request.args),
        cwd: normalize_path(&cwd),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        sandbox: SandboxReport {
            backend: SandboxBackend::PolicyOnly,
            backend_status: active_platform_backend_status(),
            enforced: false,
            mode: SandboxMode::ReadOnly,
            network_access: false,
            writable_roots: policy
                .writable_roots
                .iter()
                .map(|root| normalize_path(root))
                .collect(),
            protected_path_count: policy.protected_paths.len(),
            denial_reason: None,
        },
    })
}

fn run_policy_only_process(
    executable: &Path,
    args: &[String],
    cwd: &Path,
    environment: &[(String, String)],
) -> Result<std::process::Output, JavisError> {
    let mut command = Command::new(executable);
    command.args(args).current_dir(cwd).env_clear().envs(
        environment
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str())),
    );
    Ok(command.output()?)
}

fn sandbox_audit_event_for_output(
    output: &SandboxCommandOutput,
    task_id: Option<String>,
) -> SandboxAuditEvent {
    SandboxAuditEvent {
        kind: "sandbox_process",
        task_id,
        command: output.command.clone(),
        cwd: output.cwd.clone(),
        sandbox_mode: output.sandbox.mode.clone(),
        backend: output.sandbox.backend.clone(),
        backend_status: output.sandbox.backend_status.clone(),
        enforced: output.sandbox.enforced,
        network_access: output.sandbox.network_access,
        writable_roots: output.sandbox.writable_roots.clone(),
        protected_path_count: output.sandbox.protected_path_count,
        approval_id: None,
        exit_code: output.exit_code,
        stdout_bytes: output.stdout.len(),
        stderr_bytes: output.stderr.len(),
        stdout_truncated: false,
        stderr_truncated: false,
        denial_reason: output.sandbox.denial_reason.clone(),
    }
}

fn sandbox_denied_command_output(
    command: String,
    cwd: &Path,
    policy: &ValidatedPolicy,
    assessment: &SandboxBackendAssessment,
    denial_reason: String,
) -> SandboxCommandOutput {
    SandboxCommandOutput {
        command,
        cwd: normalize_path(cwd),
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        sandbox: SandboxReport {
            backend: assessment.status.backend.clone(),
            backend_status: assessment.status.clone(),
            enforced: false,
            mode: policy.mode.clone(),
            network_access: policy.network_access,
            writable_roots: policy
                .writable_roots
                .iter()
                .map(|root| normalize_path(root))
                .collect(),
            protected_path_count: policy.protected_paths.len(),
            denial_reason: Some(denial_reason),
        },
    }
}

pub(crate) fn sandbox_audit_jsonl_line_for_output(
    output: &SandboxCommandOutput,
    task_id: Option<String>,
) -> Result<String, JavisError> {
    let line = serde_json::to_string(&sandbox_audit_event_for_output(output, task_id))?;
    if line.trim().is_empty() || line.lines().count() != 1 {
        return Err(JavisError::Internal(
            "Sandbox audit JSONL serialization produced an invalid line.".into(),
        ));
    }
    Ok(line)
}

#[allow(dead_code)]
pub(crate) fn sandbox_denied_interactive_audit_jsonl_line(
    command: String,
    cwd: &Path,
    policy: SandboxPolicy,
    task_id: Option<String>,
) -> Result<String, JavisError> {
    sandbox_denied_audit_jsonl_line_for_policy(
        command,
        cwd,
        policy,
        SandboxBackendRequirement::interactive_session(),
        "Interactive sessions require an OS sandbox backend.",
        task_id,
    )
}

#[allow(dead_code)]
pub(crate) fn sandbox_denied_workspace_write_audit_jsonl_line(
    command: String,
    cwd: &Path,
    policy: SandboxPolicy,
    task_id: Option<String>,
) -> Result<String, JavisError> {
    sandbox_denied_audit_jsonl_line_for_policy(
        command,
        cwd,
        policy,
        SandboxBackendRequirement::workspace_write_command(),
        "Workspace-write commands require an OS sandbox backend.",
        task_id,
    )
}

#[allow(dead_code)]
pub(crate) fn sandbox_denied_network_audit_jsonl_line(
    command: String,
    cwd: &Path,
    policy: SandboxPolicy,
    task_id: Option<String>,
) -> Result<String, JavisError> {
    sandbox_denied_audit_jsonl_line_for_policy(
        command,
        cwd,
        policy,
        SandboxBackendRequirement::network_command(),
        "Network-capable commands require an OS sandbox backend.",
        task_id,
    )
}

fn sandbox_denied_audit_jsonl_line_for_policy(
    command: String,
    cwd: &Path,
    policy: SandboxPolicy,
    requirement: SandboxBackendRequirement,
    reason: &str,
    task_id: Option<String>,
) -> Result<String, JavisError> {
    let policy = validate_policy(policy)?;
    let assessment = assess_backend_capabilities(requirement);
    let filesystem_rules = compile_filesystem_rules(&policy);
    let network_policy = compile_network_policy(&policy);
    let manifest = compile_windows_enforcement_manifest(&filesystem_rules, &network_policy);
    let readiness = sandbox_launch_readiness(&assessment, &manifest);
    if readiness.ready {
        return Err(JavisError::Internal(
            "Sandbox denied audit requested for a launch-ready policy.".into(),
        ));
    }
    let denial_reason = backend_capability_denial_reason(reason, &assessment, Some(&readiness));
    let output = sandbox_denied_command_output(command, cwd, &policy, &assessment, denial_reason);
    sandbox_audit_jsonl_line_for_output(&output, task_id)
}

fn build_sandbox_launch_plan(
    request: &SandboxCommandRequest,
    requirement: SandboxBackendRequirement,
) -> Result<SandboxLaunchPlan, JavisError> {
    let policy = validate_policy(request.policy.clone())?;
    let cwd = canonicalize_existing_dir(&request.cwd, "command cwd")?;
    if !cwd.starts_with(&policy.workspace_root) {
        return Err(JavisError::Permission(
            "Sandbox command cwd must stay inside the selected workspace.".into(),
        ));
    }
    let executable = resolve_trusted_read_only_executable(&request.program, &cwd)
        .map_err(JavisError::Permission)?;
    require_executable_outside_workspace(&executable, &policy.workspace_root)?;
    let args = request.args.clone();
    let windows_command_line = windows_command_line(&executable, &args);
    let windows_command_line_wide =
        windows_null_terminated_utf16("Windows command line", &windows_command_line)?;
    let windows_cwd = cwd.to_string_lossy();
    let windows_cwd_wide = windows_null_terminated_utf16("Windows cwd", &windows_cwd)?;
    let environment = sandbox_environment();
    let windows_environment_block = windows_environment_block(&environment)?;
    let filesystem_rules = compile_filesystem_rules(&policy);
    let network_policy = compile_network_policy(&policy);
    let windows_enforcement_manifest =
        compile_windows_enforcement_manifest(&filesystem_rules, &network_policy);
    let protected_path_count = policy.protected_paths.len();
    let backend = assess_backend_capabilities(requirement);
    let launch_readiness = sandbox_launch_readiness(&backend, &windows_enforcement_manifest);
    Ok(SandboxLaunchPlan {
        command: command_summary(&request.program, &request.args),
        executable,
        args,
        windows_command_line,
        windows_command_line_wide,
        windows_cwd_wide,
        environment,
        windows_environment_block,
        cwd,
        mode: policy.mode,
        network_access: policy.network_access,
        network_policy,
        readable_roots: policy.readable_roots,
        writable_roots: policy.writable_roots,
        protected_paths: policy.protected_paths,
        filesystem_rules,
        windows_enforcement_manifest,
        protected_path_count,
        backend,
        launch_readiness,
        stdin: request.stdin.clone(),
    })
}

fn require_launch_plan_ready(reason: &str, plan: &SandboxLaunchPlan) -> Result<(), JavisError> {
    if plan.launch_readiness.ready {
        return Ok(());
    }
    Err(backend_capability_error(
        reason,
        &plan.backend,
        Some(&plan.launch_readiness),
    ))
}

fn validate_policy(policy: SandboxPolicy) -> Result<ValidatedPolicy, JavisError> {
    if policy.approval_required && policy.approval.is_none() {
        return Err(JavisError::Permission(
            "Sandbox policy requires approval scope.".into(),
        ));
    }
    if let Some(approval) = &policy.approval {
        if approval.approval_id.trim().is_empty()
            || approval.tool_name.trim().is_empty()
            || approval.preview_hash.trim().is_empty()
        {
            return Err(JavisError::Permission(
                "Sandbox approval scope is incomplete.".into(),
            ));
        }
        let _ = approval.task_id.as_deref().unwrap_or_default();
    }

    let workspace_root = canonicalize_existing_dir(&policy.workspace_root, "workspace root")?;
    let readable_roots = canonicalize_roots_under_workspace(
        &policy.readable_roots,
        &workspace_root,
        "readable root",
    )?;
    let writable_roots = canonicalize_roots_under_workspace(
        &policy.writable_roots,
        &workspace_root,
        "writable root",
    )?;
    let protected_paths = canonicalize_protected_paths(&policy.protected_paths, &workspace_root)?;

    if readable_roots.is_empty() {
        return Err(JavisError::Validation(
            "Sandbox policy requires at least one readable root.".into(),
        ));
    }
    if matches!(policy.mode, SandboxMode::WorkspaceWrite) && writable_roots.is_empty() {
        return Err(JavisError::Validation(
            "Workspace-write sandbox mode requires at least one writable root.".into(),
        ));
    }
    for writable_root in &writable_roots {
        if !is_path_under_any_root(writable_root, &readable_roots) {
            return Err(JavisError::Validation(
                "Sandbox writable roots must also be covered by a readable root.".into(),
            ));
        }
    }

    Ok(ValidatedPolicy {
        mode: policy.mode,
        workspace_root,
        readable_roots,
        writable_roots,
        protected_paths,
        network_access: policy.network_access,
    })
}

fn canonicalize_roots_under_workspace(
    roots: &[PathBuf],
    workspace_root: &Path,
    label: &str,
) -> Result<Vec<PathBuf>, JavisError> {
    let mut canonical = Vec::new();
    for root in roots {
        let resolved = canonicalize_existing_dir(root, label)?;
        if !resolved.starts_with(workspace_root) {
            return Err(JavisError::Permission(format!(
                "Sandbox {label} must stay inside the selected workspace."
            )));
        }
        canonical.push(resolved);
    }
    Ok(canonical)
}

fn is_path_under_any_root(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

fn compile_filesystem_rules(policy: &ValidatedPolicy) -> Vec<SandboxFilesystemRule> {
    let mut rules = Vec::new();
    rules.extend(
        policy
            .protected_paths
            .iter()
            .cloned()
            .map(|path| SandboxFilesystemRule {
                access: SandboxFilesystemAccess::Deny,
                path,
            }),
    );
    rules.extend(
        policy
            .writable_roots
            .iter()
            .cloned()
            .map(|path| SandboxFilesystemRule {
                access: SandboxFilesystemAccess::ReadWrite,
                path,
            }),
    );
    rules.extend(
        policy
            .readable_roots
            .iter()
            .cloned()
            .map(|path| SandboxFilesystemRule {
                access: SandboxFilesystemAccess::ReadOnly,
                path,
            }),
    );
    rules
}

#[allow(dead_code)]
fn filesystem_access_for_path(
    path: &Path,
    rules: &[SandboxFilesystemRule],
) -> SandboxFilesystemAccess {
    rules
        .iter()
        .find(|rule| path.starts_with(&rule.path))
        .map(|rule| rule.access.clone())
        .unwrap_or(SandboxFilesystemAccess::Deny)
}

fn compile_network_policy(policy: &ValidatedPolicy) -> SandboxNetworkPolicy {
    if policy.network_access {
        SandboxNetworkPolicy::AllowAll
    } else {
        SandboxNetworkPolicy::DenyAll
    }
}

#[allow(dead_code)]
fn network_policy_allows_connect(policy: &SandboxNetworkPolicy) -> bool {
    matches!(policy, SandboxNetworkPolicy::AllowAll)
}

fn compile_windows_enforcement_manifest(
    filesystem_rules: &[SandboxFilesystemRule],
    network_policy: &SandboxNetworkPolicy,
) -> WindowsSandboxEnforcementManifest {
    WindowsSandboxEnforcementManifest {
        requires_job_object: true,
        requires_restricted_token: true,
        requires_filesystem_boundary: !filesystem_rules.is_empty(),
        requires_network_boundary: matches!(network_policy, SandboxNetworkPolicy::DenyAll),
        allow_permanent_acl_mutation: false,
        filesystem_rules: filesystem_rules
            .iter()
            .map(|rule| WindowsSandboxFilesystemRule {
                access: rule.access.clone(),
                path: rule.path.clone(),
            })
            .collect(),
        network_policy: network_policy.clone(),
    }
}

fn canonicalize_protected_paths(
    protected_paths: &[PathBuf],
    workspace_root: &Path,
) -> Result<Vec<PathBuf>, JavisError> {
    let mut protected = Vec::new();
    for path in protected_paths {
        let resolved = if path.exists() {
            fs::canonicalize(path).map_err(|error| {
                JavisError::Io(format!(
                    "Could not resolve protected path {}: {error}",
                    normalize_path(path)
                ))
            })?
        } else if path.is_absolute() {
            canonicalize_missing_path(path)?
        } else {
            workspace_root.join(path)
        };
        if !resolved.starts_with(workspace_root) {
            return Err(JavisError::Permission(
                "Sandbox protected paths must stay inside the selected workspace.".into(),
            ));
        }
        protected.push(resolved);
    }
    Ok(protected)
}

fn canonicalize_existing_dir(path: &Path, label: &str) -> Result<PathBuf, JavisError> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| JavisError::Io(format!("Could not resolve sandbox {label}: {error}")))?;
    if !canonical.is_dir() {
        return Err(JavisError::Validation(format!(
            "Sandbox {label} must be a directory."
        )));
    }
    Ok(canonical)
}

#[allow(dead_code)]
fn copy_workspace_into_temporary_sandbox(
    source_root: &Path,
    sandbox_root: &Path,
    stats: &mut TemporaryWorkspaceCopyStats,
) -> Result<(), JavisError> {
    for entry in fs::read_dir(source_root).map_err(|error| {
        JavisError::Io(format!(
            "Could not read workspace directory {}: {error}",
            normalize_path(source_root)
        ))
    })? {
        let entry = entry.map_err(|error| {
            JavisError::Io(format!(
                "Could not read workspace directory entry {}: {error}",
                normalize_path(source_root)
            ))
        })?;
        copy_workspace_entry_into_temporary_sandbox(
            &entry.path(),
            source_root,
            sandbox_root,
            stats,
        )?;
    }
    Ok(())
}

#[allow(dead_code)]
fn collect_temporary_workspace_relative_files(
    root: &Path,
) -> Result<BTreeSet<PathBuf>, JavisError> {
    let mut files = BTreeSet::new();
    collect_temporary_workspace_relative_files_inner(root, root, &mut files)?;
    Ok(files)
}

#[allow(dead_code)]
fn collect_temporary_workspace_relative_files_inner(
    root: &Path,
    current: &Path,
    files: &mut BTreeSet<PathBuf>,
) -> Result<(), JavisError> {
    for entry in fs::read_dir(current).map_err(|error| {
        JavisError::Io(format!(
            "Could not read temporary workspace diff directory {}: {error}",
            normalize_path(current)
        ))
    })? {
        let entry = entry.map_err(|error| {
            JavisError::Io(format!(
                "Could not read temporary workspace diff entry {}: {error}",
                normalize_path(current)
            ))
        })?;
        let path = entry.path();
        let relative = path.strip_prefix(root).map_err(|_| {
            JavisError::Internal("Temporary workspace diff path escaped root.".into())
        })?;
        if should_skip_temporary_workspace_copy_entry(relative, &path) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            JavisError::Io(format!(
                "Could not inspect temporary workspace diff path {}: {error}",
                normalize_path(&path)
            ))
        })?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_temporary_workspace_relative_files_inner(root, &path, files)?;
        } else if metadata.is_file() {
            files.insert(relative.to_path_buf());
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn temporary_workspace_file_diff(path: &Path, before: Option<&str>, after: Option<&str>) -> String {
    let display = path.to_string_lossy().replace('\\', "/");
    let before_label = before
        .map(|_| format!("a/{display}"))
        .unwrap_or_else(|| "/dev/null".to_string());
    let after_label = after
        .map(|_| format!("b/{display}"))
        .unwrap_or_else(|| "/dev/null".to_string());
    let mut lines = vec![
        format!("diff --git a/{display} b/{display}"),
        format!("--- {before_label}"),
        format!("+++ {after_label}"),
        "@@ -1 +1 @@".to_string(),
    ];
    if let Some(before) = before {
        lines.extend(before.lines().map(|line| format!("-{line}")));
    }
    if let Some(after) = after {
        lines.extend(after.lines().map(|line| format!("+{line}")));
    }
    lines.join("\n")
}

#[allow(dead_code)]
fn temporary_workspace_apply_preview_hash(changed_files: &[PathBuf], unified_diff: &str) -> String {
    let changed = changed_files
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>()
        .join("\n");
    create_fnv1a_hash(format!("temporary-workspace-apply\n{changed}\n{unified_diff}").as_bytes())
}

#[allow(dead_code)]
fn copy_workspace_entry_into_temporary_sandbox(
    source: &Path,
    source_root: &Path,
    sandbox_root: &Path,
    stats: &mut TemporaryWorkspaceCopyStats,
) -> Result<(), JavisError> {
    let relative = source.strip_prefix(source_root).map_err(|_| {
        JavisError::Internal("Temporary workspace copy source escaped workspace root.".into())
    })?;
    if should_skip_temporary_workspace_copy_entry(relative, source) {
        stats.skipped_entries += 1;
        return Ok(());
    }
    let target = sandbox_root.join(relative);
    let metadata = fs::symlink_metadata(source).map_err(|error| {
        JavisError::Io(format!(
            "Could not inspect temporary workspace copy source {}: {error}",
            normalize_path(source)
        ))
    })?;
    if metadata.file_type().is_symlink() {
        stats.skipped_entries += 1;
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir_all(&target).map_err(|error| {
            JavisError::Io(format!(
                "Could not create temporary workspace directory {}: {error}",
                normalize_path(&target)
            ))
        })?;
        stats.copied_directories += 1;
        for entry in fs::read_dir(source).map_err(|error| {
            JavisError::Io(format!(
                "Could not read workspace directory {}: {error}",
                normalize_path(source)
            ))
        })? {
            let entry = entry.map_err(|error| {
                JavisError::Io(format!(
                    "Could not read workspace directory entry {}: {error}",
                    normalize_path(source)
                ))
            })?;
            copy_workspace_entry_into_temporary_sandbox(
                &entry.path(),
                source_root,
                sandbox_root,
                stats,
            )?;
        }
        return Ok(());
    }
    if metadata.is_file() {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                JavisError::Io(format!(
                    "Could not create temporary workspace parent {}: {error}",
                    normalize_path(parent)
                ))
            })?;
        }
        fs::copy(source, &target).map_err(|error| {
            JavisError::Io(format!(
                "Could not copy workspace file {} to {}: {error}",
                normalize_path(source),
                normalize_path(&target)
            ))
        })?;
        stats.copied_files += 1;
        return Ok(());
    }
    stats.skipped_entries += 1;
    Ok(())
}

#[allow(dead_code)]
fn should_skip_temporary_workspace_copy_entry(relative: &Path, source: &Path) -> bool {
    relative
        .components()
        .any(|component| component.as_os_str() == ".codex-tmp")
        || source.file_name().is_some_and(|name| name == ".codex-tmp")
}

fn canonicalize_missing_path(path: &Path) -> Result<PathBuf, JavisError> {
    let mut missing_components = Vec::new();
    let mut current = path;
    while !current.exists() {
        let Some(name) = current.file_name() else {
            return Ok(path.to_path_buf());
        };
        missing_components.push(name.to_os_string());
        let Some(parent) = current.parent() else {
            return Ok(path.to_path_buf());
        };
        current = parent;
    }
    let mut resolved = fs::canonicalize(current).map_err(|error| {
        JavisError::Io(format!(
            "Could not resolve protected path ancestor {}: {error}",
            normalize_path(current)
        ))
    })?;
    for component in missing_components.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn require_executable_outside_workspace(
    executable: &Path,
    workspace_root: &Path,
) -> Result<(), JavisError> {
    let canonical = fs::canonicalize(executable).map_err(|error| {
        JavisError::Io(format!(
            "Could not resolve sandbox executable {}: {error}",
            normalize_path(executable)
        ))
    })?;
    if canonical.starts_with(workspace_root) {
        return Err(JavisError::Permission(
            "Sandbox executable must not resolve inside the selected workspace.".into(),
        ));
    }
    Ok(())
}

fn require_backend_capabilities(
    reason: &str,
    requirement: SandboxBackendRequirement,
) -> Result<(), JavisError> {
    let assessment = assess_backend_capabilities(requirement);
    if assessment.missing_capabilities.is_empty() {
        return Ok(());
    }
    Err(backend_capability_error(reason, &assessment, None))
}

#[allow(dead_code)]
fn require_backend_readiness_for_policy(
    reason: &str,
    policy: &ValidatedPolicy,
    requirement: SandboxBackendRequirement,
) -> Result<(), JavisError> {
    let assessment = assess_backend_capabilities(requirement);
    let filesystem_rules = compile_filesystem_rules(policy);
    let network_policy = compile_network_policy(policy);
    let manifest = compile_windows_enforcement_manifest(&filesystem_rules, &network_policy);
    let readiness = sandbox_launch_readiness(&assessment, &manifest);
    if readiness.ready {
        return Ok(());
    }
    Err(backend_capability_error(
        reason,
        &assessment,
        Some(&readiness),
    ))
}

fn assess_backend_capabilities(requirement: SandboxBackendRequirement) -> SandboxBackendAssessment {
    let status = active_platform_backend_status();
    let missing_capabilities = missing_backend_capabilities(&requirement, &status);
    SandboxBackendAssessment {
        requirement_label: requirement.label,
        missing_capabilities,
        status,
    }
}

fn backend_capability_error(
    reason: &str,
    assessment: &SandboxBackendAssessment,
    readiness: Option<&SandboxLaunchReadiness>,
) -> JavisError {
    JavisError::Permission(backend_capability_denial_reason(
        reason, assessment, readiness,
    ))
}

fn backend_capability_denial_reason(
    reason: &str,
    assessment: &SandboxBackendAssessment,
    readiness: Option<&SandboxLaunchReadiness>,
) -> String {
    let missing_capabilities = if assessment.missing_capabilities.is_empty() {
        "none".to_string()
    } else {
        assessment.missing_capabilities.join(", ")
    };
    let readiness_reasons = readiness.map(|readiness| {
        if readiness.blocked_reasons.is_empty() {
            "none".to_string()
        } else {
            readiness.blocked_reasons.join(", ")
        }
    });
    format!(
        "{reason} Required sandbox capability: {}. Missing capabilities: {}. Launch readiness blocked by: {}. Sandbox backend status: {}. enforced=false.",
        assessment.requirement_label,
        missing_capabilities,
        readiness_reasons.unwrap_or_else(|| "not evaluated".to_string()),
        serde_json::to_string(&assessment.status).unwrap_or_else(|_| {
            "{\"backend\":\"unavailable\",\"available\":false}".to_string()
        })
    )
}

fn missing_backend_capabilities(
    requirement: &SandboxBackendRequirement,
    status: &SandboxBackendStatus,
) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if !status.available {
        missing.push("backend_available");
    }
    if requirement.requires_spawn && !status.can_spawn {
        missing.push("spawn");
    }
    if requirement.requires_filesystem_restriction && !status.can_restrict_filesystem {
        missing.push("filesystem_restriction");
    }
    if requirement.requires_network_denial && !status.can_deny_network {
        missing.push("network_denial");
    }
    missing
}

fn sandbox_launch_readiness(
    backend: &SandboxBackendAssessment,
    manifest: &WindowsSandboxEnforcementManifest,
) -> SandboxLaunchReadiness {
    let mut blocked_reasons = backend.missing_capabilities.clone();
    for gap in windows_manifest_backend_gaps(manifest, &backend.status) {
        push_unique(&mut blocked_reasons, gap);
    }
    SandboxLaunchReadiness {
        ready: blocked_reasons.is_empty(),
        blocked_reasons,
    }
}

fn windows_manifest_backend_gaps(
    manifest: &WindowsSandboxEnforcementManifest,
    status: &SandboxBackendStatus,
) -> Vec<&'static str> {
    let mut gaps = Vec::new();
    if manifest.requires_job_object && !status.can_control_process_tree {
        gaps.push("process_tree_control");
    }
    if manifest.requires_restricted_token && !status.can_create_restricted_token {
        gaps.push("restricted_token");
    }
    if !status.can_evaluate_filesystem_policy {
        gaps.push("filesystem_policy_evaluation");
    }
    if manifest.requires_filesystem_boundary && !status.can_restrict_filesystem {
        gaps.push("filesystem_restriction");
    }
    if !status.can_evaluate_network_policy {
        gaps.push("network_policy_evaluation");
    }
    if manifest.requires_network_boundary && !status.can_deny_network {
        gaps.push("network_denial");
    }
    gaps
}

fn push_unique(items: &mut Vec<&'static str>, item: &'static str) {
    if !items.contains(&item) {
        items.push(item);
    }
}

fn unavailable_filesystem_boundary_status() -> SandboxBoundaryStatus {
    #[cfg(target_os = "windows")]
    if cfg!(feature = "windows-sandbox-backend") {
        return SandboxBoundaryStatus {
            strategy: SandboxBoundaryStrategy::WindowsIntegrityLevel,
            available: true,
            mutates_host_state: false,
            reason: "Filesystem write-protection via token integrity level (Low for read-only, Medium for workspace-write).".to_string(),
        };
    }
    #[cfg(target_os = "linux")]
    {
        return SandboxBoundaryStatus {
            strategy: SandboxBoundaryStrategy::LinuxBubblewrap,
            available: true,
            mutates_host_state: false,
            reason: "Filesystem isolation via bubblewrap read-only bind mounts, writable-root bind mounts, and tmpfs for protected paths.".to_string(),
        };
    }
    #[cfg(target_os = "macos")]
    {
        return SandboxBoundaryStatus {
            strategy: SandboxBoundaryStrategy::MacSeatbelt,
            available: true,
            mutates_host_state: false,
            reason: "Filesystem isolation via macOS Seatbelt profile (allow-read for readable roots, allow-write for writable roots, deny protected paths).".to_string(),
        };
    }
    SandboxBoundaryStatus {
        strategy: SandboxBoundaryStrategy::NotImplemented,
        available: false,
        mutates_host_state: false,
        reason: "Filesystem boundary enforcement is not implemented without permanent host ACL mutation.".to_string(),
    }
}

fn unavailable_network_boundary_status() -> SandboxBoundaryStatus {
    #[cfg(target_os = "windows")]
    if cfg!(feature = "windows-sandbox-backend") {
        return SandboxBoundaryStatus {
            strategy: SandboxBoundaryStrategy::WindowsDisabledNetworkSid,
            available: true,
            mutates_host_state: false,
            reason: "Network denial via disabled Network SID (S-1-5-2) in restricted token, which prevents Winsock initialization.".to_string(),
        };
    }
    #[cfg(target_os = "linux")]
    {
        return SandboxBoundaryStatus {
            strategy: SandboxBoundaryStrategy::LinuxBubblewrap,
            available: true,
            mutates_host_state: false,
            reason: "Network isolation via bubblewrap --unshare-net (new network namespace with only loopback).".to_string(),
        };
    }
    #[cfg(target_os = "macos")]
    {
        return SandboxBoundaryStatus {
            strategy: SandboxBoundaryStrategy::MacSeatbelt,
            available: true,
            mutates_host_state: false,
            reason: "Network denial via macOS Seatbelt profile (deny network*).".to_string(),
        };
    }
    SandboxBoundaryStatus {
        strategy: SandboxBoundaryStrategy::NotImplemented,
        available: false,
        mutates_host_state: false,
        reason: "Network-deny enforcement is not implemented.".to_string(),
    }
}

pub(crate) fn active_platform_backend_status() -> SandboxBackendStatus {
    platform_backend_status()
}

#[tauri::command]
pub(crate) fn sandbox_backend_status() -> SandboxBackendStatus {
    active_platform_backend_status()
}

#[cfg(target_os = "windows")]
fn platform_backend_status() -> SandboxBackendStatus {
    if !cfg!(feature = "windows-sandbox-backend") {
        let filesystem_boundary = unavailable_filesystem_boundary_status();
        let network_boundary = unavailable_network_boundary_status();
        return SandboxBackendStatus {
            backend: SandboxBackend::WindowsRestrictedToken,
            available: false,
            can_spawn: false,
            can_control_process_tree: false,
            can_create_restricted_token: false,
            can_launch_restricted_process: false,
            can_evaluate_filesystem_policy: true,
            can_evaluate_network_policy: true,
            can_restrict_filesystem: filesystem_boundary.available,
            can_deny_network: network_boundary.available,
            filesystem_boundary,
            network_boundary,
            reason: "Windows sandbox backend feature is disabled. Enable the windows-sandbox-backend Cargo feature to probe restricted-token process primitives.".to_string(),
        };
    }
    let resources = create_windows_sandbox_process_resources();
    let can_control_process_tree = resources.can_control_process_tree;
    let can_create_restricted_token = resources.can_create_restricted_token;
    let can_spawn = resources.ready_for_process_spawn();
    let filesystem_boundary = unavailable_filesystem_boundary_status();
    let network_boundary = unavailable_network_boundary_status();
    SandboxBackendStatus {
        backend: SandboxBackend::WindowsRestrictedToken,
        available: can_spawn,
        can_spawn,
        can_control_process_tree,
        can_create_restricted_token,
        can_launch_restricted_process: resources.can_launch_restricted_process,
        can_evaluate_filesystem_policy: true,
        can_evaluate_network_policy: true,
        can_restrict_filesystem: filesystem_boundary.available,
        can_deny_network: network_boundary.available,
        filesystem_boundary,
        network_boundary,
        reason: windows_backend_reason(
            can_control_process_tree,
            can_create_restricted_token,
            resources.can_launch_restricted_process,
        ),
    }
}

#[cfg(target_os = "windows")]
fn windows_backend_reason(
    can_control_process_tree: bool,
    can_create_restricted_token: bool,
    can_launch_restricted_process: bool,
) -> String {
    let mut missing = Vec::new();
    if !can_control_process_tree {
        missing.push("Job Object process-tree control probe failed");
    }
    if !can_create_restricted_token {
        missing.push("restricted-token probe failed");
    }
    if !can_launch_restricted_process {
        missing.push("restricted-token process execution probe failed");
    }
    format!(
        "Windows sandbox backend primitives: can_control_process_tree={can_control_process_tree}, can_create_restricted_token={can_create_restricted_token}, can_launch_restricted_process={can_launch_restricted_process}. The launch probe creates a restricted-token process, assigns it to a kill-on-close Job Object, resumes it, waits for exit, and verifies exit code 0. Missing: {}.",
        missing.join("; ")
    )
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug)]
struct WindowsTokenConfig {
    disable_max_privilege: bool,
    disable_network_sid: bool,
    low_integrity: bool,
}

#[cfg(target_os = "windows")]
struct WindowsSandboxProcessResources {
    job: Option<WindowsHandle>,
    restricted_token: Option<WindowsHandle>,
    can_control_process_tree: bool,
    can_create_restricted_token: bool,
    can_launch_restricted_process: bool,
}

#[cfg(target_os = "windows")]
impl WindowsSandboxProcessResources {
    fn ready_for_process_spawn(&self) -> bool {
        self.job.is_some()
            && self.restricted_token.is_some()
            && self.can_control_process_tree
            && self.can_create_restricted_token
            && self.can_launch_restricted_process
    }
}

#[cfg(target_os = "windows")]
fn create_windows_sandbox_process_resources() -> WindowsSandboxProcessResources {
    let job = create_windows_kill_on_close_job();
    let restricted_token = create_windows_restricted_primary_token();
    let can_launch_restricted_process =
        windows_restricted_process_launch_probe(job.as_ref(), restricted_token.as_ref());
    WindowsSandboxProcessResources {
        can_control_process_tree: job.is_some(),
        can_create_restricted_token: restricted_token.is_some(),
        can_launch_restricted_process,
        job,
        restricted_token,
    }
}

#[cfg(target_os = "windows")]
fn create_windows_kill_on_close_job() -> Option<WindowsHandle> {
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectBasicLimitInformation, SetInformationJobObject,
        JOBOBJECT_BASIC_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if handle.is_null() {
            return None;
        }
        let info = JOBOBJECT_BASIC_LIMIT_INFORMATION {
            LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            ..Default::default()
        };
        let configured = SetInformationJobObject(
            handle,
            JobObjectBasicLimitInformation,
            (&info as *const JOBOBJECT_BASIC_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_BASIC_LIMIT_INFORMATION>() as u32,
        ) != 0;
        if configured {
            Some(WindowsHandle(handle))
        } else {
            let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
            None
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn create_windows_terminal_job() -> Option<WindowsHandle> {
    create_windows_kill_on_close_job()
}

#[cfg(target_os = "windows")]
pub(crate) fn assign_process_to_terminal_job(job: &WindowsHandle, process_id: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id);
        if handle.is_null() {
            return false;
        }
        let result = AssignProcessToJobObject(job.0, handle) != 0;
        let _ = CloseHandle(handle);
        result
    }
}

#[cfg(target_os = "windows")]
fn create_windows_restricted_primary_token() -> Option<WindowsHandle> {
    create_windows_sandbox_token(&WindowsTokenConfig {
        disable_max_privilege: true,
        disable_network_sid: false,
        low_integrity: false,
    })
}

#[cfg(target_os = "windows")]
fn create_windows_sandbox_token(config: &WindowsTokenConfig) -> Option<WindowsHandle> {
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = std::ptr::null_mut();
        let token_access = TOKEN_DUPLICATE
            | TOKEN_ASSIGN_PRIMARY
            | TOKEN_QUERY
            | TOKEN_ADJUST_DEFAULT
            | TOKEN_ADJUST_SESSIONID;
        if OpenProcessToken(GetCurrentProcess(), token_access, &mut token) == 0 {
            return None;
        }
        let source_token = WindowsHandle(token);

        let restricted = if config.disable_network_sid {
            create_restricted_token_with_disabled_network_sid(source_token.0)?
        } else {
            let mut restricted = std::ptr::null_mut();
            let created = CreateRestrictedToken(
                source_token.0,
                if config.disable_max_privilege {
                    DISABLE_MAX_PRIVILEGE
                } else {
                    0
                },
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                &mut restricted,
            ) != 0;
            if created && !restricted.is_null() {
                WindowsHandle(restricted)
            } else {
                return None;
            }
        };

        if config.low_integrity {
            set_token_integrity_level(&restricted, true).ok()?;
        }

        Some(restricted)
    }
}

#[cfg(target_os = "windows")]
fn create_restricted_token_with_disabled_network_sid(
    source_token: windows_sys::Win32::Foundation::HANDLE,
) -> Option<WindowsHandle> {
    use windows_sys::Win32::Security::{
        CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, SID_AND_ATTRIBUTES,
    };

    // Build S-1-5-2 (NETWORK SID) manually.
    let network_sid = make_sid(&[0, 0, 0, 0, 0, 5], &[0x00000002]);

    unsafe {
        let sid_attr = SID_AND_ATTRIBUTES {
            Sid: network_sid.as_ptr() as *mut _,
            Attributes: 0,
        };

        let mut restricted = std::ptr::null_mut();
        let created = CreateRestrictedToken(
            source_token,
            DISABLE_MAX_PRIVILEGE,
            1,
            &sid_attr,
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
            &mut restricted,
        ) != 0;

        if created && !restricted.is_null() {
            Some(WindowsHandle(restricted))
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn set_token_integrity_level(token: &WindowsHandle, low_integrity: bool) -> Result<(), JavisError> {
    use windows_sys::Win32::Security::{SID_AND_ATTRIBUTES, TOKEN_MANDATORY_LABEL};

    if !low_integrity {
        return Ok(());
    }

    // Build S-1-16-0x1000 (LOW_INTEGRITY) manually.
    const SECURITY_MANDATORY_LOW_RID: u32 = 0x00001000;
    let label_sid = make_sid(&[0, 0, 0, 0, 0, 16], &[SECURITY_MANDATORY_LOW_RID]);

    const SE_GROUP_INTEGRITY: u32 = 0x00000020;
    const SE_GROUP_INTEGRITY_ENABLED: u32 = 0x00000040;

    unsafe {
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES {
                Sid: label_sid.as_ptr() as *mut _,
                Attributes: SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED,
            },
        };

        // TokenIntegrityLevel = 25 in TOKEN_INFORMATION_CLASS
        const TOKEN_INTEGRITY_LEVEL: i32 = 25;

        use windows_sys::Win32::Security::SetTokenInformation;
        let set = SetTokenInformation(
            token.0,
            TOKEN_INTEGRITY_LEVEL,
            (&label as *const TOKEN_MANDATORY_LABEL).cast(),
            std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32,
        ) != 0;

        if set {
            Ok(())
        } else {
            Err(JavisError::Internal(
                "Could not set sandbox token integrity level.".into(),
            ))
        }
    }
}

/// Build a Windows SID in memory from an authority byte array and sub-authorities.
/// Returns a byte vector holding: Revision (1) + SubAuthorityCount + Authority[6] + SubAuthorities[N * 4].
#[cfg(target_os = "windows")]
fn make_sid(authority: &[u8; 6], sub_authorities: &[u32]) -> Vec<u8> {
    let count = sub_authorities.len().min(15) as u8;
    let mut buf = Vec::with_capacity(8 + count as usize * 4);
    buf.push(1u8); // revision
    buf.push(count); // sub-authority count
    buf.extend_from_slice(authority);
    for sa in sub_authorities.iter().take(15) {
        buf.extend_from_slice(&sa.to_le_bytes());
    }
    buf
}

#[cfg(target_os = "windows")]
fn windows_restricted_process_launch_probe(
    job: Option<&WindowsHandle>,
    restricted_token: Option<&WindowsHandle>,
) -> bool {
    let (Some(job), Some(restricted_token)) = (job, restricted_token) else {
        return false;
    };
    let system_root = env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let executable = Path::new(&system_root).join("System32").join("cmd.exe");
    if !executable.exists() {
        return false;
    }
    let application = match windows_null_terminated_utf16(
        "Windows probe executable",
        &executable.to_string_lossy(),
    ) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let mut command_line = match windows_null_terminated_utf16(
        "Windows probe command line",
        &windows_command_line(
            &executable,
            &[
                "/d".to_string(),
                "/c".to_string(),
                "exit".to_string(),
                "0".to_string(),
            ],
        ),
    ) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let cwd = match windows_null_terminated_utf16("Windows probe cwd", &system_root) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let environment = sandbox_environment();
    let environment_block = match windows_environment_block(&environment) {
        Ok(value) => value,
        Err(_) => return false,
    };

    create_windows_suspended_process_in_job(
        restricted_token,
        job,
        &application,
        &mut command_line,
        &cwd,
        &environment_block,
    )
    .and_then(|process| process.resume_and_wait_for_exit(5_000))
        == Some(0)
}

#[cfg(target_os = "windows")]
pub(crate) struct WindowsHandle(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: Windows HANDLEs are process-scoped integer identifiers, not memory
// pointers. Moving a HANDLE between threads does not create aliasing violations.
#[cfg(target_os = "windows")]
unsafe impl Send for WindowsHandle {}
#[cfg(target_os = "windows")]
unsafe impl Sync for WindowsHandle {}

#[cfg(target_os = "windows")]
struct WindowsSuspendedProcess {
    process: WindowsHandle,
    thread: WindowsHandle,
}

#[cfg(target_os = "windows")]
fn create_windows_suspended_process_in_job(
    restricted_token: &WindowsHandle,
    job: &WindowsHandle,
    application: &[u16],
    command_line: &mut [u16],
    cwd: &[u16],
    environment_block: &[u16],
) -> Option<WindowsSuspendedProcess> {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
        STARTUPINFOW,
    };

    unsafe {
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut process_info = PROCESS_INFORMATION::default();
        let created = CreateProcessAsUserW(
            restricted_token.0,
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            environment_block.as_ptr().cast(),
            cwd.as_ptr(),
            &startup,
            &mut process_info,
        ) != 0;
        if !created {
            return None;
        }
        let process = WindowsSuspendedProcess {
            process: WindowsHandle(process_info.hProcess),
            thread: WindowsHandle(process_info.hThread),
        };
        if AssignProcessToJobObject(job.0, process.process.0) == 0 {
            return None;
        }
        Some(process)
    }
}

#[cfg(target_os = "windows")]
impl WindowsSuspendedProcess {
    fn resume_and_wait_for_exit(&self, timeout_ms: u32) -> Option<u32> {
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, ResumeThread, WaitForSingleObject,
        };

        unsafe {
            if ResumeThread(self.thread.0) == u32::MAX {
                return None;
            }
            if WaitForSingleObject(self.process.0, timeout_ms) != WAIT_OBJECT_0 {
                return None;
            }
            let mut exit_code = 0;
            if GetExitCodeProcess(self.process.0, &mut exit_code) == 0 {
                return None;
            }
            Some(exit_code)
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsSuspendedProcess {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::System::Threading::TerminateProcess(self.process.0, 0);
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsHandle {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                let _ = windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn launch_windows_sandboxed_process(
    plan: &SandboxLaunchPlan,
    timeout_ms: u32,
) -> Result<SandboxCommandOutput, JavisError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, GetExitCodeProcess, ResumeThread, WaitForSingleObject,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
    };

    const STARTF_USESTDHANDLES: u32 = 0x00000100;
    const WAIT_TIMEOUT: u32 = 0x00000102;

    // 1. Create stdout and stderr pipes (and stdin if needed)
    let (stdout_read, stdout_write) = create_sandbox_pipe()?;
    let (stderr_read, stderr_write) = create_sandbox_pipe()?;
    let (stdin_read, stdin_write) = if plan.stdin.is_some() {
        use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
        let (r, w) = create_sandbox_pipe()?;
        // create_sandbox_pipe sets read=non-inheritable, write=inheritable
        // For stdin: read end goes to child (must be inheritable), write end to parent (non-inheritable)
        unsafe {
            SetHandleInformation(r, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
            SetHandleInformation(w, HANDLE_FLAG_INHERIT, 0);
        }
        (r, Some(w))
    } else {
        (std::ptr::null_mut(), None)
    };

    // 2. Create sandbox token
    let token_config = WindowsTokenConfig {
        disable_max_privilege: true,
        disable_network_sid: matches!(plan.network_policy, SandboxNetworkPolicy::DenyAll),
        low_integrity: matches!(plan.mode, SandboxMode::ReadOnly),
    };
    let restricted_token = create_windows_sandbox_token(&token_config).ok_or_else(|| {
        let _ = unsafe { CloseHandle(stdout_read) };
        let _ = unsafe { CloseHandle(stdout_write) };
        let _ = unsafe { CloseHandle(stderr_read) };
        let _ = unsafe { CloseHandle(stderr_write) };
        if let Some(w) = stdin_write {
            let _ = unsafe { CloseHandle(stdin_read) };
            let _ = unsafe { CloseHandle(w) };
        }
        JavisError::Internal("Could not create Windows sandbox restricted token.".into())
    })?;

    // 3. Create Job Object
    let job = create_windows_kill_on_close_job().ok_or_else(|| {
        let _ = unsafe { CloseHandle(stdout_read) };
        let _ = unsafe { CloseHandle(stdout_write) };
        let _ = unsafe { CloseHandle(stderr_read) };
        let _ = unsafe { CloseHandle(stderr_write) };
        if let Some(w) = stdin_write {
            let _ = unsafe { CloseHandle(stdin_read) };
            let _ = unsafe { CloseHandle(w) };
        }
        JavisError::Internal("Could not create Windows sandbox Job Object.".into())
    })?;

    // 4. Clone command line (needs to be mutable for CreateProcessAsUserW)
    let mut cmd_line_wide = plan.windows_command_line_wide.clone();

    // 5. Build STARTUPINFOW with pipe handles
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        hStdInput: stdin_read,
        hStdOutput: stdout_write,
        hStdError: stderr_write,
        dwFlags: STARTF_USESTDHANDLES,
        ..Default::default()
    };

    // 6. Create process suspended
    // bInheritHandles = TRUE so the child inherits the pipe write ends
    // for stdout/stderr. Only the two pipe write handles are marked
    // inheritable via SetHandleInformation; all other handles remain
    // non-inheritable by default.
    let mut process_info = PROCESS_INFORMATION::default();
    let created = unsafe {
        CreateProcessAsUserW(
            restricted_token.0,
            std::ptr::null(),
            cmd_line_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            plan.windows_environment_block.as_ptr().cast(),
            plan.windows_cwd_wide.as_ptr(),
            &startup,
            &mut process_info,
        ) != 0
    };

    // 7. Cleanup: close pipe write ends in parent (critical for ReadFile to complete)
    unsafe {
        let _ = CloseHandle(stdout_write);
        let _ = CloseHandle(stderr_write);
    }

    // Write stdin if provided (must happen before resume so child can read it)
    if let (Some(stdin_data), Some(stdin_w)) = (&plan.stdin, stdin_write) {
        if !stdin_data.is_empty() {
            use windows_sys::Win32::Storage::FileSystem::WriteFile;
            let mut written: u32 = 0;
            unsafe {
                let _ = WriteFile(
                    stdin_w,
                    stdin_data.as_ptr().cast(),
                    stdin_data.len() as u32,
                    &mut written,
                    std::ptr::null_mut(),
                );
            }
        }
        unsafe {
            let _ = CloseHandle(stdin_w);
        }
    }
    if !stdin_read.is_null() {
        unsafe {
            let _ = CloseHandle(stdin_read);
        }
    }

    if !created {
        unsafe {
            let _ = CloseHandle(stdout_read);
            let _ = CloseHandle(stderr_read);
        }
        return Err(JavisError::Internal(format!(
            "Could not create sandbox process: {} {}",
            plan.command,
            plan.cwd.to_string_lossy()
        )));
    }

    // 8. Assign to Job Object
    let assigned = unsafe { AssignProcessToJobObject(job.0, process_info.hProcess) != 0 };
    if !assigned {
        unsafe {
            let _ =
                windows_sys::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
            let _ = CloseHandle(process_info.hThread);
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(stdout_read);
            let _ = CloseHandle(stderr_read);
        }
        return Err(JavisError::Internal(
            "Could not assign sandbox process to Job Object.".into(),
        ));
    }

    // 9. Resume thread
    let resumed = unsafe { ResumeThread(process_info.hThread) != u32::MAX };
    unsafe {
        let _ = CloseHandle(process_info.hThread);
    }

    if !resumed {
        unsafe {
            let _ =
                windows_sys::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(stdout_read);
            let _ = CloseHandle(stderr_read);
        }
        return Err(JavisError::Internal(
            "Could not resume sandbox process thread.".into(),
        ));
    }

    // 10. Wait for exit with timeout
    let wait_result = unsafe { WaitForSingleObject(process_info.hProcess, timeout_ms) };

    let timed_out = wait_result == WAIT_TIMEOUT;
    if timed_out {
        unsafe {
            let _ =
                windows_sys::Win32::System::Threading::TerminateProcess(process_info.hProcess, 1);
        }
    }

    // 11. Read stdout and stderr
    let stdout_buf = read_pipe_to_end(stdout_read);
    let stderr_buf = read_pipe_to_end(stderr_read);
    unsafe {
        let _ = CloseHandle(stdout_read);
        let _ = CloseHandle(stderr_read);
    }

    // 12. Get exit code
    let mut exit_code: u32 = 1;
    unsafe {
        let _ = GetExitCodeProcess(process_info.hProcess, &mut exit_code);
        let _ = CloseHandle(process_info.hProcess);
    }

    let stdout_str = String::from_utf8_lossy(&stdout_buf).to_string();
    let stderr_str = String::from_utf8_lossy(&stderr_buf).to_string();

    Ok(SandboxCommandOutput {
        command: plan.command.clone(),
        cwd: plan.cwd.to_string_lossy().replace('\\', "/"),
        exit_code: Some(exit_code as i32),
        stdout: stdout_str,
        stderr: stderr_str,
        sandbox: SandboxReport {
            backend: SandboxBackend::WindowsRestrictedToken,
            backend_status: active_platform_backend_status(),
            enforced: true,
            mode: plan.mode.clone(),
            network_access: plan.network_access,
            writable_roots: plan
                .writable_roots
                .iter()
                .map(|root| root.to_string_lossy().replace('\\', "/"))
                .collect(),
            protected_path_count: plan.protected_path_count,
            denial_reason: if timed_out {
                Some(format!(
                    "Sandbox process timed out after {} ms.",
                    timeout_ms
                ))
            } else {
                None
            },
        },
    })
}

#[cfg(target_os = "windows")]
fn create_sandbox_pipe() -> Result<
    (
        windows_sys::Win32::Foundation::HANDLE,
        windows_sys::Win32::Foundation::HANDLE,
    ),
    JavisError,
> {
    use windows_sys::Win32::Foundation::{CloseHandle, SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Pipes::CreatePipe;

    unsafe {
        let mut read_handle: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
        let mut write_handle: windows_sys::Win32::Foundation::HANDLE = std::ptr::null_mut();
        let created = CreatePipe(&mut read_handle, &mut write_handle, std::ptr::null(), 0) != 0;
        if !created || read_handle.is_null() || write_handle.is_null() {
            if !read_handle.is_null() {
                let _ = CloseHandle(read_handle);
            }
            if !write_handle.is_null() {
                let _ = CloseHandle(write_handle);
            }
            return Err(JavisError::Internal(
                "Could not create sandbox pipe.".into(),
            ));
        }
        // Read end must NOT be inherited by child processes
        SetHandleInformation(read_handle, HANDLE_FLAG_INHERIT, 0);
        // Write end MUST be inherited so the child can write stdout/stderr
        SetHandleInformation(write_handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        Ok((read_handle, write_handle))
    }
}

#[cfg(target_os = "windows")]
fn read_pipe_to_end(handle: windows_sys::Win32::Foundation::HANDLE) -> Vec<u8> {
    use windows_sys::Win32::Storage::FileSystem::ReadFile;

    let mut buf = Vec::new();
    let mut chunk = vec![0u8; 4096];
    loop {
        let mut bytes_read: u32 = 0;
        let ok = unsafe {
            ReadFile(
                handle,
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                &mut bytes_read,
                std::ptr::null_mut(),
            ) != 0
        };
        if !ok || bytes_read == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..bytes_read as usize]);
    }
    buf
}

// ---- Linux bubblewrap sandbox backend ----

#[cfg(target_os = "linux")]
fn detect_bubblewrap() -> Option<PathBuf> {
    let output = Command::new("which").arg("bwrap").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path_str.is_empty() {
        return None;
    }
    let path = PathBuf::from(&path_str);
    if !path.is_file() {
        return None;
    }
    fs::canonicalize(&path).ok()
}

#[cfg(target_os = "linux")]
fn launch_linux_bubblewrap_process(
    plan: &SandboxLaunchPlan,
    timeout_ms: u32,
) -> Result<SandboxCommandOutput, JavisError> {
    use std::io::Write;
    use std::process::{Command as StdCommand, Stdio};

    let bwrap = detect_bubblewrap().ok_or_else(|| {
        JavisError::Internal(
            "bubblewrap (bwrap) is not installed. Install bubblewrap to enable Linux sandbox enforcement."
                .into(),
        )
    })?;

    // Build bwrap arguments
    let mut args: Vec<String> = Vec::new();

    // Mount entire root filesystem read-only as base
    args.push("--ro-bind".to_string());
    args.push("/".to_string());
    args.push("/".to_string());

    // Bind readable roots (already covered by --ro-bind / /, but explicit for clarity)
    for root in &plan.readable_roots {
        args.push("--ro-bind".to_string());
        args.push(root.to_string_lossy().to_string());
        args.push(root.to_string_lossy().to_string());
    }

    // Bind writable roots (overrides the read-only base)
    for root in &plan.writable_roots {
        args.push("--bind".to_string());
        args.push(root.to_string_lossy().to_string());
        args.push(root.to_string_lossy().to_string());
    }

    // Mask protected paths with empty tmpfs
    for path in &plan.protected_paths {
        args.push("--tmpfs".to_string());
        args.push(path.to_string_lossy().to_string());
    }

    // Process tree isolation
    // NOTE: --unshare-pid requires user namespace support (CONFIG_USER_NS=y) on the
    // host kernel. On systems where user namespaces are restricted (e.g. some Docker
    // configurations), bwrap will fail with an error in stderr.
    args.push("--unshare-pid".to_string());
    args.push("--die-with-parent".to_string());
    args.push("--new-session".to_string());

    // Network isolation
    if !plan.network_access {
        args.push("--unshare-net".to_string());
    }

    // Separator
    args.push("--".to_string());

    // The actual program and its arguments
    args.push(plan.executable.to_string_lossy().to_string());
    args.extend(plan.args.clone());

    let mut cmd = StdCommand::new(&bwrap);
    cmd.args(&args)
        .env_clear()
        .envs(
            plan.environment
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if plan.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

    // Spawn and wait with timeout
    let mut child = cmd.spawn().map_err(|error| {
        JavisError::Io(format!(
            "Could not spawn sandbox process via bwrap: {error}"
        ))
    })?;

    // Write stdin if provided
    if let (Some(stdin_data), Some(ref mut stdin_pipe)) = (&plan.stdin, child.stdin.as_mut()) {
        let _ = stdin_pipe.write_all(stdin_data);
    }

    // Wait with timeout using thread + channel
    let (tx, rx) = std::sync::mpsc::channel();
    let pid = child.id();
    std::thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    let output = match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms as u64)) {
        Ok(result) => result
            .map_err(|error| JavisError::Io(format!("Sandbox process (bwrap) error: {error}")))?,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // Timed out — kill the process group gracefully, then force
            if let Some(pid) = pid {
                let _ = StdCommand::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .status();
                std::thread::sleep(std::time::Duration::from_millis(100));
                let _ = StdCommand::new("kill")
                    .arg("-KILL")
                    .arg(pid.to_string())
                    .status();
            }
            return Ok(SandboxCommandOutput {
                command: plan.command.clone(),
                cwd: plan.cwd.to_string_lossy().replace('\\', "/"),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                sandbox: SandboxReport {
                    backend: SandboxBackend::LinuxBubblewrap,
                    backend_status: active_platform_backend_status(),
                    enforced: true,
                    mode: plan.mode.clone(),
                    network_access: plan.network_access,
                    writable_roots: plan
                        .writable_roots
                        .iter()
                        .map(|root| root.to_string_lossy().replace('\\', "/"))
                        .collect(),
                    protected_path_count: plan.protected_path_count,
                    denial_reason: Some(format!(
                        "Sandbox process timed out after {} ms.",
                        timeout_ms
                    )),
                },
            });
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            return Err(JavisError::Internal(
                "Sandbox process (bwrap) exited unexpectedly.".into(),
            ));
        }
    };

    let exit_code = output.status.code();
    let stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(SandboxCommandOutput {
        command: plan.command.clone(),
        cwd: plan.cwd.to_string_lossy().replace('\\', "/"),
        exit_code,
        stdout: stdout_str,
        stderr: stderr_str,
        sandbox: SandboxReport {
            backend: SandboxBackend::LinuxBubblewrap,
            backend_status: active_platform_backend_status(),
            enforced: true,
            mode: plan.mode.clone(),
            network_access: plan.network_access,
            writable_roots: plan
                .writable_roots
                .iter()
                .map(|root| root.to_string_lossy().replace('\\', "/"))
                .collect(),
            protected_path_count: plan.protected_path_count,
            denial_reason: None,
        },
    })
}

#[cfg(target_os = "linux")]
fn platform_backend_status() -> SandboxBackendStatus {
    let bwrap_available = detect_bubblewrap().is_some();
    let filesystem_boundary = unavailable_filesystem_boundary_status();
    let network_boundary = unavailable_network_boundary_status();
    SandboxBackendStatus {
        backend: SandboxBackend::LinuxBubblewrap,
        available: bwrap_available,
        can_spawn: bwrap_available,
        can_control_process_tree: bwrap_available,
        can_create_restricted_token: false,
        can_launch_restricted_process: false,
        can_evaluate_filesystem_policy: true,
        can_evaluate_network_policy: true,
        can_restrict_filesystem: bwrap_available,
        can_deny_network: bwrap_available,
        filesystem_boundary,
        network_boundary,
        reason: if bwrap_available {
            "Linux bubblewrap sandbox backend is available. Filesystem isolation via read-only bind mounts + tmpfs for protected paths, network isolation via --unshare-net.".to_string()
        } else {
            "Linux bubblewrap sandbox backend is unavailable: bwrap binary not found. Install bubblewrap (e.g., apt install bubblewrap) to enable sandbox enforcement.".to_string()
        },
    }
}

// ---- macOS Seatbelt sandbox backend ----

#[cfg(target_os = "macos")]
fn detect_sandbox_exec() -> bool {
    Path::new("/usr/bin/sandbox-exec").is_file()
}

#[cfg(target_os = "macos")]
fn build_seatbelt_profile(plan: &SandboxLaunchPlan) -> String {
    let mut profile = String::new();
    profile.push_str("(version 1)\n");
    profile.push_str("(deny default)\n");
    profile.push_str("(allow process*)\n");
    profile.push_str("(allow sysctl-read)\n");
    profile.push_str("(allow signal)\n");

    // Readable roots: allow read access
    for root in &plan.readable_roots {
        let path = root.to_string_lossy().replace('\\', "/");
        profile.push_str(&format!("(allow file-read* (subpath \"{path}\"))\n"));
    }

    // Writable roots: allow write access (read is implicitly allowed on macOS)
    for root in &plan.writable_roots {
        let path = root.to_string_lossy().replace('\\', "/");
        profile.push_str(&format!("(allow file-write* (subpath \"{path}\"))\n"));
    }

    // Protected paths: explicitly deny read and write
    for path in &plan.protected_paths {
        let path_str = path.to_string_lossy().replace('\\', "/");
        profile.push_str(&format!("(deny file-read* (subpath \"{path_str}\"))\n"));
        profile.push_str(&format!("(deny file-write* (subpath \"{path_str}\"))\n"));
    }

    // Network policy
    if !plan.network_access {
        profile.push_str("(deny network*)\n");
    }

    profile
}

#[cfg(target_os = "macos")]
fn launch_macos_seatbelt_process(
    plan: &SandboxLaunchPlan,
    timeout_ms: u32,
) -> Result<SandboxCommandOutput, JavisError> {
    use std::io::Write;
    use std::process::{Command as StdCommand, Stdio};

    if !detect_sandbox_exec() {
        return Err(JavisError::Internal(
            "macOS sandbox-exec is not available. This should always be present on macOS.".into(),
        ));
    }

    // Build the Seatbelt profile and write to a temp file
    let profile = build_seatbelt_profile(plan);
    let profile_hash = crate::create_fnv1a_hash(profile.as_bytes());
    let profile_path = std::env::temp_dir().join(format!("javis-sandbox-{profile_hash}.sb"));
    {
        let mut file = fs::File::create(&profile_path).map_err(|error| {
            JavisError::Io(format!(
                "Could not create Seatbelt profile {}: {error}",
                profile_path.display()
            ))
        })?;
        file.write_all(profile.as_bytes()).map_err(|error| {
            JavisError::Io(format!(
                "Could not write Seatbelt profile {}: {error}",
                profile_path.display()
            ))
        })?;
    }

    // Build command: sandbox-exec -f <profile> <program> <args...>
    let mut cmd = StdCommand::new("/usr/bin/sandbox-exec");
    cmd.arg("-f")
        .arg(&profile_path)
        .arg(&plan.executable)
        .args(&plan.args)
        .env_clear()
        .envs(
            plan.environment
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if plan.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

    // Spawn and wait with timeout
    let mut child = cmd.spawn().map_err(|error| {
        let _ = fs::remove_file(&profile_path);
        JavisError::Io(format!(
            "Could not spawn sandbox process via sandbox-exec: {error}"
        ))
    })?;

    // Write stdin if provided
    if let (Some(stdin_data), Some(ref mut stdin_pipe)) = (&plan.stdin, child.stdin.as_mut()) {
        let _ = stdin_pipe.write_all(stdin_data);
    }

    // Wait with timeout using thread + channel
    let (tx, rx) = std::sync::mpsc::channel();
    let pid = child.id();
    std::thread::spawn(move || {
        let result = child.wait_with_output();
        let _ = tx.send(result);
    });

    let output = match rx.recv_timeout(std::time::Duration::from_millis(timeout_ms as u64)) {
        Ok(result) => {
            // Clean up temp profile file
            let _ = fs::remove_file(&profile_path);
            result.map_err(|error| {
                JavisError::Io(format!("Sandbox process (sandbox-exec) error: {error}"))
            })?
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // Timed out — kill gracefully, then force
            if let Some(pid) = pid {
                let _ = StdCommand::new("kill")
                    .arg("-TERM")
                    .arg(pid.to_string())
                    .status();
                std::thread::sleep(std::time::Duration::from_millis(100));
                let _ = StdCommand::new("kill")
                    .arg("-KILL")
                    .arg(pid.to_string())
                    .status();
            }
            let _ = fs::remove_file(&profile_path);
            return Ok(SandboxCommandOutput {
                command: plan.command.clone(),
                cwd: plan.cwd.to_string_lossy().replace('\\', "/"),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                sandbox: SandboxReport {
                    backend: SandboxBackend::MacSeatbelt,
                    backend_status: active_platform_backend_status(),
                    enforced: true,
                    mode: plan.mode.clone(),
                    network_access: plan.network_access,
                    writable_roots: plan
                        .writable_roots
                        .iter()
                        .map(|root| root.to_string_lossy().replace('\\', "/"))
                        .collect(),
                    protected_path_count: plan.protected_path_count,
                    denial_reason: Some(format!(
                        "Sandbox process timed out after {} ms.",
                        timeout_ms
                    )),
                },
            });
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            let _ = fs::remove_file(&profile_path);
            return Err(JavisError::Internal(
                "Sandbox process (sandbox-exec) exited unexpectedly.".into(),
            ));
        }
    };

    let exit_code = output.status.code();
    let stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();

    Ok(SandboxCommandOutput {
        command: plan.command.clone(),
        cwd: plan.cwd.to_string_lossy().replace('\\', "/"),
        exit_code,
        stdout: stdout_str,
        stderr: stderr_str,
        sandbox: SandboxReport {
            backend: SandboxBackend::MacSeatbelt,
            backend_status: active_platform_backend_status(),
            enforced: true,
            mode: plan.mode.clone(),
            network_access: plan.network_access,
            writable_roots: plan
                .writable_roots
                .iter()
                .map(|root| root.to_string_lossy().replace('\\', "/"))
                .collect(),
            protected_path_count: plan.protected_path_count,
            denial_reason: None,
        },
    })
}

#[cfg(target_os = "macos")]
fn platform_backend_status() -> SandboxBackendStatus {
    let sb_available = detect_sandbox_exec();
    let filesystem_boundary = unavailable_filesystem_boundary_status();
    let network_boundary = unavailable_network_boundary_status();
    SandboxBackendStatus {
        backend: SandboxBackend::MacSeatbelt,
        available: sb_available,
        can_spawn: sb_available,
        can_control_process_tree: false, // macOS Seatbelt doesn't provide process-tree cleanup like Windows Job Objects
        can_create_restricted_token: false,
        can_launch_restricted_process: false,
        can_evaluate_filesystem_policy: true,
        can_evaluate_network_policy: true,
        can_restrict_filesystem: sb_available,
        can_deny_network: sb_available,
        filesystem_boundary,
        network_boundary,
        reason: if sb_available {
            "macOS Seatbelt sandbox backend is available. Filesystem isolation via Seatbelt profile (allow-read/write scoped to workspace, deny protected paths), network denial via (deny network*).".to_string()
        } else {
            "macOS Seatbelt sandbox backend is unavailable: /usr/bin/sandbox-exec not found."
                .to_string()
        },
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn platform_backend_status() -> SandboxBackendStatus {
    let filesystem_boundary = unavailable_filesystem_boundary_status();
    let network_boundary = unavailable_network_boundary_status();
    SandboxBackendStatus {
        backend: SandboxBackend::Unavailable,
        available: false,
        can_spawn: false,
        can_control_process_tree: false,
        can_create_restricted_token: false,
        can_launch_restricted_process: false,
        can_evaluate_filesystem_policy: true,
        can_evaluate_network_policy: true,
        can_restrict_filesystem: filesystem_boundary.available,
        can_deny_network: network_boundary.available,
        filesystem_boundary,
        network_boundary,
        reason: "No sandbox backend is defined for this platform.".to_string(),
    }
}

fn command_summary(program: &str, args: &[String]) -> String {
    format!("{} {}", program, args.join(" ")).trim().to_string()
}

fn windows_command_line(executable: &Path, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(windows_quote_command_arg(&executable.to_string_lossy()));
    parts.extend(args.iter().map(|arg| windows_quote_command_arg(arg)));
    parts.join(" ")
}

fn windows_quote_command_arg(value: &str) -> String {
    if value.is_empty()
        || value
            .chars()
            .any(|ch| matches!(ch, ' ' | '\t' | '\n' | '\r' | '"'))
    {
        let mut quoted = String::from("\"");
        let mut backslashes = 0;
        for ch in value.chars() {
            match ch {
                '\\' => backslashes += 1,
                '"' => {
                    quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                    quoted.push('"');
                    backslashes = 0;
                }
                _ => {
                    quoted.push_str(&"\\".repeat(backslashes));
                    quoted.push(ch);
                    backslashes = 0;
                }
            }
        }
        quoted.push_str(&"\\".repeat(backslashes * 2));
        quoted.push('"');
        quoted
    } else {
        value.to_string()
    }
}

fn windows_null_terminated_utf16(label: &str, value: &str) -> Result<Vec<u16>, JavisError> {
    if value.contains('\0') {
        return Err(JavisError::Validation(format!(
            "Sandbox {label} contains an embedded NUL."
        )));
    }
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    wide.push(0);
    Ok(wide)
}

fn sandbox_environment() -> Vec<(String, String)> {
    sandbox_environment_from(env::vars())
}

fn sandbox_environment_with_overrides(
    overrides: &[(String, String)],
) -> Result<Vec<(String, String)>, JavisError> {
    let mut environment = sandbox_environment();
    for (key, value) in overrides {
        if key.is_empty()
            || key.contains('=')
            || key.contains('\0')
            || value.contains('\0')
            || is_sensitive_env_key(&key.to_ascii_uppercase())
        {
            return Err(JavisError::Validation(
                "Sandbox command environment contains an invalid entry.".into(),
            ));
        }
        environment.retain(|(existing, _)| !existing.eq_ignore_ascii_case(key));
        environment.push((key.clone(), value.clone()));
    }
    environment.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(environment)
}

fn sandbox_environment_from<I>(vars: I) -> Vec<(String, String)>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut kept = BTreeMap::new();
    for (key, value) in vars {
        if should_keep_sandbox_env_var(&key) {
            kept.insert(key.to_ascii_uppercase(), (key, value));
        }
    }
    kept.into_values().collect()
}

fn windows_environment_block(environment: &[(String, String)]) -> Result<Vec<u16>, JavisError> {
    let mut block = Vec::new();
    for (key, value) in environment {
        if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
            return Err(JavisError::Validation(
                "Sandbox environment contains an invalid Windows environment entry.".into(),
            ));
        }
        block.extend(format!("{key}={value}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

fn should_keep_sandbox_env_var(key: &str) -> bool {
    let normalized = key.trim().to_ascii_uppercase();
    if normalized.is_empty() || is_sensitive_env_key(&normalized) {
        return false;
    }
    matches!(
        normalized.as_str(),
        "PATH"
            | "PATHEXT"
            | "SYSTEMROOT"
            | "WINDIR"
            | "TEMP"
            | "TMP"
            | "COMSPEC"
            | "NUMBER_OF_PROCESSORS"
            | "PROCESSOR_ARCHITECTURE"
            | "PROCESSOR_IDENTIFIER"
            | "PROCESSOR_LEVEL"
            | "PROCESSOR_REVISION"
    )
}

fn is_sensitive_env_key(normalized_key: &str) -> bool {
    [
        "KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "COOKIE",
        "SESSION",
        "PRIVATE",
        "AUTH",
    ]
    .iter()
    .any(|needle| normalized_key.contains(needle))
}

fn default_protected_paths(workspace_root: &Path) -> Vec<PathBuf> {
    [
        ".git",
        ".codex",
        ".agents",
        ".claude",
        ".env",
        ".env.local",
        ".env.production",
        ".aws",
        ".azure",
        ".docker",
        ".gnupg",
        ".kube",
        ".ssh",
        "credentials",
        "cookies",
        "keychain",
        "keyrings",
        "passwords",
    ]
    .into_iter()
    .map(|name| workspace_root.join(name))
    .collect()
}

#[allow(dead_code)]
pub(crate) fn is_default_protected_path(path: &Path) -> bool {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        file_name.as_str(),
        ".git" | ".codex" | ".agents" | ".claude" | ".env"
    ) || file_name.starts_with(".env.")
        || is_sensitive_read_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::append_jsonl_line_to_path;
    use std::{fs, process::Command};

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn read_only_request(root: &Path) -> SandboxCommandRequest {
        SandboxCommandRequest {
            program: "git".to_string(),
            args: vec!["status".to_string(), "--short".to_string()],
            cwd: root.to_path_buf(),
            policy: read_only_policy(root),
            env: Vec::new(),
            stdin: None,
            timeout_ms: None,
        }
    }

    fn test_backend_status(
        available: bool,
        can_restrict_filesystem: bool,
        can_deny_network: bool,
    ) -> SandboxBackendStatus {
        let filesystem_boundary = SandboxBoundaryStatus {
            strategy: SandboxBoundaryStrategy::NotImplemented,
            available: can_restrict_filesystem,
            mutates_host_state: false,
            reason: "test filesystem boundary".to_string(),
        };
        let network_boundary = SandboxBoundaryStatus {
            strategy: SandboxBoundaryStrategy::NotImplemented,
            available: can_deny_network,
            mutates_host_state: false,
            reason: "test network boundary".to_string(),
        };
        SandboxBackendStatus {
            backend: SandboxBackend::WindowsRestrictedToken,
            available,
            can_spawn: true,
            can_control_process_tree: true,
            can_create_restricted_token: true,
            can_launch_restricted_process: true,
            can_evaluate_filesystem_policy: true,
            can_evaluate_network_policy: true,
            can_restrict_filesystem,
            can_deny_network,
            filesystem_boundary,
            network_boundary,
            reason: "test backend".to_string(),
        }
    }

    #[test]
    fn rejects_cwd_outside_workspace() {
        let root = workspace();
        let outside = workspace();
        let mut request = read_only_request(root.path());
        request.cwd = outside.path().to_path_buf();

        let result = run_sandboxed_command(request);

        assert!(matches!(result, Err(JavisError::Permission(_))));
    }

    #[test]
    fn rejects_executable_resolved_from_workspace_by_default() {
        let root = workspace();
        let executable_name = if cfg!(windows) { "git.cmd" } else { "git" };
        fs::write(root.path().join(executable_name), "echo hijacked").unwrap();

        let result = require_executable_outside_workspace(
            &root.path().join(executable_name),
            &fs::canonicalize(root.path()).unwrap(),
        );

        assert!(matches!(result, Err(JavisError::Permission(_))));
    }

    #[test]
    fn rejects_write_mode_without_writable_root() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        policy.mode = SandboxMode::WorkspaceWrite;

        let result = validate_policy(policy);

        assert!(matches!(result, Err(JavisError::Validation(_))));
    }

    #[test]
    fn rejects_workspace_write_when_backend_is_unavailable() {
        let root = workspace();
        let mut request = read_only_request(root.path());
        request.policy.mode = SandboxMode::WorkspaceWrite;
        request.policy.writable_roots = vec![root.path().to_path_buf()];

        let result = run_sandboxed_command(request);

        let Err(JavisError::Permission(message)) = result else {
            panic!("expected unavailable backend permission error");
        };
        assert!(message.contains("Workspace-write commands require an OS sandbox backend"));
        assert!(message.contains("Required sandbox capability: workspace_write_command"));
        assert!(message.contains("Launch readiness blocked by"));
        assert!(message.contains("filesystem_restriction"));
        assert!(message.contains("network_denial"));
        assert!(message.contains("Sandbox backend status"));
        assert!(message.contains("enforced=false"));
    }

    #[test]
    fn workspace_write_launch_helper_fails_closed_without_launcher() {
        let root = workspace();
        let result = require_workspace_write_command_launch_backend(
            "git".to_string(),
            vec!["add".to_string()],
            root.path(),
            workspace_write_policy(root.path(), vec![root.path().to_path_buf()]),
        );

        let Err(error) = result else {
            panic!("workspace-write helper should not permit raw spawn");
        };
        let message = error.to_string();
        assert!(
            message.contains("Workspace-write commands require an OS sandbox backend")
                || message.contains("Workspace-write sandbox launcher is not implemented yet"),
            "{message}"
        );
    }

    #[test]
    fn interactive_session_helper_fails_closed_without_launcher() {
        let root = workspace();
        let result = require_interactive_session_backend(workspace_write_policy(
            root.path(),
            vec![root.path().to_path_buf()],
        ));

        let Err(error) = result else {
            panic!("interactive helper should not permit raw PTY spawn");
        };
        let message = error.to_string();
        assert!(
            message.contains("Interactive sessions require an OS sandbox backend")
                || message.contains("Interactive sandbox launcher is not implemented yet"),
            "{message}"
        );
    }

    #[test]
    fn network_launch_helper_fails_closed_without_launcher() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        policy.network_access = true;
        let result = require_network_command_launch_backend(
            "git".to_string(),
            vec!["push".to_string()],
            root.path(),
            policy,
        );

        let Err(error) = result else {
            panic!("network helper should not permit raw network spawn");
        };
        let message = error.to_string();
        assert!(
            message.contains("Network-capable commands require an OS sandbox backend")
                || message.contains("Network sandbox launcher is not implemented yet"),
            "{message}"
        );
    }

    #[test]
    fn rejects_network_access_until_backend_can_enforce_it() {
        let root = workspace();
        let mut request = read_only_request(root.path());
        request.policy.network_access = true;

        let result = run_sandboxed_command(request);

        let Err(JavisError::Permission(message)) = result else {
            panic!("expected unavailable backend permission error");
        };
        assert!(message.contains("Network access requires an OS sandbox backend"));
        assert!(message.contains("Launch readiness blocked by"));
        assert!(message.contains("filesystem_restriction"));
        assert!(message.contains("Sandbox backend status"));
        assert!(message.contains("enforced=false"));
    }

    #[test]
    fn rejects_full_access_manual_for_model_initiated_commands() {
        let root = workspace();
        let mut request = read_only_request(root.path());
        request.policy.mode = SandboxMode::FullAccessManual;
        request.policy.approval_required = true;
        request.policy.approval = Some(SandboxApprovalScope {
            approval_id: "approval-1".to_string(),
            task_id: Some("task-1".to_string()),
            tool_name: "terminal.create".to_string(),
            preview_hash: "hash-1".to_string(),
        });

        let result = run_sandboxed_command(request);

        let Err(JavisError::Permission(message)) = result else {
            panic!("expected full access rejection");
        };
        assert!(message.contains("Full access is not available to model-initiated commands"));
        assert!(message.contains("Sandbox backend status"));
    }

    #[test]
    fn rejects_non_allowlisted_command_before_network_can_run() {
        let root = workspace();
        let mut request = read_only_request(root.path());
        request.program = "curl".to_string();
        request.args = vec!["https://example.com".to_string()];

        let result = run_sandboxed_command(request);

        assert!(matches!(result, Err(JavisError::Permission(_))));
    }

    #[test]
    fn creates_temporary_workspace_sandbox_copy_under_ignored_root() {
        let root = workspace();
        fs::create_dir_all(root.path().join("src")).expect("create src");
        fs::write(root.path().join("README.md"), "hello\n").expect("write readme");
        fs::write(root.path().join("src").join("main.rs"), "fn main() {}\n").expect("write source");
        fs::create_dir_all(root.path().join(".codex-tmp").join("old")).expect("create tmp");
        fs::write(
            root.path().join(".codex-tmp").join("old").join("skip.txt"),
            "skip\n",
        )
        .expect("write skipped");

        let sandbox = create_temporary_workspace_sandbox(root.path(), " task/one:bad ")
            .expect("temporary workspace sandbox");

        assert_eq!(sandbox.task_id, "task-one-bad");
        assert_eq!(
            sandbox.sandbox_root,
            fs::canonicalize(root.path())
                .unwrap()
                .join(".codex-tmp")
                .join("javis-sandboxes")
                .join("task-one-bad")
        );
        assert!(sandbox.sandbox_root.join("README.md").is_file());
        assert!(sandbox.sandbox_root.join("src").join("main.rs").is_file());
        assert!(!sandbox
            .sandbox_root
            .join(".codex-tmp")
            .join("old")
            .join("skip.txt")
            .exists());
        assert_eq!(sandbox.copied_files, 2);
        assert!(sandbox.copied_directories >= 1);
        assert!(sandbox.skipped_entries >= 1);
    }

    #[test]
    fn rejects_duplicate_temporary_workspace_sandbox_task_id() {
        let root = workspace();
        fs::write(root.path().join("README.md"), "hello\n").expect("write readme");
        create_temporary_workspace_sandbox(root.path(), "task-1").expect("first sandbox");

        let result = create_temporary_workspace_sandbox(root.path(), "task-1");

        assert!(
            matches!(result, Err(JavisError::Validation(message)) if message.contains("already exists"))
        );
    }

    #[test]
    fn rejects_invalid_temporary_workspace_sandbox_task_id() {
        let root = workspace();

        let result = create_temporary_workspace_sandbox(root.path(), "...");

        assert!(matches!(result, Err(JavisError::Validation(_))));
    }

    #[test]
    fn diffs_temporary_workspace_sandbox_against_real_workspace() {
        let root = workspace();
        fs::write(root.path().join("modified.txt"), "before\n").expect("write modified");
        fs::write(root.path().join("deleted.txt"), "delete me\n").expect("write deleted");
        fs::create_dir_all(root.path().join(".codex-tmp").join("old")).expect("create tmp");
        fs::write(
            root.path()
                .join(".codex-tmp")
                .join("old")
                .join("ignored.txt"),
            "ignored\n",
        )
        .expect("write ignored");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-diff")
            .expect("temporary workspace sandbox");
        fs::write(sandbox.sandbox_root.join("modified.txt"), "after\n").expect("modify sandbox");
        fs::write(sandbox.sandbox_root.join("added.txt"), "new\n").expect("add sandbox file");
        fs::remove_file(sandbox.sandbox_root.join("deleted.txt")).expect("delete sandbox file");
        fs::create_dir_all(sandbox.sandbox_root.join(".codex-tmp").join("nested"))
            .expect("create nested tmp");
        fs::write(
            sandbox
                .sandbox_root
                .join(".codex-tmp")
                .join("nested")
                .join("ignored.txt"),
            "ignored changed\n",
        )
        .expect("write nested ignored");

        let diff = diff_temporary_workspace_sandbox(root.path(), &sandbox.sandbox_root)
            .expect("temporary workspace diff");

        assert_eq!(diff.changed_files.len(), 3);
        assert!(diff.changed_files.iter().any(|file| {
            file.path == PathBuf::from("modified.txt")
                && file.change == TemporaryWorkspaceDiffChange::Modified
        }));
        assert!(diff.changed_files.iter().any(|file| {
            file.path == PathBuf::from("added.txt")
                && file.change == TemporaryWorkspaceDiffChange::Added
        }));
        assert!(diff.changed_files.iter().any(|file| {
            file.path == PathBuf::from("deleted.txt")
                && file.change == TemporaryWorkspaceDiffChange::Deleted
        }));
        assert!(diff
            .unified_diff
            .contains("diff --git a/modified.txt b/modified.txt"));
        assert!(diff.unified_diff.contains("-before"));
        assert!(diff.unified_diff.contains("+after"));
        assert!(diff
            .unified_diff
            .contains("diff --git a/added.txt b/added.txt"));
        assert!(diff
            .unified_diff
            .contains("diff --git a/deleted.txt b/deleted.txt"));
        assert!(!diff.unified_diff.contains(".codex-tmp"));
    }

    #[test]
    fn finalizes_temporary_workspace_sandbox_by_deleting_directory() {
        let root = workspace();
        fs::write(root.path().join("README.md"), "hello\n").expect("write readme");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-delete")
            .expect("temporary workspace sandbox");

        let result = finalize_temporary_workspace_sandbox(
            root.path(),
            &sandbox.sandbox_root,
            TemporaryWorkspaceFinalizeMode::Delete,
        )
        .expect("finalize delete");

        assert_eq!(result.mode, TemporaryWorkspaceFinalizeMode::Delete);
        assert_eq!(result.archived_to, None);
        assert!(!sandbox.sandbox_root.exists());
    }

    #[test]
    fn finalizes_temporary_workspace_sandbox_by_archiving_directory() {
        let root = workspace();
        fs::write(root.path().join("README.md"), "hello\n").expect("write readme");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-archive")
            .expect("temporary workspace sandbox");

        let result = finalize_temporary_workspace_sandbox(
            root.path(),
            &sandbox.sandbox_root,
            TemporaryWorkspaceFinalizeMode::Archive,
        )
        .expect("finalize archive");
        let archived_to = result.archived_to.expect("archive path");

        assert_eq!(result.mode, TemporaryWorkspaceFinalizeMode::Archive);
        assert!(!sandbox.sandbox_root.exists());
        assert!(archived_to.join("README.md").is_file());
        assert!(archived_to.starts_with(temporary_workspace_sandboxes_root(
            &fs::canonicalize(root.path()).unwrap()
        )));
    }

    #[test]
    fn rejects_finalizing_temporary_workspace_outside_sandboxes_root() {
        let root = workspace();
        let outside = workspace();

        let result = finalize_temporary_workspace_sandbox(
            root.path(),
            outside.path(),
            TemporaryWorkspaceFinalizeMode::Delete,
        );

        assert!(matches!(result, Err(JavisError::Permission(_))));
        assert!(outside.path().exists());
    }

    #[test]
    fn applies_temporary_workspace_plan_after_hash_and_path_approval() {
        let root = workspace();
        fs::write(root.path().join("modified.txt"), "before\n").expect("write modified");
        fs::write(root.path().join("deleted.txt"), "delete me\n").expect("write deleted");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-apply")
            .expect("temporary workspace sandbox");
        fs::write(sandbox.sandbox_root.join("modified.txt"), "after\n").expect("modify sandbox");
        fs::write(sandbox.sandbox_root.join("added.txt"), "new\n").expect("add sandbox file");
        fs::remove_file(sandbox.sandbox_root.join("deleted.txt")).expect("delete sandbox file");
        let diff = diff_temporary_workspace_sandbox(root.path(), &sandbox.sandbox_root)
            .expect("temporary workspace diff");
        let plan = create_temporary_workspace_apply_plan(&diff).expect("apply plan");

        let result =
            apply_temporary_workspace_sandbox_plan(&plan, &plan.changed_files, &plan.preview_hash)
                .expect("apply temporary workspace plan");

        assert_eq!(result.applied_files, 2);
        assert_eq!(result.deleted_files, 1);
        assert_eq!(
            fs::read_to_string(root.path().join("modified.txt")).expect("modified"),
            "after\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("added.txt")).expect("added"),
            "new\n"
        );
        assert!(!root.path().join("deleted.txt").exists());
    }

    #[test]
    fn temporary_workspace_apply_requires_native_approval() {
        let root = workspace();
        fs::write(root.path().join("README.md"), "before\n").expect("write readme");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-approval")
            .expect("temporary workspace sandbox");
        fs::write(sandbox.sandbox_root.join("README.md"), "after\n").expect("modify sandbox");
        let diff = diff_temporary_workspace_sandbox(root.path(), &sandbox.sandbox_root)
            .expect("temporary workspace diff");
        let plan = create_temporary_workspace_apply_plan(&diff).expect("apply plan");
        let approval_state = Mutex::new(TemporaryWorkspaceApplyApprovalState {
            pending: Some(PendingTemporaryWorkspaceApplyApproval {
                binding: crate::create_native_approval_binding(
                    "approval-1".to_string(),
                    TEMP_WORKSPACE_APPLY_TOOL_NAME,
                    "task-1".to_string(),
                    plan.preview_hash.clone(),
                    false,
                ),
                plan: plan.clone(),
            }),
        });

        let result = take_approved_temporary_workspace_apply(
            &approval_state,
            "approval-1",
            Some("task-1"),
            &plan,
        );

        assert!(
            matches!(result, Err(JavisError::Permission(message)) if message.contains("not been approved"))
        );
    }

    #[test]
    fn temporary_workspace_apply_consumes_native_approval_once() {
        let root = workspace();
        fs::write(root.path().join("README.md"), "before\n").expect("write readme");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-consume")
            .expect("temporary workspace sandbox");
        fs::write(sandbox.sandbox_root.join("README.md"), "after\n").expect("modify sandbox");
        let diff = diff_temporary_workspace_sandbox(root.path(), &sandbox.sandbox_root)
            .expect("temporary workspace diff");
        let plan = create_temporary_workspace_apply_plan(&diff).expect("apply plan");
        let approval_state = Mutex::new(TemporaryWorkspaceApplyApprovalState {
            pending: Some(PendingTemporaryWorkspaceApplyApproval {
                binding: crate::create_native_approval_binding(
                    "approval-1".to_string(),
                    TEMP_WORKSPACE_APPLY_TOOL_NAME,
                    "task-1".to_string(),
                    plan.preview_hash.clone(),
                    false,
                ),
                plan: plan.clone(),
            }),
        });
        approve_temporary_workspace_apply(&approval_state, "approval-1", Some("task-1"))
            .expect("approve temporary workspace apply");

        take_approved_temporary_workspace_apply(
            &approval_state,
            "approval-1",
            Some("task-1"),
            &plan,
        )
        .expect("consume approval");
        let second = take_approved_temporary_workspace_apply(
            &approval_state,
            "approval-1",
            Some("task-1"),
            &plan,
        );

        assert!(
            matches!(second, Err(JavisError::Permission(message)) if message.contains("No approved"))
        );
    }

    #[test]
    fn rejects_temporary_workspace_apply_preview_hash_mismatch() {
        let root = workspace();
        fs::write(root.path().join("README.md"), "before\n").expect("write readme");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-apply-hash")
            .expect("temporary workspace sandbox");
        fs::write(sandbox.sandbox_root.join("README.md"), "after\n").expect("modify sandbox");
        let diff = diff_temporary_workspace_sandbox(root.path(), &sandbox.sandbox_root)
            .expect("temporary workspace diff");
        let plan = create_temporary_workspace_apply_plan(&diff).expect("apply plan");

        let result =
            apply_temporary_workspace_sandbox_plan(&plan, &plan.changed_files, "fnv1a-stale");

        assert!(
            matches!(result, Err(JavisError::Permission(message)) if message.contains("preview hash"))
        );
        assert_eq!(
            fs::read_to_string(root.path().join("README.md")).expect("readme"),
            "before\n"
        );
    }

    #[test]
    fn rejects_temporary_workspace_apply_when_diff_changes_after_plan() {
        let root = workspace();
        fs::write(root.path().join("README.md"), "before\n").expect("write readme");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-apply-stale")
            .expect("temporary workspace sandbox");
        fs::write(sandbox.sandbox_root.join("README.md"), "after\n").expect("modify sandbox");
        let diff = diff_temporary_workspace_sandbox(root.path(), &sandbox.sandbox_root)
            .expect("temporary workspace diff");
        let plan = create_temporary_workspace_apply_plan(&diff).expect("apply plan");
        fs::write(sandbox.sandbox_root.join("README.md"), "changed again\n")
            .expect("modify sandbox again");

        let result =
            apply_temporary_workspace_sandbox_plan(&plan, &plan.changed_files, &plan.preview_hash);

        assert!(
            matches!(result, Err(JavisError::Permission(message)) if message.contains("changed before apply"))
        );
        assert_eq!(
            fs::read_to_string(root.path().join("README.md")).expect("readme"),
            "before\n"
        );
    }

    #[test]
    fn rejects_temporary_workspace_apply_plan_with_binary_changes() {
        let root = workspace();
        fs::write(root.path().join("data.bin"), [0, 159, 146, 150]).expect("write binary");
        let sandbox = create_temporary_workspace_sandbox(root.path(), "task-apply-binary")
            .expect("temporary workspace sandbox");
        fs::write(sandbox.sandbox_root.join("data.bin"), [1, 159, 146, 150])
            .expect("modify binary");
        let diff = diff_temporary_workspace_sandbox(root.path(), &sandbox.sandbox_root)
            .expect("temporary workspace diff");

        let result = create_temporary_workspace_apply_plan(&diff);

        assert!(
            matches!(result, Err(JavisError::Validation(message)) if message.contains("binary changes"))
        );
    }

    #[test]
    fn marks_default_sensitive_paths_as_protected() {
        for name in [
            ".git",
            ".codex",
            ".agents",
            ".claude",
            ".env",
            ".env.local",
            ".ssh",
            ".aws",
            "credentials",
        ] {
            assert!(is_default_protected_path(Path::new(name)), "{name}");
        }
        assert!(is_default_protected_path(Path::new("id_ed25519")));
        assert!(is_default_protected_path(Path::new("secret.pem")));

        let protected = default_protected_paths(Path::new("workspace"));
        assert!(protected.contains(&PathBuf::from("workspace").join(".ssh")));
        assert!(protected.contains(&PathBuf::from("workspace").join("credentials")));
    }

    #[test]
    fn rejects_writable_roots_that_escape_workspace() {
        let root = workspace();
        let outside = workspace();
        let mut policy = read_only_policy(root.path());
        policy.mode = SandboxMode::WorkspaceWrite;
        policy.writable_roots = vec![outside.path().to_path_buf()];

        let result = validate_policy(policy);

        assert!(matches!(result, Err(JavisError::Permission(_))));
    }

    #[test]
    fn rejects_writable_roots_that_escape_workspace_through_symlink() {
        let root = workspace();
        let outside = workspace();
        let link = root.path().join("linked-outside");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(outside.path(), &link).is_err() {
                return;
            }
        }

        let mut policy = read_only_policy(root.path());
        policy.mode = SandboxMode::WorkspaceWrite;
        policy.writable_roots = vec![link];

        let result = validate_policy(policy);

        assert!(matches!(result, Err(JavisError::Permission(_))));
    }

    #[test]
    fn rejects_writable_roots_not_covered_by_readable_roots() {
        let root = workspace();
        let readable = root.path().join("readable");
        let writable = root.path().join("writable");
        fs::create_dir(&readable).expect("readable dir");
        fs::create_dir(&writable).expect("writable dir");
        let mut policy = read_only_policy(root.path());
        policy.mode = SandboxMode::WorkspaceWrite;
        policy.readable_roots = vec![readable];
        policy.writable_roots = vec![writable];

        let result = validate_policy(policy);

        assert!(matches!(result, Err(JavisError::Validation(_))));
    }

    #[test]
    fn filesystem_access_uses_deny_before_allow_and_default_deny() {
        let root = workspace();
        let protected = root.path().join(".git");
        let writable_file = root.path().join("src").join("main.rs");
        fs::create_dir(&protected).expect("protected dir");
        fs::create_dir(root.path().join("src")).expect("src dir");
        fs::write(&writable_file, "fn main() {}\n").expect("write source");

        let mut policy = read_only_policy(root.path());
        policy.mode = SandboxMode::WorkspaceWrite;
        policy.writable_roots = vec![root.path().to_path_buf()];
        let policy = validate_policy(policy).expect("validated policy");
        let rules = compile_filesystem_rules(&policy);

        assert_eq!(
            filesystem_access_for_path(
                &fs::canonicalize(protected.join("config")).unwrap_or(protected.join("config")),
                &rules
            ),
            SandboxFilesystemAccess::Deny
        );
        assert_eq!(
            filesystem_access_for_path(&fs::canonicalize(&writable_file).unwrap(), &rules),
            SandboxFilesystemAccess::ReadWrite
        );
        assert_eq!(
            filesystem_access_for_path(Path::new("C:\\outside\\file.txt"), &rules),
            SandboxFilesystemAccess::Deny
        );
    }

    #[test]
    fn requires_approval_for_mode_escalation() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        policy.approval_required = true;

        let result = validate_policy(policy);

        assert!(matches!(result, Err(JavisError::Permission(_))));
    }

    #[test]
    fn validates_sandbox_approval_scope_against_native_binding() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        policy.approval_required = true;
        policy.approval = Some(SandboxApprovalScope {
            approval_id: "approval-1".to_string(),
            task_id: Some("task-1".to_string()),
            tool_name: "terminal.create".to_string(),
            preview_hash: "hash-1".to_string(),
        });
        let binding = crate::create_native_approval_binding(
            "approval-1".to_string(),
            "terminal.create",
            "task-1".to_string(),
            "hash-1".to_string(),
            true,
        );

        let result = require_sandbox_escalation_approval(&policy, &binding);

        assert!(result.is_ok());
    }

    #[test]
    fn rejects_sandbox_approval_preview_hash_mismatch() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        policy.approval_required = true;
        policy.approval = Some(SandboxApprovalScope {
            approval_id: "approval-1".to_string(),
            task_id: Some("task-1".to_string()),
            tool_name: "terminal.create".to_string(),
            preview_hash: "hash-2".to_string(),
        });
        let binding = crate::create_native_approval_binding(
            "approval-1".to_string(),
            "terminal.create",
            "task-1".to_string(),
            "hash-1".to_string(),
            true,
        );

        let result = require_sandbox_escalation_approval(&policy, &binding);

        assert!(matches!(result, Err(JavisError::Permission(_))));
    }

    #[test]
    fn policy_only_report_never_claims_os_enforcement() {
        let root = workspace();
        let report = SandboxReport {
            backend: SandboxBackend::PolicyOnly,
            backend_status: active_platform_backend_status(),
            enforced: false,
            mode: SandboxMode::ReadOnly,
            network_access: false,
            writable_roots: Vec::new(),
            protected_path_count: default_protected_paths(root.path()).len(),
            denial_reason: None,
        };

        assert_eq!(report.backend, SandboxBackend::PolicyOnly);
        assert!(!report.enforced);
    }

    #[test]
    fn active_platform_backend_status_is_fail_closed_until_backend_exists() {
        let status = active_platform_backend_status();

        assert!(!status.available);
        assert!(status.can_evaluate_filesystem_policy);
        assert!(status.can_evaluate_network_policy);
        assert!(!status.can_restrict_filesystem);
        assert!(!status.can_deny_network);
        assert_eq!(
            status.filesystem_boundary.strategy,
            SandboxBoundaryStrategy::NotImplemented
        );
        assert!(!status.filesystem_boundary.available);
        assert!(!status.filesystem_boundary.mutates_host_state);
        assert_eq!(
            status.network_boundary.strategy,
            SandboxBoundaryStrategy::NotImplemented
        );
        assert!(!status.network_boundary.available);
        assert!(!status.network_boundary.mutates_host_state);
        assert!(!status.reason.trim().is_empty());
        #[cfg(target_os = "windows")]
        {
            assert_eq!(status.backend, SandboxBackend::WindowsRestrictedToken);
            if cfg!(feature = "windows-sandbox-backend") {
                let resources = create_windows_sandbox_process_resources();
                assert_eq!(status.can_spawn, resources.ready_for_process_spawn());
                assert_eq!(
                    status.can_control_process_tree,
                    resources.can_control_process_tree
                );
                assert_eq!(
                    status.can_create_restricted_token,
                    resources.can_create_restricted_token
                );
                assert_eq!(
                    status.can_launch_restricted_process,
                    resources.can_launch_restricted_process
                );
                assert!(status.reason.contains("can_control_process_tree="));
                assert!(status.reason.contains("can_create_restricted_token="));
                assert!(status.reason.contains("can_launch_restricted_process="));
                assert!(status.reason.contains("verifies exit code 0"));
            } else {
                assert!(!status.can_spawn);
                assert!(!status.can_control_process_tree);
                assert!(!status.can_create_restricted_token);
                assert!(!status.can_launch_restricted_process);
                assert!(status.reason.contains("feature is disabled"));
            }
        }
    }

    #[test]
    fn backend_requirements_report_missing_capabilities() {
        let status = test_backend_status(false, false, false);

        assert_eq!(
            missing_backend_capabilities(
                &SandboxBackendRequirement::workspace_write_command(),
                &status
            ),
            vec!["backend_available", "filesystem_restriction"]
        );
        assert_eq!(
            missing_backend_capabilities(&SandboxBackendRequirement::network_command(), &status),
            vec!["backend_available", "filesystem_restriction"]
        );
        assert_eq!(
            missing_backend_capabilities(
                &SandboxBackendRequirement::interactive_session(),
                &status
            ),
            vec!["backend_available", "filesystem_restriction"]
        );
    }

    #[test]
    fn launch_readiness_blocks_until_backend_enforces_policy() {
        let backend = SandboxBackendAssessment {
            requirement_label: "workspace_write_command",
            missing_capabilities: vec![
                "backend_available",
                "filesystem_restriction",
                "network_denial",
            ],
            status: test_backend_status(false, false, false),
        };
        let readiness = sandbox_launch_readiness(
            &backend,
            &compile_windows_enforcement_manifest(
                &[SandboxFilesystemRule {
                    access: SandboxFilesystemAccess::ReadWrite,
                    path: PathBuf::from(r"C:\workspace"),
                }],
                &SandboxNetworkPolicy::DenyAll,
            ),
        );

        assert!(!readiness.ready);
        assert_eq!(
            readiness.blocked_reasons,
            vec![
                "backend_available",
                "filesystem_restriction",
                "network_denial"
            ]
        );
    }

    #[test]
    fn launch_readiness_requires_windows_process_primitives_from_manifest() {
        let backend = SandboxBackendAssessment {
            requirement_label: "workspace_write_command",
            missing_capabilities: Vec::new(),
            status: SandboxBackendStatus {
                can_control_process_tree: false,
                can_create_restricted_token: false,
                ..test_backend_status(true, true, true)
            },
        };
        let readiness = sandbox_launch_readiness(
            &backend,
            &compile_windows_enforcement_manifest(
                &[SandboxFilesystemRule {
                    access: SandboxFilesystemAccess::ReadWrite,
                    path: PathBuf::from(r"C:\workspace"),
                }],
                &SandboxNetworkPolicy::DenyAll,
            ),
        );

        assert!(!readiness.ready);
        assert_eq!(
            readiness.blocked_reasons,
            vec!["process_tree_control", "restricted_token"]
        );
    }

    #[test]
    fn launch_readiness_requires_policy_evaluation_capabilities() {
        let backend = SandboxBackendAssessment {
            requirement_label: "workspace_write_command",
            missing_capabilities: Vec::new(),
            status: SandboxBackendStatus {
                can_evaluate_filesystem_policy: false,
                can_evaluate_network_policy: false,
                ..test_backend_status(true, true, true)
            },
        };
        let readiness = sandbox_launch_readiness(
            &backend,
            &compile_windows_enforcement_manifest(
                &[SandboxFilesystemRule {
                    access: SandboxFilesystemAccess::ReadWrite,
                    path: PathBuf::from(r"C:\workspace"),
                }],
                &SandboxNetworkPolicy::DenyAll,
            ),
        );

        assert!(!readiness.ready);
        assert_eq!(
            readiness.blocked_reasons,
            vec!["filesystem_policy_evaluation", "network_policy_evaluation"]
        );
    }

    #[test]
    fn launch_readiness_only_requires_network_denial_for_deny_all_policy() {
        let backend = SandboxBackendAssessment {
            requirement_label: "workspace_write_command",
            missing_capabilities: Vec::new(),
            status: test_backend_status(true, true, false),
        };
        let readiness = sandbox_launch_readiness(
            &backend,
            &compile_windows_enforcement_manifest(
                &[SandboxFilesystemRule {
                    access: SandboxFilesystemAccess::ReadWrite,
                    path: PathBuf::from(r"C:\workspace"),
                }],
                &SandboxNetworkPolicy::AllowAll,
            ),
        );

        assert!(readiness.ready);
        assert!(readiness.blocked_reasons.is_empty());
    }

    #[test]
    fn launch_plan_resolves_executable_policy_and_backend_assessment() {
        let root = workspace();
        let mut request = read_only_request(root.path());
        request.policy.mode = SandboxMode::WorkspaceWrite;
        request.policy.writable_roots = vec![root.path().to_path_buf()];
        request.policy.approval_required = true;
        request.policy.approval = Some(SandboxApprovalScope {
            approval_id: "approval-1".to_string(),
            task_id: Some("task-1".to_string()),
            tool_name: "git.stageFiles".to_string(),
            preview_hash: "hash-1".to_string(),
        });

        let plan = build_sandbox_launch_plan(
            &request,
            SandboxBackendRequirement::workspace_write_command(),
        )
        .expect("launch plan");

        assert_eq!(plan.command, "git status --short");
        assert!(!plan.executable.starts_with(root.path()));
        assert_eq!(plan.args, vec!["status".to_string(), "--short".to_string()]);
        assert!(plan.windows_command_line.contains("status --short"));
        assert!(plan.windows_command_line_wide.ends_with(&[0]));
        assert!(plan.windows_cwd_wide.ends_with(&[0]));
        assert!(plan
            .environment
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("PATH")));
        assert!(plan.windows_environment_block.ends_with(&[0, 0]));
        assert_eq!(plan.cwd, fs::canonicalize(root.path()).unwrap());
        assert_eq!(plan.mode, SandboxMode::WorkspaceWrite);
        assert!(!plan.network_access);
        assert_eq!(plan.network_policy, SandboxNetworkPolicy::DenyAll);
        assert_eq!(
            plan.readable_roots,
            vec![fs::canonicalize(root.path()).unwrap()]
        );
        assert_eq!(
            plan.writable_roots,
            vec![fs::canonicalize(root.path()).unwrap()]
        );
        assert!(plan
            .protected_paths
            .iter()
            .any(|path| path.ends_with(".git")));
        assert_eq!(
            plan.filesystem_rules
                .iter()
                .map(|rule| &rule.access)
                .take(3)
                .collect::<Vec<_>>(),
            vec![
                &SandboxFilesystemAccess::Deny,
                &SandboxFilesystemAccess::Deny,
                &SandboxFilesystemAccess::Deny
            ]
        );
        assert!(plan
            .filesystem_rules
            .iter()
            .any(|rule| rule.access == SandboxFilesystemAccess::ReadWrite
                && rule.path == fs::canonicalize(root.path()).unwrap()));
        assert!(plan
            .filesystem_rules
            .iter()
            .any(|rule| rule.access == SandboxFilesystemAccess::ReadOnly
                && rule.path == fs::canonicalize(root.path()).unwrap()));
        assert!(plan.windows_enforcement_manifest.requires_job_object);
        assert!(plan.windows_enforcement_manifest.requires_restricted_token);
        assert!(
            plan.windows_enforcement_manifest
                .requires_filesystem_boundary
        );
        assert!(plan.windows_enforcement_manifest.requires_network_boundary);
        assert!(
            !plan
                .windows_enforcement_manifest
                .allow_permanent_acl_mutation
        );
        assert_eq!(
            plan.windows_enforcement_manifest.network_policy,
            SandboxNetworkPolicy::DenyAll
        );
        assert_eq!(
            plan.windows_enforcement_manifest
                .filesystem_rules
                .iter()
                .map(|rule| &rule.access)
                .take(3)
                .collect::<Vec<_>>(),
            vec![
                &SandboxFilesystemAccess::Deny,
                &SandboxFilesystemAccess::Deny,
                &SandboxFilesystemAccess::Deny
            ]
        );
        assert!(plan.protected_path_count >= 5);
        assert_eq!(plan.backend.requirement_label, "workspace_write_command");
        assert!(plan
            .backend
            .missing_capabilities
            .contains(&"backend_available"));
        assert!(!plan.launch_readiness.ready);
        assert!(plan
            .launch_readiness
            .blocked_reasons
            .contains(&"filesystem_restriction"));
        assert!(plan
            .launch_readiness
            .blocked_reasons
            .contains(&"network_denial"));
    }

    #[test]
    fn network_policy_tracks_network_access_flag() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        let validated = validate_policy(policy.clone()).expect("deny policy");
        let network_policy = compile_network_policy(&validated);
        assert_eq!(network_policy, SandboxNetworkPolicy::DenyAll);
        assert!(!network_policy_allows_connect(&network_policy));

        policy.network_access = true;
        let validated = validate_policy(policy).expect("allow policy");
        let network_policy = compile_network_policy(&validated);
        assert_eq!(network_policy, SandboxNetworkPolicy::AllowAll);
        assert!(network_policy_allows_connect(&network_policy));
    }

    #[test]
    fn windows_enforcement_manifest_tracks_network_boundary_requirement() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        policy.network_access = true;
        let validated = validate_policy(policy).expect("allow-network policy");
        let filesystem_rules = compile_filesystem_rules(&validated);
        let network_policy = compile_network_policy(&validated);

        let manifest = compile_windows_enforcement_manifest(&filesystem_rules, &network_policy);

        assert!(manifest.requires_job_object);
        assert!(manifest.requires_restricted_token);
        assert!(manifest.requires_filesystem_boundary);
        assert!(!manifest.requires_network_boundary);
        assert_eq!(manifest.network_policy, SandboxNetworkPolicy::AllowAll);
        assert!(!manifest.allow_permanent_acl_mutation);
    }

    #[test]
    fn windows_manifest_backend_gaps_reports_exact_missing_boundaries() {
        let manifest = WindowsSandboxEnforcementManifest {
            requires_job_object: true,
            requires_restricted_token: true,
            requires_filesystem_boundary: true,
            requires_network_boundary: true,
            allow_permanent_acl_mutation: false,
            filesystem_rules: vec![WindowsSandboxFilesystemRule {
                access: SandboxFilesystemAccess::ReadWrite,
                path: PathBuf::from(r"C:\workspace"),
            }],
            network_policy: SandboxNetworkPolicy::DenyAll,
        };
        let status = SandboxBackendStatus {
            can_control_process_tree: false,
            can_evaluate_network_policy: false,
            ..test_backend_status(true, false, false)
        };

        assert_eq!(
            windows_manifest_backend_gaps(&manifest, &status),
            vec![
                "process_tree_control",
                "filesystem_restriction",
                "network_policy_evaluation",
                "network_denial"
            ]
        );
    }

    #[test]
    fn windows_command_line_quotes_create_process_arguments() {
        let command_line = windows_command_line(
            Path::new(r"C:\Program Files\Git\cmd\git.exe"),
            &[
                "status".to_string(),
                "".to_string(),
                "path with spaces".to_string(),
                r#"say "hello""#.to_string(),
                r#"C:\path\ending\"#.to_string(),
            ],
        );

        assert_eq!(
            command_line,
            r#""C:\Program Files\Git\cmd\git.exe" status "" "path with spaces" "say \"hello\"" C:\path\ending\"#
        );
    }

    #[test]
    fn windows_null_terminated_utf16_rejects_embedded_nul() {
        let wide = windows_null_terminated_utf16("test", "abc").expect("wide string");
        assert_eq!(wide, vec!['a' as u16, 'b' as u16, 'c' as u16, 0]);
        assert!(windows_null_terminated_utf16("test", "a\0b").is_err());
    }

    #[test]
    fn sandbox_environment_keeps_only_safe_launch_variables() {
        let env = sandbox_environment_from(vec![
            ("Path".to_string(), "C:\\Windows\\System32".to_string()),
            ("PATH".to_string(), "C:\\Tools".to_string()),
            ("SYSTEMROOT".to_string(), "C:\\Windows".to_string()),
            ("TEMP".to_string(), "C:\\Temp".to_string()),
            ("OPENAI_API_KEY".to_string(), "secret".to_string()),
            ("SESSION_COOKIE".to_string(), "cookie".to_string()),
            ("HOME".to_string(), "C:\\Users\\Alice".to_string()),
        ]);

        assert!(env.contains(&("PATH".to_string(), "C:\\Tools".to_string())));
        assert!(env.contains(&("SYSTEMROOT".to_string(), "C:\\Windows".to_string())));
        assert!(env.contains(&("TEMP".to_string(), "C:\\Temp".to_string())));
        assert!(!env.iter().any(|(key, _)| key == "OPENAI_API_KEY"));
        assert!(!env.iter().any(|(key, _)| key == "SESSION_COOKIE"));
        assert!(!env.iter().any(|(key, _)| key == "HOME"));
    }

    #[test]
    fn windows_environment_block_is_double_nul_terminated_utf16() {
        let block = windows_environment_block(&[
            ("PATH".to_string(), "C:\\Windows\\System32".to_string()),
            ("TEMP".to_string(), "C:\\Temp".to_string()),
        ])
        .expect("environment block");
        let expected: Vec<u16> = "PATH=C:\\Windows\\System32\0TEMP=C:\\Temp\0\0"
            .encode_utf16()
            .collect();

        assert_eq!(block, expected);
    }

    #[test]
    fn windows_environment_block_rejects_invalid_entries() {
        assert!(
            windows_environment_block(&[("BAD=NAME".to_string(), "value".to_string())]).is_err()
        );
        assert!(
            windows_environment_block(&[("PATH".to_string(), "bad\0value".to_string())]).is_err()
        );
    }

    #[test]
    fn policy_only_command_preserves_stdout_whitespace() {
        let root = workspace();
        Command::new("git")
            .args(["init"])
            .current_dir(root.path())
            .output()
            .expect("git init");
        Command::new("git")
            .args(["config", "user.name", "Javis Test"])
            .current_dir(root.path())
            .output()
            .expect("git config user");
        Command::new("git")
            .args(["config", "user.email", "javis@example.test"])
            .current_dir(root.path())
            .output()
            .expect("git config email");
        fs::write(root.path().join("README.md"), "before\n").expect("write file");
        Command::new("git")
            .args(["add", "README.md"])
            .current_dir(root.path())
            .output()
            .expect("git add");
        Command::new("git")
            .args(["commit", "-m", "Initial commit"])
            .current_dir(root.path())
            .output()
            .expect("git commit");
        fs::write(root.path().join("README.md"), "after\n").expect("modify file");

        let output = run_sandboxed_command(read_only_request(root.path())).expect("git status");

        assert!(output.stdout.starts_with(" M README.md"));
    }

    #[test]
    fn sandbox_audit_event_serializes_backend_status_and_stream_metadata() {
        let root = workspace();
        Command::new("git")
            .args(["init"])
            .current_dir(root.path())
            .output()
            .expect("git init");

        let output = run_sandboxed_command(read_only_request(root.path())).expect("git status");
        let event = sandbox_audit_event_for_output(&output, Some("task-sandbox".to_string()));
        let json = serde_json::to_string(&event).expect("audit event json");
        let jsonl = sandbox_audit_jsonl_line_for_output(&output, Some("task-sandbox".to_string()))
            .expect("audit jsonl line");
        let audit_path = root.path().join("task-audit.jsonl");
        append_jsonl_line_to_path(&audit_path, &jsonl, "Sandbox audit").expect("append audit");

        assert!(!json.contains('\n'));
        assert!(!jsonl.contains('\n'));
        assert_eq!(event.kind, "sandbox_process");
        assert_eq!(event.task_id.as_deref(), Some("task-sandbox"));
        assert_eq!(event.backend, SandboxBackend::PolicyOnly);
        assert_eq!(
            event.backend_status.backend,
            output.sandbox.backend_status.backend
        );
        assert_eq!(event.stdout_bytes, output.stdout.len());
        assert_eq!(event.stderr_bytes, output.stderr.len());
        assert!(!event.stdout_truncated);
        assert!(!event.stderr_truncated);
        assert!(json.contains("\"backendStatus\""));
        assert!(json.contains("\"filesystemBoundary\""));
        assert!(json.contains("\"networkBoundary\""));
        assert!(jsonl.contains("\"taskId\":\"task-sandbox\""));
        assert_eq!(
            fs::read_to_string(audit_path).expect("audit file"),
            format!("{jsonl}\n")
        );
    }

    #[test]
    fn sandbox_audit_event_serializes_denied_launch_reason() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        policy.mode = SandboxMode::WorkspaceWrite;
        policy.writable_roots = vec![root.path().to_path_buf()];
        let policy = validate_policy(policy).expect("policy");
        let assessment =
            assess_backend_capabilities(SandboxBackendRequirement::workspace_write_command());
        let filesystem_rules = compile_filesystem_rules(&policy);
        let network_policy = compile_network_policy(&policy);
        let manifest = compile_windows_enforcement_manifest(&filesystem_rules, &network_policy);
        let readiness = sandbox_launch_readiness(&assessment, &manifest);
        let denial_reason = backend_capability_denial_reason(
            "Workspace-write commands require an OS sandbox backend.",
            &assessment,
            Some(&readiness),
        );
        let output = sandbox_denied_command_output(
            "git add README.md".to_string(),
            root.path(),
            &policy,
            &assessment,
            denial_reason.clone(),
        );

        let event = sandbox_audit_event_for_output(&output, Some("task-denied".to_string()));
        let jsonl = sandbox_audit_jsonl_line_for_output(&output, Some("task-denied".to_string()))
            .expect("audit jsonl line");

        assert_eq!(event.kind, "sandbox_process");
        assert_eq!(event.task_id.as_deref(), Some("task-denied"));
        assert_eq!(event.command, "git add README.md");
        assert_eq!(event.exit_code, None);
        assert_eq!(event.stdout_bytes, 0);
        assert_eq!(event.stderr_bytes, 0);
        assert_eq!(event.denial_reason.as_deref(), Some(denial_reason.as_str()));
        assert!(jsonl.contains("\"denialReason\""));
        assert!(jsonl.contains("Launch readiness blocked by"));
        assert!(jsonl.contains("\"backendStatus\""));
        assert!(jsonl.contains("\"filesystemBoundary\""));
        assert!(jsonl.contains("\"networkBoundary\""));
    }

    #[test]
    fn workspace_write_denied_audit_helper_serializes_task_context() {
        let root = workspace();
        let mut policy = read_only_policy(root.path());
        policy.mode = SandboxMode::WorkspaceWrite;
        policy.writable_roots = vec![root.path().to_path_buf()];
        policy.approval_required = true;
        policy.approval = Some(SandboxApprovalScope {
            approval_id: "approval-1".to_string(),
            task_id: Some("task-code".to_string()),
            tool_name: "code.applyProposedEdit".to_string(),
            preview_hash: "hash-1".to_string(),
        });

        let line = sandbox_denied_workspace_write_audit_jsonl_line(
            "git apply proposal proposal-1".to_string(),
            root.path(),
            policy,
            Some("task-code".to_string()),
        )
        .expect("workspace write denied audit jsonl");

        assert!(line.contains("\"taskId\":\"task-code\""));
        assert!(line.contains("\"command\":\"git apply proposal proposal-1\""));
        assert!(line.contains("\"sandboxMode\":\"workspace_write\""));
        assert!(line.contains("Workspace-write commands require an OS sandbox backend"));
        assert!(line.contains("Launch readiness blocked by"));
    }

    #[test]
    fn boundary_status_reports_correct_strategy_on_current_platform() {
        let fs_status = unavailable_filesystem_boundary_status();
        let net_status = unavailable_network_boundary_status();

        #[cfg(target_os = "windows")]
        {
            // Without feature flag, returns NotImplemented
            if !cfg!(feature = "windows-sandbox-backend") {
                assert_eq!(fs_status.strategy, SandboxBoundaryStrategy::NotImplemented);
                assert_eq!(net_status.strategy, SandboxBoundaryStrategy::NotImplemented);
            }
        }

        #[cfg(target_os = "linux")]
        {
            // Linux always reports LinuxBubblewrap
            assert_eq!(fs_status.strategy, SandboxBoundaryStrategy::LinuxBubblewrap);
            assert_eq!(
                net_status.strategy,
                SandboxBoundaryStrategy::LinuxBubblewrap
            );
            assert!(fs_status.available);
            assert!(net_status.available);
            assert!(!fs_status.mutates_host_state);
            assert!(!net_status.mutates_host_state);
        }

        #[cfg(target_os = "macos")]
        {
            // macOS always reports MacSeatbelt
            assert_eq!(fs_status.strategy, SandboxBoundaryStrategy::MacSeatbelt);
            assert_eq!(net_status.strategy, SandboxBoundaryStrategy::MacSeatbelt);
            assert!(fs_status.available);
            assert!(net_status.available);
            assert!(!fs_status.mutates_host_state);
            assert!(!net_status.mutates_host_state);
        }
    }

    #[test]
    fn active_platform_backend_reports_platform_specific_backend() {
        let status = active_platform_backend_status();

        #[cfg(target_os = "windows")]
        {
            // Without feature flag, Windows backend exists but is unavailable
            assert!(matches!(
                status.backend,
                SandboxBackend::WindowsRestrictedToken
            ));
            // can_evaluate_* are always true regardless of feature
            assert!(status.can_evaluate_filesystem_policy);
            assert!(status.can_evaluate_network_policy);
        }

        #[cfg(target_os = "linux")]
        {
            assert!(matches!(status.backend, SandboxBackend::LinuxBubblewrap));
            assert!(status.can_evaluate_filesystem_policy);
            assert!(status.can_evaluate_network_policy);
        }

        #[cfg(target_os = "macos")]
        {
            assert!(matches!(status.backend, SandboxBackend::MacSeatbelt));
            assert!(status.can_evaluate_filesystem_policy);
            assert!(status.can_evaluate_network_policy);
        }
    }

    #[test]
    fn new_boundary_strategy_variants_exist() {
        // Compile-time verification that the new variants are defined
        let _ = SandboxBoundaryStrategy::LinuxBubblewrap;
        let _ = SandboxBoundaryStrategy::MacSeatbelt;
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn detect_bubblewrap_handles_missing_binary() {
        // If bwrap is not installed, detect_bubblewrap returns None
        let result = detect_bubblewrap();
        // On a system without bubblewrap, this is None
        // On a system with bubblewrap, this is Some(path)
        // Either is valid for the test
        if let Some(path) = result {
            assert!(path.is_file());
            assert!(path.to_string_lossy().contains("bwrap"));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn detect_sandbox_exec_is_available_on_macos() {
        assert!(detect_sandbox_exec());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_seatbelt_profile_includes_readable_roots() {
        let plan = SandboxLaunchPlan {
            command: "test".to_string(),
            executable: PathBuf::from("/usr/bin/true"),
            args: vec![],
            windows_command_line: String::new(),
            windows_command_line_wide: vec![],
            windows_cwd_wide: vec![],
            environment: vec![],
            windows_environment_block: vec![],
            cwd: PathBuf::from("/tmp"),
            mode: SandboxMode::ReadOnly,
            network_access: false,
            network_policy: SandboxNetworkPolicy::DenyAll,
            readable_roots: vec![PathBuf::from("/tmp/workspace")],
            writable_roots: vec![],
            protected_paths: vec![PathBuf::from("/tmp/workspace/.git")],
            filesystem_rules: vec![],
            windows_enforcement_manifest: WindowsSandboxEnforcementManifest {
                requires_job_object: false,
                requires_restricted_token: false,
                requires_filesystem_boundary: false,
                requires_network_boundary: false,
                allow_permanent_acl_mutation: false,
                filesystem_rules: vec![],
                network_policy: SandboxNetworkPolicy::DenyAll,
            },
            protected_path_count: 1,
            backend: SandboxBackendAssessment {
                requirement_label: "test",
                missing_capabilities: vec![],
                status: active_platform_backend_status(),
            },
            launch_readiness: SandboxLaunchReadiness {
                ready: true,
                blocked_reasons: vec![],
            },
            stdin: None,
        };

        let profile = build_seatbelt_profile(&plan);
        assert!(profile.contains("(version 1)"));
        assert!(profile.contains("(deny default)"));
        assert!(profile.contains("(allow process*)"));
        assert!(profile.contains("(allow file-read* (subpath \"/tmp/workspace\"))"));
        assert!(profile.contains("(deny file-read* (subpath \"/tmp/workspace/.git\"))"));
        assert!(profile.contains("(deny file-write* (subpath \"/tmp/workspace/.git\"))"));
        assert!(profile.contains("(deny network*)"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_seatbelt_profile_allows_network_when_enabled() {
        let mut plan = create_minimal_launch_plan();
        plan.network_access = true;
        let profile = build_seatbelt_profile(&plan);
        assert!(!profile.contains("(deny network*)"));
    }

    #[cfg(target_os = "macos")]
    fn create_minimal_launch_plan() -> SandboxLaunchPlan {
        SandboxLaunchPlan {
            command: "test".to_string(),
            executable: PathBuf::from("/usr/bin/true"),
            args: vec![],
            windows_command_line: String::new(),
            windows_command_line_wide: vec![],
            windows_cwd_wide: vec![],
            environment: vec![],
            windows_environment_block: vec![],
            cwd: PathBuf::from("/tmp"),
            mode: SandboxMode::ReadOnly,
            network_access: false,
            network_policy: SandboxNetworkPolicy::DenyAll,
            readable_roots: vec![],
            writable_roots: vec![],
            protected_paths: vec![],
            filesystem_rules: vec![],
            windows_enforcement_manifest: WindowsSandboxEnforcementManifest {
                requires_job_object: false,
                requires_restricted_token: false,
                requires_filesystem_boundary: false,
                requires_network_boundary: false,
                allow_permanent_acl_mutation: false,
                filesystem_rules: vec![],
                network_policy: SandboxNetworkPolicy::DenyAll,
            },
            protected_path_count: 0,
            backend: SandboxBackendAssessment {
                requirement_label: "test",
                missing_capabilities: vec![],
                status: active_platform_backend_status(),
            },
            launch_readiness: SandboxLaunchReadiness {
                ready: true,
                blocked_reasons: vec![],
            },
            stdin: None,
        }
    }
}
