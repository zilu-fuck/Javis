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

use crate::{
    create_openai_compatible_stream_body,
    extract_openai_compatible_usage,
    default_openai_compatible_base_url_for_provider,
    extract_openai_compatible_stream_text,
    hydrate_model_completion_api_key_secret,
    infer_model_completion_provider_id,
    normalize_model_completion_model_name,
    ModelCompletionRequest,
    ModelUsage,
};
use crate::code::{create_chat_completions_endpoint, normalize_optional_config_value};

const STREAMING_READ_TIMEOUT: Duration = Duration::from_secs(120);

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
    hydrate_model_completion_api_key_secret(&app_handle, &mut request)?;
    let stream_id = stream_id.unwrap_or_else(|| {
        format!("stream-{}", NEXT_STREAM_ID.fetch_add(1, Ordering::Relaxed))
    });
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
                        finish_reason: Some("stop".into()),
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
        return crate::anthropic::execute_anthropic_streaming_request(request, app, stream_id, cancelled);
    }

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

    let client = reqwest::blocking::Client::builder()
        .timeout(STREAMING_READ_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(&endpoint)
        .header("Authorization", &format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .body(body_text)
        .send()
        .map_err(|error| format!("Model stream request failed: {error}"))?;
    let buf_reader = BufReader::new(response);
    let mut total_chunks: u32 = 0;
    let mut token_usage: Option<ModelUsage> = None;

    for line in buf_reader.lines() {
        if cancelled.load(Ordering::Relaxed) {
            // Drain remaining data before returning
            break;
        }
        let line = line.map_err(|error| format!("Stream read error: {error}"))?;
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }
        let data = trimmed.trim_start_matches("data:").trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let value = serde_json::from_str::<serde_json::Value>(data).map_err(|error| {
            format!("Model stream returned invalid JSON chunk: {error}")
        })?;
        if let Some(usage) = extract_openai_compatible_usage(&value) {
            token_usage = Some(usage);
        }
        if let Some(text) = extract_openai_compatible_stream_text(&value) {
            let _ = app.emit(
                "stream-model-chunk",
                StreamChunkPayload {
                    stream_id: stream_id.to_string(),
                    text,
                    model: Some(model.clone()),
                    provider: Some(provider_id.clone()),
                    index: total_chunks,
                },
            );
            total_chunks += 1;
        }
    }

    if total_chunks == 0 && !cancelled.load(Ordering::Relaxed) {
        return Err("Model stream returned no content chunks.".to_string());
    }

    Ok(StreamingRequestResult {
        total_chunks,
        token_usage,
    })
}

pub(crate) struct StreamingRequestResult {
    pub total_chunks: u32,
    pub token_usage: Option<ModelUsage>,
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
