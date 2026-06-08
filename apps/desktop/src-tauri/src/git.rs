use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{normalize_path, resolve_command_program, resolve_workspace_path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitWorkspaceRequest {
    session_id: String,
    workspace_root: String,
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

#[tauri::command]
pub(crate) fn git_status(request: GitWorkspaceRequest) -> Result<GitStatusSnapshot, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let status = git_output(&cwd, &["status", "--short"])?;
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
    let git = resolve_git_executable_for_workspace(cwd)?;
    let output = Command::new(git)
        .args(hardened_git_args(args))
        .current_dir(cwd)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn hardened_git_args(args: &[&str]) -> Vec<String> {
    let mut safe_args = vec![
        "-c".to_string(),
        "core.fsmonitor=false".to_string(),
        "-c".to_string(),
        "diff.external=".to_string(),
    ];
    safe_args.extend(args.iter().map(|arg| arg.to_string()));
    if matches!(
        args,
        ["diff", "--stat"]
            | ["diff", "--unified=1"]
            | ["diff", "--unified=1", "--cached"]
            | ["diff", "--unified=1", "--", _]
            | ["diff", "--unified=1", "--cached", "--", _]
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
}
