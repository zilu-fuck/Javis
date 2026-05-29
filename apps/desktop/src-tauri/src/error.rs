use serde::Serialize;
use std::fmt;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum JavisError {
    #[serde(rename = "io")]
    Io(String),
    #[serde(rename = "serde")]
    Serde(String),
    #[serde(rename = "validation")]
    Validation(String),
    #[serde(rename = "not_found")]
    NotFound(String),
    #[serde(rename = "permission")]
    Permission(String),
    #[serde(rename = "internal")]
    Internal(String),
}

impl fmt::Display for JavisError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JavisError::Io(msg) => write!(f, "IO error: {msg}"),
            JavisError::Serde(msg) => write!(f, "Serialization error: {msg}"),
            JavisError::Validation(msg) => write!(f, "Validation error: {msg}"),
            JavisError::NotFound(msg) => write!(f, "Not found: {msg}"),
            JavisError::Permission(msg) => write!(f, "Permission denied: {msg}"),
            JavisError::Internal(msg) => write!(f, "Internal error: {msg}"),
        }
    }
}

impl std::error::Error for JavisError {}

impl From<std::io::Error> for JavisError {
    fn from(e: std::io::Error) -> Self {
        JavisError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for JavisError {
    fn from(e: serde_json::Error) -> Self {
        JavisError::Serde(e.to_string())
    }
}

impl From<String> for JavisError {
    fn from(s: String) -> Self {
        JavisError::Internal(s)
    }
}

impl From<&str> for JavisError {
    fn from(s: &str) -> Self {
        JavisError::Internal(s.to_string())
    }
}

impl From<JavisError> for String {
    fn from(e: JavisError) -> Self {
        e.to_string()
    }
}
