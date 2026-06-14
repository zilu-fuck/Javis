use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

use crate::{
    audit::{append_jsonl_line_to_path, task_audit_jsonl_path},
    resolve_command_program, resolve_workspace_path,
    sandbox::{
        read_only_policy, run_sandboxed_command, sandbox_audit_jsonl_line_for_output,
        SandboxCommandRequest, SandboxReport,
    },
};

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
    sandbox: SandboxReport,
}

#[tauri::command]
pub(crate) fn run_read_only_command(
    app: AppHandle,
    request: ShellCommandRequest,
) -> Result<ShellCommandOutput, String> {
    let audit_path = task_audit_jsonl_path(&app)?;
    run_read_only_command_with_audit_path(request, Some(&audit_path))
}

pub(crate) fn run_read_only_command_with_audit_path(
    request: ShellCommandRequest,
    audit_path: Option<&Path>,
) -> Result<ShellCommandOutput, String> {
    if !is_allowed_read_only_command(&request.program, &request.args) {
        return Err("Command is not in the first-version read-only allowlist.".to_string());
    }

    let cwd = resolve_workspace_path(request.workspace_path)?;
    let output = run_sandboxed_command(SandboxCommandRequest {
        program: request.program,
        args: request.args,
        cwd: cwd.clone(),
        policy: read_only_policy(&cwd),
        env: Vec::new(),
        stdin: None,
        timeout_ms: None,
    })
    .map_err(|error| error.to_string())?;
    if let Some(audit_path) = audit_path {
        let line = sandbox_audit_jsonl_line_for_output(&output, None)
            .map_err(|error| error.to_string())?;
        append_jsonl_line_to_path(audit_path, &line, "Sandbox audit")
            .map_err(|error| error.to_string())?;
    }

    Ok(ShellCommandOutput {
        command: output.command,
        cwd: output.cwd,
        exit_code: output.exit_code,
        stdout: output.stdout.trim().to_string(),
        stderr: output.stderr.trim().to_string(),
        sandbox: output.sandbox,
    })
}

pub(crate) fn resolve_trusted_read_only_executable(
    program: &str,
    cwd: &Path,
) -> Result<PathBuf, String> {
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

pub(crate) fn read_only_command_args(program: &str, args: &[String]) -> Vec<String> {
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
    use std::{fs, process::Command};

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

    #[test]
    fn read_only_command_returns_policy_only_sandbox_report() {
        let workspace = tempfile::tempdir().unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(workspace.path())
            .output()
            .expect("git init");

        let audit_path = workspace.path().join("task-audit.jsonl");
        let output = run_read_only_command_with_audit_path(
            ShellCommandRequest {
                program: "git".to_string(),
                args: vec!["status".to_string(), "--short".to_string()],
                workspace_path: Some(workspace.path().to_string_lossy().to_string()),
            },
            Some(&audit_path),
        )
        .expect("read-only command");

        assert_eq!(output.command, "git status --short");
        assert!(!output.sandbox.enforced);
        assert_eq!(
            output.sandbox.backend,
            crate::sandbox::SandboxBackend::PolicyOnly
        );
        assert_eq!(output.sandbox.mode, crate::sandbox::SandboxMode::ReadOnly);
        let audit = fs::read_to_string(audit_path).expect("read sandbox audit");
        assert!(audit.contains("\"kind\":\"sandbox_process\""));
        assert!(audit.contains("\"backend\":\"policy_only\""));
        assert!(audit.contains("\"enforced\":false"));
    }
}
