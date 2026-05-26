use rusqlite::{Connection, OpenFlags};
use std::{
    path::PathBuf,
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

static DB: once_cell::sync::Lazy<Mutex<Option<Connection>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

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
    let mut guard = DB.lock().map_err(|error| format!("Database lock error: {error}"))?;
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
    let conn = guard.as_ref().ok_or_else(|| "Database not initialized".to_string())?;
    f(conn)
}

#[tauri::command]
pub fn db_execute(app: AppHandle, sql: String, bind_values: Vec<serde_json::Value>) -> Result<(), String> {
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
        let column_names: Vec<String> = stmt
            .column_names()
            .iter()
            .map(|n| n.to_string())
            .collect();
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
pub fn db_close() -> Result<(), String> {
    let mut guard = DB.lock().map_err(|error| format!("Database lock error: {error}"))?;
    *guard = None;
    Ok(())
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
        rusqlite::types::Value::Real(f) => {
            serde_json::Number::from_f64(f)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null)
        }
        rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
        rusqlite::types::Value::Blob(_) => serde_json::Value::Null,
    }
}
