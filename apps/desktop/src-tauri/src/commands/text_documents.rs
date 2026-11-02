use crate::{
    core::{
        paths::LibraryPaths,
        text_documents::{self, TextDocument},
    },
    db::Database,
    error::AppError,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn read_text_document(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<TextDocument, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || text_documents::read(&db, &asset_id))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn save_text_document(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    expected_version: String,
    text: String,
) -> Result<TextDocument, AppError> {
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        text_documents::save(&paths, &db, &asset_id, &expected_version, &text)
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
    Ok(result)
}
