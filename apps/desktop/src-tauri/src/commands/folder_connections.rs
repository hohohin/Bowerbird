use crate::{
    core::{
        folder_connections::{AssetOriginal, ConnectionEntry, FolderConnection},
        paths::LibraryPaths,
    },
    db::Database,
    error::{AppError, AppResult},
};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, State};

// Serialize walks and physical mutations so a refresh cannot reconcile a half-finished move.
static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
#[path = "connection_watch.rs"]
mod watcher;
pub use watcher::watch;

#[derive(Default)]
struct RefreshQueue {
    running: bool,
    all: bool,
    roots: HashSet<String>,
    priority: Option<String>,
}
static REFRESH: std::sync::LazyLock<Mutex<RefreshQueue>> =
    std::sync::LazyLock::new(|| Mutex::new(RefreshQueue::default()));
fn changed(app: &AppHandle) {
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
}
pub(super) async fn mutation<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let _permit = GATE
        .acquire()
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let value = tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;
    changed(&app);
    value
}
fn refresh(app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>, folder: Option<String>) {
    queue_refresh(app, db, paths, None, folder);
}
fn queue_refresh(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    roots: Option<HashSet<String>>,
    priority: Option<String>,
) {
    let mut queue = REFRESH.lock().unwrap();
    if let Some(roots) = roots {
        queue.roots.extend(roots);
    } else {
        queue.all = true;
    }
    if priority.is_some() {
        queue.priority = priority;
    }
    if queue.running {
        return;
    }
    queue.running = true;
    drop(queue);
    tauri::async_runtime::spawn(async move {
        loop {
            // Multiple panes/focus events and bursts of writes share one background walk.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let (all, requested, priority) = {
                let mut queue = REFRESH.lock().unwrap();
                (
                    std::mem::take(&mut queue.all),
                    std::mem::take(&mut queue.roots),
                    queue.priority.clone(),
                )
            };
            if let Ok(_permit) = GATE.acquire().await {
                let (app2, db2, paths2) = (app.clone(), db.clone(), paths.clone());
                let result = tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
                    let priority_root = priority
                        .as_deref()
                        .and_then(|id| db2.connected_folder(id).ok())
                        .map(|f| f.root_id);
                    let mut ids = db2.connected_root_ids()?;
                    if !all {
                        ids.retain(|id| requested.contains(id));
                    }
                    ids.sort_by_key(|id| Some(id) != priority_root.as_ref());
                    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
                    for id in ids {
                        let value = db2.scan_connection_prioritized(
                            &paths2,
                            &id,
                            priority.as_deref(),
                            || {
                                if last.elapsed() >= std::time::Duration::from_millis(500) {
                                    changed(&app2);
                                    last = std::time::Instant::now();
                                }
                            },
                        );
                        if let Err(error) = value {
                            tracing::warn!("connection scan {id}: {error}");
                        }
                    }
                    Ok(())
                })
                .await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => tracing::warn!("connection refresh: {error}"),
                    Err(error) => tracing::warn!("connection refresh worker: {error}"),
                }
                changed(&app);
            }
            let mut queue = REFRESH.lock().unwrap();
            if queue.all || !queue.roots.is_empty() {
                continue;
            }
            queue.running = false;
            break;
        }
    });
}
#[tauri::command]
pub async fn folder_connections(
    db: State<'_, Arc<Database>>,
    project_id: Option<String>,
    media: Option<String>,
) -> AppResult<Vec<FolderConnection>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.connection_folders(project_id.as_deref(), media.as_deref())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn connect_folder(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    path: String,
    project_id: Option<String>,
) -> AppResult<String> {
    let database = db.inner().clone();
    let source = PathBuf::from(path);
    let id = mutation(app.clone(), move || {
        database.connect_directory(&source, project_id.as_deref())
    })
    .await?;
    refresh(
        app,
        db.inner().clone(),
        paths.inner().clone(),
        Some(id.clone()),
    );
    Ok(id)
}
#[tauri::command]
pub async fn refresh_folder_connections(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    folder_id: Option<String>,
) -> AppResult<()> {
    refresh(app, db.inner().clone(), paths.inner().clone(), folder_id);
    Ok(())
}
fn allow_entries(app: &AppHandle, entries: &[ConnectionEntry]) -> AppResult<()> {
    for entry in entries {
        for path in [&entry.asset.store_path, &entry.asset.thumb_path]
            .into_iter()
            .flatten()
        {
            app.asset_protocol_scope()
                .allow_file(path)
                .map_err(|e| AppError::Other(e.to_string()))?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn connection_entries(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    folder_id: String,
    offset: i64,
    limit: i64,
    media: Option<String>,
    project_id: Option<String>,
) -> AppResult<Vec<ConnectionEntry>> {
    let db = db.inner().clone();
    let values = tauri::async_runtime::spawn_blocking(move || {
        let ids = db.connection_entry_ids(
            Some(&folder_id),
            project_id.as_deref(),
            media.as_deref(),
            offset,
            limit.min(240),
        )?;
        db.resolve_connection_entries(&ids)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    allow_entries(&app, &values)?;
    Ok(values)
}
#[tauri::command]
pub async fn connection_entry_ids(
    db: State<'_, Arc<Database>>,
    folder_id: Option<String>,
    media: Option<String>,
    project_id: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
) -> AppResult<Vec<String>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.connection_entry_ids(
            folder_id.as_deref(),
            project_id.as_deref(),
            media.as_deref(),
            offset.unwrap_or(0),
            limit.unwrap_or(2000),
        )
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn resolve_connection_entries(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    ids: Vec<String>,
) -> AppResult<Vec<ConnectionEntry>> {
    let db = db.inner().clone();
    let values = tauri::async_runtime::spawn_blocking(move || db.resolve_connection_entries(&ids))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    allow_entries(&app, &values)?;
    Ok(values)
}
#[tauri::command]
pub async fn create_connected_collection(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    parent_id: Option<String>,
    name: String,
    path: Option<String>,
    project_id: Option<String>,
) -> AppResult<String> {
    let db = db.inner().clone();
    mutation(app, move || {
        db.create_connected_directory(
            parent_id.as_deref(),
            path.as_deref().map(std::path::Path::new),
            &name,
            project_id.as_deref(),
        )
    })
    .await
}
#[tauri::command]
pub async fn rename_connected_collection(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
    name: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    mutation(app, move || db.rename_connected_directory(&id, &name)).await
}
#[tauri::command]
pub async fn move_connected_collection(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
    target_id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    mutation(app, move || db.move_connected_directory(&id, &target_id)).await
}
#[tauri::command]
pub async fn disconnect_folder(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    mutation(app, move || db.disconnect_directory(&id)).await
}
#[tauri::command]
pub async fn relocate_folder(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    id: String,
    path: String,
) -> AppResult<()> {
    let database = db.inner().clone();
    let scan_id = id.clone();
    mutation(app.clone(), move || {
        database.relocate_connected_directory(&id, &PathBuf::from(path))
    })
    .await?;
    refresh(
        app,
        db.inner().clone(),
        paths.inner().clone(),
        Some(scan_id),
    );
    Ok(())
}
#[tauri::command]
pub async fn trash_connected_collection(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    mutation(app, move || db.trash_connected_directory(&id)).await
}
#[tauri::command]
pub async fn create_material_references(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    asset_ids: Vec<String>,
    folder_id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    mutation(app, move || {
        db.create_material_references(&paths, &asset_ids, &folder_id)
    })
    .await
}
#[tauri::command]
pub async fn rename_connection_entry(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    id: String,
    name: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    mutation(app, move || db.rename_connection_entry(&id, &name)).await
}
#[tauri::command]
pub async fn move_connection_entries(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    ids: Vec<String>,
    folder_id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    mutation(app, move || db.move_connection_entries(&ids, &folder_id)).await
}
#[tauri::command]
pub async fn trash_connection_entries(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    ids: Vec<String>,
) -> AppResult<()> {
    let db = db.inner().clone();
    mutation(app, move || db.trash_connection_entries(&ids)).await
}

#[tauri::command]
pub async fn preview_asset_originals(
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
) -> AppResult<Vec<AssetOriginal>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.preview_asset_originals(&asset_ids))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn trash_asset_original(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    original: AssetOriginal,
) -> AppResult<()> {
    let db = db.inner().clone();
    let result = mutation(app.clone(), move || db.trash_asset_original(&original)).await;
    let _ = app.emit("projects://changed", ());
    result
}

#[tauri::command]
pub async fn remove_connection_references(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    ids: Vec<String>,
) -> AppResult<()> {
    let db = db.inner().clone();
    mutation(app, move || db.remove_connection_references(&ids)).await
}
