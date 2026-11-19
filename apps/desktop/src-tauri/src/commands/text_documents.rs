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
pub async fn create_text_document(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    input: text_documents::CreateTextDocument,
) -> Result<text_documents::CreatedTextDocument, AppError> {
    let db = db.inner().clone(); let paths = paths.inner().clone();
    let result = super::folder_connections::mutation(app.clone(), move || text_documents::create(&paths, &db, &input)).await;
    let _ = app.emit("projects://changed", ());
    result
}

#[tauri::command]
pub async fn read_text_document(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    preview_only: Option<bool>,
) -> Result<TextDocument, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || text_documents::read_with_options(&db, &asset_id, preview_only.unwrap_or(false)))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn read_spreadsheet_document(db: State<'_, Arc<Database>>, asset_id: String) -> Result<text_documents::office::SpreadsheetDocument, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || text_documents::office::read_spreadsheet(&db, &asset_id)).await.map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn save_docx_document(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, db: State<'_, Arc<Database>>, asset_id: String, expected_version: String, data: String) -> Result<TextDocument, AppError> {
    let db = db.inner().clone(); let paths = paths.inner().clone();
    let result = tokio::task::spawn_blocking(move || text_documents::office::save_docx(&paths, &db, &asset_id, &expected_version, &data)).await.map_err(|error| AppError::Other(error.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
    Ok(result)
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
