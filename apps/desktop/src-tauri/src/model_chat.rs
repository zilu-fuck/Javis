use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::anthropic::{
    anthropic_endpoint, build_anthropic_headers, default_anthropic_base_url, parse_data_url,
};
use crate::code::normalize_optional_config_value;
use crate::{
    classify_http_request_error, classify_http_status_error, create_chat_completions_endpoint,
    default_openai_compatible_base_url_for_provider, ensure_saved_model_key_matches_base_url,
    load_model_api_key_secret_with_fallback, openai_compatible_request_requires_api_key,
    ModelUsage, OPENCODE_PROPOSAL_TIMEOUT,
};

const MODEL_TOOL_NAME_MAX_CHARS: usize = 64;
const MODEL_CHAT_STREAM_TIMEOUT: Duration = Duration::from_secs(120);
const MODEL_CHAT_STREAM_EVENT_NAME: &str = "stream-model-chat-event";
const MODEL_CHAT_STREAM_ERROR_NAME: &str = "stream-model-chat-error";
static NEXT_CHAT_STREAM_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_CHAT_STREAMS: Mutex<Vec<ActiveChatStream>> = Mutex::new(Vec::new());

struct ActiveChatStream {
    stream_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelChatRequest {
    messages: Vec<ModelChatMessage>,
    #[serde(default)]
    tools: Vec<ModelToolDefinition>,
    #[serde(default)]
    tool_choice: Option<ModelToolChoice>,
    #[serde(default)]
    response_format: Option<ModelResponseFormat>,
    #[serde(default)]
    parallel_tool_calls: Option<bool>,
    provider_id: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    api_key_reference: Option<String>,
    base_url: Option<String>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
enum ModelChatMessage {
    System {
        content: Vec<ModelContentBlock>,
    },
    User {
        content: Vec<ModelContentBlock>,
    },
    Assistant {
        content: Vec<ModelContentBlock>,
        #[serde(default)]
        tool_calls: Vec<ModelToolCall>,
    },
    Tool {
        tool_call_id: String,
        name: String,
        content: Vec<ModelContentBlock>,
        status: ModelToolStatus,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ModelContentBlock {
    Text {
        text: String,
    },
    Image {
        url: String,
        #[serde(default, rename = "mimeType")]
        mime_type: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelToolDefinition {
    canonical_name: String,
    model_name: String,
    description: String,
    input_schema: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ModelToolCall {
    id: String,
    name: String,
    arguments: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ModelToolStatus {
    Success,
    Error,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum ModelToolChoice {
    Mode(ModelToolChoiceMode),
    Named { name: String },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ModelToolChoiceMode {
    Auto,
    None,
    Required,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelResponseFormat {
    json_schema: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelChatResponse {
    message: ModelAssistantMessage,
    finish_reason: ModelFinishReason,
    #[serde(rename = "usage")]
    token_usage: Option<ModelUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelAssistantMessage {
    role: &'static str,
    content: Vec<ModelContentBlock>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<ModelToolCall>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ModelFinishReason {
    Stop,
    ToolCalls,
    Length,
    ContentFilter,
    Cancelled,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum ModelChatStreamEvent {
    MessageStart {
        message_id: String,
    },
    TextDelta {
        delta: String,
    },
    ToolCallStart {
        index: usize,
        id: String,
        name: String,
    },
    ToolCallArgumentsDelta {
        index: usize,
        delta: String,
    },
    ToolCallEnd {
        index: usize,
    },
    Usage {
        usage: ModelUsage,
    },
    MessageEnd {
        finish_reason: ModelFinishReason,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelChatStreamPayload {
    stream_id: String,
    event: ModelChatStreamEvent,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelChatStreamErrorPayload {
    stream_id: String,
    error: String,
}

/// Sanitized response-shape diagnostic for an empty model response
/// (dual-kernel plan §13.2). Never carries the API key or the raw body.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelChatEmptyResponseShape {
    choices_count: usize,
    message_keys: Vec<String>,
    content_type: String,
    content_length: usize,
    has_reasoning_content: bool,
    tool_calls_count: usize,
    has_usage: bool,
}

const EMPTY_RESPONSE_ERROR_PREFIX: &str = "__JAVIS_EMPTY_RESPONSE__";

/// Structured, deserializable error for an empty provider response. The
/// payload keeps the usage so the caller can retain failed-call tokens and
/// record a controlled retry with a fresh call id.
pub(crate) fn empty_chat_response_error(
    shape: &ModelChatEmptyResponseShape,
    finish_reason: Option<&str>,
    usage: Option<&ModelUsage>,
) -> String {
    let mut payload = serde_json::json!({
        "code": "model_chat_empty_response",
        "responseShape": shape,
        "finishReason": finish_reason,
    });
    if let Some(usage) = usage {
        payload["usage"] = serde_json::json!({
            "inputTokens": usage.input_tokens,
            "outputTokens": usage.output_tokens,
            "totalTokens": usage.total_tokens,
        });
    }
    format!("{EMPTY_RESPONSE_ERROR_PREFIX}{}", payload)
}

#[derive(Default)]
struct PendingToolCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    started: bool,
}

#[derive(Default)]
struct OpenAiStreamState {
    tool_calls: Vec<PendingToolCall>,
    finish_reason: Option<String>,
    saw_done: bool,
    text_seen: bool,
    usage_seen: bool,
}

#[derive(Default)]
struct AnthropicStreamState {
    tool_calls: Vec<PendingToolCall>,
    finish_reason: Option<String>,
    saw_message_stop: bool,
    input_tokens: u32,
    output_tokens: u32,
    text_seen: bool,
}

#[tauri::command]
pub(crate) async fn complete_model_chat(
    app: AppHandle,
    request: ModelChatRequest,
) -> Result<ModelChatResponse, String> {
    tauri::async_runtime::spawn_blocking(move || complete_model_chat_blocking(&app, request))
        .await
        .map_err(|error| format!("Model chat worker failed: {error}"))?
}

#[tauri::command]
pub(crate) fn stream_model_chat_start(
    app: AppHandle,
    mut request: ModelChatRequest,
    stream_id: Option<String>,
) -> Result<String, String> {
    validate_model_chat_request(&request)?;
    hydrate_model_chat_api_key(&app, &mut request)?;
    let stream_id = stream_id.unwrap_or_else(|| {
        format!(
            "chat-stream-{}",
            NEXT_CHAT_STREAM_ID.fetch_add(1, Ordering::Relaxed)
        )
    });
    if stream_id.trim().is_empty() {
        return Err("Model chat stream id cannot be empty.".to_string());
    }
    let cancelled = register_chat_stream(&stream_id)?;
    let worker_stream_id = stream_id.clone();
    thread::spawn(move || {
        let result =
            execute_model_chat_stream(&request, &app, &worker_stream_id, cancelled.as_ref());
        remove_chat_stream(&worker_stream_id);
        if let Err(error) = result {
            let _ = app.emit(
                MODEL_CHAT_STREAM_ERROR_NAME,
                ModelChatStreamErrorPayload {
                    stream_id: worker_stream_id,
                    error,
                },
            );
        }
    });
    Ok(stream_id)
}

#[tauri::command]
pub(crate) fn stream_model_chat_cancel(stream_id: String) -> Result<(), String> {
    let streams = ACTIVE_CHAT_STREAMS
        .lock()
        .map_err(|_| "Model chat stream registry is unavailable.".to_string())?;
    let Some(stream) = streams.iter().find(|stream| stream.stream_id == stream_id) else {
        return Err(format!(
            "No active model chat stream found for id: {stream_id}"
        ));
    };
    stream.cancelled.store(true, Ordering::Relaxed);
    Ok(())
}

fn register_chat_stream(stream_id: &str) -> Result<Arc<AtomicBool>, String> {
    let mut streams = ACTIVE_CHAT_STREAMS
        .lock()
        .map_err(|_| "Model chat stream registry is unavailable.".to_string())?;
    streams.retain(|stream| !stream.cancelled.load(Ordering::Relaxed));
    if streams.iter().any(|stream| stream.stream_id == stream_id) {
        return Err(format!(
            "Model chat stream id is already active: {stream_id}"
        ));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    streams.push(ActiveChatStream {
        stream_id: stream_id.to_string(),
        cancelled: cancelled.clone(),
    });
    Ok(cancelled)
}

fn remove_chat_stream(stream_id: &str) {
    if let Ok(mut streams) = ACTIVE_CHAT_STREAMS.lock() {
        streams.retain(|stream| stream.stream_id != stream_id);
    }
}

fn execute_model_chat_stream(
    request: &ModelChatRequest,
    app: &AppHandle,
    stream_id: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    emit_chat_stream_event(
        app,
        stream_id,
        ModelChatStreamEvent::MessageStart {
            message_id: stream_id.to_string(),
        },
    )?;
    match request.protocol.as_deref().unwrap_or("openai-compatible") {
        "anthropic" => execute_anthropic_chat_stream(request, app, stream_id, cancelled),
        "openai-compatible" => execute_openai_chat_stream(request, app, stream_id, cancelled),
        protocol => Err(format!("Unsupported model chat protocol: {protocol}.")),
    }
}

fn execute_openai_chat_stream(
    request: &ModelChatRequest,
    app: &AppHandle,
    stream_id: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let model = normalize_model(request)?;
    let provider_id = infer_provider_id(request);
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_openai_compatible_base_url_for_provider(&provider_id));
    let api_key = normalize_optional_config_value(request.api_key.as_deref());
    if api_key.is_none() && openai_compatible_request_requires_api_key(&provider_id, &base_url) {
        return Err("Model chat stream requires an API key.".to_string());
    }
    let endpoint = create_chat_completions_endpoint(&base_url);
    let body = build_openai_chat_body(&model, request, true)?;
    let headers = api_key
        .map(|key| vec![("Authorization".to_string(), format!("Bearer {key}"))])
        .unwrap_or_default();
    let response =
        send_json_stream_request(&endpoint, &body, request.timeout_ms, headers, &provider_id)?;
    let mut state = OpenAiStreamState::default();
    for line in BufReader::with_capacity(65_536, response).lines() {
        if cancelled.load(Ordering::Relaxed) {
            emit_chat_stream_event(
                app,
                stream_id,
                ModelChatStreamEvent::MessageEnd {
                    finish_reason: ModelFinishReason::Cancelled,
                },
            )?;
            return Ok(());
        }
        let line = line.map_err(|error| format!("Model chat stream read error: {error}"))?;
        let Some(data) = sse_data(&line) else {
            continue;
        };
        if data == "[DONE]" {
            state.saw_done = true;
            break;
        }
        let value = parse_stream_json(data, "Model chat stream")?;
        for event in consume_openai_stream_value(&value, request, &mut state)? {
            emit_chat_stream_event(app, stream_id, event)?;
        }
    }
    for event in finalize_openai_stream(request, &state)? {
        emit_chat_stream_event(app, stream_id, event)?;
    }
    Ok(())
}

fn execute_anthropic_chat_stream(
    request: &ModelChatRequest,
    app: &AppHandle,
    stream_id: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let api_key = normalize_optional_config_value(request.api_key.as_deref())
        .ok_or_else(|| "Anthropic model chat stream requires an API key.".to_string())?;
    let model = normalize_model(request)?;
    let provider_id = infer_provider_id(request);
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_anthropic_base_url(&provider_id));
    let endpoint = anthropic_endpoint(&base_url);
    let body = build_anthropic_chat_body(&model, request, true)?;
    let response = send_json_stream_request(
        &endpoint,
        &body,
        request.timeout_ms,
        build_anthropic_headers(&api_key, &provider_id),
        &provider_id,
    )?;
    let mut state = AnthropicStreamState::default();
    for line in BufReader::with_capacity(65_536, response).lines() {
        if cancelled.load(Ordering::Relaxed) {
            emit_chat_stream_event(
                app,
                stream_id,
                ModelChatStreamEvent::MessageEnd {
                    finish_reason: ModelFinishReason::Cancelled,
                },
            )?;
            return Ok(());
        }
        let line =
            line.map_err(|error| format!("Anthropic model chat stream read error: {error}"))?;
        let Some(data) = sse_data(&line) else {
            continue;
        };
        let value = parse_stream_json(data, "Anthropic model chat stream")?;
        for event in consume_anthropic_stream_value(&value, request, &mut state)? {
            emit_chat_stream_event(app, stream_id, event)?;
        }
        if state.saw_message_stop {
            break;
        }
    }
    for event in finalize_anthropic_stream(request, &state)? {
        emit_chat_stream_event(app, stream_id, event)?;
    }
    Ok(())
}

fn send_json_stream_request(
    endpoint: &str,
    body: &serde_json::Value,
    timeout_ms: Option<u64>,
    headers: Vec<(String, String)>,
    provider_id: &str,
) -> Result<reqwest::blocking::Response, String> {
    let timeout = timeout_ms
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(MODEL_CHAT_STREAM_TIMEOUT);
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let mut builder = client
        .post(endpoint)
        .header("Content-Type", "application/json");
    for (name, value) in headers {
        builder = builder.header(&name, &value);
    }
    let response = builder
        .json(body)
        .send()
        .map_err(|error| classify_http_request_error(error, endpoint))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let response_text = response
        .text()
        .map_err(|error| format!("Model chat stream could not read response: {error}"))?;
    Err(
        classify_http_status_error(status, &response_text, provider_id)
            .unwrap_or_else(|| format!("Model chat stream returned HTTP {}.", status.as_u16())),
    )
}

fn consume_openai_stream_value(
    value: &serde_json::Value,
    request: &ModelChatRequest,
    state: &mut OpenAiStreamState,
) -> Result<Vec<ModelChatStreamEvent>, String> {
    let mut events = Vec::new();
    if value.get("error").is_some() {
        return Err("Model chat stream returned an error.".to_string());
    }
    if let Some(usage) = crate::extract_openai_compatible_usage(value) {
        state.usage_seen = true;
        events.push(ModelChatStreamEvent::Usage { usage });
    }
    let Some(choice) = value
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return Ok(events);
    };
    if let Some(reason) = choice
        .get("finish_reason")
        .and_then(serde_json::Value::as_str)
    {
        state.finish_reason = Some(reason.to_string());
    }
    let Some(delta) = choice.get("delta") else {
        return Ok(events);
    };
    if let Some(text) = delta
        .get("content")
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
    {
        state.text_seen = true;
        events.push(ModelChatStreamEvent::TextDelta {
            delta: text.to_string(),
        });
    }
    let Some(tool_calls) = delta
        .get("tool_calls")
        .and_then(serde_json::Value::as_array)
    else {
        return Ok(events);
    };
    for tool_call in tool_calls {
        let index = tool_call
            .get("index")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| "Model chat stream tool call is missing index.".to_string())?;
        while state.tool_calls.len() <= index {
            state.tool_calls.push(PendingToolCall::default());
        }
        let pending = &mut state.tool_calls[index];
        merge_stream_identity(&mut pending.id, tool_call.get("id"), "id", index)?;
        let function = tool_call.get("function");
        merge_stream_identity(
            &mut pending.name,
            function.and_then(|value| value.get("name")),
            "name",
            index,
        )?;
        let was_started = pending.started;
        start_pending_tool_call(index, pending, request, &mut events)?;
        if !was_started && pending.started && !pending.arguments.is_empty() {
            events.push(ModelChatStreamEvent::ToolCallArgumentsDelta {
                index,
                delta: pending.arguments.clone(),
            });
        }
        if let Some(arguments) = function
            .and_then(|value| value.get("arguments"))
            .and_then(serde_json::Value::as_str)
            .filter(|arguments| !arguments.is_empty())
        {
            pending.arguments.push_str(arguments);
            if pending.started {
                events.push(ModelChatStreamEvent::ToolCallArgumentsDelta {
                    index,
                    delta: arguments.to_string(),
                });
            }
        }
    }
    Ok(events)
}

fn consume_anthropic_stream_value(
    value: &serde_json::Value,
    request: &ModelChatRequest,
    state: &mut AnthropicStreamState,
) -> Result<Vec<ModelChatStreamEvent>, String> {
    let mut events = Vec::new();
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("message_start") => {
            if let Some(tokens) = value
                .pointer("/message/usage/input_tokens")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
            {
                state.input_tokens = tokens;
            }
        }
        Some("content_block_start") => {
            let index = stream_index(value)?;
            let block = value.get("content_block").ok_or_else(|| {
                "Anthropic content_block_start is missing content_block.".to_string()
            })?;
            match block.get("type").and_then(serde_json::Value::as_str) {
                Some("text") => {
                    if let Some(text) = block
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        state.text_seen = true;
                        events.push(ModelChatStreamEvent::TextDelta {
                            delta: text.to_string(),
                        });
                    }
                }
                Some("tool_use") => {
                    while state.tool_calls.len() <= index {
                        state.tool_calls.push(PendingToolCall::default());
                    }
                    let pending = &mut state.tool_calls[index];
                    merge_stream_identity(&mut pending.id, block.get("id"), "id", index)?;
                    merge_stream_identity(&mut pending.name, block.get("name"), "name", index)?;
                    start_pending_tool_call(index, pending, request, &mut events)?;
                    if let Some(input) = block
                        .get("input")
                        .and_then(serde_json::Value::as_object)
                        .filter(|input| !input.is_empty())
                    {
                        let delta = serde_json::Value::Object(input.clone()).to_string();
                        pending.arguments.push_str(&delta);
                        events.push(ModelChatStreamEvent::ToolCallArgumentsDelta { index, delta });
                    }
                }
                _ => {}
            }
        }
        Some("content_block_delta") => {
            let index = stream_index(value)?;
            let delta = value
                .get("delta")
                .ok_or_else(|| "Anthropic content_block_delta is missing delta.".to_string())?;
            match delta.get("type").and_then(serde_json::Value::as_str) {
                Some("text_delta") => {
                    if let Some(text) = delta
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .filter(|text| !text.is_empty())
                    {
                        state.text_seen = true;
                        events.push(ModelChatStreamEvent::TextDelta {
                            delta: text.to_string(),
                        });
                    }
                }
                Some("input_json_delta") => {
                    let arguments = delta
                        .get("partial_json")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            "Anthropic input_json_delta is missing partial_json.".to_string()
                        })?;
                    let pending = state.tool_calls.get_mut(index).ok_or_else(|| {
                        format!("Anthropic arguments delta references unknown tool index {index}.")
                    })?;
                    if !pending.started {
                        return Err(format!(
                            "Anthropic arguments delta arrived before tool start at index {index}."
                        ));
                    }
                    pending.arguments.push_str(arguments);
                    events.push(ModelChatStreamEvent::ToolCallArgumentsDelta {
                        index,
                        delta: arguments.to_string(),
                    });
                }
                _ => {}
            }
        }
        Some("message_delta") => {
            if let Some(reason) = value
                .pointer("/delta/stop_reason")
                .and_then(serde_json::Value::as_str)
            {
                state.finish_reason = Some(reason.to_string());
            }
            if let Some(tokens) = value
                .pointer("/usage/output_tokens")
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
            {
                state.output_tokens = tokens;
                events.push(ModelChatStreamEvent::Usage {
                    usage: ModelUsage {
                        input_tokens: state.input_tokens,
                        output_tokens: state.output_tokens,
                        total_tokens: state.input_tokens + state.output_tokens,
                    },
                });
            }
        }
        Some("message_stop") => state.saw_message_stop = true,
        Some("error") => {
            return Err("Anthropic model chat stream returned an error.".to_string());
        }
        _ => {}
    }
    Ok(events)
}

fn finalize_openai_stream(
    request: &ModelChatRequest,
    state: &OpenAiStreamState,
) -> Result<Vec<ModelChatStreamEvent>, String> {
    if !state.saw_done && state.finish_reason.is_none() {
        return Err(
            "Model chat stream ended without a terminal marker or finish reason.".to_string(),
        );
    }
    validate_tool_finish_reason(
        "Model chat stream",
        state.finish_reason.as_deref(),
        !state.tool_calls.is_empty(),
    )?;
    if !state.text_seen && state.tool_calls.is_empty() {
        let shape = ModelChatEmptyResponseShape {
            choices_count: 0,
            message_keys: Vec::new(),
            content_type: "none".to_string(),
            content_length: 0,
            has_reasoning_content: false,
            tool_calls_count: 0,
            has_usage: state.usage_seen,
        };
        return Err(empty_chat_response_error(
            &shape,
            state.finish_reason.as_deref(),
            None,
        ));
    }
    finalize_stream_tools(request, &state.tool_calls, state.finish_reason.as_deref())
}

fn finalize_anthropic_stream(
    request: &ModelChatRequest,
    state: &AnthropicStreamState,
) -> Result<Vec<ModelChatStreamEvent>, String> {
    if !state.saw_message_stop && state.finish_reason.is_none() {
        return Err(
            "Anthropic model chat stream ended without message_stop or stop_reason.".to_string(),
        );
    }
    validate_tool_finish_reason(
        "Model chat stream",
        state.finish_reason.as_deref(),
        !state.tool_calls.is_empty(),
    )?;
    if !state.text_seen && state.tool_calls.is_empty() {
        let usage = (state.input_tokens > 0 || state.output_tokens > 0).then(|| ModelUsage {
            input_tokens: state.input_tokens,
            output_tokens: state.output_tokens,
            total_tokens: state.input_tokens + state.output_tokens,
        });
        let shape = ModelChatEmptyResponseShape {
            choices_count: 0,
            message_keys: Vec::new(),
            content_type: "none".to_string(),
            content_length: 0,
            has_reasoning_content: false,
            tool_calls_count: 0,
            has_usage: usage.is_some(),
        };
        return Err(empty_chat_response_error(
            &shape,
            state.finish_reason.as_deref(),
            usage.as_ref(),
        ));
    }
    finalize_stream_tools(request, &state.tool_calls, state.finish_reason.as_deref())
}

fn finalize_stream_tools(
    request: &ModelChatRequest,
    tool_calls: &[PendingToolCall],
    finish_reason: Option<&str>,
) -> Result<Vec<ModelChatStreamEvent>, String> {
    let allowed: HashSet<&str> = request
        .tools
        .iter()
        .map(|tool| tool.model_name.as_str())
        .collect();
    let mut ids = HashSet::new();
    let mut events = Vec::new();
    for (index, call) in tool_calls.iter().enumerate() {
        let id = call
            .id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("Model chat stream tool call {index} is missing id."))?;
        if !ids.insert(id) {
            return Err(format!(
                "Model chat stream returned duplicate tool call id: {id}."
            ));
        }
        let name = call
            .name
            .as_deref()
            .ok_or_else(|| format!("Model chat stream tool call {index} is missing name."))?;
        if !allowed.contains(name) {
            return Err(format!(
                "Model chat stream returned unknown tool name: {name}."
            ));
        }
        if !call.started {
            return Err(format!(
                "Model chat stream tool call {index} never started."
            ));
        }
        let arguments_text = if call.arguments.is_empty() {
            "{}"
        } else {
            &call.arguments
        };
        serde_json::from_str::<serde_json::Value>(arguments_text)
            .map_err(|error| format!("Model chat stream tool call {id} returned truncated or invalid arguments JSON: {error}."))?
            .as_object()
            .ok_or_else(|| format!("Model chat stream tool call {id} arguments must be an object."))?;
        events.push(ModelChatStreamEvent::ToolCallEnd { index });
    }
    validate_tool_finish_reason("Model chat stream", finish_reason, !tool_calls.is_empty())?;
    events.push(ModelChatStreamEvent::MessageEnd {
        finish_reason: if tool_calls.is_empty() {
            normalize_finish_reason(finish_reason)
        } else {
            ModelFinishReason::ToolCalls
        },
    });
    Ok(events)
}

fn start_pending_tool_call(
    index: usize,
    pending: &mut PendingToolCall,
    request: &ModelChatRequest,
    events: &mut Vec<ModelChatStreamEvent>,
) -> Result<(), String> {
    if pending.started {
        return Ok(());
    }
    let (Some(id), Some(name)) = (pending.id.as_ref(), pending.name.as_ref()) else {
        return Ok(());
    };
    if !request.tools.iter().any(|tool| tool.model_name == *name) {
        return Err(format!(
            "Model chat stream returned unknown tool name: {name}."
        ));
    }
    pending.started = true;
    events.push(ModelChatStreamEvent::ToolCallStart {
        index,
        id: id.clone(),
        name: name.clone(),
    });
    Ok(())
}

fn merge_stream_identity(
    target: &mut Option<String>,
    value: Option<&serde_json::Value>,
    field: &str,
    index: usize,
) -> Result<(), String> {
    let Some(value) = value
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    if let Some(existing) = target {
        if existing != value {
            return Err(format!(
                "Model chat stream changed tool {field} at index {index}."
            ));
        }
    } else {
        *target = Some(value.to_string());
    }
    Ok(())
}

fn stream_index(value: &serde_json::Value) -> Result<usize, String> {
    value
        .get("index")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "Model chat stream event is missing index.".to_string())
}

fn sse_data(line: &str) -> Option<&str> {
    line.trim()
        .strip_prefix("data:")
        .map(str::trim)
        .filter(|data| !data.is_empty())
}

fn parse_stream_json(data: &str, label: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(data).map_err(|error| format!("{label} returned invalid JSON: {error}."))
}

fn emit_chat_stream_event(
    app: &AppHandle,
    stream_id: &str,
    event: ModelChatStreamEvent,
) -> Result<(), String> {
    app.emit(
        MODEL_CHAT_STREAM_EVENT_NAME,
        ModelChatStreamPayload {
            stream_id: stream_id.to_string(),
            event,
        },
    )
    .map_err(|error| format!("Could not emit model chat stream event: {error}"))
}

fn complete_model_chat_blocking(
    app: &AppHandle,
    mut request: ModelChatRequest,
) -> Result<ModelChatResponse, String> {
    validate_model_chat_request(&request)?;
    hydrate_model_chat_api_key(app, &mut request)?;
    match request.protocol.as_deref().unwrap_or("openai-compatible") {
        "anthropic" => run_anthropic_chat_request(&request),
        "openai-compatible" => run_openai_chat_request(&request),
        protocol => Err(format!("Unsupported model chat protocol: {protocol}.")),
    }
}

fn validate_model_chat_request(request: &ModelChatRequest) -> Result<(), String> {
    if request.messages.is_empty() {
        return Err("Model chat requires at least one message.".to_string());
    }
    normalize_model(request)?;

    let mut canonical_names = HashSet::new();
    let mut model_names = HashSet::new();
    for tool in &request.tools {
        if tool.canonical_name.trim().is_empty() {
            return Err("Model chat tool canonicalName cannot be empty.".to_string());
        }
        if !canonical_names.insert(tool.canonical_name.as_str()) {
            return Err(format!(
                "Model chat contains duplicate canonical tool name: {}.",
                tool.canonical_name
            ));
        }
        validate_model_tool_name(&tool.model_name)?;
        if !model_names.insert(tool.model_name.as_str()) {
            return Err(format!(
                "Model chat contains duplicate model tool name: {}.",
                tool.model_name
            ));
        }
        if tool.description.trim().is_empty() {
            return Err(format!(
                "Model chat tool {} requires a description.",
                tool.model_name
            ));
        }
        if tool
            .input_schema
            .get("type")
            .and_then(serde_json::Value::as_str)
            != Some("object")
        {
            return Err(format!(
                "Model chat tool {} inputSchema must be an object schema.",
                tool.model_name
            ));
        }
    }

    if let Some(ModelToolChoice::Named { name }) = &request.tool_choice {
        if !model_names.contains(name.as_str()) {
            return Err(format!(
                "Model chat toolChoice references unknown tool: {name}."
            ));
        }
    }

    let mut prior_tool_calls = HashMap::new();
    let mut tool_result_ids = HashSet::new();
    for message in &request.messages {
        validate_message_content(message)?;
        match message {
            ModelChatMessage::Assistant { tool_calls, .. } => {
                for tool_call in tool_calls {
                    validate_tool_call(tool_call, &model_names, &mut prior_tool_calls)?;
                }
            }
            ModelChatMessage::Tool {
                tool_call_id, name, ..
            } => {
                let Some(expected_name) = prior_tool_calls.get(tool_call_id.as_str()) else {
                    return Err(format!(
                        "Model chat tool result references unknown toolCallId: {tool_call_id}."
                    ));
                };
                if *expected_name != name.as_str() {
                    return Err(format!(
                        "Model chat tool result {tool_call_id} must use tool {expected_name}, not {name}."
                    ));
                }
                if !tool_result_ids.insert(tool_call_id.as_str()) {
                    return Err(format!(
                        "Model chat contains duplicate tool result for toolCallId: {tool_call_id}."
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_message_content(message: &ModelChatMessage) -> Result<(), String> {
    let content = match message {
        ModelChatMessage::System { content }
        | ModelChatMessage::User { content }
        | ModelChatMessage::Assistant { content, .. }
        | ModelChatMessage::Tool { content, .. } => content,
    };
    if content.iter().any(|block| match block {
        ModelContentBlock::Text { text } => text.trim().is_empty(),
        ModelContentBlock::Image { url, .. } => url.trim().is_empty(),
    }) {
        return Err("Model chat content blocks cannot be empty.".to_string());
    }
    Ok(())
}

fn validate_tool_call<'a>(
    tool_call: &'a ModelToolCall,
    model_names: &HashSet<&str>,
    call_names: &mut HashMap<&'a str, &'a str>,
) -> Result<(), String> {
    if tool_call.id.trim().is_empty() {
        return Err("Model chat tool call id cannot be empty.".to_string());
    }
    if call_names
        .insert(tool_call.id.as_str(), tool_call.name.as_str())
        .is_some()
    {
        return Err(format!(
            "Model chat contains duplicate tool call id: {}.",
            tool_call.id
        ));
    }
    if !model_names.contains(tool_call.name.as_str()) {
        return Err(format!(
            "Model chat tool call references unknown tool: {}.",
            tool_call.name
        ));
    }
    Ok(())
}

fn validate_model_tool_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= MODEL_TOOL_NAME_MAX_CHARS
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid provider model tool name: {name}."))
    }
}

fn hydrate_model_chat_api_key(
    app: &AppHandle,
    request: &mut ModelChatRequest,
) -> Result<(), String> {
    if normalize_optional_config_value(request.api_key.as_deref()).is_some() {
        return Ok(());
    }
    let Some(reference) = normalize_optional_config_value(request.api_key_reference.as_deref())
    else {
        return Ok(());
    };
    let provider_id = infer_provider_id(request);
    let base_url =
        normalize_optional_config_value(request.base_url.as_deref()).unwrap_or_else(|| {
            if request.protocol.as_deref() == Some("anthropic") {
                default_anthropic_base_url(&provider_id)
            } else {
                default_openai_compatible_base_url_for_provider(&provider_id)
            }
        });
    if request.protocol.as_deref() != Some("anthropic")
        && !openai_compatible_request_requires_api_key(&provider_id, &base_url)
    {
        return Ok(());
    }
    ensure_saved_model_key_matches_base_url(&provider_id, Some(&base_url))?;
    request.api_key = Some(load_model_api_key_secret_with_fallback(
        app,
        &reference,
        &provider_id,
    )?);
    Ok(())
}

fn run_openai_chat_request(request: &ModelChatRequest) -> Result<ModelChatResponse, String> {
    let model = normalize_model(request)?;
    let provider_id = infer_provider_id(request);
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_openai_compatible_base_url_for_provider(&provider_id));
    let api_key = normalize_optional_config_value(request.api_key.as_deref());
    if api_key.is_none() && openai_compatible_request_requires_api_key(&provider_id, &base_url) {
        return Err("Model chat requires an API key.".to_string());
    }
    let endpoint = create_chat_completions_endpoint(&base_url);
    let body = build_openai_chat_body(&model, request, false)?;
    let response_text = send_json_request(
        &endpoint,
        &body,
        request.timeout_ms,
        api_key
            .map(|key| vec![("Authorization".to_string(), format!("Bearer {key}"))])
            .unwrap_or_default(),
        &provider_id,
    )?;
    let value: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|error| format!("Model chat returned invalid JSON: {error}."))?;
    parse_openai_chat_response(&value, request)
}

fn run_anthropic_chat_request(request: &ModelChatRequest) -> Result<ModelChatResponse, String> {
    let api_key = normalize_optional_config_value(request.api_key.as_deref())
        .ok_or_else(|| "Anthropic model chat requires an API key.".to_string())?;
    let model = normalize_model(request)?;
    let provider_id = infer_provider_id(request);
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_anthropic_base_url(&provider_id));
    let endpoint = anthropic_endpoint(&base_url);
    let body = build_anthropic_chat_body(&model, request, false)?;
    let response_text = send_json_request(
        &endpoint,
        &body,
        request.timeout_ms,
        build_anthropic_headers(&api_key, &provider_id),
        &provider_id,
    )?;
    let value: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|error| format!("Anthropic model chat returned invalid JSON: {error}."))?;
    parse_anthropic_chat_response(&value, request)
}

fn send_json_request(
    endpoint: &str,
    body: &serde_json::Value,
    timeout_ms: Option<u64>,
    headers: Vec<(String, String)>,
    provider_id: &str,
) -> Result<String, String> {
    let timeout = timeout_ms
        .filter(|value| *value > 0)
        .map(Duration::from_millis)
        .unwrap_or(OPENCODE_PROPOSAL_TIMEOUT);
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())?;
    let mut builder = client
        .post(endpoint)
        .header("Content-Type", "application/json");
    for (name, value) in headers {
        builder = builder.header(&name, &value);
    }
    let response = builder
        .json(body)
        .send()
        .map_err(|error| classify_http_request_error(error, endpoint))?;
    let status = response.status();
    let response_text = response
        .text()
        .map_err(|error| format!("Model chat could not read response: {error}"))?;
    if let Some(error) = classify_http_status_error(status, &response_text, provider_id) {
        return Err(error.replace("Model completion", "Model chat"));
    }
    Ok(response_text)
}

fn build_openai_chat_body(
    model: &str,
    request: &ModelChatRequest,
    stream: bool,
) -> Result<serde_json::Value, String> {
    let messages = request
        .messages
        .iter()
        .map(openai_message_value)
        .collect::<Result<Vec<_>, _>>()?;
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": stream,
        "temperature": request.temperature.unwrap_or(0.2),
        "max_tokens": request.max_tokens.unwrap_or(2048),
    });
    if !request.tools.is_empty() {
        body["tools"] = serde_json::Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    serde_json::json!({
                        "type": "function",
                        "function": {
                            "name": tool.model_name,
                            "description": tool.description,
                            "parameters": tool.input_schema,
                        }
                    })
                })
                .collect(),
        );
    }
    if let Some(choice) = &request.tool_choice {
        body["tool_choice"] = openai_tool_choice_value(choice);
    }
    if let Some(parallel) = request.parallel_tool_calls {
        body["parallel_tool_calls"] = serde_json::Value::Bool(parallel);
    }
    if let Some(format) = &request.response_format {
        let schema = format.json_schema.clone();
        let name = schema
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("javis_response");
        let description = schema
            .get("description")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Structured response from Javis Agent runtime.");
        body["response_format"] = serde_json::json!({
            "type": "json_schema",
            "json_schema": {
                "name": name,
                "description": description,
                "schema": schema,
                "strict": true,
            },
        });
    }
    if stream {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }
    Ok(body)
}

fn openai_message_value(message: &ModelChatMessage) -> Result<serde_json::Value, String> {
    match message {
        ModelChatMessage::System { content } => Ok(serde_json::json!({
            "role": "system",
            "content": text_content(content),
        })),
        ModelChatMessage::User { content } => Ok(serde_json::json!({
            "role": "user",
            "content": openai_content_value(content),
        })),
        ModelChatMessage::Assistant {
            content,
            tool_calls,
        } => {
            let mut value = serde_json::json!({
                "role": "assistant",
                "content": text_content(content),
            });
            if !tool_calls.is_empty() {
                value["tool_calls"] = serde_json::Value::Array(tool_calls.iter().map(|call| {
                    serde_json::json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": serde_json::Value::Object(call.arguments.clone()).to_string(),
                        }
                    })
                }).collect());
            }
            Ok(value)
        }
        ModelChatMessage::Tool {
            tool_call_id,
            name,
            content,
            ..
        } => Ok(serde_json::json!({
            "role": "tool",
            "tool_call_id": tool_call_id,
            "name": name,
            "content": text_content(content),
        })),
    }
}

fn openai_content_value(content: &[ModelContentBlock]) -> serde_json::Value {
    if content
        .iter()
        .all(|block| matches!(block, ModelContentBlock::Text { .. }))
    {
        return serde_json::Value::String(text_content(content));
    }
    serde_json::Value::Array(
        content
            .iter()
            .map(|block| match block {
                ModelContentBlock::Text { text } => {
                    serde_json::json!({ "type": "text", "text": text })
                }
                ModelContentBlock::Image { url, .. } => serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": url },
                }),
            })
            .collect(),
    )
}

fn openai_tool_choice_value(choice: &ModelToolChoice) -> serde_json::Value {
    match choice {
        ModelToolChoice::Mode(ModelToolChoiceMode::Auto) => serde_json::json!("auto"),
        ModelToolChoice::Mode(ModelToolChoiceMode::None) => serde_json::json!("none"),
        ModelToolChoice::Mode(ModelToolChoiceMode::Required) => serde_json::json!("required"),
        ModelToolChoice::Named { name } => serde_json::json!({
            "type": "function",
            "function": { "name": name },
        }),
    }
}

fn build_anthropic_chat_body(
    model: &str,
    request: &ModelChatRequest,
    stream: bool,
) -> Result<serde_json::Value, String> {
    let system = request
        .messages
        .iter()
        .filter_map(|message| match message {
            ModelChatMessage::System { content } => Some(text_content(content)),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let messages = request
        .messages
        .iter()
        .filter(|message| !matches!(message, ModelChatMessage::System { .. }))
        .map(anthropic_message_value)
        .collect::<Result<Vec<_>, _>>()?;
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "messages": messages,
        "stream": stream,
    });
    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    if !request.tools.is_empty() {
        body["tools"] = serde_json::Value::Array(
            request
                .tools
                .iter()
                .map(|tool| {
                    serde_json::json!({
                        "name": tool.model_name,
                        "description": tool.description,
                        "input_schema": tool.input_schema,
                    })
                })
                .collect(),
        );
    }
    if let Some(choice) = &request.tool_choice {
        match choice {
            ModelToolChoice::Mode(ModelToolChoiceMode::None) => {
                body.as_object_mut().expect("object").remove("tools");
            }
            _ => body["tool_choice"] = anthropic_tool_choice_value(choice),
        }
    }
    Ok(body)
}

fn anthropic_message_value(message: &ModelChatMessage) -> Result<serde_json::Value, String> {
    match message {
        ModelChatMessage::User { content } => Ok(serde_json::json!({
            "role": "user",
            "content": anthropic_content_value(content)?,
        })),
        ModelChatMessage::Assistant {
            content,
            tool_calls,
        } => {
            let mut blocks = anthropic_content_value(content)?;
            for call in tool_calls {
                blocks.push(serde_json::json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": call.arguments,
                }));
            }
            Ok(serde_json::json!({ "role": "assistant", "content": blocks }))
        }
        ModelChatMessage::Tool {
            tool_call_id,
            content,
            status,
            ..
        } => Ok(serde_json::json!({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_call_id,
                "content": text_content(content),
                "is_error": matches!(status, ModelToolStatus::Error),
            }]
        })),
        ModelChatMessage::System { .. } => {
            Err("System messages must be lifted before Anthropic serialization.".to_string())
        }
    }
}

fn anthropic_content_value(
    content: &[ModelContentBlock],
) -> Result<Vec<serde_json::Value>, String> {
    content
        .iter()
        .map(|block| match block {
            ModelContentBlock::Text { text } => {
                Ok(serde_json::json!({ "type": "text", "text": text }))
            }
            ModelContentBlock::Image { url, .. } => {
                let (media_type, data) = parse_data_url(url)?;
                Ok(serde_json::json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": media_type, "data": data },
                }))
            }
        })
        .collect()
}

fn anthropic_tool_choice_value(choice: &ModelToolChoice) -> serde_json::Value {
    match choice {
        ModelToolChoice::Mode(ModelToolChoiceMode::Auto) => serde_json::json!({ "type": "auto" }),
        ModelToolChoice::Mode(ModelToolChoiceMode::Required) => {
            serde_json::json!({ "type": "any" })
        }
        ModelToolChoice::Named { name } => serde_json::json!({ "type": "tool", "name": name }),
        ModelToolChoice::Mode(ModelToolChoiceMode::None) => serde_json::Value::Null,
    }
}


fn build_openai_empty_response_shape(
    value: &serde_json::Value,
    message: &serde_json::Value,
    tool_calls_count: usize,
    has_usage: bool,
) -> ModelChatEmptyResponseShape {
    let choices_count = value
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let message_keys = message
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let content_value = message.get("content");
    let (content_type, content_length) = match content_value {
        Some(serde_json::Value::String(text)) => ("string".to_string(), text.len()),
        Some(serde_json::Value::Array(blocks)) => {
            ("array".to_string(), blocks.len())
        }
        Some(serde_json::Value::Null) | None => ("missing".to_string(), 0),
        Some(_) => ("other".to_string(), 0),
    };
    let has_reasoning_content = message
        .get("reasoning_content")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|text| !text.is_empty());
    ModelChatEmptyResponseShape {
        choices_count,
        message_keys,
        content_type,
        content_length,
        has_reasoning_content,
        tool_calls_count,
        has_usage,
    }
}

fn build_anthropic_empty_response_shape(
    value: &serde_json::Value,
    tool_calls_count: usize,
    has_usage: bool,
) -> ModelChatEmptyResponseShape {
    let content_type = match value.get("content") {
        Some(serde_json::Value::Array(blocks)) => format!("array:{}", blocks.len()),
        Some(_) => "other".to_string(),
        None => "missing".to_string(),
    };
    let content_length = value
        .get("content")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    ModelChatEmptyResponseShape {
        choices_count: 0,
        message_keys: value
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default(),
        content_type,
        content_length,
        has_reasoning_content: false,
        tool_calls_count,
        has_usage,
    }
}

fn parse_openai_chat_response(
    value: &serde_json::Value,
    request: &ModelChatRequest,
) -> Result<ModelChatResponse, String> {
    let choice = value
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "Model chat returned no choices.".to_string())?;
    let message = choice
        .get("message")
        .ok_or_else(|| "Model chat returned no assistant message.".to_string())?;
    let content = parse_openai_text_content(message.get("content"));
    let tool_calls = parse_openai_tool_calls(message.get("tool_calls"), request)?;
    if content.is_empty() && tool_calls.is_empty() {
        let usage = crate::extract_openai_compatible_usage(value);
        let shape = build_openai_empty_response_shape(value, message, tool_calls.len(), usage.is_some());
        let finish_reason = choice.get("finish_reason").and_then(serde_json::Value::as_str);
        return Err(empty_chat_response_error(&shape, finish_reason, usage.as_ref()));
    }
    let provider_finish_reason = choice
        .get("finish_reason")
        .and_then(serde_json::Value::as_str);
    validate_tool_finish_reason(
        "Model chat response",
        provider_finish_reason,
        !tool_calls.is_empty(),
    )?;
    let finish_reason = if !tool_calls.is_empty() {
        ModelFinishReason::ToolCalls
    } else {
        normalize_finish_reason(provider_finish_reason)
    };
    Ok(ModelChatResponse {
        message: ModelAssistantMessage {
            role: "assistant",
            content,
            tool_calls,
        },
        finish_reason,
        token_usage: crate::extract_openai_compatible_usage(value),
    })
}

fn parse_openai_tool_calls(
    value: Option<&serde_json::Value>,
    request: &ModelChatRequest,
) -> Result<Vec<ModelToolCall>, String> {
    let Some(calls) = value.and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };
    let allowed: HashSet<&str> = request
        .tools
        .iter()
        .map(|tool| tool.model_name.as_str())
        .collect();
    let mut ids = HashSet::new();
    calls
        .iter()
        .map(|call| {
            let id = call
                .get("id")
                .and_then(serde_json::Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Model chat tool call is missing id.".to_string())?;
            if !ids.insert(id) {
                return Err(format!("Model chat returned duplicate tool call id: {id}."));
            }
            let function = call
                .get("function")
                .ok_or_else(|| format!("Model chat tool call {id} is missing function."))?;
            let name = function
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| format!("Model chat tool call {id} is missing name."))?;
            if !allowed.contains(name) {
                return Err(format!("Model chat returned unknown tool name: {name}."));
            }
            let arguments_text = function
                .get("arguments")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| format!("Model chat tool call {id} is missing arguments."))?;
            let arguments = serde_json::from_str::<serde_json::Value>(arguments_text)
                .map_err(|error| {
                    format!("Model chat tool call {id} returned invalid arguments JSON: {error}.")
                })?
                .as_object()
                .cloned()
                .ok_or_else(|| format!("Model chat tool call {id} arguments must be an object."))?;
            Ok(ModelToolCall {
                id: id.to_string(),
                name: name.to_string(),
                arguments,
            })
        })
        .collect()
}

fn parse_anthropic_chat_response(
    value: &serde_json::Value,
    request: &ModelChatRequest,
) -> Result<ModelChatResponse, String> {
    let blocks = value
        .get("content")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Anthropic model chat returned no content blocks.".to_string())?;
    let allowed: HashSet<&str> = request
        .tools
        .iter()
        .map(|tool| tool.model_name.as_str())
        .collect();
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    let mut ids = HashSet::new();
    for block in blocks {
        match block.get("type").and_then(serde_json::Value::as_str) {
            Some("text") => {
                if let Some(text) = block
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    content.push(ModelContentBlock::Text {
                        text: text.to_string(),
                    });
                }
            }
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .ok_or_else(|| "Anthropic tool_use is missing id.".to_string())?;
                if !ids.insert(id) {
                    return Err(format!(
                        "Anthropic model chat returned duplicate tool call id: {id}."
                    ));
                }
                let name = block
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| format!("Anthropic tool_use {id} is missing name."))?;
                if !allowed.contains(name) {
                    return Err(format!(
                        "Anthropic model chat returned unknown tool name: {name}."
                    ));
                }
                let arguments = block
                    .get("input")
                    .and_then(serde_json::Value::as_object)
                    .cloned()
                    .ok_or_else(|| format!("Anthropic tool_use {id} input must be an object."))?;
                tool_calls.push(ModelToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments,
                });
            }
            _ => {}
        }
    }
    if content.is_empty() && tool_calls.is_empty() {
        let usage = parse_anthropic_usage(value);
        let shape = build_anthropic_empty_response_shape(value, tool_calls.len(), usage.is_some());
        let stop_reason = value.get("stop_reason").and_then(serde_json::Value::as_str);
        return Err(empty_chat_response_error(&shape, stop_reason, usage.as_ref()));
    }
    let stop_reason = value.get("stop_reason").and_then(serde_json::Value::as_str);
    validate_tool_finish_reason(
        "Anthropic model chat response",
        stop_reason,
        !tool_calls.is_empty(),
    )?;
    Ok(ModelChatResponse {
        message: ModelAssistantMessage {
            role: "assistant",
            content,
            tool_calls,
        },
        finish_reason: if stop_reason == Some("tool_use") {
            ModelFinishReason::ToolCalls
        } else {
            normalize_finish_reason(stop_reason)
        },
        token_usage: parse_anthropic_usage(value),
    })
}

fn parse_openai_text_content(value: Option<&serde_json::Value>) -> Vec<ModelContentBlock> {
    match value {
        Some(serde_json::Value::String(text)) if !text.is_empty() => {
            vec![ModelContentBlock::Text { text: text.clone() }]
        }
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(|text| ModelContentBlock::Text {
                        text: text.to_string(),
                    })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_anthropic_usage(value: &serde_json::Value) -> Option<ModelUsage> {
    let usage = value.get("usage")?;
    let input_tokens = u32::try_from(usage.get("input_tokens")?.as_u64()?).ok()?;
    let output_tokens = u32::try_from(usage.get("output_tokens")?.as_u64()?).ok()?;
    Some(ModelUsage {
        input_tokens,
        output_tokens,
        total_tokens: input_tokens + output_tokens,
    })
}

fn normalize_finish_reason(reason: Option<&str>) -> ModelFinishReason {
    match reason {
        Some("tool_calls" | "tool_use" | "function_call") => ModelFinishReason::ToolCalls,
        Some("length" | "max_tokens") => ModelFinishReason::Length,
        Some("content_filter") => ModelFinishReason::ContentFilter,
        Some("cancelled") => ModelFinishReason::Cancelled,
        Some("error") => ModelFinishReason::Error,
        _ => ModelFinishReason::Stop,
    }
}

fn validate_tool_finish_reason(
    label: &str,
    reason: Option<&str>,
    has_tool_calls: bool,
) -> Result<(), String> {
    let reports_tool_calls = matches!(reason, Some("tool_calls" | "tool_use" | "function_call"));
    if has_tool_calls && reason.is_some() && !reports_tool_calls {
        return Err(format!(
            "{label} contains tool calls but reported finish reason {}.",
            reason.unwrap_or("unknown")
        ));
    }
    if !has_tool_calls && reports_tool_calls {
        return Err(format!(
            "{label} reported a tool-call finish reason without tool calls."
        ));
    }
    Ok(())
}

fn text_content(content: &[ModelContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ModelContentBlock::Text { text } => Some(text.as_str()),
            ModelContentBlock::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_model(request: &ModelChatRequest) -> Result<String, String> {
    normalize_optional_config_value(request.model.as_deref())
        .map(|model| {
            model
                .rsplit_once('/')
                .map(|(_, name)| name.to_string())
                .unwrap_or(model)
        })
        .ok_or_else(|| "Model chat requires a model.".to_string())
}

fn infer_provider_id(request: &ModelChatRequest) -> String {
    normalize_optional_config_value(request.provider_id.as_deref())
        .or_else(|| {
            normalize_optional_config_value(request.model.as_deref()).and_then(|model| {
                model
                    .split_once('/')
                    .map(|(provider, _)| provider.to_string())
            })
        })
        .unwrap_or_else(|| {
            if request.protocol.as_deref() == Some("anthropic") {
                "anthropic".to_string()
            } else {
                "openai".to_string()
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

        #[test]
    fn empty_openai_response_returns_structured_shape_error_with_usage() {
        let request = request("openai-compatible");
        let value = serde_json::json!({
            "choices": [{
                "message": {
                    "content": null,
                    "reasoning_content": "",
                    "tool_calls": []
                },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 12, "completion_tokens": 0, "total_tokens": 12 }
        });
        let error = parse_openai_chat_response(&value, &request).expect_err("must fail");
        assert!(error.starts_with("__JAVIS_EMPTY_RESPONSE__"), "unexpected prefix: {error}");
        let payload: serde_json::Value =
            serde_json::from_str(&error[EMPTY_RESPONSE_ERROR_PREFIX.len()..]).expect("payload json");
        assert_eq!(payload["code"], "model_chat_empty_response");
        assert_eq!(payload["responseShape"]["choicesCount"], 1);
        assert_eq!(payload["responseShape"]["contentType"], "missing");
        assert_eq!(payload["responseShape"]["hasReasoningContent"], false);
        assert_eq!(payload["responseShape"]["toolCallsCount"], 0);
        assert_eq!(payload["responseShape"]["hasUsage"], true);
        assert_eq!(payload["finishReason"], "stop");
        assert_eq!(payload["usage"]["inputTokens"], 12);
        assert_eq!(payload["usage"]["totalTokens"], 12);
    }

    #[test]
    fn empty_anthropic_response_returns_structured_shape_error() {
        let request = request("anthropic");
        let value = serde_json::json!({
            "content": [],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 3, "output_tokens": 0 }
        });
        let error = parse_anthropic_chat_response(&value, &request).expect_err("must fail");
        assert!(error.starts_with("__JAVIS_EMPTY_RESPONSE__"), "unexpected prefix: {error}");
        let payload: serde_json::Value =
            serde_json::from_str(&error[EMPTY_RESPONSE_ERROR_PREFIX.len()..]).expect("payload json");
        assert_eq!(payload["code"], "model_chat_empty_response");
        assert_eq!(payload["responseShape"]["contentType"], "array:0");
        assert_eq!(payload["responseShape"]["hasUsage"], true);
        assert_eq!(payload["usage"]["inputTokens"], 3);
    }

    #[test]
    fn empty_openai_stream_detects_missing_text_and_tools() {
        let request = request("openai-compatible");
        let state = OpenAiStreamState {
            tool_calls: Vec::new(),
            finish_reason: Some("stop".to_string()),
            saw_done: true,
            text_seen: false,
            usage_seen: true,
        };
        let error = finalize_openai_stream(&request, &state).expect_err("must fail");
        assert!(error.starts_with("__JAVIS_EMPTY_RESPONSE__"), "unexpected prefix: {error}");
        let payload: serde_json::Value =
            serde_json::from_str(&error[EMPTY_RESPONSE_ERROR_PREFIX.len()..]).expect("payload json");
        assert_eq!(payload["responseShape"]["hasUsage"], true);
        assert_eq!(payload["responseShape"]["toolCallsCount"], 0);
    }

    #[test]
    fn non_empty_stream_response_is_not_classified_as_empty() {
        let request = request("openai-compatible");
        let state = OpenAiStreamState {
            tool_calls: Vec::new(),
            finish_reason: Some("stop".to_string()),
            saw_done: true,
            text_seen: true,
            usage_seen: true,
        };
        let events = finalize_openai_stream(&request, &state).expect("must succeed");
        assert!(matches!(
            events.as_slice(),
            [ModelChatStreamEvent::MessageEnd { finish_reason: ModelFinishReason::Stop }]
        ));
    }


fn request(protocol: &str) -> ModelChatRequest {
        ModelChatRequest {
            messages: vec![ModelChatMessage::User {
                content: vec![ModelContentBlock::Text {
                    text: "Search".to_string(),
                }],
            }],
            tools: vec![ModelToolDefinition {
                canonical_name: "web.search".to_string(),
                model_name: "web__search".to_string(),
                description: "Search the web".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": { "query": { "type": "string" } },
                    "required": ["query"]
                }),
            }],
            tool_choice: Some(ModelToolChoice::Mode(ModelToolChoiceMode::Auto)),
            response_format: None,
            parallel_tool_calls: Some(true),
            provider_id: Some(
                if protocol == "anthropic" {
                    "anthropic"
                } else {
                    "openai"
                }
                .to_string(),
            ),
            model: Some("test-model".to_string()),
            api_key: Some("secret".to_string()),
            api_key_reference: None,
            base_url: None,
            max_tokens: Some(512),
            temperature: Some(0.0),
            protocol: Some(protocol.to_string()),
            timeout_ms: None,
        }
    }

    #[test]
    fn openai_body_uses_native_tool_protocol() {
        let mut request = request("openai-compatible");
        request.response_format = Some(ModelResponseFormat {
            json_schema: serde_json::json!({
                "title": "research_result",
                "type": "object",
                "properties": { "answer": { "type": "string" } },
                "required": ["answer"]
            }),
        });
        let body = build_openai_chat_body("test-model", &request, false).expect("body");
        assert_eq!(body["tools"][0]["function"]["name"], "web__search");
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["parallel_tool_calls"], true);
        assert_eq!(
            body["response_format"]["json_schema"]["name"],
            "research_result"
        );
        assert_eq!(
            body["response_format"]["json_schema"]["schema"]["required"][0],
            "answer"
        );
        assert!(!body.to_string().contains("reactDecideNext"));
    }

    #[test]
    fn openai_native_request_honors_model_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind local fixture");
        let address = listener.local_addr().expect("local address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut request_bytes = [0_u8; 2_048];
            let _ = stream.read(&mut request_bytes);
            thread::sleep(Duration::from_millis(100));
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            );
        });
        let mut request = request("openai-compatible");
        request.base_url = Some(format!("http://{address}/v1"));
        request.timeout_ms = Some(20);

        let error = run_openai_chat_request(&request).expect_err("request timeout");
        let normalized = error.to_ascii_lowercase();
        assert!(normalized.contains("timed out") || normalized.contains("timeout"));
        server.join().expect("fixture server");
    }

    #[test]
    fn parses_openai_tool_call_fixture() {
        let response = serde_json::json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": { "name": "web__search", "arguments": "{\"query\":\"rust\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14 }
        });
        let parsed =
            parse_openai_chat_response(&response, &request("openai-compatible")).expect("response");
        assert!(matches!(parsed.finish_reason, ModelFinishReason::ToolCalls));
        assert_eq!(parsed.message.tool_calls[0].id, "call-1");
        assert_eq!(parsed.message.tool_calls[0].arguments["query"], "rust");
    }

    #[test]
    fn openai_fixture_completes_non_stream_and_stream_tool_result_loops() {
        let mut request = request("openai-compatible");
        let first = parse_openai_chat_response(
            &serde_json::json!({
                "choices": [{
                    "message": {
                        "content": null,
                        "tool_calls": [{
                            "id": "call-loop",
                            "type": "function",
                            "function": {
                                "name": "web__search",
                                "arguments": "{\"query\":\"rust\"}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            &request,
        )
        .expect("first response");
        request.messages.push(ModelChatMessage::Assistant {
            content: first.message.content.clone(),
            tool_calls: first.message.tool_calls.clone(),
        });
        request.messages.push(ModelChatMessage::Tool {
            tool_call_id: "call-loop".to_string(),
            name: "web__search".to_string(),
            content: vec![ModelContentBlock::Text {
                text: "Rust result".to_string(),
            }],
            status: ModelToolStatus::Success,
        });
        let second_body = build_openai_chat_body("test-model", &request, false).expect("body");
        assert_eq!(
            second_body["messages"][1]["tool_calls"][0]["id"],
            "call-loop"
        );
        assert_eq!(second_body["messages"][2]["tool_call_id"], "call-loop");
        let final_response = parse_openai_chat_response(
            &serde_json::json!({
                "choices": [{
                    "message": { "role": "assistant", "content": "Final Rust answer" },
                    "finish_reason": "stop"
                }]
            }),
            &request,
        )
        .expect("final response");
        assert_eq!(
            text_content(&final_response.message.content),
            "Final Rust answer"
        );

        let mut first_stream = OpenAiStreamState::default();
        let first_events = consume_openai_stream_value(
            &serde_json::json!({
                "choices": [{
                    "delta": { "tool_calls": [{
                        "index": 0,
                        "id": "call-stream-loop",
                        "function": {
                            "name": "web__search",
                            "arguments": "{\"query\":\"rust\"}"
                        }
                    }] },
                    "finish_reason": "tool_calls"
                }]
            }),
            &request,
            &mut first_stream,
        )
        .expect("tool stream");
        first_stream.saw_done = true;
        let first_terminal = finalize_openai_stream(&request, &first_stream).expect("terminal");
        assert!(first_events.iter().any(|event| matches!(
            event,
            ModelChatStreamEvent::ToolCallArgumentsDelta { delta, .. }
                if delta == "{\"query\":\"rust\"}"
        )));
        assert!(matches!(
            first_terminal.last(),
            Some(ModelChatStreamEvent::MessageEnd {
                finish_reason: ModelFinishReason::ToolCalls
            })
        ));

        let mut final_stream = OpenAiStreamState::default();
        let final_events = consume_openai_stream_value(
            &serde_json::json!({
                "choices": [{
                    "delta": { "content": "Final streamed answer" },
                    "finish_reason": "stop"
                }]
            }),
            &request,
            &mut final_stream,
        )
        .expect("final stream");
        final_stream.saw_done = true;
        let final_terminal = finalize_openai_stream(&request, &final_stream).expect("terminal");
        assert!(final_events.iter().any(|event| matches!(
            event,
            ModelChatStreamEvent::TextDelta { delta } if delta == "Final streamed answer"
        )));
        assert!(matches!(
            final_terminal.last(),
            Some(ModelChatStreamEvent::MessageEnd {
                finish_reason: ModelFinishReason::Stop
            })
        ));
    }

    #[test]
    fn rejects_openai_unknown_tool_and_invalid_arguments() {
        let unknown = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [{
                "id": "call-1", "function": { "name": "write__file", "arguments": "{}" }
            }] } }]
        });
        assert!(
            parse_openai_chat_response(&unknown, &request("openai-compatible"))
                .expect_err("unknown tool")
                .contains("unknown tool name")
        );

        let invalid = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [{
                "id": "call-1", "function": { "name": "web__search", "arguments": "[1]" }
            }] } }]
        });
        assert!(
            parse_openai_chat_response(&invalid, &request("openai-compatible"))
                .expect_err("invalid args")
                .contains("must be an object")
        );
    }

    #[test]
    fn anthropic_body_maps_tool_result_and_tool_use_fixture() {
        let mut request = request("anthropic");
        request.messages.push(ModelChatMessage::Assistant {
            content: vec![],
            tool_calls: vec![ModelToolCall {
                id: "toolu-1".to_string(),
                name: "web__search".to_string(),
                arguments: serde_json::from_value(serde_json::json!({ "query": "rust" })).unwrap(),
            }],
        });
        request.messages.push(ModelChatMessage::Tool {
            tool_call_id: "toolu-1".to_string(),
            name: "web__search".to_string(),
            content: vec![ModelContentBlock::Text {
                text: "result".to_string(),
            }],
            status: ModelToolStatus::Success,
        });
        let body = build_anthropic_chat_body("test-model", &request, false).expect("body");
        assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");

        let response = serde_json::json!({
            "content": [{
                "type": "tool_use", "id": "toolu-2", "name": "web__search",
                "input": { "query": "tauri" }
            }],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 8, "output_tokens": 3 }
        });
        let parsed = parse_anthropic_chat_response(&response, &request).expect("response");
        assert_eq!(parsed.message.tool_calls[0].id, "toolu-2");
        assert!(matches!(parsed.finish_reason, ModelFinishReason::ToolCalls));
    }

    #[test]
    fn anthropic_fixture_completes_non_stream_and_stream_tool_result_loops() {
        let mut request = request("anthropic");
        let first = parse_anthropic_chat_response(
            &serde_json::json!({
                "content": [{
                    "type": "tool_use",
                    "id": "toolu-loop",
                    "name": "web__search",
                    "input": { "query": "rust" }
                }],
                "stop_reason": "tool_use"
            }),
            &request,
        )
        .expect("first response");
        request.messages.push(ModelChatMessage::Assistant {
            content: first.message.content.clone(),
            tool_calls: first.message.tool_calls.clone(),
        });
        request.messages.push(ModelChatMessage::Tool {
            tool_call_id: "toolu-loop".to_string(),
            name: "web__search".to_string(),
            content: vec![ModelContentBlock::Text {
                text: "Rust result".to_string(),
            }],
            status: ModelToolStatus::Success,
        });
        let second_body = build_anthropic_chat_body("test-model", &request, false).expect("body");
        assert_eq!(second_body["messages"][1]["content"][0]["id"], "toolu-loop");
        assert_eq!(
            second_body["messages"][2]["content"][0]["tool_use_id"],
            "toolu-loop"
        );
        let final_response = parse_anthropic_chat_response(
            &serde_json::json!({
                "content": [{ "type": "text", "text": "Final Claude answer" }],
                "stop_reason": "end_turn"
            }),
            &request,
        )
        .expect("final response");
        assert_eq!(
            text_content(&final_response.message.content),
            "Final Claude answer"
        );

        let mut first_stream = AnthropicStreamState::default();
        let chunks = [
            serde_json::json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu-stream-loop",
                    "name": "web__search",
                    "input": {}
                }
            }),
            serde_json::json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": "{\"query\":\"rust\"}"
                }
            }),
            serde_json::json!({
                "type": "message_delta",
                "delta": { "stop_reason": "tool_use" }
            }),
            serde_json::json!({ "type": "message_stop" }),
        ];
        let mut first_events = Vec::new();
        for chunk in chunks {
            first_events.extend(
                consume_anthropic_stream_value(&chunk, &request, &mut first_stream)
                    .expect("tool stream"),
            );
        }
        let first_terminal = finalize_anthropic_stream(&request, &first_stream).expect("terminal");
        assert!(first_events.iter().any(|event| matches!(
            event,
            ModelChatStreamEvent::ToolCallArgumentsDelta { delta, .. }
                if delta == "{\"query\":\"rust\"}"
        )));
        assert!(matches!(
            first_terminal.last(),
            Some(ModelChatStreamEvent::MessageEnd {
                finish_reason: ModelFinishReason::ToolCalls
            })
        ));

        let mut final_stream = AnthropicStreamState::default();
        let final_chunks = [
            serde_json::json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "Final " }
            }),
            serde_json::json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "text_delta", "text": "streamed answer" }
            }),
            serde_json::json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn" }
            }),
            serde_json::json!({ "type": "message_stop" }),
        ];
        let mut final_events = Vec::new();
        for chunk in final_chunks {
            final_events.extend(
                consume_anthropic_stream_value(&chunk, &request, &mut final_stream)
                    .expect("final stream"),
            );
        }
        let final_terminal = finalize_anthropic_stream(&request, &final_stream).expect("terminal");
        assert!(final_events.iter().any(|event| matches!(
            event,
            ModelChatStreamEvent::TextDelta { delta } if delta == "streamed answer"
        )));
        assert!(matches!(
            final_terminal.last(),
            Some(ModelChatStreamEvent::MessageEnd {
                finish_reason: ModelFinishReason::Stop
            })
        ));
    }

    #[test]
    fn rejects_duplicate_tool_call_ids() {
        let response = serde_json::json!({
            "content": [
                { "type": "tool_use", "id": "dup", "name": "web__search", "input": {} },
                { "type": "tool_use", "id": "dup", "name": "web__search", "input": {} }
            ],
            "stop_reason": "tool_use"
        });
        assert!(
            parse_anthropic_chat_response(&response, &request("anthropic"))
                .expect_err("duplicate id")
                .contains("duplicate tool call id")
        );
    }

    #[test]
    fn rejects_openai_duplicate_tool_call_ids() {
        let response = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [
                {
                    "id": "dup",
                    "function": { "name": "web__search", "arguments": "{}" }
                },
                {
                    "id": "dup",
                    "function": { "name": "web__search", "arguments": "{}" }
                }
            ] } }]
        });
        assert!(
            parse_openai_chat_response(&response, &request("openai-compatible"))
                .expect_err("duplicate id")
                .contains("duplicate tool call id")
        );
    }

    #[test]
    fn validates_tool_result_call_id_name_binding_and_uniqueness() {
        let mut mismatched = request("openai-compatible");
        mismatched.tools.push(ModelToolDefinition {
            canonical_name: "web.fetch".to_string(),
            model_name: "web__fetch".to_string(),
            description: "Fetch a page".to_string(),
            input_schema: serde_json::json!({ "type": "object" }),
        });
        mismatched.messages.push(ModelChatMessage::Assistant {
            content: vec![],
            tool_calls: vec![ModelToolCall {
                id: "call-bound".to_string(),
                name: "web__search".to_string(),
                arguments: serde_json::Map::new(),
            }],
        });
        mismatched.messages.push(ModelChatMessage::Tool {
            tool_call_id: "call-bound".to_string(),
            name: "web__fetch".to_string(),
            content: vec![ModelContentBlock::Text {
                text: "result".to_string(),
            }],
            status: ModelToolStatus::Success,
        });
        assert!(validate_model_chat_request(&mismatched)
            .expect_err("mismatched tool name")
            .contains("must use tool web__search"));

        let mut duplicated = request("anthropic");
        duplicated.messages.push(ModelChatMessage::Assistant {
            content: vec![],
            tool_calls: vec![ModelToolCall {
                id: "toolu-bound".to_string(),
                name: "web__search".to_string(),
                arguments: serde_json::Map::new(),
            }],
        });
        for _ in 0..2 {
            duplicated.messages.push(ModelChatMessage::Tool {
                tool_call_id: "toolu-bound".to_string(),
                name: "web__search".to_string(),
                content: vec![ModelContentBlock::Text {
                    text: "result".to_string(),
                }],
                status: ModelToolStatus::Success,
            });
        }
        assert!(validate_model_chat_request(&duplicated)
            .expect_err("duplicate tool result")
            .contains("duplicate tool result"));
    }

    #[test]
    fn aggregates_interleaved_openai_tool_argument_deltas() {
        let request = request("openai-compatible");
        let mut state = OpenAiStreamState::default();
        let chunks = [
            serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{
                    "index": 0, "id": "call-a",
                    "function": { "name": "web__search", "arguments": "{\"query\":" }
                }] } }]
            }),
            serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{
                    "index": 1, "id": "call-b",
                    "function": { "name": "web__search", "arguments": "{\"query\":\"b\"}" }
                }] } }]
            }),
            serde_json::json!({
                "choices": [{
                    "delta": { "tool_calls": [{
                        "index": 0, "function": { "arguments": "\"a\"}" }
                    }] },
                    "finish_reason": "tool_calls"
                }]
            }),
        ];
        let mut events = Vec::new();
        for chunk in chunks {
            events
                .extend(consume_openai_stream_value(&chunk, &request, &mut state).expect("chunk"));
        }
        state.saw_done = true;
        let terminal = finalize_openai_stream(&request, &state).expect("terminal");

        assert_eq!(state.tool_calls[0].arguments, "{\"query\":\"a\"}");
        assert_eq!(state.tool_calls[1].arguments, "{\"query\":\"b\"}");
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, ModelChatStreamEvent::ToolCallStart { .. }))
                .count(),
            2
        );
        assert_eq!(
            terminal
                .iter()
                .filter(|event| matches!(event, ModelChatStreamEvent::ToolCallEnd { .. }))
                .count(),
            2
        );
        assert!(matches!(
            terminal.last(),
            Some(ModelChatStreamEvent::MessageEnd {
                finish_reason: ModelFinishReason::ToolCalls
            })
        ));
    }

    #[test]
    fn rejects_duplicate_tool_call_ids_after_stream_aggregation() {
        let request = request("openai-compatible");
        let mut state = OpenAiStreamState::default();
        consume_openai_stream_value(
            &serde_json::json!({
                "choices": [{
                    "delta": { "tool_calls": [
                        {
                            "index": 0,
                            "id": "call-dup",
                            "function": { "name": "web__search", "arguments": "{}" }
                        },
                        {
                            "index": 1,
                            "id": "call-dup",
                            "function": { "name": "web__search", "arguments": "{}" }
                        }
                    ] },
                    "finish_reason": "tool_calls"
                }]
            }),
            &request,
            &mut state,
        )
        .expect("stream chunk");
        state.saw_done = true;
        assert!(finalize_openai_stream(&request, &state)
            .expect_err("duplicate stream call id")
            .contains("duplicate tool call id"));
    }

    #[test]
    fn replays_openai_arguments_buffered_before_tool_identity() {
        let request = request("openai-compatible");
        let mut state = OpenAiStreamState::default();
        let prefix_events = consume_openai_stream_value(
            &serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{
                    "index": 0,
                    "function": { "arguments": "{\"query\":" }
                }] } }]
            }),
            &request,
            &mut state,
        )
        .expect("arguments prefix");
        assert!(prefix_events.is_empty());

        let identity_events = consume_openai_stream_value(
            &serde_json::json!({
                "choices": [{ "delta": { "tool_calls": [{
                    "index": 0,
                    "id": "call-late-id",
                    "function": {
                        "name": "web__search",
                        "arguments": "\"rust\"}"
                    }
                }] } }]
            }),
            &request,
            &mut state,
        )
        .expect("late identity");

        assert_eq!(state.tool_calls[0].arguments, "{\"query\":\"rust\"}");
        assert!(matches!(
            identity_events.as_slice(),
            [
                ModelChatStreamEvent::ToolCallStart { .. },
                ModelChatStreamEvent::ToolCallArgumentsDelta { delta: prefix, .. },
                ModelChatStreamEvent::ToolCallArgumentsDelta { delta: suffix, .. }
            ] if prefix == "{\"query\":" && suffix == "\"rust\"}"
        ));
    }

    #[test]
    fn rejects_truncated_stream_arguments_before_message_end() {
        let request = request("openai-compatible");
        let mut state = OpenAiStreamState::default();
        consume_openai_stream_value(
            &serde_json::json!({
                "choices": [{
                    "delta": { "tool_calls": [{
                        "index": 0, "id": "call-a",
                        "function": { "name": "web__search", "arguments": "{\"query\":" }
                    }] },
                    "finish_reason": "tool_calls"
                }]
            }),
            &request,
            &mut state,
        )
        .expect("chunk");
        state.saw_done = true;
        assert!(finalize_openai_stream(&request, &state)
            .expect_err("truncated arguments")
            .contains("truncated or invalid arguments JSON"));
    }

    #[test]
    fn maps_anthropic_input_json_delta_to_the_shared_stream_contract() {
        let request = request("anthropic");
        let mut state = AnthropicStreamState::default();
        let chunks = [
            serde_json::json!({
                "type": "message_start",
                "message": { "usage": { "input_tokens": 7 } }
            }),
            serde_json::json!({
                "type": "content_block_start", "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu-a", "name": "web__search", "input": {} }
            }),
            serde_json::json!({
                "type": "content_block_delta", "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{\"query\":\"rust\"}" }
            }),
            serde_json::json!({
                "type": "message_delta",
                "delta": { "stop_reason": "tool_use" },
                "usage": { "output_tokens": 3 }
            }),
            serde_json::json!({ "type": "message_stop" }),
        ];
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(
                consume_anthropic_stream_value(&chunk, &request, &mut state).expect("chunk"),
            );
        }
        let terminal = finalize_anthropic_stream(&request, &state).expect("terminal");
        assert_eq!(state.tool_calls[0].arguments, "{\"query\":\"rust\"}");
        assert!(events.iter().any(|event| matches!(
            event,
            ModelChatStreamEvent::Usage { usage }
                if usage.input_tokens == 7 && usage.output_tokens == 3
        )));
        assert!(matches!(
            terminal.last(),
            Some(ModelChatStreamEvent::MessageEnd {
                finish_reason: ModelFinishReason::ToolCalls
            })
        ));
    }

    #[test]
    fn redacts_anthropic_stream_error_payloads() {
        let request = request("anthropic");
        let mut state = AnthropicStreamState::default();
        let error = consume_anthropic_stream_value(
            &serde_json::json!({
                "type": "error",
                "error": { "message": "provider secret sk-live-secret" }
            }),
            &request,
            &mut state,
        )
        .expect_err("stream error");
        assert_eq!(error, "Anthropic model chat stream returned an error.");
        assert!(!error.contains("sk-live-secret"));
    }

    #[test]
    fn redacts_openai_stream_error_payloads() {
        let request = request("openai-compatible");
        let mut state = OpenAiStreamState::default();
        let error = consume_openai_stream_value(
            &serde_json::json!({
                "error": { "message": "provider secret sk-live-secret" }
            }),
            &request,
            &mut state,
        )
        .expect_err("stream error");
        assert_eq!(error, "Model chat stream returned an error.");
        assert!(!error.contains("sk-live-secret"));
    }

    #[test]
    fn invalid_stream_json_does_not_echo_sensitive_payloads() {
        let error = parse_stream_json("{\"apiKey\":\"sk-live-secret\"", "Model chat stream")
            .expect_err("invalid JSON");
        assert!(error.contains("returned invalid JSON"));
        assert!(!error.contains("sk-live-secret"));
        assert!(!error.contains("apiKey"));
    }

    #[test]
    fn rejects_finish_reasons_that_conflict_with_tool_call_structure() {
        let openai_without_calls = serde_json::json!({
            "choices": [{
                "message": { "content": "done" },
                "finish_reason": "tool_calls"
            }]
        });
        assert!(
            parse_openai_chat_response(&openai_without_calls, &request("openai-compatible"),)
                .expect_err("OpenAI missing calls")
                .contains("without tool calls")
        );

        let anthropic_with_conflict = serde_json::json!({
            "content": [{
                "type": "tool_use",
                "id": "toolu-conflict",
                "name": "web__search",
                "input": {}
            }],
            "stop_reason": "end_turn"
        });
        assert!(
            parse_anthropic_chat_response(&anthropic_with_conflict, &request("anthropic"),)
                .expect_err("Anthropic conflicting finish reason")
                .contains("contains tool calls")
        );

        let mut stream = OpenAiStreamState {
            saw_done: true,
            finish_reason: Some("tool_calls".to_string()),
            ..OpenAiStreamState::default()
        };
        assert!(
            finalize_openai_stream(&request("openai-compatible"), &stream)
                .expect_err("stream missing calls")
                .contains("without tool calls")
        );
        stream.finish_reason = Some("stop".to_string());
        let empty_error = finalize_openai_stream(&request("openai-compatible"), &stream)
            .expect_err("empty stream must fail as empty response");
        assert!(
            empty_error.starts_with("__JAVIS_EMPTY_RESPONSE__"),
            "unexpected empty-stream error: {empty_error}"
        );
    }

    #[test]
    fn rejects_anthropic_unknown_tools_and_non_object_input() {
        let unknown = serde_json::json!({
            "content": [{
                "type": "tool_use",
                "id": "toolu-unknown",
                "name": "write__file",
                "input": {}
            }],
            "stop_reason": "tool_use"
        });
        assert!(
            parse_anthropic_chat_response(&unknown, &request("anthropic"))
                .expect_err("unknown tool")
                .contains("unknown tool name")
        );

        let invalid = serde_json::json!({
            "content": [{
                "type": "tool_use",
                "id": "toolu-invalid",
                "name": "web__search",
                "input": ["not", "an", "object"]
            }],
            "stop_reason": "tool_use"
        });
        assert!(
            parse_anthropic_chat_response(&invalid, &request("anthropic"))
                .expect_err("invalid input")
                .contains("input must be an object")
        );
    }

    #[test]
    fn serializes_non_stream_usage_with_backend_neutral_field_names() {
        let value = serde_json::to_value(ModelChatResponse {
            message: ModelAssistantMessage {
                role: "assistant",
                content: vec![ModelContentBlock::Text {
                    text: "done".to_string(),
                }],
                tool_calls: vec![],
            },
            finish_reason: ModelFinishReason::Stop,
            token_usage: Some(ModelUsage {
                input_tokens: 7,
                output_tokens: 3,
                total_tokens: 10,
            }),
        })
        .expect("serialize");
        assert_eq!(value["usage"]["inputTokens"], 7);
        assert_eq!(value["usage"]["totalTokens"], 10);
        assert!(value.get("tokenUsage").is_none());
    }

    #[test]
    fn serializes_stream_events_with_backend_neutral_field_names() {
        let value = serde_json::to_value(ModelChatStreamEvent::MessageEnd {
            finish_reason: ModelFinishReason::ToolCalls,
        })
        .expect("serialize");
        assert_eq!(value["type"], "message_end");
        assert_eq!(value["finishReason"], "tool_calls");
    }
}
