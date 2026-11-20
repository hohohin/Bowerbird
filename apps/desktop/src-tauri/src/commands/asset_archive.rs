//! Export selected originals as a ZIP or as complete, non-overwriting file copies.
use crate::{
    core::library::sanitize_file_stem,
    db::Database,
    error::{AppError, AppResult},
};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;
use rusqlite::OptionalExtension;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

#[tauri::command]
pub async fn export_assets_zip(
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
    path: String,
) -> AppResult<usize> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || write_archive(&db, &asset_ids, Path::new(&path)))
        .await
        .map_err(|error| AppError::Other(format!("打包失败：{error}")))?
}

#[tauri::command]
pub async fn export_assets_to_directory(
    db: State<'_, Arc<Database>>,
    asset_ids: Vec<String>,
    path: String,
) -> AppResult<usize> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || write_directory(&db, &asset_ids, Path::new(&path)))
        .await
        .map_err(|error| AppError::Other(format!("导出文件失败：{error}")))?
}

struct ExportOriginal {
    source: PathBuf,
    stem: String,
    suffix: String,
}

impl ExportOriginal {
    fn name(&self, index: usize) -> String {
        if index == 1 {
            format!("{}{}", self.stem, self.suffix)
        } else {
            format!("{} ({index}){}", self.stem, self.suffix)
        }
    }
}

fn originals(db: &Database, ids: &[String]) -> AppResult<Vec<ExportOriginal>> {
    if ids.is_empty() {
        return Err(AppError::Other("请先选择要导出的素材".into()));
    }
    let assets = db.get_assets_by_ids(ids)?;
    if assets.len() != ids.iter().collect::<HashSet<_>>().len() {
        return Err(AppError::Other("所选素材已不存在，请重新选择".into()));
    }
    let mut entries = Vec::with_capacity(assets.len());
    for asset in assets {
        let source = db.resolve_asset_original(&asset.id).map_err(|error| {
            AppError::Other(format!("{}：无法读取原文件（{error}）", asset.name))
        })?;
        let expected: Option<String> = db.conn.lock().unwrap().query_row(
            "SELECT fingerprint FROM external_assets WHERE asset_id=?1", [&asset.id], |row| row.get(0)).optional()?;
        if let Some(expected) = expected {
            if crate::core::external_files::fingerprint(&source)? != expected {
                return Err(AppError::Other("外部参考图已修改，请先确认更新引用".into()));
            }
        }
        let extension = source
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("");
        let suffix = if extension.is_empty() {
            String::new()
        } else {
            format!(".{extension}")
        };
        let name = asset
            .name
            .rsplit_once('.')
            .filter(|(_, ext)| !extension.is_empty() && ext.eq_ignore_ascii_case(extension))
            .map_or(asset.name.as_str(), |(stem, _)| stem);
        let stem = sanitize_file_stem(name, "图片");
        entries.push(ExportOriginal {
            source,
            stem,
            suffix,
        });
    }
    Ok(entries)
}

fn copy_original(file: &mut File, before: &fs::Metadata, out: &mut impl Write) -> AppResult<()> {
    let copied = io::copy(file, out)?;
    let after = file.metadata()?;
    if copied != before.len()
        || after.len() != before.len()
        || after.modified()? != before.modified()?
    {
        return Err(AppError::Other("原文件正在变化，请稍后重新导出".into()));
    }
    Ok(())
}

fn write_archive(db: &Database, ids: &[String], destination: &Path) -> AppResult<usize> {
    if !destination.is_absolute()
        || !destination
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err(AppError::Other("请选择以 .zip 结尾的保存位置".into()));
    }
    if fs::symlink_metadata(destination).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(AppError::Other("压缩包保存位置不能是符号链接".into()));
    }
    let entries = originals(db, ids)?;
    if let Ok(existing) = fs::canonicalize(destination) {
        if entries.iter().any(|entry| entry.source == existing) {
            return Err(AppError::Other(
                "保存位置与原文件相同，请选择其他位置".into(),
            ));
        }
    }
    let mut temporary = tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
    let mut archive = ZipWriter::new(temporary.as_file_mut());
    let mut names = HashSet::new();
    for entry in &entries {
        let name = (1..)
            .map(|i| entry.name(i))
            .find(|name| names.insert(name.to_lowercase()))
            .unwrap();
        let mut file = File::open(&entry.source)
            .map_err(|error| AppError::Other(format!("{name}：无法读取原文件（{error}）")))?;
        let before = file.metadata()?;
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(before.len() >= u32::MAX as u64);
        archive
            .start_file(&name, options)
            .map_err(|error| AppError::Other(format!("打包失败：{error}")))?;
        copy_original(&mut file, &before, &mut archive)?;
    }
    archive
        .finish()
        .map_err(|error| AppError::Other(format!("打包失败：{error}")))?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(destination)
        .map_err(|error| AppError::Other(format!("保存压缩包失败：{error}")))?;
    Ok(entries.len())
}

fn write_directory(db: &Database, ids: &[String], directory: &Path) -> AppResult<usize> {
    if !directory.is_absolute() || !directory.is_dir() {
        return Err(AppError::Other("请选择可用的导出文件夹".into()));
    }
    let directory = directory.canonicalize()?;
    let entries = originals(db, ids)?;
    let mut staged = Vec::with_capacity(entries.len());
    for entry in &entries {
        let mut original = File::open(&entry.source)?;
        let before = original.metadata()?;
        let mut copy = tempfile::NamedTempFile::new_in(&directory)?;
        copy_original(&mut original, &before, copy.as_file_mut())?;
        copy.as_file().sync_all()?;
        staged.push(copy.into_temp_path());
    }

    let mut names = HashSet::new();
    for (written, (entry, mut copy)) in entries.iter().zip(staged).enumerate() {
        for index in 1.. {
            let name = entry.name(index);
            if !names.insert(name.to_lowercase()) {
                continue;
            }
            let target = directory.join(name);
            match copy.persist_noclobber(&target) {
                Ok(()) => break,
                Err(error)
                    if error.error.kind() == io::ErrorKind::AlreadyExists
                        || fs::symlink_metadata(&target).is_ok() =>
                {
                    copy = error.path;
                }
                Err(error) => {
                    tracing::warn!("directory export could not publish a copy: {}", error.error);
                    return Err(AppError::Other(format!("已导出 {written} 个文件，保存剩余文件失败，请检查目标文件夹的写入权限和可用空间。")));
                }
            }
        }
    }
    Ok(entries.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn fixture() -> (tempfile::TempDir, Database) {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        for (id, name) in [("a", "风景"), ("b", "风景"), ("c", "../CON:示例")] {
            let path = root.path().join(format!("{id}.png"));
            fs::write(&path, format!("original-{id}")).unwrap();
            db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,store_path,created_at) VALUES(?1,?2,'png',?3,1)",
                rusqlite::params![id, name, path.to_str().unwrap()]).unwrap();
        }
        (root, db)
    }

    #[test]
    fn zip_roundtrip_keeps_originals_and_unique_safe_names() {
        let (root, db) = fixture();
        let output = root.path().join("所选内容.zip");
        assert_eq!(
            write_archive(
                &db,
                &["a".into(), "b".into(), "a".into(), "c".into()],
                &output
            )
            .unwrap(),
            3
        );
        let mut archive = zip::ZipArchive::new(File::open(output).unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        for (index, id) in ["a", "b", "c"].iter().enumerate() {
            let mut entry = archive.by_index(index).unwrap();
            assert_eq!(entry.enclosed_name().unwrap().components().count(), 1);
            if index < 2 {
                assert_eq!(entry.name(), ["风景.png", "风景 (2).png"][index]);
            }
            let mut content = String::new();
            entry.read_to_string(&mut content).unwrap();
            assert_eq!(content, format!("original-{id}"));
            assert_eq!(
                fs::read_to_string(root.path().join(format!("{id}.png"))).unwrap(),
                content
            );
            assert!(db.get_asset(id).unwrap().is_some());
        }
    }

    #[test]
    fn missing_source_preserves_existing_archive_and_leaves_no_partial_file() {
        let (root, db) = fixture();
        let output = root.path().join("saved.zip");
        fs::write(&output, b"existing archive").unwrap();
        fs::remove_file(root.path().join("b.png")).unwrap();
        assert!(write_archive(&db, &["a".into(), "b".into()], &output).is_err());
        assert_eq!(fs::read(output).unwrap(), b"existing archive");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
        assert!(write_archive(&db, &["missing".into()], &root.path().join("new.zip")).is_err());
        assert!(!root.path().join("new.zip").exists());
    }

    #[test]
    fn invalid_destination_and_empty_selection_are_rejected() {
        let (root, db) = fixture();
        assert!(write_archive(&db, &[], &root.path().join("empty.zip")).is_err());
        assert!(write_archive(&db, &["a".into()], &root.path().join("a.png")).is_err());
        assert_eq!(fs::read(root.path().join("a.png")).unwrap(), b"original-a");
    }

    #[test]
    fn directory_copies_original_bytes_and_preserves_conflicting_files_and_directories() {
        let (root, db) = fixture();
        let destination = root.path().join("导出");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("风景.png"), b"keep this").unwrap();
        fs::create_dir(destination.join("风景 (2).png")).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET name='风景.PNG',thumb_path='unused-preview.jpg' WHERE id='b'",
                [],
            )
            .unwrap();

        let ids = ["b".into(), "a".into(), "b".into(), "c".into()];
        assert_eq!(write_directory(&db, &ids, &destination).unwrap(), 3);
        assert_eq!(
            fs::read(destination.join("风景.png")).unwrap(),
            b"keep this"
        );
        assert!(destination.join("风景 (2).png").is_dir());
        assert_eq!(
            fs::read(destination.join("风景 (3).png")).unwrap(),
            b"original-b"
        );
        assert_eq!(
            fs::read(destination.join("风景 (4).png")).unwrap(),
            b"original-a"
        );
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 5);
        assert!(fs::read_dir(&destination)
            .unwrap()
            .flatten()
            .any(|entry| fs::read(entry.path()).is_ok_and(|bytes| bytes == b"original-c")));
        assert_eq!(fs::read(root.path().join("a.png")).unwrap(), b"original-a");
    }

    #[test]
    fn directory_export_to_source_folder_and_concurrent_exports_never_replace_an_original() {
        let (root, db) = fixture();
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE assets SET name='a' WHERE id='a'", [])
            .unwrap();
        let export = || write_directory(&db, &["a".into()], root.path()).unwrap();
        std::thread::scope(|scope| {
            let concurrent = scope.spawn(export);
            assert_eq!(export(), 1);
            assert_eq!(concurrent.join().unwrap(), 1);
        });
        for name in ["a.png", "a (2).png", "a (3).png"] {
            assert_eq!(fs::read(root.path().join(name)).unwrap(), b"original-a");
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 5);
    }

    #[test]
    fn directory_export_rejects_missing_originals_and_invalid_targets_without_writing() {
        let (root, db) = fixture();
        let output = root.path().join("导出");
        fs::create_dir(&output).unwrap();
        fs::remove_file(root.path().join("b.png")).unwrap();
        assert!(write_directory(&db, &["a".into(), "b".into()], &output).is_err());
        assert!(write_directory(&db, &["a".into(), "gone".into()], &output).is_err());
        assert!(write_directory(&db, &[], &output).is_err());
        assert!(write_directory(&db, &["a".into()], Path::new(".")).is_err());
        assert!(write_directory(&db, &["a".into()], &root.path().join("a.png")).is_err());
        assert_eq!(fs::read_dir(output).unwrap().count(), 0);
    }

    #[test]
    fn changed_external_original_is_not_exported_to_either_destination() {
        let (root, db) = fixture();
        let source = root.path().join("a.png");
        let fingerprint = crate::core::external_files::fingerprint(&source).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO external_assets(asset_id,fingerprint) VALUES('a',?1)",
                [fingerprint],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO external_asset_paths(asset_id,path) VALUES('a',?1)",
                [source.to_str().unwrap()],
            )
            .unwrap();
        }
        fs::write(&source, b"replacement").unwrap();
        let output = root.path().join("导出");
        fs::create_dir(&output).unwrap();
        assert!(write_directory(&db, &["b".into(), "a".into()], &output).is_err());
        assert!(write_archive(&db, &["a".into()], &output.join("所选内容.zip")).is_err());
        assert_eq!(fs::read_dir(output).unwrap().count(), 0);
        assert_eq!(fs::read(source).unwrap(), b"replacement");
    }

    #[test]
    fn export_uses_verified_aliases_and_blocks_cleaned_assets_without_changing_registration() {
        let (root, db) = fixture();
        let original = root.path().join("a.png");
        let alias = root.path().join("原件 重定位.png");
        fs::rename(&original, &alias).unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO external_assets(asset_id,fingerprint) VALUES('a',?1)", [crate::core::external_files::fingerprint(&alias).unwrap()]).unwrap();
            conn.execute("INSERT INTO external_asset_paths(asset_id,path) VALUES('a',?1)", [alias.to_string_lossy()]).unwrap();
        }
        let output = root.path().join("导出");
        fs::create_dir(&output).unwrap();
        assert_eq!(write_directory(&db, &["a".into()], &output).unwrap(), 1);
        assert_eq!(fs::read(output.join("风景.png")).unwrap(), b"original-a");
        let zip = root.path().join("alias.zip");
        assert_eq!(write_archive(&db, &["a".into()], &zip).unwrap(), 1);
        let mut archive = zip::ZipArchive::new(File::open(zip).unwrap()).unwrap();
        let mut entry = archive.by_name("风景.png").unwrap();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"original-a");
        assert_eq!(db.get_asset("a").unwrap().unwrap().store_path.as_deref(), original.to_str());

        db.conn.lock().unwrap().execute("INSERT INTO removed_missing_asset_originals(asset_id,path) VALUES('a',?1)", [original.to_string_lossy()]).unwrap();
        assert!(write_directory(&db, &["a".into()], &output).is_err());
        assert!(write_archive(&db, &["a".into()], &root.path().join("blocked.zip")).is_err());
        assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
        assert!(!root.path().join("blocked.zip").exists());
        assert_eq!(fs::read(alias).unwrap(), b"original-a");
    }
}
