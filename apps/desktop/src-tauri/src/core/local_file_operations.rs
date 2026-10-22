//! Explicit file-browser mutations. Reference-only library actions retain their existing semantics.
use crate::{db::Database, error::{AppError, AppResult}};
use rusqlite::{params, Connection, OptionalExtension};
use std::{fs, path::PathBuf};

fn invalid(message: &str) -> AppError { AppError::Other(message.into()) }

fn selected_file(conn: &Connection, id: &str, expected_path: &str) -> AppResult<PathBuf> {
    let stored: Option<String> = conn.query_row("SELECT store_path FROM assets WHERE id=?1", [id], |r| r.get(0)).optional()?.flatten();
    let stored = stored.ok_or_else(|| invalid("文件记录已变化，请刷新后重试"))?;
    if fs::symlink_metadata(expected_path)?.file_type().is_symlink() { return Err(invalid("文件已变为链接，请刷新后重试")); }
    let path = fs::canonicalize(expected_path)?;
    if !path.is_file() || fs::canonicalize(&stored)? != path {
        return Err(invalid("文件位置已变化，请刷新后重新选择"));
    }
    let hash: Option<String> = conn.query_row("SELECT fingerprint FROM external_assets WHERE asset_id=?1", [id], |r| r.get(0)).optional()?;
    if let Some(hash) = hash {
        if super::external_files::fingerprint(&path)? != hash {
            return Err(invalid("文件内容已变化，请先更新引用后重试"));
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use crate::core::{library::Asset, paths::LibraryPaths};

    struct Fixture { root: PathBuf, db: Database, paths: LibraryPaths, asset: Asset }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("bowerbird-file-operations-{}", ulid::Ulid::new()));
            fs::create_dir_all(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let paths = LibraryPaths::init(root.join("library")).unwrap();
            let db = Database::open(&paths.db).unwrap(); db.migrate().unwrap();
            let path = root.join("original.png");
            image::RgbImage::from_pixel(8, 8, image::Rgb([20, 40, 60])).save(&path).unwrap();
            let asset = db.index_external(&paths, &path).unwrap();
            Self { root, db, paths, asset }
        }
        fn path(&self) -> &str { self.asset.store_path.as_deref().unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }

    #[test]
    fn browser_rename_updates_disk_identity_and_aliases() {
        let f = Fixture::new(); let before = fs::read(f.path()).unwrap();
        f.db.rename_local_file(&f.asset.id, f.path(), "renamed").unwrap();
        let new = f.root.join("renamed.png");
        assert!(!Path::new(f.path()).exists()); assert_eq!(fs::read(&new).unwrap(), before);
        let asset = f.db.index_external(&f.paths, &new).unwrap();
        assert_eq!(asset.id, f.asset.id); assert_eq!(asset.name, "renamed");
        assert_eq!(asset.origin_path.as_deref(), new.to_str());
        assert_eq!(f.db.resolve_external_paths(&[f.path().into()]).unwrap(), vec![new.to_string_lossy().to_string()]);
    }

    #[test]
    fn browser_rename_never_overwrites_an_existing_file() {
        let f = Fixture::new(); let destination = f.root.join("occupied.png");
        fs::write(&destination, b"unrelated").unwrap();
        assert!(f.db.rename_local_file(&f.asset.id, f.path(), "occupied").is_err());
        assert!(Path::new(f.path()).is_file()); assert_eq!(fs::read(destination).unwrap(), b"unrelated");
        assert_eq!(f.db.get_asset(&f.asset.id).unwrap().unwrap().store_path, f.asset.store_path);
    }

    #[test]
    fn dotted_names_keep_the_original_extension() {
        let f = Fixture::new();
        f.db.rename_local_file(&f.asset.id, f.path(), "海报.v2").unwrap();
        assert!(f.root.join("海报.v2.png").is_file());
        assert!(!f.root.join("海报.png").exists());
    }

    #[test]
    fn browser_rename_rolls_back_on_database_error() {
        let f = Fixture::new();
        f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_file_rename BEFORE UPDATE OF store_path ON assets BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(f.db.rename_local_file(&f.asset.id, f.path(), "renamed").is_err());
        assert!(Path::new(f.path()).is_file()); assert!(!f.root.join("renamed.png").exists());
    }

    #[test]
    fn browser_delete_removes_file_and_project_membership() {
        let f = Fixture::new();
        f.db.create_project("p", "p", f.root.to_str().unwrap(), "p", "user").unwrap();
        f.db.add_assets_to_project("p", &[f.asset.id.clone()]).unwrap();
        f.db.delete_local_file(&f.asset.id, f.path()).unwrap();
        assert!(!Path::new(f.path()).exists()); assert!(f.db.get_asset(&f.asset.id).unwrap().is_none());
        let count: i64 = f.db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE asset_id=?1", [&f.asset.id], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn failed_delete_keeps_original_and_index() {
        let f = Fixture::new();
        f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_file_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT,'test failure'); END;").unwrap();
        assert!(f.db.delete_local_file(&f.asset.id, f.path()).is_err());
        assert!(Path::new(f.path()).is_file()); assert!(f.db.get_asset(&f.asset.id).unwrap().is_some());
    }

    #[test]
    fn mutations_reject_changed_content_or_wrong_path() {
        let f = Fixture::new(); let other = f.root.join("other.png"); fs::copy(f.path(), &other).unwrap();
        assert!(f.db.delete_local_file(&f.asset.id, other.to_str().unwrap()).is_err());
        assert!(f.db.rename_local_file(&f.asset.id, other.to_str().unwrap(), "renamed").is_err());
        fs::write(f.path(), b"replaced outside the application").unwrap();
        assert!(f.db.delete_local_file(&f.asset.id, f.path()).is_err());
        assert!(f.db.rename_local_file(&f.asset.id, f.path(), "renamed").is_err());
        assert!(other.is_file()); assert!(Path::new(f.path()).is_file());
    }

    #[test]
    fn managed_file_operations_keep_the_same_identity() {
        let f = Fixture::new();
        f.db.conn.lock().unwrap().execute_batch("DELETE FROM external_assets; UPDATE assets SET source='imported';").unwrap();
        f.db.rename_local_file(&f.asset.id, f.path(), "managed").unwrap();
        let destination = f.root.join("managed.png");
        assert_eq!(f.db.index_external(&f.paths, &destination).unwrap().id, f.asset.id);
        f.db.delete_local_file(&f.asset.id, destination.to_str().unwrap()).unwrap();
        assert!(!destination.exists());
    }
}

impl Database {
    pub fn rename_local_file(&self, id: &str, expected_path: &str, new_name: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let path = selected_file(&tx, id, expected_path)?;
        if new_name.trim().is_empty() { return Err(invalid("文件名称不能为空")); }
        let stem = super::library::sanitize_file_stem(new_name, id);
        let extension = path.extension().unwrap_or_default().to_string_lossy();
        let destination = path.with_file_name(format!("{stem}.{extension}"));
        if destination == path { return Ok(()); }
        // Create the destination without replacement, including a concurrent name collision.
        if fs::symlink_metadata(&destination).is_ok() { return Err(invalid("同名文件已存在，请使用其他名称")); }
        if fs::hard_link(&path, &destination).is_err() {
            // FAT/NAS may not support hard links; an exclusive copy preserves the no-overwrite rule.
            let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&destination)?;
            let copied = (|| -> std::io::Result<()> {
                std::io::copy(&mut fs::File::open(&path)?, &mut output)?;
                output.sync_all()
            })();
            drop(output);
            if let Err(error) = copied { let _ = fs::remove_file(&destination); return Err(error.into()); }
        }
        let result = (|| -> AppResult<()> {
            let old = path.to_string_lossy(); let new = destination.to_string_lossy();
            let conflict: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM external_asset_paths WHERE path IN (?1,?2) AND asset_id<>?3)", params![old,new,id], |r| r.get(0))?;
            if conflict { return Err(invalid("该名称已有其他素材记录，请使用其他名称")); }
            for alias in [old.as_ref(), new.as_ref()] {
                tx.execute("INSERT OR IGNORE INTO external_asset_paths(asset_id,path) VALUES(?1,?2)", params![id,alias])?;
            }
            tx.execute("UPDATE assets SET name=?2,name_manual=1,store_path=?3,origin_path=CASE WHEN origin_path=?4 THEN ?3 ELSE origin_path END,thumb_path=CASE WHEN thumb_path=?4 THEN ?3 ELSE thumb_path END WHERE id=?1", params![id,stem,new,old])?;
            fs::remove_file(&path)?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = result {
            if path.exists() { fs::remove_file(&destination)?; }
            else { fs::rename(&destination, &path)?; }
            return Err(error);
        }
        Ok(())
    }

    pub fn delete_local_file(&self, id: &str, expected_path: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let path = selected_file(&tx, id, expected_path)?;
        super::project_canvas::hide_asset_canvas_nodes(&tx, id, None)?;
        tx.execute("DELETE FROM assets WHERE id=?1", [id])?;
        // SQL failures and filesystem failures leave the index intact; never report a failed removal as success.
        fs::remove_file(&path)?;
        tx.commit()?;
        Ok(())
    }
}
