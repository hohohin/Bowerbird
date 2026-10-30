use crate::error::AppError;

/// A pasted filesystem item remains an original; bitmap-only clipboard content
/// can instead use the first-save pipeline. Read only during an explicit paste.
#[tauri::command]
pub async fn clipboard_file_paths() -> Result<Vec<String>, AppError> {
    tokio::task::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|error| AppError::Other(format!("无法读取剪贴板，请重试：{error}")))?;
        match clipboard.get().file_list() {
            Ok(paths) => Ok(paths.into_iter().map(|path| path.to_string_lossy().into_owned()).collect()),
            Err(arboard::Error::ContentNotAvailable) => Ok(Vec::new()),
            Err(error) => Err(AppError::Other(format!("无法读取剪贴板文件位置，请使用建立连接：{error}"))),
        }
    }).await.map_err(|error| AppError::Other(error.to_string()))?
}
