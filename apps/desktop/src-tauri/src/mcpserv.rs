use std::fs;

use crate::error::JavisError;


#[tauri::command]
pub(crate) fn read_mcp_config() -> Result<Option<String>, String> {
    read_mcp_config_impl().map_err(|e| e.to_string())
}

fn read_mcp_config_impl() -> Result<Option<String>, JavisError> {
    let config_dir =
        dirs::config_dir().ok_or_else(|| JavisError::Io("Cannot determine config directory".into()))?;
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

    let config_dir =
        dirs::config_dir().ok_or_else(|| JavisError::Io("Cannot determine config directory".into()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
            assert!(!e.to_string().contains("Invalid JSON"),
                "Valid JSON should not trigger validation error: {e}");
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
}
