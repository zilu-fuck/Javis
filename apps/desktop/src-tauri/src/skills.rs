use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

const EXTRA_SKILL_ROOTS_ENV: &str = "JAVIS_SKILL_ROOTS";
const MAX_SKILL_SEARCH_DEPTH: usize = 5;
const MAX_SKILL_RESOURCE_DEPTH: usize = 3;
const MAX_SKILL_RESOURCE_PATHS: usize = 40;
const MAX_SKILL_INSTALL_FILES: usize = 500;
const MAX_SKILL_INSTALL_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SKILL_INSTALL_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
static DISABLED_SKILL_IDS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Serialize)]
pub(crate) struct UserSkillSummary {
    id: String,
    name: String,
    description: String,
    path: String,
    source: String,
    enabled: bool,
    removable: bool,
    toggleable: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct EnabledUserSkillContext {
    id: String,
    name: String,
    description: String,
    path: String,
    source: String,
    content: String,
    resources: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallUserSkillRequest {
    url: String,
    title: Option<String>,
    description: Option<String>,
}

#[tauri::command]
pub(crate) fn scan_user_skills() -> Result<Vec<UserSkillSummary>, String> {
    scan_user_skills_impl().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn read_enabled_user_skill_contexts() -> Result<Vec<EnabledUserSkillContext>, String> {
    read_enabled_user_skill_contexts_impl().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn install_user_skill_from_github(
    request: InstallUserSkillRequest,
) -> Result<UserSkillSummary, String> {
    install_user_skill_from_github_impl(&request).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_user_skill(id: String) -> Result<(), String> {
    delete_user_skill_impl(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_user_skill_enabled(
    id: String,
    enabled: bool,
) -> Result<UserSkillSummary, String> {
    set_user_skill_enabled_impl(&id, enabled).map_err(|e| e.to_string())
}

fn scan_user_skills_impl() -> Result<Vec<UserSkillSummary>, std::io::Error> {
    let mut skills = Vec::new();
    let disabled_skill_ids = read_disabled_skill_ids()?;
    for (source, root) in user_skill_roots() {
        collect_skills_from_root(&mut skills, &source, &root, &disabled_skill_ids)?;
    }
    skills.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
    Ok(skills)
}

fn read_enabled_user_skill_contexts_impl() -> Result<Vec<EnabledUserSkillContext>, std::io::Error> {
    let mut contexts = Vec::new();
    let disabled_skill_ids = read_disabled_skill_ids()?;
    for (source, root) in user_skill_roots() {
        collect_enabled_skill_contexts_from_root(
            &mut contexts,
            &source,
            &root,
            &disabled_skill_ids,
        )?;
    }
    contexts.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.cmp(&b.name)));
    Ok(contexts)
}

fn user_skill_roots() -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    let mut seen = BTreeSet::new();
    if let Ok(root) = javis_skill_root() {
        push_user_skill_root(&mut roots, &mut seen, "javis".to_string(), root);
    }
    if let Some(home_dir) = dirs::home_dir() {
        let codex_skills_root = home_dir.join(".codex").join("skills");
        push_user_skill_root(
            &mut roots,
            &mut seen,
            "codex".to_string(),
            codex_skills_root.clone(),
        );
        push_user_skill_root(
            &mut roots,
            &mut seen,
            "codex-system".to_string(),
            codex_skills_root.join(".system"),
        );
        push_user_skill_root(
            &mut roots,
            &mut seen,
            "agents".to_string(),
            home_dir.join(".agents").join("skills"),
        );
    }
    for (source, root) in extra_skill_roots() {
        push_user_skill_root(&mut roots, &mut seen, source, root);
    }
    roots
}

fn push_user_skill_root(
    roots: &mut Vec<(String, PathBuf)>,
    seen: &mut BTreeSet<String>,
    source: String,
    root: PathBuf,
) {
    let key = skill_root_dedupe_key(&root);
    if seen.insert(key) {
        roots.push((source, root));
    }
}

fn skill_root_dedupe_key(root: &Path) -> String {
    let absolute = root.canonicalize().unwrap_or_else(|_| {
        if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(root))
                .unwrap_or_else(|_| root.to_path_buf())
        }
    });
    let text = absolute.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

fn extra_skill_roots() -> Vec<(String, PathBuf)> {
    let Some(raw_roots) = std::env::var_os(EXTRA_SKILL_ROOTS_ENV) else {
        return Vec::new();
    };
    extra_skill_roots_from_value(raw_roots)
}

fn extra_skill_roots_from_value(raw_roots: std::ffi::OsString) -> Vec<(String, PathBuf)> {
    std::env::split_paths(&raw_roots)
        .filter(|root| !root.as_os_str().is_empty())
        .enumerate()
        .map(|(index, root)| {
            let source = if index == 0 {
                "external".to_string()
            } else {
                format!("external{}", index + 1)
            };
            (source, root)
        })
        .collect()
}

fn javis_skill_root() -> Result<PathBuf, std::io::Error> {
    Ok(javis_config_dir()?.join("skills"))
}

fn javis_config_dir() -> Result<PathBuf, std::io::Error> {
    dirs::config_dir()
        .map(|config_dir| config_dir.join("javis"))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Cannot determine Javis config directory",
            )
        })
}

fn disabled_skill_ids_path() -> Result<PathBuf, std::io::Error> {
    Ok(javis_config_dir()?.join("disabled-skills.json"))
}

fn disabled_skill_root(root: &Path) -> PathBuf {
    root.join(".disabled")
}

fn install_user_skill_from_github_impl(
    request: &InstallUserSkillRequest,
) -> Result<UserSkillSummary, std::io::Error> {
    let github = parse_github_repo_url(&request.url).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Skill install only supports https://github.com/owner/repo URLs.",
        )
    })?;
    let skill_dir_name = github_skill_dir_name(&github);
    if skill_dir_name.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "GitHub repository name cannot be used as a skill directory.",
        ));
    }

    let root = javis_skill_root()?;
    let disabled_root = disabled_skill_root(&root);
    fs::create_dir_all(&root)?;
    let target_dir = root.join(&skill_dir_name);
    let disabled_target_dir = disabled_root.join(&skill_dir_name);
    if target_dir.exists() {
        let skill_path = target_dir.join("SKILL.md");
        if skill_path.is_file() {
            return read_skill_summary("javis", &target_dir, &skill_path, true, true, true)
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Installed skill metadata is unreadable.",
                    )
                });
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!(
                "Target skill directory already exists: {}",
                target_dir.display()
            ),
        ));
    }
    if disabled_target_dir.exists() {
        let skill_path = disabled_target_dir.join("SKILL.md");
        if skill_path.is_file() {
            fs::rename(&disabled_target_dir, &target_dir)?;
            return read_skill_summary(
                "javis",
                &target_dir,
                &target_dir.join("SKILL.md"),
                true,
                true,
                true,
            )
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Installed skill metadata is unreadable.",
                )
            });
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!(
                "Disabled target skill directory already exists: {}",
                disabled_target_dir.display()
            ),
        ));
    }

    let temp_dir = std::env::temp_dir().join(format!(
        "javis-skill-install-{}-{}",
        std::process::id(),
        skill_dir_name,
    ));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir)?;
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
        .status();
    let clone_status = match clone_status {
        Ok(status) => status,
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Cannot start git clone for skill install: {error}"),
            ));
        }
    };
    if !clone_status.success() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "Git clone failed while installing the skill.",
        ));
    }

    let inspect_dir = github
        .subdir
        .as_ref()
        .map(|subdir| temp_dir.join(subdir))
        .unwrap_or_else(|| temp_dir.clone());
    if !inspect_dir.is_dir() {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "GitHub repository subdirectory does not exist.",
        ));
    }
    let source_dir = find_installable_skill_dir(&inspect_dir)?;
    if let Err(error) = copy_dir_all(&source_dir, &target_dir) {
        let _ = fs::remove_dir_all(&target_dir);
        return Err(error);
    }
    let _ = fs::remove_dir_all(&temp_dir);

    let skill_path = target_dir.join("SKILL.md");
    if !skill_path.is_file() {
        let _ = fs::remove_dir_all(&target_dir);
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Installed repository did not contain a usable SKILL.md.",
        ));
    }

    let mut summary = read_skill_summary("javis", &target_dir, &skill_path, true, true, true)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Installed skill metadata is unreadable.",
            )
        })?;
    if summary.description == "User installed Javis skill." {
        summary.description = request
            .description
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or(summary.description);
    }
    if summary.name == skill_dir_name {
        summary.name = request
            .title
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or(summary.name);
    }
    Ok(summary)
}

fn delete_user_skill_impl(id: &str) -> Result<(), std::io::Error> {
    let Some((source, dir_name)) = id.split_once(':') else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid skill id.",
        ));
    };
    if source != "javis" {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Only Javis-managed user skills can be deleted.",
        ));
    }
    validate_skill_dir_name(dir_name)?;
    let root = javis_skill_root()?;
    let enabled_target = skill_child_path(&root, dir_name)?;
    let disabled_root = disabled_skill_root(&root);
    let disabled_target = skill_child_path(&disabled_root, dir_name)?;
    let target = if enabled_target.join("SKILL.md").is_file() {
        enabled_target
    } else if disabled_target.join("SKILL.md").is_file() {
        disabled_target
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Skill does not exist or is not managed by Javis.",
        ));
    };
    fs::remove_dir_all(target)
}

fn set_user_skill_enabled_impl(
    id: &str,
    enabled: bool,
) -> Result<UserSkillSummary, std::io::Error> {
    let Some((source, skill_key)) = id.split_once(':') else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid skill id.",
        ));
    };
    let root = user_skill_roots()
        .into_iter()
        .find_map(|(root_source, root)| (root_source == source).then_some(root))
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "Unknown skill source.")
        })?;
    if source != "javis" {
        return set_external_skill_enabled(source, skill_key, enabled, &root);
    }
    validate_skill_dir_name(skill_key)?;
    let disabled_root = disabled_skill_root(&root);
    let enabled_target = skill_child_path(&root, skill_key)?;
    let disabled_target = skill_child_path(&disabled_root, skill_key)?;
    if enabled {
        if enabled_target.join("SKILL.md").is_file() {
            return read_skill_summary(
                source,
                &enabled_target,
                &enabled_target.join("SKILL.md"),
                true,
                source == "javis",
                true,
            )
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Enabled skill metadata is unreadable.",
                )
            });
        }
        if !disabled_target.join("SKILL.md").is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Disabled skill does not exist.",
            ));
        }
        if enabled_target.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "Enabled skill directory already exists.",
            ));
        }
        fs::rename(&disabled_target, &enabled_target)?;
        return read_skill_summary(
            source,
            &enabled_target,
            &enabled_target.join("SKILL.md"),
            true,
            source == "javis",
            true,
        )
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Enabled skill metadata is unreadable.",
            )
        });
    }

    if disabled_target.join("SKILL.md").is_file() {
        return read_skill_summary(
            source,
            &disabled_target,
            &disabled_target.join("SKILL.md"),
            false,
            source == "javis",
            true,
        )
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Disabled skill metadata is unreadable.",
            )
        });
    }
    if !enabled_target.join("SKILL.md").is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Enabled skill does not exist.",
        ));
    }
    fs::create_dir_all(&disabled_root)?;
    if disabled_target.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "Disabled skill directory already exists.",
        ));
    }
    fs::rename(&enabled_target, &disabled_target)?;
    read_skill_summary(
        source,
        &disabled_target,
        &disabled_target.join("SKILL.md"),
        false,
        source == "javis",
        true,
    )
    .ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Disabled skill metadata is unreadable.",
        )
    })
}

fn set_external_skill_enabled(
    source: &str,
    skill_key: &str,
    enabled: bool,
    root: &Path,
) -> Result<UserSkillSummary, std::io::Error> {
    let id = skill_id(source, skill_key);
    let enabled_target = skill_path_from_key(root, skill_key)?;
    let disabled_root = disabled_skill_root(root);
    let disabled_target = skill_path_from_key(&disabled_root, skill_key)?;
    if enabled {
        if !enabled_target.join("SKILL.md").is_file() && disabled_target.join("SKILL.md").is_file()
        {
            if enabled_target.exists() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "Enabled skill directory already exists.",
                ));
            }
            fs::rename(&disabled_target, &enabled_target)?;
        }
        if !enabled_target.join("SKILL.md").is_file() {
            return if enabled_target.exists() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Skill metadata is unreadable.",
                ))
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Skill does not exist.",
                ))
            };
        }
    } else if !enabled_target.join("SKILL.md").is_file()
        && !disabled_target.join("SKILL.md").is_file()
    {
        return if enabled_target.exists() || disabled_target.exists() {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Skill metadata is unreadable.",
            ))
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Skill does not exist.",
            ))
        };
    }

    update_disabled_skill_ids(|disabled_ids| {
        if enabled {
            disabled_ids.remove(&id);
        } else {
            disabled_ids.insert(id.clone());
        }
    })?;

    if let Some(summary) = read_external_skill_summary(source, skill_key, enabled) {
        return Ok(summary);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "Skill does not exist.",
    ))
}

fn read_external_skill_summary(
    source: &str,
    skill_key: &str,
    enabled: bool,
) -> Option<UserSkillSummary> {
    let root = user_skill_roots()
        .into_iter()
        .find_map(|(root_source, root)| (root_source == source).then_some(root))?;
    let enabled_target = skill_path_from_key(&root, skill_key).ok()?;
    let disabled_target = skill_path_from_key(&disabled_skill_root(&root), skill_key).ok()?;
    let target = if enabled_target.join("SKILL.md").is_file() {
        enabled_target
    } else if disabled_target.join("SKILL.md").is_file() {
        disabled_target
    } else {
        return None;
    };
    read_skill_summary_with_id(
        source,
        &target,
        &target.join("SKILL.md"),
        enabled,
        false,
        true,
        skill_id(source, skill_key),
    )
}

fn collect_skills_from_root(
    skills: &mut Vec<UserSkillSummary>,
    source: &str,
    root: &Path,
    disabled_skill_ids: &BTreeSet<String>,
) -> Result<(), std::io::Error> {
    if !root.exists() {
        return Ok(());
    }
    collect_skill_entries(
        skills,
        source,
        root,
        true,
        source == "javis",
        disabled_skill_ids,
    )?;
    collect_skill_entries(
        skills,
        source,
        &disabled_skill_root(root),
        false,
        source == "javis",
        disabled_skill_ids,
    )?;
    Ok(())
}

fn collect_enabled_skill_contexts_from_root(
    contexts: &mut Vec<EnabledUserSkillContext>,
    source: &str,
    root: &Path,
    disabled_skill_ids: &BTreeSet<String>,
) -> Result<(), std::io::Error> {
    if !root.exists() {
        return Ok(());
    }
    collect_enabled_skill_contexts_recursive(contexts, source, root, root, 0, disabled_skill_ids)?;
    Ok(())
}

fn collect_skill_entries(
    skills: &mut Vec<UserSkillSummary>,
    source: &str,
    root: &Path,
    enabled: bool,
    removable: bool,
    disabled_skill_ids: &BTreeSet<String>,
) -> Result<(), std::io::Error> {
    if !root.exists() {
        return Ok(());
    }
    collect_skill_entries_recursive(
        skills,
        source,
        root,
        root,
        0,
        enabled,
        removable,
        disabled_skill_ids,
    )?;
    Ok(())
}

fn collect_enabled_skill_contexts_recursive(
    contexts: &mut Vec<EnabledUserSkillContext>,
    source: &str,
    root: &Path,
    current: &Path,
    depth: usize,
    disabled_skill_ids: &BTreeSet<String>,
) -> Result<(), std::io::Error> {
    if should_skip_skill_search_dir(current, root, depth) {
        return Ok(());
    }
    let skill_path = current.join("SKILL.md");
    if skill_path.is_file() {
        let id = skill_id_for_path(source, root, current);
        if !disabled_skill_ids.contains(&id) {
            if let Some(context) = read_enabled_skill_context(source, current, &skill_path, id) {
                contexts.push(context);
            }
        }
        return Ok(());
    }
    if depth >= MAX_SKILL_SEARCH_DEPTH {
        return Ok(());
    }
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        collect_enabled_skill_contexts_recursive(
            contexts,
            source,
            root,
            &path,
            depth + 1,
            disabled_skill_ids,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn collect_skill_entries_recursive(
    skills: &mut Vec<UserSkillSummary>,
    source: &str,
    root: &Path,
    current: &Path,
    depth: usize,
    enabled: bool,
    removable: bool,
    disabled_skill_ids: &BTreeSet<String>,
) -> Result<(), std::io::Error> {
    if should_skip_skill_search_dir(current, root, depth) {
        return Ok(());
    }
    let skill_path = current.join("SKILL.md");
    if skill_path.is_file() {
        let id = skill_id_for_path(source, root, current);
        let entry_enabled = enabled && !disabled_skill_ids.contains(&id);
        if let Some(skill) = read_skill_summary_with_id(
            source,
            current,
            &skill_path,
            entry_enabled,
            removable,
            true,
            id,
        ) {
            skills.push(skill);
        }
        return Ok(());
    }
    if depth >= MAX_SKILL_SEARCH_DEPTH {
        return Ok(());
    }
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        collect_skill_entries_recursive(
            skills,
            source,
            root,
            &path,
            depth + 1,
            enabled,
            removable,
            disabled_skill_ids,
        )?;
    }
    Ok(())
}

fn should_skip_skill_search_dir(path: &Path, root: &Path, depth: usize) -> bool {
    if depth == 0 || path == root {
        return false;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    matches!(
        name,
        ".git" | ".hg" | ".svn" | ".system" | ".disabled" | "node_modules" | "target"
    )
}

fn read_enabled_skill_context(
    source: &str,
    skill_dir: &Path,
    skill_path: &Path,
    id: String,
) -> Option<EnabledUserSkillContext> {
    let content = std::fs::read_to_string(skill_path).ok()?;
    let summary = read_skill_summary_with_id(
        source,
        skill_dir,
        skill_path,
        true,
        source == "javis",
        true,
        id,
    )?;
    let instruction_content = skill_instruction_content(&content);
    Some(EnabledUserSkillContext {
        id: summary.id,
        name: summary.name,
        description: summary.description,
        path: summary.path,
        source: summary.source,
        content: clip_skill_context_content(&instruction_content),
        resources: list_skill_resource_paths(skill_dir),
    })
}

fn read_skill_summary(
    source: &str,
    skill_dir: &Path,
    skill_path: &Path,
    enabled: bool,
    removable: bool,
    toggleable: bool,
) -> Option<UserSkillSummary> {
    let id = skill_id(source, &skill_dir.file_name()?.to_string_lossy());
    read_skill_summary_with_id(
        source, skill_dir, skill_path, enabled, removable, toggleable, id,
    )
}

fn read_skill_summary_with_id(
    source: &str,
    skill_dir: &Path,
    skill_path: &Path,
    enabled: bool,
    removable: bool,
    toggleable: bool,
    id: String,
) -> Option<UserSkillSummary> {
    let content = std::fs::read_to_string(skill_path).ok()?;
    let frontmatter = extract_frontmatter(&content);
    let dir_name = skill_dir.file_name()?.to_string_lossy().to_string();
    let name = frontmatter
        .as_ref()
        .and_then(|meta| frontmatter_value(meta, "name"))
        .unwrap_or_else(|| dir_name.clone());
    let description = frontmatter
        .as_ref()
        .and_then(|meta| frontmatter_value(meta, "description"))
        .unwrap_or_else(|| first_markdown_paragraph(&content));
    Some(UserSkillSummary {
        id,
        name,
        description,
        path: skill_dir.to_string_lossy().to_string(),
        source: source.to_string(),
        enabled,
        removable,
        toggleable,
    })
}

fn skill_id(source: &str, dir_name: &str) -> String {
    format!("{source}:{dir_name}")
}

fn skill_id_for_path(source: &str, root: &Path, skill_dir: &Path) -> String {
    skill_id(source, &skill_key_for_path(root, skill_dir))
}

fn skill_key_for_path(root: &Path, skill_dir: &Path) -> String {
    let relative = skill_dir.strip_prefix(root).unwrap_or(skill_dir);
    if relative.as_os_str().is_empty() {
        return format!("path_{}", hex_encode(b"."));
    }
    let components = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if components.len() == 1 && validate_skill_dir_name(&components[0]).is_ok() {
        return components[0].clone();
    }
    format!("path_{}", hex_encode(components.join("/").as_bytes()))
}

fn skill_path_from_key(root: &Path, key: &str) -> Result<PathBuf, std::io::Error> {
    if let Some(relative) = decode_skill_path_key(key) {
        let path = root.join(relative);
        if !path.starts_with(root) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Skill path is outside its configured root.",
            ));
        }
        return Ok(path);
    }
    skill_child_path(root, key)
}

fn decode_skill_path_key(key: &str) -> Option<PathBuf> {
    let hex = key.strip_prefix("path_")?;
    let bytes = hex_decode(hex)?;
    let text = String::from_utf8(bytes).ok()?;
    if text == "." {
        return Some(PathBuf::new());
    }
    if text.is_empty() || text.contains('\\') {
        return None;
    }
    let mut path = PathBuf::new();
    for segment in text.split('/') {
        if segment.is_empty() || matches!(segment, "." | "..") {
            return None;
        }
        path.push(segment);
    }
    Some(path)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn hex_decode(value: &str) -> Option<Vec<u8>> {
    if value.is_empty() || value.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    let raw = value.as_bytes();
    for pair in raw.chunks_exact(2) {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        bytes.push((high << 4) | low);
    }
    Some(bytes)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn read_disabled_skill_ids() -> Result<BTreeSet<String>, std::io::Error> {
    let _guard = DISABLED_SKILL_IDS_LOCK.lock().map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::Other,
            "Disabled skill config lock is poisoned.",
        )
    })?;
    read_disabled_skill_ids_unlocked()
}

fn update_disabled_skill_ids(
    update: impl FnOnce(&mut BTreeSet<String>),
) -> Result<BTreeSet<String>, std::io::Error> {
    let _guard = DISABLED_SKILL_IDS_LOCK.lock().map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::Other,
            "Disabled skill config lock is poisoned.",
        )
    })?;
    let mut ids = read_disabled_skill_ids_unlocked()?;
    update(&mut ids);
    write_disabled_skill_ids_unlocked(&ids)?;
    Ok(ids)
}

fn read_disabled_skill_ids_unlocked() -> Result<BTreeSet<String>, std::io::Error> {
    let path = disabled_skill_ids_path()?;
    match fs::read_to_string(&path) {
        Ok(content) => {
            let ids = serde_json::from_str::<Vec<String>>(&content).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Disabled skill config is invalid: {error}"),
                )
            })?;
            Ok(ids.into_iter().filter(|id| is_valid_skill_id(id)).collect())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(error),
    }
}

fn write_disabled_skill_ids_unlocked(ids: &BTreeSet<String>) -> Result<(), std::io::Error> {
    let path = disabled_skill_ids_path()?;
    let Some(parent) = path.parent() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Disabled skill config path has no parent directory.",
        ));
    };
    fs::create_dir_all(parent)?;
    if ids.is_empty() {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        return Ok(());
    }
    let content =
        serde_json::to_string_pretty(&ids.iter().collect::<Vec<_>>()).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Cannot serialize disabled skill config: {error}"),
            )
        })?;
    fs::write(path, format!("{content}\n"))
}

fn is_valid_skill_id(id: &str) -> bool {
    let Some((source, skill_key)) = id.split_once(':') else {
        return false;
    };
    if source.trim().is_empty() {
        return false;
    }
    if skill_key.starts_with("path_") {
        return decode_skill_path_key(skill_key).is_some();
    }
    validate_skill_dir_name(skill_key).is_ok()
}

fn clip_skill_context_content(content: &str) -> String {
    const MAX_CHARS: usize = 12_000;
    if content.len() <= MAX_CHARS {
        return content.to_string();
    }
    let mut clipped = String::new();
    for ch in content.chars() {
        if clipped.len() + ch.len_utf8() > MAX_CHARS {
            break;
        }
        clipped.push(ch);
    }
    clipped.push_str("\n\n[Skill content truncated by Javis.]");
    clipped
}

fn list_skill_resource_paths(skill_dir: &Path) -> Vec<String> {
    let mut resources = Vec::new();
    let _ = collect_skill_resource_paths(skill_dir, skill_dir, 0, &mut resources);
    resources.sort();
    resources.truncate(MAX_SKILL_RESOURCE_PATHS);
    resources
}

fn collect_skill_resource_paths(
    root: &Path,
    current: &Path,
    depth: usize,
    resources: &mut Vec<String>,
) -> Result<(), std::io::Error> {
    if resources.len() >= MAX_SKILL_RESOURCE_PATHS || depth > MAX_SKILL_RESOURCE_DEPTH {
        return Ok(());
    }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if should_skip_skill_search_dir(&path, root, depth + 1) {
                continue;
            }
            collect_skill_resource_paths(root, &path, depth + 1, resources)?;
            continue;
        }
        if !file_type.is_file()
            || path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md")
        {
            continue;
        }
        if let Some(relative) = relative_resource_path(root, &path) {
            resources.push(relative);
            if resources.len() >= MAX_SKILL_RESOURCE_PATHS {
                break;
            }
        }
    }
    Ok(())
}

fn relative_resource_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let parts = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return None;
    }
    let text = parts.join("/");
    (text.len() <= 240).then_some(text)
}

fn skill_instruction_content(content: &str) -> String {
    let mut lines = content.lines();
    if lines.next().is_some_and(|line| line.trim() == "---") {
        for line in lines.by_ref() {
            if line.trim() == "---" {
                return lines.collect::<Vec<_>>().join("\n").trim().to_string();
            }
        }
    }
    content.trim().to_string()
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
        if parts.last().copied() != Some("SKILL.md") {
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

fn github_skill_dir_name(github: &GithubRepo) -> String {
    let mut raw = format!("{}-{}", github.owner, github.repo);
    if let Some(subdir) = &github.subdir {
        for component in subdir.components() {
            raw.push('-');
            raw.push_str(&component.as_os_str().to_string_lossy());
        }
    }
    sanitize_skill_dir_name(&raw)
}

fn sanitize_skill_dir_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_' || *ch == '.')
        .take(96)
        .collect()
}

fn validate_skill_dir_name(value: &str) -> Result<(), std::io::Error> {
    let invalid = value.is_empty()
        || matches!(value, "." | ".." | ".system" | ".disabled")
        || value.contains('/')
        || value.contains('\\')
        || sanitize_skill_dir_name(value) != value;
    if invalid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid skill directory name.",
        ));
    }
    Ok(())
}

fn skill_child_path(root: &Path, dir_name: &str) -> Result<PathBuf, std::io::Error> {
    validate_skill_dir_name(dir_name)?;
    let child = root.join(dir_name);
    if !child.starts_with(root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Skill directory is outside its configured root.",
        ));
    }
    Ok(child)
}

fn find_installable_skill_dir(repo_dir: &Path) -> Result<PathBuf, std::io::Error> {
    if repo_dir.join("SKILL.md").is_file() {
        return Ok(repo_dir.to_path_buf());
    }
    let mut matches = Vec::new();
    collect_skill_dirs(repo_dir, 0, &mut matches)?;
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "GitHub repository does not contain SKILL.md.",
        )),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "GitHub repository contains multiple skills; install a single-skill repository.",
        )),
    }
}

fn collect_skill_dirs(
    dir: &Path,
    depth: usize,
    matches: &mut Vec<PathBuf>,
) -> Result<(), std::io::Error> {
    if depth > 3 {
        return Ok(());
    }
    if dir.file_name().and_then(|name| name.to_str()) == Some(".git") {
        return Ok(());
    }
    if dir.join("SKILL.md").is_file() {
        matches.push(dir.to_path_buf());
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_skill_dirs(&path, depth + 1, matches)?;
        }
    }
    Ok(())
}

#[derive(Default)]
struct SkillInstallCopyBudget {
    files: usize,
    total_bytes: u64,
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    let mut budget = SkillInstallCopyBudget::default();
    copy_dir_all_limited(source, target, &mut budget)
}

fn copy_dir_all_limited(
    source: &Path,
    target: &Path,
    budget: &mut SkillInstallCopyBudget,
) -> Result<(), std::io::Error> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let file_name = entry.file_name();
        if should_skip_install_copy_entry(&file_name.to_string_lossy()) {
            continue;
        }
        if entry.file_type()?.is_symlink() {
            continue;
        }
        let target_path = target.join(file_name);
        if source_path.is_dir() {
            copy_dir_all_limited(&source_path, &target_path, budget)?;
        } else if source_path.is_file() {
            let bytes = entry.metadata()?.len();
            reserve_install_copy_file(&source_path, bytes, budget)?;
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn should_skip_install_copy_entry(name: &str) -> bool {
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

fn reserve_install_copy_file(
    path: &Path,
    bytes: u64,
    budget: &mut SkillInstallCopyBudget,
) -> Result<(), std::io::Error> {
    if bytes > MAX_SKILL_INSTALL_FILE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "Skill install file is too large: {} ({} bytes)",
                path.display(),
                bytes
            ),
        ));
    }
    if budget.files + 1 > MAX_SKILL_INSTALL_FILES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Skill install exceeds {MAX_SKILL_INSTALL_FILES} files."),
        ));
    }
    if budget.total_bytes.saturating_add(bytes) > MAX_SKILL_INSTALL_TOTAL_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Skill install exceeds {MAX_SKILL_INSTALL_TOTAL_BYTES} bytes."),
        ));
    }
    budget.files += 1;
    budget.total_bytes += bytes;
    Ok(())
}

fn extract_frontmatter(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut collected = Vec::new();
    for line in lines {
        if line.trim() == "---" {
            return Some(collected.join("\n"));
        }
        collected.push(line);
    }
    None
}

fn frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    let mut value_lines = Vec::new();
    let mut capture_folded = false;
    for line in frontmatter.lines() {
        if capture_folded {
            if line.starts_with(' ') || line.starts_with('\t') {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    value_lines.push(trimmed.to_string());
                }
                continue;
            }
            break;
        }
        let trimmed = line.trim_start();
        if !trimmed.starts_with(&prefix) {
            continue;
        }
        let raw = trimmed[prefix.len()..].trim();
        if raw == ">-" || raw == ">" || raw == "|" || raw == "|-" {
            capture_folded = true;
            continue;
        }
        return Some(unquote(raw).trim().to_string()).filter(|value| !value.is_empty());
    }
    if value_lines.is_empty() {
        None
    } else {
        Some(value_lines.join(" "))
    }
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|inner| inner.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn first_markdown_paragraph(content: &str) -> String {
    let mut in_frontmatter = content
        .lines()
        .next()
        .is_some_and(|line| line.trim() == "---");
    let mut passed_frontmatter = !in_frontmatter;
    for line in content.lines() {
        let trimmed = line.trim();
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
                passed_frontmatter = true;
            }
            continue;
        }
        if !passed_frontmatter || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        return trimmed.to_string();
    }
    "User installed Javis skill.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_frontmatter_values() {
        let frontmatter = "name: demo\ndescription: >-\n  One line\n  continued";

        assert_eq!(
            frontmatter_value(frontmatter, "name"),
            Some("demo".to_string())
        );
        assert_eq!(
            frontmatter_value(frontmatter, "description"),
            Some("One line continued".to_string()),
        );
    }

    #[test]
    fn extracts_frontmatter_block() {
        let content = "---\nname: demo\n---\n# Demo";

        assert_eq!(extract_frontmatter(content), Some("name: demo".to_string()));
    }

    #[test]
    fn skill_instruction_content_omits_frontmatter() {
        let content =
            "---\nname: demo\ndescription: metadata\n---\n# Demo\nUse the actual skill body.";

        assert_eq!(
            skill_instruction_content(content),
            "# Demo\nUse the actual skill body."
        );
    }

    #[test]
    fn parses_safe_github_repo_urls() {
        assert_eq!(
            parse_github_repo_url("https://github.com/openai/codex-skill.git"),
            Some(GithubRepo {
                owner: "openai".to_string(),
                repo: "codex-skill".to_string(),
                branch: None,
                subdir: None,
            }),
        );
        assert_eq!(
            parse_github_repo_url("https://github.com/openai/codex/tree/main/skills/demo"),
            Some(GithubRepo {
                owner: "openai".to_string(),
                repo: "codex".to_string(),
                branch: Some("main".to_string()),
                subdir: Some(PathBuf::from("skills").join("demo")),
            }),
        );
        assert!(parse_github_repo_url("http://github.com/openai/codex-skill").is_none());
        assert!(parse_github_repo_url("https://example.com/openai/codex-skill").is_none());
        assert!(parse_github_repo_url("https://github.com/openai/../bad").is_none());
        assert_eq!(
            parse_github_repo_url("https://github.com/openai/codex/blob/main/SKILL.md"),
            Some(GithubRepo {
                owner: "openai".to_string(),
                repo: "codex".to_string(),
                branch: Some("main".to_string()),
                subdir: None,
            }),
        );
        assert_eq!(
            parse_github_repo_url("https://github.com/openai/codex/blob/main/skills/demo/SKILL.md"),
            Some(GithubRepo {
                owner: "openai".to_string(),
                repo: "codex".to_string(),
                branch: Some("main".to_string()),
                subdir: Some(PathBuf::from("skills").join("demo")),
            }),
        );
        assert!(
            parse_github_repo_url("https://github.com/openai/codex/tree/main/../bad").is_none()
        );
    }

    #[test]
    fn finds_single_nested_skill_dir() {
        let temp_dir = tempfile::tempdir().unwrap();
        let skill_dir = temp_dir.path().join("skills").join("demo");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: demo\n---").unwrap();

        assert_eq!(
            find_installable_skill_dir(temp_dir.path()).unwrap(),
            skill_dir
        );
    }

    #[test]
    fn skill_install_copy_skips_dependency_and_build_dirs() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source = temp_dir.path().join("source");
        let target = temp_dir.path().join("target");
        fs::create_dir_all(source.join("node_modules").join("package")).unwrap();
        fs::create_dir_all(source.join("dist")).unwrap();
        fs::write(source.join("SKILL.md"), "---\nname: demo\n---").unwrap();
        fs::write(
            source.join("node_modules").join("package").join("index.js"),
            "ignored",
        )
        .unwrap();
        fs::write(source.join("dist").join("bundle.js"), "ignored").unwrap();

        copy_dir_all(&source, &target).unwrap();

        assert!(target.join("SKILL.md").is_file());
        assert!(!target.join("node_modules").exists());
        assert!(!target.join("dist").exists());
    }

    #[test]
    fn skill_install_copy_rejects_oversized_files() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source = temp_dir.path().join("source");
        let target = temp_dir.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "---\nname: demo\n---").unwrap();
        fs::File::create(source.join("large.bin"))
            .unwrap()
            .set_len(MAX_SKILL_INSTALL_FILE_BYTES + 1)
            .unwrap();

        let error = copy_dir_all(&source, &target).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("too large"));
    }

    #[test]
    fn builds_distinct_skill_dir_names_for_repo_subdirs() {
        let root_repo = parse_github_repo_url("https://github.com/openai/codex").unwrap();
        let nested_repo =
            parse_github_repo_url("https://github.com/openai/codex/tree/main/skills/demo").unwrap();

        assert_eq!(github_skill_dir_name(&root_repo), "openai-codex");
        assert_eq!(
            github_skill_dir_name(&nested_repo),
            "openai-codex-skills-demo"
        );
    }

    #[test]
    fn scans_disabled_javis_skills_without_exposing_disabled_dir() {
        let temp_dir = tempfile::tempdir().unwrap();
        let enabled_dir = temp_dir.path().join("enabled-skill");
        let disabled_dir = temp_dir.path().join(".disabled").join("disabled-skill");
        fs::create_dir_all(&enabled_dir).unwrap();
        fs::create_dir_all(&disabled_dir).unwrap();
        fs::write(enabled_dir.join("SKILL.md"), "---\nname: enabled\n---").unwrap();
        fs::write(disabled_dir.join("SKILL.md"), "---\nname: disabled\n---").unwrap();

        let mut skills = Vec::new();
        collect_skills_from_root(&mut skills, "javis", temp_dir.path(), &BTreeSet::new()).unwrap();
        skills.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "disabled");
        assert!(!skills[0].enabled);
        assert!(skills[0].removable);
        assert_eq!(skills[1].name, "enabled");
        assert!(skills[1].enabled);
        assert!(skills[1].removable);
    }

    #[test]
    fn enabled_skill_contexts_read_only_enabled_skill_markdown() {
        let temp_dir = tempfile::tempdir().unwrap();
        let enabled_dir = temp_dir.path().join("enabled-skill");
        let disabled_dir = temp_dir.path().join(".disabled").join("disabled-skill");
        fs::create_dir_all(&enabled_dir).unwrap();
        fs::create_dir_all(&disabled_dir).unwrap();
        fs::write(
            enabled_dir.join("SKILL.md"),
            "---\nname: enabled\n---\nUse this skill.",
        )
        .unwrap();
        fs::write(
            disabled_dir.join("SKILL.md"),
            "---\nname: disabled\n---\nDo not use this skill.",
        )
        .unwrap();

        let mut contexts = Vec::new();
        collect_enabled_skill_contexts_from_root(
            &mut contexts,
            "javis",
            temp_dir.path(),
            &BTreeSet::new(),
        )
        .unwrap();

        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].id, "javis:enabled-skill");
        assert!(contexts[0].content.contains("Use this skill."));
        assert!(!contexts[0].content.contains("Do not use this skill."));
    }

    #[test]
    fn agents_skills_are_toggleable_but_not_removable() {
        let temp_dir = tempfile::tempdir().unwrap();
        let skill_dir = temp_dir.path().join("external-skill");
        let disabled_dir = temp_dir.path().join(".disabled").join("external-disabled");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::create_dir_all(&disabled_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: external\n---").unwrap();
        fs::write(
            disabled_dir.join("SKILL.md"),
            "---\nname: external-disabled\n---",
        )
        .unwrap();

        let mut skills = Vec::new();
        collect_skills_from_root(&mut skills, "agents", temp_dir.path(), &BTreeSet::new()).unwrap();

        assert_eq!(skills.len(), 2);
        assert!(skills.iter().any(|skill| skill.enabled));
        assert!(skills.iter().any(|skill| !skill.enabled));
        assert!(skills.iter().all(|skill| !skill.removable));
    }

    #[test]
    fn codex_skills_are_toggleable_but_not_removable() {
        let temp_dir = tempfile::tempdir().unwrap();
        let skill_dir = temp_dir.path().join("external-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: external\n---").unwrap();

        let mut skills = Vec::new();
        collect_skills_from_root(&mut skills, "codex", temp_dir.path(), &BTreeSet::new()).unwrap();

        assert_eq!(skills.len(), 1);
        assert!(skills[0].enabled);
        assert!(!skills[0].removable);
    }

    #[test]
    fn codex_system_skills_are_toggleable_but_not_removable() {
        let temp_dir = tempfile::tempdir().unwrap();
        let skill_dir = temp_dir.path().join("system-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: system\n---").unwrap();

        let mut skills = Vec::new();
        let disabled_ids = BTreeSet::from([skill_id("codex-system", "system-skill")]);
        collect_skills_from_root(&mut skills, "codex-system", temp_dir.path(), &disabled_ids)
            .unwrap();

        assert_eq!(skills.len(), 1);
        assert!(!skills[0].enabled);
        assert!(!skills[0].removable);
    }

    #[test]
    fn configured_external_skills_are_toggleable_but_not_removable() {
        let temp_dir = tempfile::tempdir().unwrap();
        let skill_dir = temp_dir.path().join("external-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: external\n---").unwrap();

        let mut skills = Vec::new();
        collect_skills_from_root(&mut skills, "external", temp_dir.path(), &BTreeSet::new())
            .unwrap();

        assert_eq!(skills.len(), 1);
        assert!(skills[0].enabled);
        assert!(!skills[0].removable);
    }

    #[test]
    fn external_disabled_config_marks_skill_disabled_without_requiring_move() {
        let temp_dir = tempfile::tempdir().unwrap();
        let skill_dir = temp_dir.path().join("external-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: external\n---").unwrap();
        let disabled_ids = BTreeSet::from([skill_id("agents", "external-skill")]);

        let mut skills = Vec::new();
        collect_skills_from_root(&mut skills, "agents", temp_dir.path(), &disabled_ids).unwrap();
        let mut contexts = Vec::new();
        collect_enabled_skill_contexts_from_root(
            &mut contexts,
            "agents",
            temp_dir.path(),
            &disabled_ids,
        )
        .unwrap();

        assert_eq!(skills.len(), 1);
        assert!(!skills[0].enabled);
        assert!(contexts.is_empty());
        assert!(skill_dir.join("SKILL.md").is_file());
    }

    #[test]
    fn recursively_discovers_nested_external_skills() {
        let temp_dir = tempfile::tempdir().unwrap();
        let skill_dir = temp_dir
            .path()
            .join("repo")
            .join("skills")
            .join("demo skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: nested external\n---\nUse nested skill instructions.",
        )
        .unwrap();

        let mut skills = Vec::new();
        collect_skills_from_root(&mut skills, "external", temp_dir.path(), &BTreeSet::new())
            .unwrap();
        let mut contexts = Vec::new();
        collect_enabled_skill_contexts_from_root(
            &mut contexts,
            "external",
            temp_dir.path(),
            &BTreeSet::new(),
        )
        .unwrap();

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "nested external");
        assert!(skills[0].id.starts_with("external:path_"));
        assert!(skills[0].enabled);
        assert!(skills[0].toggleable);
        assert!(!skills[0].removable);
        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].id, skills[0].id);
        assert!(contexts[0]
            .content
            .contains("Use nested skill instructions."));

        let disabled_ids = BTreeSet::from([skills[0].id.clone()]);
        let mut disabled_contexts = Vec::new();
        collect_enabled_skill_contexts_from_root(
            &mut disabled_contexts,
            "external",
            temp_dir.path(),
            &disabled_ids,
        )
        .unwrap();

        assert!(disabled_contexts.is_empty());
    }

    #[test]
    fn external_disabled_dir_is_scanned_for_legacy_state_but_not_injected() {
        let temp_dir = tempfile::tempdir().unwrap();
        let disabled_dir = temp_dir.path().join(".disabled").join("external-skill");
        fs::create_dir_all(&disabled_dir).unwrap();
        fs::write(disabled_dir.join("SKILL.md"), "---\nname: external\n---").unwrap();

        let mut skills = Vec::new();
        collect_skills_from_root(&mut skills, "agents", temp_dir.path(), &BTreeSet::new()).unwrap();
        let mut contexts = Vec::new();
        collect_enabled_skill_contexts_from_root(
            &mut contexts,
            "agents",
            temp_dir.path(),
            &BTreeSet::new(),
        )
        .unwrap();

        assert_eq!(skills.len(), 1);
        assert!(!skills[0].enabled);
        assert!(!skills[0].removable);
        assert!(contexts.is_empty());
    }

    #[test]
    fn invalid_disabled_skill_ids_are_ignored() {
        assert!(is_valid_skill_id("agents:external-skill"));
        let path_key = format!("path_{}", hex_encode(b"repo/skills/demo"));
        assert!(is_valid_skill_id(&format!("agents:{path_key}")));
        let traversal_key = format!("path_{}", hex_encode(b"repo/../outside"));
        assert!(!is_valid_skill_id(&format!("agents:{traversal_key}")));
        assert!(!is_valid_skill_id("agents:../outside"));
        assert!(!is_valid_skill_id("missing-separator"));
    }

    #[test]
    fn parses_extra_skill_roots_from_environment_style_value() {
        let temp_dir = tempfile::tempdir().unwrap();
        let first = temp_dir.path().join("skills-one");
        let second = temp_dir.path().join("skills-two");
        let raw = std::env::join_paths([first.as_path(), second.as_path()]).unwrap();

        let roots = extra_skill_roots_from_value(raw);

        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].0, "external");
        assert_eq!(roots[0].1, first);
        assert_eq!(roots[1].0, "external2");
        assert_eq!(roots[1].1, second);
    }

    #[test]
    fn skill_root_dedupe_key_matches_existing_root_aliases() {
        let temp_dir = tempfile::tempdir().unwrap();
        let root = temp_dir.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        let alias = root.join("..").join("skills");

        assert_eq!(skill_root_dedupe_key(&root), skill_root_dedupe_key(&alias));
    }

    #[test]
    fn delete_rejects_agents_skill_ids() {
        let error = delete_user_skill_impl("agents:external-skill").unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn delete_rejects_codex_skill_ids() {
        let error = delete_user_skill_impl("codex:external-skill").unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn rejects_path_traversal_skill_dir_names() {
        for id in [
            "javis:.",
            "javis:..",
            "javis:..\\outside",
            "javis:../outside",
        ] {
            let delete_error = delete_user_skill_impl(id).unwrap_err();
            assert_eq!(delete_error.kind(), std::io::ErrorKind::InvalidInput);

            let toggle_error = set_user_skill_enabled_impl(id, false).unwrap_err();
            assert_eq!(toggle_error.kind(), std::io::ErrorKind::InvalidInput);
        }
    }
}
