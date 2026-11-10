use crate::{
    core::{
        external_files::{self, DirectoryPage, ExternalReference},
        library::Asset,
        paths::LibraryPaths,
    },
    db::Database,
    error::AppError,
};
use std::{collections::{HashMap, HashSet, VecDeque}, path::PathBuf, sync::{Arc, Mutex, LazyLock}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn external_files_media(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, path: String) -> Result<String, AppError> {
    let paths = paths.inner().clone();
    let path = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let path = std::fs::canonicalize(path)?;
        if !path.is_file() || !(external_files::image_path(&path) || external_files::video_path(&path) || external_files::audio_path(&path)) {
            return Err(AppError::Other("请选择支持的图片、视频或音频".into()));
        }
        external_files::compatible_image(&paths, &path)
    }).await.map_err(|e| AppError::Other(e.to_string()))??;
    app.asset_protocol_scope().allow_file(&path).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

fn allow(app: &AppHandle, asset: &Asset) -> Result<(), AppError> {
    if let Some(path) = &asset.store_path {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}
fn changed(app: &AppHandle) {
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
}

#[derive(Clone, serde::Serialize)]
struct PreviewChanges { assets: Vec<Asset>, versions: HashMap<String, String> }
fn preview_completed(app: AppHandle, asset: Asset, version: String) {
    static PENDING: LazyLock<Mutex<HashMap<String, (Asset, String)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    let first = {
        let mut pending = PENDING.lock().unwrap();
        let first = pending.is_empty();
        pending.insert(asset.id.clone(), (asset, version));
        first
    };
    if !first { return; }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let pending = std::mem::take(&mut *PENDING.lock().unwrap());
        let mut payload = PreviewChanges { assets: Vec::new(), versions: HashMap::new() };
        for (id, (asset, version)) in pending { payload.assets.push(asset); payload.versions.insert(id, version); }
        let _ = app.emit("library://previews-changed", payload);
    });
}

struct PreviewCompletion {
    app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>, source: PathBuf,
    preview: String, attempt: u8, queued_at: Instant,
}
#[derive(Default)]
struct CompletionQueue {
    jobs: VecDeque<PreviewCompletion>,
    keys: HashSet<String>,
    running: bool,
}
impl CompletionQueue {
    fn reserve(&mut self, key: &str) -> bool {
        self.keys.len() < 512 && self.keys.insert(key.to_owned())
    }
}
static COMPLETIONS: LazyLock<Mutex<CompletionQueue>> = LazyLock::new(|| Mutex::new(CompletionQueue::default()));

#[cfg(test)]
mod completion_tests {
    use super::*;
    #[test]
    fn completion_reservations_deduplicate_bound_backlog_and_allow_retry() {
        let mut queue = CompletionQueue::default();
        assert!(queue.reserve("first"));
        assert!(!queue.reserve("first"));
        for index in 1..512 { assert!(queue.reserve(&format!("preview-{index}"))); }
        assert!(!queue.reserve("overflow"));
        queue.keys.remove("first");
        assert!(queue.reserve("overflow"));
        queue.keys.remove("overflow");
        assert!(queue.reserve("first"), "a completed/failed task can be retried on a later cache hit");
    }
}

fn queue_preview_completion(app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>, source: PathBuf, preview: String) {
    let mut queue = COMPLETIONS.lock().unwrap();
    // The persisted null/stale thumb_path remains the recovery marker. A cache
    // hit on a later visit retries work rejected here or interrupted by exit.
    if !queue.reserve(&preview) { return; }
    queue.jobs.push_back(PreviewCompletion { app, db, paths, source, preview, attempt: 0, queued_at: Instant::now() });
    if queue.running { return; }
    queue.running = true;
    drop(queue);
    tauri::async_runtime::spawn(async move {
        loop {
            // One low-priority completion worker yields between items; the four
            // foreground render slots never wait for hashing/color extraction.
            tokio::time::sleep(Duration::from_millis(40)).await;
            let job = {
                let mut queue = COMPLETIONS.lock().unwrap();
                match queue.jobs.pop_front() {
                    Some(job) => job,
                    None => { queue.running = false; return; }
                }
            };
            let key = job.preview.clone();
            let result = tokio::task::spawn_blocking(move || {
                let started = Instant::now();
                tracing::debug!(stage="preview_completion_queue", elapsed_ms=job.queued_at.elapsed().as_millis() as u64);
                let result = job.db.complete_connected_preview_versioned(&job.paths, &job.source, &job.preview);
                tracing::debug!(stage="preview_completion", elapsed_ms=started.elapsed().as_millis() as u64, success=result.is_ok(), attempt=job.attempt);
                (job, result)
            }).await;
            match result {
                Ok((job, Ok(Some((asset, version))))) => preview_completed(job.app, asset, version),
                Ok((mut job, Err(_))) if job.attempt < 2 => {
                    job.attempt += 1;
                    job.queued_at = Instant::now();
                    COMPLETIONS.lock().unwrap().jobs.push_back(job);
                    continue;
                }
                Ok((_, Err(_))) | Err(_) => tracing::warn!(stage="preview_completion", "preview metadata remains pending for next visit"),
                _ => {},
            }
            COMPLETIONS.lock().unwrap().keys.remove(&key);
        }
    });
}

#[tauri::command]
pub async fn local_file_rename(app: AppHandle, db: State<'_, Arc<Database>>, asset_id: String, path: String, name: String) -> Result<(), AppError> {
    let db = db.inner().clone();
    let asset = tokio::task::spawn_blocking(move || {
        db.rename_local_file(&asset_id, &path, &name)?;
        db.get_asset(&asset_id)?.ok_or_else(|| AppError::Other("素材已不存在".into()))
    }).await.map_err(|e| AppError::Other(e.to_string()))??;
    allow(&app, &asset)?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn local_file_delete(app: AppHandle, db: State<'_, Arc<Database>>, asset_id: String, path: String) -> Result<(), AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.delete_local_file(&asset_id, &path))
        .await.map_err(|e| AppError::Other(e.to_string()))??;
    changed(&app);
    Ok(())
}
#[tauri::command]
pub async fn external_files_browse(
    paths: State<'_, Arc<LibraryPaths>>,
    path: Option<String>,
    offset: Option<usize>,
    all: Option<bool>,
) -> Result<DirectoryPage, AppError> {
    let paths = paths.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mut page = external_files::browse_page(path.as_deref(), offset.unwrap_or(0), all.unwrap_or(false))?;
        external_files::attach_previews(&paths, &mut page.entries);
        Ok(page)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn external_files_preview(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    path: String,
) -> Result<String, AppError> {
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    let started = Instant::now();
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let cached_paths = paths.clone(); let cached_path = path.clone();
    let cached = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let source = PathBuf::from(cached_path);
        external_files::cached_preview(&cached_paths, &source)
    })
        .await.map_err(|e| AppError::Other(e.to_string()))??;
    if let Some(cached) = cached {
        app.asset_protocol_scope().allow_file(&cached).map_err(|e| AppError::Other(e.to_string()))?;
        tracing::debug!(stage="preview_cache", hit=true, elapsed_ms=started.elapsed().as_millis() as u64);
        queue_preview_completion(app, db, paths, PathBuf::from(path), cached.clone());
        return Ok(cached);
    }
    tracing::debug!(stage="preview_cache", hit=false, elapsed_ms=started.elapsed().as_millis() as u64);
    let queued = Instant::now();
    let permit = GATE.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
    tracing::debug!(stage="preview_render_queue", elapsed_ms=queued.elapsed().as_millis() as u64);
    let render_paths = paths.clone(); let render_db = db.clone(); let source = PathBuf::from(path);
    let render_source = source.clone();
    let preview = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let _permit = permit;
        let started = Instant::now();
        let result = external_files::preview_with_index(&render_paths, Some(&render_db), &render_source);
        tracing::debug!(stage="preview_render", elapsed_ms=started.elapsed().as_millis() as u64, success=result.is_ok());
        result
    })
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    app.asset_protocol_scope().allow_file(&preview).map_err(|e| AppError::Other(e.to_string()))?;
    queue_preview_completion(app, db, paths, source, preview.clone());
    Ok(preview)
}
#[tauri::command]
pub async fn external_files_index(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    path: String,
) -> Result<Asset, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let asset =
        tokio::task::spawn_blocking(move || db.index_external(&paths, &PathBuf::from(path)))
            .await
            .map_err(|e| AppError::Other(e.to_string()))??;
    allow(&app, &asset)?;
    Ok(asset)
}
#[tauri::command]
pub async fn external_files_references(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> Result<Vec<ExternalReference>, AppError> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || external_files::references(&db, &project_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn external_files_update(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    path: String,
    accept_changes: bool,
) -> Result<Asset, AppError> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let asset = tokio::task::spawn_blocking(move || {
        db.update_external(&paths, &asset_id, &PathBuf::from(path), accept_changes)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    allow(&app, &asset)?;
    changed(&app);
    let _ = app.emit(
        "analyses://changed",
        serde_json::json!({"asset_id":asset.id,"kind":"caption"}),
    );
    Ok(asset)
}
#[tauri::command]
pub async fn external_files_copy(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Asset, AppError> {
    let db = db.inner().clone();
    // Retain the IPC name for older callers; joining the library never copies an original.
    let asset = tokio::task::spawn_blocking(move || db.link_external_to_library(&asset_id))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    allow(&app, &asset)?;
    changed(&app);
    Ok(asset)
}
