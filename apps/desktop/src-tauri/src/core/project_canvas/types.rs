//! Persisted canvas and IPC types, re-exported from project_canvas.
use serde::{Deserialize, Serialize};

use crate::core::creative_session_contract::{CreativeEdgeKind, CreativeGroupRole, CreativeNodeKind, CreativeNodeRole, CreativeThreadOrigin, VisualProfileRefV1};

pub const PROJECT_CANVAS_DRAFT_SCHEMA_VERSION: u64 = 1;
pub const MIN_PROJECT_CANVAS_ZOOM: f64 = 0.1;
pub const MAX_PROJECT_CANVAS_ZOOM: f64 = 2.4;

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
    /// 失败重试的叠放锚点：被重试失败轮的 prompt 节点。新卡原样落在它的位置（原卡保留），
    /// 不再按参考图脑图式落位。纯展示约定：锚点不存在/已隐藏时静默回退常规落位。
    pub retry_anchor_node_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_is_video: Option<bool>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasNodeBatchLayout {
    pub node_id: String,
    pub value: CanvasNodeLayoutUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasGroupBatchCreate {
    pub value: NewCanvasGroup,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct CanvasBatchCreated {
    pub nodes: Vec<CanvasNode>,
    pub groups: Vec<CanvasGroup>,
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


pub fn clamp_project_source_panel_width(value: f64, workspace_width: f64) -> f64 {
    let min = 240.0_f64.min(workspace_width * 0.42);
    let max = min.max(workspace_width * 0.55);
    value.clamp(min, max)
}
