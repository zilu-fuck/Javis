use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use crate::pdf::{FileDryRunSummary, PlannedPathOperation};
use crate::{
    approve_native_approval_binding, create_approval_id, create_fnv1a_hash,
    create_native_approval_binding, normalize_path, require_native_approval_binding,
    resolve_workspace_path, NativeApprovalBinding,
};

pub(crate) const WRITE_TEXT_APPROVAL_TOOL_NAME: &str = "file.writeText";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteTextFileRequest {
    pub(crate) target_path: String,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) workspace_path: Option<String>,
    #[serde(default)]
    pub(crate) task_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextFileWritePlan {
    approval_id: String,
    target_path: String,
    action: String,
    byte_count: usize,
    content_hash: String,
    dry_run: FileDryRunSummary,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteWriteTextFileRequest {
    pub(crate) approval_id: String,
    pub(crate) target_path: String,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) workspace_path: Option<String>,
    #[serde(default)]
    pub(crate) task_id: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextFileWriteResult {
    pub(crate) target_path: String,
    pub(crate) action: String,
    pub(crate) byte_count: usize,
    pub(crate) status: String,
    pub(crate) message: String,
}

#[derive(Default)]
pub(crate) struct WriteTextApprovalState {
    pub(crate) pending: Option<PendingWriteTextApproval>,
}

#[derive(Debug)]
pub(crate) struct PendingWriteTextApproval {
    pub(crate) binding: NativeApprovalBinding,
    pub(crate) target_path: String,
    pub(crate) content: String,
    pub(crate) action: String,
    pub(crate) previous_hash: Option<String>,
}

#[tauri::command]
pub(crate) fn plan_write_text_file(
    request: WriteTextFileRequest,
    approval_state: tauri::State<'_, Mutex<WriteTextApprovalState>>,
) -> Result<TextFileWritePlan, String> {
    let approval_id = create_approval_id();
    let pending = create_pending_write_text_approval(&approval_id, &request)?;
    let plan = create_text_write_plan_from_pending(&approval_id, &pending);
    store_pending_write_text_approval(&approval_state, pending)?;
    Ok(plan)
}

#[tauri::command]
pub(crate) fn approve_write_text_file(
    approval_id: String,
    #[allow(unused_variables)] task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<WriteTextApprovalState>>,
) -> Result<(), String> {
    approve_pending_write_text(&approval_state, &approval_id, task_id.as_deref())
}

#[tauri::command]
pub(crate) fn execute_write_text_file(
    request: ExecuteWriteTextFileRequest,
    approval_state: tauri::State<'_, Mutex<WriteTextApprovalState>>,
) -> Result<TextFileWriteResult, String> {
    let approved = take_approved_write_text(&approval_state, &request)?;
    let workspace = resolve_workspace_path(request.workspace_path.clone())
        .map_err(|error| error.to_string())?;
    let target = resolve_text_target_path(&request.target_path, request.workspace_path.as_deref())?;
    write_text_file_with_workspace(
        &target,
        &approved.content,
        &approved.action,
        approved.previous_hash.as_deref(),
        Some(&workspace),
    )
}

#[cfg(test)]
pub(crate) fn replace_pending_write_text_approval(
    approval_state: &Mutex<WriteTextApprovalState>,
    approval_id: &str,
    request: &WriteTextFileRequest,
) -> Result<(), String> {
    let pending = create_pending_write_text_approval(approval_id, request)?;
    let mut state = approval_state
        .lock()
        .map_err(|_| "Text write approval state could not be locked.".to_string())?;
    state.pending = Some(pending);
    Ok(())
}

pub(crate) fn approve_pending_write_text(
    approval_state: &Mutex<WriteTextApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Text write approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_mut() else {
        return Err("No pending text write approval exists.".to_string());
    };
    let hash = pending_preview_hash(pending);
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        WRITE_TEXT_APPROVAL_TOOL_NAME,
        task_id,
        &hash,
        "Text write approval id does not match the pending dry-run.",
    )
}

pub(crate) fn take_approved_write_text(
    approval_state: &Mutex<WriteTextApprovalState>,
    request: &ExecuteWriteTextFileRequest,
) -> Result<PendingWriteTextApproval, String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Text write approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_ref() else {
        return Err("No approved text write dry-run is pending.".to_string());
    };
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        WRITE_TEXT_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &pending_preview_hash(pending),
        "Text write approval id does not match the pending dry-run.",
        "Text write dry-run has not been approved.",
    )
    .map_err(|error| error.to_string())?;

    let requested_target = normalize_path(&resolve_text_target_path(
        &request.target_path,
        request.workspace_path.as_deref(),
    )?);
    if pending.target_path != requested_target || pending.content != request.content {
        return Err("Approved text write request does not match the current dry-run.".to_string());
    }

    let approved = state
        .pending
        .take()
        .ok_or_else(|| "No approved text write dry-run is pending.".to_string())?;
    Ok(approved)
}

pub(crate) fn create_pending_write_text_approval(
    approval_id: &str,
    request: &WriteTextFileRequest,
) -> Result<PendingWriteTextApproval, String> {
    let target = resolve_text_target_path(&request.target_path, request.workspace_path.as_deref())?;
    let target_path = normalize_path(&target);
    ensure_text_target_is_new_file(&target)?;
    let previous_hash = None;
    let action = "create".to_string();
    let content_hash = create_fnv1a_hash(request.content.as_bytes());
    Ok(PendingWriteTextApproval {
        binding: create_native_approval_binding(
            approval_id.to_string(),
            WRITE_TEXT_APPROVAL_TOOL_NAME,
            request
                .task_id
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_string(),
            create_write_text_preview_hash(
                &target_path,
                &action,
                &content_hash,
                previous_hash.as_deref(),
            ),
            false,
        ),
        target_path,
        content: request.content.clone(),
        action,
        previous_hash,
    })
}

#[allow(dead_code)]
pub(crate) fn store_pending_write_text_approval(
    approval_state: &Mutex<WriteTextApprovalState>,
    approval: PendingWriteTextApproval,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Text write approval state could not be locked.".to_string())?;
    state.pending = Some(approval);
    Ok(())
}

fn create_text_write_plan_from_pending(
    approval_id: &str,
    pending: &PendingWriteTextApproval,
) -> TextFileWritePlan {
    let content_hash = create_fnv1a_hash(pending.content.as_bytes());
    TextFileWritePlan {
        approval_id: approval_id.to_string(),
        target_path: pending.target_path.clone(),
        action: pending.action.clone(),
        byte_count: pending.content.as_bytes().len(),
        content_hash: content_hash.clone(),
        dry_run: FileDryRunSummary {
            operation: "Write text file".to_string(),
            affected_paths: vec![PlannedPathOperation {
                source: String::new(),
                target: pending.target_path.clone(),
                action: pending.action.clone(),
                conflict: pending
                    .previous_hash
                    .is_some()
                    .then(|| "Target file exists and will be overwritten if approved.".to_string()),
            }],
            risk_summary:
                "Preview only. The file is written only after the current dry-run is approved."
                    .to_string(),
            reversible: pending.previous_hash.is_none(),
        },
    }
}

#[allow(dead_code)]
pub(crate) fn write_text_file(
    target: &Path,
    content: &str,
    action: &str,
    approved_previous_hash: Option<&str>,
) -> Result<TextFileWriteResult, String> {
    write_text_file_with_workspace(target, content, action, approved_previous_hash, None)
}

fn write_text_file_with_workspace(
    target: &Path,
    content: &str,
    action: &str,
    approved_previous_hash: Option<&str>,
    workspace_scope: Option<&Path>,
) -> Result<TextFileWriteResult, String> {
    if action != "create" || approved_previous_hash.is_some() {
        return Err("Only new text-file creation is supported in v1.".to_string());
    }
    match fs::symlink_metadata(target) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Text write target cannot be a symlink.".to_string());
            }
            return Err("Target file now exists; create approval is stale.".to_string());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Text write target cannot be inspected: {error}")),
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Target directory could not be created: {error}"))?;
        if let Some(workspace) = workspace_scope {
            ensure_target_path_stays_in_workspace(workspace, target)?;
        }
        if fs::symlink_metadata(parent)
            .map_err(|error| format!("Target directory cannot be inspected: {error}"))?
            .file_type()
            .is_symlink()
        {
            return Err("Text write target directory cannot be a symlink.".to_string());
        }
    } else {
        return Err("Target path does not include a parent directory.".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| format!("Text file could not be created: {error}"))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Text file could not be written: {error}"))?;
    Ok(TextFileWriteResult {
        target_path: normalize_path(target),
        action: action.to_string(),
        byte_count: content.as_bytes().len(),
        status: "written".to_string(),
        message: "Text file written successfully.".to_string(),
    })
}

fn resolve_text_target_path(
    target_path: &str,
    workspace_path: Option<&str>,
) -> Result<PathBuf, String> {
    let trimmed = target_path.trim();
    if trimmed.is_empty() {
        return Err("Target path cannot be empty.".to_string());
    }
    let requested = PathBuf::from(trimmed);
    if has_parent_dir_component(&requested) {
        return Err(
            "Text write target path cannot contain parent directory traversal.".to_string(),
        );
    }
    if requested.is_absolute() || has_windows_prefix(&requested) {
        return Err("Text write target path must be workspace-relative.".to_string());
    }
    let workspace = resolve_workspace_path(workspace_path.map(str::to_string))
        .map_err(|error| error.to_string())?;
    let target = workspace.join(requested);
    ensure_target_path_stays_in_workspace(&workspace, &target)?;
    Ok(target)
}

fn read_existing_file_hash(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(error) => return Err(format!("Text write target cannot be inspected: {error}")),
    };
    if metadata.file_type().is_symlink() {
        return Err("Text write target cannot be a symlink.".to_string());
    }
    if !metadata.is_file() {
        return Err("Text write target already exists and is not a file.".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("Target file cannot be read: {error}"))?;
    Ok(Some(create_fnv1a_hash(&bytes)))
}

fn ensure_text_target_is_new_file(path: &Path) -> Result<(), String> {
    if read_existing_file_hash(path)?.is_none() {
        return Ok(());
    }
    Err("Text write target already exists; overwriting is not supported in v1.".to_string())
}

fn ensure_target_path_stays_in_workspace(workspace: &Path, target: &Path) -> Result<(), String> {
    let workspace = fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace path cannot be canonicalized: {error}"))?;
    let existing_ancestor = nearest_existing_ancestor(target)
        .ok_or_else(|| "Text write target has no accessible parent directory.".to_string())?;
    let ancestor = fs::canonicalize(existing_ancestor)
        .map_err(|error| format!("Text write target parent cannot be canonicalized: {error}"))?;
    if !ancestor.starts_with(&workspace) {
        return Err("Text write target must stay inside the selected workspace.".to_string());
    }
    Ok(())
}

fn nearest_existing_ancestor(path: &Path) -> Option<&Path> {
    let mut current = path.parent();
    while let Some(candidate) = current {
        if candidate.exists() {
            return Some(candidate);
        }
        current = candidate.parent();
    }
    None
}

fn create_write_text_preview_hash(
    target_path: &str,
    action: &str,
    content_hash: &str,
    previous_hash: Option<&str>,
) -> String {
    create_fnv1a_hash(
        format!(
            "{}\n{}\n{}\n{}",
            target_path,
            action,
            content_hash,
            previous_hash.unwrap_or("")
        )
        .as_bytes(),
    )
}

fn pending_preview_hash(pending: &PendingWriteTextApproval) -> String {
    create_write_text_preview_hash(
        &pending.target_path,
        &pending.action,
        &create_fnv1a_hash(pending.content.as_bytes()),
        pending.previous_hash.as_deref(),
    )
}

fn has_parent_dir_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn has_windows_prefix(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::Prefix(_)))
}
