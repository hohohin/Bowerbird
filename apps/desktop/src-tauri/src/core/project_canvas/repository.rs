//! Canvas repository and transactional node, group, edge and viewport writes.
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Row, Transaction, TransactionBehavior};

use crate::core::creative_session_contract::{
    edge_endpoints_are_valid, parse_node_payload, project_canvas_node_requires_thread, validate_node_kind_role,
    AssetNodePayloadV1, CanvasNoteType, CreativeEdgeKind, CreativeGroupRole, CreativeNodeKind, CreativeNodePayload, CreativeNodeRole,
    CreativeThreadOrigin,
};
use crate::{core::library::Asset, db::Database, error::{AppError, AppResult}};

use super::{placement, types::*, note_assets::record_image_container_assets, gallery_projection::restore_canvas_conversations};
use super::execution_projection::{asset_node_height, asset_snapshot};

pub(super) fn invalid(message: impl Into<String>) -> AppError {
    AppError::Other(format!("project canvas: {}", message.into()))
}

pub(super) fn required(value: &str, field: &str) -> AppResult<()> {
    if value.trim().is_empty() {
        Err(invalid(format!("{field} must not be empty")))
    } else {
        Ok(())
    }
}

fn validate_draft_json(value: &str) -> AppResult<()> {
    let value: serde_json::Value = serde_json::from_str(value)?;
    if value.get("schema_version").and_then(|value| value.as_u64())
        != Some(PROJECT_CANVAS_DRAFT_SCHEMA_VERSION)
    {
        return Err(invalid("draft_json must use schema_version 1"));
    }
    Ok(())
}

fn validate_geometry(x: f64, y: f64, width: f64, height: f64) -> AppResult<()> {
    if !x.is_finite() || !y.is_finite() || !width.is_finite() || !height.is_finite() {
        return Err(invalid("geometry must contain only finite numbers"));
    }
    if width <= 0.0 || height <= 0.0 {
        return Err(invalid("geometry width and height must be positive"));
    }
    Ok(())
}

fn title_source_sql(value: ProjectTitleSource) -> &'static str {
    match value {
        ProjectTitleSource::Default => "default",
        ProjectTitleSource::FirstPrompt => "first_prompt",
        ProjectTitleSource::Manual => "manual",
    }
}

fn thread_origin_sql(value: CreativeThreadOrigin) -> &'static str {
    match value {
        CreativeThreadOrigin::Direct => "direct",
        CreativeThreadOrigin::GenerationBackfill => "generation_backfill",
        CreativeThreadOrigin::AgentBackfill => "agent_backfill",
        CreativeThreadOrigin::MergedLegacy => "merged_legacy",
    }
}

fn thread_origin_from_sql(value: String) -> rusqlite::Result<CreativeThreadOrigin> {
    match value.as_str() {
        "direct" => Ok(CreativeThreadOrigin::Direct),
        "generation_backfill" => Ok(CreativeThreadOrigin::GenerationBackfill),
        "agent_backfill" => Ok(CreativeThreadOrigin::AgentBackfill),
        "merged_legacy" => Ok(CreativeThreadOrigin::MergedLegacy),
        _ => Err(invalid_column("thread origin", value)),
    }
}

fn node_kind_sql(value: CreativeNodeKind) -> &'static str {
    match value {
        CreativeNodeKind::Asset => "asset",
        CreativeNodeKind::Prompt => "prompt",
        CreativeNodeKind::AgentGroup => "agent_group",
        CreativeNodeKind::Note => "note",
    }
}

fn node_kind_from_sql(value: String) -> rusqlite::Result<CreativeNodeKind> {
    match value.as_str() {
        "asset" => Ok(CreativeNodeKind::Asset),
        "prompt" => Ok(CreativeNodeKind::Prompt),
        "agent_group" => Ok(CreativeNodeKind::AgentGroup),
        "note" => Ok(CreativeNodeKind::Note),
        _ => Err(invalid_column("node kind", value)),
    }
}

fn node_role_sql(value: CreativeNodeRole) -> &'static str {
    match value {
        CreativeNodeRole::Reference => "reference",
        CreativeNodeRole::Output => "output",
        CreativeNodeRole::Intermediate => "intermediate",
        CreativeNodeRole::Final => "final",
    }
}

fn node_role_from_sql(value: String) -> rusqlite::Result<CreativeNodeRole> {
    match value.as_str() {
        "reference" => Ok(CreativeNodeRole::Reference),
        "output" => Ok(CreativeNodeRole::Output),
        "intermediate" => Ok(CreativeNodeRole::Intermediate),
        "final" => Ok(CreativeNodeRole::Final),
        _ => Err(invalid_column("node role", value)),
    }
}

fn group_role_sql(value: CreativeGroupRole) -> &'static str {
    match value {
        CreativeGroupRole::Base => "base",
        CreativeGroupRole::Style => "style",
        CreativeGroupRole::Composition => "composition",
        CreativeGroupRole::Candidate => "candidate",
        CreativeGroupRole::Rejected => "rejected",
    }
}

fn group_role_from_sql(value: String) -> rusqlite::Result<CreativeGroupRole> {
    match value.as_str() {
        "base" => Ok(CreativeGroupRole::Base),
        "style" => Ok(CreativeGroupRole::Style),
        "composition" => Ok(CreativeGroupRole::Composition),
        "candidate" => Ok(CreativeGroupRole::Candidate),
        "rejected" => Ok(CreativeGroupRole::Rejected),
        _ => Err(invalid_column("group role", value)),
    }
}

pub(super) fn edge_kind_sql(value: CreativeEdgeKind) -> &'static str {
    match value {
        CreativeEdgeKind::Input => "input",
        CreativeEdgeKind::Produced => "produced",
        CreativeEdgeKind::Continued => "continued",
        CreativeEdgeKind::Retry => "retry",
        CreativeEdgeKind::Branch => "branch",
        CreativeEdgeKind::AgentStep => "agent_step",
    }
}

fn edge_kind_from_sql(value: String) -> rusqlite::Result<CreativeEdgeKind> {
    match value.as_str() {
        "input" => Ok(CreativeEdgeKind::Input),
        "produced" => Ok(CreativeEdgeKind::Produced),
        "continued" => Ok(CreativeEdgeKind::Continued),
        "retry" => Ok(CreativeEdgeKind::Retry),
        "branch" => Ok(CreativeEdgeKind::Branch),
        "agent_step" => Ok(CreativeEdgeKind::AgentStep),
        _ => Err(invalid_column("edge kind", value)),
    }
}

fn view_mode_sql(value: ProjectCanvasViewMode) -> &'static str {
    match value {
        ProjectCanvasViewMode::Canvas => "canvas",
        ProjectCanvasViewMode::Timeline => "timeline",
    }
}

fn view_mode_from_sql(value: String) -> rusqlite::Result<ProjectCanvasViewMode> {
    match value.as_str() {
        "canvas" => Ok(ProjectCanvasViewMode::Canvas),
        "timeline" => Ok(ProjectCanvasViewMode::Timeline),
        _ => Err(invalid_column("view mode", value)),
    }
}

fn timeline_scope_sql(value: ProjectTimelineScope) -> &'static str {
    match value {
        ProjectTimelineScope::Focused => "focused",
        ProjectTimelineScope::All => "all",
    }
}

fn timeline_scope_from_sql(value: String) -> rusqlite::Result<ProjectTimelineScope> {
    match value.as_str() {
        "focused" => Ok(ProjectTimelineScope::Focused),
        "all" => Ok(ProjectTimelineScope::All),
        _ => Err(invalid_column("timeline scope", value)),
    }
}

fn invalid_column(field: &'static str, value: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("invalid {field}: {value}"),
        )),
    )
}

fn canvas_from_row(row: &Row<'_>) -> rusqlite::Result<ProjectCanvas> {
    Ok(ProjectCanvas {
        project_id: row.get(0)?,
        draft_json: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn thread_from_row(row: &Row<'_>) -> rusqlite::Result<CreativeThread> {
    Ok(CreativeThread {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        origin: thread_origin_from_sql(row.get(3)?)?,
        archived_at: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const THREAD_COLUMNS: &str = "id,project_id,title,origin,archived_at,created_at,updated_at";

pub(super) fn node_from_row(row: &Row<'_>) -> rusqlite::Result<CanvasNode> {
    Ok(CanvasNode {
        id: row.get(0)?,
        project_id: row.get(1)?,
        thread_id: row.get(2)?,
        kind: node_kind_from_sql(row.get(3)?)?,
        asset_id: row.get(4)?,
        role: row
            .get::<_, Option<String>>(5)?
            .map(node_role_from_sql)
            .transpose()?,
        output_is_video: None,
        payload_json: row.get(6)?,
        x: row.get(7)?,
        y: row.get(8)?,
        width: row.get(9)?,
        height: row.get(10)?,
        z_index: row.get(11)?,
        position_locked: row.get::<_, i64>(12)? != 0,
        hidden_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

pub(super) const NODE_COLUMNS: &str = "id,project_id,thread_id,kind,asset_id,role,payload_json,x,y,width,height,z_index,position_locked,hidden_at,created_at,updated_at";

fn group_from_row(row: &Row<'_>) -> rusqlite::Result<CanvasGroup> {
    Ok(CanvasGroup {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        role: row
            .get::<_, Option<String>>(3)?
            .map(group_role_from_sql)
            .transpose()?,
        x: row.get(4)?,
        y: row.get(5)?,
        width: row.get(6)?,
        height: row.get(7)?,
        z_index: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

const GROUP_COLUMNS: &str =
    "id,project_id,name,role,x,y,width,height,z_index,created_at,updated_at";

pub(super) fn edge_from_row(row: &Row<'_>) -> rusqlite::Result<CanvasEdge> {
    Ok(CanvasEdge {
        id: row.get(0)?,
        project_id: row.get(1)?,
        thread_id: row.get(2)?,
        from_node_id: row.get(3)?,
        to_node_id: row.get(4)?,
        kind: edge_kind_from_sql(row.get(5)?)?,
        ordinal: row.get(6)?,
        created_at: row.get(7)?,
    })
}

pub(super) const EDGE_COLUMNS: &str =
    "id,project_id,thread_id,from_node_id,to_node_id,kind,ordinal,created_at";

fn view_from_row(row: &Row<'_>) -> rusqlite::Result<CanvasView> {
    Ok(CanvasView {
        project_id: row.get(0)?,
        pan_x: row.get(1)?,
        pan_y: row.get(2)?,
        zoom: row.get(3)?,
        source_panel_width: row.get(4)?,
        active_node_id: row.get(5)?,
        focused_thread_id: row.get(6)?,
        view_mode: view_mode_from_sql(row.get(7)?)?,
        timeline_scope: timeline_scope_from_sql(row.get(8)?)?,
        updated_at: row.get(9)?,
    })
}

pub(super) fn get_node_tx(tx: &Transaction<'_>, node_id: &str) -> AppResult<Option<CanvasNode>> {
    let sql = format!("SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE id=?1");
    Ok(tx.query_row(&sql, [node_id], node_from_row).optional()?)
}

pub(crate) fn touch_canvas_tx(tx: &Transaction<'_>, project_id: &str, now: i64) -> AppResult<()> {
    let changed = tx.execute(
        "UPDATE project_canvases SET updated_at=?2 WHERE project_id=?1",
        params![project_id, now],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound(format!("project canvas {project_id}")));
    }
    tx.execute(
        "UPDATE projects SET updated_at=?2 WHERE id=?1",
        params![project_id, now],
    )?;
    Ok(())
}

fn validate_new_node(value: &NewCanvasNode) -> AppResult<CreativeNodePayload> {
    required(&value.id, "node id")?;
    required(&value.project_id, "project id")?;
    validate_node_kind_role(&value.id, value.kind, value.role)
        .map_err(|error| invalid(error.to_string()))?;
    if value.kind != CreativeNodeKind::Asset && value.asset_id.is_some() {
        return Err(invalid("only asset nodes may carry asset_id"));
    }
    if project_canvas_node_requires_thread(value.kind, value.role) && value.thread_id.is_none() {
        return Err(invalid(format!(
            "node {} requires a creative thread",
            value.id
        )));
    }
    let payload = parse_node_payload(value.kind, &value.payload_json)
        .map_err(|error| invalid(error.to_string()))?;
    if matches!(&payload, CreativeNodePayload::Note(note) if note.note_type == Some(CanvasNoteType::Chat)) {
        return Err(invalid("chat cards must be created by the chat runtime"));
    }
    validate_geometry(value.x, value.y, value.width, value.height)?;
    Ok(payload)
}

pub(crate) fn insert_node_tx(tx: &Transaction<'_>, value: &NewCanvasNode, now: i64) -> AppResult<CanvasNode> {
    let payload = validate_new_node(value)?;
    if let Some(existing) = get_node_tx(tx, &value.id)? {
        let same = existing.project_id == value.project_id
            && existing.thread_id == value.thread_id
            && existing.kind == value.kind
            && existing.asset_id == value.asset_id
            && existing.role == value.role
            && existing.payload_json == value.payload_json
            && existing.x == value.x
            && existing.y == value.y
            && existing.width == value.width
            && existing.height == value.height
            && existing.z_index == value.z_index
            && existing.position_locked == value.position_locked
            && existing.hidden_at.is_none();
        return if same {
            Ok(existing)
        } else {
            Err(invalid(format!(
                "stable node id {} replayed with different content",
                value.id
            )))
        };
    }
    if let Some(asset_id) = value.asset_id.as_deref() {
        tx.execute(
            "INSERT OR IGNORE INTO project_assets (project_id,asset_id,created_at) VALUES (?1,?2,?3)",
            params![value.project_id, asset_id, now],
        )?;
    }
    if let CreativeNodePayload::Note(note) = &payload {
        record_image_container_assets(tx, &value.project_id, note, None, now)?;
    }
    tx.execute(
        "INSERT INTO canvas_nodes (id,project_id,thread_id,kind,asset_id,role,payload_json,x,y,width,height,z_index,position_locked,hidden_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,?14,?14)",
        params![value.id, value.project_id, value.thread_id, node_kind_sql(value.kind), value.asset_id, value.role.map(node_role_sql), value.payload_json, value.x, value.y, value.width, value.height, value.z_index, i64::from(value.position_locked), now],
    )?;
    get_node_tx(tx, &value.id)?.ok_or_else(|| invalid("inserted node was not found"))
}

pub(super) fn edge_threads_are_valid(value: &NewCanvasEdge, from: &CanvasNode, to: &CanvasNode) -> bool {
    let shared_reference = value.kind == CreativeEdgeKind::Input
        && from.kind == CreativeNodeKind::Asset;
    (shared_reference
        || from
            .thread_id
            .as_deref()
            .is_none_or(|id| id == value.thread_id))
        && to
            .thread_id
            .as_deref()
            .is_none_or(|id| id == value.thread_id)
}

fn node_is_execution_owned(node: &CanvasNode) -> bool {
    match node.kind {
        CreativeNodeKind::Prompt | CreativeNodeKind::AgentGroup => true,
        CreativeNodeKind::Note => matches!(parse_node_payload(node.kind, &node.payload_json),
            Ok(CreativeNodePayload::Note(payload)) if payload.note_type == Some(crate::core::creative_session_contract::CanvasNoteType::Chat)),
        CreativeNodeKind::Asset => {
            if node.role != Some(CreativeNodeRole::Reference) {
                return true;
            }
            matches!(
                parse_node_payload(node.kind, &node.payload_json),
                Ok(CreativeNodePayload::Asset(payload)) if payload.execution.is_some()
            )
        }
    }
}

fn ensure_project_canvas_tx(tx: &Transaction<'_>, project_id: &str, now: i64) -> AppResult<()> {
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
        [project_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(AppError::NotFound(format!("project {project_id}")));
    }
    tx.execute(
        "INSERT OR IGNORE INTO project_canvases (project_id,draft_json,created_at,updated_at) VALUES (?1,'{\"schema_version\":1}',?2,?2)",
        params![project_id, now],
    )?;
    Ok(())
}

fn touch_project_opened_tx(tx: &Transaction<'_>, project_id: &str, now: i64) -> AppResult<bool> {
    let changed = tx.execute(
        "UPDATE projects SET last_opened_at=?2,updated_at=COALESCE(updated_at,?2) WHERE id=?1",
        params![project_id, now],
    )?;
    if changed > 0 {
        tx.execute(
            "UPDATE project_canvases SET updated_at=updated_at WHERE project_id=?1",
            [project_id],
        )?;
    }
    Ok(changed > 0)
}

pub(super) fn project_canvas_snapshot_tx(
    tx: &Transaction<'_>,
    project_id: &str,
) -> AppResult<ProjectCanvasSnapshot> {
    let canvas = tx
        .query_row(
            "SELECT project_id,draft_json,created_at,updated_at FROM project_canvases WHERE project_id=?1",
            [project_id],
            canvas_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("project canvas {project_id}")))?;
    let threads = {
        let mut statement = tx.prepare(&format!(
            "SELECT {THREAD_COLUMNS} FROM creative_threads WHERE project_id=?1 ORDER BY created_at,id"
        ))?;
        let rows = statement.query_map([project_id], thread_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?
    };
    let mut nodes = {
        let mut statement = tx.prepare(&format!(
            "SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE project_id=?1 ORDER BY z_index,created_at,id"
        ))?;
        let rows = statement.query_map([project_id], node_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?
    };
    restore_canvas_conversations(tx, project_id, &mut nodes)?;
    let groups = {
        let mut statement = tx.prepare(&format!(
            "SELECT {GROUP_COLUMNS} FROM canvas_groups WHERE project_id=?1 ORDER BY z_index,created_at,id"
        ))?;
        let rows = statement.query_map([project_id], group_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?
    };
    let group_items = {
        let mut statement = tx.prepare(
            "SELECT project_id,group_id,node_id,ordinal FROM canvas_group_items WHERE project_id=?1 ORDER BY group_id,ordinal,node_id",
        )?;
        let rows = statement.query_map([project_id], |row| {
            Ok(CanvasGroupItem {
                project_id: row.get(0)?,
                group_id: row.get(1)?,
                node_id: row.get(2)?,
                ordinal: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?
    };
    let edges = {
        let mut statement = tx.prepare(&format!(
            "SELECT {EDGE_COLUMNS} FROM canvas_edges WHERE project_id=?1 ORDER BY created_at,ordinal,id"
        ))?;
        let rows = statement.query_map([project_id], edge_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?
    };
    let view = tx
        .query_row(
            "SELECT project_id,pan_x,pan_y,zoom,source_panel_width,active_node_id,focused_thread_id,view_mode,timeline_scope,updated_at FROM canvas_views WHERE project_id=?1",
            [project_id],
            view_from_row,
        )
        .optional()?;

    Ok(ProjectCanvasSnapshot {
        canvas,
        threads,
        nodes,
        groups,
        group_items,
        edges,
        view,
    })
}

impl Database {
    pub fn get_project_canvas(&self, project_id: &str) -> AppResult<Option<ProjectCanvas>> {
        let conn = self.lock_conn()?;
        Ok(conn
            .query_row(
                "SELECT project_id,draft_json,created_at,updated_at FROM project_canvases WHERE project_id=?1",
                [project_id],
                canvas_from_row,
            )
            .optional()?)
    }

    pub fn ensure_project_canvas(&self, project_id: &str) -> AppResult<ProjectCanvas> {
        required(project_id, "project id")?;
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_project_canvas_tx(&tx, project_id, now)?;
        let canvas = tx.query_row(
            "SELECT project_id,draft_json,created_at,updated_at FROM project_canvases WHERE project_id=?1",
            [project_id],
            canvas_from_row,
        )?;
        tx.commit()?;
        Ok(canvas)
    }

    pub fn open_project_canvas_scope(&self, project_id: &str) -> AppResult<()> {
        required(project_id, "project id")?;
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_project_canvas_tx(&tx, project_id, now)?;
        touch_project_opened_tx(&tx, project_id, now)?;
        tx.commit()?;
        Ok(())
    }

    pub fn materialize_project_canvas(
        &self,
        value: &ProjectCanvasMaterializeInput,
        initial_threads: &[NewCreativeThread],
        initial_nodes: &[NewCanvasNode],
        initial_view: Option<&CanvasViewInput>,
    ) -> AppResult<ProjectCanvas> {
        required(&value.project_id, "project id")?;
        required(&value.name, "project name")?;
        required(&value.workspace_path, "workspace path")?;
        required(&value.workspace_key, "workspace key")?;
        required(&value.kind, "project kind")?;
        validate_draft_json(&value.draft_json)?;
        if initial_nodes
            .iter()
            .any(|node| node.project_id != value.project_id)
        {
            return Err(invalid("initial node belongs to another project"));
        }
        if initial_threads
            .iter()
            .any(|thread| thread.project_id != value.project_id)
        {
            return Err(invalid("initial thread belongs to another project"));
        }
        if initial_view.is_some_and(|view| view.project_id != value.project_id) {
            return Err(invalid("initial view belongs to another project"));
        }
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT OR IGNORE INTO projects (id,name,workspace_path,workspace_key,created_at,kind,title_source,updated_at,last_opened_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?5,?5)",
            params![value.project_id, value.name.trim(), value.workspace_path, value.workspace_key, now, value.kind, title_source_sql(value.title_source)],
        )?;
        let stored_name: String = tx.query_row(
            "SELECT name FROM projects WHERE id=?1",
            [&value.project_id],
            |row| row.get(0),
        )?;
        if stored_name != value.name.trim() {
            return Err(invalid(format!(
                "project {} already exists with another title",
                value.project_id
            )));
        }
        tx.execute(
            "INSERT OR IGNORE INTO project_canvases (project_id,draft_json,created_at,updated_at) VALUES (?1,?2,?3,?3)",
            params![value.project_id, value.draft_json, now],
        )?;
        for thread in initial_threads {
            required(&thread.id, "thread id")?;
            required(&thread.title, "thread title")?;
            tx.execute(
                "INSERT OR IGNORE INTO creative_threads (id,project_id,title,origin,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                params![thread.id, thread.project_id, thread.title.trim(), thread_origin_sql(thread.origin), now],
            )?;
            let stored: (String, String, String) = tx.query_row(
                "SELECT project_id,title,origin FROM creative_threads WHERE id=?1",
                [&thread.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            if stored
                != (
                    thread.project_id.clone(),
                    thread.title.trim().to_string(),
                    thread_origin_sql(thread.origin).to_string(),
                )
            {
                return Err(invalid(format!(
                    "stable thread id {} replayed with different content",
                    thread.id
                )));
            }
        }
        for node in initial_nodes {
            insert_node_tx(&tx, node, now)?;
        }
        if let Some(view) = initial_view {
            upsert_view_tx(&tx, view, now)?;
        }
        let canvas = tx.query_row(
            "SELECT project_id,draft_json,created_at,updated_at FROM project_canvases WHERE project_id=?1",
            [&value.project_id],
            canvas_from_row,
        )?;
        tx.commit()?;
        Ok(canvas)
    }

    pub fn rename_canvas_project(&self, project_id: &str, title: &str) -> AppResult<bool> {
        required(title, "project title")?;
        let now = Utc::now().timestamp();
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE projects SET name=?2,title_source='manual',updated_at=?3 WHERE id=?1",
            params![project_id, title.trim(), now],
        )?;
        Ok(changed > 0)
    }

    pub fn title_canvas_project_from_first_prompt(
        &self,
        project_id: &str,
        title: &str,
    ) -> AppResult<bool> {
        required(title, "project title")?;
        let now = Utc::now().timestamp();
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE projects SET name=?2,title_source='first_prompt',updated_at=?3 WHERE id=?1 AND title_source='default'",
            params![project_id, title.trim(), now],
        )?;
        Ok(changed > 0)
    }

    pub fn update_project_canvas_draft(
        &self,
        project_id: &str,
        draft_json: &str,
    ) -> AppResult<bool> {
        validate_draft_json(draft_json)?;
        let now = Utc::now().timestamp();
        let conn = self.lock_conn()?;
        let changed = conn.execute(
            "UPDATE project_canvases SET draft_json=?2,updated_at=?3 WHERE project_id=?1",
            params![project_id, draft_json, now],
        )?;
        Ok(changed > 0)
    }

    pub fn touch_project_canvas(&self, project_id: &str) -> AppResult<bool> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = touch_project_opened_tx(&tx, project_id, now)?;
        tx.commit()?;
        Ok(changed)
    }

    pub fn create_creative_thread(&self, value: &NewCreativeThread) -> AppResult<CreativeThread> {
        required(&value.id, "thread id")?;
        required(&value.project_id, "project id")?;
        required(&value.title, "thread title")?;
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        if let Some(existing) = tx
            .query_row(
                &format!("SELECT {THREAD_COLUMNS} FROM creative_threads WHERE id=?1"),
                [&value.id],
                thread_from_row,
            )
            .optional()?
        {
            if existing.project_id == value.project_id
                && existing.title == value.title.trim()
                && existing.origin == value.origin
            {
                tx.commit()?;
                return Ok(existing);
            }
            return Err(invalid(format!(
                "stable thread id {} replayed with different content",
                value.id
            )));
        }
        tx.execute(
            "INSERT INTO creative_threads (id,project_id,title,origin,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
            params![value.id, value.project_id, value.title.trim(), thread_origin_sql(value.origin), now],
        )?;
        let thread = tx.query_row(
            &format!("SELECT {THREAD_COLUMNS} FROM creative_threads WHERE id=?1"),
            [&value.id],
            thread_from_row,
        )?;
        tx.commit()?;
        Ok(thread)
    }

    pub fn get_creative_thread(&self, thread_id: &str) -> AppResult<Option<CreativeThread>> {
        let conn = self.lock_conn()?;
        Ok(conn
            .query_row(
                &format!("SELECT {THREAD_COLUMNS} FROM creative_threads WHERE id=?1"),
                [thread_id],
                thread_from_row,
            )
            .optional()?)
    }

    pub fn list_project_threads(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> AppResult<Vec<CreativeThread>> {
        let conn = self.lock_conn()?;
        let sql = format!(
            "SELECT {THREAD_COLUMNS} FROM creative_threads WHERE project_id=?1 {} ORDER BY created_at,id",
            if include_archived { "" } else { "AND archived_at IS NULL" }
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map([project_id], thread_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn archive_creative_thread(&self, thread_id: &str) -> AppResult<bool> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project_id = tx
            .query_row(
                "SELECT project_id FROM creative_threads WHERE id=?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(project_id) = project_id else {
            return Ok(false);
        };
        let changed = tx.execute(
            "UPDATE creative_threads SET archived_at=?2,updated_at=?2 WHERE id=?1 AND archived_at IS NULL",
            params![thread_id, now],
        )?;
        if changed > 0 {
            touch_canvas_tx(&tx, &project_id, now)?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn restore_creative_thread(&self, thread_id: &str) -> AppResult<bool> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project_id = tx
            .query_row(
                "SELECT project_id FROM creative_threads WHERE id=?1",
                [thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(project_id) = project_id else {
            return Ok(false);
        };
        let changed = tx.execute(
            "UPDATE creative_threads SET archived_at=NULL,updated_at=?2 WHERE id=?1 AND archived_at IS NOT NULL",
            params![thread_id, now],
        )?;
        if changed > 0 {
            touch_canvas_tx(&tx, &project_id, now)?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn place_collected_image(&self, project_id: &str, asset: &Asset) -> AppResult<()> {
        self.ensure_project_canvas(project_id)?;
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let visible: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM canvas_nodes WHERE project_id=?1 AND asset_id=?2 AND hidden_at IS NULL)",
            params![project_id, asset.id], |row| row.get(0),
        )?;
        if !visible {
            let now = Utc::now().timestamp();
            let snapshot = asset_snapshot(asset);
            let rect = placement::Rect { x: 32.0, y: 32.0, width: 190.0, height: asset_node_height(&snapshot) };
            let workflow = placement::workflow(&tx, project_id)?;
            let occupied = placement::obstacles(&tx, project_id, &workflow, &[])?;
            let (x, y) = placement::near(rect, &occupied, 0.0);
            let node = NewCanvasNode {
                id: ulid::Ulid::new().to_string(), project_id: project_id.to_owned(), thread_id: None,
                kind: CreativeNodeKind::Asset, role: Some(CreativeNodeRole::Reference), asset_id: Some(asset.id.clone()),
                payload_json: serde_json::to_string(&AssetNodePayloadV1 {
                    schema_version: 1, snapshot, execution: None, workflow_source: None, workflow_generation_group: None,
                })?,
                x, y, width: rect.width, height: rect.height, z_index: 0, position_locked: false,
            };
            touch_canvas_tx(&tx, project_id, now)?;
            insert_node_tx(&tx, &node, now)?;
        } else {
            tx.execute("INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) VALUES(?1,?2,?3)",
                params![project_id, asset.id, Utc::now().timestamp()])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn create_canvas_node(&self, value: &NewCanvasNode) -> AppResult<CanvasNode> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        let node = insert_node_tx(&tx, value, now)?;
        tx.commit()?;
        Ok(node)
    }

    pub fn create_canvas_nodes_batch(
        &self,
        project_id: &str,
        values: &[NewCanvasNode],
        groups: &[CanvasGroupBatchCreate],
    ) -> AppResult<CanvasBatchCreated> {
        required(project_id, "project id")?;
        if values.iter().any(|node| node.project_id != project_id)
            || groups.iter().any(|group| group.value.project_id != project_id)
        {
            return Err(invalid("batch creation contains entries from another project"));
        }
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !values.is_empty() || !groups.is_empty() {
            touch_canvas_tx(&tx, project_id, now)?;
        }
        let nodes = values.iter().map(|node| insert_node_tx(&tx, node, now))
            .collect::<AppResult<Vec<_>>>()?;
        let groups = groups.iter().map(|group| {
            match replay_canvas_group_tx(&tx, &group.value, &group.node_ids)? {
                Some(existing) => Ok(existing),
                None => insert_canvas_group_tx(&tx, &group.value, &group.node_ids, now),
            }
        })
            .collect::<AppResult<Vec<_>>>()?;
        tx.commit()?;
        Ok(CanvasBatchCreated { nodes, groups })
    }

    pub fn get_canvas_node(&self, node_id: &str) -> AppResult<Option<CanvasNode>> {
        let conn = self.lock_conn()?;
        let sql = format!("SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE id=?1");
        Ok(conn.query_row(&sql, [node_id], node_from_row).optional()?)
    }

    /// Read the addressed canvas instances without rebuilding gallery or conversation projections.
    pub fn visible_canvas_nodes(&self, project_id: &str, node_ids: &[String]) -> AppResult<Vec<CanvasNode>> {
        self.with_canvas_reader(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "WITH wanted AS (
                     SELECT value AS wanted_id, MIN(CAST(key AS INTEGER)) AS ordinal
                     FROM json_each(?2) GROUP BY value
                 )
                 SELECT {NODE_COLUMNS} FROM wanted JOIN canvas_nodes n ON n.id=wanted.wanted_id
                 WHERE n.project_id=?1 AND n.hidden_at IS NULL ORDER BY wanted.ordinal"
            ))?;
            let ids = serde_json::to_string(node_ids)?;
            let matches = stmt.query_map(params![project_id, ids], node_from_row)?;
            Ok(matches.collect::<Result<Vec<_>, _>>()?)
        })
    }

    pub fn list_canvas_nodes(&self, project_id: &str) -> AppResult<Vec<CanvasNode>> {
        let conn = self.lock_conn()?;
        let sql = format!(
            "SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE project_id=?1 ORDER BY z_index,created_at,id"
        );
        let mut statement = conn.prepare(&sql)?;
        let mut nodes = statement
            .query_map([project_id], node_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        restore_canvas_conversations(&conn, project_id, &mut nodes)?;
        Ok(nodes)
    }

    pub fn update_canvas_note_payload(&self, node_id: &str, payload_json: &str) -> AppResult<CanvasNode> {
        let CreativeNodePayload::Note(note) = parse_node_payload(CreativeNodeKind::Note, payload_json)
            .map_err(|error| invalid(error.to_string()))? else {
                return Err(invalid("invalid note payload"));
            };
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = get_node_tx(&tx, node_id)?.ok_or_else(|| invalid("note not found"))?;
        if node_is_execution_owned(&existing) || note.note_type == Some(CanvasNoteType::Chat) {
            return Err(invalid("chat cards are maintained by the chat runtime"));
        }
        if existing.kind != CreativeNodeKind::Note || existing.hidden_at.is_some() {
            return Err(invalid("only visible notes can be edited"));
        }
        record_image_container_assets(&tx, &existing.project_id, &note, Some(&existing.payload_json), now)?;
        tx.execute(
            "UPDATE canvas_nodes SET payload_json=?2,updated_at=?3 WHERE id=?1",
            params![node_id, payload_json, now],
        )?;
        touch_canvas_tx(&tx, &existing.project_id, now)?;
        let updated = get_node_tx(&tx, node_id)?.ok_or_else(|| invalid("note not found"))?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn update_canvas_node_layout(
        &self,
        node_id: &str,
        value: &CanvasNodeLayoutUpdate,
    ) -> AppResult<Option<CanvasNode>> {
        validate_geometry(value.x, value.y, value.width, value.height)?;
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(existing) = get_node_tx(&tx, node_id)? else {
            return Ok(None);
        };
        update_canvas_node_layout_tx(&tx, &existing, value, now)?;
        touch_canvas_tx(&tx, &existing.project_id, now)?;
        let updated = get_node_tx(&tx, node_id)?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn update_canvas_nodes_batch(
        &self,
        project_id: &str,
        updates: &[CanvasNodeBatchLayout],
        groups: &[CanvasGroup],
    ) -> AppResult<()> {
        required(project_id, "project id")?;
        for update in updates {
            validate_geometry(update.value.x, update.value.y, update.value.width, update.value.height)?;
        }
        for group in groups {
            if group.project_id != project_id {
                return Err(invalid("batch layout contains a group from another project"));
            }
            validate_geometry(group.x, group.y, group.width, group.height)?;
            required(&group.name, "group name")?;
        }
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut changed = false;
        for update in updates {
            let existing = get_node_tx(&tx, &update.node_id)?
                .ok_or_else(|| AppError::NotFound(format!("canvas node {}", update.node_id)))?;
            if existing.project_id != project_id {
                return Err(invalid("batch layout contains a node from another project"));
            }
            update_canvas_node_layout_tx(&tx, &existing, &update.value, now)?;
            changed = true;
        }
        for group in groups {
            if !update_canvas_group_tx(&tx, group, now)? {
                return Err(AppError::NotFound(format!("canvas group {} in project {project_id}", group.id)));
            }
            changed = true;
        }
        if changed {
            touch_canvas_tx(&tx, project_id, now)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn restore_canvas_node(
        &self,
        project_id: &str,
        node_id: &str,
    ) -> AppResult<Option<CanvasNode>> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(node) = get_node_tx(&tx, node_id)? else {
            return Ok(None);
        };
        if node.project_id != project_id {
            return Err(invalid("restore node crosses projects"));
        }
        tx.execute(
            "UPDATE canvas_nodes SET hidden_at=NULL,updated_at=?2 WHERE id=?1",
            params![node_id, now],
        )?;
        touch_canvas_tx(&tx, project_id, now)?;
        let restored = get_node_tx(&tx, node_id)?;
        tx.commit()?;
        Ok(restored)
    }

    pub fn remove_canvas_node(&self, node_id: &str) -> AppResult<Option<CanvasNodeRemoval>> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(node) = get_node_tx(&tx, node_id)? else {
            return Ok(None);
        };
        let referenced_by_execution: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM canvas_edges WHERE from_node_id=?1 OR to_node_id=?1)",
            [node_id],
            |row| row.get(0),
        )?;
        let removal = if node_is_execution_owned(&node) || referenced_by_execution {
            tx.execute(
                "UPDATE canvas_nodes SET hidden_at=COALESCE(hidden_at,?2),updated_at=?2 WHERE id=?1",
                params![node_id, now],
            )?;
            CanvasNodeRemoval::Hidden
        } else {
            tx.execute("DELETE FROM canvas_nodes WHERE id=?1", [node_id])?;
            CanvasNodeRemoval::Deleted
        };
        touch_canvas_tx(&tx, &node.project_id, now)?;
        tx.commit()?;
        Ok(Some(removal))
    }

    pub fn create_canvas_group_with_items(
        &self,
        value: &NewCanvasGroup,
        node_ids: &[String],
    ) -> AppResult<CanvasGroup> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        let group = insert_canvas_group_tx(&tx, value, node_ids, now)?;
        tx.commit()?;
        Ok(group)
    }

    pub fn set_canvas_group_items(
        &self,
        group_id: &str,
        node_ids: &[String],
    ) -> AppResult<Vec<CanvasGroupItem>> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project_id = tx
            .query_row(
                "SELECT project_id FROM canvas_groups WHERE id=?1",
                [group_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("canvas group {group_id}")))?;
        let items = set_group_items_tx(&tx, &project_id, group_id, node_ids)?;
        touch_canvas_tx(&tx, &project_id, now)?;
        tx.commit()?;
        Ok(items)
    }

    pub fn list_canvas_groups(&self, project_id: &str) -> AppResult<Vec<CanvasGroup>> {
        let conn = self.lock_conn()?;
        let mut statement = conn.prepare(&format!(
            "SELECT {GROUP_COLUMNS} FROM canvas_groups WHERE project_id=?1 ORDER BY z_index,created_at,id"
        ))?;
        let groups = statement
            .query_map([project_id], group_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(groups)
    }

    pub fn list_canvas_group_items(&self, project_id: &str) -> AppResult<Vec<CanvasGroupItem>> {
        let conn = self.lock_conn()?;
        let mut statement = conn.prepare(
            "SELECT project_id,group_id,node_id,ordinal FROM canvas_group_items WHERE project_id=?1 ORDER BY group_id,ordinal,node_id",
        )?;
        let items = statement
            .query_map([project_id], |row| {
                Ok(CanvasGroupItem {
                    project_id: row.get(0)?,
                    group_id: row.get(1)?,
                    node_id: row.get(2)?,
                    ordinal: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(items)
    }

    pub fn update_canvas_group(&self, value: &CanvasGroup) -> AppResult<bool> {
        validate_geometry(value.x, value.y, value.width, value.height)?;
        required(&value.name, "group name")?;
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = update_canvas_group_tx(&tx, value, now)?;
        if changed {
            touch_canvas_tx(&tx, &value.project_id, now)?;
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn delete_canvas_group(&self, group_id: &str) -> AppResult<bool> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project_id = tx
            .query_row(
                "SELECT project_id FROM canvas_groups WHERE id=?1",
                [group_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let changed = tx.execute("DELETE FROM canvas_groups WHERE id=?1", [group_id])?;
        if let Some(project_id) = project_id {
            touch_canvas_tx(&tx, &project_id, now)?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn create_canvas_edge(&self, value: &NewCanvasEdge) -> AppResult<CanvasEdge> {
        required(&value.id, "edge id")?;
        required(&value.project_id, "project id")?;
        required(&value.thread_id, "thread id")?;
        if value.ordinal < 0 || value.from_node_id == value.to_node_id {
            return Err(invalid("invalid edge ordinal or endpoints"));
        }
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        let from = get_node_tx(&tx, &value.from_node_id)?
            .ok_or_else(|| AppError::NotFound(format!("canvas node {}", value.from_node_id)))?;
        let to = get_node_tx(&tx, &value.to_node_id)?
            .ok_or_else(|| AppError::NotFound(format!("canvas node {}", value.to_node_id)))?;
        if from.project_id != value.project_id || to.project_id != value.project_id {
            return Err(invalid("edge crosses projects"));
        }
        if !edge_threads_are_valid(value, &from, &to) {
            return Err(invalid("edge crosses creative threads"));
        }
        if !edge_endpoints_are_valid(value.kind, from.kind, from.role, to.kind, to.role) {
            return Err(invalid("invalid edge endpoints"));
        }
        if let Some(existing) = tx
            .query_row(
                &format!("SELECT {EDGE_COLUMNS} FROM canvas_edges WHERE id=?1"),
                [&value.id],
                edge_from_row,
            )
            .optional()?
        {
            let same = existing.project_id == value.project_id
                && existing.thread_id == value.thread_id
                && existing.from_node_id == value.from_node_id
                && existing.to_node_id == value.to_node_id
                && existing.kind == value.kind
                && existing.ordinal == value.ordinal;
            return if same {
                tx.commit()?;
                Ok(existing)
            } else {
                Err(invalid(format!(
                    "stable edge id {} replayed with different content",
                    value.id
                )))
            };
        }
        tx.execute(
            "INSERT INTO canvas_edges (id,project_id,thread_id,from_node_id,to_node_id,kind,ordinal,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![value.id, value.project_id, value.thread_id, value.from_node_id, value.to_node_id, edge_kind_sql(value.kind), value.ordinal, now],
        )?;
        let edge = tx.query_row(
            &format!("SELECT {EDGE_COLUMNS} FROM canvas_edges WHERE id=?1"),
            [&value.id],
            edge_from_row,
        )?;
        tx.commit()?;
        Ok(edge)
    }

    pub fn list_canvas_edges(&self, project_id: &str) -> AppResult<Vec<CanvasEdge>> {
        let conn = self.lock_conn()?;
        let mut statement = conn.prepare(&format!(
            "SELECT {EDGE_COLUMNS} FROM canvas_edges WHERE project_id=?1 ORDER BY created_at,ordinal,id"
        ))?;
        let edges = statement
            .query_map([project_id], edge_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(edges)
    }

    pub fn delete_canvas_edge(&self, edge_id: &str) -> AppResult<bool> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let project_id = tx
            .query_row(
                "SELECT project_id FROM canvas_edges WHERE id=?1",
                [edge_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let changed = tx.execute("DELETE FROM canvas_edges WHERE id=?1", [edge_id])?;
        if let Some(project_id) = project_id {
            touch_canvas_tx(&tx, &project_id, now)?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn upsert_canvas_view(&self, value: &CanvasViewInput) -> AppResult<CanvasView> {
        let now = Utc::now().timestamp();
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        let view = upsert_view_tx(&tx, value, now)?;
        tx.commit()?;
        Ok(view)
    }

    pub fn get_canvas_view(&self, project_id: &str) -> AppResult<Option<CanvasView>> {
        let conn = self.lock_conn()?;
        Ok(conn
            .query_row(
                "SELECT project_id,pan_x,pan_y,zoom,source_panel_width,active_node_id,focused_thread_id,view_mode,timeline_scope,updated_at FROM canvas_views WHERE project_id=?1",
                [project_id],
                view_from_row,
            )
            .optional()?)
    }

    pub fn project_canvas_snapshot(&self, project_id: &str) -> AppResult<ProjectCanvasSnapshot> {
        self.with_canvas_reader(|conn| {
            let tx = conn.transaction()?;
            let snapshot = project_canvas_snapshot_tx(&tx, project_id)?;
            tx.commit()?;
            Ok(snapshot)
        })
    }

    pub fn project_canvas_location_for_asset(
        &self,
        asset_id: &str,
    ) -> AppResult<Option<(String, String, Option<String>)>> {
        required(asset_id, "asset id")?;
        let conn = self.lock_conn()?;
        let mut statement = conn.prepare(
            "SELECT project_id,id,thread_id FROM canvas_nodes WHERE asset_id=?1 AND hidden_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT 2",
        )?;
        let mut locations = statement
            .query_map([asset_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if locations.len() > 1 {
            return Err(invalid(format!(
                "asset {asset_id} belongs to multiple visible canvas nodes; use project id, thread id and node id"
            )));
        }
        Ok(locations.pop())
    }

    pub fn project_canvas_location_for_node(
        &self,
        project_id: &str,
        thread_id: &str,
        node_id: &str,
    ) -> AppResult<(String, String, Option<String>)> {
        required(project_id, "project id")?;
        required(thread_id, "thread id")?;
        required(node_id, "node id")?;
        let conn = self.lock_conn()?;
        let (actual_project_id, actual_node_id, actual_thread_id, hidden_at) = conn
            .query_row(
                "SELECT project_id,id,thread_id,hidden_at FROM canvas_nodes WHERE id=?1",
                [node_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("canvas node {node_id}")))?;
        if actual_project_id != project_id {
            return Err(invalid(format!(
                "node {node_id} belongs to another project"
            )));
        }
        if actual_thread_id.as_deref() != Some(thread_id) {
            return Err(invalid(format!(
                "node {node_id} belongs to another creative thread"
            )));
        }
        if hidden_at.is_some() {
            return Err(AppError::NotFound(format!("visible canvas node {node_id}")));
        }
        Ok((actual_project_id, actual_node_id, actual_thread_id))
    }
}

fn update_canvas_node_layout_tx(
    tx: &Transaction<'_>, existing: &CanvasNode, value: &CanvasNodeLayoutUpdate, now: i64,
) -> AppResult<()> {
    let node_id = &existing.id;
    if existing.hidden_at.is_some() {
        return Err(invalid(format!(
            "hidden canvas node {node_id} cannot be moved"
        )));
    }
    tx.execute(
        "UPDATE canvas_nodes SET x=?2,y=?3,width=?4,height=?5,z_index=?6,position_locked=?7,updated_at=?8 WHERE id=?1",
        params![node_id, value.x, value.y, value.width, value.height, value.z_index, i64::from(value.position_locked), now],
    )?;
    Ok(())
}

fn replay_canvas_group_tx(
    tx: &Transaction<'_>, value: &NewCanvasGroup, node_ids: &[String],
) -> AppResult<Option<CanvasGroup>> {
    let Some(group) = tx.query_row(
        &format!("SELECT {GROUP_COLUMNS} FROM canvas_groups WHERE id=?1"),
        [&value.id], group_from_row,
    ).optional()? else { return Ok(None); };
    let shape_matches = group.project_id == value.project_id
        && group.name == value.name.trim()
        && group.role == value.role
        && (group.x, group.y, group.width, group.height, group.z_index)
            == (value.x, value.y, value.width, value.height, value.z_index);
    if shape_matches {
        let mut members = tx.prepare_cached("SELECT node_id FROM canvas_group_items WHERE group_id=?1 ORDER BY ordinal")?;
        let matches = members.query_map([&value.id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if matches == node_ids {
            return Ok(Some(group));
        }
    }
    Err(invalid(format!("stable group id {} replayed with different content", value.id)))
}

fn insert_canvas_group_tx(
    tx: &Transaction<'_>, value: &NewCanvasGroup, node_ids: &[String], now: i64,
) -> AppResult<CanvasGroup> {
    required(&value.id, "group id")?;
    required(&value.project_id, "project id")?;
    required(&value.name, "group name")?;
    validate_geometry(value.x, value.y, value.width, value.height)?;
    tx.execute(
        "INSERT INTO canvas_groups (id,project_id,name,role,x,y,width,height,z_index,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
        params![value.id, value.project_id, value.name.trim(), value.role.map(group_role_sql), value.x, value.y, value.width, value.height, value.z_index, now],
    )?;
    set_group_items_tx(tx, &value.project_id, &value.id, node_ids)?;
    let group = tx.query_row(
        &format!("SELECT {GROUP_COLUMNS} FROM canvas_groups WHERE id=?1"),
        [&value.id],
        group_from_row,
    )?;
    Ok(group)
}

fn update_canvas_group_tx(tx: &Transaction<'_>, value: &CanvasGroup, now: i64) -> AppResult<bool> {
    let changed = tx.execute(
        "UPDATE canvas_groups SET name=?3,role=?4,x=?5,y=?6,width=?7,height=?8,z_index=?9,updated_at=?10 WHERE id=?1 AND project_id=?2",
        params![value.id, value.project_id, value.name.trim(), value.role.map(group_role_sql), value.x, value.y, value.width, value.height, value.z_index, now],
    )?;
    Ok(changed > 0)
}

fn set_group_items_tx(
    tx: &Transaction<'_>,
    project_id: &str,
    group_id: &str,
    node_ids: &[String],
) -> AppResult<Vec<CanvasGroupItem>> {
    let mut seen = std::collections::HashSet::new();
    if node_ids.iter().any(|node_id| !seen.insert(node_id)) {
        return Err(invalid("group node list contains duplicates"));
    }
    let ids = serde_json::to_string(node_ids)?;
    let invalid_member = tx.prepare_cached(
        "SELECT requested.value FROM json_each(?2) requested
         LEFT JOIN canvas_nodes n ON n.id=requested.value AND n.project_id=?1
         WHERE n.id IS NULL LIMIT 1",
    )?.query_row(params![project_id, ids], |row| row.get::<_, String>(0)).optional()?;
    if let Some(id) = invalid_member {
        return Err(invalid(format!("node {id} does not belong to group project")));
    }
    tx.execute(
        "DELETE FROM canvas_group_items WHERE project_id=?1 AND group_id=?2",
        params![project_id, group_id],
    )?;
    let mut items = Vec::with_capacity(node_ids.len());
    let mut insert = tx.prepare_cached(
        "INSERT INTO canvas_group_items (project_id,group_id,node_id,ordinal) VALUES (?1,?2,?3,?4)",
    )?;
    for (ordinal, node_id) in node_ids.iter().enumerate() {
        insert.execute(params![project_id, group_id, node_id, ordinal as i64])?;
        items.push(CanvasGroupItem {
            project_id: project_id.to_string(),
            group_id: group_id.to_string(),
            node_id: node_id.clone(),
            ordinal: ordinal as i64,
        });
    }
    Ok(items)
}

fn upsert_view_tx(
    tx: &Transaction<'_>,
    value: &CanvasViewInput,
    now: i64,
) -> AppResult<CanvasView> {
    required(&value.project_id, "project id")?;
    if !value.pan_x.is_finite() || !value.pan_y.is_finite() || !value.zoom.is_finite() {
        return Err(invalid("view values must be finite"));
    }
    if value
        .workspace_width
        .is_some_and(|width| !width.is_finite() || width <= 0.0)
        || value
            .source_panel_width
            .is_some_and(|width| !width.is_finite() || width <= 0.0)
    {
        return Err(invalid("invalid source panel/workspace width"));
    }
    let zoom = value
        .zoom
        .clamp(MIN_PROJECT_CANVAS_ZOOM, MAX_PROJECT_CANVAS_ZOOM);
    let source_panel_width = match (value.source_panel_width, value.workspace_width) {
        (Some(width), Some(workspace_width)) => {
            Some(clamp_project_source_panel_width(width, workspace_width))
        }
        (width, _) => width,
    };
    tx.execute(
        "INSERT INTO canvas_views (project_id,pan_x,pan_y,zoom,source_panel_width,active_node_id,focused_thread_id,view_mode,timeline_scope,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(project_id) DO UPDATE SET pan_x=excluded.pan_x,pan_y=excluded.pan_y,zoom=excluded.zoom,source_panel_width=excluded.source_panel_width,active_node_id=excluded.active_node_id,focused_thread_id=excluded.focused_thread_id,view_mode=excluded.view_mode,timeline_scope=excluded.timeline_scope,updated_at=excluded.updated_at",
        params![value.project_id, value.pan_x, value.pan_y, zoom, source_panel_width, value.active_node_id, value.focused_thread_id, view_mode_sql(value.view_mode), timeline_scope_sql(value.timeline_scope), now],
    )?;
    tx.query_row(
        "SELECT project_id,pan_x,pan_y,zoom,source_panel_width,active_node_id,focused_thread_id,view_mode,timeline_scope,updated_at FROM canvas_views WHERE project_id=?1",
        [&value.project_id],
        view_from_row,
    )
    .map_err(Into::into)
}
