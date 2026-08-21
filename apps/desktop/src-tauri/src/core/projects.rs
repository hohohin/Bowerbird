//! 项目 workspace：登记项目、维护素材多对多成员关系与当前采集项目上下文。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::core::ingest;
use crate::core::library::{delete_asset_files, Asset};
use crate::core::paths::LibraryPaths;
use crate::db::Database;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub workspace_path: String,
    pub created_at: i64,
    pub asset_count: i64,
    pub kind: String,
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

/// 「更新项目文件」结果：本次新加入项目的素材数（0 = 文件夹没有新素材）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRefreshResult {
    pub added_count: usize,
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

/// 右键单素材删除三选项（与「删除项目」语义对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetDeleteMode {
    /// 仅移出当前项目（素材留在全局）；非项目内时等价于 `Keep` 无操作。
    Keep,
    /// 文件移回原始位置（origin_path）并删资产行；同项目的独占素材直接删除。
    MoveOut,
    /// 从全局及所有项目物理删除（删文件 + 删行 + 级联清理）。
    Delete,
}

/// 单素材删除结果（前端消息提示用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetDeleteResult {
    /// 实际从中央库删除的资产数（keep 为 0）。
    pub deleted_assets: usize,
    /// keep 模式：从当前项目移出的成员关系数。
    pub removed_members: usize,
    /// move_out 模式：成功移回原始位置的文件数。
    pub moved_files: usize,
    /// move_out 模式：移回失败的原始路径（素材保留在全局）。
    pub failed_moves: Vec<String>,
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
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
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
        kind: row.get("kind")?,
    })
}

impl Database {
    pub fn create_project(
        &self,
        id: &str,
        name: &str,
        workspace_path: &str,
        workspace_key: &str,
        kind: &str,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, workspace_path, workspace_key, kind, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))",
            rusqlite::params![id, name, workspace_path, workspace_key, kind],
        )?;
        Ok(())
    }

    pub fn list_projects(&self) -> AppResult<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.workspace_path, p.created_at, p.kind, COUNT(pa.asset_id) AS asset_count \
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
            "SELECT p.id, p.name, p.workspace_path, p.created_at, p.kind, COUNT(pa.asset_id) AS asset_count \
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
        let (workspace_path, kind): (String, String) = conn
            .query_row(
                "SELECT workspace_path, kind FROM projects WHERE id = ?1",
                rusqlite::params![project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("project {project_id}")))?;
        // 预置项目（如「欢迎来到园丁鸟」）：workspace_path 是虚拟值，无真实目录可移出，
        // 成员素材（source='sample'）应留全局供未来按 source 清理。强制 Keep 语义，忽略传入 mode。
        // 空白项目（kind="blank"）没有 workspace，「移出」无处可移（MoveOut 会把文件移到相对
        // 路径），同样降级 Keep；Keep / DeleteExclusive 语义不变。
        let mode = match (kind.as_str(), mode) {
            ("builtin", _) => ProjectDeleteMode::Keep,
            ("blank", ProjectDeleteMode::MoveOut) => ProjectDeleteMode::Keep,
            (_, mode) => mode,
        };

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

    /// 单素材删除（右键菜单），三选项语义与「删除项目」对齐：
    /// - `Keep`：仅移出当前项目（素材留全局）。`project_id=None` 时无操作。
    /// - `MoveOut`：文件移回原始位置（origin_path）并删资产行；同项目的独占素材直接删除；
    ///   共享素材移回后仍留全局（行保留）。
    /// - `Delete`：从全局及所有项目物理删除。
    pub fn delete_asset_with_mode(
        &self,
        asset_id: &str,
        mode: AssetDeleteMode,
        project_id: Option<&str>,
    ) -> AppResult<AssetDeleteResult> {
        let conn = self.conn.lock().unwrap();
        // 直接在当前持有连接上取行（self.get_asset() 会再锁 conn，死锁）。
        let (name, origin_path, store_path): (String, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT name, origin_path, store_path FROM assets WHERE id = ?1",
                rusqlite::params![asset_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("asset {asset_id}")))?;

        // 共享判定：该素材是否还被其它项目引用（在中央库层面复用项目的共享语义）。
        let shared_in_other_project: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_assets pa \
                 WHERE pa.asset_id = ?1 AND pa.project_id != COALESCE(?2, ''))",
            rusqlite::params![asset_id, project_id],
            |r| r.get(0),
        )?;

        match mode {
            AssetDeleteMode::Keep => {
                // 仅移出当前项目：素材留全局。
                let mut removed_members = 0;
                if let Some(pid) = project_id {
                    removed_members = conn.execute(
                        "DELETE FROM project_assets WHERE project_id = ?1 AND asset_id = ?2",
                        rusqlite::params![pid, asset_id],
                    )?;
                }
                Ok(AssetDeleteResult {
                    deleted_assets: 0,
                    removed_members,
                    moved_files: 0,
                    failed_moves: Vec::new(),
                })
            }
            AssetDeleteMode::Delete => {
                // 从全局及所有项目物理删除（删行删文件，成员关系由 ON DELETE CASCADE 清理）。
                drop(conn); // 先释放锁，delete_asset 内部会再拿锁（文件 IO 前 drop）。
                self.delete_asset(asset_id)?;
                Ok(AssetDeleteResult {
                    deleted_assets: 1,
                    removed_members: 0,
                    moved_files: 0,
                    failed_moves: Vec::new(),
                })
            }
            AssetDeleteMode::MoveOut => {
                if shared_in_other_project {
                    // 共享素材：仍被其它项目引用，不能从库删除，库内文件也不能动（行保留、
                    // 缩略图/详情页仍按 store_path 渲染）。只移出当前项目视图；原始文件在位
                    // 即算「已恢复」，原始文件不在时如实报告失败。
                    let mut removed_members = 0;
                    if let Some(pid) = project_id {
                        removed_members = conn.execute(
                            "DELETE FROM project_assets WHERE project_id = ?1 AND asset_id = ?2",
                            rusqlite::params![pid, asset_id],
                        )?;
                    }
                    let origin_exists = origin_path
                        .as_deref()
                        .map(Path::new)
                        .is_some_and(|p| p.exists());
                    return Ok(AssetDeleteResult {
                        deleted_assets: 0,
                        removed_members,
                        moved_files: 0,
                        failed_moves: if origin_exists {
                            Vec::new()
                        } else {
                            vec![name.clone()]
                        },
                    });
                }

                // 独占素材的「移出园丁鸟」：把素材文件交回原始位置。原始位置优先取 origin_path；
                // 原文件已不在（被移动/删除，或扩展临时目录已清）时把库内文件移回 origin_path。
                let mut restored = false;
                let mut failed_moves = Vec::new();
                let mut moved_files = 0;
                if let Some(dst) = origin_path.as_deref().map(Path::new) {
                    if dst.exists() {
                        // 原文件仍在原始位置：素材已就位，库内只是副本，无需移动。
                        restored = true;
                    } else if let Some(src) = store_path.as_deref().map(Path::new) {
                        // 原文件已不在：把库内文件移回原始位置（move_file 目标不存在时才走到这里）。
                        match move_file(src, dst) {
                            Ok(()) => {
                                restored = true;
                                moved_files = 1;
                            }
                            Err(error) => {
                                tracing::warn!(
                                    "move asset {asset_id} back to {} failed: {error}",
                                    dst.display()
                                );
                                failed_moves.push(name.clone());
                            }
                        }
                    } else {
                        failed_moves.push(name.clone());
                    }
                } else {
                    failed_moves.push(name.clone());
                }

                // 独占素材：恢复成功（或原文件本就在位）→ 从库删行删文件（ON DELETE CASCADE
                // 清掉该素材在全部项目的成员关系）。store_path 与 origin_path 相同（病态导入）
                // 时不删，避免删掉用户原始文件。
                if restored && store_path.as_deref() != origin_path.as_deref() {
                    drop(conn);
                    self.delete_asset(asset_id)?;
                    Ok(AssetDeleteResult {
                        deleted_assets: 1,
                        removed_members: 0,
                        moved_files,
                        failed_moves: Vec::new(),
                    })
                } else {
                    // 恢复失败：素材保留在全局，不删任何东西。
                    Ok(AssetDeleteResult {
                        deleted_assets: 0,
                        removed_members: 0,
                        moved_files,
                        failed_moves,
                    })
                }
            }
        }
    }
}

/// 「更新项目文件」：重新扫描项目 workspace 文件夹，把新增图片导入中央库并加入项目。
/// 约定 18 项目不监听文件夹，本函数只做**单向增量**——已导入过的文件（origin_path 命中）
/// 直接跳过：既省去全量重拷贝/重算 pHash，也避免低熵纯色图等不可去重文件被重复入库；
/// 文件夹里删掉的文件不动（刷新不删素材）。新文件走 [`ingest::ingest_file`]，视觉去重
/// 命中已有资产时只新增项目关系。返回（本次涉及的资产, 新增成员数），命令层据此触发
/// 自动分析（已有 caption 的资产内部会跳过）与结果提示。
pub fn refresh_workspace_assets(
    paths: &LibraryPaths,
    db: &Database,
    workspace: &Path,
    project_id: &str,
) -> AppResult<(Vec<Asset>, usize)> {
    let existing = db.list_origin_paths()?;
    let mut assets = Vec::new();
    for p in ingest::walk_images(workspace) {
        if existing.contains(p.to_string_lossy().as_ref()) {
            continue;
        }
        match ingest::ingest_file(paths, db, &p) {
            Ok(a) => assets.push(a),
            Err(e) => tracing::warn!("refresh ingest failed for {}: {e}", p.display()),
        }
    }
    // 文件夹里多个新文件视觉去重命中同一已有资产时按 id 归并。
    let mut unique = std::collections::HashMap::new();
    for asset in assets {
        unique.entry(asset.id.clone()).or_insert(asset);
    }
    let assets: Vec<_> = unique.into_values().collect();
    if assets.is_empty() {
        return Ok((assets, 0));
    }
    let ids: Vec<String> = assets.iter().map(|a| a.id.clone()).collect();
    let added = db.add_assets_to_project(project_id, &ids)?;
    Ok((assets, added))
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
        db.create_project(id, id, workspace, workspace, "user")
            .unwrap();
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

        let result = db
            .delete_project("p1", ProjectDeleteMode::DeleteExclusive)
            .unwrap();
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
    fn deleting_blank_project_degrades_move_out_to_keep() {
        let db = db();
        put_asset(&db, "a1");
        // 空白项目：无 workspace（空路径），kind="blank"，key 用 id 派生避免 UNIQUE 冲突。
        db.create_project("p1", "空白", "", "blank:p1", "blank")
            .unwrap();
        db.add_assets_to_project("p1", &["a1".into()]).unwrap();

        // 「移出」无 workspace 可回，降级 Keep：项目删除、素材留在全局、不产生任何移动。
        let result = db.delete_project("p1", ProjectDeleteMode::MoveOut).unwrap();
        assert_eq!(result.moved_assets, 0);
        assert_eq!(result.deleted_assets, 0);
        assert!(db.get_asset("a1").unwrap().is_some());
        assert!(db.get_project("p1").unwrap().is_none());
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

    #[test]
    fn asset_delete_keep_only_removes_project_membership() {
        let db = db();
        put_asset(&db, "a1");
        put_project(&db, "p1");
        db.add_assets_to_project("p1", &["a1".into()]).unwrap();

        let result = db
            .delete_asset_with_mode("a1", AssetDeleteMode::Keep, Some("p1"))
            .unwrap();
        assert_eq!(result.deleted_assets, 0);
        assert_eq!(result.removed_members, 1);
        // 素材留全局。
        assert!(db.get_asset("a1").unwrap().is_some());
    }

    #[test]
    fn asset_delete_delete_removes_row_and_all_memberships() {
        let db = db();
        put_asset(&db, "a1");
        put_project(&db, "p1");
        put_project(&db, "p2");
        db.add_assets_to_project("p1", &["a1".into()]).unwrap();
        db.add_assets_to_project("p2", &["a1".into()]).unwrap();

        let result = db
            .delete_asset_with_mode("a1", AssetDeleteMode::Delete, None)
            .unwrap();
        assert_eq!(result.deleted_assets, 1);
        assert!(db.get_asset("a1").unwrap().is_none());
        // 两个项目的成员关系都被级联清理。
        assert_eq!(db.get_project("p1").unwrap().unwrap().asset_count, 0);
        assert_eq!(db.get_project("p2").unwrap().unwrap().asset_count, 0);
    }

    #[test]
    fn asset_move_out_moves_shared_back_and_keeps_row() {
        let stamp = ulid::Ulid::new().to_string();
        let origin_dir = std::env::temp_dir().join(format!("bowerbird-origin-{stamp}"));
        let store_dir = std::env::temp_dir().join(format!("bowerbird-store2-{stamp}"));
        std::fs::create_dir_all(&origin_dir).unwrap();
        std::fs::create_dir_all(&store_dir).unwrap();
        let origin_file = origin_dir.join("shared.png");
        let store_file = store_dir.join("shared-ulid.png");
        std::fs::write(&origin_file, b"original").unwrap();
        std::fs::write(&store_file, b"library copy").unwrap();

        let db = db();
        put_asset_with_store(&db, "shared", Some(&store_file));
        // 直接把 origin_path 改成源文件。
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE assets SET origin_path = ?1 WHERE id = 'shared'",
                rusqlite::params![origin_file.to_string_lossy().to_string()],
            )
            .unwrap();
        }
        put_project(&db, "p1");
        put_project(&db, "p2");
        db.add_assets_to_project("p1", &["shared".into()]).unwrap();
        db.add_assets_to_project("p2", &["shared".into()]).unwrap();

        // 共享素材：原始文件仍在 → 视为已就位（无需移动），资产行保留在全局（含库内副本），
        // 项目 p1 成员关系被移除。
        let result = db
            .delete_asset_with_mode("shared", AssetDeleteMode::MoveOut, Some("p1"))
            .unwrap();
        assert_eq!(result.deleted_assets, 0);
        assert_eq!(result.moved_files, 0);
        assert!(db.get_asset("shared").unwrap().is_some());
        assert_eq!(db.get_project("p1").unwrap().unwrap().asset_count, 0);
        assert_eq!(db.get_project("p2").unwrap().unwrap().asset_count, 1);
        assert!(store_file.exists());

        let _ = std::fs::remove_dir_all(&origin_dir);
        let _ = std::fs::remove_dir_all(&store_dir);
    }

    #[test]
    fn asset_move_out_exclusive_removes_row() {
        let stamp = ulid::Ulid::new().to_string();
        let origin_dir = std::env::temp_dir().join(format!("bowerbird-origin2-{stamp}"));
        let store_dir = std::env::temp_dir().join(format!("bowerbird-store3-{stamp}"));
        std::fs::create_dir_all(&origin_dir).unwrap();
        std::fs::create_dir_all(&store_dir).unwrap();
        let origin_file = origin_dir.join("exclusive.png");
        let store_file = store_dir.join("exclusive-ulid.png");
        std::fs::write(&origin_file, b"original").unwrap();
        std::fs::write(&store_file, b"library copy").unwrap();

        let db = db();
        put_asset_with_store(&db, "ex", Some(&store_file));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE assets SET origin_path = ?1 WHERE id = 'ex'",
                rusqlite::params![origin_file.to_string_lossy().to_string()],
            )
            .unwrap();
        }
        put_project(&db, "p1");
        db.add_assets_to_project("p1", &["ex".into()]).unwrap();

        // 独占素材：原始文件仍在 → 视为已就位（无需移动），资产行从库删除、文件保留在原始位置。
        let result = db
            .delete_asset_with_mode("ex", AssetDeleteMode::MoveOut, Some("p1"))
            .unwrap();
        assert_eq!(result.deleted_assets, 1);
        assert_eq!(result.moved_files, 0);
        assert!(db.get_asset("ex").unwrap().is_none());
        assert_eq!(db.get_project("p1").unwrap().unwrap().asset_count, 0);
        // 原始文件还在；库内副本已随删行被删除。
        assert!(origin_file.exists());
        assert!(!store_file.exists());

        let _ = std::fs::remove_dir_all(&origin_dir);
        let _ = std::fs::remove_dir_all(&store_dir);
    }

    #[test]
    fn asset_move_out_moves_library_file_back_when_origin_missing() {
        let stamp = ulid::Ulid::new().to_string();
        let origin_dir = std::env::temp_dir().join(format!("bowerbird-origin3-{stamp}"));
        let store_dir = std::env::temp_dir().join(format!("bowerbird-store4-{stamp}"));
        std::fs::create_dir_all(&origin_dir).unwrap();
        std::fs::create_dir_all(&store_dir).unwrap();
        let origin_file = origin_dir.join("gone.png");
        let store_file = store_dir.join("gone-ulid.png");
        // 原始文件已不在（用户删了/移动了）。
        std::fs::write(&store_file, b"library copy").unwrap();

        let db = db();
        put_asset_with_store(&db, "gone", Some(&store_file));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE assets SET origin_path = ?1 WHERE id = 'gone'",
                rusqlite::params![origin_file.to_string_lossy().to_string()],
            )
            .unwrap();
        }
        put_project(&db, "p1");
        db.add_assets_to_project("p1", &["gone".into()]).unwrap();

        // 独占素材：库内文件真实移回原始位置 + 资产行删除。
        let result = db
            .delete_asset_with_mode("gone", AssetDeleteMode::MoveOut, Some("p1"))
            .unwrap();
        assert_eq!(result.deleted_assets, 1);
        assert_eq!(result.moved_files, 1);
        assert!(db.get_asset("gone").unwrap().is_none());
        assert!(origin_file.exists());
        assert!(!store_file.exists());

        let _ = std::fs::remove_dir_all(&origin_dir);
        let _ = std::fs::remove_dir_all(&store_dir);
    }

    #[test]
    fn asset_move_out_shared_with_missing_origin_keeps_library_copy() {
        let stamp = ulid::Ulid::new().to_string();
        let origin_dir = std::env::temp_dir().join(format!("bowerbird-origin4-{stamp}"));
        let store_dir = std::env::temp_dir().join(format!("bowerbird-store5-{stamp}"));
        std::fs::create_dir_all(&origin_dir).unwrap();
        std::fs::create_dir_all(&store_dir).unwrap();
        let origin_file = origin_dir.join("missing.png"); // 原始文件不存在
        let store_file = store_dir.join("missing-ulid.png");
        std::fs::write(&store_file, b"library copy").unwrap();

        let db = db();
        put_asset_with_store(&db, "missing", Some(&store_file));
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE assets SET origin_path = ?1 WHERE id = 'missing'",
                rusqlite::params![origin_file.to_string_lossy().to_string()],
            )
            .unwrap();
        }
        put_project(&db, "p1");
        put_project(&db, "p2");
        db.add_assets_to_project("p1", &["missing".into()]).unwrap();
        db.add_assets_to_project("p2", &["missing".into()]).unwrap();

        // 共享素材：原始文件不在 → 不能动库内文件（会破坏 p2 的引用），如实报告失败。
        let result = db
            .delete_asset_with_mode("missing", AssetDeleteMode::MoveOut, Some("p1"))
            .unwrap();
        assert_eq!(result.deleted_assets, 0);
        assert_eq!(result.removed_members, 1);
        assert!(!result.failed_moves.is_empty());
        assert!(db.get_asset("missing").unwrap().is_some());
        assert!(store_file.exists());
        assert_eq!(db.get_project("p2").unwrap().unwrap().asset_count, 1);

        let _ = std::fs::remove_dir_all(&origin_dir);
        let _ = std::fs::remove_dir_all(&store_dir);
    }

    #[test]
    fn refresh_workspace_assets_imports_only_new_files() {
        use image::{ImageBuffer, Rgb};

        let stamp = ulid::Ulid::new().to_string();
        let base = std::env::temp_dir().join(format!("bowerbird-refresh-{stamp}"));
        let workspace = base.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let paths = LibraryPaths::init(base.join("lib")).unwrap();
        let db = db();
        put_project_at(&db, "p1", &workspace.to_string_lossy());

        let gradient = |path: &Path, seed: u8| {
            let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(64, 64, |x, y| {
                Rgb([
                    ((x * 4 + seed as u32) % 256) as u8,
                    ((y * 4 + seed as u32) % 256) as u8,
                    seed,
                ])
            });
            img.save(path).unwrap();
        };
        // 低熵纯色图：dHash 退化不做视觉去重，防重复入库只能靠 origin_path 跳过。
        let solid = |path: &Path| {
            let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
                ImageBuffer::from_pixel(64, 64, Rgb([200, 30, 30]));
            img.save(path).unwrap();
        };
        gradient(&workspace.join("a.png"), 11);
        gradient(&workspace.join("b.png"), 77);
        solid(&workspace.join("solid.png"));

        // 首次刷新 = 建项式全量导入。
        let (_, added) = refresh_workspace_assets(&paths, &db, &workspace, "p1").unwrap();
        assert_eq!(added, 3);
        assert_eq!(db.count_assets(None).unwrap(), 3);
        assert_eq!(db.get_project("p1").unwrap().unwrap().asset_count, 3);

        // 无变化再刷：零新增，纯色图不被重复入库。
        let (_, added) = refresh_workspace_assets(&paths, &db, &workspace, "p1").unwrap();
        assert_eq!(added, 0);
        assert_eq!(db.count_assets(None).unwrap(), 3);

        // 文件夹新增文件 → 只补新文件；被删掉的文件不回收素材（单向增量）。
        gradient(&workspace.join("c.png"), 33);
        let _ = std::fs::remove_file(workspace.join("a.png"));
        let (_, added) = refresh_workspace_assets(&paths, &db, &workspace, "p1").unwrap();
        assert_eq!(added, 1);
        assert_eq!(db.count_assets(None).unwrap(), 4);
        assert_eq!(db.get_project("p1").unwrap().unwrap().asset_count, 4);

        let _ = std::fs::remove_dir_all(&base);
    }
}
