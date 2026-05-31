use std::{
    io::{BufRead, BufReader},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{AppHandle, Emitter};

use crate::{
    infer_model_completion_provider_id,
    normalize_model_completion_model_name,
    ModelCompletionRequest,
    ModelCompletionResponse,
    ModelUsage,
    streaming::{StreamChunkPayload, StreamingRequestResult},
};
use crate::code::normalize_optional_config_value;

const ANTHROPIC_TIMEOUT: Duration = Duration::from_secs(90);
const ANTHROPIC_STREAMING_TIMEOUT: Duration = Duration::from_secs(120);
const ANTHROPIC_API_VERSION: &str = "2023-06-01";

fn anthropic_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/messages") {
        return trimmed.to_string();
    }
    if trimmed == "https://api.deepseek.com" {
        return format!("{trimmed}/anthropic/messages");
    }
    format!("{trimmed}/messages")
}

fn default_anthropic_base_url(provider_id: &str) -> String {
    match provider_id {
        "anthropic" => "https://api.anthropic.com/v1".to_string(),
        "deepseek" | "deepseek-anthropic" => "https://api.deepseek.com/anthropic".to_string(),
        _ => "https://api.anthropic.com/v1".to_string(),
    }
}

fn build_anthropic_headers(api_key: &str, provider_id: &str) -> Vec<(String, String)> {
    let mut headers = vec![
        ("x-api-key".to_string(), api_key.to_string()),
        ("anthropic-version".to_string(), ANTHROPIC_API_VERSION.to_string()),
        ("content-type".to_string(), "application/json".to_string()),
    ];
    if provider_id == "deepseek" || provider_id == "deepseek-anthropic" {
        headers.push(("Authorization".to_string(), format!("Bearer {api_key}")));
    }
    headers
}

fn build_anthropic_completion_body(model: &str, request: &ModelCompletionRequest) -> Result<serde_json::Value, String> {
    let max_tokens = request.max_tokens.unwrap_or(2048);
    let content = build_anthropic_message_content(request)?;
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": content
            }
        ],
        "stream": false,
    });
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    if let Some(ref stop_sequences) = request.stop_sequences {
        if !stop_sequences.is_empty() {
            body["stop_sequences"] = serde_json::json!(stop_sequences);
        }
    }
    Ok(body)
}

fn build_anthropic_stream_body(model: &str, request: &ModelCompletionRequest) -> Result<serde_json::Value, String> {
    let max_tokens = request.max_tokens.unwrap_or(2048);
    let content = build_anthropic_message_content(request)?;
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": content
            }
        ],
        "stream": true,
    });
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    if let Some(ref stop_sequences) = request.stop_sequences {
        if !stop_sequences.is_empty() {
            body["stop_sequences"] = serde_json::json!(stop_sequences);
        }
    }
    Ok(body)
}

fn build_anthropic_message_content(request: &ModelCompletionRequest) -> Result<serde_json::Value, String> {
    let images = crate::build_image_list(request);
    if images.is_empty() {
        return Ok(serde_json::Value::String(request.prompt.clone()));
    }
    let mut content: Vec<serde_json::Value> = vec![
        serde_json::json!({ "type": "text", "text": request.prompt }),
    ];
    for image_data_url in &images {
        let (media_type, data) = parse_data_url(image_data_url)?;
        content.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": data
            }
        }));
    }
    Ok(serde_json::json!(content))
}

fn parse_data_url(value: &str) -> Result<(String, String), String> {
    let rest = value
        .strip_prefix("data:")
        .ok_or_else(|| "Image data URL must start with data:.".to_string())?;
    let (metadata, data) = rest
        .split_once(',')
        .ok_or_else(|| "Image data URL must include a base64 payload.".to_string())?;
    let media_type = metadata
        .strip_suffix(";base64")
        .ok_or_else(|| "Image data URL must use base64 encoding.".to_string())?;
    let normalized_media_type = match media_type.to_ascii_lowercase().as_str() {
        "image/png" => "image/png",
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/webp" => "image/webp",
        "image/gif" => "image/gif",
        "image/bmp" => "image/bmp",
        "image/tiff" | "image/tif" => "image/tiff",
        _ => return Err("Unsupported image data URL format. Use PNG, JPEG, WebP, GIF, BMP, or TIFF.".to_string()),
    };
    if data.is_empty() || STANDARD.decode(data).is_err() {
        return Err("Image data URL must contain a valid non-empty base64 payload.".to_string());
    }
    Ok((normalized_media_type.to_string(), data.to_string()))
}

fn extract_anthropic_usage(value: &serde_json::Value) -> Option<ModelUsage> {
    let usage = value.get("usage")?;
    let input_tokens = usage.get("input_tokens")?.as_u64()? as u32;
    let output_tokens = usage.get("output_tokens")?.as_u64()? as u32;
    Some(ModelUsage {
        input_tokens,
        output_tokens,
        total_tokens: input_tokens + output_tokens,
    })
}

fn extract_anthropic_response_text(value: &serde_json::Value) -> Option<String> {
    let content = value.get("content")?.as_array()?;
    for block in content {
        if block.get("type")?.as_str()? == "text" {
            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

pub(crate) fn run_anthropic_completion_request(
    request: &ModelCompletionRequest,
) -> Result<ModelCompletionResponse, String> {
    let api_key = normalize_optional_config_value(request.api_key.as_deref())
        .ok_or_else(|| "Anthropic completion requires an API key.".to_string())?;
    let model = normalize_model_completion_model_name(request)
        .ok_or_else(|| "Anthropic completion requires a model.".to_string())?;
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_model_completion_provider_id(request));
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_anthropic_base_url(&provider_id));
    let endpoint = anthropic_endpoint(&base_url);
    let body = build_anthropic_completion_body(&model, request)?;
    let body_text = serde_json::to_string(&body).map_err(|error| error.to_string())?;

    let client = reqwest::blocking::Client::builder()
        .timeout(ANTHROPIC_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;

    let mut req_builder = client.post(&endpoint);
    for (key, value) in build_anthropic_headers(&api_key, &provider_id) {
        req_builder = req_builder.header(&key, &value);
    }

    let response_text = req_builder
        .body(body_text)
        .send()
        .map_err(|error| format!("Anthropic completion request failed: {error}"))?
        .text()
        .map_err(|error| format!("Anthropic completion could not read response: {error}"))?;

    let value = serde_json::from_str::<serde_json::Value>(&response_text).map_err(|error| {
        format!("Anthropic completion returned invalid JSON: {error}; response: {}", truncate(&response_text, 500))
    })?;

    let text = extract_anthropic_response_text(&value)
        .ok_or_else(|| format!("Anthropic completion returned no text content. response: {}", truncate(&response_text, 500)))?;

    Ok(ModelCompletionResponse {
        text,
        model: Some(model),
        provider: Some(provider_id),
        token_usage: extract_anthropic_usage(&value),
    })
}

pub(crate) fn execute_anthropic_streaming_request(
    request: &ModelCompletionRequest,
    app: &AppHandle,
    stream_id: &str,
    cancelled: &AtomicBool,
) -> Result<StreamingRequestResult, String> {
    let api_key = normalize_optional_config_value(request.api_key.as_deref())
        .ok_or_else(|| "Anthropic stream requires an API key.".to_string())?;
    let model = normalize_model_completion_model_name(request)
        .ok_or_else(|| "Anthropic stream requires a model.".to_string())?;
    let provider_id = normalize_optional_config_value(request.provider_id.as_deref())
        .unwrap_or_else(|| infer_model_completion_provider_id(request));
    let base_url = normalize_optional_config_value(request.base_url.as_deref())
        .unwrap_or_else(|| default_anthropic_base_url(&provider_id));
    let endpoint = anthropic_endpoint(&base_url);
    let body = build_anthropic_stream_body(&model, request)?;
    let body_text = serde_json::to_string(&body).map_err(|error| error.to_string())?;

    let client = reqwest::blocking::Client::builder()
        .timeout(ANTHROPIC_STREAMING_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;

    let mut req_builder = client.post(&endpoint);
    for (key, value) in build_anthropic_headers(&api_key, &provider_id) {
        req_builder = req_builder.header(&key, &value);
    }

    let response = req_builder
        .body(body_text)
        .send()
        .map_err(|error| format!("Anthropic stream request failed: {error}"))?;

    let buf_reader = BufReader::new(response);
    let mut total_chunks: u32 = 0;
    let mut token_usage: Option<ModelUsage> = None;

    for line in buf_reader.lines() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let line = line.map_err(|error| format!("Anthropic stream read error: {error}"))?;
        let trimmed = line.trim();
        if !trimmed.starts_with("data:") {
            continue;
        }
        let data = trimmed.trim_start_matches("data:").trim();
        if data.is_empty() {
            continue;
        }

        let value = match serde_json::from_str::<serde_json::Value>(data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

        // Extract usage from message_delta (final event)
        if event_type == "message_delta" {
            if let Some(usage) = extract_anthropic_stream_usage(&value) {
                token_usage = Some(usage);
            }
        }

        // Extract text from content_block_delta with type=text_delta
        if event_type == "content_block_delta" {
            if let Some(delta) = value.get("delta") {
                if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                    if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            let _ = app.emit(
                                "stream-model-chunk",
                                StreamChunkPayload {
                                    stream_id: stream_id.to_string(),
                                    text: text.to_string(),
                                    model: Some(model.clone()),
                                    provider: Some(provider_id.clone()),
                                    index: total_chunks,
                                },
                            );
                            total_chunks += 1;
                        }
                    }
                }
            }
        }
    }

    if total_chunks == 0 && !cancelled.load(Ordering::Relaxed) {
        return Err("Anthropic stream returned no content chunks.".to_string());
    }

    Ok(StreamingRequestResult {
        total_chunks,
        token_usage,
    })
}

fn extract_anthropic_stream_usage(value: &serde_json::Value) -> Option<ModelUsage> {
    // message_delta contains usage with output_tokens
    // message_start contains usage with input_tokens
    // We combine them if available; for simplicity, extract what's in this event
    let usage = value.get("usage")?;
    let output_tokens = usage.get("output_tokens")?.as_u64()? as u32;
    let input_tokens = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    Some(ModelUsage {
        input_tokens,
        output_tokens,
        total_tokens: input_tokens + output_tokens,
    })
}

fn truncate(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        s
    } else {
        &s[..max_len]
    }
}
