use rusqlite::{params, OptionalExtension};
use crate::{core::{ingest, library::Asset, paths::LibraryPaths}, db::Database, error::{AppError, AppResult}, media};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFrameOrigin {
    pub source_path: String,
    pub time: f64,
}

pub fn ingest_frame(paths: &LibraryPaths, db: &Database, bytes: &[u8], name: Option<&str>, origin: &VideoFrameOrigin) -> AppResult<Asset> {
    let source = source_video(db, origin)?;
    let asset = ingest::ingest_from_bytes(paths, db, bytes, "", name, None, "video-frame")?;
    let time = if origin.time == 0.0 { 0.0 } else { origin.time };
    let record_id = format!("video-frame:{}:{}:{:x}", asset.id, source.id, time.to_bits());
    let payload = serde_json::json!({ "schema_version": 1, "source_asset_id": source.id,
        "source_path": source.store_path, "source_name": source.name, "time_seconds": time,
        "source_file_mtime": source.file_mtime, "source_size": source.size }).to_string();
    // A retry, including one after a process exit, must not append the same origin twice.
    // Keep distinct origins when exact image bytes are shared by different source moments.
    db.conn.lock().unwrap().execute("INSERT OR IGNORE INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'video_frame',?3,strftime('%s','now'))",
        params![record_id, asset.id, payload])?;
    Ok(asset)
}

fn source_video(db: &Database, origin: &VideoFrameOrigin) -> AppResult<Asset> {
    if !origin.time.is_finite() || origin.time < 0.0 {
        return Err(AppError::Media("截帧时间无效，请重新定位画面".into()));
    }
    let id: String = db.conn.lock().unwrap().query_row(
        "SELECT id FROM assets WHERE store_path IN (?1,?2,?3) LIMIT 1",
        params![origin.source_path, origin.source_path.replace('\\', "/"), origin.source_path.replace('/', "\\")], |r| r.get(0))
        .optional()?.ok_or_else(|| AppError::Media("来源视频未登记，请重新打开视频后截帧".into()))?;
    let asset = db.get_asset(&id)?.ok_or_else(|| AppError::NotFound(id))?;
    if !media::probe::is_video(asset.ext.as_deref().unwrap_or_default())
        || asset.duration.is_some_and(|duration| duration > 0.0 && origin.time > duration + 0.001) {
        return Err(AppError::Media("来源视频或截帧时间无效，请重新打开视频".into()));
    }
    Ok(asset)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { db: Database, paths: LibraryPaths, bytes: Vec<u8> }
    impl Fixture {
        fn new() -> Self {
            let paths = LibraryPaths::init(std::env::temp_dir().join(format!("bowerbird-frame-{}", ulid::Ulid::new()))).unwrap();
            let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
            db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,store_path,duration) VALUES('video','原视频','mp4','C:/fixture/clip.mp4',2)", []).unwrap();
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(8, 16).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
            Self { db, paths, bytes: bytes.into_inner() }
        }
        fn save(&self, time: f64, path: &str) -> AppResult<Asset> {
            ingest_frame(&self.paths, &self.db, &self.bytes, Some("frame.png"), &VideoFrameOrigin { source_path: path.into(), time })
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.paths.root); } }

    #[test]
    fn frame_origin_preserves_identity_time_and_is_idempotent() {
        let f = Fixture::new();
        let first = f.save(1.25, "C:/fixture/clip.mp4").unwrap();
        let second = f.save(1.25, "C:/fixture/clip.mp4").unwrap();
        assert_eq!(first.id, second.id);
        let records = f.db.list_analyses_by_asset(&first.id).unwrap();
        assert_eq!(records.len(), 1, "one provenance record survives a retry");
        assert_eq!(records[0].kind, "video_frame");
        let payload: serde_json::Value = serde_json::from_str(&records[0].payload).unwrap();
        assert_eq!(payload["source_asset_id"], "video");
        assert_eq!(payload["time_seconds"], 1.25);
        f.save(1.5, "C:/fixture/clip.mp4").unwrap();
        assert_eq!(f.db.list_analyses_by_asset(&first.id).unwrap().len(), 2, "identical pixels may have more than one source moment");
    }

    #[test]
    fn frame_origin_rejects_invalid_source_before_ingestion() {
        let f = Fixture::new();
        for time in [-1.0, f64::NAN, f64::INFINITY, 2.1] { assert!(f.save(time, "C:/fixture/clip.mp4").is_err()); }
        assert!(f.save(1.0, "C:/fixture/missing.mp4").is_err());
        let count: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "invalid capture must not create a frame");
    }
}
