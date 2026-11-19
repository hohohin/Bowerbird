//! Bounded loose-file upload. Legacy video IPC names remain for desktop compatibility.
use crate::{core::{file_intake, library::Asset, paths::LibraryPaths}, db::Database, error::{AppError, AppResult}};
#[cfg(test)]
use crate::core::ingest;
use base64::Engine;
use std::{collections::HashMap, fs::File, io::Write, path::PathBuf, sync::{Arc, LazyLock, Mutex}, time::Instant};
use std::fs::OpenOptions;
use tauri::{AppHandle, Emitter, Manager, State};

const CHUNK_SIZE: usize = 1024 * 1024;
static UPLOADS: LazyLock<Mutex<HashMap<String, MediaUpload>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct MediaUpload {
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

impl MediaUpload {
    fn new(name: &str, size: u64, project_id: Option<String>) -> AppResult<Self> {
        let name = name.rsplit(['/', '\\']).next().unwrap_or("");
        let (stem, ext) = name.rsplit_once('.').ok_or_else(|| invalid("请选择支持的素材文件"))?;
        if !file_intake::supported(std::path::Path::new(name)) || (size == 0 && !crate::core::text_documents::text_path(std::path::Path::new(name))) || size > 2 * 1024 * 1024 * 1024 { return Err(invalid("素材格式不支持、文件为空或超过 2 GiB")); }
        let stem: String = stem.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0')).take(80).collect();
        let directory = tempfile::Builder::new().prefix("bowerbird-upload-").tempdir()?;
        let path = directory.path().join(format!("{}.{}", if stem.trim().is_empty() { "素材" } else { &stem }, ext.to_lowercase()));
        let file = OpenOptions::new().write(true).create_new(true).open(&path)?;
        Ok(Self { file, path, _directory: directory, size, written: 0, project_id, touched: Instant::now() })
    }

    fn append(&mut self, offset: u64, bytes: &[u8]) -> AppResult<()> {
        if offset != self.written || bytes.is_empty() || bytes.len() > CHUNK_SIZE || bytes.len() as u64 > self.size - self.written {
            return Err(invalid("素材传输不完整，请重新拖入"));
        }
        self.file.write_all(bytes)?;
        self.written += bytes.len() as u64;
        self.touched = Instant::now();
        Ok(())
    }

    fn finish(mut self, paths: &LibraryPaths, db: &Database) -> AppResult<Asset> {
        if self.written != self.size { return Err(invalid("素材尚未传输完成，请重新拖入")); }
        self.file.flush()?;
        if let Some(project) = &self.project_id {
            if db.get_project(project)?.is_none() { return Err(invalid("目标项目已不存在")); }
        }
        let mut asset = file_intake::collect(paths, db, &self.path)?;
        if asset.origin_path.as_deref() == Some(self.path.to_string_lossy().as_ref()) {
            db.conn.lock().unwrap().execute("UPDATE assets SET origin_path=NULL WHERE id=?1", [&asset.id])?;
            asset.origin_path = None;
        }
        if let Some(project) = &self.project_id {
            db.add_assets_to_project(project, std::slice::from_ref(&asset.id))
                .map_err(|error| AppError::Other(format!("素材已入素材库，但加入项目失败：{error}")))?;
        }
        Ok(asset)
    }
}

#[tauri::command]
pub async fn video_import_begin(file_name: String, size: u64, project_id: Option<String>) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut uploads = UPLOADS.lock().unwrap();
        uploads.retain(|_, upload| upload.touched.elapsed().as_secs() < 900);
        if uploads.len() >= 4 { return Err(invalid("正在接收其他素材，请稍后重试")); }
        let upload = MediaUpload::new(&file_name, size, project_id)?;
        let id = ulid::Ulid::new().to_string();
        uploads.insert(id.clone(), upload);
        Ok(id)
    }).await.map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn video_import_append(upload_id: String, offset: u64, data: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if data.len() > CHUNK_SIZE.div_ceil(3) * 4 { return Err(invalid("素材数据块过大")); }
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| invalid("素材数据块无效"))?;
        UPLOADS.lock().unwrap().get_mut(&upload_id).ok_or_else(|| invalid("素材接收已结束，请重新拖入"))?.append(offset, &bytes)
    }).await.map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn video_import_finish(app: AppHandle, paths: State<'_, Arc<LibraryPaths>>, db: State<'_, Arc<Database>>, upload_id: String) -> AppResult<Asset> {
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    let analyze_db = db.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let upload = UPLOADS.lock().unwrap().remove(&upload_id).ok_or_else(|| invalid("素材接收已结束，请重新拖入"))?;
        upload.finish(&paths, &db)
    }).await.map_err(|e| AppError::Other(e.to_string()))?;
    if let Ok(asset) = &result {
        for path in [&asset.store_path, &asset.thumb_path].into_iter().flatten() {
            app.asset_protocol_scope().allow_file(path).map_err(|error| AppError::Other(error.to_string()))?;
        }
        crate::core::autoname::spawn_auto_analyze(app.clone(), analyze_db, asset.clone());
    }
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

    #[tokio::test]
    async fn standalone_upload_starts_without_connection_and_cancel_removes_only_temporary_bytes() {
        let original_dir = tempfile::tempdir().unwrap();
        let original = original_dir.path().join("existing.mp4");
        let bytes = include_bytes!("../../tests/fixtures/media/fragmented.mp4");
        std::fs::write(&original, bytes).unwrap();
        let id = video_import_begin("existing.mp4".into(), bytes.len() as u64, None).await.unwrap();
        video_import_append(id.clone(), 0, base64::engine::general_purpose::STANDARD.encode(bytes)).await.unwrap();
        let directory = UPLOADS.lock().unwrap()[&id]._directory.path().to_owned();
        video_import_cancel(id.clone()).await.unwrap();
        assert!(!directory.exists());
        assert!(!UPLOADS.lock().unwrap().contains_key(&id));
        assert_eq!(std::fs::read(original).unwrap(), bytes);
    }

    #[test]
    fn chunks_require_exact_offsets_and_sizes_and_cleanup_on_drop() {
        assert!(MediaUpload::new("bad.exe", 3, None).is_err());
        assert!(MediaUpload::new("empty.mp4", 0, None).is_err());
        let mut upload = MediaUpload::new("../中文视频.MP4", 6, None).unwrap();
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
    fn text_uploads_preserve_utf8_bom_empty_files_and_project_membership() {
        let root = tempfile::tempdir().unwrap();
        let mut paths = LibraryPaths::init(root.path().join("data")).unwrap();
        paths.files = Some(Arc::new(crate::core::file_workspace::FileWorkspace::open(root.path().join("files.json"), root.path().join("BowerbirdLibrary")).unwrap()));
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.create_project("p", "Text", "blank:p", "blank:p", "blank").unwrap();
        for (name, text) in [("中文.TXT", "\u{feff}# 原样文字\r\n* 不转换\r\n"), ("笔记.MARKDOWN", "# 标题\n\n**正文**"), ("空文档.md", "")] {
            let bytes = text.as_bytes();
            let mut upload = MediaUpload::new(name, bytes.len() as u64, Some("p".into())).unwrap();
            let directory = upload._directory.path().to_owned();
            for (index, chunk) in bytes.chunks(7).enumerate() { upload.append((index * 7) as u64, chunk).unwrap(); }
            let asset = upload.finish(&paths, &db).unwrap();
            assert!(!directory.exists());
            let stored = PathBuf::from(asset.store_path.as_ref().unwrap());
            assert!(stored.starts_with(root.path().join("BowerbirdLibrary").canonicalize().unwrap().join("收集箱")));
            assert_eq!(std::fs::read(stored).unwrap(), bytes);
            let document = crate::core::text_documents::read(&db, &asset.id).unwrap();
            assert_eq!(document.text, text.trim_start_matches('\u{feff}'));
            assert_eq!(document.format, if name.ends_with("TXT") { "text" } else { "markdown" });
        }
        assert_eq!(db.get_project("p").unwrap().unwrap().asset_count, 3);
    }

    #[test]
    fn incomplete_upload_never_enters_library() {
        let root = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(root.path().into()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let mut upload = MediaUpload::new("incomplete.mp4", 6, None).unwrap();
        let directory = upload._directory.path().to_owned();
        upload.append(0, &[1, 2, 3]).unwrap();
        assert!(upload.finish(&paths, &db).is_err());
        assert_eq!(db.count_assets(None).unwrap(), 0);
        assert!(!directory.exists());
    }

    #[test]
    fn video_first_save_survives_cleanup_and_folder_connection_keeps_original() {
        let root = tempfile::tempdir().unwrap();
        let mut paths = LibraryPaths::init(root.path().join("library")).unwrap();
        paths.files = Some(Arc::new(crate::core::file_workspace::FileWorkspace::open(root.path().join("files.json"), root.path().join("BowerbirdLibrary")).unwrap()));
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let bytes = include_bytes!("../../tests/fixtures/media/fragmented.mp4");
        db.create_project("p", "测试项目", "blank:p", "blank:p", "blank").unwrap();
        let mut upload = MediaUpload::new("示例视频.mp4", bytes.len() as u64, Some("p".into())).unwrap();
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
        assert_eq!(imported.len(), 2);
        let video = imported.iter().find(|item| item.ext.as_deref() == Some("mp4")).unwrap();
        let text = imported.iter().find(|item| item.ext.as_deref() == Some("txt")).unwrap();
        assert_ne!(video.id, asset.id);
        assert_eq!(PathBuf::from(video.store_path.as_deref().unwrap()), input.join("same.MP4").canonicalize().unwrap());
        assert_eq!(PathBuf::from(text.store_path.as_deref().unwrap()), input.join("ignore.txt").canonicalize().unwrap());
        assert!(db.is_external_asset(&video.id).unwrap());
        assert!(db.is_external_asset(&text.id).unwrap());
        assert_eq!(db.count_assets(None).unwrap(), 3);
    }
}
