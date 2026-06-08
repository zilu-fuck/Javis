use serde::Serialize;
use std::{fs, path::Path};

use crate::error::JavisError;
use crate::{normalize_path, resolve_workspace_path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectInspection {
    workspace_path: String,
    package_manager: Option<String>,
    scripts: Vec<ProjectScript>,
    recommended_start_command: Option<String>,
    recommended_test_command: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectScript {
    name: String,
    command: String,
}

#[tauri::command]
pub(crate) fn inspect_project(workspace_path: Option<String>) -> Result<ProjectInspection, String> {
    inspect_project_impl(workspace_path).map_err(|e| e.to_string())
}

fn inspect_project_impl(workspace_path: Option<String>) -> Result<ProjectInspection, JavisError> {
    let workspace = resolve_workspace_path(workspace_path)?;
    let package_json_path = workspace.join("package.json");
    if !package_json_path.exists() {
        return Err(JavisError::NotFound(format!(
            "Selected workspace does not contain package.json: {}",
            workspace.to_string_lossy()
        )));
    }
    let package_json = fs::read_to_string(&package_json_path).map_err(|error| {
        JavisError::Io(format!(
            "Could not read package.json in selected workspace {}: {error}",
            workspace.to_string_lossy()
        ))
    })?;
    let value = serde_json::from_str::<serde_json::Value>(&package_json)?;
    let scripts = value
        .get("scripts")
        .and_then(|scripts| scripts.as_object())
        .map(|scripts| {
            scripts
                .iter()
                .filter_map(|(name, command)| {
                    command.as_str().map(|command| ProjectScript {
                        name: name.clone(),
                        command: command.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let package_manager = detect_package_manager(&workspace);
    let runner = package_manager.as_deref().unwrap_or("pnpm");

    Ok(ProjectInspection {
        workspace_path: normalize_path(&workspace),
        recommended_start_command: recommend_script(&scripts, runner, &["dev", "start"]),
        recommended_test_command: recommend_script(&scripts, runner, &["typecheck", "test"]),
        package_manager,
        scripts,
    })
}

pub(crate) fn detect_package_manager(workspace: &Path) -> Option<String> {
    if workspace.join("pnpm-lock.yaml").exists() {
        return Some("pnpm".to_string());
    }
    if workspace.join("yarn.lock").exists() {
        return Some("yarn".to_string());
    }
    if workspace.join("package-lock.json").exists() {
        return Some("npm".to_string());
    }
    None
}

pub(crate) fn recommend_script(
    scripts: &[ProjectScript],
    runner: &str,
    names: &[&str],
) -> Option<String> {
    names.iter().find_map(|name| {
        scripts
            .iter()
            .any(|script| script.name == *name)
            .then(|| format!("{} {}", runner, name))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_package_manager_pnpm() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(tmp.path().join("pnpm-lock.yaml"), b"").unwrap();
        assert_eq!(detect_package_manager(tmp.path()), Some("pnpm".into()));
    }

    #[test]
    fn detect_package_manager_yarn() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(tmp.path().join("yarn.lock"), b"").unwrap();
        assert_eq!(detect_package_manager(tmp.path()), Some("yarn".into()));
    }

    #[test]
    fn detect_package_manager_npm() {
        let tmp = tempfile::tempdir().expect("tempdir");
        std::fs::write(tmp.path().join("package-lock.json"), b"").unwrap();
        assert_eq!(detect_package_manager(tmp.path()), Some("npm".into()));
    }

    #[test]
    fn detect_package_manager_none() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert_eq!(detect_package_manager(tmp.path()), None);
    }

    #[test]
    fn recommend_script_finds_first_match() {
        let scripts = vec![
            ProjectScript {
                name: "dev".into(),
                command: "vite".into(),
            },
            ProjectScript {
                name: "start".into(),
                command: "node index.js".into(),
            },
        ];
        assert_eq!(
            recommend_script(&scripts, "pnpm", &["dev", "start"]),
            Some("pnpm dev".into())
        );
    }

    #[test]
    fn recommend_script_falls_back_to_second() {
        let scripts = vec![
            ProjectScript {
                name: "build".into(),
                command: "tsc".into(),
            },
            ProjectScript {
                name: "start".into(),
                command: "node index.js".into(),
            },
        ];
        assert_eq!(
            recommend_script(&scripts, "npm", &["dev", "start"]),
            Some("npm start".into())
        );
    }

    #[test]
    fn recommend_script_returns_none_when_no_match() {
        let scripts = vec![ProjectScript {
            name: "build".into(),
            command: "tsc".into(),
        }];
        assert_eq!(recommend_script(&scripts, "yarn", &["dev", "start"]), None);
    }
}
