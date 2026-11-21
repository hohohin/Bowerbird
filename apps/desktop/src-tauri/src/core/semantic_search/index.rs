use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use crate::{
    core::material_catalog::{catalog_visibility, IMAGE},
    core::settings::SettingsState,
    db::Database,
    error::{AppError, AppResult},
};

use super::{
    embedding::{Embedding, DIMENSIONS},
    model,
    schedule::{self, Schedule},
    scope::Policy,
    source::{self, Failure},
};

pub(crate) const INDEXABLE_FORMAT: &str = "lower(COALESCE(a.ext,'')) IN ('jpg','jpeg','png','webp','heic','heif') AND a.store_path IS NOT NULL";
const EXTERNAL_HASH: &str =
    "NULLIF((SELECT fingerprint FROM external_assets e WHERE e.asset_id=a.id),'')";
const SOURCE_HASH: &str = "COALESCE(NULLIF((SELECT fingerprint FROM external_assets e WHERE e.asset_id=a.id),''),(SELECT sha256 FROM creative_file_fingerprints f WHERE f.asset_id=a.id))";
pub(crate) const VECTOR_JOINS: &str = "LEFT JOIN semantic_jobs sj ON sj.asset_id=a.id AND sj.model_key=? LEFT JOIN semantic_vectors sv ON sv.asset_id=a.id AND sv.model_key=sj.model_key AND sv.content_sha256=sj.content_sha256";

pub(crate) fn valid_vector_condition() -> String {
    format!(
        "sv.dim={DIMENSIONS} AND ({EXTERNAL_HASH} IS NULL OR {EXTERNAL_HASH}=sv.content_sha256)"
    )
}

/// Native change events can detect same-size, same-mtime writes. Use their
/// canonical path variants to invalidate only that original and ask the next
/// regular connection scan to bypass its metadata-only shortcut.
pub(crate) fn note_original_changes(db: &Database, paths: &[PathBuf]) -> AppResult<bool> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let mut changed = false;
    for path in paths {
        let canonical = crate::core::folder_connections::registered_path_spelling(path);
        let [canonical, raw, normal] =
            crate::core::external_files::connection_path_spellings(path, &canonical);
        let count = tx.execute("UPDATE semantic_jobs SET status='pending',generation=generation+1,
            content_sha256=NULL,lease=NULL,lease_until=0,attempts=0,next_attempt=0,error_code=NULL,verify_registered=1
            WHERE model_key=(SELECT model_key FROM semantic_index_state WHERE run_state<>'off')
              AND asset_id IN (SELECT id FROM assets WHERE store_path IN (?1,?2,?3))",
            params![canonical,raw,normal])?;
        changed |= count > 0;
    }
    if changed {
        tx.execute(
            "UPDATE semantic_index_state SET revision=revision+1 WHERE id=1",
            [],
        )?;
    }
    tx.commit()?;
    Ok(changed)
}

/// Explicit refresh also verifies originals whose filesystem notices were lost.
/// It preserves their current vectors unless the scan confirms changed bytes.
pub(crate) fn request_connection_verification(
    db: &Database,
    folder: Option<&str>,
) -> AppResult<()> {
    db.conn.lock().unwrap().execute(
        "UPDATE semantic_jobs SET verify_registered=1,generation=generation+1
        WHERE model_key=(SELECT model_key FROM semantic_index_state WHERE run_state<>'off')
          AND asset_id IN (WITH RECURSIVE scope(id) AS (
             SELECT id FROM connected_folders WHERE ?1 IS NULL OR id=?1
             UNION SELECT f.id FROM connected_folders f JOIN scope s ON f.parent_id=s.id
          ) SELECT e.asset_id FROM connected_entries e JOIN scope s ON s.id=e.folder_id)",
        [folder],
    )?;
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexState {
    pub library_id: String,
    pub active_model_key: Option<String>,
    pub index_state: String,
    pub operation_id: Option<String>,
    pub index_revision: i64,
    pub backfill_complete: bool,
    pub eligible: i64,
    pub indexed: i64,
    pub auditing: i64,
    pub pending: i64,
    pub unavailable: i64,
    pub unsupported: i64,
    pub failed: i64,
    pub last_error: Option<String>,
}

pub(crate) fn library_id(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row(
        "SELECT id FROM library_identity WHERE singleton=1",
        [],
        |r| r.get(0),
    )
}

pub(crate) fn status(db: &Database) -> AppResult<IndexState> {
    status_with_schedule(db).map(|(index, _)| index)
}

pub(super) fn status_with_schedule(db: &Database) -> AppResult<(IndexState, Schedule)> {
    let conn = db.conn.lock().unwrap();
    let tx = conn.unchecked_transaction()?;
    let mut summary = IndexState {
        library_id: library_id(&tx)?,
        active_model_key: None,
        index_state: "off".into(),
        operation_id: None,
        index_revision: 0,
        backfill_complete: false,
        eligible: 0,
        indexed: 0,
        auditing: 0,
        pending: 0,
        unavailable: 0,
        unsupported: 0,
        failed: 0,
        last_error: None,
    };
    if let Some((model, state, operation, revision, complete)) = tx.query_row(
        "SELECT model_key,run_state,operation_id,revision,backfill_complete FROM semantic_index_state WHERE id=1",
        [], |r| Ok((r.get(0)?,r.get::<_, String>(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    ).optional()? {
        summary.active_model_key = if state == "off" { None } else { Some(model) };
        summary.index_state = state;
        summary.operation_id = Some(operation);
        summary.index_revision = revision;
        summary.backfill_complete = complete;
    }
    if let Some(model_key) = &summary.active_model_key {
        let valid = valid_vector_condition();
        let scope = Policy::read(&tx)?;
        let provenance = scope.provenance(&tx, false)?;
        let visible = index_visibility();
        let condition = scope.condition();
        tx.query_row(
            &format!(
                "WITH {provenance}, states AS MATERIALIZED (
                SELECT CASE
                    WHEN NOT ({INDEXABLE_FORMAT}) OR sj.status='unsupported' THEN 'unsupported'
                    WHEN {valid} THEN 'indexed'
                    WHEN sj.status IN ('unavailable','failed') THEN sj.status
                    ELSE 'pending' END AS state,
                    sj.status AS job_state,sj.error_code
                FROM assets a {VECTOR_JOINS} WHERE {IMAGE} AND {visible} AND {condition}
             ) SELECT COUNT(CASE WHEN state<>'unsupported' THEN 1 END),
                COUNT(CASE WHEN state='indexed' THEN 1 END),
                COUNT(CASE WHEN state='indexed' AND job_state IN ('pending','running') THEN 1 END),
                COUNT(CASE WHEN state='pending' THEN 1 END),
                COUNT(CASE WHEN state='unavailable' THEN 1 END),
                COUNT(CASE WHEN state='unsupported' THEN 1 END),
                COUNT(CASE WHEN state='failed' THEN 1 END),
                MAX(CASE WHEN state<>'indexed' THEN error_code END)
             FROM states"
            ),
            [model_key],
            |r| {
                summary.eligible = r.get(0)?;
                summary.indexed = r.get(1)?;
                summary.auditing = r.get(2)?;
                summary.pending = r.get(3)?;
                summary.unavailable = r.get(4)?;
                summary.unsupported = r.get(5)?;
                summary.failed = r.get(6)?;
                summary.last_error = r.get(7)?;
                Ok(())
            },
        )?;
    }
    let schedule = Schedule::read(&tx)?;
    tx.commit()?;
    Ok((summary, schedule))
}

/// Index tasks are derived from a fixed database handle. An app restart can never
/// resume a previous process's claim, while already committed vectors remain valid.
pub(crate) fn recover(db: &Database) -> AppResult<()> {
    revoke_leases(&db.conn.lock().unwrap())?;
    Ok(())
}

/// Repair reopens only the jobs previously charged for a model-wide failure.
/// The user's persisted running/paused choice is independent of model repair.
pub(crate) fn retry_model_failures(db: &Database) -> AppResult<()> {
    db.conn.lock().unwrap().execute(
        "UPDATE semantic_jobs SET status='pending',lease=NULL,lease_until=0,
        generation=generation+1,attempts=0,next_attempt=0,error_code=NULL
        WHERE model_key=?1 AND error_code='inference_failed'",
        [model::MODEL_ID],
    )?;
    Ok(())
}

pub(super) fn revoke_leases(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("UPDATE semantic_jobs SET status='pending',lease=NULL,lease_until=0,generation=generation+1 WHERE status='running'", [])?;
    Ok(())
}

struct Run {
    model_key: String,
    state: String,
    backfill_after: String,
    backfill_complete: bool,
    audit_after: String,
    next_audit: i64,
}

fn read_run(conn: &Connection) -> rusqlite::Result<Option<Run>> {
    conn.query_row(
        "SELECT model_key,run_state,backfill_after,backfill_complete,audit_after,next_audit
         FROM semantic_index_state WHERE id=1",
        [],
        |row| Ok(Run {
            model_key: row.get(0)?,
            state: row.get(1)?,
            backfill_after: row.get(2)?,
            backfill_complete: row.get(3)?,
            audit_after: row.get(4)?,
            next_audit: row.get(5)?,
        }),
    ).optional()
}

fn begin_round(tx: &Transaction<'_>, run: Option<&Run>, manual: bool, now: i64) -> AppResult<()> {
    let same_model = run.is_some_and(|run| run.model_key == model::MODEL_ID);
    let was_off = run.is_some_and(|run| run.state == "off");
    if was_off || !same_model {
        revoke_leases(tx)?;
    }
    if was_off && same_model {
        // Content can have changed while disabled. Keep vectors for verified SHA reuse.
        tx.execute("UPDATE semantic_jobs SET status='pending',content_sha256=NULL,attempts=0,next_attempt=0,error_code=NULL WHERE model_key=?1", [model::MODEL_ID])?;
    }
    tx.execute("INSERT INTO semantic_index_state(id,model_key,run_state,operation_id) VALUES(1,?1,'running',?2)
        ON CONFLICT(id) DO UPDATE SET run_state='running',operation_id=excluded.operation_id,
        backfill_after=CASE WHEN model_key<>excluded.model_key OR run_state='off' THEN '' ELSE backfill_after END,
        backfill_complete=CASE WHEN model_key<>excluded.model_key OR run_state='off' THEN 0 ELSE backfill_complete END,
        model_key=excluded.model_key", params![model::MODEL_ID, ulid::Ulid::new().to_string()])?;
    let audit = same_model && !was_off && run.is_some_and(|run| run.backfill_complete);
    schedule::begin(tx, manual, audit, now)?;
    Ok(())
}

pub(crate) fn control(db: &Database, action: &str) -> AppResult<IndexState> {
    control_at(db, action, chrono::Utc::now().timestamp())
}

fn control_at(db: &Database, action: &str, now: i64) -> AppResult<IndexState> {
    {
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let run = read_run(&tx)?;
        let run_state = run.as_ref().map(|run| run.state.as_str()).unwrap_or("off");
        let round = Schedule::read(&tx)?;
        let operation = ulid::Ulid::new().to_string();
        match action {
            "start" | "update" | "resume" if run_state != "paused" || action == "resume" => {
                if round.active() && run_state == "running" {
                    schedule::keep_manual(&tx)?;
                } else {
                    begin_round(&tx, run.as_ref(), true, now)?;
                }
            }
            "pause" | "cancel" if run_state == "running" => {
                revoke_leases(&tx)?;
                tx.execute(
                    "UPDATE semantic_index_state SET run_state='paused',operation_id=?1 WHERE id=1",
                    [&operation],
                )?;
                schedule::stop(&tx)?;
            }
            "disable" if run_state != "off" || run.is_none() => {
                revoke_leases(&tx)?;
                tx.execute("INSERT INTO semantic_index_state(id,model_key,run_state,operation_id) VALUES(1,?1,'off',?2)
                    ON CONFLICT(id) DO UPDATE SET run_state='off',revision=revision+1,operation_id=excluded.operation_id",
                    params![model::MODEL_ID, operation])?;
                schedule::stop(&tx)?;
            }
            "rebuild" if run_state == "running" => {
                revoke_leases(&tx)?;
                let policy = Policy::read(&tx)?;
                let provenance = policy.provenance(&tx, false)?;
                let condition = policy.condition();
                for table in ["semantic_vectors", "semantic_jobs"] {
                    tx.execute(&format!("WITH {provenance} DELETE FROM {table} WHERE model_key=?1
                        AND asset_id IN (SELECT a.id FROM assets a WHERE {condition})"), [model::MODEL_ID])?;
                }
                tx.execute("UPDATE semantic_index_state SET run_state='running',model_key=?1,operation_id=?2,
                    revision=revision+1,backfill_after='',backfill_complete=0,audit_after='',next_audit=0 WHERE id=1",
                    params![model::MODEL_ID, operation])?;
                schedule::begin(&tx, true, false, now)?;
            }
            "start" | "update" | "pause" | "cancel" | "disable" | "rebuild" => {}
            _ => return Err(AppError::Other("未知的语义索引操作".into())),
        }
        tx.commit()?;
    }
    status(db)
}

fn index_visibility() -> String {
    format!("({} OR (a.library_hidden=0 AND {} AND EXISTS(SELECT 1 FROM project_assets pa WHERE pa.asset_id=a.id)))",
        catalog_visibility(false), catalog_visibility(true))
}

struct Claim {
    id: String,
    library_id: String,
    generation: i64,
    policy_revision: i64,
    lease: String,
    path: String,
    registered_hash: Option<String>,
    external_hash: Option<String>,
    content_hash: Option<String>,
    attempts: i64,
    round_started_at: i64,
}

fn scan_ids(tx: &Transaction<'_>, scope: Option<&Policy>, after: &str, limit: i64) -> AppResult<Vec<String>> {
    let (prefix, condition) = match scope.filter(|scope| !scope.include_generated) {
        Some(scope) => (format!("WITH {}", scope.provenance(tx, false)?), scope.condition()),
        None => (String::new(), "1".into()),
    };
    let visible = index_visibility();
    let mut query = tx.prepare_cached(&format!(
        "{prefix} SELECT a.id FROM assets a WHERE a.id>?1 AND {INDEXABLE_FORMAT}
        AND {visible} AND {condition} ORDER BY a.id LIMIT ?2"
    ))?;
    let ids = query
        .query_map(params![after, limit], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

fn backfill(tx: &Transaction<'_>, after: &str) -> AppResult<()> {
    // Register original identities once; only eligibility for actual work changes with scope.
    let ids = scan_ids(tx, None, after, 128)?;
    for id in &ids {
        tx.execute(
            "INSERT OR IGNORE INTO semantic_jobs(asset_id, model_key) VALUES(?1,?2)",
            params![id, model::MODEL_ID],
        )?;
    }
    tx.execute(
        "UPDATE semantic_index_state SET backfill_after=?1,backfill_complete=?2 WHERE id=1",
        params![ids.last().map_or(after, String::as_str), ids.len() < 128],
    )?;
    Ok(())
}

// Low-priority bounded recheck protects against missed native notifications and
// external edits that preserve file size and mtime. It retains ready rows while
// reading and withdraws them immediately if the observed content differs.
fn schedule_audit(tx: &Transaction<'_>, scope: &Policy, after: &str, now: i64) -> AppResult<()> {
    const AUDIT_BATCH: i64 = 32;
    let ids = scan_ids(tx, Some(scope), after, AUDIT_BATCH)?;
    for id in &ids {
        tx.execute("INSERT INTO semantic_jobs(asset_id, model_key) VALUES(?1,?2)
            ON CONFLICT(asset_id,model_key) DO UPDATE SET status='pending',next_attempt=0,attempts=0 WHERE status='ready'",
            params![id, model::MODEL_ID])?;
    }
    let (next, delay) = if ids.len() == AUDIT_BATCH as usize {
        (ids.last().unwrap().as_str(), 0)
    } else {
        ("", 300)
    };
    tx.execute(
        "UPDATE semantic_index_state SET audit_after=?1,next_audit=?2 WHERE id=1",
        params![next, now + delay],
    )?;
    tx.execute("UPDATE semantic_index_preferences SET audit_pending=0 WHERE id=1", [])?;
    Ok(())
}

fn due(tx: &Transaction<'_>, scope: &Policy, now: i64, round_started_at: i64) -> AppResult<Option<Claim>> {
    let lease = ulid::Ulid::new().to_string();
    let library_id = library_id(tx)?;
    let provenance = scope.provenance(tx, false)?;
    let visible = index_visibility();
    let condition = scope.condition();
    let mut stmt = tx.prepare_cached(&format!("WITH {provenance}
        SELECT a.id,a.store_path,{SOURCE_HASH},j.content_sha256,j.generation,j.attempts,{EXTERNAL_HASH}
        FROM semantic_jobs j JOIN assets a ON a.id=j.asset_id
        WHERE j.model_key=?1 AND j.status IN ('pending','unavailable') AND j.next_attempt<=?2
        AND {INDEXABLE_FORMAT} AND {visible} AND {condition} ORDER BY j.next_attempt,a.id LIMIT 1"))?;
    let claim = stmt.query_row(
        params![model::MODEL_ID, now.min(round_started_at)], |r| Ok(Claim {
            id:r.get(0)?, path:r.get(1)?, registered_hash:r.get(2)?, content_hash:r.get(3)?,
            generation:r.get(4)?, policy_revision:scope.revision,
            attempts:r.get(5)?, external_hash:r.get(6)?, library_id, lease, round_started_at,
        }),
    ).optional()?;
    if let Some(claim) = &claim {
        tx.execute("UPDATE semantic_jobs SET status='running',lease=?3,lease_until=?4 WHERE asset_id=?1 AND model_key=?2",
            params![claim.id,model::MODEL_ID,claim.lease,now+120])?;
    }
    Ok(claim)
}

pub(super) enum WorkerWake {
    Continue,
    At(i64),
    Command,
}

#[cfg(test)]
fn take_work(db: &Database, now: i64) -> AppResult<(Option<Claim>, WorkerWake, bool)> {
    take_work_locked(&mut db.conn.lock().unwrap(), now)
}

fn take_work_locked(conn: &mut Connection, now: i64) -> AppResult<(Option<Claim>, WorkerWake, bool)> {
    let tx = conn.transaction()?;
    let run = read_run(&tx)?;
    if run.as_ref().is_some_and(|run| run.state != "running") {
        return Ok((None, WorkerWake::Command, false));
    }
    let schedule = Schedule::read(&tx)?;
    let Some(round_started_at) = schedule.round_started_at else {
        if !schedule.due(now) {
            let wake = if schedule.preferences.automatic {
                schedule.next_update_at.map_or(WorkerWake::Command, WorkerWake::At)
            } else {
                WorkerWake::Command
            };
            return Ok((None, wake, false));
        }
        begin_round(&tx, run.as_ref(), false, now)?;
        tx.commit()?;
        return Ok((None, WorkerWake::Continue, true));
    };
    let Some(run) = run else {
        return Ok((None, WorkerWake::Command, false));
    };
    if run.model_key != model::MODEL_ID {
        begin_round(&tx, Some(&run), !schedule.preferences.automatic, now)?;
        tx.commit()?;
        return Ok((None, WorkerWake::Continue, true));
    }
    let scope = Policy::read(&tx)?;
    // Use the persisted start for retry eligibility. Newly queued work has a
    // zero deadline; retries scheduled within a round wait for the next one.
    // This worker awaits each item before claiming another. A remaining lease
    // here belongs to a prior item whose result could not be recorded.
    tx.execute(
        "UPDATE semantic_jobs SET status='pending',lease=NULL,lease_until=0,generation=generation+1
        WHERE model_key=?1 AND status='running'",
        [model::MODEL_ID],
    )?;
    let mut work = due(&tx, &scope, now, round_started_at)?;
    if work.is_none() && !run.backfill_complete {
        backfill(&tx, &run.backfill_after)?;
        work = due(&tx, &scope, now, round_started_at)?;
        tx.commit()?;
        return Ok((work, WorkerWake::Continue, false));
    }
    if work.is_none() && schedule.audit_pending && run.next_audit <= now {
        schedule_audit(&tx, &scope, &run.audit_after, now)?;
        work = due(&tx, &scope, now, round_started_at)?;
    }
    if work.is_some() {
        tx.commit()?;
        return Ok((work, WorkerWake::Continue, false));
    }
    schedule::complete(&tx, now)?;
    tx.commit()?;
    let wake = if schedule.preferences.automatic {
        WorkerWake::At(now + i64::from(schedule.preferences.interval_minutes) * 60)
    } else {
        WorkerWake::Command
    };
    Ok((None, wake, true))
}

fn still_current(tx: &Transaction<'_>, claim: &Claim) -> AppResult<bool> {
    let scope = Policy::read(tx)?;
    if scope.revision != claim.policy_revision {
        return Ok(false);
    }
    let provenance = scope.provenance(tx, false)?;
    let visible = index_visibility();
    let condition = scope.condition();
    let mut stmt = tx.prepare_cached(&format!("WITH {provenance}
        SELECT EXISTS(SELECT 1 FROM assets a JOIN semantic_jobs j ON j.asset_id=a.id
        JOIN semantic_index_state s ON s.model_key=j.model_key JOIN library_identity li ON li.singleton=1
        WHERE a.id=?1 AND j.model_key=?2 AND j.lease=?3 AND j.generation=?4 AND a.store_path=?5
        AND {SOURCE_HASH} IS ?6 AND li.id=?7 AND s.run_state='running' AND {INDEXABLE_FORMAT} AND {visible} AND {condition})"))?;
    Ok(stmt.query_row(
        params![claim.id,model::MODEL_ID,claim.lease,claim.generation,claim.path,claim.registered_hash,claim.library_id],
        |r| r.get(0))?)
}

fn owns_lease(conn: &Connection, claim: &Claim) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM semantic_jobs j, semantic_index_preferences p
         WHERE j.asset_id=?1 AND j.model_key=?2 AND j.lease=?3 AND j.generation=?4
           AND p.id=1 AND p.policy_revision=?5)",
        params![
            claim.id,
            model::MODEL_ID,
            claim.lease,
            claim.generation,
            claim.policy_revision,
        ],
        |row| row.get(0),
    )
}

fn withdraw_old_bytes(conn: &mut Connection, claim: &Claim, sha: &str) -> AppResult<Option<bool>> {
    let tx = conn.transaction()?;
    if !still_current(&tx, claim)? {
        return Ok(None);
    }
    let removed = tx.execute(
        "DELETE FROM semantic_vectors WHERE asset_id=?1 AND model_key=?2 AND content_sha256<>?3",
        params![claim.id, model::MODEL_ID, sha],
    )?;
    if removed > 0 {
        tx.execute(
            "UPDATE semantic_jobs SET content_sha256=NULL WHERE asset_id=?1 AND model_key=?2",
            params![claim.id, model::MODEL_ID],
        )?;
        tx.execute(
            "UPDATE semantic_index_state SET revision=revision+1 WHERE id=1",
            [],
        )?;
    }
    tx.commit()?;
    Ok(Some(removed > 0))
}

fn existing_vector(db: &Database, claim: &Claim, sha: &str) -> AppResult<Option<Embedding>> {
    let conn = db.conn.lock().unwrap();
    let blob: Option<Vec<u8>> = conn.query_row("SELECT vec_f32le FROM semantic_vectors WHERE asset_id=?1 AND model_key=?2 AND content_sha256=?3",
        params![claim.id,model::MODEL_ID,sha], |r| r.get(0)).optional()?;
    Ok(blob.as_deref().and_then(Embedding::from_bytes))
}

fn finish(
    conn: &mut Connection,
    claim: &Claim,
    result: Result<(String, Embedding), Failure>,
    now: i64,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    if !still_current(&tx, claim)? {
        tx.execute("UPDATE semantic_jobs SET status='pending',lease=NULL,lease_until=0,generation=generation+1 WHERE asset_id=?1 AND model_key=?2 AND lease=?3",
            params![claim.id,model::MODEL_ID,claim.lease])?;
    } else {
        match result {
            Ok((sha, vector)) => {
                let bytes = vector.to_bytes();
                let updated = tx.execute("INSERT INTO semantic_vectors(asset_id,model_key,content_sha256,dim,vec_f32le,updated_at) VALUES(?1,?2,?3,?4,?5,?6)
                    ON CONFLICT(asset_id,model_key) DO UPDATE SET content_sha256=excluded.content_sha256,vec_f32le=excluded.vec_f32le,updated_at=excluded.updated_at
                    WHERE content_sha256<>excluded.content_sha256 OR vec_f32le<>excluded.vec_f32le",
                    params![claim.id,model::MODEL_ID,sha,DIMENSIONS as i64,bytes,now])?;
                tx.execute("UPDATE semantic_jobs SET status='ready',content_sha256=?3,lease=NULL,lease_until=0,attempts=0,next_attempt=0,error_code=NULL,verify_registered=0 WHERE asset_id=?1 AND model_key=?2",
                    params![claim.id,model::MODEL_ID,sha])?;
                if updated > 0 || claim.content_hash.as_deref() != Some(sha.as_str()) {
                    tx.execute(
                        "UPDATE semantic_index_state SET revision=revision+1 WHERE id=1",
                        [],
                    )?;
                }
            }
            Err(Failure::Model | Failure::Interrupted) => {
                tx.execute("UPDATE semantic_jobs SET status='pending',lease=NULL,lease_until=0 WHERE asset_id=?1 AND model_key=?2",
                    params![claim.id,model::MODEL_ID])?;
            }
            Err(failure) => {
                let attempts = (claim.attempts + 1).min(16);
                let (status, delay, code) = match failure {
                    Failure::Unavailable => ("unavailable", 30, "source_unavailable"),
                    Failure::Changed => (
                        "pending",
                        if claim.external_hash.is_some() {
                            300
                        } else {
                            10
                        },
                        "source_changed",
                    ),
                    Failure::Unsupported => ("unsupported", 0, "unsupported_image"),
                    Failure::ResourceLimit => ("unsupported", 0, "resource_limit"),
                    Failure::Decode if attempts < 3 => ("pending", 10 * attempts, "decode_failed"),
                    Failure::Decode => ("failed", 0, "decode_failed"),
                    Failure::Model | Failure::Interrupted => unreachable!(),
                };
                let next_attempt = now.max(claim.round_started_at) + delay;
                tx.execute("UPDATE semantic_jobs SET status=?3,lease=NULL,lease_until=0,attempts=?4,next_attempt=?5,error_code=?6,
                    verify_registered=CASE WHEN ?7 AND ?8 THEN 1 ELSE verify_registered END,
                    content_sha256=CASE WHEN ?9 THEN content_sha256 ELSE NULL END WHERE asset_id=?1 AND model_key=?2",
                    params![claim.id,model::MODEL_ID,status,attempts,next_attempt,code,failure==Failure::Changed,
                        claim.external_hash.is_some(),failure==Failure::Unavailable])?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}

pub(crate) struct WorkerTick {
    pub progress: bool,
    pub invalidated: bool,
    pub model_failed: bool,
    pub(super) wake: WorkerWake,
    pub(super) round_changed: bool,
}

pub(crate) enum EncodeFailure {
    Model(String),
    Interrupted,
}

/// One bounded work item. Only this worker claims jobs. Read, hash, decode and
/// inference never run with the app's primary SQLite lock held.
pub(super) fn run_one_for_settings(
    db: &Database,
    settings: &SettingsState,
    encode: impl FnOnce(&image::DynamicImage) -> Result<Vec<f32>, EncodeFailure>,
) -> AppResult<WorkerTick> {
    run_one_guarded(db, Some(settings), || chrono::Utc::now().timestamp(), encode)
}

#[cfg(test)]
pub(crate) fn run_one(
    db: &Database,
    encode: impl FnOnce(&image::DynamicImage) -> Result<Vec<f32>, EncodeFailure>,
) -> AppResult<WorkerTick> {
    run_one_with_clock(db, || chrono::Utc::now().timestamp(), encode)
}

#[cfg(test)]
mod round_tests;

#[cfg(test)]
fn run_one_with_clock(
    db: &Database,
    now: impl Fn() -> i64,
    encode: impl FnOnce(&image::DynamicImage) -> Result<Vec<f32>, EncodeFailure>,
) -> AppResult<WorkerTick> {
    run_one_guarded(db, None, now, encode)
}

fn with_current_preferences<T>(
    db: &Database,
    settings: Option<&SettingsState>,
    apply: impl FnOnce(&mut Connection) -> AppResult<T>,
) -> AppResult<Option<T>> {
    let mut conn = db.conn.lock().unwrap();
    let Some(settings) = settings else {
        return apply(&mut conn).map(Some);
    };
    // Keep JSON settings stable through each short SQLite operation. The
    // settings writer releases its lock before trying to apply the DB mirror.
    settings.with_semantic_index_preferences(|current| {
        if Schedule::read(&conn)?.preferences != current {
            return Ok(None);
        }
        apply(&mut conn).map(Some)
    })
}

fn run_one_guarded(
    db: &Database,
    settings: Option<&SettingsState>,
    now: impl Fn() -> i64,
    encode: impl FnOnce(&image::DynamicImage) -> Result<Vec<f32>, EncodeFailure>,
) -> AppResult<WorkerTick> {
    let Some((claim, wake, round_changed)) = with_current_preferences(db, settings, |conn| {
        take_work_locked(conn, now())
    })? else {
        return Ok(WorkerTick {
            progress: false,
            invalidated: false,
            model_failed: false,
            wake: WorkerWake::At(now() + 5),
            round_changed: false,
        });
    };
    let Some(claim) = claim else {
        return Ok(WorkerTick {
            progress: round_changed || matches!(wake, WorkerWake::Continue),
            invalidated: false,
            model_failed: false,
            wake,
            round_changed,
        });
    };
    let path = Path::new(&claim.path);
    let mut invalidated = false;
    let result = match source::read(path) {
        Ok(bytes) => {
            let removed = with_current_preferences(db, settings, |conn| {
                withdraw_old_bytes(conn, &claim, &bytes.sha256)
            })?.flatten();
            invalidated = removed.unwrap_or(false);
            if removed.is_none() {
                Err(Failure::Changed)
            } else if claim
                .external_hash
                .as_ref()
                .is_some_and(|sha| sha != &bytes.sha256)
            {
                Err(Failure::Changed)
            } else {
                let existing = existing_vector(db, &claim, &bytes.sha256)?;
                let vector = match existing {
                    Some(vector) => Ok(vector),
                    None => match bytes.decode() {
                        Ok(image) if with_current_preferences(db, settings, |conn| {
                            Ok(owns_lease(conn, &claim)?)
                        })?.unwrap_or(false) => {
                            let values = encode(&image).map_err(|error| match error {
                                EncodeFailure::Model(error) => {
                                    tracing::warn!(%error, "local semantic image encoder is unavailable");
                                    Failure::Model
                                }
                                EncodeFailure::Interrupted => Failure::Interrupted,
                            });
                            values.and_then(|values| Embedding::normalize(values).ok_or(Failure::Model))
                        }
                        Ok(_) => Err(Failure::Interrupted),
                        Err(error) => Err(error),
                    },
                };
                vector.and_then(|vector| {
                    let current = source::digest_at_path(path)?;
                    if current == bytes.sha256 {
                        Ok((current, vector))
                    } else {
                        Err(Failure::Changed)
                    }
                })
            }
        }
        Err(error) => Err(error),
    };
    invalidated |= claim.content_hash.is_some()
        && matches!(&result, Err(failure)
        if !matches!(failure, Failure::Unavailable | Failure::Model | Failure::Interrupted));
    let model_failed = matches!(&result, Err(Failure::Model));
    let applied = with_current_preferences(db, settings, |conn| {
        finish(conn, &claim, result, now())
    })?.is_some();
    Ok(WorkerTick {
        progress: applied,
        invalidated,
        model_failed: applied && model_failed,
        wake: if applied { wake } else { WorkerWake::At(now() + 5) },
        round_changed,
    })
}
