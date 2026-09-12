use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

use crate::error::JavisError;
use crate::pdf::{FileDryRunSummary, PlannedPathOperation};
use crate::{
    approve_native_approval_binding, create_approval_id, create_fnv1a_hash,
    create_native_approval_binding, require_native_approval_binding, NativeApprovalBinding,
};

const WORKSPACE_CREATE_TOOL_NAME: &str = "workspace.create";
const WORKSPACE_DELETE_TOOL_NAME: &str = "workspace.delete";

#[derive(Default)]
pub(crate) struct WorkspaceMutationApprovalState {
    pending: HashMap<String, PendingWorkspaceMutation>,
}

#[derive(Debug)]
struct PendingWorkspaceMutation {
    binding: NativeApprovalBinding,
    workspace_id: String,
    action: String,
    payload_hash: String,
    previous_hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCreateRequest {
    definition: serde_json::Value,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDeleteRequest {
    workspace_id: String,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMutationApprovalRequest {
    approval_id: String,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteWorkspaceCreateRequest {
    approval_id: String,
    definition: serde_json::Value,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteWorkspaceDeleteRequest {
    approval_id: String,
    workspace_id: String,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceMutationPlan {
    approval_id: String,
    workspace_id: String,
    action: String,
    payload_hash: String,
    dry_run: FileDryRunSummary,
}

#[tauri::command]
pub(crate) fn load_workspace_definitions(
    app_handle: tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, String> {
    load_workspace_definitions_impl(&app_handle).map_err(|e| e.to_string())
}

fn load_workspace_definitions_impl(
    app_handle: &tauri::AppHandle,
) -> Result<Vec<serde_json::Value>, JavisError> {
    let workspaces_dir = get_workspaces_dir(app_handle)?;
    if !workspaces_dir.exists() {
        return Ok(Vec::new());
    }
    let mut defs = Vec::new();
    let entries = std::fs::read_dir(&workspaces_dir)?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let is_workspace_file = path.extension().and_then(|s| s.to_str()) == Some("json")
            && path
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.ends_with(".workspace"));
        if !is_workspace_file {
            continue;
        }
        let content = std::fs::read_to_string(&path)?;
        let def: serde_json::Value = serde_json::from_str(&content)?;
        defs.push(def);
    }
    Ok(defs)
}

#[tauri::command]
pub(crate) fn plan_workspace_create(
    app_handle: tauri::AppHandle,
    request: WorkspaceCreateRequest,
    approval_state: tauri::State<'_, Mutex<WorkspaceMutationApprovalState>>,
) -> Result<WorkspaceMutationPlan, String> {
    let workspace_id = workspace_id_from_definition(&request.definition)?;
    let target = resolve_workspace_definition_path(&app_handle, &workspace_id)?;
    ensure_workspace_target_is_not_symlink(&target)?;
    if target.exists() {
        return Err(format!("Workspace {workspace_id} already exists."));
    }
    let content = serde_json::to_string_pretty(&request.definition).map_err(|e| e.to_string())?;
    let payload_hash = create_fnv1a_hash(content.as_bytes());
    let approval_id = create_approval_id();
    let pending = create_pending_workspace_mutation(
        &approval_id,
        WORKSPACE_CREATE_TOOL_NAME,
        &workspace_id,
        "create",
        &payload_hash,
        None,
        request.task_id.as_deref(),
    );
    let plan = create_workspace_mutation_plan(&approval_id, &pending, &target);
    store_pending_workspace_mutation(&approval_state, approval_id, pending)?;
    Ok(plan)
}

#[tauri::command]
pub(crate) fn plan_workspace_delete(
    app_handle: tauri::AppHandle,
    request: WorkspaceDeleteRequest,
    approval_state: tauri::State<'_, Mutex<WorkspaceMutationApprovalState>>,
) -> Result<WorkspaceMutationPlan, String> {
    validate_workspace_id(&request.workspace_id).map_err(|e| e.to_string())?;
    let target = resolve_workspace_definition_path(&app_handle, &request.workspace_id)?;
    ensure_workspace_target_is_regular_file(&target)?;
    let previous_hash = create_fnv1a_hash(&fs::read(&target).map_err(|e| e.to_string())?);
    let approval_id = create_approval_id();
    let pending = create_pending_workspace_mutation(
        &approval_id,
        WORKSPACE_DELETE_TOOL_NAME,
        &request.workspace_id,
        "delete",
        &previous_hash,
        Some(previous_hash.clone()),
        request.task_id.as_deref(),
    );
    let plan = create_workspace_mutation_plan(&approval_id, &pending, &target);
    store_pending_workspace_mutation(&approval_state, approval_id, pending)?;
    Ok(plan)
}

#[tauri::command]
pub(crate) fn approve_workspace_mutation(
    request: WorkspaceMutationApprovalRequest,
    approval_state: tauri::State<'_, Mutex<WorkspaceMutationApprovalState>>,
) -> Result<(), String> {
    approve_pending_workspace_mutation(
        &approval_state,
        &request.approval_id,
        request.task_id.as_deref(),
    )
}

#[tauri::command]
pub(crate) fn execute_workspace_create(
    app_handle: tauri::AppHandle,
    request: ExecuteWorkspaceCreateRequest,
    approval_state: tauri::State<'_, Mutex<WorkspaceMutationApprovalState>>,
) -> Result<(), String> {
    let workspace_id = workspace_id_from_definition(&request.definition)?;
    let content = serde_json::to_string_pretty(&request.definition).map_err(|e| e.to_string())?;
    let payload_hash = create_fnv1a_hash(content.as_bytes());
    take_approved_workspace_mutation(
        &approval_state,
        &request.approval_id,
        WORKSPACE_CREATE_TOOL_NAME,
        &workspace_id,
        Some(&payload_hash),
        request.task_id.as_deref(),
    )?;
    create_workspace_definition_impl(&app_handle, &workspace_id, &content, &request.approval_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn execute_workspace_delete(
    app_handle: tauri::AppHandle,
    request: ExecuteWorkspaceDeleteRequest,
    approval_state: tauri::State<'_, Mutex<WorkspaceMutationApprovalState>>,
) -> Result<(), String> {
    validate_workspace_id(&request.workspace_id).map_err(|e| e.to_string())?;
    let pending = take_approved_workspace_mutation(
        &approval_state,
        &request.approval_id,
        WORKSPACE_DELETE_TOOL_NAME,
        &request.workspace_id,
        None,
        request.task_id.as_deref(),
    )?;
    delete_workspace_definition_impl(
        &app_handle,
        &request.workspace_id,
        pending.previous_hash.as_deref(),
    )
    .map_err(|e| e.to_string())
}

fn create_workspace_definition_impl(
    app_handle: &tauri::AppHandle,
    workspace_id: &str,
    content: &str,
    approval_id: &str,
) -> Result<(), JavisError> {
    let workspaces_dir = get_workspaces_dir(app_handle)?;
    fs::create_dir_all(&workspaces_dir)?;
    ensure_directory_is_not_symlink(&workspaces_dir)?;
    let path = workspaces_dir.join(format!("{workspace_id}.workspace.json"));
    ensure_workspace_target_is_not_symlink(&path).map_err(JavisError::Permission)?;
    if path.exists() {
        return Err(JavisError::Validation(format!(
            "Workspace {workspace_id} already exists."
        )));
    }
    let tmp_path = workspaces_dir.join(format!("{workspace_id}.{approval_id}.tmp"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&tmp_path);
        return Err(error.into());
    }
    if let Err(error) = fs::rename(&tmp_path, &path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(error.into());
    }
    Ok(())
}

fn delete_workspace_definition_impl(
    app_handle: &tauri::AppHandle,
    workspace_id: &str,
    expected_hash: Option<&str>,
) -> Result<(), JavisError> {
    validate_workspace_id(workspace_id)?;
    let workspaces_dir = get_workspaces_dir(app_handle)?;
    let path = workspaces_dir.join(format!("{workspace_id}.workspace.json"));
    ensure_workspace_target_is_regular_file(&path).map_err(JavisError::Permission)?;
    if let Some(expected_hash) = expected_hash {
        let current_hash = create_fnv1a_hash(&fs::read(&path)?);
        if current_hash != expected_hash {
            return Err(JavisError::Permission(
                "Workspace definition changed after approval; request a new preview.".into(),
            ));
        }
    }
    fs::remove_file(&path)?;
    Ok(())
}

fn workspace_id_from_definition(definition: &serde_json::Value) -> Result<String, String> {
    let workspace_id = definition
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Workspace definition requires a non-empty id.".to_string())?
        .trim()
        .to_string();
    validate_workspace_id(&workspace_id).map_err(|e| e.to_string())?;
    Ok(workspace_id)
}

fn resolve_workspace_definition_path(
    app_handle: &tauri::AppHandle,
    workspace_id: &str,
) -> Result<PathBuf, String> {
    validate_workspace_id(workspace_id).map_err(|e| e.to_string())?;
    let workspaces_dir = get_workspaces_dir(app_handle).map_err(|e| e.to_string())?;
    if workspaces_dir.exists() {
        ensure_directory_is_not_symlink(&workspaces_dir).map_err(|e| e.to_string())?;
    }
    Ok(workspaces_dir.join(format!("{workspace_id}.workspace.json")))
}

fn ensure_directory_is_not_symlink(path: &Path) -> Result<(), JavisError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(JavisError::Permission(
            "Workspace definitions directory must be a real directory.".into(),
        ));
    }
    Ok(())
}

fn ensure_workspace_target_is_not_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Workspace definition target cannot be a symlink.".to_string())
        }
        Ok(metadata) if !metadata.is_file() => {
            Err("Workspace definition target must be a regular file.".to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
        Ok(_) => Ok(()),
    }
}

fn ensure_workspace_target_is_regular_file(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Workspace definition does not exist.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Workspace definition target must be a non-symlink regular file.".to_string());
    }
    Ok(())
}

fn create_pending_workspace_mutation(
    approval_id: &str,
    tool_name: &str,
    workspace_id: &str,
    action: &str,
    payload_hash: &str,
    previous_hash: Option<String>,
    task_id: Option<&str>,
) -> PendingWorkspaceMutation {
    let preview_hash = create_workspace_mutation_preview_hash(
        action,
        workspace_id,
        payload_hash,
        previous_hash.as_deref(),
    );
    PendingWorkspaceMutation {
        binding: create_native_approval_binding(
            approval_id.to_string(),
            tool_name,
            task_id.unwrap_or_default().trim().to_string(),
            preview_hash,
            false,
        ),
        workspace_id: workspace_id.to_string(),
        action: action.to_string(),
        payload_hash: payload_hash.to_string(),
        previous_hash,
    }
}

fn create_workspace_mutation_plan(
    approval_id: &str,
    pending: &PendingWorkspaceMutation,
    target: &Path,
) -> WorkspaceMutationPlan {
    WorkspaceMutationPlan {
        approval_id: approval_id.to_string(),
        workspace_id: pending.workspace_id.clone(),
        action: pending.action.clone(),
        payload_hash: pending.payload_hash.clone(),
        dry_run: FileDryRunSummary {
            operation: if pending.action == "create" {
                WORKSPACE_CREATE_TOOL_NAME.to_string()
            } else {
                WORKSPACE_DELETE_TOOL_NAME.to_string()
            },
            affected_paths: vec![PlannedPathOperation {
                source: pending.workspace_id.clone(),
                target: target.to_string_lossy().to_string(),
                action: pending.action.clone(),
                conflict: None,
            }],
            risk_summary: if pending.action == "create" {
                "Creates a durable local workspace definition.".to_string()
            } else {
                "Deletes a local workspace definition.".to_string()
            },
            reversible: pending.action == "create",
        },
    }
}

fn store_pending_workspace_mutation(
    approval_state: &Mutex<WorkspaceMutationApprovalState>,
    approval_id: String,
    pending: PendingWorkspaceMutation,
) -> Result<(), String> {
    approval_state
        .lock()
        .map_err(|_| "Workspace approval state could not be locked.".to_string())?
        .pending
        .insert(approval_id, pending);
    Ok(())
}

fn approve_pending_workspace_mutation(
    approval_state: &Mutex<WorkspaceMutationApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Workspace approval state could not be locked.".to_string())?;
    let pending = state
        .pending
        .get_mut(approval_id)
        .ok_or_else(|| "No pending workspace mutation approval exists.".to_string())?;
    let tool_name = if pending.action == "create" {
        WORKSPACE_CREATE_TOOL_NAME
    } else {
        WORKSPACE_DELETE_TOOL_NAME
    };
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        tool_name,
        task_id,
        &create_workspace_mutation_preview_hash(
            &pending.action,
            &pending.workspace_id,
            &pending.payload_hash,
            pending.previous_hash.as_deref(),
        ),
        "Workspace approval id does not match the pending preview.",
    )
}

fn take_approved_workspace_mutation(
    approval_state: &Mutex<WorkspaceMutationApprovalState>,
    approval_id: &str,
    tool_name: &str,
    workspace_id: &str,
    payload_hash: Option<&str>,
    task_id: Option<&str>,
) -> Result<PendingWorkspaceMutation, String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Workspace approval state could not be locked.".to_string())?;
    let pending = state
        .pending
        .get(approval_id)
        .ok_or_else(|| "No approved workspace mutation is pending.".to_string())?;
    require_native_approval_binding(
        &pending.binding,
        approval_id,
        tool_name,
        task_id,
        &create_workspace_mutation_preview_hash(
            &pending.action,
            &pending.workspace_id,
            &pending.payload_hash,
            pending.previous_hash.as_deref(),
        ),
        "Workspace approval id does not match the pending preview.",
        "Workspace mutation preview has not been approved.",
    )
    .map_err(|e| e.to_string())?;
    if pending.workspace_id != workspace_id
        || payload_hash.is_some_and(|hash| hash != pending.payload_hash)
    {
        return Err("Approved workspace mutation does not match the current request.".to_string());
    }
    state
        .pending
        .remove(approval_id)
        .ok_or_else(|| "No approved workspace mutation is pending.".to_string())
}

fn create_workspace_mutation_preview_hash(
    action: &str,
    workspace_id: &str,
    payload_hash: &str,
    previous_hash: Option<&str>,
) -> String {
    create_fnv1a_hash(
        format!(
            "{action}\0{workspace_id}\0{payload_hash}\0{}",
            previous_hash.unwrap_or_default()
        )
        .as_bytes(),
    )
}

// ── `.javis` configuration loading (C1b) ─────────────────────────────────────

/// Directory and file name of the project configuration layer.
const JAVIS_CONFIG_DIR: &str = ".javis";
const JAVIS_CONFIG_FILE: &str = "config.json";
/// Configuration is data, not a payload: anything larger is a mistake or an attack.
const MAX_JAVIS_CONFIG_BYTES: u64 = 256 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JavisConfigFiles {
    pub(crate) project_path: Option<String>,
    pub(crate) project_text: Option<String>,
    pub(crate) user_path: Option<String>,
    pub(crate) user_text: Option<String>,
}

/// Reads a file only when it is directly inside `root`, refusing symlink escapes.
///
/// The file is canonicalized first, so a `.javis/config.json` symlinked outside the
/// workspace resolves to its real target and then fails the containment check.
pub(crate) fn read_config_file_within_root(
    root: &Path,
    file_name: &str,
    max_bytes: u64,
) -> Result<Option<String>, String> {
    let candidate = root.join(file_name);
    if !candidate.exists() {
        return Ok(None);
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Cannot resolve workspace root: {error}"))?;
    let canonical_file = fs::canonicalize(&candidate)
        .map_err(|error| format!("Cannot resolve config path: {error}"))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(format!(
            "Config file {} resolves outside the workspace root.",
            candidate.to_string_lossy()
        ));
    }
    let metadata = fs::metadata(&canonical_file)
        .map_err(|error| format!("Cannot stat config file: {error}"))?;
    if metadata.len() > max_bytes {
        return Err(format!(
            "Config file {} is {} bytes; the limit is {max_bytes}.",
            canonical_file.to_string_lossy(),
            metadata.len()
        ));
    }
    fs::read_to_string(&canonical_file)
        .map(Some)
        .map_err(|error| format!("Cannot read config file: {error}"))
}

/// Loads the project (`<workspace>/.javis/config.json`) and user
/// (`<config dir>/javis/config.json`) layers. A missing layer is `None`, not an
/// error: most installs have neither.
#[tauri::command]
pub(crate) fn load_javis_config_files(
    workspace_path: Option<String>,
) -> Result<JavisConfigFiles, String> {
    let mut files = JavisConfigFiles::default();

    if let Some(workspace) = workspace_path.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        let root = PathBuf::from(workspace).join(JAVIS_CONFIG_DIR);
        if root.exists() {
            if let Some(text) = read_config_file_within_root(&root, JAVIS_CONFIG_FILE, MAX_JAVIS_CONFIG_BYTES)? {
                files.project_path = Some(root.join(JAVIS_CONFIG_FILE).to_string_lossy().to_string());
                files.project_text = Some(text);
            }
        }
    }

    // Mirrors the MCP config location so both live side by side.
    if let Some(config_dir) = dirs::config_dir() {
        let root = config_dir.join("javis");
        if root.exists() {
            if let Some(text) = read_config_file_within_root(&root, JAVIS_CONFIG_FILE, MAX_JAVIS_CONFIG_BYTES)? {
                files.user_path = Some(root.join(JAVIS_CONFIG_FILE).to_string_lossy().to_string());
                files.user_text = Some(text);
            }
        }
    }

    Ok(files)
}

// ── Workspace Definition CRUD ────────────────────────────────────────────────

pub(crate) fn get_workspaces_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, JavisError> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| JavisError::Io(format!("Failed to resolve app data dir: {e}")))?;
    Ok(dir.join("workspaces"))
}

pub(crate) fn validate_workspace_id(id: &str) -> Result<(), JavisError> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(JavisError::Validation(
            "Invalid workspace id: path traversal not allowed".into(),
        ));
    }
    // Only allow lowercase alphanumeric and hyphens
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(JavisError::Validation(
            "Invalid workspace id: only [a-z0-9-] allowed".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("javis-config-{label}-{unique}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn reads_a_config_file_inside_its_root() {
        let root = temp_dir("inside");
        fs::write(root.join("config.json"), "{\"version\":1}").expect("write config");
        let text = read_config_file_within_root(&root, "config.json", 1024)
            .expect("read config")
            .expect("config present");
        assert_eq!(text, "{\"version\":1}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn treats_a_missing_config_file_as_absent_rather_than_an_error() {
        let root = temp_dir("missing");
        assert!(read_config_file_within_root(&root, "config.json", 1024)
            .expect("missing file is not an error")
            .is_none());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_a_config_file_that_escapes_its_root() {
        let root = temp_dir("escape-root");
        let outside = temp_dir("escape-outside");
        fs::write(outside.join("secret.json"), "{\"version\":1}").expect("write outside file");
        let relative = format!(
            "../{}/secret.json",
            outside.file_name().expect("outside dir name").to_string_lossy()
        );
        let error = read_config_file_within_root(&root, &relative, 1024)
            .expect_err("escaping path must be rejected");
        assert!(error.contains("outside the workspace root"), "unexpected error: {error}");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn refuses_a_config_file_over_the_size_limit() {
        let root = temp_dir("oversize");
        fs::write(root.join("config.json"), "x".repeat(64)).expect("write config");
        let error = read_config_file_within_root(&root, "config.json", 16)
            .expect_err("oversize config must be rejected");
        assert!(error.contains("the limit is 16"), "unexpected error: {error}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn returns_no_layers_when_nothing_is_configured() {
        let files = load_javis_config_files(None).expect("load config files");
        assert!(files.project_text.is_none());
        assert!(files.project_path.is_none());
    }

    #[test]
    fn validate_workspace_id_accepts_valid_kebab_case() {
        assert!(validate_workspace_id("my-workspace").is_ok());
        assert!(validate_workspace_id("test-123").is_ok());
        assert!(validate_workspace_id("a").is_ok());
    }

    #[test]
    fn validate_workspace_id_rejects_empty() {
        assert!(validate_workspace_id("").is_err());
    }

    #[test]
    fn validate_workspace_id_rejects_path_traversal() {
        assert!(validate_workspace_id("../escape").is_err());
        assert!(validate_workspace_id("foo/bar").is_err());
        assert!(validate_workspace_id("foo\\bar").is_err());
    }

    #[test]
    fn validate_workspace_id_rejects_uppercase() {
        assert!(validate_workspace_id("My-Workspace").is_err());
    }

    #[test]
    fn validate_workspace_id_rejects_special_chars() {
        assert!(validate_workspace_id("my workspace").is_err());
        assert!(validate_workspace_id("workspace!").is_err());
        assert!(validate_workspace_id("ws@test").is_err());
    }

    fn pending_create(
        state: &Mutex<WorkspaceMutationApprovalState>,
        approval_id: &str,
        task_id: &str,
    ) {
        let pending = create_pending_workspace_mutation(
            approval_id,
            WORKSPACE_CREATE_TOOL_NAME,
            "knowledge-base",
            "create",
            "payload-hash",
            None,
            Some(task_id),
        );
        store_pending_workspace_mutation(state, approval_id.to_string(), pending)
            .expect("store pending workspace create");
    }

    #[test]
    fn workspace_approval_is_bound_to_task_and_payload() {
        let state = Mutex::new(WorkspaceMutationApprovalState::default());
        pending_create(&state, "approval-1", "task-1");

        assert!(
            approve_pending_workspace_mutation(&state, "approval-1", Some("wrong-task")).is_err()
        );
        approve_pending_workspace_mutation(&state, "approval-1", Some("task-1"))
            .expect("approve matching workspace create");
        assert!(take_approved_workspace_mutation(
            &state,
            "approval-1",
            WORKSPACE_CREATE_TOOL_NAME,
            "knowledge-base",
            Some("changed-payload"),
            Some("task-1"),
        )
        .is_err());
        assert!(take_approved_workspace_mutation(
            &state,
            "approval-1",
            WORKSPACE_CREATE_TOOL_NAME,
            "knowledge-base",
            Some("payload-hash"),
            Some("task-1"),
        )
        .is_ok());
    }

    #[test]
    fn workspace_approval_is_tool_bound_and_one_shot() {
        let state = Mutex::new(WorkspaceMutationApprovalState::default());
        pending_create(&state, "approval-2", "task-2");
        approve_pending_workspace_mutation(&state, "approval-2", Some("task-2"))
            .expect("approve workspace create");

        assert!(take_approved_workspace_mutation(
            &state,
            "approval-2",
            WORKSPACE_DELETE_TOOL_NAME,
            "knowledge-base",
            Some("payload-hash"),
            Some("task-2"),
        )
        .is_err());
        assert!(take_approved_workspace_mutation(
            &state,
            "approval-2",
            WORKSPACE_CREATE_TOOL_NAME,
            "knowledge-base",
            Some("payload-hash"),
            Some("task-2"),
        )
        .is_ok());
        assert!(take_approved_workspace_mutation(
            &state,
            "approval-2",
            WORKSPACE_CREATE_TOOL_NAME,
            "knowledge-base",
            Some("payload-hash"),
            Some("task-2"),
        )
        .is_err());
    }
}
