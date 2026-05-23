use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::Read,
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

    let mut response = ureq::get(&request.url)
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
    let package_json = fs::read_to_string(&package_json_path).map_err(|error| error.to_string())?;
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
        return fs::canonicalize(path).map_err(|error| error.to_string());
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
        "https://duckduckgo.com/html/?q={}",
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
    let results = parse_duckduckgo_html_results(&html, max_results);
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

fn parse_duckduckgo_html_results(html: &str, max_results: usize) -> Vec<WebSearchResult> {
    let fetched_at = format_system_time(SystemTime::now());
    let mut results = Vec::new();
    let mut remaining = html;

    while results.len() < max_results {
        let Some(link_index) = remaining.find("result__a") else {
            break;
        };
        remaining = &remaining[link_index..];
        let Some(href) = extract_html_attribute(remaining, "href") else {
            remaining = &remaining["result__a".len()..];
            continue;
        };
        let Some(close_index) = remaining.find('>') else {
            break;
        };
        let after_link = &remaining[close_index + 1..];
        let Some(end_index) = after_link.find("</a>") else {
            break;
        };
        let title = html_to_text(&after_link[..end_index]);
        let excerpt = extract_result_snippet(after_link)
            .filter(|snippet| !snippet.is_empty())
            .unwrap_or_else(|| title.clone());
        if let Some(url) = normalize_duckduckgo_url(&href) {
            results.push(WebSearchResult {
                url,
                title: (!title.is_empty()).then_some(title),
                excerpt,
                fetched_at: fetched_at.clone(),
                provider: Some("agent-chrome".to_string()),
            });
        }
        remaining = &after_link[end_index..];
    }

    results
}

fn extract_result_snippet(value: &str) -> Option<String> {
    let index = value.find("result__snippet")?;
    let snippet = &value[index..];
    let close_index = snippet.find('>')?;
    let after_tag = &snippet[close_index + 1..];
    let end_index = after_tag.find("</a>").or_else(|| after_tag.find("</div>"))?;
    Some(html_to_text(&after_tag[..end_index]))
}

fn extract_html_attribute(value: &str, attribute: &str) -> Option<String> {
    let pattern = format!("{attribute}=\"");
    let start = value.find(&pattern)? + pattern.len();
    let rest = &value[start..];
    let end = rest.find('"')?;
    Some(html_decode(&rest[..end]))
}

fn normalize_duckduckgo_url(value: &str) -> Option<String> {
    if value.starts_with("http://") || value.starts_with("https://") {
        return Some(value.to_string());
    }
    if let Some(index) = value.find("uddg=") {
        let encoded = &value[index + "uddg=".len()..];
        let end = encoded.find('&').unwrap_or(encoded.len());
        return Some(percent_decode(&encoded[..end]));
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

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                output.push(byte);
                index += 3;
                continue;
            }
        }
        output.push(if bytes[index] == b'+' { b' ' } else { bytes[index] });
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
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
    file.by_ref()
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
    fn parses_agent_chrome_duckduckgo_results() {
        let html = r#"
          <a rel="nofollow" class="result__a" href="https://example.com/alpha">Alpha &amp; Docs</a>
          <a class="result__snippet">Useful alpha evidence.</a>
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta&amp;rut=1">Beta</a>
          <a class="result__snippet">Useful beta evidence.</a>
        "#;

        let results = parse_duckduckgo_html_results(html, 3);

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
        assert_eq!(percent_decode(&encoded), "opencode intellisearch/Rust");
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
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(PdfOrganizationApprovalState::default()))
        .invoke_handler(tauri::generate_handler![
            scan_markdown_documents,
            run_read_only_command,
            fetch_web_source,
            search_web_sources,
            inspect_project,
            plan_pdf_organization,
            approve_pdf_organization,
            execute_pdf_organization
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
