//! Bounded temporary uploads for HTML video drops (which cannot expose native paths).
use crate::{core::{ingest, library::Asset, paths::LibraryPaths}, db::Database, error::{AppError, AppResult}, media::probe};
use base64::Engine;
use std::{collections::HashMap, fs::{File, OpenOptions}, io::Write, path::PathBuf, sync::{Arc, LazyLock, Mutex}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter, State};

const CHUNK_SIZE: usize = 1024 * 1024;
static UPLOADS: LazyLock<Mutex<HashMap<String, VideoUpload>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct VideoUpload {
    // File must close before TempDir removes it on Windows.
    file: File,
    path: PathBuf,
    _directory: tempfile::TempDir,
    size: u64,
    written: u64,
    project_id: Option<String>,
    touched: Instant,
}

fn invalid(message: &str) -> AppError { AppError::Media(message.into()) }

impl VideoUpload {
    fn new(name: &str, size: u64, project_id: Option<String>) -> AppResult<Self> {
        let name = name.rsplit(['/', '\\']).next().unwrap_or("");
        let (stem, ext) = name.rsplit_once('.').ok_or_else(|| invalid("请选择支持的视频文件"))?;
        if !probe::is_video(ext) || size == 0 { return Err(invalid("视频格式不支持或文件为空")); }
        let stem: String = stem.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0')).take(80).collect();
        let directory = tempfile::Builder::new().prefix("bowerbird-upload-").tempdir()?;
        let path = directory.path().join(format!("{}.{}", if stem.trim().is_empty() { "video" } else { &stem }, ext.to_lowercase()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path)?;
        Ok(Self { file, path, _directory: directory, size, written: 0, project_id, touched: Instant::now() })
    }

    fn append(&mut self, offset: u64, bytes: &[u8]) -> AppResult<()> {
        if offset != self.written || bytes.is_empty() || bytes.len() > CHUNK_SIZE || bytes.len() as u64 > self.size - self.written {
            return Err(invalid("视频传输不完整，请重新拖入"));
        }
        self.file.write_all(bytes)?;
        self.written += bytes.len() as u64;
        self.touched = Instant::now();
        Ok(())
    }

    fn finish(mut self, paths: &LibraryPaths, db: &Database) -> AppResult<Asset> {
        if self.written != self.size { return Err(invalid("视频尚未传输完成，请重新拖入")); }
        self.file.flush()?;
        let paths = paths.for_project(db, self.project_id.as_deref())?;
        let mut asset = ingest::ingest_file(&paths, db, &self.path)?;
        if asset.origin_path.as_deref() == Some(self.path.to_string_lossy().as_ref()) {
            db.conn.lock().unwrap().execute("UPDATE assets SET origin_path=NULL WHERE id=?1", [&asset.id])?;
            asset.origin_path = None;
        }
        if let Some(project) = &self.project_id {
            db.add_assets_to_project(project, std::slice::from_ref(&asset.id))
                .map_err(|error| AppError::Other(format!("视频已入素材库，但加入项目失败：{error}")))?;
        }
        Ok(asset)
    }
}

#[tauri::command]
pub async fn video_import_begin(file_name: String, size: u64, project_id: Option<String>) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut uploads = UPLOADS.lock().unwrap();
        uploads.retain(|_, upload| upload.touched.elapsed() < Duration::from_secs(3600));
        if uploads.len() >= 8 { return Err(invalid("正在导入的视频过多，请等待当前导入完成")); }
        let upload = VideoUpload::new(&file_name, size, project_id)?;
        let id = ulid::Ulid::new().to_string();
        uploads.insert(id.clone(), upload);
        Ok(id)
    }).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn video_import_append(upload_id: String, offset: u64, data: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if data.len() > CHUNK_SIZE.div_ceil(3) * 4 { return Err(invalid("视频数据块过大")); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| invalid("视频数据块无效"))?;
        UPLOADS.lock().unwrap().get_mut(&upload_id).ok_or_else(|| invalid("视频导入已结束，请重新拖入"))?.append(offset, &bytes)
    }).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn video_import_finish(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, db: State<'_, Arc<Database>>, upload_id: String) -> AppResult<Asset> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let upload = UPLOADS.lock().unwrap().remove(&upload_id).ok_or_else(|| invalid("视频导入已结束，请重新拖入"))?;
        upload.finish(&paths, &db)
    }).await.map_err(|e| AppError::Other(e.to_string()))?;
    let _ = app.emit("library://assets-changed", ());
    let _ = app.emit("projects://changed", ());
    result
}

#[tauri::command]
pub async fn video_import_cancel(upload_id: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || { UPLOADS.lock().unwrap().remove(&upload_id); })
        .await.map_err(|e| AppError::Other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_require_exact_offsets_and_sizes_and_cleanup_on_drop() {
        assert!(VideoUpload::new("bad.txt", 3, None).is_err());
        assert!(VideoUpload::new("empty.mp4", 0, None).is_err());
        let mut upload = VideoUpload::new("../中文视频.MP4", 6, None).unwrap();
        let directory = upload._directory.path().to_owned();
        assert_eq!(upload.path.parent().unwrap(), directory);
        assert!(upload.append(1, &[1, 2]).is_err());
        upload.append(0, &[1, 2, 3]).unwrap();
        assert!(upload.append(0, &[1, 2, 3]).is_err());
        assert!(upload.append(3, &[4, 5, 6, 7]).is_err());
        upload.append(3, &[4, 5, 6]).unwrap();
        assert_eq!(std::fs::read(&upload.path).unwrap(), [1, 2, 3, 4, 5, 6]);
        drop(upload);
        assert!(!directory.exists());
    }

    #[test]
    fn incomplete_upload_never_enters_library() {
        let root = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(root.path().into()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let mut upload = VideoUpload::new("incomplete.mp4", 6, None).unwrap();
        let directory = upload._directory.path().to_owned();
        upload.append(0, &[1, 2, 3]).unwrap();
        assert!(upload.finish(&paths, &db).is_err());
        assert_eq!(db.count_assets(None).unwrap(), 0);
        assert!(!directory.exists());
    }

    #[test]
    fn video_upload_and_folder_import_keep_metadata_and_deduplicate() {
        let root = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(root.path().join("library")).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let bytes = include_bytes!("../../tests/fixtures/media/fragmented.mp4");
        db.create_project("p", "测试项目", "blank:p", "blank:p", "blank").unwrap();
        let mut upload = VideoUpload::new("示例视频.mp4", bytes.len() as u64, Some("p".into())).unwrap();
        let directory = upload._directory.path().to_owned();
        for (index, chunk) in bytes.chunks(512).enumerate() { upload.append((index * 512) as u64, chunk).unwrap(); }
        let asset = upload.finish(&paths, &db).unwrap();
        assert!(!directory.exists());
        assert_eq!(asset.name, "示例视频");
        assert_eq!(asset.ext.as_deref(), Some("mp4"));
        assert_eq!(asset.origin_path, None);
        assert_eq!(db.list_projects().unwrap()[0].asset_count, 1);
        assert!(asset.width.unwrap() > 0 && asset.height.unwrap() > 0 && asset.duration.unwrap() > 0.0);
        assert_eq!(std::fs::read(asset.store_path.unwrap()).unwrap(), bytes);
        let input = root.path().join("input"); std::fs::create_dir(&input).unwrap();
        std::fs::write(input.join("same.MP4"), bytes).unwrap();
        std::fs::write(input.join("ignore.txt"), "text").unwrap();
        assert!(ingest::walk_images(&input).is_empty(), "image generation scans must exclude videos");
        let imported = ingest::ingest_dir(&paths, &db, &input).unwrap();
        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].id, asset.id);
        assert_eq!(db.count_assets(None).unwrap(), 1);
    }
}
