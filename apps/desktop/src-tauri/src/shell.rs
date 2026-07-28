use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::AppHandle;

use crate::{
    approve_native_approval_binding,
    audit::{append_jsonl_line_to_path, task_audit_jsonl_path},
    create_approval_id, create_fnv1a_hash, create_native_approval_binding, normalize_path,
    redact_secret_like_text, require_native_approval_binding, resolve_command_program,
    resolve_workspace_path,
    sandbox::{
        read_only_policy, run_sandboxed_command, sandbox_audit_jsonl_line_for_output,
        workspace_write_policy, SandboxCommandRequest, SandboxReport,
    },
    NativeApprovalBinding,
};

const WORKSPACE_COMMAND_TOOL_NAME: &str = "shell.runWorkspaceCommand";
const WORKSPACE_COMMAND_TIMEOUT_MS: u64 = 10 * 60 * 1000;

#[derive(Default)]
pub(crate) struct WorkspaceCommandApprovalState {
    pending: HashMap<String, PendingWorkspaceCommand>,
}

struct PendingWorkspaceCommand {
    binding: NativeApprovalBinding,
    program: String,
    args: Vec<String>,
    cwd: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShellCommandRequest {
    program: String,
    args: Vec<String>,
    workspace_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCommandPlanRequest {
    task_id: String,
    program: String,
    args: Vec<String>,
    workspace_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCommandApproveRequest {
    approval_id: String,
    task_id: String,
    preview_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCommandRunRequest {
    approval_id: String,
    task_id: String,
    program: String,
    args: Vec<String>,
    workspace_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceCommandPlanResult {
    approval_id: String,
    task_id: String,
    tool_name: String,
    preview_hash: String,
    command: String,
    cwd: String,
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
pub(crate) fn plan_workspace_command(
    approval_state: tauri::State<'_, Mutex<WorkspaceCommandApprovalState>>,
    request: WorkspaceCommandPlanRequest,
) -> Result<WorkspaceCommandPlanResult, String> {
    if !is_allowed_workspace_command(&request.program, &request.args) {
        return Err("Command is not in the approved workspace-command allowlist.".to_string());
    }
    let cwd = resolve_workspace_path(request.workspace_path)?;
    let cwd = normalize_path(&cwd);
    let preview_hash = workspace_command_preview_hash(&cwd, &request.program, &request.args)?;
    let approval_id = create_approval_id();
    let pending = PendingWorkspaceCommand {
        binding: create_native_approval_binding(
            approval_id.clone(),
            WORKSPACE_COMMAND_TOOL_NAME,
            request.task_id.clone(),
            preview_hash.clone(),
            false,
        ),
        program: request.program.clone(),
        args: request.args.clone(),
        cwd: cwd.clone(),
    };
    approval_state
        .lock()
        .map_err(|_| "Workspace command approval state could not be locked.".to_string())?
        .pending
        .insert(approval_id.clone(), pending);
    Ok(WorkspaceCommandPlanResult {
        approval_id,
        task_id: request.task_id,
        tool_name: WORKSPACE_COMMAND_TOOL_NAME.to_string(),
        preview_hash,
        command: format_workspace_command(&request.program, &request.args),
        cwd,
    })
}

#[tauri::command]
pub(crate) fn approve_workspace_command(
    approval_state: tauri::State<'_, Mutex<WorkspaceCommandApprovalState>>,
    request: WorkspaceCommandApproveRequest,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Workspace command approval state could not be locked.".to_string())?;
    approve_pending_workspace_command(&mut state, &request)
}

#[tauri::command]
pub(crate) fn run_approved_workspace_command(
    app: AppHandle,
    approval_state: tauri::State<'_, Mutex<WorkspaceCommandApprovalState>>,
    request: WorkspaceCommandRunRequest,
) -> Result<ShellCommandOutput, String> {
    if !is_allowed_workspace_command(&request.program, &request.args) {
        return Err("Command is not in the approved workspace-command allowlist.".to_string());
    }
    let cwd_path = resolve_workspace_path(request.workspace_path.clone())?;
    let cwd = normalize_path(&cwd_path);
    let preview_hash = workspace_command_preview_hash(&cwd, &request.program, &request.args)?;
    {
        let mut state = approval_state
            .lock()
            .map_err(|_| "Workspace command approval state could not be locked.".to_string())?;
        consume_pending_workspace_command(&mut state, &request, &cwd, &preview_hash)?;
    }

    let output = run_sandboxed_command(SandboxCommandRequest {
        program: request.program,
        args: request.args,
        cwd: cwd_path.clone(),
        policy: workspace_write_policy(&cwd_path, vec![cwd_path.clone()]),
        env: Vec::new(),
        stdin: None,
        timeout_ms: Some(WORKSPACE_COMMAND_TIMEOUT_MS),
    })
    .map_err(|error| redact_secret_like_text(&error.to_string()))?;
    let audit_path = task_audit_jsonl_path(&app)?;
    let line = sandbox_audit_jsonl_line_for_output(&output, Some(request.approval_id.clone()))
        .map_err(|error| redact_secret_like_text(&error.to_string()))?;
    append_jsonl_line_to_path(&audit_path, &line, "Sandbox audit")
        .map_err(|error| redact_secret_like_text(&error.to_string()))?;

    Ok(ShellCommandOutput {
        command: output.command,
        cwd: output.cwd,
        exit_code: output.exit_code,
        stdout: output.stdout.trim().to_string(),
        stderr: redact_secret_like_text(output.stderr.trim()),
        sandbox: output.sandbox,
    })
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
    .map_err(|error| redact_secret_like_text(&error.to_string()))?;
    if let Some(audit_path) = audit_path {
        let line = sandbox_audit_jsonl_line_for_output(&output, None)
            .map_err(|error| redact_secret_like_text(&error.to_string()))?;
        append_jsonl_line_to_path(audit_path, &line, "Sandbox audit")
            .map_err(|error| redact_secret_like_text(&error.to_string()))?;
    }

    Ok(ShellCommandOutput {
        command: output.command,
        cwd: output.cwd,
        exit_code: output.exit_code,
        stdout: output.stdout.trim().to_string(),
        stderr: redact_secret_like_text(output.stderr.trim()),
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

pub(crate) fn is_allowed_workspace_command(program: &str, args: &[String]) -> bool {
    let normalized_program = program.to_ascii_lowercase();
    if args.iter().any(|arg| !is_safe_workspace_command_arg(arg)) {
        return false;
    }
    match normalized_program.as_str() {
        "pnpm" => is_allowed_pnpm_workspace_command(args),
        "cargo" => matches!(args.first().map(String::as_str), Some("test" | "check")),
        _ => false,
    }
}

fn is_allowed_pnpm_workspace_command(args: &[String]) -> bool {
    let mut index = 0;
    if args.get(index).map(String::as_str) == Some("--filter") {
        let Some(package) = args.get(index + 1) else {
            return false;
        };
        if !is_safe_package_filter(package) {
            return false;
        }
        index += 2;
    }
    if args.get(index).map(String::as_str) == Some("run") {
        index += 1;
    }
    matches!(
        args.get(index).map(String::as_str),
        Some("test" | "typecheck" | "check")
    )
}

fn is_safe_package_filter(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && !value.contains("..")
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '@' | '/' | '.' | '_' | '-'))
}

fn is_safe_workspace_command_arg(value: &str) -> bool {
    if value.len() > 500 || value.chars().any(char::is_control) {
        return false;
    }
    let normalized = value.replace('\\', "/");
    let has_parent_traversal = normalized.split('/').any(|segment| segment == "..");
    let has_absolute_path =
        normalized.starts_with('/') || normalized.as_bytes().get(1) == Some(&b':');
    let lower = normalized.to_ascii_lowercase();
    let redirects_cargo_scope = ["--manifest-path", "--target-dir", "--config"]
        .iter()
        .any(|flag| lower == *flag || lower.starts_with(&format!("{flag}=")));
    !has_parent_traversal && !has_absolute_path && !redirects_cargo_scope
}

fn approve_pending_workspace_command(
    state: &mut WorkspaceCommandApprovalState,
    request: &WorkspaceCommandApproveRequest,
) -> Result<(), String> {
    let pending = state
        .pending
        .get_mut(&request.approval_id)
        .ok_or_else(|| "Workspace command approval was not found.".to_string())?;
    approve_native_approval_binding(
        &mut pending.binding,
        &request.approval_id,
        WORKSPACE_COMMAND_TOOL_NAME,
        Some(&request.task_id),
        &request.preview_hash,
        "Workspace command approval id does not match the pending preview.",
    )
}

fn consume_pending_workspace_command(
    state: &mut WorkspaceCommandApprovalState,
    request: &WorkspaceCommandRunRequest,
    cwd: &str,
    preview_hash: &str,
) -> Result<(), String> {
    let pending = state
        .pending
        .get(&request.approval_id)
        .ok_or_else(|| "No approved workspace command is pending.".to_string())?;
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        WORKSPACE_COMMAND_TOOL_NAME,
        Some(&request.task_id),
        preview_hash,
        "Workspace command approval id does not match the pending preview.",
        "Workspace command preview has not been approved.",
    )
    .map_err(|error| error.to_string())?;
    if pending.program != request.program || pending.args != request.args || pending.cwd != cwd {
        return Err("Approved workspace command does not match the current request.".to_string());
    }
    state.pending.remove(&request.approval_id);
    Ok(())
}

fn workspace_command_preview_hash(
    cwd: &str,
    program: &str,
    args: &[String],
) -> Result<String, String> {
    let payload = serde_json::to_vec(&(cwd, program, args))
        .map_err(|error| format!("Could not serialize workspace command preview: {error}"))?;
    Ok(create_fnv1a_hash(&payload))
}

fn format_workspace_command(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(|part| {
            if part.chars().any(char::is_whitespace) {
                format!("\"{}\"", part.replace('"', "\\\""))
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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
    fn allows_only_governed_workspace_verification_commands() {
        assert!(is_allowed_workspace_command("pnpm", &["test".into()]));
        assert!(is_allowed_workspace_command(
            "pnpm",
            &[
                "--filter".into(),
                "@javis/core".into(),
                "run".into(),
                "typecheck".into(),
                "--".into(),
                "--run".into(),
                "src/example.test.ts".into(),
            ],
        ));
        assert!(is_allowed_workspace_command(
            "cargo",
            &["test".into(), "shell::tests".into()],
        ));
        assert!(is_allowed_workspace_command(
            "cargo",
            &["check".into(), "--tests".into()],
        ));
    }

    #[test]
    fn rejects_ungoverned_or_out_of_workspace_commands() {
        assert!(!is_allowed_workspace_command("pnpm", &["build".into()]));
        assert!(!is_allowed_workspace_command(
            "pnpm",
            &["run".into(), "dev".into()],
        ));
        assert!(!is_allowed_workspace_command("cargo", &["run".into()]));
        assert!(!is_allowed_workspace_command(
            "cargo",
            &[
                "test".into(),
                "--manifest-path".into(),
                "../outside/Cargo.toml".into(),
            ],
        ));
        assert!(!is_allowed_workspace_command(
            "cargo",
            &["check".into(), "--target-dir=C:/outside".into()],
        ));
        assert!(!is_allowed_workspace_command(
            "pnpm",
            &["--filter".into(), "../outside".into(), "test".into()],
        ));
    }

    fn workspace_command_approval_fixture() -> (
        WorkspaceCommandApprovalState,
        WorkspaceCommandApproveRequest,
        WorkspaceCommandRunRequest,
        String,
    ) {
        let approval_id = "approval-workspace-command".to_string();
        let task_id = "task-workspace-command".to_string();
        let cwd = "E:/Javis".to_string();
        let program = "pnpm".to_string();
        let args = vec![
            "--filter".to_string(),
            "@javis/core".to_string(),
            "test".to_string(),
        ];
        let preview_hash = workspace_command_preview_hash(&cwd, &program, &args).unwrap();
        let mut state = WorkspaceCommandApprovalState::default();
        state.pending.insert(
            approval_id.clone(),
            PendingWorkspaceCommand {
                binding: create_native_approval_binding(
                    approval_id.clone(),
                    WORKSPACE_COMMAND_TOOL_NAME,
                    task_id.clone(),
                    preview_hash.clone(),
                    false,
                ),
                program: program.clone(),
                args: args.clone(),
                cwd: cwd.clone(),
            },
        );
        (
            state,
            WorkspaceCommandApproveRequest {
                approval_id: approval_id.clone(),
                task_id: task_id.clone(),
                preview_hash: preview_hash.clone(),
            },
            WorkspaceCommandRunRequest {
                approval_id,
                task_id,
                program,
                args,
                workspace_path: None,
            },
            cwd,
        )
    }

    #[test]
    fn workspace_command_approval_rejects_wrong_task_and_hash() {
        let (mut state, mut approval, _, _) = workspace_command_approval_fixture();
        approval.task_id = "wrong-task".to_string();
        assert!(approve_pending_workspace_command(&mut state, &approval)
            .unwrap_err()
            .contains("task"));

        let (mut state, mut approval, _, _) = workspace_command_approval_fixture();
        approval.preview_hash = "wrong-hash".to_string();
        assert!(approve_pending_workspace_command(&mut state, &approval)
            .unwrap_err()
            .contains("preview hash"));
    }

    #[test]
    fn workspace_command_approval_rejects_command_changes() {
        let (mut state, approval, mut request, cwd) = workspace_command_approval_fixture();
        approve_pending_workspace_command(&mut state, &approval).unwrap();
        request.args = vec!["check".to_string()];

        let error =
            consume_pending_workspace_command(&mut state, &request, &cwd, &approval.preview_hash)
                .unwrap_err();

        assert!(error.contains("does not match the current request"));
    }

    #[test]
    fn workspace_command_approval_is_consumed_once() {
        let (mut state, approval, request, cwd) = workspace_command_approval_fixture();
        approve_pending_workspace_command(&mut state, &approval).unwrap();
        consume_pending_workspace_command(&mut state, &request, &cwd, &approval.preview_hash)
            .unwrap();

        assert!(consume_pending_workspace_command(
            &mut state,
            &request,
            &cwd,
            &approval.preview_hash,
        )
        .unwrap_err()
        .contains("No approved workspace command is pending"));
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
