use crate::{
    core::{
        file_workspace::FileWorkspace,
        folder_connections::{connection_root_readable, registered_path_spelling},
        paths::LibraryPaths,
        settings::{QuickTransferDefaultFolder, SettingsState},
    },
    db::Database,
    error::{AppError, AppResult},
    quick_transfer::{QuickTransfer, QuickTransferDestination, ReceiveDestination, Snapshot},
};
use std::{
    fs,
    net::Ipv4Addr,
    path::{Path, PathBuf},
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
pub async fn quick_transfer_preview_destination(
    files: State<'_, Arc<FileWorkspace>>,
    db: State<'_, Arc<Database>>,
    destination: QuickTransferDestination,
) -> AppResult<ReceiveDestination> {
    let (files, db) = (files.inner().clone(), db.inner().clone());
    blocking(move || resolve_destination(&files, &db, destination, false)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultDestination {
    builtin: ReceiveDestination,
    effective: ReceiveDestination,
    saved_folder: Option<QuickTransferDefaultFolder>,
    warning: Option<String>,
}

#[tauri::command]
pub async fn quick_transfer_default_destination(
    files: State<'_, Arc<FileWorkspace>>,
    db: State<'_, Arc<Database>>,
    settings: State<'_, SettingsState>,
) -> AppResult<DefaultDestination> {
    let (files, db) = (files.inner().clone(), db.inner().clone());
    let saved = settings.get().quick_transfer_default_folder;
    blocking(move || Ok(default_destination(&files, &db, saved))).await
}

#[tauri::command]
pub async fn quick_transfer_set_default_folder(
    files: State<'_, Arc<FileWorkspace>>,
    db: State<'_, Arc<Database>>,
    settings: State<'_, SettingsState>,
    folder_id: Option<String>,
) -> AppResult<DefaultDestination> {
    let db = db.inner().clone();
    let builtin = builtin_destination(&files);
    let _gate = super::folder_connections::GATE.acquire().await
        .map_err(|error| AppError::Other(error.to_string()))?;
    let (saved_folder, effective) = if let Some(folder_id) = folder_id {
        let (saved, folder) = blocking(move || {
            let folder = connected_destination(&db, &folder_id)?;
            let saved = QuickTransferDefaultFolder {
                folder_id,
                name: folder.name.clone(),
                path: folder.directory.to_string_lossy().into_owned(),
            };
            Ok((saved, folder))
        }).await?;
        (Some(saved), folder)
    } else {
        (None, builtin.clone())
    };
    save_default_folder(&settings, saved_folder.clone())?;
    Ok(DefaultDestination { builtin, effective, saved_folder, warning: None })
}

fn save_default_folder(settings: &SettingsState, folder: Option<QuickTransferDefaultFolder>) -> AppResult<()> {
    settings.update_with(|settings| settings.quick_transfer_default_folder = folder)
}

fn builtin_destination(files: &FileWorkspace) -> ReceiveDestination {
    ReceiveDestination {
        target: QuickTransferDestination::Default,
        name: "默认快传".into(),
        directory: receive_directory(files),
    }
}

fn default_destination(
    files: &FileWorkspace,
    db: &Database,
    saved_folder: Option<QuickTransferDefaultFolder>,
) -> DefaultDestination {
    let builtin = builtin_destination(files);
    let mut warning = None;
    let effective = saved_folder.as_ref().map_or_else(|| builtin.clone(), |folder| {
        connected_destination(db, &folder.folder_id).unwrap_or_else(|_| {
            warning = Some(format!("默认接收文件夹「{}」不可用，已回退到默认「快传」。", folder.name));
            builtin.clone()
        })
    });
    DefaultDestination { builtin, effective, saved_folder, warning }
}

fn connected_destination(db: &Database, folder_id: &str) -> AppResult<ReceiveDestination> {
    let folder = db.connected_folder(folder_id)?;
    let root = if folder.root_id == folder.id { folder.clone() } else { db.connected_folder(&folder.root_id)? };
    let path = Path::new(&folder.path);
    let unavailable = || AppError::Other("接收文件夹不可用，请重新连接或选择可写的文件夹".into());
    if !folder.available || !root.available || !connection_root_readable(Path::new(&root.path)) {
        return Err(unavailable());
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    let canonical = fs::canonicalize(path).map_err(|_| unavailable())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink()
        || canonical != registered_path_spelling(path)
        || !canonical.starts_with(registered_path_spelling(Path::new(&root.path)))
        || fs::read_dir(path).is_err()
        || !directory_allows_writes(&canonical)
    {
        return Err(unavailable());
    }
    Ok(ReceiveDestination {
        target: QuickTransferDestination::Folder { folder_id: folder.id },
        name: if folder.name.is_empty() { folder.path } else { folder.name },
        directory: canonical,
    })
}

#[cfg(windows)]
fn directory_allows_writes(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use windows::Win32::Storage::FileSystem::{FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_FLAG_BACKUP_SEMANTICS};
    fs::OpenOptions::new()
        .access_mode(FILE_ADD_FILE.0 | FILE_ADD_SUBDIRECTORY.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
        .is_ok()
}

#[cfg(unix)]
fn directory_allows_writes(path: &Path) -> bool {
    use std::{ffi::{c_char, c_int, CString}, os::unix::ffi::OsStrExt};
    unsafe extern "C" { fn access(path: *const c_char, mode: c_int) -> c_int; }
    const W_OK: c_int = 2;
    const X_OK: c_int = 1;
    // access only checks permissions. The C string remains live for the call.
    CString::new(path.as_os_str().as_bytes()).is_ok_and(|path| unsafe {
        access(path.as_ptr(), W_OK | X_OK) == 0
    })
}

fn resolve_destination(
    files: &FileWorkspace,
    db: &Database,
    target: QuickTransferDestination,
    prepare: bool,
) -> AppResult<ReceiveDestination> {
    match &target {
        QuickTransferDestination::Default => {
            let mut destination = builtin_destination(files);
            if prepare { destination.directory = prepare_receive_directory(files)?; }
            Ok(destination)
        }
        QuickTransferDestination::Project { project_id } => {
            let project = db.get_project(project_id)?
                .ok_or_else(|| AppError::Other("接收项目已不存在，请重新选择".into()))?;
            let directory = if prepare {
                fs::canonicalize(files.project_directory(&project.id, &project.name)?)?
            } else {
                files.proposed_project_directory(&project.id, &project.name)?
            };
            Ok(ReceiveDestination { target, name: project.name, directory })
        }
        QuickTransferDestination::Folder { folder_id } => connected_destination(db, folder_id),
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
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
    destination: Option<QuickTransferDestination>,
) -> AppResult<Snapshot> {
    let ip: Ipv4Addr = address
        .parse()
        .map_err(|_| AppError::Other("请选择有效的局域网地址".into()))?;
    let (files, destination_db, scope_app) = (files.inner().clone(), db.inner().clone(), app.clone());
    let prepare = move || {
        let destination = resolve_destination(&files, &destination_db, destination.unwrap_or_default(), true)?;
        scope_app.asset_protocol_scope()
            .allow_directory(&destination.directory, true)
            .map_err(|error| AppError::Other(error.to_string()))?;
        Ok(destination)
    };
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
            prepare,
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
