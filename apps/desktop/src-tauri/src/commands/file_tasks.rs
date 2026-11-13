//! In-process file operations. Closing a window never abandons a filesystem mutation.
use super::folder_connections::GATE;
use crate::{
    core::folder_connections::AssetOriginal,
    db::Database,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, Semaphore, SemaphorePermit};

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum FileRequest {
    Delete {
        originals: Vec<AssetOriginal>,
    },
    MoveOriginals {
        originals: Vec<AssetOriginal>,
        folder_id: String,
    },
    Add {
        ids: Vec<String>,
        folder_id: String,
    },
    Move {
        ids: Vec<String>,
        folder_id: String,
        #[serde(default)]
        versions: BTreeMap<String, String>,
    },
}

impl FileRequest {
    fn retain(&mut self, mut keep: impl FnMut(&str) -> bool) {
        match self {
            Self::Delete { originals } | Self::MoveOriginals { originals, .. } => originals.retain(|original| keep(&original.asset_id)),
            Self::Add { ids, .. } | Self::Move { ids, .. } => ids.retain(|id| keep(id)),
        }
        if let Self::Move { ids, versions, .. } = self {
            let keep: HashSet<_> = ids.iter().collect();
            versions.retain(|id, _| keep.contains(id));
        }
    }

    fn normalize(&mut self) {
        let mut seen = HashSet::new();
        match self {
            Self::Delete { originals } | Self::MoveOriginals { originals, .. } => originals.retain(|o| seen.insert(o.path.clone())),
            _ => self.retain(|id| seen.insert(id.to_owned())),
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Delete { originals } | Self::MoveOriginals { originals, .. } => originals.len(),
            Self::Add { ids, .. } | Self::Move { ids, .. } => ids.len(),
        }
    }

    fn identity(&self, index: usize) -> (&str, &str) {
        match self {
            Self::Delete { originals } | Self::MoveOriginals { originals, .. } => (&originals[index].asset_id, &originals[index].name),
            Self::Add { ids, .. } | Self::Move { ids, .. } => (&ids[index], &ids[index]),
        }
    }

    fn apply(&self, index: usize, db: &Database) -> AppResult<bool> {
        match self {
            Self::Delete { originals } => db.apply_original_removal(&originals[index]),
            Self::MoveOriginals { originals, folder_id } => db.move_asset_original(&originals[index], folder_id),
            Self::Add { ids, folder_id } => db.add_material_reference(&ids[index], folder_id),
            Self::Move {
                ids,
                folder_id,
                versions,
            } => db.move_connection_entry_verified(
                &ids[index],
                folder_id,
                versions.get(&ids[index]).map(String::as_str),
            ),
        }
    }
}

#[derive(Clone, Serialize)]
struct Failure {
    id: String,
    label: String,
    message: String,
    retryable: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Running,
    Stopping,
    Finished,
    Cancelled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    id: String,
    title: String,
    phase: Phase,
    total: usize,
    completed: usize,
    succeeded: usize,
    skipped: usize,
    recycled: usize,
    cleaned: usize,
    failures: Vec<Failure>,
    retry_id: Option<String>,
}

impl FileStatus {
    fn terminal(&self) -> bool {
        matches!(self.phase, Phase::Finished | Phase::Cancelled)
    }
}

struct Task {
    request: FileRequest,
    status: Mutex<FileStatus>,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
pub struct FileTasks(Mutex<Registry>);

#[derive(Default)]
struct Registry {
    tasks: Vec<Arc<Task>>,
    // Keep small receipts even after the user dismisses the result. A replay of an
    // accepted id must never start another destructive action within this session.
    receipts: HashMap<String, [u8; 32]>,
}

fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}

impl Registry {
    fn find(&self, id: &str) -> AppResult<&Arc<Task>> {
        self.tasks
            .iter()
            .find(|task| task.status.lock().unwrap().id == id)
            .ok_or_else(|| invalid("文件任务已结束，请刷新任务列表。"))
    }

    fn register(
        &mut self,
        id: String,
        title: String,
        mut request: FileRequest,
    ) -> AppResult<Option<Arc<Task>>> {
        use sha2::{Digest, Sha256};
        if id.is_empty() || id.len() > 128 {
            return Err(invalid("文件任务标识无效，请重新确认。"));
        }
        request.normalize();
        let total = request.len();
        if total == 0 {
            return Err(invalid("请选择需要操作的文件。"));
        }
        let signature: [u8; 32] = Sha256::digest(serde_json::to_vec(&request)?).into();
        if let Some(previous) = self.receipts.get(&id) {
            return if *previous == signature {
                Ok(None)
            } else {
                Err(invalid("文件任务内容已变化，请重新确认。"))
            };
        }
        self.receipts.insert(id.clone(), signature);
        let task = Arc::new(Task {
            request,
            status: Mutex::new(FileStatus {
                id,
                title,
                phase: Phase::Running,
                total,
                completed: 0,
                succeeded: 0,
                skipped: 0,
                recycled: 0,
                cleaned: 0,
                failures: Vec::new(),
                retry_id: None,
            }),
            cancel: watch::channel(false).0,
        });
        self.tasks.push(task.clone());
        Ok(Some(task))
    }

    fn retry(&mut self, id: &str, new_id: String) -> AppResult<Option<Arc<Task>>> {
        let original = self.find(id)?.clone();
        let mut status = original.status.lock().unwrap();
        if !status.terminal() {
            return Err(invalid("请等待当前文件任务结束。"));
        }
        if status.retry_id.is_some() {
            return Ok(None);
        }
        let failed: HashSet<_> = status
            .failures
            .iter()
            .filter(|f| f.retryable)
            .map(|f| f.id.as_str())
            .collect();
        let mut request = original.request.clone();
        request.retain(|id| failed.contains(id));
        let task = self.register(new_id.clone(), status.title.clone(), request)?;
        status.retry_id = Some(new_id);
        Ok(task)
    }
}

async fn permission<'a>(
    gate: &'a Semaphore,
    cancel: &mut watch::Receiver<bool>,
) -> Option<SemaphorePermit<'a>> {
    if *cancel.borrow() {
        return None;
    }
    tokio::select! {
        biased;
        _ = cancel.changed() => None,
        result = gate.acquire() => result.ok(),
    }
}

fn notify_changes(app: &AppHandle) {
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("external-files://changed", ());
    let _ = app.emit("projects://changed", ());
}

fn launch(app: AppHandle, db: Arc<Database>, task: Option<Arc<Task>>) {
    let Some(task) = task else {
        return;
    };
    let _ = app.emit("file-tasks://changed", ());
    tauri::async_runtime::spawn(async move {
        run_items(
            task,
            &GATE,
            move |request, index| request.apply(index, &db),
            || notify_changes(&app),
        )
        .await;
        let _ = app.emit("file-tasks://changed", ());
    });
}

async fn run_items(
    task: Arc<Task>,
    gate: &Semaphore,
    apply: impl Fn(&FileRequest, usize) -> AppResult<bool> + Send + Sync + 'static,
    changed: impl Fn(),
) {
    let apply = Arc::new(apply);
    let mut cancel = task.cancel.subscribe();
    let mut last_notice = Instant::now();
    let mut dirty = false;
    for index in 0..task.request.len() {
        let waiting = Instant::now();
        let Some(permit) = permission(gate, &mut cancel).await else {
            break;
        };
        if *cancel.borrow() {
            break;
        }
        let gate_wait_ms = waiting.elapsed().as_millis() as u64;
        let started = Instant::now();
        let worker = task.clone();
        let operation = apply.clone();
        // Once admitted, only the worker may finish this item. Never abort it
        // or give the scan gate back while a physical operation is in flight.
        let result =
            tauri::async_runtime::spawn_blocking(move || operation(&worker.request, index))
                .await
                .unwrap_or_else(|error| {
                    tracing::error!("file task worker ended unexpectedly: {error}");
                    Err(AppError::FileOperationNeedsReview(
                        "文件操作意外中断，请核对磁盘和文件夹列表。".into(),
                    ))
                });
        drop(permit);
        tracing::debug!(
            gate_wait_ms,
            operation_ms = started.elapsed().as_millis() as u64,
            index,
            "file task item"
        );
        {
            let mut status = task.status.lock().unwrap();
            status.completed += 1;
            match result {
                Ok(true) => {
                    dirty = true;
                    status.succeeded += 1;
                    if let FileRequest::Delete { originals } = &task.request {
                        if originals[index].missing {
                            status.cleaned += 1;
                        } else {
                            status.recycled += 1;
                        }
                    }
                }
                Ok(false) => status.skipped += 1,
                Err(error) => {
                    let retryable = !matches!(error, AppError::FileOperationNeedsReview(_));
                    dirty |= !retryable;
                    let (id, label) = task.request.identity(index);
                    tracing::warn!(task_id = %status.id, index, %error, "file task item failed");
                    status.failures.push(Failure {
                        id: id.into(),
                        label: label.into(),
                        message: error.to_string(),
                        retryable,
                    });
                }
            }
        }
        if dirty && last_notice.elapsed() >= Duration::from_secs(1) {
            changed();
            dirty = false;
            last_notice = Instant::now();
        }
    }
    {
        let mut status = task.status.lock().unwrap();
        status.phase = if status.completed == status.total {
            Phase::Finished
        } else {
            Phase::Cancelled
        };
    }
    if dirty {
        changed();
    }
}

#[tauri::command]
pub async fn start_file_task(
    app: AppHandle,
    tasks: State<'_, FileTasks>,
    db: State<'_, Arc<Database>>,
    id: String,
    title: String,
    request: FileRequest,
) -> AppResult<()> {
    let task = tasks.0.lock().unwrap().register(id, title, request)?;
    launch(app, db.inner().clone(), task);
    Ok(())
}

#[tauri::command]
pub async fn list_file_tasks(tasks: State<'_, FileTasks>) -> AppResult<Vec<FileStatus>> {
    Ok(tasks
        .0
        .lock()
        .unwrap()
        .tasks
        .iter()
        .map(|task| task.status.lock().unwrap().clone())
        .collect())
}

#[tauri::command]
pub async fn cancel_file_task(tasks: State<'_, FileTasks>, id: String) -> AppResult<()> {
    let registry = tasks.0.lock().unwrap();
    let task = registry.find(&id)?;
    let mut status = task.status.lock().unwrap();
    if !status.terminal() {
        status.phase = Phase::Stopping;
        task.cancel.send_replace(true);
    }
    Ok(())
}

#[tauri::command]
pub async fn retry_file_task(
    app: AppHandle,
    tasks: State<'_, FileTasks>,
    db: State<'_, Arc<Database>>,
    id: String,
    new_id: String,
) -> AppResult<()> {
    let task = tasks.0.lock().unwrap().retry(&id, new_id)?;
    launch(app, db.inner().clone(), task);
    Ok(())
}

#[tauri::command]
pub async fn dismiss_file_task(tasks: State<'_, FileTasks>, id: String) -> AppResult<()> {
    tasks.0.lock().unwrap().tasks.retain(|task| {
        let status = task.status.lock().unwrap();
        status.id != id || !status.terminal()
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> FileRequest {
        FileRequest::Move {
            ids: ["a", "b", "b", "c", "d"].map(str::to_owned).to_vec(),
            folder_id: "destination".into(),
            versions: [("b".to_owned(), "version-of-b".to_owned())].into(),
        }
    }
    fn register(registry: &mut Registry) -> Arc<Task> {
        registry
            .register("original".into(), "移动".into(), request())
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn mixed_results_retry_only_safe_failures_and_rejoin_original_receipt() {
        let mut registry = Registry::default();
        let task = register(&mut registry);
        assert!(registry
            .register("original".into(), "移动".into(), request())
            .unwrap()
            .is_none());
        let mut different = request();
        different.retain(|id| id != "a");
        assert!(registry
            .register("original".into(), "移动".into(), different)
            .is_err());
        run_items(
            task.clone(),
            &Semaphore::new(1),
            |_, index| match index {
                0 => Ok(true),
                1 => Err(invalid("普通错误")),
                2 => Err(AppError::FileOperationNeedsReview("核对磁盘".into())),
                _ => Ok(false),
            },
            || (),
        )
        .await;
        {
            let status = task.status.lock().unwrap();
            assert_eq!(
                (
                    status.completed,
                    status.succeeded,
                    status.skipped,
                    status.failures.len()
                ),
                (4, 1, 1, 2)
            );
            assert!(status.terminal());
        }
        let retry = registry.retry("original", "retry".into()).unwrap().unwrap();
        assert_eq!(retry.request.len(), 1);
        assert_eq!(retry.request.identity(0).0, "b");
        assert!(registry
            .retry("original", "retry2".into())
            .unwrap()
            .is_none());
        registry.tasks.clear();
        assert!(registry
            .register("original".into(), "移动".into(), request())
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn desktop_requests_reconcile_with_disk_and_reopened_sqlite() {
        use crate::core::{file_workspace::FileWorkspace, paths::LibraryPaths};
        use serde_json::json;
        use std::fs;
        async fn execute(task: Arc<Task>, db: &Arc<Database>) -> FileStatus {
            let db = db.clone();
            run_items(
                task.clone(),
                &Semaphore::new(1),
                move |request, index| request.apply(index, &db),
                || (),
            )
            .await;
            let status = task.status.lock().unwrap().clone();
            assert!(matches!(status.phase, Phase::Finished));
            status
        }
        let temp = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(temp.path().join("index")).unwrap();
        let db = Arc::new(Database::open(&paths.db).unwrap());
        db.migrate().unwrap();
        let files = FileWorkspace::open(
            temp.path().join("files.json"),
            temp.path().join("BowerbirdLibrary"),
        )
        .unwrap();
        let create = |name| {
            db.create_connected_directory(&files, None, None, name, None)
                .unwrap()
        };
        let source = create("source");
        let references = create("references");
        let destination = create("destination");
        let root = files.proposed_root();
        let original_path = root.join("source/note.txt");
        fs::write(&original_path, "move this file").unwrap();
        db.scan_connection(&paths, &source).unwrap();
        let source_ids = db
            .connection_entry_ids(Some(&source), None, None, 0, 10)
            .unwrap();
        let entry = db.read_connection_entries(&source_ids).unwrap().remove(0);
        let asset_id = &entry.asset_id;
        let mut registry = Registry::default();
        fn register_json(registry: &mut Registry, id: &str, value: serde_json::Value) -> Arc<Task> {
            let request = serde_json::from_value(value).unwrap();
            registry
                .register(id.into(), "测试".into(), request)
                .unwrap()
                .unwrap()
        }
        let add = register_json(
            &mut registry,
            "add",
            json!({
                "kind":"add", "folderId":references, "ids":[asset_id,"absent-record",asset_id]
            }),
        );
        let status = execute(add, &db).await;
        assert_eq!(
            (status.total, status.succeeded, status.failures.len()),
            (2, 1, 1)
        );
        let retry = registry.retry("add", "retry".into()).unwrap().unwrap();
        assert!(registry
            .retry("add", "another-retry".into())
            .unwrap()
            .is_none());
        assert_eq!(execute(retry, &db).await.total, 1);
        let reference_path = root.join("references/note.txt.bowerbird");
        assert!(reference_path.is_file());
        assert_eq!(fs::read_dir(root.join("references")).unwrap().count(), 1);

        let movement = register_json(
            &mut registry,
            "move",
            json!({
                "kind":"move", "folderId":destination, "ids":[entry.id],
                "versions":{(entry.id.clone()):entry.version.unwrap()}
            }),
        );
        assert_eq!(execute(movement, &db).await.succeeded, 1);
        let moved = root.join("destination/note.txt");
        assert!(!original_path.exists());
        assert_eq!(fs::read_to_string(&moved).unwrap(), "move this file");
        let reference: serde_json::Value =
            serde_json::from_slice(&fs::read(&reference_path).unwrap()).unwrap();
        assert_eq!(
            fs::canonicalize(reference["targetPath"].as_str().unwrap()).unwrap(),
            fs::canonicalize(&moved).unwrap()
        );

        let selected = db.preview_asset_originals(std::slice::from_ref(asset_id)).unwrap().remove(0);
        let mut missing = selected.clone();
        missing.asset_id = "unavailable".into();
        missing.path = root.join("missing.txt").to_string_lossy().into();
        missing.missing = true;
        let movement = json!({"kind":"moveoriginals","folderId":source,"originals":[missing,selected,selected]});
        let cancelled = register_json(&mut registry, "stop-before-move", movement.clone());
        cancelled.cancel.send_replace(true);
        run_items(cancelled.clone(), &Semaphore::new(1), |_,_| panic!("cancelled move executed"), || ()).await;
        assert_eq!(cancelled.status.lock().unwrap().completed, 0);
        assert!(moved.is_file());
        let status = execute(register_json(&mut registry, "move-originals", movement), &db).await;
        assert_eq!((status.total, status.succeeded, status.failures.len()), (2, 1, 1));
        assert_eq!(status.failures[0].id, missing.asset_id);
        assert_eq!(fs::read_to_string(&original_path).unwrap(), "move this file");
        assert!(!moved.exists());
        assert_eq!(db.read_connection_entries(&[entry.id]).unwrap()[0].folder_id, source);
        fs::remove_file(&original_path).unwrap();
        let originals = db
            .preview_asset_originals(std::slice::from_ref(asset_id))
            .unwrap();
        assert!(originals[0].missing);
        let request = json!({"kind":"delete","originals":originals});
        let cleanup = register_json(&mut registry, "clean", request.clone());
        assert_eq!(execute(cleanup, &db).await.cleaned, 1);
        let already_clean = register_json(&mut registry, "old-selection", request);
        let status = execute(already_clean, &db).await;
        assert_eq!((status.skipped, status.cleaned, status.recycled), (1, 0, 0));
        drop(db);
        let reopened = Database::open(&paths.db).unwrap();
        assert!(reopened.get_asset(asset_id).unwrap().is_some());
        let removed: bool = reopened
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM removed_missing_asset_originals WHERE asset_id=?1)",
                [asset_id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(removed && reference_path.is_file());
        assert!(reopened
            .connection_entry_ids(Some(&destination), None, None, 0, 10)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn cancellation_while_queued_does_not_need_file_gate() {
        let task = register(&mut Registry::default());
        let gate = Semaphore::new(0);
        let worker = run_items(
            task.clone(),
            &gate,
            |_, _| panic!("queued item mutated"),
            || (),
        );
        tokio::pin!(worker);
        tokio::select! { biased; _ = &mut worker => panic!("task did not wait for gate"), _ = tokio::task::yield_now() => {} }
        task.cancel.send_replace(true);
        tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap();
        let status = task.status.lock().unwrap();
        assert!(matches!(status.phase, Phase::Cancelled));
        assert_eq!(status.completed, 0);
    }

    #[tokio::test]
    async fn cancel_in_flight_finishes_item_holding_gate_and_skips_remaining() {
        let task = register(&mut Registry::default());
        let gate = Semaphore::new(1);
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let release = Mutex::new(release_rx);
        let worker = run_items(
            task.clone(),
            &gate,
            move |_, index| {
                assert_eq!(index, 0);
                entered_tx.send(()).unwrap();
                release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                Ok(true)
            },
            || (),
        );
        tokio::pin!(worker);
        tokio::select! { _ = &mut worker => panic!("worker returned early"), _ = entered_rx.recv() => {} }
        task.cancel.send_replace(true);
        assert_eq!(gate.available_permits(), 0);
        release_tx.send(()).unwrap();
        worker.await;
        let status = task.status.lock().unwrap();
        assert_eq!((status.completed, status.succeeded), (1, 1));
        assert!(matches!(status.phase, Phase::Cancelled));
        assert_eq!(gate.available_permits(), 1);
    }
}
