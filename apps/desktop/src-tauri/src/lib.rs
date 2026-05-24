use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodePatchApplyRequest {
    workspace_path: String,
    changed_files: Vec<String>,
    patch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeApplyResult {
    applied: bool,
    workspace_path: String,
    changed_files: Vec<String>,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeProposeEditRequest {
    workspace_path: String,
    user_goal: String,
    changed_files: Vec<String>,
    diff: String,
    provider_id: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeProposedEdit {
    proposal_id: String,
    workspace_path: String,
    summary: String,
    changed_files: Vec<String>,
    patch: String,
    patch_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCodeProposal {
    summary: String,
    changed_files: Vec<String>,
    patch: String,
}

#[derive(Default)]
struct PdfOrganizationApprovalState {
    pending: Option<PendingPdfOrganizationApproval>,
}

struct PendingPdfOrganizationApproval {
    approval_id: String,
    operations: Vec<PlannedPathOperation>,
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
    replace_pending_pdf_approval(&approval_state, &approval_id, &operations)?;

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
    approval_state: tauri::State<'_, Mutex<PdfOrganizationApprovalState>>,
) -> Result<(), String> {
    approve_pending_pdf_organization(&approval_state, &approval_id)
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
    let executable = resolve_command_program(&request.program);
    let output = Command::new(executable)
        .args(&request.args)
        .current_dir(&cwd)
        .output()
        .map_err(|error| error.to_string())?;

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
        return search_with_agent_chrome(query, max_results)
            .map_err(|error| format!("GitHub CLI search disabled; Chrome fallback failed: {error}"));
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
fn apply_code_patch(request: CodePatchApplyRequest) -> Result<CodeApplyResult, String> {
    let workspace = resolve_workspace_path(Some(request.workspace_path.clone()))?;
    apply_code_patch_in_workspace(&workspace, request)
}

#[tauri::command]
fn propose_code_edit(request: CodeProposeEditRequest) -> Result<CodeProposedEdit, String> {
    let workspace = resolve_workspace_path(Some(request.workspace_path.clone()))?;
    propose_code_edit_with_opencode(&workspace, request)
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
        let workspace = fs::canonicalize(trimmed_path)
            .map_err(|error| format!("Selected workspace path is not accessible: {trimmed_path}: {error}"))?;
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
    for file in &request.changed_files {
        let relative_path = normalize_relative_code_path(file)?;
        ensure_code_path_stays_in_workspace(&canonical_workspace, &relative_path)?;
    }

    if env_flag_enabled("JAVIS_QA_MODE") {
        if let Some(path) = env::var_os("JAVIS_CODE_PROPOSAL_FIXTURE_PATH").map(PathBuf::from) {
            let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
            return parse_code_proposal_from_text(&canonical_workspace, &content);
        }
    } else if env::var_os("JAVIS_CODE_PROPOSAL_FIXTURE_PATH").is_some() {
        return Err("Code proposal fixtures require JAVIS_QA_MODE=1.".to_string());
    }

    let prompt = create_opencode_proposal_prompt(&request);
    let output = run_opencode_proposal_command(&canonical_workspace, &prompt, &request)?;
    parse_code_proposal_from_text(&canonical_workspace, &output)
}

fn run_opencode_proposal_command(
    workspace: &Path,
    prompt: &str,
    request: &CodeProposeEditRequest,
) -> Result<String, String> {
    let opencode = resolve_opencode_program();
    let invocation = create_opencode_proposal_invocation(workspace, prompt, request)?;
    let output = Command::new(&opencode)
        .args(&invocation.args)
        .current_dir(workspace)
        .env("OPENCODE_CONFIG_CONTENT", invocation.config_content)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
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
    if let Some(model) = normalize_optional_config_value(request.model.as_deref()) {
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
        let model_name = normalize_optional_config_value(request.model.as_deref())
            .and_then(|model| model.split_once('/').map(|(_, name)| name.to_string()))
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
        .and_then(|model| model.split_once('/').map(|(provider, _)| provider.to_string()))
        .unwrap_or_else(|| "openai".to_string())
}

fn normalize_optional_config_value(value: Option<&str>) -> Option<String> {
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
    format!(
        r#"You are generating a patch proposal for Javis. Do not edit files. Return only JSON with keys summary, changedFiles, and patch. The patch must be a unified diff for only the approved changed files.

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

fn parse_code_proposal_from_text(
    workspace: &Path,
    text: &str,
) -> Result<CodeProposedEdit, String> {
    let canonical_workspace = fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace is not accessible: {error}"))?;
    let raw = extract_raw_code_proposal(text)?;
    validate_raw_code_proposal(&canonical_workspace, &raw)?;
    let mut proposal = CodeProposedEdit {
        proposal_id: format!("opencode-{}", create_approval_id()),
        workspace_path: normalize_path(&canonical_workspace),
        summary: raw.summary.trim().to_string(),
        changed_files: raw.changed_files,
        patch: raw.patch,
        patch_hash: String::new(),
    };
    proposal.patch_hash = create_code_proposal_hash(&proposal);
    Ok(proposal)
}

fn extract_raw_code_proposal(text: &str) -> Result<RawCodeProposal, String> {
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
            if let Some(text) = value.get("text").and_then(|text| text.as_str()) {
                if let Ok(raw) = serde_json::from_str::<RawCodeProposal>(text.trim()) {
                    return Ok(raw);
                }
            }
        }
    }

    Err("opencode did not return a parseable CodeProposedEdit JSON object.".to_string())
}

fn validate_raw_code_proposal(workspace: &Path, proposal: &RawCodeProposal) -> Result<(), String> {
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
    for file in &approved_files {
        ensure_code_path_stays_in_workspace(workspace, file)?;
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
    let payload = std::iter::once(edit.proposal_id.as_str())
        .chain(std::iter::once(edit.workspace_path.as_str()))
        .chain(edit.changed_files.iter().map(String::as_str))
        .chain(std::iter::once(edit.patch.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    let mut hash = 2166136261u32;
    for byte in payload.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("fnv1a-{hash:08x}")
}

fn apply_code_patch_in_workspace(
    workspace: &Path,
    request: CodePatchApplyRequest,
) -> Result<CodeApplyResult, String> {
    let canonical_workspace = fs::canonicalize(workspace)
        .map_err(|error| format!("Workspace is not accessible: {error}"))?;
    let patch = request.patch.trim();
    if patch.is_empty() {
        return Err("Code patch cannot be empty.".to_string());
    }
    if request.changed_files.is_empty() {
        return Err("Code patch must list at least one approved changed file.".to_string());
    }

    let approved_files = request
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;

    let patch_files = extract_unified_diff_paths(patch)?;
    for file in &patch_files {
        if !approved_files.contains(file) {
            return Err(format!(
                "Patch includes an unapproved file path: {}",
                file.display()
            ));
        }
    }
    for file in &approved_files {
        ensure_code_path_stays_in_workspace(&canonical_workspace, file)?;
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
        message: format!("Applied patch to {} approved file(s).", approved_files.len()),
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
    if path.components().any(|component| matches!(component, std::path::Component::ParentDir)) {
        return Err("Changed file path cannot contain parent directory traversal.".to_string());
    }
    Ok(path)
}

fn ensure_code_path_stays_in_workspace(workspace: &Path, relative_path: &Path) -> Result<(), String> {
    let target = workspace.join(relative_path);
    let parent = target
        .parent()
        .ok_or_else(|| "Changed file path does not have a parent directory.".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("Changed file parent is not accessible: {error}"))?;
    if !canonical_parent.starts_with(workspace) {
        return Err("Changed file path must stay inside the selected workspace.".to_string());
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

fn search_with_github_cli(
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, String> {
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

fn search_with_agent_chrome(query: &str, max_results: usize) -> Result<Vec<WebSearchResult>, String> {
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
                let elapsed = SystemTime::now()
                    .duration_since(start)
                    .unwrap_or_default();
                if elapsed >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(format!("Command timed out after {} seconds.", timeout.as_secs()));
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
    let end_index = after_tag.find("</p>").or_else(|| after_tag.find("</div>"))?;
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

fn replace_pending_pdf_approval(
    approval_state: &Mutex<PdfOrganizationApprovalState>,
    approval_id: &str,
    operations: &[PlannedPathOperation],
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "PDF approval state could not be locked.".to_string())?;
    state.pending = Some(PendingPdfOrganizationApproval {
        approval_id: approval_id.to_string(),
        operations: operations.to_vec(),
        approved: false,
    });
    Ok(())
}

fn approve_pending_pdf_organization(
    approval_state: &Mutex<PdfOrganizationApprovalState>,
    approval_id: &str,
) -> Result<(), String> {
    let mut state = approval_state
        .lock()
        .map_err(|_| "PDF approval state could not be locked.".to_string())?;
    let Some(pending) = state.pending.as_mut() else {
        return Err("No pending PDF organization approval exists.".to_string());
    };
    if pending.approval_id != approval_id {
        return Err("PDF organization approval id does not match the pending dry-run.".to_string());
    }
    pending.approved = true;
    Ok(())
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
    if pending.approval_id != request.approval_id {
        return Err("PDF organization approval id does not match the pending dry-run.".to_string());
    }
    if !pending.approved {
        return Err("PDF organization dry-run has not been approved.".to_string());
    }
    if pending.operations != request.operations {
        return Err(
            "Approved PDF organization operations do not match the current dry-run.".to_string(),
        );
    }
    let operations = request.operations;
    state.pending = None;
    Ok(operations)
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
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        let operations = vec![planned_pdf_operation()];
        replace_pending_pdf_approval(&approval_state, "approval-1", &operations)
            .expect("store pending approval");

        let result = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations,
            },
        );

        assert_eq!(
            result.expect_err("approval should be required"),
            "PDF organization dry-run has not been approved."
        );
    }

    #[test]
    fn pdf_operations_must_match_the_approved_dry_run() {
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        let operations = vec![planned_pdf_operation()];
        replace_pending_pdf_approval(&approval_state, "approval-1", &operations)
            .expect("store pending approval");
        approve_pending_pdf_organization(&approval_state, "approval-1").expect("approve plan");
        let mut changed_operations = operations;
        changed_operations[0].target = "C:/Users/example/Downloads/Other/paper.pdf".to_string();

        let result = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations: changed_operations,
            },
        );

        assert_eq!(
            result.expect_err("changed operations should be rejected"),
            "Approved PDF organization operations do not match the current dry-run."
        );
    }

    #[test]
    fn approved_pdf_operations_are_one_time_use() {
        let approval_state = Mutex::new(PdfOrganizationApprovalState::default());
        let operations = vec![planned_pdf_operation()];
        replace_pending_pdf_approval(&approval_state, "approval-1", &operations)
            .expect("store pending approval");
        approve_pending_pdf_organization(&approval_state, "approval-1").expect("approve plan");

        let approved_operations = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations: operations.clone(),
            },
        )
        .expect("approved operations");
        let second_result = take_approved_pdf_operations(
            &approval_state,
            ExecuteFileOrganizationRequest {
                approval_id: "approval-1".to_string(),
                operations,
            },
        );

        assert_eq!(approved_operations.len(), 1);
        assert_eq!(
            second_result.expect_err("approval should be consumed"),
            "No approved PDF organization dry-run is pending."
        );
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
            &["checkout".to_string(), "--".to_string(), "src/lib.rs".to_string()]
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

        assert!(
            result
                .expect_err("missing workspace should fail")
                .starts_with("Selected workspace path is not accessible:")
        );
    }

    #[test]
    fn resolve_workspace_rejects_file_paths() {
        let root = create_test_directory("workspace-file-path");
        let file_path = root.join("package.json");
        fs::write(&file_path, "{}").expect("write file path");

        let result = resolve_workspace_path(Some(normalize_path(&file_path)));

        assert!(
            result
                .expect_err("file workspace path should fail")
                .starts_with("Selected workspace path is not a directory:")
        );
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
            CodePatchApplyRequest {
                workspace_path: normalize_path(&root),
                changed_files: vec!["src/message.txt".to_string()],
                patch,
            },
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
            CodePatchApplyRequest {
                workspace_path: normalize_path(&root),
                changed_files: vec!["src/allowed.txt".to_string()],
                patch: patch.to_string(),
            },
        );

        assert_eq!(
            result.expect_err("unapproved path should fail"),
            "Patch includes an unapproved file path: src/other.txt"
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn apply_code_patch_rejects_parent_directory_paths() {
        let root = create_test_directory("code-patch-traversal");

        let result = apply_code_patch_in_workspace(
            &root,
            CodePatchApplyRequest {
                workspace_path: normalize_path(&root),
                changed_files: vec!["../outside.txt".to_string()],
                patch: "diff --git a/../outside.txt b/../outside.txt\n".to_string(),
            },
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
    fn code_proposal_hash_matches_core_test_vector() {
        let proposal = CodeProposedEdit {
            proposal_id: "opencode-test".to_string(),
            workspace_path: "E:/Javis".to_string(),
            summary: "Tighten message copy.".to_string(),
            changed_files: vec!["src/message.txt".to_string()],
            patch: "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
            patch_hash: String::new(),
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
            base_url: Some("https://api.example.test/v1".to_string()),
        };

        let invocation =
            create_opencode_proposal_invocation(&root, "Return JSON.", &request).expect("invocation");
        let config: serde_json::Value =
            serde_json::from_str(&invocation.config_content).expect("config json");

        assert!(invocation.args.windows(2).any(|pair| pair == ["--model", "openai/gpt-5.1-codex"]));
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
            base_url: Some("http://127.0.0.1:11434/v1".to_string()),
        };
        let config: serde_json::Value =
            serde_json::from_str(&create_opencode_config_content(&request).expect("config"))
                .expect("config json");

        assert_eq!(config["provider"]["custom"]["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(config["provider"]["custom"]["models"]["local-model"]["name"], "local-model");
        assert_eq!(config["provider"]["custom"]["options"]["apiKey"], "local-key");
        assert_eq!(
            config["provider"]["custom"]["options"]["baseURL"],
            "http://127.0.0.1:11434/v1"
        );
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
                base_url: None,
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
                url: "https://github.com/expert-vision-software/opencode-intellisearch"
                    .to_string(),
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
        assert_eq!(results[0].title.as_deref(), Some("expert-vision-software/opencode-intellisearch"));
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

    fn create_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("javis-{name}-{unique}"));
        fs::create_dir_all(&root).expect("create test directory");
        root
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

    fn planned_pdf_operation() -> PlannedPathOperation {
        PlannedPathOperation {
            source: "C:/Users/example/Downloads/paper.pdf".to_string(),
            target: "C:/Users/example/Downloads/Research/paper.pdf".to_string(),
            action: "move".to_string(),
            conflict: None,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(PdfOrganizationApprovalState::default()))
        .invoke_handler(tauri::generate_handler![
            scan_markdown_documents,
            run_read_only_command,
            fetch_web_source,
            search_web_sources,
            inspect_project,
            propose_code_edit,
            apply_code_patch,
            plan_pdf_organization,
            approve_pdf_organization,
            execute_pdf_organization
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
