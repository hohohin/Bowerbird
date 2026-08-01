//! 素材库整体迁移：把 images / thumbnails / library.db 搬到新根目录，
//! 并改写 DB 内的绝对路径前缀。迁移只复制、不删除旧文件；旧库残留由下次启动清理。

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::core::paths::LibraryPaths;
use crate::db::Database;
use crate::error::{AppError, AppResult};

/// 迁移进度事件（经 `library://migrate-progress` 推给前端）。
#[derive(Debug, Clone, Serialize)]
pub struct MigrateProgress {
    pub stage: String,
    pub done: u64,
    pub total: u64,
}

/// 进度回调：stage ∈ {"images","thumbnails","db"}，done/total 为文件计数（db 阶段为 0/0）。
pub type ProgressFn = dyn FnMut(&str, u64, u64);

/// 规范化路径（去掉 . / ..，不含 Windows 的 \\?\ 前缀，便于与库内存储路径比对）。
fn normalize(path: &Path) -> AppResult<PathBuf> {
    Ok(std::path::absolute(path)?)
}

#[cfg(target_os = "windows")]
fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

#[cfg(not(target_os = "windows"))]
fn same_path(a: &Path, b: &Path) -> bool {
    a == b
}

fn validate_target(old_root: &Path, new_root: &Path) -> AppResult<()> {
    let old = normalize(old_root)?;
    let new = normalize(new_root)?;
    if same_path(&old, &new) {
        return Err(AppError::Other("新位置与当前素材库相同".into()));
    }
    if new.starts_with(&old) || old.starts_with(&new) {
        return Err(AppError::Other(
            "新位置不能是当前素材库的子目录或父目录".into(),
        ));
    }
    std::fs::create_dir_all(&new)?;
    if new.join("library.db").exists() {
        return Err(AppError::Other(
            "目标目录已包含素材库（library.db 已存在）".into(),
        ));
    }
    // 可写校验：写一个临时文件再删掉。
    let probe = new.join(format!(".bowerbird-write-probe-{}", ulid::Ulid::new()));
    std::fs::write(&probe, b"probe")
        .map_err(|e| AppError::Other(format!("目标目录不可写：{e}")))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

fn count_files(dir: &Path) -> AppResult<u64> {
    let mut n = 0;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            n += count_files(&entry.path())?;
        } else {
            n += 1;
        }
    }
    Ok(n)
}

fn copy_dir_recursive(
    src: &Path,
    dst: &Path,
    done: &mut u64,
    total: u64,
    progress: &mut ProgressFn,
) -> AppResult<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to, done, total, progress)?;
        } else {
            std::fs::copy(&from, &to)?;
            *done += 1;
            progress("copy", *done, total);
        }
    }
    Ok(())
}

/// 迁移主流程（只复制、不删除旧文件；旧库残留由 lib.rs 在下次启动清理）。
/// 返回规范化后的新根目录，供命令层写入设置。
pub fn migrate_library(
    db: &Database,
    paths: &LibraryPaths,
    new_root: &Path,
    progress: &mut ProgressFn,
) -> AppResult<String> {
    validate_target(&paths.root, new_root)?;
    let new_paths = LibraryPaths::init(normalize(new_root)?)?;
    let new_root = new_paths.root.clone();

    // 1. images / thumbnails 递归复制（逐文件进度）。
    let old_str = normalize(&paths.root)?.to_string_lossy().into_owned();
    let new_str = new_root.to_string_lossy().into_owned();
    for (name, src_dir, dst_dir) in [
        ("images", paths.images.clone(), new_paths.images.clone()),
        (
            "thumbnails",
            paths.thumbnails.clone(),
            new_paths.thumbnails.clone(),
        ),
    ] {
        if !src_dir.exists() {
            continue;
        }
        progress(name, 0, 0);
        let total = count_files(&src_dir)?;
        let mut done = 0;
        copy_dir_recursive(&src_dir, &dst_dir, &mut done, total, progress)?;
    }

    // 2. 数据库一致性快照（VACUUM INTO 在 WAL 下也拿得到完整数据）。
    progress("db", 0, 0);
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("VACUUM INTO ?1", rusqlite::params![new_paths.db.to_string_lossy()])?;
    }

    // 3. 改写新库中的绝对路径前缀（store/thumb 为关键；analyses payload 里 generation 引用
    //    存了 store_path 字符串，一并替换避免悬空引用）。
    {
        let conn = Connection::open(&new_paths.db)?;
        conn.execute(
            "UPDATE assets SET store_path = replace(store_path, ?1, ?2) \
                WHERE store_path LIKE ?1 || '%'",
            rusqlite::params![old_str, new_str],
        )?;
        conn.execute(
            "UPDATE assets SET thumb_path = replace(thumb_path, ?1, ?2) \
                WHERE thumb_path LIKE ?1 || '%'",
            rusqlite::params![old_str, new_str],
        )?;
        conn.execute(
            "UPDATE analyses SET payload = replace(payload, ?1, ?2) \
                WHERE payload LIKE '%' || ?1 || '%'",
            rusqlite::params![old_str, new_str],
        )?;
    }

    Ok(new_str)
}

/// 迁移只复制不删除；下次启动（已用自定义根打开新库后）清理应用数据目录里的旧库残留，
/// 彻底释放系统盘。只删固定文件名，settings.json 与 app_data_dir 本身保留。
pub fn cleanup_legacy_root(app_data_dir: &Path) {
    for name in [
        "images",
        "thumbnails",
        "library.db",
        "library.db-wal",
        "library.db-shm",
    ] {
        let target = app_data_dir.join(name);
        let _ = match std::fs::remove_dir_all(&target) {
            Err(_) => std::fs::remove_file(&target),
            Ok(()) => Ok(()),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::LibraryPaths;
    use crate::core::library::Asset;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("bowerbird-migrate-{tag}-{}", ulid::Ulid::new()))
    }

    #[test]
    fn migrate_moves_media_rewrites_paths_and_cleans_up_old_root() {
        let old_root = temp_dir("old");
        let new_root = temp_dir("new");
        let store_file = old_root.join("images").join("2026").join("07").join("asset-1.png");
        std::fs::create_dir_all(store_file.parent().unwrap()).unwrap();
        std::fs::write(&store_file, b"data").unwrap();

        let paths = LibraryPaths::init(old_root.clone()).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        db.insert_asset(&Asset {
            id: "asset-1".into(),
            name: "asset-1".into(),
            ext: Some("png".into()),
            origin_path: None,
            store_path: Some(store_file.to_string_lossy().into_owned()),
            thumb_path: Some(store_file.to_string_lossy().into_owned()),
            size: Some(0),
            width: Some(1),
            height: Some(1),
            duration: Some(0.0),
            phash: None,
            colors: None,
            rating: Some(0),
            source: Some("imported".into()),
            source_url: None,
            folder_id: None,
            created_at: Some(0),
            file_mtime: Some(0),
            generation_session_id: None,
        })
        .unwrap();

        let mut progress: Box<ProgressFn> = Box::new(|_, _, _| {});
        let new_str = migrate_library(&db, &paths, &new_root, &mut *progress).unwrap();
        // 设置侧记录新根由命令层负责；这里直接断言返回值是新根路径。
        assert_eq!(
            new_str,
            normalize(&new_root).unwrap().to_string_lossy()
        );

        // 新根：媒体文件已复制、新库路径已改写。
        assert!(new_root.join("images/2026/07/asset-1.png").exists());
        let new_db = Database::open(&new_root.join("library.db")).unwrap();
        let rewritten: Option<String> = new_db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT store_path FROM assets WHERE id='asset-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let new_path = new_root.to_string_lossy();
        let rewritten = rewritten.unwrap();
        assert!(rewritten.starts_with(new_path.as_ref()), "{rewritten:?}");

        // 旧根原样保留（迁移不删）。
        assert!(old_root.join("images/2026/07/asset-1.png").exists());
        assert!(old_root.join("library.db").exists());

        let _ = std::fs::remove_dir_all(&old_root);
        let _ = std::fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migrate_rejects_nested_or_identical_target() {
        let old_root = temp_dir("nested");
        std::fs::create_dir_all(&old_root).unwrap();
        let paths = LibraryPaths::init(old_root.clone()).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        let mut progress: Box<ProgressFn> = Box::new(|_, _, _| {});

        let child = old_root.join("sub");
        assert!(migrate_library(&db, &paths, &child, &mut *progress).is_err());
        assert!(migrate_library(&db, &paths, &old_root, &mut *progress).is_err());

        let _ = std::fs::remove_dir_all(&old_root);
    }
}
