use std::{fs, path::{Path, PathBuf}, process::Stdio, sync::Arc, time::{Duration, Instant}};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::{core::{ingest, library::Asset, paths::LibraryPaths}, db::Database, error::{AppError, AppResult}, media::{self, tools::{self, Tool}}};

static AUDIO_QUEUE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
struct Scratch(PathBuf);
impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

#[tauri::command]
pub async fn extract_video_audio(app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>,
    source_path: String, operation_id: String, project_id: Option<String>) -> AppResult<Asset> {
    let permit = AUDIO_QUEUE.try_acquire().map_err(|_| AppError::Other("另一个音轨正在提取，请稍后重试".into()))?;
    let db = db.inner().clone(); let paths = paths.inner().clone();
    let asset = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        extract(&db, &paths, &source_path, &operation_id, project_id.as_deref())
    }).await.map_err(|e| AppError::Other(e.to_string()))??;
    if let Some(path) = &asset.store_path { app.asset_protocol_scope().allow_file(path).map_err(|e| AppError::Other(e.to_string()))?; }
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

fn extract(db: &Database, paths: &LibraryPaths, source: &str, operation: &str, project: Option<&str>) -> AppResult<Asset> {
    if operation.is_empty() || operation.len() > 80 || !operation.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err(AppError::Other("操作标识无效，请重新打开视频后重试".into()));
    }
    let id: String = db.conn.lock().unwrap().query_row("SELECT id FROM assets WHERE store_path IN (?1,?2,?3) LIMIT 1",
        params![source, source.replace('\\', "/"), source.replace('/', "\\")], |r| r.get(0)).optional()?
        .ok_or_else(|| AppError::Other("请先将视频保存到素材库，再提取音轨".into()))?;
    let original = db.get_asset(&id)?.ok_or_else(|| AppError::NotFound(id.clone()))?;
    if !media::probe::is_video(original.ext.as_deref().unwrap_or_default()) { return Err(AppError::Media("请从视频素材提取音轨".into())); }
    if let Some(project) = project {
        let exists: bool = db.conn.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)", [project], |r| r.get(0))?;
        if !exists { return Err(AppError::Other("目标项目已不存在，请返回画板重新选择".into())); }
    }
    let record = format!("video-audio:{operation}");
    let previous: Option<(String, String)> = db.conn.lock().unwrap().query_row("SELECT asset_id,payload FROM analyses WHERE id=?1", [&record], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((asset_id, payload)) = previous {
        let payload: serde_json::Value = serde_json::from_str(&payload).map_err(|e| AppError::Other(e.to_string()))?;
        if payload["source_asset_id"] != id || payload["project_id"] != serde_json::json!(project) { return Err(AppError::Other("保存目标发生变化，请重新打开视频后重试".into())); }
        let asset = db.get_asset(&asset_id)?.ok_or_else(|| AppError::NotFound(asset_id))?;
        if asset.store_path.as_deref().is_some_and(|p| Path::new(p).is_file()) { return Ok(asset); }
        return Err(AppError::Other("已提取的音轨文件不存在，请重新打开视频后提取".into()));
    }
    let source = Path::new(original.store_path.as_deref().unwrap());
    let before = fs::metadata(source)?;
    let scratch = Scratch(paths.root.join(".video-audio").join(ulid::Ulid::new().to_string())); fs::create_dir_all(&scratch.0)?;
    let output = scratch.0.join("audio.wav");
    encode(source, &output, &scratch.0.join("ffmpeg.log"))?;
    let waveform = media::audio::decode(&output)?;
    if waveform.duration <= 0.0 || !waveform.duration.is_finite() { return Err(AppError::Media("音轨内容无效，请检查视频文件".into())); }
    let after = fs::metadata(source)?;
    if before.len() != after.len() || before.modified()? != after.modified()? { return Err(AppError::Other("提取期间视频已变化，请重新打开视频后重试".into())); }
    let destination = paths.for_project(db, project)?;
    let asset = ingest::ingest_generated(&destination, db, &output, None, "video-audio")?;
    let saved = (|| -> AppResult<()> {
        let mut conn = db.conn.lock().unwrap(); let tx = conn.transaction()?;
        tx.execute("UPDATE assets SET name=?1,origin_path=NULL,duration=?2 WHERE id=?3", params![format!("{}-音轨", original.name), waveform.duration, asset.id])?;
        if let Some(project) = project { tx.execute("INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) VALUES(?1,?2,strftime('%s','now'))", params![project,asset.id])?; }
        let payload = serde_json::json!({"source_asset_id":id,"source_path":source,"project_id":project,"source_size":before.len()}).to_string();
        tx.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'video_audio',?3,strftime('%s','now'))", params![record,asset.id,payload])?;
        tx.commit()?; Ok(())
    })();
    if let Err(error) = saved { let _ = db.delete_asset(&asset.id); return Err(error); }
    db.get_asset(&asset.id)?.ok_or_else(|| AppError::NotFound(asset.id))
}

fn encode(source: &Path, output: &Path, log: &Path) -> AppResult<()> {
    let binary = tools::resolve(Tool::Ffmpeg).map_err(|_| AppError::Media("提取音轨需要本机 FFmpeg，请安装后重试".into()))?;
    let mut child = tools::command(binary).args(["-nostdin","-hide_banner","-loglevel","error","-y","-i"]).arg(source)
        .args(["-map","0:a:0","-vn","-sn","-dn","-c:a","pcm_s16le","-fs","536870912"]).arg(output)
        .stdout(Stdio::null()).stderr(fs::File::create(log)?).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                if fs::metadata(output)?.len() >= 536_870_912 { return Err(AppError::Media("音轨过大，请先裁剪视频后提取".into())); }
                return Ok(());
            }
            Ok(Some(_)) => {
                let detail = fs::read_to_string(log).unwrap_or_default();
                tracing::warn!("video audio extraction failed: {}", detail.chars().take(2000).collect::<String>());
                return Err(AppError::Media(if detail.contains("matches no streams") { "视频没有可提取的音轨，请选择带声音的视频" } else { "音轨提取失败，请检查视频是否完整或使用兼容格式" }.into()));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err(AppError::Media("音轨提取未完成，请缩短视频后重试".into())); }
        }
    }
}

#[cfg(test)]
#[path = "video_audio_tests.rs"]
mod tests;
