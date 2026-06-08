use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{normalize_path, resolve_command_program, resolve_workspace_path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellCommandRequest {
    program: String,
    args: Vec<String>,
    workspace_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellCommandOutput {
    command: String,
    cwd: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[tauri::command]
pub(crate) fn run_read_only_command(
    request: ShellCommandRequest,
) -> Result<ShellCommandOutput, String> {
    if !is_allowed_read_only_command(&request.program, &request.args) {
        return Err("Command is not in the first-version read-only allowlist.".to_string());
    }

    let cwd = resolve_workspace_path(request.workspace_path)?;
    let output = run_read_only_command_output(&request.program, &request.args, &cwd)?;

    Ok(ShellCommandOutput {
        command: format!("{} {}", request.program, request.args.join(" "))
            .trim()
            .to_string(),
        cwd: normalize_path(&cwd),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

pub(crate) fn run_read_only_command_output(
    program: &str,
    args: &[String],
    cwd: &Path,
) -> Result<std::process::Output, String> {
    let executable = resolve_trusted_read_only_executable(program, cwd)?;
    let safe_args = read_only_command_args(program, args);
    let mut output = Command::new(&executable)
        .args(&safe_args)
        .current_dir(cwd)
        .output()
        .map_err(|error| error.to_string())?;
    if is_retryable_windows_process_initialization_exit(output.status.code()) {
        output = Command::new(&executable)
            .args(&safe_args)
            .current_dir(cwd)
            .output()
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
}

fn resolve_trusted_read_only_executable(program: &str, cwd: &Path) -> Result<PathBuf, String> {
    let program = resolve_command_program(program);
    let cwd = cwd
        .canonicalize()
        .map_err(|error| format!("Could not resolve command workspace: {error}"))?;
    resolve_program_from_path(&program, &cwd)
        .ok_or_else(|| format!("Could not locate trusted executable for {program}."))
}

fn resolve_program_from_path(program: &str, cwd: &Path) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.is_absolute() && candidate.is_file() {
        return trusted_candidate(candidate, cwd);
    }

    let path_exts = executable_extensions();
    for dir in env::split_paths(&env::var_os("PATH")?) {
        if !dir.is_absolute() {
            continue;
        }
        let base = dir.join(program);
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

fn read_only_command_args(program: &str, args: &[String]) -> Vec<String> {
    if program.eq_ignore_ascii_case("git") {
        let mut safe_args = vec![
            "-c".to_string(),
            "core.fsmonitor=false".to_string(),
            "-c".to_string(),
            "diff.external=".to_string(),
        ];
        safe_args.extend(args.iter().cloned());
        if matches!(
            args.iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice(),
            ["diff", "--stat"] | ["diff", "--unified=1"] | ["diff", "--check"]
        ) {
            safe_args.push("--no-ext-diff".to_string());
            safe_args.push("--no-textconv".to_string());
        }
        return safe_args;
    }
    args.to_vec()
}

pub(crate) fn is_retryable_windows_process_initialization_exit(exit_code: Option<i32>) -> bool {
    #[cfg(windows)]
    {
        matches!(exit_code, Some(-1073741502))
    }
    #[cfg(not(windows))]
    {
        let _ = exit_code;
        false
    }
}

pub(crate) fn is_allowed_read_only_command(program: &str, args: &[String]) -> bool {
    let normalized_program = program.to_ascii_lowercase();
    let normalized_args = args.iter().map(String::as_str).collect::<Vec<_>>();

    matches!(
        (normalized_program.as_str(), normalized_args.as_slice()),
        ("node", ["--version"])
            | ("pnpm", ["--version"])
            | ("cargo", ["--version"])
            | ("git", ["status", "--short"])
            | ("git", ["diff", "--stat"])
            | ("git", ["diff", "--unified=1"])
            | ("git", ["diff", "--check"])
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn allows_git_status() {
        assert!(is_allowed_read_only_command(
            "git",
            &["status".into(), "--short".into()]
        ));
    }

    #[test]
    fn rejects_package_scripts_as_read_only() {
        assert!(!is_allowed_read_only_command("pnpm", &["typecheck".into()]));
        assert!(!is_allowed_read_only_command("pnpm", &["test".into()]));
        assert!(!is_allowed_read_only_command(
            "npm",
            &["run".into(), "typecheck".into()]
        ));
        assert!(!is_allowed_read_only_command("npm", &["test".into()]));
        assert!(!is_allowed_read_only_command("yarn", &["typecheck".into()]));
        assert!(!is_allowed_read_only_command("yarn", &["test".into()]));
    }

    #[test]
    fn allows_node_version() {
        assert!(is_allowed_read_only_command("node", &["--version".into()]));
    }

    #[test]
    fn allows_cargo_version() {
        assert!(is_allowed_read_only_command("cargo", &["--version".into()]));
    }

    #[test]
    fn rejects_unknown_program() {
        assert!(!is_allowed_read_only_command(
            "rm",
            &["-rf".into(), "/".into()]
        ));
    }

    #[test]
    fn rejects_git_push() {
        assert!(!is_allowed_read_only_command("git", &["push".into()]));
    }

    #[test]
    fn rejects_pnpm_install() {
        assert!(!is_allowed_read_only_command("pnpm", &["install".into()]));
    }

    #[test]
    fn normalizes_program_case() {
        assert!(is_allowed_read_only_command(
            "GIT",
            &["status".into(), "--short".into()]
        ));
        assert!(is_allowed_read_only_command("Pnpm", &["--version".into()]));
    }

    #[test]
    fn hardens_git_read_only_invocations() {
        assert_eq!(
            read_only_command_args("git", &["status".into(), "--short".into()]),
            vec![
                "-c",
                "core.fsmonitor=false",
                "-c",
                "diff.external=",
                "status",
                "--short"
            ]
        );
        assert_eq!(
            read_only_command_args("git", &["diff".into(), "--stat".into()]),
            vec![
                "-c",
                "core.fsmonitor=false",
                "-c",
                "diff.external=",
                "diff",
                "--stat",
                "--no-ext-diff",
                "--no-textconv"
            ]
        );
    }

    #[test]
    fn rejects_read_only_executable_from_workspace_path() {
        let workspace = tempfile::tempdir().unwrap();
        let executable_name = if cfg!(windows) { "git.cmd" } else { "git" };
        fs::write(workspace.path().join(executable_name), "echo hijacked").unwrap();

        let result = trusted_candidate(workspace.path().join(executable_name), workspace.path());

        assert!(result.is_none());
    }
}
