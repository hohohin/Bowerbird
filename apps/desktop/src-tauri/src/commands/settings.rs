//! 设置相关 Tauri commands：读取 / 更新应用设置、素材库位置迁移。

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::core::migrate;
use crate::core::paths::LibraryPaths;
use crate::core::settings::{AppSettings, SettingsState};
use crate::db::Database;
use crate::error::AppError;
/// 获取当前设置快照。
#[tauri::command]
pub async fn get_settings(state: State<'_, SettingsState>) -> Result<AppSettings, AppError> {
    Ok(state.get())
}

/// 全量覆盖设置并持久化到 settings.json。
#[tauri::command]
pub async fn update_settings(
    state: State<'_, SettingsState>,
    settings: AppSettings,
) -> Result<(), AppError> {
    state.update(settings)?;
    Ok(())
}

/// 当前素材库根目录（images / thumbnails / library.db 所在地）。
#[tauri::command]
pub async fn library_root(paths: State<'_, Arc<LibraryPaths>>) -> Result<String, AppError> {
    Ok(paths.inner().root.to_string_lossy().into_owned())
}

/// 把素材库整体迁移到新根目录（复制媒体 + 一致性 DB 快照 + 改写路径前缀 + 记录设置）。
/// 迁移完成后由前端调用 `restart_app` 重启生效；旧根目录残留由下次启动清理。
#[tauri::command]
pub async fn migrate_library_root(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    settings: State<'_, SettingsState>,
    new_root: String,
) -> Result<(), AppError> {
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    let settings = settings.inner().clone();
    let app_for_progress = app.clone();
    // 进度事件经 library://migrate-progress 推给前端；按 50 文件节流避免淹没 IPC。
    let mut progress = move |stage: &str, done: u64, total: u64| {
        if done % 50 == 0 || done == total {
            let _ = app_for_progress.emit(
                "library://migrate-progress",
                crate::core::migrate::MigrateProgress {
                    stage: stage.to_string(),
                    done,
                    total,
                },
            );
        }
    };
    let new_root_value = tokio::task::spawn_blocking(move || {
        migrate::migrate_library(&db, &paths, Path::new(&new_root), &mut progress)
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    // 记录新根，重启后 lib.rs 据此切换库路径。
    let mut next = settings.get();
    next.library_root = Some(new_root_value);
    settings.update(next)?;
    Ok(())
}

/// 重启应用（迁移等需要重载库路径的场景）。`app.restart()` 返回 `!`，永不返回。
#[tauri::command]
pub async fn restart_app(app: AppHandle) -> Result<(), AppError> {
    app.restart()
}
