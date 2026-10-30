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
    collections::{BTreeSet, HashMap},
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Default, Debug, Clone, Serialize, Deserialize)]
pub struct ExclusiveDeleteImpact {
    pub exclusive_asset_count: usize,
    #[serde(default)]
    pub exclusive_asset_ids: Vec<String>,
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

fn protected(conn: &Connection, project: &str, id: &str, store: Option<&str>, check: &dyn Fn() -> AppResult<()>) -> AppResult<bool> {
    check()?;
    // local_agent_runs.target_asset_id CASCADE would destroy execution evidence: always protect.
    // Global collections and saved prompt bindings are independent uses, not project ownership.
    let linked: bool = conn.query_row("SELECT
      EXISTS(SELECT 1 FROM external_assets WHERE asset_id=?2) OR
      EXISTS(SELECT 1 FROM connected_entries WHERE asset_id=?2) OR
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
        "SELECT document_json FROM canvas_workflows WHERE project_id<>?1",
        "SELECT source_payload FROM project_visual_profiles WHERE ?1 IS NOT NULL",
        "SELECT supporting_asset_ids FROM visual_profile_rules v JOIN project_visual_profiles p ON p.id=v.profile_id WHERE ?1 IS NOT NULL",
        "SELECT opposing_asset_ids FROM visual_profile_rules v JOIN project_visual_profiles p ON p.id=v.profile_id WHERE ?1 IS NOT NULL",
        "SELECT reference_asset_ids FROM cloud_agent_runs WHERE ?1 IS NOT NULL",
        "SELECT m.reference_asset_ids FROM local_chat_messages m JOIN local_chat_conversations c ON c.id=m.conversation_id WHERE c.project_id<>?1",
        "SELECT snapshot_json FROM cloud_agent_runs WHERE project_id IS NOT ?1",
        "SELECT checkpoint_json FROM local_agent_runs WHERE ?1 IS NOT NULL",
        "SELECT payload FROM task_queue WHERE project_id IS NOT ?1",
        "SELECT payload FROM task_queue WHERE project_id=?1 AND NOT json_valid(payload)",
        "SELECT json_object('references',json_extract(payload,'$.references'),'parent',json_extract(payload,'$.parent_asset_path')) FROM task_queue WHERE project_id=?1 AND json_valid(payload)",
        "SELECT payload FROM analyses WHERE kind='generation_meta' AND asset_id<>?2 AND ?1 IS NOT NULL",
    ];
    for sql in json_sources {
        check()?;
        let mut stmt = conn.prepare(sql)?;
        stmt.raw_bind_parameter(1, project)?;
        if stmt.parameter_count() > 1 {
            stmt.raw_bind_parameter(2, id)?;
        }
        let mut rows = stmt.raw_query();
        while let Some(row) = rows.next()? {
            check()?;
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
// Only application-created media roots are eligible; browsing places confer no ownership.
fn safe_file(paths: &LibraryPaths, raw: &Path) -> AppResult<PathBuf> {
    if !raw.is_absolute()
        || raw
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::Other("文件路径不安全".into()));
    }
    let canonical = fs::canonicalize(raw)?;
    let root = paths.managed_file_root(raw)
        .ok_or_else(|| AppError::Other("文件不在应用创建的素材目录内".into()))?;
    // Inspect the supplied path too: canonicalization alone would follow internal links.
    let mut cursor = raw.to_path_buf();
    while path_key(&cursor) != path_key(&root) && cursor.parent().is_some() {
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
    plan_with_progress(conn, paths, project, &|| Ok(()), &mut |_, _, _| {})
}

fn plan_with_progress(conn: &Connection, paths: &LibraryPaths, project: &str,
    check: &dyn Fn() -> AppResult<()>, report: &mut dyn FnMut(&str, usize, usize)) -> AppResult<Plan> {
    check()?;
    report("candidates", 0, 0);
    let kind: String = conn.query_row("SELECT kind FROM projects WHERE id=?1", [project], |r| {
        r.get(0)
    })?;
    let mut stmt = conn.prepare(CANDIDATES)?;
    let candidate_rows = stmt
        .query_map([project], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?;
    let mut candidates = Vec::new();
    for row in candidate_rows {
        check()?;
        candidates.push(row?);
    }
    let mut out = Plan {
        impact: ExclusiveDeleteImpact::default(),
        ids: vec![],
        files: BTreeSet::new(),
    };
    let mut path_owners: Option<HashMap<String, BTreeSet<String>>> = None;
    let total = candidates.len();
    for (index, (id, store, thumb, origin)) in candidates.into_iter().enumerate() {
        check()?;
        report("assets", index, total);
        if kind == "builtin" || protected(conn, project, &id, store.as_deref(), check)? {
            out.impact.preserved_shared_count += 1;
            continue;
        }
        let mut files = BTreeSet::new();
        let mut unsafe_path = store.is_none();
        for raw in [store.as_deref(), thumb.as_deref()].into_iter().flatten() {
            check()?;
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
        // Resolve library paths once, and only if a candidate can actually be deleted.
        if path_owners.is_none() {
            let path_total: usize = conn.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?;
            let mut stmt = conn.prepare("SELECT id, store_path, thumb_path, origin_path FROM assets")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?,
                [r.get::<_, Option<String>>(1)?, r.get(2)?, r.get(3)?])))?;
            let mut owners: HashMap<String, BTreeSet<String>> = HashMap::new();
            for (path_index, row) in rows.enumerate() {
                check()?;
                report("paths", path_index, path_total);
                let (other, refs) = row?;
                for raw in refs.iter().flatten() {
                    check()?;
                    let canonical = fs::canonicalize(raw).unwrap_or_else(|_| PathBuf::from(raw));
                    owners.entry(path_key(&canonical)).or_default().insert(other.clone());
                }
            }
            report("paths", path_total, path_total);
            path_owners = Some(owners);
            report("assets", index, total);
        }
        let shared_path = files.iter().any(|file| path_owners.as_ref().unwrap().get(&path_key(file))
            .is_some_and(|owners| owners.iter().any(|other| other != &id)));
        if shared_path {
            out.impact.preserved_shared_count += 1;
            continue;
        }
        out.ids.push(id);
        out.files.extend(files);
    }
    check()?;
    report("assets", total, total);
    out.impact.exclusive_asset_count = out.ids.len();
    out.impact.exclusive_asset_ids = out.ids.clone();
    out.impact.exclusive_file_count = out.files.len();
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(&(
        project,
        &out.ids,
        &out.files,
        out.impact.preserved_shared_count,
        out.impact.preserved_unsafe_count,
    ))?);
    for (index, file) in out.files.iter().enumerate() {
        check()?;
        report("fingerprint", index, out.files.len());
        let meta = fs::metadata(file)?;
        digest.update(meta.len().to_le_bytes());
        digest.update(format!("{:?}", meta.modified()?));
    }
    out.impact.confirmation = format!("{:x}", digest.finalize());
    check()?;
    report("fingerprint", out.files.len(), out.files.len());
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
    /// Cancellable preview only. Final deletion still recomputes the plan inside its transaction.
    pub fn project_exclusive_impact_progress(&self, paths: &LibraryPaths, project: &str,
        check: &dyn Fn() -> AppResult<()>, report: &mut dyn FnMut(&str, usize, usize)) -> AppResult<ExclusiveDeleteImpact> {
        report("waiting", 0, 0);
        loop {
            check()?;
            match self.conn.try_lock() {
                Ok(conn) => return plan_with_progress(&conn, paths, project, check, report).map(|p| p.impact),
                Err(std::sync::TryLockError::WouldBlock) => std::thread::sleep(std::time::Duration::from_millis(20)),
                Err(_) => return Err(AppError::Other("无法读取素材库".into())),
            }
        }
    }

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
        self.delete_project_managed(paths,project,Some(confirmation),None)
    }

    pub fn delete_project_keep_managed(&self, paths: &LibraryPaths, project: &str) -> AppResult<ProjectDeleteResult> {
        self.delete_project_managed(paths,project,None,None)
    }

    pub fn delete_project_managed(&self, paths: &LibraryPaths, project: &str, confirmation: Option<&str>, discard_pending_results: Option<&[String]>) -> AppResult<ProjectDeleteResult> {
        let _records=super::creative_files::RECORD_GATE.lock().unwrap();
        self.recover_project_deletions(paths)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(expected) = discard_pending_results {
            let actual = super::projects::pending_agent_results(&tx, project)?;
            let expected: std::collections::BTreeSet<_> = expected.iter().map(String::as_str).collect();
            let actual: std::collections::BTreeSet<_> = actual.iter().map(|result| result.run_id.as_str()).collect();
            if expected != actual {
                return Err(AppError::Other("待入库任务已变化，请重新打开删除确认".into()));
            }
        }
        ensure_project_has_no_unfinished_work(&tx, project, discard_pending_results.is_some())?;
        let mut plan = if confirmation.is_some() {
            plan(&tx, paths, project)?
        } else {
            // Keep mode never deletes assets, so it needs no second exclusivity scan.
            tx.query_row("SELECT id FROM projects WHERE id=?1", [project], |r| r.get::<_, String>(0))?;
            Plan { impact: ExclusiveDeleteImpact::default(), ids: vec![], files: BTreeSet::new() }
        };
        if confirmation.is_some_and(|value|value.is_empty() || value != plan.impact.confirmation) {
            return Err(AppError::Other(
                "项目素材或文件已变化，请重新打开删除确认".into(),
            ));
        }
        let (transferred,originals)=super::file_workspace_move::history::transfer_shared(&tx,paths,project)?;
        plan.files.extend(originals);
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
            if discard_pending_results.is_some() {
                super::projects::discard_project_pending_results(&tx, project)?;
            }
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
            preserved_shared: if confirmation.is_none() {removed_members} else {plan.impact.preserved_shared_count
                + plan.impact.preserved_unsafe_count},
            moved_assets: transferred,
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

    #[test]
    fn explicit_pending_result_abandonment_unblocks_deletion_and_preserves_audit() {
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "already-ingested");
        {
            let conn = db.conn.lock().unwrap();
            for (id, project) in [("legacy", "p"), ("unrelated", "other")] {
                conn.execute("INSERT INTO cloud_agent_runs(run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,project_id,snapshot_json,feedback_action,final_asset_id,created_at,updated_at) VALUES(?1,?1,'skill','succeeded','test','[]',?2,'{}','accept','already-ingested',1,1)", params![id, project]).unwrap();
            }
        }
        let impact = db.project_delete_impact("p").unwrap();
        assert_eq!(impact.running_agent_count, 1);
        assert_eq!(impact.pending_agent_results[0].run_id, "legacy");
        assert!(db.delete_project_keep_managed(&paths, "p").is_err());
        // A stale physical confirmation must roll back the abandonment too.
        assert!(db.delete_project_managed(&paths, "p", Some("stale"), Some(&["legacy".into()])).is_err());
        assert!(db.delete_project_managed(&paths, "p", None, Some(&["unreviewed".into()])).unwrap_err().to_string().contains("待入库任务已变化"));
        assert_eq!(db.project_delete_impact("p").unwrap().running_agent_count, 1);
        let result = db.delete_project_managed(&paths, "p", None, Some(&["legacy".into()])).unwrap();
        assert_eq!(result.deleted_assets, 0);
        assert!(file.is_file());
        assert!(db.get_asset("already-ingested").unwrap().is_some());
        assert!(db.get_project("p").unwrap().is_none());
        assert_eq!(db.project_delete_impact("other").unwrap().running_agent_count, 1);
        let conn = db.conn.lock().unwrap();
        let audit: (String, String, Option<String>, String) = conn.query_row("SELECT status,feedback_action,project_id,json_extract(snapshot_json,'$._bowerbirdResultAbandonedV1.reason') FROM cloud_agent_runs WHERE run_id='legacy'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(audit, ("succeeded".into(),"accept".into(),None,"project_deleted".into()));
        assert_eq!(conn.query_row("SELECT snapshot_json FROM cloud_agent_runs WHERE run_id='unrelated'", [], |r| r.get::<_,String>(0)).unwrap(), "{}");
    }

    #[test]
    fn result_abandonment_never_bypasses_active_or_unknown_agent_states() {
        let (db, paths) = fixture();
        for status in ["running", "awaiting_local_task", "awaiting_result_feedback", "cancel_requested", "future_state"] {
            db.conn.lock().unwrap().execute("INSERT OR REPLACE INTO cloud_agent_runs(run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,project_id,snapshot_json,created_at,updated_at) VALUES('active','conversation','skill',?1,'test','[]','p','{}',1,1)", [status]).unwrap();
            assert!(db.delete_project_managed(&paths, "p", None, Some(&[])).is_err(), "{status}");
            assert!(db.get_project("p").unwrap().is_some());
        }
    }

    #[test]
    fn pending_result_abandonment_keeps_physical_delete_confirmation_required() {
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "exclusive");
        db.conn.lock().unwrap().execute("INSERT INTO cloud_agent_runs(run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,project_id,snapshot_json,feedback_action,created_at,updated_at) VALUES('legacy','conversation','skill','succeeded','test','[]','p','{}','accept',1,1)", []).unwrap();
        assert!(db.delete_project_managed(&paths, "p", Some(""), Some(&["legacy".into()])).is_err());
        assert!(file.is_file());
        let confirmation = db.project_exclusive_impact(&paths, "p").unwrap().confirmation;
        let result = db.delete_project_managed(&paths, "p", Some(&confirmation), Some(&["legacy".into()])).unwrap();
        assert_eq!(result.deleted_assets, 1);
        assert!(!file.exists());
        assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM cloud_agent_runs WHERE run_id='legacy' AND project_id IS NULL AND status='succeeded'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
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
    #[test]
    fn connected_managed_original_survives_every_project_cleanup_mode() {
        for mode in ["exclusive", "move-out", "shared-transfer"] {
            let (db, mut paths) = fixture();
            let mut file = asset(&db, &paths, "connected");
            if mode == "shared-transfer" {
                let files = std::sync::Arc::new(super::super::file_workspace::FileWorkspace::open(
                    paths.root.join("files.json"), paths.root.join("BowerbirdLibrary")).unwrap());
                let target = files.project_directory("p", "p").unwrap().join("connected.png");
                fs::rename(&file, &target).unwrap();
                file = target;
                db.conn.lock().unwrap().execute("UPDATE assets SET store_path=?1 WHERE id='connected'", [file.to_string_lossy()]).unwrap();
                db.add_assets_to_project("other", &["connected".into()]).unwrap();
                paths.files = Some(files);
            }
            let original = fs::read(&file).unwrap();
            let directory = file.parent().unwrap().to_string_lossy();
            {
                let conn = db.conn.lock().unwrap();
                conn.execute("INSERT INTO connected_roots(id,path) VALUES('root',?1)", [&directory]).unwrap();
                conn.execute("INSERT INTO connected_folders(id,root_id,path,name) VALUES('root','root',?1,'connected')", [&directory]).unwrap();
                conn.execute("INSERT INTO connected_entries(id,folder_id,asset_id,path,name,is_reference) VALUES('entry','root','connected',?1,'connected.png',0)", [file.to_string_lossy()]).unwrap();
            }
            let result = match mode {
                "exclusive" => {
                    let impact = db.project_exclusive_impact(&paths, "p").unwrap();
                    assert_eq!(impact.exclusive_asset_count, 0);
                    assert_eq!(impact.preserved_shared_count, 1);
                    db.delete_project_exclusive(&paths, "p", &impact.confirmation).unwrap()
                }
                "move-out" => {
                    let workspace = paths.root.join("workspace");
                    fs::create_dir(&workspace).unwrap();
                    db.conn.lock().unwrap().execute("UPDATE projects SET kind='user',workspace_path=?1 WHERE id='p'", [workspace.to_string_lossy()]).unwrap();
                    db.delete_project("p", ProjectDeleteMode::MoveOut).unwrap()
                }
                _ => db.delete_project_keep_managed(&paths, "p").unwrap(),
            };
            assert_eq!(result.moved_assets, 0, "{mode}");
            assert_eq!(result.deleted_assets, 0, "{mode}");
            assert_eq!(fs::read(&file).unwrap(), original, "{mode}");
            assert_eq!(db.get_asset("connected").unwrap().unwrap().store_path.as_deref(), file.to_str());
            assert!(db.get_project("p").unwrap().is_none());
            assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM connected_entries WHERE asset_id='connected'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
            drop(db);
            fs::remove_dir_all(paths.root).unwrap();
        }
    }
    #[test]
    fn cancelled_preview_releases_database_without_changing_files_or_project() {
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "cancel-preview");
        let cancelled = std::cell::Cell::new(false);
        let mut events = Vec::new();
        let result = db.project_exclusive_impact_progress(&paths, "p",
            &|| if cancelled.get() { Err(AppError::Other("cancelled".into())) } else { Ok(()) },
            &mut |phase, completed, total| {
                events.push((phase.to_string(), completed, total));
                if phase == "paths" { cancelled.set(true); }
            });
        assert!(result.is_err());
        assert!(events.iter().any(|e| e.0 == "paths"));
        assert!(db.conn.try_lock().is_ok());
        assert!(db.get_project("p").unwrap().is_some());
        assert!(db.get_asset("cancel-preview").unwrap().is_some());
        assert!(file.is_file());
        let expected = db.project_exclusive_impact(&paths, "p").unwrap();
        let actual = db.project_exclusive_impact_progress(&paths, "p", &|| Ok(()),
            &mut |phase, completed, total| events.push((phase.to_string(), completed, total))).unwrap();
        assert_eq!(actual.confirmation, expected.confirmation);
        assert_eq!(actual.exclusive_asset_ids, expected.exclusive_asset_ids);
        assert_eq!(events.last().unwrap(), &("fingerprint".into(), 2, 2));
    }
    #[test]
    fn preview_can_be_cancelled_while_waiting_for_database() {
        let (db, paths) = fixture();
        let _locked = db.conn.lock().unwrap();
        let checks = std::cell::Cell::new(0);
        let result = db.project_exclusive_impact_progress(&paths, "p", &|| {
            checks.set(checks.get() + 1);
            if checks.get() >= 2 { Err(AppError::Other("cancelled".into())) } else { Ok(()) }
        }, &mut |_, _, _| {});
        assert!(result.is_err());
        assert_eq!(checks.get(), 2);
    }
    #[test]
    fn protected_only_preview_skips_library_path_scan() {
        let (db, paths) = fixture();
        asset(&db, &paths, "shared-preview");
        db.add_assets_to_project("other", &["shared-preview".into()]).unwrap();
        let impact = db.project_exclusive_impact_progress(&paths, "p", &|| Ok(()),
            &mut |phase, _, _| assert_ne!(phase, "paths")).unwrap();
        assert_eq!(impact.exclusive_asset_count, 0);
        assert_eq!(impact.preserved_shared_count, 1);
    }
    #[test]
    fn managed_keep_preserves_exclusive_shared_and_missing_assets() {
        let (db, paths) = fixture();
        let exclusive = asset(&db, &paths, "keep-exclusive");
        let shared = asset(&db, &paths, "keep-shared");
        let missing = asset(&db, &paths, "keep-missing");
        db.add_assets_to_project("other", &["keep-shared".into()]).unwrap();
        fs::remove_file(missing).unwrap();
        let result = db.delete_project_keep_managed(&paths, "p").unwrap();
        assert_eq!(result.deleted_assets, 0);
        assert_eq!(result.preserved_shared, 3);
        assert!(exclusive.is_file());
        assert!(shared.is_file());
        for id in ["keep-exclusive", "keep-shared", "keep-missing"] {
            assert!(db.get_asset(id).unwrap().is_some());
        }
        assert!(db.get_project("p").unwrap().is_none());
        assert!(db.delete_project_keep_managed(&paths, "p").is_err());
    }
    fn node(db: &Database, project: &str, id: &str, asset: &str) {
        db.conn.lock().unwrap().execute("INSERT INTO canvas_nodes(id,project_id,kind,asset_id,role,payload_json,x,y,width,height,created_at,updated_at) VALUES(?1,?2,'asset',?3,'reference','{\"schema_version\":1,\"snapshot\":{}}',0,0,100,100,1,1)",params![id,project,asset]).unwrap();
    }
    #[test]
    fn managed_project_files_are_eligible_but_added_locations_are_not() {
        let (db, mut paths) = fixture();
        let files = std::sync::Arc::new(crate::core::file_workspace::FileWorkspace::open(
            paths.root.join("file-workspace.json"), paths.root.join("BowerbirdLibrary")).unwrap());
        let project = files.project_directory("p", "project").unwrap();
        let managed = project.join("output.png"); fs::write(&managed, b"created").unwrap();
        let external = paths.root.join("user-photos"); fs::create_dir(&external).unwrap();
        fs::write(external.join("original.png"), b"user original").unwrap();
        files.set_place(&external, true).unwrap(); paths.files = Some(files);
        assert!(safe_file(&paths, &managed).is_ok());
        assert!(safe_file(&paths, &external.join("original.png")).is_err());
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,store_path) VALUES('output','output',?1)", [managed.to_str()]).unwrap();
        db.add_assets_to_project("p", &["output".into()]).unwrap();
        assert_eq!(db.project_exclusive_impact(&paths, "p").unwrap().exclusive_asset_count, 1);
        delete(&db, &paths).unwrap();
        assert!(!managed.exists());
        assert!(external.join("original.png").exists());
    }
    #[test]
    fn workflow_references_in_other_projects_protect_assets_without_membership() {
        let (db, paths) = fixture();
        let file = asset(&db, &paths, "workflow-input");
        db.conn.lock().unwrap().execute(
            "INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES ('other',1,?1)",
            [r#"{"schema_version":1,"nodes":[{"inputs":{"image":[{"assetId":"workflow-input"}]}}],"run":null}"#],
        ).unwrap();
        let impact = db.project_exclusive_impact(&paths, "p").unwrap();
        assert_eq!(impact.exclusive_asset_count, 0);
        assert_eq!(impact.preserved_shared_count, 1);
        delete(&db, &paths).unwrap();
        assert!(file.exists());
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
        assert_eq!(impact.exclusive_asset_ids, vec!["only".to_string()]);
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

    #[test]
    fn shared_transfer_cleanup_recovers_without_removing_the_new_copy() {
        let (db,mut paths)=fixture();
        let files=std::sync::Arc::new(super::super::file_workspace::FileWorkspace::open(paths.root.join("file-workspace.json"),paths.root.join("BowerbirdLibrary")).unwrap());
        let source=files.project_directory("p","project").unwrap().join("shared.png");fs::write(&source,b"shared original").unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,store_path) VALUES('shared','shared',?1)",[source.to_string_lossy()]).unwrap();
        for project in ["p","other"] {db.add_assets_to_project(project,&["shared".into()]).unwrap();}
        paths.files=Some(files.clone());FAIL_UNLINK.set(true);
        let result=db.delete_project_keep_managed(&paths,"p").unwrap();FAIL_UNLINK.set(false);
        assert_eq!(result.moved_assets,1);assert!(!result.cleanup_pending.is_empty());assert!(!source.exists());
        let target=PathBuf::from(db.get_asset("shared").unwrap().unwrap().store_path.unwrap());
        assert!(target.starts_with(&files.snapshot().projects["other"]));assert_eq!(fs::read(&target).unwrap(),b"shared original");
        db.recover_project_deletions(&paths).unwrap();assert!(target.exists());
        assert_eq!(fs::read_dir(paths.root.join(".project-deletions")).unwrap().count(),0);
    }
}
