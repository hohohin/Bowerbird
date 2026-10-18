use std::{fs, path::{Path, PathBuf}, process::Stdio, sync::Arc, time::{Duration, Instant}};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, State};
use crate::{core::{ingest, library::Asset, paths::LibraryPaths}, db::Database, error::{AppError, AppResult}, media::{self, tools::{self, Tool}}};

// A second edit must not encode against a source another edit is replacing.
static TRIM_QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[tauri::command]
pub async fn trim_video(app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>,
    source_path: String, start: f64, end: f64, overwrite: bool, project_id: Option<String>) -> AppResult<Asset> {
    let permit = TRIM_QUEUE.try_acquire().map_err(|_| AppError::Other("另一个视频正在保存，请稍后重试".into()))?;
    let db = db.inner().clone();
    let paths = paths.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        trim(&db, &paths, &source_path, start, end, overwrite, project_id.as_deref())
    }).await.map_err(|e| AppError::Other(e.to_string()))?;
    if result.is_ok() { let _ = app.emit("library://assets-changed", ()); }
    result
}

struct Scratch(PathBuf);
impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

fn validate_range(start: f64, end: f64, duration: f64) -> AppResult<()> {
    if !start.is_finite() || !end.is_finite() || !duration.is_finite() || start < 0.0
        || end <= start || end > duration + 0.001 || duration <= 0.0 {
        return Err(AppError::Media("入点和出点无效：需要 0 ≤ 入点 < 出点 ≤ 视频时长".into()));
    }
    Ok(())
}

fn encode(source: &Path, output: &Path, log: &Path, start: f64, end: f64) -> AppResult<()> {
    let binary = tools::resolve(Tool::Ffmpeg).map_err(|e| AppError::Media(format!("裁剪视频需要本机 FFmpeg：{e}")))?;
    let mut command = tools::command(binary);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"]).arg(source)
        .args(["-ss", &format!("{start:.6}"), "-t", &format!("{:.6}", end - start), "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]);
    if output.extension().and_then(|v| v.to_str()) == Some("webm") {
        command.args(["-c:v", "libvpx-vp9", "-crf", "24", "-b:v", "0", "-c:a", "libopus"]);
    } else {
        command.args(["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "192k"]);
    }
    // H.264 yuv420 requires even dimensions; pad by at most one pixel, never stretch.
    command.args(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p"]);
    if matches!(output.extension().and_then(|v| v.to_str()), Some("mp4" | "mov" | "m4v")) {
        command.args(["-movflags", "+faststart"]);
    }
    let mut child = command.arg(output).stdout(Stdio::null()).stderr(fs::File::create(log)?).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let message = fs::read_to_string(log).unwrap_or_default();
                return Err(AppError::Media(format!("视频裁剪失败：{}", message.chars().take(4000).collect::<String>())));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            result => {
                let _ = child.kill(); let _ = child.wait();
                return Err(AppError::Media(format!("视频裁剪超时或进程异常：{result:?}")));
            }
        }
    }
}

fn trim(db: &Database, paths: &LibraryPaths, source: &str, start: f64, end: f64,
    overwrite: bool, project: Option<&str>) -> AppResult<Asset> {
    let id: String = db.conn.lock().unwrap().query_row("SELECT id FROM assets WHERE store_path=?1", [source], |row| row.get(0))
        .optional()?.ok_or_else(|| AppError::Other("请先将视频加入素材库或画板，再进行裁剪".into()))?;
    let original = db.get_asset(&id)?.ok_or_else(|| AppError::NotFound(id.clone()))?;
    let source_path = Path::new(source);
    let meta = media::probe::probe(source_path)?;
    if !media::probe::is_video(&meta.ext) { return Err(AppError::Media("只能裁剪视频素材".into())); }
    validate_range(start, end, meta.duration)?;
    if overwrite {
        let external: bool = db.conn.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM external_assets WHERE asset_id=?1)", [&id], |r| r.get(0))?;
        if external || paths.managed_file_root(source_path).is_none() {
            return Err(AppError::Other("外部引用视频不能覆盖原文件，请选择另存为新视频".into()));
        }
    }
    if let Some(project) = project {
        let exists: bool = db.conn.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [project], |r| r.get(0))?;
        if !exists { return Err(AppError::NotFound(format!("project {project}"))); }
    }
    let source_modified = fs::metadata(source_path)?.modified()?;
    let job = ulid::Ulid::new().to_string();
    let scratch = Scratch(paths.root.join(".video-trim").join(&job));
    fs::create_dir_all(&scratch.0)?;
    let output = scratch.0.join(format!("clip.{}", if overwrite { &meta.ext } else { "mp4" }));
    encode(source_path, &output, &scratch.0.join("ffmpeg.log"), start, end.min(meta.duration))?;
    let trimmed = media::probe::probe(&output)?;
    if trimmed.width == 0 || trimmed.height == 0 || trimmed.duration <= 0.0
        || (trimmed.duration - (end - start)).abs() > 0.25 {
        return Err(AppError::Media("裁剪结果校验失败，原视频未修改".into()));
    }
    if !overwrite {
        let destination = paths.for_project(db, project)?;
        let asset = ingest::ingest_generated(&destination, db, &output, None, "video-trim")?;
        let update = (|| -> AppResult<()> {
            db.conn.lock().unwrap().execute("UPDATE assets SET name=?1, origin_path=NULL WHERE id=?2", params![format!("{}-裁剪", original.name), asset.id])?;
            if let Some(project) = project { db.add_assets_to_project(project, std::slice::from_ref(&asset.id))?; }
            Ok(())
        })();
        if let Err(error) = update { let _ = db.delete_asset(&asset.id); return Err(error); }
        return db.get_asset(&asset.id)?.ok_or_else(|| AppError::NotFound(asset.id));
    }
    let current = fs::metadata(source_path)?;
    if current.len() != meta.size || current.modified()? != source_modified {
        return Err(AppError::Other("裁剪期间原视频已变化，请重新打开后再保存".into()));
    }
    // Unique thumbnail avoids stale image caches when the asset keeps its identity.
    let thumbnail = paths.thumb_path(&job);
    media::thumb::generate_video(&output, &thumbnail, 480)?;
    let backup = source_path.with_file_name(format!(".{}-{job}.trim-backup.{}", id, meta.ext));
    fs::copy(source_path, &backup)?;
    fs::OpenOptions::new().write(true).open(&backup)?.sync_all()?;
    let result = replace(db, &original, &output, &thumbnail, &trimmed);
    if result.is_err() {
        let _ = fs::remove_file(&thumbnail);
    }
    if result.is_ok() || output.is_file() { let _ = fs::remove_file(&backup); }
    else {
        if let Err(restore) = fs::rename(&backup, source_path) {
            return Err(AppError::Other(format!("保存失败，原文件备份保留在 {}；恢复失败：{restore}；原错误：{}", backup.display(), result.unwrap_err())));
        }
    }
    result?;
    db.get_asset(&id)?.ok_or_else(|| AppError::NotFound(id))
}

fn replace(db: &Database, original: &Asset, output: &Path, thumbnail: &Path, meta: &media::probe::ProbeMeta) -> AppResult<()> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let changed = tx.execute("UPDATE assets SET size=?1,width=?2,height=?3,duration=?4,thumb_path=?5,file_mtime=?6,phash=NULL,colors=NULL WHERE id=?7 AND store_path=?8",
        params![meta.size as i64, meta.width, meta.height, meta.duration, thumbnail.to_string_lossy(), chrono::Utc::now().timestamp(), original.id, original.store_path])?;
    if changed != 1 { return Err(AppError::Other("原视频已被删除或移动，未覆盖".into())); }
    tx.execute("DELETE FROM asset_colors WHERE asset_id=?1", [&original.id])?;
    // Same volume rename replaces atomically; encoding never writes into the source file.
    fs::rename(output, original.store_path.as_deref().unwrap())?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
#[path = "video_trim_tests.rs"]
mod tests;
