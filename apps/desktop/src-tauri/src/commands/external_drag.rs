use crate::external_drag::session::Sessions;
use crate::{core::external_drag, db::Database, error::AppError};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{State, Webview};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DragMode {
    Hold,
    Pickup,
}

#[derive(Serialize)]
pub struct DragResult {
    dropped: bool,
}

// Native drag loops process window events while running. Keep another IPC call
// from starting a nested drag, including while the original paths are resolved.
static SESSIONS: Sessions = Sessions::new();

#[tauri::command]
pub fn cancel_pending_external_drag(
    webview: Webview,
    session_id: String,
) -> Result<bool, AppError> {
    if webview.label() != "main" {
        return Err(AppError::Other("请从素材库或画布拖出素材".into()));
    }
    Ok(SESSIONS.cancel_pending(&session_id))
}

#[tauri::command]
pub async fn start_external_drag(
    webview: Webview,
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
    mode: DragMode,
    session_id: String,
) -> Result<DragResult, AppError> {
    if webview.label() != "main" {
        return Err(AppError::Other("请从素材库或画布拖出素材".into()));
    }
    let session = SESSIONS
        .start(session_id)
        .map_err(|error| AppError::Other(error.into()))?;
    if session.intent.cancelled() {
        return Ok(DragResult { dropped: false });
    }
    let db = db.inner().clone();
    let files = tokio::task::spawn_blocking(move || external_drag::files(&db, &asset_ids))
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
    if session.intent.cancelled() {
        return Ok(DragResult { dropped: false });
    }
    let intent = session.intent.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<bool, String>>();
    let window = webview.window();
    #[cfg(target_os = "macos")]
    let source_window = window.clone();
    window
        .run_on_main_thread(move || {
            let pickup = matches!(mode, DragMode::Pickup);
            #[cfg(windows)]
            {
                let result = crate::external_drag::windows::drag(&files, pickup, || intent.begin())
                    .map(|(dropped, _)| dropped)
                    .map_err(|error| error.to_string());
                let _ = sender.send(result);
            }
            #[cfg(target_os = "macos")]
            crate::external_drag::macos::start(&source_window, &files, pickup, sender, move || {
                intent.begin()
            });
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                let _ = (files, pickup, intent);
                let _ = sender.send(Err("当前系统暂不支持拖出素材".into()));
            }
        })
        .map_err(|error| AppError::Other(error.to_string()))?;
    let dropped = receiver
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
        .map_err(AppError::Other)?;
    Ok(DragResult { dropped })
}
