//! 项目 workspace 相关命令。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

use crate::core::ingest;
use crate::core::paths::LibraryPaths;
use crate::core::projects::{
    ActiveProjectContext, Project, ProjectCreateResult, ProjectDeleteMode, ProjectDeleteResult,
};
use crate::db::Database;
use crate::error::{AppError, AppResult};

fn workspace_identity(path: &str) -> AppResult<(PathBuf, String, String)> {
    let canonical = std::fs::canonicalize(path)?;
    if !canonical.is_dir() {
        return Err(AppError::Other("workspace 必须是文件夹".into()));
    }
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::Other("无法从所选文件夹取得项目名".into()))?
        .to_string();
    let display = canonical.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    let key = display.to_lowercase();
    #[cfg(not(target_os = "windows"))]
    let key = display.clone();
    Ok((canonical, name, key))
}

#[tauri::command]
pub async fn create_project(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    active: State<'_, ActiveProjectContext>,
    workspace_path: String,
) -> Result<ProjectCreateResult, AppError> {
    let (workspace, name, workspace_key) = workspace_identity(&workspace_path)?;
    let display = workspace.to_string_lossy().into_owned();
    let project_id = Ulid::new().to_string();
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    let db_for_import = db.clone();
    let id_for_import = project_id.clone();
    let assets = tokio::task::spawn_blocking(move || -> Result<Vec<_>, AppError> {
        db_for_import.create_project(&id_for_import, &name, &display, &workspace_key, "user")?;
        match ingest::ingest_dir(&paths, &db_for_import, &workspace) {
            Ok(assets) => {
                let mut unique = std::collections::HashMap::new();
                for asset in assets {
                    unique.entry(asset.id.clone()).or_insert(asset);
                }
                let assets: Vec<_> = unique.into_values().collect();
                let ids: Vec<String> = assets.iter().map(|asset| asset.id.clone()).collect();
                db_for_import.add_assets_to_project(&id_for_import, &ids)?;
                Ok(assets)
            }
            Err(error) => {
                let _ = db_for_import.delete_project(&id_for_import, ProjectDeleteMode::Keep);
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;

    for asset in &assets {
        crate::core::autoname::spawn_auto_analyze(app.clone(), db.clone(), asset.clone());
    }
    active.set(Some(project_id.clone()));
    let project = db
        .get_project(&project_id)?
        .ok_or_else(|| AppError::NotFound(format!("project {project_id}")))?;
    let _ = app.emit("projects://changed", ());
    let _ = app.emit("library://assets-changed", ());
    Ok(ProjectCreateResult {
        project,
        imported_count: assets.len(),
        member_count: assets.len(),
    })
}

#[tauri::command]
pub async fn list_projects(db: State<'_, Arc<Database>>) -> Result<Vec<Project>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.list_projects())
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn set_active_project(
    db: State<'_, Arc<Database>>,
    active: State<'_, ActiveProjectContext>,
    project_id: Option<String>,
) -> Result<(), AppError> {
    if let Some(id) = &project_id {
        if db.get_project(id)?.is_none() {
            return Err(AppError::NotFound(format!("project {id}")));
        }
    }
    active.set(project_id);
    Ok(())
}

#[tauri::command]
pub async fn add_assets_to_project(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    project_id: String,
    asset_ids: Vec<String>,
) -> Result<usize, AppError> {
    let db = db.inner().clone();
    let added =
        tokio::task::spawn_blocking(move || db.add_assets_to_project(&project_id, &asset_ids))
            .await
            .map_err(|error| AppError::Other(error.to_string()))??;
    let _ = app.emit("projects://changed", ());
    let _ = app.emit("library://assets-changed", ());
    Ok(added)
}

#[tauri::command]
pub async fn remove_assets_from_project(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    project_id: String,
    asset_ids: Vec<String>,
) -> Result<usize, AppError> {
    let db = db.inner().clone();
    let removed =
        tokio::task::spawn_blocking(move || db.remove_assets_from_project(&project_id, &asset_ids))
            .await
            .map_err(|error| AppError::Other(error.to_string()))??;
    let _ = app.emit("projects://changed", ());
    let _ = app.emit("library://assets-changed", ());
    Ok(removed)
}

#[tauri::command]
pub async fn delete_project(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    active: State<'_, ActiveProjectContext>,
    project_id: String,
    mode: String,
) -> Result<ProjectDeleteResult, AppError> {
    let mode = match mode.as_str() {
        "keep" => ProjectDeleteMode::Keep,
        "move_out" => ProjectDeleteMode::MoveOut,
        "delete_exclusive" => ProjectDeleteMode::DeleteExclusive,
        other => return Err(AppError::Other(format!("未知删除模式: {other}"))),
    };
    let db = db.inner().clone();
    let id_for_delete = project_id.clone();
    let result = tokio::task::spawn_blocking(move || db.delete_project(&id_for_delete, mode))
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
    if active.get().as_deref() == Some(project_id.as_str()) {
        active.set(None);
    }
    let _ = app.emit("projects://changed", ());
    let _ = app.emit("library://assets-changed", ());
    Ok(result)
}
