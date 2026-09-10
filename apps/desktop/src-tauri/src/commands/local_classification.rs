use crate::core::local_classification::{data::Label, LocalClassifier, Status};
use crate::core::paths::LibraryPaths;
use crate::db::Database;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn local_classification_status(
    classifier: State<'_, Arc<LocalClassifier>>,
    db: State<'_, Arc<Database>>,
) -> Result<Status, String> {
    classifier.snapshot(&db)
}

#[tauri::command]
pub async fn local_classification_start(
    app: AppHandle,
    classifier: State<'_, Arc<LocalClassifier>>,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    install: bool,
    tag_id: Option<String>,
    pending_only: bool,
) -> Result<(), String> {
    classifier.inner().start(
        app,
        db.inner().clone(),
        paths.inner().clone(),
        install,
        tag_id,
        pending_only,
    )
}

#[tauri::command]
pub async fn local_classification_stop(
    classifier: State<'_, Arc<LocalClassifier>>,
    db: State<'_, Arc<Database>>,
) -> Result<(), String> {
    db.set_local_enabled(false).map_err(|e| e.to_string())?;
    classifier.cancel();
    Ok(())
}

#[tauri::command]
pub async fn local_classification_enable(
    db: State<'_, Arc<Database>>,
    enabled: bool,
) -> Result<(), String> {
    db.set_local_enabled(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_classification_labels(
    db: State<'_, Arc<Database>>,
) -> Result<Vec<Label>, String> {
    db.local_labels().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_classification_save_label(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: Option<String>,
    name: String,
    description: String,
    enabled: bool,
) -> Result<String, String> {
    let result = db
        .save_local_label(id.as_deref(), &name, &description, enabled)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("library://assets-changed", ());
    Ok(result)
}

#[tauri::command]
pub async fn local_classification_example(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    tag_id: String,
    asset_ids: Vec<String>,
    positive: bool,
) -> Result<(), String> {
    db.local_example(&tag_id, &asset_ids, positive)
        .map_err(|e| e.to_string())?;
    let _ = app.emit("library://assets-changed", ());
    Ok(())
}
