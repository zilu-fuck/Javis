use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    mpsc::{self, Receiver},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use crate::error::JavisError;

const MCP_DEFAULT_REQUEST_TIMEOUT_MS: u64 = 30_000;
const MCP_MIN_REQUEST_TIMEOUT_MS: u64 = 1_000;
const MCP_MAX_REQUEST_TIMEOUT_MS: u64 = 30_000;
const MCP_STDERR_TAIL_MAX_CHARS: usize = 2_000;
const MCP_MAX_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const MCP_MAX_HEADER_LINE_BYTES: usize = 8 * 1024;
const MCP_READONLY_TOOL_ALLOWLIST_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const MCP_INSTALL_MAX_FILES: usize = 1_000;
const MCP_INSTALL_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MCP_INSTALL_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
static MCP_READONLY_TOOL_ALLOWLIST_CACHE: Lazy<
    Mutex<BTreeMap<String, McpReadonlyToolAllowlistCacheEntry>>,
> = Lazy::new(|| Mutex::new(BTreeMap::new()));

#[derive(Debug, Clone)]
struct McpReadonlyToolAllowlistCacheEntry {
    signature: String,
    cached_at: Instant,
    read_only_tool_names: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct CodexMcpServerSummary {
    name: String,
    transport: String,
    command: Option<String>,
    url: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    enabled: bool,
    source: String,
    removable: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct InstallMcpServerSummary {
    name: String,
    transport: String,
    command: Option<String>,
    url: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallMcpServerRequest {
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpToolCallRequest {
    server_name: String,
    source: Option<String>,
    action: Option<String>,
    tool_name: Option<String>,
    arguments: Option<serde_json::Value>,
    input: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
}

#[tauri::command]
pub(crate) fn read_mcp_config() -> Result<Option<String>, String> {
    read_mcp_config_impl().map_err(|e| e.to_string())
}

fn read_mcp_config_impl() -> Result<Option<String>, JavisError> {
    let config_dir = dirs::config_dir()
        .ok_or_else(|| JavisError::Io("Cannot determine config directory".into()))?;
    let config_path = config_dir.join("javis").join("mcp.json");

    if !config_path.exists() {
        return Ok(None);
    }

    fs::read_to_string(&config_path)
        .map(Some)
        .map_err(|e| JavisError::Io(format!("Cannot read MCP config: {e}")))
}

#[tauri::command]
pub(crate) fn write_mcp_config(json: String) -> Result<(), String> {
    write_mcp_config_impl(&json).map_err(|e| e.to_string())
}

fn write_mcp_config_impl(json: &str) -> Result<(), JavisError> {
    // Validate JSON before writing
    serde_json::from_str::<serde_json::Value>(json)
        .map_err(|e| JavisError::Validation(format!("Invalid JSON for MCP config: {e}")))?;

    let config_dir = dirs::config_dir()
        .ok_or_else(|| JavisError::Io("Cannot determine config directory".into()))?;
    let javis_dir = config_dir.join("javis");

    fs::create_dir_all(&javis_dir)
        .map_err(|e| JavisError::Io(format!("Cannot create config directory: {e}")))?;

    let config_path = javis_dir.join("mcp.json");
    let tmp_path = javis_dir.join("mcp.json.tmp");
    fs::write(&tmp_path, json)
        .map_err(|e| JavisError::Io(format!("Cannot write MCP config: {e}")))?;
    fs::rename(&tmp_path, &config_path)
        .map_err(|e| JavisError::Io(format!("Cannot finalize MCP config: {e}")))?;

    Ok(())
}

#[tauri::command]
pub(crate) fn install_mcp_server_from_github(
    request: InstallMcpServerRequest,
) -> Result<InstallMcpServerSummary, String> {
    install_mcp_server_from_github_impl(&request).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn scan_codex_mcp_servers() -> Result<Vec<CodexMcpServerSummary>, String> {
    scan_codex_mcp_servers_impl().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_codex_mcp_server_enabled(
    name: String,
    source: Option<String>,
    enabled: bool,
) -> Result<Vec<CodexMcpServerSummary>, String> {
    set_codex_mcp_server_enabled_impl(&name, source.as_deref(), enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_codex_mcp_server(
    name: String,
    source: Option<String>,
) -> Result<Vec<CodexMcpServerSummary>, String> {
    delete_codex_mcp_server_impl(&name, source.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn call_mcp_server_tool(
    request: McpToolCallRequest,
) -> Result<serde_json::Value, String> {
    call_mcp_server_tool_impl(&request).map_err(|e| e.to_string())
}

fn scan_codex_mcp_servers_impl() -> Result<Vec<CodexMcpServerSummary>, JavisError> {
    let Some(home_dir) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let config_path = codex_config_path(&home_dir);
    if !config_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|e| JavisError::Io(format!("Cannot read Codex config: {e}")))?;
    Ok(parse_codex_mcp_servers(&content))
}

fn call_mcp_server_tool_impl(
    request: &McpToolCallRequest,
) -> Result<serde_json::Value, JavisError> {
    validate_mcp_name(&request.server_name)?;
    let server = find_enabled_mcp_server(&request.server_name, request.source.as_deref())?;
    let action = request.action.as_deref().unwrap_or("callTool");
    let timeout = mcp_request_timeout(request.timeout_ms);
    let mut client = StdioMcpClient::start(&server)?;
    client.initialize(timeout)?;
    match action {
        "listTools" => {
            let result = client.request("tools/list", serde_json::json!({}), timeout)?;
            update_mcp_readonly_tool_allowlist_cache(&server, &result);
            Ok(result)
        }
        "callTool" => {
            let tool_name = request
                .tool_name
                .as_deref()
                .or_else(|| {
                    request
                        .input
                        .as_ref()
                        .and_then(|input| input.get("toolName"))
                        .and_then(|value| value.as_str())
                })
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    JavisError::Validation("MCP callTool requires a toolName input.".to_string())
                })?;
            let arguments = mcp_call_tool_arguments(request);
            let is_allowlisted =
                match cached_mcp_readonly_tool_allowlist_contains(&server, tool_name) {
                    Some(result) => result,
                    None => {
                        let listed_tools =
                            client.request("tools/list", serde_json::json!({}), timeout)?;
                        let result = is_read_only_mcp_tool_in_list(&listed_tools, tool_name);
                        update_mcp_readonly_tool_allowlist_cache(&server, &listed_tools);
                        result
                    }
                };
            if !is_allowlisted {
                return Err(JavisError::Validation(format!(
                    "MCP callTool is limited to discovered read-only tools: {tool_name}"
                )));
            }
            client.request(
                "tools/call",
                serde_json::json!({
                    "name": tool_name,
                    "arguments": arguments,
                }),
                timeout,
            )
        }
        other => Err(JavisError::Validation(format!(
            "Unsupported MCP action: {other}"
        ))),
    }
}

fn mcp_call_tool_arguments(request: &McpToolCallRequest) -> serde_json::Value {
    request
        .arguments
        .clone()
        .or_else(|| {
            request
                .input
                .as_ref()
                .and_then(|input| input.get("arguments").cloned())
        })
        .or_else(|| {
            request
                .input
                .as_ref()
                .and_then(|input| input.get("args").cloned())
        })
        .or_else(|| {
            request
                .input
                .as_ref()
                .and_then(|input| input.get("parameters").cloned())
        })
        .or_else(|| {
            request
                .input
                .as_ref()
                .and_then(|input| input.get("input").cloned())
        })
        .unwrap_or_else(|| serde_json::json!({}))
}

fn mcp_request_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(MCP_DEFAULT_REQUEST_TIMEOUT_MS)
            .clamp(MCP_MIN_REQUEST_TIMEOUT_MS, MCP_MAX_REQUEST_TIMEOUT_MS),
    )
}

fn is_read_only_mcp_tool_in_list(list_tools_result: &serde_json::Value, tool_name: &str) -> bool {
    parse_mcp_listed_tools(list_tools_result)
        .iter()
        .any(|tool| tool.name == tool_name && is_read_only_mcp_tool(tool))
}

fn cached_mcp_readonly_tool_allowlist_contains(
    server: &CodexMcpServerSummary,
    tool_name: &str,
) -> Option<bool> {
    let key = mcp_readonly_tool_allowlist_cache_key(server);
    let signature = mcp_readonly_tool_allowlist_cache_signature(server);
    let Ok(mut cache) = MCP_READONLY_TOOL_ALLOWLIST_CACHE.lock() else {
        return None;
    };
    let now = Instant::now();
    let Some(entry) = cache.get(&key) else {
        return None;
    };
    if entry.signature != signature
        || now.duration_since(entry.cached_at) > MCP_READONLY_TOOL_ALLOWLIST_CACHE_TTL
    {
        cache.remove(&key);
        return None;
    }
    Some(entry.read_only_tool_names.contains(tool_name))
}

fn update_mcp_readonly_tool_allowlist_cache(
    server: &CodexMcpServerSummary,
    list_tools_result: &serde_json::Value,
) {
    let read_only_tool_names = parse_mcp_listed_tools(list_tools_result)
        .into_iter()
        .filter(is_read_only_mcp_tool)
        .map(|tool| tool.name)
        .collect::<BTreeSet<_>>();
    let Ok(mut cache) = MCP_READONLY_TOOL_ALLOWLIST_CACHE.lock() else {
        return;
    };
    cache.insert(
        mcp_readonly_tool_allowlist_cache_key(server),
        McpReadonlyToolAllowlistCacheEntry {
            signature: mcp_readonly_tool_allowlist_cache_signature(server),
            cached_at: Instant::now(),
            read_only_tool_names,
        },
    );
}

fn mcp_readonly_tool_allowlist_cache_key(server: &CodexMcpServerSummary) -> String {
    format!("{}:{}", server.source, server.name)
}

fn mcp_readonly_tool_allowlist_cache_signature(server: &CodexMcpServerSummary) -> String {
    serde_json::to_string(&serde_json::json!({
        "transport": server.transport,
        "command": server.command,
        "url": server.url,
        "args": server.args,
        "cwd": server.cwd,
        "env": server.env,
        "enabled": server.enabled,
    }))
    .unwrap_or_default()
}

#[derive(Debug, Clone, Default)]
struct McpListedTool {
    name: String,
    annotations: McpToolAnnotations,
}

#[derive(Debug, Clone, Default)]
struct McpToolAnnotations {
    read_only_hint: Option<bool>,
    destructive_hint: Option<bool>,
}

fn parse_mcp_listed_tools(value: &serde_json::Value) -> Vec<McpListedTool> {
    value
        .get("tools")
        .and_then(|tools| tools.as_array())
        .map(|tools| {
            tools
                .iter()
                .filter_map(parse_mcp_listed_tool)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn parse_mcp_listed_tool(value: &serde_json::Value) -> Option<McpListedTool> {
    let object = value.as_object()?;
    let name = object.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(McpListedTool {
        name: name.to_string(),
        annotations: parse_mcp_tool_annotations(object.get("annotations")),
    })
}

fn parse_mcp_tool_annotations(value: Option<&serde_json::Value>) -> McpToolAnnotations {
    let Some(object) = value.and_then(|value| value.as_object()) else {
        return McpToolAnnotations::default();
    };
    McpToolAnnotations {
        read_only_hint: object.get("readOnlyHint").and_then(|value| value.as_bool()),
        destructive_hint: object
            .get("destructiveHint")
            .and_then(|value| value.as_bool()),
    }
}

fn is_read_only_mcp_tool(tool: &McpListedTool) -> bool {
    if tool.annotations.destructive_hint == Some(true) {
        return false;
    }
    let name_tokens = tokenize_mcp_tool_name(&tool.name);
    if name_tokens
        .iter()
        .any(|token| is_unsafe_mcp_tool_name_token(token))
    {
        return false;
    }
    if tool.annotations.read_only_hint == Some(true) {
        return true;
    }
    if tool.annotations.read_only_hint == Some(false) {
        return false;
    }
    name_tokens
        .iter()
        .any(|token| MCP_READONLY_TOOL_NAME_TOKENS.contains(&token.as_str()))
}

fn tokenize_mcp_tool_name(name: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(name.len());
    let mut previous_is_lower_or_digit = false;
    for ch in name.chars() {
        if ch.is_ascii_uppercase() && previous_is_lower_or_digit {
            spaced.push(' ');
        }
        spaced.push(ch);
        previous_is_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
    }
    spaced
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|token| !token.is_empty())
        .collect()
}

fn is_unsafe_mcp_tool_name_token(token: &str) -> bool {
    MCP_UNSAFE_TOOL_NAME_TOKENS.contains(&token)
        || MCP_UNSAFE_COMPACT_PREFIXES
            .iter()
            .any(|prefix| token.len() > prefix.len() && token.starts_with(prefix))
}

const MCP_UNSAFE_TOOL_NAME_TOKENS: &[&str] = &[
    "write",
    "delete",
    "remove",
    "create",
    "update",
    "edit",
    "move",
    "copy",
    "run",
    "execute",
    "exec",
    "shell",
    "command",
    "apply",
    "patch",
    "install",
    "start",
    "stop",
    "restart",
    "open",
    "click",
    "type",
    "send",
    "post",
    "put",
    "deploy",
    "publish",
    "upload",
    "mkdir",
    "rmdir",
    "set",
    "add",
    "append",
    "insert",
    "upsert",
    "replace",
    "rename",
    "save",
    "clear",
    "reset",
    "drop",
    "truncate",
    "format",
    "overwrite",
    "mutate",
    "modify",
    "enable",
    "disable",
    "download",
    "clone",
    "checkout",
    "commit",
    "push",
    "merge",
    "grant",
    "revoke",
    "login",
    "auth",
    "subscribe",
];

const MCP_UNSAFE_COMPACT_PREFIXES: &[&str] = &[
    "write",
    "delete",
    "remove",
    "create",
    "update",
    "edit",
    "move",
    "copy",
    "run",
    "execute",
    "exec",
    "shell",
    "command",
    "apply",
    "patch",
    "install",
    "start",
    "stop",
    "restart",
    "click",
    "type",
    "send",
    "post",
    "put",
    "deploy",
    "publish",
    "upload",
    "mkdir",
    "rmdir",
    "append",
    "insert",
    "upsert",
    "replace",
    "rename",
    "save",
    "clear",
    "reset",
    "drop",
    "truncate",
    "format",
    "overwrite",
    "mutate",
    "modify",
    "enable",
    "disable",
    "download",
    "clone",
    "checkout",
    "commit",
    "push",
    "merge",
    "grant",
    "revoke",
    "login",
    "auth",
    "subscribe",
];

const MCP_READONLY_TOOL_NAME_TOKENS: &[&str] = &[
    "read", "get", "list", "search", "find", "query", "fetch", "lookup", "inspect", "describe",
    "stat", "status", "show", "view", "resolve", "explain", "info",
];

fn find_enabled_mcp_server(
    name: &str,
    source: Option<&str>,
) -> Result<CodexMcpServerSummary, JavisError> {
    if let Some(server) = read_javis_mcp_servers()?.into_iter().find(|server| {
        server.name == name
            && server.enabled
            && source.map(|value| value == server.source).unwrap_or(true)
    }) {
        return Ok(server);
    }
    if let Some(server) = scan_codex_mcp_servers_impl()?.into_iter().find(|server| {
        server.name == name
            && server.enabled
            && source.map(|value| value == server.source).unwrap_or(true)
    }) {
        return Ok(server);
    }
    Err(JavisError::NotFound(format!(
        "Enabled MCP server was not found: {name}"
    )))
}

fn read_javis_mcp_servers() -> Result<Vec<CodexMcpServerSummary>, JavisError> {
    let Some(content) = read_mcp_config_impl()? else {
        return Ok(Vec::new());
    };
    let value = serde_json::from_str::<serde_json::Value>(&content)?;
    Ok(parse_javis_mcp_servers(&value))
}

fn parse_javis_mcp_servers(value: &serde_json::Value) -> Vec<CodexMcpServerSummary> {
    let Some(servers) = value.get("mcpServers").and_then(|entry| entry.as_object()) else {
        return value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(parse_javis_mcp_server_array_item)
                    .collect()
            })
            .unwrap_or_default();
    };
    servers
        .iter()
        .filter_map(|(name, config)| parse_javis_mcp_server(name, config))
        .collect()
}

fn parse_javis_mcp_server_array_item(value: &serde_json::Value) -> Option<CodexMcpServerSummary> {
    let name = value.get("name")?.as_str()?.to_string();
    parse_javis_mcp_server(&name, value)
}

fn parse_javis_mcp_server(name: &str, value: &serde_json::Value) -> Option<CodexMcpServerSummary> {
    let object = value.as_object()?;
    let transport = object
        .get("transport")
        .and_then(|value| value.as_str())
        .unwrap_or("stdio")
        .to_string();
    let command = object
        .get("command")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let url = object
        .get("url")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let args = object
        .get("args")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let cwd = object
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let env = object
        .get("env")
        .and_then(|value| value.as_object())
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    if transport == "stdio" && command.is_none() {
        return None;
    }
    if transport == "sse" && url.is_none() {
        return None;
    }
    Some(CodexMcpServerSummary {
        name: name.to_string(),
        transport,
        command,
        url,
        args,
        cwd,
        env,
        enabled: object.get("enabled").and_then(|value| value.as_bool()) != Some(false),
        source: "javis".to_string(),
        removable: true,
    })
}

struct StdioMcpClient {
    child: Child,
    responses: Receiver<Result<serde_json::Value, String>>,
    stderr_tail: Arc<Mutex<String>>,
    stdin: std::process::ChildStdin,
    next_id: u64,
}

impl StdioMcpClient {
    fn start(server: &CodexMcpServerSummary) -> Result<Self, JavisError> {
        if server.transport != "stdio" {
            return Err(JavisError::Validation(
                "Only stdio MCP servers are supported by this Javis runtime bridge.".to_string(),
            ));
        }
        let command = server.command.as_ref().ok_or_else(|| {
            JavisError::Validation("MCP stdio server is missing command.".to_string())
        })?;
        let mut command = Command::new(command);
        command.args(&server.args);
        if let Some(cwd) = server.cwd.as_ref().filter(|value| !value.trim().is_empty()) {
            command.current_dir(cwd);
        }
        command.envs(&server.env);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                JavisError::Io(format!("Cannot start MCP server {}: {error}", server.name))
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| JavisError::Io("Cannot open MCP server stdin.".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| JavisError::Io("Cannot open MCP server stdout.".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| JavisError::Io("Cannot open MCP server stderr.".to_string()))?;
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let stderr_tail_for_thread = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            read_mcp_stderr_tail(stderr, stderr_tail_for_thread);
        });
        let (sender, responses) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let parsed = read_mcp_message(&mut reader);
                let should_stop = parsed.is_err();
                let _ = sender.send(parsed);
                if should_stop {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            responses,
            stderr_tail,
            stdin,
            next_id: 1,
        })
    }

    fn initialize(&mut self, timeout: Duration) -> Result<(), JavisError> {
        let _ = self.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "Javis",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }),
            timeout,
        )?;
        self.notify("notifications/initialized", serde_json::json!({}))
            .map_err(|error| self.with_stderr_tail(error))
    }

    fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, JavisError> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|error| self.with_stderr_tail(error))?;
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(self.with_stderr_tail(JavisError::Io(format!(
                    "Timed out waiting for MCP response to {method}."
                ))));
            }
            let response = match self.responses.recv_timeout(remaining) {
                Ok(Ok(value)) => value,
                Ok(Err(message)) => return Err(self.with_stderr_tail(JavisError::Io(message))),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(self.with_stderr_tail(JavisError::Io(format!(
                        "Timed out waiting for MCP response to {method}."
                    ))));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(self.with_stderr_tail(JavisError::Io(
                        "MCP response reader stopped.".to_string(),
                    )));
                }
            };
            if response.get("id").and_then(|value| value.as_u64()) != Some(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(self.with_stderr_tail(JavisError::Internal(format!(
                    "MCP server returned error for {method}: {error}"
                ))));
            }
            return Ok(response
                .get("result")
                .cloned()
                .unwrap_or_else(|| serde_json::json!(null)));
        }
    }

    fn notify(&mut self, method: &str, params: serde_json::Value) -> Result<(), JavisError> {
        self.write_json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn write_json(&mut self, value: &serde_json::Value) -> Result<(), JavisError> {
        let body = serde_json::to_string(value)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.stdin.write_all(header.as_bytes())?;
        self.stdin.write_all(body.as_bytes())?;
        self.stdin.flush()?;
        Ok(())
    }

    fn with_stderr_tail(&self, error: JavisError) -> JavisError {
        let tail = self
            .stderr_tail
            .lock()
            .ok()
            .map(|tail| tail.trim().to_string())
            .unwrap_or_default();
        if tail.is_empty() {
            return error;
        }
        match error {
            JavisError::Io(message) => {
                JavisError::Io(append_mcp_stderr_tail_to_message(&message, &tail))
            }
            JavisError::Internal(message) => {
                JavisError::Internal(append_mcp_stderr_tail_to_message(&message, &tail))
            }
            other => other,
        }
    }
}

fn read_mcp_stderr_tail<R: Read>(mut stderr: R, tail: Arc<Mutex<String>>) {
    let mut buffer = [0_u8; 1024];
    loop {
        let bytes = match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes) => bytes,
            Err(_) => break,
        };
        let chunk = String::from_utf8_lossy(&buffer[..bytes]);
        if let Ok(mut current) = tail.lock() {
            append_bounded_text_tail(&mut current, &chunk, MCP_STDERR_TAIL_MAX_CHARS);
        } else {
            break;
        }
    }
}

fn append_bounded_text_tail(current: &mut String, chunk: &str, max_chars: usize) {
    current.push_str(chunk);
    let char_count = current.chars().count();
    if char_count <= max_chars {
        return;
    }
    let keep_from = char_count.saturating_sub(max_chars);
    *current = current.chars().skip(keep_from).collect();
}

fn append_mcp_stderr_tail_to_message(message: &str, tail: &str) -> String {
    let normalized_tail = tail.trim().replace('\0', "");
    if normalized_tail.is_empty() {
        return message.to_string();
    }
    format!("{message} MCP stderr tail: {normalized_tail}")
}

fn read_mcp_message<R: BufRead>(reader: &mut R) -> Result<serde_json::Value, String> {
    let first_line = read_mcp_line_limited(reader, MCP_MAX_RESPONSE_BYTES)
        .map_err(|error| format!("Cannot read MCP response: {error}"))?;
    if first_line.is_empty() {
        return Err("MCP server closed stdout before responding.".to_string());
    }
    let trimmed = first_line.trim_end_matches(['\r', '\n']);
    if let Some(length_text) = trimmed.strip_prefix("Content-Length:") {
        let content_length = length_text
            .trim()
            .parse::<usize>()
            .map_err(|error| format!("Invalid MCP Content-Length: {error}"))?;
        if content_length > MCP_MAX_RESPONSE_BYTES {
            return Err(format!(
                "MCP response body exceeds {MCP_MAX_RESPONSE_BYTES} bytes."
            ));
        }
        loop {
            let header_line = read_mcp_line_limited(reader, MCP_MAX_HEADER_LINE_BYTES)
                .map_err(|error| format!("Cannot read MCP response headers: {error}"))?;
            if header_line.is_empty() {
                return Err("MCP server closed stdout during headers.".to_string());
            }
            if header_line.trim().is_empty() {
                break;
            }
        }
        let mut body = vec![0_u8; content_length];
        reader
            .read_exact(&mut body)
            .map_err(|error| format!("Cannot read MCP response body: {error}"))?;
        return serde_json::from_slice::<serde_json::Value>(&body)
            .map_err(|error| format!("Invalid MCP response JSON: {error}"));
    }
    serde_json::from_str::<serde_json::Value>(trimmed)
        .map_err(|error| format!("Invalid MCP response JSON: {error}"))
}

fn read_mcp_line_limited<R: BufRead>(reader: &mut R, max_bytes: usize) -> Result<String, String> {
    let mut output = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|error| format!("Cannot read line: {error}"))?;
        if available.is_empty() {
            break;
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        if output.len().saturating_add(take) > max_bytes {
            return Err(format!("MCP response line exceeds {max_bytes} bytes."));
        }
        output.extend_from_slice(&available[..take]);
        reader.consume(take);
        if output.last() == Some(&b'\n') {
            break;
        }
    }
    String::from_utf8(output).map_err(|error| format!("MCP response is not UTF-8: {error}"))
}

impl Drop for StdioMcpClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn codex_config_path(home_dir: &Path) -> PathBuf {
    home_dir.join(".codex").join("config.toml")
}

fn set_codex_mcp_server_enabled_impl(
    name: &str,
    source: Option<&str>,
    enabled: bool,
) -> Result<Vec<CodexMcpServerSummary>, JavisError> {
    validate_mcp_name(name)?;
    validate_codex_mcp_source(source)?;
    let home_dir = dirs::home_dir()
        .ok_or_else(|| JavisError::Io("Cannot determine home directory".to_string()))?;
    let config_path = codex_config_path(&home_dir);
    let content = fs::read_to_string(&config_path)
        .map_err(|e| JavisError::Io(format!("Cannot read Codex config: {e}")))?;
    ensure_codex_mcp_source_matches(&content, name, source)?;
    let next_content = set_codex_mcp_enabled_in_toml(&content, name, enabled)
        .ok_or_else(|| JavisError::NotFound(format!("Codex MCP server was not found: {name}")))?;
    let tmp_path = config_path.with_extension("toml.tmp");
    fs::write(&tmp_path, next_content)
        .map_err(|e| JavisError::Io(format!("Cannot write Codex config: {e}")))?;
    fs::rename(&tmp_path, &config_path)
        .map_err(|e| JavisError::Io(format!("Cannot finalize Codex config: {e}")))?;
    scan_codex_mcp_servers_impl()
}

fn delete_codex_mcp_server_impl(
    name: &str,
    source: Option<&str>,
) -> Result<Vec<CodexMcpServerSummary>, JavisError> {
    validate_mcp_name(name)?;
    validate_codex_mcp_source(source)?;
    let home_dir = dirs::home_dir()
        .ok_or_else(|| JavisError::Io("Cannot determine home directory".to_string()))?;
    let config_path = codex_config_path(&home_dir);
    let content = fs::read_to_string(&config_path)
        .map_err(|e| JavisError::Io(format!("Cannot read Codex config: {e}")))?;
    ensure_codex_mcp_source_matches(&content, name, source)?;
    let next_content = remove_codex_mcp_server_in_toml(&content, name).ok_or_else(|| {
        JavisError::NotFound(format!(
            "Javis-managed Codex MCP server was not found: {name}"
        ))
    })?;
    let tmp_path = config_path.with_extension("toml.tmp");
    fs::write(&tmp_path, next_content)
        .map_err(|e| JavisError::Io(format!("Cannot write Codex config: {e}")))?;
    fs::rename(&tmp_path, &config_path)
        .map_err(|e| JavisError::Io(format!("Cannot finalize Codex config: {e}")))?;
    scan_codex_mcp_servers_impl()
}

fn validate_mcp_name(name: &str) -> Result<(), JavisError> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed != name
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains("..")
        || trimmed.chars().any(char::is_control)
    {
        return Err(JavisError::Validation(
            "Codex MCP server name is invalid.".to_string(),
        ));
    }
    Ok(())
}

fn validate_codex_mcp_source(source: Option<&str>) -> Result<(), JavisError> {
    if source.is_some_and(|value| value != "codex") {
        return Err(JavisError::Validation(
            "Codex MCP source is invalid.".to_string(),
        ));
    }
    Ok(())
}

fn ensure_codex_mcp_source_matches(
    content: &str,
    name: &str,
    source: Option<&str>,
) -> Result<(), JavisError> {
    if source.is_none() {
        return Ok(());
    }
    let server = parse_codex_mcp_servers(content)
        .into_iter()
        .find(|server| server.name == name)
        .ok_or_else(|| JavisError::NotFound(format!("Codex MCP server was not found: {name}")))?;
    if source == Some(server.source.as_str()) {
        Ok(())
    } else {
        Err(JavisError::NotFound(format!(
            "Codex MCP server was not found for source {}: {name}",
            source.unwrap_or_default()
        )))
    }
}

fn set_codex_mcp_enabled_in_toml(content: &str, name: &str, enabled: bool) -> Option<String> {
    let mut lines: Vec<String> = content.lines().map(ToString::to_string).collect();
    let mut target_start = None;
    let mut target_end = lines.len();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if !(trimmed.starts_with('[') && trimmed.ends_with(']')) {
            continue;
        }
        if target_start.is_some() {
            target_end = index;
            break;
        }
        let table = trimmed.trim_start_matches('[').trim_end_matches(']');
        if parse_mcp_server_table_name(table).as_deref() == Some(name) {
            target_start = Some(index);
        }
    }
    let start = target_start?;
    let enabled_line = format!("enabled = {}", if enabled { "true" } else { "false" });
    for line in lines.iter_mut().take(target_end).skip(start + 1) {
        let trimmed = line.trim_start();
        if trimmed.starts_with("enabled") {
            let indent = &line[..line.len() - trimmed.len()];
            *line = format!("{indent}{enabled_line}");
            return Some(join_toml_lines(lines, content.ends_with('\n')));
        }
    }
    lines.insert(target_end, enabled_line);
    Some(join_toml_lines(lines, content.ends_with('\n')))
}

fn upsert_codex_mcp_server_in_toml(content: &str, server: &InstallMcpServerSummary) -> String {
    let mut lines = remove_codex_mcp_server_tables(content, &server.name)
        .unwrap_or_else(|| content.lines().map(ToString::to_string).collect());
    if lines.last().is_some_and(|line| !line.trim().is_empty()) {
        lines.push(String::new());
    }
    lines.extend(render_codex_mcp_server_table(server));
    join_toml_lines(lines, true)
}

fn remove_codex_mcp_server_in_toml(content: &str, name: &str) -> Option<String> {
    let server = parse_codex_mcp_servers(content)
        .into_iter()
        .find(|server| server.name == name)?;
    if !server.removable {
        return None;
    }
    let lines = remove_codex_mcp_server_tables(content, name)?;
    Some(join_toml_lines(lines, content.ends_with('\n')))
}

fn remove_codex_mcp_server_tables(content: &str, name: &str) -> Option<Vec<String>> {
    let mut found = false;
    let mut skip = false;
    let mut output = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let table = trimmed.trim_start_matches('[').trim_end_matches(']');
            skip = is_mcp_server_table_for_name(table, name);
            if skip {
                found = true;
                continue;
            }
        }
        if !skip {
            output.push(line.to_string());
        }
    }
    found.then_some(output)
}

fn render_codex_mcp_server_table(server: &InstallMcpServerSummary) -> Vec<String> {
    let mut lines = vec![
        format!("[mcp_servers.{}]", toml_key(&server.name)),
        "# javis-managed = true".to_string(),
        "transport = \"stdio\"".to_string(),
    ];
    if let Some(command) = &server.command {
        lines.push(format!("command = {}", toml_string(command)));
    }
    if !server.args.is_empty() {
        let args = server
            .args
            .iter()
            .map(|arg| toml_string(arg))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("args = [{args}]"));
    }
    if let Some(cwd) = &server.cwd {
        lines.push(format!("cwd = {}", toml_string(cwd)));
    }
    lines.push(format!(
        "enabled = {}",
        if server.enabled { "true" } else { "false" }
    ));
    lines
}

fn join_toml_lines(lines: Vec<String>, trailing_newline: bool) -> String {
    let mut output = lines.join("\n");
    if trailing_newline {
        output.push('\n');
    }
    output
}

fn parse_codex_mcp_servers(content: &str) -> Vec<CodexMcpServerSummary> {
    let mut servers = Vec::new();
    let mut current: Option<CodexMcpServerSummary> = None;
    let mut current_env_server: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "# javis-managed = true" {
            if let Some(server) = current.as_mut() {
                server.removable = true;
            }
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if let Some(server) = current.take() {
                servers.push(server);
            }
            let table = trimmed.trim_start_matches('[').trim_end_matches(']');
            if let Some(name) = parse_mcp_server_env_table_name(table) {
                if let Some(server) = servers.iter_mut().find(|server| server.name == name) {
                    current = Some(server.clone());
                    servers.retain(|server| server.name != name);
                    current_env_server = Some(name);
                } else {
                    current = None;
                    current_env_server = Some(name);
                }
            } else if let Some(name) = parse_mcp_server_table_name(table) {
                current = Some(CodexMcpServerSummary {
                    name,
                    transport: "stdio".to_string(),
                    command: None,
                    url: None,
                    args: Vec::new(),
                    cwd: None,
                    env: BTreeMap::new(),
                    enabled: true,
                    source: "codex".to_string(),
                    removable: false,
                });
                current_env_server = None;
            } else {
                current = None;
                current_env_server = None;
            }
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let Some(server) = current.as_mut() else {
            continue;
        };
        if current_env_server.is_some() {
            if let Some(value) = unquote_toml_value(value.trim()) {
                server.env.insert(key.trim().to_string(), value);
            }
            continue;
        }
        match key.trim() {
            "type" | "transport" => {
                if let Some(value) = unquote_toml_value(value.trim()) {
                    server.transport = value;
                }
            }
            "command" => {
                server.command = unquote_toml_value(value.trim());
            }
            "url" => {
                server.url = unquote_toml_value(value.trim());
            }
            "args" => {
                server.args = parse_toml_string_array(value.trim());
            }
            "cwd" => {
                server.cwd = unquote_toml_value(value.trim());
            }
            "enabled" => {
                if let Some(enabled) = parse_toml_bool(value.trim()) {
                    server.enabled = enabled;
                }
            }
            _ => {}
        }
    }

    if let Some(server) = current {
        servers.push(server);
    }
    servers
}

fn install_mcp_server_from_github_impl(
    request: &InstallMcpServerRequest,
) -> Result<InstallMcpServerSummary, JavisError> {
    let github = parse_github_repo_url(&request.url).ok_or_else(|| {
        JavisError::Validation(
            "MCP install only supports https://github.com/owner/repo URLs.".to_string(),
        )
    })?;
    let temp_dir = std::env::temp_dir().join(format!(
        "javis-mcp-install-{}-{}-{}",
        std::process::id(),
        github.owner,
        github.repo,
    ));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).map_err(|error| {
            JavisError::Io(format!("Cannot clear temp MCP install dir: {error}"))
        })?;
    }
    let clone_status = Command::new("git")
        .arg("clone")
        .arg("--depth")
        .arg("1")
        .args(
            github
                .branch
                .as_ref()
                .map(|branch| ["--branch", branch.as_str()])
                .into_iter()
                .flatten(),
        )
        .arg(github_clone_url(&github))
        .arg(&temp_dir)
        .status()
        .map_err(|error| {
            JavisError::Io(format!("Cannot start git clone for MCP install: {error}"))
        })?;
    if !clone_status.success() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(JavisError::Io(
            "Git clone failed while installing the MCP server.".to_string(),
        ));
    }

    let inspect_dir = github
        .subdir
        .as_ref()
        .map(|subdir| temp_dir.join(subdir))
        .unwrap_or_else(|| temp_dir.clone());
    if !inspect_dir.is_dir() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(JavisError::NotFound(
            "GitHub repository subdirectory does not exist.".to_string(),
        ));
    }
    let package_path = find_package_json(&inspect_dir)
        .map_err(|error| JavisError::Io(format!("Cannot inspect MCP package: {error}")))?;
    let package_json = fs::read_to_string(&package_path)
        .map_err(|error| JavisError::Io(format!("Cannot read MCP package.json: {error}")))?;
    let package = serde_json::from_str::<serde_json::Value>(&package_json).map_err(|error| {
        JavisError::Validation(format!("MCP package.json is invalid JSON: {error}"))
    })?;
    let _package_name = package
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            JavisError::Validation("MCP package.json must define a package name.".to_string())
        })?;
    if package.get("bin").is_none() {
        return Err(JavisError::Validation(
            "MCP package.json must define a bin entry so it can run through npx.".to_string(),
        ));
    }
    if !package_has_mcp_signal(&package) {
        return Err(JavisError::Validation(
            "MCP package.json does not look like a Model Context Protocol server; expected MCP keywords, package metadata, or @modelcontextprotocol/sdk dependency.".to_string(),
        ));
    }

    let server_name = github_mcp_server_name(&github);
    let managed_root = javis_mcp_server_root()?;
    let managed_dir = managed_root.join(&server_name);
    replace_managed_mcp_dir(&managed_root, &managed_dir)?;
    if let Err(error) = copy_dir_all_without_git(&temp_dir, &managed_dir) {
        let _ = fs::remove_dir_all(&managed_dir);
        return Err(JavisError::Io(format!(
            "Cannot copy MCP server into Javis config: {error}"
        )));
    }
    let package_relative_dir = package_path
        .parent()
        .and_then(|parent| parent.strip_prefix(&temp_dir).ok())
        .unwrap_or_else(|| Path::new(""));
    let managed_package_dir = managed_dir.join(package_relative_dir);
    let _ = fs::remove_dir_all(&temp_dir);
    let summary = local_mcp_install_summary(server_name, &managed_package_dir);
    upsert_codex_mcp_server(&summary)?;
    Ok(summary)
}

fn local_mcp_install_summary(server_name: String, package_dir: &Path) -> InstallMcpServerSummary {
    let package_dir_text = package_dir.to_string_lossy().to_string();
    InstallMcpServerSummary {
        name: server_name,
        transport: "stdio".to_string(),
        command: Some(default_npx_command()),
        url: None,
        args: vec!["-y".to_string(), package_dir_text.clone()],
        cwd: Some(package_dir_text),
        enabled: true,
    }
}

fn default_npx_command() -> String {
    #[cfg(windows)]
    {
        resolve_windows_path_command("npx").unwrap_or_else(|| "npx.cmd".to_string())
    }
    #[cfg(not(windows))]
    {
        "npx".to_string()
    }
}

#[cfg(windows)]
fn resolve_windows_path_command(command: &str) -> Option<String> {
    let path_env = std::env::var_os("PATH")?;
    resolve_windows_path_command_from_env(command, &path_env)
}

#[cfg(windows)]
fn resolve_windows_path_command_from_env(
    command: &str,
    path_env: &std::ffi::OsStr,
) -> Option<String> {
    if command.contains(['\\', '/']) {
        return None;
    }
    let lower = command.to_ascii_lowercase();
    let has_extension = lower.ends_with(".cmd")
        || lower.ends_with(".bat")
        || lower.ends_with(".exe")
        || lower.ends_with(".com");
    let candidates = if has_extension {
        vec![command.to_string()]
    } else {
        vec![
            format!("{command}.cmd"),
            format!("{command}.bat"),
            format!("{command}.exe"),
            format!("{command}.com"),
            command.to_string(),
        ]
    };
    std::env::split_paths(path_env).find_map(|dir| {
        candidates.iter().find_map(|candidate| {
            let path = dir.join(candidate);
            path.is_file().then(|| path.to_string_lossy().to_string())
        })
    })
}

fn package_has_mcp_signal(package: &serde_json::Value) -> bool {
    package_string_field_has_mcp_signal(package, "name")
        || package_string_field_has_mcp_signal(package, "description")
        || package_array_field_has_mcp_signal(package, "keywords")
        || package_object_keys_or_values_have_mcp_signal(package, "scripts")
        || package_object_keys_or_values_have_mcp_signal(package, "dependencies")
        || package_object_keys_or_values_have_mcp_signal(package, "devDependencies")
        || package_object_keys_or_values_have_mcp_signal(package, "peerDependencies")
        || package_object_keys_or_values_have_mcp_signal(package, "optionalDependencies")
}

fn package_string_field_has_mcp_signal(package: &serde_json::Value, field: &str) -> bool {
    package
        .get(field)
        .and_then(|value| value.as_str())
        .is_some_and(text_has_mcp_signal)
}

fn package_array_field_has_mcp_signal(package: &serde_json::Value, field: &str) -> bool {
    package
        .get(field)
        .and_then(|value| value.as_array())
        .is_some_and(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .any(text_has_mcp_signal)
        })
}

fn package_object_keys_or_values_have_mcp_signal(package: &serde_json::Value, field: &str) -> bool {
    package
        .get(field)
        .and_then(|value| value.as_object())
        .is_some_and(|object| {
            object.iter().any(|(key, value)| {
                text_has_mcp_signal(key) || value.as_str().is_some_and(text_has_mcp_signal)
            })
        })
}

fn text_has_mcp_signal(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("@modelcontextprotocol/")
        || lower.contains("model context protocol")
        || lower.contains("model-context-protocol")
        || lower.contains("modelcontextprotocol")
        || lower
            .split(|ch: char| !(ch.is_ascii_alphanumeric()))
            .any(|part| part == "mcp")
}

fn upsert_codex_mcp_server(server: &InstallMcpServerSummary) -> Result<(), JavisError> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| JavisError::Io("Cannot determine home directory".to_string()))?;
    let config_path = codex_config_path(&home_dir);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| JavisError::Io(format!("Cannot create Codex config directory: {e}")))?;
    }
    let content = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|e| JavisError::Io(format!("Cannot read Codex config: {e}")))?
    } else {
        String::new()
    };
    let next_content = upsert_codex_mcp_server_in_toml(&content, server);
    let tmp_path = config_path.with_extension("toml.tmp");
    fs::write(&tmp_path, next_content)
        .map_err(|e| JavisError::Io(format!("Cannot write Codex config: {e}")))?;
    fs::rename(&tmp_path, &config_path)
        .map_err(|e| JavisError::Io(format!("Cannot finalize Codex config: {e}")))?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubRepo {
    owner: String,
    repo: String,
    branch: Option<String>,
    subdir: Option<PathBuf>,
}

fn parse_github_repo_url(url: &str) -> Option<GithubRepo> {
    let trimmed = url.trim();
    let rest = trimmed.strip_prefix("https://github.com/")?;
    let rest = rest
        .split(['?', '#'])
        .next()
        .unwrap_or(rest)
        .trim_matches('/');
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim().trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    if !is_safe_github_segment(owner) || !is_safe_github_segment(repo) {
        return None;
    }
    let (branch, subdir) = parse_github_tree_subdir(parts.collect::<Vec<_>>().as_slice())?;
    Some(GithubRepo {
        owner: owner.to_string(),
        repo: repo.to_string(),
        branch,
        subdir,
    })
}

fn is_safe_github_segment(value: &str) -> bool {
    if value == "." || value == ".." || value.contains("..") {
        return false;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
}

fn parse_github_tree_subdir(parts: &[&str]) -> Option<(Option<String>, Option<PathBuf>)> {
    if parts.is_empty() {
        return Some((None, None));
    }
    let view = parts.first().copied()?;
    if !matches!(view, "tree" | "blob") || parts.len() < 3 {
        return None;
    }
    let branch = parts[1].trim();
    if !is_safe_github_segment(branch) {
        return None;
    }
    let path_parts = if view == "blob" {
        if parts.last().copied() != Some("package.json") {
            return None;
        }
        &parts[2..parts.len() - 1]
    } else {
        &parts[2..]
    };
    let mut subdir = PathBuf::new();
    for part in path_parts {
        let segment = part.trim();
        if !is_safe_github_segment(segment) {
            return None;
        }
        subdir.push(segment);
    }
    Some((
        Some(branch.to_string()),
        (!subdir.as_os_str().is_empty()).then_some(subdir),
    ))
}

fn github_clone_url(github: &GithubRepo) -> String {
    format!("https://github.com/{}/{}.git", github.owner, github.repo)
}

fn sanitize_mcp_name(value: &str) -> Option<String> {
    let sanitized: String = value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_' || *ch == '.')
        .take(80)
        .collect();
    (!sanitized.is_empty()).then_some(sanitized)
}

fn github_mcp_server_name(github: &GithubRepo) -> String {
    let mut raw = format!("{}-{}", github.owner, github.repo);
    if let Some(subdir) = &github.subdir {
        for component in subdir.components() {
            raw.push('-');
            raw.push_str(&component.as_os_str().to_string_lossy());
        }
    }
    sanitize_mcp_name(&raw).unwrap_or_else(|| github.repo.clone())
}

fn javis_mcp_server_root() -> Result<PathBuf, JavisError> {
    dirs::config_dir()
        .map(|config_dir| config_dir.join("javis").join("mcp-servers"))
        .ok_or_else(|| JavisError::Io("Cannot determine Javis config directory".to_string()))
}

fn replace_managed_mcp_dir(root: &Path, target: &Path) -> Result<(), JavisError> {
    fs::create_dir_all(root)
        .map_err(|error| JavisError::Io(format!("Cannot create MCP install root: {error}")))?;
    if target.exists() {
        let root_canonical = root
            .canonicalize()
            .map_err(|error| JavisError::Io(format!("Cannot resolve MCP install root: {error}")))?;
        let target_canonical = target.canonicalize().map_err(|error| {
            JavisError::Io(format!("Cannot resolve MCP install target: {error}"))
        })?;
        if !target_canonical.starts_with(&root_canonical) || target_canonical == root_canonical {
            return Err(JavisError::Validation(
                "Refusing to replace MCP install target outside the Javis MCP root.".to_string(),
            ));
        }
        fs::remove_dir_all(target).map_err(|error| {
            JavisError::Io(format!(
                "Cannot replace existing MCP install target: {error}"
            ))
        })?;
    }
    Ok(())
}

#[derive(Default)]
struct McpInstallCopyBudget {
    files: usize,
    total_bytes: u64,
}

fn copy_dir_all_without_git(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    let mut budget = McpInstallCopyBudget::default();
    copy_dir_all_without_git_limited(source, target, &mut budget)
}

fn copy_dir_all_without_git_limited(
    source: &Path,
    target: &Path,
    budget: &mut McpInstallCopyBudget,
) -> Result<(), std::io::Error> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_name = entry.file_name();
        if should_skip_mcp_install_copy_entry(&file_name.to_string_lossy()) {
            continue;
        }
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let source_path = entry.path();
        let target_path = target.join(file_name);
        if source_path.is_dir() {
            copy_dir_all_without_git_limited(&source_path, &target_path, budget)?;
        } else if source_path.is_file() {
            let bytes = entry.metadata()?.len();
            reserve_mcp_install_copy_file(&source_path, bytes, budget)?;
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn should_skip_mcp_install_copy_entry(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".cache"
            | "__pycache__"
    )
}

fn reserve_mcp_install_copy_file(
    path: &Path,
    bytes: u64,
    budget: &mut McpInstallCopyBudget,
) -> Result<(), std::io::Error> {
    if bytes > MCP_INSTALL_FILE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "MCP install file is too large: {} ({} bytes)",
                path.display(),
                bytes
            ),
        ));
    }
    if budget.files + 1 > MCP_INSTALL_MAX_FILES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("MCP install exceeds {MCP_INSTALL_MAX_FILES} files."),
        ));
    }
    if budget.total_bytes.saturating_add(bytes) > MCP_INSTALL_TOTAL_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("MCP install exceeds {MCP_INSTALL_TOTAL_BYTES} bytes."),
        ));
    }
    budget.files += 1;
    budget.total_bytes += bytes;
    Ok(())
}

fn parse_mcp_server_env_table_name(table: &str) -> Option<String> {
    let value = table.strip_prefix("mcp_servers.")?;
    if value.starts_with('"') {
        let (name, rest) = parse_quoted_toml_key(value, '"')?;
        return (rest == ".env").then_some(name);
    }
    if value.starts_with('\'') {
        let (name, rest) = parse_quoted_toml_key(value, '\'')?;
        return (rest == ".env").then_some(name);
    }
    value
        .strip_suffix(".env")
        .filter(|name| !name.contains('.'))
        .map(ToString::to_string)
}

fn parse_mcp_server_table_name(table: &str) -> Option<String> {
    let value = table.strip_prefix("mcp_servers.")?;
    if value.ends_with(".env") {
        return None;
    }
    if value.starts_with('"') {
        let (name, rest) = parse_quoted_toml_key(value, '"')?;
        return rest.is_empty().then_some(name);
    }
    if value.starts_with('\'') {
        let (name, rest) = parse_quoted_toml_key(value, '\'')?;
        return rest.is_empty().then_some(name);
    }
    (!value.contains('.')).then(|| value.to_string())
}

fn is_mcp_server_table_for_name(table: &str, name: &str) -> bool {
    let Some(value) = table.strip_prefix("mcp_servers.") else {
        return false;
    };
    if value.starts_with('"') {
        let Some((parsed_name, rest)) = parse_quoted_toml_key(value, '"') else {
            return false;
        };
        return parsed_name == name && (rest.is_empty() || rest.starts_with('.'));
    }
    if value.starts_with('\'') {
        let Some((parsed_name, rest)) = parse_quoted_toml_key(value, '\'') else {
            return false;
        };
        return parsed_name == name && (rest.is_empty() || rest.starts_with('.'));
    }
    value == name
        || value
            .strip_prefix(name)
            .is_some_and(|rest| rest.starts_with('.'))
}

fn parse_quoted_toml_key(value: &str, quote: char) -> Option<(String, &str)> {
    let mut escaped = false;
    let mut output = String::new();
    let mut chars = value.char_indices();
    let (_, first) = chars.next()?;
    if first != quote {
        return None;
    }
    for (index, ch) in chars {
        if escaped {
            output.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
            continue;
        }
        if quote == '"' && ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return Some((output, &value[index + ch.len_utf8()..]));
        }
        output.push(ch);
    }
    None
}

fn toml_key(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        value.to_string()
    } else {
        toml_string(value)
    }
}

fn toml_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    format!("\"{escaped}\"")
}

fn find_package_json(root: &Path) -> Result<PathBuf, std::io::Error> {
    let direct = root.join("package.json");
    if direct.is_file() {
        return Ok(direct);
    }
    let mut matches = Vec::new();
    collect_package_json(root, 0, &mut matches)?;
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "GitHub repository does not contain package.json.",
        )),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "GitHub repository contains multiple package.json files; install a single MCP package repository.",
        )),
    }
}

fn collect_package_json(
    dir: &Path,
    depth: usize,
    matches: &mut Vec<PathBuf>,
) -> Result<(), std::io::Error> {
    if depth > 2 {
        return Ok(());
    }
    if dir.file_name().and_then(|name| name.to_str()) == Some(".git") {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|name| name.to_str()) == Some("package.json")
        {
            matches.push(path);
        } else if path.is_dir() {
            collect_package_json(&path, depth + 1, matches)?;
        }
    }
    Ok(())
}

fn unquote_toml_value(value: &str) -> Option<String> {
    let without_comment = strip_toml_inline_comment(value);
    let trimmed = without_comment.trim();
    let (parsed, rest) = parse_toml_string_literal(trimmed)?;
    rest.trim().is_empty().then_some(parsed)
}

fn parse_toml_string_literal(value: &str) -> Option<(String, &str)> {
    let mut chars = value.char_indices();
    let (_, quote) = chars.next()?;
    if quote == '\'' {
        for (index, ch) in chars {
            if ch == '\'' {
                return Some((value[1..index].to_string(), &value[index + ch.len_utf8()..]));
            }
        }
        return None;
    }
    if quote != '"' {
        return None;
    }

    let mut escaped = false;
    let mut output = String::new();
    for (index, ch) in chars {
        if escaped {
            output.push(match ch {
                '"' => '"',
                '\\' => '\\',
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'b' => '\u{0008}',
                'f' => '\u{000c}',
                other => other,
            });
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return Some((output, &value[index + ch.len_utf8()..]));
        }
        output.push(ch);
    }
    None
}

fn parse_toml_bool(value: &str) -> Option<bool> {
    match strip_toml_inline_comment(value).trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn strip_toml_inline_comment(value: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (index, ch) in value.char_indices() {
        if let Some(active_quote) = quote {
            if active_quote == '"' && ch == '\\' && !escaped {
                escaped = true;
                continue;
            }
            if ch == active_quote && !escaped {
                quote = None;
            }
            escaped = false;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch == '#' {
            return &value[..index];
        }
    }
    value
}

fn parse_toml_string_array(value: &str) -> Vec<String> {
    let without_comment = strip_toml_inline_comment(value);
    let trimmed = without_comment.trim();
    let Some(mut rest) = trimmed.strip_prefix('[') else {
        return Vec::new();
    };
    let mut values = Vec::new();
    loop {
        rest = rest.trim_start();
        if let Some(after_close) = rest.strip_prefix(']') {
            return if after_close.trim().is_empty() {
                values
            } else {
                Vec::new()
            };
        }
        let Some((value, after_value)) = parse_toml_string_literal(rest) else {
            return Vec::new();
        };
        values.push(value);
        rest = after_value.trim_start();
        if let Some(after_comma) = rest.strip_prefix(',') {
            rest = after_comma;
            continue;
        }
        if rest.starts_with(']') {
            continue;
        }
        return Vec::new();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    const FAKE_MCP_SERVER_PS1: &str = r#"
$ErrorActionPreference = 'Stop'

function Read-McpMessage {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { return $null }
  if ($line.StartsWith('Content-Length:')) {
    $length = [int]$line.Substring('Content-Length:'.Length).Trim()
    while ($true) {
      $header = [Console]::In.ReadLine()
      if ($null -eq $header) { return $null }
      if ($header.Trim().Length -eq 0) { break }
    }
    $chars = New-Object char[] $length
    $read = 0
    while ($read -lt $length) {
      $count = [Console]::In.Read($chars, $read, $length - $read)
      if ($count -le 0) { break }
      $read += $count
    }
    return -join $chars
  }
  return $line
}

function Write-McpMessage($payload) {
  $json = ConvertTo-Json $payload -Compress -Depth 20
  $length = [Text.Encoding]::UTF8.GetByteCount($json)
  [Console]::Out.Write("Content-Length: $length`r`n`r`n$json")
  [Console]::Out.Flush()
}

while ($true) {
  $raw = Read-McpMessage
  if ([string]::IsNullOrEmpty($raw)) { break }
  $message = $raw | ConvertFrom-Json
  if ($message.method -eq 'initialize') {
    Write-McpMessage @{
      jsonrpc = '2.0'
      id = $message.id
      result = @{
        protocolVersion = '2024-11-05'
        capabilities = @{}
      }
    }
    continue
  }
  if ($message.method -eq 'notifications/initialized') {
    continue
  }
  if ($message.method -eq 'tools/list') {
    Write-McpMessage @{
      jsonrpc = '2.0'
      id = $message.id
      result = @{
        tools = @(
          @{ name = 'search'; annotations = @{ readOnlyHint = $true } },
          @{ name = 'write_file'; annotations = @{ readOnlyHint = $true } }
        )
      }
    }
    continue
  }
  if ($message.method -eq 'tools/call') {
    Write-McpMessage @{
      jsonrpc = '2.0'
      id = $message.id
      result = @{
        name = $message.params.name
        arguments = $message.params.arguments
      }
    }
    continue
  }
  Write-McpMessage @{
    jsonrpc = '2.0'
    id = $message.id
    result = $null
  }
}
"#;

    #[test]
    fn write_mcp_config_rejects_invalid_json() {
        let result = write_mcp_config_impl("not valid json");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Invalid JSON"));
    }

    #[test]
    fn write_mcp_config_accepts_valid_json() {
        let config = serde_json::json!({"mcpServers": {}});
        let json = serde_json::to_string(&config).unwrap();
        // Valid JSON must pass the validation gate; the impl may fail
        // on dirs::config_dir() resolution but that's environment-specific
        let result = write_mcp_config_impl(&json);
        // If it fails, it must NOT be a Validation error
        if let Err(e) = &result {
            assert!(
                !e.to_string().contains("Invalid JSON"),
                "Valid JSON should not trigger validation error: {e}"
            );
        }
    }

    #[test]
    fn read_mcp_config_returns_none_when_missing() {
        // dirs::config_dir() is system-dependent; just verify the function
        // doesn't panic on None case
        let result = read_mcp_config_impl();
        // Should be Ok(None) if no config exists, or Ok(Some(...)) if it does
        assert!(result.is_ok());
    }

    #[test]
    fn clamps_mcp_request_timeout() {
        assert_eq!(
            mcp_request_timeout(Some(250)).as_millis(),
            MCP_MIN_REQUEST_TIMEOUT_MS as u128
        );
        assert_eq!(mcp_request_timeout(Some(5_000)).as_millis(), 5_000);
        assert_eq!(
            mcp_request_timeout(Some(120_000)).as_millis(),
            MCP_MAX_REQUEST_TIMEOUT_MS as u128
        );
        assert_eq!(
            mcp_request_timeout(None).as_millis(),
            MCP_DEFAULT_REQUEST_TIMEOUT_MS as u128
        );
    }

    #[test]
    fn extracts_mcp_call_arguments_from_direct_arguments_first() {
        let request = McpToolCallRequest {
            server_name: "filesystem".to_string(),
            source: Some("javis".to_string()),
            action: Some("callTool".to_string()),
            tool_name: Some("search".to_string()),
            arguments: Some(serde_json::json!({"query": "direct"})),
            input: Some(serde_json::json!({
                "arguments": {"query": "nested"},
                "parameters": {"query": "parameters"}
            })),
            timeout_ms: None,
        };

        assert_eq!(
            mcp_call_tool_arguments(&request),
            serde_json::json!({"query": "direct"})
        );
    }

    #[test]
    fn extracts_mcp_call_arguments_from_parameter_wrappers() {
        let request = McpToolCallRequest {
            server_name: "filesystem".to_string(),
            source: Some("javis".to_string()),
            action: Some("callTool".to_string()),
            tool_name: Some("search".to_string()),
            arguments: None,
            input: Some(serde_json::json!({"parameters": {"query": "parameters"}})),
            timeout_ms: None,
        };
        assert_eq!(
            mcp_call_tool_arguments(&request),
            serde_json::json!({"query": "parameters"})
        );

        let request = McpToolCallRequest {
            input: Some(serde_json::json!({"input": {"query": "input"}})),
            ..request
        };
        assert_eq!(
            mcp_call_tool_arguments(&request),
            serde_json::json!({"query": "input"})
        );
    }

    #[test]
    fn mcp_stderr_tail_is_bounded_and_appended_to_errors() {
        let mut tail = String::new();
        append_bounded_text_tail(&mut tail, "abcdef", 4);

        assert_eq!(tail, "cdef");
        assert_eq!(
            append_mcp_stderr_tail_to_message("MCP response reader stopped.", &tail),
            "MCP response reader stopped. MCP stderr tail: cdef"
        );
    }

    #[test]
    fn mcp_stderr_tail_strips_nul_bytes() {
        assert_eq!(
            append_mcp_stderr_tail_to_message("failed", "line\0with nul"),
            "failed MCP stderr tail: linewith nul"
        );
    }

    #[test]
    fn allows_only_discovered_read_only_mcp_tools() {
        let list = serde_json::json!({
            "tools": [
                {"name": "custom_lookup", "annotations": {"readOnlyHint": true}},
                {"name": "read_file"},
                {"name": "search"},
                {"name": "transform_dataset"},
                {"name": "write_file", "annotations": {"readOnlyHint": true}},
                {"name": "writeFile", "annotations": {"readOnlyHint": true}},
                {"name": "deletefile", "annotations": {"readOnlyHint": true}},
                {"name": "run command", "annotations": {"readOnlyHint": true}},
                {"name": "save_note", "annotations": {"readOnlyHint": true}},
                {"name": "replaceDocument", "annotations": {"readOnlyHint": true}},
                {"name": "insert_row", "annotations": {"readOnlyHint": true}},
                {"name": "drop_table", "annotations": {"readOnlyHint": true}},
                {"name": "commit_changes", "annotations": {"readOnlyHint": true}},
                {"name": "push_branch", "annotations": {"readOnlyHint": true}},
                {"name": "download_file", "annotations": {"readOnlyHint": true}},
                {"name": "danger", "annotations": {"destructiveHint": true}}
            ]
        });

        assert!(is_read_only_mcp_tool_in_list(&list, "custom_lookup"));
        assert!(is_read_only_mcp_tool_in_list(&list, "read_file"));
        assert!(is_read_only_mcp_tool_in_list(&list, "search"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "transform_dataset"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "write_file"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "writeFile"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "deletefile"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "run command"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "save_note"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "replaceDocument"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "insert_row"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "drop_table"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "commit_changes"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "push_branch"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "download_file"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "danger"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "missing"));
    }

    #[test]
    fn caches_read_only_mcp_tool_allowlists_per_server_signature() {
        let server = test_mcp_server("filesystem");
        MCP_READONLY_TOOL_ALLOWLIST_CACHE.lock().unwrap().clear();
        let list = serde_json::json!({
            "tools": [
                {"name": "search"},
                {"name": "write_file", "annotations": {"readOnlyHint": true}},
                {"name": "custom_lookup", "annotations": {"readOnlyHint": true}}
            ]
        });

        update_mcp_readonly_tool_allowlist_cache(&server, &list);

        assert_eq!(
            cached_mcp_readonly_tool_allowlist_contains(&server, "search"),
            Some(true)
        );
        assert_eq!(
            cached_mcp_readonly_tool_allowlist_contains(&server, "custom_lookup"),
            Some(true)
        );
        assert_eq!(
            cached_mcp_readonly_tool_allowlist_contains(&server, "write_file"),
            Some(false)
        );

        let mut changed_server = server.clone();
        changed_server.args.push("--changed".to_string());
        assert_eq!(
            cached_mcp_readonly_tool_allowlist_contains(&changed_server, "search"),
            None
        );
    }

    #[test]
    fn mcp_install_copy_skips_dependency_and_build_dirs() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source = temp_dir.path().join("source");
        let target = temp_dir.path().join("target");
        fs::create_dir_all(source.join("node_modules").join("package")).unwrap();
        fs::create_dir_all(source.join("dist")).unwrap();
        fs::write(source.join("package.json"), r#"{"name":"demo-mcp"}"#).unwrap();
        fs::write(
            source.join("node_modules").join("package").join("index.js"),
            "ignored",
        )
        .unwrap();
        fs::write(source.join("dist").join("bundle.js"), "ignored").unwrap();

        copy_dir_all_without_git(&source, &target).unwrap();

        assert!(target.join("package.json").is_file());
        assert!(!target.join("node_modules").exists());
        assert!(!target.join("dist").exists());
    }

    #[test]
    fn mcp_install_copy_rejects_oversized_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source = temp_dir.path().join("source");
        let target = temp_dir.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("package.json"), r#"{"name":"demo-mcp"}"#).unwrap();
        fs::File::create(source.join("large.bin"))
            .unwrap()
            .set_len(MCP_INSTALL_FILE_BYTES + 1)
            .unwrap();

        let error = copy_dir_all_without_git(&source, &target).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("too large"));
    }

    #[test]
    fn package_has_mcp_signal_from_sdk_dependency_or_metadata() {
        assert!(package_has_mcp_signal(&serde_json::json!({
            "name": "filesystem-server",
            "bin": "index.js",
            "dependencies": {
                "@modelcontextprotocol/sdk": "^1.0.0"
            }
        })));
        assert!(package_has_mcp_signal(&serde_json::json!({
            "name": "custom-mcp-server",
            "bin": "index.js"
        })));
        assert!(package_has_mcp_signal(&serde_json::json!({
            "name": "server",
            "bin": "index.js",
            "keywords": ["Model Context Protocol", "tools"]
        })));
    }

    #[test]
    fn package_has_mcp_signal_rejects_plain_cli_package() {
        assert!(!package_has_mcp_signal(&serde_json::json!({
            "name": "plain-cli",
            "description": "A normal command line utility.",
            "bin": "index.js",
            "dependencies": {
                "commander": "^12.0.0"
            }
        })));
    }

    fn test_mcp_server(name: &str) -> CodexMcpServerSummary {
        CodexMcpServerSummary {
            name: name.to_string(),
            transport: "stdio".to_string(),
            command: Some("npx".to_string()),
            url: None,
            args: vec!["-y".to_string(), "@demo/mcp".to_string()],
            cwd: Some("E:/Javis".to_string()),
            env: BTreeMap::new(),
            enabled: true,
            source: "javis".to_string(),
            removable: true,
        }
    }

    #[test]
    fn parses_codex_mcp_servers_from_config_toml() {
        let servers = parse_codex_mcp_servers(
            r#"
[mcp_servers.godot-mcp]
# javis-managed = true
type = "stdio"
command = 'C:\Program Files\nodejs\npx.cmd'
args = ["-y", "gopeak"]
cwd = 'E:\Javis'

[mcp_servers.godot-mcp.env]
GODOT_PATH = 'C:\godot.exe'
"#,
        );

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "godot-mcp");
        assert_eq!(servers[0].transport, "stdio");
        assert_eq!(
            servers[0].command.as_deref(),
            Some(r"C:\Program Files\nodejs\npx.cmd"),
        );
        assert_eq!(
            servers[0].args,
            vec!["-y".to_string(), "gopeak".to_string()]
        );
        assert_eq!(servers[0].cwd.as_deref(), Some(r"E:\Javis"));
        assert_eq!(
            servers[0].env.get("GODOT_PATH").map(String::as_str),
            Some(r"C:\godot.exe")
        );
        assert!(servers[0].removable);
    }

    #[test]
    fn parses_codex_mcp_enabled_false_with_inline_comment() {
        let servers = parse_codex_mcp_servers(
            r#"
[mcp_servers.filesystem]
type = "stdio"
command = "npx"
enabled = false # disabled by user
"#,
        );

        assert_eq!(servers.len(), 1);
        assert!(!servers[0].enabled);
    }

    #[test]
    fn strips_toml_inline_comments_outside_quotes() {
        assert_eq!(parse_toml_bool("false # disabled"), Some(false));
        assert_eq!(
            unquote_toml_value(r#""value # not comment" # comment"#).as_deref(),
            Some("value # not comment")
        );
    }

    #[test]
    fn parses_toml_string_arrays_without_splitting_quoted_commas() {
        assert_eq!(
            parse_toml_string_array(r#"["-y", "pkg,with,commas", 'literal,comma']"#),
            vec![
                "-y".to_string(),
                "pkg,with,commas".to_string(),
                "literal,comma".to_string(),
            ]
        );
    }

    #[test]
    fn unquotes_common_double_quoted_toml_escapes() {
        assert_eq!(
            unquote_toml_value(r#""C:\\Users\\demo\\mcp server""#).as_deref(),
            Some(r#"C:\Users\demo\mcp server"#)
        );
        assert_eq!(
            parse_toml_string_array(r#"["line\nbreak", "quote\"value"]"#),
            vec!["line\nbreak".to_string(), "quote\"value".to_string()]
        );
    }

    #[test]
    fn validates_display_mcp_names_without_allowing_paths() {
        assert!(validate_mcp_name("@scope/filesystem server").is_ok());
        assert!(validate_mcp_name("filesystem").is_ok());
        assert!(validate_mcp_name("").is_err());
        assert!(validate_mcp_name(" filesystem").is_err());
        assert!(validate_mcp_name("../filesystem").is_err());
        assert!(validate_mcp_name(r"..\filesystem").is_err());
        assert!(validate_mcp_name("filesystem..backup").is_err());
    }

    #[test]
    fn reads_newline_delimited_mcp_messages() {
        let mut reader =
            std::io::Cursor::new(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n");

        let message = read_mcp_message(&mut reader).unwrap();

        assert_eq!(message["result"]["ok"], true);
    }

    #[test]
    fn reads_content_length_mcp_messages() {
        let body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}";
        let framed = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        let mut reader = std::io::Cursor::new(framed.into_bytes());

        let message = read_mcp_message(&mut reader).unwrap();

        assert_eq!(message["result"]["ok"], true);
    }

    #[test]
    fn rejects_oversized_content_length_mcp_messages() {
        let framed = format!("Content-Length: {}\r\n\r\n", MCP_MAX_RESPONSE_BYTES + 1);
        let mut reader = std::io::Cursor::new(framed.into_bytes());

        let error = read_mcp_message(&mut reader).unwrap_err();

        assert!(error.contains("exceeds"));
    }

    #[test]
    fn rejects_oversized_newline_delimited_mcp_messages() {
        let mut payload = vec![b' '; MCP_MAX_RESPONSE_BYTES + 1];
        payload.push(b'\n');
        let mut reader = std::io::Cursor::new(payload);

        let error = read_mcp_message(&mut reader).unwrap_err();

        assert!(error.contains("exceeds"));
    }

    #[cfg(windows)]
    #[test]
    fn stdio_mcp_client_talks_to_fake_server_over_json_rpc_frames() {
        let temp_dir = tempfile::tempdir().unwrap();
        let script_path = temp_dir.path().join("fake-mcp-server.ps1");
        fs::write(&script_path, FAKE_MCP_SERVER_PS1).unwrap();
        let server = CodexMcpServerSummary {
            name: "fake".to_string(),
            transport: "stdio".to_string(),
            command: Some("powershell".to_string()),
            url: None,
            args: vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                script_path.to_string_lossy().to_string(),
            ],
            cwd: None,
            env: BTreeMap::new(),
            enabled: true,
            source: "javis".to_string(),
            removable: true,
        };
        let timeout = Duration::from_secs(5);
        let mut client = StdioMcpClient::start(&server).unwrap();

        client.initialize(timeout).unwrap();
        let list = client
            .request("tools/list", serde_json::json!({}), timeout)
            .unwrap();
        assert!(is_read_only_mcp_tool_in_list(&list, "search"));
        assert!(!is_read_only_mcp_tool_in_list(&list, "write_file"));

        let result = client
            .request(
                "tools/call",
                serde_json::json!({
                    "name": "search",
                    "arguments": {"query": "demo"}
                }),
                timeout,
            )
            .unwrap();

        assert_eq!(result["name"], "search");
        assert_eq!(result["arguments"]["query"], "demo");
    }

    #[test]
    fn updates_codex_mcp_enabled_in_config_toml() {
        let content = r#"
[mcp_servers.filesystem]
type = "stdio"
enabled = true

[mcp_servers.filesystem.env]
ROOT = "E:/Javis"

[mcp_servers.other]
type = "stdio"
"#;

        let updated = set_codex_mcp_enabled_in_toml(content, "filesystem", false).unwrap();
        let servers = parse_codex_mcp_servers(&updated);

        assert!(updated.contains("enabled = false"));
        assert_eq!(servers.len(), 2);
        assert!(
            !servers
                .iter()
                .find(|server| server.name == "filesystem")
                .unwrap()
                .enabled
        );
        assert!(
            servers
                .iter()
                .find(|server| server.name == "other")
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn inserts_codex_mcp_enabled_when_missing() {
        let content =
            "[mcp_servers.filesystem]\ntype = \"stdio\"\n\n[mcp_servers.other]\ntype = \"stdio\"\n";

        let updated = set_codex_mcp_enabled_in_toml(content, "filesystem", false).unwrap();
        let servers = parse_codex_mcp_servers(&updated);

        assert!(
            !servers
                .iter()
                .find(|server| server.name == "filesystem")
                .unwrap()
                .enabled
        );
        assert!(
            servers
                .iter()
                .find(|server| server.name == "other")
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn updates_quoted_codex_mcp_enabled_in_config_toml() {
        let content = r#"
[mcp_servers."@scope/filesystem server"]
type = "stdio"
command = "npx"

[mcp_servers.other]
type = "stdio"
"#;

        let updated =
            set_codex_mcp_enabled_in_toml(content, "@scope/filesystem server", false).unwrap();
        let servers = parse_codex_mcp_servers(&updated);

        assert!(
            !servers
                .iter()
                .find(|server| server.name == "@scope/filesystem server")
                .unwrap()
                .enabled
        );
        assert!(
            servers
                .iter()
                .find(|server| server.name == "other")
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn returns_none_for_missing_codex_mcp_server() {
        assert!(set_codex_mcp_enabled_in_toml(
            "[mcp_servers.other]\ntype = \"stdio\"\n",
            "missing",
            false
        )
        .is_none());
    }

    #[test]
    fn upserts_javis_managed_codex_mcp_server() {
        let content = "[mcp_servers.other]\ntransport = \"stdio\"\n";
        let server = InstallMcpServerSummary {
            name: "demo-mcp".to_string(),
            transport: "stdio".to_string(),
            command: Some("npx".to_string()),
            url: None,
            args: vec!["-y".to_string(), "@demo/mcp".to_string()],
            cwd: Some("C:/Users/example/AppData/Roaming/javis/mcp-servers/demo-mcp".to_string()),
            enabled: true,
        };

        let updated = upsert_codex_mcp_server_in_toml(content, &server);
        let servers = parse_codex_mcp_servers(&updated);
        let installed = servers.iter().find(|item| item.name == "demo-mcp").unwrap();

        assert!(updated.contains("# javis-managed = true"));
        assert_eq!(installed.command.as_deref(), Some("npx"));
        assert_eq!(
            installed.args,
            vec!["-y".to_string(), "@demo/mcp".to_string()]
        );
        assert_eq!(
            installed.cwd.as_deref(),
            Some("C:/Users/example/AppData/Roaming/javis/mcp-servers/demo-mcp")
        );
        assert!(installed.enabled);
        assert!(installed.removable);
        assert!(servers.iter().any(|item| item.name == "other"));
    }

    #[test]
    fn removes_javis_managed_codex_mcp_server_with_subtables() {
        let content = r#"
[mcp_servers.demo]
# javis-managed = true
transport = "stdio"
command = "npx"

[mcp_servers.demo.env]
TOKEN = "secret"

[mcp_servers.other]
transport = "stdio"
"#;

        let updated = remove_codex_mcp_server_in_toml(content, "demo").unwrap();
        let servers = parse_codex_mcp_servers(&updated);

        assert!(!updated.contains("[mcp_servers.demo]"));
        assert!(!updated.contains("[mcp_servers.demo.env]"));
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "other");
    }

    #[test]
    fn refuses_to_remove_manual_codex_mcp_server() {
        let content = "[mcp_servers.demo]\ntransport = \"stdio\"\ncommand = \"npx\"\n";

        assert!(remove_codex_mcp_server_in_toml(content, "demo").is_none());
    }

    #[test]
    fn parses_safe_github_repo_urls() {
        assert_eq!(
            parse_github_repo_url("https://github.com/modelcontextprotocol/server-filesystem.git"),
            Some(GithubRepo {
                owner: "modelcontextprotocol".to_string(),
                repo: "server-filesystem".to_string(),
                branch: None,
                subdir: None,
            }),
        );
        assert_eq!(
            parse_github_repo_url(
                "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem"
            ),
            Some(GithubRepo {
                owner: "modelcontextprotocol".to_string(),
                repo: "servers".to_string(),
                branch: Some("main".to_string()),
                subdir: Some(PathBuf::from("src").join("filesystem")),
            }),
        );
        assert!(parse_github_repo_url("http://github.com/modelcontextprotocol/server").is_none());
        assert!(
            parse_github_repo_url("https://github.com/modelcontextprotocol/../server").is_none()
        );
        assert_eq!(
            parse_github_repo_url(
                "https://github.com/modelcontextprotocol/servers/blob/main/package.json"
            ),
            Some(GithubRepo {
                owner: "modelcontextprotocol".to_string(),
                repo: "servers".to_string(),
                branch: Some("main".to_string()),
                subdir: None,
            }),
        );
        assert_eq!(
            parse_github_repo_url(
                "https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/package.json"
            ),
            Some(GithubRepo {
                owner: "modelcontextprotocol".to_string(),
                repo: "servers".to_string(),
                branch: Some("main".to_string()),
                subdir: Some(PathBuf::from("src").join("filesystem")),
            }),
        );
        assert!(parse_github_repo_url(
            "https://github.com/modelcontextprotocol/servers/tree/main/../bad"
        )
        .is_none());
    }

    #[test]
    fn builds_distinct_mcp_server_names_for_repo_subdirs() {
        let root_repo =
            parse_github_repo_url("https://github.com/modelcontextprotocol/servers").unwrap();
        let nested_repo = parse_github_repo_url(
            "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
        )
        .unwrap();

        assert_eq!(
            github_mcp_server_name(&root_repo),
            "modelcontextprotocol-servers"
        );
        assert_eq!(
            github_mcp_server_name(&nested_repo),
            "modelcontextprotocol-servers-src-filesystem"
        );
    }

    #[test]
    fn local_mcp_install_summary_runs_managed_package_path() {
        let package_dir =
            PathBuf::from("C:/Users/example/AppData/Roaming/javis/mcp-servers/demo/src/server");
        let summary = local_mcp_install_summary("demo".to_string(), &package_dir);
        let package_dir_text = package_dir.to_string_lossy().to_string();

        assert!(summary.command.as_deref().is_some_and(|command| {
            command == "npx"
                || command == "npx.cmd"
                || command == "npx.bat"
                || command == "npx.exe"
                || command == "npx.com"
                || command.ends_with(r"\npx.cmd")
                || command.ends_with(r"\npx.bat")
                || command.ends_with(r"\npx.exe")
                || command.ends_with(r"\npx.com")
                || command.ends_with("/npx.cmd")
                || command.ends_with("/npx.bat")
                || command.ends_with("/npx.exe")
                || command.ends_with("/npx.com")
        }));
        assert_eq!(
            summary.args,
            vec!["-y".to_string(), package_dir_text.clone()]
        );
        assert_eq!(summary.cwd.as_deref(), Some(package_dir_text.as_str()));
    }

    #[cfg(windows)]
    #[test]
    fn windows_npx_resolution_prefers_cmd_shims_over_extensionless_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let pathless_npx = temp_dir.path().join("npx");
        let cmd_npx = temp_dir.path().join("npx.cmd");
        fs::write(&pathless_npx, "shell script").unwrap();
        fs::write(&cmd_npx, "@echo off").unwrap();
        let path_env = std::env::join_paths([temp_dir.path()]).unwrap();

        assert_eq!(
            resolve_windows_path_command_from_env("npx", &path_env).as_deref(),
            Some(cmd_npx.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn finds_single_package_json() {
        let temp_dir = tempfile::tempdir().unwrap();
        let package_dir = temp_dir.path().join("packages").join("server");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.json"),
            r#"{"name":"demo","bin":"index.js"}"#,
        )
        .unwrap();

        assert_eq!(
            find_package_json(temp_dir.path()).unwrap(),
            package_dir.join("package.json")
        );
    }
}
