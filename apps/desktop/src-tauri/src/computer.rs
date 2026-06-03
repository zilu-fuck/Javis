use crate::error::JavisError;
use crate::{require_native_approval_binding, NativeApprovalBinding};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

// ── Request / Result types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenshotRequest {
    pub window_handle: Option<u64>,
    pub region: Option<ScreenRegion>,
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
    pub captured_at: String,
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

// ── Approval state (follows code.rs pattern) ────────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct ComputerApprovalState {
    pub(crate) pending: Option<PendingComputerApproval>,
}

#[derive(Debug)]
pub(crate) struct PendingComputerApproval {
    pub(crate) binding: NativeApprovalBinding,
}

// ── Safety guards ───────────────────────────────────────────────────────────

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

fn window_title(hwnd: HWND) -> String {
    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32) };
    String::from_utf16_lossy(&title_buf[..title_len as usize])
}

fn validate_window_handle_title(handle: u64) -> Result<(), JavisError> {
    let hwnd = handle as HWND;
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return Err(JavisError::Validation(format!("Invalid window handle: {handle}")));
    }
    validate_window_title(&window_title(hwnd))
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
    let hwnd = unsafe { WindowFromPoint(POINT { x, y }) };
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
            && denied
                .iter()
                .all(|key| normalized.iter().any(|candidate| candidate.as_str() == *key))
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
    if x < 0 || y < 0 {
        return Err(JavisError::Validation(format!(
            "Coordinates ({x}, {y}) must be non-negative"
        )));
    }
    unsafe {
        let sw = GetSystemMetrics(SM_CXSCREEN);
        let sh = GetSystemMetrics(SM_CYSCREEN);
        if x >= sw || y >= sh {
            return Err(JavisError::Validation(format!(
                "Coordinates ({x}, {y}) exceed screen size ({sw}, {sh})"
            )));
        }
    }
    Ok(())
}

fn hash_action_params(tool: &str, params: &serde_json::Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tool.as_bytes());
    hasher.update(
        serde_json::to_string(params)
            .unwrap_or_default()
            .as_bytes(),
    );
    format!("{:x}", hasher.finalize())
}

fn current_timestamp_iso() -> String {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| {
            let secs = d.as_secs();
            let days = secs / 86400;
            let y = 1970 + days / 365;
            let m = (days % 365) / 30 + 1;
            let day = (days % 365) % 30 + 1;
            format!("{y:04}-{m:02}-{day:02}T00:00:00Z")
        })
        .unwrap_or_default()
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
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

    unsafe {
        let null_hwnd: HWND = std::ptr::null_mut();
        let (hdc_src, width, height, release_fn): (HDC, i32, i32, Box<dyn Fn()>) =
            if let Some(wh) = request.window_handle {
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
                (hdc, w, h, Box::new(move || { ReleaseDC(hwnd, hdc); }))
            } else {
                let hdc = GetDC(null_hwnd);
                if hdc.is_null() {
                    return Err(JavisError::Internal("GetDC(0) failed".to_string()));
                }
                let sw = GetSystemMetrics(SM_CXSCREEN);
                let sh = GetSystemMetrics(SM_CYSCREEN);
                (hdc, sw, sh, Box::new(move || { ReleaseDC(null_hwnd, hdc); }))
            };

        if width <= 0 || height <= 0 {
            release_fn();
            return Err(JavisError::Validation(format!(
                "Capture bounds must be positive, got ({width}, {height})"
            )));
        }

        let (crop_x, crop_y, crop_w, crop_h) = if let Some(ref r) = request.region {
            if r.width <= 0 || r.height <= 0 {
                release_fn();
                return Err(JavisError::Validation(
                    "Screenshot region width and height must be positive".to_string(),
                ));
            }
            if r.x >= width || r.y >= height {
                release_fn();
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
                release_fn();
                return Err(JavisError::Validation(
                    "Screenshot region does not overlap the capture bounds".to_string(),
                ));
            }
            (cx, cy, cw, ch)
        } else {
            (0, 0, width, height)
        };

        let mem_dc = CreateCompatibleDC(hdc_src);
        if mem_dc.is_null() {
            release_fn();
            return Err(JavisError::Internal("CreateCompatibleDC failed".to_string()));
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

        BitBlt(
            mem_dc,
            0,
            0,
            crop_w,
            crop_h,
            hdc_src,
            crop_x,
            crop_y,
            SRCCOPY,
        );

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

        GetDIBits(
            mem_dc,
            hbmp,
            0,
            crop_h as u32,
            pixels.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // BGRA → RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        // Cleanup GDI
        SelectObject(mem_dc, old_bmp);
        DeleteObject(hbmp as HGDIOBJ);
        DeleteDC(mem_dc);
        release_fn();

        // Encode to PNG
        let img = image::RgbaImage::from_raw(crop_w as u32, crop_h as u32, pixels)
            .ok_or_else(|| JavisError::Internal("Failed to create RgbaImage".to_string()))?;
        let mut png_buf: Vec<u8> = Vec::new();
        image::ImageEncoder::write_image(
            image::codecs::png::PngEncoder::new(&mut png_buf),
            img.as_raw(),
            crop_w as u32,
            crop_h as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| JavisError::Internal(format!("PNG encode error: {e}")))?;

        let b64 = BASE64.encode(&png_buf);
        let data_url = format!("data:image/png;base64,{b64}");

        Ok(ComputerScreenshotResult {
            data_url,
            width: crop_w as u32,
            height: crop_h as u32,
            captured_at: current_timestamp_iso(),
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

        let mut class_buf = [0u16; 256];
        let class_len =
            GetClassNameW(hwnd, class_buf.as_mut_ptr(), class_buf.len() as i32);
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

    // Get title for validation
    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32) };
    let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);

    validate_window_title(&title)?;

    unsafe {
        SetForegroundWindow(hwnd);
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
        unsafe {
            SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    Ok(ComputerClickResult {
        x: request.x,
        y: request.y,
        clicked: true,
    })
}

/// Type text via keyboard simulation.
pub(crate) fn type_text(
    request: &ComputerTypeRequest,
) -> Result<ComputerTypeResult, JavisError> {
    let delay = Duration::from_millis(request.delay_ms.unwrap_or(50));
    let text_len = request.text.chars().count();

    // Clear before if requested
    if request.clear_before.unwrap_or(false) {
        // Ctrl+A
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
    if ch.is_ascii() && ch.is_alphanumeric() {
        // Simple ASCII — use VkKeyScanW
        let vk = unsafe { VkKeyScanW(ch as u16) };
        if vk == -1 {
            return Err(JavisError::Internal(format!("VkKeyScanW failed for '{ch}'")));
        }
        let vk_code = (vk & 0xFF) as u16;
        let shift_needed = (vk >> 8) & 1 != 0;

        if shift_needed {
            press_key(VK_SHIFT)?;
        }
        press_key(vk_code)?;
        release_key(vk_code)?;
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
            unsafe {
                SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                );
            }
        }
    }
    Ok(())
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
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
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
    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }
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

    // Press all keys in order
    for &vk in &vks {
        press_key(vk)?;
        std::thread::sleep(Duration::from_millis(10));
    }
    // Release in reverse order
    for &vk in vks.iter().rev() {
        release_key(vk)?;
        std::thread::sleep(Duration::from_millis(10));
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

    unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        );
    }

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
pub(crate) fn computer_approve_action(
    state: tauri::State<'_, Mutex<ComputerApprovalState>>,
    approval_id: String,
    task_id: String,
    tool_name: String,
    params_json: String,
) -> Result<(), String> {
    let params: serde_json::Value =
        serde_json::from_str(&params_json).map_err(|e| format!("Invalid params JSON: {e}"))?;
    validate_computer_action_params(&tool_name, &params).map_err(|e| e.to_string())?;
    let preview_hash = hash_action_params(&tool_name, &params);

    let binding = crate::create_native_approval_binding(
        approval_id,
        &tool_name,
        task_id,
        preview_hash,
        true, // approved
    );

    let mut guard = state.lock().map_err(|e| format!("Lock error: {e}"))?;
    guard.pending = Some(PendingComputerApproval { binding });
    Ok(())
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
            // Run domain-specific validation
            ($validate_fn)(&request).map_err(|e: JavisError| e.to_string())?;

            // Compute preview hash
            let tool_name = format!("computer.{}", $tool_suffix);
            let params_json = serde_json::to_value(&request).unwrap_or_default();
            let preview_hash = hash_action_params(&tool_name, &params_json);

            // Validate approval
            let mut guard = state.lock().map_err(|e| format!("Lock error: {e}"))?;
            let pending = guard
                .pending
                .take()
                .ok_or("No pending computer approval")?;
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
            drop(guard);

            // Execute
            ($execute_fn)(&request).map_err(|e: JavisError| e.to_string())
        }
    };
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
        assert_eq!(key_to_vk("unknown_key"), None);
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
    fn test_wait_clamped() {
        let result = wait(&ComputerWaitRequest { ms: 0 }).unwrap();
        assert_eq!(result.waited, 0);

        let result = wait(&ComputerWaitRequest { ms: 5000 }).unwrap();
        assert_eq!(result.waited, 5000);
    }
}
