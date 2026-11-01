//! Visible audio waveform work is bounded independently of image previews.
use crate::{
    core::{audio, paths::LibraryPaths},
    db::Database,
    error::AppError,
};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn audio_waveform(
    app: AppHandle,
    paths: State<'_, Arc<LibraryPaths>>,
    db: State<'_, Arc<Database>>,
    asset_id: String,
    expected_version: Option<String>,
) -> Result<audio::AudioWaveform, AppError> {
    static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let permit = GATE
        .acquire()
        .await
        .map_err(|error| AppError::Other(error.to_string()))?;
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        audio::waveform(&paths, &db, &asset_id, expected_version.as_deref())
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    drop(permit);
    app.asset_protocol_scope()
        .allow_file(&result.source_path)
        .map_err(|error| AppError::Other(error.to_string()))?;
    Ok(result)
}
