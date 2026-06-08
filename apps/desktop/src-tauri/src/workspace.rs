use std::path::PathBuf;
use tauri::Manager;

use crate::error::JavisError;

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
pub(crate) fn save_workspace_definition(
    app_handle: tauri::AppHandle,
    definition: serde_json::Value,
) -> Result<(), String> {
    save_workspace_definition_impl(&app_handle, definition).map_err(|e| e.to_string())
}

fn save_workspace_definition_impl(
    app_handle: &tauri::AppHandle,
    definition: serde_json::Value,
) -> Result<(), JavisError> {
    let workspaces_dir = get_workspaces_dir(app_handle)?;
    std::fs::create_dir_all(&workspaces_dir)?;
    let id = definition["id"].as_str().ok_or_else(|| {
        JavisError::Validation("Missing 'id' field in workspace definition".into())
    })?;
    validate_workspace_id(id)?;
    let path = workspaces_dir.join(format!("{id}.workspace.json"));
    let tmp_path = workspaces_dir.join(format!("{id}.workspace.json.tmp"));
    let content = serde_json::to_string_pretty(&definition)?;
    std::fs::write(&tmp_path, &content)?;
    std::fs::rename(&tmp_path, &path)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_workspace_definition(
    app_handle: tauri::AppHandle,
    workspace_id: String,
) -> Result<(), String> {
    delete_workspace_definition_impl(&app_handle, &workspace_id).map_err(|e| e.to_string())
}

fn delete_workspace_definition_impl(
    app_handle: &tauri::AppHandle,
    workspace_id: &str,
) -> Result<(), JavisError> {
    validate_workspace_id(workspace_id)?;
    let workspaces_dir = get_workspaces_dir(app_handle)?;
    let path = workspaces_dir.join(format!("{workspace_id}.workspace.json"));
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
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
}
