use crate::core::local_classification::{data::Label, LocalClassifier, Status};
use crate::core::paths::LibraryPaths;
use crate::core::settings::SettingsState;
use crate::db::Database;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn folder_classification_view(classifier: State<'_, Arc<LocalClassifier>>, path: String) -> Result<crate::core::local_classification::folder::FolderView, String> {
    let local = classifier.folder_records_root();
    tokio::task::spawn_blocking(move || crate::core::local_classification::folder::view_with_storage(&path, Some(&local))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn folder_classification_images(classifier: State<'_, Arc<LocalClassifier>>, path: String, tag_id: String) -> Result<Vec<crate::core::external_files::FileEntry>, String> {
    let local = classifier.folder_records_root();
    tokio::task::spawn_blocking(move || crate::core::local_classification::folder::tagged_images_with_storage(&path, &tag_id, Some(&local))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn folder_classification_start(
    app: AppHandle, classifier: State<'_, Arc<LocalClassifier>>, paths: State<'_, Arc<LibraryPaths>>,
    settings: State<'_, SettingsState>, root: String, recursive: bool, pending_only: bool, tag_id: Option<String>,
) -> Result<(),String> {
    let settings=settings.get();
    let key=if settings.jev_image_classification_enabled { Some(settings.jev_api_key.unwrap_or_default()) } else { None };
    classifier.start_folder(app,paths.inner().clone(),root,recursive,pending_only,tag_id,key)
}

#[tauri::command]
pub async fn folder_classification_edit(
    classifier: State<'_, Arc<LocalClassifier>>, root: String, action: String,
    id: Option<String>, name: Option<String>, description: Option<String>, enabled: Option<bool>,
    ids: Option<Vec<String>>, positive: Option<bool>,
) -> Result<Option<String>,String> {
    // Share the classifier's task gate: metadata edits cannot race a running scan.
    classifier.edit_folder(root,action,id,name,description,enabled,ids,positive).await
}

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
    settings: State<'_, SettingsState>,
    install: bool,
    tag_id: Option<String>,
    pending_only: bool,
) -> Result<(), String> {
    let snapshot = settings.get();
    let jev_key = if snapshot.jev_image_classification_enabled {
        Some(snapshot.jev_api_key.unwrap_or_default())
    } else {
        None
    };
    classifier.inner().start(
        app,
        db.inner().clone(),
        paths.inner().clone(),
        install,
        tag_id,
        jev_key,
        pending_only,
    )
}

#[tauri::command]
pub async fn local_classification_vector_install(
    app: AppHandle,
    classifier: State<'_, Arc<LocalClassifier>>,
) -> Result<(), String> {
    classifier.inner().start_vector(app)
}

#[tauri::command]
pub async fn local_classification_vector_uninstall(
    classifier: State<'_, Arc<LocalClassifier>>,
) -> Result<(), String> {
    classifier.inner().uninstall_vector()
}

#[tauri::command]
pub async fn local_classification_stop(
    classifier: State<'_, Arc<LocalClassifier>>,
    db: State<'_, Arc<Database>>,
) -> Result<(), String> {
    if classifier.snapshot(&db)?.folder_root.is_none() {
        db.set_local_enabled(false).map_err(|e| e.to_string())?;
    }
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
pub async fn local_classification_delete_labels(
    app: AppHandle,
    classifier: State<'_, Arc<LocalClassifier>>,
    db: State<'_, Arc<Database>>,
    tag_ids: Vec<String>,
) -> Result<(), String> {
    classifier.delete_labels(&db, &tag_ids)?;
    let _ = app.emit("library://assets-changed", ());
    Ok(())
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
