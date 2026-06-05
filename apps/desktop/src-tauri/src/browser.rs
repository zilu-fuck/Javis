use serde::{Deserialize, Serialize};
use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, SystemTime},
};
use crate::error::JavisError;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Managed inner state that holds the child process together with its taken
/// stdin handle and a channel receiver fed by a background stdout reader thread.
struct ManagedInner {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Result<String, String>>,
    /// Kept alive so the reader thread's sender half stays open.
    _tx: mpsc::Sender<Result<String, String>>,
}

pub(crate) struct BrowserState {
    inner: Mutex<Option<ManagedInner>>,
}

impl BrowserState {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl Drop for BrowserState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mut inner) = guard.take() {
                // Try graceful close, then force kill.
                let close_msg = serde_json::json!({
                    "id": generate_request_id(),
                    "method": "close",
                    "params": serde_json::Value::Null,
                });
                let line = serde_json::to_string(&close_msg).unwrap_or_default();
                let _ = writeln!(inner.stdin, "{line}");
                let _ = inner.stdin.flush();
                thread::sleep(Duration::from_millis(200));
                let _ = inner.child.kill();
                let _ = inner.child.wait();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserNavigateRequest {
    url: String,
    session_id: Option<String>,
    allow_localhost: Option<bool>,
    wait_for_selector: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserScreenshotRequest {
    selector: Option<String>,
    full_page: Option<bool>,
    format: Option<String>,
    quality: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserGetContentRequest {
    selector: Option<String>,
    format: Option<String>,
    max_length: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserClickRequest {
    session_id: Option<String>,
    permission_mode: Option<String>,
    selector: String,
    button: Option<String>,
    click_count: Option<u32>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTypeRequest {
    session_id: Option<String>,
    permission_mode: Option<String>,
    selector: String,
    text: String,
    delay: Option<u32>,
    clear_before: Option<bool>,
    press_enter: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserEvaluateRequest {
    session_id: Option<String>,
    permission_mode: Option<String>,
    expression: String,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserRunTestRequest {
    script: String,
    test_file: Option<String>,
    timeout_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserNavigateResult {
    url: String,
    title: String,
    status: u16,
    load_state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserScreenshotResult {
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserGetContentResult {
    content: String,
    url: String,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserClickResult {
    selector: String,
    clicked: bool,
    new_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTypeResult {
    selector: String,
    typed: bool,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserEvaluateResult {
    result: String,
    #[serde(rename = "type")]
    result_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserRunTestResult {
    passed: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSnapshotResult {
    url: String,
    title: String,
    load_state: String,
    content: String,
    screenshot_data_url: String,
}

// ---------------------------------------------------------------------------
// Sidecar management — resolution helpers
// ---------------------------------------------------------------------------

fn resolve_node_executable() -> Result<PathBuf, JavisError> {
    // 1. Check JAVIS_NODE_PATH environment variable.
    if let Some(path) = env::var_os("JAVIS_NODE_PATH").map(PathBuf::from) {
        if path.exists() {
            return Ok(path);
        }
    }

    // 2. Use `where node` on Windows to locate node.exe in PATH.
    let output = Command::new("where")
        .arg("node")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| JavisError::Io(format!("Failed to run `where node`: {e}")))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(first_line) = stdout.lines().next() {
            let trimmed = first_line.trim();
            if !trimmed.is_empty() {
                let path = PathBuf::from(trimmed);
                if path.exists() {
                    return Ok(path);
                }
            }
        }
    }

    Err(JavisError::NotFound(
        "Node.js executable not found. Set JAVIS_NODE_PATH or add node to PATH.".to_string(),
    ))
}

fn resolve_sidecar_script() -> Result<PathBuf, JavisError> {
    // 1. Check JAVIS_BROWSER_SIDECAR_PATH environment variable.
    if let Some(path) = env::var_os("JAVIS_BROWSER_SIDECAR_PATH").map(PathBuf::from) {
        if path.exists() {
            return Ok(path);
        }
    }

    // 2. Relative to the executable (production / packaged mode).
    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidate = exe_dir
                .join("sidecar")
                .join("browser")
                .join("dist")
                .join("index.js");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // 3. Relative to CWD (development mode).
    if let Ok(cwd) = env::current_dir() {
        let candidate = cwd
            .join("sidecar")
            .join("browser")
            .join("dist")
            .join("index.js");
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(JavisError::NotFound(
        "Browser sidecar script not found. Set JAVIS_BROWSER_SIDECAR_PATH or place \
         sidecar/browser/dist/index.js next to the executable."
            .to_string(),
    ))
}

// ---------------------------------------------------------------------------
// Sidecar management — spawn & request
// ---------------------------------------------------------------------------

fn generate_request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("req-{nanos}")
}

/// Ensure the sidecar process is running. On first call it spawns node, waits
/// for the `{"id":"ready",...}` handshake, and stores the managed handles in
/// state. Subsequent calls are no-ops.
fn spawn_sidecar(state: &BrowserState) -> Result<(), JavisError> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| JavisError::Internal(format!("Failed to lock browser state: {e}")))?;

    if guard.is_some() {
        return Ok(());
    }

    let node = resolve_node_executable()?;
    let script = resolve_sidecar_script()?;

    let mut child = Command::new(&node)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| JavisError::Io(format!("Failed to spawn browser sidecar: {e}")))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| JavisError::Io("Sidecar stdin pipe was unavailable.".to_string()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| JavisError::Io("Sidecar stdout pipe was unavailable.".to_string()))?;

    // Drain stderr in a background thread so the pipe never blocks.
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for _ in reader.lines() {
                // intentionally discarded
            }
        });
    }

    // Background reader thread: owns stdout and feeds lines through a channel.
    let (tx, rx) = mpsc::channel();
    let tx_for_thread = tx.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line_result in reader.lines() {
            if tx_for_thread.send(line_result.map_err(|e| e.to_string())).is_err() {
                break;
            }
        }
    });

    // Wait for the ready message with timeout.
    let start = SystemTime::now();
    loop {
        // Check if the child exited prematurely.
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(JavisError::Internal(format!(
                    "Browser sidecar exited prematurely with status: {status}"
                )));
            }
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(JavisError::Io(format!(
                    "Failed to check sidecar status: {e}"
                )));
            }
        }

        match rx.try_recv() {
            Ok(Ok(line)) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if value.get("id").and_then(|v| v.as_str()) == Some("ready") {
                        *guard = Some(ManagedInner {
                            child,
                            stdin,
                            rx,
                            _tx: tx.clone(),
                        });
                        return Ok(());
                    }
                }
            }
            Ok(Err(e)) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(JavisError::Io(format!(
                    "Error reading sidecar stdout: {e}"
                )));
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(JavisError::Internal(
                    "Sidecar stdout reader thread disconnected.".to_string(),
                ));
            }
        }

        let elapsed = SystemTime::now()
            .duration_since(start)
            .unwrap_or_default();
        if elapsed >= SIDECAR_READY_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            return Err(JavisError::Internal(format!(
                "Browser sidecar did not become ready within {} seconds.",
                SIDECAR_READY_TIMEOUT.as_secs()
            )));
        }

        thread::sleep(POLL_INTERVAL);
    }
}

/// Send a JSON-RPC-style request to the sidecar and return the result payload.
/// If the sidecar has crashed, clears state and re-spawns on the next call.
fn send_request(
    state: &BrowserState,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, JavisError> {
    spawn_sidecar(state)?;

    let mut guard = state
        .inner
        .lock()
        .map_err(|e| JavisError::Internal(format!("Failed to lock browser state: {e}")))?;

    let inner = guard
        .as_mut()
        .ok_or_else(|| JavisError::Internal("Browser sidecar is not running.".to_string()))?;

    // Build and write the request.
    let request = serde_json::json!({
        "id": generate_request_id(),
        "method": method,
        "params": params,
    });

    let line = serde_json::to_string(&request)
        .map_err(|e| JavisError::Serde(format!("Failed to serialize request: {e}")))?;

    writeln!(inner.stdin, "{line}")
        .map_err(|e| JavisError::Io(format!("Failed to write to sidecar stdin: {e}")))?;
    inner
        .stdin
        .flush()
        .map_err(|e| JavisError::Io(format!("Failed to flush sidecar stdin: {e}")))?;

    // Read one response line with timeout.
    let start = SystemTime::now();
    loop {
        match inner.child.try_wait() {
            Ok(Some(status)) => {
                // Sidecar crashed — clear state so next call re-spawns.
                let _ = guard.take();
                return Err(JavisError::Internal(format!(
                    "Browser sidecar exited unexpectedly with status: {status}"
                )));
            }
            Ok(None) => {}
            Err(e) => {
                return Err(JavisError::Io(format!(
                    "Failed to check sidecar status: {e}"
                )));
            }
        }

        match inner.rx.try_recv() {
            Ok(Ok(line)) => {
                let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| {
                    JavisError::Serde(format!("Invalid JSON from sidecar: {e}"))
                })?;

                if let Some(error) = value.get("error") {
                    let msg = error.as_str().unwrap_or("Unknown sidecar error");
                    return Err(JavisError::Internal(format!("Sidecar error: {msg}")));
                }

                return Ok(
                    value
                        .get("result")
                        .cloned()
                        .unwrap_or(value),
                );
            }
            Ok(Err(e)) => {
                return Err(JavisError::Io(format!(
                    "Error reading sidecar response: {e}"
                )));
            }
            Err(mpsc::TryRecvError::Empty) => {}
            Err(mpsc::TryRecvError::Disconnected) => {
                return Err(JavisError::Internal(
                    "Sidecar stdout reader thread disconnected.".to_string(),
                ));
            }
        }

        let elapsed = SystemTime::now()
            .duration_since(start)
            .unwrap_or_default();
        if elapsed >= COMMAND_TIMEOUT {
            return Err(JavisError::Internal(format!(
                "Sidecar command '{}' timed out after {} seconds.",
                method,
                COMMAND_TIMEOUT.as_secs()
            )));
        }

        thread::sleep(POLL_INTERVAL);
    }
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

fn validate_url(url: &str) -> Result<(), JavisError> {
    validate_url_with_localhost(url, false)
}

fn validate_url_with_localhost(url: &str, allow_localhost: bool) -> Result<(), JavisError> {
    let lower = url.to_ascii_lowercase();

    // Only allow http and https schemes.
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(JavisError::Validation(
            "Only http:// and https:// URLs are allowed.".to_string(),
        ));
    }

    // Extract the portion after the scheme.
    let after_scheme = if lower.starts_with("https://") {
        &url[8..]
    } else {
        &url[7..]
    };

    // Strip userinfo (anything before '@') to prevent `http://evil.com@127.0.0.1`.
    let after_userinfo = match after_scheme.rfind('@') {
        Some(pos) => &after_scheme[pos + 1..],
        None => after_scheme,
    };

    let host_end = after_userinfo
        .find('/')
        .or_else(|| after_userinfo.find(':'))
        .unwrap_or(after_userinfo.len());
    let raw_host = &after_userinfo[..host_end];

    // Percent-decode the host to prevent `http://127%2e0%2e0%2e1`.
    let host = percent_decode_host(raw_host);

    if is_private_host(&host) && !(allow_localhost && is_localhost(&host)) {
        return Err(JavisError::Validation(format!(
            "URLs targeting private/loopback addresses are not allowed: {host}"
        )));
    }

    Ok(())
}

fn is_localhost(host: &str) -> bool {
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

fn ensure_browser_write_permission(session_id: Option<&str>, permission_mode: Option<&str>) -> Result<(), JavisError> {
    if session_id.unwrap_or_default().trim().is_empty() {
        return Err(JavisError::Validation(
            "Browser write operation requires a session id.".to_string(),
        ));
    }
    match permission_mode {
        Some("confirmed_write") | Some("full_access") => Ok(()),
        Some("read_only") => Err(JavisError::Validation(
            "Browser write operation requires confirmed write permission.".to_string(),
        )),
        Some(other) => Err(JavisError::Validation(format!(
            "Unknown browser permission mode: {other}"
        ))),
        None => Err(JavisError::Validation(
            "Browser write operation requires a permission mode.".to_string(),
        )),
    }
}

/// Simple percent-decoding for the host portion (handles %2E → '.', etc.).
fn percent_decode_host(host: &str) -> String {
    let bytes = host.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push(hi << 4 | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_ascii_lowercase()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn is_private_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }

    // IPv4 checks.
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() == 4 {
        if let (Ok(a), Ok(b)) = (parts[0].parse::<u8>(), parts[1].parse::<u8>()) {
            match a {
                127 => return true,                                // 127.0.0.0/8
                10 => return true,                                 // 10.0.0.0/8
                172 if (16..=31).contains(&b) => return true,     // 172.16.0.0/12
                192 if b == 168 => return true,                    // 192.168.0.0/16
                169 if b == 254 => return true,                    // 169.254.0.0/16 (link-local)
                0 if b == 0 => return true,                        // 0.0.0.0
                _ => {}
            }
        }
    }

    // IPv6 loopback / private.
    if host == "::1" || host == "[::1]" {
        return true;
    }
    if host.starts_with("fe80:") || host.starts_with("[fe80:") {
        return true; // link-local
    }
    if host.starts_with("fc00:") || host.starts_with("[fc00:") {
        return true; // ULA fc00::/7 covers fc00:: and fd00::
    }
    // fd00::/8 — any address starting with fd (e.g. fd00::1, fd12:3456::1)
    if host.starts_with("fd") {
        return true;
    }
    if host.starts_with("[fd") {
        return true;
    }

    false
}

// ---------------------------------------------------------------------------
// Tauri commands — Read
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn browser_navigate(
    state: tauri::State<'_, BrowserState>,
    request: BrowserNavigateRequest,
) -> Result<BrowserNavigateResult, String> {
    let _ = request.session_id.as_deref();
    if request.allow_localhost.unwrap_or(false) {
        validate_url_with_localhost(&request.url, true).map_err(|e| e.to_string())?;
    } else {
        validate_url(&request.url).map_err(|e| e.to_string())?;
    }

    let params = serde_json::json!({
        "url": request.url,
        "waitForSelector": request.wait_for_selector,
        "timeoutMs": request.timeout_ms,
    });

    let result = send_request(&state, "navigate", params).map_err(|e| e.to_string())?;

    Ok(BrowserNavigateResult {
        url: result
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        title: result
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        status: result
            .get("status")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u16,
        load_state: result
            .get("loadState")
            .or_else(|| result.get("load_state"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

#[tauri::command]
pub(crate) fn browser_snapshot(
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserSnapshotResult, String> {
    let content_result = send_request(
        &state,
        "getContent",
        serde_json::json!({
            "selector": serde_json::Value::Null,
            "format": "text",
            "maxLength": 4000,
        }),
    )
    .map_err(|e| e.to_string())?;
    let screenshot_result = send_request(
        &state,
        "screenshot",
        serde_json::json!({
            "selector": serde_json::Value::Null,
            "fullPage": false,
        }),
    )
    .map_err(|e| e.to_string())?;
    Ok(BrowserSnapshotResult {
        url: content_result
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        title: content_result
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        load_state: "snapshot".to_string(),
        content: content_result
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        screenshot_data_url: screenshot_result
            .get("dataUrl")
            .or_else(|| screenshot_result.get("data_url"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

#[tauri::command]
pub(crate) fn browser_screenshot(
    state: tauri::State<'_, BrowserState>,
    request: BrowserScreenshotRequest,
) -> Result<BrowserScreenshotResult, String> {
    let params = serde_json::json!({
        "selector": request.selector,
        "fullPage": request.full_page,
        "format": request.format,
        "quality": request.quality,
    });

    let result = send_request(&state, "screenshot", params).map_err(|e| e.to_string())?;

    Ok(BrowserScreenshotResult {
        data_url: result
            .get("dataUrl")
            .or_else(|| result.get("data_url"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        width: result
            .get("width")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        height: result
            .get("height")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
    })
}

#[tauri::command]
pub(crate) fn browser_get_content(
    state: tauri::State<'_, BrowserState>,
    request: BrowserGetContentRequest,
) -> Result<BrowserGetContentResult, String> {
    let params = serde_json::json!({
        "selector": request.selector,
        "format": request.format,
        "maxLength": request.max_length,
    });

    let result = send_request(&state, "getContent", params).map_err(|e| e.to_string())?;

    Ok(BrowserGetContentResult {
        content: result
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        url: result
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        title: result
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

// ---------------------------------------------------------------------------
// Tauri commands — Write (approval handled at TS layer)
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn browser_click(
    state: tauri::State<'_, BrowserState>,
    request: BrowserClickRequest,
) -> Result<BrowserClickResult, String> {
    ensure_browser_write_permission(request.session_id.as_deref(), request.permission_mode.as_deref())
        .map_err(|e| e.to_string())?;
    let params = serde_json::json!({
        "selector": request.selector,
        "button": request.button,
        "clickCount": request.click_count,
        "timeoutMs": request.timeout_ms,
    });

    let result = send_request(&state, "click", params).map_err(|e| e.to_string())?;

    Ok(BrowserClickResult {
        selector: result
            .get("selector")
            .and_then(|v| v.as_str())
            .unwrap_or(&request.selector)
            .to_string(),
        clicked: result
            .get("clicked")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        new_url: result
            .get("newUrl")
            .or_else(|| result.get("new_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

#[tauri::command]
pub(crate) fn browser_type(
    state: tauri::State<'_, BrowserState>,
    request: BrowserTypeRequest,
) -> Result<BrowserTypeResult, String> {
    ensure_browser_write_permission(request.session_id.as_deref(), request.permission_mode.as_deref())
        .map_err(|e| e.to_string())?;
    let params = serde_json::json!({
        "selector": request.selector,
        "text": request.text,
        "delay": request.delay,
        "clearBefore": request.clear_before,
        "pressEnter": request.press_enter,
    });

    let result = send_request(&state, "type", params).map_err(|e| e.to_string())?;

    Ok(BrowserTypeResult {
        selector: result
            .get("selector")
            .and_then(|v| v.as_str())
            .unwrap_or(&request.selector)
            .to_string(),
        typed: result
            .get("typed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        value: result
            .get("value")
            .and_then(|v| v.as_str())
            .unwrap_or(&request.text)
            .to_string(),
    })
}

#[tauri::command]
pub(crate) fn browser_evaluate(
    state: tauri::State<'_, BrowserState>,
    request: BrowserEvaluateRequest,
) -> Result<BrowserEvaluateResult, String> {
    ensure_browser_write_permission(request.session_id.as_deref(), request.permission_mode.as_deref())
        .map_err(|e| e.to_string())?;
    let params = serde_json::json!({
        "expression": request.expression,
        "timeoutMs": request.timeout_ms,
    });

    let result = send_request(&state, "evaluate", params).map_err(|e| e.to_string())?;

    Ok(BrowserEvaluateResult {
        result: result
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        result_type: result
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
    })
}

#[tauri::command]
pub(crate) fn browser_run_test(
    state: tauri::State<'_, BrowserState>,
    request: BrowserRunTestRequest,
) -> Result<BrowserRunTestResult, String> {
    let start = SystemTime::now();

    let params = serde_json::json!({
        "script": request.script,
        "testFile": request.test_file,
        "timeoutMs": request.timeout_ms,
    });

    let result = send_request(&state, "runTest", params).map_err(|e| e.to_string())?;

    let duration_ms = SystemTime::now()
        .duration_since(start)
        .unwrap_or_default()
        .as_millis() as u64;

    Ok(BrowserRunTestResult {
        passed: result
            .get("passed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        exit_code: result
            .get("exitCode")
            .or_else(|| result.get("exit_code"))
            .and_then(|v| v.as_i64())
            .unwrap_or(-1) as i32,
        stdout: result
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        stderr: result
            .get("stderr")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        duration_ms: result
            .get("durationMs")
            .or_else(|| result.get("duration_ms"))
            .and_then(|v| v.as_u64())
            .unwrap_or(duration_ms),
    })
}

// ---------------------------------------------------------------------------
// Tauri commands — Utility
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn browser_close(
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| format!("Failed to lock browser state: {e}"))?;

    if let Some(mut inner) = guard.take() {
        // Try to send a graceful close request to the sidecar.
        let close_msg = serde_json::json!({
            "id": generate_request_id(),
            "method": "close",
            "params": serde_json::Value::Null,
        });
        let line = serde_json::to_string(&close_msg).unwrap_or_default();
        let _ = writeln!(inner.stdin, "{line}");
        let _ = inner.stdin.flush();

        // Give the sidecar a moment to exit gracefully.
        thread::sleep(Duration::from_millis(500));

        // Force kill if still running.
        let _ = inner.child.kill();
        let _ = inner.child.wait();
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_url_rejects_file_scheme() {
        assert!(validate_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn validate_url_rejects_javascript_scheme() {
        assert!(validate_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn validate_url_rejects_data_scheme() {
        assert!(validate_url("data:text/html,<h1>hi</h1>").is_err());
    }

    #[test]
    fn validate_url_rejects_loopback() {
        assert!(validate_url("http://127.0.0.1").is_err());
        assert!(validate_url("http://127.0.0.1:8080/path").is_err());
    }

    #[test]
    fn validate_url_rejects_private_10() {
        assert!(validate_url("http://10.0.0.1").is_err());
    }

    #[test]
    fn validate_url_rejects_private_172() {
        assert!(validate_url("http://172.16.0.1").is_err());
        assert!(validate_url("http://172.31.255.255").is_err());
    }

    #[test]
    fn validate_url_rejects_private_192() {
        assert!(validate_url("http://192.168.1.1").is_err());
    }

    #[test]
    fn validate_url_rejects_localhost() {
        assert!(validate_url("http://localhost").is_err());
        assert!(validate_url("http://localhost:3000").is_err());
    }

    #[test]
    fn validate_url_allows_localhost_only_with_explicit_flag() {
        assert!(validate_url_with_localhost("http://localhost:3000", true).is_ok());
        assert!(validate_url_with_localhost("http://127.0.0.1:1421", true).is_ok());
        assert!(validate_url_with_localhost("http://192.168.1.1", true).is_err());
    }

    #[test]
    fn validate_url_allows_public_https() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("https://example.com/path?q=1").is_ok());
    }

    #[test]
    fn validate_url_allows_public_http() {
        assert!(validate_url("http://example.com").is_ok());
    }

    #[test]
    fn validate_url_rejects_ftp() {
        assert!(validate_url("ftp://example.com").is_err());
    }

    #[test]
    fn is_private_host_detects_localhost() {
        assert!(is_private_host("localhost"));
    }

    #[test]
    fn is_private_host_detects_127_range() {
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("127.255.255.255"));
    }

    #[test]
    fn is_private_host_detects_172_range() {
        assert!(is_private_host("172.16.0.1"));
        assert!(is_private_host("172.31.255.255"));
        assert!(!is_private_host("172.15.0.1"));
        assert!(!is_private_host("172.32.0.1"));
    }

    #[test]
    fn is_private_host_detects_0_0_0_0() {
        assert!(is_private_host("0.0.0.0"));
    }

    #[test]
    fn is_private_host_detects_ipv6_loopback() {
        assert!(is_private_host("::1"));
        assert!(is_private_host("[::1]"));
    }

    #[test]
    fn is_private_host_allows_public() {
        assert!(!is_private_host("8.8.8.8"));
        assert!(!is_private_host("1.1.1.1"));
        assert!(!is_private_host("example.com"));
    }

    #[test]
    fn browser_state_starts_empty() {
        let state = BrowserState::new();
        let guard = state.inner.lock().unwrap();
        assert!(guard.is_none());
    }

    #[test]
    fn generate_request_id_has_prefix() {
        let id = generate_request_id();
        assert!(id.starts_with("req-"));
    }

    #[test]
    fn validate_url_rejects_userinfo_ssrf() {
        // http://evil.com@127.0.0.1/ should be blocked (userinfo trick).
        assert!(validate_url("http://evil.com@127.0.0.1/").is_err());
        assert!(validate_url("https://user@192.168.1.1/admin").is_err());
        assert!(validate_url("http://x@10.0.0.1:8080/").is_err());
    }

    #[test]
    fn validate_url_rejects_percent_encoded_ssrf() {
        // Percent-encoded dots: 127%2e0%2e0%2e1 → 127.0.0.1
        assert!(validate_url("http://127%2e0%2e0%2e1/").is_err());
        assert!(validate_url("http://%31%32%37%2e%30%2e%30%2e%31/").is_err());
    }

    #[test]
    fn validate_url_rejects_link_local_169() {
        assert!(validate_url("http://169.254.1.1").is_err());
        assert!(validate_url("http://169.254.0.0/").is_err());
        assert!(validate_url("http://169.254.255.255:8080").is_err());
    }

    #[test]
    fn is_private_host_detects_169_254() {
        assert!(is_private_host("169.254.1.1"));
        assert!(is_private_host("169.254.0.0"));
        assert!(is_private_host("169.254.255.255"));
        assert!(!is_private_host("169.253.0.1"));
        assert!(!is_private_host("169.255.0.1"));
    }

    #[test]
    fn is_private_host_detects_fd00_ula() {
        assert!(is_private_host("fd00::1"));
        assert!(is_private_host("fd12:3456::1"));
        assert!(is_private_host("[fd00::1]"));
        assert!(is_private_host("fc00::1"));
    }

    #[test]
    fn percent_decode_host_handles_encoded_dots() {
        assert_eq!(percent_decode_host("127%2e0%2e0%2e1"), "127.0.0.1");
        assert_eq!(percent_decode_host("example%2ecom"), "example.com");
        assert_eq!(percent_decode_host("127.0.0.1"), "127.0.0.1");
    }
}
