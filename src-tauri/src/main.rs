#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{async_runtime::channel, AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

const PROJECT_METADATA_FILE: &str = "excalibur.json";

/// Holds the file path from startup (e.g. double-click in Finder) until the frontend is ready.
struct PendingFile(Mutex<Option<String>>);

#[derive(Serialize, Deserialize, Clone)]
struct RecentItem {
    kind: String,
    path: String,
    name: Option<String>,
    updated_at: u64,
    /// Display title read from the file (Mermaid frontmatter); never persisted.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    /// Normalized Mermaid diagram type; never persisted.
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none")]
    diagram_type: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ProjectItem {
    path: String,
    name: String,
    added_at: u64,
}

#[derive(Serialize)]
struct ProjectFile {
    kind: String,
    path: String,
    name: String,
    relative_path: String,
    updated_at: u64,
    /// User-authored label from the project metadata file.
    display_name: Option<String>,
    /// Format-owned title, currently Mermaid YAML frontmatter.
    title: Option<String>,
    /// Normalized Mermaid diagram type ("flowchart", "er", "sequence", ...).
    diagram_type: Option<String>,
}

#[derive(Serialize)]
struct OpenFileResponse {
    path: String,
    name: Option<String>,
    display_name: Option<String>,
    contents: String,
}

#[derive(Serialize)]
struct SaveFileResponse {
    path: String,
}

#[derive(Serialize)]
struct ImageFileResponse {
    path: String,
    name: Option<String>,
    mime_type: String,
    data_url: String,
}

#[derive(Deserialize)]
struct SaveFileRequest {
    path: Option<String>,
    name: Option<String>,
    /// Directory the save dialog should start in when no path is set.
    directory: Option<String>,
    contents: String,
}

#[derive(Deserialize)]
struct SavePngFileRequest {
    name: Option<String>,
    contents: Vec<u8>,
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn app_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn recents_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("recents.json")
}

fn load_recents(app: &AppHandle) -> Vec<RecentItem> {
    let path = recents_path(app);
    let Ok(contents) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_recents(app: &AppHandle, recents: &[RecentItem]) {
    if let Ok(contents) = serde_json::to_string_pretty(recents) {
        let _ = fs::create_dir_all(app_data_dir(app));
        let _ = fs::write(recents_path(app), contents);
    }
}

fn update_recents(app: &AppHandle, kind: &str, path: &str, name: Option<String>) {
    let mut recents = load_recents(app);
    recents.retain(|item| !(item.kind == kind && item.path == path));
    recents.insert(
        0,
        RecentItem {
            kind: kind.to_string(),
            path: path.to_string(),
            name,
            updated_at: now_epoch(),
            title: None,
            diagram_type: None,
        },
    );
    let limit = recents_limit(app);
    if recents.len() > limit {
        recents.truncate(limit);
    }
    save_recents(app, &recents);
}

fn remove_recent_entry(app: &AppHandle, kind: &str, path: &str) {
    let mut recents = load_recents(app);
    recents.retain(|item| !(item.kind == kind && item.path == path));
    save_recents(app, &recents);
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("settings.json")
}

/// Settings are an open JSON object owned by the frontend; the backend only reads the keys it needs.
fn load_settings_value(app: &AppHandle) -> serde_json::Value {
    let Ok(contents) = fs::read_to_string(settings_path(app)) else {
        return serde_json::Value::Object(Default::default());
    };
    match serde_json::from_str(&contents) {
        Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        _ => serde_json::Value::Object(Default::default()),
    }
}

fn setting_u64(app: &AppHandle, key: &str, default: u64, min: u64, max: u64) -> u64 {
    load_settings_value(app)
        .get(key)
        .and_then(|value| value.as_f64())
        .map(|value| value.round().clamp(min as f64, max as f64) as u64)
        .unwrap_or(default)
}

fn recents_limit(app: &AppHandle) -> usize {
    setting_u64(app, "recentsLimit", 10, 1, 100) as usize
}

fn project_scan_depth(app: &AppHandle) -> usize {
    setting_u64(app, "projectScanDepth", 4, 0, 10) as usize
}

fn projects_path(app: &AppHandle) -> PathBuf {
    app_data_dir(app).join("projects.json")
}

fn load_projects(app: &AppHandle) -> Vec<ProjectItem> {
    let Ok(contents) = fs::read_to_string(projects_path(app)) else {
        return Vec::new();
    };
    let mut projects: Vec<ProjectItem> = serde_json::from_str(&contents).unwrap_or_default();
    for project in &mut projects {
        project.name = project_display_name(Path::new(&project.path)).unwrap_or_else(|| {
            file_name(Path::new(&project.path)).unwrap_or_else(|| project.name.clone())
        });
    }
    projects
}

fn save_projects(app: &AppHandle, projects: &[ProjectItem]) {
    if let Ok(contents) = serde_json::to_string_pretty(projects) {
        let _ = fs::create_dir_all(app_data_dir(app));
        let _ = fs::write(projects_path(app), contents);
    }
}

/// Reads the user-facing name from the project-owned metadata file.
///
/// Invalid or missing metadata must not make a registered project disappear; the
/// folder name remains a safe display fallback until the file is repaired.
fn project_display_name(folder: &Path) -> Option<String> {
    let contents = fs::read_to_string(folder.join(PROJECT_METADATA_FILE)).ok()?;
    let metadata: serde_json::Value = serde_json::from_str(&contents).ok()?;
    metadata
        .get("displayName")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn project_diagram_display_names(folder: &Path) -> HashMap<String, String> {
    let Ok(contents) = fs::read_to_string(folder.join(PROJECT_METADATA_FILE)) else {
        return HashMap::new();
    };
    let Ok(metadata) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return HashMap::new();
    };
    metadata
        .get("diagrams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let path = entry.get("path")?.as_str()?.trim();
            let display_name = entry.get("displayName")?.as_str()?.trim();
            if path.is_empty() || display_name.is_empty() {
                return None;
            }
            Some((path.to_string(), display_name.to_string()))
        })
        .collect()
}

fn validate_project_display_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Project name cannot be empty.".to_string());
    }
    if trimmed.chars().count() > 120 {
        return Err("Project name must be 120 characters or fewer.".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("Project name cannot contain control characters.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Merges the display name into `excalibur.json`, preserving future or
/// user-authored metadata fields that Excalibur does not understand yet.
fn project_metadata_for_write(
    folder: &Path,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let metadata_path = folder.join(PROJECT_METADATA_FILE);
    if metadata_path.exists() {
        let contents = fs::read_to_string(&metadata_path).map_err(|error| error.to_string())?;
        let value: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|error| format!("{} contains invalid JSON: {error}", metadata_path.display()))?;
        match value {
            serde_json::Value::Object(map) => Ok(map),
            _ => {
                Err(format!(
                    "{} must contain a JSON object.",
                    metadata_path.display()
                ))
            }
        }
    } else {
        Ok(serde_json::Map::new())
    }
}

fn save_project_metadata(
    folder: &Path,
    metadata: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let metadata_path = folder.join(PROJECT_METADATA_FILE);
    let mut contents = serde_json::to_string_pretty(&metadata).map_err(|error| error.to_string())?;
    contents.push('\n');
    fs::write(metadata_path, contents).map_err(|error| error.to_string())
}

fn write_project_display_name(folder: &Path, name: &str) -> Result<(), String> {
    let mut metadata = project_metadata_for_write(folder)?;
    metadata.insert(
        "displayName".to_string(),
        serde_json::Value::String(name.to_string()),
    );
    save_project_metadata(folder, metadata)
}

fn portable_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| format!("{} is not inside {}.", path.display(), root.display()))?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn write_diagram_display_name(root: &Path, path: &Path, name: &str) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{} no longer exists.", path.display()));
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let relative_path = portable_relative_path(&root, &path)?;
    let mut metadata = project_metadata_for_write(&root)?;
    let diagrams = metadata
        .entry("diagrams".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "The diagrams field in excalibur.json must be an array.".to_string())?;

    if let Some(entry) = diagrams.iter_mut().find(|entry| {
        entry.get("path").and_then(serde_json::Value::as_str) == Some(relative_path.as_str())
    }) {
        let object = entry
            .as_object_mut()
            .ok_or_else(|| "Diagram metadata entries must be JSON objects.".to_string())?;
        object.insert(
            "displayName".to_string(),
            serde_json::Value::String(name.to_string()),
        );
    } else {
        diagrams.push(serde_json::json!({
            "path": relative_path,
            "displayName": name,
        }));
    }
    save_project_metadata(&root, metadata)
}

fn registered_project_root(app: &AppHandle, path: &Path) -> Option<PathBuf> {
    load_projects(app)
        .into_iter()
        .map(|project| PathBuf::from(project.path))
        .filter(|root| path.strip_prefix(root).is_ok())
        .max_by_key(|root| root.components().count())
}

fn diagram_display_name_for_path(app: &AppHandle, path: &Path) -> Option<String> {
    let root = registered_project_root(app, path)?;
    let relative_path = portable_relative_path(&root, path).ok()?;
    project_diagram_display_names(&root).remove(&relative_path)
}

fn validate_diagram_metadata_relocation(
    app: &AppHandle,
    source: &Path,
    target: &Path,
) -> Result<(), String> {
    let roots = [
        registered_project_root(app, source),
        registered_project_root(app, target),
    ];
    for root in roots.into_iter().flatten() {
        let metadata = project_metadata_for_write(&root)?;
        if metadata
            .get("diagrams")
            .is_some_and(|diagrams| !diagrams.is_array())
        {
            return Err(format!(
                "The diagrams field in {} must be an array.",
                root.join(PROJECT_METADATA_FILE).display()
            ));
        }
    }
    Ok(())
}

/// Keeps a diagram's metadata attached to it when its real file path changes.
fn relocate_diagram_metadata(app: &AppHandle, source: &Path, target: &Path) -> Result<(), String> {
    let Some(source_root) = registered_project_root(app, source) else {
        return Ok(());
    };
    let Some(target_root) = registered_project_root(app, target) else {
        return Ok(());
    };
    let old_relative = portable_relative_path(&source_root, source)?;
    let new_relative = portable_relative_path(&target_root, target)?;
    let mut source_metadata = project_metadata_for_write(&source_root)?;
    let Some(source_diagrams) = source_metadata
        .get_mut("diagrams")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return Ok(());
    };
    let Some(index) = source_diagrams.iter().position(|entry| {
        entry.get("path").and_then(serde_json::Value::as_str) == Some(old_relative.as_str())
    }) else {
        return Ok(());
    };
    let mut entry = source_diagrams.remove(index);
    entry
        .as_object_mut()
        .ok_or_else(|| "Diagram metadata entries must be JSON objects.".to_string())?
        .insert(
            "path".to_string(),
            serde_json::Value::String(new_relative.clone()),
        );

    if source_root == target_root {
        source_diagrams.push(entry);
        return save_project_metadata(&source_root, source_metadata);
    }

    let mut target_metadata = project_metadata_for_write(&target_root)?;
    let target_diagrams = target_metadata
        .entry("diagrams".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "The diagrams field in excalibur.json must be an array.".to_string())?;
    target_diagrams.retain(|candidate| {
        candidate.get("path").and_then(serde_json::Value::as_str) != Some(new_relative.as_str())
    });
    target_diagrams.push(entry);
    save_project_metadata(&target_root, target_metadata)?;
    save_project_metadata(&source_root, source_metadata)
}

fn register_project(app: &AppHandle, folder: &Path) -> Result<ProjectItem, String> {
    if !folder.is_dir() {
        return Err(format!("{} is not a folder.", folder.display()));
    }
    let path_string = folder.to_string_lossy().to_string();
    let mut projects = load_projects(app);
    if let Some(existing) = projects.iter().find(|item| item.path == path_string) {
        return Ok(existing.clone());
    }
    let item = ProjectItem {
        path: path_string,
        name: project_display_name(folder)
            .or_else(|| file_name(folder))
            .unwrap_or_else(|| "Project".to_string()),
        added_at: now_epoch(),
    };
    projects.push(item.clone());
    save_projects(app, &projects);
    Ok(item)
}

/// Extracts `title:` from a Mermaid YAML frontmatter block (`---` ... `---`) at the top of the source.
fn mermaid_frontmatter_title(source: &str) -> Option<String> {
    let mut lines = source.trim_start_matches('\u{feff}').lines();
    let first = lines.next()?.trim();
    if first != "---" {
        return None;
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            return None;
        }
        if let Some(value) = trimmed.strip_prefix("title:") {
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            return (!value.is_empty()).then(|| value.to_string());
        }
    }
    None
}

/// Identifies the Mermaid diagram type from the first meaningful line after
/// frontmatter, blank lines, and `%%` comments/directives.
fn mermaid_diagram_type(source: &str) -> Option<&'static str> {
    let mut lines = source.trim_start_matches('\u{feff}').lines().peekable();
    if lines.peek().map(|line| line.trim()) == Some("---") {
        lines.next();
        while lines.next()?.trim() != "---" {}
    }
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("%%") {
            continue;
        }
        let keyword: String = trimmed
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect();
        return Some(match keyword.as_str() {
            "flowchart" | "graph" => "flowchart",
            "sequenceDiagram" => "sequence",
            "classDiagram" | "classDiagram-v2" => "class",
            "erDiagram" => "er",
            "stateDiagram" | "stateDiagram-v2" => "state",
            "gantt" => "gantt",
            "pie" => "pie",
            "mindmap" => "mindmap",
            "journey" => "journey",
            "timeline" => "timeline",
            "gitGraph" => "git",
            "quadrantChart" => "quadrant",
            "requirementDiagram" => "requirement",
            "C4Context" | "C4Container" | "C4Component" | "C4Dynamic" | "C4Deployment" => "c4",
            _ => return None,
        });
    }
    None
}

/// Reads the head of a diagram file, enough for its format-owned metadata.
/// Only the head matters; avoids reading large files fully.
fn read_diagram_head(path: &Path) -> Option<String> {
    let mut buffer = vec![0u8; 4096];
    let mut file = fs::File::open(path).ok()?;
    let read = std::io::Read::read(&mut file, &mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer[..read]).into_owned())
}

/// Maps a file extension to the workspace that can open it.
fn diagram_kind(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("excalidraw") => Some("excalidraw"),
        Some("mmd") | Some("mermaid") => Some("mermaid"),
        _ => None,
    }
}

fn collect_project_files(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    display_names: &HashMap<String, String>,
    out: &mut Vec<ProjectFile>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = file_name(&path).unwrap_or_default();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        if path.is_dir() {
            if depth < max_depth {
                collect_project_files(root, &path, depth + 1, max_depth, display_names, out);
            }
            continue;
        }
        let Some(kind) = diagram_kind(&path) else {
            continue;
        };
        let updated_at = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let relative_path = path
            .strip_prefix(root)
            .map(|rest| rest.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        let head = (kind == "mermaid")
            .then(|| read_diagram_head(&path))
            .flatten();
        out.push(ProjectFile {
            kind: kind.to_string(),
            display_name: display_names.get(&relative_path.replace('\\', "/")).cloned(),
            title: head.as_deref().and_then(mermaid_frontmatter_title),
            diagram_type: head
                .as_deref()
                .and_then(mermaid_diagram_type)
                .map(str::to_string),
            path: path.to_string_lossy().to_string(),
            name,
            relative_path,
            updated_at,
        });
    }
}

fn sanitize_file_stem(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty.".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        return Err("Name cannot contain path separators.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Moves a file or folder, falling back to copy + delete when crossing volumes.
fn move_path(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("{} already exists.", to.display()));
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if from.is_dir() {
        return Err("Unable to move folder across volumes.".to_string());
    }
    fs::copy(from, to).map_err(|error| error.to_string())?;
    fs::remove_file(from).map_err(|error| error.to_string())
}

fn read_file(path: &Path) -> Result<String, String> {
    eprintln!("[excalibur] read_file: attempting to read {:?}", path);
    match fs::read_to_string(path) {
        Ok(contents) => {
            eprintln!(
                "[excalibur] read_file: success, read {} bytes from {:?}",
                contents.len(),
                path
            );
            Ok(contents)
        }
        Err(error) => {
            eprintln!("[excalibur] read_file: FAILED to read {:?}: {}", path, error);
            Err(error.to_string())
        }
    }
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn write_binary_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn file_name(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
}

fn default_excalidraw_file_name(name: Option<&str>) -> String {
    let base_name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("drawing");

    if base_name.ends_with(".excalidraw") || base_name.ends_with(".json") {
        base_name.to_string()
    } else {
        format!("{base_name}.excalidraw")
    }
}

fn default_mermaid_file_name(name: Option<&str>) -> String {
    let base_name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("diagram");
    let lower = base_name.to_ascii_lowercase();
    if lower.ends_with(".mmd") || lower.ends_with(".mermaid") || lower.ends_with(".md") {
        base_name.to_string()
    } else {
        format!("{base_name}.mmd")
    }
}

fn default_png_file_name(name: Option<&str>) -> String {
    let base_name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("drawing");

    if base_name.to_ascii_lowercase().ends_with(".png") {
        return base_name.to_string();
    }

    let stem = Path::new(base_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or(base_name);

    format!("{stem}.png")
}

fn supported_image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn recents_with_titles(app: &AppHandle) -> Vec<RecentItem> {
    let mut recents = load_recents(app);
    for item in recents.iter_mut() {
        let path = Path::new(&item.path);
        let head = (item.kind == "mermaid")
            .then(|| read_diagram_head(path))
            .flatten();
        item.title = diagram_display_name_for_path(app, path)
            .or_else(|| head.as_deref().and_then(mermaid_frontmatter_title));
        item.diagram_type = head
            .as_deref()
            .and_then(mermaid_diagram_type)
            .map(str::to_string);
    }
    recents
}

#[tauri::command]
fn list_recents(app: AppHandle) -> Vec<RecentItem> {
    recents_with_titles(&app)
}

#[tauri::command]
fn remove_recent(app: AppHandle, kind: String, path: String) -> Vec<RecentItem> {
    remove_recent_entry(&app, &kind, &path);
    recents_with_titles(&app)
}

#[tauri::command]
fn load_settings(app: AppHandle) -> serde_json::Value {
    load_settings_value(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: serde_json::Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("Settings must be an object.".to_string());
    }
    let contents = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::create_dir_all(app_data_dir(&app)).map_err(|error| error.to_string())?;
    fs::write(settings_path(&app), contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_projects(app: AppHandle) -> Vec<ProjectItem> {
    load_projects(&app)
}

/// Opens a folder picker (which can also create a new folder) and registers the choice as a project.
#[tauri::command]
async fn add_project_folder(app: AppHandle) -> Result<Option<ProjectItem>, String> {
    let (sender, mut receiver) = channel(1);
    app.dialog()
        .file()
        .set_title("Choose or create a project folder")
        .set_can_create_directories(true)
        .pick_folder(move |folder| {
            let _ = sender.try_send(folder);
        });

    let Some(Some(folder)) = receiver.recv().await else {
        return Ok(None);
    };
    let folder = folder.into_path().map_err(|e| e.to_string())?;
    register_project(&app, &folder).map(Some)
}

#[tauri::command]
fn add_project_path(app: AppHandle, path: String) -> Result<ProjectItem, String> {
    register_project(&app, &PathBuf::from(path))
}

#[tauri::command]
fn remove_project(app: AppHandle, path: String) -> Vec<ProjectItem> {
    let mut projects = load_projects(&app);
    projects.retain(|item| item.path != path);
    save_projects(&app, &projects);
    projects
}

/// Changes only the project's display name. The folder path and every diagram
/// inside it stay put; the name travels with the folder in `excalibur.json`.
#[tauri::command]
fn rename_project(app: AppHandle, path: String, name: String) -> Result<ProjectItem, String> {
    let name = validate_project_display_name(&name)?;
    let project_path = PathBuf::from(&path);
    if !project_path.is_dir() {
        return Err(format!("{} is not available.", project_path.display()));
    }
    let mut projects = load_projects(&app);
    let item = projects
        .iter_mut()
        .find(|item| item.path == path)
        .ok_or_else(|| "Project is not registered.".to_string())?;
    write_project_display_name(&project_path, &name)?;
    item.name = name;
    let updated = item.clone();
    save_projects(&app, &projects);
    Ok(updated)
}

#[tauri::command]
fn list_project_files(app: AppHandle, path: String) -> Result<Vec<ProjectFile>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{} is not available.", root.display()));
    }
    let mut files = Vec::new();
    let display_names = project_diagram_display_names(&root);
    collect_project_files(
        &root,
        &root,
        0,
        project_scan_depth(&app),
        &display_names,
        &mut files,
    );
    files.sort_by(|a, b| {
        a.relative_path
            .to_lowercase()
            .cmp(&b.relative_path.to_lowercase())
    });
    Ok(files)
}

/// Gives one diagram a project-local display name without renaming the file.
#[tauri::command]
fn rename_project_file_display_name(
    app: AppHandle,
    project_path: String,
    path: String,
    name: String,
) -> Result<(), String> {
    let name = validate_project_display_name(&name)?;
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("{} is not available.", root.display()));
    }
    if !load_projects(&app)
        .iter()
        .any(|project| project.path == project_path)
    {
        return Err("Project is not registered.".to_string());
    }
    write_diagram_display_name(&root, &PathBuf::from(path), &name)
}

/// Moves a diagram file into a project folder and returns its new path.
#[tauri::command]
fn move_file_to_project(app: AppHandle, path: String, project_path: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    let kind = diagram_kind(&source).ok_or_else(|| "Only diagram files can be moved.".to_string())?;
    if !source.is_file() {
        return Err(format!("{} no longer exists.", source.display()));
    }
    let project = PathBuf::from(&project_path);
    if !project.is_dir() {
        return Err(format!("{} is not a folder.", project.display()));
    }
    let name = file_name(&source).ok_or_else(|| "File has no name.".to_string())?;
    let target = project.join(&name);
    if target == source {
        return Ok(path);
    }
    validate_diagram_metadata_relocation(&app, &source, &target)?;
    move_path(&source, &target)?;
    if let Err(error) = relocate_diagram_metadata(&app, &source, &target) {
        let rollback = move_path(&target, &source);
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => format!(
                "{error} The file was moved to {}, and moving it back also failed: {rollback_error}",
                target.display()
            ),
        });
    }
    let target_string = target.to_string_lossy().to_string();
    remove_recent_entry(&app, kind, &path);
    update_recents(&app, kind, &target_string, Some(name));
    Ok(target_string)
}

/// Renames a diagram file in place (keeping its extension) and returns the new path.
#[tauri::command]
fn rename_file(app: AppHandle, path: String, name: String) -> Result<String, String> {
    let stem = sanitize_file_stem(&name)?;
    let source = PathBuf::from(&path);
    let kind = diagram_kind(&source).ok_or_else(|| "Only diagram files can be renamed.".to_string())?;
    let parent = source
        .parent()
        .ok_or_else(|| "File has no parent folder.".to_string())?;
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    let target = parent.join(format!("{stem}.{extension}"));
    if target == source {
        return Ok(path);
    }
    validate_diagram_metadata_relocation(&app, &source, &target)?;
    move_path(&source, &target)?;
    if let Err(error) = relocate_diagram_metadata(&app, &source, &target) {
        let rollback = move_path(&target, &source);
        return Err(match rollback {
            Ok(()) => error,
            Err(rollback_error) => format!(
                "{error} The file was renamed to {}, and restoring its old name also failed: {rollback_error}",
                target.display()
            ),
        });
    }
    let target_string = target.to_string_lossy().to_string();
    remove_recent_entry(&app, kind, &path);
    update_recents(&app, kind, &target_string, file_name(&target));
    Ok(target_string)
}

#[tauri::command]
async fn open_excalidraw_file(app: AppHandle) -> Result<Option<OpenFileResponse>, String> {
    eprintln!("[excalibur] open_excalidraw_file: opening file dialog");
    let (sender, mut receiver) = channel(1);
    app.dialog()
        .file()
        .add_filter("Excalidraw", &["excalidraw", "json"])
        .pick_file(move |file_path| {
            eprintln!("[excalibur] open_excalidraw_file: file dialog callback received");
            let _ = sender.try_send(file_path);
        });

    eprintln!("[excalibur] open_excalidraw_file: waiting for file dialog response");
    let Some(file_path) = receiver.recv().await else {
        eprintln!("[excalibur] open_excalidraw_file: receiver closed, returning None");
        return Ok(None);
    };
    let Some(file) = file_path else {
        eprintln!("[excalibur] open_excalidraw_file: user cancelled dialog, returning None");
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| {
        eprintln!("[excalibur] open_excalidraw_file: failed to convert path: {}", e);
        e.to_string()
    })?;
    eprintln!("[excalibur] open_excalidraw_file: selected path = {:?}", path);

    let contents = read_file(&path)?;
    let name = file_name(&path);
    let path_string = path.to_string_lossy().to_string();

    eprintln!(
        "[excalibur] open_excalidraw_file: updating recents for path={}, name={:?}",
        path_string, name
    );
    update_recents(&app, "excalidraw", &path_string, name.clone());

    eprintln!(
        "[excalibur] open_excalidraw_file: returning response with {} bytes of content",
        contents.len()
    );
    Ok(Some(OpenFileResponse {
        path: path_string,
        name,
        display_name: diagram_display_name_for_path(&app, &path),
        contents,
    }))
}

#[tauri::command]
fn load_excalidraw_path(
    app: AppHandle,
    path: String,
    track_recent: Option<bool>,
) -> Result<OpenFileResponse, String> {
    eprintln!("[excalibur] load_excalidraw_path: loading from path={}", path);
    let path_buf = PathBuf::from(&path);

    let contents = read_file(&path_buf)?;
    let name = file_name(&path_buf);
    let path_string = path_buf.to_string_lossy().to_string();

    if track_recent.unwrap_or(true) {
        eprintln!(
            "[excalibur] load_excalidraw_path: updating recents for path={}, name={:?}",
            path_string, name
        );
        update_recents(&app, "excalidraw", &path_string, name.clone());
    }

    eprintln!(
        "[excalibur] load_excalidraw_path: returning response with {} bytes of content",
        contents.len()
    );
    Ok(OpenFileResponse {
        path: path_string,
        name,
        display_name: diagram_display_name_for_path(&app, &path_buf),
        contents,
    })
}

#[tauri::command]
fn load_image_file(path: String) -> Result<ImageFileResponse, String> {
    eprintln!("[excalibur] load_image_file: loading from path={}", path);
    let path_buf = PathBuf::from(&path);
    let mime_type = supported_image_mime_type(&path_buf)
        .ok_or_else(|| "Unsupported image type. Use PNG, JPEG, or WebP.".to_string())?;
    let contents = fs::read(&path_buf).map_err(|error| {
        eprintln!(
            "[excalibur] load_image_file: FAILED to read {:?}: {}",
            path_buf, error
        );
        error.to_string()
    })?;
    let data_url = format!(
        "data:{};base64,{}",
        mime_type,
        general_purpose::STANDARD.encode(contents)
    );

    Ok(ImageFileResponse {
        path: path_buf.to_string_lossy().to_string(),
        name: file_name(&path_buf),
        mime_type: mime_type.to_string(),
        data_url,
    })
}

#[tauri::command]
async fn save_excalidraw_file(
    app: AppHandle,
    request: SaveFileRequest,
) -> Result<SaveFileResponse, String> {
    let suggested_name = default_excalidraw_file_name(request.name.as_deref());
    let path = if let Some(path) = request.path {
        PathBuf::from(path)
    } else {
        let (sender, mut receiver) = channel(1);
        let mut dialog = app
            .dialog()
            .file()
            .add_filter("Excalidraw", &["excalidraw", "json"])
            .set_file_name(suggested_name);
        if let Some(directory) = request.directory.as_deref().filter(|dir| Path::new(dir).is_dir()) {
            dialog = dialog.set_directory(directory);
        }
        dialog
            .save_file(move |file_path| {
                let _ = sender.try_send(file_path);
            });
        let target = receiver
            .recv()
            .await
            .ok_or_else(|| "Save cancelled".to_string())?;
        target
            .ok_or_else(|| "Save cancelled".to_string())?
            .into_path()
            .map_err(|e| e.to_string())?
    };

    write_file(&path, &request.contents)?;
    let name = request.name.or_else(|| file_name(&path));
    let path_string = path.to_string_lossy().to_string();
    update_recents(&app, "excalidraw", &path_string, name);

    Ok(SaveFileResponse { path: path_string })
}

#[tauri::command]
async fn save_png_file(
    app: AppHandle,
    request: SavePngFileRequest,
) -> Result<SaveFileResponse, String> {
    let suggested_name = default_png_file_name(request.name.as_deref());
    let (sender, mut receiver) = channel(1);
    app.dialog()
        .file()
        .add_filter("PNG", &["png"])
        .set_file_name(suggested_name)
        .save_file(move |file_path| {
            let _ = sender.try_send(file_path);
        });
    let target = receiver
        .recv()
        .await
        .ok_or_else(|| "Save cancelled".to_string())?;
    let path = target
        .ok_or_else(|| "Save cancelled".to_string())?
        .into_path()
        .map_err(|e| e.to_string())?;

    write_binary_file(&path, &request.contents)?;
    Ok(SaveFileResponse {
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn open_mermaid_file(app: AppHandle) -> Result<Option<OpenFileResponse>, String> {
    let (sender, mut receiver) = channel(1);
    app.dialog()
        .file()
        .add_filter("Mermaid", &["mmd", "mermaid", "md", "txt"])
        .pick_file(move |file_path| {
            let _ = sender.try_send(file_path);
        });

    let Some(file_path) = receiver.recv().await else {
        return Ok(None);
    };
    let Some(file) = file_path else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let contents = read_file(&path)?;
    let name = file_name(&path);
    let path_string = path.to_string_lossy().to_string();
    update_recents(&app, "mermaid", &path_string, name.clone());

    Ok(Some(OpenFileResponse {
        path: path_string,
        name,
        display_name: diagram_display_name_for_path(&app, &path),
        contents,
    }))
}

#[tauri::command]
fn load_mermaid_path(
    app: AppHandle,
    path: String,
    track_recent: Option<bool>,
) -> Result<OpenFileResponse, String> {
    let path_buf = PathBuf::from(path);
    let contents = read_file(&path_buf)?;
    let name = file_name(&path_buf);
    let path_string = path_buf.to_string_lossy().to_string();
    if track_recent.unwrap_or(true) {
        update_recents(&app, "mermaid", &path_string, name.clone());
    }

    Ok(OpenFileResponse {
        path: path_string,
        name,
        display_name: diagram_display_name_for_path(&app, &path_buf),
        contents,
    })
}

#[tauri::command]
async fn save_mermaid_file(
    app: AppHandle,
    request: SaveFileRequest,
) -> Result<SaveFileResponse, String> {
    let path = if let Some(path) = request.path {
        PathBuf::from(path)
    } else {
        let (sender, mut receiver) = channel(1);
        let mut dialog = app
            .dialog()
            .file()
            .add_filter("Mermaid", &["mmd", "mermaid", "md", "txt"])
            .set_file_name(default_mermaid_file_name(request.name.as_deref()));
        if let Some(directory) = request.directory.as_deref().filter(|dir| Path::new(dir).is_dir()) {
            dialog = dialog.set_directory(directory);
        }
        dialog
            .save_file(move |file_path| {
                let _ = sender.try_send(file_path);
            });
        let target = receiver
            .recv()
            .await
            .ok_or_else(|| "Save cancelled".to_string())?;
        target
            .ok_or_else(|| "Save cancelled".to_string())?
            .into_path()
            .map_err(|e| e.to_string())?
    };

    write_file(&path, &request.contents)?;
    let name = request.name.or_else(|| file_name(&path));
    let path_string = path.to_string_lossy().to_string();
    update_recents(&app, "mermaid", &path_string, name);

    Ok(SaveFileResponse { path: path_string })
}

/// Returns (and clears) the file path that was pending from app startup.
#[tauri::command]
fn take_pending_file(app: AppHandle) -> Option<String> {
    let state = app.state::<PendingFile>();
    let path = state.0.lock().unwrap().take();
    eprintln!("[excalibur] take_pending_file: {:?}", path);
    path
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

fn file_path_from_url(url: &url::Url) -> Option<String> {
    url.to_file_path()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(PendingFile(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            list_recents,
            remove_recent,
            load_settings,
            save_settings,
            list_projects,
            add_project_folder,
            add_project_path,
            remove_project,
            rename_project,
            list_project_files,
            rename_project_file_display_name,
            move_file_to_project,
            rename_file,
            open_excalidraw_file,
            load_excalidraw_path,
            load_image_file,
            save_excalidraw_file,
            save_png_file,
            open_mermaid_file,
            load_mermaid_path,
            save_mermaid_file,
            take_pending_file,
            exit_app
        ])
        .setup(|app| {
            // Check for a file opened at launch (e.g. double-click in Finder).
            // Store it in state so the frontend can retrieve it when ready.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                eprintln!("[excalibur] deep_link startup URLs: {:?}", urls);
                for url in &urls {
                    if let Some(path) = file_path_from_url(url) {
                        eprintln!("[excalibur] storing pending file for startup: {}", path);
                        let state = app.state::<PendingFile>();
                        *state.0.lock().unwrap() = Some(path);
                        break;
                    }
                }
            }

            // Listen for files opened while the app is already running.
            // At this point the frontend is loaded, so emitting an event is fine.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                eprintln!("[excalibur] deep_link on_open_url: {:?}", urls);
                for url in &urls {
                    if let Some(path) = file_path_from_url(url) {
                        eprintln!("[excalibur] emitting open-file for runtime path: {}", path);
                        let _ = handle.emit("open-file", path);
                        break;
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        mermaid_diagram_type, mermaid_frontmatter_title, project_diagram_display_names,
        project_display_name, write_diagram_display_name, write_project_display_name,
        PROJECT_METADATA_FILE,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn reads_title_from_frontmatter() {
        let source = "---\ntitle: Auth flow\nconfig:\n  theme: dark\n---\nflowchart TD\n  A --> B";
        assert_eq!(mermaid_frontmatter_title(source), Some("Auth flow".to_string()));
    }

    #[test]
    fn strips_quotes_and_bom() {
        let source = "\u{feff}---\ntitle: \"Order: ER\"\n---\nerDiagram";
        assert_eq!(mermaid_frontmatter_title(source), Some("Order: ER".to_string()));
    }

    #[test]
    fn ignores_title_outside_frontmatter() {
        assert_eq!(mermaid_frontmatter_title("flowchart TD\n  title: nope"), None);
        assert_eq!(mermaid_frontmatter_title("---\n---\ntitle: later"), None);
        assert_eq!(mermaid_frontmatter_title("---\ntitle:   \n---\n"), None);
    }

    #[test]
    fn detects_diagram_type_from_first_keyword() {
        assert_eq!(mermaid_diagram_type("flowchart TD\n  A --> B"), Some("flowchart"));
        assert_eq!(mermaid_diagram_type("graph LR\n  A --> B"), Some("flowchart"));
        assert_eq!(mermaid_diagram_type("erDiagram\n  USER ||--o{ ORDER : places"), Some("er"));
        assert_eq!(mermaid_diagram_type("stateDiagram-v2\n  [*] --> Idle"), Some("state"));
        assert_eq!(mermaid_diagram_type("pie showData\n  \"A\": 1"), Some("pie"));
        assert_eq!(mermaid_diagram_type("C4Context\n  title System"), Some("c4"));
    }

    #[test]
    fn diagram_type_skips_frontmatter_and_comments() {
        let source = "\u{feff}---\ntitle: Auth\n---\n\n%%{init: {\"theme\": \"dark\"}}%%\nsequenceDiagram\n  A->>B: hi";
        assert_eq!(mermaid_diagram_type(source), Some("sequence"));
        assert_eq!(mermaid_diagram_type("---\ntitle: cut off"), None);
        assert_eq!(mermaid_diagram_type("someUnknownThing\n  A --> B"), None);
    }

    #[test]
    fn project_metadata_keeps_project_and_diagram_display_names() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "excalibur-project-metadata-{}-{nonce}",
            std::process::id()
        ));
        let nested = root.join("flows");
        fs::create_dir_all(&nested).unwrap();
        let diagram = nested.join("auth.mmd");
        fs::write(&diagram, "flowchart TD\n  A --> B\n").unwrap();
        fs::write(
            root.join(PROJECT_METADATA_FILE),
            "{\n  \"owner\": \"architecture\"\n}\n",
        )
        .unwrap();

        write_project_display_name(&root, "FSML architecture").unwrap();
        write_diagram_display_name(&root, &diagram, "Teacher signup and routing").unwrap();

        assert_eq!(
            project_display_name(&root),
            Some("FSML architecture".to_string())
        );
        assert_eq!(
            project_diagram_display_names(&root).get("flows/auth.mmd"),
            Some(&"Teacher signup and routing".to_string())
        );
        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(root.join(PROJECT_METADATA_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["owner"], "architecture");
        assert_eq!(metadata["diagrams"][0]["path"], "flows/auth.mmd");

        fs::remove_dir_all(root).unwrap();
    }
}
