use serde::Deserialize;
use std::{fs, io::Write, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

use crate::error::JavisError;


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppendTaskAuditJsonLineRequest {
    line: String,
}


#[tauri::command]
pub(crate) fn append_task_audit_jsonl_line(
    app: AppHandle,
    request: AppendTaskAuditJsonLineRequest,
) -> Result<(), String> {
    let path = task_audit_jsonl_path(&app)?;
    append_jsonl_line_to_path(&path, &request.line, "Task audit").map_err(|e| e.to_string())
}


#[tauri::command]
pub(crate) fn append_task_session_jsonl_line(
    app: AppHandle,
    request: AppendTaskAuditJsonLineRequest,
) -> Result<(), String> {
    let path = task_session_jsonl_path(&app)?;
    append_jsonl_line_to_path(&path, &request.line, "Task session").map_err(|e| e.to_string())
}


pub(crate) fn task_audit_jsonl_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(data_dir.join("task-audit.jsonl"))
}


pub(crate) fn task_session_jsonl_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(data_dir.join("task-session.jsonl"))
}


pub(crate) fn append_jsonl_line_to_path(path: &Path, line: &str, label: &str) -> Result<(), JavisError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(JavisError::Validation(format!("{label} JSONL line cannot be empty.")));
    }
    if trimmed.lines().count() != 1 {
        return Err(JavisError::Validation(format!(
            "{label} JSONL append accepts exactly one JSON line."
        )));
    }
    serde_json::from_str::<serde_json::Value>(trimmed)
        .map_err(|e| JavisError::Validation(format!("{label} JSONL line must be valid JSON: {e}")))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| JavisError::Io(format!("Could not create {label} directory: {e}")))?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| JavisError::Io(format!("Could not open {label} JSONL file: {e}")))?;
    writeln!(file, "{trimmed}")
        .map_err(|e| JavisError::Io(format!("Could not append {label} JSONL line: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_jsonl_line() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("test.jsonl");
        let result = append_jsonl_line_to_path(&path, "", "Test");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("cannot be empty"));
    }

    #[test]
    fn rejects_multi_line_jsonl() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("test.jsonl");
        let result = append_jsonl_line_to_path(&path, "{\"a\":1}\n{\"b\":2}", "Test");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("exactly one JSON line"));
    }

    #[test]
    fn rejects_invalid_json() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("test.jsonl");
        let result = append_jsonl_line_to_path(&path, "not-valid-json", "Test");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("valid JSON"));
    }

    #[test]
    fn appends_valid_json_line() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("test.jsonl");
        append_jsonl_line_to_path(&path, "{\"kind\":\"test\"}", "Test").expect("append line");

        let content = std::fs::read_to_string(&path).expect("read file");
        assert_eq!(content.trim(), "{\"kind\":\"test\"}");
    }

    #[test]
    fn appends_multiple_lines() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("test.jsonl");
        append_jsonl_line_to_path(&path, "{\"kind\":\"first\"}", "Test").expect("append first");
        append_jsonl_line_to_path(&path, "{\"kind\":\"second\"}\n", "Test").expect("append second");

        let content = std::fs::read_to_string(&path).expect("read file");
        assert_eq!(content, "{\"kind\":\"first\"}\n{\"kind\":\"second\"}\n");
    }
}
