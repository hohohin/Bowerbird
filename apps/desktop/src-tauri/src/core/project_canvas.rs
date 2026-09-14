//! Project-centred infinite canvas repository (`PROJECT-CANVAS-PLAN` PB1).
//!
//! A project is the only user-visible lifecycle/title boundary and owns exactly one canvas.
//! Creative threads are causal groupings inside that canvas. Provider sessions, generation jobs
//! and Agent runs remain separate identities and are joined only through explicit link tables.

#![allow(dead_code)]

use chrono::Utc;
use std::path::Path;

use rusqlite::{params, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};

use crate::core::creative_session_contract::{
    edge_endpoints_are_valid, parse_node_payload, project_canvas_node_requires_thread,
    validate_node_kind_role, AgentGroupNodePayloadV1, AssetExecutionRefV1, AssetNodePayloadV1,
    AssetSnapshotV1, CreativeEdgeKind, CreativeGroupRole, CreativeNodeKind, CreativeNodePayload,
    CreativeNodeRole, CreativeThreadOrigin, PromptNodePayloadV1, VisualProfileRefV1,
};
use crate::core::library::Asset;
use crate::db::Database;
use crate::error::{AppError, AppResult};

pub const PROJECT_CANVAS_DRAFT_SCHEMA_VERSION: u64 = 1;
pub const MIN_PROJECT_CANVAS_ZOOM: f64 = 0.35;
pub const MAX_PROJECT_CANVAS_ZOOM: f64 = 2.4;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectTitleSource {
    Default,
    FirstPrompt,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectCanvasViewMode {
    Canvas,
    Timeline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectTimelineScope {
    Focused,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCanvas {
    pub project_id: String,
    pub draft_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCanvasMaterializeInput {
    pub project_id: String,
    pub name: String,
    pub workspace_path: String,
    pub workspace_key: String,
    pub kind: String,
    pub title_source: ProjectTitleSource,
    pub draft_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreativeThread {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub origin: CreativeThreadOrigin,
    pub archived_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewCreativeThread {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub origin: CreativeThreadOrigin,
}

#[derive(Debug, Clone)]
pub struct ProjectGenerationTurnInput {
    pub project_id: String,
    pub thread_id: String,
    pub generation_conversation_id: String,
    pub job_id: String,
    pub turn_key: String,
    pub prompt: String,
    pub applied_prompt: String,
    pub provider: String,
    pub provider_session_id: Option<String>,
    pub ratio: Option<String>,
    pub visual_profile: Option<VisualProfileRefV1>,
    pub references: Vec<String>,
    pub reference_node_ids: Vec<Option<String>>,
    pub parent_node_id: Option<String>,
    pub parent_asset_path: Option<String>,
    pub relation: Option<crate::core::creative_session_contract::CreativeGenerationRelation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectGenerationTurnGraph {
    pub prompt_node_id: String,
    pub reference_node_ids: Vec<String>,
    pub parent_node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAgentLaunchInput {
    pub project_id: String,
    pub thread_id: String,
    pub launch_id: String,
    pub prompt: String,
    pub provider: String,
    pub ratio: Option<String>,
    pub visual_profile: Option<VisualProfileRefV1>,
    pub reference_asset_ids: Vec<String>,
    #[serde(default)]
    pub reference_node_ids: Vec<Option<String>>,
    #[serde(default)]
    pub parent_node_id: Option<String>,
    #[serde(default)]
    pub parent_asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNode {
    pub id: String,
    pub project_id: String,
    pub thread_id: Option<String>,
    pub kind: CreativeNodeKind,
    pub asset_id: Option<String>,
    pub role: Option<CreativeNodeRole>,
    pub payload_json: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
    pub position_locked: bool,
    pub hidden_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewCanvasNode {
    pub id: String,
    pub project_id: String,
    pub thread_id: Option<String>,
    pub kind: CreativeNodeKind,
    pub asset_id: Option<String>,
    pub role: Option<CreativeNodeRole>,
    pub payload_json: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
    pub position_locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNodeLayoutUpdate {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
    pub position_locked: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CanvasNodeRemoval {
    Deleted,
    Hidden,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasGroup {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub role: Option<CreativeGroupRole>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewCanvasGroup {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub role: Option<CreativeGroupRole>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasGroupItem {
    pub project_id: String,
    pub group_id: String,
    pub node_id: String,
    pub ordinal: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    pub id: String,
    pub project_id: String,
    pub thread_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: CreativeEdgeKind,
    pub ordinal: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewCanvasEdge {
    pub id: String,
    pub project_id: String,
    pub thread_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: CreativeEdgeKind,
    pub ordinal: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasView {
    pub project_id: String,
    pub pan_x: f64,
    pub pan_y: f64,
    pub zoom: f64,
    pub source_panel_width: Option<f64>,
    pub active_node_id: Option<String>,
    pub focused_thread_id: Option<String>,
    pub view_mode: ProjectCanvasViewMode,
    pub timeline_scope: ProjectTimelineScope,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasViewInput {
    pub project_id: String,
    pub pan_x: f64,
    pub pan_y: f64,
    pub zoom: f64,
    pub source_panel_width: Option<f64>,
    #[serde(default)]
    pub workspace_width: Option<f64>,
    pub active_node_id: Option<String>,
    pub focused_thread_id: Option<String>,
    pub view_mode: ProjectCanvasViewMode,
    pub timeline_scope: ProjectTimelineScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCanvasSnapshot {
    pub canvas: ProjectCanvas,
    pub threads: Vec<CreativeThread>,
    pub nodes: Vec<CanvasNode>,
    pub groups: Vec<CanvasGroup>,
    pub group_items: Vec<CanvasGroupItem>,
    pub edges: Vec<CanvasEdge>,
    pub view: Option<CanvasView>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Other(format!("project canvas: {}", message.into()))
}

fn required(value: &str, field: &str) -> AppResult<()> {
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

pub fn clamp_project_source_panel_width(value: f64, workspace_width: f64) -> f64 {
    let min = 240.0_f64.min(workspace_width * 0.42);
    let max = min.max(workspace_width * 0.55);
    value.clamp(min, max)
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

fn edge_kind_sql(value: CreativeEdgeKind) -> &'static str {
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

fn node_from_row(row: &Row<'_>) -> rusqlite::Result<CanvasNode> {
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

const NODE_COLUMNS: &str = "id,project_id,thread_id,kind,asset_id,role,payload_json,x,y,width,height,z_index,position_locked,hidden_at,created_at,updated_at";

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

fn edge_from_row(row: &Row<'_>) -> rusqlite::Result<CanvasEdge> {
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

const EDGE_COLUMNS: &str =
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

fn get_node_tx(tx: &Transaction<'_>, node_id: &str) -> AppResult<Option<CanvasNode>> {
    let sql = format!("SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE id=?1");
    Ok(tx.query_row(&sql, [node_id], node_from_row).optional()?)
}

fn touch_canvas_tx(tx: &Transaction<'_>, project_id: &str, now: i64) -> AppResult<()> {
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

fn validate_new_node(value: &NewCanvasNode) -> AppResult<()> {
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
    parse_node_payload(value.kind, &value.payload_json)
        .map_err(|error| invalid(error.to_string()))?;
    validate_geometry(value.x, value.y, value.width, value.height)
}

fn insert_node_tx(tx: &Transaction<'_>, value: &NewCanvasNode, now: i64) -> AppResult<CanvasNode> {
    validate_new_node(value)?;
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
    tx.execute(
        "INSERT INTO canvas_nodes (id,project_id,thread_id,kind,asset_id,role,payload_json,x,y,width,height,z_index,position_locked,hidden_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,?14,?14)",
        params![value.id, value.project_id, value.thread_id, node_kind_sql(value.kind), value.asset_id, value.role.map(node_role_sql), value.payload_json, value.x, value.y, value.width, value.height, value.z_index, i64::from(value.position_locked), now],
    )?;
    get_node_tx(tx, &value.id)?.ok_or_else(|| invalid("inserted node was not found"))
}

fn projection_id(prefix: &str, execution_id: &str, turn_key: &str, suffix: &str) -> String {
    format!("{prefix}:{execution_id}:{turn_key}:{suffix}")
}

fn asset_snapshot(asset: &Asset) -> AssetSnapshotV1 {
    AssetSnapshotV1 {
        name: asset.name.clone(),
        width: asset.width.and_then(|value| u32::try_from(value).ok()),
        height: asset.height.and_then(|value| u32::try_from(value).ok()),
    }
}

fn asset_node_height(snapshot: &AssetSnapshotV1) -> f64 {
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
) -> AppResult<CanvasNode> {
    required(node_id, "reference node id")?;
    let node = get_node_tx(tx, node_id)?
        .ok_or_else(|| AppError::NotFound(format!("canvas reference node {node_id}")))?;
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
    Ok(node)
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
fn edge_threads_are_valid(value: &NewCanvasEdge, from: &CanvasNode, to: &CanvasNode) -> bool {
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
    // Include room for the execution card to the right and use group bounds for members.
    loop {
        let bottom: Option<f64> = tx.query_row(
            "SELECT MAX(y+height) FROM (
                SELECT x,y,width,height FROM canvas_nodes WHERE project_id=?1 AND id<>?2 AND hidden_at IS NULL
                  AND id NOT IN (SELECT value FROM json_each(?5))
                  AND id NOT IN (SELECT node_id FROM canvas_group_items WHERE project_id=?1)
                UNION ALL SELECT x,y,width,height FROM canvas_groups WHERE project_id=?1
             ) WHERE x < ?3+620 AND x+width+32 > ?3 AND y < ?4+184 AND y+height+32 > ?4",
            params![project_id,prompt_id,x,y,excluded], |row| row.get(0),
        )?;
        match bottom {
            Some(bottom) => y = bottom + 40.0,
            None => break,
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

fn node_is_execution_owned(node: &CanvasNode) -> bool {
    match node.kind {
        CreativeNodeKind::Prompt | CreativeNodeKind::AgentGroup => true,
        CreativeNodeKind::Note => false,
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

fn project_canvas_snapshot_tx(
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
    let nodes = {
        let mut statement = tx.prepare(&format!(
            "SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE project_id=?1 ORDER BY z_index,created_at,id"
        ))?;
        let rows = statement.query_map([project_id], node_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?
    };
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let canvas = tx.query_row(
            "SELECT project_id,draft_json,created_at,updated_at FROM project_canvases WHERE project_id=?1",
            [project_id],
            canvas_from_row,
        )?;
        tx.commit()?;
        Ok(canvas)
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE project_canvases SET draft_json=?2,updated_at=?3 WHERE project_id=?1",
            params![project_id, draft_json, now],
        )?;
        Ok(changed > 0)
    }

    pub fn touch_project_canvas(&self, project_id: &str) -> AppResult<bool> {
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn create_creative_thread(&self, value: &NewCreativeThread) -> AppResult<CreativeThread> {
        required(&value.id, "thread id")?;
        required(&value.project_id, "project id")?;
        required(&value.title, "thread title")?;
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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

    pub fn create_canvas_node(&self, value: &NewCanvasNode) -> AppResult<CanvasNode> {
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        let node = insert_node_tx(&tx, value, now)?;
        tx.commit()?;
        Ok(node)
    }

    pub fn get_canvas_node(&self, node_id: &str) -> AppResult<Option<CanvasNode>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE id=?1");
        Ok(conn.query_row(&sql, [node_id], node_from_row).optional()?)
    }

    pub fn list_canvas_nodes(&self, project_id: &str) -> AppResult<Vec<CanvasNode>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE project_id=?1 ORDER BY z_index,created_at,id"
        );
        let mut statement = conn.prepare(&sql)?;
        let nodes = statement
            .query_map([project_id], node_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(nodes)
    }

    pub fn update_canvas_node_layout(
        &self,
        node_id: &str,
        value: &CanvasNodeLayoutUpdate,
    ) -> AppResult<Option<CanvasNode>> {
        validate_geometry(value.x, value.y, value.width, value.height)?;
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let Some(existing) = get_node_tx(&tx, node_id)? else {
            return Ok(None);
        };
        if existing.hidden_at.is_some() {
            return Err(invalid(format!(
                "hidden canvas node {node_id} cannot be moved"
            )));
        }
        tx.execute(
            "UPDATE canvas_nodes SET x=?2,y=?3,width=?4,height=?5,z_index=?6,position_locked=?7,updated_at=?8 WHERE id=?1",
            params![node_id, value.x, value.y, value.width, value.height, value.z_index, i64::from(value.position_locked), now],
        )?;
        touch_canvas_tx(&tx, &existing.project_id, now)?;
        let updated = get_node_tx(&tx, node_id)?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn restore_canvas_node(
        &self,
        project_id: &str,
        node_id: &str,
    ) -> AppResult<Option<CanvasNode>> {
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        required(&value.id, "group id")?;
        required(&value.project_id, "project id")?;
        required(&value.name, "group name")?;
        validate_geometry(value.x, value.y, value.width, value.height)?;
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        tx.execute(
            "INSERT INTO canvas_groups (id,project_id,name,role,x,y,width,height,z_index,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
            params![value.id, value.project_id, value.name.trim(), value.role.map(group_role_sql), value.x, value.y, value.width, value.height, value.z_index, now],
        )?;
        set_group_items_tx(&tx, &value.project_id, &value.id, node_ids)?;
        let group = tx.query_row(
            &format!("SELECT {GROUP_COLUMNS} FROM canvas_groups WHERE id=?1"),
            [&value.id],
            group_from_row,
        )?;
        tx.commit()?;
        Ok(group)
    }

    pub fn set_canvas_group_items(
        &self,
        group_id: &str,
        node_ids: &[String],
    ) -> AppResult<Vec<CanvasGroupItem>> {
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let changed = tx.execute(
            "UPDATE canvas_groups SET name=?3,role=?4,x=?5,y=?6,width=?7,height=?8,z_index=?9,updated_at=?10 WHERE id=?1 AND project_id=?2",
            params![value.id, value.project_id, value.name.trim(), value.role.map(group_role_sql), value.x, value.y, value.width, value.height, value.z_index, now],
        )?;
        if changed > 0 {
            touch_canvas_tx(&tx, &value.project_id, now)?;
        }
        tx.commit()?;
        Ok(changed > 0)
    }

    pub fn delete_canvas_group(&self, group_id: &str) -> AppResult<bool> {
        let now = Utc::now().timestamp();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        touch_canvas_tx(&tx, &value.project_id, now)?;
        let view = upsert_view_tx(&tx, value, now)?;
        tx.commit()?;
        Ok(view)
    }

    pub fn get_canvas_view(&self, project_id: &str) -> AppResult<Option<CanvasView>> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row(
                "SELECT project_id,pan_x,pan_y,zoom,source_panel_width,active_node_id,focused_thread_id,view_mode,timeline_scope,updated_at FROM canvas_views WHERE project_id=?1",
                [project_id],
                view_from_row,
            )
            .optional()?)
    }

    pub fn project_canvas_snapshot(&self, project_id: &str) -> AppResult<ProjectCanvasSnapshot> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let snapshot = project_canvas_snapshot_tx(&tx, project_id)?;
        tx.commit()?;
        Ok(snapshot)
    }

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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let prompt_x = max_right + 72.0;
        let prompt_y = 88.0;
        let prompt_node_id = projection_id("gen-prompt", &value.job_id, &value.turn_key, "0");
        let new_prompt = get_node_tx(&tx, &prompt_node_id)?.is_none();
        let prompt_payload = serde_json::to_string(&PromptNodePayloadV1 {
            schema_version: 1,
            text: value.prompt.clone(),
            applied_prompt: Some(value.applied_prompt.clone()),
            provider: Some(value.provider.clone()),
            provider_session_id: value.provider_session_id.clone(),
            job_id: Some(value.job_id.clone()),
            turn_key: Some(value.turn_key.clone()),
            ratio: value.ratio.clone(),
            visual_profile: value.visual_profile.clone(),
            status: Some("running".into()),
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
                Some(
                    exact_visible_reference_node_tx(&tx, &value.project_id, node_id, store_path)?
                        .id,
                )
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        verify_project_thread_tx(&tx, project_id, thread_id)?;
        let prompt = tx
            .query_row(
                "SELECT x,y,z_index FROM canvas_nodes WHERE id=?1 AND project_id=?2 AND thread_id=?3 AND kind='prompt'",
                params![prompt_node_id, project_id, thread_id],
                |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, i64>(2)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("project prompt node {prompt_node_id}")))?;
        let mut node_ids = Vec::with_capacity(assets.len());
        for (index, asset) in assets.iter().enumerate() {
            let node_id = projection_id("gen-output", job_id, turn_key, &asset.id);
            let snapshot = asset_snapshot(asset);
            let payload = serde_json::to_string(&AssetNodePayloadV1 {
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
                    x: prompt.0 + 332.0 + index as f64 * 218.0,
                    y: prompt.1,
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
                    text: value.prompt.clone(),
                    applied_prompt: None,
                    provider: Some(value.provider.clone()),
                    provider_session_id: None,
                    job_id: None,
                    turn_key: Some(value.launch_id.clone()),
                    ratio: value.ratio.clone(),
                    visual_profile: value.visual_profile.clone(),
                    status: Some("creating".into()),
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
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
                    schema_version: 1,
                    snapshot: snapshot.clone(),
                    execution: Some(AssetExecutionRefV1 {
                        job_id: None,
                        turn_key: None,
                        run_id: Some(run_id.to_string()),
                        artifact_id: Some(artifact_id.to_string()),
                    }),
                })?,
                x: group_x + 358.0 + ordinal as f64 * 218.0,
                y: group_y,
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT thread_id FROM {table} WHERE {key_column}=?1");
        Ok(conn.query_row(&sql, [key], |row| row.get(0)).optional()?)
    }

    pub fn project_canvas_location_for_asset(
        &self,
        asset_id: &str,
    ) -> AppResult<Option<(String, String, Option<String>)>> {
        required(asset_id, "asset id")?;
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
    for node_id in node_ids {
        let node_project = tx
            .query_row(
                "SELECT project_id FROM canvas_nodes WHERE id=?1",
                [node_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if node_project.as_deref() != Some(project_id) {
            return Err(invalid(format!(
                "node {node_id} does not belong to group project"
            )));
        }
    }
    tx.execute(
        "DELETE FROM canvas_group_items WHERE project_id=?1 AND group_id=?2",
        params![project_id, group_id],
    )?;
    let mut items = Vec::with_capacity(node_ids.len());
    for (ordinal, node_id) in node_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO canvas_group_items (project_id,group_id,node_id,ordinal) VALUES (?1,?2,?3,?4)",
            params![project_id, group_id, node_id, ordinal as i64],
        )?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::creative_session_contract::{AssetNodePayloadV1, AssetSnapshotV1};

    fn db() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db
    }

    fn materialize(db: &Database, id: &str) {
        db.materialize_project_canvas(
            &ProjectCanvasMaterializeInput {
                project_id: id.into(),
                name: format!("项目 {id}"),
                workspace_path: format!("blank:{id}"),
                workspace_key: format!("blank:{id}"),
                kind: "blank".into(),
                title_source: ProjectTitleSource::Default,
                draft_json: r#"{"schema_version":1}"#.into(),
            },
            &[],
            &[],
            None,
        )
        .unwrap();
    }

    fn note(project_id: &str, id: &str) -> NewCanvasNode {
        NewCanvasNode {
            id: id.into(),
            project_id: project_id.into(),
            thread_id: None,
            kind: CreativeNodeKind::Note,
            asset_id: None,
            role: None,
            payload_json: r#"{"schema_version":1,"text":"note"}"#.into(),
            x: 0.0,
            y: 0.0,
            width: 160.0,
            height: 100.0,
            z_index: 0,
            position_locked: false,
        }
    }

    fn prompt(project_id: &str, thread_id: &str, id: &str) -> NewCanvasNode {
        NewCanvasNode {
            id: id.into(),
            project_id: project_id.into(),
            thread_id: Some(thread_id.into()),
            kind: CreativeNodeKind::Prompt,
            asset_id: None,
            role: None,
            payload_json: r#"{"schema_version":1,"text":"prompt"}"#.into(),
            x: 200.0,
            y: 0.0,
            width: 220.0,
            height: 120.0,
            z_index: 1,
            position_locked: false,
        }
    }

    fn output(project_id: &str, thread_id: &str, id: &str, asset_id: &str) -> NewCanvasNode {
        NewCanvasNode {
            id: id.into(),
            project_id: project_id.into(),
            thread_id: Some(thread_id.into()),
            kind: CreativeNodeKind::Asset,
            asset_id: Some(asset_id.into()),
            role: Some(CreativeNodeRole::Output),
            payload_json: serde_json::to_string(&AssetNodePayloadV1 {
                schema_version: 1,
                snapshot: AssetSnapshotV1 {
                    name: asset_id.into(),
                    width: None,
                    height: None,
                },
                execution: None,
            })
            .unwrap(),
            x: 0.0,
            y: 0.0,
            width: 190.0,
            height: 180.0,
            z_index: 1,
            position_locked: false,
        }
    }

    #[test]
    fn materialize_is_atomic_and_one_project_has_one_canvas() {
        let db = db();
        materialize(&db, "p1");
        assert_eq!(db.ensure_project_canvas("p1").unwrap().project_id, "p1");
        let conn = db.conn.lock().unwrap();
        assert!(conn
            .execute(
                "INSERT INTO project_canvases (project_id,draft_json,created_at,updated_at) VALUES ('p1','{\"schema_version\":1}',2,2)",
                [],
            )
            .is_err());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM project_canvases", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn nodes_require_valid_project_thread_and_stable_replay_is_idempotent() {
        let db = db();
        materialize(&db, "p1");
        materialize(&db, "p2");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "线程".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        let value = prompt("p1", "t1", "prompt");
        let first = db.create_canvas_node(&value).unwrap();
        let replay = db.create_canvas_node(&value).unwrap();
        assert_eq!(first, replay);
        assert!(db.create_canvas_node(&prompt("p2", "t1", "bad")).is_err());
        let mut unowned = prompt("p1", "t1", "unowned");
        unowned.thread_id = None;
        assert!(db.create_canvas_node(&unowned).is_err());
    }

    #[test]
    fn layout_update_dto_rejects_execution_payload_fields() {
        let error = serde_json::from_value::<CanvasNodeLayoutUpdate>(serde_json::json!({
            "payloadJson": "{\"schema_version\":1}",
            "x": 12.0,
            "y": 24.0,
            "width": 190.0,
            "height": 180.0,
            "zIndex": 3,
            "positionLocked": false
        }))
        .unwrap_err();

        assert!(error.to_string().contains("unknown field `payloadJson`"));
    }

    #[test]
    fn stale_layout_updates_preserve_execution_payload_owner_and_hidden_state() {
        let db = db();
        materialize(&db, "p1");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "生成线程".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,created_at) VALUES ('asset-1','初始结果',1)",
                [],
            )
            .unwrap();
        }

        let turn = ProjectGenerationTurnInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            generation_conversation_id: "conversation-1".into(),
            job_id: "job-1".into(),
            turn_key: "turn-1".into(),
            prompt: "生成一张海报".into(),
            applied_prompt: "生成一张海报，暖色".into(),
            provider: "test-provider".into(),
            provider_session_id: None,
            ratio: Some("1:1".into()),
            visual_profile: None,
            reference_node_ids: vec![],
            references: vec![],
            parent_node_id: None,
            parent_asset_path: None,
            relation: None,
        };
        let graph = db.begin_project_generation_turn(&turn).unwrap();
        let initial_asset = db.get_asset("asset-1").unwrap().unwrap();
        let output_node_id = db
            .complete_project_generation_turn("p1", "t1", "job-1", "turn-1", None, &[initial_asset])
            .unwrap()
            .pop()
            .unwrap();
        let stale_prompt = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
        let stale_output = db.get_canvas_node(&output_node_id).unwrap().unwrap();

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE assets SET name='后端最终结果' WHERE id='asset-1'",
                [],
            )
            .unwrap();
        }
        let final_asset = db.get_asset("asset-1").unwrap().unwrap();
        db.complete_project_generation_turn(
            "p1",
            "t1",
            "job-1",
            "turn-1",
            Some("provider-session-final"),
            &[final_asset],
        )
        .unwrap();
        db.update_project_generation_turn_status(
            "p1",
            "t1",
            "job-1",
            "turn-1",
            "failed",
            Some("provider-session-final"),
        )
        .unwrap();

        let latest_prompt = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
        let latest_output = db.get_canvas_node(&output_node_id).unwrap().unwrap();
        assert_ne!(stale_prompt.payload_json, latest_prompt.payload_json);
        assert_ne!(stale_output.payload_json, latest_output.payload_json);

        let moved_prompt = db
            .update_canvas_node_layout(
                &graph.prompt_node_id,
                &CanvasNodeLayoutUpdate {
                    x: stale_prompt.x + 17.0,
                    y: stale_prompt.y + 19.0,
                    width: stale_prompt.width + 11.0,
                    height: stale_prompt.height + 13.0,
                    z_index: stale_prompt.z_index + 7,
                    position_locked: true,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(moved_prompt.payload_json, latest_prompt.payload_json);
        assert_eq!(moved_prompt.project_id, latest_prompt.project_id);
        assert_eq!(moved_prompt.thread_id, latest_prompt.thread_id);
        assert_eq!(moved_prompt.kind, latest_prompt.kind);
        assert_eq!(moved_prompt.asset_id, latest_prompt.asset_id);
        assert_eq!(moved_prompt.role, latest_prompt.role);
        assert_eq!(moved_prompt.hidden_at, latest_prompt.hidden_at);
        let prompt_payload: PromptNodePayloadV1 =
            serde_json::from_str(&moved_prompt.payload_json).unwrap();
        assert_eq!(prompt_payload.status.as_deref(), Some("failed"));
        assert_eq!(
            prompt_payload.provider_session_id.as_deref(),
            Some("provider-session-final")
        );

        let moved_output = db
            .update_canvas_node_layout(
                &output_node_id,
                &CanvasNodeLayoutUpdate {
                    x: stale_output.x + 23.0,
                    y: stale_output.y + 29.0,
                    width: stale_output.width + 17.0,
                    height: stale_output.height + 19.0,
                    z_index: stale_output.z_index + 9,
                    position_locked: true,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(moved_output.payload_json, latest_output.payload_json);
        assert_eq!(moved_output.project_id, latest_output.project_id);
        assert_eq!(moved_output.thread_id, latest_output.thread_id);
        assert_eq!(moved_output.kind, latest_output.kind);
        assert_eq!(moved_output.asset_id, latest_output.asset_id);
        assert_eq!(moved_output.role, latest_output.role);
        assert_eq!(moved_output.hidden_at, latest_output.hidden_at);
        let output_payload: AssetNodePayloadV1 =
            serde_json::from_str(&moved_output.payload_json).unwrap();
        assert_eq!(output_payload.snapshot.name, "后端最终结果");
        assert_eq!(
            output_payload
                .execution
                .as_ref()
                .and_then(|execution| execution.job_id.as_deref()),
            Some("job-1")
        );

        assert_eq!(
            db.remove_canvas_node(&output_node_id).unwrap(),
            Some(CanvasNodeRemoval::Hidden)
        );
        let hidden_output = db.get_canvas_node(&output_node_id).unwrap().unwrap();
        assert!(hidden_output.hidden_at.is_some());
        let error = db
            .update_canvas_node_layout(
                &output_node_id,
                &CanvasNodeLayoutUpdate {
                    x: hidden_output.x + 100.0,
                    y: hidden_output.y + 100.0,
                    width: hidden_output.width,
                    height: hidden_output.height,
                    z_index: hidden_output.z_index + 1,
                    position_locked: false,
                },
            )
            .unwrap_err();
        assert!(error.to_string().contains("hidden canvas node"));
        assert_eq!(
            db.get_canvas_node(&output_node_id).unwrap().unwrap(),
            hidden_output
        );
    }

    #[test]
    fn shared_reference_upgrade_preserves_ownership_and_rejects_cross_thread_outputs() {
        let db = Database::open_in_memory().unwrap();
        crate::db::migrations::migrations()
            .to_version(&mut db.conn.lock().unwrap(), 23)
            .unwrap();
        materialize(&db, "p1");
        materialize(&db, "p2");
        for (project, thread) in [("p1", "t1"), ("p1", "t2"), ("p2", "t3")] {
            db.create_creative_thread(&NewCreativeThread {
                id: thread.into(),
                project_id: project.into(),
                title: thread.into(),
                origin: CreativeThreadOrigin::Direct,
            })
            .unwrap();
        }
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,created_at) VALUES ('a','reference',1)",
                [],
            )
            .unwrap();
        let mut reference = output("p1", "t1", "reference", "a");
        reference.role = Some(CreativeNodeRole::Reference);
        db.create_canvas_node(&reference).unwrap();
        db.create_canvas_node(&output("p1", "t1", "output", "a"))
            .unwrap();
        db.create_canvas_node(&prompt("p1", "t2", "target"))
            .unwrap();
        db.create_canvas_node(&prompt("p2", "t3", "other-project"))
            .unwrap();
        let insert = "INSERT INTO canvas_edges(id,project_id,thread_id,from_node_id,to_node_id,kind,ordinal,created_at) VALUES (?1,?2,?3,?4,?5,?6,0,1)";
        let shared = params!["shared", "p1", "t2", "reference", "target", "input"];
        assert!(db.conn.lock().unwrap().execute(insert, shared).is_err());
        let before = db.get_canvas_node("reference").unwrap().unwrap();
        // This is the v23 -> v24 contract; v25 deliberately adds generated asset inputs.
        crate::db::migrations::migrations()
            .to_version(&mut db.conn.lock().unwrap(), 24)
            .unwrap();
        assert_eq!(db.get_canvas_node("reference").unwrap().unwrap(), before);
        let conn = db.conn.lock().unwrap();
        conn.execute(insert, shared).unwrap();
        for kind in ["input", "continued", "retry", "branch"] {
            assert!(conn
                .execute(insert, params![kind, "p1", "t2", "output", "target", kind])
                .is_err());
        }
        assert!(conn
            .execute(
                insert,
                params![
                    "wrong-target-thread",
                    "p1",
                    "t1",
                    "reference",
                    "target",
                    "input"
                ]
            )
            .is_err());
        assert!(conn
            .execute(
                insert,
                params![
                    "cross-project",
                    "p2",
                    "t3",
                    "reference",
                    "other-project",
                    "input"
                ]
            )
            .is_err());
        drop(conn);
        db.migrate().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(insert, params!["generated-input", "p1", "t2", "output", "target", "input"]).unwrap();
        for kind in ["continued", "retry", "branch"] {
            assert!(conn.execute(insert, params![kind, "p1", "t2", "output", "target", kind]).is_err());
        }
        assert!(conn.execute(insert, params!["wrong-target-v25", "p1", "t1", "reference", "target", "input"]).is_err());
        assert!(conn.execute(insert, params!["cross-project-v25", "p2", "t3", "reference", "other-project", "input"]).is_err());
    }

    #[test]
    fn agent_reuses_selected_reference_and_keeps_repeated_launches_nearby() {
        let db = db();
        materialize(&db, "p1");
        for id in ["t1", "t2"] {
            db.create_creative_thread(&NewCreativeThread {
                id: id.into(),
                project_id: "p1".into(),
                title: id.into(),
                origin: CreativeThreadOrigin::Direct,
            })
            .unwrap();
        }
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets (id,name,created_at) VALUES ('a','reference',1)",
                [],
            )
            .unwrap();
        let mut original = output("p1", "t1", "original", "a");
        original.role = Some(CreativeNodeRole::Reference);
        original.x = 50.0;
        original.y = 70.0;
        db.create_canvas_node(&original).unwrap();
        let mut duplicate = original.clone();
        duplicate.id = "duplicate".into();
        duplicate.x = 4000.0;
        db.create_canvas_node(&duplicate).unwrap();
        let mut launch = ProjectAgentLaunchInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            launch_id: "launch1".into(),
            prompt: "edit".into(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec!["a".into()],
            reference_node_ids: vec![Some("original".into())],
            parent_node_id: None,
            parent_asset_id: None,
        };
        let first = db.begin_project_agent_launch(&launch).unwrap();
        assert_eq!(first.reference_node_ids, vec!["original"]);
        let first_node = db.get_canvas_node(&first.prompt_node_id).unwrap().unwrap();
        assert_eq!((first_node.x, first_node.y), (312.0, 70.0));
        launch.launch_id = "launch2".into();
        launch.thread_id = "t2".into();
        let second = db.begin_project_agent_launch(&launch).unwrap();
        let second_node = db.get_canvas_node(&second.prompt_node_id).unwrap().unwrap();
        assert_eq!(second.reference_node_ids, vec!["original"]);
        assert_eq!(second_node.x, first_node.x);
        assert!(second_node.y >= first_node.y + first_node.height + 32.0);
        assert_eq!(
            db.project_canvas_snapshot("p1")
                .unwrap()
                .nodes
                .iter()
                .filter(|n| n.asset_id.as_deref() == Some("a"))
                .count(),
            2
        );
        assert_eq!(
            db.get_canvas_node("original").unwrap().unwrap().x,
            original.x
        );
        db.update_canvas_node_layout(
            &second.prompt_node_id,
            &CanvasNodeLayoutUpdate {
                x: 900.0,
                y: 800.0,
                width: second_node.width,
                height: second_node.height,
                z_index: second_node.z_index,
                position_locked: true,
            },
        )
        .unwrap();
        assert_eq!(
            db.remove_canvas_node("original").unwrap(),
            Some(CanvasNodeRemoval::Hidden)
        );
        assert_eq!(
            db.begin_project_agent_launch(&launch)
                .unwrap()
                .reference_node_ids,
            vec!["original"]
        );
        let recovered = db.get_canvas_node(&second.prompt_node_id).unwrap().unwrap();
        assert_eq!((recovered.x, recovered.y), (900.0, 800.0));
        assert!(db
            .get_canvas_node("original")
            .unwrap()
            .unwrap()
            .hidden_at
            .is_some());
        assert_eq!(
            db.remove_canvas_node(&second.prompt_node_id).unwrap(),
            Some(CanvasNodeRemoval::Hidden)
        );
        db.begin_project_agent_launch(&launch).unwrap();
        db.update_project_agent_launch_status("t2", "launch2", "succeeded")
            .unwrap();
        assert!(db
            .get_canvas_node(&second.prompt_node_id)
            .unwrap()
            .unwrap()
            .hidden_at
            .is_some());
        launch.launch_id = "invalid".into();
        assert!(db.begin_project_agent_launch(&launch).is_err());
        assert!(db
            .get_canvas_node(&projection_id("agent-prompt", "invalid", "0", "0"))
            .unwrap()
            .is_none());
    }

    #[test]
    fn restore_removed_card_preserves_layout_payload_and_edges() {
        let db = db();
        materialize(&db, "p1");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "test".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        let launch = ProjectAgentLaunchInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            launch_id: "restore-test".into(),
            prompt: "restore me".into(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec![],
            reference_node_ids: vec![],
            parent_node_id: None,
            parent_asset_id: None,
        };
        let graph = db.begin_project_agent_launch(&launch).unwrap();
        let original = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
        db.remove_canvas_node(&original.id).unwrap();
        db.update_project_agent_launch_status("t1", "restore-test", "succeeded")
            .unwrap();
        assert!(db
            .restore_canvas_node("wrong-project", &original.id)
            .is_err());
        assert!(db
            .get_canvas_node(&original.id)
            .unwrap()
            .unwrap()
            .hidden_at
            .is_some());
        let restored = db.restore_canvas_node("p1", &original.id).unwrap().unwrap();
        assert!(restored.hidden_at.is_none());
        assert_eq!((restored.x, restored.y), (original.x, original.y));
        assert!(restored.payload_json.contains("succeeded"));
        assert_eq!(restored.thread_id, original.thread_id);
        db.begin_project_agent_launch(&launch).unwrap();
        assert!(db
            .get_canvas_node(&original.id)
            .unwrap()
            .unwrap()
            .hidden_at
            .is_none());
        assert!(db.restore_canvas_node("p1", "missing").unwrap().is_none());
    }

    #[test]
    fn agent_fallback_reuses_unique_grouped_reference_and_anchors_to_group() {
        let db = db();
        materialize(&db, "p1");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "t1".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets (id,name,created_at) VALUES ('a','reference',1)",
                [],
            )
            .unwrap();
        let mut original = output("p1", "t1", "original", "a");
        original.thread_id = None;
        original.role = Some(CreativeNodeRole::Reference);
        db.create_canvas_node(&original).unwrap();
        db.create_canvas_group_with_items(
            &NewCanvasGroup {
                id: "group".into(),
                project_id: "p1".into(),
                name: "references".into(),
                role: None,
                x: 500.0,
                y: 800.0,
                width: 300.0,
                height: 250.0,
                z_index: 1,
            },
            &["original".into()],
        )
        .unwrap();
        let launch = ProjectAgentLaunchInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            launch_id: "launch".into(),
            prompt: "edit".into(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec!["a".into()],
            reference_node_ids: vec![],
            parent_node_id: None,
            parent_asset_id: None,
        };
        let graph = db.begin_project_agent_launch(&launch).unwrap();
        assert_eq!(graph.reference_node_ids, vec!["original"]);
        let prompt = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
        assert_eq!((prompt.x, prompt.y), (872.0, 800.0));
        assert_eq!(
            db.project_canvas_snapshot("p1").unwrap().group_items.len(),
            1
        );
    }

    #[test]
    fn asset_location_compatibility_requires_one_visible_node() {
        let db = db();
        materialize(&db, "p1");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "线程".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,created_at) VALUES ('asset-1','素材',1)",
                [],
            )
            .unwrap();
        }
        db.create_canvas_node(&output("p1", "t1", "node-1", "asset-1"))
            .unwrap();
        assert_eq!(
            db.project_canvas_location_for_asset("asset-1").unwrap(),
            Some(("p1".into(), "node-1".into(), Some("t1".into())))
        );

        db.create_canvas_node(&output("p1", "t1", "node-2", "asset-1"))
            .unwrap();
        let error = db.project_canvas_location_for_asset("asset-1").unwrap_err();
        assert!(error.to_string().contains("multiple visible canvas nodes"));

        let continuation_error = db
            .begin_project_agent_launch(&ProjectAgentLaunchInput {
                project_id: "p1".into(),
                thread_id: "t1".into(),
                launch_id: "launch-ambiguous".into(),
                prompt: "继续创作".into(),
                provider: "bowerbird-agent".into(),
                ratio: None,
                visual_profile: None,
                reference_asset_ids: vec![],
                reference_node_ids: vec![],
                parent_node_id: None,
                parent_asset_id: Some("asset-1".into()),
            })
            .unwrap_err();
        assert!(continuation_error
            .to_string()
            .contains("multiple visible continuation nodes"));
    }

    #[test]
    fn exact_node_location_rejects_cross_project_and_cross_thread() {
        let db = db();
        materialize(&db, "p1");
        materialize(&db, "p2");
        for (project_id, thread_id) in [("p1", "t1"), ("p1", "t2"), ("p2", "t3")] {
            db.create_creative_thread(&NewCreativeThread {
                id: thread_id.into(),
                project_id: project_id.into(),
                title: thread_id.into(),
                origin: CreativeThreadOrigin::Direct,
            })
            .unwrap();
        }
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,created_at) VALUES ('asset-1','素材',1)",
                [],
            )
            .unwrap();
        }
        db.create_canvas_node(&output("p1", "t1", "node-1", "asset-1"))
            .unwrap();

        assert_eq!(
            db.project_canvas_location_for_node("p1", "t1", "node-1")
                .unwrap(),
            ("p1".into(), "node-1".into(), Some("t1".into()))
        );
        let wrong_project = db
            .project_canvas_location_for_node("p2", "t3", "node-1")
            .unwrap_err();
        assert!(wrong_project.to_string().contains("another project"));
        let wrong_thread = db
            .project_canvas_location_for_node("p1", "t2", "node-1")
            .unwrap_err();
        assert!(wrong_thread.to_string().contains("another creative thread"));
    }

    #[test]
    fn explicit_parent_node_is_exact_and_rejects_wrong_owner_asset_role_or_visibility() {
        let db = db();
        materialize(&db, "p1");
        materialize(&db, "p2");
        for (project_id, thread_id) in [("p1", "t1"), ("p1", "t2"), ("p2", "t3")] {
            db.create_creative_thread(&NewCreativeThread {
                id: thread_id.into(),
                project_id: project_id.into(),
                title: thread_id.into(),
                origin: CreativeThreadOrigin::Direct,
            })
            .unwrap();
        }
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,store_path,created_at) VALUES ('asset-1','素材 1','/asset-1.png',1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,store_path,created_at) VALUES ('asset-2','素材 2','/asset-2.png',1)",
                [],
            )
            .unwrap();
        }
        db.create_canvas_node(&output("p1", "t1", "parent-exact", "asset-1"))
            .unwrap();
        db.create_canvas_node(&output("p1", "t1", "parent-duplicate", "asset-1"))
            .unwrap();
        db.create_canvas_node(&output("p1", "t2", "parent-other-thread", "asset-1"))
            .unwrap();
        db.create_canvas_node(&output("p2", "t3", "parent-other-project", "asset-1"))
            .unwrap();
        let mut reference = output("p1", "t1", "parent-reference", "asset-1");
        reference.role = Some(CreativeNodeRole::Reference);
        db.create_canvas_node(&reference).unwrap();

        let generation_input = |job_id: &str, parent_node_id: &str, parent_asset_path: &str| {
            ProjectGenerationTurnInput {
                project_id: "p1".into(),
                thread_id: "t1".into(),
                generation_conversation_id: format!("conversation-{job_id}"),
                job_id: job_id.into(),
                turn_key: "turn-1".into(),
                prompt: "继续生成".into(),
                applied_prompt: "继续生成".into(),
                provider: "test-provider".into(),
                provider_session_id: None,
                ratio: None,
                visual_profile: None,
                reference_node_ids: vec![],
                references: vec![],
                parent_node_id: Some(parent_node_id.into()),
                parent_asset_path: Some(parent_asset_path.into()),
                relation: Some(
                    crate::core::creative_session_contract::CreativeGenerationRelation::Continued,
                ),
            }
        };

        let graph = db
            .begin_project_generation_turn(&generation_input(
                "job-exact",
                "parent-exact",
                "/asset-1.png",
            ))
            .unwrap();
        assert_eq!(graph.parent_node_id.as_deref(), Some("parent-exact"));
        assert!(db
            .project_canvas_snapshot("p1")
            .unwrap()
            .edges
            .iter()
            .any(|edge| edge.from_node_id == "parent-exact"
                && edge.to_node_id == graph.prompt_node_id));

        let cross_thread = db
            .begin_project_generation_turn(&generation_input(
                "job-cross-thread",
                "parent-other-thread",
                "/asset-1.png",
            ))
            .unwrap_err();
        assert!(cross_thread.to_string().contains("another creative thread"));
        let cross_project = db
            .begin_project_generation_turn(&generation_input(
                "job-cross-project",
                "parent-other-project",
                "/asset-1.png",
            ))
            .unwrap_err();
        assert!(cross_project.to_string().contains("another project"));
        let wrong_asset = db
            .begin_project_generation_turn(&generation_input(
                "job-wrong-asset",
                "parent-exact",
                "/asset-2.png",
            ))
            .unwrap_err();
        assert!(wrong_asset
            .to_string()
            .contains("does not match parent asset path"));
        let wrong_role = db
            .begin_project_generation_turn(&generation_input(
                "job-wrong-role",
                "parent-reference",
                "/asset-1.png",
            ))
            .unwrap_err();
        assert!(wrong_role
            .to_string()
            .contains("must be an output, intermediate, or final asset"));

        let agent_graph = db
            .begin_project_agent_launch(&ProjectAgentLaunchInput {
                project_id: "p1".into(),
                thread_id: "t1".into(),
                launch_id: "launch-exact".into(),
                prompt: "继续 Agent 创作".into(),
                provider: "cloud".into(),
                ratio: None,
                visual_profile: None,
                reference_asset_ids: vec![],
                reference_node_ids: vec![],
                parent_node_id: Some("parent-duplicate".into()),
                parent_asset_id: Some("asset-1".into()),
            })
            .unwrap();
        assert_eq!(
            agent_graph.parent_node_id.as_deref(),
            Some("parent-duplicate")
        );
        let wrong_agent_asset = db
            .begin_project_agent_launch(&ProjectAgentLaunchInput {
                project_id: "p1".into(),
                thread_id: "t1".into(),
                launch_id: "launch-wrong-asset".into(),
                prompt: "继续 Agent 创作".into(),
                provider: "cloud".into(),
                ratio: None,
                visual_profile: None,
                reference_asset_ids: vec![],
                reference_node_ids: vec![],
                parent_node_id: Some("parent-duplicate".into()),
                parent_asset_id: Some("asset-2".into()),
            })
            .unwrap_err();
        assert!(wrong_agent_asset
            .to_string()
            .contains("does not match parent asset asset-2"));

        assert_eq!(
            db.remove_canvas_node("parent-exact").unwrap(),
            Some(CanvasNodeRemoval::Hidden)
        );
        let hidden = db
            .begin_project_generation_turn(&generation_input(
                "job-hidden",
                "parent-exact",
                "/asset-1.png",
            ))
            .unwrap_err();
        assert!(hidden.to_string().contains("visible canvas parent node"));
    }

    #[test]
    fn groups_are_project_wide_while_edges_are_thread_scoped_and_acyclic() {
        let db = db();
        materialize(&db, "p1");
        for id in ["t1", "t2"] {
            db.create_creative_thread(&NewCreativeThread {
                id: id.into(),
                project_id: "p1".into(),
                title: id.into(),
                origin: CreativeThreadOrigin::Direct,
            })
            .unwrap();
        }
        let free = db.create_canvas_node(&note("p1", "free")).unwrap();
        let p1 = db
            .create_canvas_node(&prompt("p1", "t1", "prompt-1"))
            .unwrap();
        let p2 = db
            .create_canvas_node(&prompt("p1", "t2", "prompt-2"))
            .unwrap();
        let group = db
            .create_canvas_group_with_items(
                &NewCanvasGroup {
                    id: "g".into(),
                    project_id: "p1".into(),
                    name: "跨线程空间组".into(),
                    role: None,
                    x: 0.0,
                    y: 0.0,
                    width: 600.0,
                    height: 300.0,
                    z_index: 0,
                },
                &[free.id.clone(), p1.id.clone(), p2.id.clone()],
            )
            .unwrap();
        assert_eq!(group.project_id, "p1");

        let asset_payload = serde_json::to_string(&AssetNodePayloadV1 {
            schema_version: 1,
            snapshot: AssetSnapshotV1 {
                name: "结果".into(),
                width: None,
                height: None,
            },
            execution: None,
        })
        .unwrap();
        let output = db
            .create_canvas_node(&NewCanvasNode {
                id: "output".into(),
                project_id: "p1".into(),
                thread_id: Some("t1".into()),
                kind: CreativeNodeKind::Asset,
                asset_id: None,
                role: Some(CreativeNodeRole::Output),
                payload_json: asset_payload,
                x: 500.0,
                y: 0.0,
                width: 190.0,
                height: 180.0,
                z_index: 2,
                position_locked: false,
            })
            .unwrap();
        db.create_canvas_edge(&NewCanvasEdge {
            id: "edge".into(),
            project_id: "p1".into(),
            thread_id: "t1".into(),
            from_node_id: p1.id,
            to_node_id: output.id.clone(),
            kind: CreativeEdgeKind::Produced,
            ordinal: 0,
        })
        .unwrap();
        assert!(db
            .create_canvas_edge(&NewCanvasEdge {
                id: "cross".into(),
                project_id: "p1".into(),
                thread_id: "t1".into(),
                from_node_id: output.id,
                to_node_id: p2.id,
                kind: CreativeEdgeKind::Continued,
                ordinal: 0,
            })
            .is_err());
    }

    #[test]
    fn agent_reference_nodes_keep_execution_identity_and_are_only_hidden() {
        let db = db();
        materialize(&db, "p1");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "Agent 线程".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,created_at) VALUES ('reference-asset','参考图',1)",
                [],
            )
            .unwrap();
        }
        let launch = ProjectAgentLaunchInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            launch_id: "launch-1".into(),
            prompt: "制作海报".into(),
            provider: "bowerbird-agent".into(),
            ratio: Some("1:1".into()),
            visual_profile: None,
            reference_asset_ids: vec!["reference-asset".into()],
            reference_node_ids: vec![],
            parent_node_id: None,
            parent_asset_id: None,
        };

        let graph = db.begin_project_agent_launch(&launch).unwrap();
        let reference_node_id = graph.reference_node_ids.first().unwrap();
        let reference_node = db.get_canvas_node(reference_node_id).unwrap().unwrap();
        let payload: AssetNodePayloadV1 =
            serde_json::from_str(&reference_node.payload_json).unwrap();
        assert_eq!(
            payload.execution.and_then(|execution| execution.run_id),
            Some("launch-1".into())
        );
        assert!(matches!(
            db.remove_canvas_node(reference_node_id).unwrap(),
            Some(CanvasNodeRemoval::Hidden)
        ));
        assert!(db
            .get_canvas_node(reference_node_id)
            .unwrap()
            .unwrap()
            .hidden_at
            .is_some());

        db.begin_project_agent_launch(&launch).unwrap();
        assert!(db
            .get_canvas_node(reference_node_id)
            .unwrap()
            .unwrap()
            .hidden_at
            .is_some());
    }

    #[test]
    fn deleting_asset_keeps_tombstone_thread_archives_and_running_work_blocks_project_delete() {
        let db = db();
        materialize(&db, "p1");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "线程".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,created_at) VALUES ('a','素材',1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,created_at) VALUES ('kept','项目资产',1)",
                [],
            )
            .unwrap();
        }
        db.add_assets_to_project("p1", &["kept".into()]).unwrap();
        let payload = serde_json::to_string(&AssetNodePayloadV1 {
            schema_version: 1,
            snapshot: AssetSnapshotV1 {
                name: "素材".into(),
                width: None,
                height: None,
            },
            execution: None,
        })
        .unwrap();
        db.create_canvas_node(&NewCanvasNode {
            id: "asset-node".into(),
            project_id: "p1".into(),
            thread_id: None,
            kind: CreativeNodeKind::Asset,
            asset_id: Some("a".into()),
            role: Some(CreativeNodeRole::Reference),
            payload_json: payload,
            x: 0.0,
            y: 0.0,
            width: 190.0,
            height: 180.0,
            z_index: 0,
            position_locked: false,
        })
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("DELETE FROM assets WHERE id='a'", []).unwrap();
        }
        assert_eq!(
            db.get_canvas_node("asset-node").unwrap().unwrap().asset_id,
            None
        );
        assert!(db.archive_creative_thread("t1").unwrap());
        assert!(db
            .get_creative_thread("t1")
            .unwrap()
            .unwrap()
            .archived_at
            .is_some());
        assert!(!db.archive_creative_thread("t1").unwrap());
        assert!(db.restore_creative_thread("t1").unwrap());
        assert!(db
            .get_creative_thread("t1")
            .unwrap()
            .unwrap()
            .archived_at
            .is_none());
        assert!(!db.restore_creative_thread("t1").unwrap());
        assert!(db.archive_creative_thread("t1").unwrap());

        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO task_queue (id,kind,payload,status,created_at,project_id,thread_id) VALUES ('job','generation','{}','running',1,'p1','t1')",
                [],
            )
            .unwrap();
        }
        let impact = db.project_delete_impact("p1").unwrap();
        assert_eq!(impact.project_asset_count, 1);
        assert_eq!(impact.thread_count, 1);
        assert_eq!(impact.node_count, 1);
        assert_eq!(impact.running_generation_count, 1);

        {
            let conn = db.conn.lock().unwrap();
            assert!(conn
                .execute("DELETE FROM projects WHERE id='p1'", [])
                .is_err());
            conn.execute("UPDATE task_queue SET status='done' WHERE id='job'", [])
                .unwrap();
            conn.execute("DELETE FROM projects WHERE id='p1'", [])
                .unwrap();
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM project_canvases", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM assets WHERE id='kept'", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                1,
                "删除项目不得删除中央素材"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM task_queue WHERE id='job'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                1,
                "删除项目不得删除底层执行审计"
            );
        }
    }
    fn reference_placement_fixture() -> Database {
        let db = db();
        materialize(&db, "p1");
        materialize(&db, "p2");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "layout".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        for id in ["existing", "a", "b", "c", "d"] {
            db.conn.lock().unwrap().execute(
                "INSERT INTO assets(id,name,store_path,width,height,created_at) VALUES (?1,?1,?2,400,600,1)",
                params![id, format!("/{id}.png")],
            ).unwrap();
        }
        let mut original = output("p1", "t1", "original", "existing");
        original.role = Some(CreativeNodeRole::Reference);
        original.x = 50.0;
        original.y = 70.0;
        db.create_canvas_node(&original).unwrap();
        let mut far = note("p1", "far");
        far.x = 20_000.0;
        db.create_canvas_node(&far).unwrap();
        let mut foreign = original;
        foreign.id = "foreign".into();
        foreign.project_id = "p2".into();
        foreign.thread_id = None;
        foreign.asset_id = Some("a".into());
        db.create_canvas_node(&foreign).unwrap();
        db
    }

    fn launch_layout_references(
        db: &Database,
        agent: bool,
        launch: &str,
        refs: &[&str],
        parent: bool,
    ) -> ProjectGenerationTurnGraph {
        if agent {
            db.begin_project_agent_launch(&ProjectAgentLaunchInput {
                project_id: "p1".into(),
                thread_id: "t1".into(),
                launch_id: launch.into(),
                prompt: "layout".into(),
                provider: "bowerbird-cloud".into(),
                ratio: None,
                visual_profile: None,
                reference_asset_ids: refs.iter().map(|id| id.to_string()).collect(),
                reference_node_ids: vec![],
                parent_node_id: parent.then(|| "parent".into()),
                parent_asset_id: parent.then(|| "existing".into()),
            })
            .unwrap()
        } else {
            db.begin_project_generation_turn(&ProjectGenerationTurnInput {
                project_id: "p1".into(),
                thread_id: "t1".into(),
                generation_conversation_id: "conversation".into(),
                job_id: launch.into(),
                turn_key: "turn".into(),
                prompt: "layout".into(),
                applied_prompt: "layout".into(),
                provider: "jimeng".into(),
                provider_session_id: None,
                ratio: None,
                visual_profile: None,
                references: refs.iter().map(|id| format!("/{id}.png")).collect(),
                reference_node_ids: vec![],
                parent_node_id: parent.then(|| "parent".into()),
                parent_asset_path: parent.then(|| "/existing.png".into()),
                relation: parent.then_some(
                    crate::core::creative_session_contract::CreativeGenerationRelation::Continued,
                ),
            })
            .unwrap()
        }
    }

    fn assert_reference_rects_clear(db: &Database, ids: &[String]) {
        let snapshot = db.project_canvas_snapshot("p1").unwrap();
        for id in ids {
            let a = snapshot.nodes.iter().find(|node| &node.id == id).unwrap();
            for b in snapshot
                .nodes
                .iter()
                .filter(|node| node.id != a.id && node.hidden_at.is_none())
            {
                assert!(
                    a.x + a.width <= b.x
                        || b.x + b.width <= a.x
                        || a.y + a.height <= b.y
                        || b.y + b.height <= a.y,
                    "overlap: {} and {}",
                    a.id,
                    b.id
                );
            }
            for g in &snapshot.groups {
                assert!(
                    a.x + a.width <= g.x
                        || g.x + g.width <= a.x
                        || a.y + a.height <= g.y
                        || g.y + g.height <= a.y
                );
            }
        }
    }

    fn assert_same_canvas_layout(before: &[CanvasNode], after: &[CanvasNode]) {
        assert_eq!(before.len(), after.len());
        for (a, b) in before.iter().zip(after) {
            assert_eq!(
                (
                    &a.id,
                    &a.thread_id,
                    &a.asset_id,
                    a.x,
                    a.y,
                    a.width,
                    a.height,
                    a.position_locked,
                    a.hidden_at
                ),
                (
                    &b.id,
                    &b.thread_id,
                    &b.asset_id,
                    b.x,
                    b.y,
                    b.width,
                    b.height,
                    b.position_locked,
                    b.hidden_at
                )
            );
        }
    }

    #[test]
    fn new_references_stay_near_card_despite_far_nodes_and_keep_existing_inputs() {
        for agent in [false, true] {
            let db = reference_placement_fixture();
            let original = db.get_canvas_node("original").unwrap().unwrap();
            let foreign = db.get_canvas_node("foreign").unwrap().unwrap();
            let graph = launch_layout_references(
                &db,
                agent,
                "mixed",
                &["existing", "a", "b", "a", "c", "d"],
                false,
            );
            let card = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
            assert_eq!(
                (card.x, card.y),
                (312.0, 70.0),
                "new inputs must not drag the card to the global right edge"
            );
            assert_eq!(graph.reference_node_ids.len(), 5);
            assert_eq!(graph.reference_node_ids[0], "original");
            let refs = &graph.reference_node_ids[1..];
            for id in refs {
                let node = db.get_canvas_node(id).unwrap().unwrap();
                assert!((node.x - card.x).abs() < 900.0 && (node.y - card.y).abs() < 900.0);
            }
            assert_reference_rects_clear(&db, refs);
            assert_eq!(db.get_canvas_node("original").unwrap().unwrap(), original);
            assert_eq!(db.get_canvas_node("foreign").unwrap().unwrap(), foreign);
            let before = db.project_canvas_snapshot("p1").unwrap();
            assert_eq!(
                launch_layout_references(
                    &db,
                    agent,
                    "mixed",
                    &["existing", "a", "b", "a", "c", "d"],
                    false
                ),
                graph
            );
            assert_same_canvas_layout(
                &before.nodes,
                &db.project_canvas_snapshot("p1").unwrap().nodes,
            );
            println!(
                "REFERENCE_COORDS agent={agent} card=({}, {}) refs={:?}",
                card.x,
                card.y,
                before
                    .nodes
                    .iter()
                    .filter(|n| refs.contains(&n.id))
                    .map(|n| (&n.id, n.x, n.y, n.width, n.height))
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn library_reference_reuses_existing_instances_without_creating_another() {
        for agent in [false, true] {
            let db = reference_placement_fixture();
            let mut duplicate = output("p1", "t1", "second-instance", "existing");
            duplicate.role = Some(CreativeNodeRole::Reference);
            duplicate.x = 5000.0;
            db.create_canvas_node(&duplicate).unwrap();
            let graph =
                launch_layout_references(&db, agent, "reuse", &["existing", "existing"], false);
            assert_eq!(graph.reference_node_ids, vec!["original"]);
            assert_eq!(
                db.project_canvas_snapshot("p1")
                    .unwrap()
                    .nodes
                    .iter()
                    .filter(|node| node.asset_id.as_deref() == Some("existing"))
                    .count(),
                2
            );
            assert_eq!(
                db.get_canvas_node("second-instance").unwrap().unwrap().x,
                5000.0
            );
        }
    }

    #[test]
    fn missing_references_on_replay_follow_moved_visible_card_and_avoid_groups() {
        for agent in [false, true] {
            let db = reference_placement_fixture();
            let graph = launch_layout_references(&db, agent, "replay", &[], false);
            let card_id = if agent {
                let payload: AgentGroupNodePayloadV1 = serde_json::from_value(serde_json::json!({
                    "schema_version":1,"run_id":"run","skill_id":"bowerbird-unified-agent","status":"running"
                })).unwrap();
                db.project_agent_run_on_canvas("p1", "t1", "replay", &payload)
                    .unwrap()
            } else {
                graph.prompt_node_id.clone()
            };
            let card = db.get_canvas_node(&card_id).unwrap().unwrap();
            db.update_canvas_node_layout(
                &card_id,
                &CanvasNodeLayoutUpdate {
                    x: -1600.0,
                    y: -800.0,
                    width: card.width,
                    height: card.height,
                    z_index: card.z_index,
                    position_locked: true,
                },
            )
            .unwrap();
            // Reserve the first slot with a real persisted material group.
            db.create_canvas_group_with_items(
                &NewCanvasGroup {
                    id: "obstacle".into(),
                    project_id: "p1".into(),
                    name: "group".into(),
                    role: None,
                    x: -1600.0,
                    y: -800.0 + card.height + 40.0,
                    width: 190.0,
                    height: 272.0,
                    z_index: 0,
                },
                &[],
            )
            .unwrap();
            let before = db.project_canvas_snapshot("p1").unwrap();
            let restored = launch_layout_references(&db, agent, "replay", &["a", "b"], false);
            for id in &restored.reference_node_ids {
                let node = db.get_canvas_node(id).unwrap().unwrap();
                assert!(
                    node.x >= -1600.0 && node.x < -700.0 && node.y >= -800.0 && node.y < 200.0,
                    "reference must follow the moved card, got ({},{})",
                    node.x,
                    node.y
                );
            }
            assert_reference_rects_clear(&db, &restored.reference_node_ids);
            for node in before.nodes {
                let after = db.get_canvas_node(&node.id).unwrap().unwrap();
                assert_eq!(
                    (
                        after.x,
                        after.y,
                        after.width,
                        after.height,
                        after.position_locked
                    ),
                    (
                        node.x,
                        node.y,
                        node.width,
                        node.height,
                        node.position_locked
                    )
                );
                if node.kind == CreativeNodeKind::Asset {
                    assert_eq!(after, node);
                }
            }
            let saved = db.project_canvas_snapshot("p1").unwrap();
            launch_layout_references(&db, agent, "replay", &["a", "b"], false);
            assert_same_canvas_layout(
                &saved.nodes,
                &db.project_canvas_snapshot("p1").unwrap().nodes,
            );
        }
    }

    #[test]
    fn continuation_references_use_parent_region_and_startup_video_recovery_is_stable() {
        for agent in [false, true] {
            let db = reference_placement_fixture();
            let mut parent = output("p1", "t1", "parent", "existing");
            parent.x = -2000.0;
            parent.y = 1400.0;
            db.create_canvas_node(&parent).unwrap();
            let graph = launch_layout_references(&db, agent, "continued", &["a"], true);
            let card = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
            assert_eq!((card.x, card.y), (-1738.0, 1400.0));
            let reference = db
                .get_canvas_node(&graph.reference_node_ids[0])
                .unwrap()
                .unwrap();
            assert!((reference.x - card.x).abs() < 900.0 && (reference.y - card.y).abs() < 500.0);
            assert_reference_rects_clear(&db, &graph.reference_node_ids);
            if !agent {
                let job: crate::core::task_queue::GenJob = serde_json::from_value(serde_json::json!({
                    "id":"continued","media":"video","provider":"jimeng","status":"running","prompt":"layout","created_at":1,
                    "project_id":"p1","thread_id":"t1","turn_key":"turn","conversation_id":"conversation",
                    "references":["/a.png"],"parent_node_id":"parent","parent_asset_path":"/existing.png","creative_relation":"continued"
                })).unwrap();
                for _ in 0..2 {
                    crate::core::generation_worker::recover_project_generation_projection(
                        &db, &job, "running",
                    )
                    .unwrap();
                    assert_eq!(
                        db.get_canvas_node(&reference.id).unwrap().unwrap(),
                        reference
                    );
                }
            }
        }
    }
    #[test]
    fn generation_reuses_the_exact_canvas_reference_node_instead_of_copying_it() {
        let db = db();
        materialize(&db, "p1");
        db.create_creative_thread(&NewCreativeThread {
            id: "t1".into(),
            project_id: "p1".into(),
            title: "生成线程".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO assets (id,name,store_path,created_at) VALUES ('asset-1','原参考图','/asset-1.png',1)",
                [],
            )
            .unwrap();
        }
        db.create_creative_thread(&NewCreativeThread {
            id: "reference-owner".into(),
            project_id: "p1".into(),
            title: "此前使用参考图的线程".into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
        let mut original = output("p1", "reference-owner", "original-reference", "asset-1");
        original.role = Some(CreativeNodeRole::Reference);
        original.x = 37.0;
        original.y = 59.0;
        db.create_canvas_node(&original).unwrap();

        let mut input = ProjectGenerationTurnInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            generation_conversation_id: "conversation-1".into(),
            job_id: "job-1".into(),
            turn_key: "turn-1".into(),
            prompt: "参考原图生成".into(),
            applied_prompt: "参考原图生成".into(),
            provider: "test-provider".into(),
            provider_session_id: None,
            ratio: None,
            visual_profile: None,
            references: vec!["/asset-1.png".into()],
            reference_node_ids: vec![Some("original-reference".into())],
            parent_node_id: None,
            parent_asset_path: None,
            relation: None,
        };
        let graph = db.begin_project_generation_turn(&input).unwrap();

        assert_eq!(graph.reference_node_ids, vec!["original-reference"]);
        let snapshot = db.project_canvas_snapshot("p1").unwrap();
        assert_eq!(
            snapshot
                .nodes
                .iter()
                .filter(|node| node.asset_id.as_deref() == Some("asset-1"))
                .count(),
            1
        );
        let preserved = snapshot
            .nodes
            .iter()
            .find(|node| node.id == "original-reference")
            .unwrap();
        assert_eq!((preserved.x, preserved.y), (37.0, 59.0));
        assert_eq!(preserved.thread_id.as_deref(), Some("reference-owner"));
        assert!(snapshot.edges.iter().any(|edge| {
            edge.kind == CreativeEdgeKind::Input
                && edge.from_node_id == "original-reference"
                && edge.to_node_id == graph.prompt_node_id
        }));

        // Without a chip node id, unique project-wide lookup must reuse it too.
        input.job_id = "job-fallback".into();
        input.turn_key = "turn-fallback".into();
        input.reference_node_ids.clear();
        let fallback = db.begin_project_generation_turn(&input).unwrap();
        assert_eq!(fallback.reference_node_ids, vec!["original-reference"]);
        assert_eq!(db.begin_project_generation_turn(&input).unwrap(), fallback);

        // A previous generated result can be referenced directly, even when the
        // same central asset also has another instance in this project.
        let generated = output("p1", "reference-owner", "generated-reference", "asset-1");
        db.create_canvas_node(&generated).unwrap();
        input.job_id = "job-output-reference".into();
        input.turn_key = "turn-output-reference".into();
        input.reference_node_ids = vec![Some("generated-reference".into())];
        let from_output = db.begin_project_generation_turn(&input).unwrap();
        assert_eq!(from_output.reference_node_ids, vec!["generated-reference"]);
        assert_eq!(db.project_canvas_snapshot("p1").unwrap().nodes.iter().filter(|n| n.asset_id.as_deref()==Some("asset-1")).count(),2);

        input.job_id = "job-invalid".into();
        input.turn_key = "turn-invalid".into();
        input.reference_node_ids = vec![Some("original-reference".into())];
        input.references = vec!["/different-asset.png".into()];
        assert!(db
            .begin_project_generation_turn(&input)
            .unwrap_err()
            .to_string()
            .contains("does not match"));
        input.references = vec!["/asset-1.png".into()];
        db.remove_canvas_node("original-reference").unwrap();
        assert!(db.begin_project_generation_turn(&input).is_err());
    }

}
