use rusqlite::{Connection, OpenFlags};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

static DB: once_cell::sync::Lazy<Mutex<Option<Connection>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

const ALLOWED_TABLES: &[&str] = &[
    "schema_migrations",
    "task_history",
    "recent_workspaces",
    "model_settings",
    "model_profiles",
    "agent_model_overrides",
    "approval_records",
    "tool_call_audit",
    "tool_call_audit_log",
    "scheduled_tasks",
    "user_preferences",
    "task_session_log",
    "file_scan_cache",
    "file_classifications",
    "app_classifications",
    "resource_scan_roots",
    "resource_file_cache",
    "current_goal",
    "goal_events",
    "goal_evaluations",
    "user_profile_memory",
    "agent_session_summaries",
    "agent_memory_facts",
    "agent_memory_facts_fts",
    "memory_injection_logs",
    "vector_index_items",
    "vector_index_buckets",
    "workspace_settings",
];

#[derive(Clone, Copy)]
enum SqlOperation {
    Execute,
    Select,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecordUpsertRequest {
    approval_id: String,
    task_id: String,
    tool_name: String,
    workspace_path: String,
    permission_level: String,
    preview_hash: String,
    expires_at: String,
    status: String,
    created_at: String,
    resolved_at: Option<String>,
    decision: Option<String>,
    permission_request_json: String,
    code_proposed_edit_json: Option<String>,
    record_json: String,
    updated_at: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct ResourceScanRootRecord {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) label: Option<String>,
    pub(crate) kinds_json: String,
    pub(crate) enabled: bool,
    pub(crate) source: String,
    pub(crate) created_at: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceScanRootUpsertRequest {
    id: String,
    path: String,
    label: Option<String>,
    kinds: Vec<String>,
    enabled: bool,
    source: String,
    created_at: String,
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    Ok(data_dir.join("javis.db"))
}

fn with_connection<F, T>(app: &AppHandle, f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let mut guard = DB
        .lock()
        .map_err(|error| format!("Database lock error: {error}"))?;
    if guard.is_none() {
        let path = db_path(app)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create database directory: {error}"))?;
        }
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| format!("Could not open database: {error}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 2000;",
        )
        .map_err(|error| format!("Could not configure database: {error}"))?;
        *guard = Some(conn);
    }
    let conn = guard
        .as_ref()
        .ok_or_else(|| "Database not initialized".to_string())?;
    f(conn)
}

#[tauri::command]
pub fn db_execute(
    app: AppHandle,
    sql: String,
    bind_values: Vec<serde_json::Value>,
) -> Result<(), String> {
    validate_sql(&sql, SqlOperation::Execute)?;
    with_connection(&app, |conn| {
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|error| format!("SQL prepare error: {error}"))?;
        let params: Vec<rusqlite::types::Value> = bind_values
            .into_iter()
            .map(json_to_rusqlite_value)
            .collect();
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();
        stmt.execute(param_refs.as_slice())
            .map_err(|error| format!("SQL execute error: {error}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn db_select(
    app: AppHandle,
    sql: String,
    bind_values: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    validate_sql(&sql, SqlOperation::Select)?;
    with_connection(&app, |conn| {
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|error| format!("SQL prepare error: {error}"))?;
        let params: Vec<rusqlite::types::Value> = bind_values
            .into_iter()
            .map(json_to_rusqlite_value)
            .collect();
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();
        let column_names: Vec<String> = stmt.column_names().iter().map(|n| n.to_string()).collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                let mut map = serde_json::Map::new();
                for (i, name) in column_names.iter().enumerate() {
                    let value = row.get::<_, rusqlite::types::Value>(i)?;
                    map.insert(name.clone(), rusqlite_to_json_value(value));
                }
                Ok(map)
            })
            .map_err(|error| format!("SQL query error: {error}"))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row.map_err(|error| format!("Row read error: {error}"))?);
        }
        Ok(result)
    })
}

#[tauri::command]
pub fn approval_records_upsert(
    app: AppHandle,
    request: ApprovalRecordUpsertRequest,
) -> Result<(), String> {
    validate_approval_record_upsert_request(&request)?;
    with_connection(&app, |conn| {
        conn.execute(
            "INSERT INTO approval_records (
              approval_id,
              task_id,
              tool_name,
              workspace_path,
              permission_level,
              preview_hash,
              expires_at,
              status,
              created_at,
              resolved_at,
              decision,
              permission_request_json,
              code_proposed_edit_json,
              record_json,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(approval_id) DO UPDATE SET
              task_id = excluded.task_id,
              tool_name = excluded.tool_name,
              workspace_path = excluded.workspace_path,
              permission_level = excluded.permission_level,
              preview_hash = excluded.preview_hash,
              expires_at = excluded.expires_at,
              status = excluded.status,
              created_at = excluded.created_at,
              resolved_at = excluded.resolved_at,
              decision = excluded.decision,
              permission_request_json = excluded.permission_request_json,
              code_proposed_edit_json = excluded.code_proposed_edit_json,
              record_json = excluded.record_json,
              updated_at = excluded.updated_at",
            rusqlite::params![
                request.approval_id,
                request.task_id,
                request.tool_name,
                request.workspace_path,
                request.permission_level,
                request.preview_hash,
                request.expires_at,
                request.status,
                request.created_at,
                request.resolved_at,
                request.decision,
                request.permission_request_json,
                request.code_proposed_edit_json,
                request.record_json,
                request.updated_at,
            ],
        )
        .map_err(|error| format!("Approval record upsert error: {error}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn approval_records_prune(app: AppHandle, limit: i64) -> Result<(), String> {
    if !(1..=1000).contains(&limit) {
        return Err("Approval record prune limit is out of range.".to_string());
    }
    with_connection(&app, |conn| {
        conn.execute(
            "DELETE FROM approval_records
             WHERE approval_id NOT IN (
               SELECT approval_id
               FROM approval_records
               ORDER BY created_at DESC
               LIMIT ?
             )",
            [limit],
        )
        .map_err(|error| format!("Approval record prune error: {error}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn resource_scan_roots_list(
    app: AppHandle,
    enabled_only: bool,
) -> Result<Vec<ResourceScanRootRecord>, String> {
    with_connection(&app, |conn| select_resource_scan_roots(conn, enabled_only))
}

#[tauri::command]
pub fn resource_scan_roots_upsert(
    app: AppHandle,
    request: ResourceScanRootUpsertRequest,
) -> Result<(), String> {
    let record = validate_resource_scan_root_upsert_request(request)?;
    with_connection(&app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO resource_scan_roots
               (id, path, label, kinds_json, enabled, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                record.id,
                record.path,
                record.label,
                record.kinds_json,
                if record.enabled { 1 } else { 0 },
                record.source,
                record.created_at,
            ],
        )
        .map_err(|error| format!("Resource scan root upsert error: {error}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn resource_scan_roots_delete(app: AppHandle, id: String) -> Result<(), String> {
    validate_resource_scan_root_id(&id)?;
    with_connection(&app, |conn| {
        conn.execute("DELETE FROM resource_scan_roots WHERE id = ?", [&id])
            .map_err(|error| format!("Resource scan root delete error: {error}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn resource_scan_roots_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    validate_resource_scan_root_id(&id)?;
    with_connection(&app, |conn| {
        conn.execute(
            "UPDATE resource_scan_roots SET enabled = ? WHERE id = ?",
            rusqlite::params![if enabled { 1 } else { 0 }, id],
        )
        .map_err(|error| format!("Resource scan root update error: {error}"))?;
        Ok(())
    })
}

#[tauri::command]
pub fn db_debug_path(app: AppHandle) -> Result<String, String> {
    db_path(&app).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn db_close() -> Result<(), String> {
    close_database()
}

/// Close the database connection with an explicit WAL checkpoint.
/// Must be called before the application exits to prevent data loss.
pub fn close_database() -> Result<(), String> {
    let mut guard = DB
        .lock()
        .map_err(|error| format!("Database lock error: {error}"))?;
    if let Some(conn) = guard.as_ref() {
        // Force WAL checkpoint to flush all pending writes to the main database file.
        // TRUNCATE mode empties the WAL file after a successful checkpoint.
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|error| format!("WAL checkpoint error: {error}"))?;
    }
    *guard = None;
    Ok(())
}

pub(crate) fn resource_scan_roots_for_ids(
    app: &AppHandle,
    ids: &[String],
) -> Result<Vec<ResourceScanRootRecord>, String> {
    let mut records = Vec::new();
    for id in ids {
        let record = resource_scan_root_for_id(app, id)?
            .ok_or_else(|| format!("Unknown resource scan root id: {id}"))?;
        records.push(record);
    }
    Ok(records)
}

pub(crate) fn resource_scan_root_for_id(
    app: &AppHandle,
    id: &str,
) -> Result<Option<ResourceScanRootRecord>, String> {
    validate_resource_scan_root_id(id)?;
    if let Some(record) = default_resource_scan_root_record(id) {
        return Ok(Some(record));
    }
    with_connection(app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, path, label, kinds_json, enabled, source, created_at
                 FROM resource_scan_roots
                 WHERE id = ?",
            )
            .map_err(|error| format!("Resource scan root query prepare error: {error}"))?;
        let mut rows = stmt
            .query([id])
            .map_err(|error| format!("Resource scan root query error: {error}"))?;
        let Some(row) = rows
            .next()
            .map_err(|error| format!("Resource scan root row error: {error}"))?
        else {
            return Ok(None);
        };
        Ok(Some(resource_scan_root_record_from_row(row).map_err(
            |error| format!("Resource scan root row decode error: {error}"),
        )?))
    })
}

fn select_resource_scan_roots(
    conn: &Connection,
    enabled_only: bool,
) -> Result<Vec<ResourceScanRootRecord>, String> {
    let sql = if enabled_only {
        "SELECT id, path, label, kinds_json, enabled, source, created_at
         FROM resource_scan_roots
         WHERE enabled = 1
         ORDER BY source DESC, created_at ASC"
    } else {
        "SELECT id, path, label, kinds_json, enabled, source, created_at
         FROM resource_scan_roots
         ORDER BY source DESC, created_at ASC"
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|error| format!("Resource scan root list prepare error: {error}"))?;
    let rows = stmt
        .query_map([], resource_scan_root_record_from_row)
        .map_err(|error| format!("Resource scan root list error: {error}"))?;
    let mut records = Vec::new();
    for row in rows {
        records.push(row.map_err(|error| format!("Resource scan root row error: {error}"))?);
    }
    Ok(records)
}

fn resource_scan_root_record_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ResourceScanRootRecord> {
    Ok(ResourceScanRootRecord {
        id: row.get(0)?,
        path: row.get(1)?,
        label: row.get(2)?,
        kinds_json: row.get(3)?,
        enabled: row.get::<_, i64>(4)? != 0,
        source: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn validate_resource_scan_root_upsert_request(
    request: ResourceScanRootUpsertRequest,
) -> Result<ResourceScanRootRecord, String> {
    validate_resource_scan_root_id(&request.id)?;
    if request.created_at.trim().is_empty() {
        return Err("Resource scan root createdAt is required.".to_string());
    }
    let kinds_json = validate_resource_scan_root_kinds(&request.kinds)?;
    let source = request.source.trim().to_ascii_lowercase();
    if source != "default" && source != "custom" {
        return Err("Resource scan root source must be default or custom.".to_string());
    }

    let canonical_path = if source == "default" {
        let default = default_resource_scan_root_record(&request.id)
            .ok_or_else(|| "Default resource scan root id is not recognized.".to_string())?;
        ensure_same_canonical_path(&request.path, &default.path)?;
        default.path
    } else {
        validate_custom_resource_scan_root_path(&request.path)?
    };

    Ok(ResourceScanRootRecord {
        id: request.id.trim().to_string(),
        path: canonical_path,
        label: request.label.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        }),
        kinds_json,
        enabled: request.enabled,
        source,
        created_at: request.created_at.trim().to_string(),
    })
}

fn validate_resource_scan_root_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err("Resource scan root id is invalid.".to_string());
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("Resource scan root id contains invalid characters.".to_string());
    }
    Ok(())
}

fn validate_resource_scan_root_kinds(kinds: &[String]) -> Result<String, String> {
    if kinds.is_empty() {
        return Err("Resource scan root kinds cannot be empty.".to_string());
    }
    let mut normalized = Vec::new();
    for kind in kinds {
        let value = kind.trim().to_ascii_lowercase();
        if value != "documents" && value != "images" {
            return Err("Resource scan root kind must be documents or images.".to_string());
        }
        if !normalized.contains(&value) {
            normalized.push(value);
        }
    }
    serde_json::to_string(&normalized)
        .map_err(|error| format!("Could not serialize resource scan root kinds: {error}"))
}

fn validate_custom_resource_scan_root_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Resource scan root path cannot be empty.".to_string());
    }
    let canonical = std::fs::canonicalize(trimmed)
        .map_err(|error| format!("Could not resolve resource scan root path: {error}"))?;
    if !canonical.is_dir() {
        return Err("Resource scan root path must be a directory.".to_string());
    }
    let home = dirs::home_dir()
        .ok_or_else(|| "Could not resolve user home directory.".to_string())?
        .canonicalize()
        .map_err(|error| format!("Could not resolve user home directory: {error}"))?;
    if !canonical.starts_with(&home) {
        return Err(
            "Custom resource scan roots must be inside the user home directory.".to_string(),
        );
    }
    if is_sensitive_resource_scan_root_path(&canonical) {
        return Err("Refusing to register a sensitive resource scan root.".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

fn ensure_same_canonical_path(left: &str, right: &str) -> Result<(), String> {
    let left = std::fs::canonicalize(left)
        .map_err(|error| format!("Could not resolve resource scan root path: {error}"))?;
    let right = std::fs::canonicalize(right)
        .map_err(|error| format!("Could not resolve default resource scan root path: {error}"))?;
    if left == right {
        Ok(())
    } else {
        Err("Default resource scan root path does not match the native default.".to_string())
    }
}

fn default_resource_scan_root_record(id: &str) -> Option<ResourceScanRootRecord> {
    let home = dirs::home_dir()?;
    let (path, label, kinds_json) = match id.trim() {
        "default-desktop" => (
            home.join("Desktop"),
            Some("Desktop".to_string()),
            r#"["documents","images"]"#.to_string(),
        ),
        "default-documents" => (
            home.join("Documents"),
            Some("Documents".to_string()),
            r#"["documents"]"#.to_string(),
        ),
        "default-downloads" => (
            home.join("Downloads"),
            Some("Downloads".to_string()),
            r#"["documents","images"]"#.to_string(),
        ),
        "default-pictures" => (
            home.join("Pictures"),
            Some("Pictures".to_string()),
            r#"["images"]"#.to_string(),
        ),
        _ => return None,
    };
    Some(ResourceScanRootRecord {
        id: id.trim().to_string(),
        path: path.to_string_lossy().to_string(),
        label,
        kinds_json,
        enabled: true,
        source: "default".to_string(),
        created_at: "1970-01-01T00:00:00.000Z".to_string(),
    })
}

fn is_sensitive_resource_scan_root_path(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        matches!(
            value.as_str(),
            ".aws"
                | ".azure"
                | ".docker"
                | ".gnupg"
                | ".kube"
                | ".ssh"
                | "appdata"
                | "cookies"
                | "credentials"
                | "keychain"
                | "keyrings"
                | "passwords"
        )
    })
}

fn validate_sql(sql: &str, operation: SqlOperation) -> Result<(), String> {
    let normalized = normalize_single_statement(sql)?;
    let lowered = normalized.to_ascii_lowercase();
    if lowered.contains("--") || lowered.contains("/*") || lowered.contains("*/") {
        return Err("SQL comments are not allowed over IPC.".to_string());
    }
    let tokens = sql_tokens(&lowered);
    let Some(first) = tokens.first().map(String::as_str) else {
        return Err("SQL statement is empty.".to_string());
    };

    match operation {
        SqlOperation::Select => {
            if first != "select" {
                return Err("db_select only allows SELECT statements.".to_string());
            }
            let tables = table_refs_after_keywords(&tokens, &["from", "join"]);
            require_allowed_tables(&tables)?;
            require_known_select_shape(&tokens, &collapse_sql_whitespace(&lowered))
        }
        SqlOperation::Execute => {
            if is_transaction_statement(&tokens) {
                return Ok(());
            }
            let tables = match first {
                "create" => create_statement_tables(&tokens)?,
                "insert" => {
                    let mut tables = table_after_keyword(&tokens, "into")?;
                    tables.extend(table_refs_after_keywords(&tokens, &["from", "join"]));
                    tables
                }
                "update" => {
                    let mut tables = table_after_index(&tokens, 1)?;
                    tables.extend(table_refs_after_keywords(&tokens, &["from", "join"]));
                    tables
                }
                "delete" => table_refs_after_keywords(&tokens, &["from", "join"]),
                _ => {
                    return Err("db_execute only allows known app database statements.".to_string())
                }
            };
            require_allowed_tables(&tables)?;
            require_known_execute_shape(&tokens, &collapse_sql_whitespace(&lowered))
        }
    }
}

fn normalize_single_statement(sql: &str) -> Result<String, String> {
    let mut trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL statement is empty.".to_string());
    }
    if let Some(without_semicolon) = trimmed.strip_suffix(';') {
        trimmed = without_semicolon.trim_end();
    }
    if trimmed.contains(';') {
        let lowered = collapse_sql_whitespace(&trimmed.to_ascii_lowercase());
        if !(lowered.starts_with("create trigger ")
            && lowered.contains(" begin ")
            && lowered.ends_with(" end"))
        {
            return Err("Only single SQL statements are allowed over IPC.".to_string());
        }
    }
    Ok(trimmed.to_string())
}

fn sql_tokens(sql: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in sql.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn collapse_sql_whitespace(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_transaction_statement(tokens: &[String]) -> bool {
    matches!(tokens, [single] if single == "commit" || single == "rollback")
        || matches!(tokens, [first] if first == "begin")
        || matches!(tokens, [first, second] if first == "begin" && second == "transaction")
}

fn create_statement_tables(tokens: &[String]) -> Result<Vec<String>, String> {
    match tokens.get(1).map(String::as_str) {
        Some("table") => {
            if tokens.get(2).map(String::as_str) == Some("if")
                && tokens.get(3).map(String::as_str) == Some("not")
                && tokens.get(4).map(String::as_str) == Some("exists")
            {
                table_after_index(tokens, 5)
            } else {
                table_after_index(tokens, 2)
            }
        }
        Some("virtual") => {
            if tokens.get(2).map(String::as_str) == Some("table") {
                if tokens.get(3).map(String::as_str) == Some("if")
                    && tokens.get(4).map(String::as_str) == Some("not")
                    && tokens.get(5).map(String::as_str) == Some("exists")
                {
                    table_after_index(tokens, 6)
                } else {
                    table_after_index(tokens, 3)
                }
            } else {
                Err("Only CREATE VIRTUAL TABLE statements are allowed.".to_string())
            }
        }
        Some("index") => table_after_keyword(tokens, "on"),
        Some("trigger") => table_after_keyword(tokens, "on"),
        _ => Err("Only CREATE TABLE, CREATE VIRTUAL TABLE, CREATE TRIGGER, and CREATE INDEX statements are allowed.".to_string()),
    }
}

fn table_after_keyword(tokens: &[String], keyword: &str) -> Result<Vec<String>, String> {
    let Some(index) = tokens.iter().position(|token| token == keyword) else {
        return Err(format!("SQL statement is missing {keyword} table target."));
    };
    table_after_index(tokens, index + 1)
}

fn table_after_index(tokens: &[String], index: usize) -> Result<Vec<String>, String> {
    tokens
        .get(index)
        .map(|table| vec![table.clone()])
        .ok_or_else(|| "SQL statement is missing a table target.".to_string())
}

fn table_refs_after_keywords(tokens: &[String], keywords: &[&str]) -> Vec<String> {
    tokens
        .windows(2)
        .filter_map(|pair| {
            if keywords.iter().any(|keyword| pair[0] == *keyword) {
                Some(pair[1].clone())
            } else {
                None
            }
        })
        .collect()
}

fn require_allowed_tables(tables: &[String]) -> Result<(), String> {
    if tables.is_empty() {
        return Err("SQL statement must reference an allowed app table.".to_string());
    }
    for table in tables {
        if !ALLOWED_TABLES.contains(&table.as_str()) {
            return Err(format!("SQL table is not allowed over IPC: {table}"));
        }
    }
    Ok(())
}

fn require_known_select_shape(tokens: &[String], sql_text: &str) -> Result<(), String> {
    let signature = sql_signature(tokens);
    if matches!(
        signature.as_str(),
        "select id from schema_migrations"
            | "select record_json from approval_records order by created_at desc limit"
            | "select c fc category fc tags_json fc confidence from file_scan_cache c left join file_classifications fc on c path fc file_path where c is_dir 0 order by c modified_at desc"
            | "select c from file_scan_cache c left join file_classifications fc on c path fc file_path where fc file_path is null and c is_dir 0 order by c modified_at desc"
            | "select category count as count from file_classifications group by category order by count desc"
            | "select app_path category tags_json confidence classified_at source from app_classifications order by classified_at desc"
            | "select category count as count from app_classifications group by category order by count desc"
            | "select provider model api_key_reference base_url from model_settings where id limit 1"
            | "select id slot display_name provider model api_key_reference base_url capabilities from model_profiles order by slot id"
            | "select agent_kind profile_id from agent_model_overrides"
            | "select count as count from model_profiles"
            | "select path from recent_workspaces order by sort_order asc updated_at desc limit"
            | "select from resource_file_cache where kind order by modified_at desc"
            | "select id name goal workspace_path schedule_type schedule_value enabled last_run_at last_run_started_at next_run_at created_at source updated_at from scheduled_tasks order by next_run_at asc"
            | "select snapshot_json from task_history order by updated_at desc id desc limit"
            | "select record_json from tool_call_audit where task_id order by coalesce started_at ended_at id asc"
            | "select key value updated_at from user_preferences order by key asc"
            | "select value from user_preferences where key"
            | "select workspace_id key value updated_at from workspace_settings where workspace_id order by key asc"
            | "select value from workspace_settings where workspace_id and key"
            | "select goal_json from current_goal where id limit 1"
            | "select event_json from goal_events where goal_id order by created_at desc id desc limit"
            | "select evaluation_json from goal_evaluations where goal_id order by created_at desc id desc limit"
            | "select evaluation_json from goal_evaluations where goal_id and task_id order by created_at desc id desc limit 1"
            | "select memory_json from user_profile_memory where id limit 1"
            | "select rowid from agent_memory_facts_fts where agent_memory_facts_fts match limit"
            | "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where status order by updated_at desc limit"
            | "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where status and rowid in"
            | "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where id limit 1"
            | "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where status and fact like or normalized_fact like or search_text like or tags_json like or keywords_json like order by updated_at desc limit"
            | "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where status and scope_type and scope_id order by updated_at desc limit"
            | "select count as count from agent_memory_facts where status"
            | "select count as count from agent_memory_facts where status and scope_type and scope_id"
            | "select count as count from agent_memory_facts where source_session_id"
            | "select count as count from agent_session_summaries"
            | "select count as count from agent_session_summaries where workspace_id"
            | "select count as count from memory_injection_logs"
            | "select count as count from memory_injection_logs where workspace_id"
            | "select updated_at from agent_memory_facts where status order by updated_at desc limit 1"
            | "select id session_id workspace_id summary important_points open_threads created_at updated_at from agent_session_summaries order by updated_at desc limit"
            | "select id session_id workspace_id summary important_points open_threads created_at updated_at from agent_session_summaries where workspace_id order by updated_at desc limit"
            | "select id from vector_index_items where owner_type and owner_id"
            | "select id from vector_index_items where namespace and scope_type and scope_id"
            | "select id from vector_index_items where namespace"
            | "select item_id from vector_index_buckets where namespace and bucket_key limit"
            | "select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where id limit 1"
            | "select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where namespace limit"
            | "select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where namespace and scope_type and scope_id limit"
    ) && has_required_select_operator_shape(&signature, sql_text)
    {
        Ok(())
    } else {
        Err("db_select only allows known app query shapes.".to_string())
    }
}

fn has_required_select_operator_shape(signature: &str, sql_text: &str) -> bool {
    match signature {
        "select record_json from approval_records order by created_at desc limit" => {
            sql_text.contains("order by created_at desc limit ?")
        }
        "select c fc category fc tags_json fc confidence from file_scan_cache c left join file_classifications fc on c path fc file_path where c is_dir 0 order by c modified_at desc" => {
            sql_text.contains("left join file_classifications fc on c.path = fc.file_path")
                && sql_text.contains("where c.is_dir = 0")
        }
        "select c from file_scan_cache c left join file_classifications fc on c path fc file_path where fc file_path is null and c is_dir 0 order by c modified_at desc" => {
            sql_text.contains("left join file_classifications fc on c.path = fc.file_path")
                && sql_text.contains("where fc.file_path is null and c.is_dir = 0")
        }
        "select provider model api_key_reference base_url from model_settings where id limit 1" => {
            sql_text.contains("where id = ? limit 1")
        }
        "select path from recent_workspaces order by sort_order asc updated_at desc limit" => {
            sql_text.contains("limit ?")
        }
        "select from resource_file_cache where kind order by modified_at desc" => {
            sql_text.contains("where kind = ?")
        }
        "select snapshot_json from task_history order by updated_at desc id desc limit" => {
            sql_text.contains("limit ?")
        }
        "select record_json from tool_call_audit where task_id order by coalesce started_at ended_at id asc" => {
            sql_text.contains("where task_id = ?")
        }
        "select value from user_preferences where key" => sql_text.contains("where key = ?"),
        "select workspace_id key value updated_at from workspace_settings where workspace_id order by key asc" => {
            sql_text.contains("where workspace_id = ? order by key asc")
        }
        "select value from workspace_settings where workspace_id and key" => {
            sql_text.contains("where workspace_id = ? and key = ?")
        }
        "select goal_json from current_goal where id limit 1" => {
            sql_text.contains("where id = ? limit 1")
        }
        "select event_json from goal_events where goal_id order by created_at desc id desc limit" => {
            sql_text.contains("where goal_id = ?")
                && sql_text.contains("order by created_at desc, id desc")
                && sql_text.contains("limit ?")
        }
        "select evaluation_json from goal_evaluations where goal_id order by created_at desc id desc limit" => {
            sql_text.contains("where goal_id = ?")
                && sql_text.contains("order by created_at desc, id desc")
                && sql_text.contains("limit ?")
        }
        "select evaluation_json from goal_evaluations where goal_id and task_id order by created_at desc id desc limit 1" => {
            sql_text.contains("where goal_id = ? and task_id = ?")
                && sql_text.contains("order by created_at desc, id desc")
                && sql_text.contains("limit 1")
        }
        "select memory_json from user_profile_memory where id limit 1" => {
            sql_text.contains("where id = ? limit 1")
        }
        "select rowid from agent_memory_facts_fts where agent_memory_facts_fts match limit" => {
            sql_text.contains("where agent_memory_facts_fts match ?") && sql_text.contains("limit ?")
        }
        "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where status order by updated_at desc limit" => {
            sql_text.contains("where status = ?") && sql_text.contains("limit ?")
        }
        "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where status and rowid in" => {
            sql_text.contains("where status = ? and rowid in (?")
        }
        "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where id limit 1" => {
            sql_text.contains("where id = ?") && sql_text.contains("limit 1")
        }
        "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where status and fact like or normalized_fact like or search_text like or tags_json like or keywords_json like order by updated_at desc limit" => {
            sql_text.contains("where status = ?")
                && sql_text.contains("fact like ?")
                && sql_text.contains("normalized_fact like ?")
                && sql_text.contains("search_text like ?")
                && sql_text.contains("tags_json like ?")
                && sql_text.contains("keywords_json like ?")
                && sql_text.contains("limit ?")
        }
        "select rowid id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at from agent_memory_facts where status and scope_type and scope_id order by updated_at desc limit" => {
            sql_text.contains("where status = ? and scope_type = ? and scope_id = ?")
                && sql_text.contains("limit ?")
        }
        "select count as count from agent_memory_facts where status" => {
            sql_text.contains("where status = ?")
        }
        "select count as count from agent_memory_facts where status and scope_type and scope_id" => {
            sql_text.contains("where status = ? and scope_type = ? and scope_id = ?")
        }
        "select count as count from agent_memory_facts where source_session_id" => {
            sql_text.contains("where source_session_id = ?")
        }
        "select count as count from agent_session_summaries where workspace_id" => {
            sql_text.contains("where workspace_id = ?")
        }
        "select count as count from memory_injection_logs where workspace_id" => {
            sql_text.contains("where workspace_id = ?")
        }
        "select updated_at from agent_memory_facts where status order by updated_at desc limit 1" => {
            sql_text.contains("where status = ?") && sql_text.contains("limit 1")
        }
        "select id session_id workspace_id summary important_points open_threads created_at updated_at from agent_session_summaries order by updated_at desc limit" => {
            sql_text.contains("limit ?")
        }
        "select id session_id workspace_id summary important_points open_threads created_at updated_at from agent_session_summaries where workspace_id order by updated_at desc limit" => {
            sql_text.contains("where workspace_id = ?") && sql_text.contains("limit ?")
        }
        "select id from vector_index_items where owner_type and owner_id" => {
            sql_text.contains("where owner_type = ? and owner_id = ?")
        }
        "select id from vector_index_items where namespace and scope_type and scope_id" => {
            sql_text.contains("where namespace = ? and scope_type = ? and scope_id = ?")
        }
        "select id from vector_index_items where namespace" => {
            sql_text.contains("where namespace = ?")
        }
        "select item_id from vector_index_buckets where namespace and bucket_key limit" => {
            sql_text.contains("where namespace = ? and bucket_key = ?") && sql_text.contains("limit ?")
        }
        "select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where id limit 1" => {
            sql_text.contains("where id = ?") && sql_text.contains("limit 1")
        }
        "select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where namespace limit" => {
            sql_text.contains("where namespace = ?") && sql_text.contains("limit ?")
        }
        "select id namespace owner_id dimensions metric vector_json vector_norm metadata_json from vector_index_items where namespace and scope_type and scope_id limit" => {
            sql_text.contains("where namespace = ? and scope_type = ? and scope_id = ?")
                && sql_text.contains("limit ?")
        }
        _ => true,
    }
}

fn require_known_execute_shape(tokens: &[String], sql_text: &str) -> Result<(), String> {
    let signature = sql_signature(tokens);
    if is_known_create_shape(tokens)
        || matches!(
            signature.as_str(),
            "insert into schema_migrations id applied_at values"
                | "insert into task_history id title user_goal status updated_at snapshot_json values on conflict id do update set title excluded title user_goal excluded user_goal status excluded status updated_at excluded updated_at snapshot_json excluded snapshot_json"
                | "insert into recent_workspaces path sort_order updated_at values on conflict path do update set sort_order excluded sort_order updated_at excluded updated_at"
                | "insert into model_settings id provider model api_key_reference base_url updated_at values on conflict id do update set provider excluded provider model excluded model api_key_reference excluded api_key_reference base_url excluded base_url updated_at excluded updated_at"
                | "insert into model_profiles id slot display_name provider model api_key_reference base_url capabilities updated_at values on conflict id do update set slot excluded slot display_name excluded display_name provider excluded provider model excluded model api_key_reference excluded api_key_reference base_url excluded base_url capabilities excluded capabilities updated_at excluded updated_at"
                | "insert into agent_model_overrides agent_kind profile_id updated_at values"
                | "insert into tool_call_audit id task_id agent_run_id tool_name permission_level status input_summary output_summary dry_run_json permission_request_id started_at ended_at error_json record_json values on conflict id do update set task_id excluded task_id agent_run_id excluded agent_run_id tool_name excluded tool_name permission_level excluded permission_level status excluded status input_summary excluded input_summary output_summary excluded output_summary dry_run_json excluded dry_run_json permission_request_id excluded permission_request_id started_at excluded started_at ended_at excluded ended_at error_json excluded error_json record_json excluded record_json"
                | "insert into task_session_log task_id recorded_at snapshot_json values"
                | "insert into tool_call_audit_log task_id recorded_at entry_json values"
                | "insert or replace into file_scan_cache path name is_dir size_bytes modified_at extension scanned_at values"
                | "insert or replace into file_classifications file_path category tags_json confidence classified_at model_id values"
                | "insert or replace into app_classifications app_path category tags_json confidence classified_at source values"
                | "insert or replace into resource_file_cache kind path name source source_root_id source_root_path size_bytes modified_at extension scanned_at values"
                | "insert into scheduled_tasks id name goal workspace_path schedule_type schedule_value enabled last_run_at last_run_started_at next_run_at created_at source updated_at values"
                | "insert or replace into user_preferences key value updated_at values"
                | "insert into user_preferences key value updated_at values"
                | "insert or replace into workspace_settings workspace_id key value updated_at values"
                | "insert into workspace_settings workspace_id key value updated_at values"
                | "delete from workspace_settings where workspace_id and key"
                | "insert into current_goal id goal_json updated_at values on conflict id do update set goal_json excluded goal_json updated_at excluded updated_at"
                | "insert into goal_events id goal_id run_id task_id type created_at event_json values on conflict id do update set goal_id excluded goal_id run_id excluded run_id task_id excluded task_id type excluded type created_at excluded created_at event_json excluded event_json"
                | "insert into goal_evaluations id goal_id task_id decision created_at evaluation_json values on conflict id do update set goal_id excluded goal_id task_id excluded task_id decision excluded decision created_at excluded created_at evaluation_json excluded evaluation_json"
                | "insert into user_profile_memory id updated_at memory_json values on conflict id do update set updated_at excluded updated_at memory_json excluded memory_json"
                | "insert into agent_memory_facts id fact normalized_fact kind tags_json keywords_json search_text scope_type scope_id source_session_id source_message_ids confidence importance status created_at updated_at last_accessed_at access_count expires_at values on conflict id do update set fact excluded fact normalized_fact excluded normalized_fact kind excluded kind tags_json excluded tags_json keywords_json excluded keywords_json search_text excluded search_text scope_type excluded scope_type scope_id excluded scope_id source_session_id excluded source_session_id source_message_ids excluded source_message_ids confidence excluded confidence importance excluded importance status excluded status updated_at excluded updated_at last_accessed_at case when agent_memory_facts last_accessed_at is null then excluded last_accessed_at when excluded last_accessed_at is null then agent_memory_facts last_accessed_at else max agent_memory_facts last_accessed_at excluded last_accessed_at end access_count max agent_memory_facts access_count excluded access_count expires_at excluded expires_at"
                | "insert into agent_session_summaries id session_id workspace_id summary important_points open_threads created_at updated_at values on conflict id do update set session_id excluded session_id workspace_id excluded workspace_id summary excluded summary important_points excluded important_points open_threads excluded open_threads updated_at excluded updated_at"
                | "insert into memory_injection_logs id session_id message_id workspace_id injection_type memory_fact_ids query_hash query_terms query_length scope_type scope_id prompt_section score_summary created_at values"
                | "insert into vector_index_items id namespace owner_type owner_id scope_type scope_id content_hash dimensions metric vector_json vector_norm metadata_json created_at updated_at values on conflict id do update set namespace excluded namespace owner_type excluded owner_type owner_id excluded owner_id scope_type excluded scope_type scope_id excluded scope_id content_hash excluded content_hash dimensions excluded dimensions metric excluded metric vector_json excluded vector_json vector_norm excluded vector_norm metadata_json excluded metadata_json updated_at excluded updated_at"
                | "insert or ignore into vector_index_buckets namespace bucket_key item_id values"
                | "update agent_memory_facts set last_accessed_at case when last_accessed_at is null or last_accessed_at then else last_accessed_at end access_count coalesce access_count 0 1 where id and status"
                | "delete from file_scan_cache where scanned_at"
                | "delete from file_scan_cache"
                | "delete from file_classifications where file_path not in select path from file_scan_cache"
                | "delete from recent_workspaces"
                | "delete from agent_model_overrides"
                | "delete from resource_file_cache where kind and source_root_id"
                | "delete from resource_file_cache where kind"
                | "delete from resource_file_cache"
                | "delete from scheduled_tasks"
                | "delete from task_history"
                | "delete from user_preferences"
                | "delete from current_goal where id"
                | "delete from goal_events where goal_id"
                | "delete from goal_evaluations where goal_id"
                | "delete from user_profile_memory where id"
                | "delete from agent_memory_facts"
                | "delete from agent_memory_facts where id"
                | "delete from agent_memory_facts where scope_type and scope_id"
                | "delete from agent_session_summaries"
                | "delete from agent_session_summaries where session_id"
                | "delete from agent_session_summaries where workspace_id"
                | "delete from memory_injection_logs"
                | "delete from memory_injection_logs where memory_fact_ids like"
                | "delete from memory_injection_logs where workspace_id"
                | "delete from memory_injection_logs where scope_type and scope_id"
                | "delete from vector_index_buckets where item_id"
                | "delete from vector_index_items where id"
        ) && has_required_execute_operator_shape(&signature, sql_text)
    {
        Ok(())
    } else {
        Err("db_execute only allows known app statement shapes.".to_string())
    }
}

fn has_required_execute_operator_shape(signature: &str, sql_text: &str) -> bool {
    match signature {
        "update agent_memory_facts set last_accessed_at case when last_accessed_at is null or last_accessed_at then else last_accessed_at end access_count coalesce access_count 0 1 where id and status" => {
            sql_text.contains("set last_accessed_at = case")
                && sql_text.contains("last_accessed_at is null or last_accessed_at < ?")
                && sql_text.contains("then ?")
                && sql_text.contains("access_count = coalesce(access_count, 0) + 1")
                && sql_text.contains("where id = ? and status = ?")
        }
        "delete from file_scan_cache where scanned_at" => sql_text.contains("where scanned_at <> ?"),
        "delete from file_classifications where file_path not in select path from file_scan_cache" => {
            sql_text.contains("where file_path not in")
        }
        "delete from resource_file_cache where kind and source_root_id" => {
            sql_text.contains("where kind = ? and source_root_id = ?")
        }
        "delete from resource_file_cache where kind" => sql_text.contains("where kind = ?"),
        "delete from user_profile_memory where id" => sql_text.contains("where id = ?"),
        "delete from current_goal where id" => sql_text.contains("where id = ?"),
        "delete from goal_events where goal_id" => sql_text.contains("where goal_id = ?"),
        "delete from goal_evaluations where goal_id" => sql_text.contains("where goal_id = ?"),
        "delete from agent_memory_facts where id" => sql_text.contains("where id = ?"),
        "delete from agent_memory_facts where scope_type and scope_id" => {
            sql_text.contains("where scope_type = ? and scope_id = ?")
        }
        "delete from agent_session_summaries where workspace_id" => {
            sql_text.contains("where workspace_id = ?")
        }
        "delete from agent_session_summaries where session_id" => {
            sql_text.contains("where session_id = ?")
        }
        "delete from memory_injection_logs where memory_fact_ids like" => {
            sql_text.contains("where memory_fact_ids like ?")
        }
        "delete from memory_injection_logs where workspace_id" => {
            sql_text.contains("where workspace_id = ?")
        }
        "delete from memory_injection_logs where scope_type and scope_id" => {
            sql_text.contains("where scope_type = ? and scope_id = ?")
        }
        "insert into vector_index_items id namespace owner_type owner_id scope_type scope_id content_hash dimensions metric vector_json vector_norm metadata_json created_at updated_at values on conflict id do update set namespace excluded namespace owner_type excluded owner_type owner_id excluded owner_id scope_type excluded scope_type scope_id excluded scope_id content_hash excluded content_hash dimensions excluded dimensions metric excluded metric vector_json excluded vector_json vector_norm excluded vector_norm metadata_json excluded metadata_json updated_at excluded updated_at" => {
            sql_text.contains("on conflict(id) do update set")
        }
        "insert or ignore into vector_index_buckets namespace bucket_key item_id values" => {
            sql_text.contains("values (?, ?, ?)")
        }
        "delete from vector_index_buckets where item_id" => sql_text.contains("where item_id = ?"),
        "delete from vector_index_items where id" => sql_text.contains("where id = ?"),
        _ => true,
    }
}

fn is_known_create_shape(tokens: &[String]) -> bool {
    if is_known_virtual_table_signature(&sql_signature(tokens)) {
        return true;
    }

    if is_known_trigger_signature(&sql_signature(tokens)) {
        return true;
    }

    if matches!(
        tokens,
        [create, index, if_token, not_token, exists_token, index_name, on_token, table_name, ..]
            if create == "create"
                && index == "index"
                && if_token == "if"
                && not_token == "not"
                && exists_token == "exists"
                && on_token == "on"
                && is_known_index(index_name, table_name)
    ) {
        return true;
    }

    let table_name = match tokens {
        [create, table, if_token, not_token, exists_token, table_name, ..]
            if create == "create"
                && table == "table"
                && if_token == "if"
                && not_token == "not"
                && exists_token == "exists" =>
        {
            table_name.as_str()
        }
        _ => return false,
    };
    let required_columns = match table_name {
        "schema_migrations" => &["id", "applied_at"][..],
        "task_history" => &[
            "id",
            "title",
            "user_goal",
            "status",
            "updated_at",
            "snapshot_json",
        ],
        "recent_workspaces" => &["path", "sort_order", "updated_at"],
        "model_settings" => &[
            "id",
            "provider",
            "model",
            "api_key_reference",
            "base_url",
            "updated_at",
        ],
        "model_profiles" => &[
            "id",
            "slot",
            "display_name",
            "provider",
            "model",
            "api_key_reference",
            "base_url",
            "capabilities",
            "updated_at",
        ],
        "agent_model_overrides" => &["agent_kind", "profile_id", "updated_at"],
        "approval_records" => &[
            "approval_id",
            "task_id",
            "tool_name",
            "workspace_path",
            "permission_level",
            "preview_hash",
            "expires_at",
            "status",
            "created_at",
            "resolved_at",
            "decision",
            "permission_request_json",
            "code_proposed_edit_json",
            "record_json",
            "updated_at",
        ],
        "tool_call_audit" => &[
            "id",
            "task_id",
            "agent_run_id",
            "tool_name",
            "permission_level",
            "status",
            "input_summary",
            "output_summary",
            "dry_run_json",
            "permission_request_id",
            "started_at",
            "ended_at",
            "error_json",
            "record_json",
        ],
        "scheduled_tasks" => &[
            "id",
            "name",
            "goal",
            "workspace_path",
            "schedule_type",
            "schedule_value",
            "enabled",
            "last_run_at",
            "last_run_started_at",
            "next_run_at",
            "created_at",
            "source",
            "updated_at",
        ],
        "user_preferences" => &["key", "value", "updated_at"],
        "current_goal" => &["id", "goal_json", "updated_at"],
        "goal_events" => &[
            "id",
            "goal_id",
            "run_id",
            "task_id",
            "type",
            "created_at",
            "event_json",
        ],
        "goal_evaluations" => &[
            "id",
            "goal_id",
            "task_id",
            "decision",
            "created_at",
            "evaluation_json",
        ],
        "task_session_log" => &["id", "task_id", "recorded_at", "snapshot_json"],
        "tool_call_audit_log" => &["id", "task_id", "recorded_at", "entry_json"],
        "file_scan_cache" => &[
            "path",
            "name",
            "is_dir",
            "size_bytes",
            "modified_at",
            "extension",
            "scanned_at",
        ],
        "file_classifications" => &[
            "file_path",
            "category",
            "tags_json",
            "confidence",
            "classified_at",
            "model_id",
        ],
        "app_classifications" => &[
            "app_path",
            "category",
            "tags_json",
            "confidence",
            "classified_at",
            "source",
        ],
        "resource_scan_roots" => &[
            "id",
            "path",
            "label",
            "kinds_json",
            "enabled",
            "source",
            "created_at",
        ],
        "resource_file_cache" => &[
            "kind",
            "path",
            "name",
            "source",
            "source_root_id",
            "source_root_path",
            "size_bytes",
            "modified_at",
            "extension",
            "scanned_at",
        ],
        "user_profile_memory" => &["id", "updated_at", "memory_json"],
        "agent_session_summaries" => &[
            "id",
            "session_id",
            "workspace_id",
            "summary",
            "important_points",
            "open_threads",
            "created_at",
            "updated_at",
        ],
        "agent_memory_facts" => &[
            "id",
            "fact",
            "normalized_fact",
            "kind",
            "tags_json",
            "keywords_json",
            "search_text",
            "scope_type",
            "scope_id",
            "source_session_id",
            "source_message_ids",
            "confidence",
            "importance",
            "status",
            "created_at",
            "updated_at",
            "last_accessed_at",
            "access_count",
            "expires_at",
        ],
        "memory_injection_logs" => &[
            "id",
            "session_id",
            "message_id",
            "workspace_id",
            "injection_type",
            "memory_fact_ids",
            "query_hash",
            "query_terms",
            "query_length",
            "scope_type",
            "scope_id",
            "prompt_section",
            "score_summary",
            "created_at",
        ],
        "vector_index_items" => &[
            "id",
            "namespace",
            "owner_type",
            "owner_id",
            "scope_type",
            "scope_id",
            "content_hash",
            "dimensions",
            "metric",
            "vector_json",
            "vector_norm",
            "metadata_json",
            "created_at",
            "updated_at",
        ],
        "vector_index_buckets" => &["namespace", "bucket_key", "item_id"],
        "workspace_settings" => &["workspace_id", "key", "value", "updated_at"],
        _ => return false,
    };
    required_columns
        .iter()
        .all(|column| tokens.iter().any(|token| token == column))
}

fn is_known_index(index_name: &str, table_name: &str) -> bool {
    matches!(
        (index_name, table_name),
        ("idx_task_history_updated_at", "task_history")
            | ("idx_recent_workspaces_sort_order", "recent_workspaces")
            | ("approval_records_status_tool_idx", "approval_records")
            | ("approval_records_expiration_idx", "approval_records")
            | ("tool_call_audit_task_idx", "tool_call_audit")
            | ("idx_scheduled_tasks_next_run", "scheduled_tasks")
            | ("idx_task_session_log_task_id", "task_session_log")
            | ("idx_tool_call_audit_log_task_id", "tool_call_audit_log")
            | ("idx_file_scan_cache_ext", "file_scan_cache")
            | ("idx_file_classifications_cat", "file_classifications")
            | ("idx_app_classifications_cat", "app_classifications")
            | ("idx_resource_cache_kind_root", "resource_file_cache")
            | ("idx_agent_memory_facts_scope", "agent_memory_facts")
            | (
                "idx_agent_session_summaries_workspace",
                "agent_session_summaries"
            )
            | ("idx_memory_injection_logs_session", "memory_injection_logs")
            | (
                "idx_memory_injection_logs_workspace",
                "memory_injection_logs"
            )
            | ("idx_vector_index_owner", "vector_index_items")
            | ("idx_vector_index_scope", "vector_index_items")
    )
}

fn is_known_virtual_table_signature(signature: &str) -> bool {
    matches!(
        signature,
        "create virtual table if not exists agent_memory_facts_fts using fts5 fact normalized_fact search_text content agent_memory_facts content_rowid rowid"
    )
}

fn is_known_trigger_signature(signature: &str) -> bool {
    matches!(
        signature,
        "create trigger if not exists agent_memory_facts_ai after insert on agent_memory_facts begin insert into agent_memory_facts_fts rowid fact normalized_fact search_text values new rowid new fact new normalized_fact new search_text end"
            | "create trigger if not exists agent_memory_facts_ad after delete on agent_memory_facts begin insert into agent_memory_facts_fts agent_memory_facts_fts rowid fact normalized_fact search_text values delete old rowid old fact old normalized_fact old search_text end"
            | "create trigger if not exists agent_memory_facts_au after update on agent_memory_facts begin insert into agent_memory_facts_fts agent_memory_facts_fts rowid fact normalized_fact search_text values delete old rowid old fact old normalized_fact old search_text insert into agent_memory_facts_fts rowid fact normalized_fact search_text values new rowid new fact new normalized_fact new search_text end"
    )
}

fn sql_signature(tokens: &[String]) -> String {
    tokens.join(" ")
}

fn json_to_rusqlite_value(value: serde_json::Value) -> rusqlite::types::Value {
    match value {
        serde_json::Value::Null => rusqlite::types::Value::Null,
        serde_json::Value::Bool(b) => rusqlite::types::Value::Integer(i64::from(b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                rusqlite::types::Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                rusqlite::types::Value::Real(f)
            } else {
                rusqlite::types::Value::Text(n.to_string())
            }
        }
        serde_json::Value::String(s) => rusqlite::types::Value::Text(s),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            rusqlite::types::Value::Text(value.to_string())
        }
    }
}

fn rusqlite_to_json_value(value: rusqlite::types::Value) -> serde_json::Value {
    match value {
        rusqlite::types::Value::Null => serde_json::Value::Null,
        rusqlite::types::Value::Integer(i) => serde_json::Value::Number(i.into()),
        rusqlite::types::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
        rusqlite::types::Value::Blob(_) => serde_json::Value::Null,
    }
}

fn validate_approval_record_upsert_request(
    request: &ApprovalRecordUpsertRequest,
) -> Result<(), String> {
    require_non_empty(&request.approval_id, "approvalId")?;
    require_non_empty(&request.task_id, "taskId")?;
    require_non_empty(&request.tool_name, "toolName")?;
    require_non_empty(&request.workspace_path, "workspacePath")?;
    require_non_empty(&request.preview_hash, "previewHash")?;
    require_iso_like_timestamp(&request.expires_at, "expiresAt")?;
    require_iso_like_timestamp(&request.created_at, "createdAt")?;
    require_iso_like_timestamp(&request.updated_at, "updatedAt")?;
    if let Some(resolved_at) = request.resolved_at.as_deref() {
        require_iso_like_timestamp(resolved_at, "resolvedAt")?;
    }
    if !matches!(
        request.permission_level.as_str(),
        "preview" | "confirmed_write"
    ) {
        return Err("Approval record permissionLevel is invalid.".to_string());
    }
    if !matches!(
        request.status.as_str(),
        "pending" | "approved" | "denied" | "expired"
    ) {
        return Err("Approval record status is invalid.".to_string());
    }
    if let Some(decision) = request.decision.as_deref() {
        if !matches!(decision, "approved" | "denied") {
            return Err("Approval record decision is invalid.".to_string());
        }
    }

    let record = parse_json_object(&request.record_json, "recordJson")?;
    let permission_request =
        parse_json_object(&request.permission_request_json, "permissionRequestJson")?;
    require_json_string(&record, "approvalId", &request.approval_id)?;
    require_json_string(&record, "taskId", &request.task_id)?;
    require_json_string(&record, "toolName", &request.tool_name)?;
    require_json_string(&record, "workspacePath", &request.workspace_path)?;
    require_json_string(&record, "permissionLevel", &request.permission_level)?;
    require_json_string(&record, "previewHash", &request.preview_hash)?;
    require_json_string(&record, "expiresAt", &request.expires_at)?;
    require_json_string(&record, "status", &request.status)?;
    require_json_string(&record, "createdAt", &request.created_at)?;
    require_optional_json_string(&record, "resolvedAt", request.resolved_at.as_deref())?;
    require_optional_json_string(&record, "decision", request.decision.as_deref())?;

    require_json_string(&permission_request, "id", &request.approval_id)?;
    require_json_string(&permission_request, "level", &request.permission_level)?;
    require_json_string(&permission_request, "bindingHash", &request.preview_hash)?;
    require_json_string(&permission_request, "status", &request.status)?;
    if !permission_request
        .get("dryRun")
        .map(|value| value.is_object())
        .unwrap_or(false)
    {
        return Err("Approval record permissionRequest.dryRun is invalid.".to_string());
    }
    if record.get("permissionRequest") != Some(&serde_json::Value::Object(permission_request)) {
        return Err(
            "Approval record JSON must contain the same permissionRequest JSON.".to_string(),
        );
    }
    if let Some(code_json) = request.code_proposed_edit_json.as_deref() {
        let code = parse_json_object(code_json, "codeProposedEditJson")?;
        if record.get("codeProposedEdit") != Some(&serde_json::Value::Object(code)) {
            return Err(
                "Approval record JSON must contain the same codeProposedEdit JSON.".to_string(),
            );
        }
    } else if record.get("codeProposedEdit").is_some() {
        return Err("Approval record codeProposedEdit column is missing.".to_string());
    }
    Ok(())
}

fn require_non_empty(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("Approval record {field} is required."));
    }
    Ok(())
}

fn require_iso_like_timestamp(value: &str, field: &str) -> Result<(), String> {
    require_non_empty(value, field)?;
    if !value.contains('T') || !value.ends_with('Z') {
        return Err(format!("Approval record {field} must be an ISO timestamp."));
    }
    Ok(())
}

fn parse_json_object(
    raw: &str,
    field: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        _ => Err(format!("Approval record {field} must be a JSON object.")),
    }
}

fn require_json_string(
    map: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    expected: &str,
) -> Result<(), String> {
    match map.get(field).and_then(|value| value.as_str()) {
        Some(value) if value == expected => Ok(()),
        _ => Err(format!(
            "Approval record JSON field {field} does not match."
        )),
    }
}

fn require_optional_json_string(
    map: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    match (expected, map.get(field).and_then(|value| value.as_str())) {
        (Some(expected), Some(value)) if value == expected => Ok(()),
        (None, None) => Ok(()),
        _ => Err(format!(
            "Approval record JSON field {field} does not match."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_allowed(sql: &str, operation: SqlOperation) {
        assert!(
            validate_sql(sql, operation).is_ok(),
            "expected SQL to be allowed: {sql}"
        );
    }

    fn assert_rejected(sql: &str, operation: SqlOperation) {
        assert!(
            validate_sql(sql, operation).is_err(),
            "expected SQL to be rejected: {sql}"
        );
    }

    fn approval_record_request() -> ApprovalRecordUpsertRequest {
        let permission_request = serde_json::json!({
            "id": "approval-1",
            "level": "confirmed_write",
            "title": "Write file",
            "reason": "User requested a write.",
            "dryRun": {
                "operation": "Write text file",
                "affectedPaths": [{ "source": "", "target": "notes.md", "action": "create" }],
                "riskSummary": "Creates a file.",
                "reversible": true
            },
            "bindingHash": "hash-1",
            "status": "pending",
            "createdAt": "2026-06-08T00:00:00.000Z"
        });
        let record = serde_json::json!({
            "approvalId": "approval-1",
            "taskId": "task-1",
            "toolName": "file.writeText",
            "workspacePath": "E:/Javis",
            "permissionLevel": "confirmed_write",
            "previewHash": "hash-1",
            "expiresAt": "2026-06-08T00:10:00.000Z",
            "status": "pending",
            "createdAt": "2026-06-08T00:00:00.000Z",
            "permissionRequest": permission_request
        });
        ApprovalRecordUpsertRequest {
            approval_id: "approval-1".to_string(),
            task_id: "task-1".to_string(),
            tool_name: "file.writeText".to_string(),
            workspace_path: "E:/Javis".to_string(),
            permission_level: "confirmed_write".to_string(),
            preview_hash: "hash-1".to_string(),
            expires_at: "2026-06-08T00:10:00.000Z".to_string(),
            status: "pending".to_string(),
            created_at: "2026-06-08T00:00:00.000Z".to_string(),
            resolved_at: None,
            decision: None,
            permission_request_json: permission_request.to_string(),
            code_proposed_edit_json: None,
            record_json: record.to_string(),
            updated_at: "2026-06-08T00:00:01.000Z".to_string(),
        }
    }

    #[test]
    fn validates_matching_approval_record_upsert_request() {
        assert!(validate_approval_record_upsert_request(&approval_record_request()).is_ok());
    }

    #[test]
    fn rejects_mismatched_approval_record_json() {
        let mut request = approval_record_request();
        let mut record: serde_json::Value = serde_json::from_str(&request.record_json).unwrap();
        record["approvalId"] = serde_json::Value::String("other-approval".to_string());
        request.record_json = record.to_string();

        assert!(validate_approval_record_upsert_request(&request).is_err());
    }

    #[test]
    fn rejects_mismatched_approval_permission_request_json() {
        let mut request = approval_record_request();
        let mut permission_request: serde_json::Value =
            serde_json::from_str(&request.permission_request_json).unwrap();
        permission_request["bindingHash"] = serde_json::Value::String("other-hash".to_string());
        request.permission_request_json = permission_request.to_string();

        assert!(validate_approval_record_upsert_request(&request).is_err());
    }

    #[test]
    fn allows_known_app_execute_statements() {
        let statements = [
            "BEGIN TRANSACTION",
            "COMMIT",
            "ROLLBACK",
            "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
            "CREATE TABLE IF NOT EXISTS task_history (id TEXT PRIMARY KEY, title TEXT NOT NULL, user_goal TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS idx_resource_cache_kind_root ON resource_file_cache (kind, source_root_id)",
            "CREATE INDEX IF NOT EXISTS idx_app_classifications_cat ON app_classifications (category)",
            r#"CREATE TABLE IF NOT EXISTS vector_index_items (
                 id TEXT PRIMARY KEY,
                 namespace TEXT NOT NULL,
                 owner_type TEXT NOT NULL,
                 owner_id TEXT NOT NULL,
                 scope_type TEXT,
                 scope_id TEXT,
                 content_hash TEXT NOT NULL,
                 dimensions INTEGER NOT NULL,
                 metric TEXT NOT NULL,
                 vector_json TEXT NOT NULL,
                 vector_norm REAL NOT NULL,
                 metadata_json TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
               )"#,
            r#"CREATE TABLE IF NOT EXISTS vector_index_buckets (
                 namespace TEXT NOT NULL,
                 bucket_key TEXT NOT NULL,
                 item_id TEXT NOT NULL,
                 PRIMARY KEY (namespace, bucket_key, item_id)
               )"#,
            "CREATE INDEX IF NOT EXISTS idx_vector_index_owner ON vector_index_items(owner_type, owner_id)",
            "CREATE INDEX IF NOT EXISTS idx_vector_index_scope ON vector_index_items(namespace, scope_type, scope_id)",
            r#"CREATE TABLE IF NOT EXISTS agent_memory_facts (
                 rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                 id TEXT UNIQUE NOT NULL,
                 fact TEXT NOT NULL,
                 normalized_fact TEXT,
                 kind TEXT NOT NULL,
                 tags_json TEXT,
                 keywords_json TEXT,
                 search_text TEXT,
                 scope_type TEXT NOT NULL DEFAULT 'global',
                 scope_id TEXT,
                 source_session_id TEXT,
                 source_message_ids TEXT,
                 confidence REAL DEFAULT 0.8,
                 importance INTEGER DEFAULT 3,
                 status TEXT DEFAULT 'active',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 last_accessed_at INTEGER,
                 access_count INTEGER DEFAULT 0,
                 expires_at INTEGER)"#,
            r#"CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_facts_fts USING fts5(
                 fact,
                 normalized_fact,
                 search_text,
                 content='agent_memory_facts',
                 content_rowid='rowid')"#,
            r#"CREATE TRIGGER IF NOT EXISTS agent_memory_facts_ai
               AFTER INSERT ON agent_memory_facts BEGIN
                 INSERT INTO agent_memory_facts_fts(rowid, fact, normalized_fact, search_text)
                 VALUES (new.rowid, new.fact, new.normalized_fact, new.search_text);
               END"#,
            r#"INSERT INTO task_history (id, title, user_goal, status, updated_at, snapshot_json)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title,
                 user_goal = excluded.user_goal,
                 status = excluded.status,
                 updated_at = excluded.updated_at,
                 snapshot_json = excluded.snapshot_json"#,
            "DELETE FROM file_classifications WHERE file_path NOT IN (SELECT path FROM file_scan_cache)",
            r#"INSERT OR REPLACE INTO file_scan_cache
               (path, name, is_dir, size_bytes, modified_at, extension, scanned_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
            "DELETE FROM file_scan_cache WHERE scanned_at <> ?",
            r#"INSERT OR REPLACE INTO file_classifications
               (file_path, category, tags_json, confidence, classified_at, model_id)
               VALUES (?, ?, ?, ?, ?, ?)"#,
            r#"INSERT OR REPLACE INTO app_classifications
               (app_path, category, tags_json, confidence, classified_at, source)
               VALUES (?, ?, ?, ?, ?, ?)"#,
            r#"INSERT OR REPLACE INTO resource_file_cache
               (kind, path, name, source, source_root_id, source_root_path,
                size_bytes, modified_at, extension, scanned_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            "DELETE FROM resource_file_cache WHERE kind = ? AND source_root_id = ?",
            "DELETE FROM scheduled_tasks",
            r#"INSERT INTO scheduled_tasks
               (id, name, goal, workspace_path, schedule_type, schedule_value,
                enabled, last_run_at, last_run_started_at, next_run_at,
                created_at, source, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            "INSERT OR REPLACE INTO user_preferences (key, value, updated_at) VALUES (?, ?, ?)",
            r#"INSERT INTO user_profile_memory (id, updated_at, memory_json)
               VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 updated_at = excluded.updated_at,
                 memory_json = excluded.memory_json"#,
            r#"INSERT INTO agent_memory_facts (
                 id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
                 scope_type, scope_id, source_session_id, source_message_ids,
                 confidence, importance, status, created_at, updated_at,
                 last_accessed_at, access_count, expires_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 fact = excluded.fact,
                 normalized_fact = excluded.normalized_fact,
                 kind = excluded.kind,
                 tags_json = excluded.tags_json,
                 keywords_json = excluded.keywords_json,
                 search_text = excluded.search_text,
                 scope_type = excluded.scope_type,
                 scope_id = excluded.scope_id,
                 source_session_id = excluded.source_session_id,
                 source_message_ids = excluded.source_message_ids,
                 confidence = excluded.confidence,
                 importance = excluded.importance,
                 status = excluded.status,
                 updated_at = excluded.updated_at,
                 last_accessed_at = CASE
                   WHEN agent_memory_facts.last_accessed_at IS NULL THEN excluded.last_accessed_at
                   WHEN excluded.last_accessed_at IS NULL THEN agent_memory_facts.last_accessed_at
                   ELSE MAX(agent_memory_facts.last_accessed_at, excluded.last_accessed_at)
                 END,
                 access_count = MAX(agent_memory_facts.access_count, excluded.access_count),
                 expires_at = excluded.expires_at"#,
            r#"INSERT INTO memory_injection_logs (
                 id, session_id, message_id, workspace_id, injection_type, memory_fact_ids,
                 query_hash, query_terms, query_length, scope_type, scope_id,
                 prompt_section, score_summary, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            r#"UPDATE agent_memory_facts
               SET last_accessed_at = CASE
                     WHEN last_accessed_at IS NULL OR last_accessed_at < ? THEN ?
                     ELSE last_accessed_at
                   END,
                   access_count = COALESCE(access_count, 0) + 1
               WHERE id = ? AND status = ?"#,
            "DELETE FROM agent_memory_facts WHERE scope_type = ? AND scope_id = ?",
            "DELETE FROM agent_session_summaries WHERE session_id = ?",
            "DELETE FROM memory_injection_logs WHERE memory_fact_ids LIKE ?",
            r#"INSERT INTO vector_index_items (
                 id, namespace, owner_type, owner_id, scope_type, scope_id, content_hash,
                 dimensions, metric, vector_json, vector_norm, metadata_json, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 namespace = excluded.namespace,
                 owner_type = excluded.owner_type,
                 owner_id = excluded.owner_id,
                 scope_type = excluded.scope_type,
                 scope_id = excluded.scope_id,
                 content_hash = excluded.content_hash,
                 dimensions = excluded.dimensions,
                 metric = excluded.metric,
                 vector_json = excluded.vector_json,
                 vector_norm = excluded.vector_norm,
                 metadata_json = excluded.metadata_json,
                 updated_at = excluded.updated_at"#,
            r#"INSERT OR IGNORE INTO vector_index_buckets (namespace, bucket_key, item_id)
               VALUES (?, ?, ?)"#,
            "DELETE FROM vector_index_buckets WHERE item_id = ?",
            "DELETE FROM vector_index_items WHERE id = ?",
        ];

        for sql in statements {
            assert_allowed(sql, SqlOperation::Execute);
        }
    }

    #[test]
    fn allows_known_app_select_statements() {
        let statements = [
            "SELECT id FROM schema_migrations",
            "SELECT record_json FROM approval_records ORDER BY created_at DESC LIMIT ?",
            "SELECT * FROM resource_file_cache WHERE kind = ? ORDER BY modified_at DESC",
            r#"SELECT c.*, fc.category, fc.tags_json, fc.confidence
               FROM file_scan_cache c
               LEFT JOIN file_classifications fc ON c.path = fc.file_path
               WHERE c.is_dir = 0
               ORDER BY c.modified_at DESC"#,
            r#"SELECT c.*
               FROM file_scan_cache c
               LEFT JOIN file_classifications fc ON c.path = fc.file_path
               WHERE fc.file_path IS NULL AND c.is_dir = 0
               ORDER BY c.modified_at DESC"#,
            r#"SELECT category, COUNT(*) as count
               FROM file_classifications
               GROUP BY category
               ORDER BY count DESC"#,
            r#"SELECT app_path, category, tags_json, confidence, classified_at, source
               FROM app_classifications
               ORDER BY classified_at DESC"#,
            r#"SELECT category, COUNT(*) as count
               FROM app_classifications
               GROUP BY category
               ORDER BY count DESC"#,
            "SELECT COUNT(*) as count FROM model_profiles",
            "SELECT provider, model, api_key_reference, base_url FROM model_settings WHERE id = ? LIMIT 1",
            "SELECT id, slot, display_name, provider, model, api_key_reference, base_url, capabilities FROM model_profiles ORDER BY slot, id",
            "SELECT agent_kind, profile_id FROM agent_model_overrides",
            "SELECT path FROM recent_workspaces ORDER BY sort_order ASC, updated_at DESC LIMIT ?",
            r#"SELECT id, name, goal, workspace_path, schedule_type, schedule_value,
                      enabled, last_run_at, last_run_started_at, next_run_at,
                      created_at, source, updated_at
               FROM scheduled_tasks
               ORDER BY next_run_at ASC"#,
            "SELECT snapshot_json FROM task_history ORDER BY updated_at DESC, id DESC LIMIT ?",
            "SELECT record_json FROM tool_call_audit WHERE task_id = ? ORDER BY COALESCE(started_at, ended_at, id) ASC",
            "SELECT key, value, updated_at FROM user_preferences ORDER BY key ASC",
            "SELECT value FROM user_preferences WHERE key = ?",
            "SELECT goal_json FROM current_goal WHERE id = ? LIMIT 1",
            "SELECT event_json FROM goal_events WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            "SELECT evaluation_json FROM goal_evaluations WHERE goal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
            "SELECT evaluation_json FROM goal_evaluations WHERE goal_id = ? AND task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
            "SELECT memory_json FROM user_profile_memory WHERE id = ? LIMIT 1",
            "SELECT rowid FROM agent_memory_facts_fts WHERE agent_memory_facts_fts MATCH ? LIMIT ?",
            r#"SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
                      scope_type, scope_id, source_session_id, source_message_ids, confidence,
                      importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
               FROM agent_memory_facts
               WHERE status = ?
               ORDER BY updated_at DESC
               LIMIT ?"#,
            r#"SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
                      scope_type, scope_id, source_session_id, source_message_ids, confidence,
                      importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
               FROM agent_memory_facts
               WHERE status = ? AND rowid IN (?, ?)"#,
            r#"SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
                      scope_type, scope_id, source_session_id, source_message_ids, confidence,
                      importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
               FROM agent_memory_facts
               WHERE id = ?
               LIMIT 1"#,
            r#"SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
                      scope_type, scope_id, source_session_id, source_message_ids, confidence,
                      importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
               FROM agent_memory_facts
               WHERE status = ? AND (
                 fact LIKE ? OR
                 normalized_fact LIKE ? OR
                 search_text LIKE ? OR
                 tags_json LIKE ? OR
                 keywords_json LIKE ?
               )
               ORDER BY updated_at DESC
               LIMIT ?"#,
            r#"SELECT rowid, id, fact, normalized_fact, kind, tags_json, keywords_json, search_text,
                      scope_type, scope_id, source_session_id, source_message_ids, confidence,
                      importance, status, created_at, updated_at, last_accessed_at, access_count, expires_at
               FROM agent_memory_facts
               WHERE status = ? AND scope_type = ? AND scope_id = ?
               ORDER BY updated_at DESC
               LIMIT ?"#,
            "SELECT COUNT(*) as count FROM agent_memory_facts WHERE status = ?",
            "SELECT COUNT(*) as count FROM agent_memory_facts WHERE status = ? AND scope_type = ? AND scope_id = ?",
            "SELECT COUNT(*) as count FROM agent_memory_facts WHERE source_session_id = ?",
            "SELECT COUNT(*) as count FROM agent_session_summaries",
            "SELECT COUNT(*) as count FROM agent_session_summaries WHERE workspace_id = ?",
            "SELECT COUNT(*) as count FROM memory_injection_logs",
            "SELECT COUNT(*) as count FROM memory_injection_logs WHERE workspace_id = ?",
            "SELECT updated_at FROM agent_memory_facts WHERE status = ? ORDER BY updated_at DESC LIMIT 1",
            r#"SELECT id, session_id, workspace_id, summary, important_points, open_threads, created_at, updated_at
               FROM agent_session_summaries
               WHERE workspace_id = ?
               ORDER BY updated_at DESC
               LIMIT ?"#,
            "SELECT id FROM vector_index_items WHERE owner_type = ? AND owner_id = ?",
            "SELECT id FROM vector_index_items WHERE namespace = ? AND scope_type = ? AND scope_id = ?",
            "SELECT id FROM vector_index_items WHERE namespace = ?",
            "SELECT item_id FROM vector_index_buckets WHERE namespace = ? AND bucket_key = ? LIMIT ?",
            r#"SELECT id, namespace, owner_id, dimensions, metric, vector_json, vector_norm, metadata_json
               FROM vector_index_items
               WHERE id = ?
               LIMIT 1"#,
            r#"SELECT id, namespace, owner_id, dimensions, metric, vector_json, vector_norm, metadata_json
               FROM vector_index_items
               WHERE namespace = ?
               LIMIT ?"#,
            r#"SELECT id, namespace, owner_id, dimensions, metric, vector_json, vector_norm, metadata_json
               FROM vector_index_items
               WHERE namespace = ? AND scope_type = ? AND scope_id = ?
               LIMIT ?"#,
        ];

        for sql in statements {
            assert_allowed(sql, SqlOperation::Select);
        }
    }

    #[test]
    fn rejects_unknown_or_dangerous_execute_statements() {
        let statements = [
            "DROP TABLE task_history",
            "ALTER TABLE task_history ADD COLUMN leaked TEXT",
            "ATTACH DATABASE 'x.db' AS x",
            "DETACH DATABASE main",
            "PRAGMA user_version",
            "VACUUM",
            "CREATE TABLE IF NOT EXISTS secrets (id TEXT)",
            "INSERT INTO secrets (id) VALUES (?)",
            "UPDATE secrets SET id = ?",
            "DELETE FROM secrets",
            "SELECT * FROM task_history; DELETE FROM task_history",
            "DELETE FROM task_history -- remove all rows",
            "CREATE INDEX IF NOT EXISTS idx_secret ON secrets (id)",
            "INSERT INTO task_history (id) SELECT name FROM sqlite_master",
            "INSERT INTO task_history (id, title) VALUES (?, ?)",
            "UPDATE task_history SET title = (SELECT name FROM sqlite_master LIMIT 1)",
            "UPDATE task_history SET title = ? WHERE id = ?",
            r#"INSERT OR REPLACE INTO resource_scan_roots
               (id, path, label, kinds_json, enabled, source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
            "UPDATE resource_scan_roots SET enabled = ? WHERE id = ?",
            "UPDATE resource_scan_roots SET enabled = ? WHERE id <> ?",
            "DELETE FROM resource_scan_roots WHERE id = ?",
            "DELETE FROM task_history WHERE status = ?",
            "DELETE FROM approval_records",
            r#"INSERT INTO approval_records
               (approval_id, task_id, tool_name, workspace_path, permission_level, preview_hash, expires_at, status, created_at, resolved_at, decision, permission_request_json, code_proposed_edit_json, record_json, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(approval_id) DO UPDATE SET
                 task_id = excluded.task_id,
                 tool_name = excluded.tool_name,
                 workspace_path = excluded.workspace_path,
                 permission_level = excluded.permission_level,
                 preview_hash = excluded.preview_hash,
                 expires_at = excluded.expires_at,
                 status = excluded.status,
                 created_at = excluded.created_at,
                 resolved_at = excluded.resolved_at,
                 decision = excluded.decision,
                 permission_request_json = excluded.permission_request_json,
                 code_proposed_edit_json = excluded.code_proposed_edit_json,
                 record_json = excluded.record_json,
                 updated_at = excluded.updated_at"#,
            r#"DELETE FROM approval_records
               WHERE approval_id NOT IN (
                 SELECT approval_id
                 FROM approval_records
                 ORDER BY created_at DESC
                 LIMIT ?
               )"#,
            "DELETE FROM file_scan_cache WHERE scanned_at = ?",
            "DELETE FROM resource_file_cache WHERE kind <> ?",
            "DELETE FROM resource_file_cache WHERE kind = ? OR source_root_id = ?",
            "DELETE FROM task_history WHERE id IN (SELECT id FROM secrets)",
        ];

        for sql in statements {
            assert_rejected(sql, SqlOperation::Execute);
        }
    }

    #[test]
    fn rejects_unknown_or_dangerous_select_statements() {
        let statements = [
            "SELECT 1",
            "SELECT * FROM sqlite_master",
            "SELECT * FROM secrets",
            "SELECT * FROM task_history; DELETE FROM task_history",
            "SELECT * FROM task_history -- comment",
            "SELECT * FROM task_history",
            "SELECT user_goal FROM task_history",
            "SELECT record_json FROM approval_records",
            "SELECT * FROM resource_scan_roots ORDER BY source DESC, created_at ASC",
            "SELECT * FROM resource_scan_roots WHERE enabled = 1 ORDER BY source DESC, created_at ASC",
            "SELECT * FROM resource_file_cache WHERE kind <> ? ORDER BY modified_at DESC",
            "SELECT value FROM user_preferences WHERE key <> ?",
            "PRAGMA user_version",
            "UPDATE task_history SET title = ?",
        ];

        for sql in statements {
            assert_rejected(sql, SqlOperation::Select);
        }
    }
}
