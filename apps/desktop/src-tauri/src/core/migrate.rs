//! 素材库整体迁移：把 images / thumbnails / library.db 搬到新根目录，
//! 并改写 DB 内的绝对路径前缀。迁移只复制、不删除旧文件，切换后保留原库。

use std::path::{Path, PathBuf};

use crate::core::{external_files::fingerprint, settings::SettingsState};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;

use crate::core::paths::LibraryPaths;
use crate::db::Database;
use crate::error::{AppError, AppResult};

const JSON_PATH_COLUMNS: [(&str, &str); 3] = [
    ("analyses", "payload"),
    ("task_queue", "payload"),
    ("local_agent_runs", "checkpoint_json"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingMove {
    target: PathBuf,
    token: String,
}

fn identity(db: &Database) -> AppResult<String> {
    Ok(db.conn.lock().unwrap().query_row(
        "SELECT id FROM library_identity WHERE singleton=1",
        [],
        |row| row.get(0),
    )?)
}

/// Validate an already-open handle before enabling WAL or migrating its schema.
fn open_existing_index(file: &Path, expected_id: Option<&str>) -> AppResult<Database> {
    let conn = Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    if let Some(expected) = expected_id {
        let found: String = conn.query_row(
            "SELECT id FROM library_identity WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        if found != expected {
            return Err(AppError::Other("索引库身份不匹配".into()));
        }
    } else {
        let valid: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='assets')",
            [],
            |r| r.get(0),
        )?;
        if !valid {
            return Err(AppError::Other("指定位置没有原素材索引库".into()));
        }
    }
    Database::from_connection(conn)
}

/// The running app only records intent. Its last successful writes are included on restart.
pub fn schedule(
    db: &Database,
    paths: &LibraryPaths,
    settings: &SettingsState,
    target: &Path,
) -> AppResult<()> {
    static PLAN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _lock = PLAN_LOCK.lock().unwrap();
    let snapshot = settings.get();
    let id = identity(db)?;
    if snapshot.library_id.as_ref() != Some(&id) {
        return Err(AppError::Other(
            "当前索引库与设置记录不同，无法迁移。".into(),
        ));
    }
    let target = normalize(target)?;
    if let Some(plan) = snapshot.pending_library_move {
        if plan.target == target {
            return Ok(());
        }
        return Err(AppError::Other("已有迁移计划，请先重新启动应用".into()));
    }
    super::file_workspace_move::ensure_idle(&db.conn.lock().unwrap())?;
    validate_target(&paths.root, &target)?;
    let plan = PendingMove {
        target,
        token: uuid::Uuid::new_v4().to_string(),
    };
    let marker_path = plan
        .target
        .join(format!(".bowerbird-index-move-{}", plan.token));
    let mut marker = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker_path)?;
    std::io::Write::write_all(&mut marker, plan.token.as_bytes())?;
    marker.sync_all()?;
    settings.update_with(|s| s.pending_library_move = Some(plan))
}

/// Only called by setup before starting any IPC/background writers.
pub fn open_authority(
    app_dir: &Path,
    settings: &SettingsState,
) -> AppResult<(LibraryPaths, Database, Option<String>)> {
    let config = settings.get();
    let root = config
        .library_root
        .as_deref()
        .map(Path::new)
        .unwrap_or(app_dir);
    let db_file = root.join("library.db");
    let db = if config.library_root.is_some() || config.library_id.is_some() {
        open_existing_index(&db_file, config.library_id.as_deref()).map_err(|e| {
            AppError::Other(format!(
                "索引库不可用，请重新连接原磁盘后再启动。\n{}\n{e}",
                db_file.display()
            ))
        })?
    } else {
        fs::create_dir_all(root)?;
        Database::open(&db_file)?
    };
    db.migrate()?;
    let paths = LibraryPaths::init(root.to_path_buf())?;
    if config.library_id.is_none() {
        let id = identity(&db)?;
        settings.update_with(|s| s.library_id = Some(id))?;
    }
    let Some(plan) = config.pending_library_move else {
        return Ok((paths, db, None));
    };
    let moved = (|| -> AppResult<(LibraryPaths, Database, String)> {
        super::file_workspace_move::ensure_idle(&db.conn.lock().unwrap())?;
        let marker = fs::read_to_string(
            plan.target
                .join(format!(".bowerbird-index-move-{}", plan.token)),
        )?;
        if marker != plan.token {
            return Err(AppError::Other("目标目录与预约迁移的位置不一致".into()));
        }
        migrate_library(&db, &paths, &plan.target)?;
        let next = open_existing_index(
            &plan.target.join("library.db"),
            config.library_id.as_deref(),
        )?;
        let updated = next.conn.lock().unwrap().execute(
            "UPDATE library_identity SET id=?1 WHERE singleton=1 AND id=?2",
            rusqlite::params![plan.token, identity(&db)?],
        )?;
        if updated != 1 {
            return Err(AppError::Other("目标索引校验失败".into()));
        }
        Ok((
            LibraryPaths::init(plan.target.clone())?,
            next,
            plan.token.clone(),
        ))
    })();
    match moved {
        Ok((target, next, id)) => {
            settings.update_with(|s| {
                s.library_root = Some(target.root.to_string_lossy().into_owned());
                s.library_id = Some(id);
                s.pending_library_move = None;
            })?;
            let _ = fs::remove_file(
                target
                    .root
                    .join(format!(".bowerbird-index-move-{}", plan.token)),
            );
            Ok((target, next, None))
        }
        Err(error) => {
            // A partial copy is never authoritative. Keep it for inspection and keep accepting
            // writes in the original, including after a crash immediately before cutover.
            settings.update_with(|s| s.pending_library_move = None)?;
            Ok((
                paths,
                db,
                Some(format!(
                    "迁移未完成，已继续使用原索引库。请重新选择空目录迁移。\n{error}"
                )),
            ))
        }
    }
}

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
    let old_physical = fs::canonicalize(&old)?;
    let new_physical = fs::canonicalize(&new)?;
    if old_physical.starts_with(&new_physical) || new_physical.starts_with(&old_physical) {
        return Err(AppError::Other(
            "新位置不能包含原素材库或位于原素材库内".into(),
        ));
    }
    for name in [
        "library.db",
        "library.db-wal",
        "library.db-shm",
        "library.db-journal",
        "images",
        "layers",
        "thumbnails",
    ] {
        match fs::symlink_metadata(new.join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
            Ok(_) => {
                return Err(AppError::Other(format!(
                    "目标目录已有 {name}，请选择空目录"
                )))
            }
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> AppResult<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink()
            || fs::canonicalize(&from)?.parent() != Some(fs::canonicalize(src)?.as_path())
        {
            return Err(AppError::Other(format!(
                "索引目录包含链接：{}",
                from.display()
            )));
        }
        if kind.is_dir() {
            fs::create_dir(&to)?;
            copy_dir_recursive(&from, &to)?;
        } else if kind.is_file() {
            let mut input = fs::File::open(&from)?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&to)?;
            std::io::copy(&mut input, &mut output)?;
            output.sync_all()?;
            if fingerprint(&from)? != fingerprint(&to)? {
                return Err(AppError::Other("复制校验失败，原库已保留".into()));
            }
        } else {
            return Err(AppError::Other("索引目录包含不支持的文件类型".into()));
        }
    }
    Ok(())
}

// Only use complete native path components. A prefix sibling, parent traversal or
// missing target must keep its original reference, including during legacy repair.
fn relocated_media(value: &str, old_root: &Path, new_root: &Path) -> Option<String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return None;
    }
    #[cfg(windows)]
    fn ordinary(path: &Path) -> std::borrow::Cow<'_, Path> {
        let raw = path.to_str().unwrap_or_default();
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}")).into();
        }
        Path::new(raw.strip_prefix(r"\\?\").unwrap_or(raw)).into()
    }
    #[cfg(windows)]
    let (path, old_root) = (ordinary(path), ordinary(old_root));
    let mut parts = path.components();
    for old in old_root.components() {
        if !same_path(
            Path::new(parts.next()?.as_os_str()),
            Path::new(old.as_os_str()),
        ) {
            return None;
        }
    }
    let directory = parts.next()?;
    let name = ["images", "thumbnails", "layers"]
        .into_iter()
        .find(|name| same_path(Path::new(directory.as_os_str()), Path::new(name)))?;
    if parts.as_path().as_os_str().is_empty() {
        return None;
    }
    let mut new = new_root.join(name);
    for part in parts {
        let std::path::Component::Normal(name) = part else {
            return None;
        };
        if Path::new(name)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return None;
        }
        new.push(name);
    }
    new.is_file().then(|| new.to_string_lossy().into_owned())
}

// json_tree quotes keys containing underscores in some SQLite versions. Only
// unquote individual simple labels, so a user key such as "turns[0].refs" never
// becomes the path of a real generation reference.
fn media_json_field(kind: &str, fullkey: &str) -> bool {
    static INDEX: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\[[0-9]+\]").unwrap());
    static LABEL: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r#"\."([a-z_]+)""#).unwrap());
    let path = INDEX.replace_all(fullkey, "[]");
    let path = LABEL.replace_all(&path, ".$1");
    match kind {
        "generation_meta" => matches!(path.as_ref(), "$.image" | "$.references[]"),
        "generation" => matches!(
            path.as_ref(),
            "$.image"
                | "$.parent_asset_path"
                | "$.references[]"
                | "$.turns[].refs[]"
                | "$.turns[].images[]"
                | "$.turns[].refAssets[].store_path"
                | "$.turns[].refAssets[].thumb_path"
        ),
        "checkpoint" => matches!(
            path.as_ref(),
            "$.image" | "$.generatedImagePath" | "$.records[].result.generatedImagePath"
        ),
        "annotation" => path == "$.source_store_path",
        "video_frame" | "video_audio" => path == "$.source_path",
        "replication_source" => path == "$.outputPath",
        _ => false,
    }
}

fn rewrite_library_paths(
    conn: &Connection,
    old_root: &Path,
    new_root: &Path,
    verify_legacy_copy: bool,
) -> AppResult<usize> {
    let old = normalize(old_root)?;
    let new = normalize(new_root)?;
    if same_path(&old, &new) {
        return Ok(0);
    }
    // A previous release may have left both files around and the user may have
    // edited either one since. A matching filename is insufficient in that case.
    let mut verified = std::collections::HashMap::new();
    let mut relocate = |value: &str| -> Option<String> {
        let next = relocated_media(value, &old, &new)?;
        if verify_legacy_copy {
            let matches = verified.entry(value.to_owned()).or_insert_with(|| {
                let source = Path::new(value);
                match source.try_exists() {
                    Ok(false) => true, // older releases removed the original copy
                    Ok(true) => fingerprint(source).ok().is_some_and(|hash| {
                        fingerprint(Path::new(&next)).ok().as_ref() == Some(&hash)
                    }),
                    Err(_) => false,
                }
            });
            if !*matches {
                return None;
            }
        }
        Some(next)
    };
    let tx = conn.unchecked_transaction()?;
    let mut changed = 0;
    for column in ["store_path", "thumb_path"] {
        let mut select = tx.prepare(&format!(
            "SELECT rowid,{column} FROM assets WHERE {column} IS NOT NULL"
        ))?;
        let mut rows = select.query([])?;
        let mut updates = Vec::new();
        while let Some(row) = rows.next()? {
            if let Some(next) = relocate(&row.get::<_, String>(1)?) {
                updates.push((row.get::<_, i64>(0)?, next));
            }
        }
        let mut update = tx.prepare(&format!("UPDATE assets SET {column}=?1 WHERE rowid=?2"))?;
        for (id, next) in updates {
            changed += update.execute(rusqlite::params![next, id])?;
        }
    }
    for (table, column) in JSON_PATH_COLUMNS {
        let (kind, filter) = match table {
            "analyses" => ("t.kind", "t.kind IN ('generation_meta','annotation','video_frame','video_audio','replication_source')"),
            "task_queue" => ("t.kind", "t.kind='generation'"),
            _ => ("'checkpoint'", "1"),
        };
        let mut select = tx.prepare(&format!(
            "SELECT t.rowid,{kind},j.fullkey,j.atom FROM {table} t,
             json_tree(CASE WHEN json_valid(t.{column}) THEN t.{column} END) j
             WHERE {filter} AND j.type='text'"
        ))?;
        let mut rows = select.query([])?;
        let mut updates = Vec::new();
        while let Some(row) = rows.next()? {
            let value = row.get::<_, String>(3)?;
            if !Path::new(&value).is_absolute() {
                continue;
            }
            let key = row.get::<_, String>(2)?;
            if media_json_field(&row.get::<_, String>(1)?, &key) {
                if let Some(next) = relocate(&value) {
                    updates.push((row.get::<_, i64>(0)?, key, next));
                }
            }
        }
        // Let SQLite patch just the selected scalar. Other values, including
        // wide integer IDs, never round-trip through floating point.
        let mut update = tx.prepare(&format!(
            "UPDATE {table} SET {column}=json_replace({column},?1,?2) WHERE rowid=?3"
        ))?;
        for (id, key, next) in updates {
            changed += update.execute(rusqlite::params![key, next, id])?;
        }
    }
    tx.commit()?;
    Ok(changed)
}

/// 兼容旧版本已经完成的 app-data → 自定义库迁移：启动新库后补改未命中的 JSON 路径。
pub fn repair_migrated_library_paths(
    db: &Database,
    old_root: &Path,
    new_root: &Path,
) -> AppResult<usize> {
    let conn = db.conn.lock().unwrap();
    rewrite_library_paths(&conn, old_root, new_root, true)
}

/// 启动时复制并校验，旧库完整保留。
/// 返回规范化后的新根目录，供命令层写入设置。
fn migrate_library(db: &Database, paths: &LibraryPaths, new_root: &Path) -> AppResult<String> {
    validate_target(&paths.root, new_root)?;
    let new_paths = LibraryPaths::init(normalize(new_root)?)?;
    let new_root = new_paths.root.clone();

    // 1. 媒体与独立图层工程递归复制（逐文件进度）。
    let new_str = new_root.to_string_lossy().into_owned();
    for (src_dir, dst_dir) in [
        (paths.images.clone(), new_paths.images.clone()),
        (paths.root.join("layers"), new_paths.root.join("layers")),
        (paths.thumbnails.clone(), new_paths.thumbnails.clone()),
    ] {
        if !src_dir.try_exists()? {
            continue;
        }
        if fs::canonicalize(&src_dir)?.parent() != Some(fs::canonicalize(&paths.root)?.as_path()) {
            return Err(AppError::Other("索引目录包含链接，请检查原库后重试".into()));
        }
        copy_dir_recursive(&src_dir, &dst_dir)?;
    }

    // 2. 数据库一致性快照（VACUUM INTO 在 WAL 下也拿得到完整数据）。
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "VACUUM INTO ?1",
            rusqlite::params![new_paths.db.to_string_lossy()],
        )?;
    }

    // 3. 改写新库中的绝对媒体路径（含 JSON payload/checkpoint 中的转义路径）。
    {
        let conn = Connection::open(&new_paths.db)?;
        rewrite_library_paths(&conn, &paths.root, &new_root, false)?;
        let check: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(AppError::Other(format!("目标数据库校验失败：{check}")));
        }
    }

    Ok(new_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::library::Asset;
    use crate::core::paths::LibraryPaths;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("bowerbird-migrate-{tag}-{}", ulid::Ulid::new()))
    }

    #[test]
    fn unavailable_or_replaced_index_never_falls_back_or_creates_a_database() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("app");
        let external = tmp.path().join("disk");
        let settings = SettingsState::init(home.join("settings.json")).unwrap();
        settings
            .update_with(|s| s.library_root = Some(external.display().to_string()))
            .unwrap();
        assert!(open_authority(&home, &settings).is_err());
        assert!(!home.join("library.db").exists());
        fs::create_dir(&external).unwrap();
        assert!(open_authority(&home, &settings).is_err());
        assert!(!external.join("library.db").exists());
        let original = Database::open(&external.join("library.db")).unwrap();
        original.migrate().unwrap();
        let expected = identity(&original).unwrap();
        drop(original);
        drop(open_authority(&home, &settings).unwrap());
        assert_eq!(
            settings.get().library_id.as_deref(),
            Some(expected.as_str())
        );
        fs::rename(&external, tmp.path().join("original")).unwrap();
        fs::create_dir(&external).unwrap();
        let other = Database::open(&external.join("library.db")).unwrap();
        other.migrate().unwrap();
        drop(other);
        assert!(open_authority(&home, &settings).is_err());
        assert!(!home.join("library.db").exists());
    }

    #[test]
    fn startup_cutover_includes_commits_after_scheduling_and_preserves_the_source() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("source");
        let target = tmp.path().join("target");
        let settings = SettingsState::init(home.join("settings.json")).unwrap();
        let (paths, db, _) = open_authority(&home, &settings).unwrap();
        schedule(&db, &paths, &settings, &target).unwrap();
        assert!(!target.join("library.db").exists());
        fs::write(paths.images.join("late.jpg"), b"late").unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,store_path) VALUES ('late','late',?1)",
                [paths.images.join("late.jpg").to_str().unwrap()],
            )
            .unwrap();
        drop(db);
        let (paths, db, notice) = open_authority(&home, &settings).unwrap();
        assert!(notice.is_none());
        assert_eq!(paths.root, target);
        let stored = db.get_asset("late").unwrap().unwrap().store_path.unwrap();
        assert_eq!(Path::new(&stored), target.join("images/late.jpg"));
        assert_eq!(fs::read(stored).unwrap(), b"late");
        drop(db);
        assert_eq!(fs::read(home.join("images/late.jpg")).unwrap(), b"late");
        assert_eq!(open_authority(&home, &settings).unwrap().0.root, target);
    }

    #[test]
    fn interrupted_copy_or_snapshot_keeps_old_authority_and_preserves_partial_target() {
        for after_snapshot in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let home = tmp.path().join("app");
            let target = tmp.path().join("disk");
            let settings = SettingsState::init(home.join("settings.json")).unwrap();
            let (paths, db, _) = open_authority(&home, &settings).unwrap();
            schedule(&db, &paths, &settings, &target).unwrap();
            if after_snapshot {
                migrate_library(&db, &paths, &target).unwrap();
            } else {
                fs::create_dir(target.join("images")).unwrap();
            }
            fs::write(target.join("images/keep"), b"keep").unwrap();
            drop(db);
            let (paths, _, notice) = open_authority(&home, &settings).unwrap();
            assert_eq!(paths.root, home);
            assert!(notice.is_some());
            assert!(settings.get().pending_library_move.is_none());
            assert_eq!(fs::read(target.join("images/keep")).unwrap(), b"keep");
        }
    }

    #[test]
    fn migrate_moves_media_rewrites_paths_and_preserves_old_root() {
        let old_root = temp_dir("old");
        let new_root = temp_dir("new");
        let store_file = old_root
            .join("images")
            .join("2026")
            .join("07")
            .join("asset-1.png");
        std::fs::create_dir_all(store_file.parent().unwrap()).unwrap();
        std::fs::write(&store_file, b"data").unwrap();

        let paths = LibraryPaths::init(old_root.clone()).unwrap();
        std::fs::create_dir_all(old_root.join("layers")).unwrap();
        std::fs::write(old_root.join("layers/document.json"), b"layer-workspace").unwrap();
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
            reference_count: 0,
            library_hidden: false,
        })
        .unwrap();
        let annotation_file = old_root.join("annotations").join("temp.png");
        let payload = serde_json::json!({
            "image": store_file.to_string_lossy(),
            "annotation": annotation_file.to_string_lossy(),
        })
        .to_string();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO analyses (id, asset_id, kind, payload) VALUES ('analysis-1', 'asset-1', 'generation_meta', ?1)",
                [&payload],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO task_queue (id, kind, payload, created_at) VALUES ('task-1', 'generation', ?1, 0)",
                [&payload],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO local_agent_runs (id, skill_id, target_asset_id, status, phase, checkpoint_json, created_at, updated_at) VALUES ('run-1', 'test', 'asset-1', 'running', 'test', ?1, 0, 0)",
                [&payload],
            )
            .unwrap();
        }

        let new_str = migrate_library(&db, &paths, &new_root).unwrap();
        // 设置侧记录新根由命令层负责；这里直接断言返回值是新根路径。
        assert_eq!(new_str, normalize(&new_root).unwrap().to_string_lossy());

        // 新根：媒体文件已复制、新库路径已改写。
        assert!(new_root.join("images/2026/07/asset-1.png").exists());
        assert_eq!(
            std::fs::read(new_root.join("layers/document.json")).unwrap(),
            b"layer-workspace"
        );
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
        for (table, column) in JSON_PATH_COLUMNS {
            let sql = format!("SELECT {column} FROM {table} LIMIT 1");
            let rewritten_json: String = new_db
                .conn
                .lock()
                .unwrap()
                .query_row(&sql, [], |r| r.get(0))
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(&rewritten_json).unwrap();
            assert!(
                value["image"]
                    .as_str()
                    .unwrap()
                    .starts_with(new_path.as_ref()),
                "{table}.{column}: {rewritten_json}"
            );
            assert_eq!(
                value["annotation"].as_str().unwrap(),
                annotation_file.to_string_lossy(),
                "未复制的 annotations 路径不应被改写"
            );
        }

        // 旧根原样保留（迁移不删）。
        assert!(old_root.join("images/2026/07/asset-1.png").exists());
        assert!(old_root.join("library.db").exists());

        let _ = std::fs::remove_dir_all(&old_root);
        let _ = std::fs::remove_dir_all(&new_root);
    }

    #[test]
    fn upgrade_cutover_and_legacy_repair_only_retarget_copied_media_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("资料 %_ old");
        let new = tmp.path().join("资料 new");
        let local = PathBuf::from("images").join("images").join("a b.jpg");
        let external = old.join("images-backup").join("a b.jpg");
        let thumbnail = PathBuf::from("thumbnails").join("a b.jpg");
        for (file, content) in [
            (&old.join(&local), "managed"),
            (&external, "external"),
            (&old.join(&thumbnail), "thumb"),
        ] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, content).unwrap();
        }
        let source = old.join(&local);
        let db = Database::open(&old.join("library.db")).unwrap();
        let payload = serde_json::json!({
            "references": [source, external],
            "parent_asset_path":source, "prompt":source, "description":format!("keep {}", source.display()),
            "turns":[{"refs":[source], "images":[source], "refAssets":[{"store_path":source,"name":source}]}],
            "notes":{"image":source}, "turns[0].refs":[source]
        }).to_string();
        {
            let mut conn = db.conn.lock().unwrap();
            crate::db::migrations::migrations()
                .to_version(&mut conn, 56)
                .unwrap();
            conn.execute(
                "INSERT INTO assets(id,name,store_path,thumb_path) VALUES('managed','m',?1,?2)",
                rusqlite::params![source.to_str(), old.join(&thumbnail).to_str()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO assets(id,name,store_path) VALUES('sibling','e',?1)",
                [external.to_str()],
            )
            .unwrap();
            conn.execute("INSERT INTO task_queue(id,kind,status,payload,created_at) VALUES('t','generation','done',?1,0)", [&payload]).unwrap();
            conn.execute(
                "INSERT INTO analyses(id,asset_id,kind,payload) VALUES('c','managed','caption',?1)",
                [&payload],
            )
            .unwrap();
        }
        drop(db);
        let settings_path = old.join("settings.json");
        let settings = SettingsState::init(settings_path.clone()).unwrap();
        let (paths, db, _) = open_authority(&old, &settings).unwrap();
        schedule(&db, &paths, &settings, &new).unwrap();
        drop(db);
        drop(settings);
        for _boot in 0..2 {
            let settings = SettingsState::init(settings_path.clone()).unwrap();
            let (paths, db, notice) = open_authority(&old, &settings).unwrap();
            assert_eq!(paths.root, new);
            assert!(notice.is_none());
            let managed = db.get_asset("managed").unwrap().unwrap();
            for (actual, expected, bytes) in [
                (managed.store_path.unwrap(), new.join(&local), "managed"),
                (managed.thumb_path.unwrap(), new.join(&thumbnail), "thumb"),
                (
                    db.get_asset("sibling")
                        .unwrap()
                        .unwrap()
                        .store_path
                        .unwrap(),
                    external.clone(),
                    "external",
                ),
            ] {
                assert_eq!(Path::new(&actual), expected);
                assert_eq!(fs::read_to_string(actual).unwrap(), bytes);
            }
            let conn = db.conn.lock().unwrap();
            let raw: String = conn
                .query_row("SELECT payload FROM task_queue WHERE id='t'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            let task: serde_json::Value = serde_json::from_str(&raw).unwrap();
            for field in [
                "/references/0",
                "/parent_asset_path",
                "/turns/0/refs/0",
                "/turns/0/images/0",
                "/turns/0/refAssets/0/store_path",
            ] {
                assert_eq!(
                    task.pointer(field),
                    Some(&serde_json::json!(new.join(&local))),
                    "{field}"
                );
            }
            assert_eq!(task["references"][1], serde_json::json!(external));
            for field in [
                "/prompt",
                "/notes/image",
                "/turns/0/refAssets/0/name",
                "/turns[0].refs/0",
            ] {
                assert_eq!(
                    task.pointer(field),
                    Some(&serde_json::json!(source)),
                    "{field}"
                );
            }
            assert_eq!(task["description"], format!("keep {}", source.display()));
            let caption: String = conn
                .query_row("SELECT payload FROM analyses WHERE id='c'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(caption, payload);
            // A legacy Windows snapshot can still have an unpatched checkpoint.
            conn.execute("INSERT OR REPLACE INTO local_agent_runs(id,skill_id,target_asset_id,status,phase,checkpoint_json,created_at,updated_at) VALUES ('r','refine','managed','done','done',?1,0,0)",
                [serde_json::json!({"records":[{"result":{"generatedImagePath":source},"arguments":{"prompt":source}}]}).to_string()]).unwrap();
            drop(conn);
            assert_eq!(repair_migrated_library_paths(&db, &old, &new).unwrap(), 1);
            assert_eq!(repair_migrated_library_paths(&db, &old, &new).unwrap(), 0);
            let chk: String = db
                .conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT checkpoint_json FROM local_agent_runs WHERE id='r'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(&chk).unwrap();
            assert_eq!(
                value["records"][0]["result"]["generatedImagePath"],
                serde_json::json!(new.join(&local))
            );
            assert_eq!(
                value["records"][0]["arguments"]["prompt"],
                serde_json::json!(source)
            );
        }
        assert_eq!(fs::read_to_string(source).unwrap(), "managed");
        assert!(relocated_media(
            old.join("images")
                .join("..")
                .join("images-backup")
                .join("a b.jpg")
                .to_str()
                .unwrap(),
            &old,
            &new
        )
        .is_none());
        assert!(
            relocated_media(old.join("images/missing").to_str().unwrap(), &old, &new).is_none()
        );
        let diverged = old.join("images/ambiguous.png");
        fs::write(&diverged, b"original").unwrap();
        fs::write(new.join("images/ambiguous.png"), b"changed!").unwrap();
        let removed = old.join("images/removed.png");
        fs::write(new.join("images/removed.png"), b"only copy").unwrap();
        let db = Database::open(&new.join("library.db")).unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,store_path) VALUES('edited','edited',?1),('removed','removed',?2)",
            rusqlite::params![diverged.to_str(),removed.to_str()],
        ).unwrap();
        assert_eq!(repair_migrated_library_paths(&db, &old, &new).unwrap(), 1);
        let stored = |id| PathBuf::from(db.get_asset(id).unwrap().unwrap().store_path.unwrap());
        assert_eq!(stored("edited"), diverged);
        assert_eq!(stored("removed"), new.join("images/removed.png"));
    }

    // For release drills, BOWERBIRD_MIGRATION_ARCHIVE may name an offline
    // SQLite snapshot. Only the Backup API's private destination is upgraded.
    #[test]
    fn archived_index_survives_upgrade_disconnect_and_reconnect() {
        use rusqlite::{backup::Backup, OpenFlags};
        use sha2::{Digest, Sha256};

        fn inventory(conn: &Connection) -> Vec<(String, usize, String)> {
            [
                "assets",
                "analyses",
                "projects",
                "task_queue",
                "local_agent_runs",
                "cloud_agent_runs",
            ]
            .into_iter()
            .map(|table| {
                let key = if table == "cloud_agent_runs" {
                    "run_id"
                } else {
                    "id"
                };
                let mut stmt = conn
                    .prepare(&format!("SELECT {key} FROM {table} ORDER BY {key}"))
                    .unwrap();
                let mut count = 0;
                let mut hash = Sha256::new();
                for id in stmt.query_map([], |r| r.get::<_, String>(0)).unwrap() {
                    let id = id.unwrap();
                    hash.update((id.len() as u64).to_le_bytes());
                    hash.update(id.as_bytes());
                    count += 1;
                }
                (table.to_owned(), count, format!("{:x}", hash.finalize()))
            })
            .collect()
        }

        let tmp = tempfile::tempdir().unwrap();
        let archive = std::env::var_os("BOWERBIRD_MIGRATION_ARCHIVE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let seed = tmp.path().join("snapshot.sqlite");
                let mut conn = Connection::open(&seed).unwrap();
                crate::db::migrations::migrations()
                    .to_version(&mut conn, 56)
                    .unwrap();
                conn.execute("INSERT INTO assets(id,name) VALUES('sample','sample')", [])
                    .unwrap();
                seed
            });
        // immutable=1 avoids creating WAL/SHM beside the archive. Input must
        // be a standalone, offline backup without outstanding WAL transactions.
        assert!(!PathBuf::from(format!("{}-wal", archive.display())).exists());
        let archive_hash = fingerprint(&archive).unwrap();
        let mut uri = tauri::Url::from_file_path(&archive).unwrap();
        uri.set_query(Some("mode=ro&immutable=1"));
        let src = Connection::open_with_flags(
            uri.as_str(),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .unwrap();
        let old_version: u32 = src
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        let original = inventory(&src);
        let home = tmp.path().join("app");
        fs::create_dir(&home).unwrap();
        let dbfile = home.join("library.db");
        {
            let mut destination = Connection::open(&dbfile).unwrap();
            let backup = Backup::new(&src, &mut destination).unwrap();
            backup
                .run_to_completion(64, std::time::Duration::from_millis(1), None)
                .unwrap();
        }
        drop(src);

        let settings_path = home.join("settings.json");
        let target = tmp.path().join("volume");
        let settings = SettingsState::init(settings_path.clone()).unwrap();
        let (paths, db, notice) = open_authority(&home, &settings).unwrap();
        assert!(notice.is_none());
        let old_id = identity(&db).unwrap();
        assert_eq!(inventory(&db.conn.lock().unwrap()), original);
        schedule(&db, &paths, &settings, &target).unwrap();
        drop(db);
        drop(settings);
        let boot = || open_authority(&home, &SettingsState::init(settings_path.clone()).unwrap());
        let (paths, db, notice) = boot().unwrap();
        assert_eq!(paths.root, target);
        assert!(notice.is_none());
        assert_ne!(old_id, identity(&db).unwrap());
        let expected_id = identity(&db).unwrap();
        drop(db);

        let offline = tmp.path().join("unmounted");
        fs::rename(&target, &offline).unwrap();
        assert!(boot().is_err());
        assert!(!target.exists());
        assert_eq!(
            SettingsState::init(settings_path.clone())
                .unwrap()
                .get()
                .library_id
                .as_deref(),
            Some(expected_id.as_str())
        );
        fs::rename(&offline, &target).unwrap();
        let (paths, db, notice) = boot().unwrap();
        assert_eq!(paths.root, target);
        assert!(notice.is_none());
        assert_eq!(identity(&db).unwrap(), expected_id);
        let conn = db.conn.lock().unwrap();
        let current: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(current >= 58);
        assert_eq!(inventory(&conn), original);
        assert_eq!(
            conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        assert_eq!(fingerprint(&archive).unwrap(), archive_hash);
        eprintln!("offline archive {archive_hash}, schema {old_version} -> {current}, ID sets preserved, counts {:?}, offline boot refused, original volume reopened, integrity ok, foreign-key errors 0",
            original.iter().map(|(table,count,_)|(table,count)).collect::<Vec<_>>());
    }

    #[test]
    fn migrate_rejects_nested_or_identical_target() {
        let old_root = temp_dir("nested");
        std::fs::create_dir_all(&old_root).unwrap();
        let paths = LibraryPaths::init(old_root.clone()).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();

        let child = old_root.join("sub");
        assert!(migrate_library(&db, &paths, &child).is_err());
        assert!(migrate_library(&db, &paths, &old_root).is_err());

        let _ = std::fs::remove_dir_all(&old_root);
    }
}
