//! Stable canvas projections for generation turn and Agent execution identities.
use std::path::Path;
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::core::creative_session_contract::{
    edge_endpoints_are_valid, parse_node_payload, AgentGroupNodePayloadV1, AssetExecutionRefV1,
    AssetNodePayloadV1, AssetSnapshotV1, CreativeEdgeKind, CreativeNodeKind, CreativeNodeRole,
    PromptNodePayloadV1, PromptReferenceAssetV1,
};
use crate::{core::library::Asset, db::Database, error::{AppError, AppResult}};

use super::{placement, types::*};
use super::repository::{
    edge_from_row, edge_kind_sql, edge_threads_are_valid, get_node_tx, insert_node_tx, invalid,
    project_canvas_snapshot_tx, required, touch_canvas_tx, EDGE_COLUMNS,
};

pub(super) fn projection_id(prefix: &str, execution_id: &str, turn_key: &str, suffix: &str) -> String {
    format!("{prefix}:{execution_id}:{turn_key}:{suffix}")
}

pub(super) fn asset_snapshot(asset: &Asset) -> AssetSnapshotV1 {
    AssetSnapshotV1 {
        name: asset.name.clone(),
        width: asset.width.and_then(|value| u32::try_from(value).ok()),
        height: asset.height.and_then(|value| u32::try_from(value).ok()),
    }
}

pub(super) fn asset_node_height(snapshot: &AssetSnapshotV1) -> f64 {
    let ratio = match (snapshot.width, snapshot.height) {
        (Some(width), Some(height)) if width > 0 => height as f64 / width as f64,
        _ => 0.78,
    };
    (190.0 * ratio).clamp(112.0, 242.0) + 30.0
}

fn asset_snapshot_by_store_path_tx(
    tx: &Transaction<'_>,
    store_path: &str,
) -> AppResult<Option<(String, AssetSnapshotV1)>> {
    Ok(tx
        .query_row(
            "SELECT id,name,width,height FROM assets WHERE store_path=?1 ORDER BY created_at DESC,id DESC LIMIT 1",
            [store_path],
            |row| {
                Ok((
                    row.get(0)?,
                    AssetSnapshotV1 {
                        name: row.get(1)?,
                        width: row
                            .get::<_, Option<i64>>(2)?
                            .and_then(|value| u32::try_from(value).ok()),
                        height: row
                            .get::<_, Option<i64>>(3)?
                            .and_then(|value| u32::try_from(value).ok()),
                    },
                ))
            },
        )
        .optional()?)
}

fn unique_visible_output_node_for_asset_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    thread_id: &str,
    asset_id: &str,
) -> AppResult<Option<String>> {
    let mut statement = tx.prepare(
        "SELECT id FROM canvas_nodes WHERE project_id=?1 AND thread_id=?2 AND asset_id=?3 AND role IN ('output','intermediate','final') AND hidden_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 2",
    )?;
    let mut node_ids = statement
        .query_map(params![project_id, thread_id, asset_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if node_ids.len() > 1 {
        return Err(invalid(format!(
            "asset {asset_id} matches multiple visible continuation nodes in project {project_id} thread {thread_id}; use an exact node id"
        )));
    }
    Ok(node_ids.pop())
}

fn verify_project_thread_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    thread_id: &str,
) -> AppResult<()> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM creative_threads WHERE id=?1 AND project_id=?2 AND archived_at IS NULL)",
        params![thread_id, project_id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound(format!(
            "active creative thread {thread_id} in project {project_id}"
        )))
    }
}

fn exact_visible_parent_node_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    thread_id: &str,
    node_id: &str,
) -> AppResult<CanvasNode> {
    required(node_id, "parent node id")?;
    let node = get_node_tx(tx, node_id)?
        .ok_or_else(|| AppError::NotFound(format!("canvas parent node {node_id}")))?;
    if node.project_id != project_id {
        return Err(invalid(format!(
            "parent node {node_id} belongs to another project"
        )));
    }
    if node.thread_id.as_deref() != Some(thread_id) {
        return Err(invalid(format!(
            "parent node {node_id} belongs to another creative thread"
        )));
    }
    if node.hidden_at.is_some() {
        return Err(AppError::NotFound(format!(
            "visible canvas parent node {node_id}"
        )));
    }
    if node.kind != CreativeNodeKind::Asset
        || !matches!(
            node.role,
            Some(
                CreativeNodeRole::Output | CreativeNodeRole::Intermediate | CreativeNodeRole::Final
            )
        )
    {
        return Err(invalid(format!(
            "parent node {node_id} must be an output, intermediate, or final asset"
        )));
    }
    Ok(node)
}

fn exact_visible_reference_node_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    node_id: &str,
    store_path: &str,
) -> AppResult<Option<CanvasNode>> {
    required(node_id, "reference node id")?;
    let Some(node) = get_node_tx(tx, node_id)? else {
        // Draft chips can survive removal of an unconnected canvas instance.
        // Retain the central image and let this turn create its own reference;
        // do not bind the stale locator to a different visible instance.
        if asset_snapshot_by_store_path_tx(tx, store_path)?.is_some() {
            return Ok(None);
        }
        return Err(AppError::NotFound(format!("canvas reference node {node_id}")));
    };
    if node.project_id != project_id {
        return Err(invalid(format!(
            "reference node {node_id} belongs to another project"
        )));
    }
    if node.hidden_at.is_some() {
        return Err(AppError::NotFound(format!(
            "visible canvas reference node {node_id}"
        )));
    }
    if node.kind != CreativeNodeKind::Asset {
        return Err(invalid(format!(
            "reference node {node_id} must be an asset"
        )));
    }
    let matches_path = if let Some(asset_id) = node.asset_id.as_deref() {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND store_path=?2)",
            params![asset_id, store_path],
            |row| row.get::<_, bool>(0),
        )?
    } else {
        false
    };
    if !matches_path {
        return Err(invalid(format!(
            "reference node {node_id} does not match reference asset path"
        )));
    }
    Ok(Some(node))
}

fn first_visible_reference_node_for_path_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    store_path: &str,
) -> AppResult<Option<String>> {
    let mut statement = tx.prepare(
        "SELECT n.id FROM canvas_nodes n JOIN assets a ON a.id=n.asset_id
         WHERE n.project_id=?1
           AND n.kind='asset' AND n.hidden_at IS NULL
           AND a.store_path=?2
         ORDER BY n.created_at,n.id LIMIT 1",
    )?;
    let node_ids = statement
        .query_map(params![project_id, store_path], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(node_ids.into_iter().next())
}

fn upsert_projection_node_tx(
    tx: &Transaction<'_>,
    value: &NewCanvasNode,
    now: i64,
) -> AppResult<CanvasNode> {
    if let Some(existing) = get_node_tx(tx, &value.id)? {
        if existing.project_id != value.project_id
            || existing.thread_id != value.thread_id
            || existing.kind != value.kind
            || existing.asset_id != value.asset_id
            || existing.role != value.role
        {
            return Err(invalid(format!(
                "stable projection node id {} replayed with different identity",
                value.id
            )));
        }
        parse_node_payload(value.kind, &value.payload_json)
            .map_err(|error| invalid(error.to_string()))?;
        tx.execute(
            "UPDATE canvas_nodes SET payload_json=?2,updated_at=?3 WHERE id=?1",
            params![value.id, value.payload_json, now],
        )?;
        return get_node_tx(tx, &value.id)?
            .ok_or_else(|| AppError::NotFound(format!("canvas node {}", value.id)));
    }
    insert_node_tx(tx, value, now)
}

// Reference ownership records its origin, not exclusive use. Only an input
// edge may reuse a reference asset across threads within the same project.
fn insert_projection_edge_tx(
    tx: &Transaction<'_>,
    value: &NewCanvasEdge,
    now: i64,
) -> AppResult<()> {
    if let Some(existing) = tx
        .query_row(
            &format!("SELECT {EDGE_COLUMNS} FROM canvas_edges WHERE id=?1"),
            [&value.id],
            edge_from_row,
        )
        .optional()?
    {
        if existing.project_id == value.project_id
            && existing.thread_id == value.thread_id
            && existing.from_node_id == value.from_node_id
            && existing.to_node_id == value.to_node_id
            && existing.kind == value.kind
            && existing.ordinal == value.ordinal
        {
            return Ok(());
        }
        return Err(invalid(format!(
            "stable projection edge id {} replayed with different content",
            value.id
        )));
    }
    let from = get_node_tx(tx, &value.from_node_id)?
        .ok_or_else(|| AppError::NotFound(format!("canvas node {}", value.from_node_id)))?;
    let to = get_node_tx(tx, &value.to_node_id)?
        .ok_or_else(|| AppError::NotFound(format!("canvas node {}", value.to_node_id)))?;
    if from.project_id != value.project_id
        || to.project_id != value.project_id
        || !edge_threads_are_valid(value, &from, &to)
        || !edge_endpoints_are_valid(value.kind, from.kind, from.role, to.kind, to.role)
    {
        return Err(invalid("invalid project/thread projection edge"));
    }
    tx.execute(
        "INSERT INTO canvas_edges (id,project_id,thread_id,from_node_id,to_node_id,kind,ordinal,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![value.id, value.project_id, value.thread_id, value.from_node_id, value.to_node_id, edge_kind_sql(value.kind), value.ordinal, now],
    )?;
    Ok(())
}

// New prompts use vertical free space beside their sources. Recovery never moves them.
fn place_prompt_near_inputs_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    prompt_id: &str,
    new_reference_ids: &[String],
) -> AppResult<()> {
    let excluded = serde_json::to_string(new_reference_ids)?;
    let mut statement = tx.prepare(
        "SELECT COALESCE(g.x,n.x),COALESCE(g.y,n.y),COALESCE(g.width,n.width)
         FROM canvas_edges e JOIN canvas_nodes n ON n.id=e.from_node_id
         LEFT JOIN canvas_group_items i ON i.node_id=n.id
         LEFT JOIN canvas_groups g ON g.id=i.group_id
         WHERE e.to_node_id=?1 AND n.hidden_at IS NULL
           AND n.id NOT IN (SELECT value FROM json_each(?2))",
    )?;
    let sources = statement
        .query_map(params![prompt_id, excluded], |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if sources.is_empty() {
        return Ok(());
    }
    let x = sources
        .iter()
        .map(|(x, _, w)| x + w)
        .fold(f64::NEG_INFINITY, f64::max)
        + 72.0;
    let mut y = sources
        .iter()
        .map(|(_, y, _)| *y)
        .fold(f64::INFINITY, f64::min);
    // Walk down the occupied horizontal strip once. Each collision advances beyond
    // its bottom, so a previously visited rectangle cannot block the new position.
    let mut obstacles = tx.prepare_cached(
        "SELECT y,y+height FROM (
            SELECT x,y,width,height FROM canvas_nodes WHERE project_id=?1 AND id<>?2 AND hidden_at IS NULL
              AND id NOT IN (SELECT value FROM json_each(?4))
              AND id NOT IN (SELECT node_id FROM canvas_group_items WHERE project_id=?1)
            UNION ALL SELECT x,y,width,height FROM canvas_groups WHERE project_id=?1
         ) WHERE x < ?3+620 AND x+width+32 > ?3 ORDER BY y",
    )?;
    let free_y = obstacles.query_map(params![project_id, prompt_id, x, excluded], |row| {
        Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?))
    })?;
    for obstacle in free_y {
        let (top, bottom) = obstacle?;
        if top >= y + 184.0 {
            break;
        }
        if bottom + 32.0 > y {
            y = bottom + 40.0;
        }
    }
    tx.execute(
        "UPDATE canvas_nodes SET x=?2,y=?3 WHERE id=?1",
        params![prompt_id, x, y],
    )?;
    Ok(())
}

// Only nodes inserted by this transaction receive automatic reference layout.
// Resolve the visible Agent card on replay; its launch prompt may have been moved separately.
fn place_new_references_near_card_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    prompt_id: &str,
    new_reference_ids: &[String],
    agent: bool,
) -> AppResult<()> {
    if new_reference_ids.is_empty() {
        return Ok(());
    }
    let prompt = get_node_tx(tx, prompt_id)?.ok_or_else(|| invalid("missing reference anchor"))?;
    let group_id: Option<String> = if agent {
        tx.query_row(
            "SELECT n.id FROM canvas_edges e JOIN canvas_nodes n ON n.id=e.to_node_id
             WHERE e.from_node_id=?1 AND n.project_id=?2 AND n.thread_id=?3
               AND n.kind='agent_group' AND n.hidden_at IS NULL",
            params![prompt_id, project_id, prompt.thread_id],
            |row| row.get(0),
        )
        .optional()?
    } else {
        None
    };
    let (x, bottom) = if let Some(group_id) = group_id {
        let group = get_node_tx(tx, &group_id)?.ok_or_else(|| invalid("missing Agent card"))?;
        (group.x, group.y + group.height)
    } else if agent {
        // The first checkpoint creates the execution card at this exact offset.
        (prompt.x + 332.0, prompt.y - 18.0 + 184.0)
    } else {
        (prompt.x, prompt.y + prompt.height)
    };
    let excluded = serde_json::to_string(new_reference_ids)?;
    let mut statement = tx.prepare(
        "SELECT x,y,width,height FROM canvas_nodes WHERE project_id=?1 AND hidden_at IS NULL
           AND id NOT IN (SELECT value FROM json_each(?2))
           AND id NOT IN (SELECT node_id FROM canvas_group_items WHERE project_id=?1)
         UNION ALL SELECT x,y,width,height FROM canvas_groups WHERE project_id=?1",
    )?;
    let mut occupied = statement
        .query_map(params![project_id, excluded], |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut column = 0;
    let mut y = bottom + 40.0;
    let mut row_height: f64 = 0.0;
    for id in new_reference_ids {
        let node = get_node_tx(tx, id)?.ok_or_else(|| invalid("missing new reference"))?;
        let mut candidate_x = x + column as f64 * 230.0;
        // Try three ordered slots per row, including existing groups as obstacles.
        while occupied.iter().any(|(ox, oy, ow, oh)| {
            candidate_x < ox + ow + 32.0
                && candidate_x + node.width + 32.0 > *ox
                && y < oy + oh + 32.0
                && y + node.height + 32.0 > *oy
        }) {
            row_height = row_height.max(node.height);
            column += 1;
            if column == 3 {
                column = 0;
                y += row_height + 40.0;
                row_height = 0.0;
            }
            candidate_x = x + column as f64 * 230.0;
        }
        tx.execute(
            "UPDATE canvas_nodes SET x=?2,y=?3 WHERE id=?1",
            params![id, candidate_x, y],
        )?;
        occupied.push((candidate_x, y, node.width, node.height));
        row_height = row_height.max(node.height);
        column += 1;
        if column == 3 {
            column = 0;
            y += row_height + 40.0;
            row_height = 0.0;
        }
    }
    Ok(())
}

impl Database {
    /// Provider 启动前的项目画板事实投影。执行身份与 thread 分离，稳定键重放时只更新 payload，
    /// 不覆盖用户已经调整过的节点坐标。
    pub fn begin_project_generation_turn(
        &self,
        value: &ProjectGenerationTurnInput,
    ) -> AppResult<ProjectGenerationTurnGraph> {
        required(&value.project_id, "project id")?;
        required(&value.thread_id, "thread id")?;
        required(
            &value.generation_conversation_id,
            "generation conversation id",
        )?;
        required(&value.job_id, "generation job id")?;
        required(&value.turn_key, "turn key")?;
        required(&value.prompt, "prompt")?;
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        verify_project_thread_tx(&tx, &value.project_id, &value.thread_id)?;
        touch_canvas_tx(&tx, &value.project_id, now)?;

        if let Some(existing) = tx
            .query_row(
                "SELECT thread_id FROM thread_generation_links WHERE generation_conversation_id=?1",
                [&value.generation_conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            if existing != value.thread_id {
                return Err(invalid(
                    "generation conversation already belongs to another creative thread",
                ));
            }
        } else {
            tx.execute(
                "INSERT INTO thread_generation_links (thread_id,generation_conversation_id,created_at) VALUES (?1,?2,?3)",
                params![value.thread_id, value.generation_conversation_id, now],
            )?;
        }

        let (max_right, max_z): (f64, i64) = tx.query_row(
            "SELECT COALESCE(MAX(x+width),0),COALESCE(MAX(z_index),0) FROM canvas_nodes WHERE project_id=?1 AND hidden_at IS NULL",
            [&value.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let prompt_node_id = projection_id("gen-prompt", &value.job_id, &value.turn_key, "0");
        // Workflow runs persist this binding before submitting the provider job.
        // Anchor at creation, including when the owning canvas is not mounted.
        let workflow = placement::workflow(&tx, &value.project_id)?;
        let owner = placement::generation_source(&workflow, &value.job_id, &prompt_node_id);
        // 失败重试锚点：同线程内可见的 prompt 卡才可作为叠放目标，否则回退常规落位。
        let retry_anchor = match value.retry_anchor_node_id.as_deref() {
            Some(node_id) => get_node_tx(&tx, node_id)?.filter(|node| {
                node.kind == CreativeNodeKind::Prompt
                    && node.project_id == value.project_id
                    && node.thread_id.as_deref() == Some(value.thread_id.as_str())
                    && node.hidden_at.is_none()
            }),
            None => None,
        };
        let existing_canvas = project_canvas_snapshot_tx(&tx, &value.project_id)?;
        let gallery_anchor = existing_canvas.nodes.iter().filter(|n| n.kind == CreativeNodeKind::Prompt && n.hidden_at.is_none())
            .filter(|n| {
                let payload: serde_json::Value = serde_json::from_str(&n.payload_json).unwrap_or_default();
                payload["generation_group_dissolved"] != true
                    && !payload["workflow_generation_group"].as_str().is_some_and(|key| key.starts_with("asset:"))
                    && (payload["conversation_id"].as_str() == Some(value.generation_conversation_id.as_str())
                        || owner.is_some_and(|source| source["sessionNodeIds"].as_array().is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(n.id.as_str())))))
            }).min_by(|a,b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        let (prompt_x, prompt_y) = if let Some(anchor) = retry_anchor.as_ref().or(gallery_anchor) {
            (anchor.x, anchor.y)
        } else if let Some(source) = owner {
            let rect = placement::workflow_rect(source);
            let mut excluded = vec![prompt_node_id.as_str()];
            let x = if placement::generation_workflow_can_replace(source, &workflow, &existing_canvas) {
                excluded.extend(source["id"].as_str());
                rect.x
            } else { rect.x + rect.width + 64.0 };
            placement::near(placement::Rect { x, y: rect.y, width: 260.0, height: 148.0 },
                &placement::obstacles_in_snapshot(&existing_canvas, &workflow, &excluded, None), x)
        } else { (max_right + 72.0, 88.0) };
        let new_prompt = get_node_tx(&tx, &prompt_node_id)?.is_none();
        let mut reference_assets = Vec::new();
        for path in &value.references {
            if let Some((asset_id, snapshot)) = asset_snapshot_by_store_path_tx(&tx, path)? {
                if new_prompt {
                    tx.execute(
                        "INSERT OR IGNORE INTO project_assets (project_id,asset_id,created_at) VALUES (?1,?2,?3)",
                        params![value.project_id, asset_id, now],
                    )?;
                }
                reference_assets.push(PromptReferenceAssetV1 { asset_id, snapshot });
            }
        }
        let prompt_payload = serde_json::to_string(&PromptNodePayloadV1 {
            schema_version: 1,
            workflow_generation_group: None,
            text: value.prompt.clone(),
            applied_prompt: Some(value.applied_prompt.clone()),
            provider: Some(value.provider.clone()),
            provider_session_id: value.provider_session_id.clone(),
            job_id: Some(value.job_id.clone()),
            conversation_id: Some(value.generation_conversation_id.clone()),
            turn_key: Some(value.turn_key.clone()),
            ratio: value.ratio.clone(),
            visual_profile: value.visual_profile.clone(),
            status: Some("running".into()),
            reference_assets,
        })?;
        upsert_projection_node_tx(
            &tx,
            &NewCanvasNode {
                id: prompt_node_id.clone(),
                project_id: value.project_id.clone(),
                thread_id: Some(value.thread_id.clone()),
                kind: CreativeNodeKind::Prompt,
                asset_id: None,
                role: None,
                payload_json: prompt_payload,
                x: prompt_x,
                y: prompt_y,
                width: 260.0,
                height: 148.0,
                z_index: max_z + 1,
                position_locked: owner.is_some() || retry_anchor.is_some(),
            },
            now,
        )?;

        let parent_node_id = if let Some(explicit_node_id) = value.parent_node_id.as_deref() {
            let parent = exact_visible_parent_node_tx(
                &tx,
                &value.project_id,
                &value.thread_id,
                explicit_node_id,
            )?;
            if let Some(parent_path) = value.parent_asset_path.as_deref() {
                let matches_path = if let Some(asset_id) = parent.asset_id.as_deref() {
                    tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND store_path=?2)",
                        params![asset_id, parent_path],
                        |row| row.get::<_, bool>(0),
                    )?
                } else {
                    false
                };
                if !matches_path {
                    return Err(invalid(format!(
                        "parent node {explicit_node_id} does not match parent asset path"
                    )));
                }
            }
            Some(parent.id)
        } else if let Some(parent_path) = value.parent_asset_path.as_deref() {
            if let Some((asset_id, snapshot)) = asset_snapshot_by_store_path_tx(&tx, parent_path)? {
                let existing = unique_visible_output_node_for_asset_tx(
                    &tx,
                    &value.project_id,
                    &value.thread_id,
                    &asset_id,
                )?;
                let node_id = if let Some(existing) = existing {
                    existing
                } else {
                    let node_id = projection_id("gen-parent", &value.job_id, &value.turn_key, "0");
                    let payload = serde_json::to_string(&AssetNodePayloadV1 {
                        draft_document_id: None,
                        workflow_source: None,
                        workflow_generation_group: None,
                        schema_version: 1,
                        snapshot: snapshot.clone(),
                        execution: Some(AssetExecutionRefV1 {
                            job_id: Some(value.job_id.clone()),
                            turn_key: Some(value.turn_key.clone()),
                            run_id: None,
                            artifact_id: None,
                        }),
                    })?;
                    upsert_projection_node_tx(
                        &tx,
                        &NewCanvasNode {
                            id: node_id.clone(),
                            project_id: value.project_id.clone(),
                            thread_id: Some(value.thread_id.clone()),
                            kind: CreativeNodeKind::Asset,
                            asset_id: Some(asset_id),
                            role: Some(CreativeNodeRole::Output),
                            payload_json: payload,
                            x: (prompt_x - 240.0).max(24.0),
                            y: prompt_y,
                            width: 190.0,
                            height: asset_node_height(&snapshot),
                            z_index: max_z + 2,
                            position_locked: false,
                        },
                        now,
                    )?;
                    node_id
                };
                Some(node_id)
            } else {
                None
            }
        } else {
            None
        };
        if let (Some(parent_node_id), Some(relation)) = (parent_node_id.as_deref(), value.relation)
        {
            let kind = match relation {
                crate::core::creative_session_contract::CreativeGenerationRelation::Continued => {
                    CreativeEdgeKind::Continued
                }
                crate::core::creative_session_contract::CreativeGenerationRelation::Retry => {
                    CreativeEdgeKind::Retry
                }
                crate::core::creative_session_contract::CreativeGenerationRelation::Branch => {
                    CreativeEdgeKind::Branch
                }
            };
            insert_projection_edge_tx(
                &tx,
                &NewCanvasEdge {
                    id: projection_id("gen-edge", &value.job_id, &value.turn_key, "parent"),
                    project_id: value.project_id.clone(),
                    thread_id: value.thread_id.clone(),
                    from_node_id: parent_node_id.to_string(),
                    to_node_id: prompt_node_id.clone(),
                    kind,
                    ordinal: 0,
                },
                now,
            )?;
        }

        let mut reference_node_ids = Vec::new();
        let mut new_reference_ids = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (index, store_path) in value.references.iter().enumerate() {
            // The editor sends null for library/file references and a node ID
            // only for a canvas pick. Do not guess by matching the asset path.
            // Missing slots are legacy callers; their projection stays compatible.
            if matches!(value.reference_node_ids.get(index), Some(None)) {
                continue;
            }
            if !seen.insert(store_path.as_str())
                || value.parent_asset_path.as_deref() == Some(store_path.as_str())
            {
                continue;
            }
            let requested_node_id = value
                .reference_node_ids
                .get(index)
                .and_then(|node_id| node_id.as_deref());
            let existing_node_id = if let Some(node_id) = requested_node_id {
                exact_visible_reference_node_tx(&tx, &value.project_id, node_id, store_path)?
                    .map(|node| node.id)
            } else {
                // Once selected, replay retains this input even if another instance is added.
                let source: Option<String> = tx.query_row(
                    "SELECT e.from_node_id FROM canvas_edges e JOIN canvas_nodes n ON n.id=e.from_node_id
                     JOIN assets a ON a.id=n.asset_id WHERE e.id=?1 AND n.project_id=?2 AND a.store_path=?3",
                    params![projection_id("gen-edge", &value.job_id, &value.turn_key, &format!("input-{index}")), value.project_id, store_path],
                    |row| row.get(0),
                ).optional()?;
                match source {
                    Some(id) => Some(id),
                    None => first_visible_reference_node_for_path_tx(
                        &tx,
                        &value.project_id,
                        store_path,
                    )?,
                }
            };
            let found = asset_snapshot_by_store_path_tx(&tx, store_path)?;
            let (asset_id, snapshot) = found.map_or_else(
                || {
                    (
                        None,
                        AssetSnapshotV1 {
                            name: Path::new(store_path)
                                .file_name()
                                .and_then(|name| name.to_str())
                                .unwrap_or("参考素材")
                                .to_string(),
                            width: None,
                            height: None,
                        },
                    )
                },
                |(id, snapshot)| (Some(id), snapshot),
            );
            let node_id = if let Some(node_id) = existing_node_id {
                node_id
            } else {
                let node_id = projection_id(
                    "gen-reference",
                    &value.job_id,
                    &value.turn_key,
                    &index.to_string(),
                );
                if get_node_tx(&tx, &node_id)?.is_none() {
                    new_reference_ids.push(node_id.clone());
                }
                let payload = serde_json::to_string(&AssetNodePayloadV1 {
                    draft_document_id: None,
                    workflow_source: None,
                    workflow_generation_group: None,
                    schema_version: 1,
                    snapshot: snapshot.clone(),
                    execution: Some(AssetExecutionRefV1 {
                        job_id: Some(value.job_id.clone()),
                        turn_key: Some(value.turn_key.clone()),
                        run_id: None,
                        artifact_id: None,
                    }),
                })?;
                upsert_projection_node_tx(
                    &tx,
                    &NewCanvasNode {
                        id: node_id.clone(),
                        project_id: value.project_id.clone(),
                        thread_id: Some(value.thread_id.clone()),
                        kind: CreativeNodeKind::Asset,
                        asset_id,
                        role: Some(CreativeNodeRole::Reference),
                        payload_json: payload,
                        x: (prompt_x - 230.0).max(24.0),
                        y: prompt_y + index as f64 * 42.0,
                        width: 190.0,
                        height: asset_node_height(&snapshot),
                        z_index: max_z + 2 + index as i64,
                        position_locked: false,
                    },
                    now,
                )?;
                node_id
            };
            insert_projection_edge_tx(
                &tx,
                &NewCanvasEdge {
                    id: projection_id(
                        "gen-edge",
                        &value.job_id,
                        &value.turn_key,
                        &format!("input-{index}"),
                    ),
                    project_id: value.project_id.clone(),
                    thread_id: value.thread_id.clone(),
                    from_node_id: node_id.clone(),
                    to_node_id: prompt_node_id.clone(),
                    kind: CreativeEdgeKind::Input,
                    ordinal: index as i64,
                },
                now,
            )?;
            reference_node_ids.push(node_id);
        }
        if new_prompt && owner.is_none() && retry_anchor.is_none() {
            place_prompt_near_inputs_tx(
                &tx,
                &value.project_id,
                &prompt_node_id,
                &new_reference_ids,
            )?;
        }
        place_new_references_near_card_tx(
            &tx,
            &value.project_id,
            &prompt_node_id,
            &new_reference_ids,
            false,
        )?;
        tx.execute(
            "UPDATE creative_threads SET updated_at=?2 WHERE id=?1",
            params![value.thread_id, now],
        )?;
        tx.commit()?;
        Ok(ProjectGenerationTurnGraph {
            prompt_node_id,
            reference_node_ids,
            parent_node_id,
        })
    }

    pub fn update_project_generation_turn_status(
        &self,
        project_id: &str,
        thread_id: &str,
        job_id: &str,
        turn_key: &str,
        status: &str,
        provider_session_id: Option<&str>,
    ) -> AppResult<bool> {
        let node_id = projection_id("gen-prompt", job_id, turn_key, "0");
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE canvas_nodes SET payload_json=json_set(payload_json,'$.status',?2,'$.provider_session_id',COALESCE(?3,json_extract(payload_json,'$.provider_session_id'))),updated_at=?4 WHERE id=?1 AND project_id=?5 AND thread_id=?6 AND kind='prompt'",
            params![node_id, status, provider_session_id, now, project_id, thread_id],
        )?;
        if changed > 0 {
            touch_canvas_tx(&tx, project_id, now)?;
            tx.execute(
                "UPDATE creative_threads SET updated_at=?2 WHERE id=?1",
                params![thread_id, now],
            )?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn complete_project_generation_turn(
        &self,
        project_id: &str,
        thread_id: &str,
        job_id: &str,
        turn_key: &str,
        provider_session_id: Option<&str>,
        assets: &[Asset],
    ) -> AppResult<Vec<String>> {
        let prompt_node_id = projection_id("gen-prompt", job_id, turn_key, "0");
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        verify_project_thread_tx(&tx, project_id, thread_id)?;
        let prompt = tx
            .query_row(
                "SELECT x,y,z_index FROM canvas_nodes WHERE id=?1 AND project_id=?2 AND thread_id=?3 AND kind='prompt'",
                params![prompt_node_id, project_id, thread_id],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, i64>(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("project prompt node {prompt_node_id}")))?;
        let workflow = placement::workflow(&tx, project_id)?;
        let owner = placement::generation_source(&workflow, job_id, &prompt_node_id);
        let source = placement::source(&workflow, job_id, false).map(placement::workflow_rect);
        let mut excluded = vec![prompt_node_id.as_str()];
        let snapshot = project_canvas_snapshot_tx(&tx, project_id)?;
        let first_gallery = owner.filter(|node| matches!(node["kind"].as_str(), Some("generation" | "comfy-video")))
            .filter(|node| node["activeSessionNodeId"].as_str().is_none_or(|id| id == prompt_node_id))
            .filter(|_| !assets.is_empty())
            .and_then(|node| {
            if !placement::generation_workflow_can_replace(node, &workflow, &snapshot) { return None; }
            let output_ids: std::collections::HashSet<_> = assets.iter()
                .map(|asset| projection_id("gen-output", job_id, turn_key, &asset.id)).collect();
            let already_delivered = snapshot.nodes.iter().any(|entry| output_ids.contains(&entry.id));
            let (anchor, has_product) = placement::generation_workflow_history(node, &snapshot);
            let video = node["kind"] == "comfy-video" || node["generation"]["media"] == "video";
            (!already_delivered && !has_product).then_some((node, if video { prompt_node_id.as_str() } else {
                anchor.map_or(prompt_node_id.as_str(), |anchor| anchor.id.as_str())
            }, video))
        });
        if let Some((node, anchor, _)) = first_gallery {
            excluded.extend(node["id"].as_str());
            excluded.push(anchor);
        }
        let mut occupied = placement::obstacles_in_snapshot(&snapshot, &workflow, &excluded, None);
        let sizes: Vec<_> = assets.iter().map(|asset| (190.0, asset_node_height(&asset_snapshot(asset)))).collect();
        let slots = placement::grid(&sizes);
        let start = if let Some((node, anchor, video)) = first_gallery {
            let source = placement::workflow_rect(node);
            let at = if video {
                (source.x, source.y)
            } else {
                let height = sizes[0].1 * 260.0 / sizes[0].0;
                placement::near(placement::Rect { x: source.x, y: source.y, width: 260.0, height }, &occupied, source.x)
            };
            tx.execute("UPDATE canvas_nodes SET x=?2,y=?3 WHERE id=?1", params![anchor, at.0, at.1])?;
            at
        } else {
            source.map_or((prompt.0 + 260.0 + 64.0, prompt.1), |s| (s.x + s.width + 64.0, s.y))
        };
        let mut node_ids = Vec::with_capacity(assets.len());
        for (index, asset) in assets.iter().enumerate() {
            let node_id = projection_id("gen-output", job_id, turn_key, &asset.id);
            let point = if first_gallery.is_some() && index == 0 { start } else {
                placement::near(placement::Rect { x: start.0 + slots[index].0, y: start.1 + slots[index].1,
                    width: sizes[index].0, height: sizes[index].1 }, &occupied, start.0)
            };
            occupied.push(placement::Rect {x:point.0,y:point.1,width:sizes[index].0,height:sizes[index].1});
            let snapshot = asset_snapshot(asset);
            let payload = serde_json::to_string(&AssetNodePayloadV1 {
                draft_document_id: None,
                workflow_source: None,
                workflow_generation_group: None,
                schema_version: 1,
                snapshot: snapshot.clone(),
                execution: Some(AssetExecutionRefV1 {
                    job_id: Some(job_id.to_string()),
                    turn_key: Some(turn_key.to_string()),
                    run_id: None,
                    artifact_id: None,
                }),
            })?;
            upsert_projection_node_tx(
                &tx,
                &NewCanvasNode {
                    id: node_id.clone(),
                    project_id: project_id.to_string(),
                    thread_id: Some(thread_id.to_string()),
                    kind: CreativeNodeKind::Asset,
                    asset_id: Some(asset.id.clone()),
                    role: Some(CreativeNodeRole::Output),
                    payload_json: payload,
                    x: point.0,
                    y: point.1,
                    width: 190.0,
                    height: asset_node_height(&snapshot),
                    z_index: prompt.2 + 1 + index as i64,
                    position_locked: false,
                },
                now,
            )?;
            insert_projection_edge_tx(
                &tx,
                &NewCanvasEdge {
                    id: projection_id("gen-edge", job_id, turn_key, &format!("produced-{index}")),
                    project_id: project_id.to_string(),
                    thread_id: thread_id.to_string(),
                    from_node_id: prompt_node_id.clone(),
                    to_node_id: node_id.clone(),
                    kind: CreativeEdgeKind::Produced,
                    ordinal: index as i64,
                },
                now,
            )?;
            node_ids.push(node_id);
        }
        tx.execute(
            "UPDATE canvas_nodes SET payload_json=json_set(payload_json,'$.status','done','$.provider_session_id',COALESCE(?2,json_extract(payload_json,'$.provider_session_id'))),updated_at=?3 WHERE id=?1",
            params![prompt_node_id, provider_session_id, now],
        )?;
        touch_canvas_tx(&tx, project_id, now)?;
        tx.execute(
            "UPDATE creative_threads SET updated_at=?2 WHERE id=?1",
            params![thread_id, now],
        )?;
        tx.commit()?;
        Ok(node_ids)
    }

    pub fn begin_project_agent_launch(
        &self,
        value: &ProjectAgentLaunchInput,
    ) -> AppResult<ProjectGenerationTurnGraph> {
        required(&value.project_id, "project id")?;
        required(&value.thread_id, "thread id")?;
        required(&value.launch_id, "agent launch id")?;
        required(&value.prompt, "agent prompt")?;
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        verify_project_thread_tx(&tx, &value.project_id, &value.thread_id)?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        let (max_right, max_z): (f64, i64) = tx.query_row(
            "SELECT COALESCE(MAX(x+width),0),COALESCE(MAX(z_index),0) FROM canvas_nodes WHERE project_id=?1 AND hidden_at IS NULL",
            [&value.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let prompt_x = max_right + 72.0;
        let prompt_y = 88.0;
        let prompt_node_id = projection_id("agent-prompt", &value.launch_id, "0", "0");
        let new_prompt = get_node_tx(&tx, &prompt_node_id)?.is_none();
        upsert_projection_node_tx(
            &tx,
            &NewCanvasNode {
                id: prompt_node_id.clone(),
                project_id: value.project_id.clone(),
                thread_id: Some(value.thread_id.clone()),
                kind: CreativeNodeKind::Prompt,
                asset_id: None,
                role: None,
                payload_json: serde_json::to_string(&PromptNodePayloadV1 {
                    schema_version: 1,
                    workflow_generation_group: None,
                    text: value.prompt.clone(),
                    applied_prompt: None,
                    provider: Some(value.provider.clone()),
                    provider_session_id: None,
                    job_id: None,
                    conversation_id: None,
                    turn_key: Some(value.launch_id.clone()),
                    ratio: value.ratio.clone(),
                    visual_profile: value.visual_profile.clone(),
                    status: Some("creating".into()),
                    reference_assets: vec![],
                })?,
                x: prompt_x,
                y: prompt_y,
                width: 260.0,
                height: 148.0,
                z_index: max_z + 1,
                position_locked: false,
            },
            now,
        )?;

        let parent_node_id = if let Some(explicit_node_id) = value.parent_node_id.as_deref() {
            let parent = exact_visible_parent_node_tx(
                &tx,
                &value.project_id,
                &value.thread_id,
                explicit_node_id,
            )?;
            if let Some(parent_asset_id) = value.parent_asset_id.as_deref() {
                if parent.asset_id.as_deref() != Some(parent_asset_id) {
                    return Err(invalid(format!(
                        "parent node {explicit_node_id} does not match parent asset {parent_asset_id}"
                    )));
                }
            }
            Some(parent.id)
        } else if let Some(parent_asset_id) = value.parent_asset_id.as_deref() {
            let parent = unique_visible_output_node_for_asset_tx(
                &tx,
                &value.project_id,
                &value.thread_id,
                parent_asset_id,
            )?
            .ok_or_else(|| invalid("agent parent asset is not an output of this thread"))?;
            Some(parent)
        } else {
            None
        };
        if let Some(parent) = parent_node_id.as_deref() {
            insert_projection_edge_tx(
                &tx,
                &NewCanvasEdge {
                    id: projection_id("agent-edge", &value.launch_id, "0", "parent"),
                    project_id: value.project_id.clone(),
                    thread_id: value.thread_id.clone(),
                    from_node_id: parent.to_string(),
                    to_node_id: prompt_node_id.clone(),
                    kind: CreativeEdgeKind::Continued,
                    ordinal: 0,
                },
                now,
            )?;
        }

        let mut reference_node_ids = Vec::new();
        let mut new_reference_ids = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (index, asset_id) in value.reference_asset_ids.iter().enumerate() {
            if !seen.insert(asset_id.as_str()) || value.parent_asset_id.as_deref() == Some(asset_id)
            {
                continue;
            }
            let snapshot = tx
                .query_row(
                    "SELECT name,width,height FROM assets WHERE id=?1",
                    [asset_id],
                    |row| {
                        Ok(AssetSnapshotV1 {
                            name: row.get(0)?,
                            width: row
                                .get::<_, Option<i64>>(1)?
                                .and_then(|value| u32::try_from(value).ok()),
                            height: row
                                .get::<_, Option<i64>>(2)?
                                .and_then(|value| u32::try_from(value).ok()),
                        })
                    },
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound(format!("asset {asset_id}")))?;
            let edge_id = projection_id(
                "agent-edge",
                &value.launch_id,
                "0",
                &format!("input-{index}"),
            );
            // Recovery retains the original source, including a subsequently hidden node.
            let existing_source: Option<String> = tx
                .query_row(
                    "SELECT from_node_id FROM canvas_edges WHERE id=?1",
                    [&edge_id],
                    |row| row.get(0),
                )
                .optional()?;
            let source = if existing_source.is_some() {
                existing_source
            } else if let Some(node_id) = value
                .reference_node_ids
                .get(index)
                .and_then(Option::as_deref)
            {
                let node = get_node_tx(&tx, node_id)?
                    .ok_or_else(|| AppError::NotFound(format!("reference node {node_id}")))?;
                if node.project_id != value.project_id
                    || node.hidden_at.is_some()
                    || node.kind != CreativeNodeKind::Asset
                    || node.role != Some(CreativeNodeRole::Reference)
                    || node.asset_id.as_deref() != Some(asset_id)
                {
                    return Err(invalid("invalid Agent canvas reference node"));
                }
                Some(node.id)
            } else {
                let mut statement = tx.prepare("SELECT id FROM canvas_nodes WHERE project_id=?1 AND kind='asset' AND role='reference' AND hidden_at IS NULL AND asset_id=?2 ORDER BY created_at,id LIMIT 1")?;
                let ids = statement
                    .query_map(params![value.project_id, asset_id], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                ids.into_iter().next()
            };
            let node_id = source.clone().unwrap_or_else(|| {
                projection_id("agent-reference", &value.launch_id, "0", &index.to_string())
            });
            if source.is_none() {
                if get_node_tx(&tx, &node_id)?.is_none() {
                    new_reference_ids.push(node_id.clone());
                }
                upsert_projection_node_tx(
                    &tx,
                    &NewCanvasNode {
                        id: node_id.clone(),
                        project_id: value.project_id.clone(),
                        thread_id: Some(value.thread_id.clone()),
                        kind: CreativeNodeKind::Asset,
                        asset_id: Some(asset_id.clone()),
                        role: Some(CreativeNodeRole::Reference),
                        payload_json: serde_json::to_string(&AssetNodePayloadV1 {
                            draft_document_id: None,
                            workflow_source: None,
                            workflow_generation_group: None,
                            schema_version: 1,
                            snapshot: snapshot.clone(),
                            execution: Some(AssetExecutionRefV1 {
                                job_id: None,
                                turn_key: None,
                                run_id: Some(value.launch_id.clone()),
                                artifact_id: None,
                            }),
                        })?,
                        x: (prompt_x - 230.0).max(24.0),
                        y: prompt_y + index as f64 * 340.0,
                        width: 190.0,
                        height: asset_node_height(&snapshot),
                        z_index: max_z + 2 + index as i64,
                        position_locked: false,
                    },
                    now,
                )?;
            }
            insert_projection_edge_tx(
                &tx,
                &NewCanvasEdge {
                    id: projection_id(
                        "agent-edge",
                        &value.launch_id,
                        "0",
                        &format!("input-{index}"),
                    ),
                    project_id: value.project_id.clone(),
                    thread_id: value.thread_id.clone(),
                    from_node_id: node_id.clone(),
                    to_node_id: prompt_node_id.clone(),
                    kind: CreativeEdgeKind::Input,
                    ordinal: index as i64,
                },
                now,
            )?;
            reference_node_ids.push(node_id);
        }
        if new_prompt {
            place_prompt_near_inputs_tx(
                &tx,
                &value.project_id,
                &prompt_node_id,
                &new_reference_ids,
            )?;
        }
        place_new_references_near_card_tx(
            &tx,
            &value.project_id,
            &prompt_node_id,
            &new_reference_ids,
            true,
        )?;
        tx.execute(
            "UPDATE creative_threads SET updated_at=?2 WHERE id=?1",
            params![value.thread_id, now],
        )?;
        tx.commit()?;
        Ok(ProjectGenerationTurnGraph {
            prompt_node_id,
            reference_node_ids,
            parent_node_id,
        })
    }

    pub fn update_project_agent_launch_status(
        &self,
        thread_id: &str,
        launch_id: &str,
        status: &str,
    ) -> AppResult<bool> {
        let node_id = projection_id("agent-prompt", launch_id, "0", "0");
        let now = Utc::now().timestamp();
        let conn = self.lock_conn()?;
        let project_id = conn
            .query_row(
                "SELECT project_id FROM creative_threads WHERE id=?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("creative thread {thread_id}")))?;
        let changed = conn.execute(
            "UPDATE canvas_nodes SET payload_json=json_set(payload_json,'$.status',?2),updated_at=?3 WHERE id=?1 AND project_id=?4 AND thread_id=?5 AND kind='prompt'",
            params![node_id, status, now, project_id, thread_id],
        )?;
        Ok(changed > 0)
    }

    pub fn project_agent_run_on_canvas(
        &self,
        project_id: &str,
        thread_id: &str,
        launch_id: &str,
        payload: &AgentGroupNodePayloadV1,
    ) -> AppResult<String> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        verify_project_thread_tx(&tx, project_id, thread_id)?;
        let prompt_node_id = projection_id("agent-prompt", launch_id, "0", "0");
        let (prompt_x, prompt_y, prompt_z) = tx
            .query_row(
                "SELECT x,y,z_index FROM canvas_nodes WHERE id=?1 AND project_id=?2 AND thread_id=?3 AND kind='prompt'",
                params![prompt_node_id, project_id, thread_id],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, i64>(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("agent prompt {prompt_node_id}")))?;
        if let Some(existing) = tx
            .query_row(
                "SELECT thread_id FROM thread_agent_links WHERE run_id=?1",
                [&payload.run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            if existing != thread_id {
                return Err(invalid("Agent Run already belongs to another thread"));
            }
        } else {
            tx.execute(
                "INSERT INTO thread_agent_links (thread_id,run_id,created_at) VALUES (?1,?2,?3)",
                params![thread_id, payload.run_id, now],
            )?;
        }
        let group_node_id = projection_id("agent-group", &payload.run_id, "0", "0");
        upsert_projection_node_tx(
            &tx,
            &NewCanvasNode {
                id: group_node_id.clone(),
                project_id: project_id.to_string(),
                thread_id: Some(thread_id.to_string()),
                kind: CreativeNodeKind::AgentGroup,
                asset_id: None,
                role: None,
                payload_json: serde_json::to_string(payload)?,
                x: prompt_x + 332.0,
                y: prompt_y - 18.0,
                width: 286.0,
                height: 184.0,
                z_index: prompt_z + 1,
                position_locked: false,
            },
            now,
        )?;
        insert_projection_edge_tx(
            &tx,
            &NewCanvasEdge {
                id: projection_id("agent-edge", &payload.run_id, "0", "run"),
                project_id: project_id.to_string(),
                thread_id: thread_id.to_string(),
                from_node_id: prompt_node_id.clone(),
                to_node_id: group_node_id.clone(),
                kind: CreativeEdgeKind::Input,
                ordinal: 0,
            },
            now,
        )?;
        tx.execute(
            "UPDATE canvas_nodes SET payload_json=json_set(payload_json,'$.status',?2),updated_at=?3 WHERE id=?1",
            params![prompt_node_id, payload.status, now],
        )?;
        touch_canvas_tx(&tx, project_id, now)?;
        tx.execute(
            "UPDATE creative_threads SET updated_at=?2 WHERE id=?1",
            params![thread_id, now],
        )?;
        tx.commit()?;
        Ok(group_node_id)
    }

    pub fn project_agent_artifact_on_canvas(
        &self,
        run_id: &str,
        artifact_id: &str,
        role: &str,
        ordinal: i64,
        asset: &Asset,
    ) -> AppResult<String> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (thread_id, project_id): (String, String) = tx
            .query_row(
                "SELECT l.thread_id,t.project_id FROM thread_agent_links l JOIN creative_threads t ON t.id=l.thread_id WHERE l.run_id=?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("Agent Run canvas link {run_id}")))?;
        let group_node_id = projection_id("agent-group", run_id, "0", "0");
        let (group_x, group_y, group_z) = tx
            .query_row(
                "SELECT x,y,z_index FROM canvas_nodes WHERE id=?1 AND project_id=?2 AND thread_id=?3 AND kind='agent_group'",
                params![group_node_id, project_id, thread_id],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, i64>(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("Agent group {group_node_id}")))?;
        let role_value = if matches!(
            role,
            "final" | "final_result" | "full_page_screenshot" | "viewport_screenshot"
        ) {
            CreativeNodeRole::Final
        } else {
            CreativeNodeRole::Intermediate
        };
        let snapshot = asset_snapshot(asset);
        let node_id = projection_id("agent-artifact", run_id, "0", artifact_id);
        let workflow = placement::workflow(&tx, &project_id)?;
        let source = placement::source(&workflow, run_id, true).map(placement::workflow_rect)
            .unwrap_or(placement::Rect { x:group_x,y:group_y,width:286.0,height:184.0 });
        let x = source.x + source.width + 64.0;
        let occupied = placement::obstacles(&tx, &project_id, &workflow, &[&node_id])?;
        let point = placement::near(placement::Rect { x:x + (ordinal.max(0) % 3) as f64 * 222.0,
            y:source.y, width:190.0,height:asset_node_height(&snapshot) }, &occupied, x);
        upsert_projection_node_tx(
            &tx,
            &NewCanvasNode {
                id: node_id.clone(),
                project_id: project_id.clone(),
                thread_id: Some(thread_id.clone()),
                kind: CreativeNodeKind::Asset,
                asset_id: Some(asset.id.clone()),
                role: Some(role_value),
                payload_json: serde_json::to_string(&AssetNodePayloadV1 {
                    draft_document_id: None,
                    workflow_source: None,
                    workflow_generation_group: None,
                    schema_version: 1,
                    snapshot: snapshot.clone(),
                    execution: Some(AssetExecutionRefV1 {
                        job_id: None,
                        turn_key: None,
                        run_id: Some(run_id.to_string()),
                        artifact_id: Some(artifact_id.to_string()),
                    }),
                })?,
                x: point.0,
                y: point.1,
                width: 190.0,
                height: asset_node_height(&snapshot),
                z_index: group_z + 1 + ordinal,
                position_locked: false,
            },
            now,
        )?;
        insert_projection_edge_tx(
            &tx,
            &NewCanvasEdge {
                id: projection_id(
                    "agent-edge",
                    run_id,
                    "0",
                    &format!("artifact-{artifact_id}"),
                ),
                project_id: project_id.clone(),
                thread_id: thread_id.clone(),
                from_node_id: group_node_id,
                to_node_id: node_id.clone(),
                kind: if role_value == CreativeNodeRole::Final {
                    CreativeEdgeKind::Produced
                } else {
                    CreativeEdgeKind::AgentStep
                },
                ordinal,
            },
            now,
        )?;
        touch_canvas_tx(&tx, &project_id, now)?;
        tx.execute(
            "UPDATE creative_threads SET updated_at=?2 WHERE id=?1",
            params![thread_id, now],
        )?;
        tx.commit()?;
        Ok(node_id)
    }

    pub fn link_thread_generation(
        &self,
        thread_id: &str,
        conversation_id: &str,
    ) -> AppResult<bool> {
        self.insert_thread_link(
            "thread_generation_links",
            "generation_conversation_id",
            thread_id,
            conversation_id,
        )
    }

    pub fn thread_for_generation(&self, conversation_id: &str) -> AppResult<Option<String>> {
        self.lookup_thread_link(
            "thread_generation_links",
            "generation_conversation_id",
            conversation_id,
        )
    }

    pub fn link_thread_agent(&self, thread_id: &str, run_id: &str) -> AppResult<bool> {
        self.insert_thread_link("thread_agent_links", "run_id", thread_id, run_id)
    }

    pub fn thread_for_agent(&self, run_id: &str) -> AppResult<Option<String>> {
        self.lookup_thread_link("thread_agent_links", "run_id", run_id)
    }

    fn insert_thread_link(
        &self,
        table: &'static str,
        key_column: &'static str,
        thread_id: &str,
        key: &str,
    ) -> AppResult<bool> {
        required(thread_id, "thread id")?;
        required(key, key_column)?;
        let now = Utc::now().timestamp();
        let conn = self.lock_conn()?;
        let select = format!("SELECT thread_id FROM {table} WHERE {key_column}=?1");
        if let Some(existing) = conn
            .query_row(&select, [key], |row| row.get::<_, String>(0))
            .optional()?
        {
            return if existing == thread_id {
                Ok(false)
            } else {
                Err(invalid(format!(
                    "{key_column} {key} is already linked to another creative thread"
                )))
            };
        }
        let insert =
            format!("INSERT INTO {table} (thread_id,{key_column},created_at) VALUES (?1,?2,?3)");
        conn.execute(&insert, params![thread_id, key, now])?;
        Ok(true)
    }

    fn lookup_thread_link(
        &self,
        table: &'static str,
        key_column: &'static str,
        key: &str,
    ) -> AppResult<Option<String>> {
        let conn = self.lock_conn()?;
        let sql = format!("SELECT thread_id FROM {table} WHERE {key_column}=?1");
        Ok(conn.query_row(&sql, [key], |row| row.get(0)).optional()?)
    }

}
