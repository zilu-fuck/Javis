use crate::error::JavisError;
use crate::{require_native_approval_binding, NativeApprovalBinding};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
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
    pub captured_at: String,
    pub method_used: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerListWindowsRequest {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerListWindowsResult {
    pub windows: Vec<WindowInfo>,
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
    let age = lease.created_at.elapsed().map_err(|_| {
        JavisError::Permission("Computer Use lease timestamp is invalid.".into())
    })?;
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
        ): (
            HDC,
            i32,
            i32,
            i32,
            i32,
            i32,
            i32,
            Box<dyn Fn()>,
        ) = if let Some(wh) =
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

fn encode_rgba_png_data_url(
    width: u32,
    height: u32,
    pixels: Vec<u8>,
) -> Result<(String, u32, u32), JavisError> {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
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
        let mut lines = Vec::new();
        let mut count = 0u16;
        write_tree(
            &walker, &root, 0, max_depth, max_nodes, &mut count, &mut lines,
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
        count: &mut u16,
        lines: &mut Vec<String>,
    ) -> Result<(), JavisError> {
        if *count >= max_nodes {
            return Ok(());
        }
        let node = read_node(element)?;
        lines.push(format!(
            "{}<{} name=\"{}\" automationId=\"{}\">",
            "  ".repeat(depth as usize),
            node.control_type,
            escape_ui_text(&node.name),
            escape_ui_text(&node.automation_id),
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
                count,
                lines,
            )?;
            if *count >= max_nodes {
                break;
            }
        }
        Ok(())
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
pub(crate) fn computer_screenshot(
    request: ComputerScreenshotRequest,
) -> Result<ComputerScreenshotResult, String> {
    capture_screenshot(&request).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn computer_list_windows(
    request: ComputerListWindowsRequest,
) -> Result<ComputerListWindowsResult, String> {
    let _ = request;
    list_windows().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn computer_wait(request: ComputerWaitRequest) -> Result<ComputerWaitResult, String> {
    wait(&request).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn computer_inspect_ui(
    request: ComputerInspectUiRequest,
) -> Result<ComputerInspectUiResult, String> {
    uia::inspect_ui(&request).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn computer_approve_action(
    state: tauri::State<'_, Mutex<ComputerApprovalState>>,
    approval_id: String,
    task_id: String,
    tool_name: String,
    params_json: String,
    #[allow(unused_variables)] session_wide: Option<bool>,
) -> Result<(), String> {
    computer_approve_action_inner(
        state.inner(),
        approval_id,
        task_id,
        tool_name,
        params_json,
        session_wide,
    )
}

fn computer_approve_action_inner(
    state: &Mutex<ComputerApprovalState>,
    approval_id: String,
    task_id: String,
    tool_name: String,
    params_json: String,
    session_wide: Option<bool>,
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
                "This Computer Use action requires per-action approval because it can enter text, press keys, or modify control values."
                    .to_string(),
            );
        }
        guard.leases.insert(
            task_id.clone(),
            ComputerApprovalLease {
                task_id,
                approval_id,
                created_at: SystemTime::now(),
                remaining_actions: COMPUTER_LEASE_MAX_ACTIONS,
            },
        );
        return Ok(());
    }

    // Per-action approval — normalized params → hash → one-shot binding
    let pending_key = approval_id.clone();
    let binding = crate::create_native_approval_binding(
        approval_id,
        &tool_name,
        task_id,
        preview_hash,
        true, // approved
    );

    guard.pending.insert(pending_key, PendingComputerApproval {
        binding,
        created_at: SystemTime::now(),
    });
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
        pub(crate) fn $fn_name(
            state: tauri::State<'_, Mutex<ComputerApprovalState>>,
            approval_id: String,
            task_id: String,
            request: $request_type,
        ) -> Result<$result_type, String> {
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
                validate_computer_approval_lease(lease).map_err(|e| e.to_string())?;
                if lease.approval_id != approval_id || lease.task_id != task_id {
                    return Err(
                        "Computer Use task approval does not match this action.".to_string(),
                    );
                }
                if requires_per_action_computer_approval(&tool_name, &params_json) {
                    return Err(
                        "This Computer Use action requires a fresh per-action approval.".to_string(),
                    );
                }
                lease.remaining_actions = lease.remaining_actions.saturating_sub(1);
            } else {
                return Err(
                    "No pending computer approval - call computer_approve_action first."
                        .to_string(),
                );
            }
            guard.last_write_at = Some(SystemTime::now());
            drop(guard);

            // Execute
            ($execute_fn)(&request).map_err(|e: JavisError| e.to_string())
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
        "computer.type" | "computer.keyCombo" | "computer.setUiValue" => true,
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
        if lower.contains("password")
            || lower.contains("token")
            || lower.contains("secret")
            || lower.contains("credential")
            || lower.contains("密码")
            || lower.contains("令牌")
            || lower.contains("密钥")
        {
            return true;
        }
    }
    false
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
        );

        assert!(result.is_ok());
        let guard = state.lock().unwrap();
        assert!(guard.pending.is_empty());
        assert_eq!(guard.leases.len(), 1);
        assert_eq!(guard.leases.get("task-1").unwrap().remaining_actions, COMPUTER_LEASE_MAX_ACTIONS);
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
        );

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("per-action approval"));
        let guard = state.lock().unwrap();
        assert!(guard.pending.is_empty());
        assert!(guard.leases.is_empty());
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
                serde_json::json!({ "x": 100, "y": 200, "button": "left", "clickCount": 1 }).to_string(),
                Some(false),
            )
            .unwrap();
        }

        let guard = state.lock().unwrap();
        assert!(guard.pending.contains_key("approval-1"));
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
