use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter};

use crate::database;

#[cfg(target_os = "windows")]
use std::{
    ffi::{c_void, OsStr},
    os::windows::ffi::OsStrExt,
    ptr::null_mut,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    },
    UI::{
        Controls::ILD_TRANSPARENT,
        Shell::{
            SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
            SHGFI_SYSICONINDEX, SHIL_EXTRALARGE, SHIL_JUMBO,
        },
        WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
    },
};

// ── Sidebar scanning infrastructure ──────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) modified_at: Option<String>,
    pub(crate) extension: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) icon_path: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) install_location: Option<String>,
}

pub(crate) const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "__pycache__",
    ".venv",
    "AppData",
    "$RECYCLE.BIN",
    "System Volume Information",
    ".cache",
    ".cargo",
    ".rustup",
    "Code",
    "scoop",
    "choco",
    // Windows system directories
    "Windows",
    "Program Files",
    "Program Files (x86)",
    "ProgramData",
    "Recovery",
    "Boot",
    "EFI",
    "PerfLogs",
    // Package manager / tool caches
    ".npm",
    ".yarn",
    ".pnpm-store",
    ".nuget",
    ".gradle",
    ".m2",
    // Build output directories
    "dist",
    "build",
    ".turbo",
    ".next",
    ".nuxt",
    "out",
    // Editor / IDE state
    ".vscode",
    ".idea",
    ".ssh",
    ".conda",
    // Vendor noise at root
    "Intel",
    "AMD",
    "NVIDIA",
    "MSOCache",
    "Temp",
    "tmp",
];

// Only Intel/AMD/NVIDIA directories directly under a drive root (e.g. C:\Intel)
// are vendor driver noise. A project folder named "Intel" at a deeper path is
// kept.
pub(crate) fn is_root_level_vendor_skip(dir_name: &str, parent: &Path) -> bool {
    let vendor_dirs = ["Intel", "AMD", "NVIDIA"];
    if !vendor_dirs.contains(&dir_name) {
        return false;
    }
    // A filesystem root has no parent, or its parent equals itself.
    parent.parent().is_none() || parent.parent() == Some(parent)
}

pub(crate) fn chrono_datetime_from_secs(secs: u64) -> String {
    // Simple ISO-like timestamp without external crate dependency
    let days_since_epoch = secs / 86400;
    let remaining_secs = secs % 86400;
    let hours = remaining_secs / 3600;
    let minutes = (remaining_secs % 3600) / 60;
    let seconds = remaining_secs % 60;

    // Compute year/month/day from days since epoch (1970-01-01)
    let mut year = 1970i64;
    let mut remaining_days = days_since_epoch as i64;
    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        year += 1;
    }
    let is_leap = is_leap_year(year);
    let days_in_month = [
        31,
        if is_leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    for &dim in &days_in_month {
        if remaining_days < dim as i64 {
            break;
        }
        remaining_days -= dim as i64;
        month += 1;
    }
    let day = remaining_days as u32 + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

pub(crate) fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

pub(crate) fn collect_files(
    roots: &[PathBuf],
    extensions: &[&str],
    max_results: usize,
    recursive: bool,
) -> Result<Vec<FileEntry>, String> {
    collect_files_with_depth(roots, extensions, max_results, recursive, usize::MAX)
}

pub(crate) fn collect_files_with_depth(
    roots: &[PathBuf],
    extensions: &[&str],
    max_results: usize,
    recursive: bool,
    max_depth: usize,
) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    let ext_lower: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();

    for root in roots {
        if !root.exists() || !root.is_dir() {
            continue;
        }
        collect_files_inner(
            root,
            &ext_lower,
            max_results,
            recursive,
            max_depth,
            0,
            &mut entries,
        );
        if entries.len() >= max_results {
            break;
        }
    }

    entries.sort_by(|a, b| {
        b.modified_at
            .as_deref()
            .unwrap_or("")
            .cmp(a.modified_at.as_deref().unwrap_or(""))
    });
    entries.truncate(max_results);
    Ok(entries)
}

fn collect_files_inner(
    dir: &Path,
    extensions: &[String],
    max_results: usize,
    recursive: bool,
    max_depth: usize,
    depth: usize,
    entries: &mut Vec<FileEntry>,
) {
    if entries.len() >= max_results {
        return;
    }
    if depth >= max_depth {
        return;
    }
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    let skip_lower: Vec<String> = SKIP_DIRS.iter().map(|d| d.to_lowercase()).collect();
    for entry in read_dir {
        if entries.len() >= max_results {
            return;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            let name_lower = file_name.to_lowercase();
            if recursive
                && !skip_lower.contains(&name_lower)
                && !is_root_level_vendor_skip(&file_name, dir)
            {
                collect_files_inner(
                    &path,
                    extensions,
                    max_results,
                    recursive,
                    max_depth,
                    depth + 1,
                    entries,
                );
            }
            continue;
        }

        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        if !extensions.is_empty() && !extensions.contains(&ext) {
            continue;
        }

        let metadata = fs::metadata(&path).ok();
        let size_bytes = metadata.as_ref().map(|m| m.len());
        let modified_at = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| chrono_datetime_from_secs(d.as_secs()));

        entries.push(FileEntry {
            name: file_name,
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            size_bytes,
            modified_at,
            extension: Some(ext),
        });
    }
}

pub(crate) fn user_home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\Users\\Default"))
}

#[tauri::command]
pub(crate) fn get_user_home() -> Result<String, String> {
    Ok(user_home().to_string_lossy().to_string())
}

// ── Resource file scan ───────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanResourceFilesRequest {
    kind: String,
    roots: Vec<ScanResourceRootInput>,
    extensions: Vec<String>,
    max_results_per_root: Option<usize>,
    scan_id: Option<String>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanResourceRootInput {
    id: String,
    path: String,
    source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceFileEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) modified_at: Option<String>,
    pub(crate) extension: Option<String>,
    pub(crate) source: String,
    pub(crate) source_root_id: String,
    pub(crate) source_root_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResourceProgressPayload {
    scan_id: String,
    current: usize,
    total: usize,
    current_root_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResourceDonePayload {
    scan_id: String,
    kind: String,
    entries: Vec<ResourceFileEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResourceErrorPayload {
    scan_id: String,
    error: String,
}

#[tauri::command]
pub(crate) fn scan_resource_files(
    app_handle: AppHandle,
    request: ScanResourceFilesRequest,
) -> Result<String, String> {
    if request.roots.is_empty() {
        return Err("At least one scan root is required.".to_string());
    }
    let (scan_id, cancelled) = register_scan(request.scan_id);
    let scan_id_clone = scan_id.clone();
    let kind = request.kind.clone();
    let app = app_handle.clone();
    let roots = resolve_scan_resource_roots(&app_handle, &request.roots)?;
    let extensions: Vec<String> = request
        .extensions
        .iter()
        .map(|e| e.to_lowercase())
        .collect();
    let filter_by_ext = !extensions.is_empty();
    let per_root_max = request
        .max_results_per_root
        .unwrap_or(100)
        .max(10)
        .min(1000);

    thread::spawn(move || {
        let result = execute_resource_scan(
            &roots,
            &extensions,
            filter_by_ext,
            per_root_max,
            &cancelled,
            &app,
            &scan_id_clone,
        );
        unregister_scan(&scan_id_clone);
        match result {
            Ok(entries) => {
                let _ = app.emit(
                    "scan-resource-files-done",
                    ScanResourceDonePayload {
                        scan_id: scan_id_clone,
                        kind,
                        entries,
                    },
                );
            }
            Err(error) => {
                let _ = app.emit(
                    "scan-resource-files-error",
                    ScanResourceErrorPayload {
                        scan_id: scan_id_clone,
                        error,
                    },
                );
            }
        }
    });

    Ok(scan_id)
}

fn resolve_scan_resource_roots(
    app: &AppHandle,
    requested_roots: &[ScanResourceRootInput],
) -> Result<Vec<ScanResourceRootInput>, String> {
    let ids = requested_roots
        .iter()
        .map(|root| root.id.clone())
        .collect::<Vec<_>>();
    let records = database::resource_scan_roots_for_ids(app, &ids)?;
    let mut resolved = Vec::new();
    for (requested, record) in requested_roots.iter().zip(records.into_iter()) {
        if !record.enabled {
            return Err(format!("Resource scan root is disabled: {}", record.id));
        }
        if !requested.path.trim().is_empty()
            && normalize_root_path_for_match(&requested.path) != normalize_root_path_for_match(&record.path)
        {
            return Err(format!(
                "Resource scan root path does not match registered root id: {}",
                record.id
            ));
        }
        if !requested.source.trim().is_empty()
            && requested.source.trim().eq_ignore_ascii_case(&record.source) == false
        {
            return Err(format!(
                "Resource scan root source does not match registered root id: {}",
                record.id
            ));
        }
        resolved.push(ScanResourceRootInput {
            id: record.id,
            path: record.path,
            source: record.source,
        });
    }
    Ok(resolved)
}

fn normalize_root_path_for_match(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn execute_resource_scan(
    roots: &[ScanResourceRootInput],
    extensions: &[String],
    filter_by_ext: bool,
    per_root_max: usize,
    cancelled: &AtomicBool,
    app: &AppHandle,
    scan_id: &str,
) -> Result<Vec<ResourceFileEntry>, String> {
    let mut all_entries: Vec<ResourceFileEntry> = Vec::new();
    let total_roots = roots.len();
    let skip_lower: Vec<String> = SKIP_DIRS.iter().map(|d| d.to_lowercase()).collect();

    for (_root_index, root) in roots.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let root_path = PathBuf::from(&root.path);
        let canonical = root_path
            .canonicalize()
            .unwrap_or_else(|_| root_path.clone());
        if !canonical.exists() || !canonical.is_dir() {
            continue;
        }

        let mut root_entries: Vec<ResourceFileEntry> = Vec::new();
        collect_resource_files(
            &canonical,
            extensions,
            filter_by_ext,
            per_root_max,
            0,
            &mut root_entries,
            cancelled,
            &root.source,
            &root.id,
            &canonical.to_string_lossy(),
            &skip_lower,
        );

        let _root_total = root_entries.len().min(per_root_max);
        all_entries.extend(root_entries);

        let global_current = all_entries.len();
        let global_total = per_root_max * total_roots;
        let _ = app.emit(
            "scan-resource-files-progress",
            ScanResourceProgressPayload {
                scan_id: scan_id.to_string(),
                current: global_current.min(global_total),
                total: global_total.max(1),
                current_root_id: root.id.clone(),
            },
        );
    }

    all_entries.sort_by(|a, b| {
        b.modified_at
            .as_deref()
            .unwrap_or("")
            .cmp(a.modified_at.as_deref().unwrap_or(""))
    });
    Ok(all_entries)
}

fn collect_resource_files(
    dir: &Path,
    extensions: &[String],
    filter_by_ext: bool,
    max_results: usize,
    depth: usize,
    entries: &mut Vec<ResourceFileEntry>,
    cancelled: &AtomicBool,
    source: &str,
    source_root_id: &str,
    source_root_path: &str,
    skip_lower: &[String],
) {
    if entries.len() >= max_results || depth >= 8 {
        return;
    }
    if cancelled.load(Ordering::Relaxed) {
        return;
    }
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in read_dir {
        if entries.len() >= max_results {
            return;
        }
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            let name_lower = file_name.to_lowercase();
            if !skip_lower.contains(&name_lower) && !is_root_level_vendor_skip(&file_name, dir) {
                collect_resource_files(
                    &path,
                    extensions,
                    filter_by_ext,
                    max_results,
                    depth + 1,
                    entries,
                    cancelled,
                    source,
                    source_root_id,
                    source_root_path,
                    skip_lower,
                );
            }
            continue;
        }

        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        if filter_by_ext && !extensions.contains(&ext) {
            continue;
        }

        let metadata = fs::metadata(&path).ok();
        let size_bytes = metadata.as_ref().map(|m| m.len());
        let modified_at = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| chrono_datetime_from_secs(d.as_secs()));

        entries.push(ResourceFileEntry {
            name: file_name,
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            size_bytes,
            modified_at,
            extension: Some(ext),
            source: source.to_string(),
            source_root_id: source_root_id.to_string(),
            source_root_path: source_root_path.to_string(),
        });
    }
}

// ── Mount roots ──────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MountRoot {
    pub(crate) name: String,
    pub(crate) path: String,
}

#[tauri::command]
pub(crate) fn list_mount_roots() -> Result<Vec<MountRoot>, String> {
    mount_roots()
}

pub(crate) fn mount_roots() -> Result<Vec<MountRoot>, String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDriveStringsW};

        const DRIVE_REMOVABLE: u32 = 2;
        const DRIVE_NO_ROOT_DIR: u32 = 1;
        const DRIVE_REMOTE: u32 = 4;

        let mut roots = Vec::new();
        let mut buf: Vec<u16> = vec![0u16; 256];
        let len = unsafe { GetLogicalDriveStringsW(buf.len() as u32, buf.as_mut_ptr()) };
        if len == 0 || len as usize > buf.len() {
            return Ok(fallback_windows_mount_roots());
        }

        let mut i = 0;
        while i < len as usize && buf[i] != 0 {
            let drive_wide: Vec<u16> = buf[i..].iter().copied().take_while(|&c| c != 0).collect();
            if drive_wide.is_empty() {
                i += 1;
                continue;
            }
            let drive_str = String::from_utf16_lossy(&drive_wide)
                .trim_end_matches('\\')
                .to_string();
            i += drive_wide.len() + 1;

            let drive_type = unsafe { GetDriveTypeW(drive_wide.as_ptr()) };
            if drive_type == DRIVE_REMOVABLE
                || drive_type == DRIVE_NO_ROOT_DIR
                || drive_type == DRIVE_REMOTE
            {
                continue;
            }

            let path = format!("{}\\", drive_str);
            let name = drive_str.clone();
            roots.push(MountRoot { name, path });
        }

        if roots.is_empty() {
            roots = fallback_windows_mount_roots();
        }

        Ok(roots)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec![MountRoot {
            name: "/".to_string(),
            path: "/".to_string(),
        }])
    }
}

// ── All-user-file scan ───────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn fallback_windows_mount_roots() -> Vec<MountRoot> {
    std::env::current_dir()
        .ok()
        .and_then(|path| {
            let text = path.to_string_lossy();
            let mut chars = text.chars();
            let drive = chars.next()?;
            if chars.next()? != ':' {
                return None;
            }
            let name = format!("{drive}:");
            Some(MountRoot {
                name: name.clone(),
                path: format!("{name}\\"),
            })
        })
        .into_iter()
        .collect()
}

static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);

struct ActiveScan {
    scan_id: String,
    cancelled: Arc<AtomicBool>,
}

static ACTIVE_SCANS: Mutex<Vec<ActiveScan>> = Mutex::new(Vec::new());

fn register_scan(scan_id: Option<String>) -> (String, Arc<AtomicBool>) {
    let scan_id = scan_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("scan-{}", NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed)));
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut scans = ACTIVE_SCANS.lock().unwrap();
    scans.retain(|s| !s.cancelled.load(Ordering::Relaxed));
    scans.push(ActiveScan {
        scan_id: scan_id.clone(),
        cancelled: cancelled.clone(),
    });
    (scan_id, cancelled)
}

fn unregister_scan(scan_id: &str) {
    let mut scans = ACTIVE_SCANS.lock().unwrap();
    scans.retain(|s| s.scan_id != scan_id);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressPayload {
    scan_id: String,
    current: usize,
    total: usize,
}

fn emit_scan_progress(
    app: &AppHandle,
    event_name: &str,
    scan_id: Option<&str>,
    current: usize,
    total: usize,
) {
    if let Some(scan_id) = scan_id {
        let _ = app.emit(
            event_name,
            ScanProgressPayload {
                scan_id: scan_id.to_string(),
                current,
                total,
            },
        );
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanDonePayload {
    scan_id: String,
    entries: Vec<FileEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanErrorPayload {
    scan_id: String,
    error: String,
}

#[tauri::command]
pub(crate) fn scan_all_user_files(
    app_handle: AppHandle,
    extensions: Option<Vec<String>>,
    max_results: Option<usize>,
    scan_id: Option<String>,
) -> Result<String, String> {
    let (scan_id, cancelled) = register_scan(scan_id);
    let scan_id_clone = scan_id.clone();
    let app = app_handle.clone();

    // Resolve scan parameters on the calling thread before spawning.
    let roots = mount_roots()?
        .into_iter()
        .map(|r| PathBuf::from(r.path))
        .collect::<Vec<_>>();
    let ext_vec: Vec<String> = extensions.unwrap_or_default();
    let ext_lower: Vec<String> = ext_vec.iter().map(|e| e.to_lowercase()).collect();
    let filter_by_ext = !ext_lower.is_empty();
    let max = max_results.unwrap_or(5000);
    let max_depth = 8;

    thread::spawn(move || {
        let result = execute_scan(
            &roots,
            &ext_lower,
            filter_by_ext,
            max,
            max_depth,
            &cancelled,
            &app,
            &scan_id_clone,
        );
        unregister_scan(&scan_id_clone);
        match result {
            Ok(entries) => {
                let _ = app.emit(
                    "scan-all-files-done",
                    ScanDonePayload {
                        scan_id: scan_id_clone,
                        entries,
                    },
                );
            }
            Err(error) => {
                let _ = app.emit(
                    "scan-all-files-error",
                    ScanErrorPayload {
                        scan_id: scan_id_clone,
                        error,
                    },
                );
            }
        }
    });

    Ok(scan_id)
}

pub(crate) fn execute_scan(
    roots: &[PathBuf],
    ext_lower: &[String],
    filter_by_ext: bool,
    max: usize,
    max_depth: usize,
    cancelled: &AtomicBool,
    app: &AppHandle,
    scan_id: &str,
) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    let total = count_matching_files(roots, ext_lower, filter_by_ext, max, max_depth, cancelled);
    let total = total.max(1);
    let mut current = 0usize;

    for root in roots {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        if !root.exists() || !root.is_dir() {
            continue;
        }
        collect_files_inner_for_scan(
            root,
            ext_lower,
            filter_by_ext,
            max,
            max_depth,
            0,
            &mut entries,
            cancelled,
            Some(app),
            Some(scan_id),
            total,
            &mut current,
        );
        if entries.len() >= max {
            break;
        }
    }

    entries.sort_by(|a, b| {
        b.modified_at
            .as_deref()
            .unwrap_or("")
            .cmp(a.modified_at.as_deref().unwrap_or(""))
    });
    entries.truncate(max);
    Ok(entries)
}

fn count_matching_files(
    roots: &[PathBuf],
    extensions: &[String],
    filter_by_ext: bool,
    max_results: usize,
    max_depth: usize,
    cancelled: &AtomicBool,
) -> usize {
    let mut total = 0usize;
    for root in roots {
        if cancelled.load(Ordering::Relaxed) || total >= max_results {
            break;
        }
        if root.exists() && root.is_dir() {
            count_matching_files_inner(
                root,
                extensions,
                filter_by_ext,
                max_results,
                max_depth,
                0,
                &mut total,
                cancelled,
            );
        }
    }
    total
}

fn count_matching_files_inner(
    dir: &Path,
    extensions: &[String],
    filter_by_ext: bool,
    max_results: usize,
    max_depth: usize,
    depth: usize,
    total: &mut usize,
    cancelled: &AtomicBool,
) {
    if *total >= max_results || depth >= max_depth || cancelled.load(Ordering::Relaxed) {
        return;
    }
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    let skip_lower: Vec<String> = SKIP_DIRS.iter().map(|d| d.to_lowercase()).collect();
    for entry in read_dir {
        if *total >= max_results || cancelled.load(Ordering::Relaxed) {
            return;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            let name_lower = file_name.to_lowercase();
            if !skip_lower.contains(&name_lower) && !is_root_level_vendor_skip(&file_name, dir) {
                count_matching_files_inner(
                    &path,
                    extensions,
                    filter_by_ext,
                    max_results,
                    max_depth,
                    depth + 1,
                    total,
                    cancelled,
                );
            }
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !filter_by_ext || extensions.contains(&ext) {
            *total += 1;
        }
    }
}

#[tauri::command]
pub(crate) fn cancel_scan_all_files(scan_id: String) -> Result<(), String> {
    let mut scans = ACTIVE_SCANS.lock().unwrap();
    let mut found = false;
    for s in scans.iter() {
        if s.scan_id == scan_id {
            s.cancelled.store(true, Ordering::Relaxed);
            found = true;
        }
    }
    scans.retain(|s| !s.cancelled.load(Ordering::Relaxed));
    if !found && !scan_id.is_empty() {
        return Err(format!("No active scan found for id: {scan_id}"));
    }
    Ok(())
}

pub(crate) fn collect_files_inner_for_scan(
    dir: &Path,
    extensions: &[String],
    filter_by_ext: bool,
    max_results: usize,
    max_depth: usize,
    depth: usize,
    entries: &mut Vec<FileEntry>,
    cancelled: &AtomicBool,
    app: Option<&AppHandle>,
    scan_id: Option<&str>,
    total: usize,
    current: &mut usize,
) {
    if entries.len() >= max_results || depth >= max_depth {
        return;
    }
    if cancelled.load(Ordering::Relaxed) {
        return;
    }
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    let skip_lower: Vec<String> = SKIP_DIRS.iter().map(|d| d.to_lowercase()).collect();
    for entry in read_dir {
        if entries.len() >= max_results {
            return;
        }
        if cancelled.load(Ordering::Relaxed) {
            return;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            let name_lower = file_name.to_lowercase();
            if !skip_lower.contains(&name_lower) && !is_root_level_vendor_skip(&file_name, dir) {
                collect_files_inner_for_scan(
                    &path,
                    extensions,
                    filter_by_ext,
                    max_results,
                    max_depth,
                    depth + 1,
                    entries,
                    cancelled,
                    app,
                    scan_id,
                    total,
                    current,
                );
            }
            continue;
        }

        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        if filter_by_ext && !extensions.contains(&ext) {
            continue;
        }

        let metadata = fs::metadata(&path).ok();
        let size_bytes = metadata.as_ref().map(|m| m.len());
        let modified_at = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| chrono_datetime_from_secs(d.as_secs()));

        entries.push(FileEntry {
            name: file_name,
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            size_bytes,
            modified_at,
            extension: Some(ext),
        });
        *current += 1;
        if let Some(app) = app {
            emit_scan_progress(
                app,
                "scan-all-files-progress",
                scan_id,
                (*current).min(total),
                total,
            );
        }
    }
}

#[tauri::command]
pub(crate) fn scan_installed_apps(
    app_handle: AppHandle,
    scan_id: Option<String>,
) -> Result<Vec<AppEntry>, String> {
    // Windows-only: scan Start Menu and Desktop shortcuts
    #[cfg(not(target_os = "windows"))]
    {
        return Ok(Vec::new());
    }

    #[cfg(target_os = "windows")]
    {
        let mut apps: Vec<AppEntry> = Vec::new();
        let mut shortcuts: Vec<AppShortcut> = Vec::new();
        let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

        let start_menu_paths = [
            PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"),
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Microsoft\\Windows\\Start Menu\\Programs"),
        ];

        let desktop_paths = [
            dirs::desktop_dir().unwrap_or_else(|| PathBuf::from(".")),
            PathBuf::from("C:\\Users\\Public\\Desktop"),
        ];

        let roots = start_menu_paths
            .iter()
            .chain(desktop_paths.iter())
            .collect::<Vec<_>>();
        for root in roots {
            if root.exists() {
                collect_lnk_shortcuts(root, &mut shortcuts, &mut seen_names);
            }
        }

        let total = shortcuts.len().max(1);
        let mut current = 0usize;
        for shortcut in shortcuts {
            let (resolved_path, icon_path) = resolve_lnk_target(&shortcut.path)
                .unwrap_or_else(|| (shortcut.path.to_string_lossy().to_string(), None));

            apps.push(AppEntry {
                name: shortcut.name,
                path: resolved_path,
                icon_path,
                publisher: None,
                install_location: shortcut
                    .path
                    .parent()
                    .map(|p| p.to_string_lossy().to_string()),
            });
            current += 1;
            emit_scan_progress(
                &app_handle,
                "scan-installed-apps-progress",
                scan_id.as_deref(),
                current.min(total),
                total,
            );
        }

        apps.sort_by_key(|a| a.name.to_lowercase());
        Ok(apps)
    }
}

// NOTE: Full .lnk target resolution via Windows COM (IShellLink) requires the
// `windows` crate with COM interface support (~2MB binary size increase).
// For Phase 1, .lnk paths are stored directly. The UI opens them via
// tauri_plugin_opener which delegates to ShellExecute, correctly handling .lnk files.
// A future phase can add full resolution to show the actual executable path.
#[cfg(target_os = "windows")]
fn resolve_lnk_target(lnk_path: &Path) -> Option<(String, Option<String>)> {
    Some((
        lnk_path.to_string_lossy().to_string(),
        extract_file_icon_data_url(lnk_path),
    ))
}

#[cfg(target_os = "windows")]
fn extract_file_icon_data_url(path: &Path) -> Option<String> {
    if let Some(icon) = extract_system_image_list_icon_data_url(path) {
        return Some(icon);
    }

    let wide_path = wide_path(path);
    let mut file_info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let result = unsafe {
        SHGetFileInfoW(
            wide_path.as_ptr(),
            0,
            &mut file_info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if result == 0 || file_info.hIcon.is_null() {
        return None;
    }

    let icon = file_info.hIcon;
    let png = render_icon_png(icon, 48);
    unsafe {
        DestroyIcon(icon);
    }
    png.map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

#[cfg(target_os = "windows")]
fn wide_path(path: &Path) -> Vec<u16> {
    OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn extract_system_image_list_icon_data_url(path: &Path) -> Option<String> {
    let icon_index = system_icon_index(path)?;
    let icon = image_list_icon(icon_index, SHIL_JUMBO)
        .or_else(|| image_list_icon(icon_index, SHIL_EXTRALARGE))?;
    let png = render_icon_png(icon, 96);
    unsafe {
        DestroyIcon(icon);
    }
    png.map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

#[cfg(target_os = "windows")]
fn system_icon_index(path: &Path) -> Option<i32> {
    let wide_path = wide_path(path);
    let mut file_info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let result = unsafe {
        SHGetFileInfoW(
            wide_path.as_ptr(),
            0,
            &mut file_info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX,
        )
    };
    if result == 0 {
        return None;
    }
    Some(file_info.iIcon)
}

#[repr(C)]
#[cfg(target_os = "windows")]
struct ImageList {
    vtable: *const ImageListVtable,
}

#[repr(C)]
#[cfg(target_os = "windows")]
struct ImageListVtable {
    query_interface: usize,
    add_ref: usize,
    release: unsafe extern "system" fn(*mut ImageList) -> u32,
    add: usize,
    replace_icon: usize,
    set_overlay_image: usize,
    replace: usize,
    add_masked: usize,
    draw: usize,
    remove: usize,
    get_icon: unsafe extern "system" fn(*mut ImageList, i32, u32, *mut HICON) -> i32,
}

#[cfg(target_os = "windows")]
fn image_list_icon(icon_index: i32, image_list_size: u32) -> Option<HICON> {
    const IID_IIMAGE_LIST: windows_sys::core::GUID =
        windows_sys::core::GUID::from_u128(0x46eb5926_582e_4017_9fdf_e8998daa0950);

    let mut list_ptr: *mut c_void = null_mut();
    let hr = unsafe { SHGetImageList(image_list_size as i32, &IID_IIMAGE_LIST, &mut list_ptr) };
    if hr < 0 || list_ptr.is_null() {
        return None;
    }

    let list = list_ptr as *mut ImageList;
    let vtable = unsafe { (*list).vtable };
    if vtable.is_null() {
        return None;
    }

    let mut icon: HICON = null_mut();
    let icon_hr = unsafe { ((*vtable).get_icon)(list, icon_index, ILD_TRANSPARENT, &mut icon) };
    unsafe {
        ((*vtable).release)(list);
    }

    if icon_hr < 0 || icon.is_null() {
        return None;
    }
    Some(icon)
}

#[cfg(target_os = "windows")]
fn render_icon_png(icon: HICON, size: i32) -> Option<Vec<u8>> {
    if icon.is_null() || size <= 0 {
        return None;
    }

    let dc = unsafe { CreateCompatibleDC(null_mut()) };
    if dc.is_null() {
        return None;
    }

    let mut bits: *mut c_void = null_mut();
    let mut bitmap_info: BITMAPINFO = unsafe { std::mem::zeroed() };
    bitmap_info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: size,
        biHeight: -size,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };

    let bitmap =
        unsafe { CreateDIBSection(dc, &bitmap_info, DIB_RGB_COLORS, &mut bits, null_mut(), 0) };
    if bitmap.is_null() || bits.is_null() {
        unsafe {
            DeleteDC(dc);
        }
        return None;
    }

    let old_bitmap = unsafe { SelectObject(dc, bitmap) };
    let drawn = unsafe { DrawIconEx(dc, 0, 0, icon, size, size, 0, null_mut(), DI_NORMAL) };

    let result = if drawn != 0 {
        let byte_len = (size as usize) * (size as usize) * 4;
        let bgra = unsafe { std::slice::from_raw_parts(bits as *const u8, byte_len) };
        encode_bgra_png(bgra, size as u32, size as u32)
    } else {
        None
    };

    unsafe {
        if !old_bitmap.is_null() {
            SelectObject(dc, old_bitmap);
        }
        DeleteObject(bitmap);
        DeleteDC(dc);
    }

    result
}

#[cfg(target_os = "windows")]
fn encode_bgra_png(bgra: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    use image::ImageEncoder as _;

    let has_alpha = bgra.chunks_exact(4).any(|pixel| pixel[3] > 0);
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(4) {
        let alpha = if has_alpha {
            pixel[3]
        } else if pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0 {
            255
        } else {
            0
        };
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], alpha]);
    }
    let (rgba, width, height) = crop_transparent_rgba(&rgba, width, height);

    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(png)
}

#[cfg(target_os = "windows")]
fn crop_transparent_rgba(rgba: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0;
    let mut max_y = 0;
    let mut found = false;

    for y in 0..height {
        for x in 0..width {
            let alpha_index = ((y * width + x) as usize) * 4 + 3;
            if rgba.get(alpha_index).copied().unwrap_or(0) > 8 {
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
                found = true;
            }
        }
    }

    if !found {
        return (rgba.to_vec(), width, height);
    }

    let cropped_width = max_x - min_x + 1;
    let cropped_height = max_y - min_y + 1;
    if cropped_width == width && cropped_height == height {
        return (rgba.to_vec(), width, height);
    }

    let mut cropped = Vec::with_capacity((cropped_width * cropped_height * 4) as usize);
    for y in min_y..=max_y {
        let start = ((y * width + min_x) as usize) * 4;
        let end = start + (cropped_width as usize) * 4;
        cropped.extend_from_slice(&rgba[start..end]);
    }

    (cropped, cropped_width, cropped_height)
}

#[cfg(target_os = "windows")]
struct AppShortcut {
    name: String,
    path: PathBuf,
}

#[cfg(target_os = "windows")]
fn collect_lnk_shortcuts(
    dir: &Path,
    shortcuts: &mut Vec<AppShortcut>,
    seen_names: &mut std::collections::HashSet<String>,
) {
    let read_dir = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.is_dir() {
            collect_lnk_shortcuts(&path, shortcuts, seen_names);
            continue;
        }

        let Some(name) = shortcut_name_from_path(&path) else {
            continue;
        };
        let normalized = name.to_lowercase();
        if seen_names.contains(&normalized) {
            continue;
        }
        seen_names.insert(normalized);
        shortcuts.push(AppShortcut { name, path });
    }
}

#[cfg(target_os = "windows")]
fn shortcut_name_from_path(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    if ext != "lnk" {
        return None;
    }
    let name = path.file_stem()?.to_string_lossy().trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

#[tauri::command]
pub(crate) fn scan_user_documents(
    extensions: Option<Vec<String>>,
    max_results: Option<usize>,
) -> Result<Vec<FileEntry>, String> {
    let home = user_home();
    let roots = vec![
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Downloads"),
    ];
    let default_exts: Vec<String> = vec![
        "docx", "doc", "txt", "pdf", "xlsx", "xls", "csv", "pptx", "ppt", "md", "rtf", "odt",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let exts = extensions.unwrap_or(default_exts);
    let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
    let max = max_results.unwrap_or(200);
    collect_files(&roots, &ext_refs, max, true)
}

#[tauri::command]
pub(crate) fn scan_user_images(max_results: Option<usize>) -> Result<Vec<FileEntry>, String> {
    let home = user_home();
    let roots = vec![
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Pictures"),
        home.join("Downloads"),
    ];
    let exts = [
        "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "tiff", "tif",
    ];
    let max = max_results.unwrap_or(200);
    collect_files(&roots, &exts, max, true)
}

#[tauri::command]
pub(crate) fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        return Err(format!("Path not found: {}", path));
    }
    if !dir.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Canonicalize to resolve `..` and symlinks before security checks.
    // A path like C:\Users\..\Windows would pass a naive string-prefix check
    // but resolve into the blocked C:\Windows tree.
    let real = dir
        .canonicalize()
        .map_err(|e| format!("Cannot resolve path: {}", e))?;
    let real_lower = real.to_string_lossy().to_lowercase();

    let blocked = [
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "C:\\$Recycle.Bin",
        "C:\\System Volume Information",
    ];
    for b in &blocked {
        let blocked_canonical = PathBuf::from(b)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(b));
        let blocked_lower = blocked_canonical.to_string_lossy().to_lowercase();
        if real_lower == blocked_lower || real_lower.starts_with(&format!("{}\\", blocked_lower)) {
            return Err(format!("Access denied: {}", path));
        }
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&real).map_err(|e| format!("Cannot read directory: {}", e))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let entry_path = entry.path();
        let metadata = fs::metadata(&entry_path).ok();
        let is_dir = entry_path.is_dir();
        let name = entry.file_name().to_string_lossy().to_string();
        let size_bytes = if is_dir {
            None
        } else {
            metadata.as_ref().map(|m| m.len())
        };
        let modified_at = metadata
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| chrono_datetime_from_secs(d.as_secs()));
        let extension = if is_dir {
            None
        } else {
            entry_path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
        };

        entries.push(FileEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            size_bytes,
            modified_at,
            extension,
        });
    }

    // Sort: directories first, then files, both alphabetical
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
pub(crate) fn read_file_chunk(
    app_handle: AppHandle,
    path: String,
    max_lines: Option<usize>,
    workspace_root: Option<String>,
    allowed_root_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let allowed_roots = resolve_allowed_read_roots(&app_handle, workspace_root, allowed_root_ids)?;
    read_file_chunk_with_allowed_roots(path, max_lines, Some(allowed_roots))
}

fn read_file_chunk_with_allowed_roots(
    path: String,
    max_lines: Option<usize>,
    allowed_roots: Option<Vec<String>>,
) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    validate_readable_text_file_path(&file_path, allowed_roots.as_deref())?;

    // Read at most 64 KB to stay within safe context injection limits.
    // Large files are truncated to avoid memory pressure.
    let file = fs::File::open(&file_path).map_err(|e| format!("Cannot open file: {}", e))?;
    let mut buffer = Vec::with_capacity(65536);
    file.take(65536)
        .read_to_end(&mut buffer)
        .map_err(|e| format!("Cannot read file: {}", e))?;
    let content = String::from_utf8_lossy(&buffer);

    let max = max_lines.unwrap_or(200);
    let lines: Vec<&str> = content.lines().take(max).collect();
    Ok(lines.join("\n"))
}

fn resolve_allowed_read_roots(
    app: &AppHandle,
    workspace_root: Option<String>,
    allowed_root_ids: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let mut roots = Vec::new();
    if let Some(workspace_root) = workspace_root.and_then(|root| {
        let trimmed = root.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    }) {
        roots.push(validate_workspace_read_root(&workspace_root)?);
    }
    let root_ids = allowed_root_ids.unwrap_or_default();
    for record in database::resource_scan_roots_for_ids(app, &root_ids)? {
        if !record.enabled {
            return Err(format!("Resource scan root is disabled: {}", record.id));
        }
        roots.push(record.path);
    }
    if roots.is_empty() {
        return Err("Reading local file content requires a selected workspace or scan root.".to_string());
    }
    Ok(roots)
}

fn validate_workspace_read_root(path: &str) -> Result<String, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve workspace root: {error}"))?;
    if !canonical.is_dir() {
        return Err("Workspace root must be a directory.".to_string());
    }
    if is_sensitive_read_path(&canonical) {
        return Err("Refusing to use a sensitive workspace root for local reads.".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

fn validate_readable_text_file_path(
    file_path: &Path,
    allowed_roots: Option<&[String]>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(file_path)
        .map_err(|_| format!("File not found: {}", file_path.to_string_lossy()))?;
    if metadata.file_type().is_symlink() {
        return Err("Refusing to read symlinked files.".to_string());
    }
    if !metadata.is_file() {
        return Err(format!(
            "Path is not a file: {}",
            file_path.to_string_lossy()
        ));
    }
    if is_sensitive_read_path(file_path) {
        return Err("Refusing to read sensitive local files.".to_string());
    }
    if !is_supported_text_file(file_path) {
        return Err("Only common text files can be read as document context.".to_string());
    }
    ensure_path_is_under_allowed_root(file_path, allowed_roots)?;
    Ok(())
}

fn ensure_path_is_under_allowed_root(
    file_path: &Path,
    allowed_roots: Option<&[String]>,
) -> Result<(), String> {
    let roots = allowed_roots
        .filter(|roots| !roots.is_empty())
        .ok_or_else(|| {
            "Reading local file content requires a selected workspace or scan root.".to_string()
        })?;
    let canonical_file =
        fs::canonicalize(file_path).map_err(|e| format!("Cannot resolve file path: {e}"))?;
    for root in roots {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            continue;
        }
        let root_path = PathBuf::from(trimmed);
        let canonical_root = fs::canonicalize(&root_path).map_err(|e| {
            format!(
                "Cannot resolve allowed root {}: {e}",
                root_path.to_string_lossy()
            )
        })?;
        if canonical_file.starts_with(&canonical_root) {
            return Ok(());
        }
    }
    Err("File must be inside the selected workspace or a scanned resource root.".to_string())
}

fn is_supported_text_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "bat"
            | "c"
            | "cmd"
            | "cpp"
            | "cs"
            | "css"
            | "csv"
            | "go"
            | "h"
            | "hpp"
            | "htm"
            | "html"
            | "ini"
            | "java"
            | "js"
            | "json"
            | "jsonl"
            | "jsx"
            | "log"
            | "md"
            | "markdown"
            | "php"
            | "ps1"
            | "py"
            | "rb"
            | "rs"
            | "rst"
            | "rtf"
            | "sh"
            | "sql"
            | "toml"
            | "ts"
            | "tsx"
            | "txt"
            | "xml"
            | "yaml"
            | "yml"
    )
}

fn is_sensitive_read_path(path: &Path) -> bool {
    let sensitive_components = [
        ".aws",
        ".azure",
        ".docker",
        ".gnupg",
        ".kube",
        ".ssh",
        "appdata",
        "cookies",
        "credentials",
        "keychain",
        "keyrings",
        "passwords",
    ];
    if path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        sensitive_components.contains(&value.as_str())
    }) {
        return true;
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    file_name == ".env"
        || file_name.starts_with(".env.")
        || matches!(
            file_name.as_str(),
            "id_rsa"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
                | "login data"
                | "local state"
                | "cookies.sqlite"
                | "key3.db"
                | "key4.db"
                | "cert9.db"
        )
        || file_name.ends_with(".pem")
        || file_name.ends_with(".key")
        || file_name.ends_with(".pfx")
        || file_name.ends_with(".p12")
}

#[tauri::command]
pub(crate) fn read_image_data_url(
    app_handle: AppHandle,
    path: String,
    workspace_root: Option<String>,
    allowed_root_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let allowed_roots = resolve_allowed_read_roots(&app_handle, workspace_root, allowed_root_ids)?;
    read_image_data_url_with_allowed_roots(path, Some(allowed_roots))
}

fn read_image_data_url_with_allowed_roots(
    path: String,
    allowed_roots: Option<Vec<String>>,
) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    let metadata =
        fs::symlink_metadata(&file_path).map_err(|_| format!("Image not found: {}", path))?;
    if metadata.file_type().is_symlink() {
        return Err("Refusing to read symlinked image files.".to_string());
    }
    if !metadata.is_file() {
        return Err(format!("Path is not an image file: {}", path));
    }
    if is_sensitive_read_path(&file_path) {
        return Err("Refusing to read sensitive local image files.".to_string());
    }
    ensure_path_is_under_allowed_root(&file_path, allowed_roots.as_deref())?;
    let mime = image_mime_type(&file_path)
        .ok_or_else(|| "Unsupported image format. Use PNG, JPEG, WebP, GIF, or BMP.".to_string())?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err("Image is too large for model analysis; maximum size is 10 MB.".to_string());
    }
    let bytes = fs::read(&file_path).map_err(|e| format!("Cannot read image file: {e}"))?;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())?
        .as_str()
    {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "tiff" | "tif" => Some("image/tiff"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn local_tempdir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("javis-scan-test-")
            .tempdir_in(std::env::current_dir().expect("current dir"))
            .expect("tempdir")
    }

    fn allowed_root(path: &Path) -> Option<Vec<String>> {
        Some(vec![path.to_string_lossy().to_string()])
    }

    #[test]
    fn collect_files_skips_node_modules() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let node_modules = tmp.path().join("node_modules");
        std::fs::create_dir_all(&node_modules).unwrap();
        let hidden = node_modules.join("package.json");
        std::fs::File::create(&hidden)
            .unwrap()
            .write_all(b"{}")
            .unwrap();
        let visible = tmp.path().join("readme.md");
        std::fs::File::create(&visible)
            .unwrap()
            .write_all(b"# Readme")
            .unwrap();

        let result = collect_files(&[tmp.path().to_path_buf()], &["md", "json"], 20, true).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].path.ends_with("readme.md"));
    }

    #[test]
    fn collect_files_respects_max_results() {
        let tmp = tempfile::tempdir().expect("tempdir");
        for i in 0..15 {
            let file_path = tmp.path().join(format!("{}.txt", i));
            std::fs::File::create(&file_path)
                .unwrap()
                .write_all(b"x")
                .unwrap();
        }
        let result =
            collect_files_with_depth(&[tmp.path().to_path_buf()], &["txt"], 5, true, usize::MAX)
                .unwrap();
        assert_eq!(result.len(), 5);
    }

    #[test]
    fn collect_files_respects_max_depth() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let deep = tmp.path().join("deep").join("deeper");
        std::fs::create_dir_all(&deep).unwrap();
        let file_path = deep.join("file.txt");
        std::fs::File::create(&file_path)
            .unwrap()
            .write_all(b"x")
            .unwrap();

        let result1 = collect_files(&[tmp.path().to_path_buf()], &["txt"], 10, true).unwrap();
        assert_eq!(result1.len(), 1);

        let result2 =
            collect_files_with_depth(&[tmp.path().to_path_buf()], &["txt"], 10, true, 2).unwrap();
        assert_eq!(result2.len(), 0);
    }

    #[test]
    fn read_file_chunk_reads_supported_text_file() {
        let tmp = local_tempdir();
        let file_path = tmp.path().join("notes.md");
        std::fs::File::create(&file_path)
            .unwrap()
            .write_all(b"line 1\nline 2\nline 3")
            .unwrap();

        let result = read_file_chunk_with_allowed_roots(
            file_path.to_string_lossy().to_string(),
            Some(2),
            allowed_root(tmp.path()),
        )
        .unwrap();

        assert_eq!(result, "line 1\nline 2");
    }

    #[test]
    fn read_file_chunk_rejects_missing_allowed_roots() {
        let tmp = local_tempdir();
        let file_path = tmp.path().join("notes.md");
        std::fs::File::create(&file_path)
            .unwrap()
            .write_all(b"line 1")
            .unwrap();

        assert!(read_file_chunk_with_allowed_roots(file_path.to_string_lossy().to_string(), None, None).is_err());
        assert!(
            read_file_chunk_with_allowed_roots(file_path.to_string_lossy().to_string(), None, Some(vec![])).is_err()
        );
    }

    #[test]
    fn read_file_chunk_rejects_paths_outside_allowed_roots() {
        let allowed = local_tempdir();
        let outside = local_tempdir();
        let file_path = outside.path().join("notes.md");
        std::fs::File::create(&file_path)
            .unwrap()
            .write_all(b"line 1")
            .unwrap();

        let result = read_file_chunk_with_allowed_roots(
            file_path.to_string_lossy().to_string(),
            None,
            allowed_root(allowed.path()),
        );

        assert!(result.is_err());
    }

    #[test]
    fn read_file_chunk_rejects_sensitive_paths() {
        let tmp = local_tempdir();
        let env_path = tmp.path().join(".env");
        std::fs::File::create(&env_path)
            .unwrap()
            .write_all(b"SECRET=value")
            .unwrap();
        let ssh_dir = tmp.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        let key_path = ssh_dir.join("id_rsa");
        std::fs::File::create(&key_path)
            .unwrap()
            .write_all(b"private key")
            .unwrap();

        assert!(read_file_chunk_with_allowed_roots(
            env_path.to_string_lossy().to_string(),
            None,
            allowed_root(tmp.path())
        )
        .is_err());
        assert!(read_file_chunk_with_allowed_roots(
            key_path.to_string_lossy().to_string(),
            None,
            allowed_root(tmp.path())
        )
        .is_err());
    }

    #[test]
    fn read_file_chunk_rejects_non_text_extensions() {
        let tmp = local_tempdir();
        let file_path = tmp.path().join("image.png");
        std::fs::File::create(&file_path)
            .unwrap()
            .write_all(b"not really an image")
            .unwrap();

        let result = read_file_chunk_with_allowed_roots(
            file_path.to_string_lossy().to_string(),
            None,
            allowed_root(tmp.path()),
        );

        assert!(result.is_err());
    }

    #[test]
    fn read_file_chunk_rejects_symlinks() {
        let tmp = local_tempdir();
        let target = tmp.path().join("target.md");
        let link = tmp.path().join("link.md");
        std::fs::File::create(&target)
            .unwrap()
            .write_all(b"linked content")
            .unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(&target, &link).is_err() {
                return;
            }
        }

        let result = read_file_chunk_with_allowed_roots(
            link.to_string_lossy().to_string(),
            None,
            allowed_root(tmp.path()),
        );

        assert!(result.is_err());
    }

    #[test]
    fn read_image_data_url_rejects_sensitive_paths() {
        let tmp = local_tempdir();
        let ssh_dir = tmp.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        let image_path = ssh_dir.join("id_rsa.png");
        std::fs::File::create(&image_path)
            .unwrap()
            .write_all(b"fake image")
            .unwrap();

        let result = read_image_data_url_with_allowed_roots(
            image_path.to_string_lossy().to_string(),
            allowed_root(tmp.path()),
        );

        assert!(result.is_err());
    }

    #[test]
    fn read_image_data_url_rejects_symlinks() {
        let tmp = local_tempdir();
        let target = tmp.path().join("target.png");
        let link = tmp.path().join("link.png");
        std::fs::File::create(&target)
            .unwrap()
            .write_all(b"fake image")
            .unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link).unwrap();
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(&target, &link).is_err() {
                return;
            }
        }

        let result =
            read_image_data_url_with_allowed_roots(link.to_string_lossy().to_string(), allowed_root(tmp.path()));

        assert!(result.is_err());
    }

    #[test]
    fn read_image_data_url_rejects_missing_allowed_roots() {
        let tmp = local_tempdir();
        let image_path = tmp.path().join("image.png");
        std::fs::File::create(&image_path)
            .unwrap()
            .write_all(b"fake image")
            .unwrap();

        assert!(read_image_data_url_with_allowed_roots(image_path.to_string_lossy().to_string(), None).is_err());
        assert!(
            read_image_data_url_with_allowed_roots(image_path.to_string_lossy().to_string(), Some(vec![])).is_err()
        );
    }

    #[test]
    fn read_image_data_url_rejects_paths_outside_allowed_roots() {
        let allowed = local_tempdir();
        let outside = local_tempdir();
        let image_path = outside.path().join("image.png");
        std::fs::File::create(&image_path)
            .unwrap()
            .write_all(b"fake image")
            .unwrap();

        let result = read_image_data_url_with_allowed_roots(
            image_path.to_string_lossy().to_string(),
            allowed_root(allowed.path()),
        );

        assert!(result.is_err());
    }

    #[test]
    fn mount_roots_non_empty() {
        let roots = mount_roots().expect("mount_roots");
        assert!(!roots.is_empty(), "Should return at least one mount root");
    }

    #[test]
    fn is_root_level_vendor_skip_flags_known_vendors_at_root() {
        assert!(is_root_level_vendor_skip(
            "Intel",
            std::path::Path::new("C:\\")
        ));
        assert!(is_root_level_vendor_skip(
            "NVIDIA",
            std::path::Path::new("C:\\")
        ));
        assert!(is_root_level_vendor_skip(
            "AMD",
            std::path::Path::new("C:\\")
        ));
    }

    #[test]
    fn is_root_level_vendor_skip_rejects_non_root_parent() {
        assert!(!is_root_level_vendor_skip(
            "Intel",
            std::path::Path::new("C:\\Projects")
        ));
    }
}
