//! 设置相关 Tauri commands：读取 / 更新应用设置、素材库位置迁移。

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, State, WebviewWindow};

use crate::core::migrate;
use crate::core::paths::LibraryPaths;
use crate::core::semantic_search::runtime::SemanticSearch;
use crate::core::settings::{AppSettings, SettingsState};
use crate::db::Database;
use crate::error::AppError;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsReceipt {
    semantic_index_applied: bool,
    semantic_index_error: Option<String>,
}
/// 获取当前设置快照。
#[tauri::command]
pub async fn get_settings(state: State<'_, SettingsState>) -> Result<AppSettings, AppError> {
    Ok(state.get())
}

fn save_error(error: AppError) -> AppError {
    tracing::error!(error = ?error, "settings.save_failed");
    #[cfg(windows)]
    if let AppError::Io(io) = &error {
        match io.raw_os_error() {
            Some(32 | 33) => return AppError::Other("设置文件正被占用，请稍后重试。".into()),
            Some(5) => return AppError::Other("无法写入设置文件，请检查应用数据目录的写入权限后重试。".into()),
            _ => {}
        }
    }
    error
}

#[tauri::command]
pub fn set_h3_auto_optimize(state: State<'_, SettingsState>, enabled: bool) -> Result<(), AppError> {
    state.update_with(|settings| settings.h3_auto_optimize_prompt = enabled).map_err(save_error)
}

/// 全量覆盖设置并持久化到 settings.json。
#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SettingsState>,
    db: State<'_, Arc<Database>>,
    semantic: State<'_, Arc<SemanticSearch>>,
    settings: AppSettings,
    apply_screenshot_shortcuts: Option<bool>,
) -> Result<UpdateSettingsReceipt, AppError> {
    let included_generated = state.semantic_index_preferences().include_generated;
    if apply_screenshot_shortcuts.unwrap_or(false) {
        let shortcuts = settings.screenshot_shortcuts.clone();
        super::screenshot::replace_shortcuts(&window, &app, &shortcuts, || {
            state.update_preferences(settings, true)
        })
        .map_err(AppError::Other).map_err(save_error)?;
    } else {
        state.update(settings).map_err(save_error)?;
    }
    let scope_changed = included_generated != state.semantic_index_preferences().include_generated;
    let semantic_index_error = semantic.preferences_changed(&app, &db, scope_changed);
    Ok(UpdateSettingsReceipt {
        semantic_index_applied: semantic_index_error.is_none(),
        semantic_index_error,
    })
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
