use crate::{core::file_workspace::{FileWorkspace, FileWorkspaceConfig}, error::AppResult};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn file_workspace_save_records(db: State<'_, Arc<crate::db::Database>>, files: State<'_, Arc<FileWorkspace>>, root: String)
    -> AppResult<crate::core::creative_files::SavedDirectory> {
    let db = db.inner().clone(); let local = files.local_records_root();
    tauri::async_runtime::spawn_blocking(move || crate::core::creative_files::save_directory(&db,&local,&PathBuf::from(root)))
        .await.map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn file_workspace_restore_preview(db: State<'_, Arc<crate::db::Database>>, root: String, recursive: bool)
    -> AppResult<crate::core::creative_restore::Preview> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || crate::core::creative_restore::preview(&db, &PathBuf::from(root), recursive))
        .await.map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn file_workspace_restore(app: AppHandle, db: State<'_, Arc<crate::db::Database>>,
    paths: State<'_, Arc<crate::core::paths::LibraryPaths>>, root: String, recursive: bool, token: String)
    -> AppResult<crate::core::creative_restore::Restored> {
    let db = db.inner().clone(); let paths = paths.inner().clone();
    // Scope validation happens before committing changes so a display grant failure cannot look like a failed restore.
    app.asset_protocol_scope().allow_directory(&root, true).map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    let result = tauri::async_runtime::spawn_blocking(move || crate::core::creative_restore::restore(&db, &paths, &PathBuf::from(root), recursive, &token))
        .await.map_err(|e| crate::error::AppError::Other(e.to_string()))??;
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
    Ok(result)
}

#[derive(serde::Serialize)]
pub struct WorkspaceStatus {
    pub config: FileWorkspaceConfig,
    pub proposed_root: PathBuf,
    pub migration: Option<crate::core::file_workspace_move::MoveStatus>,
}

#[tauri::command]
pub fn file_workspace_status(files: State<'_, Arc<FileWorkspace>>) -> AppResult<WorkspaceStatus> {
    Ok(WorkspaceStatus { config: files.snapshot(), proposed_root: files.proposed_root(), migration: crate::core::file_workspace_move::status(&files)? })
}

#[tauri::command]
pub async fn file_workspace_move_preview(files: State<'_, Arc<FileWorkspace>>, paths: State<'_, Arc<crate::core::paths::LibraryPaths>>, parent: String) -> AppResult<crate::core::file_workspace_move::Preview> {
    let files=files.inner().clone();let paths=paths.inner().clone();
    tauri::async_runtime::spawn_blocking(move || crate::core::file_workspace_move::preview(&files,&PathBuf::from(parent),&paths.root)).await.map_err(|e|crate::error::AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn file_workspace_move_schedule(files: State<'_, Arc<FileWorkspace>>, paths: State<'_, Arc<crate::core::paths::LibraryPaths>>, db: State<'_, Arc<crate::db::Database>>, classifier: State<'_, Arc<crate::core::local_classification::LocalClassifier>>, parent: String, token: String) -> AppResult<()> {
    if classifier.snapshot(&db).map_err(crate::error::AppError::Other)?.busy {return Err(crate::error::AppError::Other("请先停止自动分类，再迁移资料目录".into()));}
    let files=files.inner().clone();let paths=paths.inner().clone();let db=db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || crate::core::file_workspace_move::schedule(&files,&db,&PathBuf::from(parent),&paths.root,&token)).await.map_err(|e|crate::error::AppError::Other(e.to_string()))?
}
#[tauri::command]
pub fn file_workspace_move_cancel(files: State<'_, Arc<FileWorkspace>>) -> AppResult<()> { crate::core::file_workspace_move::cancel(&files) }

#[tauri::command]
pub async fn file_workspace_history_preview(files: State<'_, Arc<FileWorkspace>>, paths: State<'_, Arc<crate::core::paths::LibraryPaths>>, db: State<'_, Arc<crate::db::Database>>) -> AppResult<crate::core::file_workspace_move::history::HistoryPreview> {
    let files=files.inner().clone();let paths=paths.inner().clone();let db=db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || crate::core::file_workspace_move::history::preview(&files,&db,&paths.images)).await.map_err(|e|crate::error::AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn file_workspace_history_schedule(files: State<'_, Arc<FileWorkspace>>, paths: State<'_, Arc<crate::core::paths::LibraryPaths>>, db: State<'_, Arc<crate::db::Database>>, classifier: State<'_, Arc<crate::core::local_classification::LocalClassifier>>, token: String) -> AppResult<()> {
    if classifier.snapshot(&db).map_err(crate::error::AppError::Other)?.busy {return Err(crate::error::AppError::Other("请先停止自动分类，再迁移历史素材".into()));}
    let files=files.inner().clone();let paths=paths.inner().clone();let db=db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || crate::core::file_workspace_move::history::schedule(&files,&db,&paths.images,&token)).await.map_err(|e|crate::error::AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn file_workspace_prepare(app: AppHandle, files: State<'_, Arc<FileWorkspace>>,
    root: Option<String>, project_id: Option<String>, name: Option<String>) -> AppResult<PathBuf> {
    let runtime = files.inner().clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        if let Some(root) = root { runtime.configure(&PathBuf::from(root))?; }
        match project_id {
            Some(id) => runtime.project_directory(&id, name.as_deref().unwrap_or("未命名项目")),
            None => runtime.ensure_root(),
        }
    }).await.map_err(|e| crate::error::AppError::Other(e.to_string()))??;
    app.asset_protocol_scope().allow_directory(&path, true)
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    app.asset_protocol_scope().allow_directory(files.proposed_root(), true)
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    Ok(path)
}

#[tauri::command]
pub async fn file_workspace_place(files: State<'_, Arc<FileWorkspace>>, path: String, added: bool) -> AppResult<FileWorkspaceConfig> {
    let files = files.inner().clone();
    tauri::async_runtime::spawn_blocking(move || files.set_place(&PathBuf::from(path), added))
        .await.map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

#[derive(serde::Serialize)]
pub struct AllFiles {
    pub entries: Vec<crate::core::external_files::FileEntry>,
    pub unavailable: Vec<String>,
}
#[tauri::command]
pub async fn file_workspace_all(files: State<'_, Arc<FileWorkspace>>) -> AppResult<AllFiles> {
    let config = files.snapshot();
    tauri::async_runtime::spawn_blocking(move || collect_files(config))
        .await.map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

fn collect_files(config: FileWorkspaceConfig) -> AppResult<AllFiles> {
        let mut roots = config.places;
        if let Some(root) = config.root { roots.push(root); }
        roots.extend(config.projects.into_values());
        let mut result = AllFiles { entries: vec![], unavailable: vec![] };
        let mut seen = std::collections::HashSet::new();
        while let Some(directory) = roots.pop() {
            let canonical = match std::fs::canonicalize(&directory) {
                Ok(path) => path,
                Err(error) => { result.unavailable.push(format!("{}：{error}", directory.display())); continue; }
            };
            if !seen.insert(canonical.clone()) { continue; }
            let entries = match std::fs::read_dir(&canonical) {
                Ok(entries) => entries,
                Err(error) => { result.unavailable.push(format!("{}：{error}", canonical.display())); continue; }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => { result.unavailable.push(format!("{}：{error}", canonical.display())); continue; }
                };
                if entry.file_name().to_string_lossy().starts_with('.') { continue; }
                let kind = entry.file_type()?;
                if kind.is_symlink() { continue; }
                let path = entry.path();
                if kind.is_dir() { roots.push(path); }
                else if kind.is_file() && (crate::core::external_files::image_path(&path) || crate::core::external_files::video_path(&path)) {
                    result.entries.push(crate::core::external_files::FileEntry {
                        path: path.to_string_lossy().into_owned(), name: entry.file_name().to_string_lossy().into_owned(), directory: false,
                    });
                }
            }
        }
        result.entries.sort_by(|a,b| a.path.cmp(&b.path));
        Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locations_include_nested_media_once_and_retain_offline_entries() {
        let root = std::env::temp_dir().join(format!("bb-places-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub/.bowerbird")).unwrap();
        for path in ["photo.png", "sub/video.mp4", "sub/.bowerbird/hidden.png", "sub/readme.txt"] {
            std::fs::write(root.join(path), b"fixture").unwrap();
        }
        let config = FileWorkspaceConfig { root: Some(root.clone()), places: vec![root.join("sub"), root.join("offline")], ..Default::default() };
        let result = collect_files(config).unwrap();
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.unavailable.len(), 1);
        assert!(root.join("photo.png").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
