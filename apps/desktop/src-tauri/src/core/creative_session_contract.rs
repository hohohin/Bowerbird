//! `PROJECT-CANVAS-PLAN` PB0/PB1 冻结的项目画板创作图契约。
//!
//! 本模块定义闭集词汇、版本化节点 payload、节点/边语义与迁移 fixture 校验；
//! SQLite repository 复用相同校验，避免存储层另起一套规则。

#![allow(dead_code)] // CS0 fixture 回放 API 仅在测试与后续历史迁移阶段调用。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const CREATIVE_NODE_PAYLOAD_SCHEMA_VERSION: u8 = 1;
pub const MAX_CREATIVE_NODE_PAYLOAD_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreativeNodeKind {
    Asset,
    Prompt,
    AgentGroup,
    Note,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreativeNodeRole {
    Reference,
    Output,
    Intermediate,
    Final,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreativeGroupRole {
    Base,
    Style,
    Composition,
    Candidate,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreativeEdgeKind {
    Input,
    Produced,
    Continued,
    Retry,
    Branch,
    AgentStep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreativeGenerationRelation {
    Continued,
    Retry,
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CreativeThreadOrigin {
    Direct,
    GenerationBackfill,
    AgentBackfill,
    MergedLegacy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetSnapshotV1 {
    pub name: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetExecutionRefV1 {
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub turn_key: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub artifact_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetNodePayloadV1 {
    pub schema_version: u8,
    pub snapshot: AssetSnapshotV1,
    #[serde(default)]
    pub execution: Option<AssetExecutionRefV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VisualProfileRefV1 {
    pub profile_id: String,
    pub version: i64,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptNodePayloadV1 {
    pub schema_version: u8,
    pub text: String,
    #[serde(default)]
    pub applied_prompt: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub turn_key: Option<String>,
    #[serde(default)]
    pub ratio: Option<String>,
    #[serde(default)]
    pub visual_profile: Option<VisualProfileRefV1>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentGroupEventV1 {
    pub seq: i64,
    pub event_type: String,
    #[serde(default)]
    pub step: Option<String>,
    #[serde(default)]
    pub progress: Option<u8>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentGroupApprovalV1 {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub proposal_hash: String,
    pub planned_tool_count: u32,
    pub estimated_additional_credits: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentGroupClarificationV1 {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub question: Option<String>,
    #[serde(default)]
    pub recommended_answer: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentGroupArtifactV1 {
    pub artifact_id: String,
    pub role: String,
    #[serde(default)]
    pub step_id: Option<String>,
    pub mime: String,
    pub user_visible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentGroupNodePayloadV1 {
    pub schema_version: u8,
    pub run_id: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub skill_id: String,
    pub status: String,
    #[serde(default)]
    pub agent_runtime: Option<String>,
    #[serde(default)]
    pub current_step: Option<String>,
    #[serde(default)]
    pub progress: Option<u8>,
    #[serde(default)]
    pub budget_credits: Option<i64>,
    #[serde(default)]
    pub actual_credits: Option<i64>,
    #[serde(default)]
    pub visual_profile: Option<VisualProfileRefV1>,
    #[serde(default)]
    pub events: Vec<AgentGroupEventV1>,
    #[serde(default)]
    pub approvals: Vec<AgentGroupApprovalV1>,
    #[serde(default)]
    pub clarifications: Vec<AgentGroupClarificationV1>,
    #[serde(default)]
    pub artifacts: Vec<AgentGroupArtifactV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteNodePayloadV1 {
    pub schema_version: u8,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_type: Option<CanvasNoteType>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cells: Vec<Vec<CanvasTextCell>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub member_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height_percent: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bubble_tail: Option<CanvasBubbleTail>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Relative column widths / row heights for the text table; f64 breaks Eq.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_widths: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_heights: Option<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanvasBubbleTail {
    pub side: CanvasBubbleSide,
    pub position: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasBubbleSide { Top, Right, Bottom, Left }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasNoteType {
    Text,
    Images,
    Section,
    Bubble,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasTextAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanvasTextCell {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<CanvasCellContentType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub align: CanvasTextAlign,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_refs: Vec<CanvasCellImageRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasCellContentType { Text, Image }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CanvasCellImageRef {
    pub asset_id: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CreativeNodePayload {
    Asset(AssetNodePayloadV1),
    Prompt(PromptNodePayloadV1),
    AgentGroup(AgentGroupNodePayloadV1),
    Note(NoteNodePayloadV1),
}

#[derive(Debug, Error)]
pub enum CreativeContractError {
    #[error("creative node payload exceeds {MAX_CREATIVE_NODE_PAYLOAD_BYTES} bytes")]
    PayloadTooLarge,
    #[error("text card rows must have the same nonzero number of columns")]
    InvalidNoteGrid,
    #[error("text card line height must be between 100 and 300 percent")]
    InvalidNoteLineHeight,
    #[error("text card grid sizes must match the table and stay positive")]
    InvalidNoteGridLayout,
    #[error("bubble notes require one cell and an edge position between 0 and 100")]
    InvalidBubbleNote,
    #[error("invalid creative JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("creative node payload is missing integer schema_version")]
    MissingSchemaVersion,
    #[error("unsupported creative node payload schema_version {0}")]
    UnsupportedSchemaVersion(u64),
    #[error("node {node_id} has incompatible role {role:?} for kind {kind:?}")]
    IncompatibleNodeRole {
        node_id: String,
        kind: CreativeNodeKind,
        role: Option<CreativeNodeRole>,
    },
    #[error("duplicate node id {0}")]
    DuplicateNode(String),
    #[error("duplicate edge id {0}")]
    DuplicateEdge(String),
    #[error("edge {edge_id} references unknown node {node_id}")]
    UnknownEdgeNode { edge_id: String, node_id: String },
    #[error("edge {edge_id} has invalid {kind:?} endpoints")]
    InvalidEdgeEndpoints {
        edge_id: String,
        kind: CreativeEdgeKind,
    },
    #[error("creative fixture graph contains a cycle")]
    CyclicGraph,
    #[error("project canvas fixture is missing project_id")]
    MissingProjectId,
    #[error("duplicate creative thread id {0}")]
    DuplicateThread(String),
    #[error("node {node_id} references unknown creative thread {thread_id}")]
    UnknownNodeThread { node_id: String, thread_id: String },
    #[error("node {node_id} requires a creative thread")]
    MissingNodeThread { node_id: String },
    #[error("edge {edge_id} references unknown creative thread {thread_id}")]
    UnknownEdgeThread { edge_id: String, thread_id: String },
    #[error("edge {edge_id} crosses creative thread {thread_id}")]
    CrossThreadEdge { edge_id: String, thread_id: String },
}

/// PB0 fixture: one project canvas may contain multiple independent creative threads.
/// Nodes without a thread are project-wide free references/notes; all execution nodes and
/// every semantic edge remain explicitly owned by one thread.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectCanvasMigrationFixture {
    pub name: String,
    pub project_id: String,
    pub threads: Vec<ProjectCanvasFixtureThread>,
    pub nodes: Vec<ProjectCanvasFixtureNode>,
    pub edges: Vec<ProjectCanvasFixtureEdge>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectCanvasFixtureThread {
    pub id: String,
    pub origin: CreativeThreadOrigin,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectCanvasFixtureNode {
    pub id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub kind: CreativeNodeKind,
    #[serde(default)]
    pub role: Option<CreativeNodeRole>,
    pub payload: Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectCanvasFixtureEdge {
    pub id: String,
    pub thread_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: CreativeEdgeKind,
    pub ordinal: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreativeMigrationFixture {
    pub name: String,
    pub nodes: Vec<CreativeFixtureNode>,
    pub edges: Vec<CreativeFixtureEdge>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreativeFixtureNode {
    pub id: String,
    pub kind: CreativeNodeKind,
    #[serde(default)]
    pub role: Option<CreativeNodeRole>,
    pub payload: Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreativeFixtureEdge {
    pub id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: CreativeEdgeKind,
    pub ordinal: i64,
    pub created_at: i64,
}

pub fn parse_and_validate_project_canvas_fixture(
    fixture_json: &str,
) -> Result<ProjectCanvasMigrationFixture, CreativeContractError> {
    let fixture: ProjectCanvasMigrationFixture = serde_json::from_str(fixture_json)?;
    validate_project_canvas_fixture(&fixture)?;
    Ok(fixture)
}

pub fn validate_project_canvas_fixture(
    fixture: &ProjectCanvasMigrationFixture,
) -> Result<(), CreativeContractError> {
    if fixture.project_id.trim().is_empty() {
        return Err(CreativeContractError::MissingProjectId);
    }
    let mut thread_ids = HashSet::new();
    for thread in &fixture.threads {
        if !thread_ids.insert(thread.id.as_str()) {
            return Err(CreativeContractError::DuplicateThread(thread.id.clone()));
        }
    }

    let mut nodes = HashMap::new();
    for node in &fixture.nodes {
        if nodes.insert(node.id.as_str(), node).is_some() {
            return Err(CreativeContractError::DuplicateNode(node.id.clone()));
        }
        validate_node_kind_role(&node.id, node.kind, node.role)?;
        let payload_json = serde_json::to_string(&node.payload)?;
        parse_node_payload(node.kind, &payload_json)?;
        match node.thread_id.as_deref() {
            Some(thread_id) if !thread_ids.contains(thread_id) => {
                return Err(CreativeContractError::UnknownNodeThread {
                    node_id: node.id.clone(),
                    thread_id: thread_id.to_string(),
                });
            }
            None if project_canvas_node_requires_thread(node.kind, node.role) => {
                return Err(CreativeContractError::MissingNodeThread {
                    node_id: node.id.clone(),
                });
            }
            _ => {}
        }
    }

    let mut edge_ids = HashSet::new();
    for edge in &fixture.edges {
        if !edge_ids.insert(edge.id.as_str()) {
            return Err(CreativeContractError::DuplicateEdge(edge.id.clone()));
        }
        if !thread_ids.contains(edge.thread_id.as_str()) {
            return Err(CreativeContractError::UnknownEdgeThread {
                edge_id: edge.id.clone(),
                thread_id: edge.thread_id.clone(),
            });
        }
        let from = nodes.get(edge.from_node_id.as_str()).ok_or_else(|| {
            CreativeContractError::UnknownEdgeNode {
                edge_id: edge.id.clone(),
                node_id: edge.from_node_id.clone(),
            }
        })?;
        let to = nodes.get(edge.to_node_id.as_str()).ok_or_else(|| {
            CreativeContractError::UnknownEdgeNode {
                edge_id: edge.id.clone(),
                node_id: edge.to_node_id.clone(),
            }
        })?;
        for endpoint in [from, to] {
            if endpoint
                .thread_id
                .as_deref()
                .is_some_and(|thread_id| thread_id != edge.thread_id)
            {
                return Err(CreativeContractError::CrossThreadEdge {
                    edge_id: edge.id.clone(),
                    thread_id: edge.thread_id.clone(),
                });
            }
        }
        if !edge_endpoints_are_valid(edge.kind, from.kind, from.role, to.kind, to.role) {
            return Err(CreativeContractError::InvalidEdgeEndpoints {
                edge_id: edge.id.clone(),
                kind: edge.kind,
            });
        }
    }

    project_canvas_replay_order(fixture)?;
    Ok(())
}

pub fn project_canvas_node_requires_thread(
    kind: CreativeNodeKind,
    role: Option<CreativeNodeRole>,
) -> bool {
    matches!(
        kind,
        CreativeNodeKind::Prompt | CreativeNodeKind::AgentGroup
    ) || matches!(
        role,
        Some(CreativeNodeRole::Output | CreativeNodeRole::Intermediate | CreativeNodeRole::Final)
    )
}

/// Deterministic project replay order. Spatial coordinates are deliberately irrelevant;
/// semantic edges, ordinal, timestamp and stable ids are sufficient after project/thread
/// ownership has been validated.
pub fn project_canvas_replay_order(
    fixture: &ProjectCanvasMigrationFixture,
) -> Result<Vec<String>, CreativeContractError> {
    let mut indegree: HashMap<&str, usize> = fixture
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), 0))
        .collect();
    let mut outgoing: HashMap<&str, Vec<&ProjectCanvasFixtureEdge>> = HashMap::new();
    for edge in &fixture.edges {
        *indegree.entry(edge.to_node_id.as_str()).or_default() += 1;
        outgoing
            .entry(edge.from_node_id.as_str())
            .or_default()
            .push(edge);
    }
    let node_by_id: HashMap<&str, &ProjectCanvasFixtureNode> = fixture
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut ready: Vec<&ProjectCanvasFixtureNode> = fixture
        .nodes
        .iter()
        .filter(|node| indegree[node.id.as_str()] == 0)
        .collect();
    let mut ordered = Vec::with_capacity(fixture.nodes.len());

    while !ready.is_empty() {
        ready.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        let node = ready.pop().expect("ready was checked as non-empty");
        ordered.push(node.id.clone());
        let mut edges = outgoing.remove(node.id.as_str()).unwrap_or_default();
        edges.sort_by(|a, b| {
            a.ordinal
                .cmp(&b.ordinal)
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        for edge in edges {
            let remaining = indegree
                .get_mut(edge.to_node_id.as_str())
                .expect("validated endpoint exists");
            *remaining -= 1;
            if *remaining == 0 {
                ready.push(node_by_id[edge.to_node_id.as_str()]);
            }
        }
    }
    if ordered.len() != fixture.nodes.len() {
        return Err(CreativeContractError::CyclicGraph);
    }
    Ok(ordered)
}

pub fn parse_node_payload(
    kind: CreativeNodeKind,
    payload_json: &str,
) -> Result<CreativeNodePayload, CreativeContractError> {
    if payload_json.len() > MAX_CREATIVE_NODE_PAYLOAD_BYTES {
        return Err(CreativeContractError::PayloadTooLarge);
    }
    let value = serde_json::from_str(payload_json)?;
    parse_node_payload_value(kind, value)
}

fn parse_node_payload_value(
    kind: CreativeNodeKind,
    value: Value,
) -> Result<CreativeNodePayload, CreativeContractError> {
    let version = value
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or(CreativeContractError::MissingSchemaVersion)?;
    if version != u64::from(CREATIVE_NODE_PAYLOAD_SCHEMA_VERSION) {
        return Err(CreativeContractError::UnsupportedSchemaVersion(version));
    }
    Ok(match kind {
        CreativeNodeKind::Asset => CreativeNodePayload::Asset(serde_json::from_value(value)?),
        CreativeNodeKind::Prompt => CreativeNodePayload::Prompt(serde_json::from_value(value)?),
        CreativeNodeKind::AgentGroup => {
            CreativeNodePayload::AgentGroup(serde_json::from_value(value)?)
        }
        CreativeNodeKind::Note => {
            let note: NoteNodePayloadV1 = serde_json::from_value(value)?;
            if note.note_type == Some(CanvasNoteType::Images) && note.cells.is_empty() {
                return Err(CreativeContractError::InvalidNoteGrid);
            }
            if note.cells.iter().flatten().any(|cell| cell.image_refs.iter().any(|image| image.asset_id.is_empty() || image.token.is_empty())) {
                return Err(CreativeContractError::InvalidNoteGrid);
            }
            if note.line_height_percent.is_some_and(|height| !(100..=300).contains(&height)) {
                return Err(CreativeContractError::InvalidNoteLineHeight);
            }
            let bubble = note.note_type == Some(CanvasNoteType::Bubble);
            if (bubble && (note.cells.len() != 1 || note.cells[0].len() != 1))
                || note.bubble_tail.as_ref().is_some_and(|tail| !bubble || tail.position > 100)
            {
                return Err(CreativeContractError::InvalidBubbleNote);
            }
            if let Some(first) = note.cells.first() {
                if first.is_empty() || note.cells.iter().any(|row| row.len() != first.len()) {
                    return Err(CreativeContractError::InvalidNoteGrid);
                }
            }
            let valid_sizes = |sizes: Option<&Vec<f64>>, expected: usize| {
                sizes.map_or(true, |sizes| {
                    sizes.len() == expected
                        && sizes.iter().all(|size| size.is_finite() && *size > 0.0)
                })
            };
            let columns = note.cells.first().map_or(0, Vec::len);
            if !valid_sizes(note.column_widths.as_ref(), columns)
                || !valid_sizes(note.row_heights.as_ref(), note.cells.len())
            {
                return Err(CreativeContractError::InvalidNoteGridLayout);
            }
            CreativeNodePayload::Note(note)
        }
    })
}

pub fn parse_and_validate_fixture(
    fixture_json: &str,
) -> Result<CreativeMigrationFixture, CreativeContractError> {
    let fixture: CreativeMigrationFixture = serde_json::from_str(fixture_json)?;
    validate_fixture(&fixture)?;
    Ok(fixture)
}

pub fn validate_fixture(fixture: &CreativeMigrationFixture) -> Result<(), CreativeContractError> {
    let mut nodes = HashMap::new();
    for node in &fixture.nodes {
        if nodes.insert(node.id.as_str(), node).is_some() {
            return Err(CreativeContractError::DuplicateNode(node.id.clone()));
        }
        validate_node_kind_role(&node.id, node.kind, node.role)?;
        let payload_json = serde_json::to_string(&node.payload)?;
        parse_node_payload(node.kind, &payload_json)?;
    }

    let mut edge_ids = HashSet::new();
    for edge in &fixture.edges {
        if !edge_ids.insert(edge.id.as_str()) {
            return Err(CreativeContractError::DuplicateEdge(edge.id.clone()));
        }
        let from = nodes.get(edge.from_node_id.as_str()).ok_or_else(|| {
            CreativeContractError::UnknownEdgeNode {
                edge_id: edge.id.clone(),
                node_id: edge.from_node_id.clone(),
            }
        })?;
        let to = nodes.get(edge.to_node_id.as_str()).ok_or_else(|| {
            CreativeContractError::UnknownEdgeNode {
                edge_id: edge.id.clone(),
                node_id: edge.to_node_id.clone(),
            }
        })?;
        if !edge_endpoints_are_valid(edge.kind, from.kind, from.role, to.kind, to.role) {
            return Err(CreativeContractError::InvalidEdgeEndpoints {
                edge_id: edge.id.clone(),
                kind: edge.kind,
            });
        }
    }

    semantic_replay_order(fixture)?;
    Ok(())
}

pub fn validate_node_kind_role(
    node_id: &str,
    kind: CreativeNodeKind,
    role: Option<CreativeNodeRole>,
) -> Result<(), CreativeContractError> {
    let compatible = match kind {
        CreativeNodeKind::Asset => role.is_some(),
        CreativeNodeKind::Prompt | CreativeNodeKind::AgentGroup | CreativeNodeKind::Note => {
            role.is_none()
        }
    };
    if compatible {
        Ok(())
    } else {
        Err(CreativeContractError::IncompatibleNodeRole {
            node_id: node_id.to_string(),
            kind,
            role,
        })
    }
}

pub fn edge_endpoints_are_valid(
    kind: CreativeEdgeKind,
    from_kind: CreativeNodeKind,
    from_role: Option<CreativeNodeRole>,
    to_kind: CreativeNodeKind,
    to_role: Option<CreativeNodeRole>,
) -> bool {
    match kind {
        CreativeEdgeKind::Input => {
            matches!(
                to_kind,
                CreativeNodeKind::Prompt | CreativeNodeKind::AgentGroup
            ) && matches!(
                from_kind,
                CreativeNodeKind::Asset | CreativeNodeKind::Prompt
            )
        }
        CreativeEdgeKind::Produced => {
            matches!(
                from_kind,
                CreativeNodeKind::Prompt | CreativeNodeKind::AgentGroup
            ) && to_kind == CreativeNodeKind::Asset
                && matches!(
                    to_role,
                    Some(CreativeNodeRole::Output | CreativeNodeRole::Final)
                )
        }
        CreativeEdgeKind::Continued | CreativeEdgeKind::Retry | CreativeEdgeKind::Branch => {
            from_kind == CreativeNodeKind::Asset
                && matches!(
                    from_role,
                    Some(
                        CreativeNodeRole::Output
                            | CreativeNodeRole::Intermediate
                            | CreativeNodeRole::Final
                    )
                )
                && to_kind == CreativeNodeKind::Prompt
        }
        CreativeEdgeKind::AgentStep => {
            from_kind == CreativeNodeKind::AgentGroup
                && to_kind == CreativeNodeKind::Asset
                && matches!(
                    to_role,
                    Some(CreativeNodeRole::Intermediate | CreativeNodeRole::Final)
                )
        }
    }
}

/// 用显式边生成确定性回放顺序。坐标不是 fixture 字段，也不会参与排序。
pub fn semantic_replay_order(
    fixture: &CreativeMigrationFixture,
) -> Result<Vec<String>, CreativeContractError> {
    let mut indegree: HashMap<&str, usize> = fixture
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), 0))
        .collect();
    let mut outgoing: HashMap<&str, Vec<&CreativeFixtureEdge>> = HashMap::new();
    for edge in &fixture.edges {
        *indegree.entry(edge.to_node_id.as_str()).or_default() += 1;
        outgoing
            .entry(edge.from_node_id.as_str())
            .or_default()
            .push(edge);
    }

    let node_by_id: HashMap<&str, &CreativeFixtureNode> = fixture
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut ready: Vec<&CreativeFixtureNode> = fixture
        .nodes
        .iter()
        .filter(|node| indegree[node.id.as_str()] == 0)
        .collect();
    let mut ordered = Vec::with_capacity(fixture.nodes.len());

    while !ready.is_empty() {
        ready.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        let node = ready.pop().expect("ready was checked as non-empty");
        ordered.push(node.id.clone());
        let mut edges = outgoing.remove(node.id.as_str()).unwrap_or_default();
        edges.sort_by(|a, b| {
            a.ordinal
                .cmp(&b.ordinal)
                .then_with(|| a.created_at.cmp(&b.created_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        for edge in edges {
            let remaining = indegree
                .get_mut(edge.to_node_id.as_str())
                .expect("validated edge endpoint exists");
            *remaining -= 1;
            if *remaining == 0 {
                ready.push(node_by_id[edge.to_node_id.as_str()]);
            }
        }
    }

    if ordered.len() != fixture.nodes.len() {
        return Err(CreativeContractError::CyclicGraph);
    }
    Ok(ordered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    const FIXTURES: [(&str, &str); 5] = [
        (
            "single_turn",
            include_str!("../../fixtures/creative_session/single_turn.json"),
        ),
        (
            "multi_turn",
            include_str!("../../fixtures/creative_session/multi_turn.json"),
        ),
        (
            "retry_branch",
            include_str!("../../fixtures/creative_session/retry_branch.json"),
        ),
        (
            "cross_provider",
            include_str!("../../fixtures/creative_session/cross_provider.json"),
        ),
        (
            "agent_run",
            include_str!("../../fixtures/creative_session/agent_run.json"),
        ),
    ];

    const PROJECT_CANVAS_FIXTURES: [(&str, &str); 5] = [
        (
            "single_project_multi_thread",
            include_str!("../../fixtures/project_canvas/single_project_multi_thread.json"),
        ),
        (
            "free_reference_reuse",
            include_str!("../../fixtures/project_canvas/free_reference_reuse.json"),
        ),
        (
            "ordinary_agent_ordinary",
            include_str!("../../fixtures/project_canvas/ordinary_agent_ordinary.json"),
        ),
        (
            "cross_provider",
            include_str!("../../fixtures/project_canvas/cross_provider.json"),
        ),
        (
            "retry_branch",
            include_str!("../../fixtures/project_canvas/retry_branch.json"),
        ),
    ];

    #[test]
    fn five_project_canvas_fixtures_replay_from_project_thread_edges_and_stable_ids() {
        for (expected_name, json) in PROJECT_CANVAS_FIXTURES {
            assert!(!json.contains("\"x\""));
            assert!(!json.contains("\"y\""));
            let fixture = parse_and_validate_project_canvas_fixture(json).unwrap();
            assert_eq!(fixture.name, expected_name);
            assert_eq!(fixture.project_id, "project-a");
            assert_eq!(
                project_canvas_replay_order(&fixture).unwrap().len(),
                fixture.nodes.len()
            );
        }

        let multi =
            parse_and_validate_project_canvas_fixture(PROJECT_CANVAS_FIXTURES[0].1).unwrap();
        assert_eq!(multi.threads.len(), 2, "同一项目必须可容纳多条线程");
        let shared =
            parse_and_validate_project_canvas_fixture(PROJECT_CANVAS_FIXTURES[1].1).unwrap();
        assert_eq!(
            shared
                .edges
                .iter()
                .filter(|edge| edge.from_node_id == "shared-reference")
                .count(),
            2,
            "同一自由参考节点可被不同线程引用"
        );
        assert_eq!(
            shared
                .nodes
                .iter()
                .find(|node| node.id == "shared-reference")
                .unwrap()
                .thread_id,
            None
        );
    }

    #[test]
    fn project_canvas_fixture_rejects_cross_thread_edge_and_unowned_execution_node() {
        let cross_thread = r#"{
          "name":"bad","project_id":"p",
          "threads":[{"id":"a","origin":"direct","created_at":1},{"id":"b","origin":"direct","created_at":2}],
          "nodes":[
            {"id":"p","thread_id":"a","kind":"prompt","payload":{"schema_version":1,"text":"x"},"created_at":1},
            {"id":"o","thread_id":"b","kind":"asset","role":"output","payload":{"schema_version":1,"snapshot":{"name":"x"}},"created_at":2}
          ],
          "edges":[{"id":"e","thread_id":"a","from_node_id":"p","to_node_id":"o","kind":"produced","ordinal":0,"created_at":2}]
        }"#;
        assert!(matches!(
            parse_and_validate_project_canvas_fixture(cross_thread),
            Err(CreativeContractError::CrossThreadEdge { .. })
        ));

        let missing_thread = r#"{
          "name":"bad","project_id":"p","threads":[],
          "nodes":[{"id":"p","kind":"prompt","payload":{"schema_version":1,"text":"x"},"created_at":1}],
          "edges":[]
        }"#;
        assert!(matches!(
            parse_and_validate_project_canvas_fixture(missing_thread),
            Err(CreativeContractError::MissingNodeThread { .. })
        ));
    }

    #[test]
    fn five_migration_fixtures_validate_without_coordinates() {
        for (expected_name, json) in FIXTURES {
            assert!(!json.contains("\"x\""));
            assert!(!json.contains("\"y\""));
            let fixture = parse_and_validate_fixture(json).unwrap();
            assert_eq!(fixture.name, expected_name);
            let order = semantic_replay_order(&fixture).unwrap();
            assert_eq!(order.len(), fixture.nodes.len());

            let conn = spike_database();
            conn.execute(
                "INSERT INTO creative_sessions (id, title, title_source, draft_json, created_at, updated_at, last_opened_at) VALUES ('fixture-session',?1,'default','{}',1,1,1)",
                [expected_name],
            )
            .unwrap();
            for node in &fixture.nodes {
                let asset_id = if node.kind == CreativeNodeKind::Asset {
                    let asset_id = format!("asset:{}", node.id);
                    conn.execute("INSERT INTO assets (id) VALUES (?1)", [&asset_id])
                        .unwrap();
                    Some(asset_id)
                } else {
                    None
                };
                let kind = enum_sql(&node.kind);
                let role = node.role.as_ref().map(enum_sql);
                let payload = serde_json::to_string(&node.payload).unwrap();
                conn.execute(
                    "INSERT INTO creative_nodes (id, creative_session_id, kind, asset_id, role, payload_json, x, y, width, height, z_index, created_at, updated_at) VALUES (?1,'fixture-session',?2,?3,?4,?5,0,0,100,100,0,?6,?6)",
                    params![node.id, kind, asset_id, role, payload, node.created_at],
                )
                .unwrap();
            }
            for edge in &fixture.edges {
                conn.execute(
                    "INSERT INTO creative_edges (id, creative_session_id, from_node_id, to_node_id, kind, ordinal, created_at) VALUES (?1,'fixture-session',?2,?3,?4,?5,?6)",
                    params![
                        edge.id,
                        edge.from_node_id,
                        edge.to_node_id,
                        enum_sql(&edge.kind),
                        edge.ordinal,
                        edge.created_at
                    ],
                )
                .unwrap();
            }
            let stored_nodes: i64 = conn
                .query_row("SELECT COUNT(*) FROM creative_nodes", [], |row| row.get(0))
                .unwrap();
            let stored_edges: i64 = conn
                .query_row("SELECT COUNT(*) FROM creative_edges", [], |row| row.get(0))
                .unwrap();
            assert_eq!(stored_nodes as usize, fixture.nodes.len());
            assert_eq!(stored_edges as usize, fixture.edges.len());
        }
    }

    #[test]
    fn payload_rejects_unknown_version_kind_shape_and_oversize() {
        let version_error = parse_node_payload(
            CreativeNodeKind::Note,
            r#"{"schema_version":2,"text":"future"}"#,
        )
        .unwrap_err();
        assert!(matches!(
            version_error,
            CreativeContractError::UnsupportedSchemaVersion(2)
        ));

        let wrong_shape = parse_node_payload(
            CreativeNodeKind::Asset,
            r#"{"schema_version":1,"text":"not an asset"}"#,
        );
        assert!(matches!(
            wrong_shape,
            Err(CreativeContractError::InvalidJson(_))
        ));

        let oversized = format!(
            r#"{{"schema_version":1,"text":"{}"}}"#,
            "x".repeat(MAX_CREATIVE_NODE_PAYLOAD_BYTES)
        );
        assert!(matches!(
            parse_node_payload(CreativeNodeKind::Note, &oversized),
            Err(CreativeContractError::PayloadTooLarge)
        ));
    }

    #[test]
    fn schema_spike_enforces_group_membership_order_and_delete_semantics() {
        let conn = spike_database();
        insert_session_and_nodes(&conn);

        conn.execute(
            "INSERT INTO creative_groups (id, creative_session_id, name, x, y, width, height, z_index, created_at, updated_at) VALUES ('g1','s1','素材组 A',0,0,100,100,0,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO creative_groups (id, creative_session_id, name, x, y, width, height, z_index, created_at, updated_at) VALUES ('g2','s1','素材组 B',0,0,100,100,1,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO creative_group_items (group_id, node_id, ordinal) VALUES ('g1','n1',0),('g1','n2',1)",
            [],
        )
        .unwrap();

        let ordered: Vec<String> = conn
            .prepare(
                "SELECT node_id FROM creative_group_items WHERE group_id='g1' ORDER BY ordinal",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(ordered, ["n1", "n2"]);

        assert!(conn
            .execute(
                "INSERT INTO creative_group_items (group_id, node_id, ordinal) VALUES ('g2','n1',0)",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO creative_group_items (group_id, node_id, ordinal) VALUES ('g1','n3',1)",
                [],
            )
            .is_err());

        conn.execute("DELETE FROM creative_groups WHERE id='g1'", [])
            .unwrap();
        let nodes_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM creative_nodes", [], |row| row.get(0))
            .unwrap();
        let memberships_left: i64 = conn
            .query_row("SELECT COUNT(*) FROM creative_group_items", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(nodes_left, 4, "解组/删组不能删除画板节点");
        assert_eq!(memberships_left, 0);
    }

    #[test]
    fn schema_spike_rejects_cross_session_group_and_edges() {
        let conn = spike_database();
        insert_session_and_nodes(&conn);
        conn.execute(
            "INSERT INTO creative_groups (id, creative_session_id, name, x, y, width, height, z_index, created_at, updated_at) VALUES ('g-other','s2','另一创作',0,0,100,100,0,1,1)",
            [],
        )
        .unwrap();
        assert!(conn
            .execute(
                "INSERT INTO creative_group_items (group_id, node_id, ordinal) VALUES ('g-other','n1',0)",
                [],
            )
            .is_err());
        assert!(conn
            .execute(
                "INSERT INTO creative_edges (id, creative_session_id, from_node_id, to_node_id, kind, ordinal, created_at) VALUES ('e-cross','s1','n1','n-other','input',0,1)",
                [],
            )
            .is_err());
    }

    #[test]
    fn schema_spike_preserves_tombstones_and_project_deletion_degrades_to_global() {
        let conn = spike_database();
        insert_session_and_nodes(&conn);
        conn.execute("DELETE FROM assets WHERE id='a1'", [])
            .unwrap();
        let asset_id: Option<String> = conn
            .query_row(
                "SELECT asset_id FROM creative_nodes WHERE id='n1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(asset_id, None, "资产节点必须保留为 tombstone");

        conn.execute("DELETE FROM projects WHERE id='p1'", [])
            .unwrap();
        let project_id: Option<String> = conn
            .query_row(
                "SELECT project_id FROM creative_sessions WHERE id='s1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_id, None, "项目删除后创作必须转为全局");
    }

    #[test]
    fn note_payload_accepts_title_and_grid_sizes_and_rejects_mismatches() {
        let note_json = r#"{"schema_version":1,"text":"表格","note_type":"text","title":"配方表","column_widths":[2.0,1.0],"row_heights":[1.0,3.0],"cells":[[{"text":"a","bold":false,"italic":false,"align":"left"},{"text":"b","bold":false,"italic":false,"align":"left"}],[{"text":"c","bold":false,"italic":false,"align":"left"},{"text":"d","bold":false,"italic":false,"align":"left"}]]}"#;
        let CreativeNodePayload::Note(note) =
            parse_node_payload(CreativeNodeKind::Note, note_json).unwrap()
        else {
            panic!("note payload expected");
        };
        assert_eq!(note.title.as_deref(), Some("配方表"));
        assert_eq!(note.column_widths.as_deref(), Some(&[2.0, 1.0][..]));
        assert_eq!(note.row_heights.as_deref(), Some(&[1.0, 3.0][..]));

        let single = r#"{"schema_version":1,"text":"","note_type":"text","cells":[[{"text":"","bold":false,"italic":false,"align":"left"}]]}"#;
        assert!(parse_node_payload(CreativeNodeKind::Note, single).is_ok());

        for bad in [
            // Width vector shorter than the two columns of the table.
            r#"{"schema_version":1,"text":"","note_type":"text","column_widths":[1.0],"cells":[[{"text":"","bold":false,"italic":false,"align":"left"},{"text":"","bold":false,"italic":false,"align":"left"}]]}"#,
            // Row vector longer than the single table row.
            r#"{"schema_version":1,"text":"","note_type":"text","row_heights":[1.0,1.0],"cells":[[{"text":"","bold":false,"italic":false,"align":"left"}]]}"#,
            // Zero and non-finite weights are both rejected.
            r#"{"schema_version":1,"text":"","note_type":"text","column_widths":[0.0],"cells":[[{"text":"","bold":false,"italic":false,"align":"left"}]]}"#,
            r#"{"schema_version":1,"text":"","note_type":"text","column_widths":[-1.5],"cells":[[{"text":"","bold":false,"italic":false,"align":"left"}]]}"#,
        ] {
            assert!(
                matches!(
                    parse_node_payload(CreativeNodeKind::Note, bad),
                    Err(CreativeContractError::InvalidNoteGridLayout)
                ),
                "expected grid layout rejection: {bad}"
            );
        }
    }

    fn spike_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        conn.execute_batch(include_str!("../../spikes/canvas_session_cs0.sql"))
            .unwrap();
        conn
    }

    fn enum_sql<T: Serialize>(value: &T) -> String {
        serde_json::to_string(value)
            .unwrap()
            .trim_matches('"')
            .to_string()
    }

    fn insert_session_and_nodes(conn: &Connection) {
        conn.execute("INSERT INTO projects (id) VALUES ('p1')", [])
            .unwrap();
        conn.execute("INSERT INTO assets (id) VALUES ('a1')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO creative_sessions (id, project_id, title, title_source, draft_json, created_at, updated_at, last_opened_at) VALUES ('s1','p1','一','default','{}',1,1,1),('s2',NULL,'二','default','{}',1,1,1)",
            [],
        )
        .unwrap();
        for (id, session, asset, role, payload) in [
            (
                "n1",
                "s1",
                Some("a1"),
                Some("reference"),
                r#"{"schema_version":1,"snapshot":{"name":"素材 A"}}"#,
            ),
            (
                "n2",
                "s1",
                None,
                Some("output"),
                r#"{"schema_version":1,"snapshot":{"name":"结果 A"}}"#,
            ),
            (
                "n3",
                "s1",
                None,
                None,
                r#"{"schema_version":1,"text":"说明"}"#,
            ),
            (
                "n-other",
                "s2",
                None,
                Some("reference"),
                r#"{"schema_version":1,"snapshot":{"name":"另一素材"}}"#,
            ),
        ] {
            let kind = if id == "n3" { "note" } else { "asset" };
            conn.execute(
                "INSERT INTO creative_nodes (id, creative_session_id, kind, asset_id, role, payload_json, x, y, width, height, z_index, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,0,0,100,100,0,1,1)",
                params![id, session, kind, asset, role, payload],
            )
            .unwrap();
        }
    }
}
