//! PROJECT-CANVAS-PLAN PB5 history reconstruction.
//!
//! The source of truth is the original generation/Agent history. The unpublished
//! `creative_sessions` development schema is deliberately never read here.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{Datelike, TimeZone, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::core::creative_session_contract::{
    AgentGroupApprovalV1, AgentGroupArtifactV1, AgentGroupClarificationV1, AgentGroupEventV1,
    AgentGroupNodePayloadV1, CreativeGenerationRelation, CreativeThreadOrigin, VisualProfileRefV1,
};
use crate::core::project_canvas::{
    NewCreativeThread, ProjectAgentLaunchInput, ProjectCanvasMaterializeInput,
    ProjectGenerationTurnInput, ProjectTitleSource,
};
use crate::db::Database;
use crate::error::{AppError, AppResult};

const BACKFILL_VERSION: i64 = 2;
const UNSCOPED_NODE_LIMIT: usize = 1_000;
const EMPTY_DRAFT: &str = r#"{"schema_version":1}"#;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackfillSourceCounts {
    pub discovered: usize,
    pub migrated: usize,
    pub skipped: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSourceDistribution {
    pub project_id: Option<String>,
    pub generation_sources: usize,
    pub agent_sources: usize,
    pub estimated_nodes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEstimate {
    pub project_id: String,
    pub project_name: String,
    pub source_count: usize,
    pub thread_count: usize,
    pub estimated_nodes: usize,
    pub estimated_width: f64,
    pub estimated_height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCanvasBackfillPreview {
    pub backfill_version: i64,
    pub schema_version: i64,
    pub migration_lineage: String,
    pub has_unpublished_creative_sessions: bool,
    pub has_project_canvases: bool,
    pub generation: BackfillSourceCounts,
    pub agent: BackfillSourceCounts,
    pub asset_count: i64,
    pub generation_conversation_count: i64,
    pub agent_run_count: i64,
    pub existing_project_count: i64,
    pub target_project_count: usize,
    pub target_thread_count: usize,
    pub estimated_node_count: usize,
    pub deterministic_correlations: usize,
    pub deterministic_merges: usize,
    pub unscoped_shard_rule: String,
    pub project_source_distribution: Vec<ProjectSourceDistribution>,
    pub canvases: Vec<CanvasEstimate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCanvasBackfillReport {
    pub report_id: String,
    pub backfill_version: i64,
    pub generation: BackfillSourceCounts,
    pub agent: BackfillSourceCounts,
    pub asset_count_before: i64,
    pub asset_count_after: i64,
    pub project_count_before: i64,
    pub project_count_after: i64,
    pub thread_count_before: i64,
    pub thread_count_after: i64,
    pub node_count_before: i64,
    pub node_count_after: i64,
    pub edge_count_before: i64,
    pub edge_count_after: i64,
    pub generation_link_count_before: i64,
    pub generation_link_count_after: i64,
    pub agent_link_count_before: i64,
    pub agent_link_count_after: i64,
    pub asset_copies: usize,
    pub deterministic_correlations: usize,
    pub deterministic_merges: usize,
    pub unexplained_differences: Vec<String>,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone)]
struct GenerationRow {
    analysis_id: String,
    asset_id: String,
    payload: serde_json::Value,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct GenerationTurn {
    job_id: String,
    turn_key: String,
    prompt: String,
    applied_prompt: String,
    provider: String,
    provider_session_id: Option<String>,
    visual_profile: Option<VisualProfileRefV1>,
    references: Vec<String>,
    output_asset_ids: Vec<String>,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct GenerationSource {
    id: String,
    rows: Vec<GenerationRow>,
    tasks: Vec<serde_json::Value>,
    project_id: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct AgentSource {
    run_id: String,
    conversation_id: String,
    skill_id: String,
    status: String,
    intent_prompt: String,
    reference_asset_ids: Vec<String>,
    project_id: Option<String>,
    snapshot: serde_json::Value,
    final_asset_id: Option<String>,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct Discovery {
    generations: BTreeMap<String, GenerationSource>,
    agents: BTreeMap<String, AgentSource>,
    existing_projects: BTreeMap<String, String>,
    asset_id_by_path: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct LayoutPlan {
    project_for_source: HashMap<String, String>,
    project_names: BTreeMap<String, String>,
    thread_for_source: HashMap<String, String>,
    deterministic_correlations: usize,
    deterministic_merges: usize,
    estimated_nodes_by_project: BTreeMap<String, usize>,
    sources_by_project: BTreeMap<String, usize>,
    threads_by_project: BTreeMap<String, BTreeSet<String>>,
    unscoped_shard_rule: String,
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )?)
}

fn table_count(conn: &rusqlite::Connection, table: &str) -> AppResult<i64> {
    if !table_exists(conn, table)? {
        return Ok(0);
    }
    let sql = format!("SELECT COUNT(*) FROM {table}");
    Ok(conn.query_row(&sql, [], |row| row.get(0))?)
}

fn json_text(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn json_strings(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| json_text(Some(item)))
        .collect()
}

fn stable_id(kind: &str, source_id: &str) -> String {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("project-canvas-v2\0{kind}\0{source_id}").as_bytes())
    );
    format!("history-{kind}-{}", &digest[..24])
}

fn source_key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

fn source_kind_id(key: &str) -> (&str, &str) {
    key.split_once(':').unwrap_or(("generation", key))
}

fn legacy_title(value: &str) -> String {
    let first = value
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("历史创作");
    let title = first
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(64)
        .collect::<String>();
    if title.is_empty() {
        "历史创作".into()
    } else {
        title
    }
}

fn year_for(timestamp: i64) -> i32 {
    Utc.timestamp_opt(timestamp.max(0), 0)
        .single()
        .map(|value| value.year())
        .unwrap_or(1970)
}

fn visual_profile_ref(value: Option<&serde_json::Value>) -> Option<VisualProfileRefV1> {
    let value = value?;
    Some(VisualProfileRefV1 {
        profile_id: json_text(value.get("profile_id"))?,
        version: value.get("version")?.as_i64()?,
        hash: json_text(value.get("hash"))?,
    })
}

fn run_visual_profile_ref(value: &serde_json::Value) -> Option<VisualProfileRefV1> {
    Some(VisualProfileRefV1 {
        profile_id: json_text(value.get("visual_profile_id"))?,
        version: value.get("visual_profile_version")?.as_i64()?,
        hash: json_text(value.get("visual_profile_hash"))?,
    })
}

fn project_candidate(
    values: impl Iterator<Item = Option<String>>,
    existing: &BTreeMap<String, String>,
) -> Option<String> {
    let candidates = values
        .flatten()
        .filter(|id| existing.contains_key(id))
        .collect::<BTreeSet<_>>();
    (candidates.len() == 1).then(|| candidates.into_iter().next().unwrap())
}

impl Database {
    fn discover_project_canvas_history(&self) -> AppResult<Discovery> {
        let conn = self.conn.lock().unwrap();
        let existing_projects = if table_exists(&conn, "projects")? {
            let mut statement = conn.prepare("SELECT id,name FROM projects")?;
            let projects = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<BTreeMap<_, _>, _>>()?;
            projects
        } else {
            BTreeMap::new()
        };

        let mut asset_id_by_path = HashMap::new();
        if table_exists(&conn, "assets")? {
            let mut statement = conn.prepare("SELECT id,store_path FROM assets WHERE store_path IS NOT NULL ORDER BY created_at,id")?;
            for row in statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (id, path) = row?;
                asset_id_by_path.insert(path, id);
            }
        }

        let mut session_map = HashMap::new();
        if table_exists(&conn, "generation_conversations")? {
            let mut statement =
                conn.prepare("SELECT session_id,conversation_id FROM generation_conversations")?;
            for row in statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (session, conversation) = row?;
                session_map.insert(session, conversation);
            }
        }

        let mut rows_by_source: BTreeMap<String, Vec<GenerationRow>> = BTreeMap::new();
        if table_exists(&conn, "analyses")? {
            let mut statement = conn.prepare(
                "SELECT id,asset_id,payload,COALESCE(created_at,0) FROM analyses WHERE kind='generation_meta' ORDER BY COALESCE(created_at,0),id",
            )?;
            for row in statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })? {
                let (analysis_id, asset_id, raw, created_at) = row?;
                let Ok(payload) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                let session_id = json_text(payload.get("session_id"));
                let id = json_text(payload.get("conversation_id"))
                    .or_else(|| {
                        session_id
                            .as_ref()
                            .and_then(|id| session_map.get(id).cloned())
                    })
                    .or(session_id);
                if let Some(id) = id {
                    rows_by_source.entry(id).or_default().push(GenerationRow {
                        analysis_id,
                        asset_id,
                        payload,
                        created_at,
                    });
                }
            }
        }

        let mut tasks_by_source: BTreeMap<String, Vec<serde_json::Value>> = BTreeMap::new();
        if table_exists(&conn, "task_queue")? {
            let mut statement = conn.prepare("SELECT id,payload,COALESCE(created_at,0) FROM task_queue WHERE kind='generation' ORDER BY COALESCE(created_at,0),id")?;
            for row in statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })? {
                let (task_id, raw, created_at) = row?;
                let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                if payload.get("id").is_none() {
                    payload["id"] = serde_json::Value::String(task_id);
                }
                if payload.get("created_at").is_none() {
                    payload["created_at"] = serde_json::Value::Number(created_at.into());
                }
                if let Some(id) = json_text(payload.get("conversation_id"))
                    .or_else(|| json_text(payload.get("id")))
                {
                    tasks_by_source.entry(id).or_default().push(payload);
                }
            }
        }

        let all_generation_ids = rows_by_source
            .keys()
            .chain(tasks_by_source.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut generations = BTreeMap::new();
        for id in all_generation_ids {
            let rows = rows_by_source.remove(&id).unwrap_or_default();
            let tasks = tasks_by_source.remove(&id).unwrap_or_default();
            let project_id = project_candidate(
                rows.iter()
                    .map(|row| json_text(row.payload.get("project_id")))
                    .chain(tasks.iter().map(|task| json_text(task.get("project_id")))),
                &existing_projects,
            );
            let created_at =
                rows.iter()
                    .map(|row| row.created_at)
                    .chain(tasks.iter().filter_map(|task| {
                        task.get("created_at").and_then(serde_json::Value::as_i64)
                    }))
                    .filter(|value| *value > 0)
                    .min()
                    .unwrap_or(0);
            generations.insert(
                id.clone(),
                GenerationSource {
                    id,
                    rows,
                    tasks,
                    project_id,
                    created_at,
                },
            );
        }

        let mut agents = BTreeMap::new();
        if table_exists(&conn, "cloud_agent_runs")? {
            let mut statement = conn.prepare(
                "SELECT run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,project_id,snapshot_json,final_asset_id,COALESCE(created_at,0) FROM cloud_agent_runs ORDER BY COALESCE(created_at,0),run_id",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            })?;
            for row in rows {
                let (
                    run_id,
                    conversation_id,
                    skill_id,
                    status,
                    intent_prompt,
                    refs,
                    raw_project_id,
                    snapshot,
                    final_asset_id,
                    created_at,
                ) = row?;
                let project_id = raw_project_id.filter(|id| existing_projects.contains_key(id));
                agents.insert(
                    run_id.clone(),
                    AgentSource {
                        run_id,
                        conversation_id,
                        skill_id,
                        status,
                        intent_prompt,
                        reference_asset_ids: serde_json::from_str(&refs).unwrap_or_default(),
                        project_id,
                        snapshot: serde_json::from_str(&snapshot).unwrap_or_default(),
                        final_asset_id,
                        created_at,
                    },
                );
            }
        }
        drop(conn);
        Ok(Discovery {
            generations,
            agents,
            existing_projects,
            asset_id_by_path,
        })
    }
}

fn generation_turns(source: &GenerationSource) -> Vec<GenerationTurn> {
    let mut turns: Vec<GenerationTurn> = Vec::new();
    for row in &source.rows {
        let prompt = json_text(row.payload.get("prompt")).unwrap_or_else(|| "历史生成".into());
        let applied_prompt =
            json_text(row.payload.get("applied_prompt")).unwrap_or_else(|| prompt.clone());
        let provider_session_id = json_text(row.payload.get("session_id"));
        let stable = json_text(row.payload.get("turn_key"))
            .or_else(|| json_text(row.payload.get("job_id")))
            .unwrap_or_else(|| {
                format!(
                    "{}\0{}\0{}",
                    provider_session_id.as_deref().unwrap_or(""),
                    prompt,
                    applied_prompt
                )
            });
        if let Some(turn) = turns.iter_mut().rev().find(|turn| turn.turn_key == stable) {
            if !turn.output_asset_ids.contains(&row.asset_id) {
                turn.output_asset_ids.push(row.asset_id.clone());
            }
            continue;
        }
        turns.push(GenerationTurn {
            job_id: json_text(row.payload.get("job_id"))
                .unwrap_or_else(|| stable_id("job", &row.analysis_id)),
            turn_key: stable,
            prompt,
            applied_prompt,
            provider: json_text(row.payload.get("provider")).unwrap_or_else(|| "unknown".into()),
            provider_session_id,
            visual_profile: visual_profile_ref(row.payload.get("visual_profile")),
            references: json_strings(row.payload.get("references")),
            output_asset_ids: vec![row.asset_id.clone()],
            created_at: row.created_at,
        });
    }
    if turns.is_empty() {
        if let Some(task) = source.tasks.first() {
            let prompt = json_text(task.get("prompt")).unwrap_or_else(|| "历史生成".into());
            turns.push(GenerationTurn {
                job_id: json_text(task.get("id")).unwrap_or_else(|| stable_id("job", &source.id)),
                turn_key: json_text(task.get("turn_key"))
                    .unwrap_or_else(|| stable_id("turn", &source.id)),
                prompt: prompt.clone(),
                applied_prompt: json_text(task.get("applied_prompt")).unwrap_or(prompt),
                provider: json_text(task.get("provider")).unwrap_or_else(|| "unknown".into()),
                provider_session_id: json_text(task.get("session_id")),
                visual_profile: visual_profile_ref(task.get("visual_profile")),
                references: json_strings(task.get("references")),
                output_asset_ids: Vec::new(),
                created_at: source.created_at,
            });
        }
    }
    turns
}

fn agent_artifact_id(source: &AgentSource) -> String {
    source
        .snapshot
        .get("artifacts")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .find(|artifact| {
            artifact
                .get("user_visible")
                .and_then(serde_json::Value::as_bool)
                != Some(false)
        })
        .and_then(|artifact| json_text(artifact.get("id")))
        .unwrap_or_else(|| "legacy-final".into())
}

fn expected_generation_node_ids(source: &GenerationSource) -> Vec<String> {
    let mut ids = Vec::new();
    for turn in generation_turns(source) {
        ids.push(format!("gen-prompt:{}:{}:0", turn.job_id, turn.turn_key));
        ids.push(format!("gen-parent:{}:{}:0", turn.job_id, turn.turn_key));
        ids.extend(
            turn.references.iter().enumerate().map(|(index, _)| {
                format!("gen-reference:{}:{}:{index}", turn.job_id, turn.turn_key)
            }),
        );
        ids.extend(
            turn.output_asset_ids
                .iter()
                .map(|asset_id| format!("gen-output:{}:{}:{asset_id}", turn.job_id, turn.turn_key)),
        );
    }
    ids
}

fn expected_agent_node_ids(source: &AgentSource) -> Vec<String> {
    let launch_id = stable_id("agent-launch", &source.run_id);
    let mut ids = vec![
        format!("agent-prompt:{launch_id}:0:0"),
        format!("agent-group:{}:0:0", source.run_id),
    ];
    ids.extend(
        source
            .reference_asset_ids
            .iter()
            .enumerate()
            .map(|(index, _)| format!("agent-reference:{launch_id}:0:{index}")),
    );
    if source.final_asset_id.is_some() {
        ids.push(format!(
            "agent-artifact:{}:0:{}",
            source.run_id,
            agent_artifact_id(source)
        ));
    }
    ids
}

fn source_prompt(discovery: &Discovery, key: &str) -> String {
    let (kind, id) = source_kind_id(key);
    if kind == "agent" {
        return discovery
            .agents
            .get(id)
            .map(|source| source.intent_prompt.clone())
            .unwrap_or_default();
    }
    discovery
        .generations
        .get(id)
        .and_then(|source| {
            generation_turns(source)
                .first()
                .map(|turn| turn.prompt.clone())
        })
        .unwrap_or_else(|| "历史创作".into())
}

fn source_project<'a>(discovery: &'a Discovery, key: &str) -> Option<&'a String> {
    let (kind, id) = source_kind_id(key);
    if kind == "agent" {
        discovery.agents.get(id)?.project_id.as_ref()
    } else {
        discovery.generations.get(id)?.project_id.as_ref()
    }
}

fn source_created_at(discovery: &Discovery, key: &str) -> i64 {
    let (kind, id) = source_kind_id(key);
    if kind == "agent" {
        discovery
            .agents
            .get(id)
            .map(|source| source.created_at)
            .unwrap_or(0)
    } else {
        discovery
            .generations
            .get(id)
            .map(|source| source.created_at)
            .unwrap_or(0)
    }
}

fn estimated_source_nodes(discovery: &Discovery, key: &str) -> usize {
    let (kind, id) = source_kind_id(key);
    if kind == "agent" {
        return discovery
            .agents
            .get(id)
            .map(|source| {
                2 + source.reference_asset_ids.len() + usize::from(source.final_asset_id.is_some())
            })
            .unwrap_or(0);
    }
    discovery
        .generations
        .get(id)
        .map(|source| {
            generation_turns(source)
                .iter()
                .map(|turn| 1 + turn.references.len() + turn.output_asset_ids.len())
                .sum()
        })
        .unwrap_or(0)
}

fn find_root(parent: &mut HashMap<String, String>, key: &str) -> String {
    let current = parent.get(key).cloned().unwrap_or_else(|| key.to_string());
    if current == key {
        return current;
    }
    let root = find_root(parent, &current);
    parent.insert(key.to_string(), root.clone());
    root
}

fn union(parent: &mut HashMap<String, String>, left: &str, right: &str) -> bool {
    let left_root = find_root(parent, left);
    let right_root = find_root(parent, right);
    if left_root == right_root {
        return false;
    }
    let (root, child) = if left_root < right_root {
        (left_root, right_root)
    } else {
        (right_root, left_root)
    };
    parent.insert(child, root);
    true
}

fn build_layout_plan(discovery: &Discovery) -> LayoutPlan {
    let keys = discovery
        .generations
        .keys()
        .map(|id| source_key("generation", id))
        .chain(discovery.agents.keys().map(|id| source_key("agent", id)))
        .collect::<Vec<_>>();
    let mut parent = keys
        .iter()
        .map(|key| (key.clone(), key.clone()))
        .collect::<HashMap<_, _>>();
    let mut owners: HashMap<String, BTreeSet<String>> = HashMap::new();
    for source in discovery.generations.values() {
        let key = source_key("generation", &source.id);
        for row in &source.rows {
            owners
                .entry(row.asset_id.clone())
                .or_default()
                .insert(key.clone());
        }
    }
    for source in discovery.agents.values() {
        if let Some(asset_id) = &source.final_asset_id {
            owners
                .entry(asset_id.clone())
                .or_default()
                .insert(source_key("agent", &source.run_id));
        }
    }
    let unique_owner = owners
        .into_iter()
        .filter_map(|(asset, keys)| {
            (keys.len() == 1).then(|| (asset, keys.into_iter().next().unwrap()))
        })
        .collect::<HashMap<_, _>>();
    let mut correlations = BTreeSet::new();
    for source in discovery.generations.values() {
        let key = source_key("generation", &source.id);
        for turn in generation_turns(source) {
            for path in turn.references {
                let Some(asset_id) = discovery.asset_id_by_path.get(&path) else {
                    continue;
                };
                let Some(owner) = unique_owner.get(asset_id) else {
                    continue;
                };
                if owner != &key
                    && source_project(discovery, owner) == source_project(discovery, &key)
                {
                    let pair = if owner < &key {
                        (owner.clone(), key.clone())
                    } else {
                        (key.clone(), owner.clone())
                    };
                    correlations.insert(pair);
                }
            }
        }
    }
    for source in discovery.agents.values() {
        let key = source_key("agent", &source.run_id);
        for asset_id in &source.reference_asset_ids {
            let Some(owner) = unique_owner.get(asset_id) else {
                continue;
            };
            if owner != &key && source_project(discovery, owner) == source_project(discovery, &key)
            {
                let pair = if owner < &key {
                    (owner.clone(), key.clone())
                } else {
                    (key.clone(), owner.clone())
                };
                correlations.insert(pair);
            }
        }
    }
    let deterministic_merges = correlations
        .iter()
        .filter(|(left, right)| union(&mut parent, left, right))
        .count();
    let mut component_for_source = HashMap::new();
    for key in &keys {
        component_for_source.insert(key.clone(), find_root(&mut parent, key));
    }
    let unscoped_nodes = keys
        .iter()
        .filter(|key| source_project(discovery, key).is_none())
        .map(|key| estimated_source_nodes(discovery, key))
        .sum::<usize>();
    let shard_by_year = unscoped_nodes > UNSCOPED_NODE_LIMIT;
    let unscoped_shard_rule = if shard_by_year {
        format!("estimated unscoped nodes {unscoped_nodes} > {UNSCOPED_NODE_LIMIT}; split by source year")
    } else {
        format!("estimated unscoped nodes {unscoped_nodes} <= {UNSCOPED_NODE_LIMIT}; one 未归档创作 project")
    };
    let mut project_names = discovery.existing_projects.clone();
    let mut project_for_source = HashMap::new();
    for key in &keys {
        let project_id = if let Some(project_id) = source_project(discovery, key) {
            project_id.clone()
        } else if shard_by_year {
            let year = year_for(source_created_at(discovery, key));
            let id = format!("system-unarchived-creations-{year}");
            project_names.insert(id.clone(), format!("未归档创作 {year}"));
            id
        } else {
            let id = "system-unarchived-creations".to_string();
            project_names.insert(id.clone(), "未归档创作".into());
            id
        };
        project_for_source.insert(key.clone(), project_id);
    }
    let mut thread_for_source = HashMap::new();
    for key in &keys {
        let component = component_for_source.get(key).unwrap();
        thread_for_source.insert(key.clone(), stable_id("thread", component));
    }
    let mut estimated_nodes_by_project = BTreeMap::new();
    let mut sources_by_project = BTreeMap::new();
    let mut threads_by_project: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for key in &keys {
        let project = project_for_source.get(key).unwrap().clone();
        *estimated_nodes_by_project
            .entry(project.clone())
            .or_insert(0) += estimated_source_nodes(discovery, key);
        *sources_by_project.entry(project.clone()).or_insert(0) += 1;
        threads_by_project
            .entry(project)
            .or_default()
            .insert(thread_for_source.get(key).unwrap().clone());
    }
    LayoutPlan {
        project_for_source,
        project_names,
        thread_for_source,
        deterministic_correlations: correlations.len(),
        deterministic_merges,
        estimated_nodes_by_project,
        sources_by_project,
        threads_by_project,
        unscoped_shard_rule,
    }
}

fn agent_payload(source: &AgentSource) -> AgentGroupNodePayloadV1 {
    let run = source
        .snapshot
        .get("run")
        .unwrap_or(&serde_json::Value::Null);
    let events = source
        .snapshot
        .get("events")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .skip(values.len().saturating_sub(96))
                .filter_map(|event| {
                    Some(AgentGroupEventV1 {
                        seq: event.get("seq")?.as_i64()?,
                        event_type: json_text(event.get("type"))?,
                        step: json_text(event.get("step")),
                        progress: event
                            .get("progress")
                            .and_then(serde_json::Value::as_u64)
                            .map(|value| value.min(100) as u8),
                        summary: event
                            .get("display_payload")
                            .and_then(|payload| {
                                ["summary", "message", "title", "goal", "rationale"]
                                    .into_iter()
                                    .find_map(|key| json_text(payload.get(key)))
                            })
                            .map(|value| value.chars().take(240).collect()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let approvals = source
        .snapshot
        .get("approvals")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .skip(values.len().saturating_sub(16))
                .filter_map(|approval| {
                    let proposal = approval.get("proposal");
                    Some(AgentGroupApprovalV1 {
                        id: json_text(approval.get("id"))?,
                        kind: json_text(approval.get("kind"))?,
                        status: json_text(approval.get("status"))?,
                        proposal_hash: json_text(approval.get("proposal_hash")).unwrap_or_default(),
                        planned_tool_count: approval
                            .get("planned_tool_count")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0)
                            .min(u32::MAX as u64)
                            as u32,
                        estimated_additional_credits: approval
                            .get("estimated_additional_credits")
                            .and_then(serde_json::Value::as_i64)
                            .unwrap_or(0),
                        title: proposal.and_then(|value| json_text(value.get("title"))),
                        summary: proposal.and_then(|value| json_text(value.get("summary"))),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let clarifications = source
        .snapshot
        .get("clarifications")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .skip(values.len().saturating_sub(8))
                .filter_map(|value| {
                    let question = value.get("question");
                    Some(AgentGroupClarificationV1 {
                        id: json_text(value.get("id"))?,
                        status: json_text(value.get("status"))?,
                        question: question.and_then(|item| json_text(item.get("question"))),
                        recommended_answer: question
                            .and_then(|item| json_text(item.get("recommendedAnswer"))),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let artifacts = source
        .snapshot
        .get("artifacts")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    Some(AgentGroupArtifactV1 {
                        artifact_id: json_text(value.get("id"))?,
                        role: json_text(value.get("role"))?,
                        step_id: json_text(value.get("step_id")),
                        mime: json_text(value.get("mime"))?,
                        user_visible: value
                            .get("user_visible")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .take(64)
                .collect()
        })
        .unwrap_or_default();
    AgentGroupNodePayloadV1 {
        schema_version: 1,
        run_id: source.run_id.clone(),
        conversation_id: Some(source.conversation_id.clone()),
        skill_id: source.skill_id.clone(),
        status: source.status.clone(),
        agent_runtime: json_text(run.get("agent_runtime")),
        current_step: json_text(run.get("current_step")),
        progress: run
            .get("progress")
            .and_then(serde_json::Value::as_u64)
            .map(|value| value.min(100) as u8),
        budget_credits: run
            .get("budget_credits")
            .and_then(serde_json::Value::as_i64),
        actual_credits: run
            .get("actual_credits")
            .and_then(serde_json::Value::as_i64),
        visual_profile: run_visual_profile_ref(run),
        events,
        approvals,
        clarifications,
        artifacts,
    }
}

impl Database {
    fn v2_source_status(&self, kind: &str, id: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        if !table_exists(&conn, "project_canvas_backfill_sources")? {
            return Ok(None);
        }
        Ok(conn.query_row(
            "SELECT status FROM project_canvas_backfill_sources WHERE backfill_version=?1 AND source_kind=?2 AND source_id=?3",
            params![BACKFILL_VERSION, kind, id], |row| row.get(0),
        ).optional()?)
    }

    fn record_v2_source(
        &self,
        kind: &str,
        id: &str,
        status: &str,
        project_id: Option<&str>,
        thread_id: Option<&str>,
        node_ids: &[String],
        diagnostic: Option<&str>,
    ) -> AppResult<()> {
        let now = Utc::now().timestamp();
        let region = self.region_for_nodes(node_ids)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO project_canvas_backfill_sources (backfill_version,source_kind,source_id,status,project_id,thread_id,region_json,diagnostic,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9) ON CONFLICT(backfill_version,source_kind,source_id) DO UPDATE SET status=excluded.status,project_id=excluded.project_id,thread_id=excluded.thread_id,region_json=excluded.region_json,diagnostic=excluded.diagnostic,updated_at=excluded.updated_at",
            params![BACKFILL_VERSION, kind, id, status, project_id, thread_id, region, diagnostic, now],
        )?;
        Ok(())
    }

    fn region_for_nodes(&self, node_ids: &[String]) -> AppResult<Option<String>> {
        if node_ids.is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock().unwrap();
        let mut left = f64::INFINITY;
        let mut top = f64::INFINITY;
        let mut right = f64::NEG_INFINITY;
        let mut bottom = f64::NEG_INFINITY;
        let mut count = 0usize;
        for id in node_ids {
            if let Some((x, y, width, height)) = conn
                .query_row(
                    "SELECT x,y,width,height FROM canvas_nodes WHERE id=?1",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, f64>(0)?,
                            row.get::<_, f64>(1)?,
                            row.get::<_, f64>(2)?,
                            row.get::<_, f64>(3)?,
                        ))
                    },
                )
                .optional()?
            {
                left = left.min(x);
                top = top.min(y);
                right = right.max(x + width);
                bottom = bottom.max(y + height);
                count += 1;
            }
        }
        if count == 0 {
            return Ok(None);
        }
        Ok(Some(serde_json::json!({"x":left,"y":top,"width":right-left,"height":bottom-top,"nodeCount":count}).to_string()))
    }

    fn ensure_backfill_project(
        &self,
        discovery: &Discovery,
        plan: &LayoutPlan,
        project_id: &str,
    ) -> AppResult<()> {
        if discovery.existing_projects.contains_key(project_id) {
            self.ensure_project_canvas(project_id)?;
            return Ok(());
        }
        let name = plan.project_names.get(project_id).ok_or_else(|| {
            AppError::Other(format!("missing system project title for {project_id}"))
        })?;
        self.materialize_project_canvas(
            &ProjectCanvasMaterializeInput {
                project_id: project_id.into(),
                name: name.clone(),
                workspace_path: format!("system:{project_id}"),
                workspace_key: format!("system:{project_id}"),
                kind: "builtin".into(),
                title_source: ProjectTitleSource::Manual,
                draft_json: EMPTY_DRAFT.into(),
            },
            &[],
            &[],
            None,
        )?;
        Ok(())
    }

    fn ensure_backfill_thread(
        &self,
        discovery: &Discovery,
        plan: &LayoutPlan,
        key: &str,
    ) -> AppResult<String> {
        let project_id = plan
            .project_for_source
            .get(key)
            .ok_or_else(|| AppError::Other(format!("missing project for {key}")))?;
        let thread_id = plan
            .thread_for_source
            .get(key)
            .ok_or_else(|| AppError::Other(format!("missing thread for {key}")))?;
        if self.get_creative_thread(thread_id)?.is_none() {
            let component = plan
                .thread_for_source
                .iter()
                .filter(|(_, value)| *value == thread_id)
                .map(|(source_key, _)| source_key.clone())
                .min_by_key(|source_key| {
                    (source_created_at(discovery, source_key), source_key.clone())
                })
                .unwrap_or_else(|| key.to_string());
            let size = plan
                .thread_for_source
                .values()
                .filter(|value| *value == thread_id)
                .count();
            let origin = if size > 1 {
                CreativeThreadOrigin::MergedLegacy
            } else if source_kind_id(key).0 == "agent" {
                CreativeThreadOrigin::AgentBackfill
            } else {
                CreativeThreadOrigin::GenerationBackfill
            };
            self.create_creative_thread(&NewCreativeThread {
                id: thread_id.clone(),
                project_id: project_id.clone(),
                title: legacy_title(&source_prompt(discovery, &component)),
                origin,
            })?;
            let created_at = source_created_at(discovery, &component);
            self.conn.lock().unwrap().execute(
                "UPDATE creative_threads SET created_at=?2,updated_at=?2 WHERE id=?1",
                params![thread_id, created_at],
            )?;
        }
        Ok(thread_id.clone())
    }

    fn backfill_generation_v2(
        &self,
        source: &GenerationSource,
        project_id: &str,
        thread_id: &str,
    ) -> AppResult<Vec<String>> {
        let turns = generation_turns(source);
        if turns.is_empty() {
            return Err(AppError::Other(
                "generation source has no recoverable turn".into(),
            ));
        }
        let mut prior_output_paths = HashSet::new();
        let mut node_ids = Vec::new();
        for turn in turns {
            let parent_asset_path = turn.references.iter().find(|path| {
                if prior_output_paths.contains(path.as_str()) { return true; }
                let conn = self.conn.lock().unwrap();
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM assets a JOIN canvas_nodes n ON n.asset_id=a.id WHERE a.store_path=?1 AND n.thread_id=?2 AND n.role IN ('output','intermediate','final') AND n.hidden_at IS NULL)",
                    params![path, thread_id], |row| row.get::<_, bool>(0),
                ).unwrap_or(false)
            }).cloned();
            let graph = self.begin_project_generation_turn(&ProjectGenerationTurnInput {
                project_id: project_id.into(),
                thread_id: thread_id.into(),
                generation_conversation_id: source.id.clone(),
                job_id: turn.job_id.clone(),
                turn_key: turn.turn_key.clone(),
                prompt: turn.prompt,
                applied_prompt: turn.applied_prompt,
                provider: turn.provider,
                provider_session_id: turn.provider_session_id.clone(),
                ratio: None,
                visual_profile: turn.visual_profile,
                reference_node_ids: vec![],
                references: turn.references,
                parent_node_id: None,
                parent_asset_path,
                relation: Some(CreativeGenerationRelation::Continued),
            })?;
            node_ids.push(graph.prompt_node_id);
            node_ids.extend(graph.reference_node_ids);
            let outputs = turn
                .output_asset_ids
                .iter()
                .filter_map(|id| self.get_asset(id).ok().flatten())
                .collect::<Vec<_>>();
            let output_nodes = self.complete_project_generation_turn(
                project_id,
                thread_id,
                &turn.job_id,
                &turn.turn_key,
                turn.provider_session_id.as_deref(),
                &outputs,
            )?;
            node_ids.extend(output_nodes);
            for asset in outputs {
                if let Some(path) = asset.store_path {
                    prior_output_paths.insert(path);
                }
            }
            self.conn.lock().unwrap().execute(
                "UPDATE canvas_nodes SET created_at=?2,updated_at=?2 WHERE project_id=?1 AND id IN (SELECT id FROM canvas_nodes WHERE project_id=?1 AND thread_id=?3 AND (payload_json LIKE ?4 OR payload_json LIKE ?5))",
                params![project_id, turn.created_at, thread_id, format!("%\"job_id\":\"{}\"%", turn.job_id), format!("%\"turn_key\":\"{}\"%", turn.turn_key)],
            )?;
        }
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE task_queue SET project_id=?2,thread_id=?3 WHERE kind='generation' AND (json_extract(payload,'$.conversation_id')=?1 OR (json_extract(payload,'$.conversation_id') IS NULL AND json_extract(payload,'$.id')=?1))",
            params![source.id, project_id, thread_id],
        )?;
        Ok(node_ids)
    }

    fn backfill_agent_v2(
        &self,
        source: &AgentSource,
        project_id: &str,
        thread_id: &str,
    ) -> AppResult<Vec<String>> {
        let references = source
            .reference_asset_ids
            .iter()
            .filter(|id| self.get_asset(id).ok().flatten().is_some())
            .cloned()
            .collect::<Vec<_>>();
        let launch_id = stable_id("agent-launch", &source.run_id);
        let parent_asset_id = {
            let conn = self.conn.lock().unwrap();
            source.reference_asset_ids.iter().find(|asset_id| conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM canvas_nodes WHERE thread_id=?1 AND asset_id=?2 AND role IN ('output','intermediate','final') AND hidden_at IS NULL)",
                params![thread_id, asset_id], |row| row.get::<_, bool>(0),
            ).unwrap_or(false)).cloned()
        };
        let graph = self.begin_project_agent_launch(&ProjectAgentLaunchInput {
            project_id: project_id.into(),
            thread_id: thread_id.into(),
            launch_id: launch_id.clone(),
            prompt: source.intent_prompt.clone(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: run_visual_profile_ref(
                source
                    .snapshot
                    .get("run")
                    .unwrap_or(&serde_json::Value::Null),
            ),
            reference_asset_ids: references,
            reference_node_ids: vec![],
            parent_node_id: None,
            parent_asset_id,
        })?;
        let mut node_ids = vec![graph.prompt_node_id];
        node_ids.extend(graph.reference_node_ids);
        node_ids.push(self.project_agent_run_on_canvas(
            project_id,
            thread_id,
            &launch_id,
            &agent_payload(source),
        )?);
        if let Some(asset_id) = &source.final_asset_id {
            if let Some(asset) = self.get_asset(asset_id)? {
                let artifact_id = agent_artifact_id(source);
                node_ids.push(self.project_agent_artifact_on_canvas(
                    &source.run_id,
                    &artifact_id,
                    "final_result",
                    0,
                    &asset,
                )?);
            }
        }
        self.conn.lock().unwrap().execute(
            "UPDATE cloud_agent_runs SET project_id=?2,thread_id=?3,creative_launch_id=?4 WHERE run_id=?1",
            params![source.run_id, project_id, thread_id, launch_id],
        )?;
        Ok(node_ids)
    }

    fn cleanup_failed_source(
        &self,
        kind: &str,
        source_id: &str,
        thread_id: &str,
        node_ids: &[String],
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for id in node_ids {
            tx.execute("DELETE FROM canvas_nodes WHERE id=?1", [id])?;
        }
        if kind == "generation" {
            tx.execute(
                "DELETE FROM thread_generation_links WHERE generation_conversation_id=?1",
                [source_id],
            )?;
            tx.execute(
                "UPDATE task_queue SET project_id=NULL,thread_id=NULL WHERE kind='generation' AND (json_extract(payload,'$.conversation_id')=?1 OR (json_extract(payload,'$.conversation_id') IS NULL AND json_extract(payload,'$.id')=?1))",
                [source_id],
            )?;
        } else {
            tx.execute(
                "DELETE FROM thread_agent_links WHERE run_id=?1",
                [source_id],
            )?;
            tx.execute("UPDATE cloud_agent_runs SET thread_id=NULL,creative_launch_id=NULL WHERE run_id=?1 AND thread_id=?2", params![source_id, thread_id])?;
        }
        let used: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM thread_generation_links WHERE thread_id=?1 UNION ALL SELECT 1 FROM thread_agent_links WHERE thread_id=?1)",
            [thread_id], |row| row.get(0),
        )?;
        if !used {
            tx.execute("DELETE FROM creative_threads WHERE id=?1", [thread_id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn preview_project_canvas_backfill(&self) -> AppResult<ProjectCanvasBackfillPreview> {
        let discovery = self.discover_project_canvas_history()?;
        let plan = build_layout_plan(&discovery);
        let conn = self.conn.lock().unwrap();
        let schema_version = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let has_unpublished_creative_sessions = table_exists(&conn, "creative_sessions")?;
        let has_project_canvases = table_exists(&conn, "project_canvases")?;
        let migration_lineage = if has_unpublished_creative_sessions {
            "unpublished-canvas-session-v21-v23; rebuild from v20 backup".to_string()
        } else if has_project_canvases {
            "project-canvas-v21-v23".to_string()
        } else if schema_version <= 20 {
            "formal-v20-or-earlier".to_string()
        } else {
            "unknown-incompatible".to_string()
        };
        let mut generation = BackfillSourceCounts {
            discovered: discovery.generations.len(),
            ..Default::default()
        };
        let mut agent = BackfillSourceCounts {
            discovered: discovery.agents.len(),
            ..Default::default()
        };
        if table_exists(&conn, "project_canvas_backfill_sources")? {
            for (kind, counts) in [("generation", &mut generation), ("agent", &mut agent)] {
                let mut statement = conn.prepare("SELECT status,COUNT(*) FROM project_canvas_backfill_sources WHERE backfill_version=?1 AND source_kind=?2 GROUP BY status")?;
                for row in statement.query_map(params![BACKFILL_VERSION, kind], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, usize>(1)?))
                })? {
                    let (status, count) = row?;
                    match status.as_str() {
                        "done" | "deleted" => counts.skipped += count,
                        "failed" => counts.failed += count,
                        _ => {}
                    }
                }
            }
        }
        let mut distribution: BTreeMap<Option<String>, (usize, usize, usize)> = BTreeMap::new();
        for source in discovery.generations.values() {
            let entry = distribution.entry(source.project_id.clone()).or_default();
            entry.0 += 1;
            entry.2 += estimated_source_nodes(&discovery, &source_key("generation", &source.id));
        }
        for source in discovery.agents.values() {
            let entry = distribution.entry(source.project_id.clone()).or_default();
            entry.1 += 1;
            entry.2 += estimated_source_nodes(&discovery, &source_key("agent", &source.run_id));
        }
        let project_source_distribution = distribution
            .into_iter()
            .map(|(project_id, value)| ProjectSourceDistribution {
                project_id,
                generation_sources: value.0,
                agent_sources: value.1,
                estimated_nodes: value.2,
            })
            .collect();
        let canvases = plan
            .sources_by_project
            .iter()
            .map(|(project_id, source_count)| {
                let estimated_nodes = plan
                    .estimated_nodes_by_project
                    .get(project_id)
                    .copied()
                    .unwrap_or(0);
                let columns = (estimated_nodes.max(1) as f64).sqrt().ceil();
                CanvasEstimate {
                    project_id: project_id.clone(),
                    project_name: plan
                        .project_names
                        .get(project_id)
                        .cloned()
                        .unwrap_or_else(|| project_id.clone()),
                    source_count: *source_count,
                    thread_count: plan
                        .threads_by_project
                        .get(project_id)
                        .map(BTreeSet::len)
                        .unwrap_or(0),
                    estimated_nodes,
                    estimated_width: columns * 340.0,
                    estimated_height: ((estimated_nodes as f64 / columns).ceil()) * 280.0,
                }
            })
            .collect::<Vec<_>>();
        Ok(ProjectCanvasBackfillPreview {
            backfill_version: BACKFILL_VERSION,
            schema_version,
            migration_lineage,
            has_unpublished_creative_sessions,
            has_project_canvases,
            generation,
            agent,
            asset_count: table_count(&conn, "assets")?,
            generation_conversation_count: table_count(&conn, "generation_conversations")?,
            agent_run_count: table_count(&conn, "cloud_agent_runs")?,
            existing_project_count: table_count(&conn, "projects")?,
            target_project_count: plan.sources_by_project.len(),
            target_thread_count: plan.threads_by_project.values().map(BTreeSet::len).sum(),
            estimated_node_count: plan.estimated_nodes_by_project.values().sum(),
            deterministic_correlations: plan.deterministic_correlations,
            deterministic_merges: plan.deterministic_merges,
            unscoped_shard_rule: plan.unscoped_shard_rule,
            project_source_distribution,
            canvases,
        })
    }

    pub fn run_project_canvas_backfill(&self) -> AppResult<ProjectCanvasBackfillReport> {
        let discovery = self.discover_project_canvas_history()?;
        let plan = build_layout_plan(&discovery);
        let before = {
            let conn = self.conn.lock().unwrap();
            (
                table_count(&conn, "assets")?,
                table_count(&conn, "projects")?,
                table_count(&conn, "creative_threads")?,
                table_count(&conn, "canvas_nodes")?,
                table_count(&conn, "canvas_edges")?,
                table_count(&conn, "thread_generation_links")?,
                table_count(&conn, "thread_agent_links")?,
            )
        };
        let mut report = ProjectCanvasBackfillReport {
            report_id: ulid::Ulid::new().to_string(),
            backfill_version: BACKFILL_VERSION,
            generation: BackfillSourceCounts {
                discovered: discovery.generations.len(),
                ..Default::default()
            },
            agent: BackfillSourceCounts {
                discovered: discovery.agents.len(),
                ..Default::default()
            },
            asset_count_before: before.0,
            asset_count_after: before.0,
            project_count_before: before.1,
            project_count_after: before.1,
            thread_count_before: before.2,
            thread_count_after: before.2,
            node_count_before: before.3,
            node_count_after: before.3,
            edge_count_before: before.4,
            edge_count_after: before.4,
            generation_link_count_before: before.5,
            generation_link_count_after: before.5,
            agent_link_count_before: before.6,
            agent_link_count_after: before.6,
            asset_copies: 0,
            deterministic_correlations: plan.deterministic_correlations,
            deterministic_merges: plan.deterministic_merges,
            unexplained_differences: Vec::new(),
            failures: Vec::new(),
        };
        let mut ordered = discovery
            .generations
            .values()
            .map(|source| (source.created_at, source_key("generation", &source.id)))
            .chain(
                discovery
                    .agents
                    .values()
                    .map(|source| (source.created_at, source_key("agent", &source.run_id))),
            )
            .collect::<Vec<_>>();
        ordered.sort_by(|left, right| left.cmp(right));
        for (_, key) in ordered {
            let (kind, id) = source_kind_id(&key);
            if matches!(
                self.v2_source_status(kind, id)?.as_deref(),
                Some("done" | "deleted")
            ) {
                if kind == "generation" {
                    report.generation.skipped += 1
                } else {
                    report.agent.skipped += 1
                }
                continue;
            }
            let already_linked = if kind == "generation" {
                self.thread_for_generation(id)?
            } else {
                self.thread_for_agent(id)?
            };
            if let Some(thread_id) = already_linked {
                let project_id = self
                    .get_creative_thread(&thread_id)?
                    .map(|thread| thread.project_id);
                self.record_v2_source(
                    kind,
                    id,
                    "done",
                    project_id.as_deref(),
                    Some(&thread_id),
                    &[],
                    Some("already projected before v2 ledger"),
                )?;
                if kind == "generation" {
                    report.generation.skipped += 1
                } else {
                    report.agent.skipped += 1
                }
                continue;
            }
            let project_id = plan.project_for_source.get(&key).unwrap().clone();
            let thread_id = plan.thread_for_source.get(&key).unwrap().clone();
            let mut node_ids = if kind == "generation" {
                expected_generation_node_ids(discovery.generations.get(id).unwrap())
            } else {
                expected_agent_node_ids(discovery.agents.get(id).unwrap())
            };
            let result = (|| -> AppResult<Vec<String>> {
                self.ensure_backfill_project(&discovery, &plan, &project_id)?;
                self.ensure_backfill_thread(&discovery, &plan, &key)?;
                if kind == "generation" {
                    self.backfill_generation_v2(
                        discovery.generations.get(id).unwrap(),
                        &project_id,
                        &thread_id,
                    )
                } else {
                    self.backfill_agent_v2(
                        discovery.agents.get(id).unwrap(),
                        &project_id,
                        &thread_id,
                    )
                }
            })();
            match result {
                Ok(created) => {
                    node_ids = created;
                    self.record_v2_source(
                        kind,
                        id,
                        "done",
                        Some(&project_id),
                        Some(&thread_id),
                        &node_ids,
                        None,
                    )?;
                    if kind == "generation" {
                        report.generation.migrated += 1
                    } else {
                        report.agent.migrated += 1
                    }
                }
                Err(error) => {
                    let message = format!("{kind} {id}: {error}");
                    let _ = self.cleanup_failed_source(kind, id, &thread_id, &node_ids);
                    self.record_v2_source(
                        kind,
                        id,
                        "failed",
                        Some(&project_id),
                        None,
                        &[],
                        Some(&message),
                    )?;
                    report.failures.push(message);
                    if kind == "generation" {
                        report.generation.failed += 1
                    } else {
                        report.agent.failed += 1
                    }
                }
            }
        }
        let after = {
            let conn = self.conn.lock().unwrap();
            (
                table_count(&conn, "assets")?,
                table_count(&conn, "projects")?,
                table_count(&conn, "creative_threads")?,
                table_count(&conn, "canvas_nodes")?,
                table_count(&conn, "canvas_edges")?,
                table_count(&conn, "thread_generation_links")?,
                table_count(&conn, "thread_agent_links")?,
            )
        };
        report.asset_count_after = after.0;
        report.project_count_after = after.1;
        report.thread_count_after = after.2;
        report.node_count_after = after.3;
        report.edge_count_after = after.4;
        report.generation_link_count_after = after.5;
        report.agent_link_count_after = after.6;
        if report.asset_count_before != report.asset_count_after {
            report.unexplained_differences.push(format!(
                "asset count changed {} -> {}",
                report.asset_count_before, report.asset_count_after
            ));
        }
        let generation_link_delta =
            report.generation_link_count_after - report.generation_link_count_before;
        if generation_link_delta != report.generation.migrated as i64 {
            report.unexplained_differences.push(format!(
                "generation link delta {generation_link_delta} != migrated {}",
                report.generation.migrated
            ));
        }
        let agent_link_delta = report.agent_link_count_after - report.agent_link_count_before;
        if agent_link_delta != report.agent.migrated as i64 {
            report.unexplained_differences.push(format!(
                "agent link delta {agent_link_delta} != migrated {}",
                report.agent.migrated
            ));
        }
        let missing_done_links: i64 = self.conn.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM project_canvas_backfill_sources source
             WHERE source.backfill_version=?1 AND source.status='done' AND (
               (source.source_kind='generation' AND NOT EXISTS(
                 SELECT 1 FROM thread_generation_links link
                 WHERE link.generation_conversation_id=source.source_id AND link.thread_id=source.thread_id
               )) OR
               (source.source_kind='agent' AND NOT EXISTS(
                 SELECT 1 FROM thread_agent_links link
                 WHERE link.run_id=source.source_id AND link.thread_id=source.thread_id
               ))
             )",
            [BACKFILL_VERSION],
            |row| row.get(0),
        )?;
        if missing_done_links != 0 {
            report.unexplained_differences.push(format!(
                "{missing_done_links} completed ledger sources have no matching execution link"
            ));
        }
        let payload = serde_json::to_string(&report)?;
        self.conn.lock().unwrap().execute(
            "INSERT INTO project_canvas_backfill_reports (id,backfill_version,payload_json,created_at) VALUES (?1,?2,?3,?4)",
            params![report.report_id, BACKFILL_VERSION, payload, Utc::now().timestamp()],
        )?;
        if !report.unexplained_differences.is_empty() {
            return Err(AppError::Other(format!(
                "PB5 reconciliation failed (report {}): {}",
                report.report_id,
                report.unexplained_differences.join("; ")
            )));
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db
    }

    fn seed_project(db: &Database, id: &str) {
        db.conn.lock().unwrap().execute(
            "INSERT INTO projects(id,name,workspace_path,workspace_key,created_at,kind,title_source,updated_at,last_opened_at) VALUES (?1,?2,?3,?3,1,'blank','manual',1,1)",
            params![id, id, format!("blank:{id}")],
        ).unwrap();
    }

    #[test]
    fn v2_merges_correlated_generation_and_agent_into_one_project_thread_and_is_idempotent() {
        let db = db();
        seed_project(&db, "p1");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO assets(id,name,store_path,created_at) VALUES ('out','out','/out.png',1)", []).unwrap();
            conn.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES ('a','out','generation_meta',?1,1)", [r#"{"conversation_id":"g1","job_id":"j1","turn_key":"t1","prompt":"make","provider":"codex","project_id":"p1","references":[]}"#]).unwrap();
            conn.execute(r#"INSERT INTO cloud_agent_runs(run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,project_id,snapshot_json,created_at,updated_at) VALUES ('r1','c1','skill','failed','refine','["out"]','p1','{"run":{}}',2,2)"#, []).unwrap();
        }
        let preview = db.preview_project_canvas_backfill().unwrap();
        assert_eq!(preview.target_project_count, 1);
        assert_eq!(preview.target_thread_count, 1);
        assert_eq!(preview.deterministic_correlations, 1);
        assert_eq!(preview.deterministic_merges, 1);
        let first = db.run_project_canvas_backfill().unwrap();
        assert_eq!(first.generation.migrated, 1);
        assert_eq!(first.agent.migrated, 1);
        assert_eq!(first.asset_count_before, first.asset_count_after);
        assert!(first.unexplained_differences.is_empty());
        let generation_thread = db.thread_for_generation("g1").unwrap().unwrap();
        assert_eq!(
            db.thread_for_agent("r1").unwrap().unwrap(),
            generation_thread
        );
        let second = db.run_project_canvas_backfill().unwrap();
        assert_eq!(second.generation.skipped, 1);
        assert_eq!(second.agent.skipped, 1);
        assert_eq!(second.node_count_before, second.node_count_after);
    }

    #[test]
    fn v2_routes_unscoped_sources_to_one_system_project_without_copying_assets() {
        let db = db();
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,store_path,created_at) VALUES ('out','out','/out.png',1)", [],
        ).unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES ('a','out','generation_meta',?1,1)",
            [r#"{"conversation_id":"g1","job_id":"j1","turn_key":"t1","prompt":"make","provider":"codex","references":[]}"#],
        ).unwrap();
        let report = db.run_project_canvas_backfill().unwrap();
        assert_eq!(report.asset_copies, 0);
        assert_eq!(report.asset_count_before, report.asset_count_after);
        let thread = db.thread_for_generation("g1").unwrap().unwrap();
        assert_eq!(
            db.get_creative_thread(&thread).unwrap().unwrap().project_id,
            "system-unarchived-creations"
        );
    }

    #[test]
    fn v2_deleted_project_marker_prevents_source_resurrection() {
        let db = db();
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,store_path,created_at) VALUES ('out','out','/out.png',1)", [],
        ).unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES ('a','out','generation_meta',?1,1)",
            [r#"{"conversation_id":"g1","job_id":"j1","turn_key":"t1","prompt":"make","provider":"codex","references":[]}"#],
        ).unwrap();
        db.run_project_canvas_backfill().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "DELETE FROM projects WHERE id='system-unarchived-creations'",
                [],
            )
            .unwrap();
        let status: String = db.conn.lock().unwrap().query_row(
            "SELECT status FROM project_canvas_backfill_sources WHERE backfill_version=2 AND source_kind='generation' AND source_id='g1'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(status, "deleted");
        let rerun = db.run_project_canvas_backfill().unwrap();
        assert_eq!(rerun.generation.skipped, 1);
        assert!(db
            .get_project_canvas("system-unarchived-creations")
            .unwrap()
            .is_none());
    }
}
