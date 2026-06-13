use crate::error::JavisError;
use crate::{require_native_approval_binding, NativeApprovalBinding};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::Storage::Xps::PrintWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

// ── Request / Result types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenshotRequest {
    pub window_handle: Option<u64>,
    pub region: Option<ScreenRegion>,
    pub method: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenRegion {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenshotResult {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
    pub source_origin_x: i32,
    pub source_origin_y: i32,
    pub scale_x: f64,
    pub scale_y: f64,
    pub health: ComputerScreenshotHealth,
    pub captured_at: String,
    pub method_used: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenshotHealth {
    pub sampled_pixels: u32,
    pub dominant_color_ratio: f64,
    pub dark_pixel_ratio: f64,
    pub suspicious_blank: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerListWindowsRequest {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerListWindowsResult {
    pub windows: Vec<WindowInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ComputerDetectUiObjectsRequest {
    pub image_data_url: String,
    pub screenshot_id: String,
    pub observation_id: Option<String>,
    pub window_handle: Option<u64>,
    pub classes: Option<Vec<String>>,
    pub model_path: Option<String>,
    pub runtime: Option<String>,
    pub runtime_adapter_path: Option<String>,
    pub reuse_worker: Option<bool>,
    pub imgsz: Option<u32>,
    pub max_detections: Option<u16>,
    pub min_confidence: Option<f64>,
    pub iou_threshold: Option<f64>,
    pub timeout_ms: Option<u64>,
    pub label_map: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVisionWorkerRequest {
    pub image_path: String,
    pub screenshot_id: String,
    pub observation_id: Option<String>,
    pub window_handle: Option<u64>,
    pub classes: Option<Vec<String>>,
    pub model_path: Option<String>,
    pub runtime: Option<String>,
    pub runtime_adapter_path: Option<String>,
    pub imgsz: Option<u32>,
    pub max_detections: Option<u16>,
    pub min_confidence: Option<f64>,
    pub iou_threshold: Option<f64>,
    pub timeout_ms: Option<u64>,
    pub label_map: Option<serde_json::Value>,
}

const LOCAL_VISION_WORKER_PATH_ENV: &str = "JAVIS_LOCAL_VISION_WORKER_PATH";
const LOCAL_VISION_NODE_PATH_ENV: &str = "JAVIS_LOCAL_VISION_NODE_PATH";
const LOCAL_VISION_REQUEST_PATH_ENV: &str = "JAVIS_LOCAL_VISION_REQUEST_PATH";
const LOCAL_VISION_REUSE_WORKER_ENV: &str = "JAVIS_LOCAL_VISION_REUSE_WORKER";
const LOCAL_VISION_UI_MODEL_FILENAME: &str = "yolo26n-ui.onnx";
const LOCAL_VISION_BUNDLED_MODEL_RELATIVE_PATH: &str = "models/local-vision/yolo26n-ui.onnx";
const LOCAL_VISION_WORKER_RELATIVE_PATHS: &[&str] = &[
    "scripts/local-vision-worker.mjs",
    "scripts/local-vision-worker.cmd",
    "local-vision-worker.mjs",
    "local-vision-worker.cmd",
];
const LOCAL_VISION_DEFAULT_TIMEOUT_MS: u64 = 120;
const LOCAL_VISION_MIN_TIMEOUT_MS: u64 = 20;
const LOCAL_VISION_MAX_TIMEOUT_MS: u64 = 2_000;
const LOCAL_VISION_MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const LOCAL_VISION_MAX_IMAGE_BASE64_CHARS: usize = ((LOCAL_VISION_MAX_IMAGE_BYTES + 2) / 3) * 4;
const LOCAL_VISION_MAX_WORKER_REQUEST_JSON_BYTES: usize = 512 * 1024;
const LOCAL_VISION_MAX_WORKER_STDOUT_BYTES: usize = 1024 * 1024;
const LOCAL_VISION_MAX_WORKER_STDERR_BYTES: usize = 64 * 1024;
const LOCAL_VISION_OUTPUT_DRAIN_TIMEOUT_MS: u64 = 100;
const LOCAL_VISION_DEFAULT_MAX_DETECTIONS: usize = 20;
const LOCAL_VISION_MAX_DETECTIONS: usize = 100;
const LOCAL_VISION_DEFAULT_MIN_CONFIDENCE: f64 = 0.25;
static LOCAL_VISION_REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);
static LOCAL_VISION_REUSABLE_WORKER: Lazy<Mutex<Option<ReusableLocalVisionWorker>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerDetectUiObjectsResult {
    pub screenshot_id: String,
    pub detections: Vec<ComputerUiDetection>,
    pub latency_ms: u64,
    pub model: String,
    pub runtime: String,
    pub timed_out: bool,
    pub error: Option<String>,
    pub diagnostics: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUiDetection {
    pub id: String,
    pub label: String,
    pub confidence: f64,
    #[serde(rename = "box")]
    pub box_: ComputerUiDetectionBox,
    pub center: ComputerUiDetectionPoint,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUiDetectionBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub coordinate_space: String,
    pub screenshot_size: Option<ComputerUiDetectionSize>,
    pub device_pixel_ratio: Option<f64>,
    pub monitor_id: Option<String>,
    pub window_handle: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUiDetectionPoint {
    pub x: f64,
    pub y: f64,
    pub coordinate_space: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUiDetectionSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub handle: u64,
    pub title: String,
    pub class_name: String,
    pub rect: WindowRect,
    pub is_visible: bool,
    pub is_foreground: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerFocusWindowRequest {
    pub handle: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerFocusWindowResult {
    pub focused: bool,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerMoveMouseRequest {
    pub x: i32,
    pub y: i32,
    pub speed: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerMoveMouseResult {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerClickRequest {
    pub x: i32,
    pub y: i32,
    pub button: Option<String>,
    pub click_count: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerClickResult {
    pub x: i32,
    pub y: i32,
    pub clicked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerTypeRequest {
    pub text: String,
    pub delay_ms: Option<u64>,
    pub clear_before: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerTypeResult {
    pub typed: bool,
    pub length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerKeyComboRequest {
    pub keys: Vec<String>,
    pub press_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerKeyComboResult {
    pub combo: String,
    pub executed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScrollRequest {
    pub x: i32,
    pub y: i32,
    pub delta: i32,
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScrollResult {
    pub x: i32,
    pub y: i32,
    pub delta: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWaitRequest {
    pub ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWaitResult {
    pub waited: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiElementSelector {
    pub window_handle: u64,
    pub automation_id: Option<String>,
    pub name: Option<String>,
    pub control_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerInspectUiRequest {
    pub window_handle: u64,
    pub max_depth: Option<u8>,
    pub max_nodes: Option<u16>,
    pub include_values: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerInspectUiResult {
    pub tree: String,
    pub node_count: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerInvokeUiRequest {
    pub selector: UiElementSelector,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerInvokeUiResult {
    pub invoked: bool,
    pub matched_name: String,
    pub matched_automation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSetUiValueRequest {
    pub selector: UiElementSelector,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSetUiValueResult {
    pub set: bool,
    pub matched_name: String,
    pub matched_automation_id: String,
}

// ── Approval state (follows code.rs pattern) ────────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct ComputerApprovalState {
    pub(crate) pending: HashMap<String, PendingComputerApproval>,
    pub(crate) leases: HashMap<String, ComputerApprovalLease>,
    pub(crate) last_write_at: Option<SystemTime>,
}

#[derive(Debug)]
pub(crate) struct PendingComputerApproval {
    pub(crate) binding: NativeApprovalBinding,
    pub(crate) created_at: SystemTime,
}

#[derive(Debug)]
pub(crate) struct ComputerApprovalLease {
    pub(crate) task_id: String,
    pub(crate) approval_id: String,
    pub(crate) created_at: SystemTime,
    pub(crate) remaining_actions: u16,
    pub(crate) scope: ComputerApprovalScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ComputerApprovalScope {
    pub(crate) window_handle: Option<u64>,
    pub(crate) window_title: Option<String>,
    pub(crate) allowed_tools: Vec<String>,
}

// ── Safety guards ───────────────────────────────────────────────────────────

const COMPUTER_APPROVAL_TTL: Duration = Duration::from_secs(5 * 60);
const COMPUTER_LEASE_TTL: Duration = Duration::from_secs(2 * 60);
const COMPUTER_LEASE_MAX_ACTIONS: u16 = 12;
const COMPUTER_WRITE_MIN_INTERVAL: Duration = Duration::from_millis(50);

const DENIED_WINDOW_PATTERNS: &[&str] = &[
    "Task Manager",
    "任务管理器",
    "Registry Editor",
    "注册表编辑器",
    "Windows Security",
    "Windows 安全中心",
    "User Account Control",
    "用户账户控制",
    "System Configuration",
    "系统配置",
    "Computer Management",
    "计算机管理",
];

const DENIED_KEY_COMBOS: &[&[&str]] = &[
    &["Win", "R"],
    &["Ctrl", "Alt", "Del"],
    &["Win", "L"],
    &["Ctrl", "Shift", "Esc"],
    &["Alt", "F4"],
    &["Win", "D"],
];

fn validate_window_title(title: &str) -> Result<(), JavisError> {
    let lower_title = title.to_lowercase();
    for pattern in DENIED_WINDOW_PATTERNS {
        if lower_title.contains(&pattern.to_lowercase()) {
            return Err(JavisError::Permission(format!(
                "Window '{title}' matches denied pattern '{pattern}'"
            )));
        }
    }
    Ok(())
}

fn validate_pending_computer_approval(pending: &PendingComputerApproval) -> Result<(), JavisError> {
    let age = pending.created_at.elapsed().map_err(|_| {
        JavisError::Permission("Computer Use approval timestamp is invalid.".into())
    })?;
    if age > COMPUTER_APPROVAL_TTL {
        return Err(JavisError::Permission(
            "Computer Use approval expired; please approve the action again.".into(),
        ));
    }
    Ok(())
}

fn validate_computer_approval_lease(lease: &ComputerApprovalLease) -> Result<(), JavisError> {
    let age = lease
        .created_at
        .elapsed()
        .map_err(|_| JavisError::Permission("Computer Use lease timestamp is invalid.".into()))?;
    if age > COMPUTER_LEASE_TTL {
        return Err(JavisError::Permission(
            "Computer Use task approval expired; please approve the next action again.".into(),
        ));
    }
    if lease.remaining_actions == 0 {
        return Err(JavisError::Permission(
            "Computer Use task approval action limit reached; please approve the next action again."
                .into(),
        ));
    }
    Ok(())
}

fn validate_reusable_computer_approval_scope(
    scope: &ComputerApprovalScope,
) -> Result<(), JavisError> {
    if scope.window_handle.is_none() {
        return Err(JavisError::Permission(
            "Computer Use task approval requires a known target window.".into(),
        ));
    }
    Ok(())
}

fn pointer_computer_lease_tools() -> Vec<String> {
    ["computer.moveMouse", "computer.click", "computer.scroll"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn reusable_computer_lease_tools_for(tool_name: &str) -> Vec<String> {
    match tool_name {
        "computer.focusWindow" => [
            "computer.focusWindow",
            "computer.moveMouse",
            "computer.click",
            "computer.scroll",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
        "computer.moveMouse" | "computer.click" | "computer.scroll" => {
            pointer_computer_lease_tools()
        }
        "computer.invokeUi" => vec!["computer.invokeUi".to_string()],
        "computer.setUiValue" => vec!["computer.setUiValue".to_string()],
        _ => Vec::new(),
    }
}

fn computer_action_scope(
    tool_name: &str,
    params: &serde_json::Value,
) -> Result<ComputerApprovalScope, JavisError> {
    let window_handle = action_window_handle(tool_name, params)?;
    let window_title = window_handle.map(window_title_for_scope).transpose()?;
    let allowed_tools = reusable_computer_lease_tools_for(tool_name);
    if allowed_tools.is_empty() {
        return Err(JavisError::Permission(format!(
            "Computer Use task approval cannot be reused for {tool_name}."
        )));
    }
    Ok(ComputerApprovalScope {
        window_handle,
        window_title,
        allowed_tools,
    })
}

fn validate_computer_lease_scope(
    lease: &ComputerApprovalLease,
    tool_name: &str,
    params: &serde_json::Value,
) -> Result<(), JavisError> {
    if !lease
        .scope
        .allowed_tools
        .iter()
        .any(|tool| tool == tool_name)
    {
        return Err(JavisError::Permission(format!(
            "Computer Use task approval does not allow {tool_name}."
        )));
    }
    validate_reusable_computer_approval_scope(&lease.scope)?;
    let action_scope = computer_action_scope(tool_name, params)?;
    match (lease.scope.window_handle, action_scope.window_handle) {
        (Some(expected), Some(actual)) if expected != actual => {
            return Err(JavisError::Permission(
                "Computer Use task approval cannot be reused across windows.".into(),
            ));
        }
        (Some(_), None) => {
            return Err(JavisError::Permission(
                "Computer Use task approval requires actions to stay in the approved window."
                    .into(),
            ));
        }
        _ => {}
    }
    if let (Some(expected), Some(actual)) = (&lease.scope.window_title, &action_scope.window_title)
    {
        if expected != actual {
            return Err(JavisError::Permission(
                "Computer Use task approval window title changed; please approve again.".into(),
            ));
        }
    }
    Ok(())
}

fn validate_computer_task_lease_for_action(
    lease: &mut ComputerApprovalLease,
    approval_id: &str,
    task_id: &str,
    tool_name: &str,
    params: &serde_json::Value,
) -> Result<(), String> {
    validate_computer_approval_lease(lease).map_err(|e| e.to_string())?;
    if lease.approval_id != approval_id || lease.task_id != task_id {
        return Err("Computer Use task approval does not match this action.".to_string());
    }
    if requires_per_action_computer_approval(tool_name, params) {
        return Err("This Computer Use action requires a fresh per-action approval.".to_string());
    }
    if is_commit_action(tool_name, params) {
        return Err("Commit actions (Enter, send, submit) require fresh per-action approval and cannot use task leases.".to_string());
    }
    validate_computer_lease_scope(lease, tool_name, params).map_err(|e| e.to_string())?;
    lease.remaining_actions = lease.remaining_actions.saturating_sub(1);
    Ok(())
}

fn is_commit_action(tool_name: &str, params: &serde_json::Value) -> bool {
    match tool_name {
        "computer.keyCombo" => {
            if let Some(keys) = params.get("keys").and_then(|v| v.as_array()) {
                let key_strs: Vec<String> = keys
                    .iter()
                    .filter_map(|k| k.as_str().map(|s| s.to_lowercase()))
                    .collect();
                let has_enter = key_strs.iter().any(|k| k == "enter" || k == "return");
                let has_ctrl = key_strs.iter().any(|k| k == "ctrl" || k == "control");
                let has_shift = key_strs.iter().any(|k| k == "shift");
                if has_enter && (has_ctrl || has_shift) {
                    return true;
                }
                if has_enter && key_strs.len() == 1 {
                    return true;
                }
            }
            false
        }
        "computer.invokeUi" => {
            let selector = params
                .get("selector")
                .or_else(|| params.get("Selector"))
                .unwrap_or(&serde_json::Value::Null);
            selector_name_contains_sensitive_text(selector)
        }
        _ => false,
    }
}

fn remove_matching_computer_lease(
    state: &Mutex<ComputerApprovalState>,
    task_id: &str,
    approval_id: &str,
) -> bool {
    let Ok(mut guard) = state.lock() else {
        return false;
    };
    let should_remove = guard
        .leases
        .get(task_id)
        .is_some_and(|lease| lease.approval_id == approval_id);
    if should_remove {
        guard.leases.remove(task_id);
    }
    should_remove
}

fn window_title(hwnd: HWND) -> String {
    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32) };
    String::from_utf16_lossy(&title_buf[..title_len as usize])
}

fn validate_window_handle_title(handle: u64) -> Result<(), JavisError> {
    let hwnd = handle as HWND;
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return Err(JavisError::Validation(format!(
            "Invalid window handle: {handle}"
        )));
    }
    validate_window_title(&window_title(hwnd))
}

fn window_title_for_scope(handle: u64) -> Result<String, JavisError> {
    let hwnd = handle as HWND;
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return Err(JavisError::Validation(format!(
            "Invalid window handle: {handle}"
        )));
    }
    let title = window_title(hwnd);
    validate_window_title(&title)?;
    Ok(title)
}

fn action_window_handle(
    tool_name: &str,
    params: &serde_json::Value,
) -> Result<Option<u64>, JavisError> {
    match tool_name {
        "computer.focusWindow" => Ok(params.get("handle").and_then(|value| value.as_u64())),
        "computer.invokeUi" | "computer.setUiValue" => Ok(params
            .get("selector")
            .or_else(|| params.get("Selector"))
            .and_then(|selector| {
                selector
                    .get("windowHandle")
                    .or_else(|| selector.get("window_handle"))
                    .and_then(|value| value.as_u64())
            })),
        "computer.moveMouse" | "computer.click" | "computer.scroll" => {
            let Some(x) = params.get("x").and_then(|value| value.as_i64()) else {
                return Ok(None);
            };
            let Some(y) = params.get("y").and_then(|value| value.as_i64()) else {
                return Ok(None);
            };
            Ok(window_handle_at_point(x as i32, y as i32))
        }
        _ => Ok(None),
    }
}

fn window_handle_at_point(x: i32, y: i32) -> Option<u64> {
    let point = POINT { x, y };
    let hwnd = unsafe {
        let desktop = GetDesktopWindow();
        let child = ChildWindowFromPointEx(desktop, point, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
        if child.is_null() {
            WindowFromPoint(point)
        } else {
            child
        }
    };
    if hwnd.is_null() {
        return None;
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let target = if root.is_null() { hwnd } else { root };
    if target.is_null() {
        None
    } else {
        Some(target as u64)
    }
}

fn validate_window_not_minimized(handle: u64) -> Result<(), JavisError> {
    let hwnd = handle as HWND;
    if unsafe { IsIconic(hwnd) } != 0 {
        return Err(JavisError::Validation(format!(
            "Window {handle} is minimized; focus or restore the window before taking a screenshot."
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowScreenshotPath {
    PrintWindow,
    BitBlt,
}

fn window_screenshot_path_allows_minimized(path: WindowScreenshotPath) -> bool {
    matches!(path, WindowScreenshotPath::PrintWindow)
}

fn validate_window_not_minimized_for_screenshot_path(
    handle: u64,
    path: WindowScreenshotPath,
) -> Result<(), JavisError> {
    if window_screenshot_path_allows_minimized(path) {
        return Ok(());
    }
    validate_window_not_minimized(handle)
}

fn validate_foreground_window() -> Result<(), JavisError> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return Ok(());
    }
    validate_window_title(&window_title(hwnd))
}

fn validate_window_at_point(x: i32, y: i32) -> Result<(), JavisError> {
    validate_screen_coordinates(x, y)?;
    let point = POINT { x, y };
    let hwnd = unsafe {
        let desktop = GetDesktopWindow();
        let child = ChildWindowFromPointEx(desktop, point, CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT);
        if child.is_null() {
            WindowFromPoint(point)
        } else {
            child
        }
    };
    if hwnd.is_null() {
        return Ok(());
    }
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    let target = if root.is_null() { hwnd } else { root };
    validate_window_title(&window_title(target))
}

fn normalize_key(key: &str) -> String {
    match key.to_lowercase().as_str() {
        "ctrl" | "control" => "Ctrl".to_string(),
        "alt" => "Alt".to_string(),
        "shift" => "Shift".to_string(),
        "win" | "meta" | "super" => "Win".to_string(),
        _ => key.to_string(),
    }
}

fn validate_key_combo(keys: &[String]) -> Result<(), JavisError> {
    let normalized: Vec<String> = keys.iter().map(|k| normalize_key(k)).collect();
    for denied in DENIED_KEY_COMBOS {
        if denied.len() == normalized.len()
            && denied.iter().all(|key| {
                normalized
                    .iter()
                    .any(|candidate| candidate.as_str() == *key)
            })
        {
            return Err(JavisError::Permission(format!(
                "Key combination [{}] is denied",
                keys.join(" + ")
            )));
        }
    }
    Ok(())
}

fn validate_screen_coordinates(x: i32, y: i32) -> Result<(), JavisError> {
    unsafe {
        // Use virtual screen to support multi-monitor setups.
        // Coordinates can be negative when a secondary monitor is
        // positioned to the left of or above the primary.
        let x_origin = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y_origin = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if x < x_origin || x >= x_origin + vw || y < y_origin || y >= y_origin + vh {
            return Err(JavisError::Validation(format!(
                "Coordinates ({x}, {y}) outside virtual screen bounds [({x_origin},{y_origin})–({},{})]",
                x_origin + vw,
                y_origin + vh,
            )));
        }
    }
    Ok(())
}

fn hash_action_params(tool: &str, params: &serde_json::Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tool.as_bytes());
    hasher.update(serde_json::to_string(params).unwrap_or_default().as_bytes());
    format!("{:x}", hasher.finalize())
}

fn current_timestamp_iso() -> String {
    let Ok(duration) = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) else {
        return "unknown".to_string();
    };
    timestamp_secs_to_iso(duration.as_secs())
}

fn timestamp_secs_to_iso(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let seconds_of_day = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_unix_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_unix_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

// ── Virtual key code mapping ────────────────────────────────────────────────

fn key_to_vk(key: &str) -> Option<u16> {
    let k = key.to_lowercase();
    match k.as_str() {
        "ctrl" | "control" => Some(VK_CONTROL),
        "alt" | "menu" => Some(VK_MENU),
        "shift" => Some(VK_SHIFT),
        "win" | "meta" | "super" => Some(VK_LWIN),
        "enter" | "return" => Some(VK_RETURN),
        "tab" => Some(VK_TAB),
        "escape" | "esc" => Some(VK_ESCAPE),
        "backspace" => Some(VK_BACK),
        "delete" | "del" => Some(VK_DELETE),
        "space" => Some(VK_SPACE),
        "up" => Some(VK_UP),
        "down" => Some(VK_DOWN),
        "left" => Some(VK_LEFT),
        "right" => Some(VK_RIGHT),
        "home" => Some(VK_HOME),
        "end" => Some(VK_END),
        "pageup" | "page_up" => Some(VK_PRIOR),
        "pagedown" | "page_down" => Some(VK_NEXT),
        "f1" => Some(VK_F1),
        "f2" => Some(VK_F2),
        "f3" => Some(VK_F3),
        "f4" => Some(VK_F4),
        "f5" => Some(VK_F5),
        "f6" => Some(VK_F6),
        "f7" => Some(VK_F7),
        "f8" => Some(VK_F8),
        "f9" => Some(VK_F9),
        "f10" => Some(VK_F10),
        "f11" => Some(VK_F11),
        "f12" => Some(VK_F12),
        "a" => Some(0x41),
        "b" => Some(0x42),
        "c" => Some(0x43),
        "d" => Some(0x44),
        "e" => Some(0x45),
        "f" => Some(0x46),
        "g" => Some(0x47),
        "h" => Some(0x48),
        "i" => Some(0x49),
        "j" => Some(0x4A),
        "k" => Some(0x4B),
        "l" => Some(0x4C),
        "m" => Some(0x4D),
        "n" => Some(0x4E),
        "o" => Some(0x4F),
        "p" => Some(0x50),
        "q" => Some(0x51),
        "r" => Some(0x52),
        "s" => Some(0x53),
        "t" => Some(0x54),
        "u" => Some(0x55),
        "v" => Some(0x56),
        "w" => Some(0x57),
        "x" => Some(0x58),
        "y" => Some(0x59),
        "z" => Some(0x5A),
        _ if k.len() == 1 => {
            let ch = k.chars().next().unwrap();
            if ch.is_ascii_digit() {
                Some(0x30 + ch as u16 - '0' as u16)
            } else if ch.is_ascii() {
                match ch {
                    ';' | ':' => Some(VK_OEM_1),
                    '=' | '+' => Some(VK_OEM_PLUS),
                    ',' | '<' => Some(VK_OEM_COMMA),
                    '-' | '_' => Some(VK_OEM_MINUS),
                    '.' | '>' => Some(VK_OEM_PERIOD),
                    '/' | '?' => Some(VK_OEM_2),
                    '`' | '~' => Some(VK_OEM_3),
                    '[' | '{' => Some(VK_OEM_4),
                    '\\' | '|' => Some(VK_OEM_5),
                    ']' | '}' => Some(VK_OEM_6),
                    '\'' | '"' => Some(VK_OEM_7),
                    _ => None,
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

// ── Core functions ──────────────────────────────────────────────────────────

/// Capture a screenshot of the desktop or a specific window.
/// Uses GDI BitBlt for screen capture, then encodes to PNG via the `image` crate.
pub(crate) fn capture_screenshot(
    request: &ComputerScreenshotRequest,
) -> Result<ComputerScreenshotResult, JavisError> {
    if let Some(wh) = request.window_handle {
        match request.method.as_deref().unwrap_or("auto") {
            "printWindow" => {
                return capture_window_printwindow(wh, request.region.as_ref());
            }
            "auto" => {
                if let Ok(result) = capture_window_printwindow(wh, request.region.as_ref()) {
                    return Ok(result);
                }
            }
            "bitblt" => {}
            other => {
                return Err(JavisError::Validation(format!(
                    "Unsupported screenshot method: {other}"
                )));
            }
        }
    }

    unsafe {
        let null_hwnd: HWND = std::ptr::null_mut();
        let (
            hdc_src,
            width,
            height,
            source_origin_x,
            source_origin_y,
            blt_origin_x,
            blt_origin_y,
            release_fn,
        ): (HDC, i32, i32, i32, i32, i32, i32, Box<dyn Fn()>) = if let Some(wh) =
            request.window_handle
        {
            validate_window_handle_title(wh)?;
            validate_window_not_minimized_for_screenshot_path(wh, WindowScreenshotPath::BitBlt)?;
            let hwnd = wh as HWND;
            let hdc = GetWindowDC(hwnd);
            if hdc.is_null() {
                return Err(JavisError::Internal(format!(
                    "GetWindowDC failed for handle {wh}"
                )));
            }
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetWindowRect(hwnd, &mut rect);
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            (
                hdc,
                w,
                h,
                rect.left,
                rect.top,
                0,
                0,
                Box::new(move || {
                    ReleaseDC(hwnd, hdc);
                }),
            )
        } else {
            let hdc = GetDC(null_hwnd);
            if hdc.is_null() {
                return Err(JavisError::Internal("GetDC(0) failed".to_string()));
            }
            // Use virtual screen dimensions to capture all monitors,
            // not just the primary. GetDC(NULL) covers the full virtual desktop.
            let sw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let sh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            let sx = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let sy = GetSystemMetrics(SM_YVIRTUALSCREEN);
            (
                hdc,
                sw,
                sh,
                sx,
                sy,
                sx,
                sy,
                Box::new(move || {
                    ReleaseDC(null_hwnd, hdc);
                }),
            )
        };

        if width <= 0 || height <= 0 {
            release_fn();
            return Err(JavisError::Validation(format!(
                "Capture bounds must be positive, got ({width}, {height})"
            )));
        }

        let (crop_x, crop_y, crop_w, crop_h) =
            match crop_bounds(request.region.as_ref(), width, height) {
                Ok(bounds) => bounds,
                Err(err) => {
                    release_fn();
                    return Err(err);
                }
            };

        let mem_dc = CreateCompatibleDC(hdc_src);
        if mem_dc.is_null() {
            release_fn();
            return Err(JavisError::Internal(
                "CreateCompatibleDC failed".to_string(),
            ));
        }
        let hbmp = CreateCompatibleBitmap(hdc_src, crop_w, crop_h);
        if hbmp.is_null() {
            DeleteDC(mem_dc);
            release_fn();
            return Err(JavisError::Internal(
                "CreateCompatibleBitmap failed".to_string(),
            ));
        }
        let old_bmp = SelectObject(mem_dc, hbmp as HGDIOBJ);
        if old_bmp.is_null() {
            DeleteObject(hbmp as HGDIOBJ);
            DeleteDC(mem_dc);
            release_fn();
            return Err(JavisError::Internal("SelectObject failed".to_string()));
        }

        let blt_ok = BitBlt(
            mem_dc,
            0,
            0,
            crop_w,
            crop_h,
            hdc_src,
            blt_origin_x + crop_x,
            blt_origin_y + crop_y,
            SRCCOPY,
        );
        if blt_ok == 0 {
            SelectObject(mem_dc, old_bmp);
            DeleteObject(hbmp as HGDIOBJ);
            DeleteDC(mem_dc);
            release_fn();
            return Err(JavisError::Internal("BitBlt failed".to_string()));
        }

        let bmp_size = (crop_w as usize)
            .checked_mul(crop_h as usize)
            .and_then(|px| px.checked_mul(4))
            .ok_or_else(|| JavisError::Validation("Screenshot region is too large".to_string()))?;
        let mut pixels: Vec<u8> = vec![0u8; bmp_size];
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: crop_w,
                biHeight: -crop_h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: bmp_size as u32,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD {
                rgbBlue: 0,
                rgbGreen: 0,
                rgbRed: 0,
                rgbReserved: 0,
            }; 1],
        };

        let dib_lines = GetDIBits(
            mem_dc,
            hbmp,
            0,
            crop_h as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );
        // Cleanup GDI before checking result
        SelectObject(mem_dc, old_bmp);
        DeleteObject(hbmp as HGDIOBJ);
        DeleteDC(mem_dc);
        release_fn();

        if dib_lines == 0 {
            return Err(JavisError::Internal("GetDIBits failed".to_string()));
        }

        // BGRA → RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        let source_width = crop_w as u32;
        let source_height = crop_h as u32;
        let health = analyze_screenshot_health(source_width, source_height, &pixels);
        let (data_url, final_w, final_h) =
            encode_rgba_png_data_url(source_width, source_height, pixels)?;

        Ok(ComputerScreenshotResult {
            data_url,
            width: final_w,
            height: final_h,
            source_width,
            source_height,
            source_origin_x: source_origin_x + crop_x,
            source_origin_y: source_origin_y + crop_y,
            scale_x: final_w as f64 / source_width as f64,
            scale_y: final_h as f64 / source_height as f64,
            health,
            captured_at: current_timestamp_iso(),
            method_used: "bitblt".to_string(),
        })
    }
}

fn crop_bounds(
    region: Option<&ScreenRegion>,
    width: i32,
    height: i32,
) -> Result<(i32, i32, i32, i32), JavisError> {
    if let Some(r) = region {
        if r.width <= 0 || r.height <= 0 {
            return Err(JavisError::Validation(
                "Screenshot region width and height must be positive".to_string(),
            ));
        }
        if r.x >= width || r.y >= height {
            return Err(JavisError::Validation(format!(
                "Screenshot region origin ({}, {}) is outside capture bounds ({width}, {height})",
                r.x, r.y
            )));
        }
        let cx = r.x.max(0);
        let cy = r.y.max(0);
        let cw = r.width.min(width - cx);
        let ch = r.height.min(height - cy);
        if cw <= 0 || ch <= 0 {
            return Err(JavisError::Validation(
                "Screenshot region does not overlap the capture bounds".to_string(),
            ));
        }
        Ok((cx, cy, cw, ch))
    } else {
        Ok((0, 0, width, height))
    }
}

fn analyze_screenshot_health(width: u32, height: u32, pixels: &[u8]) -> ComputerScreenshotHealth {
    const MAX_SAMPLE_AXIS: u32 = 64;
    const DARK_CHANNEL_THRESHOLD: u8 = 16;
    const DOMINANT_COLOR_RATIO_THRESHOLD: f64 = 0.997;
    const DARK_PIXEL_RATIO_THRESHOLD: f64 = 0.995;
    const MIN_SAMPLED_PIXELS: u32 = 256;

    if width == 0 || height == 0 || pixels.len() < width as usize * height as usize * 4 {
        return ComputerScreenshotHealth {
            sampled_pixels: 0,
            dominant_color_ratio: 0.0,
            dark_pixel_ratio: 0.0,
            suspicious_blank: false,
            reason: None,
        };
    }

    let sample_w = width.min(MAX_SAMPLE_AXIS);
    let sample_h = height.min(MAX_SAMPLE_AXIS);
    let mut sampled_pixels = 0u32;
    let mut dark_pixels = 0u32;
    let mut dominant_count = 0u32;
    let mut color_counts: HashMap<u32, u32> = HashMap::new();

    for sy in 0..sample_h {
        let y = scale_sample_index(sy, sample_h, height);
        for sx in 0..sample_w {
            let x = scale_sample_index(sx, sample_w, width);
            let offset = ((y as usize * width as usize) + x as usize) * 4;
            let r = pixels[offset];
            let g = pixels[offset + 1];
            let b = pixels[offset + 2];
            sampled_pixels += 1;
            if r <= DARK_CHANNEL_THRESHOLD
                && g <= DARK_CHANNEL_THRESHOLD
                && b <= DARK_CHANNEL_THRESHOLD
            {
                dark_pixels += 1;
            }
            let key = ((r as u32 / 16) << 8) | ((g as u32 / 16) << 4) | (b as u32 / 16);
            let count = color_counts.entry(key).or_insert(0);
            *count += 1;
            dominant_count = dominant_count.max(*count);
        }
    }

    let sampled = sampled_pixels.max(1) as f64;
    let dominant_color_ratio = dominant_count as f64 / sampled;
    let dark_pixel_ratio = dark_pixels as f64 / sampled;
    let reason =
        if sampled_pixels >= MIN_SAMPLED_PIXELS && dark_pixel_ratio >= DARK_PIXEL_RATIO_THRESHOLD {
            Some("dark".to_string())
        } else if sampled_pixels >= MIN_SAMPLED_PIXELS
            && dominant_color_ratio >= DOMINANT_COLOR_RATIO_THRESHOLD
        {
            Some("solid".to_string())
        } else {
            None
        };

    ComputerScreenshotHealth {
        sampled_pixels,
        dominant_color_ratio,
        dark_pixel_ratio,
        suspicious_blank: reason.is_some(),
        reason,
    }
}

fn scale_sample_index(index: u32, sample_count: u32, full_count: u32) -> u32 {
    if sample_count <= 1 || full_count <= 1 {
        return 0;
    }
    (index as u64 * (full_count - 1) as u64 / (sample_count - 1) as u64) as u32
}

fn encode_rgba_png_data_url(
    width: u32,
    height: u32,
    pixels: Vec<u8>,
) -> Result<(String, u32, u32), JavisError> {
    use image::imageops::FilterType;

    let mut img = image::RgbaImage::from_raw(width, height, pixels)
        .ok_or_else(|| JavisError::Internal("Failed to create RgbaImage".to_string()))?;

    // Resize large screenshots to keep base64 payload under control.
    // A 4K screenshot (3840×2160) as PNG base64 can exceed 200k tokens;
    // capping at 1920 px on the long edge keeps it below ~40k tokens.
    const MAX_DIM: u32 = 1920;
    if width > MAX_DIM || height > MAX_DIM {
        let (nw, nh) = if width >= height {
            let ratio = MAX_DIM as f64 / width as f64;
            (MAX_DIM, (height as f64 * ratio).round() as u32)
        } else {
            let ratio = MAX_DIM as f64 / height as f64;
            ((width as f64 * ratio).round() as u32, MAX_DIM)
        };
        img = image::imageops::resize(&img, nw, nh, FilterType::Lanczos3);
    }

    let mut png_buf: Vec<u8> = Vec::new();
    image::ImageEncoder::write_image(
        image::codecs::png::PngEncoder::new(&mut png_buf),
        img.as_raw(),
        img.width(),
        img.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| JavisError::Internal(format!("PNG encode error: {e}")))?;

    Ok((
        format!("data:image/png;base64,{}", BASE64.encode(&png_buf)),
        img.width(),
        img.height(),
    ))
}

fn crop_rgba(
    pixels: &[u8],
    width: i32,
    crop_x: i32,
    crop_y: i32,
    crop_w: i32,
    crop_h: i32,
) -> Vec<u8> {
    let mut cropped = vec![0u8; crop_w as usize * crop_h as usize * 4];
    let source_stride = width as usize * 4;
    let crop_stride = crop_w as usize * 4;
    for row in 0..crop_h as usize {
        let source_start = (crop_y as usize + row) * source_stride + crop_x as usize * 4;
        let target_start = row * crop_stride;
        cropped[target_start..target_start + crop_stride]
            .copy_from_slice(&pixels[source_start..source_start + crop_stride]);
    }
    cropped
}

fn capture_window_printwindow(
    handle: u64,
    region: Option<&ScreenRegion>,
) -> Result<ComputerScreenshotResult, JavisError> {
    unsafe {
        validate_window_handle_title(handle)?;
        validate_window_not_minimized_for_screenshot_path(
            handle,
            WindowScreenshotPath::PrintWindow,
        )?;
        let hwnd = handle as HWND;
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        GetWindowRect(hwnd, &mut rect);
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err(JavisError::Validation(format!(
                "Capture bounds must be positive, got ({width}, {height})"
            )));
        }

        let null_hwnd: HWND = std::ptr::null_mut();
        let screen_dc = GetDC(null_hwnd);
        if screen_dc.is_null() {
            return Err(JavisError::Internal("GetDC(0) failed".to_string()));
        }

        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_null() {
            ReleaseDC(null_hwnd, screen_dc);
            return Err(JavisError::Internal(
                "CreateCompatibleDC failed".to_string(),
            ));
        }

        let hbmp = CreateCompatibleBitmap(screen_dc, width, height);
        if hbmp.is_null() {
            DeleteDC(mem_dc);
            ReleaseDC(null_hwnd, screen_dc);
            return Err(JavisError::Internal(
                "CreateCompatibleBitmap failed".to_string(),
            ));
        }
        let old_bmp = SelectObject(mem_dc, hbmp as HGDIOBJ);
        if old_bmp.is_null() {
            DeleteObject(hbmp as HGDIOBJ);
            DeleteDC(mem_dc);
            ReleaseDC(null_hwnd, screen_dc);
            return Err(JavisError::Internal(
                "SelectObject failed in PrintWindow path".to_string(),
            ));
        }
        let printed = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT);

        if printed == 0 {
            SelectObject(mem_dc, old_bmp);
            DeleteObject(hbmp as HGDIOBJ);
            DeleteDC(mem_dc);
            ReleaseDC(null_hwnd, screen_dc);
            return Err(JavisError::Internal(format!(
                "PrintWindow failed for handle {handle}"
            )));
        }

        let bmp_size = (width as usize)
            .checked_mul(height as usize)
            .and_then(|px| px.checked_mul(4))
            .ok_or_else(|| JavisError::Validation("Screenshot region is too large".to_string()))?;
        let mut pixels: Vec<u8> = vec![0u8; bmp_size];
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: bmp_size as u32,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [RGBQUAD {
                rgbBlue: 0,
                rgbGreen: 0,
                rgbRed: 0,
                rgbReserved: 0,
            }; 1],
        };

        let dib_lines = GetDIBits(
            mem_dc,
            hbmp,
            0,
            height as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(mem_dc, old_bmp);
        DeleteObject(hbmp as HGDIOBJ);
        DeleteDC(mem_dc);
        ReleaseDC(null_hwnd, screen_dc);

        if dib_lines == 0 {
            return Err(JavisError::Internal(
                "GetDIBits failed in PrintWindow path".to_string(),
            ));
        }

        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        let (crop_x, crop_y, crop_w, crop_h) = crop_bounds(region, width, height)?;
        let cropped = if crop_x == 0 && crop_y == 0 && crop_w == width && crop_h == height {
            pixels
        } else {
            crop_rgba(&pixels, width, crop_x, crop_y, crop_w, crop_h)
        };
        let source_width = crop_w as u32;
        let source_height = crop_h as u32;
        let health = analyze_screenshot_health(source_width, source_height, &cropped);
        let (data_url, final_w, final_h) =
            encode_rgba_png_data_url(source_width, source_height, cropped)?;

        Ok(ComputerScreenshotResult {
            data_url,
            width: final_w,
            height: final_h,
            source_width,
            source_height,
            source_origin_x: rect.left + crop_x,
            source_origin_y: rect.top + crop_y,
            scale_x: final_w as f64 / source_width as f64,
            scale_y: final_h as f64 / source_height as f64,
            health,
            captured_at: current_timestamp_iso(),
            method_used: "printWindow".to_string(),
        })
    }
}

struct EnumWindowsCtx {
    windows: Vec<WindowInfo>,
    foreground: HWND,
}

/// Enumerate all visible windows.
pub(crate) fn list_windows() -> Result<ComputerListWindowsResult, JavisError> {
    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> i32 {
        let ctx = &mut *(lparam as *mut EnumWindowsCtx);

        if IsWindowVisible(hwnd) == 0 {
            return 1; // continue
        }

        let mut title_buf = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
        let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);

        if title.is_empty() {
            return 1;
        }
        if validate_window_title(&title).is_err() {
            return 1;
        }

        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), class_buf.len() as i32);
        let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);

        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        GetWindowRect(hwnd, &mut rect);

        ctx.windows.push(WindowInfo {
            handle: hwnd as u64,
            title,
            class_name,
            rect: WindowRect {
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            },
            is_visible: true,
            is_foreground: hwnd == ctx.foreground,
        });

        1 // continue enumeration
    }

    let foreground = unsafe { GetForegroundWindow() };
    let mut ctx = EnumWindowsCtx {
        windows: Vec::new(),
        foreground,
    };

    unsafe {
        EnumWindows(Some(enum_callback), &mut ctx as *mut _ as LPARAM);
    }

    Ok(ComputerListWindowsResult {
        windows: ctx.windows,
    })
}

pub(crate) fn detect_ui_objects_noop(
    request: &ComputerDetectUiObjectsRequest,
) -> Result<ComputerDetectUiObjectsResult, JavisError> {
    let _ = (
        &request.image_data_url,
        &request.observation_id,
        &request.window_handle,
        &request.classes,
        &request.model_path,
        &request.runtime,
        &request.imgsz,
        &request.max_detections,
        &request.min_confidence,
        &request.timeout_ms,
    );
    Ok(ComputerDetectUiObjectsResult {
        screenshot_id: request.screenshot_id.clone(),
        detections: Vec::new(),
        latency_ms: 0,
        model: "none".to_string(),
        runtime: "unknown".to_string(),
        timed_out: false,
        error: None,
        diagnostics: None,
    })
}

pub(crate) fn detect_ui_objects_with_runtime(
    request: &ComputerDetectUiObjectsRequest,
) -> Result<ComputerDetectUiObjectsResult, JavisError> {
    let worker_path = resolve_local_vision_worker_path();
    detect_ui_objects_with_worker_path(request, worker_path.as_deref())
}

fn resolve_local_vision_worker_path() -> Option<String> {
    env::var(LOCAL_VISION_WORKER_PATH_ENV)
        .ok()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .or_else(|| {
            local_vision_worker_path_candidates()
                .into_iter()
                .find(|path| path.is_file())
                .map(|path| path.to_string_lossy().to_string())
        })
}

fn local_vision_worker_path_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe_path) = env::current_exe() {
        candidates.extend(local_vision_worker_path_candidates_near_executable(
            &exe_path,
        ));
    }
    if let Ok(current_dir) = env::current_dir() {
        for ancestor in current_dir.ancestors() {
            push_local_vision_worker_candidates(&mut candidates, ancestor);
        }
    }
    candidates
}

fn local_vision_worker_path_candidates_near_executable(exe_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = exe_path.parent() {
        for base in [exe_dir, &exe_dir.join("resources")] {
            push_local_vision_worker_candidates(&mut candidates, base);
        }
    }
    candidates
}

fn push_local_vision_worker_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    for relative in LOCAL_VISION_WORKER_RELATIVE_PATHS {
        candidates.push(base.join(relative));
    }
}

fn detect_ui_objects_with_worker_path(
    request: &ComputerDetectUiObjectsRequest,
    worker_path: Option<&str>,
) -> Result<ComputerDetectUiObjectsResult, JavisError> {
    if request
        .model_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .is_none()
    {
        return detect_ui_objects_noop(request);
    }
    let Some(worker_path) = worker_path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(local_vision_empty_result(
            request,
            0,
            false,
            Some(format!(
                "local vision worker is not configured; set {LOCAL_VISION_WORKER_PATH_ENV} or bundle scripts/local-vision-worker.mjs"
            )),
        ));
    };

    if request.reuse_worker == Some(true) || local_vision_reuse_worker_enabled() {
        run_local_vision_reusable_worker(request, worker_path)
    } else {
        run_local_vision_worker(request, worker_path)
    }
}

fn local_vision_reuse_worker_enabled() -> bool {
    env::var(LOCAL_VISION_REUSE_WORKER_ENV)
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

fn local_vision_empty_result(
    request: &ComputerDetectUiObjectsRequest,
    latency_ms: u64,
    timed_out: bool,
    error: Option<String>,
) -> ComputerDetectUiObjectsResult {
    let result = ComputerDetectUiObjectsResult {
        screenshot_id: request.screenshot_id.clone(),
        detections: Vec::new(),
        latency_ms,
        model: sanitize_local_vision_model_name(
            request
                .model_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .unwrap_or("none"),
        ),
        runtime: local_vision_result_runtime(request),
        timed_out,
        error: sanitize_local_vision_error(error),
        diagnostics: None,
    };
    with_local_vision_model_purpose_diagnostics(result)
}

fn with_local_vision_desktop_diagnostics(
    mut result: ComputerDetectUiObjectsResult,
    mode: &'static str,
    reused: bool,
) -> ComputerDetectUiObjectsResult {
    let mut diagnostics = match result.diagnostics.take() {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    diagnostics.insert(
        "desktopWorkerMode".to_string(),
        serde_json::Value::String(mode.to_string()),
    );
    diagnostics.insert(
        "desktopWorkerReused".to_string(),
        serde_json::Value::Bool(reused),
    );
    result.diagnostics = Some(serde_json::Value::Object(diagnostics));
    result
}

fn run_local_vision_worker(
    request: &ComputerDetectUiObjectsRequest,
    worker_path: &str,
) -> Result<ComputerDetectUiObjectsResult, JavisError> {
    let temp_paths = write_local_vision_worker_files(request)?;
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(LOCAL_VISION_DEFAULT_TIMEOUT_MS)
        .clamp(LOCAL_VISION_MIN_TIMEOUT_MS, LOCAL_VISION_MAX_TIMEOUT_MS);
    let timeout = Duration::from_millis(timeout_ms);
    let started = Instant::now();
    let mut command = match local_vision_worker_command(worker_path) {
        Ok(command) => command,
        Err(error) => {
            temp_paths.cleanup();
            return Ok(local_vision_empty_result(request, 0, false, Some(error)));
        }
    };
    let child = command
        .arg(&temp_paths.request_path)
        .env(LOCAL_VISION_REQUEST_PATH_ENV, &temp_paths.request_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            local_vision_empty_result(
                request,
                0,
                false,
                Some(format!(
                    "failed to start local vision worker '{worker_path}': {e}"
                )),
            )
        });
    let mut child = match child {
        Ok(child) => child,
        Err(result) => {
            temp_paths.cleanup();
            return Ok(result);
        }
    };
    let mut stdout_reader = child
        .stdout
        .take()
        .map(|stdout| spawn_bounded_pipe_reader(stdout, LOCAL_VISION_MAX_WORKER_STDOUT_BYTES));
    let mut stderr_reader = child
        .stderr
        .take()
        .map(|stderr| spawn_bounded_pipe_reader(stderr, LOCAL_VISION_MAX_WORKER_STDERR_BYTES));

    let result = loop {
        let child_status = match child.try_wait() {
            Ok(status) => status,
            Err(e) => {
                let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                let _ = child.kill();
                let _ = child.wait();
                discard_bounded_pipe_reader(&mut stdout_reader);
                discard_bounded_pipe_reader(&mut stderr_reader);
                break local_vision_empty_result(
                    request,
                    latency_ms,
                    false,
                    Some(format!("failed to poll local vision worker: {e}")),
                );
            }
        };
        if child_status.is_some() {
            let status = match child.wait() {
                Ok(status) => status,
                Err(e) => {
                    let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                    let _ = collect_bounded_pipe_output(stdout_reader.take(), "stdout");
                    let _ = collect_bounded_pipe_output(stderr_reader.take(), "stderr");
                    break local_vision_empty_result(
                        request,
                        latency_ms,
                        false,
                        Some(format!("failed to wait for local vision worker: {e}")),
                    );
                }
            };
            let stdout = match collect_bounded_pipe_output(stdout_reader.take(), "stdout") {
                Ok(output) => output,
                Err(error) => {
                    let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                    let _ = collect_bounded_pipe_output(stderr_reader.take(), "stderr");
                    break local_vision_empty_result(request, latency_ms, false, Some(error));
                }
            };
            let stderr = match collect_bounded_pipe_output(stderr_reader.take(), "stderr") {
                Ok(output) => output,
                Err(error) => {
                    let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                    break local_vision_empty_result(request, latency_ms, false, Some(error));
                }
            };
            let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            if stdout.truncated {
                break local_vision_empty_result(
                    request,
                    latency_ms,
                    false,
                    Some(format!(
                        "local vision worker stdout exceeded {LOCAL_VISION_MAX_WORKER_STDOUT_BYTES} bytes"
                    )),
                );
            }
            if stderr.truncated {
                break local_vision_empty_result(
                    request,
                    latency_ms,
                    false,
                    Some(format!(
                        "local vision worker stderr exceeded {LOCAL_VISION_MAX_WORKER_STDERR_BYTES} bytes"
                    )),
                );
            }
            if !status.success() {
                break local_vision_empty_result(
                    request,
                    latency_ms,
                    false,
                    Some(format!(
                        "local vision worker exited with status {}{}",
                        status,
                        format_worker_stderr(&stderr.bytes)
                    )),
                );
            }
            break parse_local_vision_worker_output(&stdout.bytes, request, latency_ms);
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            discard_bounded_pipe_reader(&mut stdout_reader);
            discard_bounded_pipe_reader(&mut stderr_reader);
            let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            break local_vision_empty_result(
                request,
                latency_ms,
                true,
                Some(format!(
                    "local vision worker timed out after {timeout_ms}ms"
                )),
            );
        }

        thread::sleep(Duration::from_millis(5));
    };

    temp_paths.cleanup();
    Ok(with_local_vision_desktop_diagnostics(
        result,
        "single_shot",
        false,
    ))
}

struct ReusableLocalVisionWorker {
    worker_path: String,
    child: Child,
    stdin: ChildStdin,
    stdout_lines: mpsc::Receiver<Result<String, String>>,
}

impl ReusableLocalVisionWorker {
    fn start(worker_path: &str) -> Result<Self, String> {
        let mut command = local_vision_worker_command(worker_path)?;
        let mut child = command
            .arg("--server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                format!("failed to start reusable local vision worker '{worker_path}': {e}")
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "reusable local vision worker stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "reusable local vision worker stdout is unavailable".to_string())?;
        Ok(Self {
            worker_path: worker_path.to_string(),
            child,
            stdin,
            stdout_lines: spawn_reusable_worker_stdout_reader(stdout),
        })
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ReusableLocalVisionWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_local_vision_reusable_worker(
    request: &ComputerDetectUiObjectsRequest,
    worker_path: &str,
) -> Result<ComputerDetectUiObjectsResult, JavisError> {
    let temp_paths = write_local_vision_worker_files(request)?;
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(LOCAL_VISION_DEFAULT_TIMEOUT_MS)
        .clamp(LOCAL_VISION_MIN_TIMEOUT_MS, LOCAL_VISION_MAX_TIMEOUT_MS);
    let started = Instant::now();
    let result = run_local_vision_reusable_worker_with_request_path(
        request,
        worker_path,
        &temp_paths.request_path,
        timeout_ms,
        started,
    );
    temp_paths.cleanup();
    Ok(result)
}

fn run_local_vision_reusable_worker_with_request_path(
    request: &ComputerDetectUiObjectsRequest,
    worker_path: &str,
    request_path: &Path,
    timeout_ms: u64,
    started: Instant,
) -> ComputerDetectUiObjectsResult {
    let mut guard = match LOCAL_VISION_REUSABLE_WORKER.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return local_vision_empty_result(
                request,
                0,
                false,
                Some("reusable local vision worker lock is poisoned".to_string()),
            );
        }
    };
    let reused_existing_worker = guard
        .as_ref()
        .is_some_and(|worker| worker.worker_path == worker_path);
    if !reused_existing_worker {
        if let Some(mut old_worker) = guard.take() {
            old_worker.stop();
        }
        match ReusableLocalVisionWorker::start(worker_path) {
            Ok(worker) => *guard = Some(worker),
            Err(error) => {
                return local_vision_empty_result(request, 0, false, Some(error));
            }
        }
    }

    let worker = guard.as_mut().expect("reusable worker must be initialized");
    let result = match run_local_vision_reusable_worker_once(
        worker,
        request,
        request_path,
        Duration::from_millis(timeout_ms),
        started,
    ) {
        Ok(result) => result,
        Err((timed_out, error)) => {
            if let Some(mut worker) = guard.take() {
                worker.stop();
            }
            let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            local_vision_empty_result(request, latency_ms, timed_out, Some(error))
        }
    };
    with_local_vision_desktop_diagnostics(result, "reusable", reused_existing_worker)
}

fn run_local_vision_reusable_worker_once(
    worker: &mut ReusableLocalVisionWorker,
    request: &ComputerDetectUiObjectsRequest,
    request_path: &Path,
    timeout: Duration,
    started: Instant,
) -> Result<ComputerDetectUiObjectsResult, (bool, String)> {
    writeln!(worker.stdin, "{}", request_path.to_string_lossy())
        .and_then(|_| worker.stdin.flush())
        .map_err(|e| {
            (
                false,
                format!("failed to send reusable local vision request: {e}"),
            )
        })?;
    let stdout = read_reusable_worker_stdout_line(&worker.stdout_lines, timeout)
        .map_err(|error| (error.timed_out, error.message))?;
    let latency_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    Ok(parse_local_vision_worker_output(
        stdout.trim_end().as_bytes(),
        request,
        latency_ms,
    ))
}

struct ReusableWorkerReadError {
    timed_out: bool,
    message: String,
}

fn read_reusable_worker_stdout_line(
    stdout_lines: &mpsc::Receiver<Result<String, String>>,
    timeout: Duration,
) -> Result<String, ReusableWorkerReadError> {
    let started = Instant::now();
    match stdout_lines.recv_timeout(timeout) {
        Ok(Ok(line)) if line.is_empty() => Err(ReusableWorkerReadError {
            timed_out: false,
            message: "reusable local vision worker closed stdout".to_string(),
        }),
        Ok(Ok(line)) if line.len() > LOCAL_VISION_MAX_WORKER_STDOUT_BYTES => {
            Err(ReusableWorkerReadError {
                timed_out: false,
                message: format!(
                    "local vision worker stdout exceeded {LOCAL_VISION_MAX_WORKER_STDOUT_BYTES} bytes"
                ),
            })
        }
        Ok(Ok(line)) => Ok(line),
        Ok(Err(error)) => Err(ReusableWorkerReadError {
            timed_out: false,
            message: error,
        }),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(ReusableWorkerReadError {
            timed_out: true,
            message: format!(
                "reusable local vision worker timed out after {}ms",
                timeout.as_millis()
            ),
        }),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(ReusableWorkerReadError {
            timed_out: false,
            message: format!(
                "failed to read reusable local vision worker output after {}ms",
                started.elapsed().as_millis()
            ),
        }),
    }
}

fn spawn_reusable_worker_stdout_reader(
    stdout: ChildStdout,
) -> mpsc::Receiver<Result<String, String>> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        for byte in stdout.bytes() {
            match byte {
                Ok(b'\n') => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    bytes.clear();
                    if sender.send(Ok(line)).is_err() {
                        return;
                    }
                }
                Ok(byte) => {
                    bytes.push(byte);
                    if bytes.len() > LOCAL_VISION_MAX_WORKER_STDOUT_BYTES {
                        let _ = sender.send(Err(format!(
                            "local vision worker stdout exceeded {LOCAL_VISION_MAX_WORKER_STDOUT_BYTES} bytes"
                        )));
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(format!(
                        "failed to read reusable local vision worker output: {error}"
                    )));
                    return;
                }
            }
        }
        if !bytes.is_empty() {
            let line = String::from_utf8_lossy(&bytes).to_string();
            let _ = sender.send(Ok(line));
        }
    });
    receiver
}

struct BoundedPipeOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

fn spawn_bounded_pipe_reader<R>(
    mut reader: R,
    max_bytes: usize,
) -> mpsc::Receiver<Result<BoundedPipeOutput, String>>
where
    R: Read + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 8192];
        let mut truncated = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let remaining = max_bytes.saturating_sub(bytes.len());
                    if remaining == 0 {
                        truncated = true;
                        break;
                    }
                    let keep = read.min(remaining);
                    bytes.extend_from_slice(&buffer[..keep]);
                    if read > remaining {
                        truncated = true;
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(format!(
                        "failed to read local vision worker output: {error}"
                    )));
                    return;
                }
            }
        }
        let _ = sender.send(Ok(BoundedPipeOutput { bytes, truncated }));
    });
    receiver
}

fn collect_bounded_pipe_output(
    receiver: Option<mpsc::Receiver<Result<BoundedPipeOutput, String>>>,
    name: &str,
) -> Result<BoundedPipeOutput, String> {
    let Some(receiver) = receiver else {
        return Ok(BoundedPipeOutput {
            bytes: Vec::new(),
            truncated: false,
        });
    };
    match receiver.recv_timeout(Duration::from_millis(LOCAL_VISION_OUTPUT_DRAIN_TIMEOUT_MS)) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("local vision worker {name} drain timed out"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(format!("failed to collect local vision worker {name}"))
        }
    }
}

fn discard_bounded_pipe_reader(
    receiver: &mut Option<mpsc::Receiver<Result<BoundedPipeOutput, String>>>,
) {
    let _ = receiver.take();
}

fn local_vision_worker_command(worker_path: &str) -> Result<Command, String> {
    local_vision_worker_command_with_node_resolver(
        worker_path,
        resolve_local_vision_node_executable,
    )
}

fn local_vision_worker_command_with_node_resolver<F>(
    worker_path: &str,
    resolve_node: F,
) -> Result<Command, String>
where
    F: FnOnce() -> Result<PathBuf, String>,
{
    if worker_path.to_ascii_lowercase().ends_with(".mjs") {
        let node = resolve_node()?;
        let mut command = Command::new(node);
        command.arg(worker_path);
        return Ok(command);
    }
    Ok(Command::new(worker_path))
}

fn local_vision_missing_node_error() -> String {
    format!(
        "Node.js executable not found for local vision worker; set {LOCAL_VISION_NODE_PATH_ENV}, bundle a Node runtime, or add node to PATH"
    )
}

fn resolve_local_vision_node_executable() -> Result<PathBuf, String> {
    resolve_local_vision_node_executable_with_resolvers(
        || {
            resolve_local_vision_node_executable_from_env(
                env::var(LOCAL_VISION_NODE_PATH_ENV).ok().as_deref(),
            )
        },
        resolve_bundled_local_vision_node_executable,
        resolve_node_from_path,
    )
}

fn resolve_local_vision_node_executable_with_resolvers<E, B, P>(
    env_resolver: E,
    bundled_resolver: B,
    path_resolver: P,
) -> Result<PathBuf, String>
where
    E: FnOnce() -> Result<Option<PathBuf>, String>,
    B: FnOnce() -> Option<PathBuf>,
    P: FnOnce() -> Option<PathBuf>,
{
    if let Some(path) = env_resolver()? {
        return Ok(path);
    }
    if let Some(path) = bundled_resolver() {
        return Ok(path);
    }
    if let Some(path) = path_resolver() {
        return Ok(path);
    }
    Err(local_vision_missing_node_error())
}

fn resolve_local_vision_node_executable_from_env(
    value: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(path) = value.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let path_buf = PathBuf::from(path);
    if path_buf.is_file() {
        return Ok(Some(path_buf));
    }
    Err(format!(
        "{LOCAL_VISION_NODE_PATH_ENV} is not a file: {}",
        sanitize_local_vision_model_name(path)
    ))
}

fn resolve_bundled_local_vision_node_executable() -> Option<PathBuf> {
    local_vision_node_path_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn local_vision_node_path_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe_path) = env::current_exe() {
        candidates.extend(local_vision_node_path_candidates_near_executable(&exe_path));
    }
    if let Ok(current_dir) = env::current_dir() {
        for ancestor in current_dir.ancestors() {
            push_local_vision_node_candidates(&mut candidates, ancestor);
        }
    }
    candidates
}

fn local_vision_node_path_candidates_near_executable(exe_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = exe_path.parent() {
        for base in [exe_dir, &exe_dir.join("resources")] {
            push_local_vision_node_candidates(&mut candidates, base);
        }
    }
    candidates
}

fn push_local_vision_node_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node"]
    } else {
        &["node"]
    };
    for name in names {
        candidates.push(base.join("bin").join("node").join(name));
        candidates.push(base.join("bin").join(name));
        candidates.push(base.join("node").join(name));
    }
}

fn resolve_local_vision_default_model_path() -> Option<PathBuf> {
    local_vision_default_model_path_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn local_vision_default_model_path_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe_path) = env::current_exe() {
        candidates.extend(local_vision_default_model_path_candidates_near_executable(
            &exe_path,
        ));
    }
    if let Ok(current_dir) = env::current_dir() {
        for ancestor in current_dir.ancestors() {
            push_local_vision_default_model_candidates(&mut candidates, ancestor);
        }
    }
    candidates
}

fn local_vision_default_model_path_candidates_near_executable(exe_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = exe_path.parent() {
        push_local_vision_default_model_candidates(&mut candidates, exe_dir);
        push_local_vision_default_model_candidates(&mut candidates, &exe_dir.join("resources"));
    }
    candidates
}

fn push_local_vision_default_model_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    candidates.push(
        base.join("models")
            .join("local-vision")
            .join(LOCAL_VISION_UI_MODEL_FILENAME),
    );
    candidates.push(
        base.join("artifacts")
            .join("local-vision")
            .join(LOCAL_VISION_UI_MODEL_FILENAME),
    );
    candidates.push(base.join(LOCAL_VISION_UI_MODEL_FILENAME));
}

fn resolve_local_vision_model_path_for_worker(value: Option<&str>) -> Option<String> {
    resolve_local_vision_model_path_for_worker_with_candidates(
        value,
        local_vision_default_model_path_candidates(),
    )
}

fn resolve_local_vision_model_path_for_worker_with_candidates<I>(
    value: Option<&str>,
    candidates: I,
) -> Option<String>
where
    I: IntoIterator<Item = PathBuf>,
{
    let path = value.map(str::trim).filter(|path| !path.is_empty())?;
    let path_buf = PathBuf::from(path);
    if path_buf.is_file()
        || path_buf.is_absolute()
        || !is_local_vision_default_model_reference(path)
    {
        return Some(path.to_string());
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().to_string())
        .or_else(|| Some(path.to_string()))
}

fn is_local_vision_default_model_reference(path: &str) -> bool {
    let normalized = path
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase();
    normalized == LOCAL_VISION_UI_MODEL_FILENAME
        || normalized == LOCAL_VISION_BUNDLED_MODEL_RELATIVE_PATH
        || normalized == format!("artifacts/local-vision/{LOCAL_VISION_UI_MODEL_FILENAME}")
}

fn resolve_node_from_path() -> Option<PathBuf> {
    let path_env = env::var_os("PATH")?;
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node.cmd", "node"]
    } else {
        &["node"]
    };
    for dir in env::split_paths(&path_env) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

struct LocalVisionWorkerTempFiles {
    request_path: PathBuf,
    image_path: PathBuf,
}

impl LocalVisionWorkerTempFiles {
    fn cleanup(&self) {
        let _ = fs::remove_file(&self.request_path);
        let _ = fs::remove_file(&self.image_path);
    }
}

impl Drop for LocalVisionWorkerTempFiles {
    fn drop(&mut self) {
        self.cleanup();
    }
}

fn write_local_vision_worker_files(
    request: &ComputerDetectUiObjectsRequest,
) -> Result<LocalVisionWorkerTempFiles, JavisError> {
    let safe_screenshot_id: String = request
        .screenshot_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(64)
        .collect();
    let suffix = if safe_screenshot_id.is_empty() {
        "request".to_string()
    } else {
        safe_screenshot_id
    };
    let sequence = LOCAL_VISION_REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_dir = env::temp_dir();
    let image_path = temp_dir.join(format!(
        "javis-local-vision-{}-{sequence}-{suffix}.png",
        std::process::id()
    ));
    let request_path = temp_dir.join(format!(
        "javis-local-vision-{}-{sequence}-{suffix}.json",
        std::process::id()
    ));
    let worker_request = LocalVisionWorkerRequest {
        image_path: image_path.to_string_lossy().to_string(),
        screenshot_id: request.screenshot_id.clone(),
        observation_id: request.observation_id.clone(),
        window_handle: request.window_handle,
        classes: request.classes.clone(),
        model_path: resolve_local_vision_model_path_for_worker(request.model_path.as_deref()),
        runtime: request.runtime.clone(),
        runtime_adapter_path: request.runtime_adapter_path.clone(),
        imgsz: request.imgsz,
        max_detections: request.max_detections,
        min_confidence: request.min_confidence,
        iou_threshold: request.iou_threshold,
        timeout_ms: request.timeout_ms,
        label_map: request.label_map.clone(),
    };
    let temp_files = LocalVisionWorkerTempFiles {
        request_path,
        image_path,
    };
    write_data_url_png_file(&request.image_data_url, &temp_files.image_path)?;
    let request_json = serde_json::to_vec(&worker_request)?;
    if request_json.len() > LOCAL_VISION_MAX_WORKER_REQUEST_JSON_BYTES {
        return Err(JavisError::Validation(format!(
            "Local vision request JSON exceeds {LOCAL_VISION_MAX_WORKER_REQUEST_JSON_BYTES} bytes."
        )));
    }
    fs::write(&temp_files.request_path, request_json)
        .map_err(|e| JavisError::Io(format!("Failed to write local vision request file: {e}")))?;
    Ok(temp_files)
}

fn write_data_url_png_file(data_url: &str, path: &Path) -> Result<(), JavisError> {
    const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";
    let Some(encoded) = data_url.strip_prefix(PNG_DATA_URL_PREFIX) else {
        return Err(JavisError::Validation(
            "Local vision requires a PNG data URL screenshot.".to_string(),
        ));
    };
    if encoded.len() > LOCAL_VISION_MAX_IMAGE_BASE64_CHARS {
        return Err(JavisError::Validation(format!(
            "Local vision screenshot exceeds {LOCAL_VISION_MAX_IMAGE_BYTES} bytes."
        )));
    }
    let bytes = BASE64.decode(encoded).map_err(|e| {
        JavisError::Validation(format!("Invalid local vision screenshot data URL: {e}"))
    })?;
    if bytes.len() > LOCAL_VISION_MAX_IMAGE_BYTES {
        return Err(JavisError::Validation(format!(
            "Local vision screenshot exceeds {LOCAL_VISION_MAX_IMAGE_BYTES} bytes."
        )));
    }
    fs::write(path, bytes)
        .map_err(|e| JavisError::Io(format!("Failed to write local vision image file: {e}")))?;
    Ok(())
}

fn parse_local_vision_worker_output(
    stdout: &[u8],
    request: &ComputerDetectUiObjectsRequest,
    latency_ms: u64,
) -> ComputerDetectUiObjectsResult {
    if stdout.len() > LOCAL_VISION_MAX_WORKER_STDOUT_BYTES {
        return local_vision_empty_result(
            request,
            latency_ms,
            false,
            Some(format!(
                "local vision worker stdout exceeded {LOCAL_VISION_MAX_WORKER_STDOUT_BYTES} bytes"
            )),
        );
    }
    let Ok(mut result) = serde_json::from_slice::<ComputerDetectUiObjectsResult>(stdout) else {
        return local_vision_empty_result(
            request,
            latency_ms,
            false,
            Some("failed to parse local vision worker output".to_string()),
        );
    };
    let diagnostics = sanitize_local_vision_diagnostics(result.diagnostics.take());

    if result.screenshot_id != request.screenshot_id {
        let mut empty = local_vision_empty_result(
            request,
            latency_ms,
            false,
            Some(format!(
                "local vision worker returned stale screenshot id {}; expected {}",
                result.screenshot_id, request.screenshot_id
            )),
        );
        empty.diagnostics = diagnostics;
        return empty;
    }

    if result.latency_ms == 0 {
        result.latency_ms = latency_ms;
    }
    if result.model.trim().is_empty() {
        result.model = request
            .model_path
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
    }
    result.model = sanitize_local_vision_model_name(&result.model);
    if result.runtime.trim().is_empty() {
        result.runtime = local_vision_result_runtime(request);
    }
    result.runtime = sanitize_local_vision_result_runtime(&result.runtime);
    result.error = sanitize_local_vision_error(result.error.take());
    if result.timed_out
        || result
            .error
            .as_deref()
            .is_some_and(|error| !error.trim().is_empty())
    {
        result.detections.clear();
    } else {
        clamp_local_vision_result_detections(&mut result.detections, request);
        for (index, detection) in result.detections.iter_mut().enumerate() {
            detection.id = sanitize_local_vision_detection_text(&detection.id)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("det_{}", index + 1));
            detection.label = sanitize_local_vision_detection_text(&detection.label)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "unknown_region".to_string());
        }
    }
    result.diagnostics = diagnostics;
    with_local_vision_model_purpose_diagnostics(result)
}

fn clamp_local_vision_result_detections(
    detections: &mut Vec<ComputerUiDetection>,
    request: &ComputerDetectUiObjectsRequest,
) {
    let min_confidence = normalize_local_vision_min_confidence(request.min_confidence);
    let max_detections = normalize_local_vision_max_detections(request.max_detections);
    detections.retain(|detection| {
        detection.confidence.is_finite()
            && detection.confidence >= min_confidence
            && detection.box_.coordinate_space == "screenshot"
            && detection.center.coordinate_space == "screenshot"
            && detection.box_.x.is_finite()
            && detection.box_.y.is_finite()
            && detection.box_.width.is_finite()
            && detection.box_.height.is_finite()
            && detection.box_.width > 0.0
            && detection.box_.height > 0.0
            && detection.center.x.is_finite()
            && detection.center.y.is_finite()
    });
    detections.sort_by(|left, right| {
        right
            .confidence
            .partial_cmp(&left.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    detections.truncate(max_detections);
}

fn normalize_local_vision_min_confidence(value: Option<f64>) -> f64 {
    match value {
        Some(confidence) if confidence.is_finite() && (0.0..=1.0).contains(&confidence) => {
            confidence
        }
        _ => LOCAL_VISION_DEFAULT_MIN_CONFIDENCE,
    }
}

fn normalize_local_vision_max_detections(value: Option<u16>) -> usize {
    value
        .map(usize::from)
        .unwrap_or(LOCAL_VISION_DEFAULT_MAX_DETECTIONS)
        .min(LOCAL_VISION_MAX_DETECTIONS)
}

const LOCAL_VISION_ERROR_MAX_CHARS: usize = 320;
const LOCAL_VISION_MODEL_MAX_CHARS: usize = 160;
const LOCAL_VISION_DIAGNOSTICS_MAX_DEPTH: usize = 3;
const LOCAL_VISION_DIAGNOSTICS_MAX_ENTRIES: usize = 24;
const LOCAL_VISION_DIAGNOSTICS_MAX_STRING_CHARS: usize = 160;
const LOCAL_VISION_DIAGNOSTICS_MAX_KEY_CHARS: usize = 80;
const LOCAL_VISION_DETECTION_TEXT_MAX_CHARS: usize = 120;
const LOCAL_VISION_PATH_EXTENSIONS: &[&str] = &[
    ".onnx", ".engine", ".xml", ".bin", ".mjs", ".js", ".json", ".png", ".jpg", ".jpeg", ".webp",
    ".txt",
];

fn sanitize_local_vision_model_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "unknown".to_string();
    }
    if contains_image_data_url(trimmed) {
        return "[redacted image data]".to_string();
    }
    let filename = Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("[redacted local path]");
    truncate_chars(filename, LOCAL_VISION_MODEL_MAX_CHARS)
}

fn with_local_vision_model_purpose_diagnostics(
    mut result: ComputerDetectUiObjectsResult,
) -> ComputerDetectUiObjectsResult {
    let Some(warning) = local_vision_model_purpose_warning(&result.model) else {
        return result;
    };
    let mut diagnostics = match result.diagnostics.take() {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    let mut warnings = match diagnostics.remove("warnings") {
        Some(serde_json::Value::Array(entries)) => entries,
        _ => Vec::new(),
    };
    if !warnings
        .iter()
        .any(|entry| entry.as_str().is_some_and(|entry| entry == warning))
    {
        warnings.push(serde_json::Value::String(warning));
    }
    diagnostics.insert("warnings".to_string(), serde_json::Value::Array(warnings));
    result.diagnostics = Some(serde_json::Value::Object(diagnostics));
    result
}

fn local_vision_model_purpose_warning(model: &str) -> Option<String> {
    let lower = model.trim().to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "yolo26n.pt"
            | "yolo26s.pt"
            | "yolo26m.pt"
            | "yolo26l.pt"
            | "yolo26x.pt"
            | "yolo26n.onnx"
            | "yolo26s.onnx"
            | "yolo26m.onnx"
            | "yolo26l.onnx"
            | "yolo26x.onnx"
    ) {
        Some(format!(
            "{model} matches an official Ultralytics YOLO26 COCO weight name; use it for smoke/benchmark only, not as a UI-trained production model"
        ))
    } else {
        None
    }
}

fn sanitize_local_vision_result_runtime(value: &str) -> String {
    match value.trim() {
        "onnxruntime" | "openvino" | "tensorrt" | "unknown" => value.trim().to_string(),
        _ => "unknown".to_string(),
    }
}

fn sanitize_local_vision_error(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(sanitize_local_vision_text(
        &trimmed,
        LOCAL_VISION_ERROR_MAX_CHARS,
    ))
}

fn sanitize_local_vision_diagnostics(
    value: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    let serde_json::Value::Object(map) = value? else {
        return None;
    };
    let mut output = serde_json::Map::new();
    for (key, entry) in map.into_iter().take(LOCAL_VISION_DIAGNOSTICS_MAX_ENTRIES) {
        if let Some(sanitized) = sanitize_local_vision_diagnostic_value(entry, 1) {
            output.insert(sanitize_local_vision_diagnostic_key(key), sanitized);
        }
    }
    if output.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(output))
    }
}

fn sanitize_local_vision_diagnostic_value(
    value: serde_json::Value,
    depth: usize,
) -> Option<serde_json::Value> {
    if depth > LOCAL_VISION_DIAGNOSTICS_MAX_DEPTH {
        return None;
    }
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => Some(value),
        serde_json::Value::String(text) => {
            if contains_image_data_url(&text) {
                Some(serde_json::Value::String(
                    "[redacted image data]".to_string(),
                ))
            } else {
                Some(serde_json::Value::String(sanitize_local_vision_text(
                    &text,
                    LOCAL_VISION_DIAGNOSTICS_MAX_STRING_CHARS,
                )))
            }
        }
        serde_json::Value::Array(entries) => {
            let sanitized = entries
                .into_iter()
                .take(LOCAL_VISION_DIAGNOSTICS_MAX_ENTRIES)
                .filter_map(|entry| sanitize_local_vision_diagnostic_value(entry, depth + 1))
                .collect();
            Some(serde_json::Value::Array(sanitized))
        }
        serde_json::Value::Object(map) => {
            let mut output = serde_json::Map::new();
            for (key, entry) in map.into_iter().take(LOCAL_VISION_DIAGNOSTICS_MAX_ENTRIES) {
                if let Some(sanitized) = sanitize_local_vision_diagnostic_value(entry, depth + 1) {
                    output.insert(sanitize_local_vision_diagnostic_key(key), sanitized);
                }
            }
            if output.is_empty() {
                None
            } else {
                Some(serde_json::Value::Object(output))
            }
        }
    }
}

fn sanitize_local_vision_diagnostic_key(key: String) -> String {
    if contains_image_data_url(&key) {
        "[redacted image key]".to_string()
    } else {
        sanitize_local_vision_text(&key, LOCAL_VISION_DIAGNOSTICS_MAX_KEY_CHARS)
    }
}

fn sanitize_local_vision_text(value: &str, max_chars: usize) -> String {
    truncate_chars(
        &redact_image_data_urls(&redact_local_vision_paths(value)),
        max_chars,
    )
}

fn sanitize_local_vision_detection_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(sanitize_local_vision_text(
            trimmed,
            LOCAL_VISION_DETECTION_TEXT_MAX_CHARS,
        ))
    }
}

fn redact_local_vision_paths(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        if let Some(end) = local_vision_path_match_end(value, index) {
            let matched = &value[index..end];
            let (path, suffix) = split_local_vision_path_match(matched);
            push_redacted_local_vision_path(&mut output, path);
            output.push_str(suffix);
            index = end;
        } else {
            let ch = value[index..].chars().next().unwrap_or_default();
            output.push(ch);
            index += ch.len_utf8();
        }
    }
    output
}

fn local_vision_path_match_end(value: &str, start: usize) -> Option<usize> {
    if !local_vision_path_starts_at(value, start) {
        return None;
    }
    let mut end = start;
    for (offset, ch) in value[start..].char_indices() {
        if is_local_vision_path_terminator(ch) {
            break;
        }
        end = start + offset + ch.len_utf8();
    }
    (end > start).then_some(end)
}

fn local_vision_path_starts_at(value: &str, start: usize) -> bool {
    let rest = &value[start..];
    if rest.starts_with("file:///") || rest.starts_with("file://") {
        return true;
    }
    is_windows_local_path(rest) || is_common_unix_local_path(rest)
}

fn is_local_vision_path_terminator(ch: char) -> bool {
    matches!(
        ch,
        '\r' | '\n' | '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}'
    )
}

fn split_local_vision_path_match(value: &str) -> (&str, &str) {
    let lower = value.to_ascii_lowercase();
    let mut end = value.len();
    for extension in LOCAL_VISION_PATH_EXTENSIONS {
        if let Some(extension_start) = lower.rfind(extension) {
            let candidate_end = extension_start + extension.len();
            if !value[candidate_end..]
                .chars()
                .any(|ch| ch == '\\' || ch == '/')
                && candidate_end < end
            {
                end = candidate_end;
            }
        }
    }
    while end > 0
        && value[..end]
            .chars()
            .last()
            .is_some_and(|ch| matches!(ch, ')' | ']' | '}' | '.' | ';' | ':' | ','))
    {
        end -= value[..end].chars().last().map_or(1, char::len_utf8);
    }
    (&value[..end], &value[end..])
}

fn push_redacted_local_vision_path(output: &mut String, path: &str) {
    let filename = local_path_filename(path);
    if filename.is_empty() {
        output.push_str("[redacted local path]");
    } else {
        output.push_str("[redacted local path:");
        output.push_str(&filename);
        output.push(']');
    }
}

fn redact_image_data_urls(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        if let Some(end) = image_data_url_match_end(value, index) {
            let matched_len = value[index..end].chars().count();
            output.push_str(&format!("[redacted:image data URL:{matched_len} chars]"));
            index = end;
        } else {
            let ch = value[index..].chars().next().unwrap_or_default();
            output.push(ch);
            index += ch.len_utf8();
        }
    }
    output
}

fn image_data_url_match_end(value: &str, start: usize) -> Option<usize> {
    let media_start = if starts_with_ascii_case_insensitive(value, start, "data:image/") {
        start + "data:image/".len()
    } else if starts_with_ascii_case_insensitive(value, start, "data:image\\/") {
        start + "data:image\\/".len()
    } else {
        return None;
    };
    let mut cursor = media_start;
    while cursor < value.len() {
        let byte = value.as_bytes()[cursor];
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-') {
            cursor += 1;
        } else {
            break;
        }
    }
    if cursor == media_start || !starts_with_ascii_case_insensitive(value, cursor, ";base64,") {
        return None;
    }
    cursor += ";base64,".len();
    let data_start = cursor;
    while cursor < value.len() {
        let byte = value.as_bytes()[cursor];
        if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'_' | b'-') {
            cursor += 1;
        } else {
            break;
        }
    }
    (cursor > data_start).then_some(cursor)
}

fn starts_with_ascii_case_insensitive(value: &str, start: usize, pattern: &str) -> bool {
    value
        .get(start..start.saturating_add(pattern.len()))
        .is_some_and(|part| part.eq_ignore_ascii_case(pattern))
}

fn is_windows_local_path(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && chars.next() == Some(':')
        && chars.next().is_some_and(|ch| ch == '\\' || ch == '/')
}

fn is_common_unix_local_path(value: &str) -> bool {
    [
        "/Users/",
        "/home/",
        "/tmp/",
        "/var/",
        "/mnt/",
        "/Volumes/",
        "/opt/",
        "/workspace/",
        "/private/",
        "/run/",
        "/data/",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
}

fn local_path_filename(value: &str) -> String {
    let normalized = value
        .trim_start_matches("file:///")
        .trim_start_matches("file://")
        .trim_end_matches(|ch: char| matches!(ch, ',' | '.' | ';' | ':'))
        .replace('\\', "/");
    normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or("")
        .to_string()
}

fn contains_image_data_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (lower.contains("data:image/") || lower.contains("data:image\\/")) && lower.contains(";base64,")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(3);
    let mut truncated: String = value.chars().take(keep).collect();
    truncated.push_str("...");
    truncated
}

fn local_vision_result_runtime(request: &ComputerDetectUiObjectsRequest) -> String {
    match request.runtime.as_deref().map(str::trim) {
        Some("onnxruntime") | Some("openvino") | Some("tensorrt") => {
            request.runtime.clone().unwrap_or_default()
        }
        _ => "unknown".to_string(),
    }
}

fn format_worker_stderr(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        String::new()
    } else {
        let truncated: String = stderr.chars().take(240).collect();
        format!(": {truncated}")
    }
}

/// Focus a window by handle.
pub(crate) fn focus_window(
    request: &ComputerFocusWindowRequest,
) -> Result<ComputerFocusWindowResult, JavisError> {
    let hwnd = request.handle as HWND;
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return Err(JavisError::Validation(format!(
            "Invalid window handle: {}",
            request.handle
        )));
    }

    // Get title for validation
    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32) };
    let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);

    validate_window_title(&title)?;

    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
            std::thread::sleep(Duration::from_millis(200));
        }
        if SetForegroundWindow(hwnd) == 0 && IsIconic(hwnd) != 0 {
            return Err(JavisError::Validation(format!(
                "Window {} is minimized and could not be restored before focusing.",
                request.handle
            )));
        }
    }
    std::thread::sleep(Duration::from_millis(200));

    let focused = unsafe { GetForegroundWindow() == hwnd };

    Ok(ComputerFocusWindowResult { focused, title })
}

/// Move the mouse cursor.
pub(crate) fn move_mouse(
    request: &ComputerMoveMouseRequest,
) -> Result<ComputerMoveMouseResult, JavisError> {
    validate_screen_coordinates(request.x, request.y)?;

    let speed = request.speed.as_deref().unwrap_or("instant");

    match speed {
        "linear" => {
            let duration_ms = request.duration_ms.unwrap_or(200);
            let steps = (duration_ms / 16).max(1); // ~60fps
            unsafe {
                let mut cur = POINT { x: 0, y: 0 };
                GetCursorPos(&mut cur);
                for i in 1..=steps {
                    let t = i as f64 / steps as f64;
                    let x = cur.x + ((request.x - cur.x) as f64 * t) as i32;
                    let y = cur.y + ((request.y - cur.y) as f64 * t) as i32;
                    SetCursorPos(x, y);
                    std::thread::sleep(Duration::from_millis(16));
                }
            }
        }
        _ => unsafe {
            SetCursorPos(request.x, request.y);
        },
    }

    Ok(ComputerMoveMouseResult {
        x: request.x,
        y: request.y,
    })
}

/// Click at coordinates.
pub(crate) fn execute_click(
    request: &ComputerClickRequest,
) -> Result<ComputerClickResult, JavisError> {
    validate_screen_coordinates(request.x, request.y)?;

    unsafe {
        SetCursorPos(request.x, request.y);
    }
    std::thread::sleep(Duration::from_millis(20));

    let button = request.button.as_deref().unwrap_or("left");
    let count = request.click_count.unwrap_or(1);

    let (down_flag, up_flag) = match button {
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    };

    for _ in 0..count {
        let inputs = [
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: down_flag,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: 0,
                        dy: 0,
                        mouseData: 0,
                        dwFlags: up_flag,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        send_input(&inputs).map_err(|e| JavisError::Internal(format!("click failed: {e}")))?;
        std::thread::sleep(Duration::from_millis(50));
    }

    Ok(ComputerClickResult {
        x: request.x,
        y: request.y,
        clicked: true,
    })
}

/// Type text via keyboard simulation.
pub(crate) fn type_text(request: &ComputerTypeRequest) -> Result<ComputerTypeResult, JavisError> {
    let delay = Duration::from_millis(request.delay_ms.unwrap_or(50));
    let text_len = request.text.chars().count();

    // Clear before if requested
    if request.clear_before.unwrap_or(false) {
        // Ctrl+A — validate against deny list
        validate_key_combo(&["Ctrl".into(), "a".into()])?;
        send_key_combo_internal(&["Ctrl", "a"])?;
        std::thread::sleep(Duration::from_millis(50));
        // Delete
        send_single_key(VK_DELETE)?;
        std::thread::sleep(Duration::from_millis(50));
    }

    for ch in request.text.chars() {
        send_char(ch)?;
        std::thread::sleep(delay);
    }

    Ok(ComputerTypeResult {
        typed: true,
        length: text_len,
    })
}

fn send_char(ch: char) -> Result<(), JavisError> {
    if let Some(vk) = vk_scan_char(ch) {
        // Simple ASCII — use VkKeyScanW
        let vk_code = (vk & 0xFF) as u16;
        let shift_needed = (vk >> 8) & 1 != 0;
        let ctrl_needed = (vk >> 8) & 2 != 0;
        let alt_needed = (vk >> 8) & 4 != 0;

        if shift_needed {
            press_key(VK_SHIFT)?;
        }
        if ctrl_needed {
            press_key(VK_CONTROL)?;
        }
        if alt_needed {
            press_key(VK_MENU)?;
        }
        press_key(vk_code)?;
        release_key(vk_code)?;
        if alt_needed {
            release_key(VK_MENU)?;
        }
        if ctrl_needed {
            release_key(VK_CONTROL)?;
        }
        if shift_needed {
            release_key(VK_SHIFT)?;
        }
    } else {
        // Unicode character — use KEYEVENTF_UNICODE
        let mut code_units = [0u16; 2];
        let encoded = ch.encode_utf16(&mut code_units);
        for cu in encoded.iter() {
            let inputs = [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: 0,
                            wScan: *cu,
                            dwFlags: KEYEVENTF_UNICODE,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: 0,
                            wScan: *cu,
                            dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
            ];
            send_input(&inputs)?;
        }
    }
    Ok(())
}

fn vk_scan_char(ch: char) -> Option<i16> {
    let vk = unsafe { VkKeyScanW(ch as u16) };
    if vk == -1 {
        None
    } else {
        Some(vk)
    }
}

fn send_input(events: &[INPUT]) -> Result<u32, JavisError> {
    let count = events.len() as u32;
    let inserted =
        unsafe { SendInput(count, events.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    if inserted == 0 {
        Err(JavisError::Internal(
            "SendInput failed — the injected events were blocked (UIPI or driver issue)."
                .to_string(),
        ))
    } else if inserted < count {
        Err(JavisError::Internal(format!(
            "SendInput partial failure — only {inserted} of {count} events inserted; input state may be inconsistent."
        )))
    } else {
        Ok(inserted)
    }
}

fn press_key(vk: u16) -> Result<(), JavisError> {
    let inputs = [INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: 0,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }];
    send_input(&inputs)?;
    Ok(())
}

fn release_key(vk: u16) -> Result<(), JavisError> {
    let inputs = [INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }];
    send_input(&inputs)?;
    Ok(())
}

fn send_single_key(vk: u16) -> Result<(), JavisError> {
    press_key(vk)?;
    release_key(vk)
}

/// Execute a key combination.
pub(crate) fn key_combo(
    request: &ComputerKeyComboRequest,
) -> Result<ComputerKeyComboResult, JavisError> {
    validate_key_combo(&request.keys)?;
    let combo_str = request.keys.join(" + ");
    send_key_combo_internal(&request.keys.iter().map(|k| k.as_str()).collect::<Vec<_>>())?;
    Ok(ComputerKeyComboResult {
        combo: combo_str,
        executed: true,
    })
}

fn send_key_combo_internal(keys: &[&str]) -> Result<(), JavisError> {
    let normalized: Vec<String> = keys.iter().map(|k| normalize_key(k)).collect();
    let vks: Vec<u16> = normalized
        .iter()
        .map(|k| key_to_vk(k).ok_or_else(|| JavisError::Validation(format!("Unknown key: {k}"))))
        .collect::<Result<Vec<_>, _>>()?;

    // Press all keys in order. Track how many were pressed so we can
    // roll back on failure — a stuck modifier key (Ctrl/Alt/Shift/Win)
    // corrupts the user's keyboard state.
    let mut pressed: usize = 0;
    let press_result = (|| {
        for &vk in &vks {
            press_key(vk)?;
            std::thread::sleep(Duration::from_millis(10));
            pressed += 1;
        }
        Ok(())
    })();

    if let Err(err) = press_result {
        // Release keys already pressed, in reverse order
        for &vk in vks[..pressed].iter().rev() {
            let _ = release_key(vk);
        }
        return Err(err);
    }

    // Release in reverse order
    let mut released: usize = 0;
    let release_result = (|| {
        for &vk in vks.iter().rev() {
            release_key(vk)?;
            std::thread::sleep(Duration::from_millis(10));
            released += 1;
        }
        Ok(())
    })();

    if let Err(err) = release_result {
        // Try to release remaining keys
        let remaining = vks.len() - released;
        for &vk in vks[..remaining].iter() {
            let _ = release_key(vk);
        }
        return Err(err);
    }

    Ok(())
}

/// Scroll at coordinates.
pub(crate) fn execute_scroll(
    request: &ComputerScrollRequest,
) -> Result<ComputerScrollResult, JavisError> {
    validate_screen_coordinates(request.x, request.y)?;

    unsafe {
        SetCursorPos(request.x, request.y);
    }
    std::thread::sleep(Duration::from_millis(20));

    let is_horizontal = request.direction.as_deref() == Some("horizontal");
    let flags = if is_horizontal {
        MOUSEEVENTF_HWHEEL
    } else {
        MOUSEEVENTF_WHEEL
    };

    // Windows scroll delta: 120 units = 1 notch
    let delta = request.delta * 120;

    let inputs = [INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: delta as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }];

    send_input(&inputs)?;

    Ok(ComputerScrollResult {
        x: request.x,
        y: request.y,
        delta: request.delta,
    })
}

/// Wait for a specified duration (clamped to 10s).
pub(crate) fn wait(request: &ComputerWaitRequest) -> Result<ComputerWaitResult, JavisError> {
    let clamped = request.ms.min(10000);
    std::thread::sleep(Duration::from_millis(clamped));
    Ok(ComputerWaitResult { waited: clamped })
}

#[cfg(windows)]
mod uia {
    use super::*;
    use windows::core::{Result as WindowsResult, BSTR};
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        IUIAutomationTreeWalker, IUIAutomationValuePattern, UIA_InvokePatternId,
        UIA_ValuePatternId,
    };

    const DEFAULT_MAX_DEPTH: u8 = 4;
    const DEFAULT_MAX_NODES: u16 = 120;

    struct ComApartment {
        should_uninitialize: bool,
    }

    impl ComApartment {
        fn init() -> Result<Self, JavisError> {
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if result == RPC_E_CHANGED_MODE {
                return Ok(Self {
                    should_uninitialize: false,
                });
            }
            result
                .ok()
                .map_err(|e| JavisError::Internal(format!("CoInitializeEx failed: {e}")))?;
            Ok(Self {
                should_uninitialize: true,
            })
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    struct UiNode {
        element: IUIAutomationElement,
        name: String,
        automation_id: String,
        control_type: String,
        control_type_id: i32,
        bounds: Option<WindowRect>,
    }

    pub(super) fn inspect_ui(
        request: &ComputerInspectUiRequest,
    ) -> Result<ComputerInspectUiResult, JavisError> {
        validate_window_handle_title(request.window_handle)?;
        let _com = ComApartment::init()?;
        let automation = automation()?;
        let root = root_element(&automation, request.window_handle)?;
        let walker = unsafe {
            automation
                .ControlViewWalker()
                .map_err(|e| JavisError::Internal(format!("ControlViewWalker failed: {e}")))?
        };
        let max_depth = request.max_depth.unwrap_or(DEFAULT_MAX_DEPTH).min(8);
        let max_nodes = request.max_nodes.unwrap_or(DEFAULT_MAX_NODES).min(500);
        let include_values = request.include_values.unwrap_or(false);
        let mut lines = Vec::new();
        let mut count = 0u16;
        write_tree(
            &walker,
            &root,
            0,
            max_depth,
            max_nodes,
            include_values,
            &mut count,
            &mut lines,
        )?;
        Ok(ComputerInspectUiResult {
            tree: lines.join("\n"),
            node_count: count,
        })
    }

    pub(super) fn invoke_ui(
        request: &ComputerInvokeUiRequest,
    ) -> Result<ComputerInvokeUiResult, JavisError> {
        let node = find_selected_node(&request.selector)?;
        let pattern: IUIAutomationInvokePattern = unsafe {
            node.element
                .GetCurrentPatternAs(UIA_InvokePatternId)
                .map_err(|e| {
                    JavisError::Validation(format!(
                        "Matched UI element does not support InvokePattern: {e}"
                    ))
                })?
        };
        unsafe {
            pattern
                .Invoke()
                .map_err(|e| JavisError::Internal(format!("InvokePattern.Invoke failed: {e}")))?;
        }
        Ok(ComputerInvokeUiResult {
            invoked: true,
            matched_name: node.name,
            matched_automation_id: node.automation_id,
        })
    }

    pub(super) fn set_ui_value(
        request: &ComputerSetUiValueRequest,
    ) -> Result<ComputerSetUiValueResult, JavisError> {
        let node = find_selected_node(&request.selector)?;
        let pattern: IUIAutomationValuePattern = unsafe {
            node.element
                .GetCurrentPatternAs(UIA_ValuePatternId)
                .map_err(|e| {
                    JavisError::Validation(format!(
                        "Matched UI element does not support ValuePattern: {e}"
                    ))
                })?
        };
        let value = BSTR::from(request.value.as_str());
        unsafe {
            pattern
                .SetValue(&value)
                .map_err(|e| JavisError::Internal(format!("ValuePattern.SetValue failed: {e}")))?;
        }
        Ok(ComputerSetUiValueResult {
            set: true,
            matched_name: node.name,
            matched_automation_id: node.automation_id,
        })
    }

    fn automation() -> Result<IUIAutomation, JavisError> {
        unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|e| {
                JavisError::Internal(format!("CoCreateInstance(CUIAutomation) failed: {e}"))
            })
        }
    }

    fn root_element(
        automation: &IUIAutomation,
        handle: u64,
    ) -> Result<IUIAutomationElement, JavisError> {
        let hwnd = windows::Win32::Foundation::HWND(handle as *mut core::ffi::c_void);
        unsafe {
            automation.ElementFromHandle(hwnd).map_err(|e| {
                JavisError::Validation(format!("ElementFromHandle failed for {handle}: {e}"))
            })
        }
    }

    fn find_selected_node(selector: &UiElementSelector) -> Result<UiNode, JavisError> {
        validate_ui_selector(selector)?;
        validate_window_handle_title(selector.window_handle)?;
        let _com = ComApartment::init()?;
        let automation = automation()?;
        let root = root_element(&automation, selector.window_handle)?;
        let walker = unsafe {
            automation
                .ControlViewWalker()
                .map_err(|e| JavisError::Internal(format!("ControlViewWalker failed: {e}")))?
        };
        find_matching_node(&walker, &root, selector, 0, 12, 0, 1000)?.ok_or_else(|| {
            JavisError::Validation("No matching UI Automation element found".to_string())
        })
    }

    fn write_tree(
        walker: &IUIAutomationTreeWalker,
        element: &IUIAutomationElement,
        depth: u8,
        max_depth: u8,
        max_nodes: u16,
        include_values: bool,
        count: &mut u16,
        lines: &mut Vec<String>,
    ) -> Result<(), JavisError> {
        if *count >= max_nodes {
            return Ok(());
        }
        let node = read_node(element)?;
        let value_attr = if include_values {
            read_value(element)
                .map(|value| format!(" value=\"{}\"", escape_ui_text(&value)))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let bounds_attr = node
            .bounds
            .as_ref()
            .map(|rect| {
                format!(
                    " bounds=\"{},{},{},{}\"",
                    rect.x, rect.y, rect.width, rect.height
                )
            })
            .unwrap_or_default();
        lines.push(format!(
            "{}<{} name=\"{}\" automationId=\"{}\"{}{}>",
            "  ".repeat(depth as usize),
            node.control_type,
            escape_ui_text(&node.name),
            escape_ui_text(&node.automation_id),
            bounds_attr,
            value_attr,
        ));
        *count += 1;
        if depth >= max_depth {
            return Ok(());
        }
        for child in child_elements(walker, element)? {
            write_tree(
                walker,
                &child,
                depth + 1,
                max_depth,
                max_nodes,
                include_values,
                count,
                lines,
            )?;
            if *count >= max_nodes {
                break;
            }
        }
        Ok(())
    }

    fn read_value(element: &IUIAutomationElement) -> Option<String> {
        let pattern: IUIAutomationValuePattern =
            unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId).ok()? };
        let value = unsafe { pattern.CurrentValue().ok()? };
        Some(value.to_string())
    }

    fn find_matching_node(
        walker: &IUIAutomationTreeWalker,
        element: &IUIAutomationElement,
        selector: &UiElementSelector,
        depth: u8,
        max_depth: u8,
        visited: u16,
        max_nodes: u16,
    ) -> Result<Option<UiNode>, JavisError> {
        if visited >= max_nodes {
            return Ok(None);
        }
        let node = read_node(element)?;
        if selector_matches(&node, selector) {
            return Ok(Some(node));
        }
        if depth >= max_depth {
            return Ok(None);
        }
        let mut seen = visited + 1;
        for child in child_elements(walker, element)? {
            if let Some(found) = find_matching_node(
                walker,
                &child,
                selector,
                depth + 1,
                max_depth,
                seen,
                max_nodes,
            )? {
                return Ok(Some(found));
            }
            seen += 1;
            if seen >= max_nodes {
                break;
            }
        }
        Ok(None)
    }

    fn child_elements(
        walker: &IUIAutomationTreeWalker,
        element: &IUIAutomationElement,
    ) -> Result<Vec<IUIAutomationElement>, JavisError> {
        let mut children = Vec::new();
        let mut next: WindowsResult<IUIAutomationElement> =
            unsafe { walker.GetFirstChildElement(element) };
        while let Ok(child) = next {
            next = unsafe { walker.GetNextSiblingElement(&child) };
            children.push(child);
        }
        Ok(children)
    }

    fn read_node(element: &IUIAutomationElement) -> Result<UiNode, JavisError> {
        let name = unsafe {
            element
                .CurrentName()
                .map(|v| v.to_string())
                .unwrap_or_default()
        };
        let automation_id = unsafe {
            element
                .CurrentAutomationId()
                .map(|v| v.to_string())
                .unwrap_or_default()
        };
        let control_type_id = unsafe {
            element
                .CurrentControlType()
                .map(|v| v.0)
                .unwrap_or_default()
        };
        let control_type = control_type_name(control_type_id).to_string();
        Ok(UiNode {
            element: element.clone(),
            name,
            automation_id,
            control_type,
            control_type_id,
            bounds: read_bounds(element),
        })
    }

    fn read_bounds(element: &IUIAutomationElement) -> Option<WindowRect> {
        let rect = unsafe { element.CurrentBoundingRectangle().ok()? };
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }
        Some(WindowRect {
            x: rect.left,
            y: rect.top,
            width,
            height,
        })
    }

    fn selector_matches(node: &UiNode, selector: &UiElementSelector) -> bool {
        selector
            .automation_id
            .as_ref()
            .map(|value| node.automation_id == *value)
            .unwrap_or(true)
            && selector
                .name
                .as_ref()
                .map(|value| node.name.contains(value))
                .unwrap_or(true)
            && selector
                .control_type
                .as_ref()
                .map(|value| control_type_matches(node, value))
                .unwrap_or(true)
    }

    fn control_type_matches(node: &UiNode, value: &str) -> bool {
        node.control_type.eq_ignore_ascii_case(value)
            || value
                .strip_prefix("controlType")
                .and_then(|id| id.parse::<i32>().ok())
                .map(|id| id == node.control_type_id)
                .unwrap_or(false)
            || value
                .parse::<i32>()
                .map(|id| id == node.control_type_id)
                .unwrap_or(false)
    }

    pub(super) fn control_type_name(control_type_id: i32) -> &'static str {
        match control_type_id {
            50000 => "Button",
            50001 => "Calendar",
            50002 => "CheckBox",
            50003 => "ComboBox",
            50004 => "Edit",
            50005 => "Hyperlink",
            50006 => "Image",
            50007 => "ListItem",
            50008 => "List",
            50009 => "Menu",
            50010 => "MenuBar",
            50011 => "MenuItem",
            50012 => "ProgressBar",
            50013 => "RadioButton",
            50014 => "ScrollBar",
            50015 => "Slider",
            50016 => "Spinner",
            50017 => "StatusBar",
            50018 => "Tab",
            50019 => "TabItem",
            50020 => "Text",
            50021 => "ToolBar",
            50022 => "ToolTip",
            50023 => "Tree",
            50024 => "TreeItem",
            50025 => "Custom",
            50026 => "Group",
            50027 => "Thumb",
            50028 => "DataGrid",
            50029 => "DataItem",
            50030 => "Document",
            50031 => "SplitButton",
            50032 => "Window",
            50033 => "Pane",
            50034 => "Header",
            50035 => "HeaderItem",
            50036 => "Table",
            50037 => "TitleBar",
            50038 => "Separator",
            50039 => "SemanticZoom",
            50040 => "AppBar",
            _ => "Control",
        }
    }

    fn validate_ui_selector(selector: &UiElementSelector) -> Result<(), JavisError> {
        if selector
            .automation_id
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
            && selector.name.as_deref().unwrap_or("").trim().is_empty()
        {
            return Err(JavisError::Validation(
                "UI Automation selector requires automationId or name".to_string(),
            ));
        }
        for value in [
            selector.automation_id.as_deref(),
            selector.name.as_deref(),
            selector.control_type.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.len() > 200 {
                return Err(JavisError::Validation(
                    "UI Automation selector fields must be at most 200 characters".to_string(),
                ));
            }
        }
        Ok(())
    }

    fn escape_ui_text(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }
}

#[cfg(not(windows))]
mod uia {
    use super::*;

    pub(super) fn inspect_ui(
        _request: &ComputerInspectUiRequest,
    ) -> Result<ComputerInspectUiResult, JavisError> {
        Err(JavisError::Validation(
            "UI Automation is only available on Windows".to_string(),
        ))
    }

    pub(super) fn invoke_ui(
        _request: &ComputerInvokeUiRequest,
    ) -> Result<ComputerInvokeUiResult, JavisError> {
        Err(JavisError::Validation(
            "UI Automation is only available on Windows".to_string(),
        ))
    }

    pub(super) fn set_ui_value(
        _request: &ComputerSetUiValueRequest,
    ) -> Result<ComputerSetUiValueResult, JavisError> {
        Err(JavisError::Validation(
            "UI Automation is only available on Windows".to_string(),
        ))
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn computer_screenshot(
    request: ComputerScreenshotRequest,
) -> Result<ComputerScreenshotResult, String> {
    run_blocking_computer_command(move || capture_screenshot(&request)).await
}

#[tauri::command]
pub(crate) async fn computer_list_windows(
    request: ComputerListWindowsRequest,
) -> Result<ComputerListWindowsResult, String> {
    let _ = request;
    run_blocking_computer_command(list_windows).await
}

#[tauri::command]
pub(crate) async fn computer_detect_ui_objects(
    request: ComputerDetectUiObjectsRequest,
) -> Result<ComputerDetectUiObjectsResult, String> {
    run_blocking_computer_command(move || detect_ui_objects_with_runtime(&request)).await
}

#[tauri::command]
pub(crate) async fn computer_local_vision_default_model_path() -> Result<Option<String>, String> {
    run_blocking_computer_command(|| {
        Ok(
            resolve_local_vision_default_model_path()
                .map(|path| path.to_string_lossy().to_string()),
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn computer_wait(
    request: ComputerWaitRequest,
) -> Result<ComputerWaitResult, String> {
    run_blocking_computer_command(move || wait(&request)).await
}

#[tauri::command]
pub(crate) async fn computer_inspect_ui(
    request: ComputerInspectUiRequest,
) -> Result<ComputerInspectUiResult, String> {
    run_blocking_computer_command(move || uia::inspect_ui(&request)).await
}

async fn run_blocking_computer_command<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, JavisError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| format!("Computer Use worker failed: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn computer_approve_action(
    state: tauri::State<'_, Mutex<ComputerApprovalState>>,
    approval_id: String,
    task_id: String,
    tool_name: String,
    params_json: String,
    #[allow(unused_variables)] session_wide: Option<bool>,
    risk_level: Option<String>,
) -> Result<(), String> {
    computer_approve_action_inner(
        state.inner(),
        approval_id,
        task_id,
        tool_name,
        params_json,
        session_wide,
        risk_level,
    )
}

#[tauri::command]
pub(crate) fn computer_cancel_approvals(
    state: tauri::State<'_, Mutex<ComputerApprovalState>>,
    task_id: Option<String>,
) -> Result<(), String> {
    computer_cancel_approvals_inner(state.inner(), task_id)
}

fn computer_cancel_approvals_inner(
    state: &Mutex<ComputerApprovalState>,
    task_id: Option<String>,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    if let Some(task_id) = task_id {
        guard.leases.remove(&task_id);
        guard
            .pending
            .retain(|_, pending| pending.binding.task_id() != task_id.as_str());
    } else {
        guard.pending.clear();
        guard.leases.clear();
    }
    Ok(())
}

fn computer_approve_action_inner(
    state: &Mutex<ComputerApprovalState>,
    approval_id: String,
    task_id: String,
    tool_name: String,
    params_json: String,
    session_wide: Option<bool>,
    risk_level: Option<String>,
) -> Result<(), String> {
    validate_approval_id(&approval_id).map_err(|e| e.to_string())?;
    validate_task_id(&task_id).map_err(|e| e.to_string())?;
    let raw_params: serde_json::Value =
        serde_json::from_str(&params_json).map_err(|e| format!("Invalid params JSON: {e}"))?;

    validate_computer_action_params(&tool_name, &raw_params).map_err(|e| e.to_string())?;
    let normalized = normalize_computer_params(&tool_name, &raw_params)
        .map_err(|e| format!("Invalid params: {e}"))?;
    let preview_hash = hash_action_params(&tool_name, &normalized);

    let mut guard = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    prune_expired_computer_approvals(&mut guard);

    if session_wide.unwrap_or(false) {
        if requires_per_action_computer_approval(&tool_name, &normalized) {
            return Err(
                "This Computer Use action requires per-action approval because it can enter free text, press keys, or handle sensitive controls/values."
                    .to_string(),
            );
        }
        if risk_level.as_deref() == Some("commit") {
            return Err(
                "Commit-level actions (send, submit, Enter) require per-action approval and cannot create task leases."
                    .to_string(),
            );
        }
        if is_commit_action(&tool_name, &normalized) {
            return Err(
                "Commit-level actions (Enter, send, submit) require per-action approval and cannot create task leases."
                    .to_string(),
            );
        }
        let scope = computer_action_scope(&tool_name, &normalized).map_err(|e| e.to_string())?;
        validate_reusable_computer_approval_scope(&scope).map_err(|e| e.to_string())?;
        guard.leases.insert(
            task_id.clone(),
            ComputerApprovalLease {
                task_id,
                approval_id,
                created_at: SystemTime::now(),
                remaining_actions: COMPUTER_LEASE_MAX_ACTIONS,
                scope,
            },
        );
        return Ok(());
    }

    guard.leases.remove(&task_id);

    // Per-action approval — normalized params → hash → one-shot binding
    let pending_key = approval_id.clone();
    let binding = crate::create_native_approval_binding(
        approval_id,
        &tool_name,
        task_id,
        preview_hash,
        true, // approved
    );

    guard.pending.insert(
        pending_key,
        PendingComputerApproval {
            binding,
            created_at: SystemTime::now(),
        },
    );
    Ok(())
}

fn normalize_computer_params(
    tool_name: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, JavisError> {
    match tool_name {
        "computer.focusWindow" => {
            let req: ComputerFocusWindowRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid focusWindow params: {e}")))?;
            Ok(serde_json::to_value(&req).unwrap_or_default())
        }
        "computer.moveMouse" => {
            let req: ComputerMoveMouseRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid moveMouse params: {e}")))?;
            Ok(serde_json::to_value(&req).unwrap_or_default())
        }
        "computer.click" => {
            let req: ComputerClickRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid click params: {e}")))?;
            Ok(serde_json::to_value(&req).unwrap_or_default())
        }
        "computer.type" => {
            let req: ComputerTypeRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid type params: {e}")))?;
            Ok(serde_json::to_value(&req).unwrap_or_default())
        }
        "computer.keyCombo" => {
            let req: ComputerKeyComboRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid keyCombo params: {e}")))?;
            Ok(serde_json::to_value(&req).unwrap_or_default())
        }
        "computer.scroll" => {
            let req: ComputerScrollRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid scroll params: {e}")))?;
            Ok(serde_json::to_value(&req).unwrap_or_default())
        }
        "computer.invokeUi" => {
            let req: ComputerInvokeUiRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid invokeUi params: {e}")))?;
            Ok(serde_json::to_value(&req).unwrap_or_default())
        }
        "computer.setUiValue" => {
            let req: ComputerSetUiValueRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid setUiValue params: {e}")))?;
            Ok(serde_json::to_value(&req).unwrap_or_default())
        }
        _ => Err(JavisError::Validation(format!(
            "Unsupported computer action approval tool: {tool_name}"
        ))),
    }
}

fn validate_computer_action_params(
    tool_name: &str,
    params: &serde_json::Value,
) -> Result<(), JavisError> {
    match tool_name {
        "computer.focusWindow" => {
            let request: ComputerFocusWindowRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid focusWindow params: {e}")))?;
            validate_focus_request(&request)
        }
        "computer.moveMouse" => {
            let request: ComputerMoveMouseRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid moveMouse params: {e}")))?;
            validate_move_request(&request)
        }
        "computer.click" => {
            let request: ComputerClickRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid click params: {e}")))?;
            validate_click_request(&request)
        }
        "computer.type" => {
            let request: ComputerTypeRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid type params: {e}")))?;
            validate_type_request(&request)
        }
        "computer.keyCombo" => {
            let request: ComputerKeyComboRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid keyCombo params: {e}")))?;
            validate_keycombo_request(&request)
        }
        "computer.scroll" => {
            let request: ComputerScrollRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid scroll params: {e}")))?;
            validate_scroll_request(&request)
        }
        "computer.invokeUi" => {
            let request: ComputerInvokeUiRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid invokeUi params: {e}")))?;
            validate_invoke_ui_request(&request)
        }
        "computer.setUiValue" => {
            let request: ComputerSetUiValueRequest = serde_json::from_value(params.clone())
                .map_err(|e| JavisError::Validation(format!("Invalid setUiValue params: {e}")))?;
            validate_set_ui_value_request(&request)
        }
        _ => Err(JavisError::Validation(format!(
            "Unsupported computer action approval tool: {tool_name}"
        ))),
    }
}

macro_rules! impl_computer_write_command {
    ($fn_name:ident, $request_type:ty, $result_type:ty, $tool_suffix:expr, $validate_fn:expr, $execute_fn:expr) => {
        #[tauri::command]
        pub(crate) async fn $fn_name(
            state: tauri::State<'_, Mutex<ComputerApprovalState>>,
            approval_id: String,
            task_id: String,
            request: $request_type,
        ) -> Result<$result_type, String> {
            let used_task_lease = {
                validate_approval_id(&approval_id).map_err(|e| e.to_string())?;
                validate_task_id(&task_id).map_err(|e| e.to_string())?;

                // Run domain-specific validation
                ($validate_fn)(&request).map_err(|e: JavisError| e.to_string())?;

                // Compute preview hash
                let tool_name = format!("computer.{}", $tool_suffix);
                let params_json = serde_json::to_value(&request).unwrap_or_default();
                let preview_hash = hash_action_params(&tool_name, &params_json);

                // Validate approval — one-shot binding only.
                let mut guard = state.lock().map_err(|e| format!("Lock error: {e}"))?;
                validate_computer_write_rate_limit(&guard).map_err(|e| e.to_string())?;
                let mut used_task_lease = false;
                if let Some(pending) = guard.pending.remove(&approval_id) {
                    // Per-action approval — strict hash check
                    validate_pending_computer_approval(&pending).map_err(|e| e.to_string())?;
                    require_native_approval_binding(
                        &pending.binding,
                        &approval_id,
                        &tool_name,
                        Some(&task_id),
                        &preview_hash,
                        "Approval hash mismatch — operation params differ from approved action.",
                        "Computer Use action requires confirmed-write approval.",
                    )
                    .map_err(|e| e.to_string())?;
                } else if let Some(lease) = guard.leases.get_mut(&task_id) {
                    validate_computer_task_lease_for_action(
                        lease,
                        &approval_id,
                        &task_id,
                        &tool_name,
                        &params_json,
                    )?;
                    used_task_lease = true;
                } else {
                    return Err(
                        "No pending computer approval - call computer_approve_action first."
                            .to_string(),
                    );
                }
                guard.last_write_at = Some(SystemTime::now());
                used_task_lease
            };

            // Execute
            let execution = run_blocking_computer_command(move || ($execute_fn)(&request)).await;
            if execution.is_err() && used_task_lease {
                remove_matching_computer_lease(state.inner(), &task_id, &approval_id);
            }
            execution
        }
    };
}

fn prune_expired_computer_approvals(state: &mut ComputerApprovalState) {
    state
        .pending
        .retain(|_, pending| validate_pending_computer_approval(pending).is_ok());
    state
        .leases
        .retain(|_, lease| validate_computer_approval_lease(lease).is_ok());
}

fn requires_per_action_computer_approval(tool_name: &str, params: &serde_json::Value) -> bool {
    match tool_name {
        "computer.type" | "computer.keyCombo" => true,
        "computer.setUiValue" => {
            selector_name_contains_sensitive_text(
                params
                    .get("selector")
                    .or_else(|| params.get("Selector"))
                    .unwrap_or(&serde_json::Value::Null),
            ) || params
                .get("value")
                .or_else(|| params.get("Value"))
                .and_then(|value| value.as_str())
                .is_some_and(text_contains_sensitive_value)
        }
        "computer.invokeUi" => selector_name_contains_sensitive_text(
            params
                .get("selector")
                .or_else(|| params.get("Selector"))
                .unwrap_or(&serde_json::Value::Null),
        ),
        _ => false,
    }
}

fn selector_name_contains_sensitive_text(selector: &serde_json::Value) -> bool {
    let Some(object) = selector.as_object() else {
        return false;
    };
    for key in ["name", "automationId", "automation_id"] {
        let Some(value) = object.get(key).and_then(|value| value.as_str()) else {
            continue;
        };
        let lower = value.to_lowercase();
        let compact = compact_ascii_alnum(&lower);
        if lower.contains("delete")
            || lower.contains("remove")
            || lower.contains("pay")
            || lower.contains("purchase")
            || lower.contains("submit")
            || lower.contains("send")
            || lower.contains("publish")
            || lower.contains("overwrite")
            || lower.contains("install")
            || lower.contains("grant")
            || lower.contains("permission")
            || lower.contains("password")
            || lower.contains("passcode")
            || lower.contains("pin")
            || lower.contains("otp")
            || lower.contains("2fa")
            || lower.contains("mfa")
            || lower.contains("token")
            || lower.contains("secret")
            || lower.contains("credential")
            || lower.contains("api key")
            || lower.contains("api_key")
            || lower.contains("api-key")
            || lower.contains("private key")
            || lower.contains("private_key")
            || lower.contains("private-key")
            || compact.contains("apikey")
            || compact.contains("privatekey")
            || compact.contains("passcode")
            || compact.contains("creditcard")
            || compact.contains("cardnumber")
            || lower.contains("删除")
            || lower.contains("移除")
            || lower.contains("付款")
            || lower.contains("支付")
            || lower.contains("购买")
            || lower.contains("转账")
            || lower.contains("提交")
            || lower.contains("发送")
            || lower.contains("发布")
            || lower.contains("覆盖")
            || lower.contains("安装")
            || lower.contains("授权")
            || lower.contains("权限")
            || lower.contains("密码")
            || lower.contains("令牌")
            || lower.contains("密钥")
            || lower.contains("凭据")
            || lower.contains("凭证")
        {
            return true;
        }
    }
    false
}

fn text_contains_sensitive_value(value: &str) -> bool {
    let lower = value.to_lowercase();
    let compact = compact_ascii_alnum(&lower);
    lower.contains("password")
        || lower.contains("passcode")
        || lower.contains("pin")
        || lower.contains("otp")
        || lower.contains("2fa")
        || lower.contains("mfa")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("credential")
        || lower.contains("api key")
        || lower.contains("api_key")
        || lower.contains("api-key")
        || lower.contains("private key")
        || lower.contains("private_key")
        || lower.contains("private-key")
        || compact.contains("apikey")
        || compact.contains("privatekey")
        || compact.contains("creditcard")
        || compact.contains("cardnumber")
        || lower.contains("sk-")
        || lower.contains("ghp_")
        || lower.contains("xoxb-")
        || lower.contains("xoxp-")
        || lower.contains("xoxa-")
        || lower.contains("akia")
        || lower.contains("eyj")
        || lower.contains("credit card")
        || lower.contains("card number")
        || lower.contains("cvv")
        || lower.contains("ssn")
        || lower.contains("passport")
        || lower.contains("密码")
        || lower.contains("口令")
        || lower.contains("验证码")
        || lower.contains("动态码")
        || lower.contains("令牌")
        || lower.contains("密钥")
        || lower.contains("私钥")
        || lower.contains("凭据")
        || lower.contains("凭证")
        || lower.contains("信用卡")
        || lower.contains("银行卡")
        || lower.contains("身份证")
        || lower.contains("护照")
}

fn compact_ascii_alnum(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

fn validate_focus_request(req: &ComputerFocusWindowRequest) -> Result<(), JavisError> {
    validate_window_handle_title(req.handle)
}

fn validate_move_request(req: &ComputerMoveMouseRequest) -> Result<(), JavisError> {
    validate_screen_coordinates(req.x, req.y)?;
    match req.speed.as_deref().unwrap_or("instant") {
        "instant" | "linear" => Ok(()),
        other => Err(JavisError::Validation(format!(
            "Unsupported mouse movement speed: {other}"
        ))),
    }
}

fn validate_click_request(req: &ComputerClickRequest) -> Result<(), JavisError> {
    validate_window_at_point(req.x, req.y)?;
    match req.button.as_deref().unwrap_or("left") {
        "left" | "right" | "middle" => {}
        other => {
            return Err(JavisError::Validation(format!(
                "Unsupported mouse button: {other}"
            )));
        }
    }
    match req.click_count.unwrap_or(1) {
        1 | 2 => Ok(()),
        other => Err(JavisError::Validation(format!(
            "Unsupported click count: {other}"
        ))),
    }
}

fn validate_type_request(req: &ComputerTypeRequest) -> Result<(), JavisError> {
    validate_foreground_window()?;
    if req.delay_ms.unwrap_or(50) > 1000 {
        return Err(JavisError::Validation(
            "Typing delay must be at most 1000ms".to_string(),
        ));
    }
    Ok(())
}

fn validate_keycombo_request(req: &ComputerKeyComboRequest) -> Result<(), JavisError> {
    validate_foreground_window()?;
    validate_key_combo(&req.keys)
}

fn validate_scroll_request(req: &ComputerScrollRequest) -> Result<(), JavisError> {
    validate_window_at_point(req.x, req.y)?;
    match req.direction.as_deref().unwrap_or("vertical") {
        "vertical" | "horizontal" => Ok(()),
        other => Err(JavisError::Validation(format!(
            "Unsupported scroll direction: {other}"
        ))),
    }
}

fn validate_ui_selector_request(selector: &UiElementSelector) -> Result<(), JavisError> {
    validate_window_handle_title(selector.window_handle)?;
    if selector
        .automation_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
        && selector.name.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err(JavisError::Validation(
            "UI Automation selector requires automationId or name".to_string(),
        ));
    }
    Ok(())
}

fn validate_task_id(task_id: &str) -> Result<(), JavisError> {
    validate_binding_id("task_id", task_id)
}

fn validate_approval_id(approval_id: &str) -> Result<(), JavisError> {
    validate_binding_id("approval_id", approval_id)
}

fn validate_binding_id(name: &str, value: &str) -> Result<(), JavisError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err(JavisError::Validation(format!(
            "Computer Use {name} must be non-empty and at most 128 characters."
        )));
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.'))
    {
        return Err(JavisError::Validation(format!(
            "Computer Use {name} contains unsupported characters."
        )));
    }
    Ok(())
}

fn validate_computer_write_rate_limit(state: &ComputerApprovalState) -> Result<(), JavisError> {
    let Some(last_write_at) = state.last_write_at else {
        return Ok(());
    };
    let elapsed = last_write_at
        .elapsed()
        .map_err(|_| JavisError::Permission("Computer Use write timestamp is invalid.".into()))?;
    if elapsed < COMPUTER_WRITE_MIN_INTERVAL {
        return Err(JavisError::Permission(
            "Computer Use write actions are being sent too quickly.".into(),
        ));
    }
    Ok(())
}

fn validate_invoke_ui_request(req: &ComputerInvokeUiRequest) -> Result<(), JavisError> {
    validate_ui_selector_request(&req.selector)
}

fn validate_set_ui_value_request(req: &ComputerSetUiValueRequest) -> Result<(), JavisError> {
    validate_ui_selector_request(&req.selector)?;
    if req.value.chars().count() > 10_000 {
        return Err(JavisError::Validation(
            "UI Automation value must be at most 10000 characters".to_string(),
        ));
    }
    Ok(())
}

impl_computer_write_command!(
    computer_focus_window,
    ComputerFocusWindowRequest,
    ComputerFocusWindowResult,
    "focusWindow",
    validate_focus_request,
    focus_window
);

impl_computer_write_command!(
    computer_move_mouse,
    ComputerMoveMouseRequest,
    ComputerMoveMouseResult,
    "moveMouse",
    validate_move_request,
    move_mouse
);

impl_computer_write_command!(
    computer_click,
    ComputerClickRequest,
    ComputerClickResult,
    "click",
    validate_click_request,
    execute_click
);

impl_computer_write_command!(
    computer_type,
    ComputerTypeRequest,
    ComputerTypeResult,
    "type",
    validate_type_request,
    type_text
);

impl_computer_write_command!(
    computer_key_combo,
    ComputerKeyComboRequest,
    ComputerKeyComboResult,
    "keyCombo",
    validate_keycombo_request,
    key_combo
);

impl_computer_write_command!(
    computer_scroll,
    ComputerScrollRequest,
    ComputerScrollResult,
    "scroll",
    validate_scroll_request,
    execute_scroll
);

impl_computer_write_command!(
    computer_invoke_ui,
    ComputerInvokeUiRequest,
    ComputerInvokeUiResult,
    "invokeUi",
    validate_invoke_ui_request,
    uia::invoke_ui
);

impl_computer_write_command!(
    computer_set_ui_value,
    ComputerSetUiValueRequest,
    ComputerSetUiValueResult,
    "setUiValue",
    validate_set_ui_value_request,
    uia::set_ui_value
);

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PNG_DATA_URL: &str = "data:image/png;base64,iVBORw0KGgo=";
    static REUSABLE_WORKER_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    #[test]
    fn test_analyze_screenshot_health_flags_solid_black() {
        let pixels = solid_rgba(32, 32, 0, 0, 0);
        let health = analyze_screenshot_health(32, 32, &pixels);

        assert!(health.suspicious_blank);
        assert_eq!(health.reason.as_deref(), Some("dark"));
        assert!(health.dark_pixel_ratio > 0.99);
    }

    #[test]
    fn test_analyze_screenshot_health_allows_mixed_pixels() {
        let mut pixels = Vec::with_capacity(32 * 32 * 4);
        for y in 0..32 {
            for x in 0..32 {
                let value = if (x + y) % 2 == 0 { 0 } else { 255 };
                pixels.extend_from_slice(&[value, value, value, 255]);
            }
        }
        let health = analyze_screenshot_health(32, 32, &pixels);

        assert!(!health.suspicious_blank);
        assert!(health.dominant_color_ratio < 0.6);
    }

    fn solid_rgba(width: usize, height: usize, r: u8, g: u8, b: u8) -> Vec<u8> {
        let mut pixels = Vec::with_capacity(width * height * 4);
        for _ in 0..width * height {
            pixels.extend_from_slice(&[r, g, b, 255]);
        }
        pixels
    }

    #[test]
    fn test_validate_window_deny_task_manager() {
        assert!(validate_window_title("Task Manager").is_err());
        assert!(validate_window_title("Windows Task Manager").is_err());
        assert!(validate_window_title("任务管理器").is_err());
    }

    #[test]
    fn test_validate_window_allow_normal() {
        assert!(validate_window_title("VS Code").is_ok());
        assert!(validate_window_title("Chrome").is_ok());
        assert!(validate_window_title("记事本").is_ok());
    }

    #[test]
    fn test_validate_key_combo_deny_dangerous() {
        assert!(validate_key_combo(&["Win".into(), "R".into()]).is_err());
        assert!(validate_key_combo(&["R".into(), "Win".into()]).is_err());
        assert!(validate_key_combo(&["Ctrl".into(), "Alt".into(), "Del".into()]).is_err());
        assert!(validate_key_combo(&["Alt".into(), "F4".into()]).is_err());
        assert!(validate_key_combo(&["Win".into(), "L".into()]).is_err());
    }

    #[test]
    fn test_validate_key_combo_allow_normal() {
        assert!(validate_key_combo(&["Ctrl".into(), "C".into()]).is_ok());
        assert!(validate_key_combo(&["Ctrl".into(), "V".into()]).is_ok());
        assert!(validate_key_combo(&["Ctrl".into(), "S".into()]).is_ok());
    }

    #[test]
    fn test_normalize_key() {
        assert_eq!(normalize_key("ctrl"), "Ctrl");
        assert_eq!(normalize_key("CTRL"), "Ctrl");
        assert_eq!(normalize_key("control"), "Ctrl");
        assert_eq!(normalize_key("alt"), "Alt");
        assert_eq!(normalize_key("shift"), "Shift");
        assert_eq!(normalize_key("win"), "Win");
        assert_eq!(normalize_key("meta"), "Win");
        assert_eq!(normalize_key("a"), "a");
    }

    #[test]
    fn test_key_to_vk() {
        assert_eq!(key_to_vk("ctrl"), Some(VK_CONTROL));
        assert_eq!(key_to_vk("a"), Some(0x41));
        assert_eq!(key_to_vk("enter"), Some(VK_RETURN));
        assert_eq!(key_to_vk("1"), Some(0x31));
        assert_eq!(key_to_vk("]"), Some(VK_OEM_6));
        assert_eq!(key_to_vk("?"), Some(VK_OEM_2));
        assert_eq!(key_to_vk("unknown_key"), None);
    }

    #[test]
    fn test_window_screenshot_minimized_policy_keeps_printwindow_benefit() {
        assert!(window_screenshot_path_allows_minimized(
            WindowScreenshotPath::PrintWindow
        ));
        assert!(!window_screenshot_path_allows_minimized(
            WindowScreenshotPath::BitBlt
        ));
    }

    #[test]
    fn test_detect_ui_objects_noop_preserves_screenshot_id() {
        let result = detect_ui_objects_noop(&ComputerDetectUiObjectsRequest {
            image_data_url: TEST_PNG_DATA_URL.to_string(),
            screenshot_id: "shot-1".to_string(),
            observation_id: Some("obs-1".to_string()),
            window_handle: Some(42),
            classes: None,
            model_path: None,
            runtime: None,
            runtime_adapter_path: None,
            reuse_worker: None,
            imgsz: Some(640),
            max_detections: Some(20),
            min_confidence: Some(0.75),
            iou_threshold: None,
            timeout_ms: Some(120),
            label_map: None,
        })
        .unwrap();

        assert_eq!(result.screenshot_id, "shot-1");
        assert!(result.detections.is_empty());
        assert_eq!(result.runtime, "unknown");
        assert!(!result.timed_out);
    }

    fn sample_detect_ui_objects_request(screenshot_id: &str) -> ComputerDetectUiObjectsRequest {
        ComputerDetectUiObjectsRequest {
            image_data_url: TEST_PNG_DATA_URL.to_string(),
            screenshot_id: screenshot_id.to_string(),
            observation_id: Some("obs-2".to_string()),
            window_handle: None,
            classes: Some(vec!["possible_button".to_string()]),
            model_path: Some("models/yolo26n-ui.onnx".to_string()),
            runtime: Some("onnxruntime".to_string()),
            runtime_adapter_path: None,
            reuse_worker: None,
            imgsz: Some(640),
            max_detections: Some(20),
            min_confidence: Some(0.75),
            iou_threshold: None,
            timeout_ms: Some(120),
            label_map: None,
        }
    }

    #[test]
    fn test_detect_ui_objects_request_rejects_worker_internal_fields() {
        let public_request = serde_json::json!({
            "imageDataUrl": TEST_PNG_DATA_URL,
            "screenshotId": "shot-public",
            "modelPath": "models/yolo26n-ui.onnx",
            "reuseWorker": true
        });
        let public_request: ComputerDetectUiObjectsRequest =
            serde_json::from_value(public_request).unwrap();
        assert_eq!(public_request.reuse_worker, Some(true));

        let with_image_path = serde_json::json!({
            "imageDataUrl": TEST_PNG_DATA_URL,
            "imagePath": "C:/Users/alice/screen.png",
            "screenshotId": "shot-image-path",
            "modelPath": "models/yolo26n-ui.onnx"
        });
        let with_raw_detections = serde_json::json!({
            "imageDataUrl": TEST_PNG_DATA_URL,
            "screenshotId": "shot-raw-detections",
            "modelPath": "models/yolo26n-ui.onnx",
            "rawDetections": []
        });

        assert!(serde_json::from_value::<ComputerDetectUiObjectsRequest>(with_image_path).is_err());
        assert!(
            serde_json::from_value::<ComputerDetectUiObjectsRequest>(with_raw_detections).is_err()
        );
    }

    #[test]
    fn test_detect_ui_objects_runtime_reports_missing_worker() {
        let result =
            detect_ui_objects_with_worker_path(&sample_detect_ui_objects_request("shot-2"), None)
                .unwrap();

        assert_eq!(result.screenshot_id, "shot-2");
        assert_eq!(result.model, "yolo26n-ui.onnx");
        assert_eq!(result.runtime, "onnxruntime");
        assert!(result.detections.is_empty());
        assert!(result.error.unwrap().contains(LOCAL_VISION_WORKER_PATH_ENV));
    }

    #[test]
    fn test_local_vision_missing_worker_warns_for_official_coco_model() {
        let mut request = sample_detect_ui_objects_request("shot-coco-missing-worker");
        request.model_path = Some("models/yolo26n.onnx".to_string());

        let result = detect_ui_objects_with_worker_path(&request, None).unwrap();
        let diagnostics = result.diagnostics.unwrap();

        assert_eq!(result.model, "yolo26n.onnx");
        assert!(diagnostics["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|warning| warning
                .as_str()
                .is_some_and(|warning| warning.contains("smoke/benchmark only"))));
    }

    #[test]
    fn test_detect_ui_objects_auto_runtime_reports_unknown_until_worker_selects_runtime() {
        let mut request = sample_detect_ui_objects_request("shot-auto-runtime");
        request.runtime = Some("auto".to_string());

        let result = detect_ui_objects_with_worker_path(&request, None).unwrap();

        assert_eq!(result.screenshot_id, "shot-auto-runtime");
        assert_eq!(result.runtime, "unknown");
        assert!(result.detections.is_empty());
    }

    #[test]
    fn test_local_vision_worker_candidates_include_dev_and_bundled_paths() {
        let candidates = local_vision_worker_path_candidates();
        let normalized: Vec<String> = candidates
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();

        assert!(normalized
            .iter()
            .any(|path| path.ends_with("scripts/local-vision-worker.cmd")));
        assert!(normalized
            .iter()
            .any(|path| path.ends_with("scripts/local-vision-worker.mjs")));
        assert!(normalized
            .iter()
            .any(|path| path.contains("/resources/scripts/local-vision-worker.cmd")));
    }

    #[test]
    fn test_local_vision_worker_candidates_prefer_mjs_before_cmd_wrappers() {
        let candidates = local_vision_worker_path_candidates_near_executable(Path::new(
            "C:/Program Files/Javis/Javis.exe",
        ));
        let normalized: Vec<String> = candidates
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();
        let packaged_mjs = normalized
            .iter()
            .position(|path| path.ends_with("/resources/scripts/local-vision-worker.mjs"))
            .expect("packaged mjs worker candidate");
        let packaged_cmd = normalized
            .iter()
            .position(|path| path.ends_with("/resources/scripts/local-vision-worker.cmd"))
            .expect("packaged cmd worker candidate");

        assert!(packaged_mjs < packaged_cmd);
    }

    #[test]
    fn test_local_vision_worker_candidates_near_executable_include_packaged_resources_dir() {
        let exe_path = if cfg!(windows) {
            Path::new("C:/Program Files/Javis/Javis.exe")
        } else {
            Path::new("/opt/javis/javis")
        };
        let candidates = local_vision_worker_path_candidates_near_executable(exe_path);
        let normalized: Vec<String> = candidates
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();

        assert!(normalized
            .iter()
            .any(|path| path.ends_with("/scripts/local-vision-worker.cmd")));
        assert!(normalized
            .iter()
            .any(|path| path.ends_with("/resources/scripts/local-vision-worker.cmd")));
        assert!(normalized
            .iter()
            .any(|path| path.ends_with("/resources/scripts/local-vision-worker.mjs")));
    }

    #[test]
    fn test_local_vision_node_candidates_near_executable_include_packaged_resources_dir() {
        let exe_path = if cfg!(windows) {
            Path::new("C:/Program Files/Javis/Javis.exe")
        } else {
            Path::new("/opt/javis/javis")
        };
        let candidates = local_vision_node_path_candidates_near_executable(exe_path);
        let normalized: Vec<String> = candidates
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();

        if cfg!(windows) {
            assert!(normalized
                .iter()
                .any(|path| path.ends_with("/resources/bin/node/node.exe")));
            assert!(normalized
                .iter()
                .any(|path| path.ends_with("/resources/bin/node.exe")));
            assert!(normalized
                .iter()
                .any(|path| path.ends_with("/resources/node/node.exe")));
        } else {
            assert!(normalized
                .iter()
                .any(|path| path.ends_with("/resources/bin/node/node")));
            assert!(normalized
                .iter()
                .any(|path| path.ends_with("/resources/bin/node")));
            assert!(normalized
                .iter()
                .any(|path| path.ends_with("/resources/node/node")));
        }
    }

    #[test]
    fn test_local_vision_default_model_candidates_include_dev_and_packaged_paths() {
        let exe_path = if cfg!(windows) {
            Path::new("C:/Program Files/Javis/Javis.exe")
        } else {
            Path::new("/opt/javis/javis")
        };
        let candidates = local_vision_default_model_path_candidates_near_executable(exe_path);
        let normalized: Vec<String> = candidates
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();

        assert!(normalized
            .iter()
            .any(|path| path.ends_with("/resources/models/local-vision/yolo26n-ui.onnx")));
        assert!(normalized
            .iter()
            .any(|path| path.ends_with("/models/local-vision/yolo26n-ui.onnx")));
        assert!(normalized
            .iter()
            .any(|path| path.ends_with("/resources/artifacts/local-vision/yolo26n-ui.onnx")));
    }

    #[test]
    fn test_resolve_local_vision_model_path_for_worker_resolves_default_relative_reference() {
        let temp_dir = tempfile::tempdir().unwrap();
        let model_path = temp_dir
            .path()
            .join("models")
            .join("local-vision")
            .join("yolo26n-ui.onnx");
        std::fs::create_dir_all(model_path.parent().unwrap()).unwrap();
        std::fs::write(&model_path, "model").unwrap();

        let resolved = resolve_local_vision_model_path_for_worker_with_candidates(
            Some("models/local-vision/yolo26n-ui.onnx"),
            vec![model_path.clone()],
        );

        assert_eq!(resolved, Some(model_path.to_string_lossy().to_string()));
    }

    #[test]
    fn test_resolve_local_vision_model_path_for_worker_preserves_custom_relative_reference() {
        let resolved = resolve_local_vision_model_path_for_worker_with_candidates(
            Some("models/custom-ui.onnx"),
            Vec::<PathBuf>::new(),
        );

        assert_eq!(resolved.as_deref(), Some("models/custom-ui.onnx"));
    }

    #[test]
    fn test_resolve_local_vision_model_path_for_worker_resolves_dev_artifact_reference() {
        let temp_dir = tempfile::tempdir().unwrap();
        let model_path = temp_dir
            .path()
            .join("artifacts")
            .join("local-vision")
            .join("yolo26n-ui.onnx");
        std::fs::create_dir_all(model_path.parent().unwrap()).unwrap();
        std::fs::write(&model_path, "model").unwrap();

        let resolved = resolve_local_vision_model_path_for_worker_with_candidates(
            Some("artifacts/local-vision/yolo26n-ui.onnx"),
            vec![model_path.clone()],
        );

        assert_eq!(resolved, Some(model_path.to_string_lossy().to_string()));
    }

    #[test]
    fn test_local_vision_worker_command_uses_node_for_mjs_workers() {
        if resolve_local_vision_node_executable().is_err() {
            return;
        }
        let command = local_vision_worker_command("scripts/local-vision-worker.mjs").unwrap();
        let program = command.get_program().to_string_lossy().to_ascii_lowercase();
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert!(program.contains("node"));
        assert_eq!(
            args.first().map(String::as_str),
            Some("scripts/local-vision-worker.mjs")
        );
    }

    #[test]
    fn test_local_vision_worker_command_runs_cmd_workers_directly() {
        let command = local_vision_worker_command("scripts/local-vision-worker.cmd").unwrap();
        assert_eq!(
            command.get_program().to_string_lossy(),
            "scripts/local-vision-worker.cmd"
        );
        assert_eq!(command.get_args().count(), 0);
    }

    #[test]
    fn test_local_vision_worker_command_reports_missing_node_for_mjs_workers() {
        let result = local_vision_worker_command_with_node_resolver(
            "scripts/local-vision-worker.mjs",
            || Err(local_vision_missing_node_error()),
        );

        let error = result.unwrap_err();
        assert!(error.contains("Node.js executable not found"));
        assert!(error.contains(LOCAL_VISION_NODE_PATH_ENV));
        assert!(error.contains("bundle a Node runtime"));
    }

    #[test]
    fn test_local_vision_cmd_worker_does_not_require_node_resolution() {
        let command = local_vision_worker_command_with_node_resolver(
            "scripts/local-vision-worker.cmd",
            || panic!("cmd workers should not resolve node"),
        )
        .unwrap();

        assert_eq!(
            command.get_program().to_string_lossy(),
            "scripts/local-vision-worker.cmd"
        );
    }

    #[test]
    fn test_resolve_local_vision_node_executable_prefers_env_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let node_path = temp_dir
            .path()
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(&node_path, "").unwrap();

        let resolved = resolve_local_vision_node_executable_from_env(node_path.to_str());

        assert_eq!(resolved, Ok(Some(node_path)));
    }

    #[test]
    fn test_resolve_local_vision_node_executable_rejects_invalid_env_without_fallback() {
        let bundled_node = PathBuf::from("bundled-node");
        let path_node = PathBuf::from("path-node");

        let resolved = resolve_local_vision_node_executable_with_resolvers(
            || resolve_local_vision_node_executable_from_env(Some("missing-node.exe")),
            || Some(bundled_node),
            || Some(path_node),
        );

        let error = resolved.unwrap_err();
        assert!(error.contains(LOCAL_VISION_NODE_PATH_ENV));
        assert!(error.contains("not a file"));
    }

    #[test]
    fn test_resolve_local_vision_node_executable_prefers_env_then_bundled_then_path() {
        let env_node = PathBuf::from("env-node");
        let bundled_node = PathBuf::from("bundled-node");
        let path_node = PathBuf::from("path-node");

        let resolved = resolve_local_vision_node_executable_with_resolvers(
            || Ok(Some(env_node.clone())),
            || Some(bundled_node.clone()),
            || Some(path_node.clone()),
        );
        assert_eq!(resolved, Ok(env_node));

        let resolved = resolve_local_vision_node_executable_with_resolvers(
            || Ok(None),
            || Some(bundled_node.clone()),
            || Some(path_node.clone()),
        );
        assert_eq!(resolved, Ok(bundled_node));

        let resolved = resolve_local_vision_node_executable_with_resolvers(
            || Ok(None),
            || None,
            || Some(path_node.clone()),
        );
        assert_eq!(resolved, Ok(path_node));
    }

    #[test]
    fn test_write_local_vision_worker_files_uses_image_path_not_data_url() {
        let mut request = sample_detect_ui_objects_request("shot-file");
        request.runtime_adapter_path = Some("adapters/mock-local-vision.mjs".to_string());
        request.reuse_worker = Some(true);
        request.iou_threshold = Some(0.33);
        request.label_map = Some(serde_json::json!({ "0": "button" }));
        let temp_files = write_local_vision_worker_files(&request).unwrap();
        let request_json = std::fs::read_to_string(&temp_files.request_path).unwrap();
        let worker_request: LocalVisionWorkerRequest = serde_json::from_str(&request_json).unwrap();

        assert!(temp_files.image_path.exists());
        assert_eq!(
            worker_request.image_path,
            temp_files.image_path.to_string_lossy()
        );
        assert_eq!(worker_request.screenshot_id, "shot-file");
        assert_eq!(worker_request.min_confidence, Some(0.75));
        assert_eq!(
            worker_request.runtime_adapter_path.as_deref(),
            Some("adapters/mock-local-vision.mjs")
        );
        assert_eq!(worker_request.iou_threshold, Some(0.33));
        assert_eq!(
            worker_request.label_map,
            Some(serde_json::json!({ "0": "button" }))
        );
        assert!(request_json.contains("\"imagePath\""));
        assert!(request_json.contains("\"minConfidence\""));
        assert!(request_json.contains("\"runtimeAdapterPath\""));
        assert!(!request_json.contains("\"reuseWorker\""));
        assert!(!request_json.contains("\"rawDetections\""));
        assert!(!request_json.contains("imageDataUrl"));
        assert!(!request_json.contains(TEST_PNG_DATA_URL));

        temp_files.cleanup();
    }

    #[test]
    fn test_write_local_vision_worker_files_rejects_oversized_request_json() {
        let mut request = sample_detect_ui_objects_request("shot-oversized-request");
        request.label_map = Some(serde_json::json!({
            "oversized": "x".repeat(LOCAL_VISION_MAX_WORKER_REQUEST_JSON_BYTES)
        }));

        match write_local_vision_worker_files(&request) {
            Ok(temp_files) => {
                temp_files.cleanup();
                panic!("oversized local vision request JSON should be rejected");
            }
            Err(error) => assert!(error.to_string().contains("request JSON exceeds")),
        }
    }

    #[test]
    fn test_write_data_url_png_file_rejects_oversized_image() {
        let temp_dir = tempfile::tempdir().unwrap();
        let image_path = temp_dir.path().join("oversized.png");
        let data_url = format!(
            "data:image/png;base64,{}",
            "A".repeat(LOCAL_VISION_MAX_IMAGE_BASE64_CHARS + 1)
        );

        let error = write_data_url_png_file(&data_url, &image_path).unwrap_err();

        assert!(error.to_string().contains("exceeds"));
        assert!(!image_path.exists());
    }

    #[test]
    fn test_local_vision_worker_temp_files_cleanup_on_drop() {
        let temp_files =
            write_local_vision_worker_files(&sample_detect_ui_objects_request("shot-drop"))
                .unwrap();
        let request_path = temp_files.request_path.clone();
        let image_path = temp_files.image_path.clone();

        assert!(request_path.exists());
        assert!(image_path.exists());

        drop(temp_files);

        assert!(!request_path.exists());
        assert!(!image_path.exists());
    }

    #[test]
    fn test_local_vision_empty_result_sanitizes_error() {
        let request = sample_detect_ui_objects_request("shot-empty-error");
        let result = local_vision_empty_result(
            &request,
            12,
            false,
            Some(format!(
                "worker stderr data:image/png;base64,EMPTY_ERROR_SHOULD_NOT_SURVIVE== {}",
                "x".repeat(400)
            )),
        );

        assert_eq!(result.screenshot_id, "shot-empty-error");
        assert!(result.detections.is_empty());
        let error = result.error.as_deref().unwrap_or_default();
        assert!(error.contains("worker stderr"));
        assert!(error.contains("[redacted:image data URL:"));
        assert!(!error.contains("EMPTY_ERROR_SHOULD_NOT_SURVIVE"));
    }

    #[test]
    fn test_bounded_pipe_reader_marks_truncated_output() {
        let receiver = spawn_bounded_pipe_reader(std::io::Cursor::new(vec![b'x'; 32]), 8);
        let output = collect_bounded_pipe_output(Some(receiver), "stdout").unwrap();

        assert_eq!(output.bytes.len(), 8);
        assert!(output.truncated);
    }

    #[test]
    fn test_parse_local_vision_worker_output_preserves_detection() {
        let request = sample_detect_ui_objects_request("shot-3");
        let stdout = br#"{
            "screenshotId": "shot-3",
            "detections": [{
                "id": "d1",
                "label": "possible_button",
                "confidence": 0.91,
                "box": {
                    "x": 10.0,
                    "y": 20.0,
                    "width": 30.0,
                    "height": 40.0,
                    "coordinateSpace": "screenshot",
                    "screenshotSize": { "width": 100, "height": 200 },
                    "devicePixelRatio": 1.0,
                    "monitorId": null,
                    "windowHandle": null
                },
                "center": {
                    "x": 25.0,
                    "y": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "source": "yolo26"
            }],
            "latencyMs": 0,
            "model": "",
            "runtime": "",
            "timedOut": false,
            "error": null
        }"#;

        let result = parse_local_vision_worker_output(stdout, &request, 42);

        assert_eq!(result.screenshot_id, "shot-3");
        assert_eq!(result.latency_ms, 42);
        assert_eq!(result.model, "yolo26n-ui.onnx");
        assert_eq!(result.runtime, "onnxruntime");
        assert_eq!(result.detections.len(), 1);
        assert_eq!(result.detections[0].id, "d1");
    }

    #[test]
    fn test_parse_local_vision_worker_output_clamps_detections() {
        let mut request = sample_detect_ui_objects_request("shot-clamp-detections");
        request.min_confidence = Some(-1.0);
        request.max_detections = Some(500);
        let mut detections = Vec::new();
        detections.push(serde_json::json!({
            "id": "weak",
            "label": "possible_button",
            "confidence": 0.1,
            "box": { "x": 1.0, "y": 1.0, "width": 2.0, "height": 2.0, "coordinateSpace": "screenshot" },
            "center": { "x": 2.0, "y": 2.0, "coordinateSpace": "screenshot" },
            "source": "yolo26"
        }));
        detections.push(serde_json::json!({
            "id": "bad-space",
            "label": "possible_button",
            "confidence": 0.99,
            "box": { "x": 1.0, "y": 1.0, "width": 2.0, "height": 2.0, "coordinateSpace": "screen" },
            "center": { "x": 2.0, "y": 2.0, "coordinateSpace": "screenshot" },
            "source": "yolo26"
        }));
        detections.push(serde_json::json!({
            "id": "bad-box",
            "label": "possible_button",
            "confidence": 0.99,
            "box": { "x": 1.0, "y": 1.0, "width": 0.0, "height": 2.0, "coordinateSpace": "screenshot" },
            "center": { "x": 2.0, "y": 2.0, "coordinateSpace": "screenshot" },
            "source": "yolo26"
        }));
        for index in 0..150 {
            detections.push(serde_json::json!({
                "id": format!("strong-{index:03}"),
                "label": "possible_button",
                "confidence": 0.9 - f64::from(index) * 0.001,
                "box": { "x": 1.0, "y": 1.0, "width": 2.0, "height": 2.0, "coordinateSpace": "screenshot" },
                "center": { "x": 2.0, "y": 2.0, "coordinateSpace": "screenshot" },
                "source": "yolo26"
            }));
        }
        let stdout = serde_json::to_vec(&serde_json::json!({
            "screenshotId": "shot-clamp-detections",
            "detections": detections,
            "latencyMs": 12,
            "model": "worker-model",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": null
        }))
        .unwrap();

        let result = parse_local_vision_worker_output(&stdout, &request, 12);

        assert_eq!(result.detections.len(), LOCAL_VISION_MAX_DETECTIONS);
        assert_eq!(result.detections[0].id, "strong-000");
        assert!(!result
            .detections
            .iter()
            .any(|detection| detection.id == "weak"));
        assert!(!result
            .detections
            .iter()
            .any(|detection| detection.id == "bad-space"));
        assert!(!result
            .detections
            .iter()
            .any(|detection| detection.id == "bad-box"));
    }

    #[test]
    fn test_local_vision_result_redacts_model_paths_to_filename() {
        let mut request = sample_detect_ui_objects_request("shot-model-redaction");
        request.model_path = Some(r"C:\Users\alice\models\yolo26n-ui.onnx".to_string());

        let missing_worker_result = detect_ui_objects_with_worker_path(&request, None).unwrap();
        assert_eq!(missing_worker_result.model, "yolo26n-ui.onnx");
        assert!(!missing_worker_result.model.contains("alice"));
        assert!(!missing_worker_result.model.contains(r"C:\Users"));

        let empty_result =
            local_vision_empty_result(&request, 7, false, Some("worker failed".to_string()));
        assert_eq!(empty_result.model, "yolo26n-ui.onnx");
        assert!(!empty_result.model.contains("alice"));
        assert!(!empty_result.model.contains(r"C:\Users"));
    }

    #[test]
    fn test_parse_local_vision_worker_output_rejects_oversized_stdout() {
        let request = sample_detect_ui_objects_request("shot-oversized-stdout");
        let stdout = vec![b' '; LOCAL_VISION_MAX_WORKER_STDOUT_BYTES + 1];

        let result = parse_local_vision_worker_output(&stdout, &request, 12);

        assert!(result.detections.is_empty());
        assert!(result.error.unwrap().contains("stdout exceeded"));
    }

    #[test]
    fn test_parse_local_vision_worker_output_sanitizes_diagnostics() {
        let request = sample_detect_ui_objects_request("shot-diagnostics");
        let stdout = serde_json::to_vec(&serde_json::json!({
            "screenshotId": "shot-diagnostics",
            "detections": [],
            "latencyMs": 8,
            "model": "worker-model",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": null,
            "diagnostics": {
                "rawPreview": "data:image/png;base64,DIAGNOSTIC_SHOULD_NOT_SURVIVE==",
                "longMessage": "x".repeat(200),
                "nested": {
                    "values": ["data:image/png;base64,NESTED_SHOULD_NOT_SURVIVE=="]
                }
            }
        }))
        .unwrap();

        let result = parse_local_vision_worker_output(&stdout, &request, 8);
        let diagnostics = result.diagnostics.unwrap();

        assert_eq!(
            diagnostics["rawPreview"],
            serde_json::Value::String("[redacted image data]".to_string())
        );
        assert!(diagnostics["longMessage"]
            .as_str()
            .is_some_and(|value| value.len() <= LOCAL_VISION_DIAGNOSTICS_MAX_STRING_CHARS));
        assert_eq!(
            diagnostics["nested"]["values"][0],
            serde_json::Value::String("[redacted image data]".to_string())
        );
        assert!(!diagnostics.to_string().contains("data:image"));
    }

    #[test]
    fn test_parse_local_vision_worker_output_warns_for_official_coco_model() {
        let request = sample_detect_ui_objects_request("shot-coco-model");
        let stdout = serde_json::to_vec(&serde_json::json!({
            "screenshotId": "shot-coco-model",
            "detections": [],
            "latencyMs": 8,
            "model": "models/yolo26n.onnx",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": null,
            "diagnostics": {
                "warnings": ["existing sanitized warning"]
            }
        }))
        .unwrap();

        let result = parse_local_vision_worker_output(&stdout, &request, 8);
        let diagnostics = result.diagnostics.unwrap();
        let warnings = diagnostics["warnings"].as_array().unwrap();

        assert_eq!(result.model, "yolo26n.onnx");
        assert!(warnings.iter().any(|warning| warning
            .as_str()
            .is_some_and(|warning| warning == "existing sanitized warning")));
        assert!(warnings.iter().any(|warning| warning
            .as_str()
            .is_some_and(|warning| warning.contains("smoke/benchmark only"))));
    }

    #[test]
    fn test_parse_local_vision_worker_output_does_not_warn_for_ui_model_name() {
        let request = sample_detect_ui_objects_request("shot-ui-model");
        let stdout = serde_json::to_vec(&serde_json::json!({
            "screenshotId": "shot-ui-model",
            "detections": [],
            "latencyMs": 8,
            "model": "models/yolo26n-ui.onnx",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": null
        }))
        .unwrap();

        let result = parse_local_vision_worker_output(&stdout, &request, 8);

        assert_eq!(result.model, "yolo26n-ui.onnx");
        assert!(result.diagnostics.is_none());
    }

    #[test]
    fn test_parse_local_vision_worker_output_drops_timed_out_detections() {
        let request = sample_detect_ui_objects_request("shot-timeout");
        let stdout = br#"{
            "screenshotId": "shot-timeout",
            "detections": [{
                "id": "late",
                "label": "possible_button",
                "confidence": 0.99,
                "box": {
                    "x": 10.0,
                    "y": 20.0,
                    "width": 30.0,
                    "height": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "center": {
                    "x": 25.0,
                    "y": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "source": "yolo26"
            }],
            "latencyMs": 130,
            "model": "worker-model",
            "runtime": "onnxruntime",
            "timedOut": true,
            "error": "worker exceeded timeout"
        }"#;

        let result = parse_local_vision_worker_output(stdout, &request, 130);

        assert_eq!(result.screenshot_id, "shot-timeout");
        assert!(result.timed_out);
        assert!(result.detections.is_empty());
        assert_eq!(result.model, "worker-model");
        assert_eq!(result.runtime, "onnxruntime");
        assert!(result.error.unwrap().contains("worker exceeded timeout"));
    }

    #[test]
    fn test_parse_local_vision_worker_output_drops_error_detections() {
        let request = sample_detect_ui_objects_request("shot-error");
        let stdout = br#"{
            "screenshotId": "shot-error",
            "detections": [{
                "id": "partial",
                "label": "possible_button",
                "confidence": 0.99,
                "box": {
                    "x": 10.0,
                    "y": 20.0,
                    "width": 30.0,
                    "height": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "center": {
                    "x": 25.0,
                    "y": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "source": "yolo26"
            }],
            "latencyMs": 44,
            "model": "worker-model",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": "adapter failed after partial output"
        }"#;

        let result = parse_local_vision_worker_output(stdout, &request, 44);

        assert_eq!(result.screenshot_id, "shot-error");
        assert!(!result.timed_out);
        assert!(result.detections.is_empty());
        assert!(result.error.unwrap().contains("adapter failed"));
    }

    #[test]
    fn test_parse_local_vision_worker_output_sanitizes_error() {
        let request = sample_detect_ui_objects_request("shot-error-redaction");
        let stdout = serde_json::to_vec(&serde_json::json!({
            "screenshotId": "shot-error-redaction",
            "detections": [{
                "id": "partial",
                "label": "possible_button",
                "confidence": 0.99,
                "box": {
                    "x": 10.0,
                    "y": 20.0,
                    "width": 30.0,
                    "height": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "center": {
                    "x": 25.0,
                    "y": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "source": "yolo26"
            }],
            "latencyMs": 44,
            "model": "worker-model",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": "runtime failed data:image/png;base64,ERROR_SHOULD_NOT_SURVIVE=="
        }))
        .unwrap();

        let result = parse_local_vision_worker_output(&stdout, &request, 44);

        assert!(result.detections.is_empty());
        let error = result.error.as_deref().unwrap_or_default();
        assert!(error.contains("runtime failed"));
        assert!(error.contains("[redacted:image data URL:"));
        assert!(!error.contains("ERROR_SHOULD_NOT_SURVIVE"));
    }

    #[test]
    fn test_parse_local_vision_worker_output_redacts_error_and_diagnostic_paths() {
        let request = sample_detect_ui_objects_request("shot-path-redaction");
        let stdout = serde_json::to_vec(&serde_json::json!({
            "screenshotId": "shot-path-redaction",
            "detections": [],
            "latencyMs": 44,
            "model": "worker-model",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": r"adapter failed at C:\Users\alice\My Models\runtime adapter.mjs kept message",
            "diagnostics": {
                "adapterPath": r"C:\Users\alice\My Models\runtime adapter.mjs",
                "cachePath": "/home/alice/.cache/javis/model cache.bin"
            }
        }))
        .unwrap();

        let result = parse_local_vision_worker_output(&stdout, &request, 44);
        let serialized = serde_json::to_string(&result).unwrap();

        assert!(serialized.contains("[redacted local path:runtime adapter.mjs]"));
        assert!(serialized.contains("[redacted local path:model cache.bin]"));
        assert!(serialized.contains("kept message"));
        assert!(!serialized.contains("alice"));
        assert!(!serialized.contains(r"C:\Users"));
        assert!(!serialized.contains("My Models"));
        assert!(!serialized.contains("/home/alice"));
    }

    #[test]
    fn test_parse_local_vision_worker_output_sanitizes_detection_text() {
        let request = sample_detect_ui_objects_request("shot-detection-redaction");
        let stdout = serde_json::to_vec(&serde_json::json!({
            "screenshotId": "shot-detection-redaction",
            "detections": [{
                "id": r"det_data:image/png;base64,ID_SHOULD_NOT_SURVIVE==_C:\Users\alice\My Models\detector cache.bin",
                "label": r"button data:image/png;base64,LABEL_SHOULD_NOT_SURVIVE== C:\Users\alice\My Models\button label.txt",
                "confidence": 0.99,
                "box": {
                    "x": 10.0,
                    "y": 20.0,
                    "width": 30.0,
                    "height": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "center": {
                    "x": 25.0,
                    "y": 40.0,
                    "coordinateSpace": "screenshot"
                },
                "source": "yolo26"
            }],
            "latencyMs": 44,
            "model": "worker-model",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": null
        }))
        .unwrap();

        let result = parse_local_vision_worker_output(&stdout, &request, 44);
        let serialized = serde_json::to_string(&result).unwrap();

        assert_eq!(result.detections.len(), 1);
        assert!(serialized.contains("[redacted local path:detector cache.bin]"));
        assert!(serialized.contains("[redacted local path:button label.txt]"));
        assert!(!serialized.contains("data:image"));
        assert!(!serialized.contains("SHOULD_NOT_SURVIVE"));
        assert!(!serialized.contains("My Models"));
    }

    #[test]
    fn test_parse_local_vision_worker_output_sanitizes_model_and_runtime() {
        let request = sample_detect_ui_objects_request("shot-model-redaction");
        let stdout = serde_json::to_vec(&serde_json::json!({
            "screenshotId": "shot-model-redaction",
            "detections": [],
            "latencyMs": 11,
            "model": "data:image/png;base64,MODEL_SHOULD_NOT_SURVIVE==",
            "runtime": "custom-runtime-that-should-not-survive",
            "timedOut": false,
            "error": null
        }))
        .unwrap();

        let result = parse_local_vision_worker_output(&stdout, &request, 11);

        assert_eq!(result.model, "[redacted image data]");
        assert_eq!(result.runtime, "unknown");
    }

    #[test]
    fn test_parse_local_vision_worker_output_discards_stale_screenshot() {
        let request = sample_detect_ui_objects_request("shot-current");
        let stdout = br#"{
            "screenshotId": "shot-old",
            "detections": [],
            "latencyMs": 10,
            "model": "worker-model",
            "runtime": "onnxruntime",
            "timedOut": false,
            "error": null,
            "diagnostics": {
                "rawPreview": "data:image/png;base64,STALE_SHOULD_NOT_SURVIVE=="
            }
        }"#;

        let result = parse_local_vision_worker_output(stdout, &request, 15);

        assert_eq!(result.screenshot_id, "shot-current");
        assert!(result.detections.is_empty());
        assert!(result.error.unwrap().contains("stale screenshot id"));
        assert_eq!(
            result.diagnostics.unwrap()["rawPreview"],
            serde_json::Value::String("[redacted image data]".to_string())
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_run_local_vision_worker_parses_stdout_json() {
        let temp_dir = tempfile::tempdir().unwrap();
        let worker_path = temp_dir.path().join("local-vision-worker.cmd");
        std::fs::write(
            &worker_path,
            concat!(
                "@echo off\r\n",
                "if not exist \"%~1\" exit /b 3\r\n",
                "echo {\"screenshotId\":\"shot-worker\",\"detections\":[],\"latencyMs\":7,\"model\":\"worker-model\",\"runtime\":\"onnxruntime\",\"timedOut\":false,\"error\":null}\r\n"
            ),
        )
        .unwrap();

        let mut request = sample_detect_ui_objects_request("shot-worker");
        request.timeout_ms = Some(LOCAL_VISION_MAX_TIMEOUT_MS);

        let result = run_local_vision_worker(&request, worker_path.to_str().unwrap()).unwrap();

        assert_eq!(result.screenshot_id, "shot-worker");
        assert!(!result.timed_out);
        assert_eq!(result.latency_ms, 7);
        assert_eq!(result.model, "worker-model");
        assert_eq!(result.runtime, "onnxruntime");
        assert!(result.detections.is_empty());
        assert!(result.error.is_none());
        let diagnostics = result.diagnostics.unwrap();
        assert_eq!(diagnostics["desktopWorkerMode"], "single_shot");
        assert_eq!(diagnostics["desktopWorkerReused"], false);
    }

    #[cfg(windows)]
    #[test]
    fn test_run_local_vision_worker_rejects_large_stdout_without_pipe_blocking() {
        let temp_dir = tempfile::tempdir().unwrap();
        let worker_path = temp_dir.path().join("local-vision-large-stdout.cmd");
        std::fs::write(
            &worker_path,
            concat!(
                "@echo off\r\n",
                "if not exist \"%~1\" exit /b 3\r\n",
                "powershell -NoProfile -Command \"$s = 'x' * 1200000; [Console]::Out.Write($s)\"\r\n"
            ),
        )
        .unwrap();

        let mut request = sample_detect_ui_objects_request("shot-large-stdout");
        request.timeout_ms = Some(LOCAL_VISION_MAX_TIMEOUT_MS);

        let result = run_local_vision_worker(&request, worker_path.to_str().unwrap()).unwrap();

        assert_eq!(result.screenshot_id, "shot-large-stdout");
        assert!(!result.timed_out);
        assert!(result.detections.is_empty());
        assert!(result.error.unwrap().contains("stdout exceeded"));
    }

    #[cfg(windows)]
    #[test]
    fn test_run_local_vision_worker_times_out_without_stdin_reader() {
        let temp_dir = tempfile::tempdir().unwrap();
        let worker_path = temp_dir.path().join("local-vision-sleep-worker.cmd");
        std::fs::write(
            &worker_path,
            concat!(
                "@echo off\r\n",
                "if not exist \"%~1\" exit /b 3\r\n",
                "ping 127.0.0.1 -n 3 > nul\r\n",
                "echo {\"screenshotId\":\"shot-timeout\",\"detections\":[],\"latencyMs\":1,\"model\":\"worker-model\",\"runtime\":\"onnxruntime\",\"timedOut\":false,\"error\":null}\r\n"
            ),
        )
        .unwrap();
        let mut request = sample_detect_ui_objects_request("shot-timeout");
        request.timeout_ms = Some(20);

        let result = run_local_vision_worker(&request, worker_path.to_str().unwrap()).unwrap();

        assert_eq!(result.screenshot_id, "shot-timeout");
        assert!(result.timed_out);
        assert!(result.error.unwrap().contains("timed out"));
    }

    #[cfg(windows)]
    #[test]
    fn test_run_local_vision_worker_clamps_tiny_timeout() {
        let temp_dir = tempfile::tempdir().unwrap();
        let worker_path = temp_dir.path().join("local-vision-sleep-worker.cmd");
        std::fs::write(
            &worker_path,
            concat!(
                "@echo off\r\n",
                "if not exist \"%~1\" exit /b 3\r\n",
                "ping 127.0.0.1 -n 3 > nul\r\n",
                "echo {\"screenshotId\":\"shot-timeout-clamp\",\"detections\":[],\"latencyMs\":1,\"model\":\"worker-model\",\"runtime\":\"onnxruntime\",\"timedOut\":false,\"error\":null}\r\n"
            ),
        )
        .unwrap();
        let mut request = sample_detect_ui_objects_request("shot-timeout-clamp");
        request.timeout_ms = Some(1);

        let result = run_local_vision_worker(&request, worker_path.to_str().unwrap()).unwrap();

        assert_eq!(result.screenshot_id, "shot-timeout-clamp");
        assert!(result.timed_out);
        assert!(result.error.unwrap().contains("timed out after 20ms"));
    }

    #[test]
    fn test_run_local_vision_reusable_worker_reuses_server_process() {
        let _test_guard = REUSABLE_WORKER_TEST_LOCK.lock().unwrap();
        clear_reusable_local_vision_worker_for_test();
        if resolve_local_vision_node_executable().is_err() {
            eprintln!(
                "skipping reusable local vision worker test because Node.js is not available"
            );
            return;
        }
        let temp_dir = tempfile::tempdir().unwrap();
        let worker_path = temp_dir.path().join("local-vision-worker.mjs");
        std::fs::write(
            &worker_path,
            r#"
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
let count = 0;
async function handle(path) {
  count += 1;
  const request = JSON.parse(await readFile(path, "utf8"));
  process.stdout.write(JSON.stringify({
    screenshotId: request.screenshotId,
    detections: [],
    latencyMs: count,
    model: "worker-model",
    runtime: "onnxruntime",
    timedOut: false,
    diagnostics: { count }
  }) + "\n");
}
if (process.argv[2] !== "--server") process.exit(3);
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const path = line.trim();
  if (path) await handle(path);
}
"#,
        )
        .unwrap();
        let mut first = sample_detect_ui_objects_request("shot-reuse-1");
        first.timeout_ms = Some(LOCAL_VISION_MAX_TIMEOUT_MS);
        let first_files = write_local_vision_worker_files(&first).unwrap();
        let first_result = run_local_vision_reusable_worker_with_request_path(
            &first,
            worker_path.to_str().unwrap(),
            &first_files.request_path,
            LOCAL_VISION_MAX_TIMEOUT_MS,
            Instant::now(),
        );
        first_files.cleanup();

        let mut second = sample_detect_ui_objects_request("shot-reuse-2");
        second.timeout_ms = Some(LOCAL_VISION_MAX_TIMEOUT_MS);
        let second_files = write_local_vision_worker_files(&second).unwrap();
        let second_result = run_local_vision_reusable_worker_with_request_path(
            &second,
            worker_path.to_str().unwrap(),
            &second_files.request_path,
            LOCAL_VISION_MAX_TIMEOUT_MS,
            Instant::now(),
        );
        second_files.cleanup();

        assert_eq!(first_result.screenshot_id, "shot-reuse-1");
        assert_eq!(second_result.screenshot_id, "shot-reuse-2");
        assert_eq!(first_result.latency_ms, 1);
        assert_eq!(second_result.latency_ms, 2);
        let first_diagnostics = first_result.diagnostics.unwrap();
        let second_diagnostics = second_result.diagnostics.unwrap();
        assert_eq!(first_diagnostics["count"], 1);
        assert_eq!(first_diagnostics["desktopWorkerMode"], "reusable");
        assert_eq!(first_diagnostics["desktopWorkerReused"], false);
        assert_eq!(second_diagnostics["count"], 2);
        assert_eq!(second_diagnostics["desktopWorkerMode"], "reusable");
        assert_eq!(second_diagnostics["desktopWorkerReused"], true);

        clear_reusable_local_vision_worker_for_test();
    }

    #[test]
    fn test_run_local_vision_reusable_worker_times_out_without_hanging() {
        let _test_guard = REUSABLE_WORKER_TEST_LOCK.lock().unwrap();
        clear_reusable_local_vision_worker_for_test();
        if resolve_local_vision_node_executable().is_err() {
            eprintln!("skipping reusable local vision worker timeout test because Node.js is not available");
            return;
        }
        let temp_dir = tempfile::tempdir().unwrap();
        let worker_path = temp_dir.path().join("local-vision-timeout-worker.mjs");
        std::fs::write(
            &worker_path,
            r#"
import { createInterface } from "node:readline";
if (process.argv[2] !== "--server") process.exit(3);
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim()) await new Promise(() => {});
}
"#,
        )
        .unwrap();
        let request = sample_detect_ui_objects_request("shot-reuse-timeout");
        let files = write_local_vision_worker_files(&request).unwrap();

        let result = run_local_vision_reusable_worker_with_request_path(
            &request,
            worker_path.to_str().unwrap(),
            &files.request_path,
            20,
            Instant::now(),
        );
        files.cleanup();

        assert_eq!(result.screenshot_id, "shot-reuse-timeout");
        assert!(result.timed_out);
        assert!(result.error.unwrap().contains("timed out after 20ms"));

        if let Ok(guard) = LOCAL_VISION_REUSABLE_WORKER.lock() {
            assert!(guard.is_none());
        }
    }

    fn clear_reusable_local_vision_worker_for_test() {
        if let Ok(mut guard) = LOCAL_VISION_REUSABLE_WORKER.lock() {
            if let Some(mut worker) = guard.take() {
                worker.stop();
            }
        }
    }

    #[test]
    fn test_vk_scan_char_supports_ascii_punctuation() {
        assert!(vk_scan_char('.').is_some());
        assert!(vk_scan_char('@').is_some());
        assert!(vk_scan_char('-').is_some());
        assert!(vk_scan_char(' ').is_some());
    }

    #[test]
    fn test_uia_control_type_names_are_stable_english() {
        assert_eq!(uia::control_type_name(50000), "Button");
        assert_eq!(uia::control_type_name(50004), "Edit");
        assert_eq!(uia::control_type_name(50032), "Window");
        assert_eq!(uia::control_type_name(59999), "Control");
    }

    #[test]
    fn test_hash_action_params_deterministic() {
        let params = serde_json::json!({"x": 100, "y": 200});
        let h1 = hash_action_params("computer.click", &params);
        let h2 = hash_action_params("computer.click", &params);
        assert_eq!(h1, h2);
        assert!(!h1.is_empty());
    }

    #[test]
    fn test_hash_action_params_different_for_different_tools() {
        let params = serde_json::json!({"x": 100, "y": 200});
        let h1 = hash_action_params("computer.click", &params);
        let h2 = hash_action_params("computer.moveMouse", &params);
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_timestamp_secs_to_iso_uses_real_calendar() {
        assert_eq!(timestamp_secs_to_iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(timestamp_secs_to_iso(1_704_067_199), "2023-12-31T23:59:59Z");
        assert_eq!(timestamp_secs_to_iso(1_704_067_200), "2024-01-01T00:00:00Z");
        assert_eq!(timestamp_secs_to_iso(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn test_validate_task_id() {
        assert!(validate_task_id("task-1704067200000").is_ok());
        assert!(validate_task_id("task:desktop_1.2").is_ok());
        assert!(validate_task_id("").is_err());
        assert!(validate_task_id("../task").is_err());
    }

    #[test]
    fn test_validate_approval_id() {
        assert!(validate_approval_id("approval-1704067200000").is_ok());
        assert!(validate_approval_id("approval:desktop_1.2").is_ok());
        assert!(validate_approval_id("").is_err());
        assert!(validate_approval_id("../approval").is_err());
    }

    #[test]
    fn test_normalized_approval_hash_matches_execute_hash_shape() {
        let raw_params = serde_json::json!({
            "x": 100,
            "y": 200,
            "button": "left",
            "clickCount": 1,
            "ignoredExtra": true
        });
        let normalized = normalize_computer_params("computer.click", &raw_params).unwrap();
        let execute_request = ComputerClickRequest {
            x: 100,
            y: 200,
            button: Some("left".to_string()),
            click_count: Some(1),
        };
        let execute_params = serde_json::to_value(&execute_request).unwrap();

        assert_eq!(normalized, execute_params);
        assert_eq!(
            hash_action_params("computer.click", &normalized),
            hash_action_params("computer.click", &execute_params)
        );
    }

    #[test]
    fn test_computer_write_rate_limit_blocks_fast_repeats() {
        let state = ComputerApprovalState {
            pending: HashMap::new(),
            leases: HashMap::new(),
            last_write_at: Some(SystemTime::now()),
        };
        assert!(validate_computer_write_rate_limit(&state).is_err());

        let state = ComputerApprovalState {
            pending: HashMap::new(),
            leases: HashMap::new(),
            last_write_at: Some(
                SystemTime::now() - COMPUTER_WRITE_MIN_INTERVAL - Duration::from_millis(1),
            ),
        };
        assert!(validate_computer_write_rate_limit(&state).is_ok());
    }

    #[test]
    fn test_session_wide_computer_approval_creates_task_lease() {
        let state = Mutex::new(ComputerApprovalState::default());
        let result = computer_approve_action_inner(
            &state,
            "approval-1".to_string(),
            "task-1".to_string(),
            "computer.click".to_string(),
            serde_json::json!({
                "x": 100,
                "y": 200,
                "button": "left",
                "clickCount": 1
            })
            .to_string(),
            Some(true),
            None,
        );

        assert!(result.is_ok());
        let guard = state.lock().unwrap();
        assert!(guard.pending.is_empty());
        assert_eq!(guard.leases.len(), 1);
        let lease = guard.leases.get("task-1").unwrap();
        assert_eq!(lease.remaining_actions, COMPUTER_LEASE_MAX_ACTIONS);
        assert!(lease
            .scope
            .allowed_tools
            .contains(&"computer.click".to_string()));
        assert!(lease
            .scope
            .allowed_tools
            .contains(&"computer.moveMouse".to_string()));
        assert!(lease
            .scope
            .allowed_tools
            .contains(&"computer.scroll".to_string()));
        assert!(!lease
            .scope
            .allowed_tools
            .contains(&"computer.invokeUi".to_string()));
        assert!(!lease
            .scope
            .allowed_tools
            .contains(&"computer.focusWindow".to_string()));
        assert!(!lease
            .scope
            .allowed_tools
            .contains(&"computer.type".to_string()));
    }

    #[test]
    fn test_reusable_computer_approval_rejects_unknown_window_scope() {
        let scope = ComputerApprovalScope {
            window_handle: None,
            window_title: None,
            allowed_tools: pointer_computer_lease_tools(),
        };

        let result = validate_reusable_computer_approval_scope(&scope);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("known target window"));
    }

    #[test]
    fn test_non_sensitive_invoke_ui_can_use_task_lease_policy() {
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "saveButton",
                "name": "Save"
            }
        });

        assert!(reusable_computer_lease_tools_for("computer.invokeUi")
            .contains(&"computer.invokeUi".to_string()));
        assert!(!requires_per_action_computer_approval(
            "computer.invokeUi",
            &params
        ));
    }

    #[test]
    fn test_non_sensitive_set_ui_value_can_use_task_lease_policy() {
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "firstNameInput",
                "name": "First name"
            },
            "value": "Alice"
        });

        assert!(reusable_computer_lease_tools_for("computer.setUiValue")
            .contains(&"computer.setUiValue".to_string()));
        assert!(!requires_per_action_computer_approval(
            "computer.setUiValue",
            &params
        ));
    }

    #[test]
    fn test_sensitive_set_ui_value_selector_still_requires_per_action_policy() {
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "passwordInput",
                "name": "Password"
            },
            "value": "not-a-secret-looking-demo"
        });

        assert!(requires_per_action_computer_approval(
            "computer.setUiValue",
            &params
        ));
    }

    #[test]
    fn test_camel_case_secret_selectors_still_require_per_action_policy() {
        let set_value_params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "apiKeyInput",
                "name": "API key"
            },
            "value": "demo"
        });
        let invoke_params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "privateKeyRevealButton",
                "name": "Reveal"
            }
        });

        assert!(requires_per_action_computer_approval(
            "computer.setUiValue",
            &set_value_params
        ));
        assert!(requires_per_action_computer_approval(
            "computer.invokeUi",
            &invoke_params
        ));
    }

    #[test]
    fn test_sensitive_set_ui_value_value_still_requires_per_action_policy() {
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "notesInput",
                "name": "Notes"
            },
            "value": "api_key=demo"
        });

        assert!(requires_per_action_computer_approval(
            "computer.setUiValue",
            &params
        ));
    }

    #[test]
    fn test_camel_case_secret_values_still_require_per_action_policy() {
        let api_key_params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "notesInput",
                "name": "Notes"
            },
            "value": "apiKey=demo"
        });
        let card_params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "notesInput",
                "name": "Notes"
            },
            "value": "creditCardNumber=4111111111111111"
        });

        assert!(requires_per_action_computer_approval(
            "computer.setUiValue",
            &api_key_params
        ));
        assert!(requires_per_action_computer_approval(
            "computer.setUiValue",
            &card_params
        ));
    }

    #[test]
    fn test_sensitive_invoke_ui_still_requires_per_action_policy() {
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "passwordButton",
                "name": "Reveal password"
            }
        });

        assert!(requires_per_action_computer_approval(
            "computer.invokeUi",
            &params
        ));
    }

    #[test]
    fn test_high_risk_invoke_ui_still_requires_per_action_policy() {
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "deleteButton",
                "name": "Delete permanently"
            }
        });

        assert!(requires_per_action_computer_approval(
            "computer.invokeUi",
            &params
        ));
    }

    #[test]
    fn test_chinese_high_risk_invoke_ui_still_requires_per_action_policy() {
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "submitButton",
                "name": "提交订单"
            }
        });

        assert!(requires_per_action_computer_approval(
            "computer.invokeUi",
            &params
        ));
    }

    #[test]
    fn test_task_lease_rejects_cross_window_action() {
        let lease = ComputerApprovalLease {
            task_id: "task-1".to_string(),
            approval_id: "approval-1".to_string(),
            created_at: SystemTime::now(),
            remaining_actions: 1,
            scope: ComputerApprovalScope {
                window_handle: Some(42),
                window_title: None,
                allowed_tools: reusable_computer_lease_tools_for("computer.focusWindow"),
            },
        };
        let params = serde_json::json!({ "handle": 99 });

        let result = validate_computer_lease_scope(&lease, "computer.focusWindow", &params);
        assert!(result.is_err());
    }

    #[test]
    fn test_task_lease_rejects_unscoped_text_entry() {
        let lease = ComputerApprovalLease {
            task_id: "task-1".to_string(),
            approval_id: "approval-1".to_string(),
            created_at: SystemTime::now(),
            remaining_actions: 1,
            scope: ComputerApprovalScope {
                window_handle: None,
                window_title: None,
                allowed_tools: pointer_computer_lease_tools(),
            },
        };
        let params = serde_json::json!({ "text": "hello" });

        let result = validate_computer_lease_scope(&lease, "computer.type", &params);
        assert!(result.is_err());
    }

    #[test]
    fn test_click_task_lease_rejects_invoke_ui_tool_escalation() {
        let lease = ComputerApprovalLease {
            task_id: "task-1".to_string(),
            approval_id: "approval-1".to_string(),
            created_at: SystemTime::now(),
            remaining_actions: 1,
            scope: ComputerApprovalScope {
                window_handle: Some(42),
                window_title: None,
                allowed_tools: reusable_computer_lease_tools_for("computer.click"),
            },
        };
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "safeButton",
                "name": "Safe"
            }
        });

        let result = validate_computer_lease_scope(&lease, "computer.invokeUi", &params);

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("does not allow"));
    }

    #[test]
    fn test_invoke_ui_task_lease_rejects_pointer_tool_escalation() {
        let lease = ComputerApprovalLease {
            task_id: "task-1".to_string(),
            approval_id: "approval-1".to_string(),
            created_at: SystemTime::now(),
            remaining_actions: 1,
            scope: ComputerApprovalScope {
                window_handle: Some(42),
                window_title: None,
                allowed_tools: reusable_computer_lease_tools_for("computer.invokeUi"),
            },
        };
        let params = serde_json::json!({ "x": 100, "y": 200 });

        let result = validate_computer_lease_scope(&lease, "computer.click", &params);

        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("does not allow"));
    }

    #[test]
    fn test_remove_matching_computer_lease_only_removes_same_approval() {
        let state = Mutex::new(ComputerApprovalState::default());
        {
            let mut guard = state.lock().unwrap();
            guard.leases.insert(
                "task-1".to_string(),
                ComputerApprovalLease {
                    task_id: "task-1".to_string(),
                    approval_id: "approval-1".to_string(),
                    created_at: SystemTime::now(),
                    remaining_actions: 3,
                    scope: ComputerApprovalScope {
                        window_handle: Some(42),
                        window_title: None,
                        allowed_tools: reusable_computer_lease_tools_for("computer.click"),
                    },
                },
            );
            guard.leases.insert(
                "task-2".to_string(),
                ComputerApprovalLease {
                    task_id: "task-2".to_string(),
                    approval_id: "approval-2".to_string(),
                    created_at: SystemTime::now(),
                    remaining_actions: 3,
                    scope: ComputerApprovalScope {
                        window_handle: Some(99),
                        window_title: None,
                        allowed_tools: reusable_computer_lease_tools_for("computer.click"),
                    },
                },
            );
        }

        assert!(!remove_matching_computer_lease(
            &state,
            "task-1",
            "approval-other"
        ));
        assert!(state.lock().unwrap().leases.contains_key("task-1"));

        assert!(remove_matching_computer_lease(
            &state,
            "task-1",
            "approval-1"
        ));
        let guard = state.lock().unwrap();
        assert!(!guard.leases.contains_key("task-1"));
        assert!(guard.leases.contains_key("task-2"));
    }

    #[test]
    fn test_task_lease_rejects_sensitive_set_ui_value_reuse() {
        let mut lease = ComputerApprovalLease {
            task_id: "task-1".to_string(),
            approval_id: "approval-1".to_string(),
            created_at: SystemTime::now(),
            remaining_actions: 1,
            scope: ComputerApprovalScope {
                window_handle: Some(42),
                window_title: None,
                allowed_tools: reusable_computer_lease_tools_for("computer.setUiValue"),
            },
        };
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "notesInput",
                "name": "Notes"
            },
            "value": "api_key=demo"
        });

        let result = validate_computer_task_lease_for_action(
            &mut lease,
            "approval-1",
            "task-1",
            "computer.setUiValue",
            &params,
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("fresh per-action approval"));
        assert_eq!(lease.remaining_actions, 1);
    }

    #[test]
    fn test_task_lease_rejects_camel_case_secret_selector_reuse() {
        let mut lease = ComputerApprovalLease {
            task_id: "task-1".to_string(),
            approval_id: "approval-1".to_string(),
            created_at: SystemTime::now(),
            remaining_actions: 1,
            scope: ComputerApprovalScope {
                window_handle: Some(42),
                window_title: None,
                allowed_tools: reusable_computer_lease_tools_for("computer.setUiValue"),
            },
        };
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "apiKeyInput",
                "name": "API key"
            },
            "value": "demo"
        });

        let result = validate_computer_task_lease_for_action(
            &mut lease,
            "approval-1",
            "task-1",
            "computer.setUiValue",
            &params,
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("fresh per-action approval"));
        assert_eq!(lease.remaining_actions, 1);
    }

    #[test]
    fn test_task_lease_rejects_sensitive_invoke_ui_reuse() {
        let mut lease = ComputerApprovalLease {
            task_id: "task-1".to_string(),
            approval_id: "approval-1".to_string(),
            created_at: SystemTime::now(),
            remaining_actions: 1,
            scope: ComputerApprovalScope {
                window_handle: Some(42),
                window_title: None,
                allowed_tools: reusable_computer_lease_tools_for("computer.invokeUi"),
            },
        };
        let params = serde_json::json!({
            "selector": {
                "windowHandle": 42,
                "automationId": "submitButton",
                "name": "提交订单"
            }
        });

        let result = validate_computer_task_lease_for_action(
            &mut lease,
            "approval-1",
            "task-1",
            "computer.invokeUi",
            &params,
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("fresh per-action approval"));
        assert_eq!(lease.remaining_actions, 1);
    }

    #[test]
    fn test_session_wide_computer_approval_rejects_sensitive_action() {
        let state = Mutex::new(ComputerApprovalState::default());
        let result = computer_approve_action_inner(
            &state,
            "approval-1".to_string(),
            "task-1".to_string(),
            "computer.type".to_string(),
            serde_json::json!({ "text": "hello" }).to_string(),
            Some(true),
            None,
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("per-action approval"));
        let guard = state.lock().unwrap();
        assert!(guard.pending.is_empty());
        assert!(guard.leases.is_empty());
    }

    #[test]
    fn test_fresh_sensitive_approval_clears_existing_task_lease() {
        let state = Mutex::new(ComputerApprovalState::default());
        computer_approve_action_inner(
            &state,
            "approval-1".to_string(),
            "task-1".to_string(),
            "computer.click".to_string(),
            serde_json::json!({
                "x": 100,
                "y": 200,
                "button": "left",
                "clickCount": 1
            })
            .to_string(),
            Some(true),
            None,
        )
        .unwrap();

        computer_approve_action_inner(
            &state,
            "approval-2".to_string(),
            "task-1".to_string(),
            "computer.type".to_string(),
            serde_json::json!({ "text": "hello" }).to_string(),
            Some(false),
            None,
        )
        .unwrap();

        let guard = state.lock().unwrap();
        assert!(!guard.leases.contains_key("task-1"));
        assert!(guard.pending.contains_key("approval-2"));
    }

    #[test]
    fn test_single_action_approval_clears_existing_task_lease() {
        let state = Mutex::new(ComputerApprovalState::default());
        computer_approve_action_inner(
            &state,
            "approval-1".to_string(),
            "task-1".to_string(),
            "computer.click".to_string(),
            serde_json::json!({
                "x": 100,
                "y": 200,
                "button": "left",
                "clickCount": 1
            })
            .to_string(),
            Some(true),
            None,
        )
        .unwrap();

        computer_approve_action_inner(
            &state,
            "approval-2".to_string(),
            "task-1".to_string(),
            "computer.click".to_string(),
            serde_json::json!({
                "x": 120,
                "y": 220,
                "button": "left",
                "clickCount": 1
            })
            .to_string(),
            Some(false),
            None,
        )
        .unwrap();

        let guard = state.lock().unwrap();
        assert!(!guard.leases.contains_key("task-1"));
        assert!(guard.pending.contains_key("approval-2"));
    }

    #[test]
    fn test_pending_approvals_are_keyed_by_approval_id() {
        let state = Mutex::new(ComputerApprovalState::default());
        for approval_id in ["approval-1", "approval-2"] {
            computer_approve_action_inner(
                &state,
                approval_id.to_string(),
                "task-1".to_string(),
                "computer.click".to_string(),
                serde_json::json!({ "x": 100, "y": 200, "button": "left", "clickCount": 1 })
                    .to_string(),
                Some(false),
                None,
            )
            .unwrap();
        }

        let guard = state.lock().unwrap();
        assert!(guard.pending.contains_key("approval-1"));
        assert!(guard.pending.contains_key("approval-2"));
    }

    #[test]
    fn test_cancel_computer_approvals_for_task() {
        let state = Mutex::new(ComputerApprovalState::default());
        computer_approve_action_inner(
            &state,
            "approval-1".to_string(),
            "task-1".to_string(),
            "computer.click".to_string(),
            serde_json::json!({ "x": 100, "y": 200, "button": "left", "clickCount": 1 })
                .to_string(),
            Some(false),
            None,
        )
        .unwrap();
        computer_approve_action_inner(
            &state,
            "approval-2".to_string(),
            "task-2".to_string(),
            "computer.click".to_string(),
            serde_json::json!({ "x": 120, "y": 220, "button": "left", "clickCount": 1 })
                .to_string(),
            Some(false),
            None,
        )
        .unwrap();

        computer_cancel_approvals_inner(&state, Some("task-1".to_string())).unwrap();

        let guard = state.lock().unwrap();
        assert!(!guard.pending.contains_key("approval-1"));
        assert!(guard.pending.contains_key("approval-2"));
    }

    #[test]
    fn test_pending_approval_allows_fresh_binding() {
        let pending = PendingComputerApproval {
            binding: crate::create_native_approval_binding(
                "approval-1".to_string(),
                "computer.click",
                "task-1".to_string(),
                "hash-1".to_string(),
                true,
            ),
            created_at: SystemTime::now(),
        };

        assert!(validate_pending_computer_approval(&pending).is_ok());
    }

    #[test]
    fn test_pending_approval_expires_after_ttl() {
        let pending = PendingComputerApproval {
            binding: crate::create_native_approval_binding(
                "approval-1".to_string(),
                "computer.click",
                "task-1".to_string(),
                "hash-1".to_string(),
                true,
            ),
            created_at: SystemTime::now() - COMPUTER_APPROVAL_TTL - Duration::from_secs(1),
        };

        assert!(validate_pending_computer_approval(&pending).is_err());
    }

    #[test]
    fn test_wait_clamped() {
        let result = wait(&ComputerWaitRequest { ms: 0 }).unwrap();
        assert_eq!(result.waited, 0);

        let result = wait(&ComputerWaitRequest { ms: 5000 }).unwrap();
        assert_eq!(result.waited, 5000);
    }
}
