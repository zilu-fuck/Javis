use std::{
    io::{BufRead, BufReader},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::code::{create_chat_completions_endpoint, normalize_optional_config_value};
use crate::{
    classify_http_status_error, create_fnv1a_hash, create_openai_compatible_stream_body,
    default_openai_compatible_base_url_for_provider, extract_openai_compatible_finish_reason,
    extract_openai_compatible_stream_text, extract_openai_compatible_usage,
    hydrate_model_completion_api_key_secret, infer_model_completion_provider_id,
    normalize_model_completion_model_name, openai_compatible_request_requires_api_key,
    validate_model_completion_request, ModelCompletionRequest, ModelUsage,
};

const STREAMING_READ_TIMEOUT: Duration = Duration::from_secs(120);
/// Minimum characters to accumulate before emitting a chunk event.
/// Emitting on every token (~1-3 chars) floods the IPC channel;
/// batching reduces Tauri events by ~5x while keeping the UI responsive.
const STREAMING_CHUNK_CHAR_THRESHOLD: usize = 20;
/// Fallback: emit after this many raw SSE chunks even if char threshold
/// isn't met (handles short tokens like punctuation or whitespace).
const STREAMING_CHUNK_COUNT_THRESHOLD: u32 = 5;

fn effective_streaming_timeout(request: &ModelCompletionRequest) -> Duration {
    request
        .timeout_ms
        .filter(|&ms| ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(STREAMING_READ_TIMEOUT)
}

static NEXT_STREAM_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunkPayload {
    pub stream_id: String,
    pub text: String,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub index: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDonePayload {
    pub stream_id: String,
    pub finish_reason: Option<String>,
    pub total_chunks: u32,
    pub token_usage: Option<ModelUsage>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamErrorPayload {
    pub stream_id: String,
    pub error: String,
}

struct ActiveStream {
    stream_id: String,
    cancelled: Arc<AtomicBool>,
}

static ACTIVE_STREAMS: Mutex<Vec<ActiveStream>> = Mutex::new(Vec::new());

fn register_stream(stream_id: &str) -> Arc<AtomicBool> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut streams = ACTIVE_STREAMS.lock().unwrap();
    streams.retain(|s| !s.cancelled.load(Ordering::Relaxed));
    streams.push(ActiveStream {
        stream_id: stream_id.to_string(),
        cancelled: cancelled.clone(),
    });
    cancelled
}

#[allow(dead_code)]
fn cancel_all_streams() {
    let streams = ACTIVE_STREAMS.lock().unwrap();
    for s in streams.iter() {
        s.cancelled.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn stream_model_prompt_cancel(stream_id: String) -> Result<(), String> {
    let mut streams = ACTIVE_STREAMS.lock().unwrap();
    let mut found = false;
    for s in streams.iter() {
        if s.stream_id == stream_id {
            s.cancelled.store(true, Ordering::Relaxed);
            found = true;
        }
    }
    streams.retain(|s| !s.cancelled.load(Ordering::Relaxed));
    if !found && !stream_id.is_empty() {
        return Err(format!("No active stream found for id: {stream_id}"));
    }
    Ok(())
}

#[tauri::command]
pub fn stream_model_prompt_start(
    app_handle: AppHandle,
    mut request: ModelCompletionRequest,
    stream_id: Option<String>,
) -> Result<String, String> {
    validate_model_completion_request(&request)?;
    hydrate_model_completion_api_key_secret(&app_handle, &mut request)?;
    let stream_id = stream_id
        .unwrap_or_else(|| format!("stream-{}", NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed)));
    let stream_id_clone = stream_id.clone();
    let app = app_handle.clone();
    let cancelled = register_stream(&stream_id);

    thread::spawn(move || {
        let result = execute_streaming_request(&request, &app, &stream_id_clone, &cancelled);
        // Remove stream from active set regardless of outcome
        {
            let mut streams = ACTIVE_STREAMS.lock().unwrap();
            streams.retain(|s| s.stream_id != stream_id_clone);
        }
        match result {
            Ok(result) => {
                let _ = app.emit(
                    "stream-model-done",
                    StreamDonePayload {
                        stream_id: stream_id_clone,
                        finish_reason: result.finish_reason,
                        total_chunks: result.total_chunks,
                        token_usage: result.token_usage,
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "stream-model-error",
                    StreamErrorPayload {
                        stream_id: stream_id_clone,
                        error: e,
                    },
                );
            }
        }
    });

    Ok(stream_id)
}

#[tauri::command]
pub async fn stream_model_prompt_l1_start(
    app_handle: AppHandle,
    mut request: ModelCompletionRequest,
    stream_id: Option<String>,
) -> Result<String, String> {
    validate_model_completion_request(&request)?;
    hydrate_model_completion_api_key_secret(&app_handle, &mut request)?;
    let stream_id = stream_id
        .unwrap_or_else(|| format!("stream-{}", NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed)));
    let stream_id_clone = stream_id.clone();
    let app = app_handle.clone();
    let cancelled = register_stream(&stream_id);

    tauri::async_runtime::spawn(async move {
        let protocol = request
            .protocol
            .as_deref()
            .unwrap_or("openai-compatible")
            .to_string();
        let result = if protocol == "anthropic" {
            let request = request;
            let app = app.clone();
            let stream_id = stream_id_clone.clone();
            let cancelled = cancelled.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::anthropic::execute_anthropic_streaming_request(
                    &request, &app, &stream_id, &cancelled,
                )
            })
            .await
            .map_err(|error| format!("Anthropic stream task failed: {error}"))
            .and_then(|result| result)
        } else {
            execute_streaming_request_async(&request, &app, &stream_id_clone, &cancelled).await
        };

        {
            let mut streams = ACTIVE_STREAMS.lock().unwrap();
            streams.retain(|s| s.stream_id != stream_id_clone);
        }
        match result {
            Ok(result) => {
                let _ = app.emit(
                    "stream-model-done",
                    StreamDonePayload {
                        stream_id: stream_id_clone,
                        finish_reason: result.finish_reason,
                        total_chunks: result.total_chunks,
                        token_usage: result.token_usage,
                    },
                );
            }
            Err(e) => {
                let _ = app.emit(
                    "stream-model-error",
                    StreamErrorPayload {
                        stream_id: stream_id_clone,
                        error: e,
                    },
                );
            }
        }
    });

    Ok(stream_id)
}

fn execute_streaming_request(
    request: &ModelCompletionRequest,
    app: &AppHandle,
    stream_id: &str,
    cancelled: &AtomicBool,
) -> Result<StreamingRequestResult, String> {
    let protocol = request.protocol.as_deref().unwrap_or("openai-compatible");
    if protocol == "anthropic" {
        return crate::anthropic::execute_anthropic_streaming_request(
            request, app, stream_id, cancelled,
        );
    }

    let model = normalize_model_completion_model_name(request)
        .ok_or_else(|| "Model stream requires a model.".to_string())?;
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_model_completion_provider_id(request));
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_openai_compatible_base_url_for_provider(&provider_id));
    let api_key = normalize_optional_config_value(request.api_key.as_deref());
    if api_key.is_none() && openai_compatible_request_requires_api_key(&provider_id, &base_url) {
        return Err("Model stream requires an API key.".to_string());
    }
    let endpoint = create_chat_completions_endpoint(&base_url);
    let body = create_openai_compatible_stream_body(&model, request);
    let body_text = serde_json::to_string(&body).map_err(|error| error.to_string())?;

    let client = reqwest::blocking::Client::builder()
        .timeout(effective_streaming_timeout(request))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request_builder = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .body(body_text);
    if let Some(api_key) = api_key {
        request_builder = request_builder.header("Authorization", &format!("Bearer {api_key}"));
    }
    let response = request_builder
        .send()
        .map_err(|error| format!("Model stream request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let response_text = response
            .text()
            .map_err(|error| format!("Model stream could not read error response: {error}"))?;
        return Err(
            classify_http_status_error(status, &response_text, &provider_id)
                .unwrap_or_else(|| format!("Model stream returned HTTP {}.", status.as_u16())),
        );
    }
    let buf_reader = BufReader::with_capacity(65536, response);
    let mut total_chunks: u32 = 0;
    let mut token_usage: Option<ModelUsage> = None;
    let mut finish_reason: Option<String> = None;
    let mut saw_done_marker = false;

    // Batch accumulator: reduces IPC events by emitting fewer, larger chunks
    // instead of one Tauri event per token.
    let mut batch_text = String::with_capacity(64);
    let mut batch_chunks: u32 = 0;

    for line in buf_reader.lines() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let line = line.map_err(|error| format!("Stream read error: {error}"))?;
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }
        let data = trimmed.trim_start_matches("data:").trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            saw_done_marker = true;
            break;
        }
        let value = serde_json::from_str::<serde_json::Value>(data)
            .map_err(|error| format!("Model stream returned invalid JSON chunk: {error}"))?;
        if let Some(error) = extract_provider_stream_error(&value, &provider_id) {
            return Err(error);
        }
        if let Some(usage) = extract_openai_compatible_usage(&value) {
            token_usage = Some(usage);
        }
        if let Some(reason) = extract_openai_compatible_finish_reason(&value) {
            finish_reason = Some(reason);
        }
        if let Some(text) = extract_openai_compatible_stream_text(&value) {
            batch_text.push_str(&text);
            batch_chunks += 1;
            total_chunks += 1;

            if batch_text.len() >= STREAMING_CHUNK_CHAR_THRESHOLD
                || batch_chunks >= STREAMING_CHUNK_COUNT_THRESHOLD
            {
                let _ = app.emit(
                    "stream-model-chunk",
                    StreamChunkPayload {
                        stream_id: stream_id.to_string(),
                        text: std::mem::take(&mut batch_text),
                        model: Some(model.clone()),
                        provider: Some(provider_id.clone()),
                        index: total_chunks,
                    },
                );
                batch_chunks = 0;
            }
        }
    }

    // Flush any remaining batched text
    if !batch_text.is_empty() {
        let _ = app.emit(
            "stream-model-chunk",
            StreamChunkPayload {
                stream_id: stream_id.to_string(),
                text: batch_text,
                model: Some(model.clone()),
                provider: Some(provider_id.clone()),
                index: total_chunks,
            },
        );
    }

    validate_openai_stream_completion(
        total_chunks,
        cancelled.load(Ordering::Relaxed),
        saw_done_marker,
        finish_reason.as_deref(),
    )?;

    Ok(StreamingRequestResult {
        total_chunks,
        token_usage,
        finish_reason: if cancelled.load(Ordering::Relaxed) {
            Some("cancelled".to_string())
        } else {
            finish_reason
        },
    })
}

async fn execute_streaming_request_async(
    request: &ModelCompletionRequest,
    app: &AppHandle,
    stream_id: &str,
    cancelled: &AtomicBool,
) -> Result<StreamingRequestResult, String> {
    let model = normalize_model_completion_model_name(request)
        .ok_or_else(|| "Model stream requires a model.".to_string())?;
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_model_completion_provider_id(request));
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_openai_compatible_base_url_for_provider(&provider_id));
    let api_key = normalize_optional_config_value(request.api_key.as_deref());
    if api_key.is_none() && openai_compatible_request_requires_api_key(&provider_id, &base_url) {
        return Err("Model stream requires an API key.".to_string());
    }
    let endpoint = create_chat_completions_endpoint(&base_url);
    let body = create_openai_compatible_stream_body(&model, request);

    let client = reqwest::Client::builder()
        .timeout(effective_streaming_timeout(request))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request_builder = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .json(&body);
    if let Some(api_key) = api_key {
        request_builder = request_builder.header("Authorization", &format!("Bearer {api_key}"));
    }
    let mut response = request_builder
        .send()
        .await
        .map_err(|error| format!("Model stream request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let response_text = response
            .text()
            .await
            .map_err(|error| format!("Model stream could not read error response: {error}"))?;
        return Err(
            classify_http_status_error(status, &response_text, &provider_id)
                .unwrap_or_else(|| format!("Model stream returned HTTP {}.", status.as_u16())),
        );
    }

    let mut total_chunks: u32 = 0;
    let mut token_usage: Option<ModelUsage> = None;
    let mut finish_reason: Option<String> = None;
    let mut saw_done_marker = false;
    let mut batch_text = String::with_capacity(64);
    let mut batch_chunks: u32 = 0;
    let mut pending: Vec<u8> = Vec::new();

    'stream: while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Stream read error: {error}"))?
    {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        pending.extend_from_slice(&chunk);
        while let Some(newline_index) = pending.iter().position(|byte| *byte == b'\n') {
            let line_bytes = pending.drain(..=newline_index).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line_bytes[..line_bytes.len() - 1])
                .map_err(|error| format!("Model stream returned invalid UTF-8: {error}"))?
                .trim_end_matches('\r')
                .trim()
                .to_string();
            consume_stream_line(
                &line,
                app,
                stream_id,
                &model,
                &provider_id,
                &mut total_chunks,
                &mut token_usage,
                &mut finish_reason,
                &mut saw_done_marker,
                &mut batch_text,
                &mut batch_chunks,
            )?;
            if saw_done_marker {
                break 'stream;
            }
        }
    }

    let trailing = std::str::from_utf8(&pending)
        .map_err(|error| format!("Model stream returned invalid UTF-8: {error}"))?
        .trim()
        .to_string();
    if !saw_done_marker && !trailing.is_empty() {
        consume_stream_line(
            &trailing,
            app,
            stream_id,
            &model,
            &provider_id,
            &mut total_chunks,
            &mut token_usage,
            &mut finish_reason,
            &mut saw_done_marker,
            &mut batch_text,
            &mut batch_chunks,
        )?;
    }

    if !batch_text.is_empty() {
        let _ = app.emit(
            "stream-model-chunk",
            StreamChunkPayload {
                stream_id: stream_id.to_string(),
                text: batch_text,
                model: Some(model.clone()),
                provider: Some(provider_id.clone()),
                index: total_chunks,
            },
        );
    }

    validate_openai_stream_completion(
        total_chunks,
        cancelled.load(Ordering::Relaxed),
        saw_done_marker,
        finish_reason.as_deref(),
    )?;

    Ok(StreamingRequestResult {
        total_chunks,
        token_usage,
        finish_reason: if cancelled.load(Ordering::Relaxed) {
            Some("cancelled".to_string())
        } else {
            finish_reason
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn consume_stream_line(
    line: &str,
    app: &AppHandle,
    stream_id: &str,
    model: &str,
    provider_id: &str,
    total_chunks: &mut u32,
    token_usage: &mut Option<ModelUsage>,
    finish_reason: &mut Option<String>,
    saw_done_marker: &mut bool,
    batch_text: &mut String,
    batch_chunks: &mut u32,
) -> Result<(), String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("data:") {
        return Ok(());
    }
    let data = trimmed.trim_start_matches("data:").trim();
    if data.is_empty() {
        return Ok(());
    }
    if data == "[DONE]" {
        *saw_done_marker = true;
        return Ok(());
    }
    let value = serde_json::from_str::<serde_json::Value>(data)
        .map_err(|error| format!("Model stream returned invalid JSON chunk: {error}"))?;
    if let Some(error) = extract_provider_stream_error(&value, provider_id) {
        return Err(error);
    }
    if let Some(usage) = extract_openai_compatible_usage(&value) {
        *token_usage = Some(usage);
    }
    if let Some(reason) = extract_openai_compatible_finish_reason(&value) {
        *finish_reason = Some(reason);
    }
    if let Some(text) = extract_openai_compatible_stream_text(&value) {
        batch_text.push_str(&text);
        *batch_chunks += 1;
        *total_chunks += 1;

        if batch_text.len() >= STREAMING_CHUNK_CHAR_THRESHOLD
            || *batch_chunks >= STREAMING_CHUNK_COUNT_THRESHOLD
        {
            let _ = app.emit(
                "stream-model-chunk",
                StreamChunkPayload {
                    stream_id: stream_id.to_string(),
                    text: std::mem::take(batch_text),
                    model: Some(model.to_string()),
                    provider: Some(provider_id.to_string()),
                    index: *total_chunks,
                },
            );
            *batch_chunks = 0;
        }
    }
    Ok(())
}

fn validate_openai_stream_completion(
    total_chunks: u32,
    cancelled: bool,
    saw_done_marker: bool,
    finish_reason: Option<&str>,
) -> Result<(), String> {
    if cancelled {
        return Ok(());
    }
    if total_chunks == 0 {
        return Err("Model stream returned no content chunks.".to_string());
    }
    let has_finish_reason = finish_reason.is_some_and(|reason| !reason.trim().is_empty());
    if !saw_done_marker && !has_finish_reason {
        return Err(
            "Model stream ended before a terminal [DONE] marker or finish_reason was received."
                .to_string(),
        );
    }
    Ok(())
}

fn extract_provider_stream_error(value: &serde_json::Value, provider_id: &str) -> Option<String> {
    let error = value.get("error")?;
    // Provider error payloads may echo prompts, reasoning, or credentials. Keep
    // the diagnostic useful without returning any provider-controlled text.
    let fingerprint_input = error.to_string();
    let fingerprint = fingerprint_input.chars().take(4096).collect::<String>();
    Some(format!(
        "Model stream provider error (provider={provider_id}; event=error; bodyHash={}).",
        create_fnv1a_hash(fingerprint.as_bytes()),
    ))
}

pub(crate) struct StreamingRequestResult {
    pub total_chunks: u32,
    pub token_usage: Option<ModelUsage>,
    pub finish_reason: Option<String>,
}

/// Cancel all active streams — called during app shutdown or task disposal.
#[tauri::command]
pub fn cancel_all_model_streams() {
    cancel_all_streams();
}

#[allow(dead_code)]
pub fn cancel_all_active_streams() {
    cancel_all_streams();
}

#[cfg(test)]
mod tests {
    use super::{extract_provider_stream_error, validate_openai_stream_completion};

    #[test]
    fn provider_stream_errors_do_not_echo_provider_text() {
        let value = serde_json::json!({
            "error": {
                "message": "private reasoning and sk-stream-secret",
            },
        });
        let error = extract_provider_stream_error(&value, "deepseek").expect("provider error");

        assert!(error.contains("provider=deepseek"));
        assert!(error.contains("event=error"));
        assert!(error.contains("bodyHash=fnv1a-"));
        assert!(!error.contains("private reasoning"));
        assert!(!error.contains("sk-stream-secret"));
    }

    #[test]
    fn rejects_eof_without_openai_terminal_signal() {
        let error = validate_openai_stream_completion(1, false, false, None)
            .expect_err("unterminated stream should fail");
        assert!(error.contains("terminal [DONE] marker or finish_reason"));
    }

    #[test]
    fn accepts_openai_done_marker_or_finish_reason() {
        assert!(validate_openai_stream_completion(1, false, true, None).is_ok());
        assert!(validate_openai_stream_completion(1, false, false, Some("length")).is_ok());
    }

    #[test]
    fn accepts_cancelled_openai_stream_without_terminal_signal() {
        assert!(validate_openai_stream_completion(0, true, false, None).is_ok());
    }
}
