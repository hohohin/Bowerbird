use crate::core::local_classification::{data::Label, LocalClassifier, Status};
use crate::core::paths::LibraryPaths;
use crate::core::settings::SettingsState;
use crate::db::Database;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTextTagStatus {
    has_transcript: bool,
    has_description: bool,
    available: bool,
    credits: Option<u32>,
}

#[tauri::command]
pub async fn video_text_tags_status(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<VideoTextTagStatus, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || video_text_status(&db, &asset_id))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn video_text_status(db: &Database, asset_id: &str) -> crate::error::AppResult<VideoTextTagStatus> {
    use super::video_asset_revision::{source, FileStamp, SourceUsage};
    let mut status = VideoTextTagStatus::default();
    let Ok(path) = source(db, asset_id, SourceUsage::VideoAnalysis) else { return Ok(status) };
    let Ok(stamp) = FileStamp::read(&path) else { return Ok(status) };
    if !db.connected_source_matches(asset_id, &path)? {
        return Ok(status);
    }
    let conn = db.conn.lock().unwrap();
    let mut statement = conn.prepare(
        "SELECT kind, json_extract(payload, '$.stamp') FROM analyses WHERE asset_id=?1
         AND kind IN ('video_transcript', 'video_analysis') AND json_valid(payload)
         AND json_extract(payload, '$.current')=1 AND json_extract(payload, '$.status')='completed'
         AND json_type(payload, '$.stamp')='object' AND json_type(payload, '$.text')='text'
         AND trim(json_extract(payload, '$.text'), ' ' || char(9,10,11,12,13,160,12288)) != ''",
    )?;
    let mut rows = statement.query([asset_id])?;
    while let Some(row) = rows.next()? {
        let kind: String = row.get(0)?;
        let saved_stamp: Option<String> = row.get(1)?;
        if saved_stamp.as_deref().and_then(|saved| serde_json::from_str::<FileStamp>(saved).ok()).as_ref() == Some(&stamp) {
            status.has_transcript |= kind == "video_transcript";
            status.has_description |= kind == "video_analysis";
        }
    }
    if FileStamp::read(&path).ok().as_ref() != Some(&stamp) {
        return Ok(VideoTextTagStatus::default());
    }
    // No provider has verified production pure-text usage, and the independent
    // Bcoin service is not activated. This command only inspects the local record.
    Ok(status)
}

#[tauri::command]
pub async fn video_text_tags_start(
    asset_id: String,
    expected_credits: u32,
) -> Result<(), String> {
    let _ = (asset_id, expected_credits);
    Err("视频文本打标签服务暂未开放".into())
}

#[cfg(test)]
mod video_text_tags_tests {
    use super::*;
    use crate::commands::video_asset_revision::FileStamp;
    use serde_json::json;

    #[test]
    fn current_transcript_and_description_are_independent_and_service_stays_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("video.mp4");
        std::fs::write(&path, b"original").unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let stamp = FileStamp::read(&path).unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,ext,store_path,created_at) VALUES ('video','素材','mp4',?1,1)",
            [path.to_str().unwrap()],
        ).unwrap();

        let save = |kind: &str, value: &str| {
            db.conn.lock().unwrap().execute(
                "INSERT OR REPLACE INTO analyses(id,asset_id,kind,payload,created_at) VALUES (?1,'video',?1,?2,1)",
                (kind, json!({ "status": "completed", "current": true, "stamp": stamp, "text": value }).to_string()),
            ).unwrap();
        };
        let check = |transcript, description| {
            let status = video_text_status(&db, "video").unwrap();
            assert_eq!((status.has_transcript, status.has_description), (transcript, description));
            assert!(!status.available);
            assert!(status.credits.is_none());
        };
        check(false, false);
        save("video_transcript", "口播");
        check(true, false);
        save("video_analysis", "挥拍");
        check(true, true);
        save("video_transcript", "  \t\n");
        check(false, true);
        std::fs::write(&path, b"replaced original").unwrap();
        check(false, false);
    }
}

#[tauri::command]
pub async fn global_classification_view(db: State<'_, Arc<Database>>, paths: Vec<String>) -> Result<crate::core::local_classification::global::View, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || crate::core::local_classification::global::view(&db, &paths)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn global_classification_start(app: AppHandle, classifier: State<'_, Arc<LocalClassifier>>,
    db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, files: State<'_, Arc<crate::core::file_workspace::FileWorkspace>>,
    pending_only: bool, tag_id: Option<String>, ensure_cloud: Option<bool>) -> Result<(), String> {
    let use_jev = manual_classification_use_jev(&app, ensure_cloud).await?;
    classifier.start_global(app, db.inner().clone(), paths.inner().clone(), files.snapshot(), tag_id, use_jev, pending_only)
}

#[tauri::command]
pub async fn project_classification_labels(db: State<'_, Arc<Database>>, project_id: String) -> Result<Vec<Label>, String> {
    crate::core::local_classification::global::project_labels(&db, &project_id)
}

#[tauri::command]
pub async fn project_classification_start(app: AppHandle, classifier: State<'_, Arc<LocalClassifier>>,
    db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>,
    project_id: String, pending_only: bool, tag_id: Option<String>, ensure_cloud: Option<bool>) -> Result<(), String> {
    let use_jev = manual_classification_use_jev(&app, ensure_cloud).await?;
    classifier.start_project(app, db.inner().clone(), paths.inner().clone(), project_id, tag_id, use_jev, pending_only)
}

#[tauri::command]
pub async fn folder_classification_view(classifier: State<'_, Arc<LocalClassifier>>, path: String) -> Result<crate::core::local_classification::folder::FolderView, String> {
    let local = classifier.folder_records_root();
    tokio::task::spawn_blocking(move || crate::core::local_classification::folder::view_with_storage(&path, Some(&local))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn folder_classification_images(classifier: State<'_, Arc<LocalClassifier>>, paths: State<'_, Arc<LibraryPaths>>, path: String, tag_id: String) -> Result<Vec<crate::core::external_files::FileEntry>, String> {
    let local = classifier.folder_records_root();
    let paths = paths.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut entries = crate::core::local_classification::folder::tagged_images_with_storage(&path, &tag_id, Some(&local))?;
        crate::core::external_files::attach_previews(&paths, &mut entries);
        Ok(entries)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn folder_classification_start(
    app: AppHandle, classifier: State<'_, Arc<LocalClassifier>>, paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    root: String, recursive: bool, pending_only: bool, tag_id: Option<String>, ensure_cloud: Option<bool>,
) -> Result<(),String> {
    let use_jev = manual_classification_use_jev(&app, ensure_cloud).await?;
    classifier.start_folder(app,paths.inner().clone(),db.local_labels().map_err(|e| e.to_string())?,root,recursive,pending_only,tag_id,use_jev)
}

/// Resolve creation evidence on demand; membership is never used as provenance.
#[tauri::command]
pub async fn local_classification_source(
    classifier: State<'_, Arc<LocalClassifier>>, db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>, tag_id: String, root: Option<String>,
) -> Result<Option<String>, String> {
    let local = classifier.folder_records_root();
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    tokio::task::spawn_blocking(move || {
        if let Some(root) = root {
            crate::core::local_classification::folder::source_preview(&root, Some(&local), &paths, &tag_id)
        } else {
            db.local_label_source(&tag_id).map_err(|e| e.to_string())
        }
    }).await.map_err(|e| e.to_string())?
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
    install: bool,
    tag_id: Option<String>,
    pending_only: bool,
    ensure_cloud: Option<bool>,
) -> Result<(), String> {
    let use_jev = !install && manual_classification_use_jev(&app, ensure_cloud).await?;
    classifier.inner().start(
        app,
        db.inner().clone(),
        paths.inner().clone(),
        install,
        tag_id,
        use_jev,
        pending_only,
    )
}

async fn manual_classification_use_jev<R: tauri::Runtime>(
    app: &AppHandle<R>,
    ensure_cloud: Option<bool>,
) -> Result<bool, String> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let settings = app.state::<SettingsState>();
        if ensure_cloud == Some(true) {
            settings.enable_jev_image_classification(|| Ok(()))?;
            return Ok(true);
        }
        Ok(settings.get().jev_image_classification_enabled)
    })
    .await
    .map_err(|error| format!("CLASSIFICATION_START_SETTINGS: {error}"))?
    .map_err(|error: crate::error::AppError| format!("CLASSIFICATION_START_SETTINGS: {error}"))
}

#[cfg(test)]
mod manual_classification_tests;

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
    let status = classifier.snapshot(&db)?;
    if status.folder_root.is_none() {
        db.stop_local_auto_pending(status.project_id.as_deref()).map_err(|e| e.to_string())?;
    }
    classifier.cancel();
    Ok(())
}

#[tauri::command]
pub async fn local_classification_enable<R: tauri::Runtime>(
    app: AppHandle<R>,
    db: State<'_, Arc<Database>>,
    enabled: bool,
) -> Result<bool, String> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || {
        let settings = app.state::<SettingsState>();
        db.set_local_enabled_with_cloud(&settings, enabled)
            .map(|()| enabled)
            .map_err(classification_auto_error)
    })
    .await
    .map_err(|error| format!("CLASSIFICATION_AUTO_WORKER: {error}"))?
}

fn classification_auto_error(error: crate::error::AppError) -> String {
    use crate::error::AppError;
    let step = match &error {
        AppError::Io(_) => "SETTINGS",
        AppError::Db(_) => "DATABASE",
        _ => "WORKER",
    };
    format!("CLASSIFICATION_AUTO_{step}: {error}")
}

#[cfg(test)]
mod auto_classification_tests;

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
    project_id: Option<String>,
    assigned_only: Option<bool>,
) -> Result<(), String> {
    let db = Arc::clone(db.inner());
    let changed_assets = tokio::task::spawn_blocking(move || {
        if let Some(project) = project_id {
            let scope = crate::core::local_classification::global::project_ids(&db, &project)?;
            if asset_ids.iter().any(|id| !scope.contains(id)) {
                return Err("所选素材不属于当前项目".into());
            }
        }
        db.local_example_with_options(&tag_id, &asset_ids, positive, assigned_only.unwrap_or(false))
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(asset_ids)
    }).await.map_err(|e| e.to_string())??;
    let _ = app.emit("library://assets-changed", serde_json::json!({ "assetTagIds": changed_assets }));
    Ok(())
}
