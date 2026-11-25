use super::video_analysis::jobs::source_version;
use super::video_asset_revision::{
    read_registration, registration, snapshot_source, source, FileStamp, Registration, SourceUsage,
};
use crate::{
    core::paths::LibraryPaths,
    db::Database,
    error::{AppError, AppResult},
    media::probe,
};
use model::{interval_id, intervals, Layout, Results, Texts};
pub use model::{Change, Cut, Kind, Plan};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;

pub(crate) mod jobs;
mod media;
mod model;
#[cfg(test)]
pub(super) mod tests;

fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}

#[derive(Deserialize, Serialize)]
struct Undo {
    layout: Layout,
    visible: BTreeSet<String>,
    threshold: f64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    current: bool,
    source_hash: String,
    version: String,
    stamp: FileStamp,
    registration: Registration,
    duration_ms: i64,
    revision: i64,
    threshold: f64,
    layout: Layout,
    undo: Option<Undo>,
}

fn stored(conn: &Connection, asset: &str) -> AppResult<Option<(String, Header)>> {
    let row: Option<(String,String)> = conn.query_row(
        "SELECT id,payload FROM analyses WHERE asset_id=?1 AND kind='video_shots' AND json_extract(payload,'$.current')=1",
        [asset], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(id, payload)| Ok((id, serde_json::from_str(&payload)?)))
        .transpose()
}
fn verify(header: &Header, conn: &Connection, asset: &str, path: &Path) -> AppResult<()> {
    if FileStamp::read(path)? != header.stamp
        || source_version(path)? != header.version
        || !header
            .registration
            .matches(&read_registration(conn, asset)?, &header.source_hash)
    {
        return Err(invalid("原件已变化，请重新打开复刻"));
    }
    Ok(())
}
fn read_texts(conn: &Connection, plan_id: &str) -> AppResult<Results> {
    let mut statement = conn.prepare(
        "SELECT interval_id,texts FROM video_shot_results WHERE plan_id=?1 AND visible=1",
    )?;
    let mut out = Results::new();
    for row in statement.query_map([plan_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (key, texts) = row?;
        out.insert(key, serde_json::from_str(&texts)?);
    }
    Ok(out)
}
fn to_plan(conn: &Connection, id: &str, h: Header) -> AppResult<Plan> {
    Ok(Plan {
        source_hash: h.source_hash,
        duration_ms: h.duration_ms,
        revision: h.revision,
        cuts: h.layout.cuts,
        selected: h.layout.selected,
        results: read_texts(conn, id)?,
        threshold: h.threshold,
        can_undo: h.undo.is_some(),
        undo_cuts: h.undo.map(|u| u.layout.cuts),
    })
}
fn matching(
    conn: &Connection,
    asset: &str,
    path: &Path,
    hash: &str,
) -> AppResult<(String, Header)> {
    let (id, h) = stored(conn, asset)?.ok_or_else(|| invalid("请重新打开复刻"))?;
    verify(&h, conn, asset, path)?;
    if h.source_hash != hash {
        return Err(invalid("原件版本已变化，请重新打开复刻"));
    }
    Ok((id, h))
}
pub(super) fn plan_in(conn: &Connection, asset: &str, path: &Path, hash: &str) -> AppResult<Plan> {
    let (id, h) = matching(conn, asset, path, hash)?;
    to_plan(conn, &id, h)
}
pub(super) fn current_plan(db: &Database, asset: &str, hash: &str) -> AppResult<(PathBuf, Plan)> {
    let path = source(db, asset, SourceUsage::VideoAnalysis)?;
    let conn = db.conn.lock().unwrap();
    let plan = plan_in(&conn, asset, &path, hash)?;
    Ok((path, plan))
}
pub(super) fn checked_plan(db: &Database, asset: &str, hash: &str) -> AppResult<(PathBuf, Plan)> {
    let (path, actual, _) = snapshot_source(db, asset, SourceUsage::VideoAnalysis)?;
    if actual != hash {
        return Err(invalid("原件已变化，请重新打开复刻"));
    }
    let conn = db.conn.lock().unwrap();
    let (id, h) = matching(&conn, asset, &path, hash)?;
    Ok((path, to_plan(&conn, &id, h)?))
}
fn get(db: &Database, asset: &str) -> AppResult<Plan> {
    let path = source(db, asset, SourceUsage::VideoAnalysis)?;
    {
        let conn = db.conn.lock().unwrap();
        if let Some((id, h)) = stored(&conn, asset)? {
            if verify(&h, &conn, asset, &path).is_ok() {
                return to_plan(&conn, &id, h);
            }
        }
    }
    let before = source_version(&path)?;
    let (path, hash, stamp) = snapshot_source(db, asset, SourceUsage::VideoAnalysis)?;
    let reg = registration(db, asset)?;
    let duration = probe::probe(&path)?.duration;
    if !duration.is_finite() || duration <= 0.0 || duration * 1000.0 >= i64::MAX as f64 {
        return Err(invalid("无法读取有效视频时长"));
    }
    let duration_ms = (duration * 1000.0).round() as i64;
    if duration_ms < 1 {
        return Err(invalid("视频时长过短"));
    }
    // Avoid decoding a feature-length video just to open the workspace. Detection is explicit.
    let cuts = model::with_long_segments(Vec::new(), duration_ms);
    let selected = intervals(&cuts, duration_ms)
        .take(1)
        .map(|(s, e)| interval_id(s, e))
        .collect();
    let mut h = Header {
        current: true,
        source_hash: hash,
        version: before,
        stamp,
        registration: reg,
        duration_ms,
        revision: 1,
        threshold: 0.35,
        layout: Layout {
            cuts,
            selected,
            ..Default::default()
        },
        undo: None,
    };
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    verify(&h, &tx, asset, &path)?;
    if let Some((id, prior)) = stored(&tx, asset)? {
        if verify(&prior, &tx, asset, &path).is_ok() {
            return to_plan(&tx, &id, prior);
        }
        h.revision = prior.revision + 1;
        tx.execute(
            "UPDATE analyses SET payload=json_set(payload,'$.current',json('false')) WHERE id=?1",
            [id],
        )?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'video_shots',?3,strftime('%s','now'))",
        params![id,asset,serde_json::to_string(&h)?])?;
    let plan = to_plan(&tx, &id, h)?;
    tx.commit()?;
    Ok(plan)
}
fn save_header(conn: &Connection, id: &str, h: &mut Header) -> AppResult<()> {
    h.revision += 1;
    conn.execute(
        "UPDATE analyses SET payload=?2 WHERE id=?1",
        params![id, serde_json::to_string(h)?],
    )?;
    Ok(())
}
fn change_cuts(
    conn: &Connection,
    id: &str,
    h: &mut Header,
    cuts: Vec<Cut>,
    confirmed: Vec<String>,
    suppressed_at: Option<i64>,
    threshold: Option<f64>,
    undo: bool,
) -> AppResult<()> {
    model::validate(&cuts, h.duration_ms)?;
    if let Some(value) = threshold {
        model::valid_threshold(value)?;
    }
    let before: BTreeSet<_> = intervals(&h.layout.cuts, h.duration_ms)
        .map(|(s, e)| interval_id(s, e))
        .collect();
    let after: BTreeSet<_> = intervals(&cuts, h.duration_ms)
        .map(|(s, e)| interval_id(s, e))
        .collect();
    let visible: BTreeSet<_> = read_texts(conn, id)?.into_keys().collect();
    let removed: BTreeSet<_> = visible.difference(&after).cloned().collect();
    if removed != confirmed.into_iter().collect() {
        return Err(invalid("受影响的镜头已变化，请重新确认清除范围"));
    }
    if h.layout.cuts == cuts && !undo {
        if let Some(value) = threshold {
            h.threshold = value;
        }
        return Ok(());
    }
    for shot in &removed {
        conn.execute(
            "UPDATE video_shot_results SET visible=0 WHERE plan_id=?1 AND interval_id=?2",
            params![id, shot],
        )?;
    }
    let current = h.layout.clone();
    h.layout.cuts = cuts;
    h.layout.selected.retain(|x| after.contains(x));
    if undo {
        let previous = h
            .undo
            .take()
            .ok_or_else(|| invalid("没有可撤销的切点改动"))?;
        h.layout.suppressed = previous.layout.suppressed;
        h.threshold = previous.threshold;
        for shot in previous.layout.selected {
            if !before.contains(&shot) && after.contains(&shot) {
                h.layout.selected.push(shot);
            }
        }
        for shot in previous.visible {
            if !before.contains(&shot) && after.contains(&shot) {
                conn.execute(
                    "UPDATE video_shot_results SET visible=1 WHERE plan_id=?1 AND interval_id=?2",
                    params![id, shot],
                )?;
            }
        }
    } else {
        if let Some(at) = suppressed_at {
            if !current.cuts.iter().any(|c| c.at == at) || h.layout.cuts.iter().any(|c| c.at == at)
            {
                return Err(invalid("被移除的切点已变化"));
            }
            h.layout.suppressed.insert(at);
        }
        h.undo = Some(Undo {
            layout: current,
            visible,
            threshold: h.threshold,
        });
        if let Some(value) = threshold {
            h.threshold = value;
        }
    }
    Ok(())
}
fn update(
    db: &Database,
    asset: &str,
    hash: &str,
    revision: i64,
    change: Change,
) -> AppResult<Plan> {
    let path = source(db, asset, SourceUsage::VideoAnalysis)?;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let (id, mut h) = matching(&tx, asset, &path, hash)?;
    if h.revision != revision {
        return Err(invalid("分镜已更新，请刷新后重试"));
    }
    let busy:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM video_shot_queues WHERE asset_id=?1 AND source_hash=?2 AND status IN ('running','interrupted'))",
        params![asset,hash],|r|r.get(0))?;
    if busy && !matches!(change, Change::Select { .. }) {
        return Err(invalid("请先完成或恢复进行中的分镜分析"));
    }
    match change {
        Change::Cuts {
            cuts,
            threshold,
            confirmed,
            suppressed_at,
        } => change_cuts(
            &tx,
            &id,
            &mut h,
            cuts,
            confirmed,
            suppressed_at,
            threshold,
            false,
        )?,
        Change::Undo { confirmed } => {
            let previous = h
                .undo
                .as_ref()
                .ok_or_else(|| invalid("没有可撤销的切点改动"))?
                .layout
                .cuts
                .clone();
            change_cuts(&tx, &id, &mut h, previous, confirmed, None, None, true)?;
        }
        Change::Select { selected } => {
            let allowed: BTreeSet<_> = intervals(&h.layout.cuts, h.duration_ms)
                .map(|(s, e)| interval_id(s, e))
                .collect();
            if selected.iter().any(|s| !allowed.contains(s))
                || selected.iter().collect::<BTreeSet<_>>().len() != selected.len()
            {
                return Err(invalid("请重新选择有效镜头"));
            }
            h.layout.selected = selected;
        }
        Change::Edit { id: shot, texts } => {
            if texts.iter().any(|s| s.len() > 250_000) {
                return Err(invalid("编辑内容过长"));
            }
            let updated=tx.execute("UPDATE video_shot_results SET texts=?3 WHERE plan_id=?1 AND interval_id=?2 AND visible=1",
                params![id,shot,serde_json::to_string(&texts)?])?;
            if updated != 1 {
                return Err(invalid("镜头分析结果已变化"));
            }
        }
    }
    save_header(&tx, &id, &mut h)?;
    let plan = to_plan(&tx, &id, h)?;
    tx.commit()?;
    Ok(plan)
}
pub(super) fn apply_result(
    db: &Database,
    asset: &str,
    hash: &str,
    shot: &str,
    task_key: &str,
    texts: Texts,
    expected: Option<&Texts>,
) -> AppResult<()> {
    let path = source(db, asset, SourceUsage::VideoAnalysis)?;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let (id, mut h) = matching(&tx, asset, &path, hash)?;
    if !intervals(&h.layout.cuts, h.duration_ms).any(|(s, e)| shot == interval_id(s, e)) {
        return Err(invalid("原分镜区间已变化，已保留原任务回执"));
    }
    let prior: Option<String> = tx
        .query_row(
            "SELECT interval_id FROM video_shot_applied_tasks WHERE plan_id=?1 AND task_key=?2",
            params![id, task_key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(original) = prior {
        if original != shot {
            return Err(invalid("任务回执与镜头不符"));
        }
        let restored=tx.execute("UPDATE video_shot_results SET visible=1 WHERE plan_id=?1 AND interval_id=?2 AND visible=0",
            params![id,shot])?;
        if restored > 0 {
            save_header(&tx, &id, &mut h)?;
        }
    } else {
        let current:Option<String>=tx.query_row("SELECT texts FROM video_shot_results WHERE plan_id=?1 AND interval_id=?2 AND visible=1",
            params![id,shot],|r|r.get(0)).optional()?;
        let previous: Option<Texts> = current.as_deref().map(serde_json::from_str).transpose()?;
        if previous.as_ref() != expected {
            return Err(invalid("镜头内容已编辑，已保留原任务回执"));
        }
        tx.execute("INSERT INTO video_shot_results(plan_id,interval_id,texts,visible) VALUES(?1,?2,?3,1) ON CONFLICT(plan_id,interval_id) DO UPDATE SET texts=excluded.texts,visible=1",
            params![id,shot,serde_json::to_string(&texts)?])?;
        tx.execute(
            "INSERT INTO video_shot_applied_tasks(plan_id,task_key,interval_id) VALUES(?1,?2,?3)",
            params![id, task_key, shot],
        )?;
        save_header(&tx, &id, &mut h)?;
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub async fn video_shots_get(db: State<'_, Arc<Database>>, asset_id: String) -> AppResult<Plan> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || get(&db, &asset_id))
        .await
        .map_err(|e| invalid(&e.to_string()))?
}
#[tauri::command]
pub async fn video_shots_update(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    source_hash: String,
    revision: i64,
    change: Change,
) -> AppResult<Plan> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || update(&db, &asset_id, &source_hash, revision, change))
        .await
        .map_err(|e| invalid(&e.to_string()))?
}

#[tauri::command]
pub async fn video_shots_detect(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    source_hash: String,
    revision: i64,
    threshold: f64,
) -> AppResult<Vec<Cut>> {
    model::valid_threshold(threshold)?;
    let path = source(&db, &asset_id, SourceUsage::VideoAnalysis)?;
    let (_, h) = matching(&db.conn.lock().unwrap(), &asset_id, &path, &source_hash)?;
    if h.revision != revision {
        return Err(invalid("分镜已变化，请刷新"));
    }
    let cuts = media::detect(&path, &h, threshold).await?;
    let (_, now) = matching(&db.conn.lock().unwrap(), &asset_id, &path, &source_hash)?;
    if now.revision != revision {
        return Err(invalid("检测期间分镜已更新，请重新检测"));
    }
    Ok(cuts)
}
#[tauri::command]
pub async fn video_shots_frame(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    asset_id: String,
    source_hash: String,
    start_ms: i64,
) -> AppResult<String> {
    let path = source(&db, &asset_id, SourceUsage::VideoAnalysis)?;
    let (_, h) = matching(&db.conn.lock().unwrap(), &asset_id, &path, &source_hash)?;
    if start_ms != 0
        && h.layout
            .cuts
            .binary_search_by_key(&start_ms, |cut| cut.at)
            .is_err()
    {
        return Err(invalid("请选择当前镜头"));
    }
    let folder = paths.thumbnails.join("video-shots").join(&h.source_hash);
    let frame = media::frame(&path, &folder, start_ms, &h.version).await?;
    if source_version(&path)? != h.version {
        return Err(invalid("提取期间原件发生变化"));
    }
    Ok(frame.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn video_shots_frame_asset(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    asset_id: String,
    source_hash: String,
    start_ms: i64,
) -> AppResult<crate::core::library::Asset> {
    let database = db.inner().clone();
    let library = paths.inner().clone();
    let file =
        video_shots_frame(db, paths, asset_id.clone(), source_hash.clone(), start_ms).await?;
    tokio::task::spawn_blocking(move || {
        let (_, plan) = current_plan(&database, &asset_id, &source_hash)?;
        if start_ms != 0 && plan.cuts.binary_search_by_key(&start_ms, |c| c.at).is_err() {
            return Err(invalid("镜头已改变，请重新选择"));
        }
        crate::core::ingest::ingest_video_shot_frame(&library, &database, Path::new(&file))
    })
    .await
    .map_err(|error| invalid(&error.to_string()))?
}
