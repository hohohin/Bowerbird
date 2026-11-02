//! Explicit, local-only receive sessions; no listener is started during application setup.
pub mod transport;

use crate::{
    core::{
        paths::LibraryPaths,
        quick_transfer::{QuickTransferStore, UploadState, ALLOWED_EXTENSIONS},
    },
    db::Database,
    error::{AppError, AppResult},
};
use serde::Serialize;
use std::{
    net::Ipv4Addr,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;
use transport::{StartConfig, TransportEvent, TransportHandle};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active: bool,
    pub directory: Option<String>,
    pub url: Option<String>,
    pub transfers: Vec<Transfer>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub received: u64,
    pub status: TransferStatus,
    pub error: Option<String>,
    pub asset_id: Option<String>,
    pub retryable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Receiving,
    Indexing,
    Complete,
    Failed,
}

pub type Notify = Arc<dyn Fn(&Snapshot) + Send + Sync>;

type Store = Arc<Mutex<QuickTransferStore>>;
struct Active {
    transport: TransportHandle,
    worker: tokio::task::JoinHandle<()>,
    context: Arc<Context>,
}
struct Context {
    store: Store,
    paths: Arc<LibraryPaths>,
    db: Arc<Database>,
    view: Arc<Mutex<Snapshot>>,
    notify: Notify,
}
#[derive(Default)]
pub struct QuickTransfer {
    active: tokio::sync::Mutex<Option<Active>>,
    view: Arc<Mutex<Snapshot>>,
}
impl QuickTransfer {
    pub fn snapshot(&self) -> Snapshot {
        self.view.lock().unwrap().clone()
    }
    pub async fn start(
        &self,
        directory: &Path,
        ip: Ipv4Addr,
        paths: Arc<LibraryPaths>,
        db: Arc<Database>,
        notify: Notify,
    ) -> AppResult<Snapshot> {
        let mut active = self.active.lock().await;
        if self.snapshot().active {
            return Err(AppError::Other(
                "快传已经开启，请先关闭接收后更改位置".into(),
            ));
        }
        if let Some(previous) = active.take() {
            shutdown(previous).await;
        }
        let directory = std::fs::canonicalize(directory)?;
        let root = directory.clone();
        let store = blocking(move || QuickTransferStore::open(&root)).await?;
        let context = Arc::new(Context {
            store: Arc::new(Mutex::new(store)),
            paths,
            db,
            view: self.view.clone(),
            notify,
        });
        let transfers = context.recover().await?;
        let secret = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = mpsc::channel(64);
        let transport = transport::start(
            StartConfig {
                bind_ip: ip,
                port: 0,
                session_secret: secret.clone(),
                upload_page: None,
                allowed_extensions: ALLOWED_EXTENSIONS
                    .iter()
                    .map(|extension| (*extension).into())
                    .collect(),
            },
            tx,
        )
        .await
        .map_err(AppError::Other)?;
        let url = format!("http://{}/?pin={secret}", transport.address());
        context.update(|view| {
            *view = Snapshot {
                active: true,
                directory: Some(directory.to_string_lossy().into_owned()),
                url: Some(url),
                transfers,
            }
        });
        let worker = tokio::spawn(process_events(context.clone(), rx));
        *active = Some(Active {
            transport,
            worker,
            context,
        });
        Ok(self.snapshot())
    }
    pub async fn stop(&self) -> AppResult<Snapshot> {
        let mut active = self.active.lock().await;
        if let Some(session) = active.take() {
            shutdown(session).await;
        }
        Ok(self.snapshot())
    }
    pub async fn retry(&self, id: String) -> AppResult<Snapshot> {
        let active = self.active.lock().await;
        let session = active
            .as_ref()
            .ok_or_else(|| AppError::Other("请先在原收件目录开启快传，再重试入库".into()))?;
        if !self
            .snapshot()
            .transfers
            .iter()
            .any(|file| file.id == id && file.retryable)
        {
            return Err(AppError::Other(
                "此文件不能重试入库，请从发送设备重新发送".into(),
            ));
        }
        session.context.index(id).await;
        Ok(self.snapshot())
    }
}

async fn shutdown(active: Active) {
    active.transport.stop().await;
    let _ = active.worker.await;
    active.context.stopped();
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}
impl Context {
    fn update(&self, update: impl FnOnce(&mut Snapshot)) {
        let snapshot = {
            let mut view = self.view.lock().unwrap();
            update(&mut view);
            view.clone()
        };
        (self.notify)(&snapshot);
    }
    fn update_file(&self, id: &str, update: impl FnOnce(&mut Transfer)) {
        self.update(|view| {
            if let Some(file) = view.transfers.iter_mut().find(|file| file.id == id) {
                update(file);
            }
        });
    }
    fn stopped(&self) {
        self.update(|view| {
            view.active = false;
            view.url = None;
            for file in &mut view.transfers {
                if file.status == TransferStatus::Receiving {
                    file.status = TransferStatus::Failed;
                    file.error = Some("接收已关闭，请重新发送未完成的文件".into());
                }
            }
        });
    }
    async fn recover(&self) -> AppResult<Vec<Transfer>> {
        let (store, paths, db) = (self.store.clone(), self.paths.clone(), self.db.clone());
        let _gate = crate::commands::folder_connections::GATE
            .acquire()
            .await
            .map_err(|e| AppError::Other(e.to_string()))?;
        blocking(move || {
            let mut store = store.lock().unwrap();
            let pending = store
                .records()
                .into_iter()
                .filter(|record| record.state != UploadState::Indexed)
                .collect::<Vec<_>>();
            let mut transfers = Vec::new();
            for record in pending {
                if record.state == UploadState::Receiving {
                    store.cancel(&record.id)?;
                    continue;
                }
                let mut file = Transfer {
                    id: record.id.clone(),
                    name: record.file_name,
                    size: record.size,
                    received: record.size,
                    status: TransferStatus::Indexing,
                    error: None,
                    asset_id: None,
                    retryable: false,
                };
                apply_result(
                    &mut file,
                    store
                        .complete(&record.id, &paths, &db)
                        .map(|asset| asset.id),
                );
                transfers.push(file);
            }
            Ok(transfers)
        })
        .await
    }
    async fn prepare(
        &self,
        id: String,
        name: String,
        size: u64,
    ) -> Result<std::path::PathBuf, String> {
        let store = self.store.clone();
        let record = blocking(move || store.lock().unwrap().prepare(&id, &name, size))
            .await
            .map_err(|error| error.to_string())?;
        let path = record.staging_path;
        self.update(|view| {
            view.transfers.push(Transfer {
                id: record.id,
                name: record.file_name,
                size,
                received: 0,
                status: TransferStatus::Receiving,
                error: None,
                asset_id: None,
                retryable: false,
            })
        });
        Ok(path)
    }
    async fn received(&self, id: &str) -> AppResult<()> {
        let (store, key) = (self.store.clone(), id.to_owned());
        blocking(move || store.lock().unwrap().mark_received(&key)).await?;
        self.update_file(id, |file| {
            file.received = file.size;
            file.status = TransferStatus::Indexing;
        });
        Ok(())
    }
    async fn index(&self, id: String) {
        self.update_file(&id, |file| {
            file.status = TransferStatus::Indexing;
            file.error = None;
        });
        let (store, paths, db, key) = (
            self.store.clone(),
            self.paths.clone(),
            self.db.clone(),
            id.clone(),
        );
        let result = match crate::commands::folder_connections::GATE.acquire().await {
            Ok(_gate) => {
                blocking(move || {
                    store
                        .lock()
                        .unwrap()
                        .complete(&key, &paths, &db)
                        .map(|asset| asset.id)
                })
                .await
            }
            Err(error) => Err(AppError::Other(error.to_string())),
        };
        self.update_file(&id, |file| apply_result(file, result));
    }
    async fn failed(&self, id: String, message: String) {
        let (store, key) = (self.store.clone(), id.clone());
        let interrupted = blocking(move || {
            let mut store = store.lock().unwrap();
            // A network cancellation cannot revoke a durable receipt or a completed import.
            if store
                .records()
                .iter()
                .any(|record| record.id == key && record.state != UploadState::Receiving)
            {
                return Ok(false);
            }
            store.cancel(&key)?;
            Ok(true)
        })
        .await;
        match interrupted {
            Ok(false) => return,
            Err(error) => tracing::warn!("quick transfer partial cleanup: {error}"),
            Ok(true) => {}
        }
        self.update_file(&id, |file| {
            file.status = TransferStatus::Failed;
            file.error = Some(message);
        });
    }
}
fn apply_result(file: &mut Transfer, result: AppResult<String>) {
    match result {
        Ok(asset_id) => {
            file.status = TransferStatus::Complete;
            file.received = file.size;
            file.asset_id = Some(asset_id);
            file.error = None;
            file.retryable = false;
        }
        Err(error) => {
            tracing::warn!("quick transfer indexing: {error}");
            file.status = TransferStatus::Failed;
            file.error = Some("文件已收到，暂未入库。请重试入库。".into());
            file.retryable = true;
        }
    }
}
async fn process_events(context: Arc<Context>, mut events: mpsc::Receiver<TransportEvent>) {
    while let Some(event) = events.recv().await {
        match event {
            TransportEvent::Prepare {
                id,
                file_name,
                size,
                reply,
            } => {
                let _ = reply.send(context.prepare(id, file_name, size).await);
            }
            TransportEvent::Progress { id, received_bytes } => context.update_file(&id, |file| {
                if file.status == TransferStatus::Receiving {
                    file.received = received_bytes.min(file.size);
                }
            }),
            TransportEvent::Received { id, reply } => {
                let result = context.received(&id).await;
                let accepted = result.is_ok();
                let _ = reply.send(result.map_err(|error| error.to_string()));
                if accepted {
                    context.index(id).await;
                }
            }
            TransportEvent::Failed { id, message } => context.failed(id, message).await,
            TransportEvent::Stopped => {
                context.stopped();
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests;
