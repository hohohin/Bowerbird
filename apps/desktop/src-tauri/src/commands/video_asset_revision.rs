use crate::{
    core::{external_files::{fingerprint, preview_key}, library::Analysis},
    db::Database,
    error::{AppError, AppResult},
    media::{audio, probe},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileStamp {
    size: u64,
    modified_nanos: String,
}

impl FileStamp {
    pub(super) fn read(path: &Path) -> AppResult<Self> {
        let metadata = fs::metadata(path)?;
        let modified = metadata
            .modified()?
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or_else(
                |before| format!("-{}", before.duration().as_nanos()),
                |after| after.as_nanos().to_string(),
            );
        Ok(Self {
            size: metadata.len(),
            modified_nanos: modified,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Registration {
    asset_size: Option<i64>,
    asset_modified: Option<i64>,
    indexed_hash: Option<String>,
}

impl Registration {
    pub(super) fn matches(&self, current: &Self, source_hash: &str) -> bool {
        current.asset_size == self.asset_size
            && current.asset_modified == self.asset_modified
            && (current.indexed_hash == self.indexed_hash
                || current.indexed_hash.as_deref() == Some(source_hash))
    }
}

fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}

pub(super) fn registration(db: &Database, asset_id: &str) -> AppResult<Registration> {
    read_registration(&db.conn.lock().unwrap(), asset_id)
}

pub(super) fn read_registration(conn: &rusqlite::Connection, asset_id: &str) -> AppResult<Registration> {
    conn.query_row(
        "SELECT a.size,a.file_mtime,COALESCE(e.fingerprint,f.sha256) FROM assets a \
         LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id \
         WHERE a.id=?1 AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals WHERE asset_id=a.id) \
         AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals WHERE asset_id=a.id)",
        [asset_id], |row| Ok(Registration { asset_size: row.get(0)?, asset_modified: row.get(1)?, indexed_hash: row.get(2)? }),
    ).optional()?.ok_or_else(|| invalid("原件已移除，请刷新素材库后重试"))
}

#[derive(Clone, Copy)]
pub(super) enum SourceUsage {
    VideoAnalysis,
    Transcript,
}

pub(super) fn source(db: &Database, asset_id: &str, usage: SourceUsage) -> AppResult<PathBuf> {
    let asset = db
        .get_asset(asset_id)?
        .ok_or_else(|| invalid("素材已不存在，请刷新素材库"))?;
    let ext = asset.ext.as_deref().unwrap_or_default();
    if !probe::is_video(ext) && !(matches!(usage, SourceUsage::Transcript) && audio::is_audio(ext)) {
        return Err(invalid(match usage {
            SourceUsage::VideoAnalysis => "请选择视频素材查看画面描述",
            SourceUsage::Transcript => "请选择音频或视频素材进行转录",
        }));
    }
    db.resolve_asset_original(asset_id)
}

pub(super) fn snapshot_source(
    db: &Database,
    asset_id: &str,
    usage: SourceUsage,
) -> AppResult<(PathBuf, String, FileStamp)> {
    let path = source(db, asset_id, usage)?;
    let before = FileStamp::read(&path)?;
    let canonical = crate::core::folder_connections::registered_path_spelling(&path);
    let key = preview_key(&canonical, &fs::metadata(&path)?)?;
    let hash = fingerprint(&path)?;
    if FileStamp::read(&path)? != before || preview_key(&canonical, &fs::metadata(&path)?)? != key {
        return Err(invalid("读取期间原件已变化，请重试"));
    }
    db.register_connected_fingerprint(asset_id, &path, &key, &hash)?;
    Ok((path, hash, before))
}

pub(super) struct RevisionGuard<'a> {
    pub path: &'a Path,
    pub stamp: &'a FileStamp,
    pub registration: &'a Registration,
    pub source_hash: &'a str,
}

pub(super) fn save_revision(
    db: &Database,
    row: &Analysis,
    select_revision: bool,
    guard: Option<RevisionGuard<'_>>,
) -> AppResult<()> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    if let Some(guard) = guard {
        // Overwrite trimming uses this database lock across the file replacement.
        if FileStamp::read(guard.path).as_ref().ok() != Some(guard.stamp)
            || !guard.registration.matches(&read_registration(&tx, &row.asset_id)?, guard.source_hash)
        {
            return Err(invalid("原件已变化，请重新核对后再转录"));
        }
    }
    if select_revision {
        tx.execute("UPDATE analyses SET payload=json_set(payload,'$.current',json('false')) \
            WHERE asset_id=?1 AND kind=?2 AND id<>?3 AND json_valid(payload) AND json_extract(payload,'$.current')=1",
            params![row.asset_id, row.kind, row.id])?;
    }
    // A task may finish after a different revision was selected or a trim cleared it.
    let updated = tx.execute(
        "INSERT INTO analyses(id,asset_id,kind,payload,provider,created_at) \
         VALUES(?1,?2,?3,?4,?5,strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET payload=CASE WHEN NOT ?6 \
             AND (CASE WHEN json_valid(analyses.payload) THEN json_extract(analyses.payload,'$.current')=0 END) \
             THEN json_set(excluded.payload,'$.current',json('false')) ELSE excluded.payload END, \
             provider=excluded.provider \
         WHERE analyses.asset_id=excluded.asset_id AND analyses.kind=excluded.kind",
        params![row.id, row.asset_id, row.kind, row.payload, row.provider, select_revision],
    )?;
    if updated != 1 {
        return Err(invalid("分析结果与当前素材版本不匹配"));
    }
    tx.commit()?;
    Ok(())
}
