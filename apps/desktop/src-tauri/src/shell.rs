use serde::{Deserialize, Serialize};
use std::{path::Path, process::Command};

use crate::{resolve_workspace_path, resolve_command_program, normalize_path};


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
pub(crate) fn run_read_only_command(request: ShellCommandRequest) -> Result<ShellCommandOutput, String> {
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
    let executable = resolve_command_program(program);
    let mut output = Command::new(&executable)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| error.to_string())?;
    if is_retryable_windows_process_initialization_exit(output.status.code()) {
        output = Command::new(&executable)
            .args(args)
            .current_dir(cwd)
            .output()
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
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
            | ("pnpm", ["typecheck"])
            | ("pnpm", ["test"])
            | ("npm", ["run", "typecheck"])
            | ("npm", ["test"])
            | ("yarn", ["typecheck"])
            | ("yarn", ["test"])
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

    #[test]
    fn allows_git_status() {
        assert!(is_allowed_read_only_command("git", &["status".into(), "--short".into()]));
    }

    #[test]
    fn allows_pnpm_typecheck() {
        assert!(is_allowed_read_only_command("pnpm", &["typecheck".into()]));
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
        assert!(!is_allowed_read_only_command("rm", &["-rf".into(), "/".into()]));
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
        assert!(is_allowed_read_only_command("GIT", &["status".into(), "--short".into()]));
        assert!(is_allowed_read_only_command("Pnpm", &["test".into()]));
    }
}

