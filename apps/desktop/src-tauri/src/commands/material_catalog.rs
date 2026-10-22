use crate::core::catalog_browser::{CatalogColorBatch, CatalogFilter, CatalogOverview};
use crate::{
    core::{library::Asset, material_catalog::MaterialCatalog},
    db::Database,
    error::AppResult,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn catalog_prepare_colors(
    db: State<'_, Arc<Database>>,
    filter: CatalogFilter,
    after: Option<String>,
) -> AppResult<CatalogColorBatch> {
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let permit = GATE
        .acquire()
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    let db = db.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.catalog_prepare_colors(&filter, after.as_deref())
    })
    .await
    .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    drop(permit);
    result
}

#[tauri::command]
pub async fn catalog_overview(
    db: State<'_, Arc<Database>>,
    filter: CatalogFilter,
    context_project: Option<String>,
) -> AppResult<CatalogOverview> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.catalog_overview(&filter, context_project.as_deref())
    })
    .await
    .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn catalog_page(
    db: State<'_, Arc<Database>>,
    filter: CatalogFilter,
    offset: i64,
    limit: i64,
) -> AppResult<Vec<Asset>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.catalog_page(&filter, offset, limit))
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn catalog_ids(
    db: State<'_, Arc<Database>>,
    filter: CatalogFilter,
    offset: i64,
    limit: i64,
) -> AppResult<Vec<String>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.catalog_ids(&filter, offset, limit))
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn material_catalog(
    db: State<'_, Arc<Database>>,
    project_id: Option<String>,
) -> AppResult<MaterialCatalog> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.material_catalog(project_id.as_deref()))
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn material_catalog_assets(
    db: State<'_, Arc<Database>>,
    kind: String,
    id: Option<String>,
    project_id: Option<String>,
) -> AppResult<Vec<Asset>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.material_catalog_assets(&kind, id.as_deref(), project_id.as_deref())
    })
    .await
    .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn save_collection_node(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: Option<String>,
    name: String,
    parent_id: Option<String>,
) -> AppResult<String> {
    let db = db.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.save_collection_node(id.as_deref(), &name, parent_id.as_deref())
    })
    .await
    .map_err(|e| crate::error::AppError::Other(e.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(result)
}
#[tauri::command]
pub async fn delete_collection_node(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.delete_collection_node(&id))
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(())
}
#[tauri::command]
pub async fn set_collection_members(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
    asset_ids: Vec<String>,
    added: bool,
) -> AppResult<()> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.set_collection_members(&id, &asset_ids, added))
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    Ok(())
}
