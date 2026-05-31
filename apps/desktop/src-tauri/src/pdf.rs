use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::{Path, PathBuf}, sync::Mutex};

use crate::{NativeApprovalBinding, create_native_approval_binding, approve_native_approval_binding, require_native_approval_binding, normalize_path, create_fnv1a_hash, format_system_time, resolve_workspace_path, create_approval_id};

pub(crate) const PDF_APPROVAL_TOOL_NAME: &str = "file.executePdfOrganization";


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarkdownDocument {
    path: String,
    modified_at: String,
    size_bytes: u64,
    heading: Option<String>,
    excerpt: Option<String>,
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOrganizationPlan {
    approval_id: String,
    directory_path: String,
    file_count: usize,
    dry_run: FileDryRunSummary,
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileDryRunSummary {
    pub(crate) operation: String,
    pub(crate) affected_paths: Vec<PlannedPathOperation>,
    pub(crate) risk_summary: String,
    pub(crate) reversible: bool,
}


#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlannedPathOperation {
    pub(crate) source: String,
    pub(crate) target: String,
    pub(crate) action: String,
    pub(crate) conflict: Option<String>,
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteFileOrganizationRequest {
    pub(crate) approval_id: String,
    pub(crate) operations: Vec<PlannedPathOperation>,
    #[serde(default)]
    pub(crate) task_id: Option<String>,
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOrganizationExecution {
    attempted_count: usize,
    moved_count: usize,
    skipped_count: usize,
    failed_count: usize,
    results: Vec<FileOperationResult>,
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOperationResult {
    pub(crate) source: String,
    pub(crate) target: String,
    pub(crate) status: String,
    pub(crate) message: String,
}


#[derive(Default)]
pub(crate) struct PdfOrganizationApprovalState {
    pub(crate) pending: Option<PendingPdfOrganizationApproval>,
}


pub(crate) struct PendingPdfOrganizationApproval {
    pub(crate) binding: NativeApprovalBinding,
    pub(crate) operations: Vec<PlannedPathOperation>,
}


#[tauri::command]
pub(crate) fn scan_markdown_documents(
    workspace_path: Option<String>,
) -> Result<Vec<MarkdownDocument>, String> {
    let workspace = resolve_workspace_path(workspace_path)?;
    let mut documents = Vec::new();
    scan_directory(&workspace, &mut documents)?;
    documents.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    documents.truncate(50);
    Ok(documents)
}


#[tauri::command]
pub(crate) fn plan_pdf_organization(
    task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<PdfOrganizationApprovalState>>,
) -> Result<FileOrganizationPlan, String> {
    let directory = downloads_directory()?;
    let mut operations = Vec::new();

    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();

        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("pdf"))
            .unwrap_or(true)
        {
            continue;
        }

        let category = infer_pdf_category(&path);
        let target = directory.join(category).join(
            path.file_name()
                .ok_or_else(|| "PDF path does not include a file name.".to_string())?,
        );
        let conflict = target
            .exists()
            .then(|| "Target file already exists; default plan will not overwrite.".to_string());

        operations.push(PlannedPathOperation {
            source: normalize_path(&path),
            target: normalize_path(&target),
            action: "move".to_string(),
            conflict,
        });
    }

    operations.sort_by(|left, right| left.source.cmp(&right.source));
    let approval_id = create_approval_id();
    replace_pending_pdf_approval(
        &approval_state,
        &approval_id,
        &directory,
        &operations,
        task_id.as_deref(),
    )?;

    Ok(FileOrganizationPlan {
        approval_id,
        directory_path: normalize_path(&directory),
        file_count: operations.len(),
        dry_run: FileDryRunSummary {
            operation: "Organize PDF files by filename topic".to_string(),
            affected_paths: operations,
            risk_summary: "Preview only. Files move only after the current dry-run is approved."
                .to_string(),
            reversible: true,
        },
    })
}


#[tauri::command]
pub(crate) fn approve_pdf_organization(
    approval_id: String,
    #[allow(unused_variables)] task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<PdfOrganizationApprovalState>>,
) -> Result<(), String> {
    approve_pending_pdf_organization(&approval_state, &approval_id, task_id.as_deref())
}


#[tauri::command]
pub(crate) fn restore_pdf_organization_approval(
    request: ExecuteFileOrganizationRequest,
    approval_state: tauri::State<'_, Mutex<PdfOrganizationApprovalState>>,
) -> Result<(), String> {
    let downloads = downloads_directory()?;
    replace_pending_pdf_approval(
        &approval_state,
        &request.approval_id,
        &downloads,
        &request.operations,
        request.task_id.as_deref(),
    )?;
    approve_pending_pdf_organization(
        &approval_state,
        &request.approval_id,
        request.task_id.as_deref(),
    )
}


#[tauri::command]
pub(crate) fn execute_pdf_organization(
    request: ExecuteFileOrganizationRequest,
    approval_state: tauri::State<'_, Mutex<PdfOrganizationApprovalState>>,
) -> Result<FileOrganizationExecution, String> {
    let downloads = downloads_directory()?;
    let mut results = Vec::new();
    let operations = take_approved_pdf_operations(&approval_state, request)?;

    for operation in operations {
        results.push(execute_pdf_move_operation(&downloads, operation));
    }

    let moved_count = results
        .iter()
        .filter(|result| result.status == "moved")
        .count();
    let skipped_count = results
        .iter()
        .filter(|result| result.status == "skipped")
        .count();
    let failed_count = results
        .iter()
        .filter(|result| result.status == "failed")
        .count();

    Ok(FileOrganizationExecution {
        attempted_count: results.len(),
        moved_count,
        skipped_count,
        failed_count,
        results,
    })
}


pub(crate) fn downloads_directory() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .ok_or_else(|| "Could not resolve the user home directory.".to_string())?;
    let downloads = home.join("Downloads");
    if downloads.is_dir() {
        return Ok(downloads);
    }
    Err("Downloads directory was not found.".to_string())
}


pub(crate) fn replace_pending_pdf_approval(
    approval_state: &Mutex<PdfOrganizationApprovalState>,
    approval_id: &str,
    downloads: &Path,
    operations: &[PlannedPathOperation],
    task_id: Option<&str>,
) -> Result<(), String> {
    require_approved_pdf_operations(downloads, operations)?;
    let preview_hash = create_pdf_operations_preview_hash(operations);
    let mut state = approval_state
        .lock()
        .map_err(|_| "PDF approval state could not be locked.".to_string())?;
    state.pending = Some(PendingPdfOrganizationApproval {
        binding: create_native_approval_binding(
            approval_id.to_string(),
            PDF_APPROVAL_TOOL_NAME,
            task_id.unwrap_or_default().trim().to_string(),
            preview_hash,
            false,
        ),
        operations: operations.to_vec(),
    });
    Ok(())
}


pub(crate) fn create_pdf_operations_preview_hash(operations: &[PlannedPathOperation]) -> String {
    let payload = operations
        .iter()
        .map(|operation| {
            format!(
                "{}\n{}\n{}\n{}",
                operation.source,
                operation.target,
                operation.action,
                operation.conflict.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n---\n");
    create_fnv1a_hash(payload.as_bytes())
}


pub(crate) fn require_approved_pdf_operations(
    downloads: &Path,
    operations: &[PlannedPathOperation],
) -> Result<(), String> {
    let downloads_canonical = fs::canonicalize(downloads)
        .map_err(|error| format!("Downloads directory cannot be verified: {error}"))?;
    for operation in operations {
        if operation.action != "move" {
            return Err("Only move PDF organization operations can be approved.".to_string());
        }
        let source = PathBuf::from(&operation.source);
        let target = PathBuf::from(&operation.target);
        if has_parent_dir_component(&source) || has_parent_dir_component(&target) {
            return Err(
                "PDF organization paths cannot contain parent directory traversal.".to_string(),
            );
        }
        let source_canonical = fs::canonicalize(&source)
            .map_err(|error| format!("Approved PDF source cannot be read: {error}"))?;
        if !source_canonical.starts_with(&downloads_canonical)
            || !target_parent_stays_in_downloads(&target, &downloads_canonical)
        {
            return Err("Approved PDF organization paths must stay inside Downloads.".to_string());
        }
        if source_canonical
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| !extension.eq_ignore_ascii_case("pdf"))
            .unwrap_or(true)
        {
            return Err("Only PDF sources can be approved for organization.".to_string());
        }
    }
    Ok(())
}


pub(crate) fn approve_pending_pdf_organization(
    approval_state: &Mutex<PdfOrganizationApprovalState>,
    approval_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "PDF approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_mut() else {
        return Err("No pending PDF organization approval exists.".to_string());
    };
    approve_native_approval_binding(
        &mut pending.binding,
        approval_id,
        PDF_APPROVAL_TOOL_NAME,
        task_id,
        &create_pdf_operations_preview_hash(&pending.operations),
        "PDF organization approval id does not match the pending dry-run.",
    )
}


pub(crate) fn take_approved_pdf_operations(
    approval_state: &Mutex<PdfOrganizationApprovalState>,
    request: ExecuteFileOrganizationRequest,
) -> Result<Vec<PlannedPathOperation>, String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "PDF approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_ref() else {
        return Err("No approved PDF organization dry-run is pending.".to_string());
    };
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        PDF_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &create_pdf_operations_preview_hash(&pending.operations),
        "PDF organization approval id does not match the pending dry-run.",
        "PDF organization dry-run has not been approved.",
    )
    .map_err(|e| e.to_string())?;
    if pending.operations != request.operations {
        return Err(
            "Approved PDF organization operations do not match the current dry-run.".to_string(),
        );
    }
    let operations = request.operations;
    state.pending = None;
    Ok(operations)
}


pub(crate) fn infer_pdf_category(path: &Path) -> &'static str {
    let name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if name.contains("invoice") || name.contains("receipt") || name.contains("bill") {
        return "Finance";
    }
    if name.contains("paper") || name.contains("research") || name.contains("report") {
        return "Research";
    }
    if name.contains("manual") || name.contains("guide") || name.contains("docs") {
        return "Manuals";
    }
    "Unsorted"
}


pub(crate) fn execute_pdf_move_operation(
    downloads: &Path,
    operation: PlannedPathOperation,
) -> FileOperationResult {
    if operation.action != "move" {
        return file_operation_result(operation, "failed", "Only move operations are supported.");
    }

    if operation.conflict.is_some() {
        return file_operation_result(
            operation,
            "skipped",
            "Dry-run marked this operation as conflicting; skipped by default.",
        );
    }

    let source = PathBuf::from(&operation.source);
    let target = PathBuf::from(&operation.target);

    if has_parent_dir_component(&source) || has_parent_dir_component(&target) {
        return file_operation_result(
            operation,
            "failed",
            "Parent directory traversal is not allowed.",
        );
    }

    let source_canonical = match fs::canonicalize(&source) {
        Ok(path) => path,
        Err(error) => {
            return file_operation_result(
                operation,
                "failed",
                &format!("Source cannot be read: {error}"),
            );
        }
    };
    let downloads_canonical = match fs::canonicalize(downloads) {
        Ok(path) => path,
        Err(error) => {
            return file_operation_result(
                operation,
                "failed",
                &format!("Downloads directory cannot be verified: {error}"),
            );
        }
    };

    if !source_canonical.starts_with(&downloads_canonical) || !target.starts_with(downloads) {
        return file_operation_result(
            operation,
            "failed",
            "Source and target must both stay inside Downloads.",
        );
    }

    if !target_parent_stays_in_downloads(&target, &downloads_canonical) {
        return file_operation_result(
            operation,
            "failed",
            "Target parent directory could not be verified inside Downloads.",
        );
    }

    if source_canonical
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("pdf"))
        .unwrap_or(true)
    {
        return file_operation_result(operation, "failed", "Only PDF files can be moved.");
    }

    if target.exists() {
        return file_operation_result(operation, "skipped", "Target already exists.");
    }

    if let Some(parent) = target.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return file_operation_result(
                operation,
                "failed",
                &format!("Target directory could not be created: {error}"),
            );
        }
    }

    match fs::rename(&source_canonical, &target) {
        Ok(()) => file_operation_result(operation, "moved", "File moved successfully."),
        Err(error) => file_operation_result(operation, "failed", &format!("Move failed: {error}")),
    }
}


pub(crate) fn target_parent_stays_in_downloads(target: &Path, downloads_canonical: &Path) -> bool {
    let Some(mut candidate) = target.parent() else {
        return false;
    };

    loop {
        if candidate.exists() {
            return fs::canonicalize(candidate)
                .map(|path| path.starts_with(downloads_canonical))
                .unwrap_or(false);
        }

        let Some(parent) = candidate.parent() else {
            return false;
        };
        candidate = parent;
    }
}


pub(crate) fn has_parent_dir_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}


pub(crate) fn file_operation_result(
    operation: PlannedPathOperation,
    status: &str,
    message: &str,
) -> FileOperationResult {
    FileOperationResult {
        source: operation.source,
        target: operation.target,
        status: status.to_string(),
        message: message.to_string(),
    }
}


pub(crate) fn scan_directory(
    directory: &Path,
    documents: &mut Vec<MarkdownDocument>,
) -> Result<(), String> {
    scan_directory_recursive(directory, documents)
}

fn scan_directory_recursive(
    directory: &Path,
    documents: &mut Vec<MarkdownDocument>,
) -> Result<(), String> {
    if should_skip_directory(directory) {
        return Ok(());
    }

    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            scan_directory_recursive(&path, documents)?;
            continue;
        }

        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }

        if should_skip_file(&path) {
            continue;
        }

        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let modified_at = metadata
            .modified()
            .ok()
            .map(format_system_time)
            .unwrap_or_else(|| "unknown".to_string());
        let content = read_text_prefix(&path).unwrap_or_default();
        let absolute_path = fs::canonicalize(&path)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        documents.push(MarkdownDocument {
            path: absolute_path,
            modified_at,
            size_bytes: metadata.len(),
            heading: first_heading(&content),
            excerpt: first_excerpt(&content),
        });
    }

    Ok(())
}


pub(crate) fn should_skip_directory(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };

    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "dist-ssr" | "gen"
    )
}


pub(crate) fn should_skip_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let normalized = name.to_lowercase();

    normalized.starts_with(".env")
        || normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("credential")
        || normalized.contains("password")
}


pub(crate) fn read_text_prefix(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(64 * 1024)
        .read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&buffer).to_string())
}


pub(crate) fn first_heading(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("# "))
        .map(|line| line.trim_start_matches("# ").trim().to_string())
}


pub(crate) fn first_excerpt(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.chars().take(180).collect())
}

