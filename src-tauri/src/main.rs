#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{async_runtime::channel, AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize, Deserialize, Clone)]
struct RecentItem {
    kind: String,
    path: String,
    name: Option<String>,
    updated_at: u64,
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

#[derive(Deserialize)]
struct SaveFileRequest {
    path: Option<String>,
    name: Option<String>,
    contents: String,
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
        },
    );
    if recents.len() > 10 {
        recents.truncate(10);
    }
    save_recents(app, &recents);
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

fn file_name(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
}

#[tauri::command]
fn list_recents(app: AppHandle) -> Vec<RecentItem> {
    load_recents(&app)
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
fn load_excalidraw_path(app: AppHandle, path: String) -> Result<OpenFileResponse, String> {
    eprintln!("[excalibur] load_excalidraw_path: loading from path={}", path);
    let path_buf = PathBuf::from(&path);

    let contents = read_file(&path_buf)?;
    let name = file_name(&path_buf);
    let path_string = path_buf.to_string_lossy().to_string();

    eprintln!(
        "[excalibur] load_excalidraw_path: updating recents for path={}, name={:?}",
        path_string, name
    );
    update_recents(&app, "excalidraw", &path_string, name.clone());

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
async fn save_excalidraw_file(
    app: AppHandle,
    request: SaveFileRequest,
) -> Result<SaveFileResponse, String> {
    let path = if let Some(path) = request.path {
        PathBuf::from(path)
    } else {
        let (sender, mut receiver) = channel(1);
        app.dialog()
            .file()
            .add_filter("Excalidraw", &["excalidraw", "json"])
            .set_file_name("drawing.excalidraw")
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
fn load_mermaid_path(app: AppHandle, path: String) -> Result<OpenFileResponse, String> {
    let path_buf = PathBuf::from(path);
    let contents = read_file(&path_buf)?;
    let name = file_name(&path_buf);
    let path_string = path_buf.to_string_lossy().to_string();
    update_recents(&app, "mermaid", &path_string, name.clone());

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
        app.dialog()
            .file()
            .add_filter("Mermaid", &["mmd", "mermaid", "md", "txt"])
            .set_file_name("diagram.mmd")
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

fn file_path_from_url(url: &url::Url) -> Option<String> {
    url.to_file_path()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            list_recents,
            open_excalidraw_file,
            load_excalidraw_path,
            save_excalidraw_file,
            open_mermaid_file,
            load_mermaid_path,
            save_mermaid_file
        ])
        .setup(|app| {
            // Check for a file opened at launch (e.g. double-click in Finder)
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                eprintln!("[excalibur] deep_link startup URLs: {:?}", urls);
                for url in &urls {
                    if let Some(path) = file_path_from_url(url) {
                        eprintln!("[excalibur] emitting open-file for startup path: {}", path);
                        let _ = app.emit("open-file", path);
                        break;
                    }
                }
            }

            // Listen for files opened while the app is already running
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
