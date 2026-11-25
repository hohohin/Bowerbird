use super::*;
use crate::commands::{
    video_asset_revision::{source, SourceUsage},
    video_shots,
};
use crate::core::creative_session_contract::{CreativeNodeKind, CreativeNodeRole};
use serde::Deserialize;
use tauri::Emitter;

#[cfg(test)]
#[path = "shot_delivery_tests.rs"]
mod tests;

#[derive(Deserialize)]
pub struct DeliveryShot {
    start: i64,
    end: i64,
    texts: [String; 3],
}
#[tauri::command]
pub async fn video_shots_delivery_get(
    db: State<'_, Arc<Database>>,
    project_id: String,
    delivery_key: String,
) -> AppResult<Option<String>> {
    db.conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT focus_id FROM video_shot_deliveries WHERE project_id=?1 AND delivery_key=?2",
            params![project_id, delivery_key],
            |r| r.get(0),
        )
        .optional()
        .map_err(Into::into)
}

#[tauri::command]
pub async fn video_shots_deliver(
    app: tauri::AppHandle,
    db: State<'_, Arc<Database>>,
    project_id: String,
    source_asset_id: String,
    source_hash: String,
    delivery_key: String,
    focus_id: String,
    revision: i64,
    shots: Vec<DeliveryShot>,
    frames: Vec<NewCanvasNode>,
    additions: Vec<Value>,
) -> AppResult<String> {
    let focus = commit_delivery(
        &db,
        project_id.clone(),
        source_asset_id,
        source_hash,
        delivery_key,
        focus_id,
        revision,
        shots,
        frames,
        additions,
    )?;
    let _ = app.emit("project-canvas://nodes-changed", &project_id);
    Ok(focus)
}

fn commit_delivery(
    db: &Database,
    project_id: String,
    source_asset_id: String,
    source_hash: String,
    delivery_key: String,
    focus_id: String,
    revision: i64,
    shots: Vec<DeliveryShot>,
    frames: Vec<NewCanvasNode>,
    additions: Vec<Value>,
) -> AppResult<String> {
    if shots.is_empty()
        || shots.len() > 2000
        || frames.len() > shots.len()
        || additions.len() > shots.len() * 2
        || delivery_key.len() != 64
        || !delivery_key.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(invalid());
    }
    let path = source(db, &source_asset_id, SourceUsage::VideoAnalysis)?;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    if let Some(focus) = tx
        .query_row(
            "SELECT focus_id FROM video_shot_deliveries WHERE project_id=?1 AND delivery_key=?2",
            params![project_id, delivery_key],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(focus);
    }
    let plan = video_shots::plan_in(&tx, &source_asset_id, &path, &source_hash)?;
    for shot in &shots {
        if plan.results.get(&format!("{}-{}", shot.start, shot.end)) != Some(&shot.texts) {
            return Err(AppError::Other("分镜已修改，请重新选择后发送".into()));
        }
    }
    let saved: Option<(i64, String)> = tx
        .query_row(
            "SELECT revision,document_json FROM canvas_workflows WHERE project_id=?1",
            [&project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (rev, mut document) = match saved {
        Some((r, s)) => (r, serde_json::from_str::<Value>(&s)?),
        None => (0, json!({"schema_version":1,"nodes":[],"run":null})),
    };
    if rev != revision {
        return Err(AppError::Other("目标画板刚有改动，请重试".into()));
    }
    let now = chrono::Utc::now().timestamp();
    touch_canvas_tx(&tx, &project_id, now)?;
    for frame in &frames {
        if frame.project_id != project_id || frame.thread_id.is_some() {
            return Err(invalid());
        }
        match frame.kind {
            CreativeNodeKind::Note
                if frames.len() == 1
                    && additions.is_empty()
                    && frame.id == format!("shot-note-{delivery_key}")
                    && frame.asset_id.is_none()
                    && frame.role.is_none() =>
            {
                let note: Value = serde_json::from_str(&frame.payload_json)?;
                if note["note_type"] != "text" {
                    return Err(invalid());
                }
                for cell in note["cells"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .flat_map(|row| row.as_array().into_iter().flatten())
                {
                    for image in cell["image_refs"].as_array().into_iter().flatten() {
                        tx.execute("INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) VALUES(?1,?2,?3)",params![project_id,image["asset_id"].as_str().ok_or_else(invalid)?,now])?;
                    }
                }
            }
            CreativeNodeKind::Asset
                if frame.id.starts_with("shot-frame-")
                    && frame.asset_id.is_some()
                    && frame.role == Some(CreativeNodeRole::Reference) => {}
            _ => return Err(invalid()),
        }
        insert_node_tx(&tx, frame, now)?;
        if let Some(asset) = &frame.asset_id {
            tx.execute("INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) VALUES(?1,?2,?3)",params![project_id,asset,now])?;
        }
    }
    if !additions.is_empty() {
        let nodes = document["nodes"].as_array_mut().ok_or_else(invalid)?;
        for node in additions {
            if node["kind"] != "generation"
                || !node["id"].as_str().is_some_and(|id| {
                    id.starts_with("shot-image-") || id.starts_with("shot-video-")
                })
            {
                return Err(invalid());
            }
            nodes.push(node);
        }
        validate(&document)?;
        tx.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES(?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json",
            params![project_id,rev+1,document.to_string()])?;
    }
    if !frames.iter().any(|n| n.id == focus_id)
        && !document["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|n| n["id"] == focus_id)
    {
        return Err(invalid());
    }
    tx.execute(
        "INSERT INTO video_shot_deliveries(project_id,delivery_key,focus_id) VALUES(?,?,?)",
        params![project_id, delivery_key, focus_id],
    )?;
    tx.commit()?;
    Ok(focus_id)
}
