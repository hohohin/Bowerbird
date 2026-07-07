//! 库相关命令（前端 invoke 入口）。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;
use ulid::Ulid;

use crate::core::ingest;
use crate::core::library::{Analysis, Asset, Folder, PromptedAsset};
use crate::core::paths::LibraryPaths;
use crate::db::Database;
use crate::error::AppError;

#[tauri::command]
pub async fn import_files(
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    sources: Vec<String>,
) -> Result<Vec<Asset>, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut assets = Vec::with_capacity(sources.len());
        for s in sources {
            match ingest::ingest_file(&paths, &db, &PathBuf::from(&s)) {
                Ok(a) => assets.push(a),
                Err(e) => tracing::warn!("ingest failed for {s}: {e}"),
            }
        }
        Ok::<_, AppError>(assets)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn import_folder(
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    path: String,
) -> Result<usize, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        ingest::ingest_dir(&paths, &db, &PathBuf::from(path))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_assets(
    db: State<'_, Arc<Database>>,
    folder_id: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        db.list_assets(folder_id.as_deref(), limit.unwrap_or(500), offset.unwrap_or(0))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn count_assets(db: State<'_, Arc<Database>>) -> Result<i64, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.count_assets())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_folders(db: State<'_, Arc<Database>>) -> Result<Vec<Folder>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_folders())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn create_folder(
    db: State<'_, Arc<Database>>,
    name: String,
    parent_id: Option<String>,
) -> Result<String, AppError> {
    let id = Ulid::new().to_string();
    let db = db.inner().clone();
    let parent_ref = parent_id.clone();
    let name_clone = name.clone();
    let id_clone = id.clone();
    tokio::task::spawn_blocking(move || {
        db.create_folder(&id_clone, &name_clone, parent_ref.as_deref())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(id)
}

#[tauri::command]
pub async fn delete_asset(
    db: State<'_, Arc<Database>>,
    id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_asset(&id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn move_assets_to_folder(
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
    folder_id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.set_assets_folder(&asset_ids, &folder_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn create_smart_folder(
    db: State<'_, Arc<Database>>,
    name: String,
    smart_query: String,
) -> Result<String, AppError> {
    let id = Ulid::new().to_string();
    let db = db.inner().clone();
    let (id_clone, name_clone, q_clone) = (id.clone(), name, smart_query);
    tokio::task::spawn_blocking(move || db.create_smart_folder(&id_clone, &name_clone, &q_clone))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(id)
}

#[tauri::command]
pub async fn search_assets(
    db: State<'_, Arc<Database>>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<Asset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.search_assets(&query, limit.unwrap_or(500)))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_analyses_by_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Vec<Analysis>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_analyses_by_asset(&asset_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// 删除单条分析结果（如旧的 caption）。DB 方法已存在，此处仅 Tauri 命令包装。
#[tauri::command]
pub async fn delete_analysis(db: State<'_, Arc<Database>>, id: String) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_analysis(&id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

/// 创作板用：有 caption（反推）的资产 + 最新 caption 正文（§5.4）。
#[tauri::command]
pub async fn list_prompted_assets(
    db: State<'_, Arc<Database>>,
) -> Result<Vec<PromptedAsset>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_prompted_assets())
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
