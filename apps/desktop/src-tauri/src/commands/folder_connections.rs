use crate::{
    core::{
        folder_connections::{AssetOriginal, ConnectionEntry, ConnectionFilter, FolderConnection},
        missing_originals::MissingOriginalSweep,
        paths::LibraryPaths,
    },
    db::Database,
    error::{AppError, AppResult},
};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

// Serialize walks and physical mutations so a refresh cannot reconcile a half-finished move.
pub(crate) static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
#[path = "connection_watch.rs"]
mod watcher;
pub use watcher::watch;

#[derive(Default)]
struct RefreshQueue {
    running: bool,
    all: bool,
    scanning_all: bool,
    last_full_scan: Option<Instant>,
    roots: HashSet<String>,
    priority: Option<String>,
    originals: bool,
    schedule: OriginalCheckSchedule,
}
impl RefreshQueue {
    fn request_full_scan(&mut self, now: Instant, force: bool) -> bool {
        if !force && (self.all || self.scanning_all
            || self.last_full_scan.is_some_and(|last| now.duration_since(last) < Duration::from_secs(30))) {
            return false;
        }
        self.all = true;
        true
    }
    fn has_work(&self) -> bool {
        self.all || !self.roots.is_empty() || self.originals
    }
}
#[derive(Default)]
struct OriginalCheckSchedule {
    running: bool,
    completed: Option<Instant>,
    pending: bool,
}
impl OriginalCheckSchedule {
    fn request(&mut self, now: Instant, focused: bool) -> bool {
        let interval = Duration::from_secs(if focused || self.pending { 30 } else { 300 });
        if self.running || self.completed.is_some_and(|last| now.duration_since(last) < interval) {
            return false;
        }
        self.running = true;
        true
    }
    fn complete(&mut self, now: Instant, pending: bool) {
        self.running = false;
        self.completed = Some(now);
        self.pending = pending;
    }
}
static REFRESH: std::sync::LazyLock<Mutex<RefreshQueue>> =
    std::sync::LazyLock::new(|| Mutex::new(RefreshQueue::default()));
static ORIGINALS: std::sync::LazyLock<Mutex<MissingOriginalSweep>> =
    std::sync::LazyLock::new(|| Mutex::new(MissingOriginalSweep::default()));
fn changed(app: &AppHandle) {
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionProgress {
    root_id: String,
    scanning: bool,
    error: Option<String>,
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
    queue_refresh(app, db, paths, None, folder, true);
}
fn request_originals_check(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    focused: bool,
) {
    let mut queue = REFRESH.lock().unwrap();
    if !queue.schedule.request(Instant::now(), focused) {
        return;
    }
    queue.originals = true;
    start_refresh(app, db, paths, queue);
}
fn queue_refresh(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    roots: Option<HashSet<String>>,
    priority: Option<String>,
    force: bool,
) {
    let mut queue = REFRESH.lock().unwrap();
    if let Some(roots) = roots {
        queue.roots.extend(roots);
    } else if !queue.request_full_scan(Instant::now(), force) {
        return;
    }
    if priority.is_some() {
        queue.priority = priority;
    }
    if queue.schedule.request(Instant::now(), true) {
        queue.originals = true;
    }
    start_refresh(app, db, paths, queue);
}
fn check_originals(db: &Database, paths: &LibraryPaths) -> AppResult<bool> {
    let batch = ORIGINALS.lock().unwrap().check_batch(db, paths, Instant::now())?;
    let mut queue = REFRESH.lock().unwrap();
    if batch.more {
        queue.originals = true;
    } else {
        queue.schedule.complete(Instant::now(), batch.pending);
    }
    let changed = batch.removed + batch.restored > 0;
    if changed {
        tracing::info!(removed = batch.removed, restored = batch.restored, "missing originals reconciled");
    }
    Ok(changed)
}
fn requested_root_ids(
    db: &Database,
    all: bool,
    requested: &HashSet<String>,
    priority: Option<&str>,
) -> AppResult<Vec<String>> {
    let priority_root = priority
        .and_then(|id| db.connected_folder(id).ok())
        .map(|f| f.root_id);
    let mut ids = db.connected_root_ids()?;
    if !all {
        ids.retain(|id| requested.contains(id));
    }
    ids.sort_by_key(|id| Some(id) != priority_root.as_ref());
    Ok(ids)
}
fn scan_requested_root(app: &AppHandle, db: &Database, paths: &LibraryPaths, id: String, priority: Option<&str>) {
    let mut last = Instant::now() - Duration::from_secs(1);
    let started = Instant::now();
    let _ = app.emit("library://connection-progress", ConnectionProgress { root_id: id.clone(), scanning: true, error: None });
    let mut dirty = false;
    let mut notifications = 0;
    let value = db.scan_connection_changes(paths, &id, priority, |changed_data| {
        dirty |= changed_data;
        if dirty && last.elapsed() >= Duration::from_millis(500) {
            changed(app);
            notifications += 1;
            dirty = false;
            last = Instant::now();
        }
    });
    // Flush changes even when a later directory failed. Progress alone never
    // invalidates pages or forces the expensive catalog counts to run again.
    if dirty { changed(app); notifications += 1; }
    let _ = app.emit("library://connection-progress", ConnectionProgress { root_id: id, scanning: false, error: value.as_ref().err().map(ToString::to_string) });
    tracing::debug!(elapsed_ms = started.elapsed().as_millis(), notifications, "connection scan completed");
    if let Err(error) = value {
        tracing::warn!("connection scan: {error}");
    }
}
fn finish_refresh(app: &AppHandle, originals: bool, result: AppResult<bool>) {
    let originals_changed = match result {
        Ok(changed) => changed,
        Err(error) => {
            if originals {
                REFRESH.lock().unwrap().schedule.complete(Instant::now(), true);
            }
            tracing::warn!("connection refresh: {error}");
            false
        }
    };
    // Directory scans publish actual changes themselves, including before errors.
    if originals_changed {
        changed(app);
    }
}
fn start_refresh(
    app: AppHandle,
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    mut queue: std::sync::MutexGuard<'_, RefreshQueue>,
) {
    if queue.running {
        return;
    }
    queue.running = true;
    drop(queue);
    tauri::async_runtime::spawn(async move {
        loop {
            // Multiple panes/focus events and bursts of writes share one background walk.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let (all, requested, priority, originals) = {
                let mut queue = REFRESH.lock().unwrap();
                queue.scanning_all = queue.all;
                (
                    std::mem::take(&mut queue.all),
                    std::mem::take(&mut queue.roots),
                    queue.priority.clone(),
                    std::mem::take(&mut queue.originals),
                )
            };
            let result = async {
                let (db2, priority2) = (db.clone(), priority.clone());
                let ids = if all || !requested.is_empty() {
                    tauri::async_runtime::spawn_blocking(move ||
                        requested_root_ids(&db2, all, &requested, priority2.as_deref()))
                        .await.map_err(|e| AppError::Other(e.to_string()))??
                } else { Vec::new() };
                for id in ids {
                    let (app, db, paths, priority) = (app.clone(), db.clone(), paths.clone(), priority.clone());
                    let permit = GATE.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
                    tauri::async_runtime::spawn_blocking(move || {
                        let _permit = permit;
                        scan_requested_root(&app, &db, &paths, id, priority.as_deref());
                    }).await.map_err(|e| AppError::Other(e.to_string()))?;
                }
                if originals {
                    let (db, paths) = (db.clone(), paths.clone());
                    let permit = GATE.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
                    tauri::async_runtime::spawn_blocking(move || {
                        let _permit = permit;
                        check_originals(&db, &paths)
                    }).await.map_err(|e| AppError::Other(e.to_string()))?
                } else { Ok(false) }
            }.await;
            if all && result.is_ok() {
                REFRESH.lock().unwrap().last_full_scan = Some(Instant::now());
            }
            finish_refresh(&app, originals, result);
            let mut queue = REFRESH.lock().unwrap();
            queue.scanning_all = false;
            if queue.has_work() {
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
    filter: Option<ConnectionFilter>,
) -> AppResult<Vec<FolderConnection>> {
    let db = db.inner().clone();
    let requested = Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        let queue_ms = requested.elapsed().as_millis();
        let started = Instant::now();
        let result = db.connection_folders_filtered(project_id.as_deref(), media.as_deref(), &filter.unwrap_or_default());
        tracing::debug!(queue_ms, read_ms = started.elapsed().as_millis(), folders = result.as_ref().map_or(0, Vec::len), "catalog folder overview");
        result
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
    let (id, root_id) = mutation(app.clone(), move || {
        let id = database.connect_directory(&source, project_id.as_deref())?;
        let root = database.connected_folder(&id)?.root_id;
        Ok((id, root))
    })
    .await?;
    queue_refresh(
        app,
        db.inner().clone(),
        paths.inner().clone(),
        Some(HashSet::from([root_id])),
        Some(id.clone()),
        true,
    );
    Ok(id)
}
#[tauri::command]
pub async fn refresh_folder_connections(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    folder_id: Option<String>,
    force: Option<bool>,
) -> AppResult<()> {
    queue_refresh(app, db.inner().clone(), paths.inner().clone(), None, folder_id, force.unwrap_or(true));
    Ok(())
}
#[derive(Default)]
struct CatalogFileGrants(Mutex<HashSet<(String, String)>>);
impl CatalogFileGrants {
    fn allow(&self, path: &str, version: Option<&str>, allow: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        let key = version.map(|version| (path.to_owned(), version.to_owned()));
        let mut granted = self.0.lock().unwrap();
        if key.as_ref().is_some_and(|key| granted.contains(key)) { return Ok(()); }
        allow()?;
        if let Some(key) = key {
            if granted.len() >= 16_384 { granted.clear(); }
            granted.insert(key);
        }
        Ok(())
    }
}
fn allow_entries(app: &AppHandle, entries: &[ConnectionEntry]) -> AppResult<()> {
    if app.try_state::<CatalogFileGrants>().is_none() { app.manage(CatalogFileGrants::default()); }
    let grants = app.state::<CatalogFileGrants>();
    let mut pending: Vec<_> = entries.iter().collect();
    while let Some(entry) = pending.pop() {
        pending.extend(&entry.group);
        for path in [&entry.asset.store_path, &entry.asset.thumb_path]
            .into_iter()
            .flatten()
        {
            // Tauri canonicalizes on every allow_file, even for an existing rule.
            // Cache only successful, versioned grants in this application session.
            grants.allow(path, entry.version.as_deref(), || app.asset_protocol_scope()
                .allow_file(path)
                .map_err(|e| AppError::Other(e.to_string())))?;
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
    filter: Option<ConnectionFilter>,
    project_id: Option<String>,
) -> AppResult<Vec<ConnectionEntry>> {
    let db = db.inner().clone();
    let requested = Instant::now();
    let values = tauri::async_runtime::spawn_blocking(move || {
        let queue_ms = requested.elapsed().as_millis();
        let started = Instant::now();
        let filter = filter.unwrap_or_default();
        let ids = db.connection_entry_ids_filtered(
            Some(&folder_id),
            project_id.as_deref(),
            media.as_deref(),
            offset,
            limit.min(240),
            &filter,
        )?;
        let ids_ms = started.elapsed().as_millis();
        let hydrate = Instant::now();
        let mut entries = db.visible_connection_entries(&ids)?;
        let hydrate_ms = hydrate.elapsed().as_millis();
        let groups = Instant::now();
        db.connection_entry_groups(&mut entries, project_id.as_deref(), media.as_deref(), &filter)?;
        tracing::debug!(queue_ms, ids_ms, hydrate_ms, groups_ms = groups.elapsed().as_millis(), count = entries.len(), "catalog folder page");
        Ok::<_, AppError>(entries)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    let permissions = Instant::now();
    allow_entries(&app, &values)?;
    tracing::debug!(permissions_ms = permissions.elapsed().as_millis(), total_ms = requested.elapsed().as_millis(), "catalog folder page returned");
    Ok(values)
}
#[tauri::command]
pub async fn connection_entry_ids(
    db: State<'_, Arc<Database>>,
    folder_id: Option<String>,
    media: Option<String>,
    filter: Option<ConnectionFilter>,
    project_id: Option<String>,
    offset: Option<i64>,
    limit: Option<i64>,
) -> AppResult<Vec<String>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.connection_entry_ids_filtered(
            folder_id.as_deref(),
            project_id.as_deref(),
            media.as_deref(),
            offset.unwrap_or(0),
            limit.unwrap_or(2000),
            &filter.unwrap_or_default(),
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
    let values = tauri::async_runtime::spawn_blocking(move || db.resolve_visible_connection_entries(&ids))
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    allow_entries(&app, &values)?;
    Ok(values)
}
#[tauri::command]
pub async fn create_connected_collection(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    files: State<'_, Arc<crate::core::file_workspace::FileWorkspace>>,
    parent_id: Option<String>,
    name: String,
    path: Option<String>,
    project_id: Option<String>,
) -> AppResult<String> {
    let db = db.inner().clone();
    let files = files.inner().clone();
    mutation(app, move || {
        db.create_connected_directory(
            &files,
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
    paths: State<'_, Arc<LibraryPaths>>,
    id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    mutation(app, move || db.disconnect_directory(&paths, &id)).await
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
    paths: State<'_, Arc<LibraryPaths>>,
    id: String,
) -> AppResult<()> {
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    mutation(app, move || db.trash_connected_directory(&paths, &id)).await
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
    allow_partial: Option<bool>,
) -> AppResult<Vec<crate::core::folder_connections::OriginalPreview>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if allow_partial == Some(true) { db.preview_original_selection(&asset_ids) }
        else { Ok(db.preview_asset_originals(&asset_ids)?.into_iter().map(crate::core::folder_connections::OriginalPreview::Ready).collect()) }
    })
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

#[cfg(test)]
mod maintenance_tests {
    use super::*;

    #[test]
    fn catalog_grants_reuse_only_successful_same_version_in_the_same_app() {
        let grants = CatalogFileGrants::default();
        let calls = std::cell::Cell::new(0);
        let allow = || { calls.set(calls.get() + 1); Ok(()) };
        grants.allow("source", Some("v1"), allow).unwrap();
        grants.allow("source", Some("v1"), allow).unwrap();
        assert_eq!(calls.get(), 1);
        grants.allow("source", Some("v2"), allow).unwrap();
        grants.allow("renamed", Some("v2"), allow).unwrap();
        assert_eq!(calls.get(), 3);
        assert!(grants.allow("failed", Some("v1"), || Err(AppError::Other("failure".into()))).is_err());
        grants.allow("failed", Some("v1"), allow).unwrap();
        grants.allow("unversioned", None, allow).unwrap();
        grants.allow("unversioned", None, allow).unwrap();
        assert_eq!(calls.get(), 6);
        CatalogFileGrants::default().allow("source", Some("v1"), allow).unwrap();
        assert_eq!(calls.get(), 7);
    }

    #[test]
    fn automatic_full_scans_share_pending_work_and_cooldown_but_manual_refresh_bypasses() {
        let now = Instant::now();
        let mut queue = RefreshQueue::default();
        assert!(queue.request_full_scan(now, false));
        assert!(!queue.request_full_scan(now, false));
        queue.all = false;
        queue.scanning_all = true;
        assert!(!queue.request_full_scan(now + Duration::from_secs(60), false));
        queue.scanning_all = false;
        queue.last_full_scan = Some(now);
        assert!(!queue.request_full_scan(now + Duration::from_secs(29), false));
        assert!(queue.request_full_scan(now + Duration::from_secs(30), false));
        queue.all = false;
        assert!(queue.request_full_scan(now + Duration::from_secs(1), true));
    }

    #[test]
    fn checks_on_startup_without_roots_then_waits_between_healthy_sweeps() {
        let now = Instant::now();
        let mut queue = RefreshQueue::default();
        assert!(queue.roots.is_empty());
        queue.originals = queue.schedule.request(now, false);
        assert!(queue.has_work());
        assert!(std::mem::take(&mut queue.originals));
        assert!(!queue.has_work());
        assert!(!queue.schedule.request(now + Duration::from_secs(600), true));
        queue.schedule.complete(now, false);
        assert!(!queue.schedule.request(now + Duration::from_secs(299), false));
        assert!(queue.schedule.request(now + Duration::from_secs(300), false));
    }

    #[test]
    fn missing_confirmation_and_focus_share_throttle_without_duplicate_workers() {
        let now = Instant::now();
        let mut schedule = OriginalCheckSchedule::default();
        schedule.complete(now, true);
        assert!(!schedule.request(now + Duration::from_secs(29), false));
        assert!(schedule.request(now + Duration::from_secs(30), false));
        assert!(!schedule.request(now + Duration::from_secs(31), true));
        schedule.complete(now + Duration::from_secs(40), false);
        assert!(!schedule.request(now + Duration::from_secs(69), true));
        assert!(schedule.request(now + Duration::from_secs(70), true));
        schedule.complete(now + Duration::from_secs(80), false);
        assert!(!schedule.request(now + Duration::from_secs(110), false));
    }
}
