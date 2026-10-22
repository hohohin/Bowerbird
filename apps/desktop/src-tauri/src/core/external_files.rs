//! Read-only local browsing and externally owned image references.
use crate::{
    core::{library::Asset, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Other(message.into())
}
pub fn image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
    )
}
fn original(path: &Path) -> AppResult<PathBuf> {
    let path =
        fs::canonicalize(path).map_err(|_| invalid("原图片不可用，请检查文件权限或重新定位"))?;
    if !path.is_file() || !(image_path(&path) || video_path(&path)) {
        return Err(invalid("请选择支持的图片或视频"));
    }
    Ok(path)
}
pub fn video_path(path: &Path) -> bool {
    crate::media::probe::is_video(path.extension().and_then(|s| s.to_str()).unwrap_or(""))
}
pub fn fingerprint(path: &Path) -> AppResult<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub directory: bool,
    pub version: Option<String>,
    pub preview: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
    pub total: usize,
}
pub fn browse(path: Option<&str>, offset: usize) -> AppResult<DirectoryPage> {
    browse_page(path, offset, false)
}
pub fn browse_page(path: Option<&str>, offset: usize, all: bool) -> AppResult<DirectoryPage> {
    let path = path.map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    });
    let path = fs::canonicalize(path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() || (metadata.is_file() && (image_path(&entry.path()) || video_path(&entry.path()))) {
            entries.push(FileEntry {
                path: entry.path().to_string_lossy().into_owned(),
                name,
                directory: metadata.is_dir(),
                version: preview_key(&entry.path(), &metadata).ok(),
                preview: None,
            });
        }
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    let total = entries.len();
    Ok(DirectoryPage {
        parent: path.parent().map(|p| p.to_string_lossy().into_owned()),
        path: path.to_string_lossy().into_owned(),
        entries: entries.into_iter().skip(offset).take(if all { usize::MAX } else { 120 }).collect(),
        total,
    })
}

fn preview_key(path: &Path, metadata: &fs::Metadata) -> AppResult<String> {
    let key = format!(
        "{}:{}:{:?}",
        path.display(),
        metadata.len(),
        metadata.modified()?
    );
    Ok(format!("{:x}", Sha256::digest(key.as_bytes())))
}

/// Cache-only enumeration: never decode media or wait for the extraction queue.
pub fn attach_previews(paths: &LibraryPaths, entries: &mut [FileEntry]) {
    let folder = paths.root.join("external-previews");
    for entry in entries.iter_mut().filter(|entry| !entry.directory) {
        if entry.version.is_none() {
            entry.version = fs::metadata(&entry.path).ok()
                .and_then(|metadata| preview_key(Path::new(&entry.path), &metadata).ok());
        }
        if let Some(key) = &entry.version {
            let cached = folder.join(format!("{key}.jpg"));
            entry.preview = cached.is_file().then(|| cached.to_string_lossy().into_owned());
        }
    }
}

pub fn cached_preview(paths: &LibraryPaths, path: &Path) -> AppResult<Option<String>> {
    let path = original(path)?;
    let key = preview_key(&path, &fs::metadata(&path)?)?;
    let cached = paths.root.join("external-previews").join(format!("{key}.jpg"));
    Ok(cached.is_file().then(|| cached.to_string_lossy().into_owned()))
}

pub fn preview(paths: &LibraryPaths, path: &Path) -> AppResult<String> {
    preview_with_index(paths, None, path)
}

pub fn preview_with_index(paths: &LibraryPaths, db: Option<&Database>, path: &Path) -> AppResult<String> {
    let path = original(path)?;
    let hash = preview_key(&path, &fs::metadata(&path)?)?;
    let folder = paths.root.join("external-previews");
    fs::create_dir_all(&folder)?;
    let destination = folder.join(format!("{hash}.jpg"));
    if !destination.is_file() {
        let temporary = folder.join(format!("{hash}-{}.jpg", ulid::Ulid::new()));
        let result = (|| -> AppResult<()> {
        // Historical thumbnails remain usable after moving files. Validate content
        // once on a cache miss; subsequent browsing only checks metadata/cache.
        let indexed: Option<(String, String)> = if let Some(db) = db {
            db.conn.lock().unwrap().query_row(
                "SELECT a.thumb_path,COALESCE(e.fingerprint,f.sha256) FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.store_path=?1 AND a.thumb_path IS NOT NULL AND COALESCE(e.fingerprint,f.sha256) IS NOT NULL LIMIT 1",
                [path.to_string_lossy().as_ref()], |row| Ok((row.get(0)?,row.get(1)?))).optional()?
        } else { None };
        let reused = if let Some((thumb, expected)) = indexed {
            if Path::new(&thumb).is_file() && fingerprint(&path)? == expected {
                fs::copy(thumb, &temporary)?; true
            } else { false }
        } else { false };
        if reused || shell_thumbnail(&path, &temporary) {
            // Already rendered by the library or Windows; do not decode the original again.
        } else if video_path(&path) {
            crate::media::thumb::generate_video(&path, &temporary, 480)?;
        } else {
            crate::media::thumb::generate(&path, &temporary, 480)?;
        }
        if preview_key(&path, &fs::metadata(&path)?)? != hash {
            return Err(invalid("文件正在变化，请刷新后重试缩略图"));
        }
        // Concurrent callers can complete the same thumbnail; keep the first.
        if !destination.is_file() { fs::rename(&temporary, &destination)?; }
        Ok(())
        })();
        let _ = fs::remove_file(&temporary);
        result?;
    }
    Ok(destination.to_string_lossy().into_owned())
}

#[path = "shell_thumbnail.rs"]
mod shell_thumbnail;
use shell_thumbnail::cached as shell_thumbnail;

impl Database {
    pub fn is_external_asset(&self, id: &str) -> AppResult<bool> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM external_assets WHERE asset_id=?1)",
            [id],
            |r| r.get(0),
        )?)
    }
    pub fn external_paths(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT store_path FROM assets JOIN external_assets ON asset_id=id WHERE store_path IS NOT NULL")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn index_external(&self, paths: &LibraryPaths, path: &Path) -> AppResult<Asset> {
        let path = original(path)?;
        // Files created in BowerbirdLibrary keep their existing image identity when browsed.
        let managed: Option<String> = self.conn.lock().unwrap().query_row(
            "SELECT id FROM assets WHERE store_path=?1 AND NOT EXISTS(SELECT 1 FROM external_assets WHERE asset_id=assets.id)",
            [path.to_string_lossy().as_ref()], |row| row.get(0)).optional()?;
        if let Some(id) = managed {
            return self.get_asset(&id)?.ok_or_else(|| invalid("素材已不存在"));
        }
        // Never treat a managed library file as an external original.
        if path.starts_with(fs::canonicalize(&paths.images)?) {
            return Err(invalid("这是库内文件，请从素材库引用"));
        }
        let hash = fingerprint(&path)?;
        let media = crate::media::probe::probe(&path)?;
        let dimensions = (media.width, media.height);
        let thumb = if video_path(&path) { preview(paths, &path).ok() } else { Some(preview(paths, &path)?) };
        if fingerprint(&path)? != hash {
            return Err(invalid("图片正在被修改，请稍后重试"));
        }
        let path = path.to_string_lossy().into_owned();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let existing: Option<(String, Option<String>, String)> = tx.query_row(
            "SELECT a.id,e.fingerprint,a.store_path FROM external_asset_paths p JOIN assets a ON a.id=p.asset_id LEFT JOIN external_assets e ON e.asset_id=a.id WHERE p.path=?1", [&path], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let id = if let Some((id, expected, current)) = existing {
            if expected.is_none() && fingerprint(Path::new(&current))? != hash {
                return Err(invalid("此路径已有转存素材，但原图片已变化；请通过导入创建新素材，或将新图片另存后引用"));
            }
            if expected.is_some_and(|value| value != hash) {
                return Err(invalid(
                    "原图片内容已变化，请在「外部引用」中确认更新后再使用",
                ));
            }
            id
        } else {
            let id = ulid::Ulid::new().to_string();
            let p = Path::new(&path);
            let metadata = fs::metadata(p)?;
            tx.execute("INSERT INTO assets(id,name,ext,origin_path,store_path,thumb_path,size,width,height,source,library_hidden,created_at) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?8,'external',1,?9)", params![id,p.file_stem().unwrap_or_default().to_string_lossy(),p.extension().unwrap_or_default().to_string_lossy().to_lowercase(),path,thumb,metadata.len() as i64,dimensions.0,dimensions.1,chrono::Utc::now().timestamp()])?;
            tx.execute("UPDATE assets SET duration=?2 WHERE id=?1", params![id,media.duration])?;
            tx.execute(
                "INSERT INTO external_assets(asset_id,fingerprint) VALUES(?1,?2)",
                params![id, hash],
            )?;
            tx.execute(
                "INSERT INTO external_asset_paths(asset_id,path) VALUES(?1,?2)",
                params![id, path],
            )?;
            id
        };
        tx.commit()?;
        drop(conn);
        self.get_asset(&id)?
            .ok_or_else(|| invalid("外部引用未保存"))
    }
    /// Resolve historical aliases after relinking/copying, then validate before provider submission.
    pub fn resolve_external_paths(&self, references: &[String]) -> AppResult<Vec<String>> {
        references.iter().map(|path| {
            let row: Option<(String, Option<String>)> = self.conn.lock().unwrap().query_row(
                "SELECT a.store_path,e.fingerprint FROM external_asset_paths p JOIN assets a ON a.id=p.asset_id LEFT JOIN external_assets e ON e.asset_id=a.id WHERE p.path=?1", [path], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((current, expected)) = row {
                if let Some(expected) = expected {
                    let p = original(Path::new(&current))?;
                    if fingerprint(&p)? != expected { return Err(invalid("外部参考图已修改，请先在本机文件浏览器的「外部引用」中确认更新")); }
                }
                Ok(current)
            } else { Ok(path.clone()) }
        }).collect()
    }
    pub fn update_external(
        &self,
        paths: &LibraryPaths,
        id: &str,
        path: &Path,
        accept_changes: bool,
    ) -> AppResult<Asset> {
        let path = original(path)?;
        let managed: bool = self.conn.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE store_path=?1 AND NOT EXISTS(SELECT 1 FROM external_assets WHERE asset_id=assets.id))",
            [path.to_string_lossy().as_ref()], |row| row.get(0))?;
        if managed || path.starts_with(fs::canonicalize(&paths.images)?) {
            return Err(invalid("重新定位请选择库外原图片"));
        }
        let hash = fingerprint(&path)?;
        let media = crate::media::probe::probe(&path)?;
        let dimensions = (media.width, media.height);
        let thumb = if video_path(&path) { preview(paths, &path).ok() } else { Some(preview(paths, &path)?) };
        if fingerprint(&path)? != hash {
            return Err(invalid("图片正在被修改，请稍后重试"));
        }
        let path = path.to_string_lossy().into_owned();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let expected: String = tx.query_row(
            "SELECT fingerprint FROM external_assets WHERE asset_id=?1",
            [id],
            |r| r.get(0),
        )?;
        if !accept_changes && expected != hash {
            return Err(invalid(
                "图片内容与原引用不同，请选择原图片；修改后的图片需使用「更新引用」",
            ));
        }
        let conflict: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM external_asset_paths WHERE path=?1 AND asset_id<>?2)",
            params![path, id],
            |r| r.get(0),
        )?;
        if conflict {
            return Err(invalid("该路径已用于其他素材引用"));
        }
        if accept_changes && expected != hash {
            tx.execute("DELETE FROM analyses WHERE asset_id=?1", [id])?;
        }
        tx.execute(
            "UPDATE external_assets SET fingerprint=?2 WHERE asset_id=?1",
            params![id, hash],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO external_asset_paths(asset_id,path) VALUES(?1,?2)",
            params![id, path],
        )?;
        tx.execute("UPDATE assets SET origin_path=?2,store_path=?2,thumb_path=?3,size=?4,width=?5,height=?6 WHERE id=?1",params![id,path,thumb,fs::metadata(&path)?.len() as i64,dimensions.0,dimensions.1])?;
        tx.execute("UPDATE assets SET duration=?2,ext=?3 WHERE id=?1", params![id,media.duration,media.ext])?;
        tx.commit()?;
        drop(conn);
        self.get_asset(id)?.ok_or_else(|| invalid("引用不存在"))
    }
    pub fn copy_external_to_library(&self, paths: &LibraryPaths, id: &str) -> AppResult<Asset> {
        if !self.is_external_asset(id)? {
            return self.get_asset(id)?.ok_or_else(|| invalid("素材不存在"));
        }
        let asset = self.get_asset(id)?.ok_or_else(|| invalid("引用不存在"))?;
        let source = asset
            .store_path
            .as_deref()
            .ok_or_else(|| invalid("原文件不可用"))?;
        self.resolve_external_paths(&[source.into()])?;
        let expected: String = self.conn.lock().unwrap().query_row(
            "SELECT fingerprint FROM external_assets WHERE asset_id=?1",
            [id],
            |r| r.get(0),
        )?;
        let destination = paths.asset_store_path(id, asset.ext.as_deref().unwrap_or("png"))?;
        fs::create_dir_all(destination.parent().unwrap())?;
        // create_new avoids overwriting unrelated data on interrupted retries.
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        let managed_thumb = paths.thumb_path(id);
        let result = (|| -> AppResult<()> {
            std::io::copy(&mut fs::File::open(source)?, &mut output)?;
            output.sync_all()?;
            self.resolve_external_paths(&[source.into()])?;
            let copied_thumb = if video_path(&destination) {
                crate::media::thumb::generate_video(&destination, &managed_thumb, 480).ok().map(|_| managed_thumb.to_string_lossy().into_owned())
            } else {
                crate::media::thumb::generate(&destination, &managed_thumb, 480)?;
                Some(managed_thumb.to_string_lossy().into_owned())
            };
            let conn = self.conn.lock().unwrap();
            let tx = conn.unchecked_transaction()?;
            let unchanged: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM external_assets e JOIN assets a ON a.id=e.asset_id WHERE a.id=?1 AND a.store_path=?2 AND e.fingerprint=?3)", params![id,source,expected], |r| r.get(0))?;
            if !unchanged || fingerprint(&destination)? != expected {
                return Err(invalid("引用或原文件已变化，请重试复制"));
            }
            tx.execute("DELETE FROM external_assets WHERE asset_id=?1", [id])?;
            tx.execute("UPDATE assets SET store_path=?2,thumb_path=?3,source='imported',library_hidden=0 WHERE id=?1",params![id,destination.to_string_lossy(),copied_thumb])?;
            tx.commit()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&destination);
            let _ = fs::remove_file(&managed_thumb);
        }
        result?;
        self.get_asset(id)?.ok_or_else(|| invalid("素材不存在"))
    }
}
#[derive(Serialize)]
pub struct ExternalReference {
    pub asset: Asset,
    pub status: String,
}
pub fn references(db: &Database, project_id: &str) -> AppResult<Vec<ExternalReference>> {
    let ids = {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT e.asset_id FROM external_assets e JOIN project_assets p ON p.asset_id=e.asset_id WHERE p.project_id=?1")?;
        let ids = stmt
            .query_map([project_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    ids.into_iter()
        .map(|id| {
            let asset = db.get_asset(&id)?.ok_or_else(|| invalid("引用不存在"))?;
            let status = match asset.store_path.as_deref() {
                Some(path) if Path::new(path).is_file() => {
                    if db.resolve_external_paths(&[path.into()]).is_ok() {
                        "available"
                    } else {
                        "changed"
                    }
                }
                _ => "missing",
            }
            .into();
            Ok(ExternalReference { asset, status })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{
        ingest,
        projects::{AssetDeleteMode, ProjectDeleteMode},
    };
    struct Fixture {
        root: PathBuf,
        paths: LibraryPaths,
        db: Database,
        original: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("bowerbird-external-test-{}", ulid::Ulid::new()));
            fs::create_dir_all(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let paths = LibraryPaths::init(root.join("library")).unwrap();
            let original = root.join("original.png");
            image::RgbImage::from_pixel(10, 20, image::Rgb([12, 34, 56]))
                .save(&original)
                .unwrap();
            let db = Database::open(&paths.db).unwrap();
            db.migrate().unwrap();
            Self {
                root,
                paths,
                db,
                original,
            }
        }
        fn index(&self) -> Asset {
            self.db.index_external(&self.paths, &self.original).unwrap()
        }
        fn project(&self, id: &str, asset: &str) {
            self.db
                .create_project(id, id, self.root.to_str().unwrap(), id, "user")
                .unwrap();
            self.db.add_assets_to_project(id, &[asset.into()]).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn warm_directory_returns_previews_without_decoding_and_invalidates_changes() {
        let f = Fixture::new();
        let thumbnail = preview(&f.paths, &f.original).unwrap();
        let mut page = browse_page(Some(f.root.to_str().unwrap()), 0, true).unwrap();
        attach_previews(&f.paths, &mut page.entries);
        let entry = page.entries.iter().find(|entry| entry.path == f.original.to_string_lossy()).unwrap();
        assert_eq!(entry.preview.as_deref(), Some(thumbnail.as_str()));
        let version = entry.version.clone();
        assert_eq!(cached_preview(&f.paths, &f.original).unwrap(), Some(thumbnail));
        fs::write(&f.original, b"changed and deliberately not decodable").unwrap();
        let mut page = browse_page(Some(f.root.to_str().unwrap()), 0, true).unwrap();
        attach_previews(&f.paths, &mut page.entries);
        let entry = page.entries.iter().find(|entry| entry.path == f.original.to_string_lossy()).unwrap();
        assert_ne!(entry.version, version);
        assert!(entry.preview.is_none());
        assert!(cached_preview(&f.paths, &f.original).unwrap().is_none());
    }
    #[test]
    fn indexed_thumbnail_reused_only_when_original_content_matches() {
        let f = Fixture::new();
        let asset = ingest::ingest_file(&f.paths, &f.db, &f.original).unwrap();
        let source = Path::new(asset.store_path.as_ref().unwrap());
        let expected = fingerprint(source).unwrap();
        f.db.conn.lock().unwrap().execute(
            "INSERT INTO creative_file_fingerprints(asset_id,sha256,asset_size,asset_mtime) VALUES(?1,?2,?3,?4)",
            params![asset.id, expected, asset.size, asset.file_mtime]).unwrap();
        let thumb = fs::read(asset.thumb_path.unwrap()).unwrap();
        let output = preview_with_index(&f.paths, Some(&f.db), source).unwrap();
        assert_eq!(fs::read(&output).unwrap(), thumb);
        image::RgbImage::from_pixel(60, 80, image::Rgb([240, 0, 0])).save(source).unwrap();
        let changed = preview_with_index(&f.paths, Some(&f.db), source).unwrap();
        assert_ne!(output, changed);
        assert_ne!(fs::read(changed).unwrap(), thumb);
    }
    #[test]
    fn directory_browser_lists_media_and_folders_without_indexing() {
        let f = Fixture::new();
        fs::write(f.root.join("video.MP4"), b"listed without decoding").unwrap();
        fs::write(f.root.join("notes.txt"), b"not media").unwrap();
        for i in 0..130 { fs::write(f.root.join(format!("image-{i}.jpg")), b"listed without decoding").unwrap(); }
        let page = browse(Some(f.root.to_str().unwrap()),0).unwrap();
        assert_eq!(page.entries.len(),120);
        let all = browse_page(Some(f.root.to_str().unwrap()),0,true).unwrap();
        assert_eq!(all.entries.len(),all.total);
        assert!(all.entries[0].directory);
        assert!(all.entries.iter().any(|e| e.name == "video.MP4"));
        assert!(!all.entries.iter().any(|e| e.name == "notes.txt"));
        assert_eq!(f.db.count_assets(None).unwrap(),0);
    }
    #[test]
    #[ignore = "requires local ffmpeg for synthetic video and poster; no network or user library"]
    fn external_video_reference_relink_and_copy_keep_original() {
        let f=Fixture::new();
        let video=f.root.join("clip.mp4");
        let mut command=crate::media::tools::command(crate::media::tools::resolve(crate::media::tools::Tool::Ffmpeg).unwrap());
        #[cfg(target_os="windows")]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let output=command.args(["-y","-f","lavfi","-i","color=c=red:s=120x240:r=25","-t","0.4","-pix_fmt","yuv420p"]).arg(&video).output().unwrap();
        assert!(output.status.success());
        let original=fs::read(&video).unwrap();
        let asset=f.db.index_external(&f.paths,&video).unwrap();
        assert_eq!(asset.ext.as_deref(),Some("mp4"));
        assert_eq!((asset.width,asset.height),(Some(120),Some(240)));
        assert!((asset.duration.unwrap()-0.4).abs()<0.05);
        assert!(asset.thumb_path.as_ref().is_some_and(|p| Path::new(p).is_file()));
        assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(),0);
        let moved=f.root.join("moved.mp4"); fs::rename(&video,&moved).unwrap();
        let relinked=f.db.update_external(&f.paths,&asset.id,&moved,false).unwrap();
        assert_eq!(relinked.ext.as_deref(),Some("mp4"));
        let copied=f.db.copy_external_to_library(&f.paths,&asset.id).unwrap();
        assert_eq!(copied.id,asset.id);
        assert_eq!(fs::read(&moved).unwrap(),original);
        assert_eq!(fs::read(copied.store_path.unwrap()).unwrap(),original);
    }
    #[test]
    fn index_is_reference_only_deduplicated_hidden_and_persists() {
        let f = Fixture::new();
        let bytes = fs::read(&f.original).unwrap();
        let a = f.index();
        assert_eq!(a.store_path, a.origin_path);
        assert_eq!(a.source.as_deref(), Some("external"));
        assert!(a.library_hidden);
        assert_eq!(f.index().id, a.id);
        assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
        assert_eq!(f.db.count_assets(None).unwrap(), 0);
        f.db.conn
            .lock()
            .unwrap()
            .execute("UPDATE assets SET library_hidden=0 WHERE id=?1", [&a.id])
            .unwrap();
        assert!(f.db.get_asset(&a.id).unwrap().unwrap().library_hidden);
        let reopened = Database::open(&f.paths.db).unwrap();
        reopened.migrate().unwrap();
        assert_eq!(
            reopened
                .resolve_external_paths(&[a.store_path.unwrap()])
                .unwrap()[0],
            f.original.to_str().unwrap()
        );
        assert_eq!(fs::read(&f.original).unwrap(), bytes);
    }
    #[test]
    fn explicit_project_library_membership_preserves_original_without_canvas_or_copy() {
        let f = Fixture::new();
        let a = f.index();
        let bytes = fs::read(&f.original).unwrap();
        f.project("library-project", &a.id);
        f.db.ensure_project_canvas("library-project").unwrap();
        assert_eq!(f.db.count_assets(Some("library-project")).unwrap(), 1);
        assert_eq!(f.db.get_project("library-project").unwrap().unwrap().asset_count, 1);
        assert!(!f.index().library_hidden);
        let snapshot = f.db.project_canvas_snapshot("library-project").unwrap();
        assert!(snapshot.nodes.is_empty());
        assert!(snapshot.threads.is_empty());
        assert!(f.db.is_external_asset(&a.id).unwrap());
        assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
        assert_eq!(fs::read(&f.original).unwrap(), bytes);
        let reopened = Database::open(&f.paths.db).unwrap();
        reopened.migrate().unwrap();
        assert_eq!(reopened.count_assets(Some("library-project")).unwrap(), 1);
    }
    #[test]
    fn external_rename_and_all_delete_modes_preserve_original() {
        let f = Fixture::new();
        let bytes = fs::read(&f.original).unwrap();
        let a = f.index();
        f.project("p", &a.id);
        f.db.rename_asset_files(&a.id, "renamed").unwrap();
        assert_eq!(f.db.get_asset(&a.id).unwrap().unwrap().name, "renamed");
        assert!(f
            .db
            .delete_asset_with_mode(&a.id, AssetDeleteMode::MoveOut, None)
            .is_err());
        f.db.delete_asset_with_mode(&a.id, AssetDeleteMode::Keep, Some("p"))
            .unwrap();
        f.db.delete_asset_with_mode(&a.id, AssetDeleteMode::Delete, None)
            .unwrap();
        assert_eq!(fs::read(&f.original).unwrap(), bytes);
    }
    #[test]
    fn project_move_out_cannot_move_external_originals() {
        let f = Fixture::new();
        let a = f.index();
        f.project("p", &a.id);
        let bytes = fs::read(&f.original).unwrap();
        f.db.delete_project("p", ProjectDeleteMode::MoveOut)
            .unwrap();
        assert_eq!(fs::read(&f.original).unwrap(), bytes);
        assert!(!f.db.get_asset(&a.id).unwrap().unwrap().library_hidden);
    }
    #[test]
    fn missing_changed_and_relinked_references_validate_before_generation() {
        let f = Fixture::new();
        let a = f.index();
        f.project("p", &a.id);
        let old = a.store_path.unwrap();
        let moved = f.root.join("moved.png");
        fs::rename(&f.original, &moved).unwrap();
        assert!(f.db.resolve_external_paths(&[old.clone()]).is_err());
        assert_eq!(references(&f.db, "p").unwrap()[0].status, "missing");
        f.db.update_external(&f.paths, &a.id, &moved, false)
            .unwrap();
        assert_eq!(
            f.db.resolve_external_paths(&[old.clone()]).unwrap()[0],
            moved.to_str().unwrap()
        );
        image::RgbImage::from_pixel(15, 25, image::Rgb([1, 2, 3]))
            .save(&moved)
            .unwrap();
        assert!(f.db.resolve_external_paths(&[old.clone()]).is_err());
        assert!(f
            .db
            .update_external(&f.paths, &a.id, &moved, false)
            .is_err());
        assert_eq!(references(&f.db, "p").unwrap()[0].status, "changed");
        let refreshed = f.db.update_external(&f.paths, &a.id, &moved, true).unwrap();
        assert_eq!(refreshed.width, Some(15));
        assert!(f.db.resolve_external_paths(&[old]).is_ok());
    }
    #[test]
    fn explicit_copy_keeps_identity_and_original_but_owns_new_files() {
        let f = Fixture::new();
        let a = f.index();
        let old = a.store_path.unwrap();
        let bytes = fs::read(&f.original).unwrap();
        let copied = f.db.copy_external_to_library(&f.paths, &a.id).unwrap();
        assert_eq!(a.id, copied.id);
        assert!(!copied.library_hidden);
        assert!(!f.db.is_external_asset(&a.id).unwrap());
        assert!(Path::new(copied.store_path.as_ref().unwrap()).starts_with(&f.paths.images));
        assert_eq!(
            f.db.resolve_external_paths(&[old]).unwrap()[0],
            copied.store_path.clone().unwrap()
        );
        assert_eq!(f.index().id, copied.id);
        image::RgbImage::from_pixel(10, 20, image::Rgb([200, 100, 50]))
            .save(&f.original)
            .unwrap();
        assert!(f.db.index_external(&f.paths, &f.original).is_err());
        fs::write(&f.original, &bytes).unwrap();
        f.db.delete_asset(&a.id).unwrap();
        assert!(!Path::new(copied.store_path.as_ref().unwrap()).exists());
        assert_eq!(fs::read(&f.original).unwrap(), bytes);
    }
    #[test]
    fn regular_import_does_not_deduplicate_into_an_external_reference() {
        let f = Fixture::new();
        let linked = f.index();
        let imported = ingest::ingest_file(&f.paths, &f.db, &f.original).unwrap();
        assert_ne!(linked.id, imported.id);
        assert_ne!(imported.store_path, imported.origin_path);
        assert!(!imported.library_hidden);
    }
    #[test]
    fn browsing_is_read_only_filtered_and_paginated() {
        let f = Fixture::new();
        fs::write(f.root.join("private.txt"), "ignore").unwrap();
        fs::create_dir(f.root.join("album")).unwrap();
        let page = browse(Some(f.root.to_str().unwrap()), 0).unwrap();
        assert!(page
            .entries
            .iter()
            .any(|e| e.name == "album" && e.directory));
        assert!(!page.entries.iter().any(|e| e.name == "private.txt"));
        assert_eq!(f.db.external_paths().unwrap().len(), 0);
        assert!(browse(Some(f.original.to_str().unwrap()), 0).is_err());
        assert!(browse(Some(f.root.to_str().unwrap()), 9999)
            .unwrap()
            .entries
            .is_empty());
    }
    #[tokio::test]
    async fn external_reference_flows_through_canvas_generation_and_cloud_preparation() {
        use crate::core::creative_session_contract::{
            CreativeNodeKind, CreativeNodeRole, CreativeThreadOrigin,
        };
        use crate::core::project_canvas::{
            NewCanvasNode, NewCreativeThread, ProjectGenerationTurnInput,
        };
        let f = Fixture::new();
        image::RgbImage::from_pixel(30, 40, image::Rgb([12, 34, 56]))
            .save(&f.original)
            .unwrap();
        let asset = f.index();
        f.db.create_project("p", "p", f.root.to_str().unwrap(), "p", "user").unwrap();
        f.db.ensure_project_canvas("p").unwrap();
        f.db.create_creative_thread(&NewCreativeThread {
            id: "t".into(),
            project_id: "p".into(),
            title: "Reference test".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        f.db.create_canvas_node(&NewCanvasNode {
            id: "reference-node".into(),
            project_id: "p".into(),
            thread_id: None,
            kind: CreativeNodeKind::Asset,
            asset_id: Some(asset.id.clone()),
            role: Some(CreativeNodeRole::Reference),
            payload_json: r#"{"schema_version":1,"snapshot":{"name":"external"}}"#.into(),
            x: 12.0,
            y: 34.0,
            width: 190.0,
            height: 250.0,
            z_index: 1,
            position_locked: false,
        })
        .unwrap();
        let refs =
            f.db.resolve_external_paths(&[asset.store_path.clone().unwrap()])
                .unwrap();
        let graph =
            f.db.begin_project_generation_turn(&ProjectGenerationTurnInput {
                project_id: "p".into(),
                thread_id: "t".into(),
                generation_conversation_id: "conversation".into(),
                job_id: "job".into(),
                turn_key: "turn".into(),
                prompt: "参考这张图".into(),
                applied_prompt: "参考这张图".into(),
                provider: "test-provider".into(),
                provider_session_id: None,
                ratio: None,
                visual_profile: None,
                references: refs.clone(),
                reference_node_ids: vec![Some("reference-node".into())],
                parent_node_id: None,
                parent_asset_path: None,
                relation: None,
                retry_anchor_node_id: None,
            })
            .unwrap();
        assert_eq!(graph.reference_node_ids, vec!["reference-node"]);
        let snapshot = f.db.project_canvas_snapshot("p").unwrap();
        assert_eq!(
            snapshot
                .nodes
                .iter()
                .filter(|n| n.asset_id.as_deref() == Some(&asset.id))
                .count(),
            1
        );
        let jpeg = crate::codex::cloud_image::read_agent_reference_jpeg(Path::new(&refs[0]))
            .await
            .unwrap();
        assert!(jpeg.starts_with(&[0xff, 0xd8, 0xff]));
        assert_eq!(fs::read_dir(&f.paths.images).unwrap().count(), 0);
        f.db.remove_canvas_node("reference-node").unwrap();
        assert!(f.db.get_asset(&asset.id).unwrap().unwrap().library_hidden);
        assert!(f.original.is_file());
    }
}
