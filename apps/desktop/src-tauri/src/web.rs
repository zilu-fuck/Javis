use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{env, fs, io::Read, path::PathBuf, process::{Command, Output, Stdio}, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

use crate::{resolve_command_program, format_system_time, html_to_text, extract_title, html_decode, env_flag_enabled, search_with_fixture_file};


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSourceRequest {
    url: String,
}

/// Detect whether a search query is likely a code/tech query that
/// benefits from GitHub repository search rather than general web search.
fn is_code_search_query(query: &str) -> bool {
    let q = query.to_lowercase();
    let code_patterns = [
        // English
        "github", "repo", "repository", "code", "library", "npm", "package",
        "api", "sdk", "framework", "bug", "issue", "pr ", "pull request",
        "commit", "release", "changelog", "dependency", "rust ", "crate",
        "typescript", "javascript", "python ", "golang", "docker", "kubernetes",
        "open source", "plugin", "extension", "component", "module",
        // Chinese
        "代码", "仓库", "开源", "插件", "模块", "组件", "依赖", "框架",
        "npm 包", "库",
    ];
    code_patterns.iter().any(|p| q.contains(p))
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSearchRequest {
    pub(crate) query: String,
    pub(crate) max_results: Option<usize>,
    /// "auto" (default): detect intent and route accordingly.
    /// "code": prefer GitHub CLI search, fall back to web.
    /// "web": skip GitHub, go directly to web search.
    #[serde(default = "default_search_type")]
    pub(crate) search_type: String,
}

fn default_search_type() -> String {
    "auto".to_string()
}


#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSource {
    url: String,
    title: Option<String>,
    excerpt: String,
    fetched_at: String,
}


#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebSearchResult {
    pub(crate) url: String,
    pub(crate) title: Option<String>,
    pub(crate) excerpt: String,
    pub(crate) fetched_at: String,
    pub(crate) provider: Option<String>,
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GithubSearchItem {
    pub(crate) full_name: String,
    pub(crate) description: Option<String>,
    pub(crate) url: String,
    pub(crate) updated_at: Option<String>,
}


#[tauri::command]
pub(crate) fn fetch_web_source(request: WebSourceRequest) -> Result<WebSource, String> {
    if !request.url.starts_with("https://") && !request.url.starts_with("http://") {
        return Err("Only http and https URLs are supported.".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    let body = client
        .get(&request.url)
        .header("User-Agent", "Javis/0.1")
        .send()
        .map_err(|error| error.to_string())?
        .text()
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
pub(crate) fn search_web_sources(request: WebSearchRequest) -> Result<Vec<WebSearchResult>, String> {
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

    let prefer_github = match request.search_type.as_str() {
        "web" => false,                       // Explicitly skip GitHub
        "code" => true,                       // Explicitly use GitHub
        _ => is_code_search_query(query),     // "auto": detect intent
    };

    if env_flag_enabled("JAVIS_SEARCH_DISABLE_GITHUB_CLI") {
        return search_with_agent_chrome(query, max_results).map_err(|error| {
            format!("GitHub CLI search disabled; Chrome fallback failed: {error}")
        });
    }

    if !prefer_github {
        return search_with_agent_chrome(query, max_results)
            .map_err(|error| format!("Web search failed: {error}"));
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


pub(crate) fn search_with_github_cli(query: &str, max_results: usize) -> Result<Vec<WebSearchResult>, String> {
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


pub(crate) fn github_items_to_search_results(
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


pub(crate) fn search_with_agent_chrome(
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


pub(crate) fn resolve_agent_chrome_program() -> Option<PathBuf> {
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


pub(crate) fn create_agent_chrome_profile_dir() -> Result<PathBuf, String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let directory = env::temp_dir().join(format!("javis-agent-chrome-{suffix}"));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}


pub(crate) fn run_command_with_timeout(
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


pub(crate) fn parse_bing_html_results(html: &str, max_results: usize) -> Vec<WebSearchResult> {
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


pub(crate) fn extract_bing_snippet(value: &str) -> Option<String> {
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


pub(crate) fn extract_html_attribute(value: &str, attribute: &str) -> Option<String> {
    let pattern = format!("{attribute}=\"");
    let start = value.find(&pattern)? + pattern.len();
    let rest = &value[start..];
    let end = rest.find('"')?;
    Some(html_decode(&rest[..end]))
}


pub(crate) fn normalize_bing_url(value: &str) -> Option<String> {
    if let Some(index) = value.find("u=") {
        let encoded = &value[index + "u=".len()..];
        let end = encoded.find('&').unwrap_or(encoded.len());
        let encoded = encoded[..end].trim_start_matches("a1");
        if !encoded.is_empty() {
            let mut padded = encoded.replace('-', "+").replace('_', "/");
            while !padded.len().is_multiple_of(4) {
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


pub(crate) fn percent_encode_query(value: &str) -> String {
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

