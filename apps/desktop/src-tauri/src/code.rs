use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime},
};
use tauri::AppHandle;

use crate::error::JavisError;
use crate::{
    capture_current_git_head, create_approval_id, create_file_content_hashes, create_fnv1a_hash,
    create_native_approval_binding, create_provider_response_diagnostic,
    default_openai_compatible_base_url, env_flag_enabled, hydrate_model_api_key_secret,
    normalize_path, require_current_git_head_matches, require_native_approval_binding,
    resolve_command_program, resolve_workspace_path, summarize_provider_output_for_error,
    NativeApprovalBinding, JAVIS_TERMINOLOGY_PROMPT_PREFIX, OPENCODE_PROPOSAL_TIMEOUT,
};

pub(crate) const CODE_PATCH_APPROVAL_TOOL_NAME: &str = "code.applyProposedEdit";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodePatchApplyRequest {
    pub(crate) approval_id: String,
    pub(crate) proposal_id: String,
    pub(crate) workspace_path: String,
    pub(crate) changed_files: Vec<String>,
    pub(crate) patch: String,
    pub(crate) patch_hash: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) task_id: Option<String>,
    #[serde(default)]
    pub(crate) base_git_head: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodePatchApprovalRequest {
    pub(crate) approval_id: String,
    pub(crate) proposal_id: String,
    pub(crate) workspace_path: String,
    pub(crate) changed_files: Vec<String>,
    pub(crate) patch_hash: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) task_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub(crate) locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodePatchRestoreApprovalRequest {
    pub(crate) approval_id: String,
    pub(crate) edit: CodeProposedEdit,
    #[serde(default)]
    pub(crate) task_id: Option<String>,
}

#[derive(Clone)]
pub(crate) struct FileContentHash {
    pub(crate) path: String,
    pub(crate) hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeApplyResult {
    pub(crate) applied: bool,
    pub(crate) workspace_path: String,
    pub(crate) changed_files: Vec<String>,
    pub(crate) message: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeProposeEditRequest {
    pub(crate) workspace_path: String,
    pub(crate) user_goal: String,
    pub(crate) changed_files: Vec<String>,
    pub(crate) diff: String,
    #[serde(default)]
    pub(crate) task_id: Option<String>,
    pub(crate) provider_id: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) api_key: Option<String>,
    pub(crate) api_key_reference: Option<String>,
    pub(crate) base_url: Option<String>,
    #[serde(default)]
    pub(crate) locale: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeProposedEdit {
    pub(crate) approval_id: String,
    pub(crate) proposal_id: String,
    pub(crate) workspace_path: String,
    pub(crate) summary: String,
    pub(crate) changed_files: Vec<String>,
    pub(crate) patch: String,
    pub(crate) patch_hash: String,
    #[serde(default)]
    pub(crate) base_git_head: Option<String>,
    #[serde(default)]
    pub(crate) hunks: Option<Vec<CodeProposalHunk>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodeProposalHunk {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    header: String,
    diff: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawCodeProposal {
    summary: String,
    changed_files: Vec<String>,
    patch: String,
}

#[derive(Default)]
pub(crate) struct RawCodeProposalParts {
    summary: Option<String>,
    changed_files: Option<Vec<String>>,
    patch: Option<String>,
}

#[derive(Default)]
pub(crate) struct CodePatchApprovalState {
    pub(crate) pending: Option<PendingCodePatchApproval>,
}

pub(crate) struct PendingCodePatchApproval {
    pub(crate) binding: NativeApprovalBinding,
    pub(crate) proposal_id: String,
    pub(crate) workspace_path: String,
    pub(crate) changed_files: Vec<String>,
    pub(crate) patch_hash: String,
    pub(crate) file_hashes: Vec<FileContentHash>,
}

pub(crate) struct OpencodeProposalInvocation {
    pub(crate) args: Vec<String>,
    pub(crate) config_content: String,
}

#[tauri::command]
pub(crate) fn approve_code_patch(
    request: CodePatchApprovalRequest,
    approval_state: tauri::State<'_, Mutex<CodePatchApprovalState>>,
) -> Result<(), String> {
    approve_pending_code_patch(&approval_state, request).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn apply_code_patch(
    request: CodePatchApplyRequest,
    approval_state: tauri::State<'_, Mutex<CodePatchApprovalState>>,
) -> Result<CodeApplyResult, String> {
    let workspace =
        resolve_workspace_path(Some(request.workspace_path.clone())).map_err(|e| e.to_string())?;
    apply_code_patch_in_workspace(&workspace, request, Some(&approval_state))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn restore_code_patch_approval(
    request: CodePatchRestoreApprovalRequest,
    approval_state: tauri::State<'_, Mutex<CodePatchApprovalState>>,
) -> Result<(), String> {
    let mut edit = request.edit;
    edit.approval_id = request.approval_id;
    register_pending_code_patch(&approval_state, &edit, request.task_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn propose_code_edit(
    app: AppHandle,
    mut request: CodeProposeEditRequest,
    approval_state: tauri::State<'_, Mutex<CodePatchApprovalState>>,
) -> Result<CodeProposedEdit, String> {
    let workspace =
        resolve_workspace_path(Some(request.workspace_path.clone())).map_err(|e| e.to_string())?;
    if !env_flag_enabled("JAVIS_QA_MODE")
        || env::var_os("JAVIS_CODE_PROPOSAL_FIXTURE_PATH").is_none()
    {
        hydrate_model_api_key_secret(&app, &mut request).map_err(JavisError::Internal)?;
    }
    let task_id = request.task_id.clone();
    let proposal =
        propose_code_edit_with_opencode(&workspace, request).map_err(|e| e.to_string())?;
    register_pending_code_patch(&approval_state, &proposal, task_id.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(proposal)
}

pub(crate) fn propose_code_edit_with_opencode(
    workspace: &Path,
    request: CodeProposeEditRequest,
) -> Result<CodeProposedEdit, JavisError> {
    let canonical_workspace = fs::canonicalize(workspace)
        .map_err(|error| JavisError::Io(format!("Workspace is not accessible: {error}")))?;
    if request.user_goal.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code proposal goal cannot be empty.".into(),
        ));
    }
    if request.diff.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code proposal requires a non-empty diff preview.".into(),
        ));
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
            let content = fs::read_to_string(path).map_err(|error| {
                JavisError::Io(format!("Could not read code proposal fixture: {error}"))
            })?;
            return parse_code_proposal_from_text_for_request(
                &canonical_workspace,
                &content,
                &request,
            );
        }
    } else if env::var_os("JAVIS_CODE_PROPOSAL_FIXTURE_PATH").is_some() {
        return Err(JavisError::Validation(
            "Code proposal fixtures require JAVIS_QA_MODE=1.".into(),
        ));
    }

    let prompt = create_opencode_proposal_prompt(&request);
    if should_fallback_to_openai_compatible(&request) {
        let output = run_openai_compatible_proposal_request(&request, &prompt)?;
        return parse_code_proposal_from_text_for_request(&canonical_workspace, &output, &request);
    }
    let output = run_opencode_proposal_command(&canonical_workspace, &prompt, &request)?;
    parse_code_proposal_from_text_for_request(&canonical_workspace, &output, &request)
}

pub(crate) fn run_opencode_proposal_command(
    workspace: &Path,
    prompt: &str,
    request: &CodeProposeEditRequest,
) -> Result<String, JavisError> {
    let opencode = resolve_opencode_program();
    let invocation =
        create_opencode_proposal_invocation(workspace, prompt, request).map_err(|error| {
            JavisError::Internal(format!("opencode proposal configuration error: {error}"))
        })?;
    let output = Command::new(&opencode)
        .args(&invocation.args)
        .current_dir(workspace)
        .env("OPENCODE_CONFIG_CONTENT", invocation.config_content)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|child| wait_with_timeout(child, OPENCODE_PROPOSAL_TIMEOUT))
        .map_err(|error| {
            JavisError::Io(format!(
                "opencode is unavailable at {}: {error}",
                opencode.display()
            ))
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            JavisError::Internal("opencode proposal command failed without stderr.".into())
        } else {
            JavisError::Internal(stderr)
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub(crate) fn wait_with_timeout(mut child: Child, timeout: Duration) -> std::io::Result<Output> {
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

pub(crate) fn create_opencode_proposal_invocation(
    workspace: &Path,
    prompt: &str,
    request: &CodeProposeEditRequest,
) -> Result<OpencodeProposalInvocation, JavisError> {
    let mut args = vec![
        "run".to_string(),
        "--pure".to_string(),
        "--dir".to_string(),
        workspace
            .to_str()
            .ok_or_else(|| JavisError::Validation("Workspace path is not valid UTF-8.".into()))?
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

pub(crate) fn create_opencode_config_content(
    request: &CodeProposeEditRequest,
) -> Result<String, JavisError> {
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
        return serde_json::to_string(&config).map_err(JavisError::from);
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
    serde_json::to_string(&config).map_err(JavisError::from)
}

pub(crate) fn create_opencode_proposal_prompt(request: &CodeProposeEditRequest) -> String {
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

pub(crate) fn resolve_opencode_program() -> PathBuf {
    bundled_opencode_candidates()
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(resolve_command_program("opencode")))
}

pub(crate) fn bundled_opencode_candidates() -> Vec<PathBuf> {
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

pub(crate) fn opencode_candidates_near_executable(exe_path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(exe_dir) = exe_path.parent() {
        for base in [exe_dir, &exe_dir.join("resources")] {
            candidates.push(base.join("bin/opencode-windows-x64/opencode.exe"));
            candidates.push(base.join("bin/opencode-windows-x64-baseline/opencode.exe"));
        }
    }
    candidates
}

pub(crate) fn infer_provider_id_from_model(request: &CodeProposeEditRequest) -> String {
    normalize_optional_config_value(request.model.as_deref())
        .and_then(|model| {
            model
                .split_once('/')
                .map(|(provider, _)| provider.to_string())
        })
        .unwrap_or_else(|| default_provider_for_locale(request.locale.as_deref()))
}

pub(crate) fn default_provider_for_locale(locale: Option<&str>) -> String {
    if locale.is_some_and(|locale| locale.starts_with("zh")) {
        "deepseek".to_string()
    } else {
        "openai".to_string()
    }
}

pub(crate) fn default_model_for_locale(locale: Option<&str>) -> String {
    if locale.is_some_and(|locale| locale.starts_with("zh")) {
        "deepseek-chat".to_string()
    } else {
        "gpt-4.1".to_string()
    }
}

pub(crate) fn normalize_opencode_model_id(
    request: &CodeProposeEditRequest,
) -> Result<Option<String>, JavisError> {
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

pub(crate) fn normalize_openai_compatible_model_name(
    request: &CodeProposeEditRequest,
) -> Option<String> {
    let model = normalize_optional_config_value(request.model.as_deref())
        .or_else(|| Some(default_model_for_locale(request.locale.as_deref())));
    model.map(|model| {
        model
            .split_once('/')
            .map(|(_, name)| name.to_string())
            .unwrap_or(model)
    })
}

pub(crate) fn validate_opencode_config_id(value: &str) -> Result<(), JavisError> {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Ok(());
    }

    Err(JavisError::Validation(format!(
        "Invalid opencode provider or model id: {value}"
    )))
}

pub(crate) fn should_fallback_to_openai_compatible(request: &CodeProposeEditRequest) -> bool {
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_provider_id_from_model(request));
    let has_credentials = normalize_optional_config_value(request.api_key.as_deref()).is_some();
    let has_custom_base_url =
        normalize_optional_config_value(request.base_url.as_deref()).is_some();
    has_credentials && (provider_id == "deepseek" || provider_id == "custom" && has_custom_base_url)
}

pub(crate) fn run_openai_compatible_proposal_request(
    request: &CodeProposeEditRequest,
    prompt: &str,
) -> Result<String, JavisError> {
    let api_key = normalize_optional_config_value(request.api_key.as_deref()).ok_or_else(|| {
        JavisError::Validation("OpenAI-compatible fallback requires an API key.".into())
    })?;
    let model = normalize_openai_compatible_model_name(request).ok_or_else(|| {
        JavisError::Validation("OpenAI-compatible fallback requires a model.".into())
    })?;
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_openai_compatible_base_url(request));
    let endpoint = create_chat_completions_endpoint(&base_url);
    let body = create_openai_compatible_proposal_body(&model, prompt);
    let body_text = serde_json::to_string(&body).map_err(JavisError::from)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(OPENCODE_PROPOSAL_TIMEOUT)
        .build()
        .map_err(|error| {
            JavisError::Internal(format!(
                "Could not create HTTP client for proposal: {error}"
            ))
        })?;
    let response_text = client
        .post(&endpoint)
        .header("Authorization", &format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .body(body_text)
        .send()
        .map_err(|error| {
            JavisError::Internal(format!(
                "OpenAI-compatible proposal fallback failed: {error}"
            ))
        })?
        .text()
        .map_err(|error| {
            JavisError::Internal(format!(
                "OpenAI-compatible proposal fallback could not read response: {error}"
            ))
        })?;
    let value = serde_json::from_str::<serde_json::Value>(&response_text).map_err(|error| {
        JavisError::Internal(format!(
            "OpenAI-compatible proposal fallback returned invalid JSON: {error}; {}",
            create_provider_response_diagnostic(request, &endpoint, &response_text)
        ))
    })?;
    let content_value = value
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"));
    let Some(content_value) = content_value else {
        return Err(JavisError::Internal(format!(
            "OpenAI-compatible proposal fallback returned no message content. {}",
            create_provider_response_diagnostic(request, &endpoint, &response_text)
        )));
    };
    let content = content_value
        .as_str()
        .map(str::to_string)
        .or_else(|| serde_json::to_string(content_value).ok())
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| {
            JavisError::Internal(format!(
                "OpenAI-compatible proposal fallback returned empty message content. {}",
                create_provider_response_diagnostic(request, &endpoint, &response_text)
            ))
        })?;
    Ok(content)
}

pub(crate) fn create_openai_compatible_proposal_body(
    model: &str,
    prompt: &str,
) -> serde_json::Value {
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
        "thinking": {
            "type": "disabled"
        },
        "response_format": {
            "type": "json_object"
        },
        "temperature": 0,
        "max_tokens": 4096
    })
}

#[cfg(test)]
pub(crate) fn parse_code_proposal_from_text(
    workspace: &Path,
    text: &str,
) -> Result<CodeProposedEdit, JavisError> {
    parse_code_proposal_from_text_with_allowed_files(workspace, text, None)
}

pub(crate) fn parse_code_proposal_from_text_for_request(
    workspace: &Path,
    text: &str,
    request: &CodeProposeEditRequest,
) -> Result<CodeProposedEdit, JavisError> {
    let approved_files = request
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;
    parse_code_proposal_from_text_with_allowed_files(workspace, text, Some(&approved_files))
}

pub(crate) fn parse_code_proposal_from_text_with_allowed_files(
    workspace: &Path,
    text: &str,
    allowed_files: Option<&[PathBuf]>,
) -> Result<CodeProposedEdit, JavisError> {
    let canonical_workspace = fs::canonicalize(workspace)
        .map_err(|error| JavisError::Io(format!("Workspace is not accessible: {error}")))?;
    let raw = extract_raw_code_proposal(text)?;
    validate_raw_code_proposal(&canonical_workspace, &raw, allowed_files)?;
    let base_git_head = capture_current_git_head(&canonical_workspace);
    let hunks = parse_patch_hunks(&raw.patch);
    let mut proposal = CodeProposedEdit {
        approval_id: create_approval_id(),
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

pub(crate) fn extract_raw_code_proposal(text: &str) -> Result<RawCodeProposal, JavisError> {
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

    Err(JavisError::Internal(format!(
        "opencode did not return a parseable CodeProposedEdit JSON object. Output excerpt: {}",
        summarize_provider_output_for_error(text)
    )))
}

pub(crate) fn parse_raw_code_proposal_candidate(text: &str) -> Option<RawCodeProposal> {
    let value =
        serde_json::from_str::<serde_json::Value>(normalize_json_candidate(text).trim()).ok()?;
    raw_code_proposal_from_value(&value)
}

pub(crate) fn raw_code_proposal_from_value(value: &serde_json::Value) -> Option<RawCodeProposal> {
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

    let mut parts = RawCodeProposalParts {
        summary: get_string_field(object, &["summary", "title", "description"]),
        ..RawCodeProposalParts::default()
    };
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

pub(crate) fn get_string_field(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn get_required_string_field_preserving_body(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(|value| value.as_str()))
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

pub(crate) fn get_string_array_field(
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

pub(crate) fn validate_raw_code_proposal(
    workspace: &Path,
    proposal: &RawCodeProposal,
    allowed_files: Option<&[PathBuf]>,
) -> Result<(), JavisError> {
    if proposal.summary.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code proposal summary cannot be empty.".into(),
        ));
    }
    if proposal.patch.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code proposal patch cannot be empty.".into(),
        ));
    }
    if proposal.changed_files.is_empty() {
        return Err(JavisError::Validation(
            "Code proposal must list at least one changed file.".into(),
        ));
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
                return Err(JavisError::Validation(format!(
                    "Code proposal includes a file outside the approved diff: {}",
                    file.display()
                )));
            }
        }
    }
    let patch_files = extract_unified_diff_paths(&proposal.patch)?;
    for file in &patch_files {
        if !approved_files.contains(file) {
            return Err(JavisError::Validation(format!(
                "Code proposal patch includes an unlisted file path: {}",
                file.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn create_code_proposal_hash(edit: &CodeProposedEdit) -> String {
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

pub(crate) fn apply_code_patch_in_workspace(
    workspace: &Path,
    request: CodePatchApplyRequest,
    approval_state: Option<&Mutex<CodePatchApprovalState>>,
) -> Result<CodeApplyResult, JavisError> {
    let canonical_workspace = fs::canonicalize(workspace)
        .map_err(|error| JavisError::Io(format!("Workspace is not accessible: {error}")))?;
    if request.approval_id.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch approval id is required.".into(),
        ));
    }
    if request.proposal_id.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch proposal id is required.".into(),
        ));
    }
    let patch = request.patch.trim();
    if patch.is_empty() {
        return Err(JavisError::Validation("Code patch cannot be empty.".into()));
    }
    if request.changed_files.is_empty() {
        return Err(JavisError::Validation(
            "Code patch must list at least one approved changed file.".into(),
        ));
    }
    let expected_patch_hash = create_code_proposal_hash(&CodeProposedEdit {
        approval_id: request.approval_id.clone(),
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
        return Err(JavisError::Validation(
            "Code patch hash does not match the approved proposal.".into(),
        ));
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
    let git = crate::git::resolve_git_executable_for_workspace(&canonical_workspace)
        .map_err(|error| JavisError::Io(format!("Could not locate git executable: {error}")))?;

    if let Ok(mut child) = Command::new(&git)
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

    let mut child = Command::new(&git)
        .args(["apply", "--whitespace=nowarn", "-"])
        .current_dir(&canonical_workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| JavisError::Io(format!("Could not start git apply: {error}")))?;

    child
        .stdin
        .as_mut()
        .ok_or_else(|| JavisError::Io("Could not open git apply stdin.".into()))?
        .write_all(request.patch.as_bytes())
        .map_err(|error| JavisError::Io(format!("Could not write patch to git apply: {error}")))?;

    let output = child
        .wait_with_output()
        .map_err(|error| JavisError::Io(format!("Could not finish git apply: {error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            JavisError::Internal("git apply failed without stderr.".into())
        } else {
            JavisError::Internal(stderr)
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

pub(crate) fn extract_unified_diff_paths(patch: &str) -> Result<Vec<PathBuf>, JavisError> {
    let mut paths = Vec::new();
    for line in patch.lines() {
        if !line.starts_with("diff --git ") {
            continue;
        }
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 4 {
            return Err(JavisError::Validation(
                "Patch contains a malformed diff header.".into(),
            ));
        }
        let path = normalize_git_diff_path(parts[3])?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }

    if paths.is_empty() {
        return Err(JavisError::Validation(
            "Patch does not contain a unified diff header.".into(),
        ));
    }
    Ok(paths)
}

pub(crate) fn normalize_git_diff_path(path: &str) -> Result<PathBuf, JavisError> {
    let without_prefix = path
        .strip_prefix("b/")
        .or_else(|| path.strip_prefix("a/"))
        .unwrap_or(path);
    normalize_relative_code_path(without_prefix)
}

pub(crate) fn normalize_relative_code_path(path: &str) -> Result<PathBuf, JavisError> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(JavisError::Validation(
            "Changed file path cannot be empty.".into(),
        ));
    }
    if trimmed.starts_with('/') || trimmed.contains(':') {
        return Err(JavisError::Validation(format!(
            "Changed file path must be relative: {trimmed}"
        )));
    }
    let path = PathBuf::from(trimmed);
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(JavisError::Validation(
            "Changed file path cannot contain parent directory traversal.".into(),
        ));
    }
    Ok(path)
}

pub(crate) fn require_approved_relative_paths(
    workspace: &Path,
    approved_files: &[PathBuf],
    requested_files: &[PathBuf],
    unapproved_message: &str,
    outside_workspace_message: &str,
) -> Result<(), JavisError> {
    for file in requested_files {
        if !approved_files.contains(file) {
            return Err(JavisError::Validation(format!(
                "{unapproved_message}: {}",
                file.display()
            )));
        }
    }
    for file in approved_files {
        ensure_relative_path_stays_in_root(workspace, file, outside_workspace_message)?;
    }
    Ok(())
}

pub(crate) fn ensure_relative_path_stays_in_root(
    root: &Path,
    relative_path: &Path,
    outside_root_message: &str,
) -> Result<(), JavisError> {
    let target = root.join(relative_path);
    let parent = target.parent().ok_or_else(|| {
        JavisError::Validation("Changed file path does not have a parent directory.".into())
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        JavisError::Io(format!("Changed file parent is not accessible: {error}"))
    })?;
    if !canonical_parent.starts_with(root) {
        return Err(JavisError::Validation(outside_root_message.to_string()));
    }
    Ok(())
}

pub(crate) fn approve_pending_code_patch(
    approval_state: &Mutex<CodePatchApprovalState>,
    request: CodePatchApprovalRequest,
) -> Result<(), JavisError> {
    if request.approval_id.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch approval id is required.".into(),
        ));
    }
    if request.proposal_id.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch proposal id is required.".into(),
        ));
    }
    if request.patch_hash.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch hash is required.".into(),
        ));
    }
    let canonical_workspace = fs::canonicalize(&request.workspace_path)
        .map_err(|error| JavisError::Io(format!("Workspace is not accessible: {error}")))?;
    let mut state = approval_state.lock().map_err(|_| {
        JavisError::Internal("Code patch approval state could not be locked.".into())
    })?;
    let Some(pending) = state.pending.as_mut() else {
        return Err(JavisError::Permission(
            "No pending Code Patch proposal exists.".into(),
        ));
    };
    if pending.proposal_id != request.proposal_id {
        return Err(JavisError::Permission(
            "Code patch proposal id does not match the pending proposal.".into(),
        ));
    }
    if pending.workspace_path != normalize_path(&canonical_workspace) {
        return Err(JavisError::Permission(
            "Code patch workspace does not match the pending proposal.".into(),
        ));
    }
    if pending.changed_files != request.changed_files {
        return Err(JavisError::Permission(
            "Code patch changed files do not match the pending proposal.".into(),
        ));
    }
    if pending.patch_hash != request.patch_hash {
        return Err(JavisError::Permission(
            "Code patch hash does not match the pending proposal.".into(),
        ));
    }
    crate::approve_native_approval_binding(
        &mut pending.binding,
        &request.approval_id,
        CODE_PATCH_APPROVAL_TOOL_NAME,
        request.task_id.as_deref(),
        &request.patch_hash,
        "Code patch approval id does not match the pending proposal.",
    )
    .map_err(JavisError::Permission)
}

pub(crate) fn register_pending_code_patch(
    approval_state: &Mutex<CodePatchApprovalState>,
    edit: &CodeProposedEdit,
    task_id: Option<&str>,
) -> Result<(), JavisError> {
    if edit.approval_id.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch approval id is required.".into(),
        ));
    }
    if edit.proposal_id.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch proposal id is required.".into(),
        ));
    }
    if edit.workspace_path.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch workspace path is required.".into(),
        ));
    }
    if edit.changed_files.is_empty() {
        return Err(JavisError::Validation(
            "Code patch must list at least one approved changed file.".into(),
        ));
    }
    if edit.patch_hash.trim().is_empty() {
        return Err(JavisError::Validation(
            "Code patch hash is required.".into(),
        ));
    }
    let canonical_workspace = fs::canonicalize(&edit.workspace_path)
        .map_err(|error| JavisError::Io(format!("Workspace is not accessible: {error}")))?;
    let approved_files = edit
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
    let file_hashes = create_file_content_hashes(&canonical_workspace, &approved_files)
        .map_err(JavisError::from)?;
    let mut state = approval_state.lock().map_err(|_| {
        JavisError::Internal("Code patch approval state could not be locked.".into())
    })?;
    state.pending = Some(PendingCodePatchApproval {
        binding: create_native_approval_binding(
            edit.approval_id.clone(),
            CODE_PATCH_APPROVAL_TOOL_NAME,
            task_id.unwrap_or_default().to_string(),
            edit.patch_hash.clone(),
            false,
        ),
        proposal_id: edit.proposal_id.clone(),
        workspace_path: normalize_path(&canonical_workspace),
        changed_files: edit.changed_files.clone(),
        patch_hash: edit.patch_hash.clone(),
        file_hashes,
    });
    Ok(())
}

pub(crate) fn take_approved_code_patch(
    approval_state: &Mutex<CodePatchApprovalState>,
    request: &CodePatchApplyRequest,
    canonical_workspace: &Path,
) -> Result<(), JavisError> {
    let mut state = approval_state.lock().map_err(|_| {
        JavisError::Internal("Code patch approval state could not be locked.".into())
    })?;
    let Some(pending) = state.pending.as_ref() else {
        return Err(JavisError::Permission(
            "No approved Code Patch proposal is pending.".into(),
        ));
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
        return Err(JavisError::Permission(
            "Code patch proposal id does not match the approved proposal.".into(),
        ));
    }
    if pending.workspace_path != normalize_path(canonical_workspace) {
        return Err(JavisError::Permission(
            "Code patch workspace does not match the approved proposal.".into(),
        ));
    }
    if pending.changed_files != request.changed_files {
        return Err(JavisError::Permission(
            "Code patch changed files do not match the approved proposal.".into(),
        ));
    }
    if pending.patch_hash != request.patch_hash {
        return Err(JavisError::Permission(
            "Code patch hash does not match the approved proposal.".into(),
        ));
    }
    let approved_files = request
        .changed_files
        .iter()
        .map(|file| normalize_relative_code_path(file))
        .collect::<Result<Vec<_>, _>>()?;
    let current_hashes = create_file_content_hashes(canonical_workspace, &approved_files)
        .map_err(JavisError::from)?;
    if pending.file_hashes.len() != current_hashes.len()
        || pending
            .file_hashes
            .iter()
            .zip(current_hashes.iter())
            .any(|(approved, current)| {
                approved.path != current.path || approved.hash != current.hash
            })
    {
        return Err(JavisError::Permission(
            "Code patch approved files changed before apply.".into(),
        ));
    }
    if let Some(base_git_head) = &request.base_git_head {
        require_current_git_head_matches(canonical_workspace, base_git_head)
            .map_err(JavisError::from)?;
    }
    state.pending = None;
    Ok(())
}

pub(crate) fn parse_patch_hunks(patch: &str) -> Option<Vec<CodeProposalHunk>> {
    let trimmed = patch.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut hunks: Vec<CodeProposalHunk> = Vec::new();
    let mut current_hunk: Option<CodeProposalHunk> = None;
    let mut hunk_lines: Vec<String> = Vec::new();

    for line in trimmed.lines() {
        if let Some(stripped) = line.strip_prefix("@@") {
            if let Some(hunk) = current_hunk.take() {
                hunks.push(CodeProposalHunk {
                    diff: hunk_lines.join("\n"),
                    ..hunk
                });
            }
            hunk_lines = Vec::new();
            if let Some((header, rest)) = stripped.split_once("@@") {
                let ranges: Vec<&str> = header.split_whitespace().collect();
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

pub(crate) fn parse_hunk_range(range: &str) -> (u32, u32) {
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

pub(crate) fn normalize_optional_config_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn create_chat_completions_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        return trimmed.to_string();
    }
    if trimmed == "https://api.deepseek.com" {
        return format!("{trimmed}/v1/chat/completions");
    }
    format!("{trimmed}/chat/completions")
}

pub(crate) fn normalize_json_candidate(text: &str) -> String {
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

pub(crate) fn extract_json_object_text(text: &str) -> Option<String> {
    let normalized = normalize_json_candidate(text);
    let start = normalized.find('{')?;
    let end = normalized.rfind('}')?;
    (start <= end).then(|| normalized[start..=end].to_string())
}
