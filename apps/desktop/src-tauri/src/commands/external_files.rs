use crate::{
    core::{
        external_files::{self, DirectoryPage, ExternalReference},
        library::Asset,
        paths::LibraryPaths,
    },
    db::Database,
    error::AppError,
};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn external_files_media(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, path: String) -> Result<String, AppError> {
    let paths = paths.inner().clone();
    let path = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let path = std::fs::canonicalize(path)?;
        if !path.is_file() || !(external_files::image_path(&path) || external_files::video_path(&path) || external_files::audio_path(&path)) {
            return Err(AppError::Other("请选择支持的图片、视频或音频".into()));
        }
        external_files::compatible_image(&paths, &path)
    }).await.map_err(|e| AppError::Other(e.to_string()))??;
    app.asset_protocol_scope().allow_file(&path).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

fn allow(app: &AppHandle, asset: &Asset) -> Result<(), AppError> {
    if let Some(path) = &asset.store_path {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}
fn changed(app: &AppHandle) {
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
}

fn preview_completed(app: AppHandle) {
    // Several visible items finish together. Publish their new dimensions as one
    // gallery refresh instead of invalidating every page for every thumbnail.
    static PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if PENDING.swap(true, std::sync::atomic::Ordering::AcqRel) { return; }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        PENDING.store(false, std::sync::atomic::Ordering::Release);
        changed(&app);
    });
}

#[tauri::command]
pub async fn local_file_rename(app: AppHandle, db: State<'_, Arc<Database>>, asset_id: String, path: String, name: String) -> Result<(), AppError> {
    let db = db.inner().clone();
    let asset = tokio::task::spawn_blocking(move || {
        db.rename_local_file(&asset_id, &path, &name)?;
        db.get_asset(&asset_id)?.ok_or_else(|| AppError::Other("素材已不存在".into()))
    }).await.map_err(|e| AppError::Other(e.to_string()))??;
    allow(&app, &asset)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn local_file_delete(app: AppHandle, db: State<'_, Arc<Database>>, asset_id: String, path: String) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_local_file(&asset_id, &path))
        .await.map_err(|e| AppError::Other(e.to_string()))??;
    changed(&app);
    Ok(())
}
#[tauri::command]
pub async fn external_files_browse(
    paths: State<'_, Arc<LibraryPaths>>,
    path: Option<String>,
    offset: Option<usize>,
    all: Option<bool>,
) -> Result<DirectoryPage, AppError> {
    let paths = paths.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut page = external_files::browse_page(path.as_deref(), offset.unwrap_or(0), all.unwrap_or(false))?;
        external_files::attach_previews(&paths, &mut page.entries);
        Ok(page)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn external_files_preview(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    path: String,
) -> Result<String, AppError> {
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let cached_paths = paths.clone(); let cached_path = path.clone(); let cached_db = db.clone();
    let cached = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let source = PathBuf::from(cached_path);
        let cached = external_files::cached_preview(&cached_paths, &source)?;
        if let Some(preview) = &cached {
            if cached_db.connected_preview_pending(&source, preview)? { return Ok(None); }
        }
        Ok(cached)
    })
        .await.map_err(|e| AppError::Other(e.to_string()))??;
    if let Some(cached) = cached {
        app.asset_protocol_scope().allow_file(&cached).map_err(|e| AppError::Other(e.to_string()))?;
        return Ok(cached);
    }
    let permit = GATE.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
    let (preview, updated) = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let _permit = permit;
        let path = PathBuf::from(path);
        let preview = external_files::preview_with_index(&paths, Some(&db), &path)?;
        let updated = db.complete_connected_preview(&paths, &path, &preview)?.is_some();
        Ok((preview, updated))
    })
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    app.asset_protocol_scope().allow_file(&preview).map_err(|e| AppError::Other(e.to_string()))?;
    if updated { preview_completed(app); }
    Ok(preview)
}
#[tauri::command]
pub async fn external_files_index(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    path: String,
) -> Result<Asset, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let asset =
        tokio::task::spawn_blocking(move || db.index_external(&paths, &PathBuf::from(path)))
            .await
            .map_err(|e| AppError::Other(e.to_string()))??;
    allow(&app, &asset)?;
    Ok(asset)
}
#[tauri::command]
pub async fn external_files_references(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> Result<Vec<ExternalReference>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || external_files::references(&db, &project_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn external_files_update(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    path: String,
    accept_changes: bool,
) -> Result<Asset, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let asset = tokio::task::spawn_blocking(move || {
        db.update_external(&paths, &asset_id, &PathBuf::from(path), accept_changes)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    allow(&app, &asset)?;
    changed(&app);
    let _ = app.emit(
        "analyses://changed",
        serde_json::json!({"asset_id":asset.id,"kind":"caption"}),
    );
    Ok(asset)
}
#[tauri::command]
pub async fn external_files_copy(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Asset, AppError> {
    let db = db.inner().clone();
    // Retain the IPC name for older callers; joining the library never copies an original.
    let asset = tokio::task::spawn_blocking(move || db.link_external_to_library(&asset_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    allow(&app, &asset)?;
    changed(&app);
    Ok(asset)
}
