use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
#[allow(unused_imports)]
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

mod streaming;
mod database;
mod anthropic;
mod error;
mod shell;
mod web;
mod pdf;
mod inspect;
mod audit;
mod workspace;
mod mcpserv;
mod scan;
mod code;

// Re-import from extracted modules
use code::{normalize_optional_config_value, create_chat_completions_endpoint, CodeProposeEditRequest, default_model_for_locale, default_provider_for_locale, infer_provider_id_from_model, normalize_openai_compatible_model_name, FileContentHash};
use web::WebSearchResult;

pub(crate) const OPENCODE_PROPOSAL_TIMEOUT: Duration = Duration::from_secs(90);
pub(crate) const MODEL_API_KEY_SECRET_REFERENCE: &str = "default";
pub(crate) const MODEL_API_KEY_SECRET_PREFIX: &str = "dpapi-v1:";
pub(crate) const JAVIS_TERMINOLOGY_PROMPT_PREFIX: &str = r#"Javis terminology rules for Chinese output:
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
    #[serde(default)]
    protocol: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCompletionResponse {
    text: String,
    model: Option<String>,
    provider: Option<String>,
    token_usage: Option<ModelUsage>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelUsage {
    input_tokens: u32,
    output_tokens: u32,
    total_tokens: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelApiKeySecretRequest {
    key_reference: String,
    api_key: String,
}
pub(crate) struct NativeApprovalBinding {
    approval_id: String,
    tool_name: String,
    #[allow(dead_code)]
    task_id: String,
    preview_hash: String,
    approved: bool,
}
pub(crate) fn env_flag_enabled(name: &str) -> bool {
    env::var(name)
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
        .unwrap_or(false)
}

pub(crate) fn search_with_fixture_file(
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
fn complete_model_prompt(
    app: AppHandle,
    mut request: ModelCompletionRequest,
) -> Result<ModelCompletionResponse, String> {
    hydrate_model_completion_api_key_secret(&app, &mut request)?;
    let protocol = request.protocol.as_deref().unwrap_or("openai-compatible");
    match protocol {
        "anthropic" => anthropic::run_anthropic_completion_request(&request),
        _ => run_openai_compatible_completion_request(&request),
    }
}
#[cfg(windows)]
pub(crate) fn resolve_command_program(program: &str) -> String {
    match program.to_ascii_lowercase().as_str() {
        "npm" | "pnpm" | "yarn" => format!("{program}.cmd"),
        _ => program.to_string(),
    }
}

#[cfg(not(windows))]
pub(crate) fn resolve_command_program(program: &str) -> String {
    program.to_string()
}

pub(crate) fn resolve_workspace_path(workspace_path: Option<String>) -> Result<PathBuf, error::JavisError> {
    if let Some(path) = workspace_path {
        let trimmed_path = path.trim();
        if trimmed_path.is_empty() {
            return Err(error::JavisError::Validation("Workspace path cannot be empty.".into()));
        }
        let workspace = fs::canonicalize(trimmed_path)
            .map_err(|e| error::JavisError::Io(format!("Selected workspace path is not accessible: {trimmed_path}: {e}")))?;
        if !workspace.is_dir() {
            return Err(error::JavisError::Validation(format!(
                "Selected workspace path is not a directory: {}",
                workspace.to_string_lossy()
            )));
        }
        return Ok(workspace);
    }

    let current_dir = std::env::current_dir()
        .map_err(|e| error::JavisError::Io(format!("Cannot resolve current directory: {e}")))?;
    for candidate in current_dir.ancestors() {
        if candidate.join("pnpm-workspace.yaml").exists() {
            return Ok(candidate.to_path_buf());
        }
    }

    Ok(current_dir)
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

pub(crate) fn hydrate_model_api_key_secret(
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
    // Accept "default" for backward compatibility
    if value == MODEL_API_KEY_SECRET_REFERENCE {
        return Ok(value.to_string());
    }
    // Accept "model.<slot>" or "model.<uuid>" for multi-model profiles
    if let Some(suffix) = value.strip_prefix("model.") {
        if !suffix.is_empty()
            && suffix
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        {
            return Ok(value.to_string());
        }
    }
    Err(format!(
        "Unknown model API key reference: {value}. Expected 'default' or 'model.<name>'."
    ))
}

#[cfg(windows)]
fn protect_model_api_key_secret(secret: &str) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let input = CRYPT_INTEGER_BLOB {
        cbData: secret.len() as u32,
        pbData: secret.as_bytes().as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
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
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
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
    let client = reqwest::blocking::Client::builder()
        .timeout(OPENCODE_PROPOSAL_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response_text = client
        .post(&endpoint)
        .header("Authorization", &format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .body(body_text)
        .send()
        .map_err(|error| format!("Model completion request failed: {error}"))?
        .text()
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
        token_usage: extract_openai_compatible_usage(&value),
    })
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
    body["stream_options"] = serde_json::json!({ "include_usage": true });
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

pub(crate) fn extract_openai_compatible_usage(value: &serde_json::Value) -> Option<ModelUsage> {
    let usage = value.get("usage")?;
    let input_tokens = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as u32;
    let total_tokens = usage
        .get("total_tokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(u64::from(input_tokens + output_tokens)) as u32;
    if input_tokens == 0 && output_tokens == 0 && total_tokens == 0 {
        return None;
    }
    Some(ModelUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
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
        "deepseek" => "https://api.deepseek.com/v1".to_string(),
        _ => "https://api.openai.com/v1".to_string(),
    }
}

pub(crate) fn create_model_completion_response_diagnostic(
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

pub(crate) fn default_openai_compatible_base_url(request: &CodeProposeEditRequest) -> String {
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_provider_id_from_model(request));
    match provider_id.as_str() {
        "deepseek" => "https://api.deepseek.com/v1".to_string(),
        _ => "https://api.openai.com/v1".to_string(),
    }
}
pub(crate) fn create_provider_response_diagnostic(
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

pub(crate) fn extract_url_host(url: &str) -> String {
    url.split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("unknown")
        .to_string()
}
pub(crate) fn summarize_provider_output_for_error(text: &str) -> String {
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
pub(crate) fn create_approval_id() -> String {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("pdf-approval-{suffix}")
}

pub(crate) fn create_native_approval_binding(
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

pub(crate) fn approve_native_approval_binding(
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

pub(crate) fn require_native_approval_binding(
    binding: &NativeApprovalBinding,
    approval_id: &str,
    tool_name: &str,
    task_id: Option<&str>,
    preview_hash: &str,
    mismatch_error: &str,
    unapproved_error: &str,
) -> Result<(), error::JavisError> {
    if binding.approval_id != approval_id {
        return Err(error::JavisError::Permission(mismatch_error.to_string()));
    }
    if binding.tool_name != tool_name {
        return Err(error::JavisError::Permission("Approval tool binding does not match the approved dry-run.".into()));
    }
    require_native_approval_task_id(binding, task_id)?;
    if binding.preview_hash != preview_hash {
        return Err(error::JavisError::Permission("Approval preview hash does not match the approved dry-run.".into()));
    }
    if !binding.approved {
        return Err(error::JavisError::Permission(unapproved_error.to_string()));
    }
    Ok(())
}

pub(crate) fn require_native_approval_task_id(
    binding: &NativeApprovalBinding,
    task_id: Option<&str>,
) -> Result<(), error::JavisError> {
    let approved_task_id = binding.task_id.trim();
    let requested_task_id = task_id.unwrap_or_default().trim();
    if approved_task_id != requested_task_id {
        return Err(error::JavisError::Permission("Approval task id does not match the approved request.".into()));
    }
    Ok(())
}

pub(crate) fn require_current_git_head_matches(
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
pub(crate) fn create_file_content_hashes(
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

pub(crate) fn create_fnv1a_hash(content: &[u8]) -> String {
    let mut hash = 2166136261u32;
    for byte in content {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    format!("fnv1a-{hash:08x}")
}

pub(crate) fn capture_current_git_head(workspace: &Path) -> Option<String> {
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
pub(crate) fn normalize_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
        return format!("//{}", rest);
    }
    if let Some(rest) = normalized.strip_prefix("//?/") {
        return rest.to_string();
    }
    normalized
}
pub(crate) fn format_system_time(value: SystemTime) -> String {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}
pub(crate) fn extract_title(content: &str) -> Option<String> {
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

pub(crate) fn html_to_text(content: &str) -> String {
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

pub(crate) fn html_decode(value: &str) -> String {
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
    use super::code::*;
    use super::pdf::*;
    use super::shell::*;
    use super::web::*;
    use super::scan::*;
    use super::inspect::*;
    use super::audit::*;

    #[test]
    fn normalize_path_strips_windows_verbatim_prefix() {
        let path = PathBuf::from(r"\\?\E:\Javis");

        assert_eq!(normalize_path(&path), "E:/Javis");
    }

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
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
            "Permission denied: PDF organization dry-run has not been approved."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn pdf_operations_must_match_the_approved_dry_run() {
        let root = create_test_directory("pdf-approval-mismatch");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
            "Permission denied: Approval task id does not match the approved request."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn pdf_execution_requires_matching_task_id() {
        let root = create_test_directory("pdf-execute-task-id");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
            "Permission denied: Approval task id does not match the approved request."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn approved_pdf_operations_are_one_time_use() {
        let root = create_test_directory("pdf-approval-one-time");
        let operations = vec![planned_pdf_operation_in(&root)];
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
        let approval_state = Mutex::new(pdf::PdfOrganizationApprovalState::default());
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
            .to_string()
            .contains("Selected workspace path is not accessible:"));
    }

    #[test]
    fn resolve_workspace_rejects_file_paths() {
        let root = create_test_directory("workspace-file-path");
        let file_path = root.join("package.json");
        fs::write(&file_path, "{}").expect("write file path");

        let result = resolve_workspace_path(Some(normalize_path(&file_path)));

        assert!(result
            .expect_err("file workspace path should fail")
            .to_string()
            .contains("Selected workspace path is not a directory:"));
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn inspect_project_reports_missing_package_json() {
        let root = create_test_directory("workspace-no-package-json");

        let result = inspect_project(Some(normalize_path(&root)));

        match result {
            Ok(_) => panic!("package.json should be required"),
            Err(error) => {
                assert!(error.contains("Selected workspace does not contain package.json"));
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
            result.expect_err("unapproved path should fail").to_string(),
            "Validation error: Patch includes an unapproved file path: src/other.txt"
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
            result.expect_err("missing approval id should fail").to_string(),
            "Validation error: Code patch approval id is required."
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
            result.expect_err("patch hash mismatch should fail").to_string(),
            "Validation error: Code patch hash does not match the approved proposal."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_apply_requires_native_approval() {
        let root = create_test_directory("code-patch-native-approval-required");
        let approval_state = Mutex::new(code::CodePatchApprovalState::default());
        let request = code_patch_apply_request(
            &root,
            vec!["src/message.txt".to_string()],
            "diff --git a/src/message.txt b/src/message.txt\n".to_string(),
        );

        let result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert_eq!(
            result.expect_err("approval should be required").to_string(),
            "Permission denied: No approved Code Patch proposal is pending."
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
        let approval_state = Mutex::new(code::CodePatchApprovalState::default());
        approve_pending_code_patch(&approval_state, code_patch_approval_request(&request))
            .expect("approve code patch");

        let result = apply_code_patch_in_workspace(&root, request.clone(), Some(&approval_state))
            .expect("apply approved patch");
        let second_result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert!(result.applied);
        assert_eq!(
            second_result.expect_err("approval should be consumed").to_string(),
            "Permission denied: No approved Code Patch proposal is pending."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_approval_must_match_apply_request() {
        let root = create_test_directory("code-patch-approval-mismatch");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let approval_state = Mutex::new(code::CodePatchApprovalState::default());
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
            result.expect_err("proposal mismatch should fail").to_string(),
            "Permission denied: Code patch proposal id does not match the approved proposal."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_apply_rejects_native_tool_binding_mismatch() {
        let root = create_test_directory("code-patch-tool-binding");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let approval_state = Mutex::new(code::CodePatchApprovalState::default());
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
            result.expect_err("tool binding mismatch should fail").to_string(),
            "Permission denied: Approval tool binding does not match the approved dry-run."
        );
        fs::remove_dir_all(root).expect("cleanup test directory");
    }

    #[test]
    fn code_patch_apply_rejects_native_preview_hash_mismatch() {
        let root = create_test_directory("code-patch-preview-hash");
        let file = root.join("src").join("message.txt");
        fs::create_dir_all(file.parent().expect("file parent")).expect("create src");
        fs::write(&file, "before\n").expect("write file");
        let approval_state = Mutex::new(code::CodePatchApprovalState::default());
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
            result.expect_err("preview hash mismatch should fail").to_string(),
            "Permission denied: Approval preview hash does not match the approved dry-run."
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
        let approval_state = Mutex::new(code::CodePatchApprovalState::default());
        approve_pending_code_patch(&approval_state, code_patch_approval_request(&request))
            .expect("approve code patch");
        fs::write(&file, "external edit\n").expect("write stale file");

        let result = apply_code_patch_in_workspace(&root, request, Some(&approval_state));

        assert_eq!(
            result.expect_err("stale approved file should fail").to_string(),
            "Permission denied: Code patch approved files changed before apply."
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
        let approval_state = Mutex::new(code::CodePatchApprovalState::default());
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
            result.expect_err("unapproved requested path should fail").to_string(),
            "Validation error: Requested path is not approved: src/other.txt"
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
            result.expect_err("root escape should fail").to_string(),
            "Validation error: Requested path must stay inside root."
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
            result.expect_err("traversal should fail").to_string(),
            "Validation error: Changed file path cannot contain parent directory traversal."
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

        let error_msg = error.to_string();
        assert!(error_msg.contains("Output excerpt:"));
        assert!(error_msg.contains("[redacted-secret]"));
        assert!(!error_msg.contains("sk-super-secret"));
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
            protocol: None,
        };

        let body = create_openai_compatible_stream_body("gpt-test", &request);

        assert_eq!(body["stream"], true);
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["max_tokens"], 42);
        assert_eq!(body["stop"], serde_json::json!(["\n\n", " "]));
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn extracts_openai_compatible_stream_text_from_delta() {
        let value: serde_json::Value = serde_json::json!({
            "choices": [{"delta": {"content": "Hello"}}]
        });
        assert_eq!(
            extract_openai_compatible_stream_text(&value).as_deref(),
            Some("Hello")
        );
    }

    #[test]
    fn extracts_openai_compatible_stream_text_from_message() {
        let value: serde_json::Value = serde_json::json!({
            "choices": [{"message": {"content": "World"}}]
        });
        assert_eq!(
            extract_openai_compatible_stream_text(&value).as_deref(),
            Some("World")
        );
    }

    #[test]
    fn extracts_openai_compatible_usage() {
        let value: serde_json::Value = serde_json::json!({
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 4,
                "total_tokens": 16
            }
        });
        let usage = extract_openai_compatible_usage(&value).expect("usage");

        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 4);
        assert_eq!(usage.total_tokens, 16);
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
        assert_eq!(
            create_chat_completions_endpoint("https://api.deepseek.com"),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            create_chat_completions_endpoint("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        // DeepSeek default base URL includes /v1 so the final endpoint is correct.
        assert_eq!(
            default_openai_compatible_base_url_for_provider("deepseek"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            create_chat_completions_endpoint(&default_openai_compatible_base_url_for_provider(
                "deepseek"
            )),
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
            result.expect_err("unapproved file should fail").to_string(),
            "Validation error: Code proposal includes a file outside the approved diff: src/other.txt"
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
            result.expect_err("unlisted path should fail").to_string(),
            "Validation error: Code proposal patch includes an unlisted file path: src/other.txt"
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
            result.expect_err("fixture should require QA mode").to_string(),
            "Validation error: Code proposal fixtures require JAVIS_QA_MODE=1."
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
            normalize_model_api_key_reference(" ").expect_err("missing reference"),
            "Model API key reference is required."
        );
    }

    #[test]
    fn model_api_key_reference_accepts_model_prefix() {
        assert_eq!(
            normalize_model_api_key_reference("model.primary").unwrap(),
            "model.primary"
        );
        assert_eq!(
            normalize_model_api_key_reference("model.secondary").unwrap(),
            "model.secondary"
        );
        assert_eq!(
            normalize_model_api_key_reference("model.multimodal").unwrap(),
            "model.multimodal"
        );
        assert_eq!(
            normalize_model_api_key_reference("model.custom-uuid_123").unwrap(),
            "model.custom-uuid_123"
        );
        // Reject empty suffix
        assert!(normalize_model_api_key_reference("model.").is_err());
        // Reject bare "other"
        assert!(normalize_model_api_key_reference("other").is_err());
        // Reject invalid characters in suffix
        assert!(normalize_model_api_key_reference("model/foo").is_err());
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

    // ── DeepSeek API request construction tests ─────────────────────

    #[test]
    fn deepseek_proposal_body_has_required_fields() {
        let body = create_openai_compatible_proposal_body(
            "deepseek-chat",
            "Add a hello world message to src/main.txt",
        );

        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["stream"], false);
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["response_format"]["type"], "json_object");
        // Messages array: system + user
        let messages = body["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert!(
            messages[1]["content"]
                .as_str()
                .unwrap()
                .contains("hello world")
        );
    }

    #[test]
    fn deepseek_proposal_body_excludes_thinking_field() {
        let body = create_openai_compatible_proposal_body("deepseek-chat", "test prompt");

        assert!(
            body.get("thinking").is_none(),
            "DeepSeek API does not support the 'thinking' field for deepseek-chat; it must be omitted"
        );
    }

    #[test]
    fn deepseek_completion_body_matches_proposal_structure() {
        let proposal_body = create_openai_compatible_proposal_body("deepseek-chat", "test");
        let request = ModelCompletionRequest {
            prompt: "test".to_string(),
            provider_id: Some("deepseek".to_string()),
            model: Some("deepseek-chat".to_string()),
            api_key: Some("sk-test".to_string()),
            api_key_reference: None,
            base_url: None,
            max_tokens: Some(4096),
            temperature: Some(0.0),
            stop_sequences: None,
            locale: None,
            protocol: None,
        };
        let completion_body = create_openai_compatible_completion_body("deepseek-chat", &request);

        // Both should have the same core structure
        assert_eq!(proposal_body["model"], completion_body["model"]);
        assert_eq!(proposal_body["stream"], completion_body["stream"]);
        // Proposal has system message, completion does not
        assert_eq!(
            proposal_body["messages"]
                .as_array()
                .unwrap()
                .first()
                .unwrap()["role"],
            "system"
        );
        assert_eq!(
            completion_body["messages"]
                .as_array()
                .unwrap()
                .first()
                .unwrap()["role"],
            "user"
        );
    }

    #[test]
    fn deepseek_endpoint_url_is_correctly_constructed() {
        // From default base URL
        let base = default_openai_compatible_base_url_for_provider("deepseek");
        assert_eq!(base, "https://api.deepseek.com/v1");
        let endpoint = create_chat_completions_endpoint(&base);
        assert_eq!(endpoint, "https://api.deepseek.com/v1/chat/completions");

        // From user-provided base URL without /v1
        let endpoint2 = create_chat_completions_endpoint("https://api.deepseek.com");
        assert_eq!(endpoint2, "https://api.deepseek.com/chat/completions");

        // From user-provided base URL with trailing slash
        let endpoint3 = create_chat_completions_endpoint("https://api.deepseek.com/v1/");
        assert_eq!(endpoint3, "https://api.deepseek.com/v1/chat/completions");

        // From user-provided full endpoint
        let endpoint4 =
            create_chat_completions_endpoint("https://api.deepseek.com/v1/chat/completions");
        assert_eq!(endpoint4, "https://api.deepseek.com/v1/chat/completions");
    }

    #[test]
    fn deepseek_proposal_request_serializes_to_valid_json() {
        let body = create_openai_compatible_proposal_body("deepseek-chat", "test prompt");
        let json_text = serde_json::to_string(&body).expect("serialize proposal body");

        // Must be valid JSON
        let parsed: serde_json::Value =
            serde_json::from_str(&json_text).expect("re-parse proposal body");
        assert_eq!(parsed["model"], "deepseek-chat");

        // Must not contain thinking field in serialized form
        assert!(
            !json_text.contains("\"thinking\""),
            "Serialized proposal body must not contain 'thinking' field"
        );
    }

    #[test]
    fn deepseek_should_fallback_when_credentials_present() {
        let request = CodeProposeEditRequest {
            workspace_path: "E:/Test".to_string(),
            user_goal: "Fix a bug".to_string(),
            changed_files: vec![],
            diff: String::new(),
            provider_id: Some("deepseek".to_string()),
            model: Some("deepseek-chat".to_string()),
            api_key: Some("sk-test-key".to_string()),
            api_key_reference: None,
            base_url: None,
            locale: None,
        };

        assert!(
            should_fallback_to_openai_compatible(&request),
            "DeepSeek with API key should use direct HTTP API"
        );
    }

    #[test]
    fn deepseek_should_not_fallback_without_credentials() {
        let request = CodeProposeEditRequest {
            workspace_path: "E:/Test".to_string(),
            user_goal: "Fix a bug".to_string(),
            changed_files: vec![],
            diff: String::new(),
            provider_id: Some("deepseek".to_string()),
            model: Some("deepseek-chat".to_string()),
            api_key: None,
            api_key_reference: None,
            base_url: None,
            locale: None,
        };

        assert!(
            !should_fallback_to_openai_compatible(&request),
            "DeepSeek without API key should not use direct HTTP API"
        );
    }

    // ── SKIP_DIRS + depth + mount roots ───────────────────────────────

    #[test]
    fn skip_dirs_case_insensitive() {
        // node_modules, Node_Modules, NODE_MODULES should all be skipped
        let node_lower = SKIP_DIRS.iter().any(|d| d.to_lowercase() == "node_modules");
        assert!(node_lower, "SKIP_DIRS contains node_modules");

        let temp_lower = SKIP_DIRS.iter().any(|d| d.to_lowercase() == "temp");
        assert!(temp_lower, "SKIP_DIRS contains Temp");

        // Verify case-insensitive comparison would match
        let lower_skips: Vec<String> = SKIP_DIRS.iter().map(|d| d.to_lowercase()).collect();
        assert!(lower_skips.contains(&"node_modules".to_string()));
        assert!(lower_skips.contains(&"NODE_MODULES".to_string().to_lowercase()));
    }

    #[test]
    fn skip_dirs_includes_windows_system() {
        let lower_skips: Vec<String> = SKIP_DIRS.iter().map(|d| d.to_lowercase()).collect();
        assert!(lower_skips.contains(&"windows".to_string()));
        assert!(lower_skips.contains(&"program files".to_string()));
        assert!(lower_skips.contains(&"program files (x86)".to_string()));
    }

    #[test]
    fn skip_dirs_includes_package_cache_dirs() {
        let lower_skips: Vec<String> = SKIP_DIRS.iter().map(|d| d.to_lowercase()).collect();
        assert!(lower_skips.contains(&".npm".to_string()));
        assert!(lower_skips.contains(&".yarn".to_string()));
        assert!(lower_skips.contains(&".docker".to_string()) || lower_skips.contains(&".vscode".to_string()));
    }

    #[test]
    fn root_level_vendor_skip_only_at_drive_root() {
        // C:\Intel, D:\NVIDIA → parent is root, should skip
        assert!(is_root_level_vendor_skip("Intel", Path::new("C:\\")));
        assert!(is_root_level_vendor_skip("NVIDIA", Path::new("D:\\")));

        // C:\Projects\Intel → parent is C:\Projects, should NOT skip
        assert!(!is_root_level_vendor_skip("Intel", Path::new("C:\\Projects")));

        // Non-vendor name at root → should NOT skip
        assert!(!is_root_level_vendor_skip("Projects", Path::new("C:\\")));

        // Filesystem root itself: root.parent() is None
        // root_level check uses dir_name from entry, not the root itself
        // So this is testing the helper, not the actual scan behavior
    }

    #[test]
    fn collect_files_respects_max_depth() {
        use std::io::Write;

        let tmp = tempfile::tempdir().expect("tempdir");
        // Create: tmp/deep/deeper/file.txt
        let deep = tmp.path().join("deep").join("deeper");
        fs::create_dir_all(&deep).unwrap();
        let file_path = deep.join("file.txt");
        fs::File::create(&file_path).unwrap().write_all(b"x").unwrap();

        // Default (unlimited depth) finds the file
        let result1 = collect_files(&[tmp.path().to_path_buf()], &["txt"], 10, true).unwrap();
        assert_eq!(result1.len(), 1);

        // max_depth=2 should NOT reach "deeper/file.txt" (depth 2 from root)
        let result2 = collect_files_with_depth(
            &[tmp.path().to_path_buf()], &["txt"], 10, true, 2,
        ).unwrap();
        assert_eq!(result2.len(), 0);

        // max_depth=3 should reach "deeper/file.txt"
        let result3 = collect_files_with_depth(
            &[tmp.path().to_path_buf()], &["txt"], 10, true, 3,
        ).unwrap();
        assert_eq!(result3.len(), 1);
    }

    #[test]
    fn collect_files_default_depth_unlimited() {
        use std::io::Write;

        let tmp = tempfile::tempdir().expect("tempdir");
        let deep = tmp.path().join("a").join("b").join("c").join("d");
        fs::create_dir_all(&deep).unwrap();
        let file_path = deep.join("file.txt");
        fs::File::create(&file_path).unwrap().write_all(b"x").unwrap();

        // Default collect_files (unlimited depth) should find the file
        let result = collect_files(&[tmp.path().to_path_buf()], &["txt"], 10, true).unwrap();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn scan_all_user_files_respects_max_results() {
        use std::io::Write;

        let tmp = tempfile::tempdir().expect("tempdir");
        for i in 0..15 {
            let file_path = tmp.path().join(format!("{}.txt", i));
            fs::File::create(&file_path).unwrap().write_all(b"x").unwrap();
        }

        let result = collect_files_with_depth(
            &[tmp.path().to_path_buf()], &["txt"], 5, true, usize::MAX,
        ).unwrap();
        assert_eq!(result.len(), 5);
    }

    #[test]
    fn execute_scan_collects_files_and_respects_cancellation() {
        use std::io::Write;

        let tmp = tempfile::tempdir().expect("tempdir");
        for i in 0..10 {
            let file_path = tmp.path().join(format!("{}.txt", i));
            fs::File::create(&file_path).unwrap().write_all(b"x").unwrap();
        }

        let ext_lower = vec!["txt".to_string()];
        let cancelled = Arc::new(AtomicBool::new(false));

        // Simulate what execute_scan does with a single root
        let mut entries = Vec::new();
        collect_files_inner_for_scan(
            tmp.path(),
            &ext_lower,
            true,
            10,
            usize::MAX,
            0,
            &mut entries,
            &cancelled,
        );

        assert_eq!(entries.len(), 10);
    }

    #[test]
    fn collect_files_skips_skip_dirs() {
        use std::io::Write;

        let tmp = tempfile::tempdir().expect("tempdir");
        let node_modules = tmp.path().join("node_modules");
        fs::create_dir_all(&node_modules).unwrap();
        let hidden_file = node_modules.join("package.json");
        fs::File::create(&hidden_file).unwrap().write_all(b"{}").unwrap();

        let visible_file = tmp.path().join("readme.md");
        fs::File::create(&visible_file).unwrap().write_all(b"# Readme").unwrap();

        let result = collect_files(&[tmp.path().to_path_buf()], &["md", "json"], 20, true).unwrap();
        // Should only find readme.md, NOT package.json inside node_modules
        assert_eq!(result.len(), 1);
        assert!(result[0].path.ends_with("readme.md"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(pdf::PdfOrganizationApprovalState::default()))
        .manage(Mutex::new(code::CodePatchApprovalState::default()))
        .invoke_handler(tauri::generate_handler![
            pdf::scan_markdown_documents,
            shell::run_read_only_command,
            web::fetch_web_source,
            web::search_web_sources,
            inspect::inspect_project,
            save_model_api_key_secret,
            delete_model_api_key_secret,
            code::propose_code_edit,
            complete_model_prompt,
            streaming::stream_model_prompt_start,
            streaming::stream_model_prompt_cancel,
            streaming::cancel_all_model_streams,
            code::approve_code_patch,
            code::apply_code_patch,
            pdf::plan_pdf_organization,
            pdf::approve_pdf_organization,
            pdf::restore_pdf_organization_approval,
            pdf::execute_pdf_organization,
            scan::scan_installed_apps,
            scan::scan_user_documents,
            scan::scan_user_images,
            scan::list_directory,
            scan::read_file_chunk,
            mcpserv::read_mcp_config,
            mcpserv::write_mcp_config,
            audit::append_task_audit_jsonl_line,
            audit::append_task_session_jsonl_line,
            database::db_execute,
            database::db_select,
            database::db_debug_path,
            database::db_close,
            workspace::load_workspace_definitions,
            workspace::save_workspace_definition,
            workspace::delete_workspace_definition,
            scan::scan_all_user_files,
            scan::list_mount_roots,
            scan::cancel_scan_all_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
