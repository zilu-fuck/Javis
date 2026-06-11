use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter};

use crate::{
    approve_native_approval_binding, create_approval_id, create_fnv1a_hash,
    create_native_approval_binding, normalize_path, require_native_approval_binding,
    resolve_workspace_path, NativeApprovalBinding,
};

pub(crate) struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
    approvals: Mutex<HashMap<String, PendingTerminalApproval>>,
}

impl TerminalState {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            approvals: Mutex::new(HashMap::new()),
        }
    }
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send>,
}

struct PendingTerminalApproval {
    action: String,
    preview_hash: String,
    binding: NativeApprovalBinding,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCreateRequest {
    task_id: Option<String>,
    session_id: String,
    workspace_root: String,
    terminal_id: Option<String>,
    #[allow(dead_code)]
    permission_mode: Option<String>,
    approval_id: Option<String>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalInputRequest {
    task_id: Option<String>,
    terminal_id: String,
    data: String,
    #[allow(dead_code)]
    permission_mode: Option<String>,
    approval_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalResizeRequest {
    terminal_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalKillRequest {
    terminal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalPlanCreateRequest {
    task_id: Option<String>,
    session_id: String,
    workspace_root: String,
    terminal_id: Option<String>,
    shell: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalPlanInputRequest {
    task_id: Option<String>,
    terminal_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalApproveRequest {
    approval_id: String,
    task_id: Option<String>,
    action: String,
    preview_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCreateResult {
    terminal_id: String,
    cwd: String,
    shell: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalPlanResult {
    approval_id: String,
    tool_name: String,
    action: String,
    preview_hash: String,
    preview: TerminalApprovalPreview,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalApprovalPreview {
    terminal_id: Option<String>,
    workspace_root: Option<String>,
    shell: Option<String>,
    input_bytes: Option<usize>,
    input_hash: Option<String>,
    sends_enter: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalApproveResult {
    approval_id: String,
    approved: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    terminal_id: String,
    session_id: String,
    workspace_root: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    terminal_id: String,
    session_id: String,
    workspace_root: String,
    exit_code: Option<i32>,
}

#[tauri::command]
pub(crate) fn terminal_plan_create(
    state: tauri::State<'_, TerminalState>,
    request: TerminalPlanCreateRequest,
) -> Result<TerminalPlanResult, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root))?;
    let shell = request.shell.unwrap_or_else(default_shell);
    let terminal_id = request
        .terminal_id
        .unwrap_or_else(|| format!("term-{}", unique_nanos()));
    let payload = terminal_create_payload(
        &request.session_id,
        &normalize_path(&cwd),
        Some(&terminal_id),
        &shell,
    );
    register_terminal_approval(
        &state,
        request.task_id,
        "terminal.create",
        "create",
        payload,
        TerminalApprovalPreview {
            terminal_id: Some(terminal_id),
            workspace_root: Some(normalize_path(&cwd)),
            shell: Some(shell),
            input_bytes: None,
            input_hash: None,
            sends_enter: None,
        },
    )
}

#[tauri::command]
pub(crate) fn terminal_plan_input(
    state: tauri::State<'_, TerminalState>,
    request: TerminalPlanInputRequest,
) -> Result<TerminalPlanResult, String> {
    let input_hash = create_fnv1a_hash(request.data.as_bytes());
    let input_bytes = request.data.len();
    let sends_enter = request.data.ends_with('\n') || request.data.ends_with('\r');
    let payload =
        terminal_input_payload(&request.terminal_id, &input_hash, input_bytes, sends_enter);
    register_terminal_approval(
        &state,
        request.task_id,
        "terminal.input",
        "input",
        payload,
        TerminalApprovalPreview {
            terminal_id: Some(request.terminal_id),
            workspace_root: None,
            shell: None,
            input_bytes: Some(input_bytes),
            input_hash: Some(input_hash),
            sends_enter: Some(sends_enter),
        },
    )
}

#[tauri::command]
pub(crate) fn terminal_approve(
    state: tauri::State<'_, TerminalState>,
    request: TerminalApproveRequest,
) -> Result<TerminalApproveResult, String> {
    let tool_name = terminal_tool_name(&request.action)?;
    let mut approvals = state
        .approvals
        .lock()
        .map_err(|error| format!("Failed to lock terminal approval state: {error}"))?;
    let pending = approvals
        .get_mut(&request.approval_id)
        .ok_or_else(|| "Terminal approval was not found.".to_string())?;
    if pending.action != request.action {
        return Err("Terminal approval scope does not match this operation.".to_string());
    }
    approve_native_approval_binding(
        &mut pending.binding,
        &request.approval_id,
        tool_name,
        request.task_id.as_deref(),
        &request.preview_hash,
        "Terminal approval id does not match the pending operation.",
    )?;
    Ok(TerminalApproveResult {
        approval_id: request.approval_id,
        approved: true,
    })
}

#[tauri::command]
pub(crate) fn terminal_create(
    app: AppHandle,
    state: tauri::State<'_, TerminalState>,
    request: TerminalCreateRequest,
) -> Result<TerminalCreateResult, String> {
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let _ = request.shell.as_deref();
    let shell = default_shell();
    let terminal_id = request
        .terminal_id
        .unwrap_or_else(|| format!("term-{}", unique_nanos()));
    let payload = terminal_create_payload(
        &request.session_id,
        &normalize_path(&cwd),
        Some(&terminal_id),
        &shell,
    );
    require_terminal_approval(
        &state,
        request.approval_id.as_deref(),
        request.task_id.as_deref(),
        "create",
        &payload,
    )?;
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: request.rows.unwrap_or(24).max(4),
            cols: request.cols.unwrap_or(80).max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut command = CommandBuilder::new(&shell);
    command.cwd(&cwd);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|error| error.to_string())?,
    ));

    let event_terminal_id = terminal_id.clone();
    let event_session_id = request.session_id.clone();
    let event_workspace_root = normalize_path(&cwd);
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_handle.emit(
                        "terminal://output",
                        TerminalOutputEvent {
                            terminal_id: event_terminal_id.clone(),
                            session_id: event_session_id.clone(),
                            workspace_root: event_workspace_root.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit(
            "terminal://exit",
            TerminalExitEvent {
                terminal_id: event_terminal_id,
                session_id: event_session_id,
                workspace_root: event_workspace_root,
                exit_code: None,
            },
        );
    });

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|error| format!("Failed to lock terminal state: {error}"))?;
    sessions.insert(
        terminal_id.clone(),
        TerminalSession {
            master: pair.master,
            writer,
            child,
        },
    );

    Ok(TerminalCreateResult {
        terminal_id,
        cwd: normalize_path(&cwd),
        shell,
    })
}

#[tauri::command]
pub(crate) fn terminal_input(
    state: tauri::State<'_, TerminalState>,
    request: TerminalInputRequest,
) -> Result<(), String> {
    let input_hash = create_fnv1a_hash(request.data.as_bytes());
    let payload = terminal_input_payload(
        &request.terminal_id,
        &input_hash,
        request.data.len(),
        request.data.ends_with('\n') || request.data.ends_with('\r'),
    );
    require_terminal_approval(
        &state,
        request.approval_id.as_deref(),
        request.task_id.as_deref(),
        "input",
        &payload,
    )?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|error| format!("Failed to lock terminal state: {error}"))?;
    let session = sessions
        .get(&request.terminal_id)
        .ok_or_else(|| format!("Terminal not found: {}", request.terminal_id))?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|error| format!("Failed to lock terminal writer: {error}"))?;
    writer
        .write_all(request.data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn terminal_resize(
    state: tauri::State<'_, TerminalState>,
    request: TerminalResizeRequest,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|error| format!("Failed to lock terminal state: {error}"))?;
    let session = sessions
        .get(&request.terminal_id)
        .ok_or_else(|| format!("Terminal not found: {}", request.terminal_id))?;
    session
        .master
        .resize(PtySize {
            rows: request.rows.max(4),
            cols: request.cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn terminal_kill(
    state: tauri::State<'_, TerminalState>,
    request: TerminalKillRequest,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|error| format!("Failed to lock terminal state: {error}"))?;
    if let Some(mut session) = sessions.remove(&request.terminal_id) {
        session.child.kill().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string())
    }
}

#[cfg(test)]
fn ensure_terminal_permission(permission_mode: Option<&str>) -> Result<(), String> {
    match permission_mode {
        Some("confirmed_write") | Some("full_access") | Some("read_only") => Err(
            "Interactive terminal requires native approval and is disabled until terminal approvals are implemented."
                .to_string(),
        ),
        Some(other) => Err(format!("Unknown terminal permission mode: {other}")),
        None => Err("Interactive terminal requires native approval.".to_string()),
    }
}

fn terminal_tool_name(action: &str) -> Result<&'static str, String> {
    match action {
        "create" => Ok("terminal.create"),
        "input" => Ok("terminal.input"),
        other => Err(format!("Unsupported terminal action: {other}")),
    }
}

fn terminal_create_payload(
    session_id: &str,
    workspace_root: &str,
    terminal_id: Option<&str>,
    shell: &str,
) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "workspaceRoot": workspace_root,
        "terminalId": terminal_id,
        "shell": shell,
    })
}

fn terminal_input_payload(
    terminal_id: &str,
    input_hash: &str,
    input_bytes: usize,
    sends_enter: bool,
) -> serde_json::Value {
    serde_json::json!({
        "terminalId": terminal_id,
        "inputHash": input_hash,
        "inputBytes": input_bytes,
        "sendsEnter": sends_enter,
    })
}

fn terminal_preview_hash(action: &str, payload: &serde_json::Value) -> String {
    create_fnv1a_hash(
        serde_json::json!({
            "action": action,
            "payload": payload,
        })
        .to_string()
        .as_bytes(),
    )
}

fn register_terminal_approval(
    state: &TerminalState,
    task_id: Option<String>,
    tool_name: &str,
    action: &str,
    payload: serde_json::Value,
    preview: TerminalApprovalPreview,
) -> Result<TerminalPlanResult, String> {
    let approval_id = create_approval_id();
    let preview_hash = terminal_preview_hash(action, &payload);
    let binding = create_native_approval_binding(
        approval_id.clone(),
        tool_name,
        task_id.unwrap_or_default(),
        preview_hash.clone(),
        false,
    );
    let mut approvals = state
        .approvals
        .lock()
        .map_err(|error| format!("Failed to lock terminal approval state: {error}"))?;
    approvals.insert(
        approval_id.clone(),
        PendingTerminalApproval {
            action: action.to_string(),
            preview_hash: preview_hash.clone(),
            binding,
        },
    );
    Ok(TerminalPlanResult {
        approval_id,
        tool_name: tool_name.to_string(),
        action: action.to_string(),
        preview_hash,
        preview,
    })
}

fn require_terminal_approval(
    state: &TerminalState,
    approval_id: Option<&str>,
    task_id: Option<&str>,
    action: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let approval_id = approval_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Interactive terminal requires native approval id.".to_string())?;
    let preview_hash = terminal_preview_hash(action, payload);
    let tool_name = terminal_tool_name(action)?;
    let mut approvals = state
        .approvals
        .lock()
        .map_err(|error| format!("Failed to lock terminal approval state: {error}"))?;
    let pending = approvals
        .remove(approval_id)
        .ok_or_else(|| "Terminal approval was not found or was already used.".to_string())?;
    if pending.action != action {
        return Err("Terminal approval scope does not match this operation.".to_string());
    }
    if pending.preview_hash != preview_hash {
        return Err("Terminal approval preview hash does not match this operation.".to_string());
    }
    require_native_approval_binding(
        &pending.binding,
        approval_id,
        tool_name,
        task_id,
        &preview_hash,
        "Terminal approval id does not match the approved operation.",
        "Interactive terminal requires confirmed-write approval.",
    )
    .map_err(|error| error.to_string())
}

fn unique_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_permission_rejects_read_only() {
        assert!(ensure_terminal_permission(Some("read_only")).is_err());
        assert!(ensure_terminal_permission(None).is_err());
    }

    #[test]
    fn terminal_permission_rejects_self_reported_write_modes() {
        assert!(ensure_terminal_permission(Some("confirmed_write")).is_err());
        assert!(ensure_terminal_permission(Some("full_access")).is_err());
    }

    #[test]
    fn terminal_input_approval_allows_matching_payload_once() {
        let state = TerminalState::new();
        let input_hash = create_fnv1a_hash(b"echo ok\r\n");
        let payload = terminal_input_payload("term-1", &input_hash, "echo ok\r\n".len(), true);
        let plan = register_terminal_approval(
            &state,
            Some("task-1".to_string()),
            "terminal.input",
            "input",
            payload.clone(),
            TerminalApprovalPreview {
                terminal_id: Some("term-1".to_string()),
                workspace_root: None,
                shell: None,
                input_bytes: Some("echo ok\r\n".len()),
                input_hash: Some(input_hash),
                sends_enter: Some(true),
            },
        )
        .expect("plan terminal input");
        terminal_approve_inner_for_test(
            &state,
            &plan.approval_id,
            Some("task-1"),
            "input",
            &plan.preview_hash,
        )
        .expect("approve terminal input");

        require_terminal_approval(
            &state,
            Some(&plan.approval_id),
            Some("task-1"),
            "input",
            &payload,
        )
        .expect("matching terminal input approval should pass");
        assert!(require_terminal_approval(
            &state,
            Some(&plan.approval_id),
            Some("task-1"),
            "input",
            &payload,
        )
        .is_err());
    }

    #[test]
    fn terminal_input_approval_rejects_changed_input_hash() {
        let state = TerminalState::new();
        let input_hash = create_fnv1a_hash(b"echo ok\r\n");
        let payload = terminal_input_payload("term-1", &input_hash, "echo ok\r\n".len(), true);
        let plan = register_terminal_approval(
            &state,
            None,
            "terminal.input",
            "input",
            payload,
            TerminalApprovalPreview {
                terminal_id: Some("term-1".to_string()),
                workspace_root: None,
                shell: None,
                input_bytes: Some("echo ok\r\n".len()),
                input_hash: Some(input_hash),
                sends_enter: Some(true),
            },
        )
        .expect("plan terminal input");
        terminal_approve_inner_for_test(
            &state,
            &plan.approval_id,
            None,
            "input",
            &plan.preview_hash,
        )
        .expect("approve terminal input");
        let changed_hash = create_fnv1a_hash(b"echo changed\r\n");
        let changed_payload =
            terminal_input_payload("term-1", &changed_hash, "echo changed\r\n".len(), true);

        assert!(require_terminal_approval(
            &state,
            Some(&plan.approval_id),
            None,
            "input",
            &changed_payload,
        )
        .is_err());
    }

    fn terminal_approve_inner_for_test(
        state: &TerminalState,
        approval_id: &str,
        task_id: Option<&str>,
        action: &str,
        preview_hash: &str,
    ) -> Result<(), String> {
        let tool_name = terminal_tool_name(action)?;
        let mut approvals = state.approvals.lock().unwrap();
        let pending = approvals.get_mut(approval_id).expect("pending approval");
        approve_native_approval_binding(
            &mut pending.binding,
            approval_id,
            tool_name,
            task_id,
            preview_hash,
            "Terminal approval id does not match the pending operation.",
        )
    }
}
