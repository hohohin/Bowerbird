//! 提示词 / 创作包相关命令。

use std::sync::Arc;

use tauri::State;
use ulid::Ulid;

use crate::core::library::AssetPrompt;
use crate::db::Database;
use crate::error::AppError;
use crate::prompt::CreationPack;

#[tauri::command]
pub async fn create_prompt(
    db: State<'_, Arc<Database>>,
    title: Option<String>,
    body: String,
    kind: Option<String>,
) -> Result<String, AppError> {
    let id = Ulid::new().to_string();
    let db = db.inner().clone();
    let (idc, tc, kc) = (id.clone(), title, kind);
    tokio::task::spawn_blocking(move || {
        db.create_prompt(&idc, tc.as_deref(), &body, kc.as_deref(), None)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(id)
}

#[tauri::command]
pub async fn update_prompt(
    db: State<'_, Arc<Database>>,
    id: String,
    title: Option<String>,
    body: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.update_prompt(&id, title.as_deref(), &body))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn delete_prompt(db: State<'_, Arc<Database>>, id: String) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_prompt(&id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn link_prompt(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    prompt_id: String,
    role: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.link_prompt(&asset_id, &prompt_id, &role))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn unlink_prompt(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    prompt_id: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.unlink_prompt(&asset_id, &prompt_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn list_prompts_by_asset(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Vec<AssetPrompt>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_prompts_by_asset(&asset_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn assemble_pack(
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
) -> Result<CreationPack, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || crate::prompt::assemble_pack(&db, &asset_ids))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
