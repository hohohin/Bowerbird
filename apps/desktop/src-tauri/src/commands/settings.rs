//! 设置相关 Tauri commands：读取 / 更新应用设置、素材库位置迁移。

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, State};

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
    state.update(settings)
}

/// 当前素材库根目录（images / thumbnails / library.db 所在地）。
#[tauri::command]
pub async fn library_root(paths: State<'_, Arc<LibraryPaths>>) -> Result<String, AppError> {
    Ok(paths.inner().root.to_string_lossy().into_owned())
}

/// 记录迁移意图。重启后、所有写入者启动前，校验并复制原库。
#[tauri::command]
pub async fn migrate_library_root(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    settings: State<'_, SettingsState>,
    new_root: String,
) -> Result<(), AppError> {
    #[cfg(debug_assertions)]
    if std::env::var_os("BOWERBIRD_LIBRARY_ROOT_OVERRIDE").is_some() {
        return Err(AppError::Other("隔离预览中的索引库不能修改正式迁移设置".into()));
    }
    migrate::schedule(&db, &paths, &settings, Path::new(&new_root))
}

/// 重启应用（迁移等需要重载库路径的场景）。`app.restart()` 返回 `!`，永不返回。
#[tauri::command]
pub async fn restart_app(app: AppHandle) -> Result<(), AppError> {
    app.restart()
}
