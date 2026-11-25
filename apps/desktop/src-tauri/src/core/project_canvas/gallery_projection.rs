//! Read-time gallery and conversation projection, plus visibility updates during removal.
use chrono::Utc;
use rusqlite::params;

use crate::{core::creative_session_contract::{CreativeNodeKind, CreativeNodeRole}, error::AppResult};

use super::CanvasNode;
use super::repository::{node_from_row, NODE_COLUMNS};

/// Hide every instance of a removed asset, retaining graph/history identities.
/// Call inside the same transaction that removes the asset or project membership.
pub(crate) fn hide_asset_canvas_nodes(
    conn: &rusqlite::Connection,
    asset_id: &str,
    project_id: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE canvas_nodes SET hidden_at = ?3, updated_at = ?3
         WHERE asset_id = ?1 AND (?2 IS NULL OR project_id = ?2) AND hidden_at IS NULL",
        params![asset_id, project_id, Utc::now().timestamp()],
    )?;
    Ok(())
}

/// Recycled/missing originals keep their asset records, but no visible canvas instances.
/// Share the caller's transaction so a failed recycle also rolls back visibility.
pub(crate) fn hide_removed_original_canvas_nodes(conn: &rusqlite::Connection, path: &str) -> AppResult<()> {
    let mut statement = conn.prepare(
        "SELECT asset_id FROM trashed_asset_originals WHERE path=?1 UNION SELECT asset_id FROM removed_missing_asset_originals WHERE path=?1")?;
    let ids = statement.query_map([path], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        hide_empty_generation_cards_for_asset(conn, &id, None)?;
        hide_asset_canvas_nodes(conn, &id, None)?;
    }
    Ok(())
}

/// Removing the last saved output also removes its generation card from the canvas.
/// Run before deleting the asset row (which clears node asset IDs), in the same transaction.
/// Keep execution nodes/edges for recovery and audit; other turns and reference users survive.
pub(crate) fn hide_empty_generation_cards_for_asset(
    conn: &rusqlite::Connection,
    asset_id: &str,
    project_id: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "UPDATE canvas_nodes AS prompt SET hidden_at = ?2, updated_at = ?2
         WHERE prompt.kind = 'prompt' AND prompt.hidden_at IS NULL
           AND (?3 IS NULL OR prompt.project_id = ?3)
           AND json_extract(prompt.payload_json, '$.job_id') IS NOT NULL
           AND prompt.id IN (
               SELECT e.from_node_id FROM canvas_nodes output JOIN canvas_edges e ON output.id = e.to_node_id
               WHERE e.kind = 'produced'
                 AND output.kind = 'asset' AND output.role = 'output' AND output.asset_id = ?1
           )
           AND NOT EXISTS (
               SELECT 1 FROM canvas_edges e JOIN canvas_nodes output ON output.id = e.to_node_id
               JOIN assets a ON a.id = output.asset_id
               WHERE e.from_node_id = prompt.id AND e.kind = 'produced'
                 AND output.kind = 'asset' AND output.role = 'output' AND a.id <> ?1
                 AND (?3 IS NULL OR output.hidden_at IS NULL)
                 AND NOT EXISTS(SELECT 1 FROM trashed_asset_originals t WHERE t.asset_id=a.id)
                 AND NOT EXISTS(SELECT 1 FROM removed_missing_asset_originals m WHERE m.asset_id=a.id)
           )",
        params![asset_id, Utc::now().timestamp(), project_id],
    )?;
    Ok(())
}

fn has_persisted_gallery_key(payload: &str) -> bool {
    const KEY: &str = "generation_gallery_key";
    payload.split('"').any(|part| {
        // Every character of this ASCII key can also use a six-byte JSON escape.
        (KEY.len()..=KEY.len() * 6).contains(&part.len())
            && (part == KEY || part.as_bytes().contains(&b'\\') && part.contains("\\u"))
    })
}

// Older prompt snapshots predate conversation_id. Enrich reads from their exact
// output assets so grouping survives a restart without rewriting saved nodes.
pub(in crate::core) fn restore_canvas_conversations(conn: &rusqlite::Connection, project_id: &str, nodes: &mut [CanvasNode]) -> AppResult<()> {
    use serde_json::Value;
    use std::collections::{HashMap, HashSet};

    let mut workflow_stmt = conn.prepare(&format!("WITH {} SELECT node_id,group_key FROM canvas_generation_groups WHERE project_id=?1", crate::core::generation_gallery::WORKFLOW_GALLERY_CTE))?;
    let workflow_groups = workflow_stmt.query_map([project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
    let mut stmt = conn.prepare("SELECT n.id,a.ext,json_extract(n.payload_json,'$.execution.job_id'),g.conversation_id FROM canvas_nodes n JOIN assets a ON a.id=n.asset_id LEFT JOIN generation_conversations g ON g.session_id=a.generation_session_id WHERE n.project_id=?1 AND n.kind='asset' AND n.role='output'")?;
    let mut outputs = std::collections::HashMap::new();
    let mut conversations = std::collections::HashMap::new();
    let mut rows = stmt.query([project_id])?;
    while let Some(row) = rows.next()? {
        if let Some(ext) = row.get::<_, Option<String>>(1)? {
            outputs.insert(row.get::<_, String>(0)?, crate::media::probe::is_video(&ext));
        }
        if let (Some(job), Some(conversation)) = (row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?) {
            conversations.insert(job, conversation);
        }
    }
    let has_gallery_edits: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM generation_gallery_separations)
             OR EXISTS(SELECT 1 FROM generation_gallery_merges)",
        [], |row| row.get(0),
    )?;
    let (merged, dissolved, asset_groups) = if has_gallery_edits {
        // The global tables also contain catalog edits for other projects.
        // Resolve only keys that can appear in this project's projections.
        let source_keys = serde_json::to_string(&workflow_groups.values().cloned()
            .chain(conversations.values().map(|id| format!("generation:{id}"))).collect::<Vec<_>>())?;
        let eligible_sources = HashSet::<String>::from_iter(
            conn.prepare_cached(
                "SELECT value FROM json_each(?2)
                 UNION SELECT 'node:'||id FROM canvas_nodes WHERE project_id=?1
                 UNION SELECT 'generation:'||json_extract(payload_json,'$.conversation_id')
                       FROM canvas_nodes WHERE project_id=?1 AND kind='prompt'
                         AND json_type(payload_json,'$.conversation_id')='text'
                 UNION SELECT 'generation:'||json_extract(payload_json,'$.job_id')
                       FROM canvas_nodes WHERE project_id=?1 AND kind='prompt'
                         AND json_type(payload_json,'$.job_id')='text'",
            )?.query_map(params![project_id, source_keys], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?,
        );
        let source_keys = serde_json::to_string(&eligible_sources)?;
        let merged = conn.prepare_cached(
            "SELECT m.source_key,m.group_key FROM json_each(?1) candidate
             JOIN generation_gallery_merges m ON m.source_key=candidate.value",
        )?.query_map([source_keys], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?)))?
            .collect::<Result<HashMap<_, _>, _>>()?;
        let mut assets_stmt = conn.prepare(&format!("WITH {} SELECT n.id,{} FROM canvas_nodes n JOIN assets a ON a.id=n.asset_id WHERE n.project_id=?1 AND {}",
            crate::core::generation_gallery::WORKFLOW_GALLERY_CTE, crate::core::catalog_browser::generation_resolved_group(), crate::core::catalog_browser::gallery_eligible()))?;
        let asset_groups = assets_stmt.query_map([project_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()?;
        let visible_keys = serde_json::to_string(&eligible_sources.iter().chain(merged.values()).chain(asset_groups.values())
            .collect::<HashSet<_>>())?;
        let dissolved = conn.prepare_cached(
            "SELECT s.group_key FROM json_each(?1) candidate
             JOIN generation_gallery_separations s ON s.group_key=candidate.value",
        )?.query_map([visible_keys], |row| row.get::<_, String>(0))?
            .collect::<Result<HashSet<_>, _>>()?;
        (merged, dissolved, asset_groups)
    } else {
        Default::default()
    };
    for node in nodes {
        node.output_is_video = outputs.get(&node.id).copied();
        let workflow_group = workflow_groups.get(&node.id);
        let selected_group = if merged.is_empty() { None } else { merged.get(&format!("node:{}", node.id)) };
        let asset_group = asset_groups.get(&node.id);
        // Most large notes have neither persisted gallery metadata nor a gallery projection.
        if workflow_group.is_none() && selected_group.is_none() && asset_group.is_none()
            && node.kind != CreativeNodeKind::Prompt
            && !has_persisted_gallery_key(&node.payload_json)
        {
            continue;
        }
        let mut payload: Value = serde_json::from_str(&node.payload_json)?;
        let Some(fields) = payload.as_object_mut() else { continue; };
        let mut dirty = false;
        if fields.get("generation_gallery_key").and_then(Value::as_str).is_some_and(|key| key.starts_with("manual:")) {
            for key in ["generation_gallery_key", "workflow_generation_group", "generation_group_dissolved", "manual_gallery_node"] {
                fields.remove(key);
            }
            dirty = true;
        }
        if let Some(group) = workflow_group {
            fields.insert("workflow_generation_group".into(), group.clone().into());
            dirty = true;
        }
        if node.kind == CreativeNodeKind::Prompt && fields.get("conversation_id").and_then(Value::as_str).is_none() {
            if let Some(conversation) = fields.get("job_id").and_then(Value::as_str).and_then(|job| conversations.get(job)) {
                fields.insert("conversation_id".into(), conversation.clone().into());
                dirty = true;
            }
        }
        let prompt_group = if node.kind == CreativeNodeKind::Prompt && has_gallery_edits && selected_group.is_none() && asset_group.is_none() {
            workflow_group.filter(|key| !key.starts_with("asset:")).cloned().or_else(|| {
                fields.get("conversation_id").and_then(Value::as_str)
                    .or_else(|| fields.get("job_id").and_then(Value::as_str))
                    .map(|id| format!("generation:{id}"))
            })
        } else {
            None
        };
        let key = selected_group.or(asset_group)
            .or_else(|| prompt_group.as_ref().map(|group| merged.get(group).unwrap_or(group)));
        if let Some(key) = key {
            if dissolved.contains(key) {
                fields.insert("generation_group_dissolved".into(), true.into());
                fields.insert("generation_gallery_key".into(), key.clone().into());
                dirty = true;
            } else if key.starts_with("manual:") {
                fields.insert("workflow_generation_group".into(), key.clone().into());
                fields.insert("generation_gallery_key".into(), key.clone().into());
                if selected_group.is_some() {
                    fields.insert("manual_gallery_node".into(), true.into());
                }
                fields.remove("generation_group_dissolved");
                dirty = true;
            }
        }
        if dirty {
            node.payload_json = serde_json::to_string(&payload)?;
        }
    }
    Ok(())
}

// Unfold only overlapping original production nodes; copied/grouped/locked nodes
// retain their placement. Persist positions in the same transaction as the preference.
pub(in crate::core) fn separate_generation_gallery(conn: &rusqlite::Connection, key: &str) -> AppResult<()> {
    let generation_group = crate::core::catalog_browser::generation_resolved_group();
    use crate::core::generation_gallery::WORKFLOW_GALLERY_CTE;
    let mut stmt = conn.prepare(&format!("WITH {WORKFLOW_GALLERY_CTE} SELECT DISTINCT project_id FROM canvas_nodes WHERE
        asset_id IN (SELECT a.id FROM assets a WHERE {generation_group}=?1)
        OR id IN (SELECT node_id FROM canvas_generation_groups WHERE group_key=?1)
        OR (kind='prompt' AND 'generation:'||COALESCE(json_extract(payload_json,'$.conversation_id'),json_extract(payload_json,'$.job_id'))=?1)"))?;
    let projects = stmt.query_map([key], |row| row.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    for project in projects {
        let mut stmt = conn.prepare(&format!("SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE project_id=?1 AND hidden_at IS NULL ORDER BY created_at,id"))?;
        let mut nodes = stmt.query_map([&project], node_from_row)?.collect::<Result<Vec<_>, _>>()?;
        restore_canvas_conversations(conn, &project, &mut nodes)?;
        let grouped = conn.prepare("SELECT node_id FROM canvas_group_items WHERE project_id=?1")?.query_map([&project], |row| row.get::<_, String>(0))?
            .collect::<Result<std::collections::HashSet<_>, _>>()?;
        let members: Vec<_> = nodes.iter().filter(|node| {
            let payload: serde_json::Value = serde_json::from_str(&node.payload_json).unwrap_or_default();
            payload["generation_gallery_key"].as_str() == Some(key) && !grouped.contains(&node.id)
                && (node.kind == CreativeNodeKind::Prompt || matches!(node.role, Some(CreativeNodeRole::Output | CreativeNodeRole::Final)))
        }).collect();
        let ids: std::collections::HashSet<_> = members.iter().map(|node| &node.id).collect();
        let mut occupied: Vec<_> = nodes.iter().filter(|node| !ids.contains(&node.id) && node.kind != CreativeNodeKind::Note)
            .map(|node| (node.x, node.y, node.width, node.height)).collect();
        for (index, node) in members.iter().enumerate() {
            let mut x = node.x;
            let height = if node.kind == CreativeNodeKind::Prompt { node.height.max(148.0) } else { node.height };
            if index > 0 && !node.position_locked {
                while let Some(right) = occupied.iter().filter(|(left, top, width, h)|
                    x < left + width + 24.0 && x + node.width + 24.0 > *left && node.y < top + h + 24.0 && node.y + height + 24.0 > *top)
                    .map(|(left, _, width, _)| left + width + 24.0).max_by(f64::total_cmp) { x = right; }
            }
            if x != node.x { conn.execute("UPDATE canvas_nodes SET x=?1,updated_at=?2 WHERE id=?3", params![x, Utc::now().timestamp(), node.id])?; }
            occupied.push((x, node.y, node.width, height));
        }
    }
    Ok(())
}
