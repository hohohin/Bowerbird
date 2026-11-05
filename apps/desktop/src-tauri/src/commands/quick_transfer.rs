use crate::{
    core::{file_workspace::FileWorkspace, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
    quick_transfer::{QuickTransfer, Snapshot},
};
use std::{
    fs,
    net::Ipv4Addr,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};

fn receive_directory(files: &FileWorkspace) -> PathBuf {
    files.proposed_root().join("快传")
}

fn prepare_receive_directory(files: &FileWorkspace) -> AppResult<PathBuf> {
    let root = files.ensure_root()?;
    let directory = root.join("快传");
    fs::create_dir(&directory).or_else(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Ok(())
        } else {
            Err(error)
        }
    })?;
    let metadata = fs::symlink_metadata(&directory)?;
    let canonical = fs::canonicalize(&directory)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || canonical.parent() != Some(root.as_path())
    {
        return Err(AppError::Other(
            "快传目录不可用，请检查资料文件夹中的同名文件或链接".into(),
        ));
    }
    Ok(canonical)
}

#[tauri::command]
pub fn quick_transfer_directory(files: State<'_, Arc<FileWorkspace>>) -> String {
    receive_directory(&files).to_string_lossy().into_owned()
}

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
    files: State<'_, Arc<FileWorkspace>>,
    address: String,
) -> AppResult<Snapshot> {
    let ip: Ipv4Addr = address
        .parse()
        .map_err(|_| AppError::Other("请选择有效的局域网地址".into()))?;
    let files = files.inner().clone();
    let directory = tauri::async_runtime::spawn_blocking(move || prepare_receive_directory(&files))
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
    app.asset_protocol_scope()
        .allow_directory(&directory, true)
        .map_err(|error| AppError::Other(error.to_string()))?;
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
            &directory,
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
pub async fn quick_transfer_send_start(app: AppHandle, state: State<'_, QuickTransfer>, address: String, files: Vec<PathBuf>) -> AppResult<Snapshot> {
    let ip = address.parse().map_err(|_| AppError::Other("请选择有效的局域网地址".into()))?;
    state.start_send(ip, files, Arc::new(move |snapshot| { let _ = app.emit("quick-transfer://changed", snapshot); })).await
}

#[tauri::command]
pub async fn quick_transfer_send_stop(state: State<'_, QuickTransfer>) -> AppResult<Snapshot> {
    state.stop_send().await
}

#[tauri::command]
pub async fn quick_transfer_retry(
    state: State<'_, QuickTransfer>,
    id: String,
) -> AppResult<Snapshot> {
    state.retry(id).await
}

#[cfg(test)]
#[path = "quick_transfer_tests.rs"]
mod tests;
