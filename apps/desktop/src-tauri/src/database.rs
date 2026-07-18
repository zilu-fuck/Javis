use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    collections::{HashMap, HashSet},
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
    "runtime_events",
    "workflow_checkpoints",
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
    run_id: Option<String>,
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventCompactionRequest {
    task_id: String,
    event_ids: Vec<String>,
    compaction_envelopes: Vec<serde_json::Value>,
}

struct RuntimeEventCompactionRow {
    event_id: String,
    task_id: String,
    run_id: String,
    sequence: i64,
    event_version: i64,
    workflow_id: Option<String>,
    step_id: Option<String>,
    agent_id: Option<String>,
    occurred_at: String,
    recorded_at: String,
    envelope_json: String,
    compacted_event_count: usize,
    compacted_event_kinds: HashSet<String>,
    first_sequence: i64,
    last_sequence: i64,
}

struct RuntimeEventCompactionSource {
    event_id: String,
    run_id: String,
    sequence: i64,
    event_kind: String,
}

const RUNTIME_EVENT_COMPACTION_DELETE_BATCH_SIZE: usize = 900;
const MAX_RUNTIME_EVENT_COMPACTION_IDS: usize = 100_000;
const MAX_RUNTIME_EVENT_COMPACTION_ENVELOPES: usize = 10_000;
const MAX_RUNTIME_EVENT_ID_BYTES: usize = 512;
const MAX_RUNTIME_EVENT_ENVELOPE_BYTES: usize = 1_000_000;

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
              run_id,
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(approval_id) DO UPDATE SET
              task_id = excluded.task_id,
              run_id = excluded.run_id,
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
                request.run_id,
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
    with_connection(&app, |conn| prune_approval_records(conn, limit).map(|_| ()))
}

fn prune_approval_records(conn: &Connection, limit: i64) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM approval_records
         WHERE approval_id IN (
           SELECT approval_id
           FROM approval_records
           WHERE status = 'expired'
             OR (status = 'denied' AND COALESCE(CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.workflowBound') END, 0) <> 1)
             OR CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.execution.status') END IN ('completed', 'failed', 'blocked')
           ORDER BY created_at DESC, approval_id DESC
           LIMIT -1 OFFSET ?
         )",
        [limit],
    )
    .map_err(|error| format!("Approval record prune error: {error}"))
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
pub fn runtime_events_compact(
    app: AppHandle,
    request: RuntimeEventCompactionRequest,
) -> Result<(), String> {
    with_connection(&app, |conn| compact_runtime_events(conn, &request))
}

fn compact_runtime_events(
    connection: &Connection,
    request: &RuntimeEventCompactionRequest,
) -> Result<(), String> {
    let compaction_rows = validate_runtime_event_compaction_request(request)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| format!("Runtime event compaction transaction error: {error}"))?;

    require_terminal_compaction_runs(&transaction, &request.task_id, &compaction_rows)?;
    let source_events =
        load_compaction_source_events(&transaction, &request.task_id, &request.event_ids)?;
    if source_events.len() != request.event_ids.len() {
        if source_events.is_empty()
            && all_compaction_rows_already_persisted(&transaction, &compaction_rows)?
        {
            return Ok(());
        }
        return Err("Runtime event compaction source events are missing.".to_string());
    }
    validate_compaction_source_bindings(
        &transaction,
        &request.task_id,
        &source_events,
        &compaction_rows,
    )?;

    for batch in request
        .event_ids
        .chunks(RUNTIME_EVENT_COMPACTION_DELETE_BATCH_SIZE)
    {
        delete_runtime_event_batch(&transaction, &request.task_id, batch)?;
    }
    for row in &compaction_rows {
        insert_runtime_event_compaction_row(&transaction, row)?;
    }

    transaction
        .commit()
        .map_err(|error| format!("Runtime event compaction commit error: {error}"))
}

fn validate_runtime_event_compaction_request(
    request: &RuntimeEventCompactionRequest,
) -> Result<Vec<RuntimeEventCompactionRow>, String> {
    validate_runtime_event_identifier(&request.task_id, "taskId")?;
    if request.event_ids.is_empty() || request.event_ids.len() > MAX_RUNTIME_EVENT_COMPACTION_IDS {
        return Err("Runtime event compaction eventIds count is out of range.".to_string());
    }
    if request.compaction_envelopes.is_empty()
        || request.compaction_envelopes.len() > MAX_RUNTIME_EVENT_COMPACTION_ENVELOPES
    {
        return Err(
            "Runtime event compaction compactionEnvelopes count is out of range.".to_string(),
        );
    }

    let mut source_ids = HashSet::with_capacity(request.event_ids.len());
    for event_id in &request.event_ids {
        validate_runtime_event_identifier(event_id, "eventIds[]")?;
        if !source_ids.insert(event_id.as_str()) {
            return Err("Runtime event compaction eventIds must be unique.".to_string());
        }
    }

    let mut compaction_ids = HashSet::with_capacity(request.compaction_envelopes.len());
    let mut rows = Vec::with_capacity(request.compaction_envelopes.len());
    let mut compacted_event_count = 0usize;
    for envelope in &request.compaction_envelopes {
        let row = parse_runtime_event_compaction_envelope(envelope, &request.task_id)?;
        if source_ids.contains(row.event_id.as_str()) {
            return Err(
                "Runtime event compaction summary eventId overlaps a source eventId.".to_string(),
            );
        }
        if !compaction_ids.insert(row.event_id.clone()) {
            return Err("Runtime event compaction summary eventIds must be unique.".to_string());
        }
        compacted_event_count = compacted_event_count
            .checked_add(row.compacted_event_count)
            .ok_or_else(|| "Runtime event compaction count overflow.".to_string())?;
        rows.push(row);
    }
    if compacted_event_count != request.event_ids.len() {
        return Err("Runtime event compaction payload counts do not match eventIds.".to_string());
    }
    Ok(rows)
}

fn parse_runtime_event_compaction_envelope(
    envelope: &serde_json::Value,
    expected_task_id: &str,
) -> Result<RuntimeEventCompactionRow, String> {
    let object = envelope
        .as_object()
        .ok_or_else(|| "Runtime event compaction envelope must be a JSON object.".to_string())?;
    let event_id = runtime_event_required_string(object, "eventId")?;
    let task_id = runtime_event_required_string(object, "taskId")?;
    if task_id != expected_task_id {
        return Err("Runtime event compaction envelope taskId does not match.".to_string());
    }
    let run_id = runtime_event_required_string(object, "runId")?;
    let correlation_id = runtime_event_required_string(object, "correlationId")?;
    validate_runtime_event_identifier(&event_id, "envelope.eventId")?;
    validate_runtime_event_identifier(&run_id, "envelope.runId")?;
    validate_runtime_event_identifier(&correlation_id, "envelope.correlationId")?;

    let sequence = runtime_event_required_positive_integer(object, "sequence")?;
    let event_version = runtime_event_required_positive_integer(object, "eventVersion")?;
    let workflow_id = runtime_event_optional_string(object, "workflowId")?;
    let step_id = runtime_event_optional_string(object, "stepId")?;
    let agent_id = runtime_event_optional_string(object, "agentId")?;
    let occurred_at = runtime_event_required_string(object, "occurredAt")?;
    let recorded_at = runtime_event_required_string(object, "recordedAt")?;
    validate_runtime_event_timestamp(&occurred_at, "occurredAt")?;
    validate_runtime_event_timestamp(&recorded_at, "recordedAt")?;

    let payload = object
        .get("payload")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "Runtime event compaction payload must be an object.".to_string())?;
    if payload.get("kind").and_then(serde_json::Value::as_str) != Some("runtime.compacted") {
        return Err("Runtime event compaction payload kind is invalid.".to_string());
    }
    if payload.get("taskId").and_then(serde_json::Value::as_str) != Some(expected_task_id) {
        return Err("Runtime event compaction payload taskId does not match.".to_string());
    }
    let payload_binding = validate_runtime_event_compaction_payload(payload)?;

    let envelope_json = serde_json::to_string(envelope)
        .map_err(|error| format!("Runtime event compaction serialization error: {error}"))?;
    if envelope_json.len() > MAX_RUNTIME_EVENT_ENVELOPE_BYTES {
        return Err("Runtime event compaction envelope is too large.".to_string());
    }

    Ok(RuntimeEventCompactionRow {
        event_id,
        task_id,
        run_id,
        sequence,
        event_version,
        workflow_id,
        step_id,
        agent_id,
        occurred_at,
        recorded_at,
        envelope_json,
        compacted_event_count: payload_binding.compacted_event_count,
        compacted_event_kinds: payload_binding.compacted_event_kinds,
        first_sequence: payload_binding.first_sequence,
        last_sequence: payload_binding.last_sequence,
    })
}

struct RuntimeEventCompactionPayloadBinding {
    compacted_event_count: usize,
    compacted_event_kinds: HashSet<String>,
    first_sequence: i64,
    last_sequence: i64,
}

fn validate_runtime_event_compaction_payload(
    payload: &serde_json::Map<String, serde_json::Value>,
) -> Result<RuntimeEventCompactionPayloadBinding, String> {
    let kinds = payload
        .get("compactedEventKinds")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "Runtime event compaction payload compactedEventKinds is invalid.".to_string()
        })?;
    if kinds.is_empty()
        || !kinds.iter().all(|kind| {
            kind.as_str()
                .map(is_streaming_runtime_event_kind)
                .unwrap_or(false)
        })
    {
        return Err(
            "Runtime event compaction payload contains a non-streaming event kind.".to_string(),
        );
    }
    let compacted_event_kinds = kinds
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    if compacted_event_kinds.len() != kinds.len() {
        return Err(
            "Runtime event compaction payload compactedEventKinds must be unique.".to_string(),
        );
    }
    let compacted_event_count = payload
        .get("compactedEventCount")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| {
            "Runtime event compaction payload compactedEventCount is invalid.".to_string()
        })?;
    if compacted_event_count == 0 {
        return Err(
            "Runtime event compaction payload compactedEventCount must be positive.".to_string(),
        );
    }
    let range = payload
        .get("originalSequenceRange")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            "Runtime event compaction payload originalSequenceRange is invalid.".to_string()
        })?;
    let first = range
        .get("first")
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            "Runtime event compaction payload originalSequenceRange.first is invalid.".to_string()
        })?;
    let last = range
        .get("last")
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value >= first)
        .ok_or_else(|| {
            "Runtime event compaction payload originalSequenceRange.last is invalid.".to_string()
        })?;
    if last < first {
        return Err(
            "Runtime event compaction payload originalSequenceRange is invalid.".to_string(),
        );
    }
    let summary = payload
        .get("summary")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Runtime event compaction payload summary is invalid.".to_string())?;
    if summary.chars().count() > 25_000 {
        return Err("Runtime event compaction payload summary is too large.".to_string());
    }
    let content_hash = payload
        .get("contentHash")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Runtime event compaction payload contentHash is invalid.".to_string())?;
    if content_hash.len() != 64
        || !content_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Runtime event compaction payload contentHash is invalid.".to_string());
    }
    if payload
        .get("hashAlgorithm")
        .and_then(serde_json::Value::as_str)
        != Some("sha256-canonical-json-v1")
    {
        return Err("Runtime event compaction payload hashAlgorithm is invalid.".to_string());
    }
    if !payload
        .get("truncated")
        .map(serde_json::Value::is_boolean)
        .unwrap_or(false)
    {
        return Err("Runtime event compaction payload truncated is invalid.".to_string());
    }
    Ok(RuntimeEventCompactionPayloadBinding {
        compacted_event_count,
        compacted_event_kinds,
        first_sequence: first,
        last_sequence: last,
    })
}

fn load_compaction_source_events(
    transaction: &rusqlite::Transaction<'_>,
    task_id: &str,
    event_ids: &[String],
) -> Result<Vec<RuntimeEventCompactionSource>, String> {
    let mut sources = Vec::with_capacity(event_ids.len());
    for batch in event_ids.chunks(RUNTIME_EVENT_COMPACTION_DELETE_BATCH_SIZE) {
        let placeholders = vec!["?"; batch.len()].join(", ");
        let sql = format!(
            "SELECT event_id, run_id, sequence, event_kind FROM runtime_events WHERE task_id = ? AND event_id IN ({placeholders})"
        );
        let params = runtime_event_batch_params(task_id, batch);
        let mut statement = transaction
            .prepare(&sql)
            .map_err(|error| format!("Runtime event compaction source prepare error: {error}"))?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok(RuntimeEventCompactionSource {
                    event_id: row.get(0)?,
                    run_id: row.get(1)?,
                    sequence: row.get(2)?,
                    event_kind: row.get(3)?,
                })
            })
            .map_err(|error| format!("Runtime event compaction source query error: {error}"))?;
        for row in rows {
            let source = row
                .map_err(|error| format!("Runtime event compaction source read error: {error}"))?;
            if !is_streaming_runtime_event_kind(&source.event_kind) {
                return Err(
                    "Runtime event compaction can only delete streaming events.".to_string()
                );
            }
            sources.push(source);
        }
    }
    Ok(sources)
}

fn require_terminal_compaction_runs(
    transaction: &rusqlite::Transaction<'_>,
    task_id: &str,
    compaction_rows: &[RuntimeEventCompactionRow],
) -> Result<(), String> {
    let mut seen_run_ids = HashSet::with_capacity(compaction_rows.len());
    for row in compaction_rows {
        if !seen_run_ids.insert(row.run_id.as_str()) {
            return Err(
                "Runtime event compaction requires exactly one summary per run.".to_string(),
            );
        }
        let has_terminal_event = transaction
            .query_row(
                "SELECT 1 FROM runtime_events WHERE task_id = ? AND run_id = ? AND event_kind IN ('task.completed', 'task.failed') LIMIT 1",
                rusqlite::params![task_id, row.run_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| {
                format!("Runtime event compaction terminal run check error: {error}")
            })?
            .is_some();
        if !has_terminal_event {
            return Err(format!(
                "Runtime event compaction requires terminal run {}.",
                row.run_id
            ));
        }
    }
    Ok(())
}

fn validate_compaction_source_bindings(
    transaction: &rusqlite::Transaction<'_>,
    task_id: &str,
    source_events: &[RuntimeEventCompactionSource],
    compaction_rows: &[RuntimeEventCompactionRow],
) -> Result<(), String> {
    let summaries_by_run = compaction_rows
        .iter()
        .map(|row| (row.run_id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let mut sources_by_run: HashMap<&str, Vec<&RuntimeEventCompactionSource>> = HashMap::new();
    for source in source_events {
        sources_by_run
            .entry(source.run_id.as_str())
            .or_default()
            .push(source);
    }
    if sources_by_run.len() != summaries_by_run.len() {
        return Err(
            "Runtime event compaction summaries do not match source event runs.".to_string(),
        );
    }

    for (run_id, run_sources) in sources_by_run {
        let summary = summaries_by_run.get(run_id).ok_or_else(|| {
            format!("Runtime event compaction is missing a summary for run {run_id}.")
        })?;
        if summary.compacted_event_count != run_sources.len() {
            return Err(format!(
                "Runtime event compaction summary count does not match source IDs for run {run_id}."
            ));
        }
        let first_sequence = run_sources
            .iter()
            .map(|source| source.sequence)
            .min()
            .ok_or_else(|| "Runtime event compaction source run is empty.".to_string())?;
        let last_sequence = run_sources
            .iter()
            .map(|source| source.sequence)
            .max()
            .ok_or_else(|| "Runtime event compaction source run is empty.".to_string())?;
        if summary.first_sequence != first_sequence || summary.last_sequence != last_sequence {
            return Err(format!(
                "Runtime event compaction summary range does not match source IDs for run {run_id}."
            ));
        }
        let source_kinds = run_sources
            .iter()
            .map(|source| source.event_kind.clone())
            .collect::<HashSet<_>>();
        if summary.compacted_event_kinds != source_kinds {
            return Err(format!(
                "Runtime event compaction summary kinds do not match source IDs for run {run_id}."
            ));
        }
        let max_run_sequence = transaction
            .query_row(
                "SELECT MAX(sequence) FROM runtime_events WHERE task_id = ? AND run_id = ?",
                rusqlite::params![task_id, run_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .map_err(|error| format!("Runtime event compaction run sequence check error: {error}"))?
            .ok_or_else(|| format!("Runtime event compaction run {run_id} is missing."))?;
        if summary.sequence <= max_run_sequence {
            return Err(format!(
                "Runtime event compaction summary sequence must follow run {run_id}."
            ));
        }

        let source_ids = run_sources
            .iter()
            .map(|source| source.event_id.as_str())
            .collect::<HashSet<_>>();
        if source_ids.len() != run_sources.len() {
            return Err(format!(
                "Runtime event compaction source IDs are not unique for run {run_id}."
            ));
        }
        let mut statement = transaction
            .prepare(
                "SELECT event_id FROM runtime_events WHERE task_id = ? AND run_id = ? AND sequence BETWEEN ? AND ? AND event_kind IN ('agent.chunk_start', 'agent.chunk', 'agent.chunk_end', 'tool.partial')",
            )
            .map_err(|error| {
                format!("Runtime event compaction source range prepare error: {error}")
            })?;
        let rows = statement
            .query_map(
                rusqlite::params![
                    task_id,
                    run_id,
                    summary.first_sequence,
                    summary.last_sequence
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| {
                format!("Runtime event compaction source range query error: {error}")
            })?;
        let mut range_source_ids = HashSet::new();
        for row in rows {
            range_source_ids.insert(row.map_err(|error| {
                format!("Runtime event compaction source range read error: {error}")
            })?);
        }
        if range_source_ids.len() != source_ids.len()
            || !range_source_ids
                .iter()
                .all(|event_id| source_ids.contains(event_id.as_str()))
        {
            return Err(format!(
                "Runtime event compaction source IDs do not exactly cover the summary range for run {run_id}."
            ));
        }
    }
    Ok(())
}

fn all_compaction_rows_already_persisted(
    transaction: &rusqlite::Transaction<'_>,
    rows: &[RuntimeEventCompactionRow],
) -> Result<bool, String> {
    for row in rows {
        let existing = transaction
            .query_row(
                "SELECT envelope_json FROM runtime_events WHERE event_id = ? LIMIT 1",
                [&row.event_id],
                |db_row| db_row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                format!("Runtime event compaction idempotency check error: {error}")
            })?;
        if existing.as_deref() != Some(row.envelope_json.as_str()) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn delete_runtime_event_batch(
    transaction: &rusqlite::Transaction<'_>,
    task_id: &str,
    event_ids: &[String],
) -> Result<(), String> {
    let placeholders = vec!["?"; event_ids.len()].join(", ");
    let sql =
        format!("DELETE FROM runtime_events WHERE task_id = ? AND event_id IN ({placeholders})");
    let params = runtime_event_batch_params(task_id, event_ids);
    transaction
        .execute(&sql, rusqlite::params_from_iter(params.iter()))
        .map_err(|error| format!("Runtime event compaction delete error: {error}"))?;
    Ok(())
}

fn runtime_event_batch_params(task_id: &str, event_ids: &[String]) -> Vec<rusqlite::types::Value> {
    std::iter::once(rusqlite::types::Value::Text(task_id.to_string()))
        .chain(event_ids.iter().cloned().map(rusqlite::types::Value::Text))
        .collect()
}

fn insert_runtime_event_compaction_row(
    transaction: &rusqlite::Transaction<'_>,
    row: &RuntimeEventCompactionRow,
) -> Result<(), String> {
    let existing = transaction
        .query_row(
            "SELECT envelope_json FROM runtime_events WHERE event_id = ? LIMIT 1",
            [&row.event_id],
            |db_row| db_row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Runtime event compaction existing-row check error: {error}"))?;
    if let Some(existing) = existing {
        if existing == row.envelope_json {
            return Ok(());
        }
        return Err("Runtime event compaction eventId conflicts with existing data.".to_string());
    }
    transaction
        .execute(
            "INSERT INTO runtime_events (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json) VALUES (?, ?, ?, ?, ?, 'runtime.compacted', ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                row.event_id,
                row.task_id,
                row.run_id,
                row.sequence,
                row.event_version,
                row.workflow_id,
                row.step_id,
                row.agent_id,
                row.occurred_at,
                row.recorded_at,
                row.envelope_json,
            ],
        )
        .map_err(|error| format!("Runtime event compaction insert error: {error}"))?;
    Ok(())
}

fn runtime_event_required_string(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<String, String> {
    object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Runtime event compaction envelope {field} is invalid."))
}

fn runtime_event_optional_string(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<Option<String>, String> {
    match object.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => {
            validate_runtime_event_identifier(value, field)?;
            Ok(Some(value.clone()))
        }
        _ => Err(format!(
            "Runtime event compaction envelope {field} is invalid."
        )),
    }
}

fn runtime_event_required_positive_integer(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<i64, String> {
    object
        .get(field)
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("Runtime event compaction envelope {field} is invalid."))
}

fn validate_runtime_event_identifier(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > MAX_RUNTIME_EVENT_ID_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(format!("Runtime event compaction {field} is invalid."));
    }
    Ok(())
}

fn validate_runtime_event_timestamp(value: &str, field: &str) -> Result<(), String> {
    if value.len() > 64 || !value.contains('T') || !value.ends_with('Z') {
        return Err(format!(
            "Runtime event compaction envelope {field} must be an ISO timestamp."
        ));
    }
    Ok(())
}

fn is_streaming_runtime_event_kind(kind: &str) -> bool {
    matches!(
        kind,
        "agent.chunk_start" | "agent.chunk" | "agent.chunk_end" | "tool.partial"
    )
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
            let tables = match first {
                "alter" => alter_statement_tables(&tokens)?,
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

fn alter_statement_tables(tokens: &[String]) -> Result<Vec<String>, String> {
    match tokens {
        [alter, table, table_name, ..] if alter == "alter" && table == "table" => {
            Ok(vec![table_name.clone()])
        }
        _ => Err("Only ALTER TABLE statements are allowed.".to_string()),
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
            | "select record_json from approval_records order by created_at desc"
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
            | "select envelope_json from runtime_events where run_id order by sequence asc limit"
            | "select envelope_json from runtime_events where run_id and sequence order by sequence asc limit"
            | "select envelope_json from runtime_events where task_id order by recorded_at asc sequence asc limit"
            | "select envelope_json from runtime_events where run_id order by sequence desc limit 1"
            | "select count as count from runtime_events where run_id"
            | "select checkpoint_json from workflow_checkpoints where run_id order by event_sequence desc limit 1"
            | "select checkpoint_json from workflow_checkpoints where task_id order by created_at desc rowid desc limit 1"
            | "select checkpoint_json from workflow_checkpoints where task_id order by created_at desc rowid desc limit"
            | "select checkpoint_id from workflow_checkpoints where task_id order by created_at desc rowid desc"
    ) && has_required_select_operator_shape(&signature, sql_text)
    {
        Ok(())
    } else {
        Err("db_select only allows known app query shapes.".to_string())
    }
}

fn has_required_select_operator_shape(signature: &str, sql_text: &str) -> bool {
    match signature {
        "select record_json from approval_records order by created_at desc" => {
            sql_text.ends_with("order by created_at desc")
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
        "select envelope_json from runtime_events where run_id order by sequence asc limit" => {
            sql_text.contains("where run_id = ?") && sql_text.contains("order by sequence asc") && sql_text.contains("limit ?")
        }
        "select envelope_json from runtime_events where run_id and sequence order by sequence asc limit" => {
            sql_text.contains("where run_id = ? and sequence <= ?")
                && sql_text.contains("order by sequence asc")
                && sql_text.contains("limit ?")
        }
        "select envelope_json from runtime_events where task_id order by recorded_at asc sequence asc limit" => {
            sql_text.contains("where task_id = ?") && sql_text.contains("order by recorded_at asc") && sql_text.contains("limit ?")
        }
        "select envelope_json from runtime_events where run_id order by sequence desc limit 1" => {
            sql_text.contains("where run_id = ?") && sql_text.contains("order by sequence desc") && sql_text.contains("limit 1")
        }
        "select count as count from runtime_events where run_id" => {
            sql_text.contains("where run_id = ?")
        }
        "select checkpoint_json from workflow_checkpoints where run_id order by event_sequence desc limit 1" => {
            sql_text.contains("where run_id = ?")
                && sql_text.contains("order by event_sequence desc")
                && sql_text.contains("limit 1")
        }
        "select checkpoint_json from workflow_checkpoints where task_id order by created_at desc rowid desc limit 1" => {
            sql_text.contains("where task_id = ?")
                && sql_text.contains("order by created_at desc, rowid desc")
                && sql_text.contains("limit 1")
        }
        "select checkpoint_json from workflow_checkpoints where task_id order by created_at desc rowid desc limit" => {
            sql_text.contains("where task_id = ?")
                && sql_text.contains("order by created_at desc, rowid desc")
                && sql_text.contains("limit ?")
        }
        "select checkpoint_id from workflow_checkpoints where task_id order by created_at desc rowid desc" => {
            sql_text.contains("where task_id = ?")
                && sql_text.contains("order by created_at desc, rowid desc")
        }
        _ => true,
    }
}

fn require_known_execute_shape(tokens: &[String], sql_text: &str) -> Result<(), String> {
    let signature = sql_signature(tokens);
    if is_known_create_shape(tokens)
        || matches!(
            signature.as_str(),
            "alter table approval_records add column run_id text"
                | "insert into schema_migrations id applied_at values"
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
                | "insert into runtime_events event_id task_id run_id sequence event_version event_kind workflow_id step_id agent_id occurred_at recorded_at envelope_json values"
                | "insert into runtime_events event_id task_id run_id sequence event_version event_kind workflow_id step_id agent_id occurred_at recorded_at envelope_json values on conflict event_id do nothing"
                | "insert into workflow_checkpoints checkpoint_id task_id run_id workflow_id workflow_version plan_hash event_sequence created_at workflow_json checkpoint_json values on conflict checkpoint_id do update set task_id excluded task_id run_id excluded run_id workflow_id excluded workflow_id workflow_version excluded workflow_version plan_hash excluded plan_hash event_sequence excluded event_sequence created_at excluded created_at workflow_json excluded workflow_json checkpoint_json excluded checkpoint_json"
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
                | "delete from runtime_events where task_id"
                | "delete from runtime_events where task_id and event_kind in"
                | "delete from runtime_events where task_id and event_id in"
                | "delete from workflow_checkpoints where checkpoint_id"
        ) && has_required_execute_operator_shape(&signature, sql_text)
    {
        Ok(())
    } else {
        Err("db_execute only allows known app statement shapes.".to_string())
    }
}

fn has_required_execute_operator_shape(signature: &str, sql_text: &str) -> bool {
    match signature {
        "alter table approval_records add column run_id text" => {
            sql_text == "alter table approval_records add column run_id text"
        }
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
        "insert into runtime_events event_id task_id run_id sequence event_version event_kind workflow_id step_id agent_id occurred_at recorded_at envelope_json values on conflict event_id do nothing" => {
            sql_text.contains("on conflict(event_id) do nothing")
        }
        "insert or ignore into vector_index_buckets namespace bucket_key item_id values" => {
            sql_text.contains("values (?, ?, ?)")
        }
        "delete from vector_index_buckets where item_id" => sql_text.contains("where item_id = ?"),
        "delete from vector_index_items where id" => sql_text.contains("where id = ?"),
        "delete from runtime_events where task_id" => sql_text.contains("where task_id = ?"),
        "delete from runtime_events where task_id and event_kind in" => {
            sql_text.contains("where task_id = ?") && sql_text.contains("event_kind in")
        }
        "delete from runtime_events where task_id and event_id in" => {
            sql_text.contains("where task_id = ?") && sql_text.contains("event_id in")
        }
        "delete from workflow_checkpoints where checkpoint_id" => {
            sql_text.contains("where checkpoint_id = ?")
        }
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
            "run_id",
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
        "runtime_events" => &[
            "event_id",
            "task_id",
            "run_id",
            "sequence",
            "event_version",
            "event_kind",
            "workflow_id",
            "step_id",
            "agent_id",
            "occurred_at",
            "recorded_at",
            "envelope_json",
        ],
        "workflow_checkpoints" => &[
            "checkpoint_id",
            "task_id",
            "run_id",
            "workflow_id",
            "workflow_version",
            "plan_hash",
            "event_sequence",
            "created_at",
            "workflow_json",
            "checkpoint_json",
        ],
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
            | ("goal_events_goal_created_idx", "goal_events")
            | ("goal_evaluations_goal_created_idx", "goal_evaluations")
            | ("goal_evaluations_goal_task_idx", "goal_evaluations")
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
            | ("idx_runtime_events_task_recorded", "runtime_events")
            | ("idx_runtime_events_run_sequence", "runtime_events")
            | ("idx_runtime_events_workflow_recorded", "runtime_events")
            | ("idx_runtime_events_kind_recorded", "runtime_events")
            | (
                "idx_workflow_checkpoints_task_created",
                "workflow_checkpoints"
            )
            | (
                "idx_workflow_checkpoints_run_sequence",
                "workflow_checkpoints"
            )
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
    if let Some(run_id) = request.run_id.as_deref() {
        require_non_empty(run_id, "runId")?;
    }
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
    require_optional_json_string(&record, "runId", request.run_id.as_deref())?;
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
            "runId": "run-1",
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
            run_id: Some("run-1".to_string()),
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

    fn in_memory_connection() -> Connection {
        Connection::open_in_memory().expect("open in-memory sqlite database")
    }

    fn create_runtime_events_table(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                CREATE TABLE runtime_events (
                  event_id TEXT PRIMARY KEY,
                  task_id TEXT NOT NULL,
                  run_id TEXT NOT NULL,
                  sequence INTEGER NOT NULL,
                  event_version INTEGER NOT NULL,
                  event_kind TEXT NOT NULL,
                  workflow_id TEXT,
                  step_id TEXT,
                  agent_id TEXT,
                  occurred_at TEXT NOT NULL,
                  recorded_at TEXT NOT NULL,
                  envelope_json TEXT NOT NULL,
                  UNIQUE(run_id, sequence)
                );
                "#,
            )
            .expect("create runtime_events table");
    }

    fn insert_runtime_event(
        connection: &Connection,
        event_id: &str,
        task_id: &str,
        run_id: &str,
        sequence: i64,
        event_kind: &str,
    ) {
        let envelope = serde_json::json!({
            "eventId": event_id,
            "eventVersion": 1,
            "sequence": sequence,
            "taskId": task_id,
            "runId": run_id,
            "correlationId": run_id,
            "occurredAt": "2026-06-16T00:00:00.000Z",
            "recordedAt": "2026-06-16T00:00:00.001Z",
            "payload": { "kind": event_kind, "taskId": task_id }
        });
        connection
            .execute(
                "INSERT INTO runtime_events (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json) VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, NULL, ?, ?, ?)",
                rusqlite::params![
                    event_id,
                    task_id,
                    run_id,
                    sequence,
                    event_kind,
                    "2026-06-16T00:00:00.000Z",
                    "2026-06-16T00:00:00.001Z",
                    envelope.to_string(),
                ],
            )
            .expect("insert runtime event");
    }

    fn runtime_compaction_envelope(
        event_id: &str,
        task_id: &str,
        run_id: &str,
        sequence: i64,
        compacted_event_count: usize,
        first_sequence: i64,
        last_sequence: i64,
    ) -> serde_json::Value {
        serde_json::json!({
            "eventId": event_id,
            "eventVersion": 1,
            "sequence": sequence,
            "taskId": task_id,
            "runId": run_id,
            "correlationId": run_id,
            "occurredAt": "2026-06-16T00:00:01.000Z",
            "recordedAt": "2026-06-16T00:00:01.001Z",
            "payload": {
                "kind": "runtime.compacted",
                "taskId": task_id,
                "compactedEventKinds": ["agent.chunk"],
                "compactedEventCount": compacted_event_count,
                "originalSequenceRange": {
                    "first": first_sequence,
                    "last": last_sequence
                },
                "summary": "summary",
                "contentHash": "a".repeat(64),
                "hashAlgorithm": "sha256-canonical-json-v1",
                "truncated": false
            }
        })
    }

    fn create_workflow_checkpoints_table(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                CREATE TABLE workflow_checkpoints (
                  checkpoint_id TEXT PRIMARY KEY,
                  task_id TEXT NOT NULL,
                  run_id TEXT NOT NULL,
                  workflow_id TEXT NOT NULL,
                  workflow_version INTEGER NOT NULL,
                  plan_hash TEXT NOT NULL,
                  event_sequence INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  workflow_json TEXT NOT NULL,
                  checkpoint_json TEXT NOT NULL,
                  UNIQUE(run_id, event_sequence)
                );
                "#,
            )
            .expect("create workflow_checkpoints table");
    }

    fn create_approval_records_prune_table(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                CREATE TABLE approval_records (
                  approval_id TEXT PRIMARY KEY,
                  status TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  record_json TEXT NOT NULL
                );
                "#,
            )
            .expect("create approval_records table");
    }

    fn insert_approval_prune_row(
        connection: &Connection,
        approval_id: &str,
        status: &str,
        created_at: &str,
        workflow_bound: Option<bool>,
        execution_status: Option<&str>,
    ) {
        let mut record = serde_json::json!({
            "approvalId": approval_id,
            "taskId": "task-1",
            "status": status,
        });
        if let Some(workflow_bound) = workflow_bound {
            record["workflowBound"] = serde_json::Value::Bool(workflow_bound);
        }
        if let Some(execution_status) = execution_status {
            record["execution"] = serde_json::json!({ "status": execution_status });
        }
        connection
            .execute(
                "INSERT INTO approval_records (approval_id, status, created_at, record_json) VALUES (?, ?, ?, ?)",
                rusqlite::params![approval_id, status, created_at, record.to_string()],
            )
            .expect("insert approval prune row");
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
    fn runtime_events_reject_duplicate_run_and_sequence() {
        let connection = in_memory_connection();
        create_runtime_events_table(&connection);

        connection
            .execute(
                r#"INSERT INTO runtime_events
                   (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
                [
                    "evt-1",
                    "task-1",
                    "run-1",
                    "1",
                    "1",
                    "step.started",
                    "workflow-1",
                    "step-1",
                    "agent-1",
                    "2026-06-16T00:00:00.000Z",
                    "2026-06-16T00:00:00.001Z",
                    r#"{"eventId":"evt-1"}"#,
                ],
            )
            .expect("insert first runtime event");

        let duplicate = connection.execute(
            r#"INSERT INTO runtime_events
               (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            [
                "evt-2",
                "task-1",
                "run-1",
                "1",
                "1",
                "step.completed",
                "workflow-1",
                "step-1",
                "agent-1",
                "2026-06-16T00:00:01.000Z",
                "2026-06-16T00:00:01.001Z",
                r#"{"eventId":"evt-2"}"#,
            ],
        );

        assert!(duplicate.is_err());
    }

    #[test]
    fn runtime_event_compaction_is_atomic_and_idempotent() {
        let connection = in_memory_connection();
        create_runtime_events_table(&connection);
        insert_runtime_event(
            &connection,
            "evt-chunk-1",
            "task-compact",
            "run-compact",
            1,
            "agent.chunk",
        );
        insert_runtime_event(
            &connection,
            "evt-chunk-2",
            "task-compact",
            "run-compact",
            2,
            "agent.chunk",
        );
        insert_runtime_event(
            &connection,
            "evt-terminal",
            "task-compact",
            "run-compact",
            3,
            "task.completed",
        );
        let request = RuntimeEventCompactionRequest {
            task_id: "task-compact".to_string(),
            event_ids: vec!["evt-chunk-1".to_string(), "evt-chunk-2".to_string()],
            compaction_envelopes: vec![runtime_compaction_envelope(
                "evt-summary",
                "task-compact",
                "run-compact",
                4,
                2,
                1,
                2,
            )],
        };

        compact_runtime_events(&connection, &request).expect("compact runtime events");
        compact_runtime_events(&connection, &request).expect("replay compaction request");

        let remaining_streams: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_events WHERE event_kind = 'agent.chunk'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let summaries: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_events WHERE event_kind = 'runtime.compacted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_streams, 0);
        assert_eq!(summaries, 1);
    }

    #[test]
    fn runtime_event_compaction_rejects_active_source_run_even_when_task_has_terminal_run() {
        let connection = in_memory_connection();
        create_runtime_events_table(&connection);
        insert_runtime_event(
            &connection,
            "evt-terminal-run-done",
            "task-multi-run-guard",
            "run-done",
            1,
            "task.completed",
        );
        insert_runtime_event(
            &connection,
            "evt-active-chunk",
            "task-multi-run-guard",
            "run-active",
            1,
            "agent.chunk",
        );
        let request = RuntimeEventCompactionRequest {
            task_id: "task-multi-run-guard".to_string(),
            event_ids: vec!["evt-active-chunk".to_string()],
            compaction_envelopes: vec![runtime_compaction_envelope(
                "evt-active-summary",
                "task-multi-run-guard",
                "run-active",
                2,
                1,
                1,
                1,
            )],
        };

        let error = compact_runtime_events(&connection, &request).unwrap_err();

        assert!(error.contains("run-active"));
        let active_streams: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_events WHERE event_id = 'evt-active-chunk'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_streams, 1);
    }

    #[test]
    fn runtime_event_compaction_rejects_summary_for_different_run() {
        let connection = in_memory_connection();
        create_runtime_events_table(&connection);
        insert_runtime_event(
            &connection,
            "evt-source-chunk",
            "task-run-binding",
            "run-source",
            1,
            "agent.chunk",
        );
        insert_runtime_event(
            &connection,
            "evt-source-terminal",
            "task-run-binding",
            "run-source",
            2,
            "task.completed",
        );
        insert_runtime_event(
            &connection,
            "evt-other-terminal",
            "task-run-binding",
            "run-other",
            1,
            "task.completed",
        );
        let request = RuntimeEventCompactionRequest {
            task_id: "task-run-binding".to_string(),
            event_ids: vec!["evt-source-chunk".to_string()],
            compaction_envelopes: vec![runtime_compaction_envelope(
                "evt-other-summary",
                "task-run-binding",
                "run-other",
                2,
                1,
                1,
                1,
            )],
        };

        let error = compact_runtime_events(&connection, &request).unwrap_err();

        assert!(error.contains("missing a summary for run run-source"));
    }

    #[test]
    fn runtime_event_compaction_rejects_per_run_count_mismatch() {
        let connection = in_memory_connection();
        create_runtime_events_table(&connection);
        for (event_id, sequence, kind) in [
            ("evt-run-a-chunk-1", 1, "agent.chunk"),
            ("evt-run-a-chunk-2", 2, "agent.chunk"),
            ("evt-run-a-terminal", 3, "task.completed"),
        ] {
            insert_runtime_event(
                &connection,
                event_id,
                "task-count-binding",
                "run-a",
                sequence,
                kind,
            );
        }
        for (event_id, sequence, kind) in [
            ("evt-run-b-chunk", 1, "agent.chunk"),
            ("evt-run-b-terminal", 2, "task.completed"),
        ] {
            insert_runtime_event(
                &connection,
                event_id,
                "task-count-binding",
                "run-b",
                sequence,
                kind,
            );
        }
        let request = RuntimeEventCompactionRequest {
            task_id: "task-count-binding".to_string(),
            event_ids: vec![
                "evt-run-a-chunk-1".to_string(),
                "evt-run-a-chunk-2".to_string(),
                "evt-run-b-chunk".to_string(),
            ],
            compaction_envelopes: vec![
                runtime_compaction_envelope(
                    "evt-run-a-summary",
                    "task-count-binding",
                    "run-a",
                    4,
                    1,
                    1,
                    1,
                ),
                runtime_compaction_envelope(
                    "evt-run-b-summary",
                    "task-count-binding",
                    "run-b",
                    3,
                    2,
                    1,
                    1,
                ),
            ],
        };

        let error = compact_runtime_events(&connection, &request).unwrap_err();

        assert!(error.contains("count does not match"));
    }

    #[test]
    fn runtime_event_compaction_rejects_unlisted_streaming_source_in_summary_range() {
        let connection = in_memory_connection();
        create_runtime_events_table(&connection);
        for (event_id, sequence, kind) in [
            ("evt-range-chunk-1", 1, "agent.chunk"),
            ("evt-range-chunk-2", 2, "agent.chunk"),
            ("evt-range-chunk-3", 3, "agent.chunk"),
            ("evt-range-terminal", 4, "task.completed"),
        ] {
            insert_runtime_event(
                &connection,
                event_id,
                "task-range-binding",
                "run-range",
                sequence,
                kind,
            );
        }
        let request = RuntimeEventCompactionRequest {
            task_id: "task-range-binding".to_string(),
            event_ids: vec![
                "evt-range-chunk-1".to_string(),
                "evt-range-chunk-3".to_string(),
            ],
            compaction_envelopes: vec![runtime_compaction_envelope(
                "evt-range-summary",
                "task-range-binding",
                "run-range",
                5,
                2,
                1,
                3,
            )],
        };

        let error = compact_runtime_events(&connection, &request).unwrap_err();

        assert!(error.contains("source IDs do not exactly cover"));
    }

    #[test]
    fn runtime_event_compaction_rolls_back_delete_and_prior_insert_on_failure() {
        let connection = in_memory_connection();
        create_runtime_events_table(&connection);
        insert_runtime_event(
            &connection,
            "evt-run-1-chunk",
            "task-rollback",
            "run-rollback-1",
            1,
            "agent.chunk",
        );
        insert_runtime_event(
            &connection,
            "evt-run-2-chunk",
            "task-rollback",
            "run-rollback-2",
            1,
            "agent.chunk",
        );
        insert_runtime_event(
            &connection,
            "evt-run-2-terminal",
            "task-rollback",
            "run-rollback-2",
            2,
            "task.completed",
        );
        insert_runtime_event(
            &connection,
            "evt-run-1-terminal",
            "task-rollback",
            "run-rollback-1",
            2,
            "task.completed",
        );
        insert_runtime_event(
            &connection,
            "evt-run-2-summary",
            "other-task",
            "other-run",
            1,
            "task.created",
        );
        let request = RuntimeEventCompactionRequest {
            task_id: "task-rollback".to_string(),
            event_ids: vec!["evt-run-1-chunk".to_string(), "evt-run-2-chunk".to_string()],
            compaction_envelopes: vec![
                runtime_compaction_envelope(
                    "evt-run-1-summary",
                    "task-rollback",
                    "run-rollback-1",
                    3,
                    1,
                    1,
                    1,
                ),
                runtime_compaction_envelope(
                    "evt-run-2-summary",
                    "task-rollback",
                    "run-rollback-2",
                    3,
                    1,
                    1,
                    1,
                ),
            ],
        };

        assert!(compact_runtime_events(&connection, &request).is_err());

        let remaining_streams: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_events WHERE event_kind = 'agent.chunk'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let summaries: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_events WHERE event_kind = 'runtime.compacted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining_streams, 2);
        assert_eq!(summaries, 0);
    }

    #[test]
    fn workflow_checkpoints_reject_duplicate_run_and_event_sequence() {
        let connection = in_memory_connection();
        create_workflow_checkpoints_table(&connection);

        connection
            .execute(
                r#"INSERT INTO workflow_checkpoints
                   (checkpoint_id, task_id, run_id, workflow_id, workflow_version, plan_hash, event_sequence, created_at, workflow_json, checkpoint_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
                [
                    "ckpt-1",
                    "task-1",
                    "run-1",
                    "workflow-1",
                    "1",
                    "plan-1",
                    "3",
                    "2026-06-16T00:00:03.000Z",
                    "{}",
                    "{}",
                ],
            )
            .expect("insert first checkpoint");

        let duplicate = connection.execute(
            r#"INSERT INTO workflow_checkpoints
               (checkpoint_id, task_id, run_id, workflow_id, workflow_version, plan_hash, event_sequence, created_at, workflow_json, checkpoint_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            [
                "ckpt-2",
                "task-1",
                "run-1",
                "workflow-1",
                "1",
                "plan-1",
                "3",
                "2026-06-16T00:00:04.000Z",
                "{}",
                "{}",
            ],
        );

        assert!(duplicate.is_err());
    }

    #[test]
    fn approval_record_prune_keeps_active_execution_states() {
        let connection = in_memory_connection();
        create_approval_records_prune_table(&connection);
        insert_approval_prune_row(
            &connection,
            "terminal-old",
            "expired",
            "2026-06-16T00:00:00.000Z",
            None,
            None,
        );
        insert_approval_prune_row(
            &connection,
            "terminal-new",
            "denied",
            "2026-06-16T00:01:00.000Z",
            Some(false),
            None,
        );
        for (id, status, minute) in [
            ("active-pending", "pending", "02"),
            ("active-started", "approved", "03"),
            ("active-succeeded", "approved", "04"),
            ("active-continuation", "approved", "05"),
        ] {
            insert_approval_prune_row(
                &connection,
                id,
                status,
                &format!("2026-06-16T00:{minute}:00.000Z"),
                Some(false),
                match id {
                    "active-started" => Some("started"),
                    "active-succeeded" => Some("succeeded"),
                    "active-continuation" => Some("continuation_pending"),
                    _ => None,
                },
            );
        }

        prune_approval_records(&connection, 1).expect("prune approval records");

        let ids = connection
            .prepare("SELECT approval_id FROM approval_records ORDER BY approval_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(ids.contains(&"terminal-new".to_string()));
        assert!(!ids.contains(&"terminal-old".to_string()));
        for id in [
            "active-pending",
            "active-started",
            "active-succeeded",
            "active-continuation",
        ] {
            assert!(
                ids.contains(&id.to_string()),
                "missing active approval {id}"
            );
        }
    }

    #[test]
    fn task_checkpoint_queries_use_global_creation_order() {
        let connection = in_memory_connection();
        create_workflow_checkpoints_table(&connection);
        for (id, run_id, sequence, created_at) in [
            (
                "checkpoint-old",
                "run-old",
                99_i64,
                "2026-06-16T00:00:00.000Z",
            ),
            (
                "checkpoint-new",
                "run-new",
                1_i64,
                "2026-06-16T00:01:00.000Z",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO workflow_checkpoints (checkpoint_id, task_id, run_id, workflow_id, workflow_version, plan_hash, event_sequence, created_at, workflow_json, checkpoint_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![id, "task-1", run_id, "workflow-1", 1_i64, "plan-1", sequence, created_at, "{}", id],
                )
                .unwrap();
        }

        let latest: String = connection
            .query_row(
                "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                ["task-1"],
                |row| row.get(0),
            )
            .unwrap();
        let listed = connection
            .prepare("SELECT checkpoint_id FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
            .unwrap()
            .query_map(rusqlite::params!["task-1", 2_i64], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(latest, "checkpoint-new");
        assert_eq!(listed, vec!["checkpoint-new", "checkpoint-old"]);
    }

    #[test]
    fn allows_known_app_execute_statements() {
        let statements = [
            "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
            "ALTER TABLE approval_records ADD COLUMN run_id TEXT",
            "CREATE TABLE IF NOT EXISTS task_history (id TEXT PRIMARY KEY, title TEXT NOT NULL, user_goal TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL)",
            "CREATE INDEX IF NOT EXISTS idx_resource_cache_kind_root ON resource_file_cache (kind, source_root_id)",
            "CREATE INDEX IF NOT EXISTS idx_app_classifications_cat ON app_classifications (category)",
            "CREATE INDEX IF NOT EXISTS goal_events_goal_created_idx ON goal_events(goal_id, created_at, id)",
            "CREATE INDEX IF NOT EXISTS goal_evaluations_goal_created_idx ON goal_evaluations(goal_id, created_at, id)",
            "CREATE INDEX IF NOT EXISTS goal_evaluations_goal_task_idx ON goal_evaluations(goal_id, task_id, created_at)",
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
            "INSERT INTO runtime_events (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            "INSERT INTO runtime_events (event_id, task_id, run_id, sequence, event_version, event_kind, workflow_id, step_id, agent_id, occurred_at, recorded_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING",
            "DELETE FROM runtime_events WHERE task_id = ? AND event_id IN (?, ?)",
            r#"INSERT INTO workflow_checkpoints
               (checkpoint_id, task_id, run_id, workflow_id, workflow_version, plan_hash, event_sequence, created_at, workflow_json, checkpoint_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(checkpoint_id) DO UPDATE SET
                 task_id = excluded.task_id,
                 run_id = excluded.run_id,
                 workflow_id = excluded.workflow_id,
                 workflow_version = excluded.workflow_version,
                 plan_hash = excluded.plan_hash,
                 event_sequence = excluded.event_sequence,
                 created_at = excluded.created_at,
                 workflow_json = excluded.workflow_json,
                 checkpoint_json = excluded.checkpoint_json"#,
            "DELETE FROM workflow_checkpoints WHERE checkpoint_id = ?",
        ];

        for sql in statements {
            assert_allowed(sql, SqlOperation::Execute);
        }
    }

    #[test]
    fn allows_known_app_select_statements() {
        let statements = [
            "SELECT id FROM schema_migrations",
            "SELECT record_json FROM approval_records ORDER BY created_at DESC",
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
            "SELECT envelope_json FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC LIMIT ?",
            "SELECT envelope_json FROM runtime_events WHERE run_id = ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?",
            "SELECT envelope_json FROM runtime_events WHERE task_id = ? ORDER BY recorded_at ASC, sequence ASC LIMIT ?",
            "SELECT envelope_json FROM runtime_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
            "SELECT COUNT(*) as count FROM runtime_events WHERE run_id = ?",
            "SELECT checkpoint_json FROM workflow_checkpoints WHERE run_id = ? ORDER BY event_sequence DESC LIMIT 1",
            "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
            "SELECT checkpoint_id FROM workflow_checkpoints WHERE task_id = ? ORDER BY created_at DESC, rowid DESC",
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
            "BEGIN TRANSACTION",
            "COMMIT",
            "ROLLBACK",
            "DROP TABLE task_history",
            "ALTER TABLE task_history ADD COLUMN leaked TEXT",
            "ALTER TABLE approval_records ADD COLUMN leaked TEXT",
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
               WHERE approval_id IN (
                 SELECT approval_id
                 FROM approval_records
                 WHERE status = 'expired'
                   OR (status = 'denied' AND COALESCE(CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.workflowBound') END, 0) <> 1)
                   OR CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.execution.status') END IN ('completed', 'failed', 'blocked')
                 ORDER BY created_at DESC, approval_id DESC
                 LIMIT -1 OFFSET ?
               )"#,
            "DELETE FROM file_scan_cache WHERE scanned_at = ?",
            "DELETE FROM resource_file_cache WHERE kind <> ?",
            "DELETE FROM resource_file_cache WHERE kind = ? OR source_root_id = ?",
            "DELETE FROM task_history WHERE id IN (SELECT id FROM secrets)",
            "DELETE FROM workflow_checkpoints",
            "DELETE FROM workflow_checkpoints WHERE task_id = ?",
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
            "SELECT * FROM runtime_events",
            "SELECT * FROM workflow_checkpoints",
            "SELECT checkpoint_json FROM workflow_checkpoints WHERE task_id <> ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
            "SELECT checkpoint_json FROM workflow_checkpoints WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
            "SELECT checkpoint_id FROM workflow_checkpoints WHERE task_id <> ? ORDER BY created_at DESC, rowid DESC",
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
