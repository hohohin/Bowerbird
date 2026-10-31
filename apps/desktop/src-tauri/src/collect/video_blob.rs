//! Explicit binary video uploads. Metadata never determines the file's media type.
use crate::{core::{ingest, library::Asset, paths::LibraryPaths}, db::Database};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path, sync::Mutex};

pub(crate) const MAX_BYTES: usize = 200 * 1024 * 1024;
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub(crate) struct UploadError {
    pub code: &'static str,
    pub message: &'static str,
    pub diagnostic: String,
}
impl UploadError {
    fn new(code: &'static str, message: &'static str) -> Self { Self { code, message, diagnostic: message.into() } }
    fn storage(error: impl std::fmt::Display) -> Self {
        Self { code: "save_failed", message: "视频未能保存，请检查保存位置和磁盘空间后重试。", diagnostic: error.to_string() }
    }
}
impl From<crate::error::AppError> for UploadError { fn from(error: crate::error::AppError) -> Self { Self::storage(error) } }
impl From<std::io::Error> for UploadError { fn from(error: std::io::Error) -> Self { Self::storage(error) } }
impl From<rusqlite::Error> for UploadError { fn from(error: rusqlite::Error) -> Self { Self::storage(error) } }

fn invalid_video() -> UploadError { UploadError::new("invalid_media", "收到的内容不是完整视频，请确认视频可播放后重新采集。") }

fn extension(bytes: &[u8]) -> Result<&'static str, UploadError> {
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"AVI " { return Ok("avi"); }
    if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        let header = &bytes[..bytes.len().min(4096)];
        if header.windows(4).any(|v| v == b"webm") { return Ok("webm"); }
        if header.windows(8).any(|v| v == b"matroska") { return Ok("mkv"); }
        return Err(invalid_video());
    }
    if bytes.len() >= 16 && [b"ftyp", b"moov", b"mdat", b"wide", b"free"].iter().any(|kind| &bytes[4..8] == *kind) {
        let size = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        if size >= 8 && size <= bytes.len() { return Ok(if &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"qt  " { "mov" } else { "mp4" }); }
    }
    Err(invalid_video())
}

pub(super) fn validate_metadata(meta: &Value) -> Result<(), UploadError> {
    if meta["media_kind"] != "video" { return Err(UploadError::new("invalid_metadata", "视频上传缺少类型标记，请更新浏览器插件。")); }
    if let Some(length) = meta.get("byte_length") {
        let length = length.as_u64().ok_or_else(|| UploadError::new("invalid_metadata", "视频大小信息无效，请重新采集。"))?;
        if length > MAX_BYTES as u64 { return Err(UploadError::new("too_large", "视频超过 200 MiB，请选择较小的视频。")); }
    }
    let requested = meta["requested_url"].as_str().or_else(|| meta["url"].as_str()).unwrap_or("");
    if requested.is_empty() { return Err(UploadError::new("invalid_metadata", "视频缺少来源地址，请重新采集。")); }
    for value in [Some(requested), meta["effective_url"].as_str(), meta["page_url"].as_str()].into_iter().flatten().filter(|v| !v.is_empty()) {
        let url = reqwest::Url::parse(value).map_err(|_| UploadError::new("invalid_metadata", "视频来源地址无效，请重新采集。"))?;
        if value.len() > 8192 || !["http", "https", "blob"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() {
            return Err(UploadError::new("invalid_metadata", "视频来源地址无效，请重新采集。"));
        }
    }
    Ok(())
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), UploadError> {
    let parent = destination.parent().unwrap();
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    let mut input = fs::File::open(source)?;
    std::io::copy(&mut input, temporary.as_file_mut())?;
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(destination).map_err(|e| UploadError::storage(e.error))?;
    Ok(())
}

pub(crate) fn save(paths: &LibraryPaths, db: &Database, bytes: &[u8], meta: &Value, project: Option<&str>) -> Result<Asset, UploadError> {
    validate_metadata(meta)?;
    if bytes.len() > MAX_BYTES { return Err(UploadError::new("too_large", "视频超过 200 MiB，请选择较小的视频。")); }
    if bytes.is_empty() || meta.get("byte_length").and_then(Value::as_u64).is_some_and(|length| length != bytes.len() as u64) { return Err(invalid_video()); }
    let ext = extension(bytes)?;
    let _lock = SAVE_LOCK.lock().unwrap();
    if let Some(id) = project {
        if db.get_project(id)?.is_none() { return Err(UploadError::new("project_unavailable", "采集目标项目已不存在，请重新选择项目后采集。")); }
    }
    let destination = paths.for_project(db, project)?;
    let temporary_root = paths.root.join("extension-uploads");
    fs::create_dir_all(&temporary_root)?;
    let temporary = tempfile::Builder::new().prefix("video-").tempdir_in(&temporary_root)?;
    let source = temporary.path().join(format!("extension-video.{ext}"));
    let mut file = fs::File::create(&source)?;
    file.write_all(bytes)?; file.sync_all()?; drop(file);
    let probed = crate::media::probe::probe(&source).map_err(|error| UploadError { diagnostic: error.to_string(), ..invalid_video() })?;
    if probed.width == 0 || probed.height == 0 || !probed.duration.is_finite() || probed.duration <= 0.0 { return Err(invalid_video()); }

    // Reuse exact-byte ingress, containing provisional files so a database failure
    // cannot leave a partial file in a user-visible folder.
    let mut staging = destination.clone();
    staging.destination = Some(temporary.path().join("staged"));
    staging.thumbnails = temporary.path().join("thumbnails");
    let asset = ingest::ingest_new_file(&staging, db, &source)?;
    let created = asset.origin_path.as_deref() == source.to_str();
    let mut copied = Vec::new();
    let result = (|| -> Result<Asset, UploadError> {
        let stored = if created {
            let target = destination.asset_store_path(&asset.id, ext)?;
            atomic_copy(Path::new(asset.store_path.as_deref().unwrap()), &target)?;
            copied.push(target.clone()); Some(target)
        } else { None };
        let thumb = if created {
            if let Some(source) = &asset.thumb_path {
                let target = paths.thumb_path(&asset.id);
                atomic_copy(Path::new(source), &target)?; copied.push(target.clone()); Some(target)
            } else { None }
        } else { None };
        let requested = meta["requested_url"].as_str().or_else(|| meta["url"].as_str()).unwrap();
        let effective = meta["effective_url"].as_str().filter(|v| !v.is_empty()).unwrap_or(requested);
        let source_url = meta["page_url"].as_str().filter(|v| !v.is_empty()).unwrap_or(effective);
        let name = meta["file_name"].as_str().and_then(|name| Path::new(name).file_stem()).and_then(|name| name.to_str())
            .map(|name| name.chars().filter(|c| !c.is_control() && !matches!(c, '<'|'>'|':'|'"'|'/'|'\\'|'|'|'?'|'*')).take(80).collect::<String>())
            .filter(|name| !name.trim().is_empty()).unwrap_or_else(|| "采集视频".into());
        let provenance = json!({"requested_url":requested,"effective_url":effective,"page_url":source_url,"file_name":meta["file_name"],"media_kind":"video"});
        let analysis_id = format!("extension-capture-{:x}", Sha256::digest(format!("{}:{}",asset.id,provenance)));
        let conn = db.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        if let Some(stored) = stored {
            tx.execute("UPDATE assets SET name=?2,source='extension',source_url=?3,origin_path=NULL,store_path=?4,thumb_path=?5,library_hidden=0 WHERE id=?1",
                rusqlite::params![asset.id,name,source_url,stored.to_string_lossy(),thumb.map(|p| p.to_string_lossy().into_owned())])?;
        } else { tx.execute("UPDATE assets SET library_hidden=0 WHERE id=?1",[&asset.id])?; }
        tx.execute("INSERT OR IGNORE INTO analyses (id,asset_id,kind,payload,provider,created_at) VALUES (?1,?2,'extension_capture',?3,NULL,strftime('%s','now'))",
            rusqlite::params![analysis_id,asset.id,provenance.to_string()])?;
        if let Some(project) = project {
            tx.execute("INSERT OR IGNORE INTO project_assets (project_id,asset_id,created_at) VALUES (?1,?2,strftime('%s','now'))",rusqlite::params![project,asset.id])?;
        }
        tx.commit()?; drop(conn);
        db.get_asset(&asset.id)?.ok_or_else(|| UploadError::storage("saved asset missing"))
    })();
    if result.is_err() && created {
        // Reused assets never enter rollback; remove only this call's unpublished files.
        let cleaned = db.conn.lock().unwrap().execute("DELETE FROM assets WHERE id=?1 AND origin_path=?2",rusqlite::params![asset.id,source.to_string_lossy()]);
        if matches!(cleaned, Ok(1)) {
            for path in copied { let _ = fs::remove_file(path); }
        } else {
            let retained = temporary.keep();
            tracing::error!("extension video rollback incomplete; retained {}", retained.display());
        }
    }
    result
}

#[cfg(test)]
#[path = "video_blob_tests.rs"]
mod tests;
