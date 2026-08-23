#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{async_runtime::channel, AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

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
    title: Option<String>,
}

#[derive(Serialize)]
struct OpenFileResponse {
    path: String,
    name: Option<String>,
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

/// Rewrites recents entries whose path starts with `old_prefix` so they point at `new_prefix`.
fn rewrite_recent_paths(app: &AppHandle, old_prefix: &Path, new_prefix: &Path) {
    let mut recents = load_recents(app);
    let mut changed = false;
    for item in recents.iter_mut() {
        let item_path = PathBuf::from(&item.path);
        if let Ok(rest) = item_path.strip_prefix(old_prefix) {
            let next = new_prefix.join(rest);
            item.path = next.to_string_lossy().to_string();
            item.name = file_name(&next);
            changed = true;
        }
    }
    if changed {
        save_recents(app, &recents);
    }
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
    serde_json::from_str(&contents).unwrap_or_default()
}

fn save_projects(app: &AppHandle, projects: &[ProjectItem]) {
    if let Ok(contents) = serde_json::to_string_pretty(projects) {
        let _ = fs::create_dir_all(app_data_dir(app));
        let _ = fs::write(projects_path(app), contents);
    }
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
        name: file_name(folder).unwrap_or_else(|| "Project".to_string()),
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

/// Reads the display title of a diagram file, if its format carries one.
fn diagram_title(kind: &str, path: &Path) -> Option<String> {
    if kind != "mermaid" {
        return None;
    }
    // Only the head of the file matters; avoid reading large files fully.
    let mut buffer = vec![0u8; 4096];
    let mut file = fs::File::open(path).ok()?;
    let read = std::io::Read::read(&mut file, &mut buffer).ok()?;
    let head = String::from_utf8_lossy(&buffer[..read]);
    mermaid_frontmatter_title(&head)
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
                collect_project_files(root, &path, depth + 1, max_depth, out);
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
        out.push(ProjectFile {
            kind: kind.to_string(),
            title: diagram_title(kind, &path),
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
        item.title = diagram_title(&item.kind, Path::new(&item.path));
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

/// Renames the project folder on disk and rewrites any recents that pointed inside it.
#[tauri::command]
fn rename_project(app: AppHandle, path: String, name: String) -> Result<ProjectItem, String> {
    let name = sanitize_file_stem(&name)?;
    let old_path = PathBuf::from(&path);
    let parent = old_path
        .parent()
        .ok_or_else(|| "Project folder has no parent.".to_string())?;
    let new_path = parent.join(&name);
    if new_path != old_path {
        move_path(&old_path, &new_path)?;
        rewrite_recent_paths(&app, &old_path, &new_path);
    }

    let mut projects = load_projects(&app);
    let new_path_string = new_path.to_string_lossy().to_string();
    let mut updated: Option<ProjectItem> = None;
    for item in projects.iter_mut() {
        if item.path == path {
            item.path = new_path_string.clone();
            item.name = name.clone();
            updated = Some(item.clone());
        }
    }
    save_projects(&app, &projects);
    updated.ok_or_else(|| "Project is not registered.".to_string())
}

#[tauri::command]
fn list_project_files(app: AppHandle, path: String) -> Result<Vec<ProjectFile>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{} is not available.", root.display()));
    }
    let mut files = Vec::new();
    collect_project_files(&root, &root, 0, project_scan_depth(&app), &mut files);
    files.sort_by(|a, b| {
        a.relative_path
            .to_lowercase()
            .cmp(&b.relative_path.to_lowercase())
    });
    Ok(files)
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
    move_path(&source, &target)?;
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
    move_path(&source, &target)?;
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
    use super::mermaid_frontmatter_title;

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
}
