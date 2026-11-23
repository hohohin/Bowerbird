use std::{
    fs::{self, File, Metadata},
    path::Path,
    sync::Arc,
    time::UNIX_EPOCH,
};

use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager, State};
use tempfile::Builder;

use super::media_trim::{self, TRIM_QUEUE};
use crate::{
    core::{external_files, ingest, library::Asset, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
    media::{
        audio,
        tools::{self, Tool},
    },
};

#[tauri::command]
pub async fn trim_audio(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    source_path: String,
    start: f64,
    end: f64,
    overwrite: bool,
    project_id: Option<String>,
) -> AppResult<Asset> {
    let permit = TRIM_QUEUE
        .try_acquire()
        .map_err(|_| AppError::Other("另一个裁剪正在保存，请稍后重试".into()))?;
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    let asset = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        trim(&db, &paths, &source_path, start, end, overwrite, project_id.as_deref())
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    if let Some(path) = &asset.store_path {
        if let Err(error) = app.asset_protocol_scope().allow_file(path) {
            tracing::warn!(%error, asset_id = %asset.id, "could not add trimmed audio to preview scope");
        }
    }
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

fn original_changed() -> AppError {
    AppError::Other("裁剪期间原音频已变化，请重新打开后再保存".into())
}

fn external_overwrite() -> AppError {
    AppError::Other("外部引用音频不能覆盖原文件，请选择另存为新音频".into())
}

fn trim(
    db: &Database,
    paths: &LibraryPaths,
    source: &str,
    start: f64,
    end: f64,
    overwrite: bool,
    project: Option<&str>,
) -> AppResult<Asset> {
    media_trim::validate_range(start, end, None, "音频")?;
    let id: String = db.conn.lock().unwrap().query_row(
        "SELECT id FROM assets WHERE store_path IN (?1,?2,?3)
          AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals t WHERE t.asset_id=assets.id)
          AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals m WHERE m.asset_id=assets.id)
          ORDER BY store_path=?1 DESC LIMIT 1",
        params![source, source.replace('\\', "/"), source.replace('/', "\\")],
        |row| row.get(0),
    ).optional()?.ok_or_else(|| AppError::Other("请先将音频加入素材库或画板，再进行裁剪".into()))?;
    let original = db.get_asset(&id)?.ok_or_else(original_changed)?;
    let stored = original.store_path.as_deref().ok_or_else(original_changed)?;
    let path = fs::canonicalize(stored).map_err(|_| original_changed())?;
    if !original.ext.as_deref().is_some_and(audio::is_audio) || !external_files::audio_path(&path) {
        return Err(AppError::Media("请选择 WAV、MP3、FLAC、M4A 或 OGG 音频素材".into()));
    }
    if overwrite && (db.is_external_asset(&id)? || paths.managed_file_root(&path).is_none()) {
        return Err(external_overwrite());
    }
    if !overwrite {
        if let Some(project) = project {
            if db.get_project(project)?.is_none() {
                return Err(AppError::Other("目标项目已不存在，请重新选择项目".into()));
            }
        }
    }
    let before = fs::metadata(&path)?;
    if !before.is_file() {
        return Err(original_changed());
    }
    if overwrite && before.permissions().readonly() {
        return Err(AppError::Other("原文件为只读，请修改文件权限后重试".into()));
    }
    let duration = audio::duration(&path)?;
    media_trim::validate_range(start, end, Some(duration), "音频")?;
    let end = end.min(duration);

    let extension = path.extension().unwrap().to_string_lossy().to_ascii_lowercase();
    let scratch = Builder::new().prefix(".audio-trim-").tempdir_in(&paths.root)?;
    let output = scratch.path().join(format!("clip.{extension}"));
    encode(&path, &output, &scratch.path().join("ffmpeg.log"), &extension, start, end)?;
    let trimmed = audio::duration(&output)?;
    if (trimmed - (end - start)).abs() > 0.25 {
        return Err(AppError::Media("裁剪结果时长校验失败，原音频未修改".into()));
    }
    verify_original(stored, &path, &before)?;

    if overwrite {
        replace(db, &original, &path, &before, &output, trimmed)?;
        db.get_asset(&id)?.ok_or_else(original_changed)
    } else {
        let destination = paths.for_project(db, project)?;
        ingest::ingest_generated_audio_clip(
            &destination,
            db,
            &output,
            ingest::GeneratedAudioClip {
                name: format!("{}-裁剪", original.name),
                duration: trimmed,
                project_id: project,
            },
        )
    }
}

fn encode(source: &Path, output: &Path, log: &Path, extension: &str, start: f64, end: f64) -> AppResult<()> {
    let encoder = match extension {
        "wav" => "pcm_s24le",
        "mp3" => "libmp3lame",
        "flac" => "flac",
        "m4a" => "aac",
        "ogg" => "libvorbis",
        _ => return Err(AppError::Media("此音频格式不支持裁剪".into())),
    };
    let binary = tools::resolve(Tool::Ffmpeg)
        .map_err(|error| AppError::Media(format!("裁剪音频需要本机 FFmpeg：{error}")))?;
    let mut command = tools::command(binary);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{start:.6}"), "-i"])
        .arg(source)
        .args(["-t", &format!("{:.6}", end - start), "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", encoder])
        .arg(output);
    media_trim::run_encoder(&mut command, log, "音频")
}

fn verify_original(stored: &str, path: &Path, before: &Metadata) -> AppResult<()> {
    if fs::canonicalize(stored).ok().as_deref() != Some(path) {
        return Err(original_changed());
    }
    let current = fs::metadata(path).map_err(|_| original_changed())?;
    if current.len() != before.len() || current.modified()? != before.modified()? {
        return Err(original_changed());
    }
    Ok(())
}

fn replace(
    db: &Database,
    original: &Asset,
    path: &Path,
    before: &Metadata,
    output: &Path,
    duration: f64,
) -> AppResult<()> {
    let stored = original.store_path.as_deref().ok_or_else(original_changed)?;
    let parent = path.parent().ok_or_else(original_changed)?;
    // The media workspace can use a different drive from the library. Only the
    // staged file and backup need to be beside the original, with non-media extensions.
    let mut staged = Builder::new().prefix(".audio-trim-").suffix(".tmp").tempfile_in(parent)?;
    std::io::copy(&mut File::open(output)?, staged.as_file_mut())?;
    staged.as_file().set_permissions(before.permissions())?;
    staged.as_file().sync_all()?;
    let staged_meta = staged.as_file().metadata()?;
    let size = staged_meta.len() as i64;
    let modified = staged_meta.modified()?
        .duration_since(UNIX_EPOCH).ok().map(|time| time.as_secs() as i64);
    let fingerprint = external_files::fingerprint(staged.path())?;

    let mut backup = Builder::new().prefix(".audio-trim-").suffix(".trim-backup").tempfile_in(parent)?;
    std::io::copy(&mut File::open(path)?, backup.as_file_mut())?;
    backup.as_file().set_permissions(before.permissions())?;
    backup.as_file().set_modified(before.modified()?)?;
    backup.as_file().sync_all()?;

    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let external: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM external_assets WHERE asset_id=?1)",
        [&original.id],
        |row| row.get(0),
    )?;
    if external {
        return Err(external_overwrite());
    }
    let changed = tx.execute(
        "UPDATE assets SET size=?1,duration=?2,file_mtime=?3,connected_scan_key=NULL WHERE id=?4 AND store_path=?5
          AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals t WHERE t.asset_id=assets.id)
          AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals m WHERE m.asset_id=assets.id)",
        params![size, duration, modified, original.id, stored],
    )?;
    if changed != 1 {
        return Err(original_changed());
    }
    tx.execute(
        "INSERT INTO creative_file_fingerprints(asset_id,sha256,asset_size,asset_mtime) VALUES(?1,?2,?3,?4)
          ON CONFLICT(asset_id) DO UPDATE SET sha256=excluded.sha256,asset_size=excluded.asset_size,asset_mtime=excluded.asset_mtime",
        params![original.id, fingerprint, size, modified],
    )?;
    tx.execute(
        "UPDATE analyses SET payload=json_set(payload,'$.current',json('false')) WHERE asset_id=?1
          AND kind='video_transcript' AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.current')=1 END",
        [&original.id],
    )?;
    verify_original(stored, path, before)?;
    staged.persist(path).map_err(|error| {
        AppError::Other(format!("无法覆盖原音频，请关闭正在占用文件的程序并检查文件权限：{}", error.error))
    })?;
    if let Err(error) = tx.commit() {
        if let Err(mut restore) = backup.persist(path) {
            restore.file.disable_cleanup(true);
            return Err(AppError::Other(format!(
                "保存与恢复失败，原音频备份保留在 {}：{error}；{}",
                restore.file.path().display(),
                restore.error,
            )));
        }
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "audio_trim_tests.rs"]
mod tests;
