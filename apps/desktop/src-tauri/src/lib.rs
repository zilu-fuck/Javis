use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
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

#[tauri::command]
fn scan_markdown_documents(workspace_path: Option<String>) -> Result<Vec<MarkdownDocument>, String> {
    let workspace = resolve_workspace_path(workspace_path)?;
    let mut documents = Vec::new();
    scan_directory(&workspace, &workspace, &mut documents)?;
    documents.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    documents.truncate(50);
    Ok(documents)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_markdown_documents])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
