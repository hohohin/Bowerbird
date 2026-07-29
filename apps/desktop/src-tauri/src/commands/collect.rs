//! 扩展采集相关命令：连接状态查询 + 扩展文件夹路径（供引导「一键复制路径」用）。
//!
//! 不再 spawn 打开 chrome://extensions / explorer——Windows 上 Chrome 单实例会丢 URL、
//! explorer 不认含 `..` 的路径兜底开「文档」，都不稳。改为返回路径，前端复制 + 教用户粘贴。

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::collect::ws_server::ExtensionStatus;
use crate::error::AppError;

/// 扩展是否已连接（最近 30s 内收过心跳 / 采集消息）。
#[tauri::command]
pub async fn extension_status(status: State<'_, ExtensionStatus>) -> Result<bool, AppError> {
    Ok(status.is_connected())
}

/// 扩展文件夹绝对路径（引导「一键复制路径」用，用户粘贴到 chrome「加载已解压」对话框地址栏）。
/// dev 走源码 `apps/extension/`、release 走内嵌 `resource_dir/extension/`。
#[tauri::command]
pub async fn extension_folder_path(app: AppHandle) -> Result<String, AppError> {
    let ext_dir: PathBuf = if cfg!(debug_assertions) {
        // dev：src-tauri → apps/desktop → apps → extension。用 parent() 拼绝对路径（不含 `..`）。
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        manifest
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.join("extension"))
            .unwrap_or_else(|| manifest.join("../../extension"))
    } else {
        // release：tauri.conf bundle.resources 内嵌的扩展副本（映射到 extension/）。
        app.path()
            .resource_dir()
            .map_err(|e| AppError::Other(format!("解析 resource_dir 失败: {e}")))?
            .join("extension")
    };
    Ok(ext_dir.to_string_lossy().to_string())
}
