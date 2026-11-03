//! Resolve registered originals for native outgoing drag. Never materialize copies.
use crate::{
    core::external_files,
    db::Database,
    error::{AppError, AppResult},
};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub fn files(db: &Database, ids: &[String]) -> AppResult<Vec<PathBuf>> {
    if ids.is_empty() {
        return Err(AppError::Other("请选择要拖出的素材".into()));
    }
    let assets = db.get_assets_by_ids(ids)?;
    if assets.len() != ids.iter().collect::<HashSet<_>>().len() {
        return Err(AppError::Other("部分素材已不存在，请刷新后重新选择".into()));
    }
    let unavailable = || AppError::Other("部分原文件不可用，请重新定位后再拖出".into());
    let mut paths = Vec::with_capacity(assets.len());
    let mut seen = HashSet::new();
    for asset in assets {
        let stored = Path::new(asset.store_path.as_deref().ok_or_else(unavailable)?);
        let path = fs::canonicalize(stored).map_err(|_| unavailable())?;
        if !path.is_file()
            || !(external_files::image_path(&path)
                || external_files::video_path(&path)
                || external_files::audio_path(&path))
        {
            return Err(unavailable());
        }
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::LibraryPaths;
    use std::fs;

    fn fixture() -> (
        tempfile::TempDir,
        LibraryPaths,
        Database,
        Vec<String>,
        Vec<PathBuf>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(directory.path()).unwrap();
        let paths = LibraryPaths::init(root.join("library")).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        let mut ids = Vec::new();
        let mut originals = Vec::new();
        for name in ["图片 sample.png", "声音.wav", "clip.mp4"] {
            let source = root.join(name);
            if name.ends_with(".png") {
                image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]))
                    .save(&source)
                    .unwrap();
            } else {
                // Outgoing file lists must not decode audio/video or inspect their contents.
                fs::write(&source, b"synthetic resolver fixture").unwrap();
            }
            ids.push(db.index_connected_file(&paths, &source, None).unwrap().id);
            originals.push(source);
        }
        (directory, paths, db, ids, originals)
    }

    #[test]
    fn drag_exports_originals_in_selection_order_without_copies_or_thumbnail_substitution() {
        let (_temp, paths, db, ids, originals) = fixture();
        let bytes: Vec<_> = originals
            .iter()
            .map(|path| fs::read(path).unwrap())
            .collect();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET thumb_path='wrong-thumbnail.png' WHERE id=?1",
                [&ids[0]],
            )
            .unwrap();
        let result = files(
            &db,
            &[
                ids[2].clone(),
                ids[0].clone(),
                ids[2].clone(),
                ids[1].clone(),
            ],
        )
        .unwrap();
        assert_eq!(
            result,
            vec![
                originals[2].clone(),
                originals[0].clone(),
                originals[1].clone()
            ]
        );
        assert_eq!(fs::read_dir(&paths.images).unwrap().count(), 0);
        assert_eq!(
            bytes,
            originals
                .iter()
                .map(|path| fs::read(path).unwrap())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn drag_uses_current_registered_path_after_a_move() {
        let (_temp, _paths, db, ids, originals) = fixture();
        let moved = originals[0].with_file_name("已移动.png");
        fs::rename(&originals[0], &moved).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET store_path=?2 WHERE id=?1",
                rusqlite::params![ids[0], moved.to_str().unwrap()],
            )
            .unwrap();
        assert_eq!(files(&db, &[ids[0].clone()]).unwrap(), vec![moved]);
    }

    #[test]
    fn drag_rejects_empty_unknown_and_partially_missing_selections() {
        let (_temp, _paths, db, ids, originals) = fixture();
        assert!(files(&db, &[]).is_err());
        assert!(files(&db, &[ids[0].clone(), "unknown".into()]).is_err());
        fs::remove_file(&originals[1]).unwrap();
        assert!(files(&db, &ids).is_err());
    }

    #[test]
    fn drag_rejects_directories_missing_originals_and_reference_descriptors() {
        let (_temp, _paths, db, ids, originals) = fixture();
        let reference = originals[0].with_extension("bowerbird");
        fs::write(&reference, b"{}").unwrap();
        for value in [
            Some(originals[0].parent().unwrap().to_str().unwrap()),
            Some(reference.to_str().unwrap()),
            None,
        ] {
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE assets SET store_path=?2 WHERE id=?1",
                    rusqlite::params![ids[0], value],
                )
                .unwrap();
            assert!(files(&db, &[ids[0].clone()]).is_err());
        }
    }
}
