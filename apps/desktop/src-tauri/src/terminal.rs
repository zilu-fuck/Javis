use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter};

use crate::{normalize_path, resolve_workspace_path};

pub(crate) struct TerminalState {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalState {
    pub(crate) fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn portable_pty::Child + Send>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCreateRequest {
    session_id: String,
    workspace_root: String,
    terminal_id: Option<String>,
    permission_mode: Option<String>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalInputRequest {
    terminal_id: String,
    data: String,
    permission_mode: Option<String>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalCreateResult {
    terminal_id: String,
    cwd: String,
    shell: String,
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
pub(crate) fn terminal_create(
    app: AppHandle,
    state: tauri::State<'_, TerminalState>,
    request: TerminalCreateRequest,
) -> Result<TerminalCreateResult, String> {
    ensure_terminal_permission(request.permission_mode.as_deref())?;
    let cwd = resolve_workspace_path(Some(request.workspace_root.clone()))?;
    let _ = request.shell.as_deref();
    let shell = default_shell();
    let terminal_id = request
        .terminal_id
        .unwrap_or_else(|| format!("term-{}", unique_nanos()));
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
    ensure_terminal_permission(request.permission_mode.as_deref())?;
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
}
