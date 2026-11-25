use super::*;
use rusqlite::{params, OptionalExtension};

pub(super) fn cached(
    db: &Database,
    asset: &str,
    hash: &str,
    shot: &str,
) -> AppResult<Option<(String, [String; 3])>> {
    let row:Option<(String,String)> = db.conn.lock().unwrap().query_row(
        "SELECT task_key,result FROM video_shot_receipts WHERE asset_id=? AND source_hash=? AND shot_id=?",
        params![asset,hash,shot], |r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(key, json)| Ok((key, serde_json::from_str(&json)?)))
        .transpose()
}

pub(super) fn remember(
    db: &Database,
    asset: &str,
    hash: &str,
    shot: &str,
    key: &str,
    texts: &[String; 3],
) -> AppResult<()> {
    db.conn.lock().unwrap().execute("INSERT INTO video_shot_receipts(asset_id,source_hash,shot_id,task_key,result) VALUES(?,?,?,?,?)
        ON CONFLICT(asset_id,source_hash,shot_id) DO UPDATE SET task_key=excluded.task_key,result=excluded.result",
        params![asset,hash,shot,key,serde_json::to_string(texts)?])?;
    Ok(())
}

pub(super) fn create(db: &Database, asset: &str, q: &Queue) -> AppResult<()> {
    use crate::commands::video_asset_revision::{source, SourceUsage};
    let path = source(db, asset, SourceUsage::VideoAnalysis)?;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let plan = super::super::plan_in(&tx, asset, &path, &q.quote.source_hash)?;
    if plan.revision != q.quote.plan_revision {
        return Err(err("镜头已变化，请重新确认报价"));
    }
    let changed=tx.execute("INSERT INTO video_shot_queues(asset_id,source_hash,batch_id,status,payload) VALUES(?,?,?,'running',?)
        ON CONFLICT(asset_id,source_hash) DO UPDATE SET batch_id=excluded.batch_id,status='running',stopping=0,payload=excluded.payload
        WHERE video_shot_queues.status IN ('completed','stopped','failed')",params![asset,q.quote.source_hash,q.id,serde_json::to_string(q)?])?;
    if changed != 1 {
        return Err(err("此素材有待恢复的镜头任务"));
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn load(db: &Database, asset: &str, hash: &str) -> AppResult<Option<(Queue, bool)>> {
    let row: Option<(String, bool)> = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT payload,stopping FROM video_shot_queues WHERE asset_id=? AND source_hash=?",
            params![asset, hash],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(raw, stopping)| Ok((serde_json::from_str(&raw)?, stopping)))
        .transpose()
}

pub(super) fn save(db: &Database, asset: &str, q: &Queue) -> AppResult<()> {
    let changed=db.conn.lock().unwrap().execute("UPDATE video_shot_queues SET status=?,payload=? WHERE asset_id=? AND source_hash=? AND batch_id=?",
        params![q.status,serde_json::to_string(q)?,asset,q.quote.source_hash,q.id])?;
    if changed != 1 {
        return Err(err("镜头队列已变化"));
    }
    Ok(())
}

pub(super) fn stop(db: &Database, asset: &str, hash: &str) -> AppResult<()> {
    db.conn.lock().unwrap().execute("UPDATE video_shot_queues SET stopping=1 WHERE asset_id=? AND source_hash=? AND status IN ('running','interrupted')",params![asset,hash])?;
    Ok(())
}
