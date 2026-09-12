use std::{
    io::{BufRead, BufReader},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::{AppHandle, Emitter};

use crate::code::normalize_optional_config_value;
use crate::{
    classify_http_request_error, classify_http_status_error, create_fnv1a_hash,
    create_model_completion_response_diagnostic, infer_model_completion_provider_id,
    normalize_model_completion_model_name,
    streaming::{StreamChunkPayload, StreamReasoningPayload, StreamingRequestResult},
    ModelCompletionRequest, ModelCompletionResponse, ModelUsage,
};

const ANTHROPIC_TIMEOUT: Duration = Duration::from_secs(90);
const ANTHROPIC_STREAMING_TIMEOUT: Duration = Duration::from_secs(120);
const ANTHROPIC_API_VERSION: &str = "2023-06-01";

pub(crate) fn anthropic_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/messages") {
        return trimmed.to_string();
    }
    if trimmed == "https://api.deepseek.com" {
        return format!("{trimmed}/anthropic/messages");
    }
    format!("{trimmed}/messages")
}

pub(crate) fn default_anthropic_base_url(provider_id: &str) -> String {
    match provider_id {
        "anthropic" => "https://api.anthropic.com/v1".to_string(),
        "deepseek" | "deepseek-anthropic" => "https://api.deepseek.com/anthropic".to_string(),
        _ => "https://api.anthropic.com/v1".to_string(),
    }
}

pub(crate) fn build_anthropic_headers(api_key: &str, provider_id: &str) -> Vec<(String, String)> {
    let mut headers = vec![
        ("x-api-key".to_string(), api_key.to_string()),
        (
            "anthropic-version".to_string(),
            ANTHROPIC_API_VERSION.to_string(),
        ),
        ("content-type".to_string(), "application/json".to_string()),
    ];
    if provider_id == "deepseek" || provider_id == "deepseek-anthropic" {
        headers.push(("Authorization".to_string(), format!("Bearer {api_key}")));
    }
    headers
}

pub(crate) fn build_anthropic_completion_body(
    model: &str,
    request: &ModelCompletionRequest,
) -> Result<serde_json::Value, String> {
    let max_tokens = request.max_tokens.unwrap_or(2048);
    let content = build_anthropic_message_content(request)?;
    let messages = crate::build_completion_messages(request, content, false);
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
        "stream": false,
    });
    if let Some(system_prompt) = crate::trimmed_non_empty(request.system_prompt.as_deref()) {
        body["system"] = serde_json::json!(system_prompt);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    let stop_sequences = crate::normalized_stop_sequences(request);
    if !stop_sequences.is_empty() {
        body["stop_sequences"] = serde_json::json!(stop_sequences);
    }
    Ok(body)
}

fn build_anthropic_stream_body(
    model: &str,
    request: &ModelCompletionRequest,
) -> Result<serde_json::Value, String> {
    let max_tokens = request.max_tokens.unwrap_or(2048);
    let content = build_anthropic_message_content(request)?;
    let messages = crate::build_completion_messages(request, content, false);
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
        "stream": true,
    });
    if let Some(system_prompt) = crate::trimmed_non_empty(request.system_prompt.as_deref()) {
        body["system"] = serde_json::json!(system_prompt);
    }
    if let Some(temperature) = request.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    let stop_sequences = crate::normalized_stop_sequences(request);
    if !stop_sequences.is_empty() {
        body["stop_sequences"] = serde_json::json!(stop_sequences);
    }
    Ok(body)
}

fn build_anthropic_message_content(
    request: &ModelCompletionRequest,
) -> Result<serde_json::Value, String> {
    let images = crate::build_image_list(request);
    if images.is_empty() {
        return Ok(serde_json::Value::String(request.prompt.clone()));
    }
    let mut content: Vec<serde_json::Value> =
        vec![serde_json::json!({ "type": "text", "text": request.prompt })];
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

pub(crate) fn parse_data_url(value: &str) -> Result<(String, String), String> {
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
        _ => {
            return Err(
                "Unsupported image data URL format. Use PNG, JPEG, WebP, GIF, BMP, or TIFF."
                    .to_string(),
            )
        }
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
    Some(anthropic_usage_with_cache(usage, input_tokens, output_tokens))
}

/// Anthropic reports `input_tokens` as the UNCACHED tail only; cache reads
/// and writes arrive as separate fields. Normalize `input_tokens` to the
/// total so cache-hit ratios stay comparable with OpenAI-compatible
/// dialects (where `prompt_tokens` already includes cached tokens).
pub(crate) fn anthropic_usage_with_cache(
    usage: &serde_json::Value,
    uncached_input_tokens: u32,
    output_tokens: u32,
) -> ModelUsage {
    let read = usage
        .get("cache_read_input_tokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as u32;
    let write = usage
        .get("cache_creation_input_tokens")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as u32;
    let input_tokens = uncached_input_tokens.saturating_add(read).saturating_add(write);
    ModelUsage {
        input_tokens,
        output_tokens,
        total_tokens: input_tokens.saturating_add(output_tokens),
        cache_read_tokens: (read > 0).then_some(read),
        cache_write_tokens: (write > 0).then_some(write),
    }
}

fn extract_anthropic_response_text(value: &serde_json::Value) -> Option<String> {
    let content = value.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("text"))
        .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
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

    let effective_timeout = request
        .timeout_ms
        .filter(|&ms| ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(ANTHROPIC_TIMEOUT);
    let client = reqwest::blocking::Client::builder()
        .timeout(effective_timeout)
        .build()
        .map_err(|error| error.to_string())?;

    let mut req_builder = client.post(&endpoint);
    for (key, value) in build_anthropic_headers(&api_key, &provider_id) {
        req_builder = req_builder.header(&key, &value);
    }

    let response = req_builder
        .body(body_text)
        .send()
        .map_err(|error| classify_http_request_error(error, &endpoint))?;
    let status = response.status();
    let response_text = response
        .text()
        .map_err(|error| format!("Anthropic completion could not read response: {error}"))?;
    if !status.is_success() {
        return Err(
            classify_http_status_error(status, &response_text, &provider_id)
                .unwrap_or_else(|| format!("Anthropic API returned HTTP {}.", status.as_u16())),
        );
    }

    let value = serde_json::from_str::<serde_json::Value>(&response_text).map_err(|error| {
        format!(
            "Anthropic completion returned invalid JSON: {error}; {}",
            create_model_completion_response_diagnostic(
                &provider_id,
                &model,
                &endpoint,
                &response_text,
            )
        )
    })?;

    let text = extract_anthropic_response_text(&value).ok_or_else(|| {
        format!(
            "Anthropic completion returned no text content. {}",
            create_model_completion_response_diagnostic(
                &provider_id,
                &model,
                &endpoint,
                &response_text,
            )
        )
    })?;

    Ok(ModelCompletionResponse {
        text,
        model: Some(model),
        provider: Some(provider_id),
        token_usage: extract_anthropic_usage(&value),
        finish_reason: value
            .get("stop_reason")
            .and_then(|reason| reason.as_str())
            .map(str::to_string),
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

    let effective_timeout = request
        .timeout_ms
        .filter(|&ms| ms > 0)
        .map(Duration::from_millis)
        .unwrap_or(ANTHROPIC_STREAMING_TIMEOUT);
    let client = reqwest::blocking::Client::builder()
        .timeout(effective_timeout)
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
    let status = response.status();
    if !status.is_success() {
        let response_text = response
            .text()
            .map_err(|error| format!("Anthropic stream could not read error response: {error}"))?;
        return Err(
            classify_http_status_error(status, &response_text, &provider_id)
                .unwrap_or_else(|| format!("Anthropic stream returned HTTP {}.", status.as_u16())),
        );
    }

    let buf_reader = BufReader::with_capacity(65536, response);
    let mut total_chunks: u32 = 0;
    let mut reasoning_chunks: u32 = 0;
    let mut token_usage: Option<ModelUsage> = None;
    let mut input_tokens: u32 = 0;
    let mut output_tokens: u32 = 0;
    let mut cache_read_tokens: u32 = 0;
    let mut cache_write_tokens: u32 = 0;
    let mut finish_reason: Option<String> = None;
    let mut saw_message_stop = false;

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

        let value = serde_json::from_str::<serde_json::Value>(data)
            .map_err(|error| format!("Anthropic stream returned invalid JSON chunk: {error}"))?;

        let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if event_type == "error" {
            return Err(format_anthropic_stream_error(&value, &provider_id));
        }
        if event_type == "message_stop" {
            saw_message_stop = true;
            break;
        }

        // Anthropic reports prompt usage on message_start and completion
        // usage on message_delta. Keep the largest value seen for each field
        // because the latter is cumulative rather than a per-event delta.
        if let Some(usage) = extract_anthropic_stream_usage(&value) {
            input_tokens = input_tokens.max(usage.input_tokens);
            output_tokens = output_tokens.max(usage.output_tokens);
            cache_read_tokens = cache_read_tokens.max(usage.cache_read_tokens.unwrap_or(0));
            cache_write_tokens = cache_write_tokens.max(usage.cache_write_tokens.unwrap_or(0));
            token_usage = Some(ModelUsage {
                input_tokens,
                output_tokens,
                total_tokens: input_tokens.saturating_add(output_tokens),
                cache_read_tokens: (cache_read_tokens > 0).then_some(cache_read_tokens),
                cache_write_tokens: (cache_write_tokens > 0).then_some(cache_write_tokens),
            });
        }

        if event_type == "message_delta" {
            finish_reason = value
                .get("delta")
                .and_then(|delta| delta.get("stop_reason"))
                .and_then(|reason| reason.as_str())
                .map(str::to_string)
                .or(finish_reason);
        }

        // Extract text from content_block_delta with type=text_delta
        if event_type == "content_block_delta" {
            if let Some(delta) = value.get("delta") {
                let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if delta_type == "text_delta" {
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
                } else if delta_type == "thinking_delta" {
                    if let Some(text) = delta.get("thinking").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            let _ = app.emit(
                                "stream-model-reasoning",
                                StreamReasoningPayload {
                                    stream_id: stream_id.to_string(),
                                    text: text.to_string(),
                                    model: Some(model.clone()),
                                    provider: Some(provider_id.clone()),
                                    index: reasoning_chunks,
                                },
                            );
                            reasoning_chunks += 1;
                        }
                    }
                }
            }
        }
    }

    validate_anthropic_stream_completion(
        total_chunks,
        cancelled.load(Ordering::Relaxed),
        saw_message_stop,
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

fn validate_anthropic_stream_completion(
    total_chunks: u32,
    cancelled: bool,
    saw_message_stop: bool,
    finish_reason: Option<&str>,
) -> Result<(), String> {
    if cancelled {
        return Ok(());
    }
    if total_chunks == 0 {
        return Err("Anthropic stream returned no content chunks.".to_string());
    }
    let has_finish_reason = finish_reason.is_some_and(|reason| !reason.trim().is_empty());
    if !saw_message_stop && !has_finish_reason {
        return Err(
            "Anthropic stream ended before a terminal message_stop event or stop_reason was received."
                .to_string(),
        );
    }
    Ok(())
}

fn format_anthropic_stream_error(value: &serde_json::Value, provider_id: &str) -> String {
    // Provider error payloads may echo prompts, reasoning, or credentials. Keep
    // the diagnostic useful without returning any provider-controlled text.
    let fingerprint_input = value
        .get("error")
        .map(ToString::to_string)
        .unwrap_or_else(|| value.to_string());
    let fingerprint = fingerprint_input.chars().take(4096).collect::<String>();
    let event_type = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("error");
    format!(
        "Anthropic stream provider error (provider={provider_id}; event={event_type}; bodyHash={}).",
        create_fnv1a_hash(fingerprint.as_bytes()),
    )
}

fn extract_anthropic_stream_usage(value: &serde_json::Value) -> Option<ModelUsage> {
    let usage = if value.get("type").and_then(|v| v.as_str()) == Some("message_start") {
        value
            .get("message")
            .and_then(|message| message.get("usage"))?
    } else {
        value.get("usage")?
    };
    let input_tokens = usage
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .map(|value| value.min(u32::MAX as u64) as u32)
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .map(|value| value.min(u32::MAX as u64) as u32)
        .unwrap_or(0);
    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }
    Some(anthropic_usage_with_cache(usage, input_tokens, output_tokens))
}

#[cfg(test)]
mod tests {
    use super::{
        extract_anthropic_stream_usage, format_anthropic_stream_error,
        validate_anthropic_stream_completion,
    };
    use super::extract_anthropic_usage;

    #[test]
    fn normalizes_anthropic_usage_to_total_input_with_cache_fields() {
        let value = serde_json::json!({
            "usage": {
                "input_tokens": 25,
                "output_tokens": 5,
                "cache_read_input_tokens": 900,
                "cache_creation_input_tokens": 75,
            }
        });
        let usage = extract_anthropic_usage(&value).expect("usage");
        // Wire input (25) is the uncached tail; the harness total includes
        // cache reads and writes so hit ratios stay comparable with the
        // OpenAI-compatible dialects where prompt_tokens already includes
        // cached tokens.
        assert_eq!(usage.input_tokens, 1000);
        assert_eq!(usage.cache_read_tokens, Some(900));
        assert_eq!(usage.cache_write_tokens, Some(75));
        assert_eq!(usage.total_tokens, 1005);
    }

    #[test]
    fn stream_message_start_usage_carries_cache_fields() {
        let value = serde_json::json!({
            "type": "message_start",
            "message": { "usage": {
                "input_tokens": 10,
                "output_tokens": 1,
                "cache_read_input_tokens": 200,
            }}
        });
        let usage = extract_anthropic_stream_usage(&value).expect("usage");
        assert_eq!(usage.input_tokens, 210);
        assert_eq!(usage.cache_read_tokens, Some(200));
        assert_eq!(usage.cache_write_tokens, None);
    }

    #[test]
    fn provider_stream_errors_do_not_echo_provider_text() {
        let value = serde_json::json!({
            "type": "error",
            "error": {
                "message": "private reasoning and sk-anthropic-secret",
            },
        });
        let error = format_anthropic_stream_error(&value, "anthropic");

        assert!(error.contains("provider=anthropic"));
        assert!(error.contains("event=error"));
        assert!(error.contains("bodyHash=fnv1a-"));
        assert!(!error.contains("private reasoning"));
        assert!(!error.contains("sk-anthropic-secret"));
    }

    #[test]
    fn extracts_prompt_usage_from_message_start() {
        let value = serde_json::json!({
            "type": "message_start",
            "message": { "usage": { "input_tokens": 42, "output_tokens": 0 } },
        });
        let usage = extract_anthropic_stream_usage(&value).expect("usage");
        assert_eq!(usage.input_tokens, 42);
        assert_eq!(usage.output_tokens, 0);
    }

    #[test]
    fn extracts_completion_usage_from_message_delta() {
        let value = serde_json::json!({
            "type": "message_delta",
            "usage": { "output_tokens": 7 },
        });
        let usage = extract_anthropic_stream_usage(&value).expect("usage");
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 7);
    }

    #[test]
    fn rejects_eof_without_anthropic_terminal_signal() {
        let error = validate_anthropic_stream_completion(1, false, false, None)
            .expect_err("unterminated stream should fail");
        assert!(error.contains("terminal message_stop event or stop_reason"));
    }

    #[test]
    fn accepts_anthropic_message_stop_or_stop_reason() {
        assert!(validate_anthropic_stream_completion(1, false, true, None).is_ok());
        assert!(validate_anthropic_stream_completion(1, false, false, Some("max_tokens")).is_ok());
    }

    #[test]
    fn accepts_cancelled_anthropic_stream_without_terminal_signal() {
        assert!(validate_anthropic_stream_completion(0, true, false, None).is_ok());
    }
}
