//! Read-only export of explicitly selected originals; publish only a complete ZIP.
use crate::{
    core::library::sanitize_file_stem,
    db::Database,
    error::{AppError, AppResult},
};
use std::{
    collections::HashSet,
    fs::{self, File},
    path::Path,
    sync::Arc,
};
use tauri::State;
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

fn write_archive(db: &Database, ids: &[String], destination: &Path) -> AppResult<usize> {
    if ids.is_empty() {
        return Err(AppError::Other("请先选择要打包的图片".into()));
    }
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
    let existing_destination = fs::canonicalize(destination).ok();
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        let asset = db
            .get_asset(id)?
            .ok_or_else(|| AppError::Other("所选素材已不存在，请重新选择".into()))?;
        let path = asset
            .store_path
            .ok_or_else(|| AppError::Other(format!("{}：原文件不可用", asset.name)))?;
        let paths = db.resolve_external_paths(&[path])?;
        let source = fs::canonicalize(&paths[0]).map_err(|error| {
            AppError::Other(format!("{}：无法读取原文件（{error}）", asset.name))
        })?;
        if !source.is_file() || existing_destination.as_ref() == Some(&source) {
            return Err(AppError::Other(format!(
                "{}：原文件不可用或与保存位置相同",
                asset.name
            )));
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
        let name =
            if !suffix.is_empty() && asset.name.to_lowercase().ends_with(&suffix.to_lowercase()) {
                &asset.name[..asset.name.len() - suffix.len()]
            } else {
                &asset.name
            };
        let stem = sanitize_file_stem(name, "图片");
        entries.push((source, stem, suffix));
    }
    let mut temporary = tempfile::NamedTempFile::new_in(destination.parent().unwrap())?;
    let mut archive = ZipWriter::new(temporary.as_file_mut());
    let mut names = HashSet::new();
    for (source, stem, suffix) in &entries {
        let mut name = format!("{stem}{suffix}");
        let mut index = 2;
        while !names.insert(name.to_lowercase()) {
            name = format!("{stem} ({index}){suffix}");
            index += 1;
        }
        let mut file = File::open(source)
            .map_err(|error| AppError::Other(format!("{name}：无法读取原文件（{error}）")))?;
        let before = file.metadata()?;
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .large_file(before.len() >= u32::MAX as u64);
        archive
            .start_file(&name, options)
            .map_err(|error| AppError::Other(format!("打包失败：{error}")))?;
        let copied = std::io::copy(&mut file, &mut archive)?;
        let after = file.metadata()?;
        if copied != before.len()
            || after.len() != before.len()
            || after.modified()? != before.modified()?
        {
            return Err(AppError::Other(format!(
                "{name}：文件正在变化，请稍后重新打包"
            )));
        }
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
}
