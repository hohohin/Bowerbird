//! Durable incoming originals. Transfer bytes stay outside the indexed directory until verified.
use super::{external_files, library::Asset, paths::LibraryPaths};
use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

pub const ALLOWED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "mp4", "mov",
    "webm", "mkv", "avi", "m4v", "wav", "mp3", "flac", "m4a", "ogg", "md", "markdown", "txt",
];
static WRITERS: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}
fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub fn accepts_file_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    !name.is_empty()
        && name.chars().count() <= 180
        && !name.starts_with('.')
        && !name.ends_with(['.', ' '])
        && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && !name.chars().any(char::is_control)
        && !reserved
        && ALLOWED_EXTENSIONS.contains(&extension(name).as_str())
}
fn valid_metadata(id: &str, file_name: &str, size: u64) -> bool {
    valid_id(id) && accepts_file_name(file_name) && size > 0 && size <= i64::MAX as u64
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UploadState {
    Receiving,
    Ready,
    Saved,
    Indexed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRecord {
    pub id: String,
    pub file_name: String,
    pub size: u64,
    pub staging_path: PathBuf,
    pub final_path: PathBuf,
    pub state: UploadState,
    pub sha256: Option<String>,
    pub asset_id: Option<String>,
}
impl UploadRecord {
    fn valid_receipt(&self) -> bool {
        let hash_valid = self
            .sha256
            .as_ref()
            .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()));
        match self.state {
            UploadState::Receiving => true,
            UploadState::Ready | UploadState::Saved => hash_valid,
            UploadState::Indexed => {
                hash_valid && self.asset_id.as_deref().is_some_and(|id| !id.is_empty())
            }
        }
    }
}

pub struct QuickTransferStore {
    root: PathBuf,
    journal: PathBuf,
    staging: PathBuf,
    uploads: BTreeMap<String, UploadRecord>,
}
impl Drop for QuickTransferStore {
    fn drop(&mut self) {
        WRITERS.lock().unwrap().remove(&self.root);
    }
}
impl QuickTransferStore {
    pub fn open(receive_dir: &Path) -> AppResult<Self> {
        let root = fs::canonicalize(receive_dir)?;
        if !root.is_dir() {
            return Err(invalid("请选择已有文件夹接收素材"));
        }
        if !WRITERS.lock().unwrap().insert(root.clone()) {
            return Err(invalid("此文件夹已有快传接收任务"));
        }
        let journal = root.join(".bowerbird-quick-transfer");
        let mut store = Self {
            staging: journal.join("staging"),
            root,
            journal,
            uploads: BTreeMap::new(),
        };
        ensure_directory(&store.journal)?;
        ensure_directory(&store.staging)?;
        store.check_directories()?;
        store.load_records()?;
        Ok(store)
    }
    pub fn prepare(&mut self, id: &str, file_name: &str, size: u64) -> AppResult<UploadRecord> {
        self.check_directories()?;
        if !valid_metadata(id, file_name, size) {
            return Err(invalid("文件名、类型或大小不支持快传"));
        }
        if let Some(record) = self.uploads.get(id) {
            if record.file_name != file_name || record.size != size {
                return Err(invalid("快传任务信息已变化，请重新发送"));
            }
            return Ok(record.clone());
        }
        let record = UploadRecord {
            id: id.into(),
            file_name: file_name.into(),
            size,
            staging_path: self.staging.join(format!(
                "{}.{}",
                ulid::Ulid::new(),
                extension(file_name)
            )),
            final_path: self.available_name(file_name),
            state: UploadState::Receiving,
            sha256: None,
            asset_id: None,
        };
        self.save(&record)?;
        Ok(record)
    }
    /// Persist validated receipt before the transport acknowledges success to its sender.
    pub fn mark_received(&mut self, id: &str) -> AppResult<()> {
        self.check_directories()?;
        let mut record = self
            .uploads
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("快传任务已不存在"))?;
        if record.state == UploadState::Receiving {
            verify_size(&record.staging_path, record.size)?;
            validate_media(&record.staging_path)?;
            record.sha256 = Some(external_files::fingerprint(&record.staging_path)?);
            record.state = UploadState::Ready;
            self.save(&record)?;
        }
        Ok(())
    }
    pub fn complete(&mut self, id: &str, paths: &LibraryPaths, db: &Database) -> AppResult<Asset> {
        self.mark_received(id)?;
        let mut record = self
            .uploads
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("快传任务已不存在"))?;
        if record.state == UploadState::Indexed {
            return db
                .get_asset(record.asset_id.as_deref().unwrap())?
                .ok_or_else(|| invalid("素材已移除，请重新发送"));
        }
        self.publish_ready(&mut record)?;
        self.register(&mut record, paths, db)
    }
    fn publish_ready(&mut self, record: &mut UploadRecord) -> AppResult<()> {
        if record.state == UploadState::Ready {
            self.publish(record)?;
            record.state = UploadState::Saved;
            self.save(record)?;
            if let Err(error) = fs::remove_file(&record.staging_path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("quick transfer staging cleanup: {error}");
                }
            }
        }
        Ok(())
    }
    fn register(
        &mut self,
        record: &mut UploadRecord,
        paths: &LibraryPaths,
        db: &Database,
    ) -> AppResult<Asset> {
        verify_fingerprint(
            &record.final_path,
            record.size,
            record.sha256.as_deref().unwrap(),
        )?;
        let root = self.connect(db)?;
        let asset = db.index_connected_file(paths, &record.final_path, None)?;
        // Other damaged files in a connected folder do not undo this original's successful registration.
        if let Err(error) = db.scan_connection(paths, &root) {
            tracing::warn!("quick transfer collection refresh: {error}");
        }
        record.asset_id = Some(asset.id.clone());
        record.state = UploadState::Indexed;
        self.save(record)?;
        Ok(asset)
    }
    pub fn records(&self) -> Vec<UploadRecord> {
        self.uploads.values().cloned().collect()
    }
    pub fn recover(
        &mut self,
        paths: &LibraryPaths,
        db: &Database,
    ) -> Vec<(String, AppResult<Asset>)> {
        let ids: Vec<_> = self
            .uploads
            .values()
            .filter(|r| matches!(r.state, UploadState::Ready | UploadState::Saved))
            .map(|r| r.id.clone())
            .collect();
        ids.into_iter()
            .map(|id| {
                let result = self.complete(&id, paths, db);
                (id, result)
            })
            .collect()
    }
    pub fn cancel(&mut self, id: &str) -> AppResult<()> {
        self.check_directories()?;
        let Some(record) = self.uploads.get(id) else {
            return Ok(());
        };
        if record.state != UploadState::Receiving {
            return Err(invalid("文件已接收完成，请从素材库管理原件"));
        }
        if record.staging_path.exists() {
            regular_file(&record.staging_path)?;
            fs::remove_file(&record.staging_path)?;
        }
        fs::remove_file(self.manifest_path(id))?;
        self.uploads.remove(id);
        Ok(())
    }
    fn check_directories(&self) -> AppResult<()> {
        for path in [&self.root, &self.journal, &self.staging] {
            if fs::canonicalize(path)? != *path {
                return Err(invalid("收件目录位置已变化，请重新选择"));
            }
        }
        Ok(())
    }
    fn check_record(&self, record: &UploadRecord) -> AppResult<()> {
        if !valid_metadata(&record.id, &record.file_name, record.size)
            || !valid_record_path(&record.staging_path, &self.staging)
            || !valid_record_path(&record.final_path, &self.root)
            || !record.valid_receipt()
        {
            return Err(invalid("快传恢复记录无效，请检查收件目录"));
        }
        Ok(())
    }
    fn load_records(&mut self) -> AppResult<()> {
        for entry in fs::read_dir(&self.journal)? {
            let path = entry?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let record = self.load_record(&path)?;
            self.uploads.insert(record.id.clone(), record);
        }
        Ok(())
    }
    fn load_record(&self, path: &Path) -> AppResult<UploadRecord> {
        regular_file(path)?;
        let mut bytes = Vec::new();
        fs::File::open(path)?.take(65537).read_to_end(&mut bytes)?;
        if bytes.len() > 65536 {
            return Err(invalid("快传恢复记录无效，请检查收件目录"));
        }
        let record: UploadRecord = serde_json::from_slice(&bytes)?;
        self.check_record(&record)?;
        if self.manifest_path(&record.id) != path {
            return Err(invalid("快传恢复记录位置无效"));
        }
        Ok(record)
    }
    fn manifest_path(&self, id: &str) -> PathBuf {
        self.journal
            .join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
    }
    fn save(&mut self, record: &UploadRecord) -> AppResult<()> {
        let mut file = tempfile::NamedTempFile::new_in(&self.journal)?;
        serde_json::to_writer(&mut file, record)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist(self.manifest_path(&record.id))
            .map_err(|error| error.error)?;
        self.uploads.insert(record.id.clone(), record.clone());
        Ok(())
    }
    fn available_name(&self, name: &str) -> PathBuf {
        let source = Path::new(name);
        let stem = source.file_stem().unwrap().to_string_lossy();
        let ext = extension(name);
        let mut number = 0;
        loop {
            let suffix = format!(" ({number}).{ext}");
            let shortened: String = stem
                .chars()
                .take(180usize.saturating_sub(suffix.chars().count()))
                .collect();
            let candidate = self.root.join(if number == 0 {
                name.to_owned()
            } else {
                format!("{shortened}{suffix}")
            });
            let reserved = self.uploads.values().any(|r| {
                r.final_path
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&candidate.to_string_lossy())
            });
            if !candidate.exists() && !reserved {
                return candidate;
            }
            number += 1;
        }
    }
    fn publish(&self, record: &UploadRecord) -> AppResult<()> {
        let hash = record.sha256.as_deref().unwrap();
        if record.final_path.exists() {
            return verify_fingerprint(&record.final_path, record.size, hash);
        }
        verify_fingerprint(&record.staging_path, record.size, hash)?;
        let mut file = tempfile::Builder::new()
            .prefix(".bowerbird-quick-transfer-")
            .tempfile_in(&self.root)?;
        std::io::copy(&mut fs::File::open(&record.staging_path)?, &mut file)?;
        file.as_file().sync_all()?;
        verify_fingerprint(file.path(), record.size, hash)?;
        file.persist_noclobber(&record.final_path)
            .map_err(|error| error.error)?;
        Ok(())
    }
    fn connect(&self, db: &Database) -> AppResult<String> {
        for id in db.connected_root_ids()? {
            let folder = db.connected_folder(&id)?;
            if self.root.starts_with(&folder.path) {
                return Ok(id);
            }
        }
        db.connect_directory(&self.root, None)
    }
}

fn valid_record_path(path: &Path, parent: &Path) -> bool {
    path.parent() == Some(parent)
        && path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(accepts_file_name)
}
fn regular_file(path: &Path) -> AppResult<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || fs::canonicalize(path)? != path {
        return Err(invalid("接收文件位置已变化，请重新发送"));
    }
    Ok(metadata)
}
fn ensure_directory(path: &Path) -> AppResult<()> {
    if !path.exists() {
        fs::create_dir(path)?;
    }
    if !path.is_dir() || fs::canonicalize(path)? != path {
        return Err(invalid("收件目录位置已变化，请重新选择"));
    }
    Ok(())
}
fn verify_size(path: &Path, size: u64) -> AppResult<()> {
    if regular_file(path)?.len() != size {
        return Err(invalid("文件尚未接收完整，请重新发送"));
    }
    Ok(())
}
fn verify_fingerprint(path: &Path, size: u64, hash: &str) -> AppResult<()> {
    verify_size(path, size)?;
    if external_files::fingerprint(path)? != hash {
        return Err(invalid("接收文件内容已变化，原文件未被覆盖"));
    }
    Ok(())
}
fn validate_media(path: &Path) -> AppResult<()> {
    let ext = extension(path.to_str().unwrap_or(""));
    if super::text_documents::is_text(&ext) {
        return validate_text(path);
    }
    if crate::media::heic::is_path(path) {
        let preview = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
        return crate::media::heic::convert_to_png(path, preview.path());
    }
    if crate::media::probe::is_video(&ext) {
        return validate_video(path);
    }
    if crate::media::audio::is_audio(&ext) {
        return crate::media::audio::decode(path).map(|_| ());
    }
    validate_image(path, &ext)
}
fn validate_text(path: &Path) -> AppResult<()> {
    if fs::metadata(path)?.len() > 2 * 1024 * 1024 {
        return Err(invalid("文本文件不能超过 2 MB"));
    }
    let bytes = fs::read(path)?;
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("文本文件须为 UTF-8 编码"))?;
    if text.contains('\0') {
        return Err(invalid("收到的内容不是有效文本"));
    }
    Ok(())
}
fn validate_video(path: &Path) -> AppResult<()> {
    let meta = crate::media::probe::probe(path)?;
    if meta.width == 0 || meta.height == 0 || !meta.duration.is_finite() || meta.duration <= 0.0 {
        return Err(invalid("收到的视频不完整或无法读取"));
    }
    Ok(())
}
fn validate_image(path: &Path, ext: &str) -> AppResult<()> {
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    if reader.format() != image::ImageFormat::from_extension(ext) {
        return Err(invalid("图片内容与文件类型不一致"));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(20000);
    limits.max_image_height = Some(20000);
    limits.max_alloc = Some(400 * 1024 * 1024);
    reader.limits(limits);
    reader.decode()?;
    Ok(())
}

#[cfg(test)]
#[path = "quick_transfer_tests.rs"]
mod tests;
