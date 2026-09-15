//! Opt-in project deletion. Only durable, exclusive central assets are eligible.
//! Files are renamed before SQL commit, with a durable manifest for crash recovery.
use super::{
    paths::LibraryPaths,
    projects::{ensure_project_has_no_unfinished_work, ProjectDeleteResult},
};
use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct ExclusiveDeleteImpact {
    pub exclusive_asset_count: usize,
    pub exclusive_file_count: usize,
    pub preserved_shared_count: usize,
    pub preserved_unsafe_count: usize,
    pub confirmation: String,
}

struct Plan {
    impact: ExclusiveDeleteImpact,
    ids: Vec<String>,
    files: BTreeSet<PathBuf>,
}

// Hidden nodes and archived projects/threads deliberately participate. JSON fields are
// checked as structured values, never LIKE matches against serialized user text.
const CANDIDATES: &str = "SELECT a.id, a.store_path, a.thumb_path, a.origin_path FROM assets a WHERE
 EXISTS(SELECT 1 FROM project_assets p WHERE p.asset_id=a.id AND p.project_id=?1)
 OR EXISTS(SELECT 1 FROM canvas_nodes n WHERE n.asset_id=a.id AND n.project_id=?1)
 OR EXISTS(SELECT 1 FROM task_queue q WHERE q.project_id=?1 AND json_valid(q.payload)
   AND a.generation_session_id=json_extract(q.payload,'$.session_id'))
 OR EXISTS(SELECT 1 FROM thread_generation_links l JOIN creative_threads t ON t.id=l.thread_id
   WHERE t.project_id=?1 AND (l.generation_conversation_id=a.generation_session_id OR
     EXISTS(SELECT 1 FROM generation_conversations g WHERE g.session_id=a.generation_session_id AND g.conversation_id=l.generation_conversation_id)))
 OR EXISTS(SELECT 1 FROM cloud_agent_runs r WHERE r.project_id=?1 AND (r.final_asset_id=a.id
   OR EXISTS(SELECT 1 FROM cloud_agent_artifact_assets f WHERE f.run_id=r.run_id AND f.asset_id=a.id)))
 ORDER BY a.id";

fn protected(conn: &Connection, project: &str, id: &str, store: Option<&str>) -> AppResult<bool> {
    // local_agent_runs.target_asset_id CASCADE would destroy execution evidence: always protect.
    // Global collections and saved prompt bindings are independent uses, not project ownership.
    let linked: bool = conn.query_row("SELECT
      EXISTS(SELECT 1 FROM project_assets WHERE asset_id=?2 AND project_id<>?1) OR
      EXISTS(SELECT 1 FROM canvas_nodes WHERE asset_id=?2 AND project_id<>?1) OR
      EXISTS(SELECT 1 FROM asset_collections WHERE asset_id=?2) OR
      EXISTS(SELECT 1 FROM asset_prompts WHERE asset_id=?2) OR
      EXISTS(SELECT 1 FROM local_agent_runs WHERE target_asset_id=?2) OR
      EXISTS(SELECT 1 FROM assets a, thread_generation_links l JOIN creative_threads t ON t.id=l.thread_id
        WHERE a.id=?2 AND t.project_id<>?1 AND (l.generation_conversation_id=a.generation_session_id OR
          EXISTS(SELECT 1 FROM generation_conversations g WHERE g.session_id=a.generation_session_id AND g.conversation_id=l.generation_conversation_id))) OR
      EXISTS(SELECT 1 FROM visual_profile_assets v JOIN project_visual_profiles p ON p.id=v.profile_id
        WHERE v.asset_id=?2) OR
      EXISTS(SELECT 1 FROM cloud_agent_runs r WHERE r.project_id IS NOT ?1 AND (r.final_asset_id=?2 OR
        EXISTS(SELECT 1 FROM cloud_agent_artifact_assets f WHERE f.run_id=r.run_id AND f.asset_id=?2))) OR
      EXISTS(SELECT 1 FROM cloud_agent_runs r JOIN thread_agent_links l ON l.run_id=r.run_id
        JOIN creative_threads t ON t.id=l.thread_id WHERE t.project_id<>?1 AND (r.final_asset_id=?2 OR
        EXISTS(SELECT 1 FROM cloud_agent_artifact_assets f WHERE f.run_id=r.run_id AND f.asset_id=?2))) OR
      EXISTS(SELECT 1 FROM task_queue q JOIN assets a ON a.id=?2 WHERE q.project_id IS NOT ?1
        AND json_valid(q.payload) AND a.generation_session_id=json_extract(q.payload,'$.session_id'))",
      params![project, id], |r| r.get(0))?;
    if linked {
        return Ok(true);
    }
    // Input references in retained audit rows remain protected even inside the deleted project.
    // Other projects' payloads/snapshots/drafts may reference an asset without project_assets.
    let json_sources = [
        "SELECT payload_json FROM canvas_nodes WHERE project_id<>?1",
        "SELECT draft_json FROM project_canvases WHERE project_id<>?1",
        "SELECT source_payload FROM project_visual_profiles WHERE ?1 IS NOT NULL",
        "SELECT supporting_asset_ids FROM visual_profile_rules v JOIN project_visual_profiles p ON p.id=v.profile_id WHERE ?1 IS NOT NULL",
        "SELECT opposing_asset_ids FROM visual_profile_rules v JOIN project_visual_profiles p ON p.id=v.profile_id WHERE ?1 IS NOT NULL",
        "SELECT reference_asset_ids FROM cloud_agent_runs WHERE ?1 IS NOT NULL",
        "SELECT snapshot_json FROM cloud_agent_runs WHERE project_id IS NOT ?1",
        "SELECT checkpoint_json FROM local_agent_runs WHERE ?1 IS NOT NULL",
        "SELECT payload FROM task_queue WHERE project_id IS NOT ?1",
        "SELECT payload FROM task_queue WHERE project_id=?1 AND NOT json_valid(payload)",
        "SELECT json_object('references',json_extract(payload,'$.references'),'parent',json_extract(payload,'$.parent_asset_path')) FROM task_queue WHERE project_id=?1 AND json_valid(payload)",
        "SELECT payload FROM analyses WHERE kind='generation_meta' AND asset_id<>?2 AND ?1 IS NOT NULL",
    ];
    for sql in json_sources {
        let mut stmt = conn.prepare(sql)?;
        stmt.raw_bind_parameter(1, project)?;
        if stmt.parameter_count() > 1 {
            stmt.raw_bind_parameter(2, id)?;
        }
        let mut rows = stmt.raw_query();
        while let Some(row) = rows.next()? {
            let raw: String = row.get(0)?;
            // Unknown/malformed persisted reference data is not evidence of exclusivity.
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                return Ok(true);
            };
            fn contains(value: &serde_json::Value, id: &str, path: Option<&str>) -> bool {
                match value {
                    serde_json::Value::String(s) => {
                        s == id
                            || path
                                .is_some_and(|p| path_key(Path::new(s)) == path_key(Path::new(p)))
                    }
                    serde_json::Value::Array(a) => a.iter().any(|v| contains(v, id, path)),
                    serde_json::Value::Object(o) => o.values().any(|v| contains(v, id, path)),
                    _ => false,
                }
            }
            if contains(&value, id, store) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text);
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_owned()
    }
}

// No external originals, directories, symlinks, junctions or parent traversal. Only
// images/ and thumbnails/ owned by this configured central library are eligible.
fn safe_file(paths: &LibraryPaths, raw: &Path) -> AppResult<PathBuf> {
    if !raw.is_absolute()
        || raw
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::Other("文件路径不安全".into()));
    }
    let canonical = fs::canonicalize(raw)?;
    let root = fs::canonicalize(&paths.root)?;
    let rel = canonical
        .strip_prefix(&root)
        .map_err(|_| AppError::Other("文件不在中央库内".into()))?;
    if !matches!(
        rel.components().next().and_then(|c| c.as_os_str().to_str()),
        Some("images" | "thumbnails")
    ) {
        return Err(AppError::Other("文件不在中央素材目录内".into()));
    }
    // Inspect the supplied path too: canonicalization alone would follow internal links.
    let mut cursor = raw.to_path_buf();
    while path_key(&cursor) != path_key(&paths.root) && cursor.parent().is_some() {
        let meta = fs::symlink_metadata(&cursor)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(AppError::Other("不删除链接文件或目录".into()));
            }
        }
        if meta.file_type().is_symlink() {
            return Err(AppError::Other("不删除链接文件".into()));
        }
        cursor.pop();
    }
    if !fs::metadata(&canonical)?.is_file() {
        return Err(AppError::Other("不删除目录".into()));
    }
    Ok(canonical)
}

fn plan(conn: &Connection, paths: &LibraryPaths, project: &str) -> AppResult<Plan> {
    let kind: String = conn.query_row("SELECT kind FROM projects WHERE id=?1", [project], |r| {
        r.get(0)
    })?;
    let mut stmt = conn.prepare(CANDIDATES)?;
    let candidates = stmt
        .query_map([project], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Plan {
        impact: ExclusiveDeleteImpact::default(),
        ids: vec![],
        files: BTreeSet::new(),
    };
    let all_paths = {
        let mut stmt =
            conn.prepare("SELECT id, store_path, thumb_path, origin_path FROM assets")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                [r.get::<_, Option<String>>(1)?, r.get(2)?, r.get(3)?],
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, store, thumb, origin) in candidates {
        if kind == "builtin" || protected(conn, project, &id, store.as_deref())? {
            out.impact.preserved_shared_count += 1;
            continue;
        }
        let mut files = BTreeSet::new();
        let mut unsafe_path = store.is_none();
        for raw in [store.as_deref(), thumb.as_deref()].into_iter().flatten() {
            match safe_file(paths, Path::new(raw)) {
                Ok(file) => {
                    files.insert(file);
                }
                Err(_) => unsafe_path = true,
            }
        }
        if origin.as_deref().is_some_and(|p| {
            let original = fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
            files.iter().any(|f| path_key(f) == path_key(&original))
        }) {
            unsafe_path = true;
        }
        if unsafe_path {
            out.impact.preserved_unsafe_count += 1;
            continue;
        }
        let shared_path = all_paths.iter().any(|(other, refs)| {
            other != &id
                && refs.iter().flatten().any(|p| {
                    let canonical = fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
                    files.iter().any(|f| path_key(f) == path_key(&canonical))
                })
        });
        if shared_path {
            out.impact.preserved_shared_count += 1;
            continue;
        }
        out.ids.push(id);
        out.files.extend(files);
    }
    out.impact.exclusive_asset_count = out.ids.len();
    out.impact.exclusive_file_count = out.files.len();
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&(
        project,
        &out.ids,
        &out.files,
        out.impact.preserved_shared_count,
        out.impact.preserved_unsafe_count,
    ))?);
    for file in &out.files {
        let meta = fs::metadata(file)?;
        digest.update(meta.len().to_le_bytes());
        digest.update(format!("{:?}", meta.modified()?));
    }
    out.impact.confirmation = format!("{:x}", digest.finalize());
    Ok(out)
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    project: String,
    operation: String,
    files: Vec<PathBuf>,
}

#[cfg(test)]
thread_local! { static FAIL_UNLINK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

fn staged(file: &Path, operation: &str, index: usize) -> PathBuf {
    file.with_file_name(format!(".bowerbird-delete-{operation}-{index}"))
}

fn finish_manifest(
    paths: &LibraryPaths,
    manifest_path: &Path,
    manifest: &Manifest,
    restore: bool,
) -> AppResult<()> {
    ulid::Ulid::from_string(&manifest.operation)
        .map_err(|_| AppError::Other("删除恢复记录无效".into()))?;
    for (index, file) in manifest.files.iter().enumerate() {
        let temporary = staged(file, &manifest.operation, index);
        if temporary.exists() {
            safe_file(paths, &temporary)?;
            // The destination must be in the same validated media directory.
            if file.file_name().is_none() || file.parent() != temporary.parent() {
                return Err(AppError::Other("删除恢复路径无效".into()));
            }
            if restore {
                if file.exists() {
                    return Err(AppError::Other(format!(
                        "恢复冲突，已保留暂存文件：{}",
                        temporary.display()
                    )));
                }
                fs::rename(&temporary, file)?;
            } else {
                #[cfg(test)]
                if FAIL_UNLINK.get() {
                    return Err(AppError::Other("synthetic unlink failure".into()));
                }
                fs::remove_file(&temporary)?;
            }
        } else if restore && !file.is_file() {
            return Err(AppError::Other(format!(
                "删除恢复文件缺失：{}",
                file.display()
            )));
        }
    }
    fs::remove_file(manifest_path)?;
    Ok(())
}

impl Database {
    pub fn project_exclusive_impact(
        &self,
        paths: &LibraryPaths,
        project: &str,
    ) -> AppResult<ExclusiveDeleteImpact> {
        plan(&self.conn.lock().unwrap(), paths, project).map(|p| p.impact)
    }

    /// Run before workers start. No recursive directory removal; an interrupted operation
    /// restores files if the project transaction rolled back, otherwise completes unlinking.
    pub fn recover_project_deletions(&self, paths: &LibraryPaths) -> AppResult<()> {
        let dir = paths.root.join(".project-deletions");
        if !dir.exists() {
            return Ok(());
        }
        if fs::canonicalize(&dir)? != fs::canonicalize(&paths.root)?.join(".project-deletions") {
            return Err(AppError::Other("删除恢复目录不安全".into()));
        }
        let conn = self.conn.lock().unwrap();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let manifest: Manifest = serde_json::from_slice(&fs::read(entry.path())?)?;
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                [&manifest.project],
                |r| r.get(0),
            )?;
            finish_manifest(paths, &entry.path(), &manifest, exists)?;
        }
        Ok(())
    }

    pub fn delete_project_exclusive(
        &self,
        paths: &LibraryPaths,
        project: &str,
        confirmation: &str,
    ) -> AppResult<ProjectDeleteResult> {
        self.recover_project_deletions(paths)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_project_has_no_unfinished_work(&tx, project)?;
        let plan = plan(&tx, paths, project)?;
        if confirmation.is_empty() || confirmation != plan.impact.confirmation {
            return Err(AppError::Other(
                "项目素材或文件已变化，请重新打开删除确认".into(),
            ));
        }
        let removed_members: usize = tx.query_row(
            "SELECT COUNT(*) FROM project_assets WHERE project_id=?1",
            [project],
            |r| r.get(0),
        )?;
        let manifest = Manifest {
            project: project.into(),
            operation: ulid::Ulid::new().to_string(),
            files: plan.files.into_iter().collect(),
        };
        let dir = paths.root.join(".project-deletions");
        fs::create_dir_all(&dir)?;
        if fs::canonicalize(&dir)? != fs::canonicalize(&paths.root)?.join(".project-deletions") {
            return Err(AppError::Other("删除恢复目录不安全".into()));
        }
        let manifest_path = dir.join(format!("{}.json", manifest.operation));
        let mut journal = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&manifest_path)?;
        journal.write_all(&serde_json::to_vec(&manifest)?)?;
        journal.sync_all()?;
        drop(journal);
        let execution = (|| -> AppResult<()> {
            for (i, file) in manifest.files.iter().enumerate() {
                safe_file(paths, file)?;
                let dest = staged(file, &manifest.operation, i);
                if dest.exists() {
                    return Err(AppError::Other("删除暂存路径冲突".into()));
                }
                fs::rename(file, dest)?;
            }
            // Existing FK/tombstone contracts preserve execution rows and remove local links.
            tx.execute("DELETE FROM projects WHERE id=?1", [project])?;
            for id in &plan.ids {
                tx.execute("DELETE FROM assets WHERE id=?1", [id])?;
            }
            Ok(())
        })();
        if let Err(error) = execution {
            tx.rollback()?;
            finish_manifest(paths, &manifest_path, &manifest, true).map_err(|restore| {
                AppError::Other(format!("{error}；文件恢复未完成：{restore}"))
            })?;
            return Err(error);
        }
        if let Err(error) = tx.commit() {
            finish_manifest(paths, &manifest_path, &manifest, true).map_err(|restore| {
                AppError::Other(format!("{error}；文件恢复未完成：{restore}"))
            })?;
            return Err(error.into());
        }
        let cleanup_pending = finish_manifest(paths, &manifest_path, &manifest, false)
            .err()
            .map(|e| e.to_string())
            .into_iter()
            .collect();
        Ok(ProjectDeleteResult {
            removed_members,
            deleted_assets: plan.ids.len(),
            preserved_shared: plan.impact.preserved_shared_count
                + plan.impact.preserved_unsafe_count,
            moved_assets: 0,
            failed_moves: vec![],
            cleanup_pending,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::projects::ProjectDeleteMode;

    fn fixture() -> (Database, LibraryPaths) {
        let root = std::env::temp_dir().join(format!(
            "bowerbird-project-delete-test-{}",
            ulid::Ulid::new()
        ));
        let paths = LibraryPaths::init(root).unwrap();
        let db = Database::open(&paths.db).unwrap();
        db.migrate().unwrap();
        for id in ["p", "other"] {
            db.create_project(id, id, "", id, "blank").unwrap();
        }
        (db, paths)
    }
    fn asset(db: &Database, paths: &LibraryPaths, id: &str) -> PathBuf {
        let file = paths.images.join(format!("{id}.png"));
        let thumb = paths.thumbnails.join(format!("{id}.jpg"));
        fs::write(&file, format!("synthetic {id}")).unwrap();
        fs::write(&thumb, b"synthetic thumbnail").unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,store_path,thumb_path) VALUES(?1,?1,?2,?3)",
                params![id, file.to_str(), thumb.to_str()],
            )
            .unwrap();
        db.add_assets_to_project("p", &[id.into()]).unwrap();
        file
    }
    fn delete(db: &Database, paths: &LibraryPaths) -> AppResult<ProjectDeleteResult> {
        let impact = db.project_exclusive_impact(paths, "p")?;
        db.delete_project_exclusive(paths, "p", &impact.confirmation)
    }
    fn node(db: &Database, project: &str, id: &str, asset: &str) {
        db.conn.lock().unwrap().execute("INSERT INTO canvas_nodes(id,project_id,kind,asset_id,role,payload_json,x,y,width,height,created_at,updated_at) VALUES(?1,?2,'asset',?3,'reference','{\"schema_version\":1,\"snapshot\":{}}',0,0,100,100,1,1)",params![id,project,asset]).unwrap();
    }
    #[test]
    fn exclusive_files_deleted_shared_hidden_and_duplicate_nodes_preserved() {
        let (db, paths) = fixture();
        let only = asset(&db, &paths, "only");
        let shared = asset(&db, &paths, "shared");
        let hidden = asset(&db, &paths, "hidden");
        db.add_assets_to_project("other", &["shared".into()])
            .unwrap();
        node(&db, "other", "hidden-node", "hidden");
        node(&db, "p", "n1", "only");
        node(&db, "p", "n2", "only");
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE canvas_nodes SET hidden_at=1 WHERE id='hidden-node'",
                [],
            )
            .unwrap();
        let impact = db.project_exclusive_impact(&paths, "p").unwrap();
        assert_eq!(impact.exclusive_asset_count, 1);
        assert_eq!(impact.exclusive_file_count, 2);
        assert_eq!(impact.preserved_shared_count, 2);
        let result = delete(&db, &paths).unwrap();
        assert_eq!(result.deleted_assets, 1);
        assert!(result.cleanup_pending.is_empty());
        assert!(!only.exists());
        assert!(shared.exists());
        assert!(hidden.exists());
        assert!(db.get_project("p").unwrap().is_none());
        assert!(db.get_asset("hidden").unwrap().is_some());
    }
    #[test]
    fn default_keep_and_missing_confirmation_never_remove_files() {
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "a");
        assert!(db.delete_project_exclusive(&paths, "p", "").is_err());
        assert!(db
            .delete_project("p", ProjectDeleteMode::DeleteExclusive)
            .is_err());
        db.delete_project("p", ProjectDeleteMode::Keep).unwrap();
        assert!(file.exists());
        assert!(db.get_asset("a").unwrap().is_some());
    }
    #[test]
    fn stale_confirmation_rejects_new_members_and_new_references() {
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "a");
        let before = db.project_exclusive_impact(&paths, "p").unwrap();
        asset(&db, &paths, "b");
        assert!(db
            .delete_project_exclusive(&paths, "p", &before.confirmation)
            .is_err());
        let before = db.project_exclusive_impact(&paths, "p").unwrap();
        db.add_assets_to_project("other", &["a".into()]).unwrap();
        assert!(db
            .delete_project_exclusive(&paths, "p", &before.confirmation)
            .is_err());
        assert!(file.exists());
    }
    #[test]
    fn external_missing_directory_and_shared_paths_are_preserved() {
        let (db, paths) = fixture();
        let external = paths.root.join("user-original.png");
        fs::write(&external, b"original").unwrap();
        for id in ["external", "missing", "directory", "alias", "original"] {
            asset(&db, &paths, id);
        }
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET store_path=?1 WHERE id='external'",
            [external.to_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE assets SET store_path=?1 WHERE id='directory'",
            [paths.images.to_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE assets SET store_path=?1 WHERE id='missing'",
            [paths.images.join("absent.png").to_str()],
        )
        .unwrap();
        conn.execute(
            "UPDATE assets SET origin_path=store_path WHERE id='original'",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO assets(id,name,store_path) SELECT 'other-alias','alias',store_path FROM assets WHERE id='alias'",[]).unwrap();
        drop(conn);
        let impact = db.project_exclusive_impact(&paths, "p").unwrap();
        assert_eq!(impact.exclusive_asset_count, 0);
        assert_eq!(impact.preserved_unsafe_count, 4);
        assert_eq!(impact.preserved_shared_count, 1);
        delete(&db, &paths).unwrap();
        assert!(external.exists());
        assert!(paths.images.join("alias.png").exists());
    }
    #[test]
    fn sql_failure_after_staging_restores_files_and_all_relations() {
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "a");
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER injected_delete_failure BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
        assert!(delete(&db, &paths)
            .unwrap_err()
            .to_string()
            .contains("synthetic failure"));
        assert_eq!(fs::read(&file).unwrap(), b"synthetic a");
        assert!(db.get_project("p").unwrap().is_some());
        assert!(db.get_asset("a").unwrap().is_some());
        assert_eq!(db.get_project("p").unwrap().unwrap().asset_count, 1);
        assert_eq!(
            fs::read_dir(paths.root.join(".project-deletions"))
                .unwrap()
                .count(),
            0
        );
    }
    #[test]
    fn running_generation_and_unknown_agent_block_even_with_fresh_token() {
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "a");
        db.conn.lock().unwrap().execute("INSERT INTO task_queue(id,kind,payload,status,created_at,project_id) VALUES('q','generation','{}','running',1,'p')",[]).unwrap();
        assert!(delete(&db, &paths).is_err());
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE task_queue SET status='done'", [])
            .unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO cloud_agent_runs(run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,project_id,snapshot_json,created_at,updated_at) VALUES('r','r','test','unknown','test','[]','p','{}',1,1)",[]).unwrap();
        assert!(delete(&db, &paths).is_err());
        assert!(file.exists());
    }
    #[test]
    fn inputs_drafts_collections_and_local_audit_are_protected() {
        let (db, paths) = fixture();
        for id in ["draft", "input", "collection", "audit"] {
            asset(&db, &paths, id);
        }
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("INSERT INTO project_canvases VALUES('other','{\"schema_version\":1,\"assetId\":\"draft\"}',1,1);
        INSERT INTO folders(id,name,kind) VALUES('f','Favorites','collection');
        INSERT INTO asset_collections VALUES('collection','f',1);
        INSERT INTO local_agent_runs(id,skill_id,target_asset_id,status,phase,checkpoint_json,created_at,updated_at) VALUES('l','test','audit','succeeded','done','{}',1,1);").unwrap();
        let payload =
            serde_json::json!({"references":[paths.images.join("input.png")]}).to_string();
        conn.execute("INSERT INTO task_queue(id,kind,payload,status,created_at,project_id) VALUES('q','generation',?1,'done',1,'p')",[payload]).unwrap();
        drop(conn);
        let impact = db.project_exclusive_impact(&paths, "p").unwrap();
        assert_eq!(impact.preserved_shared_count, 4);
        delete(&db, &paths).unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM local_agent_runs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM task_queue", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn generation_links_visual_rules_and_agent_artifacts_protect_shared_uses() {
        let (db, paths) = fixture();
        for id in ["linked", "visual", "agent", "agent-own"] {
            asset(&db, &paths, id);
        }
        let conn = db.conn.lock().unwrap();
        conn.execute_batch(r#"
          INSERT INTO creative_threads VALUES('t','other','thread','direct',NULL,1,1);
          UPDATE assets SET generation_session_id='s' WHERE id='linked';
          INSERT INTO generation_conversations VALUES('s','c',1);
          INSERT INTO thread_generation_links VALUES('t','c',1);
          INSERT INTO project_visual_profiles(id,project_id,source_folder_id,name,version,status,source_scope_hash,source_payload,created_at)
            VALUES('v','other','root','profile',1,'confirmed','h','{}',1);
          INSERT INTO visual_profile_rules(id,profile_id,category,value,polarity,supporting_asset_ids)
            VALUES('rule','v','color','red','prefer','["visual"]');
          INSERT INTO cloud_agent_runs(run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,project_id,snapshot_json,created_at,updated_at)
            VALUES('r','r','test','succeeded','test','[]','other','{}',1,1),('own','own','test','succeeded','test','[]','p','{}',1,1);
          INSERT INTO cloud_agent_artifact_assets(run_id,artifact_id,asset_id,created_at) VALUES('r','f','agent',1),('own','own-f','agent-own',1);
        "#).unwrap();
        drop(conn);
        let impact = db.project_exclusive_impact(&paths, "p").unwrap();
        assert_eq!(impact.preserved_shared_count, 3);
        assert_eq!(impact.exclusive_asset_count, 1);
        delete(&db, &paths).unwrap();
        let conn = db.conn.lock().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM cloud_agent_artifact_assets",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert!(conn
            .query_row(
                "SELECT asset_id FROM cloud_agent_artifact_assets WHERE artifact_id='own-f'",
                [],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn independent_visual_profiles_protect_sources_during_project_cleanup() {
        let (db, paths) = fixture();
        for id in ["brand-source", "legacy-rule"] { asset(&db, &paths, id); }
        {
            let conn = db.conn.lock().unwrap();
            conn.execute_batch(r#"
                INSERT INTO project_visual_profiles(id,project_id,source_folder_id,name,version,status,source_scope_hash,source_payload,created_at)
                  VALUES ('global-guide',NULL,'root','Brand',1,'confirmed','h','[]',1),
                         ('legacy-guide','p','root','Legacy',2,'confirmed','h2','[]',1);
                INSERT INTO visual_profile_assets(profile_id,asset_id,role)
                  VALUES ('global-guide','brand-source','source');
                INSERT INTO visual_profile_rules(id,profile_id,category,value,polarity,supporting_asset_ids)
                  VALUES ('legacy-brand-rule','legacy-guide','palette','warm','prefer','["legacy-rule"]');
            "#).unwrap();
        }
        let impact = db.project_exclusive_impact(&paths, "p").unwrap();
        assert_eq!(impact.preserved_shared_count, 2);
        assert_eq!(impact.exclusive_asset_count, 0);
        delete(&db, &paths).unwrap();
        assert!(db.get_asset("brand-source").unwrap().is_some());
        assert!(db.get_asset("legacy-rule").unwrap().is_some());
        assert_eq!(db.list_visual_profiles("", None).unwrap().len(), 2);
    }

    #[test]
    fn generated_and_node_only_assets_are_found_without_membership() {
        let (db, paths) = fixture();
        asset(&db, &paths, "node");
        asset(&db, &paths, "generated");
        node(&db, "p", "node-only", "node");
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM project_assets;
          UPDATE assets SET generation_session_id='session' WHERE id='generated';
          INSERT INTO task_queue(id,kind,payload,status,created_at,project_id) VALUES('q','generation','{\"session_id\":\"session\",\"references\":[]}','done',1,'p');").unwrap();
        drop(conn);
        assert_eq!(
            db.project_exclusive_impact(&paths, "p")
                .unwrap()
                .exclusive_asset_count,
            2
        );
        assert_eq!(delete(&db, &paths).unwrap().deleted_assets, 2);
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM task_queue", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn interrupted_operations_restore_or_finish_based_on_committed_database() {
        for committed in [false, true] {
            let (db, paths) = fixture();
            let file = asset(&db, &paths, "a");
            let manifest = Manifest {
                project: "p".into(),
                operation: ulid::Ulid::new().to_string(),
                files: vec![file.clone()],
            };
            let dir = paths.root.join(".project-deletions");
            fs::create_dir(&dir).unwrap();
            let journal = dir.join(format!("{}.json", manifest.operation));
            fs::write(&journal, serde_json::to_vec(&manifest).unwrap()).unwrap();
            let temporary = staged(&file, &manifest.operation, 0);
            fs::rename(&file, &temporary).unwrap();
            if committed {
                db.delete_project("p", ProjectDeleteMode::Keep).unwrap();
            }
            db.recover_project_deletions(&paths).unwrap();
            assert_eq!(file.exists(), !committed);
            assert!(!temporary.exists());
            assert!(!journal.exists());
            db.recover_project_deletions(&paths).unwrap();
        }
    }
    #[cfg(windows)]
    #[test]
    fn locked_file_fails_staging_without_losing_other_files() {
        use std::os::windows::fs::OpenOptionsExt;
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "a");
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&file)
            .unwrap();
        assert!(delete(&db, &paths).is_err());
        assert!(db.get_project("p").unwrap().is_some());
        assert!(file.exists());
    }
    #[test]
    fn post_commit_unlink_failure_is_reported_and_retryable() {
        let (db, paths) = fixture();
        asset(&db, &paths, "a");
        FAIL_UNLINK.set(true);
        let result = delete(&db, &paths).unwrap();
        FAIL_UNLINK.set(false);
        assert!(!result.cleanup_pending.is_empty());
        assert!(db.get_project("p").unwrap().is_none());
        let entry = fs::read_dir(paths.root.join(".project-deletions"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        db.recover_project_deletions(&paths).unwrap();
        assert!(!entry.path().exists());
    }
}
