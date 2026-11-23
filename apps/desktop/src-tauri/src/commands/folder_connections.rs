use crate::{
    core::{
        folder_connections::{AssetOriginal, ConnectionEntry, ConnectionFilter, FolderConnection, ScanChange, ScanTarget},
        missing_originals::{MarkedReferenceSweep, MissingOriginalSweep},
        paths::LibraryPaths,
    },
    db::Database,
    error::{AppError, AppResult},
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

// Serialize walks and physical mutations so a refresh cannot reconcile a half-finished move.
pub(crate) static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
static WAITING_MUTATIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub(super) async fn mutation_permit(gate: &tokio::sync::Semaphore) -> Result<tokio::sync::SemaphorePermit<'_>, tokio::sync::AcquireError> {
    use std::sync::atomic::Ordering;
    struct Waiting;
    impl Drop for Waiting {
        fn drop(&mut self) { WAITING_MUTATIONS.fetch_sub(1, Ordering::SeqCst); }
    }
    WAITING_MUTATIONS.fetch_add(1, Ordering::SeqCst);
    let _waiting = Waiting;
    gate.acquire().await
}

fn mutation_waiting() -> bool {
    WAITING_MUTATIONS.load(std::sync::atomic::Ordering::SeqCst) != 0
}

fn yield_scan_permit<'a>(gate: &'a tokio::sync::Semaphore, permit: &mut Option<tokio::sync::SemaphorePermit<'a>>) -> bool {
    if !mutation_waiting() { return false; }
    // Runs only on a blocking scan worker, between entries and outside any SQLite transaction.
    drop(permit.take());
    *permit = Some(tauri::async_runtime::block_on(gate.acquire()).expect("file operation gate stays open"));
    true
}
#[path = "connection_watch.rs"]
mod watcher;
pub use watcher::watch;

#[derive(Default)]
struct RefreshTargets {
    roots: HashSet<String>,
    folders: HashMap<String, String>,
}
impl RefreshTargets {
    fn roots(roots: HashSet<String>) -> Self { Self { roots, ..Self::default() } }

    fn is_empty(&self) -> bool { self.roots.is_empty() && self.folders.is_empty() }

    fn merge(&mut self, other: Self) {
        self.roots.extend(other.roots);
        self.folders.extend(other.folders);
        self.folders.retain(|_, root| !self.roots.contains(root));
    }
}

#[derive(Default)]
struct RefreshQueue {
    running: bool,
    all: bool,
    scanning_all: bool,
    last_full_scan: Option<Instant>,
    targets: RefreshTargets,
    priority: Option<String>,
    originals: bool,
    reference_continuation: bool,
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
        self.all || !self.targets.is_empty() || self.originals
    }
    fn advance_originals(&mut self, catalog_more: bool, pending: bool, references_more: bool) {
        if !self.reference_continuation { self.schedule.pending = pending; }
        self.reference_continuation = references_more;
        if catalog_more || references_more {
            self.originals = true;
        } else {
            self.schedule.complete(Instant::now(), self.schedule.pending);
        }
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
static MARKED_REFERENCES: std::sync::LazyLock<Mutex<MarkedReferenceSweep>> =
    std::sync::LazyLock::new(|| Mutex::new(MarkedReferenceSweep::default()));
fn changed(app: &AppHandle) {
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanCatalogScope {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    root_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    folder_ids: Vec<String>,
}

fn emit_scan_changes(app: &AppHandle, root: &str, root_changed: &mut bool, folders: &mut HashSet<String>) -> usize {
    let roots = std::mem::take(root_changed).then(|| root.to_owned()).into_iter().collect();
    emit_catalog_scopes(app, roots, folders.drain().collect())
}

fn emit_catalog_scopes(app: &AppHandle, roots: Vec<String>, folders: Vec<String>) -> usize {
    let mut notifications = 0;
    if !roots.is_empty() {
        let _ = app.emit("library://assets-changed", ScanCatalogScope { root_ids: roots, folder_ids: Vec::new() });
        notifications += 1;
    }
    if !folders.is_empty() {
        let _ = app.emit("library://assets-changed", ScanCatalogScope { root_ids: Vec::new(), folder_ids: folders });
        notifications += 1;
    }
    if notifications > 0 { let _ = app.emit("external-files://changed", ()); }
    notifications
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionProgress {
    root_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_folder_id: Option<String>,
    scanning: bool,
    error: Option<String>,
}
pub(super) async fn mutation<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let _permit = mutation_permit(&GATE)
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
    targets: Option<RefreshTargets>,
    priority: Option<String>,
    force: bool,
) {
    let mut queue = REFRESH.lock().unwrap();
    if let Some(targets) = targets {
        queue.targets.merge(targets);
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
    let references_only = REFRESH.lock().unwrap().reference_continuation;
    let batch = if references_only { Default::default() } else {
        ORIGINALS.lock().unwrap().check_batch_until(db, paths, Instant::now(), mutation_waiting)?
    };
    // Each continuation releases GATE. There is no complete catalog walk between reference batches.
    let (references, more_references) = if !batch.more {
        MARKED_REFERENCES.lock().unwrap().check_batch(db, mutation_waiting, crate::core::folder_connections::recycle)?
    } else { (0, false) };
    REFRESH.lock().unwrap().advance_originals(batch.more, batch.pending, more_references);
    let changed = batch.removed + batch.restored + references > 0;
    if changed {
        tracing::info!(removed = batch.removed, restored = batch.restored, references, "missing originals reconciled");
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
fn scan_requested_root(app: &AppHandle, db: &Database, paths: &LibraryPaths, id: String, folder: Option<String>, priority: Option<&str>, permit: tokio::sync::SemaphorePermit<'static>) {
    let mut last = Instant::now() - Duration::from_secs(1);
    let started = Instant::now();
    let publish_progress = |scanning, active_folder_id, error| {
        let _ = app.emit("library://connection-progress", ConnectionProgress {
            root_id: id.clone(), folder_id: folder.clone(), active_folder_id, scanning, error,
        });
    };
    publish_progress(true, None, None);
    let mut root_changed = false;
    let mut folders = HashSet::new();
    let mut notifications = 0;
    let mut permit = Some(permit);
    let mut yielded = false;
    let mut retry_folders = HashSet::new();
    let target = folder.as_deref().map_or(ScanTarget::Root { priority }, ScanTarget::Folder);
    let value = db.scan_connection_target(paths, &id, target, |change| {
        match change {
            ScanChange::Tick => (),
            ScanChange::EnteringFolder(active) => publish_progress(true, Some(active.to_owned()), None),
            ScanChange::Root => root_changed = true,
            ScanChange::Folder(folder) => { folders.insert(folder.to_owned()); }
            ScanChange::Folders(changed) => folders.extend(changed.iter().cloned()),
            ScanChange::RetryFolder(folder) => { retry_folders.insert(folder.to_owned()); }
        }
        if (root_changed || !folders.is_empty()) && last.elapsed() >= Duration::from_millis(500) {
            notifications += emit_scan_changes(app, &id, &mut root_changed, &mut folders);
            last = Instant::now();
        }
    }, || {
        let paused = yield_scan_permit(&GATE, &mut permit);
        yielded |= paused;
        paused
    });
    if yielded {
        let mut queue = REFRESH.lock().unwrap();
        if folder.is_some() {
            if !queue.targets.roots.contains(&id) {
                queue.targets.folders.extend(retry_folders.into_iter().map(|folder| (folder, id.clone())));
            }
        } else {
            queue.targets.merge(RefreshTargets::roots(HashSet::from([id.clone()])));
        }
    }
    // Flush changes even when a later directory failed. Progress alone never
    // invalidates pages or forces the expensive catalog counts to run again.
    notifications += emit_scan_changes(app, &id, &mut root_changed, &mut folders);
    publish_progress(false, None, value.as_ref().err().map(ToString::to_string));
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
                let mut queue = REFRESH.lock().unwrap();
                queue.reference_continuation = false;
                queue.schedule.complete(Instant::now(), true);
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

enum DeferredFingerprintSchedule {
    Idle,
    Running,
    Recheck,
}

impl DeferredFingerprintSchedule {
    fn request(&mut self) -> bool {
        let start = matches!(self, Self::Idle);
        *self = if start { Self::Running } else { Self::Recheck };
        start
    }

    fn finish_pass(&mut self, after: &mut String) -> bool {
        if matches!(self, Self::Recheck) {
            *self = Self::Running;
            after.clear();
            true
        } else {
            *self = Self::Idle;
            false
        }
    }
}

fn fill_deferred_fingerprints(db: Arc<Database>) {
    // Checking for a rescan and releasing the worker are one transition. A
    // refresh either requests another pass or takes ownership of a new worker.
    static SCHEDULE: Mutex<DeferredFingerprintSchedule> = Mutex::new(DeferredFingerprintSchedule::Idle);
    if !SCHEDULE.lock().unwrap().request() { return; }
    tauri::async_runtime::spawn(async move {
        let mut after = String::new();
        loop {
            let next = db.clone();
            let batch = match tokio::task::spawn_blocking({
                let after = after.clone();
                move || next.pending_connected_fingerprints(&after)
            }).await {
                Ok(Ok(batch)) => batch,
                Ok(Err(error)) => {
                    tracing::debug!(%error, "connected fingerprint query failed");
                    Vec::new()
                }
                Err(error) => {
                    tracing::debug!(%error, "connected fingerprint query interrupted");
                    Vec::new()
                }
            };
            if batch.is_empty() {
                if SCHEDULE.lock().unwrap().finish_pass(&mut after) { continue; }
                break;
            }
            after = batch.last().cloned().unwrap_or_default();
            for id in batch {
                tokio::time::sleep(Duration::from_millis(150)).await;
                while REFRESH.lock().unwrap().running || mutation_waiting() || GATE.available_permits() == 0 {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                let db = db.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    if let Err(error) = db.complete_connected_fingerprint(&id) {
                        tracing::debug!(%error, "connected fingerprint remains pending");
                    }
                }).await;
            }
        }
    });
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
                    std::mem::take(&mut queue.targets),
                    queue.priority.clone(),
                    std::mem::take(&mut queue.originals),
                )
            };
            let result = async {
                let RefreshTargets { roots, mut folders } = requested;
                let (db2, priority2) = (db.clone(), priority.clone());
                let ids = if all || !roots.is_empty() {
                    tauri::async_runtime::spawn_blocking(move ||
                        requested_root_ids(&db2, all, &roots, priority2.as_deref()))
                        .await.map_err(|e| AppError::Other(e.to_string()))??
                } else { Vec::new() };
                let full: HashSet<_> = ids.iter().collect();
                folders.retain(|_, root| !full.contains(root));
                let mut scoped: Vec<_> = folders.into_iter().collect();
                scoped.sort_by_key(|(folder, _)| Some(folder) != priority.as_ref());
                let jobs = ids.into_iter().map(|root| (root, None))
                    .chain(scoped.into_iter().map(|(folder, root)| (root, Some(folder))));
                for (id, folder) in jobs {
                    let (app, db, paths, priority) = (app.clone(), db.clone(), paths.clone(), priority.clone());
                    let permit = GATE.acquire().await.map_err(|e| AppError::Other(e.to_string()))?;
                    tauri::async_runtime::spawn_blocking(move || {
                        scan_requested_root(&app, &db, &paths, id, folder, priority.as_deref(), permit);
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
            drop(queue);
            fill_deferred_fingerprints(db.clone());
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
        Some(RefreshTargets::roots(HashSet::from([root_id]))),
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
    let force = force.unwrap_or(true);
    if force {
        let db = db.inner().clone();
        let folder = folder_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::core::semantic_search::index::request_connection_verification(&db, folder.as_deref())
        }).await.map_err(|error| AppError::Other(error.to_string()))??;
    }
    queue_refresh(app, db.inner().clone(), paths.inner().clone(), None, folder_id, force);
    Ok(())
}
const GRANT_CAPACITY: usize = 16_384;
const GRANT_EVICT_COUNT: usize = 2_048;
#[derive(Default)]
struct GrantVersions {
    inserted: u64,
    versions: HashMap<(String, String), u64>,
}
#[derive(Default)]
struct CatalogFileGrants(Mutex<GrantVersions>);
impl CatalogFileGrants {
    fn allow(&self, path: &str, version: Option<&str>, allow: impl FnOnce() -> AppResult<()>) -> AppResult<()> {
        let key = version.map(|version| (path.to_owned(), version.to_owned()));
        let mut granted = self.0.lock().unwrap();
        if key.as_ref().is_some_and(|key| granted.versions.contains_key(key)) { return Ok(()); }
        allow()?;
        if let Some(key) = key {
            if granted.versions.len() >= GRANT_CAPACITY {
                let oldest = granted.inserted - (GRANT_CAPACITY - GRANT_EVICT_COUNT) as u64;
                granted.versions.retain(|_, age| *age > oldest);
            }
            granted.inserted += 1;
            let age = granted.inserted;
            granted.versions.insert(key, age);
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
    folder_id: Option<String>,
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
            folder_id.as_deref(),
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
    subtree: Option<bool>,
) -> AppResult<Vec<String>> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.connection_entry_ids_in_scope(
            folder_id.as_deref(),
            project_id.as_deref(),
            media.as_deref(),
            offset.unwrap_or(0),
            limit.unwrap_or(2000),
            &filter.unwrap_or_default(),
            subtree.unwrap_or(false),
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
    verify_originals: Option<bool>,
) -> AppResult<Vec<ConnectionEntry>> {
    let db = db.inner().clone();
    let verify_originals = verify_originals.unwrap_or(true);
    let values = tauri::async_runtime::spawn_blocking(move || {
        if verify_originals {
            db.resolve_visible_connection_entries(&ids)
        } else {
            db.visible_connection_entries(&ids)
        }
    })
        .await
        .map_err(|e| AppError::Other(e.to_string()))??;
    if verify_originals { allow_entries(&app, &values)?; }
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
    fn deferred_fingerprint_pass_rewinds_for_an_older_asset_requeued_during_pagination() {
        let mut schedule = DeferredFingerprintSchedule::Idle;
        assert!(schedule.request());
        let mut after = String::from("asset-032");
        let pending_after = |cursor: &str| ["asset-004", "asset-033"]
            .into_iter().filter(|id| *id > cursor).collect::<Vec<_>>();

        assert!(!schedule.request());
        assert!(!schedule.request());
        assert_eq!(pending_after(&after), ["asset-033"]);
        after = String::from("asset-033");
        assert!(pending_after(&after).is_empty());
        assert!(schedule.finish_pass(&mut after));
        assert_eq!(pending_after(&after).first(), Some(&"asset-004"));

        assert!(!schedule.finish_pass(&mut after), "coalesced requests only require one extra pass");
    }

    #[test]
    fn deferred_fingerprint_exit_hands_off_wakeups_on_both_sides_of_completion() {
        let schedule = Mutex::new(DeferredFingerprintSchedule::Idle);
        let mut after = String::from("last");
        assert!(schedule.lock().unwrap().request());
        assert!(!schedule.lock().unwrap().request());
        assert!(schedule.lock().unwrap().finish_pass(&mut after));
        assert!(after.is_empty());

        assert!(!schedule.lock().unwrap().finish_pass(&mut after));
        assert!(schedule.lock().unwrap().request(), "request after retirement starts a new worker");
        assert!(!schedule.lock().unwrap().request(), "successor also coalesces concurrent requests");
        assert!(schedule.lock().unwrap().finish_pass(&mut after));
    }

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
    fn catalog_grants_evict_oldest_versions_without_dropping_other_grants() {
        let grants = CatalogFileGrants::default();
        for i in 0..=GRANT_CAPACITY {
            grants.allow(&i.to_string(), Some("v"), || Ok(())).unwrap();
        }
        assert_eq!(grants.0.lock().unwrap().versions.len(), GRANT_CAPACITY - GRANT_EVICT_COUNT + 1);
        grants.allow(&GRANT_EVICT_COUNT.to_string(), Some("v"), || panic!("recent grant was lost")).unwrap();
        let called = std::cell::Cell::new(false);
        grants.allow("0", Some("v"), || { called.set(true); Ok(()) }).unwrap();
        assert!(called.get());
    }

    #[tokio::test]
    async fn queued_file_operation_runs_before_scan_continues_its_current_root() {
        let gate = Arc::new(tokio::sync::Semaphore::new(1));
        let (ready, started) = tokio::sync::oneshot::channel();
        let (resume, checkpoint) = std::sync::mpsc::channel();
        let scanner_gate = gate.clone();
        let scan = tokio::task::spawn_blocking(move || {
            let mut permit = Some(tauri::async_runtime::block_on(scanner_gate.acquire()).unwrap());
            ready.send(()).unwrap();
            checkpoint.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(yield_scan_permit(&scanner_gate, &mut permit));
        });
        started.await.unwrap();
        let pending = mutation_permit(&gate);
        tokio::pin!(pending);
        tokio::select! { biased; _ = &mut pending => panic!("must queue behind the current entry"), _ = tokio::task::yield_now() => {} }
        let started = Instant::now();
        resume.send(()).unwrap();
        let permit = tokio::time::timeout(Duration::from_secs(5), pending).await.unwrap().unwrap();
        println!("foreground admission at the next scan entry: {:?}", started.elapsed());
        assert!(!scan.is_finished());
        drop(permit);
        scan.await.unwrap();
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
        assert!(queue.targets.is_empty());
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

    #[test]
    fn legacy_reference_backlog_continues_promptly_without_restarting_the_catalog_or_skipping_confirmation() {
        let mut queue = RefreshQueue::default();
        assert!(queue.schedule.request(Instant::now(), false));
        queue.advance_originals(true, true, false);
        assert!(std::mem::take(&mut queue.originals));
        assert!(!queue.reference_continuation);

        queue.advance_originals(false, true, true);
        assert!(std::mem::take(&mut queue.originals));
        assert!(queue.reference_continuation);
        assert!(queue.schedule.running);
        queue.advance_originals(false, false, true);
        assert!(std::mem::take(&mut queue.originals));
        assert!(queue.reference_continuation);
        queue.advance_originals(false, false, false);
        assert!(!queue.has_work());
        assert!(!queue.schedule.running);
        assert!(queue.schedule.pending, "an outstanding original still needs a second observation");
    }
}
