use ignore::WalkBuilder;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter};

use crate::{normalize_path, resolve_command_program, resolve_workspace_path};

#[derive(Default)]
pub(crate) struct FileWatchState {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesSearchRequest {
    session_id: String,
    workspace_root: String,
    query: String,
    max_results: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesWatchRequest {
    session_id: String,
    workspace_root: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileSearchResult {
    path: String,
    line: Option<usize>,
    preview: Option<String>,
    provider: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FilesChangedEvent {
    session_id: String,
    workspace_root: String,
    paths: Vec<String>,
}

#[tauri::command]
pub(crate) fn files_search(request: FilesSearchRequest) -> Result<Vec<FileSearchResult>, String> {
    let _ = request.session_id.as_str();
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let query = request.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let max_results = request.max_results.unwrap_or(80).min(200);
    search_with_rg(&cwd, query, max_results)
        .or_else(|_| search_with_ignore(&cwd, query, max_results))
}

#[tauri::command]
pub(crate) fn files_watch_start(
    app: AppHandle,
    state: tauri::State<'_, FileWatchState>,
    request: FilesWatchRequest,
) -> Result<(), String> {
    let root = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let root_label = normalize_path(&root);
    let key = format!("{}:{}", request.session_id, root_label);

    let event_session_id = request.session_id.clone();
    let event_root = root_label.clone();
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        let paths = event
            .paths
            .into_iter()
            .map(|path| normalize_path(&path))
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return;
        }
        let _ = app_handle.emit(
            "files://changed",
            FilesChangedEvent {
                session_id: event_session_id.clone(),
                workspace_root: event_root.clone(),
                paths,
            },
        );
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;

    let mut watchers = state
        .watchers
        .lock()
        .map_err(|error| format!("Failed to lock file watcher state: {error}"))?;
    watchers.insert(key, watcher);
    Ok(())
}

#[tauri::command]
pub(crate) fn files_watch_stop(
    state: tauri::State<'_, FileWatchState>,
    request: FilesWatchRequest,
) -> Result<(), String> {
    let root = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let key = format!("{}:{}", request.session_id, normalize_path(&root));
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|error| format!("Failed to lock file watcher state: {error}"))?;
    watchers.remove(&key);
    Ok(())
}

fn search_with_rg(
    cwd: &Path,
    query: &str,
    max_results: usize,
) -> Result<Vec<FileSearchResult>, String> {
    let rg = resolve_trusted_search_program("rg", cwd)
        .ok_or_else(|| "Could not locate trusted rg executable.".to_string())?;
    let mut child = Command::new(rg)
        .args(["--line-number", "--no-heading", "--color", "never", "--"])
        .arg(query)
        .arg(".")
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to read rg stdout.".to_string())?;
    let reader = BufReader::new(stdout);
    let mut results = Vec::new();
    for line in reader.lines().map_while(Result::ok).take(max_results) {
        if let Some(result) = parse_rg_line(cwd, &line) {
            results.push(result);
        }
    }
    let _ = child.wait();
    Ok(results)
}

fn search_with_ignore(
    cwd: &Path,
    query: &str,
    max_results: usize,
) -> Result<Vec<FileSearchResult>, String> {
    let needle = query.to_ascii_lowercase();
    let mut results = Vec::new();
    for entry in WalkBuilder::new(cwd)
        .hidden(false)
        .git_ignore(true)
        .build()
        .filter_map(Result::ok)
    {
        if results.len() >= max_results {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.to_ascii_lowercase().contains(&needle) {
            results.push(FileSearchResult {
                path: normalize_path(path),
                line: None,
                preview: None,
                provider: "ignore".to_string(),
            });
            continue;
        }
        if let Ok(content) = fs::read_to_string(path) {
            if let Some((index, line)) = content
                .lines()
                .enumerate()
                .find(|(_, line)| line.to_ascii_lowercase().contains(&needle))
            {
                results.push(FileSearchResult {
                    path: normalize_path(path),
                    line: Some(index + 1),
                    preview: Some(line.trim().chars().take(240).collect()),
                    provider: "ignore".to_string(),
                });
            }
        }
    }
    Ok(results)
}

fn resolve_trusted_search_program(program: &str, cwd: &Path) -> Option<PathBuf> {
    let program = resolve_command_program(program);
    let candidate = PathBuf::from(&program);
    if candidate.is_absolute() && candidate.is_file() {
        return trusted_candidate(candidate, cwd);
    }

    let path_exts = executable_extensions();
    for dir in env::split_paths(&env::var_os("PATH")?) {
        if !dir.is_absolute() {
            continue;
        }
        let base = dir.join(&program);
        if let Some(candidate) = trusted_candidate(base, cwd) {
            return Some(candidate);
        }
        for ext in &path_exts {
            let with_ext = dir.join(format!("{program}{ext}"));
            if let Some(candidate) = trusted_candidate(with_ext, cwd) {
                return Some(candidate);
            }
        }
    }
    None
}

fn trusted_candidate(candidate: PathBuf, cwd: &Path) -> Option<PathBuf> {
    if !candidate.is_file() {
        return None;
    }
    let canonical = candidate.canonicalize().ok()?;
    let canonical_cwd = cwd.canonicalize().ok()?;
    if canonical.starts_with(canonical_cwd) {
        return None;
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

fn parse_rg_line(cwd: &Path, line: &str) -> Option<FileSearchResult> {
    let mut parts = line.splitn(3, ':');
    let path = parts.next()?;
    let line_number = parts.next()?.parse::<usize>().ok();
    let preview = parts
        .next()
        .map(|value| value.trim().chars().take(240).collect::<String>());
    Some(FileSearchResult {
        path: normalize_path(&PathBuf::from(cwd).join(path)),
        line: line_number,
        preview,
        provider: "rg".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_search_program_inside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let executable_name = if cfg!(windows) { "rg.cmd" } else { "rg" };
        fs::write(workspace.path().join(executable_name), "echo hijacked").unwrap();

        let result = trusted_candidate(workspace.path().join(executable_name), workspace.path());

        assert!(result.is_none());
    }
}
