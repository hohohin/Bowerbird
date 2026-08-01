//! 项目 workspace：登记项目、维护素材多对多成员关系与当前采集项目上下文。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::core::library::delete_asset_files;
use crate::db::Database;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub workspace_path: String,
    pub created_at: i64,
    pub asset_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCreateResult {
    pub project: Project,
    pub imported_count: usize,
    pub member_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectDeleteResult {
    pub removed_members: usize,
    pub deleted_assets: usize,
    pub preserved_shared: usize,
    pub moved_assets: usize,
    pub failed_moves: Vec<String>,
}

/// 删除项目时对独占素材（不被其他项目引用）的处理方式；共享素材永远保留。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectDeleteMode {
    /// 只删项目关系，素材全部留在全局。
    Keep,
    /// 独占素材文件移回 workspace 文件夹后删除资产行（不进全局、不物理删除）。
    MoveOut,
    /// 独占素材连同行一起物理删除。
    DeleteExclusive,
}

/// 移出目的地文件名：素材名净化（Windows 非法字符 → `_`），空则回退 store 文件名（ulid）；
/// 重名时追加资产 id 前缀防覆盖。
fn move_destination(workspace: &Path, name: &str, store_path: &Path, id: &str) -> PathBuf {
    let ext = store_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let stem: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let stem = stem.trim();
    let fallback = store_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("asset");
    let base = if stem.is_empty() { fallback } else { stem };
    let file_name = |stem: &str| {
        if ext.is_empty() {
            stem.to_string()
        } else {
            format!("{stem}.{ext}")
        }
    };
    let candidate = workspace.join(file_name(base));
    if !candidate.exists() {
        return candidate;
    }
    let suffix: String = id.chars().take(8).collect();
    workspace.join(file_name(&format!("{base}-{suffix}")))
}

/// 移动文件：优先 rename；跨卷失败时 copy + 删除源。目标已存在则报错（不覆盖用户文件）。
fn move_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if dst.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("destination exists: {}", dst.display()),
        ));
    }
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(src, dst)?;
            std::fs::remove_file(src)
        }
    }
}

/// 浏览器扩展没有 WebView invoke 参数，靠该状态读取当前项目。
/// 显式导入/生成仍由前端把 project_id 快照随命令传入。
#[derive(Clone, Default)]
pub struct ActiveProjectContext(Arc<Mutex<Option<String>>>);

impl ActiveProjectContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }

    pub fn set(&self, project_id: Option<String>) {
        *self.0.lock().unwrap() = project_id;
    }
}

fn project_from_row(row: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        name: row.get("name")?,
        workspace_path: row.get("workspace_path")?,
        created_at: row.get("created_at")?,
        asset_count: row.get("asset_count")?,
    })
}

impl Database {
    pub fn create_project(
        &self,
        id: &str,
        name: &str,
        workspace_path: &str,
        workspace_key: &str,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, workspace_path, workspace_key, created_at) \
             VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))",
            rusqlite::params![id, name, workspace_path, workspace_key],
        )?;
        Ok(())
    }

    pub fn list_projects(&self) -> AppResult<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.workspace_path, p.created_at, COUNT(pa.asset_id) AS asset_count \
             FROM projects p LEFT JOIN project_assets pa ON pa.project_id = p.id \
             GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC",
        )?;
        let rows = stmt.query_map([], project_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_project(&self, id: &str) -> AppResult<Option<Project>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT p.id, p.name, p.workspace_path, p.created_at, COUNT(pa.asset_id) AS asset_count \
             FROM projects p LEFT JOIN project_assets pa ON pa.project_id = p.id \
             WHERE p.id = ?1 GROUP BY p.id",
            rusqlite::params![id],
            project_from_row,
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn add_assets_to_project(
        &self,
        project_id: &str,
        asset_ids: &[String],
    ) -> AppResult<usize> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            rusqlite::params![project_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound(format!("project {project_id}")));
        }
        let mut added = 0;
        for asset_id in asset_ids {
            added += tx.execute(
                "INSERT OR IGNORE INTO project_assets (project_id, asset_id, created_at) \
                 VALUES (?1, ?2, strftime('%s','now'))",
                rusqlite::params![project_id, asset_id],
            )?;
        }
        tx.commit()?;
        Ok(added)
    }

    pub fn remove_assets_from_project(
        &self,
        project_id: &str,
        asset_ids: &[String],
    ) -> AppResult<usize> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let mut removed = 0;
        for asset_id in asset_ids {
            removed += tx.execute(
                "DELETE FROM project_assets WHERE project_id = ?1 AND asset_id = ?2",
                rusqlite::params![project_id, asset_id],
            )?;
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn delete_project(
        &self,
        project_id: &str,
        mode: ProjectDeleteMode,
    ) -> AppResult<ProjectDeleteResult> {
        let conn = self.conn.lock().unwrap();
        let workspace_path: String = conn
            .query_row(
                "SELECT workspace_path FROM projects WHERE id = ?1",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("project {project_id}")))?;

        let members: Vec<(String, String, Option<String>, Option<String>, bool)> = {
            let mut stmt = conn.prepare(
                "SELECT a.id, a.name, a.store_path, a.thumb_path, EXISTS(\
                   SELECT 1 FROM project_assets other \
                   WHERE other.asset_id = a.id AND other.project_id != ?1\
                 ) AS shared \
                 FROM project_assets current JOIN assets a ON a.id = current.asset_id \
                 WHERE current.project_id = ?1",
            )?;
            let rows = stmt.query_map(rusqlite::params![project_id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            out
        };

        let preserved_shared = members.iter().filter(|member| member.4).count();

        // 移出模式：先把独占素材文件移回 workspace（成功的才删行，失败的保留在全局），再统一删行删项目。
        if mode == ProjectDeleteMode::MoveOut {
            let workspace = PathBuf::from(&workspace_path);
            let mut moved_ids: Vec<String> = Vec::new();
            let mut moved_thumbs: Vec<Option<String>> = Vec::new();
            let mut failed_moves: Vec<String> = Vec::new();
            for (asset_id, name, store_path, thumb_path, shared) in &members {
                if *shared {
                    continue;
                }
                match store_path {
                    Some(store) => {
                        let src = PathBuf::from(store);
                        let dst = move_destination(&workspace, name, &src, asset_id);
                        match move_file(&src, &dst) {
                            Ok(()) => {
                                moved_ids.push(asset_id.clone());
                                moved_thumbs.push(thumb_path.clone());
                            }
                            Err(error) => {
                                tracing::warn!(
                                    "move asset {asset_id} out to {} failed: {error}",
                                    dst.display()
                                );
                                failed_moves.push(name.clone());
                            }
                        }
                    }
                    // 无实体文件的资产只删行。
                    None => moved_ids.push(asset_id.clone()),
                }
            }
            let moved_assets = moved_ids.len();
            let tx = conn.unchecked_transaction()?;
            for asset_id in &moved_ids {
                tx.execute(
                    "DELETE FROM assets WHERE id = ?1",
                    rusqlite::params![asset_id],
                )?;
            }
            tx.execute(
                "DELETE FROM projects WHERE id = ?1",
                rusqlite::params![project_id],
            )?;
            tx.commit()?;
            drop(conn);

            // 缩略图是 Bowerbird 生成的中间产物，不随文件移出，直接删除。
            for thumb_path in moved_thumbs.into_iter().flatten() {
                delete_asset_files(None, Some(Path::new(&thumb_path)));
            }

            return Ok(ProjectDeleteResult {
                removed_members: members.len(),
                deleted_assets: 0,
                preserved_shared,
                moved_assets,
                failed_moves,
            });
        }

        let tx = conn.unchecked_transaction()?;
        let mut files = Vec::new();
        let mut deleted_assets = 0;
        if mode == ProjectDeleteMode::DeleteExclusive {
            for (asset_id, _name, store_path, thumb_path, shared) in &members {
                if *shared {
                    continue;
                }
                tx.execute(
                    "DELETE FROM assets WHERE id = ?1",
                    rusqlite::params![asset_id],
                )?;
                files.push((
                    store_path.as_ref().map(PathBuf::from),
                    thumb_path.as_ref().map(PathBuf::from),
                ));
                deleted_assets += 1;
            }
        }
        tx.execute(
            "DELETE FROM projects WHERE id = ?1",
            rusqlite::params![project_id],
        )?;
        tx.commit()?;
        drop(conn);

        for (store_path, thumb_path) in files {
            delete_asset_files(store_path.as_deref(), thumb_path.as_deref());
        }

        Ok(ProjectDeleteResult {
            removed_members: members.len(),
            deleted_assets,
            preserved_shared: if mode == ProjectDeleteMode::DeleteExclusive {
                preserved_shared
            } else {
                members.len()
            },
            moved_assets: 0,
            failed_moves: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::library::Asset;

    fn db() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db
    }

    fn put_asset(db: &Database, id: &str) {
        put_asset_with_store(db, id, None);
    }

    fn put_asset_with_store(db: &Database, id: &str, store_path: Option<&Path>) {
        db.insert_asset(&Asset {
            id: id.into(),
            name: id.into(),
            ext: Some("png".into()),
            origin_path: None,
            store_path: store_path.map(|p| p.to_string_lossy().into_owned()),
            thumb_path: None,
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
    }

    fn put_project(db: &Database, id: &str) {
        put_project_at(db, id, &format!("/tmp/{id}"));
    }

    fn put_project_at(db: &Database, id: &str, workspace: &str) {
        db.create_project(id, id, workspace, workspace).unwrap();
    }

    #[test]
    fn project_membership_is_many_to_many_and_idempotent() {
        let db = db();
        put_asset(&db, "a1");
        put_project(&db, "p1");
        put_project(&db, "p2");
        let ids = vec!["a1".to_string()];
        assert_eq!(db.add_assets_to_project("p1", &ids).unwrap(), 1);
        assert_eq!(db.add_assets_to_project("p1", &ids).unwrap(), 0);
        assert_eq!(db.add_assets_to_project("p2", &ids).unwrap(), 1);
        assert_eq!(
            db.list_projects()
                .unwrap()
                .iter()
                .map(|p| p.asset_count)
                .sum::<i64>(),
            2
        );
    }

    #[test]
    fn deleting_project_preserves_shared_assets() {
        let db = db();
        put_asset(&db, "shared");
        put_asset(&db, "exclusive");
        put_project(&db, "p1");
        put_project(&db, "p2");
        db.add_assets_to_project("p1", &["shared".into(), "exclusive".into()])
            .unwrap();
        db.add_assets_to_project("p2", &["shared".into()]).unwrap();

        let result = db.delete_project("p1", ProjectDeleteMode::DeleteExclusive).unwrap();
        assert_eq!(result.removed_members, 2);
        assert_eq!(result.deleted_assets, 1);
        assert_eq!(result.preserved_shared, 1);
        assert!(db.get_asset("exclusive").unwrap().is_none());
        assert!(db.get_asset("shared").unwrap().is_some());
        assert_eq!(db.get_project("p2").unwrap().unwrap().asset_count, 1);
    }

    #[test]
    fn deleting_project_without_cleanup_keeps_all_assets() {
        let db = db();
        put_asset(&db, "a1");
        put_project(&db, "p1");
        db.add_assets_to_project("p1", &["a1".into()]).unwrap();

        let result = db.delete_project("p1", ProjectDeleteMode::Keep).unwrap();
        assert_eq!(result.deleted_assets, 0);
        assert_eq!(result.preserved_shared, 1);
        assert!(db.get_asset("a1").unwrap().is_some());
    }

    #[test]
    fn moving_project_out_moves_exclusive_and_preserves_shared() {
        let stamp = ulid::Ulid::new().to_string();
        let workspace = std::env::temp_dir().join(format!("bowerbird-ws-{stamp}"));
        let store_dir = std::env::temp_dir().join(format!("bowerbird-store-{stamp}"));
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&store_dir).unwrap();
        let exclusive_file = store_dir.join("exclusive-src.png");
        let shared_file = store_dir.join("shared-src.png");
        std::fs::write(&exclusive_file, b"exclusive").unwrap();
        std::fs::write(&shared_file, b"shared").unwrap();

        let db = db();
        put_asset_with_store(&db, "exclusive", Some(&exclusive_file));
        put_asset_with_store(&db, "shared", Some(&shared_file));
        put_project_at(&db, "p1", &workspace.to_string_lossy());
        put_project(&db, "p2");
        db.add_assets_to_project("p1", &["shared".into(), "exclusive".into()])
            .unwrap();
        db.add_assets_to_project("p2", &["shared".into()]).unwrap();

        let result = db.delete_project("p1", ProjectDeleteMode::MoveOut).unwrap();
        assert_eq!(result.removed_members, 2);
        assert_eq!(result.moved_assets, 1);
        assert_eq!(result.preserved_shared, 1);
        assert!(result.failed_moves.is_empty());
        // 独占素材：文件移回 workspace（用素材名命名）、库里原文件消失、资产行删除。
        assert!(!exclusive_file.exists());
        assert!(workspace.join("exclusive.png").exists());
        assert!(db.get_asset("exclusive").unwrap().is_none());
        // 共享素材：文件与资产行都保留。
        assert!(shared_file.exists());
        assert!(db.get_asset("shared").unwrap().is_some());

        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&store_dir);
    }

    #[test]
    fn move_destination_sanitizes_name_and_avoids_overwrite() {
        let stamp = ulid::Ulid::new().to_string();
        let workspace = std::env::temp_dir().join(format!("bowerbird-dst-{stamp}"));
        std::fs::create_dir_all(&workspace).unwrap();
        let store = Path::new("C:\\library\\images\\2026\\07\\01ABC.ulid.png");
        // 非法字符净化。
        let dst = move_destination(&workspace, "a/b:c*?\"<>|", store, "01ABCDEFGH99");
        assert_eq!(dst.file_name().unwrap(), "a_b_c______.png");
        // 空名回退 store 文件名。
        let dst = move_destination(&workspace, "  ", store, "01ABCDEFGH99");
        assert_eq!(dst.file_name().unwrap(), "01ABC.ulid.png");
        // 重名追加 id 前缀，不覆盖已有文件。
        std::fs::write(workspace.join("dup.png"), b"existing").unwrap();
        let dst = move_destination(&workspace, "dup", store, "01ABCDEFGH99");
        assert_eq!(dst.file_name().unwrap(), "dup-01ABCDEF.png");
        let _ = std::fs::remove_dir_all(&workspace);
    }
}
