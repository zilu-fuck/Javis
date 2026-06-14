use crate::error::JavisError;
use crate::{
    approve_native_approval_binding, create_approval_id, create_fnv1a_hash,
    create_native_approval_binding, require_native_approval_binding, NativeApprovalBinding,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, SystemTime},
};

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
    approvals: Mutex<HashMap<String, PendingBrowserApproval>>,
}

impl BrowserState {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            approvals: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug)]
struct PendingBrowserApproval {
    action: String,
    session_id: String,
    preview_hash: String,
    binding: NativeApprovalBinding,
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
pub(crate) struct BrowserSessionRequest {
    session_id: Option<String>,
    allow_localhost: Option<bool>,
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
pub(crate) struct BrowserExtractLinksRequest {
    selector: Option<String>,
    max_results: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserClickRequest {
    task_id: Option<String>,
    session_id: Option<String>,
    #[allow(dead_code)]
    permission_mode: Option<String>,
    approval_id: Option<String>,
    selector: String,
    button: Option<String>,
    click_count: Option<u32>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserTypeRequest {
    task_id: Option<String>,
    session_id: Option<String>,
    #[allow(dead_code)]
    permission_mode: Option<String>,
    approval_id: Option<String>,
    selector: String,
    text: String,
    delay: Option<u32>,
    clear_before: Option<bool>,
    press_enter: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserEvaluateRequest {
    task_id: Option<String>,
    session_id: Option<String>,
    #[allow(dead_code)]
    permission_mode: Option<String>,
    approval_id: Option<String>,
    expression: String,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserRunTestRequest {
    task_id: Option<String>,
    session_id: Option<String>,
    approval_id: Option<String>,
    script: String,
    test_file: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPlanWriteRequest {
    task_id: Option<String>,
    session_id: String,
    action: String,
    selector: Option<String>,
    expression: Option<String>,
    test_file: Option<String>,
    input_summary: Option<String>,
    input_hash: Option<String>,
    input_bytes: Option<usize>,
    script_hash: Option<String>,
    script_bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserApproveWriteRequest {
    approval_id: String,
    task_id: Option<String>,
    session_id: String,
    action: String,
    preview_hash: String,
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
    can_go_back: bool,
    can_go_forward: bool,
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
pub(crate) struct BrowserExtractedLink {
    href: String,
    text: String,
    tag: Option<String>,
    rel: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserExtractLinksResult {
    links: Vec<BrowserExtractedLink>,
    count: usize,
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
    sidecar_running: bool,
    url: String,
    title: String,
    load_state: String,
    content: String,
    screenshot_data_url: String,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserStatusResult {
    sidecar_running: bool,
    url: String,
    title: String,
    status: u16,
    load_state: String,
    can_go_back: bool,
    can_go_forward: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPlanWriteResult {
    approval_id: String,
    tool_name: String,
    session_id: String,
    action: String,
    preview_hash: String,
    binding: NativeApprovalBindingView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserApproveWriteResult {
    approval_id: String,
    approved: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeApprovalBindingView {
    task_id: String,
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
        for candidate in sidecar_script_candidates_near_executable(&exe_path) {
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

fn sidecar_script_candidates_near_executable(exe_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = exe_path.parent() {
        for base in [exe_dir, &exe_dir.join("resources")] {
            candidates.push(
                base.join("sidecar")
                    .join("browser")
                    .join("dist")
                    .join("index.js"),
            );
        }
    }
    candidates
}

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
            if tx_for_thread
                .send(line_result.map_err(|e| e.to_string()))
                .is_err()
            {
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
                return Err(JavisError::Io(format!("Error reading sidecar stdout: {e}")));
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

        let elapsed = SystemTime::now().duration_since(start).unwrap_or_default();
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
                let value: serde_json::Value = serde_json::from_str(&line)
                    .map_err(|e| JavisError::Serde(format!("Invalid JSON from sidecar: {e}")))?;

                if let Some(error) = value.get("error") {
                    let msg = error.as_str().unwrap_or("Unknown sidecar error");
                    return Err(JavisError::Internal(format!("Sidecar error: {msg}")));
                }

                return Ok(value.get("result").cloned().unwrap_or(value));
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

        let elapsed = SystemTime::now().duration_since(start).unwrap_or_default();
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
    validate_url_with_resolver(url, allow_localhost, resolve_host_ips)
}

fn validate_url_with_resolver(
    raw_url: &str,
    allow_localhost: bool,
    resolver: impl Fn(&str, u16) -> Result<Vec<IpAddr>, JavisError>,
) -> Result<(), JavisError> {
    let parsed = Url::parse(raw_url.trim())
        .map_err(|_| JavisError::Validation("Invalid browser URL.".to_string()))?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(JavisError::Validation(
            "Only http:// and https:// URLs are allowed.".to_string(),
        ));
    }

    let Some(host) = parsed.host_str() else {
        return Err(JavisError::Validation("URL host is required.".to_string()));
    };

    if is_private_host(host) && !(allow_localhost && is_localhost(host)) {
        return Err(JavisError::Validation(format!(
            "URLs targeting private/loopback addresses are not allowed: {host}"
        )));
    }
    if allow_localhost && is_localhost(host) {
        return Ok(());
    }

    if host.parse::<IpAddr>().is_err() {
        let port = parsed.port_or_known_default().unwrap_or(443);
        for ip in resolver(host, port)? {
            if is_private_ip(ip) {
                return Err(JavisError::Validation(format!(
                    "URLs resolving to private/loopback addresses are not allowed: {host}"
                )));
            }
        }
    }

    Ok(())
}

fn resolve_host_ips(host: &str, port: u16) -> Result<Vec<IpAddr>, JavisError> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|error| JavisError::Validation(format!("Could not resolve URL host: {error}")))?
        .map(|addr| addr.ip())
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(JavisError::Validation(
            "URL host did not resolve to an address.".to_string(),
        ));
    }
    Ok(addrs)
}

fn ensure_localhost_navigation_session(
    allow_localhost: bool,
    session_id: Option<&str>,
) -> Result<(), JavisError> {
    if allow_localhost && session_id.unwrap_or_default().trim().is_empty() {
        return Err(JavisError::Validation(
            "Local browser navigation requires a session id.".to_string(),
        ));
    }
    Ok(())
}

fn is_localhost(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1" | "[::1]"
    )
}

#[cfg(test)]
fn ensure_browser_write_permission(
    session_id: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<(), JavisError> {
    if session_id.unwrap_or_default().trim().is_empty() {
        return Err(JavisError::Validation(
            "Browser write operation requires a session id.".to_string(),
        ));
    }
    match permission_mode {
        Some("confirmed_write") | Some("full_access") | Some("read_only") => {
            Err(JavisError::Validation(
                "Browser write operation requires a native approval binding.".to_string(),
            ))
        }
        Some(other) => Err(JavisError::Validation(format!(
            "Unknown browser permission mode: {other}"
        ))),
        None => Err(JavisError::Validation(
            "Browser write operation requires a native approval binding.".to_string(),
        )),
    }
}

fn browser_tool_name(action: &str) -> Result<&'static str, JavisError> {
    match action {
        "click" => Ok("browser.click"),
        "type" => Ok("browser.type"),
        "evaluate" => Ok("browser.evaluate"),
        "runTest" => Ok("browser.runTest"),
        other => Err(JavisError::Validation(format!(
            "Unsupported browser write action: {other}"
        ))),
    }
}

fn create_browser_preview_hash(
    session_id: &str,
    action: &str,
    payload: &serde_json::Value,
) -> String {
    create_fnv1a_hash(
        serde_json::json!({
            "sessionId": session_id,
            "action": action,
            "payload": payload,
        })
        .to_string()
        .as_bytes(),
    )
}

fn browser_write_payload(
    selector: serde_json::Value,
    expression: serde_json::Value,
    test_file: serde_json::Value,
    input_summary: serde_json::Value,
    input_hash: serde_json::Value,
    input_bytes: serde_json::Value,
    script_hash: serde_json::Value,
    script_bytes: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "selector": selector,
        "expression": expression,
        "testFile": test_file,
        "inputSummary": input_summary,
        "inputHash": input_hash,
        "inputBytes": input_bytes,
        "scriptHash": script_hash,
        "scriptBytes": script_bytes,
    })
}

fn browser_text_hash(value: &str) -> String {
    create_fnv1a_hash(value.as_bytes())
}

fn browser_text_bytes(value: &str) -> usize {
    value.as_bytes().len()
}

fn validate_browser_session_id(session_id: &str) -> Result<String, JavisError> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return Err(JavisError::Validation(
            "Browser write operation requires a session id.".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn require_browser_approval(
    state: &BrowserState,
    approval_id: Option<&str>,
    task_id: Option<&str>,
    session_id: Option<&str>,
    action: &str,
    payload: &serde_json::Value,
) -> Result<(), JavisError> {
    let session_id = validate_browser_session_id(session_id.unwrap_or_default())?;
    let approval_id = approval_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            JavisError::Permission(
                "Browser write operation requires a native approval id.".to_string(),
            )
        })?;
    let preview_hash = create_browser_preview_hash(&session_id, action, payload);
    let tool_name = browser_tool_name(action)?;
    let mut approvals = state
        .approvals
        .lock()
        .map_err(|_| JavisError::Internal("Browser approval state could not be locked.".into()))?;
    let pending = approvals.remove(approval_id).ok_or_else(|| {
        JavisError::Permission("Browser approval was not found or was already used.".into())
    })?;
    if pending.action != action || pending.session_id != session_id {
        return Err(JavisError::Permission(
            "Browser approval scope does not match this operation.".into(),
        ));
    }
    if pending.preview_hash != preview_hash {
        return Err(JavisError::Permission(
            "Browser approval preview hash does not match this operation.".into(),
        ));
    }
    require_native_approval_binding(
        &pending.binding,
        approval_id,
        tool_name,
        task_id,
        &preview_hash,
        "Browser approval id does not match the approved operation.",
        "Browser write operation requires confirmed-write approval.",
    )
}

fn validate_current_page_url(
    result: &serde_json::Value,
    allow_localhost: bool,
) -> Result<(), JavisError> {
    let Some(url) = result.get("url").and_then(|value| value.as_str()) else {
        return Err(JavisError::Validation(
            "Browser sidecar did not report the current page URL.".to_string(),
        ));
    };
    validate_url_with_localhost(url, allow_localhost)
}

fn require_localhost_session(request: &BrowserSessionRequest) -> Result<(), JavisError> {
    ensure_localhost_navigation_session(
        request.allow_localhost.unwrap_or(false),
        request.session_id.as_deref(),
    )
}

fn status_from_value(result: serde_json::Value) -> BrowserStatusResult {
    BrowserStatusResult {
        sidecar_running: result
            .get("sidecarRunning")
            .or_else(|| result.get("sidecar_running"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
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
        status: result.get("status").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
        load_state: result
            .get("loadState")
            .or_else(|| result.get("load_state"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string(),
        can_go_back: result
            .get("canGoBack")
            .or_else(|| result.get("can_go_back"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        can_go_forward: result
            .get("canGoForward")
            .or_else(|| result.get("can_go_forward"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

fn session_params(request: &BrowserSessionRequest) -> serde_json::Value {
    serde_json::json!({
        "timeoutMs": request.timeout_ms,
        "allowLocalhost": request.allow_localhost.unwrap_or(false),
    })
}

fn is_private_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private_ip(ip);
    }

    // IPv4 checks.
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() == 4 {
        if let (Ok(a), Ok(b)) = (parts[0].parse::<u8>(), parts[1].parse::<u8>()) {
            match a {
                127 => return true,                           // 127.0.0.0/8
                10 => return true,                            // 10.0.0.0/8
                172 if (16..=31).contains(&b) => return true, // 172.16.0.0/12
                192 if b == 168 => return true,               // 192.168.0.0/16
                169 if b == 254 => return true,               // 169.254.0.0/16 (link-local)
                0 if b == 0 => return true,                   // 0.0.0.0
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

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_private_ipv4(ip),
        IpAddr::V6(ip) => is_private_ipv6(ip),
    }
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || matches!(ip.octets(), [100, 64..=127, _, _])
}

fn is_private_ipv6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unicast_link_local()
        || (ip.octets()[0] & 0xfe) == 0xfc
}

// ---------------------------------------------------------------------------
// Tauri commands — Read
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn browser_status(
    state: tauri::State<'_, BrowserState>,
    request: Option<BrowserSessionRequest>,
) -> Result<BrowserStatusResult, String> {
    let request = request.unwrap_or(BrowserSessionRequest {
        session_id: None,
        allow_localhost: None,
        timeout_ms: None,
    });
    require_localhost_session(&request).map_err(|e| e.to_string())?;

    let has_sidecar = {
        let guard = state
            .inner
            .lock()
            .map_err(|e| format!("Failed to lock browser state: {e}"))?;
        guard.is_some()
    };

    if !has_sidecar {
        return Ok(BrowserStatusResult {
            sidecar_running: false,
            url: String::new(),
            title: String::new(),
            status: 0,
            load_state: "idle".to_string(),
            can_go_back: false,
            can_go_forward: false,
        });
    }

    let result =
        send_request(&state, "status", serde_json::Value::Null).map_err(|e| e.to_string())?;
    if result
        .get("sidecarRunning")
        .or_else(|| result.get("sidecar_running"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        validate_current_page_url(&result, request.allow_localhost.unwrap_or(false))
            .map_err(|e| e.to_string())?;
    }
    Ok(status_from_value(result))
}

#[tauri::command]
pub(crate) fn browser_navigate(
    state: tauri::State<'_, BrowserState>,
    request: BrowserNavigateRequest,
) -> Result<BrowserNavigateResult, String> {
    ensure_localhost_navigation_session(
        request.allow_localhost.unwrap_or(false),
        request.session_id.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    if request.allow_localhost.unwrap_or(false) {
        validate_url_with_localhost(&request.url, true).map_err(|e| e.to_string())?;
    } else {
        validate_url(&request.url).map_err(|e| e.to_string())?;
    }

    let params = serde_json::json!({
        "url": request.url,
        "waitForSelector": request.wait_for_selector,
        "timeoutMs": request.timeout_ms,
        "allowLocalhost": request.allow_localhost.unwrap_or(false),
    });

    let result = send_request(&state, "navigate", params).map_err(|e| e.to_string())?;
    validate_current_page_url(&result, request.allow_localhost.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    let status = status_from_value(result);

    Ok(BrowserNavigateResult {
        url: status.url,
        title: status.title,
        status: status.status,
        load_state: status.load_state,
        can_go_back: status.can_go_back,
        can_go_forward: status.can_go_forward,
    })
}

#[tauri::command]
pub(crate) fn browser_snapshot(
    state: tauri::State<'_, BrowserState>,
    request: Option<BrowserSessionRequest>,
) -> Result<BrowserSnapshotResult, String> {
    let request = request.unwrap_or(BrowserSessionRequest {
        session_id: None,
        allow_localhost: None,
        timeout_ms: None,
    });
    require_localhost_session(&request).map_err(|e| e.to_string())?;
    let allow_localhost = request.allow_localhost.unwrap_or(false);

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
    validate_current_page_url(&content_result, allow_localhost).map_err(|e| e.to_string())?;
    let screenshot_result = send_request(
        &state,
        "screenshot",
        serde_json::json!({
            "selector": serde_json::Value::Null,
            "fullPage": false,
        }),
    )
    .map_err(|e| e.to_string())?;
    validate_current_page_url(&screenshot_result, allow_localhost).map_err(|e| e.to_string())?;
    let status_result =
        send_request(&state, "status", serde_json::Value::Null).map_err(|e| e.to_string())?;
    let status = status_from_value(status_result);
    Ok(BrowserSnapshotResult {
        sidecar_running: status.sidecar_running,
        url: status.url,
        title: status.title,
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
        can_go_back: status.can_go_back,
        can_go_forward: status.can_go_forward,
    })
}

#[tauri::command]
pub(crate) fn browser_refresh(
    state: tauri::State<'_, BrowserState>,
    request: BrowserSessionRequest,
) -> Result<BrowserStatusResult, String> {
    require_localhost_session(&request).map_err(|e| e.to_string())?;
    let result =
        send_request(&state, "refresh", session_params(&request)).map_err(|e| e.to_string())?;
    validate_current_page_url(&result, request.allow_localhost.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    Ok(status_from_value(result))
}

#[tauri::command]
pub(crate) fn browser_go_back(
    state: tauri::State<'_, BrowserState>,
    request: BrowserSessionRequest,
) -> Result<BrowserStatusResult, String> {
    require_localhost_session(&request).map_err(|e| e.to_string())?;
    let result =
        send_request(&state, "goBack", session_params(&request)).map_err(|e| e.to_string())?;
    validate_current_page_url(&result, request.allow_localhost.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    Ok(status_from_value(result))
}

#[tauri::command]
pub(crate) fn browser_go_forward(
    state: tauri::State<'_, BrowserState>,
    request: BrowserSessionRequest,
) -> Result<BrowserStatusResult, String> {
    require_localhost_session(&request).map_err(|e| e.to_string())?;
    let result =
        send_request(&state, "goForward", session_params(&request)).map_err(|e| e.to_string())?;
    validate_current_page_url(&result, request.allow_localhost.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    Ok(status_from_value(result))
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
    validate_current_page_url(&result, false).map_err(|e| e.to_string())?;

    Ok(BrowserScreenshotResult {
        data_url: result
            .get("dataUrl")
            .or_else(|| result.get("data_url"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        width: result.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        height: result.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
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
    validate_current_page_url(&result, false).map_err(|e| e.to_string())?;

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
pub(crate) fn browser_extract_links(
    state: tauri::State<'_, BrowserState>,
    request: BrowserExtractLinksRequest,
) -> Result<BrowserExtractLinksResult, String> {
    let params = serde_json::json!({
        "selector": request.selector,
        "maxResults": request.max_results,
    });

    let result = send_request(&state, "extractLinks", params).map_err(|e| e.to_string())?;
    validate_current_page_url(&result, false).map_err(|e| e.to_string())?;
    let links = result
        .get("links")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| BrowserExtractedLink {
                    href: item
                        .get("href")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    text: item
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    tag: item
                        .get("tag")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    rel: item
                        .get("rel")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(BrowserExtractLinksResult {
        count: result
            .get("count")
            .and_then(|value| value.as_u64())
            .unwrap_or(links.len() as u64) as usize,
        links,
    })
}

#[tauri::command]
pub(crate) fn browser_plan_write(
    state: tauri::State<'_, BrowserState>,
    request: BrowserPlanWriteRequest,
) -> Result<BrowserPlanWriteResult, String> {
    let session_id = validate_browser_session_id(&request.session_id).map_err(|e| e.to_string())?;
    let tool_name = browser_tool_name(&request.action)
        .map_err(|e| e.to_string())?
        .to_string();
    let payload = browser_write_payload(
        serde_json::json!(request.selector),
        serde_json::json!(request.expression),
        serde_json::json!(request.test_file),
        serde_json::json!(request.input_summary),
        serde_json::json!(request.input_hash),
        serde_json::json!(request.input_bytes),
        serde_json::json!(request.script_hash),
        serde_json::json!(request.script_bytes),
    );
    let preview_hash = create_browser_preview_hash(&session_id, &request.action, &payload);
    let approval_id = create_approval_id();
    let binding = create_native_approval_binding(
        approval_id.clone(),
        &tool_name,
        request.task_id.unwrap_or_default(),
        preview_hash.clone(),
        false,
    );
    let binding_view = NativeApprovalBindingView {
        task_id: binding.task_id().to_string(),
    };
    let mut approvals = state
        .approvals
        .lock()
        .map_err(|_| "Browser approval state could not be locked.".to_string())?;
    approvals.insert(
        approval_id.clone(),
        PendingBrowserApproval {
            action: request.action.clone(),
            session_id: session_id.clone(),
            preview_hash: preview_hash.clone(),
            binding,
        },
    );
    Ok(BrowserPlanWriteResult {
        approval_id,
        tool_name,
        session_id,
        action: request.action,
        preview_hash,
        binding: binding_view,
    })
}

#[tauri::command]
pub(crate) fn browser_approve_write(
    state: tauri::State<'_, BrowserState>,
    request: BrowserApproveWriteRequest,
) -> Result<BrowserApproveWriteResult, String> {
    let session_id = validate_browser_session_id(&request.session_id).map_err(|e| e.to_string())?;
    let tool_name = browser_tool_name(&request.action).map_err(|e| e.to_string())?;
    let mut approvals = state
        .approvals
        .lock()
        .map_err(|_| "Browser approval state could not be locked.".to_string())?;
    let pending = approvals
        .get_mut(&request.approval_id)
        .ok_or_else(|| "Browser approval was not found.".to_string())?;
    if pending.action != request.action || pending.session_id != session_id {
        return Err("Browser approval scope does not match this operation.".to_string());
    }
    approve_native_approval_binding(
        &mut pending.binding,
        &request.approval_id,
        tool_name,
        request.task_id.as_deref(),
        &request.preview_hash,
        "Browser approval id does not match the pending operation.",
    )?;
    Ok(BrowserApproveWriteResult {
        approval_id: request.approval_id,
        approved: true,
    })
}

#[tauri::command]
pub(crate) fn browser_click(
    state: tauri::State<'_, BrowserState>,
    request: BrowserClickRequest,
) -> Result<BrowserClickResult, String> {
    let params = serde_json::json!({
        "selector": request.selector.clone(),
        "button": request.button,
        "clickCount": request.click_count,
        "timeoutMs": request.timeout_ms,
    });
    require_browser_approval(
        &state,
        request.approval_id.as_deref(),
        request.task_id.as_deref(),
        request.session_id.as_deref(),
        "click",
        &browser_write_payload(
            params.get("selector").cloned().unwrap_or_default(),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
        ),
    )
    .map_err(|e| e.to_string())?;

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
    let params = serde_json::json!({
        "selector": request.selector.clone(),
        "text": request.text.clone(),
        "delay": request.delay,
        "clearBefore": request.clear_before,
        "pressEnter": request.press_enter,
    });
    require_browser_approval(
        &state,
        request.approval_id.as_deref(),
        request.task_id.as_deref(),
        request.session_id.as_deref(),
        "type",
        &browser_write_payload(
            params.get("selector").cloned().unwrap_or_default(),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::json!("text input"),
            serde_json::json!(browser_text_hash(&request.text)),
            serde_json::json!(browser_text_bytes(&request.text)),
            serde_json::Value::Null,
            serde_json::Value::Null,
        ),
    )
    .map_err(|e| e.to_string())?;

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
    let params = serde_json::json!({
        "expression": request.expression,
        "timeoutMs": request.timeout_ms,
    });
    require_browser_approval(
        &state,
        request.approval_id.as_deref(),
        request.task_id.as_deref(),
        request.session_id.as_deref(),
        "evaluate",
        &browser_write_payload(
            serde_json::Value::Null,
            params.get("expression").cloned().unwrap_or_default(),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
        ),
    )
    .map_err(|e| e.to_string())?;

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
    let BrowserRunTestRequest {
        task_id,
        session_id,
        approval_id,
        script,
        test_file,
        timeout_ms,
    } = request;
    let script_hash = browser_text_hash(&script);
    let script_bytes = browser_text_bytes(&script);
    let params = serde_json::json!({
        "script": script.clone(),
        "testFile": test_file,
        "timeoutMs": timeout_ms,
    });
    require_browser_approval(
        &state,
        approval_id.as_deref(),
        task_id.as_deref(),
        session_id.as_deref(),
        "runTest",
        &browser_write_payload(
            serde_json::Value::Null,
            serde_json::Value::Null,
            params.get("testFile").cloned().unwrap_or_default(),
            serde_json::json!("browser test"),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::json!(script_hash),
            serde_json::json!(script_bytes),
        ),
    )
    .map_err(|e| e.to_string())?;
    let result = send_request(&state, "runTest", params).map_err(|e| e.to_string())?;
    Ok(BrowserRunTestResult {
        passed: result
            .get("passed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        exit_code: result
            .get("exitCode")
            .or_else(|| result.get("exit_code"))
            .and_then(|v| v.as_i64())
            .unwrap_or(1) as i32,
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
            .unwrap_or_default(),
    })
}

// ---------------------------------------------------------------------------
// Tauri commands — Utility
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn browser_close(state: tauri::State<'_, BrowserState>) -> Result<(), String> {
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
        assert!(
            validate_url_with_resolver("https://example.com", false, |_host, _port| {
                Ok(vec!["93.184.216.34".parse().unwrap()])
            })
            .is_ok()
        );
        assert!(validate_url_with_resolver(
            "https://example.com/path?q=1",
            false,
            |_host, _port| { Ok(vec!["93.184.216.34".parse().unwrap()]) }
        )
        .is_ok());
    }

    #[test]
    fn validate_url_allows_public_http() {
        assert!(
            validate_url_with_resolver("http://example.com", false, |_host, _port| {
                Ok(vec!["93.184.216.34".parse().unwrap()])
            })
            .is_ok()
        );
    }

    #[test]
    fn validate_url_rejects_hostname_resolving_to_private_ip() {
        let result =
            validate_url_with_resolver("https://public-name.example", false, |_host, _port| {
                Ok(vec!["127.0.0.1".parse().unwrap()])
            });

        assert!(result.is_err());
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
    fn sidecar_script_candidates_include_packaged_resources_dir() {
        let exe_path = if cfg!(windows) {
            Path::new("C:/Program Files/Javis/Javis.exe")
        } else {
            Path::new("/opt/javis/javis")
        };
        let candidates = sidecar_script_candidates_near_executable(exe_path);
        let normalized: Vec<String> = candidates
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();

        assert!(normalized
            .iter()
            .any(|path| path.ends_with("/resources/sidecar/browser/dist/index.js")));
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
    fn localhost_navigation_requires_session_id() {
        assert!(ensure_localhost_navigation_session(true, None).is_err());
        assert!(ensure_localhost_navigation_session(true, Some("   ")).is_err());
        assert!(ensure_localhost_navigation_session(true, Some("thread:task")).is_ok());
        assert!(ensure_localhost_navigation_session(false, None).is_ok());
    }

    #[test]
    fn browser_write_permission_rejects_self_reported_modes() {
        assert!(ensure_browser_write_permission(Some("session"), Some("confirmed_write")).is_err());
        assert!(ensure_browser_write_permission(Some("session"), Some("full_access")).is_err());
        assert!(ensure_browser_write_permission(Some("session"), Some("read_only")).is_err());
        assert!(ensure_browser_write_permission(None, Some("full_access")).is_err());
    }

    #[test]
    fn browser_native_approval_allows_matching_payload_once() {
        let state = BrowserState::new();
        let payload = browser_write_payload(
            serde_json::json!("#submit"),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
        );
        let preview_hash = create_browser_preview_hash("session-1", "click", &payload);
        let mut binding = create_native_approval_binding(
            "approval-1".to_string(),
            "browser.click",
            "task-1".to_string(),
            preview_hash.clone(),
            false,
        );
        approve_native_approval_binding(
            &mut binding,
            "approval-1",
            "browser.click",
            Some("task-1"),
            &preview_hash,
            "mismatch",
        )
        .expect("approve browser click");
        state.approvals.lock().unwrap().insert(
            "approval-1".to_string(),
            PendingBrowserApproval {
                action: "click".to_string(),
                session_id: "session-1".to_string(),
                preview_hash,
                binding,
            },
        );

        require_browser_approval(
            &state,
            Some("approval-1"),
            Some("task-1"),
            Some("session-1"),
            "click",
            &payload,
        )
        .expect("matching approval should pass");
        assert!(require_browser_approval(
            &state,
            Some("approval-1"),
            Some("task-1"),
            Some("session-1"),
            "click",
            &payload,
        )
        .is_err());
    }

    #[test]
    fn browser_native_approval_rejects_changed_payload() {
        let state = BrowserState::new();
        let approved_payload = browser_write_payload(
            serde_json::json!("#submit"),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
        );
        let changed_payload = browser_write_payload(
            serde_json::json!("#delete"),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::Value::Null,
        );
        let preview_hash = create_browser_preview_hash("session-1", "click", &approved_payload);
        let mut binding = create_native_approval_binding(
            "approval-1".to_string(),
            "browser.click",
            String::new(),
            preview_hash.clone(),
            false,
        );
        approve_native_approval_binding(
            &mut binding,
            "approval-1",
            "browser.click",
            None,
            &preview_hash,
            "mismatch",
        )
        .expect("approve browser click");
        state.approvals.lock().unwrap().insert(
            "approval-1".to_string(),
            PendingBrowserApproval {
                action: "click".to_string(),
                session_id: "session-1".to_string(),
                preview_hash,
                binding,
            },
        );

        assert!(require_browser_approval(
            &state,
            Some("approval-1"),
            None,
            Some("session-1"),
            "click",
            &changed_payload,
        )
        .is_err());
    }

    #[test]
    fn browser_native_approval_rejects_changed_type_text() {
        let state = BrowserState::new();
        let approved_payload = browser_write_payload(
            serde_json::json!("#message"),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::json!("text input"),
            serde_json::json!(browser_text_hash("approved text")),
            serde_json::json!(browser_text_bytes("approved text")),
            serde_json::Value::Null,
            serde_json::Value::Null,
        );
        let changed_payload = browser_write_payload(
            serde_json::json!("#message"),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::json!("text input"),
            serde_json::json!(browser_text_hash("changed text")),
            serde_json::json!(browser_text_bytes("changed text")),
            serde_json::Value::Null,
            serde_json::Value::Null,
        );
        let preview_hash = create_browser_preview_hash("session-1", "type", &approved_payload);
        let mut binding = create_native_approval_binding(
            "approval-1".to_string(),
            "browser.type",
            String::new(),
            preview_hash.clone(),
            false,
        );
        approve_native_approval_binding(
            &mut binding,
            "approval-1",
            "browser.type",
            None,
            &preview_hash,
            "mismatch",
        )
        .expect("approve browser type");
        state.approvals.lock().unwrap().insert(
            "approval-1".to_string(),
            PendingBrowserApproval {
                action: "type".to_string(),
                session_id: "session-1".to_string(),
                preview_hash,
                binding,
            },
        );

        assert!(require_browser_approval(
            &state,
            Some("approval-1"),
            None,
            Some("session-1"),
            "type",
            &changed_payload,
        )
        .is_err());
    }

    #[test]
    fn browser_native_approval_rejects_changed_test_script() {
        let state = BrowserState::new();
        let approved_payload = browser_write_payload(
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::json!("browser.spec.ts"),
            serde_json::json!("browser test"),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::json!(browser_text_hash("expect(page).toBeTruthy();")),
            serde_json::json!(browser_text_bytes("expect(page).toBeTruthy();")),
        );
        let changed_payload = browser_write_payload(
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::json!("browser.spec.ts"),
            serde_json::json!("browser test"),
            serde_json::Value::Null,
            serde_json::Value::Null,
            serde_json::json!(browser_text_hash("await page.click('#delete');")),
            serde_json::json!(browser_text_bytes("await page.click('#delete');")),
        );
        let preview_hash = create_browser_preview_hash("session-1", "runTest", &approved_payload);
        let mut binding = create_native_approval_binding(
            "approval-1".to_string(),
            "browser.runTest",
            String::new(),
            preview_hash.clone(),
            false,
        );
        approve_native_approval_binding(
            &mut binding,
            "approval-1",
            "browser.runTest",
            None,
            &preview_hash,
            "mismatch",
        )
        .expect("approve browser test");
        state.approvals.lock().unwrap().insert(
            "approval-1".to_string(),
            PendingBrowserApproval {
                action: "runTest".to_string(),
                session_id: "session-1".to_string(),
                preview_hash,
                binding,
            },
        );

        assert!(require_browser_approval(
            &state,
            Some("approval-1"),
            None,
            Some("session-1"),
            "runTest",
            &changed_payload,
        )
        .is_err());
    }

    #[test]
    fn current_page_url_rejects_redirected_private_url() {
        let result = serde_json::json!({ "url": "http://127.0.0.1:3000/admin" });

        assert!(validate_current_page_url(&result, false).is_err());
    }

    #[test]
    fn current_page_url_allows_explicit_localhost_navigation() {
        let result = serde_json::json!({ "url": "http://localhost:3000" });

        assert!(validate_current_page_url(&result, true).is_ok());
    }
}
