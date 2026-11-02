use crate::{
    core::paths::LibraryPaths,
    db::Database,
    error::{AppError, AppResult},
    quick_transfer::{QuickTransfer, Snapshot},
};
use std::{
    net::Ipv4Addr,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn quick_transfer_addresses() -> Vec<String> {
    crate::quick_transfer::transport::available_ipv4_addresses()
        .into_iter()
        .map(|address| address.to_string())
        .collect()
}

#[tauri::command]
pub fn quick_transfer_status(state: State<'_, QuickTransfer>) -> Snapshot {
    state.snapshot()
}

#[tauri::command]
pub async fn quick_transfer_start(
    app: AppHandle,
    state: State<'_, QuickTransfer>,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    directory: String,
    address: String,
) -> AppResult<Snapshot> {
    let ip: Ipv4Addr = address
        .parse()
        .map_err(|_| AppError::Other("请选择有效的局域网地址".into()))?;
    let completed = AtomicUsize::new(0);
    let notify = Arc::new(move |snapshot: &Snapshot| {
        let _ = app.emit("quick-transfer://changed", snapshot);
        let count = snapshot
            .transfers
            .iter()
            .filter(|file| file.status == crate::quick_transfer::TransferStatus::Complete)
            .count();
        if completed.swap(count, Ordering::Relaxed) != count {
            let _ = app.emit("library://assets-changed", ());
            let _ = app.emit("external-files://changed", ());
        }
    });
    state
        .start(
            &PathBuf::from(directory),
            ip,
            paths.inner().clone(),
            db.inner().clone(),
            notify,
        )
        .await
}

#[tauri::command]
pub async fn quick_transfer_stop(state: State<'_, QuickTransfer>) -> AppResult<Snapshot> {
    state.stop().await
}

#[tauri::command]
pub async fn quick_transfer_retry(
    state: State<'_, QuickTransfer>,
    id: String,
) -> AppResult<Snapshot> {
    state.retry(id).await
}
