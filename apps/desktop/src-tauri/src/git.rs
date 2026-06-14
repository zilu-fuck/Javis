use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

use crate::pdf::{FileDryRunSummary, PlannedPathOperation};
use crate::sandbox::{
    read_only_policy, require_network_command_launch_backend,
    require_workspace_write_command_launch_backend, run_sandboxed_command, workspace_write_policy,
    SandboxCommandRequest, SandboxPolicy,
};
use crate::{
    approve_native_approval_binding, create_approval_id, create_fnv1a_hash,
    create_native_approval_binding, normalize_path, require_native_approval_binding,
    resolve_command_program, resolve_workspace_path, NativeApprovalBinding,
};

pub(crate) const GIT_PUSH_APPROVAL_TOOL_NAME: &str = "git.pushBranch";
pub(crate) const GIT_STAGE_APPROVAL_TOOL_NAME: &str = "git.stageFiles";
pub(crate) const GIT_COMMIT_APPROVAL_TOOL_NAME: &str = "git.createCommit";
pub(crate) const GIT_CREATE_PR_APPROVAL_TOOL_NAME: &str = "git.createPullRequest";
pub(crate) const GIT_COMMENT_PR_APPROVAL_TOOL_NAME: &str = "git.commentPullRequest";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorkspaceRequest {
    session_id: String,
    workspace_root: String,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitDiffRequest {
    session_id: String,
    workspace_root: String,
    path: Option<String>,
    staged: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStatusSnapshot {
    session_id: String,
    workspace_root: String,
    branch: Option<String>,
    files: Vec<GitFileStatus>,
    diff_stat: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileStatus {
    path: String,
    index_status: String,
    worktree_status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitDiffSnapshot {
    session_id: String,
    workspace_root: String,
    diff: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRemoteSummary {
    session_id: String,
    workspace_root: String,
    branch: Option<String>,
    upstream: Option<String>,
    upstream_remote: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
    remotes: Vec<GitRemoteInfo>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRemoteInfo {
    name: String,
    fetch_url: Option<String>,
    push_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPullRequestsSnapshot {
    session_id: String,
    workspace_root: String,
    provider: String,
    unavailable_reason: Option<String>,
    pull_requests: Vec<GitPullRequestSummary>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPullRequestSummary {
    number: u32,
    title: String,
    state: String,
    url: String,
    author: Option<String>,
    head_ref_name: Option<String>,
    base_ref_name: Option<String>,
    updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPushPreview {
    session_id: String,
    workspace_root: String,
    branch: String,
    upstream: String,
    remote_name: String,
    remote_branch: String,
    remote_url: Option<String>,
    ahead: u32,
    behind: u32,
    commits: Vec<GitPushCommitPreview>,
    dry_run: FileDryRunSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPushCommitPreview {
    hash: String,
    subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPushPlan {
    approval_id: String,
    preview: GitPushPreview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCreatePullRequestPlan {
    approval_id: String,
    preview: GitCreatePullRequestPreview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCreatePullRequestPreview {
    session_id: String,
    workspace_root: String,
    provider: String,
    title: String,
    body: String,
    base_branch: String,
    head_branch: String,
    head_commit: String,
    remote_name: Option<String>,
    remote_url: Option<String>,
    draft: bool,
    dry_run: FileDryRunSummary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanGitCreatePullRequestRequest {
    session_id: String,
    workspace_root: String,
    title: String,
    #[serde(default)]
    body: String,
    base_branch: String,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteGitCreatePullRequestRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    title: String,
    #[serde(default)]
    body: String,
    base_branch: String,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreGitCreatePullRequestApprovalRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    #[serde(default)]
    task_id: Option<String>,
    preview: GitCreatePullRequestRestorePreview,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCreatePullRequestRestorePreview {
    workspace_root: String,
    provider: String,
    title: String,
    body: String,
    base_branch: String,
    head_branch: String,
    head_commit: String,
    remote_url: Option<String>,
    draft: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCreatePullRequestExecutionResult {
    session_id: String,
    workspace_root: String,
    provider: String,
    url: String,
    title: String,
    base_branch: String,
    head_branch: String,
    draft: bool,
    created: bool,
    output: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommentPullRequestPlan {
    approval_id: String,
    preview: GitCommentPullRequestPreview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommentPullRequestPreview {
    session_id: String,
    workspace_root: String,
    provider: String,
    pull_request: String,
    body: String,
    remote_url: Option<String>,
    dry_run: FileDryRunSummary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanGitCommentPullRequestRequest {
    session_id: String,
    workspace_root: String,
    pull_request: String,
    body: String,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteGitCommentPullRequestRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    pull_request: String,
    body: String,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreGitCommentPullRequestApprovalRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    #[serde(default)]
    task_id: Option<String>,
    preview: GitCommentPullRequestRestorePreview,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommentPullRequestRestorePreview {
    workspace_root: String,
    provider: String,
    pull_request: String,
    body: String,
    remote_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommentPullRequestExecutionResult {
    session_id: String,
    workspace_root: String,
    provider: String,
    pull_request: String,
    commented: bool,
    output: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteGitPushRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreGitPushApprovalRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    #[serde(default)]
    task_id: Option<String>,
    preview: GitPushRestorePreview,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitPushRestorePreview {
    branch: String,
    upstream: String,
    remote_name: String,
    remote_branch: String,
    remote_url: Option<String>,
    ahead: u32,
    behind: u32,
    commits: Vec<GitPushRestoreCommitPreview>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitPushRestoreCommitPreview {
    hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPushExecutionResult {
    session_id: String,
    workspace_root: String,
    branch: String,
    upstream: String,
    remote_name: String,
    remote_branch: String,
    commit_count: usize,
    pushed: bool,
    output: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanGitStageRequest {
    session_id: String,
    workspace_root: String,
    paths: Vec<String>,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteGitStageRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    paths: Vec<String>,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreGitStageApprovalRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    #[serde(default)]
    task_id: Option<String>,
    preview: GitStageRestorePreview,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStageRestorePreview {
    workspace_root: String,
    files: Vec<GitStageRestoreFilePreview>,
    diff: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitStageRestoreFilePreview {
    path: String,
    index_status: String,
    worktree_status: String,
    action: String,
    content_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStagePlan {
    approval_id: String,
    preview: GitStagePreview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStagePreview {
    session_id: String,
    workspace_root: String,
    files: Vec<GitStageFilePreview>,
    diff_stat: String,
    diff: String,
    dry_run: FileDryRunSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStageFilePreview {
    path: String,
    index_status: String,
    worktree_status: String,
    action: String,
    content_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitStageExecutionResult {
    session_id: String,
    workspace_root: String,
    staged_paths: Vec<String>,
    file_count: usize,
    staged: bool,
    output: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanGitCommitRequest {
    session_id: String,
    workspace_root: String,
    message: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteGitCommitRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    message: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreGitCommitApprovalRequest {
    approval_id: String,
    session_id: String,
    workspace_root: String,
    #[serde(default)]
    task_id: Option<String>,
    preview: GitCommitRestorePreview,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitRestorePreview {
    workspace_root: String,
    branch: Option<String>,
    message: String,
    files: Vec<GitCommitRestoreFilePreview>,
    diff: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitRestoreFilePreview {
    path: String,
    index_status: String,
    worktree_status: String,
    action: String,
    content_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitPlan {
    approval_id: String,
    preview: GitCommitPreview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitPreview {
    session_id: String,
    workspace_root: String,
    branch: Option<String>,
    message: String,
    files: Vec<GitCommitFilePreview>,
    diff_stat: String,
    diff: String,
    dry_run: FileDryRunSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitFilePreview {
    path: String,
    index_status: String,
    worktree_status: String,
    action: String,
    content_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitExecutionResult {
    session_id: String,
    workspace_root: String,
    branch: Option<String>,
    commit_hash: String,
    subject: String,
    file_count: usize,
    committed: bool,
    output: String,
}

#[derive(Default)]
pub(crate) struct GitPushApprovalState {
    pending: Option<PendingGitPushApproval>,
}

#[derive(Debug)]
struct PendingGitPushApproval {
    binding: NativeApprovalBinding,
}

#[derive(Default)]
pub(crate) struct GitStageApprovalState {
    pending: Option<PendingGitStageApproval>,
}

#[derive(Debug)]
struct PendingGitStageApproval {
    binding: NativeApprovalBinding,
}

#[derive(Default)]
pub(crate) struct GitCommitApprovalState {
    pending: Option<PendingGitCommitApproval>,
}

#[derive(Debug)]
struct PendingGitCommitApproval {
    binding: NativeApprovalBinding,
}

#[derive(Default)]
pub(crate) struct GitCreatePullRequestApprovalState {
    pending: Option<PendingGitCreatePullRequestApproval>,
}

#[derive(Debug)]
struct PendingGitCreatePullRequestApproval {
    binding: NativeApprovalBinding,
}

#[derive(Default)]
pub(crate) struct GitCommentPullRequestApprovalState {
    pending: Option<PendingGitCommentPullRequestApproval>,
}

#[derive(Debug)]
struct PendingGitCommentPullRequestApproval {
    binding: NativeApprovalBinding,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPullRequestSummary {
    number: Option<u32>,
    title: Option<String>,
    state: Option<String>,
    url: Option<String>,
    author: Option<GhPullRequestAuthor>,
    head_ref_name: Option<String>,
    base_ref_name: Option<String>,
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct GhPullRequestAuthor {
    login: Option<String>,
}

#[tauri::command]
pub(crate) fn git_status(request: GitWorkspaceRequest) -> Result<GitStatusSnapshot, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let status = git_output_raw(&cwd, &["status", "--short"])?;
    let branch = git_output(&cwd, &["branch", "--show-current"]).ok();
    let diff_stat = git_output(&cwd, &["diff", "--stat"]).unwrap_or_default();

    Ok(GitStatusSnapshot {
        session_id: request.session_id,
        workspace_root: normalize_path(&cwd),
        branch: branch
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        files: parse_status(&status),
        diff_stat,
    })
}

#[tauri::command]
pub(crate) fn git_remote_summary(request: GitWorkspaceRequest) -> Result<GitRemoteSummary, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let branch = git_output(&cwd, &["branch", "--show-current"])
        .ok()
        .and_then(non_empty_git_value);
    let upstream = git_output(
        &cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .and_then(non_empty_git_value);
    let (ahead, behind) = upstream
        .as_ref()
        .and_then(|_| {
            git_output(
                &cwd,
                &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
            )
            .ok()
        })
        .and_then(|value| parse_ahead_behind(&value))
        .map(|(ahead, behind)| (Some(ahead), Some(behind)))
        .unwrap_or((None, None));
    let remotes = git_output(&cwd, &["remote", "-v"])
        .map(|value| parse_remote_verbose(&value))
        .unwrap_or_default();
    let upstream_remote = upstream
        .as_deref()
        .and_then(|value| value.split('/').next())
        .map(str::to_string)
        .filter(|value| !value.is_empty());

    Ok(GitRemoteSummary {
        session_id: request.session_id,
        workspace_root: normalize_path(&cwd),
        branch,
        upstream,
        upstream_remote,
        ahead,
        behind,
        remotes,
    })
}

#[tauri::command]
pub(crate) fn git_list_pull_requests(
    request: GitWorkspaceRequest,
) -> Result<GitPullRequestsSnapshot, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let workspace_root = normalize_path(&cwd);
    let gh = match resolve_program_from_path(&resolve_command_program("gh"), Some(&cwd)) {
        Some(path) => path,
        None => {
            return Ok(unavailable_pull_requests_snapshot(
                request.session_id,
                workspace_root,
                "GitHub CLI (gh) was not found on trusted PATH.",
            ));
        }
    };
    let output = Command::new(gh)
        .args([
            "pr",
            "list",
            "--limit",
            "20",
            "--json",
            "number,title,state,url,author,headRefName,baseRefName,updatedAt",
        ])
        .env("GH_PROMPT_DISABLED", "1")
        .current_dir(&cwd)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Ok(unavailable_pull_requests_snapshot(
            request.session_id,
            workspace_root,
            &format!(
                "GitHub CLI could not list pull requests: {}",
                truncate_git_message(&stderr)
            ),
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let pull_requests = parse_gh_pull_requests(&stdout)?;

    Ok(GitPullRequestsSnapshot {
        session_id: request.session_id,
        workspace_root,
        provider: "github-cli".to_string(),
        unavailable_reason: None,
        pull_requests,
    })
}

#[tauri::command]
pub(crate) fn git_push_preview(request: GitWorkspaceRequest) -> Result<GitPushPreview, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    build_git_push_preview(&cwd, request.session_id)
}

#[tauri::command]
pub(crate) fn git_plan_push(
    request: GitWorkspaceRequest,
    approval_state: tauri::State<'_, Mutex<GitPushApprovalState>>,
) -> Result<GitPushPlan, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let preview = build_git_push_preview(&cwd, request.session_id)?;
    ensure_git_push_supported(&preview)?;
    let approval_id = create_approval_id();
    let pending =
        create_pending_git_push_approval(&approval_id, request.task_id.as_deref(), &preview);
    store_pending_git_push_approval(&approval_state, pending)?;
    Ok(GitPushPlan {
        approval_id,
        preview,
    })
}

#[tauri::command]
pub(crate) fn git_approve_push(
    approval_id: String,
    task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<GitPushApprovalState>>,
) -> Result<(), String> {
    approve_pending_git_push(&approval_state, &approval_id, task_id.as_deref())
}

#[tauri::command]
pub(crate) fn git_execute_push(
    request: ExecuteGitPushRequest,
    approval_state: tauri::State<'_, Mutex<GitPushApprovalState>>,
) -> Result<GitPushExecutionResult, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    execute_git_push_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_restore_push_approval(
    request: RestoreGitPushApprovalRequest,
    approval_state: tauri::State<'_, Mutex<GitPushApprovalState>>,
) -> Result<(), String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    restore_git_push_approval_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_plan_create_pull_request(
    request: PlanGitCreatePullRequestRequest,
    approval_state: tauri::State<'_, Mutex<GitCreatePullRequestApprovalState>>,
) -> Result<GitCreatePullRequestPlan, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let preview = build_git_create_pull_request_preview(
        &cwd,
        request.session_id,
        &request.title,
        &request.body,
        &request.base_branch,
        request.draft.unwrap_or(true),
    )?;
    let approval_id = create_approval_id();
    let pending = create_pending_git_create_pull_request_approval(
        &approval_id,
        request.task_id.as_deref(),
        &preview,
    );
    store_pending_git_create_pull_request_approval(&approval_state, pending)?;
    Ok(GitCreatePullRequestPlan {
        approval_id,
        preview,
    })
}

#[tauri::command]
pub(crate) fn git_approve_create_pull_request(
    approval_id: String,
    task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<GitCreatePullRequestApprovalState>>,
) -> Result<(), String> {
    approve_pending_git_create_pull_request(&approval_state, &approval_id, task_id.as_deref())
}

#[tauri::command]
pub(crate) fn git_execute_create_pull_request(
    request: ExecuteGitCreatePullRequestRequest,
    approval_state: tauri::State<'_, Mutex<GitCreatePullRequestApprovalState>>,
) -> Result<GitCreatePullRequestExecutionResult, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    execute_git_create_pull_request_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_restore_create_pull_request_approval(
    request: RestoreGitCreatePullRequestApprovalRequest,
    approval_state: tauri::State<'_, Mutex<GitCreatePullRequestApprovalState>>,
) -> Result<(), String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    restore_git_create_pull_request_approval_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_plan_comment_pull_request(
    request: PlanGitCommentPullRequestRequest,
    approval_state: tauri::State<'_, Mutex<GitCommentPullRequestApprovalState>>,
) -> Result<GitCommentPullRequestPlan, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let preview = build_git_comment_pull_request_preview(
        &cwd,
        request.session_id,
        &request.pull_request,
        &request.body,
    )?;
    let approval_id = create_approval_id();
    let pending = create_pending_git_comment_pull_request_approval(
        &approval_id,
        request.task_id.as_deref(),
        &preview,
    );
    store_pending_git_comment_pull_request_approval(&approval_state, pending)?;
    Ok(GitCommentPullRequestPlan {
        approval_id,
        preview,
    })
}

#[tauri::command]
pub(crate) fn git_approve_comment_pull_request(
    approval_id: String,
    task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<GitCommentPullRequestApprovalState>>,
) -> Result<(), String> {
    approve_pending_git_comment_pull_request(&approval_state, &approval_id, task_id.as_deref())
}

#[tauri::command]
pub(crate) fn git_execute_comment_pull_request(
    request: ExecuteGitCommentPullRequestRequest,
    approval_state: tauri::State<'_, Mutex<GitCommentPullRequestApprovalState>>,
) -> Result<GitCommentPullRequestExecutionResult, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    execute_git_comment_pull_request_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_restore_comment_pull_request_approval(
    request: RestoreGitCommentPullRequestApprovalRequest,
    approval_state: tauri::State<'_, Mutex<GitCommentPullRequestApprovalState>>,
) -> Result<(), String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    restore_git_comment_pull_request_approval_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_plan_stage_files(
    request: PlanGitStageRequest,
    approval_state: tauri::State<'_, Mutex<GitStageApprovalState>>,
) -> Result<GitStagePlan, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let preview = build_git_stage_preview(&cwd, request.session_id, &request.paths)?;
    let approval_id = create_approval_id();
    let pending =
        create_pending_git_stage_approval(&approval_id, request.task_id.as_deref(), &preview);
    store_pending_git_stage_approval(&approval_state, pending)?;
    Ok(GitStagePlan {
        approval_id,
        preview,
    })
}

#[tauri::command]
pub(crate) fn git_approve_stage_files(
    approval_id: String,
    task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<GitStageApprovalState>>,
) -> Result<(), String> {
    approve_pending_git_stage(&approval_state, &approval_id, task_id.as_deref())
}

#[tauri::command]
pub(crate) fn git_execute_stage_files(
    request: ExecuteGitStageRequest,
    approval_state: tauri::State<'_, Mutex<GitStageApprovalState>>,
) -> Result<GitStageExecutionResult, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    execute_git_stage_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_restore_stage_approval(
    request: RestoreGitStageApprovalRequest,
    approval_state: tauri::State<'_, Mutex<GitStageApprovalState>>,
) -> Result<(), String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    restore_git_stage_approval_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_plan_commit(
    request: PlanGitCommitRequest,
    approval_state: tauri::State<'_, Mutex<GitCommitApprovalState>>,
) -> Result<GitCommitPlan, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let preview = build_git_commit_preview_for_paths(
        &cwd,
        request.session_id,
        &request.message,
        &request.paths,
    )?;
    let approval_id = create_approval_id();
    let pending =
        create_pending_git_commit_approval(&approval_id, request.task_id.as_deref(), &preview)?;
    store_pending_git_commit_approval(&approval_state, pending)?;
    Ok(GitCommitPlan {
        approval_id,
        preview,
    })
}

#[tauri::command]
pub(crate) fn git_approve_commit(
    approval_id: String,
    task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<GitCommitApprovalState>>,
) -> Result<(), String> {
    approve_pending_git_commit(&approval_state, &approval_id, task_id.as_deref())
}

#[tauri::command]
pub(crate) fn git_execute_commit(
    request: ExecuteGitCommitRequest,
    approval_state: tauri::State<'_, Mutex<GitCommitApprovalState>>,
) -> Result<GitCommitExecutionResult, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    execute_git_commit_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_restore_commit_approval(
    request: RestoreGitCommitApprovalRequest,
    approval_state: tauri::State<'_, Mutex<GitCommitApprovalState>>,
) -> Result<(), String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    restore_git_commit_approval_in_workspace(&cwd, &request, &approval_state)
}

#[tauri::command]
pub(crate) fn git_diff(request: GitDiffRequest) -> Result<GitDiffSnapshot, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let mut args = vec!["diff".to_string(), "--unified=1".to_string()];
    if request.staged.unwrap_or(false) {
        args.push("--cached".to_string());
    }
    if let Some(path) = request.path.as_ref().filter(|path| !path.trim().is_empty()) {
        args.push("--".to_string());
        args.push(path.clone());
    }
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let diff = git_output(&cwd, &arg_refs)?;

    Ok(GitDiffSnapshot {
        session_id: request.session_id,
        workspace_root: normalize_path(&cwd),
        diff,
    })
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<String, String> {
    Ok(git_output_raw(cwd, args)?.trim().to_string())
}

fn require_git_workspace_write_backend(cwd: &Path, args: &[&str]) -> Result<(), String> {
    require_workspace_write_command_launch_backend(
        "git".to_string(),
        args.iter().map(|arg| (*arg).to_string()).collect(),
        cwd,
        workspace_write_policy(cwd, vec![cwd.to_path_buf()]),
    )
    .map_err(|error| error.to_string())
}

fn require_git_network_backend(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let mut policy = read_only_policy(cwd);
    policy.network_access = true;
    require_network_command_launch_backend(
        "git".to_string(),
        args.iter().map(|arg| (*arg).to_string()).collect(),
        cwd,
        policy,
    )
    .map_err(|error| error.to_string())
}

fn require_gh_network_backend(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let mut policy = read_only_policy(cwd);
    policy.network_access = true;
    require_network_command_launch_backend(
        "gh".to_string(),
        args.iter().map(|arg| (*arg).to_string()).collect(),
        cwd,
        policy,
    )
    .map_err(|error| error.to_string())
}

fn run_sandboxed_git_command(
    cwd: &Path,
    args: &[&str],
    policy: SandboxPolicy,
    stdin: Option<Vec<u8>>,
) -> Result<String, String> {
    let args = hardened_git_args(args);
    let output = run_sandboxed_command(SandboxCommandRequest {
        program: "git".to_string(),
        args,
        cwd: cwd.to_path_buf(),
        policy,
        env: Vec::new(),
        stdin,
        timeout_ms: None,
    })
    .map_err(|error| error.to_string())?;
    if output.exit_code.unwrap_or(1) != 0 {
        return Err(output.stderr.trim().to_string());
    }
    Ok(output.stdout.trim().to_string())
}

fn run_sandboxed_gh_command(
    cwd: &Path,
    args: &[&str],
    stdin: Option<Vec<u8>>,
) -> Result<String, String> {
    let mut policy = workspace_write_policy(cwd, vec![cwd.to_path_buf()]);
    policy.network_access = true;
    let arg_strings = args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    let output = run_sandboxed_command(SandboxCommandRequest {
        program: "gh".to_string(),
        args: arg_strings,
        cwd: cwd.to_path_buf(),
        policy,
        env: Vec::new(),
        stdin,
        timeout_ms: None,
    })
    .map_err(|error| error.to_string())?;
    if output.exit_code.unwrap_or(1) != 0 {
        return Err(output.stderr.trim().to_string());
    }
    Ok(output.stdout.trim().to_string())
}

fn git_output_raw(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let git = resolve_git_executable_for_workspace(cwd)?;
    let output = Command::new(git)
        .args(hardened_git_args(args))
        .current_dir(cwd)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_output_for_paths(
    cwd: &Path,
    base_args: &[&str],
    paths: &[String],
) -> Result<String, String> {
    let mut args = base_args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    args.push("--".to_string());
    args.extend(paths.iter().cloned());
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    git_output(cwd, &arg_refs)
}

fn hardened_git_args(args: &[&str]) -> Vec<String> {
    let mut safe_args = vec![
        "-c".to_string(),
        "core.fsmonitor=false".to_string(),
        "-c".to_string(),
        "diff.external=".to_string(),
    ];
    safe_args.extend(args.iter().map(|arg| arg.to_string()));
    if args.first() == Some(&"diff") && (args.contains(&"--stat") || args.contains(&"--unified=1"))
    {
        safe_args.push("--no-ext-diff".to_string());
        safe_args.push("--no-textconv".to_string());
    }
    safe_args
}

pub(crate) fn resolve_git_executable_for_workspace(workspace: &Path) -> Result<PathBuf, String> {
    resolve_program_from_path(&resolve_command_program("git"), Some(workspace))
        .ok_or_else(|| "Could not locate trusted git executable on PATH.".to_string())
}

fn resolve_program_from_path(program: &str, untrusted_root: Option<&Path>) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.is_absolute() && candidate.is_file() {
        return trusted_candidate(candidate, untrusted_root);
    }

    let path_exts = executable_extensions();
    for dir in env::split_paths(&env::var_os("PATH")?) {
        if !dir.is_absolute() {
            continue;
        }
        let base = dir.join(program);
        if let Some(candidate) = trusted_candidate(base, untrusted_root) {
            return Some(candidate);
        }
        for ext in &path_exts {
            let with_ext = dir.join(format!("{program}{ext}"));
            if let Some(candidate) = trusted_candidate(with_ext, untrusted_root) {
                return Some(candidate);
            }
        }
    }
    None
}

fn trusted_candidate(candidate: PathBuf, untrusted_root: Option<&Path>) -> Option<PathBuf> {
    if !candidate.is_file() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    if let Some(root) = untrusted_root {
        let canonical_root = root.canonicalize().ok()?;
        if canonical.starts_with(canonical_root) {
            return None;
        }
    }
    Some(canonical)
}

fn executable_extensions() -> Vec<String> {
    #[cfg(windows)]
    {
        env::var_os("PATHEXT")
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .filter(|ext| !ext.trim().is_empty())
                    .map(|ext| ext.to_string())
                    .collect::<Vec<_>>()
            })
            .filter(|exts| !exts.is_empty())
            .unwrap_or_else(|| vec![".exe".to_string(), ".cmd".to_string(), ".bat".to_string()])
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

fn parse_status(status: &str) -> Vec<GitFileStatus> {
    status
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let index_status = line.get(0..1).unwrap_or(" ").trim().to_string();
            let worktree_status = line.get(1..2).unwrap_or(" ").trim().to_string();
            let path = line.get(3..).unwrap_or("").trim().to_string();
            if path.is_empty() {
                return None;
            }
            Some(GitFileStatus {
                path,
                index_status,
                worktree_status,
            })
        })
        .collect()
}

fn build_git_commit_preview(
    cwd: &Path,
    session_id: String,
    message: &str,
) -> Result<GitCommitPreview, String> {
    build_git_commit_preview_for_paths(cwd, session_id, message, &[])
}

fn build_git_commit_preview_for_paths(
    cwd: &Path,
    session_id: String,
    message: &str,
    paths: &[String],
) -> Result<GitCommitPreview, String> {
    let message = sanitize_commit_message(message)?;
    let requested_paths = normalize_commit_paths(paths)?;
    let status_output = git_output_raw(cwd, &["status", "--short", "--untracked-files=all"])?;
    let status_files = parse_commit_status(cwd, &status_output)?;
    let files = select_commit_files(status_files, &requested_paths, "Git commit preview")?;
    if files.is_empty() {
        return Err("Git commit preview found no changed files.".to_string());
    }
    let branch = git_output(cwd, &["branch", "--show-current"])
        .ok()
        .and_then(non_empty_git_value);
    let diff_stat = create_git_commit_diff_stat_for_paths(cwd, &requested_paths);
    let diff = create_git_commit_diff_preview_for_paths(cwd, &requested_paths);
    let dry_run = create_git_commit_dry_run(&message, &files, !requested_paths.is_empty());

    Ok(GitCommitPreview {
        session_id,
        workspace_root: normalize_path(cwd),
        branch,
        message,
        files,
        diff_stat,
        diff,
        dry_run,
    })
}

fn select_commit_files(
    status_files: Vec<GitCommitFilePreview>,
    requested_paths: &[String],
    operation_label: &str,
) -> Result<Vec<GitCommitFilePreview>, String> {
    if requested_paths.is_empty() {
        return Ok(status_files);
    }
    let mut by_path = BTreeMap::new();
    for file in status_files {
        by_path.insert(normalized_commit_status_path(&file.path), file);
    }
    requested_paths
        .iter()
        .map(|path| {
            by_path.get(path).cloned().ok_or_else(|| {
                let available = by_path.keys().cloned().collect::<Vec<_>>().join(", ");
                format!("{operation_label} could not find changed path: {path}. Available changed paths: {available}")
            })
        })
        .collect()
}

fn sanitize_commit_message(message: &str) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Git commit message is required.".to_string());
    }
    if trimmed.chars().count() > 500 {
        return Err("Git commit message must be 500 characters or fewer.".to_string());
    }
    Ok(trimmed.to_string())
}

fn parse_commit_status(cwd: &Path, status: &str) -> Result<Vec<GitCommitFilePreview>, String> {
    parse_status(status)
        .into_iter()
        .map(|file| {
            let content_hash = create_git_commit_file_content_hash(cwd, &file.path)?;
            Ok(GitCommitFilePreview {
                action: classify_commit_action(&file.index_status, &file.worktree_status),
                path: file.path,
                index_status: file.index_status,
                worktree_status: file.worktree_status,
                content_hash,
            })
        })
        .collect()
}

fn build_git_stage_preview(
    cwd: &Path,
    session_id: String,
    paths: &[String],
) -> Result<GitStagePreview, String> {
    let requested_paths = normalize_stage_paths(paths)?;
    let status_output = git_output_raw(cwd, &["status", "--short", "--untracked-files=all"])?;
    let status_files = parse_commit_status(cwd, &status_output)?;
    let mut by_path = BTreeMap::new();
    for file in status_files {
        by_path.insert(normalized_commit_status_path(&file.path), file);
    }
    let files = requested_paths
        .iter()
        .map(|path| {
            let file = by_path.get(path).ok_or_else(|| {
                let available = by_path.keys().cloned().collect::<Vec<_>>().join(", ");
                format!("Git stage preview could not find changed path: {path}. Available changed paths: {available}")
            })?;
            Ok(GitStageFilePreview {
                path: normalized_commit_status_path(&file.path),
                index_status: file.index_status.clone(),
                worktree_status: file.worktree_status.clone(),
                action: file.action.clone(),
                content_hash: file.content_hash.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let diff_stat = create_git_stage_diff_stat(cwd, &requested_paths);
    let diff = create_git_stage_diff_preview(cwd, &requested_paths);
    let dry_run = create_git_stage_dry_run(&files);

    Ok(GitStagePreview {
        session_id,
        workspace_root: normalize_path(cwd),
        files,
        diff_stat,
        diff,
        dry_run,
    })
}

fn normalize_stage_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("Git stage preview requires at least one path.".to_string());
    }
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for raw_path in paths {
        let path = normalize_stage_path(raw_path)?;
        if seen.insert(path.clone()) {
            normalized.push(path);
        }
    }
    if normalized.is_empty() {
        return Err("Git stage preview requires at least one path.".to_string());
    }
    Ok(normalized)
}

fn normalize_stage_path(raw_path: &str) -> Result<String, String> {
    normalize_git_relative_path(raw_path, "Git stage paths")
}

fn normalize_commit_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for raw_path in paths {
        let path = normalize_commit_path(raw_path)?;
        if seen.insert(path.clone()) {
            normalized.push(path);
        }
    }
    if normalized.is_empty() {
        return Err("Git commit paths must include at least one path when provided.".to_string());
    }
    Ok(normalized)
}

fn normalize_commit_path(raw_path: &str) -> Result<String, String> {
    normalize_git_relative_path(raw_path, "Git commit paths")
}

fn normalize_git_relative_path(raw_path: &str, label: &str) -> Result<String, String> {
    let path = normalized_commit_status_path(raw_path.trim())
        .replace('\\', "/")
        .trim()
        .trim_matches('"')
        .to_string();
    if path.is_empty() {
        return Err(format!("{label} must not be empty."));
    }
    if path.starts_with('-') {
        return Err(format!("{label} must be repository-relative file paths."));
    }
    if path.contains('\0') || Path::new(&path).is_absolute() {
        return Err(format!("{label} must be repository-relative file paths."));
    }
    if path
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!(
            "{label} must not contain empty or parent-directory segments."
        ));
    }
    Ok(path)
}

fn create_git_stage_diff_stat(cwd: &Path, paths: &[String]) -> String {
    git_output_for_paths(cwd, &["diff", "--stat"], paths).unwrap_or_default()
}

fn create_git_stage_diff_preview(cwd: &Path, paths: &[String]) -> String {
    git_output_for_paths(cwd, &["diff", "--unified=1"], paths).unwrap_or_default()
}

fn create_git_stage_dry_run(files: &[GitStageFilePreview]) -> FileDryRunSummary {
    FileDryRunSummary {
        operation: "Preview Git stage selected files".to_string(),
        affected_paths: files
            .iter()
            .map(|file| PlannedPathOperation {
                source: file.path.clone(),
                target: file.path.clone(),
                action: "stage".to_string(),
                conflict: None,
            })
            .collect(),
        risk_summary: format!(
            "Preview only. No Git write was executed. A future stage operation would update the Git index for {} selected file(s).",
            files.len()
        ),
        reversible: true,
    }
}

fn create_pending_git_stage_approval(
    approval_id: &str,
    task_id: Option<&str>,
    preview: &GitStagePreview,
) -> PendingGitStageApproval {
    PendingGitStageApproval {
        binding: create_native_approval_binding(
            approval_id.to_string(),
            GIT_STAGE_APPROVAL_TOOL_NAME,
            task_id.unwrap_or_default().trim().to_string(),
            create_git_stage_preview_hash(preview),
            false,
        ),
    }
}

fn store_pending_git_stage_approval(
    approval_state: &Mutex<GitStageApprovalState>,
    approval: PendingGitStageApproval,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git stage approval state could not be locked.".to_string())?;
    state.pending = Some(approval);
    Ok(())
}

fn approve_pending_git_stage(
    approval_state: &Mutex<GitStageApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git stage approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_mut() else {
        return Err("No pending Git stage approval exists.".to_string());
    };
    let preview_hash = pending.binding.preview_hash.clone();
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        GIT_STAGE_APPROVAL_TOOL_NAME,
        task_id,
        &preview_hash,
        "Git stage approval id does not match the pending dry-run.",
    )
}

fn take_approved_git_stage(
    approval_state: &Mutex<GitStageApprovalState>,
    request: &ExecuteGitStageRequest,
    current_preview: &GitStagePreview,
) -> Result<PendingGitStageApproval, String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git stage approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_ref() else {
        return Err("No approved Git stage dry-run is pending.".to_string());
    };
    let preview_hash = create_git_stage_preview_hash(current_preview);
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        GIT_STAGE_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &preview_hash,
        "Git stage approval id does not match the pending dry-run.",
        "Git stage dry-run has not been approved.",
    )
    .map_err(|error| error.to_string())?;

    state
        .pending
        .take()
        .ok_or_else(|| "No approved Git stage dry-run is pending.".to_string())
}

fn execute_git_stage_in_workspace(
    cwd: &Path,
    request: &ExecuteGitStageRequest,
    approval_state: &Mutex<GitStageApprovalState>,
) -> Result<GitStageExecutionResult, String> {
    let preview = build_git_stage_preview(cwd, request.session_id.clone(), &request.paths)?;
    let staged_paths = preview
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let file_count = staged_paths.len();
    require_git_workspace_write_backend(cwd, &["add"])?;
    take_approved_git_stage(approval_state, request, &preview)?;
    let mut stage_args: Vec<&str> = vec!["add", "--"];
    let path_strs: Vec<&str> = staged_paths.iter().map(|p| p.as_str()).collect();
    stage_args.extend(&path_strs);
    let output = run_sandboxed_git_command(
        cwd,
        &stage_args,
        workspace_write_policy(cwd, vec![cwd.to_path_buf()]),
        None,
    )?;

    Ok(GitStageExecutionResult {
        session_id: request.session_id.clone(),
        workspace_root: normalize_path(cwd),
        staged_paths,
        file_count,
        staged: true,
        output,
    })
}

fn restore_git_stage_approval_in_workspace(
    cwd: &Path,
    request: &RestoreGitStageApprovalRequest,
    approval_state: &Mutex<GitStageApprovalState>,
) -> Result<(), String> {
    let paths = request
        .preview
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let current_preview = build_git_stage_preview(cwd, request.session_id.clone(), &paths)?;
    if create_git_stage_preview_hash(&current_preview)
        != create_git_stage_restore_preview_hash(&request.preview)
    {
        return Err(
            "Restored Git stage preview no longer matches the current repository state."
                .to_string(),
        );
    }
    let pending = create_pending_git_stage_approval(
        &request.approval_id,
        request.task_id.as_deref(),
        &current_preview,
    );
    store_pending_git_stage_approval(approval_state, pending)
}

fn create_git_stage_preview_hash(preview: &GitStagePreview) -> String {
    let file_fingerprints = preview
        .files
        .iter()
        .map(create_git_stage_file_fingerprint)
        .collect::<Vec<_>>()
        .join("\n");
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}",
            preview.workspace_root, preview.diff, file_fingerprints
        )
        .as_bytes(),
    )
}

fn create_git_stage_restore_preview_hash(preview: &GitStageRestorePreview) -> String {
    let file_fingerprints = preview
        .files
        .iter()
        .map(create_git_stage_restore_file_fingerprint)
        .collect::<Vec<_>>()
        .join("\n");
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}",
            preview.workspace_root, preview.diff, file_fingerprints
        )
        .as_bytes(),
    )
}

fn create_git_stage_file_fingerprint(file: &GitStageFilePreview) -> String {
    let path = normalized_commit_status_path(&file.path);
    format!(
        "{}\t{}\t{}\t{}\t{}",
        file.index_status, file.worktree_status, file.action, path, file.content_hash
    )
}

fn create_git_stage_restore_file_fingerprint(file: &GitStageRestoreFilePreview) -> String {
    let path = normalized_commit_status_path(&file.path);
    format!(
        "{}\t{}\t{}\t{}\t{}",
        file.index_status, file.worktree_status, file.action, path, file.content_hash
    )
}

fn classify_commit_action(index_status: &str, worktree_status: &str) -> String {
    if index_status == "?" || index_status == "A" || worktree_status == "A" {
        return "create".to_string();
    }
    if index_status == "D" || worktree_status == "D" {
        return "delete".to_string();
    }
    "modify".to_string()
}

fn create_git_commit_diff_stat(cwd: &Path) -> String {
    let unstaged = git_output(cwd, &["diff", "--stat"]).unwrap_or_default();
    let staged = git_output(cwd, &["diff", "--stat", "--cached"]).unwrap_or_default();
    [staged, unstaged]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn create_git_commit_diff_stat_for_paths(cwd: &Path, paths: &[String]) -> String {
    if paths.is_empty() {
        return create_git_commit_diff_stat(cwd);
    }
    let staged =
        git_output_for_paths(cwd, &["diff", "--stat", "--cached"], paths).unwrap_or_default();
    let unstaged = git_output_for_paths(cwd, &["diff", "--stat"], paths).unwrap_or_default();
    [staged, unstaged]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn create_git_commit_diff_preview(cwd: &Path) -> String {
    let staged = git_output(cwd, &["diff", "--unified=1", "--cached"]).unwrap_or_default();
    let unstaged = git_output(cwd, &["diff", "--unified=1"]).unwrap_or_default();
    [staged, unstaged]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn create_git_commit_diff_preview_for_paths(cwd: &Path, paths: &[String]) -> String {
    if paths.is_empty() {
        return create_git_commit_diff_preview(cwd);
    }
    let staged =
        git_output_for_paths(cwd, &["diff", "--unified=1", "--cached"], paths).unwrap_or_default();
    let unstaged = git_output_for_paths(cwd, &["diff", "--unified=1"], paths).unwrap_or_default();
    [staged, unstaged]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn create_git_commit_dry_run(
    message: &str,
    files: &[GitCommitFilePreview],
    selected_only: bool,
) -> FileDryRunSummary {
    let scope = if selected_only {
        "selected paths"
    } else {
        "the current workspace"
    };
    FileDryRunSummary {
        operation: if selected_only {
            "Preview Git commit selected files".to_string()
        } else {
            "Preview Git commit".to_string()
        },
        affected_paths: files
            .iter()
            .map(|file| PlannedPathOperation {
                source: file.path.clone(),
                target: file.path.clone(),
                action: file.action.clone(),
                conflict: None,
            })
            .collect(),
        risk_summary: format!(
            "Preview only. No Git write was executed. A future commit would stage and commit {} changed file(s) from {scope} with message \"{}\".",
            files.len(),
            message
        ),
        reversible: false,
    }
}

fn create_pending_git_commit_approval(
    approval_id: &str,
    task_id: Option<&str>,
    preview: &GitCommitPreview,
) -> Result<PendingGitCommitApproval, String> {
    Ok(PendingGitCommitApproval {
        binding: create_native_approval_binding(
            approval_id.to_string(),
            GIT_COMMIT_APPROVAL_TOOL_NAME,
            task_id.unwrap_or_default().trim().to_string(),
            create_git_commit_preview_hash(preview),
            false,
        ),
    })
}

fn store_pending_git_commit_approval(
    approval_state: &Mutex<GitCommitApprovalState>,
    approval: PendingGitCommitApproval,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git commit approval state could not be locked.".to_string())?;
    state.pending = Some(approval);
    Ok(())
}

fn approve_pending_git_commit(
    approval_state: &Mutex<GitCommitApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git commit approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_mut() else {
        return Err("No pending Git commit approval exists.".to_string());
    };
    let preview_hash = pending.binding.preview_hash.clone();
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        GIT_COMMIT_APPROVAL_TOOL_NAME,
        task_id,
        &preview_hash,
        "Git commit approval id does not match the pending dry-run.",
    )
}

fn take_approved_git_commit(
    approval_state: &Mutex<GitCommitApprovalState>,
    request: &ExecuteGitCommitRequest,
    current_preview: &GitCommitPreview,
) -> Result<PendingGitCommitApproval, String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git commit approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_ref() else {
        return Err("No approved Git commit dry-run is pending.".to_string());
    };
    let preview_hash = create_git_commit_preview_hash(current_preview);
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        GIT_COMMIT_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &preview_hash,
        "Git commit approval id does not match the pending dry-run.",
        "Git commit dry-run has not been approved.",
    )
    .map_err(|error| error.to_string())?;

    state
        .pending
        .take()
        .ok_or_else(|| "No approved Git commit dry-run is pending.".to_string())
}

fn execute_git_commit_in_workspace(
    cwd: &Path,
    request: &ExecuteGitCommitRequest,
    approval_state: &Mutex<GitCommitApprovalState>,
) -> Result<GitCommitExecutionResult, String> {
    let preview = build_git_commit_preview_for_paths(
        cwd,
        request.session_id.clone(),
        &request.message,
        &request.paths,
    )?;
    let file_count = preview.files.len();
    let selected_paths = preview
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    require_git_workspace_write_backend(cwd, &["commit"])?;
    take_approved_git_commit(approval_state, request, &preview)?;
    let output = if request.paths.is_empty() {
        run_sandboxed_git_command(
            cwd,
            &["add", "-A", "--", "."],
            workspace_write_policy(cwd, vec![cwd.to_path_buf()]),
            None,
        )?;
        run_sandboxed_git_command(
            cwd,
            &["commit", "-m", &preview.message],
            workspace_write_policy(cwd, vec![cwd.to_path_buf()]),
            None,
        )?
    } else {
        let mut add_args: Vec<&str> = vec!["add", "--"];
        add_args.extend(selected_paths.iter().map(|p| p.as_str()));
        let mut commit_args: Vec<&str> = vec!["commit", "-m", &preview.message, "--"];
        commit_args.extend(selected_paths.iter().map(|p| p.as_str()));
        run_sandboxed_git_command(
            cwd,
            &add_args,
            workspace_write_policy(cwd, vec![cwd.to_path_buf()]),
            None,
        )?;
        run_sandboxed_git_command(
            cwd,
            &commit_args,
            workspace_write_policy(cwd, vec![cwd.to_path_buf()]),
            None,
        )?
    };
    let commit_hash = git_output(cwd, &["rev-parse", "HEAD"])?;
    let subject =
        git_output(cwd, &["log", "-1", "--format=%s"]).unwrap_or_else(|_| preview.message.clone());

    Ok(GitCommitExecutionResult {
        session_id: request.session_id.clone(),
        workspace_root: normalize_path(cwd),
        branch: preview.branch,
        commit_hash,
        subject,
        file_count,
        committed: true,
        output,
    })
}

fn restore_git_commit_approval_in_workspace(
    cwd: &Path,
    request: &RestoreGitCommitApprovalRequest,
    approval_state: &Mutex<GitCommitApprovalState>,
) -> Result<(), String> {
    let current_preview =
        build_git_commit_preview(cwd, request.session_id.clone(), &request.preview.message)?;
    if create_git_commit_preview_hash(&current_preview)
        != create_git_commit_restore_preview_hash(&request.preview)
    {
        return Err(
            "Restored Git commit preview no longer matches the current repository state."
                .to_string(),
        );
    }
    let pending = create_pending_git_commit_approval(
        &request.approval_id,
        request.task_id.as_deref(),
        &current_preview,
    )?;
    store_pending_git_commit_approval(approval_state, pending)
}

fn create_git_commit_preview_hash(preview: &GitCommitPreview) -> String {
    let file_fingerprints = preview
        .files
        .iter()
        .map(create_git_commit_file_fingerprint)
        .collect::<Vec<_>>()
        .join("\n");
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            preview.workspace_root,
            preview.branch.as_deref().unwrap_or(""),
            preview.message,
            preview.diff,
            file_fingerprints
        )
        .as_bytes(),
    )
}

fn create_git_commit_restore_preview_hash(preview: &GitCommitRestorePreview) -> String {
    let file_fingerprints = preview
        .files
        .iter()
        .map(create_git_commit_restore_file_fingerprint)
        .collect::<Vec<_>>()
        .join("\n");
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            preview.workspace_root,
            preview.branch.as_deref().unwrap_or(""),
            preview.message,
            preview.diff,
            file_fingerprints
        )
        .as_bytes(),
    )
}

fn create_git_commit_file_fingerprint(file: &GitCommitFilePreview) -> String {
    let path = normalized_commit_status_path(&file.path);
    format!(
        "{}\t{}\t{}\t{}\t{}",
        file.index_status, file.worktree_status, file.action, path, file.content_hash
    )
}

fn create_git_commit_restore_file_fingerprint(file: &GitCommitRestoreFilePreview) -> String {
    let path = normalized_commit_status_path(&file.path);
    format!(
        "{}\t{}\t{}\t{}\t{}",
        file.index_status, file.worktree_status, file.action, path, file.content_hash
    )
}

fn create_git_commit_file_content_hash(cwd: &Path, path: &str) -> Result<String, String> {
    let path = normalized_commit_status_path(path);
    let full_path = cwd.join(&path);
    if full_path.is_file() {
        git_output(cwd, &["hash-object", "--", path.as_str()])
    } else if full_path.exists() {
        Ok("non-file".to_string())
    } else {
        Ok("missing".to_string())
    }
}

fn normalized_commit_status_path(path: &str) -> String {
    path.split(" -> ")
        .last()
        .unwrap_or(path)
        .trim_matches('"')
        .to_string()
}

fn build_git_push_preview(cwd: &Path, session_id: String) -> Result<GitPushPreview, String> {
    let branch = git_output(cwd, &["branch", "--show-current"])
        .ok()
        .and_then(non_empty_git_value)
        .ok_or_else(|| "Git push preview requires a named local branch.".to_string())?;
    let upstream = git_output(
        cwd,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .ok()
    .and_then(non_empty_git_value)
    .ok_or_else(|| "Git push preview requires an upstream branch.".to_string())?;
    let (remote_name, remote_branch) = split_upstream(&upstream)
        .ok_or_else(|| "Git push preview could not determine the upstream remote.".to_string())?;
    let remotes = git_output(cwd, &["remote", "-v"])
        .map(|value| parse_remote_verbose(&value))
        .unwrap_or_default();
    let remote_url = remotes
        .iter()
        .find(|remote| remote.name == remote_name)
        .and_then(|remote| remote.push_url.clone().or_else(|| remote.fetch_url.clone()));
    let (ahead, behind) = git_output(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{u}"])
        .ok()
        .and_then(|value| parse_ahead_behind(&value))
        .unwrap_or((0, 0));
    let commits = if ahead == 0 {
        Vec::new()
    } else {
        git_output(cwd, &["log", "--format=%H%x09%s", "@{u}..HEAD"])
            .map(|value| parse_push_commits(&value))
            .unwrap_or_default()
    };
    let dry_run = create_git_push_dry_run(
        &branch,
        &upstream,
        remote_url.as_deref(),
        ahead,
        behind,
        commits.len(),
    );

    Ok(GitPushPreview {
        session_id,
        workspace_root: normalize_path(cwd),
        branch,
        upstream,
        remote_name,
        remote_branch,
        remote_url,
        ahead,
        behind,
        commits,
        dry_run,
    })
}

fn ensure_git_push_supported(preview: &GitPushPreview) -> Result<(), String> {
    if is_protected_push_branch(&preview.branch) {
        return Err("Git push is disabled for protected branches in v1.".to_string());
    }
    if preview.remote_url.is_none() {
        return Err("Git push preview requires a configured push remote.".to_string());
    }
    if preview.ahead == 0 {
        return Err("Git push preview found no local commits to push.".to_string());
    }
    if preview.behind > 0 {
        return Err(
            "Git push is disabled while the local branch is behind its upstream.".to_string(),
        );
    }
    Ok(())
}

fn is_protected_push_branch(branch: &str) -> bool {
    let normalized = branch.trim().to_ascii_lowercase();
    matches!(normalized.as_str(), "main" | "master" | "trunk") || normalized.starts_with("release/")
}

fn create_pending_git_push_approval(
    approval_id: &str,
    task_id: Option<&str>,
    preview: &GitPushPreview,
) -> PendingGitPushApproval {
    PendingGitPushApproval {
        binding: create_native_approval_binding(
            approval_id.to_string(),
            GIT_PUSH_APPROVAL_TOOL_NAME,
            task_id.unwrap_or_default().trim().to_string(),
            create_git_push_preview_hash(preview),
            false,
        ),
    }
}

fn store_pending_git_push_approval(
    approval_state: &Mutex<GitPushApprovalState>,
    approval: PendingGitPushApproval,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git push approval state could not be locked.".to_string())?;
    state.pending = Some(approval);
    Ok(())
}

fn approve_pending_git_push(
    approval_state: &Mutex<GitPushApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git push approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_mut() else {
        return Err("No pending Git push approval exists.".to_string());
    };
    let preview_hash = pending.binding.preview_hash.clone();
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        GIT_PUSH_APPROVAL_TOOL_NAME,
        task_id,
        &preview_hash,
        "Git push approval id does not match the pending dry-run.",
    )
}

fn take_approved_git_push(
    approval_state: &Mutex<GitPushApprovalState>,
    request: &ExecuteGitPushRequest,
    current_preview: &GitPushPreview,
) -> Result<PendingGitPushApproval, String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git push approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_ref() else {
        return Err("No approved Git push dry-run is pending.".to_string());
    };
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        GIT_PUSH_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &create_git_push_preview_hash(current_preview),
        "Git push approval id does not match the pending dry-run.",
        "Git push dry-run has not been approved.",
    )
    .map_err(|error| error.to_string())?;

    state
        .pending
        .take()
        .ok_or_else(|| "No approved Git push dry-run is pending.".to_string())
}

fn execute_git_push_in_workspace(
    cwd: &Path,
    request: &ExecuteGitPushRequest,
    approval_state: &Mutex<GitPushApprovalState>,
) -> Result<GitPushExecutionResult, String> {
    let preview = build_git_push_preview(cwd, request.session_id.clone())?;
    ensure_git_push_supported(&preview)?;
    let commit_count = preview.commits.len();
    require_git_network_backend(cwd, &["push"])?;
    take_approved_git_push(approval_state, request, &preview)?;
    let refspec = format!("HEAD:refs/heads/{}", preview.remote_branch);
    let mut push_policy = workspace_write_policy(cwd, vec![cwd.to_path_buf()]);
    push_policy.network_access = true;
    let output = run_sandboxed_git_command(
        cwd,
        &["push", "--porcelain", &preview.remote_name, &refspec],
        push_policy,
        None,
    )?;

    Ok(GitPushExecutionResult {
        session_id: request.session_id.clone(),
        workspace_root: normalize_path(cwd),
        branch: preview.branch,
        upstream: preview.upstream,
        remote_name: preview.remote_name,
        remote_branch: preview.remote_branch,
        commit_count,
        pushed: true,
        output,
    })
}

fn restore_git_push_approval_in_workspace(
    cwd: &Path,
    request: &RestoreGitPushApprovalRequest,
    approval_state: &Mutex<GitPushApprovalState>,
) -> Result<(), String> {
    let current_preview = build_git_push_preview(cwd, request.session_id.clone())?;
    ensure_git_push_supported(&current_preview)?;
    if create_git_push_preview_hash(&current_preview)
        != create_git_push_restore_preview_hash(cwd, &request.preview)
    {
        return Err(
            "Restored Git push preview no longer matches the current repository state.".to_string(),
        );
    }
    let pending = create_pending_git_push_approval(
        &request.approval_id,
        request.task_id.as_deref(),
        &current_preview,
    );
    store_pending_git_push_approval(approval_state, pending)
}

fn restore_git_create_pull_request_approval_in_workspace(
    cwd: &Path,
    request: &RestoreGitCreatePullRequestApprovalRequest,
    approval_state: &Mutex<GitCreatePullRequestApprovalState>,
) -> Result<(), String> {
    let current_preview = build_git_create_pull_request_preview(
        cwd,
        request.session_id.clone(),
        &request.preview.title,
        &request.preview.body,
        &request.preview.base_branch,
        request.preview.draft,
    )?;
    if create_git_create_pull_request_preview_hash(&current_preview)
        != create_git_create_pull_request_restore_preview_hash(&request.preview)
    {
        return Err(
            "Restored Git pull request preview no longer matches the current repository state."
                .to_string(),
        );
    }
    let pending = create_pending_git_create_pull_request_approval(
        &request.approval_id,
        request.task_id.as_deref(),
        &current_preview,
    );
    store_pending_git_create_pull_request_approval(approval_state, pending)
}

fn restore_git_comment_pull_request_approval_in_workspace(
    cwd: &Path,
    request: &RestoreGitCommentPullRequestApprovalRequest,
    approval_state: &Mutex<GitCommentPullRequestApprovalState>,
) -> Result<(), String> {
    let current_preview = build_git_comment_pull_request_preview(
        cwd,
        request.session_id.clone(),
        &request.preview.pull_request,
        &request.preview.body,
    )?;
    if create_git_comment_pull_request_preview_hash(&current_preview)
        != create_git_comment_pull_request_restore_preview_hash(&request.preview)
    {
        return Err(
            "Restored Git pull request comment preview no longer matches the current repository state."
                .to_string(),
        );
    }
    let pending = create_pending_git_comment_pull_request_approval(
        &request.approval_id,
        request.task_id.as_deref(),
        &current_preview,
    );
    store_pending_git_comment_pull_request_approval(approval_state, pending)
}

fn build_git_create_pull_request_preview(
    cwd: &Path,
    session_id: String,
    title: &str,
    body: &str,
    base_branch: &str,
    draft: bool,
) -> Result<GitCreatePullRequestPreview, String> {
    ensure_github_cli_available(cwd)?;
    let title = sanitize_pull_request_title(title)?;
    let body = sanitize_pull_request_body(body)?;
    let base_branch = sanitize_pull_request_branch(base_branch, "base branch")?;
    let head_branch = git_output(cwd, &["branch", "--show-current"])
        .ok()
        .and_then(non_empty_git_value)
        .ok_or_else(|| "Git pull request preview requires a named local branch.".to_string())?;
    if head_branch == base_branch {
        return Err(
            "Git pull request base branch must differ from the current branch.".to_string(),
        );
    }
    let head_commit = git_output(cwd, &["rev-parse", "HEAD"])?;
    let remotes = git_output(cwd, &["remote", "-v"])
        .map(|value| parse_remote_verbose(&value))
        .unwrap_or_default();
    let (remote_name, remote_url) = select_pull_request_remote(&remotes);
    let dry_run = create_git_create_pull_request_dry_run(
        &title,
        &base_branch,
        &head_branch,
        &head_commit,
        remote_url.as_deref(),
        draft,
    );

    Ok(GitCreatePullRequestPreview {
        session_id,
        workspace_root: normalize_path(cwd),
        provider: "github-cli".to_string(),
        title,
        body,
        base_branch,
        head_branch,
        head_commit,
        remote_name,
        remote_url,
        draft,
        dry_run,
    })
}

fn ensure_github_cli_available(cwd: &Path) -> Result<PathBuf, String> {
    resolve_program_from_path(&resolve_command_program("gh"), Some(cwd))
        .ok_or_else(|| "GitHub CLI (gh) was not found on trusted PATH.".to_string())
}

fn sanitize_pull_request_title(title: &str) -> Result<String, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err("Git pull request title is required.".to_string());
    }
    if trimmed.chars().count() > 200 {
        return Err("Git pull request title must be 200 characters or fewer.".to_string());
    }
    Ok(trimmed.to_string())
}

fn sanitize_pull_request_body(body: &str) -> Result<String, String> {
    let trimmed = body.trim();
    if trimmed.chars().count() > 10_000 {
        return Err("Git pull request body must be 10000 characters or fewer.".to_string());
    }
    Ok(trimmed.to_string())
}

fn sanitize_pull_request_branch(branch: &str, label: &str) -> Result<String, String> {
    let trimmed = branch.trim();
    if trimmed.is_empty() {
        return Err(format!("Git pull request {label} is required."));
    }
    if trimmed.starts_with('-')
        || trimmed.contains('\0')
        || trimmed.contains(' ')
        || trimmed.contains("..")
        || trimmed.contains('\\')
        || trimmed.ends_with('/')
    {
        return Err(format!(
            "Git pull request {label} must be a simple branch name."
        ));
    }
    Ok(trimmed.to_string())
}

fn select_pull_request_remote(remotes: &[GitRemoteInfo]) -> (Option<String>, Option<String>) {
    remotes
        .iter()
        .find(|remote| remote.name == "origin")
        .or_else(|| remotes.first())
        .map(|remote| {
            (
                Some(remote.name.clone()),
                remote.push_url.clone().or_else(|| remote.fetch_url.clone()),
            )
        })
        .unwrap_or((None, None))
}

fn create_git_create_pull_request_dry_run(
    title: &str,
    base_branch: &str,
    head_branch: &str,
    head_commit: &str,
    remote_url: Option<&str>,
    draft: bool,
) -> FileDryRunSummary {
    FileDryRunSummary {
        operation: "Preview GitHub pull request creation".to_string(),
        affected_paths: vec![PlannedPathOperation {
            source: head_branch.to_string(),
            target: remote_url
                .map(|url| format!("{base_branch} ({url})"))
                .unwrap_or_else(|| base_branch.to_string()),
            action: "create_pr".to_string(),
            conflict: None,
        }],
        risk_summary: format!(
            "Preview only. No remote write was executed. A future GitHub CLI call would create a {}pull request \"{}\" from {} at {} into {}.",
            if draft { "draft " } else { "" },
            title,
            head_branch,
            head_commit.chars().take(12).collect::<String>(),
            base_branch
        ),
        reversible: false,
    }
}

fn create_pending_git_create_pull_request_approval(
    approval_id: &str,
    task_id: Option<&str>,
    preview: &GitCreatePullRequestPreview,
) -> PendingGitCreatePullRequestApproval {
    PendingGitCreatePullRequestApproval {
        binding: create_native_approval_binding(
            approval_id.to_string(),
            GIT_CREATE_PR_APPROVAL_TOOL_NAME,
            task_id.unwrap_or_default().trim().to_string(),
            create_git_create_pull_request_preview_hash(preview),
            false,
        ),
    }
}

fn store_pending_git_create_pull_request_approval(
    approval_state: &Mutex<GitCreatePullRequestApprovalState>,
    approval: PendingGitCreatePullRequestApproval,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git pull request approval state could not be locked.".to_string())?;
    state.pending = Some(approval);
    Ok(())
}

fn approve_pending_git_create_pull_request(
    approval_state: &Mutex<GitCreatePullRequestApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git pull request approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_mut() else {
        return Err("No pending Git pull request approval exists.".to_string());
    };
    let preview_hash = pending.binding.preview_hash.clone();
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        GIT_CREATE_PR_APPROVAL_TOOL_NAME,
        task_id,
        &preview_hash,
        "Git pull request approval id does not match the pending dry-run.",
    )
}

fn take_approved_git_create_pull_request(
    approval_state: &Mutex<GitCreatePullRequestApprovalState>,
    request: &ExecuteGitCreatePullRequestRequest,
    current_preview: &GitCreatePullRequestPreview,
) -> Result<PendingGitCreatePullRequestApproval, String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git pull request approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_ref() else {
        return Err("No approved Git pull request dry-run is pending.".to_string());
    };
    let preview_hash = create_git_create_pull_request_preview_hash(current_preview);
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        GIT_CREATE_PR_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &preview_hash,
        "Git pull request approval id does not match the pending dry-run.",
        "Git pull request dry-run has not been approved.",
    )
    .map_err(|error| error.to_string())?;

    state
        .pending
        .take()
        .ok_or_else(|| "No approved Git pull request dry-run is pending.".to_string())
}

fn execute_git_create_pull_request_in_workspace(
    cwd: &Path,
    request: &ExecuteGitCreatePullRequestRequest,
    approval_state: &Mutex<GitCreatePullRequestApprovalState>,
) -> Result<GitCreatePullRequestExecutionResult, String> {
    let preview = build_git_create_pull_request_preview(
        cwd,
        request.session_id.clone(),
        &request.title,
        &request.body,
        &request.base_branch,
        request.draft.unwrap_or(true),
    )?;
    require_gh_network_backend(cwd, &["pr", "create"])?;
    take_approved_git_create_pull_request(approval_state, request, &preview)?;
    let mut args: Vec<&str> = vec![
        "pr",
        "create",
        "--title",
        &preview.title,
        "--body",
        &preview.body,
        "--base",
        &preview.base_branch,
        "--head",
        &preview.head_branch,
    ];
    if preview.draft {
        args.push("--draft");
    }
    let stdout = run_sandboxed_gh_command(cwd, &args, None).map_err(|error| {
        format!(
            "GitHub CLI could not create pull request: {}",
            truncate_git_message(&error)
        )
    })?;
    let url = extract_first_url(&stdout)
        .ok_or_else(|| "GitHub CLI did not return a pull request URL.".to_string())?;
    Ok(GitCreatePullRequestExecutionResult {
        session_id: request.session_id.clone(),
        workspace_root: normalize_path(cwd),
        provider: "github-cli".to_string(),
        url,
        title: preview.title,
        base_branch: preview.base_branch,
        head_branch: preview.head_branch,
        draft: preview.draft,
        created: true,
        output: stdout,
    })
}

fn create_git_create_pull_request_preview_hash(preview: &GitCreatePullRequestPreview) -> String {
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            preview.workspace_root,
            preview.provider,
            preview.title,
            preview.body,
            preview.base_branch,
            preview.head_branch,
            preview.head_commit,
            preview.remote_url.as_deref().unwrap_or(""),
            preview.draft
        )
        .as_bytes(),
    )
}

fn create_git_create_pull_request_restore_preview_hash(
    preview: &GitCreatePullRequestRestorePreview,
) -> String {
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            preview.workspace_root,
            preview.provider,
            preview.title,
            preview.body,
            preview.base_branch,
            preview.head_branch,
            preview.head_commit,
            preview.remote_url.as_deref().unwrap_or(""),
            preview.draft
        )
        .as_bytes(),
    )
}

fn build_git_comment_pull_request_preview(
    cwd: &Path,
    session_id: String,
    pull_request: &str,
    body: &str,
) -> Result<GitCommentPullRequestPreview, String> {
    ensure_github_cli_available(cwd)?;
    let pull_request = sanitize_pull_request_comment_target(pull_request)?;
    let body = sanitize_pull_request_comment_body(body)?;
    let remotes = git_output(cwd, &["remote", "-v"])
        .map(|value| parse_remote_verbose(&value))
        .unwrap_or_default();
    let (_, remote_url) = select_pull_request_remote(&remotes);
    let dry_run =
        create_git_comment_pull_request_dry_run(&pull_request, &body, remote_url.as_deref());

    Ok(GitCommentPullRequestPreview {
        session_id,
        workspace_root: normalize_path(cwd),
        provider: "github-cli".to_string(),
        pull_request,
        body,
        remote_url,
        dry_run,
    })
}

fn sanitize_pull_request_comment_target(pull_request: &str) -> Result<String, String> {
    let trimmed = pull_request.trim();
    if trimmed.is_empty() {
        return Err("Git pull request comment target is required.".to_string());
    }
    if trimmed.chars().count() > 200 || trimmed.contains('\0') || trimmed.contains('\n') {
        return Err(
            "Git pull request comment target must be a single line up to 200 characters."
                .to_string(),
        );
    }
    if trimmed.starts_with('-') {
        return Err("Git pull request comment target must not start with '-'.".to_string());
    }
    Ok(trimmed.to_string())
}

fn sanitize_pull_request_comment_body(body: &str) -> Result<String, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Git pull request comment body is required.".to_string());
    }
    if trimmed.chars().count() > 10_000 {
        return Err("Git pull request comment body must be 10000 characters or fewer.".to_string());
    }
    Ok(trimmed.to_string())
}

fn create_git_comment_pull_request_dry_run(
    pull_request: &str,
    body: &str,
    remote_url: Option<&str>,
) -> FileDryRunSummary {
    FileDryRunSummary {
        operation: "Preview GitHub pull request comment".to_string(),
        affected_paths: vec![PlannedPathOperation {
            source: pull_request.to_string(),
            target: remote_url.unwrap_or("GitHub pull request").to_string(),
            action: "comment_pr".to_string(),
            conflict: None,
        }],
        risk_summary: format!(
            "Preview only. No remote write was executed. A future GitHub CLI call would post a {} character comment to pull request {}.",
            body.chars().count(),
            pull_request
        ),
        reversible: false,
    }
}

fn create_pending_git_comment_pull_request_approval(
    approval_id: &str,
    task_id: Option<&str>,
    preview: &GitCommentPullRequestPreview,
) -> PendingGitCommentPullRequestApproval {
    PendingGitCommentPullRequestApproval {
        binding: create_native_approval_binding(
            approval_id.to_string(),
            GIT_COMMENT_PR_APPROVAL_TOOL_NAME,
            task_id.unwrap_or_default().trim().to_string(),
            create_git_comment_pull_request_preview_hash(preview),
            false,
        ),
    }
}

fn store_pending_git_comment_pull_request_approval(
    approval_state: &Mutex<GitCommentPullRequestApprovalState>,
    approval: PendingGitCommentPullRequestApproval,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git pull request comment approval state could not be locked.".to_string())?;
    state.pending = Some(approval);
    Ok(())
}

fn approve_pending_git_comment_pull_request(
    approval_state: &Mutex<GitCommentPullRequestApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git pull request comment approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_mut() else {
        return Err("No pending Git pull request comment approval exists.".to_string());
    };
    let preview_hash = pending.binding.preview_hash.clone();
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        GIT_COMMENT_PR_APPROVAL_TOOL_NAME,
        task_id,
        &preview_hash,
        "Git pull request comment approval id does not match the pending dry-run.",
    )
}

fn take_approved_git_comment_pull_request(
    approval_state: &Mutex<GitCommentPullRequestApprovalState>,
    request: &ExecuteGitCommentPullRequestRequest,
    current_preview: &GitCommentPullRequestPreview,
) -> Result<PendingGitCommentPullRequestApproval, String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Git pull request comment approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_ref() else {
        return Err("No approved Git pull request comment dry-run is pending.".to_string());
    };
    let preview_hash = create_git_comment_pull_request_preview_hash(current_preview);
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        GIT_COMMENT_PR_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &preview_hash,
        "Git pull request comment approval id does not match the pending dry-run.",
        "Git pull request comment dry-run has not been approved.",
    )
    .map_err(|error| error.to_string())?;

    state
        .pending
        .take()
        .ok_or_else(|| "No approved Git pull request comment dry-run is pending.".to_string())
}

fn execute_git_comment_pull_request_in_workspace(
    cwd: &Path,
    request: &ExecuteGitCommentPullRequestRequest,
    approval_state: &Mutex<GitCommentPullRequestApprovalState>,
) -> Result<GitCommentPullRequestExecutionResult, String> {
    let preview = build_git_comment_pull_request_preview(
        cwd,
        request.session_id.clone(),
        &request.pull_request,
        &request.body,
    )?;
    require_gh_network_backend(cwd, &["pr", "comment"])?;
    take_approved_git_comment_pull_request(approval_state, request, &preview)?;
    let stdout = run_sandboxed_gh_command(
        cwd,
        &[
            "pr",
            "comment",
            preview.pull_request.as_str(),
            "--body",
            preview.body.as_str(),
        ],
        None,
    )
    .map_err(|error| {
        format!(
            "GitHub CLI could not comment on pull request: {}",
            truncate_git_message(&error)
        )
    })?;
    Ok(GitCommentPullRequestExecutionResult {
        session_id: request.session_id.clone(),
        workspace_root: normalize_path(cwd),
        provider: "github-cli".to_string(),
        pull_request: preview.pull_request,
        commented: true,
        output: stdout,
    })
}

fn create_git_comment_pull_request_preview_hash(preview: &GitCommentPullRequestPreview) -> String {
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            preview.workspace_root,
            preview.provider,
            preview.pull_request,
            preview.body,
            preview.remote_url.as_deref().unwrap_or("")
        )
        .as_bytes(),
    )
}

fn create_git_comment_pull_request_restore_preview_hash(
    preview: &GitCommentPullRequestRestorePreview,
) -> String {
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}\n{}",
            preview.workspace_root,
            preview.provider,
            preview.pull_request,
            preview.body,
            preview.remote_url.as_deref().unwrap_or("")
        )
        .as_bytes(),
    )
}

fn extract_first_url(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|part| part.starts_with("https://") || part.starts_with("http://"))
        .map(|part| {
            part.trim_matches(|ch: char| ch == '"' || ch == '\'' || ch == ',')
                .to_string()
        })
        .filter(|part| !part.is_empty())
}

fn create_git_push_preview_hash(preview: &GitPushPreview) -> String {
    let commit_hashes = preview
        .commits
        .iter()
        .map(|commit| commit.hash.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            preview.workspace_root,
            preview.branch,
            preview.upstream,
            preview.remote_name,
            preview.remote_branch,
            preview.remote_url.as_deref().unwrap_or(""),
            preview.ahead,
            preview.behind,
            commit_hashes
        )
        .as_bytes(),
    )
}

fn create_git_push_restore_preview_hash(cwd: &Path, preview: &GitPushRestorePreview) -> String {
    let commit_hashes = preview
        .commits
        .iter()
        .map(|commit| commit.hash.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
            normalize_path(cwd),
            preview.branch,
            preview.upstream,
            preview.remote_name,
            preview.remote_branch,
            preview.remote_url.as_deref().unwrap_or(""),
            preview.ahead,
            preview.behind,
            commit_hashes
        )
        .as_bytes(),
    )
}

fn non_empty_git_value(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn parse_ahead_behind(output: &str) -> Option<(u32, u32)> {
    let mut parts = output.split_whitespace();
    let ahead = parts.next()?.parse::<u32>().ok()?;
    let behind = parts.next()?.parse::<u32>().ok()?;
    Some((ahead, behind))
}

fn split_upstream(upstream: &str) -> Option<(String, String)> {
    let (remote, branch) = upstream.split_once('/')?;
    if remote.trim().is_empty() || branch.trim().is_empty() {
        return None;
    }
    Some((remote.to_string(), branch.to_string()))
}

fn parse_push_commits(output: &str) -> Vec<GitPushCommitPreview> {
    output
        .lines()
        .filter_map(|line| {
            let (hash, subject) = line.split_once('\t')?;
            let hash = hash.trim();
            if hash.is_empty() {
                return None;
            }
            Some(GitPushCommitPreview {
                hash: hash.to_string(),
                subject: subject.trim().to_string(),
            })
        })
        .collect()
}

fn create_git_push_dry_run(
    branch: &str,
    upstream: &str,
    remote_url: Option<&str>,
    ahead: u32,
    behind: u32,
    commit_count: usize,
) -> FileDryRunSummary {
    FileDryRunSummary {
        operation: "Preview Git push".to_string(),
        affected_paths: vec![PlannedPathOperation {
            source: branch.to_string(),
            target: remote_url
                .map(|url| format!("{upstream} ({url})"))
                .unwrap_or_else(|| upstream.to_string()),
            action: "push".to_string(),
            conflict: (behind > 0).then(|| {
                "Remote has commits not present locally; pushing may require pull/rebase first."
                    .to_string()
            }),
        }],
        risk_summary: format!(
            "Preview only. No Git write was executed. A future push would send {commit_count} local commit(s); branch is ahead {ahead} and behind {behind}."
        ),
        reversible: false,
    }
}

fn parse_remote_verbose(output: &str) -> Vec<GitRemoteInfo> {
    let mut remotes = BTreeMap::<String, GitRemoteInfo>::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else {
            continue;
        };
        let Some(url) = parts.next() else {
            continue;
        };
        let direction = parts.next().unwrap_or_default();
        let entry = remotes
            .entry(name.to_string())
            .or_insert_with(|| GitRemoteInfo {
                name: name.to_string(),
                fetch_url: None,
                push_url: None,
            });
        match direction {
            "(fetch)" => entry.fetch_url = Some(url.to_string()),
            "(push)" => entry.push_url = Some(url.to_string()),
            _ => {}
        }
    }
    remotes.into_values().collect()
}

fn unavailable_pull_requests_snapshot(
    session_id: String,
    workspace_root: String,
    reason: &str,
) -> GitPullRequestsSnapshot {
    GitPullRequestsSnapshot {
        session_id,
        workspace_root,
        provider: "github-cli".to_string(),
        unavailable_reason: Some(reason.to_string()),
        pull_requests: Vec::new(),
    }
}

fn parse_gh_pull_requests(output: &str) -> Result<Vec<GitPullRequestSummary>, String> {
    let pull_requests: Vec<GhPullRequestSummary> = serde_json::from_str(output)
        .map_err(|error| format!("GitHub CLI returned invalid pull request JSON: {error}"))?;
    Ok(pull_requests
        .into_iter()
        .filter_map(|pull_request| {
            let number = pull_request.number?;
            let title = non_empty_option(pull_request.title)?;
            let url = non_empty_option(pull_request.url)?;
            Some(GitPullRequestSummary {
                number,
                title,
                state: non_empty_option(pull_request.state)
                    .unwrap_or_else(|| "UNKNOWN".to_string()),
                url,
                author: pull_request
                    .author
                    .and_then(|author| non_empty_option(author.login)),
                head_ref_name: pull_request.head_ref_name.and_then(non_empty_value),
                base_ref_name: pull_request.base_ref_name.and_then(non_empty_value),
                updated_at: pull_request.updated_at.and_then(non_empty_value),
            })
        })
        .collect())
}

fn non_empty_option(value: Option<String>) -> Option<String> {
    value.and_then(non_empty_value)
}

fn non_empty_value(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn truncate_git_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "no diagnostic output".to_string();
    }
    const MAX_MESSAGE_LEN: usize = 500;
    if trimmed.chars().count() <= MAX_MESSAGE_LEN {
        trimmed.to_string()
    } else {
        format!(
            "{}...",
            trimmed.chars().take(MAX_MESSAGE_LEN).collect::<String>()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::Mutex};

    #[test]
    fn parses_short_status() {
        let files = parse_status(" M apps/main.ts\nA  README.md\n?? docs/plan.md");
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "apps/main.ts");
        assert_eq!(files[0].worktree_status, "M");
        assert_eq!(files[2].index_status, "?");
    }

    #[test]
    fn hardens_git_diff_invocations() {
        assert_eq!(
            hardened_git_args(&["diff", "--unified=1", "--cached"]),
            vec![
                "-c",
                "core.fsmonitor=false",
                "-c",
                "diff.external=",
                "diff",
                "--unified=1",
                "--cached",
                "--no-ext-diff",
                "--no-textconv"
            ]
        );
    }

    #[test]
    fn parses_git_remote_verbose_output() {
        let remotes = parse_remote_verbose(
            "origin\thttps://example.com/repo.git (fetch)\norigin\thttps://example.com/repo.git (push)\nupstream\tgit@example.com:org/repo.git (fetch)\n",
        );

        assert_eq!(
            remotes,
            vec![
                GitRemoteInfo {
                    name: "origin".to_string(),
                    fetch_url: Some("https://example.com/repo.git".to_string()),
                    push_url: Some("https://example.com/repo.git".to_string()),
                },
                GitRemoteInfo {
                    name: "upstream".to_string(),
                    fetch_url: Some("git@example.com:org/repo.git".to_string()),
                    push_url: None,
                },
            ]
        );
    }

    #[test]
    fn parses_ahead_behind_counts() {
        assert_eq!(parse_ahead_behind("3\t1\n"), Some((3, 1)));
        assert_eq!(parse_ahead_behind("not-a-count"), None);
    }

    #[test]
    fn parses_upstream_remote_and_branch() {
        assert_eq!(
            split_upstream("origin/feature/git-preview"),
            Some(("origin".to_string(), "feature/git-preview".to_string()))
        );
        assert_eq!(split_upstream("main"), None);
    }

    #[test]
    fn parses_push_commit_preview_lines() {
        assert_eq!(
            parse_push_commits("abc123\tAdd git preview\nbad-line\nfed456\t\n"),
            vec![
                GitPushCommitPreview {
                    hash: "abc123".to_string(),
                    subject: "Add git preview".to_string(),
                },
                GitPushCommitPreview {
                    hash: "fed456".to_string(),
                    subject: "".to_string(),
                },
            ]
        );
    }

    #[test]
    fn parses_github_cli_pull_requests() {
        let pull_requests = parse_gh_pull_requests(
            r##"[
              {
                "number": 42,
                "title": "Add PR list",
                "state": "OPEN",
                "url": "https://github.com/acme/repo/pull/42",
                "author": { "login": "octocat" },
                "headRefName": "feature/pr-list",
                "baseRefName": "main",
                "updatedAt": "2026-06-09T10:00:00Z"
              },
              {
                "number": 43,
                "title": "Missing URL is skipped",
                "state": "OPEN",
                "url": "",
                "author": { "login": "octocat" }
              }
            ]"##,
        )
        .unwrap();

        assert_eq!(
            pull_requests,
            vec![GitPullRequestSummary {
                number: 42,
                title: "Add PR list".to_string(),
                state: "OPEN".to_string(),
                url: "https://github.com/acme/repo/pull/42".to_string(),
                author: Some("octocat".to_string()),
                head_ref_name: Some("feature/pr-list".to_string()),
                base_ref_name: Some("main".to_string()),
                updated_at: Some("2026-06-09T10:00:00Z".to_string()),
            }]
        );
    }

    #[test]
    fn github_cli_pull_request_parse_rejects_invalid_json() {
        let result = parse_gh_pull_requests("not json");

        assert!(result.unwrap_err().contains("invalid pull request JSON"));
    }

    #[test]
    fn git_create_pull_request_plan_rejects_empty_title() {
        let result = sanitize_pull_request_title("   ");

        assert_eq!(
            result,
            Err("Git pull request title is required.".to_string())
        );
    }

    #[test]
    fn git_create_pull_request_approval_rejects_task_id_mismatch() {
        let state = Mutex::new(GitCreatePullRequestApprovalState::default());
        let preview = fake_create_pull_request_preview("feature/pr", "abc123");
        store_pending_git_create_pull_request_approval(
            &state,
            create_pending_git_create_pull_request_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();

        let result = approve_pending_git_create_pull_request(&state, "approval-1", Some("task-b"));

        assert!(result
            .unwrap_err()
            .contains("Approval task id does not match"));
    }

    #[test]
    fn git_create_pull_request_execution_requires_approval() {
        let state = Mutex::new(GitCreatePullRequestApprovalState::default());
        let preview = fake_create_pull_request_preview("feature/pr", "abc123");
        store_pending_git_create_pull_request_approval(
            &state,
            create_pending_git_create_pull_request_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        let request = fake_execute_create_pull_request_request("approval-1", Some("task-a"));

        let result = take_approved_git_create_pull_request(&state, &request, &preview);

        assert!(result.unwrap_err().contains("has not been approved"));
    }

    #[test]
    fn git_create_pull_request_execution_rejects_stale_preview_hash() {
        let state = Mutex::new(GitCreatePullRequestApprovalState::default());
        let approved_preview = fake_create_pull_request_preview("feature/pr", "abc123");
        let changed_preview = fake_create_pull_request_preview("feature/pr", "def456");
        store_pending_git_create_pull_request_approval(
            &state,
            create_pending_git_create_pull_request_approval(
                "approval-1",
                Some("task-a"),
                &approved_preview,
            ),
        )
        .unwrap();
        approve_pending_git_create_pull_request(&state, "approval-1", Some("task-a")).unwrap();
        let request = fake_execute_create_pull_request_request("approval-1", Some("task-a"));

        let result = take_approved_git_create_pull_request(&state, &request, &changed_preview);

        assert!(result.unwrap_err().contains("preview hash"));
    }

    #[test]
    fn git_create_pull_request_restore_preview_hash_matches_full_preview() {
        let preview = fake_create_pull_request_preview("feature/pr", "abc123");
        let restore_preview = restore_preview_from_create_pull_request_preview(&preview);

        assert_eq!(
            create_git_create_pull_request_preview_hash(&preview),
            create_git_create_pull_request_restore_preview_hash(&restore_preview)
        );
    }

    #[test]
    fn git_create_pull_request_restore_preview_hash_rejects_changed_head_commit() {
        let preview = fake_create_pull_request_preview("feature/pr", "abc123");
        let mut restore_preview = restore_preview_from_create_pull_request_preview(&preview);
        restore_preview.head_commit = "def456".to_string();

        assert_ne!(
            create_git_create_pull_request_preview_hash(&preview),
            create_git_create_pull_request_restore_preview_hash(&restore_preview)
        );
    }

    #[test]
    fn git_comment_pull_request_plan_rejects_empty_body() {
        let result = sanitize_pull_request_comment_body("   ");

        assert_eq!(
            result,
            Err("Git pull request comment body is required.".to_string())
        );
    }

    #[test]
    fn git_comment_pull_request_plan_rejects_multiline_target() {
        let result = sanitize_pull_request_comment_target("12\n13");

        assert_eq!(
            result,
            Err(
                "Git pull request comment target must be a single line up to 200 characters."
                    .to_string()
            )
        );
    }

    #[test]
    fn git_comment_pull_request_dry_run_uses_comment_action() {
        let dry_run = create_git_comment_pull_request_dry_run(
            "12",
            "Looks good.",
            Some("https://github.com/acme/repo.git"),
        );

        assert_eq!(dry_run.operation, "Preview GitHub pull request comment");
        assert_eq!(dry_run.affected_paths[0].source, "12");
        assert_eq!(dry_run.affected_paths[0].action, "comment_pr");
        assert!(dry_run
            .risk_summary
            .contains("No remote write was executed"));
        assert!(!dry_run.reversible);
    }

    #[test]
    fn git_comment_pull_request_execution_requires_approval() {
        let state = Mutex::new(GitCommentPullRequestApprovalState::default());
        let preview = fake_comment_pull_request_preview("12", "Looks good.");
        store_pending_git_comment_pull_request_approval(
            &state,
            create_pending_git_comment_pull_request_approval(
                "approval-1",
                Some("task-a"),
                &preview,
            ),
        )
        .unwrap();
        let request = fake_execute_comment_pull_request_request("approval-1", Some("task-a"));

        let result = take_approved_git_comment_pull_request(&state, &request, &preview);

        assert!(result.unwrap_err().contains("has not been approved"));
    }

    #[test]
    fn git_comment_pull_request_execution_rejects_stale_preview_hash() {
        let state = Mutex::new(GitCommentPullRequestApprovalState::default());
        let approved_preview = fake_comment_pull_request_preview("12", "Looks good.");
        let changed_preview = fake_comment_pull_request_preview("12", "Changed comment.");
        store_pending_git_comment_pull_request_approval(
            &state,
            create_pending_git_comment_pull_request_approval(
                "approval-1",
                Some("task-a"),
                &approved_preview,
            ),
        )
        .unwrap();
        approve_pending_git_comment_pull_request(&state, "approval-1", Some("task-a")).unwrap();
        let request = fake_execute_comment_pull_request_request("approval-1", Some("task-a"));

        let result = take_approved_git_comment_pull_request(&state, &request, &changed_preview);

        assert!(result.unwrap_err().contains("preview hash"));
    }

    #[test]
    fn git_comment_pull_request_restore_preview_hash_matches_full_preview() {
        let preview = fake_comment_pull_request_preview("12", "Looks good.");
        let restore_preview = restore_preview_from_comment_pull_request_preview(&preview);

        assert_eq!(
            create_git_comment_pull_request_preview_hash(&preview),
            create_git_comment_pull_request_restore_preview_hash(&restore_preview)
        );
    }

    #[test]
    fn git_comment_pull_request_restore_preview_hash_rejects_changed_body() {
        let preview = fake_comment_pull_request_preview("12", "Looks good.");
        let mut restore_preview = restore_preview_from_comment_pull_request_preview(&preview);
        restore_preview.body = "Changed comment.".to_string();

        assert_ne!(
            create_git_comment_pull_request_preview_hash(&preview),
            create_git_comment_pull_request_restore_preview_hash(&restore_preview)
        );
    }

    #[test]
    fn git_push_dry_run_marks_behind_remote_as_conflict() {
        let dry_run = create_git_push_dry_run(
            "feature/git-preview",
            "origin/feature/git-preview",
            Some("https://example.com/repo.git"),
            2,
            1,
            2,
        );

        assert_eq!(dry_run.operation, "Preview Git push");
        assert_eq!(dry_run.affected_paths[0].action, "push");
        assert!(dry_run.affected_paths[0]
            .conflict
            .as_deref()
            .unwrap_or_default()
            .contains("Remote has commits"));
        assert!(dry_run.risk_summary.contains("No Git write was executed"));
        assert!(!dry_run.reversible);
    }

    #[test]
    fn git_push_plan_rejects_protected_branch() {
        let preview = fake_push_preview("main", 1, 0, &["abc123"]);

        let result = ensure_git_push_supported(&preview);

        assert_eq!(
            result,
            Err("Git push is disabled for protected branches in v1.".to_string())
        );
    }

    #[test]
    fn git_push_plan_rejects_no_ahead_commits() {
        let preview = fake_push_preview("feature/git-push", 0, 0, &[]);

        let result = ensure_git_push_supported(&preview);

        assert_eq!(
            result,
            Err("Git push preview found no local commits to push.".to_string())
        );
    }

    #[test]
    fn git_push_plan_rejects_behind_upstream() {
        let preview = fake_push_preview("feature/git-push", 1, 1, &["abc123"]);

        let result = ensure_git_push_supported(&preview);

        assert_eq!(
            result,
            Err("Git push is disabled while the local branch is behind its upstream.".to_string())
        );
    }

    #[test]
    fn git_push_approval_rejects_task_id_mismatch() {
        let state = Mutex::new(GitPushApprovalState::default());
        let preview = fake_push_preview("feature/git-push", 1, 0, &["abc123"]);
        store_pending_git_push_approval(
            &state,
            create_pending_git_push_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();

        let result = approve_pending_git_push(&state, "approval-1", Some("task-b"));

        assert!(result
            .unwrap_err()
            .contains("Approval task id does not match"));
    }

    #[test]
    fn git_push_execution_requires_approval() {
        let state = Mutex::new(GitPushApprovalState::default());
        let preview = fake_push_preview("feature/git-push", 1, 0, &["abc123"]);
        store_pending_git_push_approval(
            &state,
            create_pending_git_push_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        let request = fake_execute_push_request("approval-1", Some("task-a"));

        let result = take_approved_git_push(&state, &request, &preview);

        assert!(result.unwrap_err().contains("has not been approved"));
    }

    #[test]
    fn git_push_execution_rejects_stale_preview_hash() {
        let state = Mutex::new(GitPushApprovalState::default());
        let approved_preview = fake_push_preview("feature/git-push", 1, 0, &["abc123"]);
        let changed_preview = fake_push_preview("feature/git-push", 1, 0, &["def456"]);
        store_pending_git_push_approval(
            &state,
            create_pending_git_push_approval("approval-1", Some("task-a"), &approved_preview),
        )
        .unwrap();
        approve_pending_git_push(&state, "approval-1", Some("task-a")).unwrap();
        let request = fake_execute_push_request("approval-1", Some("task-a"));

        let result = take_approved_git_push(&state, &request, &changed_preview);

        assert!(result.unwrap_err().contains("preview hash"));
    }

    #[test]
    fn git_push_approval_consumes_once() {
        let state = Mutex::new(GitPushApprovalState::default());
        let preview = fake_push_preview("feature/git-push", 1, 0, &["abc123"]);
        store_pending_git_push_approval(
            &state,
            create_pending_git_push_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        approve_pending_git_push(&state, "approval-1", Some("task-a")).unwrap();
        let request = fake_execute_push_request("approval-1", Some("task-a"));

        take_approved_git_push(&state, &request, &preview).unwrap();
        let second_result = take_approved_git_push(&state, &request, &preview);

        assert!(second_result.unwrap_err().contains("No approved Git push"));
    }

    #[test]
    fn git_push_execution_pushes_to_bare_remote() {
        let (_tmp, workspace) = create_git_push_fixture();
        let state = Mutex::new(GitPushApprovalState::default());
        let preview = build_git_push_preview(&workspace, "session-1".to_string()).unwrap();
        assert_eq!(preview.ahead, 1);
        assert_eq!(preview.behind, 0);
        ensure_git_push_supported(&preview).unwrap();
        store_pending_git_push_approval(
            &state,
            create_pending_git_push_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        approve_pending_git_push(&state, "approval-1", Some("task-a")).unwrap();
        let request = ExecuteGitPushRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            task_id: Some("task-a".to_string()),
        };

        let result = execute_git_push_in_workspace(&workspace, &request, &state);
        let ahead_behind = git_output(
            &workspace,
            &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        )
        .unwrap();

        assert_requires_sandbox_backend(result);
        assert_eq!(parse_ahead_behind(&ahead_behind), Some((1, 0)));
    }

    #[test]
    fn git_create_pull_request_approval_requires_approval() {
        let state = Mutex::new(GitCreatePullRequestApprovalState::default());
        let preview = fake_create_pull_request_preview("feature/pr", "abc123");
        store_pending_git_create_pull_request_approval(
            &state,
            create_pending_git_create_pull_request_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        let request = fake_execute_create_pull_request_request("approval-1", Some("task-a"));

        let result = take_approved_git_create_pull_request(&state, &request, &preview);

        assert!(result.unwrap_err().contains("has not been approved"));
    }

    #[test]
    fn git_create_pull_request_approval_rejects_stale_preview_hash() {
        let state = Mutex::new(GitCreatePullRequestApprovalState::default());
        let preview = fake_create_pull_request_preview("feature/pr", "abc123");
        store_pending_git_create_pull_request_approval(
            &state,
            create_pending_git_create_pull_request_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        approve_pending_git_create_pull_request(&state, "approval-1", Some("task-a")).unwrap();
        let changed_preview = fake_create_pull_request_preview("feature/pr", "def456");
        let request = fake_execute_create_pull_request_request("approval-1", Some("task-a"));

        let result = take_approved_git_create_pull_request(&state, &request, &changed_preview);

        assert!(matches!(
            result,
            Err(ref error) if error.contains("preview hash")
        ));
    }

    #[test]
    fn git_create_pull_request_sanitizes_required_fields() {
        assert_eq!(
            sanitize_pull_request_title("  Add review UI  ").unwrap(),
            "Add review UI"
        );
        assert!(sanitize_pull_request_title(" ").is_err());
        assert!(sanitize_pull_request_branch("main", "base branch").is_ok());
        assert!(sanitize_pull_request_branch("../main", "base branch").is_err());
    }

    #[test]
    fn git_create_pull_request_extracts_url_from_gh_output() {
        assert_eq!(
            extract_first_url("Created pull request https://github.com/acme/repo/pull/42"),
            Some("https://github.com/acme/repo/pull/42".to_string())
        );
    }

    #[test]
    fn git_stage_plan_rejects_empty_paths() {
        let (_tmp, workspace) = create_git_commit_fixture();

        let result = build_git_stage_preview(&workspace, "session-1".to_string(), &[]);

        assert!(matches!(
            result,
            Err(ref error) if error == "Git stage preview requires at least one path."
        ));
    }

    #[test]
    fn git_stage_plan_rejects_missing_changed_path() {
        let (_tmp, workspace) = create_git_commit_fixture();

        let result = build_git_stage_preview(
            &workspace,
            "session-1".to_string(),
            &[String::from("missing.md")],
        );

        assert!(matches!(
            result,
            Err(ref error) if error.contains("could not find changed path: missing.md")
        ));
    }

    #[test]
    fn git_stage_execution_requires_approval() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitStageApprovalState::default());
        let paths = vec![String::from("README.md")];
        let preview = build_git_stage_preview(&workspace, "session-1".to_string(), &paths).unwrap();
        store_pending_git_stage_approval(
            &state,
            create_pending_git_stage_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        let request = fake_execute_stage_request("approval-1", Some("task-a"), &paths);

        let result = take_approved_git_stage(&state, &request, &preview);

        assert!(result.unwrap_err().contains("has not been approved"));
    }

    #[test]
    fn git_stage_execution_rejects_stale_preview_hash() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitStageApprovalState::default());
        let paths = vec![String::from("README.md")];
        let preview = build_git_stage_preview(&workspace, "session-1".to_string(), &paths).unwrap();
        store_pending_git_stage_approval(
            &state,
            create_pending_git_stage_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        approve_pending_git_stage(&state, "approval-1", Some("task-a")).unwrap();
        fs::write(workspace.join("README.md"), "base\nchanged again\n").unwrap();
        let request = fake_execute_stage_request("approval-1", Some("task-a"), &paths);

        let result = execute_git_stage_in_workspace(&workspace, &request, &state);

        assert_requires_sandbox_backend(result);
    }

    #[test]
    fn git_stage_execution_stages_only_selected_paths() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitStageApprovalState::default());
        let paths = vec![String::from("README.md")];
        let preview = build_git_stage_preview(&workspace, "session-1".to_string(), &paths).unwrap();
        assert_eq!(preview.files.len(), 1);
        assert_eq!(preview.dry_run.affected_paths[0].action, "stage");
        store_pending_git_stage_approval(
            &state,
            create_pending_git_stage_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        approve_pending_git_stage(&state, "approval-1", Some("task-a")).unwrap();
        let request = fake_execute_stage_request("approval-1", Some("task-a"), &paths);

        let result = execute_git_stage_in_workspace(&workspace, &request, &state);
        let status = git_output(&workspace, &["status", "--short"]).unwrap();

        assert_requires_sandbox_backend(result);
        assert!(!status.contains("M  README.md"));
        assert!(status.contains("?? notes.md"));
        assert!(!status.contains("A  notes.md"));
    }

    #[test]
    fn git_stage_approval_consumes_once() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitStageApprovalState::default());
        let paths = vec![String::from("README.md")];
        let preview = build_git_stage_preview(&workspace, "session-1".to_string(), &paths).unwrap();
        store_pending_git_stage_approval(
            &state,
            create_pending_git_stage_approval("approval-1", Some("task-a"), &preview),
        )
        .unwrap();
        approve_pending_git_stage(&state, "approval-1", Some("task-a")).unwrap();
        let request = fake_execute_stage_request("approval-1", Some("task-a"), &paths);

        let result = execute_git_stage_in_workspace(&workspace, &request, &state);
        let second_result = execute_git_stage_in_workspace(&workspace, &request, &state);

        assert_requires_sandbox_backend(result);
        assert_requires_sandbox_backend(second_result);
    }

    #[test]
    fn restored_git_stage_approval_can_execute_once() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitStageApprovalState::default());
        let paths = vec![String::from("README.md")];
        let preview = build_git_stage_preview(&workspace, "session-1".to_string(), &paths).unwrap();
        let restore_request = RestoreGitStageApprovalRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            task_id: Some("task-a".to_string()),
            preview: restore_preview_from_stage_preview(&preview),
        };

        restore_git_stage_approval_in_workspace(&workspace, &restore_request, &state).unwrap();
        approve_pending_git_stage(&state, "approval-1", Some("task-a")).unwrap();
        let execution = execute_git_stage_in_workspace(
            &workspace,
            &fake_execute_stage_request("approval-1", Some("task-a"), &paths),
            &state,
        );
        let second_result = execute_git_stage_in_workspace(
            &workspace,
            &fake_execute_stage_request("approval-1", Some("task-a"), &paths),
            &state,
        );

        assert_requires_sandbox_backend(execution);
        assert_requires_sandbox_backend(second_result);
    }

    #[test]
    fn restored_git_stage_approval_rejects_changed_file_content() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitStageApprovalState::default());
        let paths = vec![String::from("README.md")];
        let preview = build_git_stage_preview(&workspace, "session-1".to_string(), &paths).unwrap();
        fs::write(
            workspace.join("README.md"),
            "base\nchanged after approval\n",
        )
        .unwrap();
        let restore_request = RestoreGitStageApprovalRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            task_id: Some("task-a".to_string()),
            preview: restore_preview_from_stage_preview(&preview),
        };

        let result = restore_git_stage_approval_in_workspace(&workspace, &restore_request, &state);

        assert!(result.unwrap_err().contains("no longer matches"));
    }

    #[test]
    fn restored_git_stage_approval_rejects_changed_selected_paths() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitStageApprovalState::default());
        let paths = vec![String::from("README.md")];
        let preview = build_git_stage_preview(&workspace, "session-1".to_string(), &paths).unwrap();
        let mut restore_preview = restore_preview_from_stage_preview(&preview);
        restore_preview.files[0].path = "notes.md".to_string();
        let restore_request = RestoreGitStageApprovalRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            task_id: Some("task-a".to_string()),
            preview: restore_preview,
        };

        let result = restore_git_stage_approval_in_workspace(&workspace, &restore_request, &state);

        assert!(result.unwrap_err().contains("no longer matches"));
    }

    #[test]
    fn git_commit_plan_rejects_empty_message() {
        let (_tmp, workspace) = create_git_commit_fixture();

        let result = build_git_commit_preview(&workspace, "session-1".to_string(), "   ");

        assert!(matches!(
            result,
            Err(ref error) if error == "Git commit message is required."
        ));
    }

    #[test]
    fn git_commit_execution_requires_approval() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitCommitApprovalState::default());
        let preview =
            build_git_commit_preview(&workspace, "session-1".to_string(), "Commit changes")
                .unwrap();
        store_pending_git_commit_approval(
            &state,
            create_pending_git_commit_approval("approval-1", Some("task-a"), &preview).unwrap(),
        )
        .unwrap();
        let request = fake_execute_commit_request("approval-1", Some("task-a"), "Commit changes");

        let result = take_approved_git_commit(&state, &request, &preview);

        assert!(result.unwrap_err().contains("has not been approved"));
    }

    #[test]
    fn git_commit_execution_rejects_stale_preview_hash() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitCommitApprovalState::default());
        let preview =
            build_git_commit_preview(&workspace, "session-1".to_string(), "Commit changes")
                .unwrap();
        store_pending_git_commit_approval(
            &state,
            create_pending_git_commit_approval("approval-1", Some("task-a"), &preview).unwrap(),
        )
        .unwrap();
        approve_pending_git_commit(&state, "approval-1", Some("task-a")).unwrap();
        fs::write(workspace.join("README.md"), "base\nchanged again\n").unwrap();
        let request = fake_execute_commit_request("approval-1", Some("task-a"), "Commit changes");

        let result = execute_git_commit_in_workspace(&workspace, &request, &state);

        assert_requires_sandbox_backend(result);
    }

    #[test]
    fn git_commit_execution_stages_and_commits_current_changes() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitCommitApprovalState::default());
        let preview =
            build_git_commit_preview(&workspace, "session-1".to_string(), "Commit changes")
                .unwrap();
        assert_eq!(preview.files.len(), 2);
        assert!(preview
            .dry_run
            .risk_summary
            .contains("stage and commit 2 changed file"));
        store_pending_git_commit_approval(
            &state,
            create_pending_git_commit_approval("approval-1", Some("task-a"), &preview).unwrap(),
        )
        .unwrap();
        approve_pending_git_commit(&state, "approval-1", Some("task-a")).unwrap();
        let request = fake_execute_commit_request("approval-1", Some("task-a"), "Commit changes");

        let result = execute_git_commit_in_workspace(&workspace, &request, &state);
        let status = git_output(&workspace, &["status", "--short"]).unwrap();

        assert_requires_sandbox_backend(result);
        assert!(!status.is_empty());
    }

    #[test]
    fn git_commit_execution_commits_selected_paths_only() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitCommitApprovalState::default());
        let paths = vec![String::from("README.md")];
        let preview = build_git_commit_preview_for_paths(
            &workspace,
            "session-1".to_string(),
            "Commit selected README",
            &paths,
        )
        .unwrap();
        assert_eq!(preview.files.len(), 1);
        assert!(preview.dry_run.risk_summary.contains("selected paths"));
        store_pending_git_commit_approval(
            &state,
            create_pending_git_commit_approval("approval-1", Some("task-a"), &preview).unwrap(),
        )
        .unwrap();
        approve_pending_git_commit(&state, "approval-1", Some("task-a")).unwrap();
        let request = ExecuteGitCommitRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            message: "Commit selected README".to_string(),
            paths,
            task_id: Some("task-a".to_string()),
        };

        let result = execute_git_commit_in_workspace(&workspace, &request, &state);
        let status = git_output(&workspace, &["status", "--short"]).unwrap();

        assert_requires_sandbox_backend(result);
        assert!(status.contains("?? notes.md"));
        assert!(!status.contains("M  README.md"));
    }

    #[test]
    fn restored_git_commit_approval_can_execute_once() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitCommitApprovalState::default());
        let preview =
            build_git_commit_preview(&workspace, "session-1".to_string(), "Commit changes")
                .unwrap();
        let restore_request = RestoreGitCommitApprovalRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            task_id: Some("task-a".to_string()),
            preview: restore_preview_from_commit_preview(&preview),
        };

        restore_git_commit_approval_in_workspace(&workspace, &restore_request, &state).unwrap();
        approve_pending_git_commit(&state, "approval-1", Some("task-a")).unwrap();
        let execution = execute_git_commit_in_workspace(
            &workspace,
            &fake_execute_commit_request("approval-1", Some("task-a"), "Commit changes"),
            &state,
        );
        let second_result = execute_git_commit_in_workspace(
            &workspace,
            &fake_execute_commit_request("approval-1", Some("task-a"), "Commit changes"),
            &state,
        );

        assert_requires_sandbox_backend(execution);
        assert_requires_sandbox_backend(second_result);
    }

    #[test]
    fn restored_git_commit_approval_rejects_changed_untracked_content() {
        let (_tmp, workspace) = create_git_commit_fixture();
        let state = Mutex::new(GitCommitApprovalState::default());
        let preview =
            build_git_commit_preview(&workspace, "session-1".to_string(), "Commit changes")
                .unwrap();
        fs::write(workspace.join("notes.md"), "changed after approval\n").unwrap();
        let restore_request = RestoreGitCommitApprovalRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            task_id: Some("task-a".to_string()),
            preview: restore_preview_from_commit_preview(&preview),
        };

        let result = restore_git_commit_approval_in_workspace(&workspace, &restore_request, &state);

        assert!(result.unwrap_err().contains("no longer matches"));
    }

    #[test]
    fn restored_git_push_approval_can_execute_once() {
        let (_tmp, workspace) = create_git_push_fixture();
        let state = Mutex::new(GitPushApprovalState::default());
        let preview = build_git_push_preview(&workspace, "session-1".to_string()).unwrap();
        let restore_request = RestoreGitPushApprovalRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            task_id: Some("task-a".to_string()),
            preview: restore_preview_from_push_preview(&preview),
        };

        restore_git_push_approval_in_workspace(&workspace, &restore_request, &state).unwrap();
        approve_pending_git_push(&state, "approval-1", Some("task-a")).unwrap();
        let execution = execute_git_push_in_workspace(
            &workspace,
            &ExecuteGitPushRequest {
                approval_id: "approval-1".to_string(),
                session_id: "session-1".to_string(),
                workspace_root: normalize_path(&workspace),
                task_id: Some("task-a".to_string()),
            },
            &state,
        );

        assert_requires_sandbox_backend(execution);
    }

    #[test]
    fn restored_git_push_approval_rejects_changed_preview() {
        let (_tmp, workspace) = create_git_push_fixture();
        let state = Mutex::new(GitPushApprovalState::default());
        let preview = build_git_push_preview(&workspace, "session-1".to_string()).unwrap();
        fs::write(workspace.join("README.md"), "base\nlocal\nsecond\n").unwrap();
        git_output(&workspace, &["commit", "-am", "Second local change"]).unwrap();
        let restore_request = RestoreGitPushApprovalRequest {
            approval_id: "approval-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: normalize_path(&workspace),
            task_id: Some("task-a".to_string()),
            preview: restore_preview_from_push_preview(&preview),
        };

        let result = restore_git_push_approval_in_workspace(&workspace, &restore_request, &state);

        assert!(result.unwrap_err().contains("no longer matches"));
    }

    #[test]
    fn rejects_git_executable_inside_untrusted_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let executable_name = if cfg!(windows) { "git.cmd" } else { "git" };
        fs::write(workspace.path().join(executable_name), "echo hijacked").unwrap();

        let result = trusted_candidate(
            workspace.path().join(executable_name),
            Some(workspace.path()),
        );

        assert!(result.is_none());
    }

    fn fake_push_preview(
        branch: &str,
        ahead: u32,
        behind: u32,
        commit_hashes: &[&str],
    ) -> GitPushPreview {
        let upstream = format!("origin/{branch}");
        let remote_url = Some("https://example.com/repo.git".to_string());
        GitPushPreview {
            session_id: "session-1".to_string(),
            workspace_root: "C:/repo".to_string(),
            branch: branch.to_string(),
            upstream: upstream.clone(),
            remote_name: "origin".to_string(),
            remote_branch: branch.to_string(),
            remote_url: remote_url.clone(),
            ahead,
            behind,
            commits: commit_hashes
                .iter()
                .map(|hash| GitPushCommitPreview {
                    hash: (*hash).to_string(),
                    subject: "Local change".to_string(),
                })
                .collect(),
            dry_run: create_git_push_dry_run(
                branch,
                &upstream,
                remote_url.as_deref(),
                ahead,
                behind,
                commit_hashes.len(),
            ),
        }
    }

    fn fake_create_pull_request_preview(
        head_branch: &str,
        head_commit: &str,
    ) -> GitCreatePullRequestPreview {
        GitCreatePullRequestPreview {
            session_id: "session-1".to_string(),
            workspace_root: "C:/repo".to_string(),
            provider: "github-cli".to_string(),
            title: "Add review UI".to_string(),
            body: "This is a draft PR.".to_string(),
            base_branch: "main".to_string(),
            head_branch: head_branch.to_string(),
            head_commit: head_commit.to_string(),
            remote_name: Some("origin".to_string()),
            remote_url: Some("https://github.com/acme/repo.git".to_string()),
            draft: true,
            dry_run: create_git_create_pull_request_dry_run(
                "Add review UI",
                "main",
                head_branch,
                head_commit,
                Some("https://github.com/acme/repo.git"),
                true,
            ),
        }
    }

    fn restore_preview_from_create_pull_request_preview(
        preview: &GitCreatePullRequestPreview,
    ) -> GitCreatePullRequestRestorePreview {
        GitCreatePullRequestRestorePreview {
            workspace_root: preview.workspace_root.clone(),
            provider: preview.provider.clone(),
            title: preview.title.clone(),
            body: preview.body.clone(),
            base_branch: preview.base_branch.clone(),
            head_branch: preview.head_branch.clone(),
            head_commit: preview.head_commit.clone(),
            remote_url: preview.remote_url.clone(),
            draft: preview.draft,
        }
    }

    fn fake_comment_pull_request_preview(
        pull_request: &str,
        body: &str,
    ) -> GitCommentPullRequestPreview {
        GitCommentPullRequestPreview {
            session_id: "session-1".to_string(),
            workspace_root: "C:/repo".to_string(),
            provider: "github-cli".to_string(),
            pull_request: pull_request.to_string(),
            body: body.to_string(),
            remote_url: Some("https://github.com/acme/repo.git".to_string()),
            dry_run: create_git_comment_pull_request_dry_run(
                pull_request,
                body,
                Some("https://github.com/acme/repo.git"),
            ),
        }
    }

    fn restore_preview_from_comment_pull_request_preview(
        preview: &GitCommentPullRequestPreview,
    ) -> GitCommentPullRequestRestorePreview {
        GitCommentPullRequestRestorePreview {
            workspace_root: preview.workspace_root.clone(),
            provider: preview.provider.clone(),
            pull_request: preview.pull_request.clone(),
            body: preview.body.clone(),
            remote_url: preview.remote_url.clone(),
        }
    }

    fn fake_execute_push_request(
        approval_id: &str,
        task_id: Option<&str>,
    ) -> ExecuteGitPushRequest {
        ExecuteGitPushRequest {
            approval_id: approval_id.to_string(),
            session_id: "session-1".to_string(),
            workspace_root: "C:/repo".to_string(),
            task_id: task_id.map(str::to_string),
        }
    }

    fn fake_execute_create_pull_request_request(
        approval_id: &str,
        task_id: Option<&str>,
    ) -> ExecuteGitCreatePullRequestRequest {
        ExecuteGitCreatePullRequestRequest {
            approval_id: approval_id.to_string(),
            session_id: "session-1".to_string(),
            workspace_root: "C:/repo".to_string(),
            title: "Add review UI".to_string(),
            body: "This is a draft PR.".to_string(),
            base_branch: "main".to_string(),
            draft: Some(true),
            task_id: task_id.map(str::to_string),
        }
    }

    fn fake_execute_comment_pull_request_request(
        approval_id: &str,
        task_id: Option<&str>,
    ) -> ExecuteGitCommentPullRequestRequest {
        ExecuteGitCommentPullRequestRequest {
            approval_id: approval_id.to_string(),
            session_id: "session-1".to_string(),
            workspace_root: "C:/repo".to_string(),
            pull_request: "12".to_string(),
            body: "Looks good.".to_string(),
            task_id: task_id.map(str::to_string),
        }
    }

    fn fake_execute_commit_request(
        approval_id: &str,
        task_id: Option<&str>,
        message: &str,
    ) -> ExecuteGitCommitRequest {
        ExecuteGitCommitRequest {
            approval_id: approval_id.to_string(),
            session_id: "session-1".to_string(),
            workspace_root: "C:/repo".to_string(),
            message: message.to_string(),
            paths: Vec::new(),
            task_id: task_id.map(str::to_string),
        }
    }

    fn fake_execute_stage_request(
        approval_id: &str,
        task_id: Option<&str>,
        paths: &[String],
    ) -> ExecuteGitStageRequest {
        ExecuteGitStageRequest {
            approval_id: approval_id.to_string(),
            session_id: "session-1".to_string(),
            workspace_root: "C:/repo".to_string(),
            paths: paths.to_vec(),
            task_id: task_id.map(str::to_string),
        }
    }

    fn create_git_push_fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let remote = tmp.path().join("remote.git");
        fs::create_dir_all(&remote).unwrap();
        git_output(&remote, &["init", "--bare"]).unwrap();

        let workspace = tmp.path().join("work");
        fs::create_dir_all(&workspace).unwrap();
        git_output(&workspace, &["init"]).unwrap();
        git_output(&workspace, &["config", "user.name", "Javis Test"]).unwrap();
        git_output(&workspace, &["config", "user.email", "javis@example.test"]).unwrap();
        git_output(&workspace, &["checkout", "-b", "feature/git-push"]).unwrap();

        fs::write(workspace.join("README.md"), "base\n").unwrap();
        git_output(&workspace, &["add", "README.md"]).unwrap();
        git_output(&workspace, &["commit", "-m", "Initial commit"]).unwrap();
        git_output(
            &workspace,
            &[
                "remote",
                "add",
                "origin",
                remote.to_str().expect("temp path should be UTF-8"),
            ],
        )
        .unwrap();
        git_output(&workspace, &["push", "-u", "origin", "feature/git-push"]).unwrap();

        fs::write(workspace.join("README.md"), "base\nlocal\n").unwrap();
        git_output(&workspace, &["commit", "-am", "Local change"]).unwrap();

        (tmp, workspace)
    }

    fn create_git_commit_fixture() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("work");
        fs::create_dir_all(&workspace).unwrap();
        git_output(&workspace, &["init"]).unwrap();
        git_output(&workspace, &["config", "user.name", "Javis Test"]).unwrap();
        git_output(&workspace, &["config", "user.email", "javis@example.test"]).unwrap();
        git_output(&workspace, &["checkout", "-b", "feature/git-commit"]).unwrap();

        fs::write(workspace.join("README.md"), "base\n").unwrap();
        git_output(&workspace, &["add", "README.md"]).unwrap();
        git_output(&workspace, &["commit", "-m", "Initial commit"]).unwrap();

        fs::write(workspace.join("README.md"), "base\nchanged\n").unwrap();
        fs::write(workspace.join("notes.md"), "new note\n").unwrap();

        (tmp, workspace)
    }

    fn restore_preview_from_commit_preview(preview: &GitCommitPreview) -> GitCommitRestorePreview {
        GitCommitRestorePreview {
            workspace_root: preview.workspace_root.clone(),
            branch: preview.branch.clone(),
            message: preview.message.clone(),
            files: preview
                .files
                .iter()
                .map(|file| GitCommitRestoreFilePreview {
                    path: file.path.clone(),
                    index_status: file.index_status.clone(),
                    worktree_status: file.worktree_status.clone(),
                    action: file.action.clone(),
                    content_hash: file.content_hash.clone(),
                })
                .collect(),
            diff: preview.diff.clone(),
        }
    }

    fn restore_preview_from_stage_preview(preview: &GitStagePreview) -> GitStageRestorePreview {
        GitStageRestorePreview {
            workspace_root: preview.workspace_root.clone(),
            files: preview
                .files
                .iter()
                .map(|file| GitStageRestoreFilePreview {
                    path: file.path.clone(),
                    index_status: file.index_status.clone(),
                    worktree_status: file.worktree_status.clone(),
                    action: file.action.clone(),
                    content_hash: file.content_hash.clone(),
                })
                .collect(),
            diff: preview.diff.clone(),
        }
    }

    fn restore_preview_from_push_preview(preview: &GitPushPreview) -> GitPushRestorePreview {
        GitPushRestorePreview {
            branch: preview.branch.clone(),
            upstream: preview.upstream.clone(),
            remote_name: preview.remote_name.clone(),
            remote_branch: preview.remote_branch.clone(),
            remote_url: preview.remote_url.clone(),
            ahead: preview.ahead,
            behind: preview.behind,
            commits: preview
                .commits
                .iter()
                .map(|commit| GitPushRestoreCommitPreview {
                    hash: commit.hash.clone(),
                })
                .collect(),
        }
    }

    fn assert_requires_sandbox_backend<T>(result: Result<T, String>) {
        let error = match result {
            Ok(_) => panic!("operation should require sandbox backend"),
            Err(error) => error,
        };
        assert!(
            error.contains("Workspace-write commands require an OS sandbox backend")
                || error.contains("Network-capable commands require an OS sandbox backend"),
            "{error}"
        );
        assert!(error.contains("enforced=false"), "{error}");
    }
}
