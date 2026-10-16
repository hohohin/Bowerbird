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
pub async fn external_files_media(app: AppHandle, path: String) -> Result<String, AppError> {
    let path = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let path = std::fs::canonicalize(path)?;
        if !path.is_file() || !(external_files::image_path(&path) || external_files::video_path(&path)) {
            return Err(AppError::Other("请选择支持的图片或视频".into()));
        }
        Ok(path)
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
#[tauri::command]
pub async fn external_files_browse(
    path: Option<String>,
    offset: Option<usize>,
    all: Option<bool>,
) -> Result<DirectoryPage, AppError> {
    tokio::task::spawn_blocking(move || {
        external_files::browse_page(path.as_deref(), offset.unwrap_or(0), all.unwrap_or(false))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn external_files_preview(
    paths: State<'_, Arc<LibraryPaths>>,
    path: String,
) -> Result<String, AppError> {
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    let permit = GATE.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
    let paths = paths.inner().clone();
    tokio::task::spawn_blocking(move || { let _permit = permit; external_files::preview(&paths, &PathBuf::from(path)) })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
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
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Asset, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let asset = tokio::task::spawn_blocking(move || db.copy_external_to_library(&paths, &asset_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    changed(&app);
    Ok(asset)
}
