use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, TryLockError,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

use crate::{
    core::catalog_browser::CatalogFilter,
    db::Database,
    error::{AppError, AppResult},
};

use super::{
    index::{self, IndexState},
    model,
    query::{self, SearchSnapshot},
};

const SESSION_IDLE: Duration = Duration::from_secs(300);
const QUERY_DEADLINE: Duration = Duration::from_secs(10);
const COLD_QUERY_DEADLINE: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 8;

#[derive(Clone)]
struct Install {
    operation_id: String,
    cancel: Arc<AtomicBool>,
    previous_error: Option<String>,
}

#[derive(Default)]
struct ModelState {
    install: Option<Install>,
    operation_id: Option<String>,
    corrupt: bool,
    last_error: Option<String>,
    downloaded: u64,
}

impl ModelState {
    fn is_corrupt(&self, root: &Path) -> bool {
        self.corrupt || model::known_corrupt(root)
    }

    fn availability(&self, root: &Path, installed: bool) -> &'static str {
        if self.install.is_some() {
            "downloading"
        } else if self.is_corrupt(root) {
            "corrupt"
        } else if installed {
            "ready"
        } else {
            "missing"
        }
    }

    fn finish_install(
        &mut self,
        install: &Install,
        result: Result<(), String>,
        queue_error: Option<String>,
    ) -> bool {
        if self
            .install
            .as_ref()
            .is_none_or(|current| current.operation_id != install.operation_id)
        {
            return false;
        }
        self.last_error = match result {
            Ok(()) => {
                self.corrupt = false;
                queue_error
            }
            Err(_) if install.cancel.load(Ordering::Acquire) => install.previous_error.clone(),
            Err(error) => {
                tracing::warn!(%error, "semantic model install failed");
                Some(
                    if error == "disk_full" {
                        "disk_full"
                    } else {
                        "download_failed"
                    }
                    .into(),
                )
            }
        };
        self.install = None;
        true
    }
}

struct Request {
    pane: String,
    cancel: Arc<AtomicBool>,
}

struct Session {
    pane: String,
    last_access: Instant,
    snapshot: Arc<SearchSnapshot>,
}

#[derive(Default)]
struct Queries {
    active: HashMap<String, Request>,
    sessions: HashMap<String, Session>,
}

pub(crate) struct SemanticSearch {
    model_root: PathBuf,
    model: Mutex<ModelState>,
    encoder: Mutex<Option<model::Embedder>>,
    text_warm: AtomicBool,
    model_epoch: AtomicU64,
    queries: Mutex<Queries>,
    scoring: Arc<Semaphore>,
    paging: Semaphore,
    last_progress: Mutex<Option<Instant>>,
    worker_error: Mutex<Option<&'static str>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    #[serde(flatten)]
    index: IndexState,
    supported: bool,
    model_state: &'static str,
    download_bytes: u64,
    installed_bytes: u64,
    downloaded_bytes: u64,
    model_error: Option<String>,
    worker_error: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    #[serde(flatten)]
    status: Status,
    phase: &'static str,
    total_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionsReset {
    library_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Operation {
    operation_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResponse {
    request_id: String,
    session_id: String,
    library_id: String,
    model_key: String,
    index_revision: i64,
    eligible: usize,
    indexed: usize,
    result_count: usize,
    truncated: bool,
}

fn code(name: &str) -> AppError {
    AppError::Other(name.into())
}

pub(crate) fn wire_error(error: AppError) -> String {
    if let AppError::Db(rusqlite::Error::SqliteFailure(failure, _)) = &error {
        if failure.code == rusqlite::ErrorCode::DiskFull {
            return "disk_full".into();
        }
    }
    if let AppError::Other(message) = &error {
        if matches!(
            message.as_str(),
            "unsupported_platform"
                | "model_missing"
                | "index_empty"
                | "invalid_scope"
                | "invalid_query"
                | "cancelled"
                | "stale_session"
                | "resource_limit"
                | "disk_full"
                | "model_corrupt"
                | "model_busy"
        ) {
            return message.clone();
        }
    }
    tracing::warn!(%error, "semantic search operation failed");
    "internal_error".into()
}

impl SemanticSearch {
    pub(crate) fn new(app_data: &Path) -> Self {
        Self {
            model_root: app_data.join("semantic-search").join(model::MODEL_ID),
            model: Mutex::new(ModelState::default()),
            encoder: Mutex::new(None),
            queries: Mutex::new(Queries::default()),
            text_warm: AtomicBool::new(false),
            model_epoch: AtomicU64::new(0),
            scoring: Arc::new(Semaphore::new(1)),
            paging: Semaphore::new(3),
            last_progress: Mutex::new(None),
            worker_error: Mutex::new(None),
        }
    }

    pub(crate) fn status(&self, db: &Database) -> AppResult<Status> {
        let model = self.model.lock().unwrap();
        let available = model::installed(&self.model_root);
        let supported = model::supported();
        let model_state = model.availability(&self.model_root, available);
        Ok(Status {
            index: index::status(db)?,
            supported,
            model_state,
            download_bytes: model::download_bytes(),
            installed_bytes: model::installed_bytes(),
            downloaded_bytes: model.downloaded,
            model_error: model.last_error.clone(),
            worker_error: *self.worker_error.lock().unwrap(),
        })
    }

    fn progress(&self, app: &AppHandle, db: &Database, phase: &'static str, force: bool) {
        let mut last = self.last_progress.lock().unwrap();
        if !force && last.is_some_and(|instant| instant.elapsed() < Duration::from_millis(500)) {
            return;
        }
        *last = Some(Instant::now());
        drop(last);
        if let Ok(mut status) = self.status(db) {
            if phase == "download" {
                status.index.operation_id = self.model.lock().unwrap().operation_id.clone();
            }
            let _ = app.emit(
                "semantic://progress",
                Progress {
                    status,
                    phase,
                    total_bytes: model::download_bytes(),
                },
            );
        }
    }

    pub(crate) fn index_action(
        &self,
        app: &AppHandle,
        db: &Database,
        action: &str,
    ) -> AppResult<Operation> {
        if matches!(action, "start" | "resume" | "rebuild") {
            self.check_model()?;
            *self.worker_error.lock().unwrap() = None;
        }
        if !matches!(
            action,
            "start" | "resume" | "rebuild" | "pause" | "cancel" | "disable"
        ) {
            return Err(code("invalid_scope"));
        }
        let status = index::control(db, action)?;
        if matches!(action, "rebuild" | "disable") {
            self.reset_queries(app, db);
        }
        self.progress(app, db, "index", true);
        Ok(Operation {
            operation_id: status.operation_id,
        })
    }

    pub(crate) fn model_action(
        self: &Arc<Self>,
        app: AppHandle,
        db: Arc<Database>,
        action: &str,
    ) -> AppResult<Operation> {
        if !model::supported() {
            return Err(code("unsupported_platform"));
        }
        let mut state = self.model.lock().unwrap();
        if action == "cancel" {
            if let Some(install) = &state.install {
                install.cancel.store(true, Ordering::Release);
            }
            return Ok(Operation {
                operation_id: state.operation_id.clone(),
            });
        }
        if !matches!(action, "install" | "repair" | "uninstall") {
            return Err(code("invalid_scope"));
        }
        if let Some(install) = &state.install {
            if action == "uninstall" {
                return Err(code("model_busy"));
            }
            return Ok(Operation {
                operation_id: Some(install.operation_id.clone()),
            });
        }
        if action == "install"
            && state.availability(&self.model_root, model::installed(&self.model_root)) == "ready"
        {
            return Ok(Operation {
                operation_id: state.operation_id.clone(),
            });
        }
        let id = ulid::Ulid::new().to_string();
        state.operation_id = Some(id.clone());
        let previous_error = state.last_error.take();
        state.downloaded = 0;
        self.text_warm.store(false, Ordering::Release);
        self.model_epoch.fetch_add(1, Ordering::AcqRel);
        if action == "uninstall" {
            index::control(&db, "disable")?;
            self.reset_queries(&app, &db);
            let mut encoder = self.encoder.lock().unwrap();
            *encoder = None;
            model::uninstall(&self.model_root).map_err(|error| {
                tracing::warn!(%error, "semantic model uninstall");
                code("model_corrupt")
            })?;
            state.corrupt = false;
            drop(state);
            self.progress(&app, &db, "download", true);
            return Ok(Operation {
                operation_id: Some(id),
            });
        }
        let install = Install {
            operation_id: id.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            previous_error,
        };
        state.install = Some(install.clone());
        drop(state);
        self.reset_queries(&app, &db);
        self.progress(&app, &db, "download", true);
        let search = self.clone();
        tauri::async_runtime::spawn(async move {
            // Never let stale mmap sessions run while downloaded files are repaired.
            let clear = search.clone();
            let dropped = tauri::async_runtime::spawn_blocking(move || {
                *clear.encoder.lock().unwrap() = None;
            })
            .await;
            let result = if dropped.is_ok() {
                model::install(&search.model_root, &install.cancel, |_, received, _| {
                    search.model.lock().unwrap().downloaded = received;
                    search.progress(&app, &db, "download", false);
                })
                .await
            } else {
                Err("语义模型会话关闭失败".into())
            };
            let mut state = search.model.lock().unwrap();
            if state
                .install
                .as_ref()
                .is_none_or(|current| current.operation_id != install.operation_id)
            {
                return;
            }
            let queue_error = if result.is_ok() {
                index::retry_model_failures(&db).err().map(wire_error)
            } else {
                None
            };
            if queue_error.as_deref() == Some("disk_full") {
                *search.worker_error.lock().unwrap() = Some("disk_full");
            }
            let completed = state.finish_install(&install, result, queue_error);
            drop(state);
            if completed {
                search.progress(&app, &db, "download", true);
            }
        });
        Ok(Operation {
            operation_id: Some(id),
        })
    }

    fn check_model(&self) -> AppResult<()> {
        if !model::supported() {
            return Err(code("unsupported_platform"));
        }
        let state = self.model.lock().unwrap();
        if state.install.is_some() {
            return Err(code("model_busy"));
        }
        if state.is_corrupt(&self.model_root) {
            return Err(code("model_corrupt"));
        }
        if !model::installed(&self.model_root) {
            return Err(code("model_missing"));
        }
        Ok(())
    }

    fn encode<T>(
        &self,
        apply: impl FnOnce(&mut model::Embedder) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut encoder = self.encoder.lock().unwrap();
        if encoder.is_none() {
            *encoder = Some(model::Embedder::load(&self.model_root)?);
        }
        apply(encoder.as_mut().unwrap())
    }

    fn note_corrupt_model(&self, epoch: u64) {
        let mut state = self.model.lock().unwrap();
        if state.install.is_none() && self.model_epoch.load(Ordering::Acquire) == epoch {
            state.corrupt = true;
            state.last_error = Some("model_corrupt".into());
            if let Err(error) = model::invalidate_ready(&self.model_root) {
                tracing::warn!(%error, "could not persist semantic model corruption");
            }
        }
    }

    fn reset_queries(&self, app: &AppHandle, db: &Database) {
        let mut queries = self.queries.lock().unwrap();
        for request in queries.active.values() {
            request.cancel.store(true, Ordering::Release);
        }
        queries.active.clear();
        queries.sessions.clear();
        drop(queries);
        let library_id = index::library_id(&db.conn.lock().unwrap());
        if let Ok(library_id) = library_id {
            let _ = app.emit("semantic://sessions-reset", SessionsReset { library_id });
        }
    }

    pub(crate) fn cancel(&self, request: Option<&str>, session: Option<&str>) {
        let mut queries = self.queries.lock().unwrap();
        if let Some(request) = request.and_then(|id| queries.active.remove(id)) {
            request.cancel.store(true, Ordering::Release);
        }
        if let Some(id) = session {
            queries.sessions.remove(id);
        }
    }

    fn begin(&self, id: &str, pane: &str) -> AppResult<Arc<AtomicBool>> {
        if id.is_empty() || pane.is_empty() || id.len() > 128 || pane.len() > 128 {
            return Err(code("invalid_scope"));
        }
        let mut queries = self.queries.lock().unwrap();
        if queries.active.contains_key(id) {
            return Err(code("invalid_scope"));
        }
        queries.active.retain(|_, request| {
            if request.pane != pane {
                return true;
            }
            request.cancel.store(true, Ordering::Release);
            false
        });
        if queries.active.len() >= MAX_SESSIONS {
            return Err(code("resource_limit"));
        }
        queries
            .sessions
            .retain(|_, session| session.last_access.elapsed() < SESSION_IDLE);
        let cancel = Arc::new(AtomicBool::new(false));
        queries.active.insert(
            id.into(),
            Request {
                pane: pane.into(),
                cancel: cancel.clone(),
            },
        );
        Ok(cancel)
    }

    pub(crate) async fn start(
        self: &Arc<Self>,
        path: PathBuf,
        request_id: String,
        pane: String,
        text: String,
        filter: CatalogFilter,
        top_k: usize,
    ) -> AppResult<SearchResponse> {
        self.check_model()?;
        let text = text.trim();
        if text.is_empty() || text.chars().take(513).count() > 512 {
            return Err(code("invalid_query"));
        }
        let text = text.to_owned();
        let filter = query::validated_filter(filter)?;
        if !(1..=query::MAX_RESULTS).contains(&top_k) {
            return Err(code("resource_limit"));
        }
        let cancel = self.begin(&request_id, &pane)?;
        let budget = if self.text_warm.load(Ordering::Acquire) {
            QUERY_DEADLINE
        } else {
            COLD_QUERY_DEADLINE
        };
        let deadline = Instant::now() + budget;
        let result = self
            .run_query(path, text, filter, top_k, cancel.clone(), deadline)
            .await;
        let mut queries = self.queries.lock().unwrap();
        let current = queries
            .active
            .get(&request_id)
            .is_some_and(|request| Arc::ptr_eq(&request.cancel, &cancel));
        if current {
            queries.active.remove(&request_id);
        }
        if !current || cancel.load(Ordering::Acquire) {
            return Err(code("cancelled"));
        }
        let snapshot = result?;
        queries.sessions.retain(|_, session| session.pane != pane);
        let session_id = ulid::Ulid::new().to_string();
        let response = SearchResponse {
            request_id,
            session_id: session_id.clone(),
            library_id: snapshot.library_id.clone(),
            model_key: snapshot.model_key.clone(),
            index_revision: snapshot.index_revision,
            eligible: snapshot.eligible,
            indexed: snapshot.indexed,
            result_count: snapshot.len(),
            truncated: snapshot.truncated,
        };
        while queries.sessions.len() >= MAX_SESSIONS {
            let oldest = queries
                .sessions
                .iter()
                .min_by_key(|(_, session)| session.last_access)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                queries.sessions.remove(&oldest);
            }
        }
        queries.sessions.insert(
            session_id,
            Session {
                pane,
                last_access: Instant::now(),
                snapshot: Arc::new(snapshot),
            },
        );
        Ok(response)
    }

    async fn run_query(
        self: &Arc<Self>,
        path: PathBuf,
        text: String,
        filter: CatalogFilter,
        top_k: usize,
        cancel: Arc<AtomicBool>,
        deadline: Instant,
    ) -> AppResult<SearchSnapshot> {
        let stop = Arc::new(QueryStop {
            cancel,
            deadline,
            expired: AtomicBool::new(false),
        });
        let permit = tokio::select! {
            permit = self.scoring.clone().acquire_owned() => permit.map_err(|_| code("resource_limit"))?,
            error = wait_stop(&stop) => return Err(error),
        };
        let engine = self.clone();
        let worker_stop = stop.clone();
        let work = tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            worker_stop.check()?;
            let epoch = engine.model_epoch.load(Ordering::Acquire);
            engine.check_model()?;
            let encoded = (|| -> AppResult<model::EncodedText> {
                let mut slot = lock_for_query(&engine.encoder, &worker_stop)?;
                if engine.model_epoch.load(Ordering::Acquire) != epoch {
                    return Err(code("cancelled"));
                }
                if slot.is_none() {
                    *slot =
                        Some(model::Embedder::load(&engine.model_root).map_err(AppError::Other)?);
                }
                let encoder = slot.as_mut().unwrap();
                worker_stop.check()?;
                encoder.prepare_text().map_err(AppError::Other)?;
                worker_stop.check()?;
                encoder.embed_text(&text).map_err(AppError::Other)
            })();
            worker_stop.check()?;
            if engine.model_epoch.load(Ordering::Acquire) != epoch {
                return Err(code("cancelled"));
            }
            let encoded = encoded.map_err(|error| {
                tracing::warn!(%error, "semantic text encoder failed");
                engine.note_corrupt_model(epoch);
                code("model_corrupt")
            })?;
            engine.text_warm.store(true, Ordering::Release);
            let score_deadline = deadline.min(Instant::now() + QUERY_DEADLINE);
            query::search(
                &path,
                filter,
                encoded.vector,
                top_k,
                encoded.truncated,
                worker_stop.cancel.clone(),
                score_deadline,
            )
        });
        tokio::select! {
            result = work => result.map_err(|error| AppError::Other(error.to_string()))?,
            error = wait_stop(&stop) => Err(error),
        }
    }

    pub(crate) async fn read_session<T: Send + 'static>(
        &self,
        path: PathBuf,
        id: String,
        action: impl FnOnce(&SearchSnapshot, &Path) -> AppResult<T> + Send + 'static,
    ) -> AppResult<T> {
        let _permit = self
            .paging
            .acquire()
            .await
            .map_err(|_| code("resource_limit"))?;
        let snapshot = {
            let mut queries = self.queries.lock().unwrap();
            queries
                .sessions
                .retain(|_, session| session.last_access.elapsed() < SESSION_IDLE);
            let session = queries
                .sessions
                .get_mut(&id)
                .ok_or_else(|| code("stale_session"))?;
            session.last_access = Instant::now();
            session.snapshot.clone()
        };
        let result = tauri::async_runtime::spawn_blocking(move || action(&snapshot, &path))
            .await
            .map_err(|error| AppError::Other(error.to_string()))?;
        let mut queries = self.queries.lock().unwrap();
        if !queries.sessions.contains_key(&id) {
            return Err(code("stale_session"));
        }
        if matches!(&result, Err(AppError::Other(message)) if message == "stale_session") {
            queries.sessions.remove(&id);
        }
        result
    }

    pub(crate) fn watch(self: Arc<Self>, app: AppHandle, db: Arc<Database>) {
        tauri::async_runtime::spawn(async move {
            if let Err(error) = index::recover(&db) {
                tracing::warn!(%error, "semantic index recovery failed");
            }
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                if self.check_model().is_err()
                    || !self.queries.lock().unwrap().active.is_empty()
                    || self.worker_error.lock().unwrap().is_some()
                {
                    continue;
                }
                let engine = self.clone();
                let db_copy = db.clone();
                let model_epoch = self.model_epoch.load(Ordering::Acquire);
                let result = tauri::async_runtime::spawn_blocking(move || {
                    index::run_one(&db_copy, |image| {
                        if engine.model_epoch.load(Ordering::Acquire) != model_epoch
                            || engine.check_model().is_err()
                        {
                            return Err(index::EncodeFailure::Interrupted);
                        }
                        let result = engine.encode(|encoder| {
                            encoder.prepare_vision()?;
                            encoder.embed_image(image)
                        });
                        if engine.model_epoch.load(Ordering::Acquire) != model_epoch {
                            return Err(index::EncodeFailure::Interrupted);
                        }
                        result.map_err(index::EncodeFailure::Model)
                    })
                })
                .await;
                match result {
                    Ok(Ok(tick)) => {
                        if tick.model_failed {
                            self.note_corrupt_model(model_epoch);
                        }
                        if tick.invalidated {
                            let _ = app.emit("library://assets-changed", ());
                        }
                        if tick.progress {
                            self.progress(&app, &db, "index", false);
                        }
                    }
                    Ok(Err(error)) => {
                        let category = wire_error(error);
                        if category == "disk_full" {
                            *self.worker_error.lock().unwrap() = Some("disk_full");
                        }
                        self.progress(&app, &db, "index", false);
                    }
                    Err(error) => tracing::warn!(%error, "semantic index worker stopped"),
                }
            }
        });
    }
}

struct QueryStop {
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    expired: AtomicBool,
}

impl QueryStop {
    fn check(&self) -> AppResult<()> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(code("cancelled"));
        }
        if self.expired.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            self.expired.store(true, Ordering::Release);
            return Err(code("resource_limit"));
        }
        Ok(())
    }
}

fn lock_for_query<'a, T>(mutex: &'a Mutex<T>, stop: &QueryStop) -> AppResult<MutexGuard<'a, T>> {
    loop {
        stop.check()?;
        match mutex.try_lock() {
            Ok(guard) => {
                stop.check()?;
                return Ok(guard);
            }
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(10)),
            Err(TryLockError::Poisoned(error)) => return Err(AppError::Other(error.to_string())),
        }
    }
}

async fn wait_stop(stop: &QueryStop) -> AppError {
    loop {
        if let Err(error) = stop.check() {
            return error;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_errors_and_cancel_keep_corrupt_package_blocked_and_queue_paused() {
        let directory = tempfile::tempdir().unwrap();
        let engine = SemanticSearch::new(directory.path());
        std::fs::create_dir_all(&engine.model_root).unwrap();
        let marker = engine.model_root.join("model-version");
        std::fs::write(&marker, model::MODEL_ID).unwrap();
        engine.note_corrupt_model(0);
        assert!(model::known_corrupt(&engine.model_root));
        assert_eq!(
            ModelState::default().availability(&engine.model_root, true),
            "corrupt"
        );

        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        index::control(&db, "start").unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,store_path) VALUES('image','Image','png','fixture.png')", []).unwrap();
        index::control(&db, "pause").unwrap();

        let mut state = engine.model.lock().unwrap();
        for (failure, expected) in [
            ("range connection dropped", "download_failed"),
            ("disk_full", "disk_full"),
        ] {
            let repair = Install {
                operation_id: ulid::Ulid::new().to_string(),
                cancel: Arc::new(AtomicBool::new(false)),
                previous_error: state.last_error.take(),
            };
            state.install = Some(repair.clone());
            assert_eq!(state.availability(&engine.model_root, true), "downloading");
            assert!(state.finish_install(&repair, Err(failure.into()), None));
            assert_eq!(state.availability(&engine.model_root, true), "corrupt");
            assert_eq!(state.last_error.as_deref(), Some(expected));
        }

        let cancelled = Install {
            operation_id: "cancelled".into(),
            cancel: Arc::new(AtomicBool::new(true)),
            previous_error: state.last_error.take(),
        };
        state.install = Some(cancelled.clone());
        assert!(state.finish_install(&cancelled, Err("cancelled".into()), None));
        assert_eq!(state.availability(&engine.model_root, true), "corrupt");
        assert_eq!(state.last_error.as_deref(), Some("disk_full"));

        let repaired = Install {
            operation_id: "repaired".into(),
            cancel: Arc::new(AtomicBool::new(false)),
            previous_error: state.last_error.take(),
        };
        state.install = Some(repaired.clone());
        assert!(!state.finish_install(&cancelled, Err("late error".into()), None));
        assert_eq!(state.availability(&engine.model_root, true), "downloading");
        std::fs::write(marker, model::MODEL_ID).unwrap();
        assert!(state.finish_install(&repaired, Ok(()), None));
        assert_eq!(state.availability(&engine.model_root, true), "ready");
        assert_eq!(state.last_error, None);
        drop(state);

        assert_eq!(index::status(&db).unwrap().index_state, "paused");
        assert_eq!(index::status(&db).unwrap().pending, 1);
        assert!(
            !index::run_one(&db, |_| panic!("paused repair must not run inference"))
                .unwrap()
                .progress
        );
    }

    #[test]
    fn expired_search_releases_scoring_permit_without_entering_held_encoder() {
        let encoder = Arc::new(Mutex::new(false));
        let held = encoder.lock().unwrap();
        let scoring = Arc::new(Semaphore::new(1));
        let permit = scoring.clone().try_acquire_owned().unwrap();
        let lock = encoder.clone();
        let deadline = QueryStop {
            cancel: Arc::new(AtomicBool::new(false)),
            expired: AtomicBool::new(false),
            deadline: Instant::now() + Duration::from_millis(30),
        };
        let a = std::thread::spawn(move || {
            let _permit = permit;
            let error = lock_for_query(&lock, &deadline).unwrap_err();
            assert!(deadline.expired.load(Ordering::Acquire));
            assert!(!deadline.cancel.load(Ordering::Acquire));
            error.to_string()
        });
        assert_eq!(a.join().unwrap(), "resource_limit");
        assert!(!*held);
        let _next = scoring.try_acquire().unwrap();
        drop(held);
        let next = QueryStop {
            cancel: Arc::new(AtomicBool::new(false)),
            expired: AtomicBool::new(false),
            deadline: Instant::now() + Duration::from_secs(1),
        };
        *lock_for_query(&encoder, &next).unwrap() = true;
        assert!(*encoder.lock().unwrap());
    }
}
