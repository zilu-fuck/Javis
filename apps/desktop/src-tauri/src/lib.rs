use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

mod streaming;

const OPENCODE_PROPOSAL_TIMEOUT: Duration = Duration::from_secs(90);
const MODEL_API_KEY_SECRET_REFERENCE: &str = "default";
const MODEL_API_KEY_SECRET_PREFIX: &str = "dpapi-v1:";
const PDF_APPROVAL_TOOL_NAME: &str = "file.executePdfOrganization";
const CODE_PATCH_APPROVAL_TOOL_NAME: &str = "code.applyProposedEdit";
const JAVIS_TERMINOLOGY_PROMPT_PREFIX: &str = r#"Javis terminology rules for Chinese output:
- Agent: keep the English term; do not translate it as proxy or bot.
- Token: keep the English term.
- confirmed write: confirmed write = user-approved write operation.
- dry run: dry run = preview execution without modifying files.
- patch: patch = code/file change proposal, not a repair program.
- hunk: hunk = one changed section in a unified diff.
- diff: diff = unified/text difference.
- workspace: workspace = working directory.
- approval: approval = user permission decision.
- proposal: proposal = proposed change.
- verifier: verifier = validation role.
- Commander: keep Commander as an English role name.
Keep JSON keys, code, paths, commands, and identifiers unchanged."#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownDocument {
    path: String,
    modified_at: String,
    size_bytes: u64,
    heading: Option<String>,
    excerpt: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOrganizationPlan {
    approval_id: String,
    directory_path: String,
    file_count: usize,
    dry_run: FileDryRunSummary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDryRunSummary {
    operation: String,
    affected_paths: Vec<PlannedPathOperation>,
    risk_summary: String,
    reversible: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlannedPathOperation {
    source: String,
    target: String,
    action: String,
    conflict: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteFileOrganizationRequest {
    approval_id: String,
    operations: Vec<PlannedPathOperation>,
    #[serde(default)]
    task_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOrganizationExecution {
    attempted_count: usize,
    moved_count: usize,
    skipped_count: usize,
    failed_count: usize,
    results: Vec<FileOperationResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOperationResult {
    source: String,
    target: String,
    status: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellCommandRequest {
    program: String,
    args: Vec<String>,
    workspace_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellCommandOutput {
    command: String,
    cwd: String,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSourceRequest {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchRequest {
    query: String,
    max_results: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebSource {
    url: String,
    title: Option<String>,
    excerpt: String,
    fetched_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchResult {
    url: String,
    title: Option<String>,
    excerpt: String,
    fetched_at: String,
    provider: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInspection {
    workspace_path: String,
    package_manager: Option<String>,
    scripts: Vec<ProjectScript>,
    recommended_start_command: Option<String>,
    recommended_test_command: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectScript {
    name: String,
    command: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodePatchApplyRequest {
    approval_id: String,
    proposal_id: String,
    workspace_path: String,
    changed_files: Vec<String>,
    patch: String,
    patch_hash: String,
    #[serde(default)]
    #[allow(dead_code)]
    task_id: Option<String>,
    #[serde(default)]
    base_git_head: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodePatchApprovalRequest {
    approval_id: String,
    proposal_id: String,
    workspace_path: String,
    changed_files: Vec<String>,
    patch_hash: String,
    #[serde(default)]
    #[allow(dead_code)]
    task_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    locale: Option<String>,
}

#[derive(Clone)]
struct FileContentHash {
    path: String,
    hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeApplyResult {
    applied: bool,
    workspace_path: String,
    changed_files: Vec<String>,
    message: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeProposeEditRequest {
    workspace_path: String,
    user_goal: String,
    changed_files: Vec<String>,
    diff: String,
    provider_id: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    api_key_reference: Option<String>,
    base_url: Option<String>,
    #[serde(default)]
    locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelCompletionRequest {
    prompt: String,
    provider_id: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    api_key_reference: Option<String>,
    base_url: Option<String>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    stop_sequences: Option<Vec<String>>,
    #[serde(default)]
    locale: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCompletionResponse {
    text: String,
    model: Option<String>,
    provider: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCompletionChunk {
    text: String,
    model: Option<String>,
    provider: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelApiKeySecretRequest {
    key_reference: String,
    api_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendTaskAuditJsonLineRequest {
    line: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeProposedEdit {
    proposal_id: String,
    workspace_path: String,
    summary: String,
    changed_files: Vec<String>,
    patch: String,
    patch_hash: String,
    #[serde(default)]
    base_git_head: Option<String>,
    #[serde(default)]
    hunks: Option<Vec<CodeProposalHunk>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeProposalHunk {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    header: String,
    diff: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCodeProposal {
    summary: String,
    changed_files: Vec<String>,
    patch: String,
}

#[derive(Default)]
struct RawCodeProposalParts {
    summary: Option<String>,
    changed_files: Option<Vec<String>>,
    patch: Option<String>,
}

#[derive(Default)]
struct PdfOrganizationApprovalState {
    pending: Option<PendingPdfOrganizationApproval>,
}

struct PendingPdfOrganizationApproval {
    binding: NativeApprovalBinding,
    operations: Vec<PlannedPathOperation>,
}

#[derive(Default)]
struct CodePatchApprovalState {
    pending: Option<PendingCodePatchApproval>,
}

struct PendingCodePatchApproval {
    binding: NativeApprovalBinding,
    proposal_id: String,
    workspace_path: String,
    changed_files: Vec<String>,
    patch_hash: String,
    file_hashes: Vec<FileContentHash>,
}

struct NativeApprovalBinding {
    approval_id: String,
    tool_name: String,
    #[allow(dead_code)]
    task_id: String,
    preview_hash: String,
    approved: bool,
}

#[tauri::command]
fn scan_markdown_documents(
    workspace_path: Option<String>,
) -> Result<Vec<MarkdownDocument>, String> {
    let workspace = resolve_workspace_path(workspace_path)?;
    let mut documents = Vec::new();
    scan_directory(&workspace, &workspace, &mut documents)?;
    documents.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    documents.truncate(50);
    Ok(documents)
}

#[tauri::command]
fn plan_pdf_organization(
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
fn approve_pdf_organization(
    approval_id: String,
    #[allow(unused_variables)] task_id: Option<String>,
    approval_state: tauri::State<'_, Mutex<PdfOrganizationApprovalState>>,
) -> Result<(), String> {
    approve_pending_pdf_organization(&approval_state, &approval_id, task_id.as_deref())
}

#[tauri::command]
fn restore_pdf_organization_approval(
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
fn approve_code_patch(
    request: CodePatchApprovalRequest,
    approval_state: tauri::State<'_, Mutex<CodePatchApprovalState>>,
) -> Result<(), String> {
    approve_pending_code_patch(&approval_state, request)
}

#[tauri::command]
fn execute_pdf_organization(
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

#[tauri::command]
fn run_read_only_command(request: ShellCommandRequest) -> Result<ShellCommandOutput, String> {
    if !is_allowed_read_only_command(&request.program, &request.args) {
        return Err("Command is not in the first-version read-only allowlist.".to_string());
    }

    let cwd = resolve_workspace_path(request.workspace_path)?;
    let output = run_read_only_command_output(&request.program, &request.args, &cwd)?;

    Ok(ShellCommandOutput {
        command: format!("{} {}", request.program, request.args.join(" "))
            .trim()
            .to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn run_read_only_command_output(
    program: &str,
    args: &[String],
    cwd: &Path,
) -> Result<std::process::Output, String> {
    let executable = resolve_command_program(program);
    let mut output = Command::new(&executable)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|error| error.to_string())?;
    if is_retryable_windows_process_initialization_exit(output.status.code()) {
        output = Command::new(&executable)
            .args(args)
            .current_dir(cwd)
            .output()
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
}

fn is_retryable_windows_process_initialization_exit(exit_code: Option<i32>) -> bool {
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

#[tauri::command]
fn fetch_web_source(request: WebSourceRequest) -> Result<WebSource, String> {
    if !request.url.starts_with("https://") && !request.url.starts_with("http://") {
        return Err("Only http and https URLs are supported.".to_string());
    }

    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut response = agent
        .get(&request.url)
        .header("User-Agent", "Javis/0.1")
        .call()
        .map_err(|error| error.to_string())?;
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|error| error.to_string())?;
    let plain_text = html_to_text(&body);

    Ok(WebSource {
        url: request.url,
        title: extract_title(&body),
        excerpt: plain_text.chars().take(600).collect(),
        fetched_at: format_system_time(SystemTime::now()),
    })
}

#[tauri::command]
fn search_web_sources(request: WebSearchRequest) -> Result<Vec<WebSearchResult>, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Err("Search query cannot be empty.".to_string());
    }
    let max_results = request.max_results.unwrap_or(3).clamp(1, 10);

    // QA-only fixture hook for repeatable release screenshots. It requires a
    // second explicit mode flag so a stale fixture path cannot silently replace
    // normal product search.
    if env_flag_enabled("JAVIS_QA_MODE") {
        if let Some(path) = env::var_os("JAVIS_SEARCH_FIXTURE_PATH").map(PathBuf::from) {
            return search_with_fixture_file(&path, max_results);
        }
    } else if env::var_os("JAVIS_SEARCH_FIXTURE_PATH").is_some() {
        return Err("Search fixtures require JAVIS_QA_MODE=1.".to_string());
    }

    if env_flag_enabled("JAVIS_SEARCH_DISABLE_GITHUB_CLI") {
        return search_with_agent_chrome(query, max_results).map_err(|error| {
            format!("GitHub CLI search disabled; Chrome fallback failed: {error}")
        });
    }

    match search_with_github_cli(query, max_results) {
        Ok(results) if !results.is_empty() => Ok(results),
        Ok(_) => search_with_agent_chrome(query, max_results)
            .map_err(|error| format!("GitHub CLI returned no results; Chrome fallback failed: {error}")),
        Err(primary_error) => search_with_agent_chrome(query, max_results).map_err(|fallback_error| {
            format!(
                "GitHub CLI search failed: {primary_error}; Chrome fallback failed: {fallback_error}"
            )
        }),
    }
}

fn env_flag_enabled(name: &str) -> bool {
    env::var(name)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

fn search_with_fixture_file(
    path: &Path,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, String> {
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut results = serde_json::from_str::<Vec<WebSearchResult>>(&content)
        .map_err(|error| format!("Search fixture returned invalid JSON: {error}"))?;
    results.truncate(max_results);
    Ok(results)
}

#[tauri::command]
fn inspect_project(workspace_path: Option<String>) -> Result<ProjectInspection, String> {
    let workspace = resolve_workspace_path(workspace_path)?;
    let package_json_path = workspace.join("package.json");
    if !package_json_path.exists() {
        return Err(format!(
            "Selected workspace does not contain package.json: {}",
            workspace.to_string_lossy()
        ));
    }
    let package_json = fs::read_to_string(&package_json_path).map_err(|error| {
        format!(
            "Could not read package.json in selected workspace {}: {error}",
            workspace.to_string_lossy()
        )
    })?;
    let value = serde_json::from_str::<serde_json::Value>(&package_json)
        .map_err(|error| error.to_string())?;
    let scripts = value
        .get("scripts")
        .and_then(|scripts| scripts.as_object())
        .map(|scripts| {
            scripts
                .iter()
                .filter_map(|(name, command)| {
                    command.as_str().map(|command| ProjectScript {
                        name: name.clone(),
                        command: command.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let package_manager = detect_package_manager(&workspace);
    let runner = package_manager.as_deref().unwrap_or("pnpm");

    Ok(ProjectInspection {
        workspace_path: workspace.to_string_lossy().to_string(),
        recommended_start_command: recommend_script(&scripts, runner, &["dev", "start"]),
        recommended_test_command: recommend_script(&scripts, runner, &["typecheck", "test"]),
        package_manager,
        scripts,
    })
}

#[tauri::command]
fn apply_code_patch(
    request: CodePatchApplyRequest,
    approval_state: tauri::State<'_, Mutex<CodePatchApprovalState>>,
) -> Result<CodeApplyResult, String> {
    let workspace = resolve_workspace_path(Some(request.workspace_path.clone()))?;
    apply_code_patch_in_workspace(&workspace, request, Some(&approval_state))
}

#[tauri::command]
fn save_model_api_key_secret(
    app: AppHandle,
    request: ModelApiKeySecretRequest,
) -> Result<(), String> {
    save_model_api_key_secret_for_app(&app, &request.key_reference, &request.api_key)
}

#[tauri::command]
fn delete_model_api_key_secret(app: AppHandle, key_reference: String) -> Result<(), String> {
    delete_model_api_key_secret_for_app(&app, &key_reference)
}

#[tauri::command]
fn propose_code_edit(
    app: AppHandle,
    mut request: CodeProposeEditRequest,
) -> Result<CodeProposedEdit, String> {
    let workspace = resolve_workspace_path(Some(request.workspace_path.clone()))?;
    if !env_flag_enabled("JAVIS_QA_MODE")
        || env::var_os("JAVIS_CODE_PROPOSAL_FIXTURE_PATH").is_none()
    {
        hydrate_model_api_key_secret(&app, &mut request)?;
    }
    propose_code_edit_with_opencode(&workspace, request)
}

#[tauri::command]
fn complete_model_prompt(
    app: AppHandle,
    mut request: ModelCompletionRequest,
) -> Result<ModelCompletionResponse, String> {
    hydrate_model_completion_api_key_secret(&app, &mut request)?;
    run_openai_compatible_completion_request(&request)
}

#[tauri::command]
fn stream_model_prompt(
    app: AppHandle,
    mut request: ModelCompletionRequest,
) -> Result<Vec<ModelCompletionChunk>, String> {
    hydrate_model_completion_api_key_secret(&app, &mut request)?;
    run_openai_compatible_stream_request(&request)
}

fn is_allowed_read_only_command(program: &str, args: &[String]) -> bool {
    let normalized_program = program.to_ascii_lowercase();
    let normalized_args = args.iter().map(String::as_str).collect::<Vec<_>>();

    matches!(
        (normalized_program.as_str(), normalized_args.as_slice()),
        ("node", ["--version"])
            | ("pnpm", ["--version"])
            | ("pnpm", ["typecheck"])
            | ("pnpm", ["test"])
            | ("npm", ["run", "typecheck"])
            | ("npm", ["test"])
            | ("yarn", ["typecheck"])
            | ("yarn", ["test"])
            | ("cargo", ["--version"])
            | ("git", ["status", "--short"])
            | ("git", ["diff", "--stat"])
            | ("git", ["diff", "--unified=1"])
            | ("git", ["diff", "--check"])
    )
}

#[cfg(windows)]
fn resolve_command_program(program: &str) -> String {
    match program.to_ascii_lowercase().as_str() {
        "npm" | "pnpm" | "yarn" => format!("{program}.cmd"),
        _ => program.to_string(),
    }
}

#[cfg(not(windows))]
fn resolve_command_program(program: &str) -> String {
    program.to_string()
}

fn resolve_workspace_path(workspace_path: Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = workspace_path {
        let trimmed_path = path.trim();
        if trimmed_path.is_empty() {
            return Err("Workspace path cannot be empty.".to_string());
        }
        let workspace = fs::canonicalize(trimmed_path).map_err(|error| {
            format!("Selected workspace path is not accessible: {trimmed_path}: {error}")
        })?;
        if !workspace.is_dir() {
            return Err(format!(
                "Selected workspace path is not a directory: {}",
                workspace.to_string_lossy()
            ));
        }
        return Ok(workspace);
    }

    let current_dir = std::env::current_dir().map_err(|error| error.to_string())?;
    for candidate in current_dir.ancestors() {
        if candidate.join("pnpm-workspace.yaml").exists() {
            return Ok(candidate.to_path_buf());
        }
    }

    Ok(current_dir)
}

fn detect_package_manager(workspace: &Path) -> Option<String> {
    if workspace.join("pnpm-lock.yaml").exists() {
        return Some("pnpm".to_string());
    }
    if workspace.join("yarn.lock").exists() {
        return Some("yarn".to_string());
    }
    if workspace.join("package-lock.json").exists() {
        return Some("npm".to_string());
    }
    None
}

fn recommend_script(scripts: &[ProjectScript], runner: &str, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        scripts
            .iter()
            .any(|script| script.name == *name)
            .then(|| format!("{} {}", runner, name))
    })
}

#[cfg(windows)]
fn save_model_api_key_secret_for_app(
    app: &AppHandle,
    key_reference: &str,
    api_key: &str,
) -> Result<(), String> {
    let key_reference = normalize_model_api_key_reference(key_reference)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return delete_model_api_key_secret_for_app(app, &key_reference);
    }
    let path = model_api_key_secret_path(app, &key_reference)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create model secret directory: {error}"))?;
    }
    fs::write(&path, protect_model_api_key_secret(api_key)?)
        .map_err(|error| format!("Could not save model API key secret: {error}"))
}

#[cfg(windows)]
fn delete_model_api_key_secret_for_app(app: &AppHandle, key_reference: &str) -> Result<(), String> {
    let key_reference = normalize_model_api_key_reference(key_reference)?;
    let path = model_api_key_secret_path(app, &key_reference)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not delete model API key secret: {error}")),
    }
}

fn hydrate_model_api_key_secret(
    app: &AppHandle,
    request: &mut CodeProposeEditRequest,
) -> Result<(), String> {
    if normalize_optional_config_value(request.api_key.as_deref()).is_some() {
        return Ok(());
    }
    let Some(key_reference) = normalize_optional_config_value(request.api_key_reference.as_deref())
    else {
        return Ok(());
    };
    request.api_key = Some(load_model_api_key_secret_for_app(app, &key_reference)?);
    Ok(())
}

pub(crate) fn hydrate_model_completion_api_key_secret(
    app: &AppHandle,
    request: &mut ModelCompletionRequest,
) -> Result<(), String> {
    if normalize_optional_config_value(request.api_key.as_deref()).is_some() {
        return Ok(());
    }
    let Some(key_reference) = normalize_optional_config_value(request.api_key_reference.as_deref())
    else {
        return Ok(());
    };
    request.api_key = Some(load_model_api_key_secret_for_app(app, &key_reference)?);
    Ok(())
}

#[cfg(windows)]
fn load_model_api_key_secret_for_app(
    app: &AppHandle,
    key_reference: &str,
) -> Result<String, String> {
    let key_reference = normalize_model_api_key_reference(key_reference)?;
    let path = model_api_key_secret_path(app, &key_reference)?;
    let secret = fs::read_to_string(&path)
        .map_err(|error| format!("Could not read model API key secret: {error}"))?;
    unprotect_model_api_key_secret(secret.trim())
}

fn model_api_key_secret_path(app: &AppHandle, key_reference: &str) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(data_dir
        .join("secrets")
        .join("model-api-keys")
        .join(format!("{key_reference}.secret")))
}

fn normalize_model_api_key_reference(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Model API key reference is required.".to_string());
    }
    if value == MODEL_API_KEY_SECRET_REFERENCE {
        return Ok(value.to_string());
    }
    Err("Unknown model API key reference.".to_string())
}

#[cfg(windows)]
fn protect_model_api_key_secret(secret: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: secret.as_bytes().len() as u32,
        pbData: secret.as_bytes().as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("Could not protect model API key secret.".to_string());
    }
    let protected = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = STANDARD.encode(protected);
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(format!("{MODEL_API_KEY_SECRET_PREFIX}{encoded}"))
}

#[cfg(windows)]
fn unprotect_model_api_key_secret(secret: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let encoded = secret
        .strip_prefix(MODEL_API_KEY_SECRET_PREFIX)
        .ok_or_else(|| "Model API key secret is not protected.".to_string())?;
    let protected = STANDARD
        .decode(encoded)
        .map_err(|error| format!("Model API key secret is invalid: {error}"))?;
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("Could not unprotect model API key secret.".to_string());
    }
    let unprotected = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let text = String::from_utf8(unprotected.to_vec())
        .map_err(|error| format!("Model API key secret is not valid UTF-8: {error}"));
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    text
}

#[cfg(not(windows))]
fn protect_model_api_key_secret(_secret: &str) -> Result<String, String> {
    Ok("keyring-v1:stored-in-os-credential-store".to_string())
}

#[cfg(not(windows))]
fn unprotect_model_api_key_secret(marker: &str) -> Result<String, String> {
    if marker.starts_with("keyring-v1:") {
        Err("Model API key must be read from the OS credential store.".to_string())
    } else {
        Ok(marker.to_string())
    }
}

#[cfg(not(windows))]
fn save_model_api_key_secret_for_app(
    _app: &AppHandle,
    key_reference: &str,
    api_key: &str,
) -> Result<(), String> {
    let store = OsModelApiKeySecretStore;
    save_model_api_key_secret_with_store(&store, key_reference, api_key)
}

#[cfg(not(windows))]
trait ModelApiKeySecretStore {
    fn save(&self, key_reference: &str, api_key: &str) -> Result<(), String>;
    fn load(&self, key_reference: &str) -> Result<String, String>;
    fn delete(&self, key_reference: &str) -> Result<(), String>;
}

#[cfg(not(windows))]
struct OsModelApiKeySecretStore;

#[cfg(not(windows))]
impl ModelApiKeySecretStore for OsModelApiKeySecretStore {
    fn save(&self, key_reference: &str, api_key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new("javis-model-api-key", key_reference)
            .map_err(|error| format!("Could not access OS credential store: {error}"))?;
        entry.set_password(api_key).map_err(|error| {
            format!("Could not save model API key to OS credential store: {error}")
        })
    }

    fn load(&self, key_reference: &str) -> Result<String, String> {
        let entry = keyring::Entry::new("javis-model-api-key", key_reference)
            .map_err(|error| format!("Could not access OS credential store: {error}"))?;
        entry.get_password().map_err(|error| {
            format!("Could not read model API key from OS credential store: {error}")
        })
    }

    fn delete(&self, key_reference: &str) -> Result<(), String> {
        let entry = keyring::Entry::new("javis-model-api-key", key_reference)
            .map_err(|error| format!("Could not access OS credential store: {error}"))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!(
                "Could not delete model API key from OS credential store: {error}"
            )),
        }
    }
}

#[cfg(not(windows))]
fn save_model_api_key_secret_with_store(
    store: &impl ModelApiKeySecretStore,
    key_reference: &str,
    api_key: &str,
) -> Result<(), String> {
    let key_reference = normalize_model_api_key_reference(key_reference)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return store.delete(&key_reference);
    }
    store.save(&key_reference, api_key)
}

#[cfg(not(windows))]
fn load_model_api_key_secret_for_app(
    _app: &AppHandle,
    key_reference: &str,
) -> Result<String, String> {
    let store = OsModelApiKeySecretStore;
    load_model_api_key_secret_with_store(&store, key_reference)
}

#[cfg(not(windows))]
fn load_model_api_key_secret_with_store(
    store: &impl ModelApiKeySecretStore,
    key_reference: &str,
) -> Result<String, String> {
    let key_reference = normalize_model_api_key_reference(key_reference)?;
    store.load(&key_reference)
}

#[cfg(not(windows))]
fn delete_model_api_key_secret_for_app(
    _app: &AppHandle,
    key_reference: &str,
) -> Result<(), String> {
    let store = OsModelApiKeySecretStore;
    delete_model_api_key_secret_with_store(&store, key_reference)
}

#[cfg(not(windows))]
fn delete_model_api_key_secret_with_store(
    store: &impl ModelApiKeySecretStore,
    key_reference: &str,
) -> Result<(), String> {
    let key_reference = normalize_model_api_key_reference(key_reference)?;
    store.delete(&key_reference)
}

fn propose_code_edit_with_opencode(
    workspace: &Path,
    request: CodeProposeEditRequest,
) -> Result<CodeProposedEdit, String> {
    let canonical_workspace = fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace is not accessible: {error}"))?;
    if request.user_goal.trim().is_empty() {
        return Err("Code proposal goal cannot be empty.".to_string());
    }
    if request.diff.trim().is_empty() {
        return Err("Code proposal requires a non-empty diff preview.".to_string());
    }
    let requested_changed_files = request
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;
    require_approved_relative_paths(
        &canonical_workspace,
        &requested_changed_files,
        &requested_changed_files,
        "Code proposal includes a file outside the approved diff",
        "Changed file path must stay inside the selected workspace.",
    )?;

    if env_flag_enabled("JAVIS_QA_MODE") {
        if let Some(path) = env::var_os("JAVIS_CODE_PROPOSAL_FIXTURE_PATH").map(PathBuf::from) {
            let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
            return parse_code_proposal_from_text_for_request(
                &canonical_workspace,
                &content,
                &request,
            );
        }
    } else if env::var_os("JAVIS_CODE_PROPOSAL_FIXTURE_PATH").is_some() {
        return Err("Code proposal fixtures require JAVIS_QA_MODE=1.".to_string());
    }

    let prompt = create_opencode_proposal_prompt(&request);
    let output = match run_opencode_proposal_command(&canonical_workspace, &prompt, &request) {
        Ok(output) => output,
        Err(error)
            if should_fallback_to_openai_compatible(&request)
                && can_fallback_from_opencode_error(&error) =>
        {
            run_openai_compatible_proposal_request(&request, &prompt)?
        }
        Err(error) => return Err(error),
    };
    match parse_code_proposal_from_text_for_request(&canonical_workspace, &output, &request) {
        Ok(proposal) => Ok(proposal),
        Err(error) if should_fallback_to_openai_compatible(&request) => {
            let fallback_output = run_openai_compatible_proposal_request(&request, &prompt)?;
            parse_code_proposal_from_text_for_request(
                &canonical_workspace,
                &fallback_output,
                &request,
            )
            .map_err(|fallback_error| format!("{error}; fallback failed: {fallback_error}"))
        }
        Err(error) => Err(error),
    }
}

fn run_opencode_proposal_command(
    workspace: &Path,
    prompt: &str,
    request: &CodeProposeEditRequest,
) -> Result<String, String> {
    let opencode = resolve_opencode_program();
    let invocation = create_opencode_proposal_invocation(workspace, prompt, request)
        .map_err(|error| format!("opencode proposal configuration error: {error}"))?;
    let output = Command::new(&opencode)
        .args(&invocation.args)
        .current_dir(workspace)
        .env("OPENCODE_CONFIG_CONTENT", invocation.config_content)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|child| wait_with_timeout(child, OPENCODE_PROPOSAL_TIMEOUT))
        .map_err(|error| format!("opencode is unavailable at {}: {error}", opencode.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "opencode proposal command failed without stderr.".to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn wait_with_timeout(mut child: Child, timeout: Duration) -> std::io::Result<Output> {
    let started = SystemTime::now();
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if started
            .elapsed()
            .map(|elapsed| elapsed >= timeout)
            .unwrap_or(false)
        {
            child.kill()?;
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!(
                    "opencode proposal command timed out after {} seconds",
                    timeout.as_secs()
                ),
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

struct OpencodeProposalInvocation {
    args: Vec<String>,
    config_content: String,
}

fn create_opencode_proposal_invocation(
    workspace: &Path,
    prompt: &str,
    request: &CodeProposeEditRequest,
) -> Result<OpencodeProposalInvocation, String> {
    let mut args = vec![
        "run".to_string(),
        "--pure".to_string(),
        "--dir".to_string(),
        workspace
            .to_str()
            .ok_or_else(|| "Workspace path is not valid UTF-8.".to_string())?
            .to_string(),
        "--format".to_string(),
        "json".to_string(),
    ];
    if let Some(model) = normalize_opencode_model_id(request)? {
        args.push("--model".to_string());
        args.push(model);
    }
    args.push(prompt.to_string());

    Ok(OpencodeProposalInvocation {
        args,
        config_content: create_opencode_config_content(request)?,
    })
}

fn create_opencode_config_content(request: &CodeProposeEditRequest) -> Result<String, String> {
    let mut config = serde_json::json!({
        "permission": {
            "edit": "deny",
            "bash": "deny",
            "webfetch": "deny"
        }
    });
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref());
    let api_key = normalize_optional_config_value(request.api_key.as_deref());
    let base_url = normalize_optional_config_value(request.base_url.as_deref());

    if provider_id.is_none() && api_key.is_none() && base_url.is_none() {
        return serde_json::to_string(&config).map_err(|error| error.to_string());
    }

    let provider_id = provider_id.unwrap_or_else(|| infer_provider_id_from_model(request));
    validate_opencode_config_id(&provider_id)?;
    let mut options = serde_json::Map::new();
    if let Some(api_key) = api_key {
        options.insert("apiKey".to_string(), serde_json::Value::String(api_key));
    }
    if let Some(base_url) = base_url {
        options.insert("baseURL".to_string(), serde_json::Value::String(base_url));
    }

    let provider_config = if provider_id == "custom" {
        let model_name = normalize_openai_compatible_model_name(request)
            .unwrap_or_else(|| "default".to_string());
        validate_opencode_config_id(&model_name)?;
        serde_json::json!({
            "npm": "@ai-sdk/openai-compatible",
            "name": "Custom OpenAI Compatible",
            "options": options,
            "models": {
                model_name.clone(): {
                    "name": model_name
                }
            }
        })
    } else {
        serde_json::json!({
            "options": options
        })
    };

    config["provider"] = serde_json::json!({
        provider_id: provider_config
    });
    serde_json::to_string(&config).map_err(|error| error.to_string())
}

fn infer_provider_id_from_model(request: &CodeProposeEditRequest) -> String {
    normalize_optional_config_value(request.model.as_deref())
        .and_then(|model| {
            model
                .split_once('/')
                .map(|(provider, _)| provider.to_string())
        })
        .unwrap_or_else(|| default_provider_for_locale(request.locale.as_deref()))
}

fn default_provider_for_locale(locale: Option<&str>) -> String {
    if locale.is_some_and(|locale| locale.starts_with("zh")) {
        "deepseek".to_string()
    } else {
        "openai".to_string()
    }
}

fn default_model_for_locale(locale: Option<&str>) -> String {
    if locale.is_some_and(|locale| locale.starts_with("zh")) {
        "deepseek-chat".to_string()
    } else {
        "gpt-4.1".to_string()
    }
}

fn normalize_opencode_model_id(request: &CodeProposeEditRequest) -> Result<Option<String>, String> {
    let Some(model) = normalize_optional_config_value(request.model.as_deref()) else {
        return Ok(None);
    };
    if model.contains('/') {
        return Ok(Some(model));
    }
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_provider_id_from_model(request));
    validate_opencode_config_id(&provider_id)?;
    validate_opencode_config_id(&model)?;
    Ok(Some(format!("{provider_id}/{model}")))
}

fn normalize_openai_compatible_model_name(request: &CodeProposeEditRequest) -> Option<String> {
    let model = normalize_optional_config_value(request.model.as_deref())
        .or_else(|| Some(default_model_for_locale(request.locale.as_deref())));
    model.map(|model| {
        model
            .split_once('/')
            .map(|(_, name)| name.to_string())
            .unwrap_or(model)
    })
}

pub(crate) fn normalize_optional_config_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn validate_opencode_config_id(value: &str) -> Result<(), String> {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Ok(());
    }

    Err(format!("Invalid opencode provider or model id: {value}"))
}

fn should_fallback_to_openai_compatible(request: &CodeProposeEditRequest) -> bool {
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_provider_id_from_model(request));
    let has_credentials = normalize_optional_config_value(request.api_key.as_deref()).is_some();
    let has_custom_base_url =
        normalize_optional_config_value(request.base_url.as_deref()).is_some();
    has_credentials && (provider_id == "deepseek" || provider_id == "custom" && has_custom_base_url)
}

fn can_fallback_from_opencode_error(error: &str) -> bool {
    !error.starts_with("opencode proposal configuration error:")
}

fn run_openai_compatible_proposal_request(
    request: &CodeProposeEditRequest,
    prompt: &str,
) -> Result<String, String> {
    let api_key = normalize_optional_config_value(request.api_key.as_deref())
        .ok_or_else(|| "OpenAI-compatible fallback requires an API key.".to_string())?;
    let model = normalize_openai_compatible_model_name(request)
        .ok_or_else(|| "OpenAI-compatible fallback requires a model.".to_string())?;
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_openai_compatible_base_url(request));
    let endpoint = create_chat_completions_endpoint(&base_url);
    let body = create_openai_compatible_proposal_body(&model, prompt);
    let body_text = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(OPENCODE_PROPOSAL_TIMEOUT))
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut response = agent
        .post(&endpoint)
        .header("Authorization", &format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .send(&body_text)
        .map_err(|error| format!("OpenAI-compatible proposal fallback failed: {error}"))?;
    let response_text = response.body_mut().read_to_string().map_err(|error| {
        format!("OpenAI-compatible proposal fallback could not read response: {error}")
    })?;
    let value = serde_json::from_str::<serde_json::Value>(&response_text).map_err(|error| {
        format!(
            "OpenAI-compatible proposal fallback returned invalid JSON: {error}; {}",
            create_provider_response_diagnostic(request, &endpoint, &response_text)
        )
    })?;
    let content_value = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"));
    let Some(content_value) = content_value else {
        return Err(format!(
            "OpenAI-compatible proposal fallback returned no message content. {}",
            create_provider_response_diagnostic(request, &endpoint, &response_text)
        ));
    };
    let content = content_value
        .as_str()
        .map(str::to_string)
        .or_else(|| serde_json::to_string(content_value).ok())
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| {
            format!(
                "OpenAI-compatible proposal fallback returned empty message content. {}",
                create_provider_response_diagnostic(request, &endpoint, &response_text)
            )
        })?;
    Ok(content)
}

fn create_openai_compatible_proposal_body(model: &str, prompt: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "Return only the requested JSON object. Do not include markdown fences or explanation."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "stream": false,
        "response_format": {
            "type": "json_object"
        },
        "temperature": 0,
        "max_tokens": 4096,
        "thinking": {
            "type": "disabled"
        }
    })
}

fn run_openai_compatible_completion_request(
    request: &ModelCompletionRequest,
) -> Result<ModelCompletionResponse, String> {
    let api_key = normalize_optional_config_value(request.api_key.as_deref())
        .ok_or_else(|| "Model completion requires an API key.".to_string())?;
    let model = normalize_model_completion_model_name(request)
        .ok_or_else(|| "Model completion requires a model.".to_string())?;
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_model_completion_provider_id(request));
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_openai_compatible_base_url_for_provider(&provider_id));
    let endpoint = create_chat_completions_endpoint(&base_url);
    let body = create_openai_compatible_completion_body(&model, request);
    let body_text = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(OPENCODE_PROPOSAL_TIMEOUT))
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut response = agent
        .post(&endpoint)
        .header("Authorization", &format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .send(&body_text)
        .map_err(|error| format!("Model completion request failed: {error}"))?;
    let response_text = response
        .body_mut()
        .read_to_string()
        .map_err(|error| format!("Model completion could not read response: {error}"))?;
    let value = serde_json::from_str::<serde_json::Value>(&response_text).map_err(|error| {
        format!(
            "Model completion returned invalid JSON: {error}; {}",
            create_model_completion_response_diagnostic(
                &provider_id,
                &model,
                &endpoint,
                &response_text
            )
        )
    })?;
    let content_value = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"));
    let Some(content_value) = content_value else {
        return Err(format!(
            "Model completion returned no message content. {}",
            create_model_completion_response_diagnostic(
                &provider_id,
                &model,
                &endpoint,
                &response_text
            )
        ));
    };
    let text = content_value
        .as_str()
        .map(str::to_string)
        .or_else(|| serde_json::to_string(content_value).ok())
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| {
            format!(
                "Model completion returned empty message content. {}",
                create_model_completion_response_diagnostic(
                    &provider_id,
                    &model,
                    &endpoint,
                    &response_text
                )
            )
        })?;
    Ok(ModelCompletionResponse {
        text,
        model: Some(model),
        provider: Some(provider_id),
    })
}

fn run_openai_compatible_stream_request(
    request: &ModelCompletionRequest,
) -> Result<Vec<ModelCompletionChunk>, String> {
    let api_key = normalize_optional_config_value(request.api_key.as_deref())
        .ok_or_else(|| "Model stream requires an API key.".to_string())?;
    let model = normalize_model_completion_model_name(request)
        .ok_or_else(|| "Model stream requires a model.".to_string())?;
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_model_completion_provider_id(request));
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_openai_compatible_base_url_for_provider(&provider_id));
    let endpoint = create_chat_completions_endpoint(&base_url);
    let body = create_openai_compatible_stream_body(&model, request);
    let body_text = serde_json::to_string(&body).map_err(|error| error.to_string())?;
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(OPENCODE_PROPOSAL_TIMEOUT))
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut response = agent
        .post(&endpoint)
        .header("Authorization", &format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .send(&body_text)
        .map_err(|error| format!("Model stream request failed: {error}"))?;
    let response_text = response
        .body_mut()
        .read_to_string()
        .map_err(|error| format!("Model stream could not read response: {error}"))?;
    parse_openai_compatible_stream_chunks(&response_text, &provider_id, &model, &endpoint)
}

fn create_openai_compatible_completion_body(
    model: &str,
    request: &ModelCompletionRequest,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": request.prompt
            }
        ],
        "stream": false,
        "temperature": request.temperature.unwrap_or(0.2),
        "max_tokens": request.max_tokens.unwrap_or(2048)
    });
    append_completion_stop_sequences(&mut body, request);
    body
}

pub(crate) fn create_openai_compatible_stream_body(
    model: &str,
    request: &ModelCompletionRequest,
) -> serde_json::Value {
    let mut body = create_openai_compatible_completion_body(model, request);
    body["stream"] = serde_json::Value::Bool(true);
    body
}

fn append_completion_stop_sequences(
    body: &mut serde_json::Value,
    request: &ModelCompletionRequest,
) {
    let Some(stop_sequences) = &request.stop_sequences else {
        return;
    };
    let stop = stop_sequences
        .iter()
        .filter(|sequence| !sequence.is_empty())
        .map(|sequence| serde_json::Value::String(sequence.clone()))
        .collect::<Vec<_>>();
    if !stop.is_empty() {
        body["stop"] = serde_json::Value::Array(stop);
    }
}

fn parse_openai_compatible_stream_chunks(
    response_text: &str,
    provider_id: &str,
    model: &str,
    endpoint: &str,
) -> Result<Vec<ModelCompletionChunk>, String> {
    let mut chunks = Vec::new();
    for line in response_text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }
        let data = trimmed.trim_start_matches("data:").trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let value = serde_json::from_str::<serde_json::Value>(data).map_err(|error| {
            format!(
                "Model stream returned invalid JSON chunk: {error}; {}",
                create_model_completion_response_diagnostic(provider_id, model, endpoint, data)
            )
        })?;
        if let Some(text) = extract_openai_compatible_stream_text(&value) {
            chunks.push(ModelCompletionChunk {
                text,
                model: Some(model.to_string()),
                provider: Some(provider_id.to_string()),
            });
        }
    }
    if chunks.is_empty() {
        return Err(format!(
            "Model stream returned no content chunks. {}",
            create_model_completion_response_diagnostic(
                provider_id,
                model,
                endpoint,
                response_text
            )
        ));
    }
    Ok(chunks)
}

pub(crate) fn extract_openai_compatible_stream_text(value: &serde_json::Value) -> Option<String> {
    let choice = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())?;
    choice
        .get("delta")
        .and_then(|delta| delta.get("content"))
        .or_else(|| {
            choice
                .get("message")
                .and_then(|message| message.get("content"))
        })
        .and_then(|content| content.as_str())
        .map(str::to_string)
        .filter(|content| !content.is_empty())
}

pub(crate) fn normalize_model_completion_model_name(request: &ModelCompletionRequest) -> Option<String> {
    let model = normalize_optional_config_value(request.model.as_deref())
        .or_else(|| Some(default_model_for_locale(request.locale.as_deref())));
    model.map(|model| {
        model
            .split_once('/')
            .map(|(_, name)| name.to_string())
            .unwrap_or(model)
    })
}

pub(crate) fn infer_model_completion_provider_id(request: &ModelCompletionRequest) -> String {
    normalize_optional_config_value(request.model.as_deref())
        .and_then(|model| {
            model
                .split_once('/')
                .map(|(provider, _)| provider.to_string())
        })
        .unwrap_or_else(|| default_provider_for_locale(request.locale.as_deref()))
}

pub(crate) fn default_openai_compatible_base_url_for_provider(provider_id: &str) -> String {
    match provider_id {
        "deepseek" => "https://api.deepseek.com".to_string(),
        _ => "https://api.openai.com/v1".to_string(),
    }
}

fn create_model_completion_response_diagnostic(
    provider_id: &str,
    model: &str,
    endpoint: &str,
    body: &str,
) -> String {
    let body_hash = create_fnv1a_hash(body.as_bytes());
    let body_preview = summarize_provider_output_for_error(body);
    format!(
        "provider={provider_id}; model={model}; endpointHost={}; bodyHash={body_hash}; bodyPreview={body_preview}",
        extract_url_host(endpoint)
    )
}

fn default_openai_compatible_base_url(request: &CodeProposeEditRequest) -> String {
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_provider_id_from_model(request));
    match provider_id.as_str() {
        "deepseek" => "https://api.deepseek.com".to_string(),
        _ => "https://api.openai.com/v1".to_string(),
    }
}

pub(crate) fn create_chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        return trimmed.to_string();
    }
    format!("{trimmed}/chat/completions")
}

fn create_provider_response_diagnostic(
    request: &CodeProposeEditRequest,
    endpoint: &str,
    body: &str,
) -> String {
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_provider_id_from_model(request));
    let model =
        normalize_openai_compatible_model_name(request).unwrap_or_else(|| "unknown".to_string());
    let body_hash = create_fnv1a_hash(body.as_bytes());
    let body_preview = summarize_provider_output_for_error(body);
    format!(
        "provider={provider_id}; model={model}; endpointHost={}; bodyHash={body_hash}; bodyPreview={body_preview}",
        extract_url_host(endpoint)
    )
}

fn extract_url_host(url: &str) -> String {
    url.split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("unknown")
        .to_string()
}

fn resolve_opencode_program() -> PathBuf {
    bundled_opencode_candidates()
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(resolve_command_program("opencode")))
}

fn bundled_opencode_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe_path) = env::current_exe() {
        candidates.extend(opencode_candidates_near_executable(&exe_path));
    }
    if let Ok(current_dir) = env::current_dir() {
        for ancestor in current_dir.ancestors() {
            candidates.push(
                ancestor
                    .join("node_modules/.pnpm/opencode-windows-x64@1.15.10/node_modules/opencode-windows-x64/bin/opencode.exe"),
            );
            candidates.push(
                ancestor
                    .join("node_modules/.pnpm/opencode-windows-x64-baseline@1.15.10/node_modules/opencode-windows-x64-baseline/bin/opencode.exe"),
            );
        }
    }
    candidates
}

fn opencode_candidates_near_executable(exe_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = exe_path.parent() {
        for base in [exe_dir, &exe_dir.join("resources")] {
            candidates.push(base.join("bin/opencode-windows-x64/opencode.exe"));
            candidates.push(base.join("bin/opencode-windows-x64-baseline/opencode.exe"));
        }
    }
    candidates
}

fn create_opencode_proposal_prompt(request: &CodeProposeEditRequest) -> String {
    if request
        .locale
        .as_deref()
        .is_some_and(|locale| locale.starts_with("zh"))
    {
        let prompt = format!(
            r#"你是 Javis 的代码补丁提案生成器。不要直接编辑文件。只返回一个 JSON 对象，不要包含 markdown 代码块或额外解释。

严格使用以下 schema：
{{"summary":"一句简短中文摘要","changedFiles":["relative/path"],"patch":"unified diff text"}}

规则：
- changedFiles 必须是已批准变更文件的非空子集。
- patch 必须是非空 unified diff，并且只触及 changedFiles。
- patch 必须能应用到下方当前 diff preview 的上下文。
- 如果无法生成安全的 unified diff，不要捏造文件或不安全编辑。
- summary 字段必须使用中文。

用户目标：
{}

已批准的变更文件：
{}

当前 diff preview：
{}"#,
            request.user_goal.trim(),
            request.changed_files.join("\n"),
            request.diff
        );
        return format!("{JAVIS_TERMINOLOGY_PROMPT_PREFIX}\n\n{prompt}");
    }

    format!(
        r#"You are generating a patch proposal for Javis. Do not edit files. Return only one JSON object and no markdown fences or explanation.

Use exactly this schema:
{{"summary":"one short sentence","changedFiles":["relative/path"],"patch":"unified diff text"}}

Rules:
- changedFiles must be a non-empty subset of the approved changed files.
- patch must be a non-empty unified diff touching only changedFiles.
- patch must apply to the current diff preview below.
- If you cannot produce a safe unified diff, do not invent files or unsafe edits.

User goal:
{}

Approved changed files:
{}

Current diff preview:
{}"#,
        request.user_goal.trim(),
        request.changed_files.join("\n"),
        request.diff
    )
}

#[cfg(test)]
fn parse_code_proposal_from_text(workspace: &Path, text: &str) -> Result<CodeProposedEdit, String> {
    parse_code_proposal_from_text_with_allowed_files(workspace, text, None)
}

fn parse_code_proposal_from_text_for_request(
    workspace: &Path,
    text: &str,
    request: &CodeProposeEditRequest,
) -> Result<CodeProposedEdit, String> {
    let approved_files = request
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;
    parse_code_proposal_from_text_with_allowed_files(workspace, text, Some(&approved_files))
}

fn parse_code_proposal_from_text_with_allowed_files(
    workspace: &Path,
    text: &str,
    allowed_files: Option<&[PathBuf]>,
) -> Result<CodeProposedEdit, String> {
    let canonical_workspace = fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace is not accessible: {error}"))?;
    let raw = extract_raw_code_proposal(text)?;
    validate_raw_code_proposal(&canonical_workspace, &raw, allowed_files)?;
    let base_git_head = capture_current_git_head(&canonical_workspace);
    let hunks = parse_patch_hunks(&raw.patch);
    let mut proposal = CodeProposedEdit {
        proposal_id: format!("opencode-{}", create_approval_id()),
        workspace_path: normalize_path(&canonical_workspace),
        summary: raw.summary.trim().to_string(),
        changed_files: raw.changed_files,
        patch: raw.patch,
        patch_hash: String::new(),
        base_git_head,
        hunks,
    };
    proposal.patch_hash = create_code_proposal_hash(&proposal);
    Ok(proposal)
}

fn extract_raw_code_proposal(text: &str) -> Result<RawCodeProposal, String> {
    if let Some(raw) = parse_raw_code_proposal_candidate(text) {
        return Ok(raw);
    }
    if let Some(json_text) = extract_json_object_text(text) {
        if let Some(raw) = parse_raw_code_proposal_candidate(&json_text) {
            return Ok(raw);
        }
    }
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(raw) = serde_json::from_str::<RawCodeProposal>(trimmed) {
            return Ok(raw);
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(message) = value.get("message").and_then(|message| message.as_str()) {
                if let Ok(raw) = serde_json::from_str::<RawCodeProposal>(message.trim()) {
                    return Ok(raw);
                }
            }
            if let Some(content) = value
                .get("choices")
                .and_then(|choices| choices.as_array())
                .and_then(|choices| choices.first())
                .and_then(|choice| choice.get("message"))
                .and_then(|message| message.get("content"))
            {
                if let Some(raw) = raw_code_proposal_from_value(content) {
                    return Ok(raw);
                }
                if let Some(content) = content.as_str() {
                    if let Some(raw) = parse_raw_code_proposal_candidate(content.trim()) {
                        return Ok(raw);
                    }
                }
            }
            if let Some(text) = value.get("text").and_then(|text| text.as_str()) {
                if let Ok(raw) = serde_json::from_str::<RawCodeProposal>(text.trim()) {
                    return Ok(raw);
                }
            }
        }
    }

    Err(format!(
        "opencode did not return a parseable CodeProposedEdit JSON object. Output excerpt: {}",
        summarize_provider_output_for_error(text)
    ))
}

fn parse_raw_code_proposal_candidate(text: &str) -> Option<RawCodeProposal> {
    let value =
        serde_json::from_str::<serde_json::Value>(normalize_json_candidate(text).trim()).ok()?;
    raw_code_proposal_from_value(&value)
}

fn raw_code_proposal_from_value(value: &serde_json::Value) -> Option<RawCodeProposal> {
    let object = value.as_object()?;
    if let Some(content) = object
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
    {
        if let Some(raw) = raw_code_proposal_from_value(content) {
            return Some(raw);
        }
        if let Some(content) = content.as_str() {
            if let Some(raw) = parse_raw_code_proposal_candidate(content) {
                return Some(raw);
            }
        }
    }
    for key in ["proposal", "codeProposal", "code_proposal"] {
        if let Some(raw) = object.get(key).and_then(raw_code_proposal_from_value) {
            return Some(raw);
        }
    }

    let mut parts = RawCodeProposalParts::default();
    parts.summary = get_string_field(object, &["summary", "title", "description"]);
    parts.changed_files = get_string_array_field(
        object,
        &[
            "changedFiles",
            "changed_files",
            "files",
            "affectedPaths",
            "affected_paths",
        ],
    );
    parts.patch = get_required_string_field_preserving_body(
        object,
        &["patch", "diff", "unifiedDiff", "unified_diff"],
    );

    Some(RawCodeProposal {
        summary: parts.summary?,
        changed_files: parts.changed_files?,
        patch: parts.patch?,
    })
}

fn get_string_field(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn get_required_string_field_preserving_body(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(|value| value.as_str()))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn get_string_array_field(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<Vec<String>> {
    keys.iter().find_map(|key| {
        object.get(*key).and_then(|value| {
            value.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::trim))
                    .filter(|item| !item.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
        })
    })
}

fn summarize_provider_output_for_error(text: &str) -> String {
    let excerpt = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect::<String>();
    redact_secret_like_text(&excerpt)
}

fn redact_secret_like_text(text: &str) -> String {
    text.split_whitespace()
        .map(|token| {
            let normalized = token.trim_matches(|character: char| {
                matches!(
                    character,
                    '"' | '\'' | ',' | ':' | ';' | '{' | '}' | '[' | ']'
                )
            });
            if normalized.starts_with("sk-") && normalized.len() > 12
                || normalized.eq_ignore_ascii_case("bearer")
                || normalized.eq_ignore_ascii_case("authorization")
                || normalized.eq_ignore_ascii_case("apikey")
                || normalized.eq_ignore_ascii_case("api_key")
            {
                "[redacted-secret]"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_json_candidate(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with("```") {
        return trimmed.to_string();
    }
    let without_opening = trimmed.lines().skip(1).collect::<Vec<_>>().join("\n");
    without_opening
        .trim()
        .strip_suffix("```")
        .unwrap_or(without_opening.trim())
        .trim()
        .to_string()
}

fn extract_json_object_text(text: &str) -> Option<String> {
    let normalized = normalize_json_candidate(text);
    let start = normalized.find('{')?;
    let end = normalized.rfind('}')?;
    (start <= end).then(|| normalized[start..=end].to_string())
}

fn validate_raw_code_proposal(
    workspace: &Path,
    proposal: &RawCodeProposal,
    allowed_files: Option<&[PathBuf]>,
) -> Result<(), String> {
    if proposal.summary.trim().is_empty() {
        return Err("Code proposal summary cannot be empty.".to_string());
    }
    if proposal.patch.trim().is_empty() {
        return Err("Code proposal patch cannot be empty.".to_string());
    }
    if proposal.changed_files.is_empty() {
        return Err("Code proposal must list at least one changed file.".to_string());
    }
    let approved_files = proposal
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;
    require_approved_relative_paths(
        workspace,
        &approved_files,
        &approved_files,
        "Code proposal includes a file outside the approved diff",
        "Changed file path must stay inside the selected workspace.",
    )?;
    if let Some(allowed_files) = allowed_files {
        for file in &approved_files {
            if !allowed_files.contains(file) {
                return Err(format!(
                    "Code proposal includes a file outside the approved diff: {}",
                    file.display()
                ));
            }
        }
    }
    let patch_files = extract_unified_diff_paths(&proposal.patch)?;
    for file in &patch_files {
        if !approved_files.contains(file) {
            return Err(format!(
                "Code proposal patch includes an unlisted file path: {}",
                file.display()
            ));
        }
    }
    Ok(())
}

fn create_code_proposal_hash(edit: &CodeProposedEdit) -> String {
    let mut parts: Vec<&str> = Vec::new();
    parts.push(edit.proposal_id.as_str());
    parts.push(edit.workspace_path.as_str());
    parts.extend(edit.changed_files.iter().map(String::as_str));
    parts.push(edit.patch.as_str());
    if let Some(base_git_head) = edit.base_git_head.as_deref() {
        if !base_git_head.is_empty() {
            parts.push(base_git_head);
        }
    }
    let payload = parts.join("\n");
    create_fnv1a_hash(payload.as_bytes())
}

fn apply_code_patch_in_workspace(
    workspace: &Path,
    request: CodePatchApplyRequest,
    approval_state: Option<&Mutex<CodePatchApprovalState>>,
) -> Result<CodeApplyResult, String> {
    let canonical_workspace = fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace is not accessible: {error}"))?;
    if request.approval_id.trim().is_empty() {
        return Err("Code patch approval id is required.".to_string());
    }
    if request.proposal_id.trim().is_empty() {
        return Err("Code patch proposal id is required.".to_string());
    }
    let patch = request.patch.trim();
    if patch.is_empty() {
        return Err("Code patch cannot be empty.".to_string());
    }
    if request.changed_files.is_empty() {
        return Err("Code patch must list at least one approved changed file.".to_string());
    }
    let expected_patch_hash = create_code_proposal_hash(&CodeProposedEdit {
        proposal_id: request.proposal_id.clone(),
        workspace_path: normalize_path(&canonical_workspace),
        summary: String::new(),
        changed_files: request.changed_files.clone(),
        patch: request.patch.clone(),
        patch_hash: String::new(),
        base_git_head: request.base_git_head.clone(),
        hunks: None,
    });
    if request.patch_hash != expected_patch_hash {
        return Err("Code patch hash does not match the approved proposal.".to_string());
    }
    if let Some(approval_state) = approval_state {
        take_approved_code_patch(approval_state, &request, &canonical_workspace)?;
    }

    let approved_files = request
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;

    let patch_files = extract_unified_diff_paths(patch)?;
    require_approved_relative_paths(
        &canonical_workspace,
        &approved_files,
        &patch_files,
        "Patch includes an unapproved file path",
        "Changed file path must stay inside the selected workspace.",
    )?;

    // Best-effort dry-run check — non-fatal by design.
    // git apply --check can produce false negatives on some platforms (CRLF,
    // new file creation). The actual git apply below is the authoritative guard.
    if let Ok(mut child) = Command::new(resolve_command_program("git"))
        .args(["apply", "--check", "--whitespace=nowarn", "-"])
        .current_dir(&canonical_workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(patch.as_bytes());
        }
        // Proceed regardless — the real git apply below validates correctness
        let _ = child.wait_with_output();
    }

    let mut child = Command::new(resolve_command_program("git"))
        .args(["apply", "--whitespace=nowarn", "-"])
        .current_dir(&canonical_workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start git apply: {error}"))?;

    child
        .stdin
        .as_mut()
        .ok_or_else(|| "Could not open git apply stdin.".to_string())?
        .write_all(request.patch.as_bytes())
        .map_err(|error| format!("Could not write patch to git apply: {error}"))?;

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not finish git apply: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git apply failed without stderr.".to_string()
        } else {
            stderr
        });
    }

    Ok(CodeApplyResult {
        applied: true,
        workspace_path: normalize_path(&canonical_workspace),
        changed_files: approved_files
            .iter()
            .map(|file| file.to_string_lossy().replace('\\', "/"))
            .collect(),
        message: format!(
            "Applied patch to {} approved file(s).",
            approved_files.len()
        ),
    })
}

fn extract_unified_diff_paths(patch: &str) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for line in patch.lines() {
        if !line.starts_with("diff --git ") {
            continue;
        }
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 4 {
            return Err("Patch contains a malformed diff header.".to_string());
        }
        let path = normalize_git_diff_path(parts[3])?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }

    if paths.is_empty() {
        return Err("Patch does not contain a unified diff header.".to_string());
    }
    Ok(paths)
}

fn normalize_git_diff_path(path: &str) -> Result<PathBuf, String> {
    let without_prefix = path
        .strip_prefix("b/")
        .or_else(|| path.strip_prefix("a/"))
        .unwrap_or(path);
    normalize_relative_code_path(without_prefix)
}

fn normalize_relative_code_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("Changed file path cannot be empty.".to_string());
    }
    if trimmed.starts_with('/') || trimmed.contains(':') {
        return Err(format!("Changed file path must be relative: {trimmed}"));
    }
    let path = PathBuf::from(trimmed);
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Changed file path cannot contain parent directory traversal.".to_string());
    }
    Ok(path)
}

fn require_approved_relative_paths(
    workspace: &Path,
    approved_files: &[PathBuf],
    requested_files: &[PathBuf],
    unapproved_message: &str,
    outside_workspace_message: &str,
) -> Result<(), String> {
    for file in requested_files {
        if !approved_files.contains(file) {
            return Err(format!("{unapproved_message}: {}", file.display()));
        }
    }
    for file in approved_files {
        ensure_relative_path_stays_in_root(workspace, file, outside_workspace_message)?;
    }
    Ok(())
}

fn ensure_relative_path_stays_in_root(
    root: &Path,
    relative_path: &Path,
    outside_root_message: &str,
) -> Result<(), String> {
    let target = root.join(relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| "Changed file path does not have a parent directory.".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("Changed file parent is not accessible: {error}"))?;
    if !canonical_parent.starts_with(root) {
        return Err(outside_root_message.to_string());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubSearchItem {
    full_name: String,
    description: Option<String>,
    url: String,
    updated_at: Option<String>,
}

fn search_with_github_cli(query: &str, max_results: usize) -> Result<Vec<WebSearchResult>, String> {
    let limit = max_results.to_string();
    let args = [
        "search",
        "repos",
        query,
        "--limit",
        &limit,
        "--json",
        "fullName,description,url,updatedAt",
    ];
    let output = run_command_with_timeout(
        resolve_command_program("gh"),
        &args,
        Duration::from_secs(12),
    )
    .map_err(|error| format!("GitHub CLI is unavailable: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "GitHub CLI search failed without stderr.".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let items = serde_json::from_str::<Vec<GithubSearchItem>>(&stdout)
        .map_err(|error| format!("GitHub CLI search returned invalid JSON: {error}"))?;
    Ok(github_items_to_search_results(items, max_results))
}

fn github_items_to_search_results(
    items: Vec<GithubSearchItem>,
    max_results: usize,
) -> Vec<WebSearchResult> {
    let fetched_at = format_system_time(SystemTime::now());
    items
        .into_iter()
        .take(max_results)
        .filter(|item| item.url.starts_with("https://"))
        .map(|item| WebSearchResult {
            url: item.url,
            title: Some(item.full_name),
            excerpt: item
                .description
                .filter(|description| !description.trim().is_empty())
                .unwrap_or_else(|| "GitHub repository result from gh search.".to_string()),
            fetched_at: item.updated_at.unwrap_or_else(|| fetched_at.clone()),
            provider: Some("github-cli".to_string()),
        })
        .collect()
}

fn search_with_agent_chrome(
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, String> {
    let chrome = resolve_agent_chrome_program()
        .ok_or_else(|| "Agent Chrome executable was not found.".to_string())?;
    let profile = create_agent_chrome_profile_dir()?;
    let search_url = format!(
        "https://www.bing.com/search?q={}",
        percent_encode_query(query)
    );
    let user_data_dir = format!("--user-data-dir={}", profile.to_string_lossy());
    let args = [
        "--headless=new",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-component-update",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-extensions",
        "--incognito",
        &user_data_dir,
        "--dump-dom",
        &search_url,
    ];
    let output = run_command_with_timeout(
        chrome.to_string_lossy().to_string(),
        &args,
        Duration::from_secs(35),
    );
    let _ = fs::remove_dir_all(&profile);

    let output = output.map_err(|error| format!("Agent Chrome failed to start: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Agent Chrome search failed without stderr.".to_string()
        } else {
            stderr
        });
    }

    let html = String::from_utf8_lossy(&output.stdout);
    let results = parse_bing_html_results(&html, max_results);
    if results.is_empty() {
        return Err("Agent Chrome returned no parseable search results.".to_string());
    }
    Ok(results)
}

fn resolve_agent_chrome_program() -> Option<PathBuf> {
    if let Some(path) = env::var_os("JAVIS_AGENT_CHROME_PATH").map(PathBuf::from) {
        if path.exists() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    if let Some(program_files) = env::var_os("PROGRAMFILES").map(PathBuf::from) {
        candidates.push(program_files.join("Google/Chrome/Application/chrome.exe"));
        candidates.push(program_files.join("Microsoft/Edge/Application/msedge.exe"));
    }
    if let Some(program_files_x86) = env::var_os("PROGRAMFILES(X86)").map(PathBuf::from) {
        candidates.push(program_files_x86.join("Google/Chrome/Application/chrome.exe"));
        candidates.push(program_files_x86.join("Microsoft/Edge/Application/msedge.exe"));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        candidates.push(local_app_data.join("Google/Chrome/Application/chrome.exe"));
    }

    candidates.into_iter().find(|path| path.exists())
}

fn create_agent_chrome_profile_dir() -> Result<PathBuf, String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let directory = env::temp_dir().join(format!("javis-agent-chrome-{suffix}"));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn run_command_with_timeout(
    program: String,
    args: &[&str],
    timeout: Duration,
) -> Result<Output, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Command stdout pipe was unavailable.".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Command stderr pipe was unavailable.".to_string())?;
    let stdout_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        stdout
            .read_to_end(&mut buffer)
            .map(|_| buffer)
            .map_err(|error| error.to_string())
    });
    let stderr_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        stderr
            .read_to_end(&mut buffer)
            .map(|_| buffer)
            .map_err(|error| error.to_string())
    });
    let start = SystemTime::now();

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_reader
                    .join()
                    .map_err(|_| "Command stdout reader panicked.".to_string())??;
                let stderr = stderr_reader
                    .join()
                    .map_err(|_| "Command stderr reader panicked.".to_string())??;
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                let elapsed = SystemTime::now().duration_since(start).unwrap_or_default();
                if elapsed >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(format!(
                        "Command timed out after {} seconds.",
                        timeout.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(error.to_string());
            }
        }
    }
}

fn parse_bing_html_results(html: &str, max_results: usize) -> Vec<WebSearchResult> {
    let fetched_at = format_system_time(SystemTime::now());
    let mut results = Vec::new();
    let mut remaining = html;

    while results.len() < max_results {
        let Some(block_index) = remaining.find("<li class=\"b_algo\"") else {
            break;
        };
        remaining = &remaining[block_index..];
        let next_block_index = remaining[1..]
            .find("<li class=\"b_algo\"")
            .map(|index| index + 1)
            .unwrap_or(remaining.len());
        let block = &remaining[..next_block_index];

        let Some(h2_index) = block.find("<h2") else {
            remaining = &remaining[next_block_index..];
            continue;
        };
        let h2 = &block[h2_index..];
        let Some(anchor_index) = h2.find("<a") else {
            remaining = &remaining[next_block_index..];
            continue;
        };
        let anchor = &h2[anchor_index..];
        let Some(href) = extract_html_attribute(anchor, "href") else {
            remaining = &remaining[next_block_index..];
            continue;
        };
        let Some(close_index) = anchor.find('>') else {
            remaining = &remaining[next_block_index..];
            continue;
        };
        let after_link = &anchor[close_index + 1..];
        let Some(end_index) = after_link.find("</a>") else {
            remaining = &remaining[next_block_index..];
            continue;
        };
        let title = html_to_text(&after_link[..end_index]);
        let excerpt = extract_bing_snippet(block)
            .filter(|snippet| !snippet.is_empty())
            .unwrap_or_else(|| title.clone());
        if let Some(url) = normalize_bing_url(&href) {
            results.push(WebSearchResult {
                url,
                title: (!title.is_empty()).then_some(title),
                excerpt,
                fetched_at: fetched_at.clone(),
                provider: Some("agent-chrome".to_string()),
            });
        }
        remaining = &remaining[next_block_index..];
    }

    results
}

fn extract_bing_snippet(value: &str) -> Option<String> {
    let index = value.find("b_caption")?;
    let snippet = &value[index..];
    let paragraph_index = snippet.find("<p")?;
    let paragraph = &snippet[paragraph_index..];
    let close_index = paragraph.find('>')?;
    let after_tag = &paragraph[close_index + 1..];
    let end_index = after_tag
        .find("</p>")
        .or_else(|| after_tag.find("</div>"))?;
    Some(html_to_text(&after_tag[..end_index]))
}

fn extract_html_attribute(value: &str, attribute: &str) -> Option<String> {
    let pattern = format!("{attribute}=\"");
    let start = value.find(&pattern)? + pattern.len();
    let rest = &value[start..];
    let end = rest.find('"')?;
    Some(html_decode(&rest[..end]))
}

fn normalize_bing_url(value: &str) -> Option<String> {
    if let Some(index) = value.find("u=") {
        let encoded = &value[index + "u=".len()..];
        let end = encoded.find('&').unwrap_or(encoded.len());
        let encoded = encoded[..end].trim_start_matches("a1");
        if !encoded.is_empty() {
            let mut padded = encoded.replace('-', "+").replace('_', "/");
            while padded.len() % 4 != 0 {
                padded.push('=');
            }
            if let Ok(decoded) = STANDARD.decode(padded) {
                if let Ok(url) = String::from_utf8(decoded) {
                    return Some(url);
                }
            }
        }
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        return Some(value.to_string());
    }
    None
}

fn percent_encode_query(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            b' ' => vec!['+'],
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn downloads_directory() -> Result<PathBuf, String> {
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

fn create_approval_id() -> String {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("pdf-approval-{suffix}")
}

fn create_native_approval_binding(
    approval_id: String,
    tool_name: &str,
    task_id: String,
    preview_hash: String,
    approved: bool,
) -> NativeApprovalBinding {
    NativeApprovalBinding {
        approval_id,
        tool_name: tool_name.to_string(),
        task_id,
        preview_hash,
        approved,
    }
}

fn approve_native_approval_binding(
    binding: &mut NativeApprovalBinding,
    approval_id: &str,
    tool_name: &str,
    task_id: Option<&str>,
    preview_hash: &str,
    mismatch_error: &str,
) -> Result<(), String> {
    if binding.approval_id != approval_id {
        return Err(mismatch_error.to_string());
    }
    if binding.tool_name != tool_name {
        return Err("Approval tool binding does not match the pending dry-run.".to_string());
    }
    require_native_approval_task_id(binding, task_id)?;
    if binding.preview_hash != preview_hash {
        return Err("Approval preview hash does not match the pending dry-run.".to_string());
    }
    binding.approved = true;
    Ok(())
}

fn require_native_approval_binding(
    binding: &NativeApprovalBinding,
    approval_id: &str,
    tool_name: &str,
    task_id: Option<&str>,
    preview_hash: &str,
    mismatch_error: &str,
    unapproved_error: &str,
) -> Result<(), String> {
    if binding.approval_id != approval_id {
        return Err(mismatch_error.to_string());
    }
    if binding.tool_name != tool_name {
        return Err("Approval tool binding does not match the approved dry-run.".to_string());
    }
    require_native_approval_task_id(binding, task_id)?;
    if binding.preview_hash != preview_hash {
        return Err("Approval preview hash does not match the approved dry-run.".to_string());
    }
    if !binding.approved {
        return Err(unapproved_error.to_string());
    }
    Ok(())
}

fn require_native_approval_task_id(
    binding: &NativeApprovalBinding,
    task_id: Option<&str>,
) -> Result<(), String> {
    let approved_task_id = binding.task_id.trim();
    let requested_task_id = task_id.unwrap_or_default().trim();
    if approved_task_id != requested_task_id {
        return Err("Approval task id does not match the approved request.".to_string());
    }
    Ok(())
}

fn require_current_git_head_matches(
    workspace: &Path,
    expected_base_git_head: &str,
) -> Result<(), String> {
    if expected_base_git_head.is_empty() {
        return Ok(());
    }
    let Some(current_head) = capture_current_git_head(workspace) else {
        return Ok(());
    };
    if current_head != expected_base_git_head {
        return Err(format!(
            "Workspace git HEAD ({}) no longer matches the proposal base commit ({}).",
            &current_head[..current_head.len().min(7)],
            &expected_base_git_head[..expected_base_git_head.len().min(7)],
        ));
    }
    Ok(())
}

fn replace_pending_pdf_approval(
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

fn create_pdf_operations_preview_hash(operations: &[PlannedPathOperation]) -> String {
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

fn require_approved_pdf_operations(
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

fn approve_pending_pdf_organization(
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

fn take_approved_pdf_operations(
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
    )?;
    if pending.operations != request.operations {
        return Err(
            "Approved PDF organization operations do not match the current dry-run.".to_string(),
        );
    }
    let operations = request.operations;
    state.pending = None;
    Ok(operations)
}

fn approve_pending_code_patch(
    approval_state: &Mutex<CodePatchApprovalState>,
    request: CodePatchApprovalRequest,
) -> Result<(), String> {
    if request.approval_id.trim().is_empty() {
        return Err("Code patch approval id is required.".to_string());
    }
    if request.proposal_id.trim().is_empty() {
        return Err("Code patch proposal id is required.".to_string());
    }
    if request.workspace_path.trim().is_empty() {
        return Err("Code patch workspace path is required.".to_string());
    }
    if request.changed_files.is_empty() {
        return Err("Code patch must list at least one approved changed file.".to_string());
    }
    if request.patch_hash.trim().is_empty() {
        return Err("Code patch hash is required.".to_string());
    }
    let canonical_workspace = fs::canonicalize(&request.workspace_path)
        .map_err(|error| format!("Workspace is not accessible: {error}"))?;
    let approved_files = request
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;
    require_approved_relative_paths(
        &canonical_workspace,
        &approved_files,
        &approved_files,
        "Code patch approval includes an unapproved file path",
        "Changed file path must stay inside the selected workspace.",
    )?;
    let file_hashes = create_file_content_hashes(&canonical_workspace, &approved_files)?;
    let mut state = approval_state
        .lock()
        .map_err(|_| "Code patch approval state could not be locked.".to_string())?;
    state.pending = Some(PendingCodePatchApproval {
        binding: create_native_approval_binding(
            request.approval_id,
            CODE_PATCH_APPROVAL_TOOL_NAME,
            request.task_id.clone().unwrap_or_default(),
            request.patch_hash.clone(),
            true,
        ),
        proposal_id: request.proposal_id,
        workspace_path: normalize_path(&canonical_workspace),
        changed_files: request.changed_files,
        patch_hash: request.patch_hash,
        file_hashes,
    });
    Ok(())
}

fn take_approved_code_patch(
    approval_state: &Mutex<CodePatchApprovalState>,
    request: &CodePatchApplyRequest,
    canonical_workspace: &Path,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "Code patch approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_ref() else {
        return Err("No approved Code Patch proposal is pending.".to_string());
    };
    require_native_approval_binding(
        &pending.binding,
        &request.approval_id,
        CODE_PATCH_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &request.patch_hash,
        "Code patch approval id does not match the approved proposal.",
        "Code patch proposal has not been approved.",
    )?;
    if pending.proposal_id != request.proposal_id {
        return Err("Code patch proposal id does not match the approved proposal.".to_string());
    }
    if pending.workspace_path != normalize_path(canonical_workspace) {
        return Err("Code patch workspace does not match the approved proposal.".to_string());
    }
    if pending.changed_files != request.changed_files {
        return Err("Code patch changed files do not match the approved proposal.".to_string());
    }
    if pending.patch_hash != request.patch_hash {
        return Err("Code patch hash does not match the approved proposal.".to_string());
    }
    let approved_files = request
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;
    let current_hashes = create_file_content_hashes(canonical_workspace, &approved_files)?;
    if pending.file_hashes.len() != current_hashes.len()
        || pending
            .file_hashes
            .iter()
            .zip(current_hashes.iter())
            .any(|(approved, current)| {
                approved.path != current.path || approved.hash != current.hash
            })
    {
        return Err("Code patch approved files changed before apply.".to_string());
    }
    if let Some(base_git_head) = &request.base_git_head {
        require_current_git_head_matches(canonical_workspace, base_git_head)?;
    }
    state.pending = None;
    Ok(())
}

fn create_file_content_hashes(
    workspace: &Path,
    files: &[PathBuf],
) -> Result<Vec<FileContentHash>, String> {
    files
        .iter()
        .map(|file| {
            let path = file.to_string_lossy().replace('\\', "/");
            let target = workspace.join(file);
            let hash = match fs::read(&target) {
                Ok(content) => create_fnv1a_hash(&content),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing".to_string(),
                Err(error) => {
                    return Err(format!(
                        "Could not read approved file before apply: {}: {error}",
                        target.display()
                    ));
                }
            };
            Ok(FileContentHash { path, hash })
        })
        .collect()
}

fn create_fnv1a_hash(content: &[u8]) -> String {
    let mut hash = 2166136261u32;
    for byte in content {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("fnv1a-{hash:08x}")
}

fn capture_current_git_head(workspace: &Path) -> Option<String> {
    let output = Command::new(resolve_command_program("git"))
        .args(["rev-parse", "HEAD"])
        .current_dir(workspace)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn parse_patch_hunks(patch: &str) -> Option<Vec<CodeProposalHunk>> {
    let trimmed = patch.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut hunks: Vec<CodeProposalHunk> = Vec::new();
    let mut current_hunk: Option<CodeProposalHunk> = None;
    let mut hunk_lines: Vec<String> = Vec::new();

    for line in trimmed.lines() {
        if line.starts_with("@@") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(CodeProposalHunk {
                    diff: hunk_lines.join("\n"),
                    ..hunk
                });
            }
            hunk_lines = Vec::new();
            if let Some((header, rest)) = line[2..].split_once("@@") {
                let ranges: Vec<&str> = header.trim().split_whitespace().collect();
                if ranges.len() >= 2 {
                    let old = parse_hunk_range(ranges[0]);
                    let new = parse_hunk_range(ranges[1]);
                    current_hunk = Some(CodeProposalHunk {
                        old_start: old.0,
                        old_lines: old.1,
                        new_start: new.0,
                        new_lines: new.1,
                        header: format!("@@{header} @@{rest}"),
                        diff: String::new(),
                    });
                }
            }
        }
        if current_hunk.is_some() {
            hunk_lines.push(line.to_string());
        }
    }
    if let Some(hunk) = current_hunk.take() {
        hunks.push(CodeProposalHunk {
            diff: hunk_lines.join("\n"),
            ..hunk
        });
    }

    if hunks.is_empty() {
        None
    } else {
        Some(hunks)
    }
}

fn parse_hunk_range(range: &str) -> (u32, u32) {
    let parts: Vec<&str> = range.splitn(2, ',').collect();
    let start = parts
        .first()
        .and_then(|s| s.trim_start_matches('-').parse::<u32>().ok())
        .unwrap_or(0);
    let count = parts
        .get(1)
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(1);
    (start, count)
}

fn infer_pdf_category(path: &Path) -> &'static str {
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

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn execute_pdf_move_operation(
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

fn target_parent_stays_in_downloads(target: &Path, downloads_canonical: &Path) -> bool {
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

fn has_parent_dir_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}

fn file_operation_result(
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

fn scan_directory(
    root: &Path,
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
            scan_directory(root, &path, documents)?;
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

fn format_system_time(value: SystemTime) -> String {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn should_skip_directory(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };

    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "dist-ssr" | "gen"
    )
}

fn should_skip_file(path: &Path) -> bool {
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

fn read_text_prefix(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(64 * 1024)
        .read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;
    Ok(String::from_utf8_lossy(&buffer).to_string())
}

fn first_heading(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("# "))
        .map(|line| line.trim_start_matches("# ").trim().to_string())
}

fn first_excerpt(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.chars().take(180).collect())
}

fn extract_title(content: &str) -> Option<String> {
    let lower = content.to_lowercase();
    let start = lower.find("<title>")?;
    let end = lower[start..].find("</title>")? + start;
    Some(
        content[start + "<title>".len()..end]
            .replace('\n', " ")
            .trim()
            .to_string(),
    )
    .filter(|title| !title.is_empty())
}

fn html_to_text(content: &str) -> String {
    let mut output = String::with_capacity(content.len());
    let mut in_tag = false;

    for character in content.chars() {
        match character {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                output.push(' ');
            }
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }

    output
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .pipe_html_decode()
}

trait HtmlDecode {
    fn pipe_html_decode(self) -> String;
}

impl HtmlDecode for String {
    fn pipe_html_decode(self) -> String {
        html_decode(&self)
    }
}

fn html_decode(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execute_pdf_move_moves_file_inside_downloads() {
        let root = create_test_directory("move-success");
        let source = root.join("paper.pdf");
        let target = root.join("Research").join("paper.pdf");
        fs::write(&source, b"pdf").expect("write source pdf");

        let result = execute_pdf_move_operation(
            &root,
            PlannedPathOperation {
                source: normalize_path(&source),
                target: normalize_path(&target),
                action: "move".to_string(),
                conflict: None,
            },
        );

        assert_eq!(result.status, "moved");
        assert!(!source.exists());
        assert!(target.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn execute_pdf_move_skips_conflicting_target() {
        let root = create_test_directory("move-conflict");
        let source = root.join("paper.pdf");
        let target = root.join("Research").join("paper.pdf");
        fs::create_dir_all(target.parent().expect("target parent")).expect("create target parent");
        fs::write(&source, b"source").expect("write source pdf");
        fs::write(&target, b"target").expect("write target pdf");

        let result = execute_pdf_move_operation(
            &root,
            PlannedPathOperation {
                source: normalize_path(&source),
                target: normalize_path(&target),
                action: "move".to_string(),
                conflict: Some("Target file already exists.".to_string()),
            },
        );

        assert_eq!(result.status, "skipped");
        assert!(source.exists());
        assert!(target.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn execute_pdf_move_rejects_non_pdf_source() {
        let root = create_test_directory("move-non-pdf");
        let source = root.join("notes.txt");
        let target = root.join("Research").join("notes.txt");
        fs::write(&source, b"text").expect("write source text");

        let result = execute_pdf_move_operation(
            &root,
            PlannedPathOperation {
                source: normalize_path(&source),
                target: normalize_path(&target),
                action: "move".to_string(),
                conflict: None,
            },
        );

        assert_eq!(result.status, "failed");
        assert_eq!(result.message, "Only PDF files can be moved.");
        assert!(source.exists());
        assert!(!target.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn execute_pdf_move_rejects_parent_directory_traversal() {
        let root = create_test_directory("move-traversal");
        let source = root.join("paper.pdf");
        let target = root.join("Research").join("..").join("paper.pdf");
        fs::write(&source, b"pdf").expect("write source pdf");

        let result = execute_pdf_move_operation(
            &root,
            PlannedPathOperation {
                source: normalize_path(&source),
                target: normalize_path(&target),
                action: "move".to_string(),
                conflict: None,
            },
        );

        assert_eq!(result.status, "failed");
        assert_eq!(result.message, "Parent directory traversal is not allowed.");
        assert!(source.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn execute_pdf_move_rejects_target_outside_downloads() {
        let root = create_test_directory("move-target-outside");
        let outside = create_test_directory("move-target-outside-other");
        let source = root.join("paper.pdf");
        let target = outside.join("paper.pdf");
        fs::write(&source, b"pdf").expect("write source pdf");

        let result = execute_pdf_move_operation(
            &root,
            PlannedPathOperation {
                source: normalize_path(&source),
                target: normalize_path(&target),
                action: "move".to_string(),
                conflict: None,
            },
        );

        assert_eq!(result.status, "failed");
        assert_eq!(
            result.message,
            "Source and target must both stay inside Downloads."
        );
        assert!(source.exists());
        assert!(!target.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
        fs::remove_dir_all(outside).expect("cleanup outside directory");
    }

    #[test]
    fn execute_pdf_move_rejects_source_outside_downloads() {
        let root = create_test_directory("move-source-outside");
        let outside = create_test_directory("move-source-outside-other");
        let source = outside.join("paper.pdf");
        let target = root.join("Research").join("paper.pdf");
        fs::write(&source, b"pdf").expect("write outside source pdf");

        let result = execute_pdf_move_operation(
            &root,
            PlannedPathOperation {
                source: normalize_path(&source),
                target: normalize_path(&target),
                action: "move".to_string(),
                conflict: None,
            },
        );

        assert_eq!(result.status, "failed");
        assert_eq!(
            result.message,
            "Source and target must both stay inside Downloads."
        );
        assert!(source.exists());
        assert!(!target.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
        fs::remove_dir_all(outside).expect("cleanup outside directory");
    }

    #[test]
    fn execute_pdf_move_rejects_non_move_operations() {
        let root = create_test_directory("move-copy-rejected");
        let source = root.join("paper.pdf");
        let target = root.join("Research").join("paper.pdf");
        fs::write(&source, b"pdf").expect("write source pdf");

        let result = execute_pdf_move_operation(
            &root,
            PlannedPathOperation {
                source: normalize_path(&source),
                target: normalize_path(&target),
                action: "copy".to_string(),
                conflict: None,
            },
        );

        assert_eq!(result.status, "failed");
        assert_eq!(result.message, "Only move operations are supported.");
        assert!(source.exists());
        assert!(!target.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn pdf_operations_require_approval_before_execution() {
        let root = create_test_directory("pdf-approval-required");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        replace_pending_pdf_approval(&approval_state, "approval-1", &root, &operations, None)
            .expect("store pending approval");

        let result = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations,
                task_id: None,
            },
        );

        assert_eq!(
            result.expect_err("approval should be required"),
            "PDF organization dry-run has not been approved."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn pdf_operations_must_match_the_approved_dry_run() {
        let root = create_test_directory("pdf-approval-mismatch");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        replace_pending_pdf_approval(&approval_state, "approval-1", &root, &operations, None)
            .expect("store pending approval");
        approve_pending_pdf_organization(&approval_state, "approval-1", None)
            .expect("approve plan");
        let mut changed_operations = operations;
        changed_operations[0].target = normalize_path(&root.join("Other").join("paper.pdf"));

        let result = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations: changed_operations,
                task_id: None,
            },
        );

        assert_eq!(
            result.expect_err("changed operations should be rejected"),
            "Approved PDF organization operations do not match the current dry-run."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn pdf_native_approval_rejects_preview_hash_mismatch() {
        let root = create_test_directory("pdf-approval-preview-hash");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        replace_pending_pdf_approval(&approval_state, "approval-1", &root, &operations, None)
            .expect("store pending approval");
        {
            let mut state = approval_state.lock().expect("lock approval state");
            state
                .pending
                .as_mut()
                .expect("pending approval")
                .binding
                .preview_hash = "fnv1a-stale".to_string();
        }

        let result = approve_pending_pdf_organization(&approval_state, "approval-1", None);

        assert_eq!(
            result.expect_err("preview hash mismatch should fail"),
            "Approval preview hash does not match the pending dry-run."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn pdf_native_approval_rejects_task_id_mismatch() {
        let root = create_test_directory("pdf-approval-task-id");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        replace_pending_pdf_approval(
            &approval_state,
            "approval-1",
            &root,
            &operations,
            Some("task-1"),
        )
        .expect("store pending approval");

        let result =
            approve_pending_pdf_organization(&approval_state, "approval-1", Some("task-2"));

        assert_eq!(
            result.expect_err("task id mismatch should fail"),
            "Approval task id does not match the approved request."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn pdf_execution_requires_matching_task_id() {
        let root = create_test_directory("pdf-execute-task-id");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        replace_pending_pdf_approval(
            &approval_state,
            "approval-1",
            &root,
            &operations,
            Some("task-1"),
        )
        .expect("store pending approval");
        approve_pending_pdf_organization(&approval_state, "approval-1", Some("task-1"))
            .expect("approve plan");

        let result = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations,
                task_id: Some("task-2".to_string()),
            },
        );

        assert_eq!(
            result.expect_err("task id mismatch should fail"),
            "Approval task id does not match the approved request."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn approved_pdf_operations_are_one_time_use() {
        let root = create_test_directory("pdf-approval-one-time");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        replace_pending_pdf_approval(&approval_state, "approval-1", &root, &operations, None)
            .expect("store pending approval");
        approve_pending_pdf_organization(&approval_state, "approval-1", None)
            .expect("approve plan");

        let approved_operations = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations: operations.clone(),
                task_id: None,
            },
        )
        .expect("approved operations");
        let second_result = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations,
                task_id: None,
            },
        );

        assert_eq!(approved_operations.len(), 1);
        assert_eq!(
            second_result.expect_err("approval should be consumed"),
            "No approved PDF organization dry-run is pending."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn restored_pdf_approval_is_still_one_time_use() {
        let root = create_test_directory("pdf-restored-approval-one-time");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        replace_pending_pdf_approval(&approval_state, "approval-1", &root, &operations, None)
            .expect("restore pending approval");
        approve_pending_pdf_organization(&approval_state, "approval-1", None)
            .expect("approve restored plan");

        let approved_operations = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations: operations.clone(),
                task_id: None,
            },
        )
        .expect("approved operations");
        let second_result = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations,
                task_id: None,
            },
        );

        assert_eq!(approved_operations.len(), 1);
        assert_eq!(
            second_result.expect_err("approval should be consumed"),
            "No approved PDF organization dry-run is pending."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn pdf_approval_rejects_paths_outside_downloads() {
        let root = create_test_directory("pdf-approval-downloads");
        let outside = create_test_directory("pdf-approval-outside");
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        let source = root.join("paper.pdf");
        fs::write(&source, b"pdf").expect("write source pdf");
        let operations = vec![PlannedPathOperation {
            source: normalize_path(&source),
            target: normalize_path(&outside.join("paper.pdf")),
            action: "move".to_string(),
            conflict: None,
        }];

        let result =
            replace_pending_pdf_approval(&approval_state, "approval-1", &root, &operations, None);

        assert_eq!(
            result.expect_err("outside target should fail"),
            "Approved PDF organization paths must stay inside Downloads."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
        fs::remove_dir_all(outside).expect("cleanup outside directory");
    }

    #[test]
    fn pdf_approval_rejects_non_pdf_sources() {
        let root = create_test_directory("pdf-approval-non-pdf");
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        let source = root.join("notes.txt");
        fs::write(&source, b"text").expect("write source text");
        let operations = vec![PlannedPathOperation {
            source: normalize_path(&source),
            target: normalize_path(&root.join("Research").join("notes.txt")),
            action: "move".to_string(),
            conflict: None,
        }];

        let result =
            replace_pending_pdf_approval(&approval_state, "approval-1", &root, &operations, None);

        assert_eq!(
            result.expect_err("non-pdf source should fail"),
            "Only PDF sources can be approved for organization."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn execute_pdf_move_reports_missing_source() {
        let root = create_test_directory("move-missing-source");
        let source = root.join("missing.pdf");
        let target = root.join("Research").join("missing.pdf");

        let result = execute_pdf_move_operation(
            &root,
            PlannedPathOperation {
                source: normalize_path(&source),
                target: normalize_path(&target),
                action: "move".to_string(),
                conflict: None,
            },
        );

        assert_eq!(result.status, "failed");
        assert!(result.message.starts_with("Source cannot be read:"));
        assert!(!target.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[cfg(windows)]
    #[test]
    fn resolves_windows_package_manager_shims() {
        assert_eq!(resolve_command_program("pnpm"), "pnpm.cmd");
        assert_eq!(resolve_command_program("npm"), "npm.cmd");
        assert_eq!(resolve_command_program("node"), "node");
    }

    #[test]
    fn allows_read_only_code_review_git_commands() {
        assert!(is_allowed_read_only_command(
            "git",
            &["diff".to_string(), "--stat".to_string()]
        ));
        assert!(is_allowed_read_only_command(
            "git",
            &["diff".to_string(), "--unified=1".to_string()]
        ));
        assert!(is_allowed_read_only_command(
            "git",
            &["diff".to_string(), "--check".to_string()]
        ));
    }

    #[test]
    fn rejects_write_capable_code_review_git_commands() {
        assert!(!is_allowed_read_only_command(
            "git",
            &["reset".to_string(), "--hard".to_string()]
        ));
        assert!(!is_allowed_read_only_command(
            "git",
            &[
                "checkout".to_string(),
                "--".to_string(),
                "src/lib.rs".to_string()
            ]
        ));
        assert!(!is_allowed_read_only_command(
            "git",
            &["diff".to_string(), "--output=patch.diff".to_string()]
        ));
    }

    #[test]
    fn resolve_workspace_rejects_missing_paths_with_actionable_message() {
        let missing_path = std::env::temp_dir().join("javis-missing-workspace");

        let result = resolve_workspace_path(Some(normalize_path(&missing_path)));

        assert!(result
            .expect_err("missing workspace should fail")
            .starts_with("Selected workspace path is not accessible:"));
    }

    #[test]
    fn resolve_workspace_rejects_file_paths() {
        let root = create_test_directory("workspace-file-path");
        let file_path = root.join("package.json");
        fs::write(&file_path, "{}").expect("write file path");

        let result = resolve_workspace_path(Some(normalize_path(&file_path)));

        assert!(result
            .expect_err("file workspace path should fail")
            .starts_with("Selected workspace path is not a directory:"));
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn inspect_project_reports_missing_package_json() {
        let root = create_test_directory("workspace-no-package-json");

        let result = inspect_project(Some(normalize_path(&root)));

        match result {
            Ok(_) => panic!("package.json should be required"),
            Err(error) => {
                assert!(error.starts_with("Selected workspace does not contain package.json:"));
                assert!(error.contains("javis-workspace-no-package-json"));
            }
        }
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn apply_code_patch_applies_approved_unified_diff() {
        let root = create_test_directory("code-patch-success");
        init_git_repo(&root);
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        run_git(&root, &["add", "."]);
        run_git(&root, &["commit", "-m", "initial"]);
        fs::write(&file, "after\n").expect("write changed file");
        let patch = run_git_capture(&root, &["diff"]);
        run_git(&root, &["checkout", "--", "src/message.txt"]);

        let result = apply_code_patch_in_workspace(
            &root,
            code_patch_apply_request(&root, vec!["src/message.txt".to_string()], patch),
            None,
        )
        .expect("apply approved patch");

        assert!(result.applied);
        assert_eq!(result.changed_files, vec!["src/message.txt"]);
        assert_eq!(
            fs::read_to_string(file)
                .expect("read patched file")
                .replace("\r\n", "\n"),
            "after\n"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn apply_code_patch_rejects_unapproved_diff_paths() {
        let root = create_test_directory("code-patch-unapproved");
        let patch = "diff --git a/src/allowed.txt b/src/other.txt\n--- a/src/allowed.txt\n+++ b/src/other.txt\n@@ -1 +1 @@\n-before\n+after\n";

        let result = apply_code_patch_in_workspace(
            &root,
            code_patch_apply_request(
                &root,
                vec!["src/allowed.txt".to_string()],
                patch.to_string(),
            ),
            None,
        );

        assert_eq!(
            result.expect_err("unapproved path should fail"),
            "Patch includes an unapproved file path: src/other.txt"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn apply_code_patch_requires_approval_id() {
        let root = create_test_directory("code-patch-approval-id");
        let mut request = code_patch_apply_request(
            &root,
            vec!["src/message.txt".to_string()],
            "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
        );
        request.approval_id = " ".to_string();

        let result = apply_code_patch_in_workspace(&root, request, None);

        assert_eq!(
            result.expect_err("missing approval id should fail"),
            "Code patch approval id is required."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn apply_code_patch_rejects_patch_hash_mismatch() {
        let root = create_test_directory("code-patch-hash-mismatch");
        let mut request = code_patch_apply_request(
            &root,
            vec!["src/message.txt".to_string()],
            "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
        );
        request.patch_hash = "fnv1a-wrong".to_string();

        let result = apply_code_patch_in_workspace(&root, request, None);

        assert_eq!(
            result.expect_err("patch hash mismatch should fail"),
            "Code patch hash does not match the approved proposal."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_apply_requires_native_approval() {
        let root = create_test_directory("code-patch-native-approval-required");
        let approval_state = Mutex::new(CodePatchApprovalState::default());
        let request = code_patch_apply_request(
            &root,
            vec!["src/message.txt".to_string()],
            "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
        );

        let result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert_eq!(
            result.expect_err("approval should be required"),
            "No approved Code Patch proposal is pending."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn approved_code_patch_apply_is_one_time_use() {
        let root = create_test_directory("code-patch-one-shot");
        init_git_repo(&root);
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        run_git(&root, &["add", "."]);
        run_git(&root, &["commit", "-m", "initial"]);
        fs::write(&file, "after\n").expect("write changed file");
        let patch = run_git_capture(&root, &["diff"]);
        run_git(&root, &["checkout", "--", "src/message.txt"]);
        let request = code_patch_apply_request(&root, vec!["src/message.txt".to_string()], patch);
        let approval_state = Mutex::new(CodePatchApprovalState::default());
        approve_pending_code_patch(&approval_state, code_patch_approval_request(&request))
            .expect("approve code patch");

        let result = apply_code_patch_in_workspace(&root, request.clone(), Some(&approval_state))
            .expect("apply approved patch");
        let second_result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert!(result.applied);
        assert_eq!(
            second_result.expect_err("approval should be consumed"),
            "No approved Code Patch proposal is pending."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_approval_must_match_apply_request() {
        let root = create_test_directory("code-patch-approval-mismatch");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let approval_state = Mutex::new(CodePatchApprovalState::default());
        let request = code_patch_apply_request(
            &root,
            vec!["src/message.txt".to_string()],
            "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
        );
        let mut approval = code_patch_approval_request(&request);
        approval.proposal_id = "other-proposal".to_string();
        approve_pending_code_patch(&approval_state, approval).expect("approve code patch");

        let result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert_eq!(
            result.expect_err("proposal mismatch should fail"),
            "Code patch proposal id does not match the approved proposal."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_apply_rejects_native_tool_binding_mismatch() {
        let root = create_test_directory("code-patch-tool-binding");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let approval_state = Mutex::new(CodePatchApprovalState::default());
        let request = code_patch_apply_request(
            &root,
            vec!["src/message.txt".to_string()],
            "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
        );
        approve_pending_code_patch(&approval_state, code_patch_approval_request(&request))
            .expect("approve code patch");
        {
            let mut state = approval_state.lock().expect("lock approval state");
            state
                .pending
                .as_mut()
                .expect("pending approval")
                .binding
                .tool_name = PDF_APPROVAL_TOOL_NAME.to_string();
        }

        let result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert_eq!(
            result.expect_err("tool binding mismatch should fail"),
            "Approval tool binding does not match the approved dry-run."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_apply_rejects_native_preview_hash_mismatch() {
        let root = create_test_directory("code-patch-preview-hash");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let approval_state = Mutex::new(CodePatchApprovalState::default());
        let request = code_patch_apply_request(
            &root,
            vec!["src/message.txt".to_string()],
            "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
        );
        approve_pending_code_patch(&approval_state, code_patch_approval_request(&request))
            .expect("approve code patch");
        {
            let mut state = approval_state.lock().expect("lock approval state");
            state
                .pending
                .as_mut()
                .expect("pending approval")
                .binding
                .preview_hash = "fnv1a-stale".to_string();
        }

        let result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert_eq!(
            result.expect_err("preview hash mismatch should fail"),
            "Approval preview hash does not match the approved dry-run."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_apply_rejects_files_changed_after_approval() {
        let root = create_test_directory("code-patch-stale-file");
        init_git_repo(&root);
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        run_git(&root, &["add", "."]);
        run_git(&root, &["commit", "-m", "initial"]);
        fs::write(&file, "after\n").expect("write changed file");
        let patch = run_git_capture(&root, &["diff"]);
        run_git(&root, &["checkout", "--", "src/message.txt"]);
        let request = code_patch_apply_request(&root, vec!["src/message.txt".to_string()], patch);
        let approval_state = Mutex::new(CodePatchApprovalState::default());
        approve_pending_code_patch(&approval_state, code_patch_approval_request(&request))
            .expect("approve code patch");
        fs::write(&file, "external edit\n").expect("write stale file");

        let result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert_eq!(
            result.expect_err("stale approved file should fail"),
            "Code patch approved files changed before apply."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_apply_allows_approved_missing_files_to_be_created() {
        let root = create_test_directory("code-patch-create-missing-file");
        init_git_repo(&root);
        let file = root.join("src").join("new.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        let patch = "diff --git a/src/new.txt b/src/new.txt\nnew file mode 100644\nindex 0000000..3b18e51\n--- /dev/null\n+++ b/src/new.txt\n@@ -0,0 +1 @@\n+created\n".to_string();
        let request = code_patch_apply_request(&root, vec!["src/new.txt".to_string()], patch);
        let approval_state = Mutex::new(CodePatchApprovalState::default());
        approve_pending_code_patch(&approval_state, code_patch_approval_request(&request))
            .expect("approve code patch");

        let result = apply_code_patch_in_workspace(&root, request, Some(&approval_state))
            .expect("apply approved patch");

        assert!(result.applied);
        assert_eq!(
            fs::read_to_string(file)
                .expect("read created file")
                .replace("\r\n", "\n"),
            "created\n"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn shared_relative_path_guard_rejects_unapproved_paths() {
        let root = create_test_directory("shared-guard-unapproved");

        let result = require_approved_relative_paths(
            &root,
            &[PathBuf::from("src/allowed.txt")],
            &[PathBuf::from("src/other.txt")],
            "Requested path is not approved",
            "Requested path must stay inside root.",
        );

        assert_eq!(
            result.expect_err("unapproved requested path should fail"),
            "Requested path is not approved: src/other.txt"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn shared_relative_path_guard_rejects_root_escape() {
        let root = create_test_directory("shared-guard-escape");
        let outside = create_test_directory("shared-guard-outside");
        let escape = PathBuf::from("..")
            .join(outside.file_name().expect("outside directory name"))
            .join("file.txt");

        let result = require_approved_relative_paths(
            &root,
            &[escape.clone()],
            &[escape],
            "Requested path is not approved",
            "Requested path must stay inside root.",
        );

        assert_eq!(
            result.expect_err("root escape should fail"),
            "Requested path must stay inside root."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
        fs::remove_dir_all(outside).expect("cleanup outside directory");
    }

    #[test]
    fn apply_code_patch_rejects_parent_directory_paths() {
        let root = create_test_directory("code-patch-traversal");

        let result = apply_code_patch_in_workspace(
            &root,
            code_patch_apply_request(
                &root,
                vec!["../outside.txt".to_string()],
                "diff --git a/../outside.txt b/../outside.txt\n".to_string(),
            ),
            None,
        );

        assert_eq!(
            result.expect_err("traversal should fail"),
            "Changed file path cannot contain parent directory traversal."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn parses_opencode_code_proposal_json_and_hashes_patch() {
        let root = create_test_directory("code-proposal-json");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let text = r#"{"summary":"Tighten message copy.","changedFiles":["src/message.txt"],"patch":"diff --git a/src/message.txt b/src/message.txt\n--- a/src/message.txt\n+++ b/src/message.txt\n@@ -1 +1 @@\n-before\n+after\n"}"#;

        let proposal = parse_code_proposal_from_text(&root, text).expect("proposal");

        assert!(proposal.proposal_id.starts_with("opencode-"));
        assert_eq!(proposal.summary, "Tighten message copy.");
        assert_eq!(proposal.changed_files, vec!["src/message.txt"]);
        assert_eq!(proposal.patch_hash, create_code_proposal_hash(&proposal));
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn parses_code_proposal_preserves_patch_trailing_newline() {
        let root = create_test_directory("code-proposal-patch-newline");
        fs::create_dir_all(root.join("src")).expect("create src");
        let text = r#"{"summary":"Tighten message copy.","changedFiles":["src/message.txt"],"patch":"diff --git a/src/message.txt b/src/message.txt\n--- a/src/message.txt\n+++ b/src/message.txt\n@@ -1 +1 @@\n-before\n+after\n"}"#;

        let proposal = parse_code_proposal_from_text(&root, text).expect("proposal");

        assert!(
            proposal.patch.ends_with('\n'),
            "patch body must keep trailing newline for git apply"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_proposal_hash_matches_core_test_vector() {
        let proposal = CodeProposedEdit {
            proposal_id: "opencode-test".to_string(),
            workspace_path: "E:/Javis".to_string(),
            summary: "Tighten message copy.".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            patch: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            patch_hash: String::new(),
            base_git_head: None,
            hunks: None,
        };

        assert_eq!(create_code_proposal_hash(&proposal), "fnv1a-00ce5494");
    }

    #[test]
    fn resolves_bundled_opencode_before_path_fallback() {
        let program = resolve_opencode_program();

        assert!(
            program.to_string_lossy().contains("opencode-windows-x64"),
            "unexpected opencode program path: {}",
            program.display()
        );
        let output = Command::new(program)
            .arg("--version")
            .output()
            .expect("run bundled opencode");
        assert!(
            output.status.success(),
            "bundled opencode --version failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn parses_opencode_json_event_message_payloads() {
        let root = create_test_directory("code-proposal-event-json");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let text = r#"{"type":"message","message":"{\"summary\":\"Tighten message copy.\",\"changedFiles\":[\"src/message.txt\"],\"patch\":\"diff --git a/src/message.txt b/src/message.txt\\n--- a/src/message.txt\\n+++ b/src/message.txt\\n@@ -1 +1 @@\\n-before\\n+after\\n\"}"}"#;

        let proposal = parse_code_proposal_from_text(&root, text).expect("proposal");

        assert_eq!(proposal.summary, "Tighten message copy.");
        assert_eq!(proposal.changed_files, vec!["src/message.txt"]);
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn parses_pretty_or_fenced_code_proposal_json() {
        let root = create_test_directory("code-proposal-pretty-json");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let text = r#"```json
{
  "summary": "Tighten message copy.",
  "changedFiles": ["src/message.txt"],
  "patch": "diff --git a/src/message.txt b/src/message.txt\n--- a/src/message.txt\n+++ b/src/message.txt\n@@ -1 +1 @@\n-before\n+after\n"
}
```"#;

        let proposal = parse_code_proposal_from_text(&root, text).expect("proposal");

        assert_eq!(proposal.summary, "Tighten message copy.");
        assert_eq!(proposal.changed_files, vec!["src/message.txt"]);
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn parses_provider_proposal_aliases_and_nested_payloads() {
        let root = create_test_directory("code-proposal-aliases");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let text = r#"{
          "proposal": {
            "description": "Tighten message copy.",
            "changed_files": ["src/message.txt"],
            "unifiedDiff": "diff --git a/src/message.txt b/src/message.txt\n--- a/src/message.txt\n+++ b/src/message.txt\n@@ -1 +1 @@\n-before\n+after\n"
          }
        }"#;

        let proposal = parse_code_proposal_from_text(&root, text).expect("proposal");

        assert_eq!(proposal.summary, "Tighten message copy.");
        assert_eq!(proposal.changed_files, vec!["src/message.txt"]);
        assert!(proposal.patch.contains("+after"));
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn parses_openai_content_object_code_proposal() {
        let root = create_test_directory("code-proposal-content-object");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let text = r#"{
          "choices": [
            {
              "message": {
                "content": {
                  "summary": "Tighten message copy.",
                  "files": ["src/message.txt"],
                  "diff": "diff --git a/src/message.txt b/src/message.txt\n--- a/src/message.txt\n+++ b/src/message.txt\n@@ -1 +1 @@\n-before\n+after\n"
                }
              }
            }
          ]
        }"#;

        let proposal = parse_code_proposal_from_text(&root, text).expect("proposal");

        assert_eq!(proposal.summary, "Tighten message copy.");
        assert_eq!(proposal.changed_files, vec!["src/message.txt"]);
        assert!(proposal.patch.contains("+after"));
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_proposal_parse_errors_include_sanitized_excerpt() {
        let error = extract_raw_code_proposal(
            "provider returned invalid response sk-super-secret-token-that-should-not-leak",
        )
        .expect_err("invalid proposal should fail");

        assert!(error.contains("Output excerpt:"));
        assert!(error.contains("[redacted-secret]"));
        assert!(!error.contains("sk-super-secret"));
    }

    #[test]
    fn provider_response_diagnostics_are_redacted() {
        let request = CodeProposeEditRequest {
            workspace_path: "E:/Javis".to_string(),
            user_goal: "Review changes".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            diff: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            provider_id: Some("deepseek".to_string()),
            model: Some("deepseek/deepseek-v4-flash".to_string()),
            api_key: Some("sk-local-secret-that-must-not-leak".to_string()),
            api_key_reference: None,
            base_url: Some("https://api.deepseek.com".to_string()),
            locale: None,
        };

        let diagnostic = create_provider_response_diagnostic(
            &request,
            "https://api.deepseek.com/chat/completions",
            r#"{"error":"Authorization Bearer sk-local-secret-that-must-not-leak apiKey failed"}"#,
        );

        assert!(diagnostic.contains("provider=deepseek"));
        assert!(diagnostic.contains("model=deepseek-v4-flash"));
        assert!(diagnostic.contains("endpointHost=api.deepseek.com"));
        assert!(diagnostic.contains("bodyHash=fnv1a-"));
        assert!(diagnostic.contains("[redacted-secret]"));
        assert!(!diagnostic.contains("sk-local-secret"));
    }

    #[test]
    fn openai_compatible_fallback_requests_json_object_output() {
        let body = create_openai_compatible_proposal_body(
            "deepseek-v4-flash",
            "Return the CodeProposedEdit JSON object.",
        );

        assert_eq!(body["response_format"]["type"], "json_object");
        assert_eq!(body["stream"], false);
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["model"], "deepseek-v4-flash");
    }

    #[test]
    fn openai_compatible_completion_stream_body_requests_streaming() {
        let request = ModelCompletionRequest {
            prompt: "Say hello".to_string(),
            provider_id: Some("openai".to_string()),
            model: Some("openai/gpt-test".to_string()),
            api_key: Some("sk-test".to_string()),
            api_key_reference: None,
            base_url: None,
            max_tokens: Some(42),
            temperature: Some(0.1),
            stop_sequences: Some(vec!["\n\n".to_string(), " ".to_string()]),
            locale: None,
        };

        let body = create_openai_compatible_stream_body("gpt-test", &request);

        assert_eq!(body["stream"], true);
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["max_tokens"], 42);
        assert_eq!(body["stop"], serde_json::json!(["\n\n", " "]));
    }

    #[test]
    fn parses_openai_compatible_stream_chunks() {
        let text = concat!(
            "event: message\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n",
            "data: [DONE]\n",
        );

        let chunks = parse_openai_compatible_stream_chunks(
            text,
            "openai",
            "gpt-test",
            "https://api.openai.com/v1/chat/completions",
        )
        .expect("stream chunks");

        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Hel", "lo"]
        );
        assert!(chunks
            .iter()
            .all(|chunk| chunk.provider.as_deref() == Some("openai")));
    }

    #[test]
    fn code_proposal_prompt_uses_chinese_when_locale_is_zh_cn() {
        let request = CodeProposeEditRequest {
            workspace_path: "E:/Javis".to_string(),
            user_goal: "修复当前变更".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            diff: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            provider_id: None,
            model: None,
            api_key: None,
            api_key_reference: None,
            base_url: None,
            locale: Some("zh-CN".to_string()),
        };

        let prompt = create_opencode_proposal_prompt(&request);
        assert!(prompt.contains("Javis terminology rules for Chinese output"));
        assert!(prompt.contains("Agent: keep the English term"));

        assert!(prompt.contains("summary 字段必须使用中文"));
        assert!(prompt.contains("修复当前变更"));
    }

    #[test]
    fn windows_process_initialization_exit_is_retryable() {
        #[cfg(windows)]
        assert!(is_retryable_windows_process_initialization_exit(Some(
            -1073741502
        )));
        assert!(!is_retryable_windows_process_initialization_exit(Some(1)));
        assert!(!is_retryable_windows_process_initialization_exit(Some(0)));
        assert!(!is_retryable_windows_process_initialization_exit(None));
    }

    #[test]
    fn builds_opencode_invocation_with_desktop_model_settings() {
        let root = create_test_directory("opencode-model-settings");
        let request = CodeProposeEditRequest {
            workspace_path: normalize_path(&root),
            user_goal: "Review changes".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            diff: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            provider_id: Some("openai".to_string()),
            model: Some("openai/gpt-5.1-codex".to_string()),
            api_key: Some("sk-test".to_string()),
            api_key_reference: None,
            base_url: Some("https://api.example.test/v1".to_string()),
            locale: None,
        };

        let invocation = create_opencode_proposal_invocation(&root, "Return JSON.", &request)
            .expect("invocation");
        let config: serde_json::Value =
            serde_json::from_str(&invocation.config_content).expect("config json");

        assert!(invocation
            .args
            .windows(2)
            .any(|pair| pair == ["--model", "openai/gpt-5.1-codex"]));
        assert_eq!(config["permission"]["edit"], "deny");
        assert_eq!(config["permission"]["bash"], "deny");
        assert_eq!(config["permission"]["webfetch"], "deny");
        assert_eq!(config["provider"]["openai"]["options"]["apiKey"], "sk-test");
        assert_eq!(
            config["provider"]["openai"]["options"]["baseURL"],
            "https://api.example.test/v1"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn builds_custom_openai_compatible_provider_config() {
        let request = CodeProposeEditRequest {
            workspace_path: "E:/Javis".to_string(),
            user_goal: "Review changes".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            diff: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            provider_id: Some("custom".to_string()),
            model: Some("custom/local-model".to_string()),
            api_key: Some("local-key".to_string()),
            api_key_reference: None,
            base_url: Some("http://127.0.0.1:11434/v1".to_string()),
            locale: None,
        };
        let config: serde_json::Value =
            serde_json::from_str(&create_opencode_config_content(&request).expect("config"))
                .expect("config json");

        assert_eq!(
            config["provider"]["custom"]["npm"],
            "@ai-sdk/openai-compatible"
        );
        assert_eq!(
            config["provider"]["custom"]["models"]["local-model"]["name"],
            "local-model"
        );
        assert_eq!(
            config["provider"]["custom"]["options"]["apiKey"],
            "local-key"
        );
        assert_eq!(
            config["provider"]["custom"]["options"]["baseURL"],
            "http://127.0.0.1:11434/v1"
        );
    }

    #[test]
    fn qualifies_bare_desktop_model_with_provider_for_opencode_only() {
        let root = create_test_directory("opencode-bare-model");
        let request = CodeProposeEditRequest {
            workspace_path: normalize_path(&root),
            user_goal: "Review changes".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            diff: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            provider_id: Some("deepseek".to_string()),
            model: Some("deepseek-v4-flash".to_string()),
            api_key: Some("sk-test".to_string()),
            api_key_reference: None,
            base_url: Some("https://api.deepseek.com".to_string()),
            locale: None,
        };

        let invocation = create_opencode_proposal_invocation(&root, "Return JSON.", &request)
            .expect("invocation");

        assert!(invocation
            .args
            .windows(2)
            .any(|pair| pair == ["--model", "deepseek/deepseek-v4-flash"]));
        assert_eq!(
            normalize_openai_compatible_model_name(&request).as_deref(),
            Some("deepseek-v4-flash")
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn falls_back_to_openai_compatible_only_for_supported_provider_settings() {
        let request = CodeProposeEditRequest {
            workspace_path: "E:/Javis".to_string(),
            user_goal: "Review changes".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            diff: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            provider_id: Some("deepseek".to_string()),
            model: Some("deepseek/deepseek-v4-flash".to_string()),
            api_key: Some("sk-test".to_string()),
            api_key_reference: None,
            base_url: None,
            locale: None,
        };

        assert!(should_fallback_to_openai_compatible(&request));
        assert!(!should_fallback_to_openai_compatible(
            &CodeProposeEditRequest {
                api_key: None,
                ..request.clone()
            }
        ));
        assert!(!should_fallback_to_openai_compatible(
            &CodeProposeEditRequest {
                provider_id: Some("custom".to_string()),
                model: Some("custom/local-model".to_string()),
                api_key: Some("custom-key".to_string()),
                base_url: None,
                ..request.clone()
            }
        ));
        assert!(should_fallback_to_openai_compatible(
            &CodeProposeEditRequest {
                provider_id: Some("custom".to_string()),
                model: Some("custom/local-model".to_string()),
                api_key: Some("custom-key".to_string()),
                base_url: Some("http://127.0.0.1:11434/v1".to_string()),
                ..request.clone()
            }
        ));
        assert!(can_fallback_from_opencode_error(
            "opencode proposal command failed without stderr."
        ));
        assert!(!can_fallback_from_opencode_error(
            "opencode proposal configuration error: Invalid opencode provider or model id: bad/id"
        ));
        assert_eq!(
            create_chat_completions_endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            create_chat_completions_endpoint("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn rejects_code_proposal_files_outside_approved_diff() {
        let root = create_test_directory("code-proposal-approved-files");
        let message = root.join("src").join("message.txt");
        let other = root.join("src").join("other.txt");
        fs::create_dir_all(message.parent().expect("file parent")).expect("create src");
        fs::write(&message, "before\n").expect("write message");
        fs::write(&other, "before\n").expect("write other");
        let request = CodeProposeEditRequest {
            workspace_path: normalize_path(&root),
            user_goal: "Review changes".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            diff: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            provider_id: Some("deepseek".to_string()),
            model: Some("deepseek/deepseek-v4-flash".to_string()),
            api_key: None,
            api_key_reference: None,
            base_url: None,
            locale: None,
        };
        let text = r#"{"summary":"Tighten message copy.","changedFiles":["src/other.txt"],"patch":"diff --git a/src/other.txt b/src/other.txt\n--- a/src/other.txt\n+++ b/src/other.txt\n@@ -1 +1 @@\n-before\n+after\n"}"#;

        let result = parse_code_proposal_from_text_for_request(&root, text, &request);

        assert_eq!(
            result.expect_err("unapproved file should fail"),
            "Code proposal includes a file outside the approved diff: src/other.txt"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn times_out_long_running_child_processes() {
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping", "127.0.0.1", "-n", "6", ">nul"]);
            command
        } else {
            let mut command = Command::new("sleep");
            command.arg("5");
            command
        };
        let child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sleeper");

        let error = wait_with_timeout(child, Duration::from_millis(50)).expect_err("timeout");

        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("timed out"));
    }

    #[test]
    fn rejects_opencode_code_proposals_with_unlisted_patch_paths() {
        let root = create_test_directory("code-proposal-unlisted");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let text = r#"{"summary":"Tighten message copy.","changedFiles":["src/message.txt"],"patch":"diff --git a/src/other.txt b/src/other.txt\n--- a/src/other.txt\n+++ b/src/other.txt\n@@ -1 +1 @@\n-before\n+after\n"}"#;

        let result = parse_code_proposal_from_text(&root, text);

        assert_eq!(
            result.expect_err("unlisted path should fail"),
            "Code proposal patch includes an unlisted file path: src/other.txt"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn rejects_code_proposal_fixtures_without_qa_mode() {
        let root = create_test_directory("code-proposal-fixture-guard");
        let fixture = root.join("proposal.json");
        fs::write(&fixture, "{}").expect("write fixture");
        env::set_var("JAVIS_CODE_PROPOSAL_FIXTURE_PATH", &fixture);
        env::remove_var("JAVIS_QA_MODE");

        let result = propose_code_edit_with_opencode(
            &root,
            CodeProposeEditRequest {
                workspace_path: normalize_path(&root),
                user_goal: "Review changes".to_string(),
                changed_files: vec!["proposal.json".to_string()],
                diff: "diff --git a/proposal.json b/proposal.json\n".to_string(),
                provider_id: None,
                model: None,
                api_key: None,
                api_key_reference: None,
                base_url: None,
                locale: None,
            },
        );

        assert_eq!(
            result.expect_err("fixture should require QA mode"),
            "Code proposal fixtures require JAVIS_QA_MODE=1."
        );
        env::remove_var("JAVIS_CODE_PROPOSAL_FIXTURE_PATH");
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn maps_github_results_to_search_results() {
        let results = github_items_to_search_results(
            vec![GithubSearchItem {
                full_name: "expert-vision-software/opencode-intellisearch".to_string(),
                description: Some("Deep research plugin for OpenCode.".to_string()),
                url: "https://github.com/expert-vision-software/opencode-intellisearch".to_string(),
                updated_at: Some("2026-05-23T00:00:00Z".to_string()),
            }],
            3,
        );

        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].url,
            "https://github.com/expert-vision-software/opencode-intellisearch"
        );
        assert_eq!(results[0].provider.as_deref(), Some("github-cli"));
        assert_eq!(
            results[0].title.as_deref(),
            Some("expert-vision-software/opencode-intellisearch")
        );
        assert_eq!(results[0].excerpt, "Deep research plugin for OpenCode.");
    }

    #[test]
    fn parses_agent_chrome_bing_results() {
        let html = r#"
          <li class="b_algo">
            <h2><a href="https://example.com/alpha">Alpha &amp; Docs</a></h2>
            <div class="b_caption"><p>Useful alpha evidence.</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="https://www.bing.com/ck/a?!&&p=1&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9iZXRh&ntb=1">Beta</a></h2>
            <div class="b_caption"><p>Useful beta evidence.</p></div>
          </li>
        "#;

        let results = parse_bing_html_results(html, 3);

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://example.com/alpha");
        assert_eq!(results[0].title.as_deref(), Some("Alpha & Docs"));
        assert_eq!(results[0].excerpt, "Useful alpha evidence.");
        assert_eq!(results[0].provider.as_deref(), Some("agent-chrome"));
        assert_eq!(results[1].url, "https://example.com/beta");
    }

    #[test]
    fn percent_encoding_round_trips_search_queries() {
        let encoded = percent_encode_query("opencode intellisearch/Rust");

        assert_eq!(encoded, "opencode+intellisearch%2FRust");
    }

    #[test]
    fn model_api_key_secret_round_trips_without_plaintext_storage() {
        let protected = protect_model_api_key_secret("sk-local-secret").expect("protect secret");

        #[cfg(windows)]
        {
            assert_eq!(
                unprotect_model_api_key_secret(&protected).expect("unprotect secret"),
                "sk-local-secret"
            );
            assert!(protected.starts_with(MODEL_API_KEY_SECRET_PREFIX));
            assert!(!protected.contains("sk-local-secret"));
        }
        #[cfg(not(windows))]
        {
            assert!(protected.starts_with("keyring-v1:"));
            assert_eq!(
                unprotect_model_api_key_secret(&protected).expect_err("keyring marker"),
                "Model API key must be read from the OS credential store."
            );
        }
    }

    #[cfg(not(windows))]
    struct FailingModelApiKeySecretStore;

    #[cfg(not(windows))]
    impl ModelApiKeySecretStore for FailingModelApiKeySecretStore {
        fn save(&self, _key_reference: &str, _api_key: &str) -> Result<(), String> {
            Err(
                "Could not save model API key to OS credential store: backend unavailable"
                    .to_string(),
            )
        }

        fn load(&self, _key_reference: &str) -> Result<String, String> {
            Err(
                "Could not read model API key from OS credential store: backend unavailable"
                    .to_string(),
            )
        }

        fn delete(&self, _key_reference: &str) -> Result<(), String> {
            Err(
                "Could not delete model API key from OS credential store: backend unavailable"
                    .to_string(),
            )
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_keyring_errors_are_returned() {
        let store = FailingModelApiKeySecretStore;

        assert_eq!(
            save_model_api_key_secret_with_store(&store, "default", "sk-local-secret")
                .expect_err("save should fail"),
            "Could not save model API key to OS credential store: backend unavailable"
        );
        assert_eq!(
            load_model_api_key_secret_with_store(&store, "default").expect_err("load should fail"),
            "Could not read model API key from OS credential store: backend unavailable"
        );
        assert_eq!(
            delete_model_api_key_secret_with_store(&store, "default")
                .expect_err("delete should fail"),
            "Could not delete model API key from OS credential store: backend unavailable"
        );
    }

    #[test]
    fn model_api_key_reference_is_fixed_and_required() {
        assert_eq!(
            normalize_model_api_key_reference(" default ").expect("default reference"),
            MODEL_API_KEY_SECRET_REFERENCE
        );
        assert_eq!(
            normalize_model_api_key_reference("other").expect_err("unknown reference"),
            "Unknown model API key reference."
        );
        assert_eq!(
            normalize_model_api_key_reference(" ").expect_err("missing reference"),
            "Model API key reference is required."
        );
    }

    #[test]
    fn reads_boolean_environment_flags() {
        let key = "JAVIS_TEST_BOOLEAN_FLAG";
        env::remove_var(key);
        assert!(!env_flag_enabled(key));

        env::set_var(key, "1");
        assert!(env_flag_enabled(key));

        env::set_var(key, "true");
        assert!(env_flag_enabled(key));

        env::set_var(key, "0");
        assert!(!env_flag_enabled(key));

        env::remove_var(key);
    }

    #[test]
    fn reads_search_fixture_results() {
        let root = create_test_directory("search-fixture");
        let fixture = root.join("search.json");
        fs::write(
            &fixture,
            r#"[
              {
                "url": "http://127.0.0.1:8765/alpha.html",
                "title": "Alpha",
                "excerpt": "Alpha evidence",
                "fetchedAt": "2026-05-23T00:00:00.000Z",
                "provider": "github-cli"
              },
              {
                "url": "http://127.0.0.1:8765/beta.html",
                "title": "Beta",
                "excerpt": "Beta evidence",
                "fetchedAt": "2026-05-23T00:00:00.000Z",
                "provider": "github-cli"
              }
            ]"#,
        )
        .expect("write fixture");

        let results = search_with_fixture_file(&fixture, 1).expect("fixture results");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title.as_deref(), Some("Alpha"));
        assert_eq!(results[0].provider.as_deref(), Some("github-cli"));
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn search_fixture_path_requires_qa_mode() {
        let root = create_test_directory("search-fixture-guard");
        let fixture = root.join("search.json");
        fs::write(&fixture, "[]").expect("write fixture");
        env::set_var("JAVIS_SEARCH_FIXTURE_PATH", &fixture);
        env::remove_var("JAVIS_QA_MODE");

        let result = search_web_sources(WebSearchRequest {
            query: "fixture guard".to_string(),
            max_results: Some(1),
        });

        assert_eq!(
            result.expect_err("fixture should require qa mode"),
            "Search fixtures require JAVIS_QA_MODE=1."
        );
        env::remove_var("JAVIS_SEARCH_FIXTURE_PATH");
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn appends_task_audit_jsonl_lines() {
        let root = create_test_directory("task-audit-jsonl");
        let path = root.join("task-audit.jsonl");

        append_jsonl_line_to_path(&path, "{\"kind\":\"agent_run_audit\"}\n", "Task audit")
            .expect("append first line");
        append_jsonl_line_to_path(&path, "{\"kind\":\"tool_call_audit\"}", "Task audit")
            .expect("append second line");

        assert_eq!(
            fs::read_to_string(&path).expect("read audit file"),
            "{\"kind\":\"agent_run_audit\"}\n{\"kind\":\"tool_call_audit\"}\n"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn rejects_invalid_task_audit_jsonl_lines() {
        let root = create_test_directory("task-audit-jsonl-invalid");
        let path = root.join("task-audit.jsonl");

        assert!(append_jsonl_line_to_path(&path, "", "Task audit").is_err());
        assert!(
            append_jsonl_line_to_path(&path, "{\"ok\":true}\n{\"ok\":false}", "Task audit")
                .is_err()
        );
        assert!(append_jsonl_line_to_path(&path, "not-json", "Task audit").is_err());
        assert!(!path.exists());
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn appends_task_session_jsonl_lines() {
        let root = create_test_directory("task-session-jsonl");
        let path = root.join("task-session.jsonl");

        append_jsonl_line_to_path(
            &path,
            "{\"kind\":\"task_session_snapshot\"}",
            "Task session",
        )
        .expect("append first session line");
        append_jsonl_line_to_path(
            &path,
            "{\"kind\":\"task_session_snapshot\"}\n",
            "Task session",
        )
        .expect("append second session line");

        assert_eq!(
            fs::read_to_string(&path).expect("read session file"),
            "{\"kind\":\"task_session_snapshot\"}\n{\"kind\":\"task_session_snapshot\"}\n"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    fn create_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("javis-{name}-{unique}"));
        fs::create_dir_all(&root).expect("create test directory");
        root
    }

    fn code_patch_apply_request(
        workspace: &Path,
        changed_files: Vec<String>,
        patch: String,
    ) -> CodePatchApplyRequest {
        let canonical_workspace =
            fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        let proposal = CodeProposedEdit {
            proposal_id: "opencode-test".to_string(),
            workspace_path: normalize_path(&canonical_workspace),
            summary: "Test patch.".to_string(),
            changed_files: changed_files.clone(),
            patch: patch.clone(),
            patch_hash: String::new(),
            base_git_head: None,
            hunks: None,
        };
        CodePatchApplyRequest {
            approval_id: "approval-test".to_string(),
            proposal_id: proposal.proposal_id.clone(),
            workspace_path: proposal.workspace_path.clone(),
            changed_files,
            patch,
            patch_hash: create_code_proposal_hash(&proposal),
            task_id: None,
            base_git_head: None,
            locale: None,
        }
    }

    fn code_patch_approval_request(request: &CodePatchApplyRequest) -> CodePatchApprovalRequest {
        CodePatchApprovalRequest {
            approval_id: request.approval_id.clone(),
            proposal_id: request.proposal_id.clone(),
            workspace_path: request.workspace_path.clone(),
            changed_files: request.changed_files.clone(),
            patch_hash: request.patch_hash.clone(),
            task_id: None,
            locale: None,
        }
    }

    fn init_git_repo(root: &Path) {
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "javis@example.test"]);
        run_git(root, &["config", "user.name", "Javis Test"]);
    }

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new(resolve_command_program("git"))
            .args(args)
            .current_dir(root)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_git_capture(root: &Path, args: &[&str]) -> String {
        let output = Command::new(resolve_command_program("git"))
            .args(args)
            .current_dir(root)
            .output()
            .expect("run git capture");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    fn planned_pdf_operation_in(root: &Path) -> PlannedPathOperation {
        let source = root.join("paper.pdf");
        fs::write(&source, b"pdf").expect("write planned pdf");
        PlannedPathOperation {
            source: normalize_path(&source),
            target: normalize_path(&root.join("Research").join("paper.pdf")),
            action: "move".to_string(),
            conflict: None,
        }
    }
}

// ── Sidebar scanning infrastructure ──────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size_bytes: Option<u64>,
    modified_at: Option<String>,
    extension: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppEntry {
    name: String,
    path: String,
    icon_path: Option<String>,
    publisher: Option<String>,
    install_location: Option<String>,
}

const SKIP_DIRS: &[&str] = &[
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
];

fn chrono_datetime_from_secs(secs: u64) -> String {
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

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn collect_files(
    roots: &[PathBuf],
    extensions: &[&str],
    max_results: usize,
    recursive: bool,
) -> Result<Vec<FileEntry>, String> {
    let mut entries = Vec::new();
    let ext_lower: Vec<String> = extensions.iter().map(|e| e.to_lowercase()).collect();

    for root in roots {
        if !root.exists() || !root.is_dir() {
            continue;
        }
        collect_files_inner(root, &ext_lower, max_results, recursive, &mut entries);
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
    entries: &mut Vec<FileEntry>,
) {
    if entries.len() >= max_results {
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
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            if recursive && !SKIP_DIRS.contains(&file_name.as_str()) {
                collect_files_inner(&path, extensions, max_results, recursive, entries);
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
        let size_bytes = metadata.as_ref().and_then(|m| Some(m.len()));
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

fn user_home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\Users\\Default"))
}

#[tauri::command]
fn scan_installed_apps() -> Result<Vec<AppEntry>, String> {
    // Windows-only: scan Start Menu and Desktop shortcuts
    #[cfg(not(target_os = "windows"))]
    {
        return Ok(Vec::new());
    }

    #[cfg(target_os = "windows")]
    {
        let mut apps: Vec<AppEntry> = Vec::new();
        let mut seen_names: std::collections::HashSet<String> = std::collections::HashSet::new();

        let start_menu_paths = vec![
            PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"),
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("Microsoft\\Windows\\Start Menu\\Programs"),
        ];

        let desktop_paths = vec![
            dirs::desktop_dir().unwrap_or_else(|| PathBuf::from(".")),
            PathBuf::from("C:\\Users\\Public\\Desktop"),
        ];

        for root in start_menu_paths.iter().chain(desktop_paths.iter()) {
            if !root.exists() {
                continue;
            }
            collect_lnk_files(root, &mut apps, &mut seen_names);
        }

        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
    Some((lnk_path.to_string_lossy().to_string(), None))
}

#[cfg(target_os = "windows")]
fn collect_lnk_files(
    dir: &Path,
    apps: &mut Vec<AppEntry>,
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
            collect_lnk_files(&path, apps, seen_names);
            continue;
        }
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ext != "lnk" {
            continue;
        }
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let normalized = name.to_lowercase();
        if seen_names.contains(&normalized) {
            continue;
        }
        seen_names.insert(normalized);

        // Resolve .lnk target using Windows COM IShellLink
        let (resolved_path, icon_path) =
            resolve_lnk_target(&path).unwrap_or_else(|| (path.to_string_lossy().to_string(), None));

        apps.push(AppEntry {
            name,
            path: resolved_path,
            icon_path,
            publisher: None,
            install_location: path.parent().map(|p| p.to_string_lossy().to_string()),
        });
    }
}

#[tauri::command]
fn scan_user_documents(
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
fn scan_user_images(max_results: Option<usize>) -> Result<Vec<FileEntry>, String> {
    let home = user_home();
    let roots = vec![
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Pictures"),
        home.join("Downloads"),
    ];
    let exts = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico"];
    let max = max_results.unwrap_or(200);
    collect_files(&roots, &exts, max, true)
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
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
fn read_mcp_config() -> Result<Option<String>, String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Cannot determine config directory".to_string())?;
    let config_path = config_dir.join("javis").join("mcp.json");

    if !config_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&config_path)
        .map(Some)
        .map_err(|e| format!("Cannot read MCP config: {}", e))
}

#[tauri::command]
fn write_mcp_config(json: String) -> Result<(), String> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| "Cannot determine config directory".to_string())?;
    let javis_dir = config_dir.join("javis");

    fs::create_dir_all(&javis_dir).map_err(|e| format!("Cannot create config directory: {}", e))?;

    let config_path = javis_dir.join("mcp.json");
    fs::write(&config_path, &json).map_err(|e| format!("Cannot write MCP config: {}", e))?;

    Ok(())
}

#[tauri::command]
fn append_task_audit_jsonl_line(
    app: AppHandle,
    request: AppendTaskAuditJsonLineRequest,
) -> Result<(), String> {
    let path = task_audit_jsonl_path(&app)?;
    append_jsonl_line_to_path(&path, &request.line, "Task audit")
}

#[tauri::command]
fn append_task_session_jsonl_line(
    app: AppHandle,
    request: AppendTaskAuditJsonLineRequest,
) -> Result<(), String> {
    let path = task_session_jsonl_path(&app)?;
    append_jsonl_line_to_path(&path, &request.line, "Task session")
}

fn task_audit_jsonl_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(data_dir.join("task-audit.jsonl"))
}

fn task_session_jsonl_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(data_dir.join("task-session.jsonl"))
}

fn append_jsonl_line_to_path(path: &Path, line: &str, label: &str) -> Result<(), String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} JSONL line cannot be empty."));
    }
    if trimmed.lines().count() != 1 {
        return Err(format!(
            "{label} JSONL append accepts exactly one JSON line."
        ));
    }
    serde_json::from_str::<serde_json::Value>(trimmed)
        .map_err(|error| format!("{label} JSONL line must be valid JSON: {error}"))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {label} directory: {error}"))?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Could not open {label} JSONL file: {error}"))?;
    writeln!(file, "{trimmed}")
        .map_err(|error| format!("Could not append {label} JSONL line: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(PdfOrganizationApprovalState::default()))
        .manage(Mutex::new(CodePatchApprovalState::default()))
        .invoke_handler(tauri::generate_handler![
            scan_markdown_documents,
            run_read_only_command,
            fetch_web_source,
            search_web_sources,
            inspect_project,
            save_model_api_key_secret,
            delete_model_api_key_secret,
            propose_code_edit,
            complete_model_prompt,
            stream_model_prompt,
            streaming::stream_model_prompt_start,
            streaming::stream_model_prompt_cancel,
            streaming::cancel_all_model_streams,
            approve_code_patch,
            apply_code_patch,
            plan_pdf_organization,
            approve_pdf_organization,
            restore_pdf_organization_approval,
            execute_pdf_organization,
            scan_installed_apps,
            scan_user_documents,
            scan_user_images,
            list_directory,
            read_mcp_config,
            write_mcp_config,
            append_task_audit_jsonl_line,
            append_task_session_jsonl_line
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
