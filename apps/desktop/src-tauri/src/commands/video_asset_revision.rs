use crate::{
    core::{external_files::{fingerprint, preview_key}, library::Analysis},
    db::Database,
    error::{AppError, AppResult},
    media::probe,
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
    db.conn.lock().unwrap().query_row(
        "SELECT a.size,a.file_mtime,COALESCE(e.fingerprint,f.sha256) FROM assets a \
         LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id \
         WHERE a.id=?1 AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals WHERE asset_id=a.id) \
         AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals WHERE asset_id=a.id)",
        [asset_id], |row| Ok(Registration { asset_size: row.get(0)?, asset_modified: row.get(1)?, indexed_hash: row.get(2)? }),
    ).optional()?.ok_or_else(|| invalid("视频原件已移除，请刷新素材库后重试"))
}

pub(super) fn source(db: &Database, asset_id: &str) -> AppResult<PathBuf> {
    let asset = db
        .get_asset(asset_id)?
        .ok_or_else(|| invalid("视频素材已不存在，请刷新素材库"))?;
    if !probe::is_video(asset.ext.as_deref().unwrap_or_default()) {
        return Err(invalid("请选择视频素材进行转录"));
    }
    db.resolve_asset_original(asset_id)
}

pub(super) fn snapshot_source(
    db: &Database,
    asset_id: &str,
) -> AppResult<(PathBuf, String, FileStamp)> {
    let path = source(db, asset_id)?;
    let before = FileStamp::read(&path)?;
    let canonical = crate::core::folder_connections::registered_path_spelling(&path);
    let key = preview_key(&canonical, &fs::metadata(&path)?)?;
    let hash = fingerprint(&path)?;
    if FileStamp::read(&path)? != before || preview_key(&canonical, &fs::metadata(&path)?)? != key {
        return Err(invalid("读取期间视频已变化，请重新转录"));
    }
    db.register_connected_fingerprint(asset_id, &path, &key, &hash)?;
    Ok((path, hash, before))
}

pub(super) fn save_revision(db: &Database, row: &Analysis, select_revision: bool) -> AppResult<()> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    if select_revision {
        tx.execute("UPDATE analyses SET payload=json_set(payload,'$.current',json('false')) \
            WHERE asset_id=?1 AND kind=?2 AND id<>?3 AND json_valid(payload) AND json_extract(payload,'$.current')=1",
            params![row.asset_id, row.kind, row.id])?;
    }
    let updated = tx.execute(
        "INSERT INTO analyses(id,asset_id,kind,payload,provider,created_at) \
         VALUES(?1,?2,?3,?4,?5,strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,provider=excluded.provider \
         WHERE analyses.asset_id=excluded.asset_id AND analyses.kind=excluded.kind",
        params![row.id, row.asset_id, row.kind, row.payload, row.provider],
    )?;
    if updated != 1 {
        return Err(invalid("视频结果与当前素材版本不匹配"));
    }
    tx.commit()?;
    Ok(())
}
