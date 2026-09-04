use std::{path::PathBuf, sync::Arc};

use rusqlite::{OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

use crate::cloud::{AuthClient, CloudClient, EntitlementService};
use crate::core::{
    creative_session_contract::{
        AgentGroupApprovalV1, AgentGroupArtifactV1, AgentGroupClarificationV1, AgentGroupEventV1,
        AgentGroupNodePayloadV1, VisualProfileRefV1,
    },
    library::Asset,
    paths::LibraryPaths,
    project_canvas::ProjectAgentLaunchInput,
    visual_profile::VisualProfileCapsule,
};
use crate::db::Database;
use crate::error::AppError;

const SKILL_ID: &str = "bowerbird-controlled-image-edit";
const HTML_SKILL_ID: &str = "bowerbird-html-layout-render";
const UNIFIED_SKILL_ID: &str = "bowerbird-unified-agent";
const LEGACY_AGENT_RUNTIME: &str = "legacy_kernel";
const DSH_AGENT_RUNTIME: &str = "dsh";
const MAX_REFERENCES: usize = 8;
const MAX_PROMPT_CHARS: usize = 4_000;
const MAX_FEEDBACK_CHARS: usize = 2_000;
const MAX_ARTIFACT_BYTES: u64 = 20 * 1024 * 1024;
const PROJECT_AGENT_LAUNCH_SNAPSHOT_KEY: &str = "_bowerbirdProjectAgentLaunchV1";
const PROJECT_AGENT_INGEST_SNAPSHOT_KEY: &str = "_bowerbirdAgentIngestV1";
const CODEX_AGENT_INCOMPATIBLE_MESSAGE: &str =
    "Codex 与 Bowerbird Agent 暂时互斥，请直接使用 Codex 或为 Agent 选择 Cloud / 即梦";
const ALLOWED_RATIOS: [(&str, f64); 7] = [
    ("1:1", 1.0),
    ("3:4", 3.0 / 4.0),
    ("4:3", 4.0 / 3.0),
    ("2:3", 2.0 / 3.0),
    ("3:2", 3.0 / 2.0),
    ("16:9", 16.0 / 9.0),
    ("9:16", 9.0 / 16.0),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentReferenceRequest {
    pub asset_id: String,
    pub prompt_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlLayoutOptions {
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub device_scale_factor: u8,
    pub capture_mode: String,
    pub slice_height: Option<u32>,
    pub overlap: Option<u32>,
    pub background: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlLayoutReference {
    artifact_id: String,
    token: String,
    ordinal: usize,
    mime: &'static str,
    bytes: usize,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlLayoutManifest<'a> {
    schema_version: u8,
    layout_prompt: &'a str,
    references: &'a [HtmlLayoutReference],
    viewport: HtmlLayoutViewport,
    capture: HtmlLayoutCapture,
    background: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlLayoutViewport {
    width_css_px: u32,
    height_css_px: u32,
    device_scale_factor: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HtmlLayoutCapture {
    mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    slice_height_css_px: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    overlap_css_px: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnifiedAgentManifest<'a> {
    schema_version: u8,
    goal: &'a str,
    references: &'a [HtmlLayoutReference],
    #[serde(skip_serializing_if = "Option::is_none")]
    ratio: Option<&'a str>,
    html_output: UnifiedHtmlOutput<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    visual_profile_capsule: Option<&'a crate::core::visual_profile::VisualProfileCapsule>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnifiedHtmlOutput<'a> {
    viewport: HtmlLayoutViewport,
    capture: HtmlLayoutCapture,
    background: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceFact {
    pub category: String,
    pub value: String,
    pub confidence: f64,
    pub evidence_count: u32,
    pub explicit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceScope {
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceCapsule {
    pub schema_version: u8,
    pub scope: PreferenceScope,
    pub preferred: Vec<PreferenceFact>,
    pub avoid: Vec<PreferenceFact>,
    pub workflow: Vec<PreferenceFact>,
    pub generated_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentRunRecord {
    pub run_id: String,
    pub conversation_id: String,
    pub skill_id: String,
    pub status: String,
    pub intent_prompt: String,
    pub reference_asset_ids: Vec<String>,
    pub project_id: Option<String>,
    pub thread_id: Option<String>,
    pub creative_launch_id: Option<String>,
    pub snapshot: Value,
    pub feedback_action: Option<String>,
    pub final_asset_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAgentPreview {
    pub run_id: String,
    pub artifact_id: String,
    pub path: String,
    pub mime: String,
    pub sha256: String,
    pub role: String,
    pub index: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlledReference<'a> {
    reference_id: &'a str,
    token: &'a str,
    ordinal: usize,
    mime: &'static str,
    bytes: usize,
    sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    aspect_ratio: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlledManifest<'a> {
    schema_version: u8,
    intent_prompt: &'a str,
    references: &'a [ControlledReference<'a>],
    #[serde(skip_serializing_if = "Option::is_none")]
    ratio: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preference_capsule: Option<&'a PreferenceCapsule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    visual_profile_capsule: Option<&'a crate::core::visual_profile::VisualProfileCapsule>,
}

fn validate_preference_capsule(
    capsule: &PreferenceCapsule,
    project_id: Option<&str>,
) -> Result<(), AppError> {
    const CATEGORIES: [&str; 7] = [
        "style",
        "subject",
        "palette",
        "composition",
        "medium",
        "workflow",
        "avoid",
    ];
    if capsule.schema_version != 1
        || capsule
            .scope
            .project_id
            .as_deref()
            .is_some_and(|scope_project| Some(scope_project) != project_id)
    {
        return Err(AppError::Other("Agent 偏好范围与当前项目不一致".into()));
    }
    let generated_at = chrono::DateTime::parse_from_rfc3339(&capsule.generated_at)
        .map_err(|_| AppError::Other("Agent 偏好胶囊时间无效".into()))?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(&capsule.expires_at)
        .map_err(|_| AppError::Other("Agent 偏好胶囊时间无效".into()))?;
    let now = chrono::Utc::now();
    if expires_at <= generated_at
        || generated_at > now + chrono::Duration::minutes(5)
        || expires_at <= now
        || expires_at - generated_at > chrono::Duration::days(30)
        || expires_at > now + chrono::Duration::days(30)
    {
        return Err(AppError::Other("Agent 偏好胶囊已过期或有效期过长".into()));
    }
    let facts = capsule
        .preferred
        .iter()
        .chain(&capsule.avoid)
        .chain(&capsule.workflow)
        .collect::<Vec<_>>();
    if facts.len() > 24 {
        return Err(AppError::Other("Agent 偏好事实最多 24 条".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for fact in facts {
        let value = fact.value.trim();
        let key = format!("{}\0{}", fact.category, value.to_lowercase());
        if !CATEGORIES.contains(&fact.category.as_str())
            || value.is_empty()
            || value.chars().count() > 240
            || !fact.confidence.is_finite()
            || !(0.0..=1.0).contains(&fact.confidence)
            || fact.evidence_count == 0
            || !fact.explicit
            || !seen.insert(key)
        {
            return Err(AppError::Other(
                "Agent 偏好胶囊只接受去重后的显式事实".into(),
            ));
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn artifact_magic_matches(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn normalize_requested_ratio(ratio: Option<String>) -> Result<Option<String>, AppError> {
    let Some(value) = ratio.map(|value| value.trim().to_string()) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    if ALLOWED_RATIOS.iter().any(|(key, _)| *key == value) {
        Ok(Some(value))
    } else {
        Err(AppError::Other("Agent 画面比例无效".into()))
    }
}

fn ensure_agent_provider_compatible(image_provider: Option<&str>) -> Result<(), AppError> {
    if image_provider == Some("codex") {
        return Err(AppError::Other(CODEX_AGENT_INCOMPATIBLE_MESSAGE.into()));
    }
    Ok(())
}

fn resolve_agent_runtime(
    agent_runtime: Option<&str>,
    is_test_account: bool,
) -> Result<&'static str, AppError> {
    match agent_runtime {
        None | Some(LEGACY_AGENT_RUNTIME) => Ok(LEGACY_AGENT_RUNTIME),
        Some(DSH_AGENT_RUNTIME) if is_test_account => Ok(DSH_AGENT_RUNTIME),
        Some(DSH_AGENT_RUNTIME) => Err(AppError::Other("DSH Runtime 仅对测试账号开放".into())),
        Some(_) => Err(AppError::Other("不支持的 Agent Runtime".into())),
    }
}

fn nearest_ratio(width: i64, height: i64) -> Option<String> {
    if width <= 0 || height <= 0 {
        return None;
    }
    let target = (width as f64 / height as f64).ln();
    ALLOWED_RATIOS
        .iter()
        .min_by(|left, right| {
            (left.1.ln() - target)
                .abs()
                .total_cmp(&(right.1.ln() - target).abs())
        })
        .map(|(key, _)| (*key).to_string())
}

fn safe_cloud_message(body: &str, fallback: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| fallback.to_string())
}

async fn agent_action(
    cloud: &CloudClient,
    auth: &AuthClient,
    body: Value,
    context: &str,
) -> Result<Value, AppError> {
    let endpoint = cloud
        .config()
        .endpoint("agent-run")
        .ok_or_else(|| AppError::Cloud("Bowerbird Cloud 未配置".into()))?;
    let response = auth
        .send_authorized(cloud.http().post(endpoint).json(&body), context)
        .await?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| AppError::Cloud(format!("读取 Agent 响应失败: {error}")))?;
    if !status.is_success() {
        return Err(AppError::Cloud(safe_cloud_message(
            &text,
            &format!("{context}（HTTP {}）", status.as_u16()),
        )));
    }
    serde_json::from_str(&text)
        .map_err(|error| AppError::Cloud(format!("解析 Agent 响应失败: {error}")))
}

fn run_status(snapshot: &Value) -> Result<String, AppError> {
    snapshot
        .pointer("/run/status")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::Cloud("Agent 响应缺少 Run 状态".into()))
}

fn project_agent_launch_from_snapshot(snapshot: &Value) -> Option<ProjectAgentLaunchInput> {
    let checkpoint = snapshot.get(PROJECT_AGENT_LAUNCH_SNAPSHOT_KEY)?;
    if checkpoint.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    serde_json::from_value(checkpoint.get("input")?.clone()).ok()
}

fn set_project_agent_launch_snapshot(
    snapshot: &mut Value,
    launch: &ProjectAgentLaunchInput,
) -> Result<(), AppError> {
    let object = snapshot
        .as_object_mut()
        .ok_or_else(|| AppError::Other("Agent snapshot must be a JSON object".into()))?;
    object.insert(
        PROJECT_AGENT_LAUNCH_SNAPSHOT_KEY.into(),
        json!({ "schemaVersion": 1, "input": launch }),
    );
    Ok(())
}

fn is_terminal_agent_status(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled")
}

fn transfer_cleanup_status(cancel_response: Option<&Value>) -> &'static str {
    if cancel_response
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        == Some("cancelled")
    {
        "cancelled"
    } else {
        // A lost enqueue response means the Run may already be queued or executing.
        // Until the control plane confirms cancellation, keep this checkpoint live so
        // cloud_agent_list + the coordinator can reconcile the authoritative status.
        "cancel_requested"
    }
}

fn validate_record_launch(record: &CloudAgentRunRecord) -> Result<(), AppError> {
    if project_agent_launch_from_snapshot(&record.snapshot)
        .as_ref()
        .is_some_and(|launch| {
            record.project_id.as_deref() != Some(launch.project_id.as_str())
                || record.thread_id.as_deref() != Some(launch.thread_id.as_str())
                || record.creative_launch_id.as_deref() != Some(launch.launch_id.as_str())
        })
    {
        return Err(AppError::Other(format!(
            "Cloud Agent run {} creative launch checkpoint does not match its owner",
            record.run_id
        )));
    }
    Ok(())
}

fn ensure_same_record_identity(
    existing: &CloudAgentRunRecord,
    incoming: &CloudAgentRunRecord,
) -> Result<(), AppError> {
    if existing.run_id != incoming.run_id
        || existing.conversation_id != incoming.conversation_id
        || existing.skill_id != incoming.skill_id
        || existing.project_id != incoming.project_id
        || existing.thread_id != incoming.thread_id
        || existing.creative_launch_id != incoming.creative_launch_id
    {
        return Err(AppError::Other(format!(
            "Cloud Agent run {} identity or owner cannot change after checkpoint",
            incoming.run_id
        )));
    }
    Ok(())
}

fn preserve_artifact_receipts(existing: &Value, incoming: &mut Value) {
    let Some(existing_artifacts) = existing.get("artifacts").and_then(Value::as_array) else {
        return;
    };
    let Some(incoming_object) = incoming.as_object_mut() else {
        return;
    };
    let Some(incoming_artifacts) = incoming_object
        .entry("artifacts")
        .or_insert_with(|| json!([]))
        .as_array_mut()
    else {
        return;
    };
    for existing_artifact in existing_artifacts {
        let Some(artifact_id) = existing_artifact.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(downloaded_at) = existing_artifact
            .get("downloaded_at")
            .filter(|value| !value.is_null())
            .cloned()
        else {
            continue;
        };
        if let Some(incoming_artifact) = incoming_artifacts
            .iter_mut()
            .find(|artifact| artifact.get("id").and_then(Value::as_str) == Some(artifact_id))
        {
            if incoming_artifact
                .get("downloaded_at")
                .is_none_or(Value::is_null)
            {
                if let Some(object) = incoming_artifact.as_object_mut() {
                    object.insert("downloaded_at".into(), downloaded_at);
                }
            }
        } else {
            incoming_artifacts.push(existing_artifact.clone());
        }
    }
}

fn merge_record(
    existing: &CloudAgentRunRecord,
    incoming: &CloudAgentRunRecord,
) -> Result<CloudAgentRunRecord, AppError> {
    validate_record_launch(existing)?;
    validate_record_launch(incoming)?;
    ensure_same_record_identity(existing, incoming)?;

    let existing_launch = project_agent_launch_from_snapshot(&existing.snapshot);
    let incoming_launch = project_agent_launch_from_snapshot(&incoming.snapshot);
    if let (Some(existing_launch), Some(incoming_launch)) =
        (existing_launch.as_ref(), incoming_launch.as_ref())
    {
        if existing_launch != incoming_launch {
            return Err(AppError::Other(format!(
                "Cloud Agent run {} creative parent cannot change after checkpoint",
                incoming.run_id
            )));
        }
    }
    if let (Some(existing_asset_id), Some(incoming_asset_id)) = (
        existing.final_asset_id.as_deref(),
        incoming.final_asset_id.as_deref(),
    ) {
        if existing_asset_id != incoming_asset_id {
            return Err(AppError::Other(format!(
                "Cloud Agent run {} final asset cannot change after ingest",
                incoming.run_id
            )));
        }
    }

    // A completed Run never goes back to an active state. The same terminal
    // state may still refresh its snapshot so artifact_received/downloaded_at
    // can become durable after local ingest.
    let keep_existing_terminal =
        is_terminal_agent_status(&existing.status) && existing.status != incoming.status;
    let mut merged = if keep_existing_terminal {
        existing.clone()
    } else {
        incoming.clone()
    };
    if let Some(object) = merged.snapshot.as_object_mut() {
        // This checkpoint is local evidence and must never be accepted from a remote snapshot.
        object.remove(PROJECT_AGENT_INGEST_SNAPSHOT_KEY);
    }
    merged.conversation_id = existing.conversation_id.clone();
    merged.skill_id = existing.skill_id.clone();
    merged.intent_prompt = existing.intent_prompt.clone();
    merged.reference_asset_ids = existing.reference_asset_ids.clone();
    merged.project_id = existing.project_id.clone();
    merged.thread_id = existing.thread_id.clone();
    merged.creative_launch_id = existing.creative_launch_id.clone();
    merged.created_at = existing.created_at;
    merged.updated_at = existing.updated_at.max(incoming.updated_at);
    merged.final_asset_id = existing
        .final_asset_id
        .clone()
        .or_else(|| incoming.final_asset_id.clone());
    merged.feedback_action = if keep_existing_terminal {
        existing.feedback_action.clone()
    } else {
        incoming
            .feedback_action
            .clone()
            .or_else(|| existing.feedback_action.clone())
    };
    preserve_artifact_receipts(&existing.snapshot, &mut merged.snapshot);
    if let Some(existing_launch) = existing_launch.as_ref() {
        set_project_agent_launch_snapshot(&mut merged.snapshot, existing_launch)?;
    }
    if let Some(checkpoint) = existing.snapshot.get(PROJECT_AGENT_INGEST_SNAPSHOT_KEY) {
        if ingest_checkpoint_matches(&merged, checkpoint) {
            if let Some(object) = merged.snapshot.as_object_mut() {
                object.insert(PROJECT_AGENT_INGEST_SNAPSHOT_KEY.into(), checkpoint.clone());
            }
        }
    }
    Ok(merged)
}

#[derive(Debug, Clone)]
struct StoredCloudAgentRunRecord {
    record: CloudAgentRunRecord,
    snapshot_json: String,
}

enum SaveRecordCasResult {
    Saved(CloudAgentRunRecord),
    Conflict(StoredCloudAgentRunRecord),
}

fn stored_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredCloudAgentRunRecord> {
    let references: String = row.get(5)?;
    let snapshot_json: String = row.get(7)?;
    Ok(StoredCloudAgentRunRecord {
        record: CloudAgentRunRecord {
            run_id: row.get(0)?,
            conversation_id: row.get(1)?,
            skill_id: row.get(2)?,
            status: row.get(3)?,
            intent_prompt: row.get(4)?,
            reference_asset_ids: serde_json::from_str(&references).unwrap_or_default(),
            project_id: row.get(6)?,
            thread_id: row.get(12)?,
            creative_launch_id: row.get(13)?,
            snapshot: serde_json::from_str(&snapshot_json).unwrap_or(Value::Null),
            feedback_action: row.get(8)?,
            final_asset_id: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        },
        snapshot_json,
    })
}

fn query_stored_record(
    conn: &rusqlite::Connection,
    run_id: &str,
) -> Result<StoredCloudAgentRunRecord, AppError> {
    conn.query_row(
        "SELECT run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at, thread_id, creative_launch_id FROM cloud_agent_runs WHERE run_id=?1",
        [run_id],
        stored_record_from_row,
    )
    .map_err(AppError::from)
}

fn write_record(conn: &rusqlite::Connection, record: &CloudAgentRunRecord) -> Result<(), AppError> {
    conn.execute(
        "UPDATE cloud_agent_runs SET status=?2,snapshot_json=?3,feedback_action=?4,final_asset_id=?5,updated_at=?6 WHERE run_id=?1",
        rusqlite::params![
            record.run_id,
            record.status,
            serde_json::to_string(&record.snapshot)?,
            record.feedback_action,
            record.final_asset_id,
            record.updated_at,
        ],
    )?;
    Ok(())
}

fn insert_record(
    conn: &rusqlite::Connection,
    record: &CloudAgentRunRecord,
) -> Result<(), AppError> {
    let reference_asset_ids = serde_json::to_string(&record.reference_asset_ids)?;
    let snapshot = serde_json::to_string(&record.snapshot)?;
    conn.execute(
        "INSERT INTO cloud_agent_runs (run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at, thread_id, creative_launch_id) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        rusqlite::params![
            record.run_id,
            record.conversation_id,
            record.skill_id,
            record.status,
            record.intent_prompt,
            reference_asset_ids,
            record.project_id,
            snapshot,
            record.feedback_action,
            record.final_asset_id,
            record.created_at,
            record.updated_at,
            record.thread_id,
            record.creative_launch_id,
        ],
    )?;
    Ok(())
}

fn save_record(
    db: &Database,
    record: &CloudAgentRunRecord,
) -> Result<CloudAgentRunRecord, AppError> {
    validate_record_launch(record)?;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = tx
        .query_row(
            "SELECT run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at, thread_id, creative_launch_id FROM cloud_agent_runs WHERE run_id=?1",
            [&record.run_id],
            stored_record_from_row,
        )
        .optional()?;
    if let Some(existing) = existing {
        let merged = merge_record(&existing.record, record)?;
        write_record(&tx, &merged)?;
    } else {
        insert_record(&tx, record)?;
    }
    let persisted = query_stored_record(&tx, &record.run_id)?.record;
    tx.commit()?;
    Ok(persisted)
}

fn save_record_if_unchanged(
    db: &Database,
    expected: &StoredCloudAgentRunRecord,
    incoming: &CloudAgentRunRecord,
) -> Result<SaveRecordCasResult, AppError> {
    ensure_same_record_identity(&expected.record, incoming)?;
    let merged = merge_record(&expected.record, incoming)?;
    let snapshot_json = serde_json::to_string(&merged.snapshot)?;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let changed = tx.execute(
        "UPDATE cloud_agent_runs SET status=?2,snapshot_json=?3,feedback_action=?4,final_asset_id=?5,updated_at=?6 \
         WHERE run_id=?1 AND status=?7 AND snapshot_json=?8 AND feedback_action IS ?9 \
           AND final_asset_id IS ?10 AND updated_at=?11 AND project_id IS ?12 \
           AND thread_id IS ?13 AND creative_launch_id IS ?14",
        rusqlite::params![
            merged.run_id,
            merged.status,
            snapshot_json,
            merged.feedback_action,
            merged.final_asset_id,
            merged.updated_at,
            expected.record.status,
            expected.snapshot_json,
            expected.record.feedback_action,
            expected.record.final_asset_id,
            expected.record.updated_at,
            expected.record.project_id,
            expected.record.thread_id,
            expected.record.creative_launch_id,
        ],
    )?;
    let persisted = query_stored_record(&tx, &incoming.run_id)?;
    ensure_same_record_identity(&persisted.record, incoming)?;
    tx.commit()?;
    if changed == 1 {
        Ok(SaveRecordCasResult::Saved(persisted.record))
    } else {
        Ok(SaveRecordCasResult::Conflict(persisted))
    }
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CloudAgentRunRecord> {
    stored_record_from_row(row).map(|stored| stored.record)
}

#[cfg(test)]
fn load_record(db: &Database, run_id: &str) -> Result<CloudAgentRunRecord, AppError> {
    let conn = db.conn.lock().unwrap();
    query_stored_record(&conn, run_id).map(|stored| stored.record)
}

fn load_stored_record(db: &Database, run_id: &str) -> Result<StoredCloudAgentRunRecord, AppError> {
    let conn = db.conn.lock().unwrap();
    query_stored_record(&conn, run_id)
}

fn list_records(db: &Database, limit: usize) -> Result<Vec<CloudAgentRunRecord>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut statement = conn.prepare(
        "SELECT run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at, thread_id, creative_launch_id \
         FROM cloud_agent_runs ORDER BY created_at DESC, rowid DESC LIMIT ?1",
    )?;
    let records = statement
        .query_map([limit.clamp(1, 200) as i64], record_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(records)
}

fn recover_agent_projections(db: &Database, records: &mut [CloudAgentRunRecord]) {
    for record in records {
        if record.thread_id.is_none() || record.creative_launch_id.is_none() {
            continue;
        }
        let projection = match project_agent_record(db, record) {
            Err(AppError::NotFound(message)) if message.starts_with("agent prompt ") => {
                if let Some(launch) = project_agent_launch_from_snapshot(&record.snapshot) {
                    db.begin_project_agent_launch(&launch)
                        .and_then(|_| project_agent_record(db, record))
                } else {
                    Err(AppError::NotFound(message))
                }
            }
            result => result,
        };
        if let Err(error) = projection {
            tracing::warn!(
                run_id = %record.run_id,
                error = %error,
                "failed to recover local creative projection for agent run"
            );
        }

        // A process can stop after artifact_received receipts and final_asset_id are
        // committed but before the separate whole-group checkpoint transaction. The
        // frontend correctly treats those receipts as already ingested, so repair the
        // local-only checkpoint from durable mappings while servicing startup reads.
        // Keep recovery isolated per Run: a corrupt/incomplete record remains
        // fail-closed without making the whole history list unavailable.
        let needs_ingest_checkpoint = accepted_ingest_result(record)
            && record.final_asset_id.is_some()
            && ingest_artifact_receipts_complete(record)
            && ingest_artifact_fingerprint(record).is_some()
            && !record
                .snapshot
                .get(PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
                .is_some_and(|checkpoint| ingest_checkpoint_matches(record, checkpoint));
        if needs_ingest_checkpoint {
            match checkpoint_completed_ingest_if_ready(db, record) {
                Ok(recovered) => *record = recovered,
                Err(error) => {
                    tracing::warn!(
                        run_id = %record.run_id,
                        error = %error,
                        "failed to recover local Agent ingest checkpoint"
                    );
                }
            }
        }
    }
}

fn compact_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let text = match value? {
        Value::String(value) => value.trim().to_string(),
        value => value.to_string(),
    };
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(max_chars).collect())
}

fn event_summary(event: &Value) -> Option<String> {
    let payload = event.get("display_payload")?;
    ["summary", "message", "title", "goal", "rationale"]
        .into_iter()
        .find_map(|key| compact_text(payload.get(key), 240))
}

fn agent_visual_profile(run: &Value) -> Option<VisualProfileRefV1> {
    Some(VisualProfileRefV1 {
        profile_id: compact_text(run.get("visual_profile_id"), 160)?,
        version: run.get("visual_profile_version")?.as_i64()?,
        hash: compact_text(run.get("visual_profile_hash"), 160)?,
    })
}

fn agent_group_payload(record: &CloudAgentRunRecord) -> AgentGroupNodePayloadV1 {
    let run = record.snapshot.get("run").unwrap_or(&Value::Null);
    let events = record
        .snapshot
        .get("events")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .skip(values.len().saturating_sub(96))
                .filter_map(|event| {
                    Some(AgentGroupEventV1 {
                        seq: event.get("seq")?.as_i64()?,
                        event_type: compact_text(event.get("type"), 80)?,
                        step: compact_text(event.get("step"), 120),
                        progress: event
                            .get("progress")
                            .and_then(Value::as_u64)
                            .map(|value| value.min(100) as u8),
                        summary: event_summary(event),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let approvals = record
        .snapshot
        .get("approvals")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .skip(values.len().saturating_sub(16))
                .filter_map(|approval| {
                    let proposal = approval.get("proposal");
                    Some(AgentGroupApprovalV1 {
                        id: compact_text(approval.get("id"), 160)?,
                        kind: compact_text(approval.get("kind"), 80)?,
                        status: compact_text(approval.get("status"), 40)?,
                        proposal_hash: compact_text(approval.get("proposal_hash"), 160)
                            .unwrap_or_default(),
                        planned_tool_count: approval
                            .get("planned_tool_count")
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                            .min(u32::MAX as u64)
                            as u32,
                        estimated_additional_credits: approval
                            .get("estimated_additional_credits")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        title: proposal.and_then(|value| compact_text(value.get("title"), 160)),
                        summary: proposal.and_then(|value| compact_text(value.get("summary"), 320)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let clarifications = record
        .snapshot
        .get("clarifications")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .skip(values.len().saturating_sub(8))
                .filter_map(|clarification| {
                    let question = clarification.get("question");
                    Some(AgentGroupClarificationV1 {
                        id: compact_text(clarification.get("id"), 160)?,
                        status: compact_text(clarification.get("status"), 40)?,
                        question: question
                            .and_then(|value| compact_text(value.get("question"), 400)),
                        recommended_answer: question
                            .and_then(|value| compact_text(value.get("recommendedAnswer"), 320)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let artifacts = record
        .snapshot
        .get("artifacts")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|artifact| {
                    Some(AgentGroupArtifactV1 {
                        artifact_id: compact_text(artifact.get("id"), 160)?,
                        role: compact_text(artifact.get("role"), 80)?,
                        step_id: compact_text(artifact.get("step_id"), 160),
                        mime: compact_text(artifact.get("mime"), 120)?,
                        user_visible: artifact
                            .get("user_visible")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .take(64)
                .collect()
        })
        .unwrap_or_default();
    AgentGroupNodePayloadV1 {
        schema_version: 1,
        run_id: record.run_id.clone(),
        conversation_id: Some(record.conversation_id.clone()),
        skill_id: record.skill_id.clone(),
        status: record.status.clone(),
        agent_runtime: compact_text(run.get("agent_runtime"), 40),
        current_step: compact_text(run.get("current_step"), 120),
        progress: run
            .get("progress")
            .and_then(Value::as_u64)
            .map(|value| value.min(100) as u8),
        budget_credits: run.get("budget_credits").and_then(Value::as_i64),
        actual_credits: run.get("actual_credits").and_then(Value::as_i64),
        visual_profile: agent_visual_profile(run),
        events,
        approvals,
        clarifications,
        artifacts,
    }
}

fn project_agent_artifact_and_map(
    db: &Database,
    run_id: &str,
    artifact_id: &str,
    role: &str,
    ordinal: i64,
    asset: &Asset,
) -> Result<String, AppError> {
    let node_id = db.project_agent_artifact_on_canvas(run_id, artifact_id, role, ordinal, asset)?;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing: Option<(String, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT run_id,asset_id,node_id FROM cloud_agent_artifact_assets WHERE artifact_id=?1",
            [artifact_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    if let Some((existing_run_id, existing_asset_id, existing_node_id)) = existing.as_ref() {
        if existing_run_id != run_id
            || existing_asset_id
                .as_deref()
                .is_some_and(|value| value != asset.id)
            || existing_node_id
                .as_deref()
                .is_some_and(|value| value != node_id)
        {
            return Err(AppError::Other(format!(
                "Agent artifact {artifact_id} local projection cannot change after ingest"
            )));
        }
        tx.execute(
            "UPDATE cloud_agent_artifact_assets SET asset_id=COALESCE(asset_id,?3),node_id=COALESCE(node_id,?4) WHERE run_id=?1 AND artifact_id=?2",
            rusqlite::params![run_id, artifact_id, asset.id, node_id],
        )?;
    } else {
        tx.execute(
            "INSERT INTO cloud_agent_artifact_assets (run_id,artifact_id,asset_id,node_id,created_at) VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![
                run_id,
                artifact_id,
                asset.id,
                node_id,
                chrono::Utc::now().timestamp()
            ],
        )?;
    }
    tx.commit()?;
    Ok(node_id)
}

fn project_agent_record(db: &Database, record: &CloudAgentRunRecord) -> Result<(), AppError> {
    let (Some(project_id), Some(thread_id), Some(launch_id)) = (
        record.project_id.as_deref(),
        record.thread_id.as_deref(),
        record.creative_launch_id.as_deref(),
    ) else {
        return Ok(());
    };
    db.project_agent_run_on_canvas(
        project_id,
        thread_id,
        launch_id,
        &agent_group_payload(record),
    )?;
    if let Some(asset_id) = record.final_asset_id.as_deref() {
        if let Some(asset) = db.get_asset(asset_id)? {
            db.add_assets_to_project(project_id, std::slice::from_ref(&asset.id))?;
            if let Some((ordinal, artifact_id, role)) = primary_ingestible_artifact(record) {
                project_agent_artifact_and_map(
                    db,
                    &record.run_id,
                    &artifact_id,
                    &role,
                    ordinal as i64,
                    &asset,
                )?;
            }
        }
    }
    Ok(())
}

fn save_and_project_record(
    db: &Database,
    record: &CloudAgentRunRecord,
) -> Result<CloudAgentRunRecord, AppError> {
    let persisted = save_record(db, record)?;
    project_agent_record(db, &persisted)?;
    Ok(persisted)
}

fn save_feedback_action_and_project(
    db: &Database,
    record: &CloudAgentRunRecord,
    feedback_action: &str,
) -> Result<CloudAgentRunRecord, AppError> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = query_stored_record(&tx, &record.run_id)?;
    ensure_same_record_identity(&existing.record, record)?;
    if !is_terminal_agent_status(&existing.record.status) || existing.record.status == record.status
    {
        tx.execute(
            "UPDATE cloud_agent_runs SET feedback_action=?2,updated_at=MAX(updated_at,?3) WHERE run_id=?1",
            rusqlite::params![
                record.run_id,
                feedback_action,
                chrono::Utc::now().timestamp()
            ],
        )?;
    }
    let persisted = query_stored_record(&tx, &record.run_id)?.record;
    tx.commit()?;
    drop(conn);
    project_agent_record(db, &persisted)?;
    Ok(persisted)
}

fn save_final_asset_and_project(
    db: &Database,
    record: &CloudAgentRunRecord,
    asset_id: &str,
) -> Result<CloudAgentRunRecord, AppError> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = query_stored_record(&tx, &record.run_id)?;
    ensure_same_record_identity(&existing.record, record)?;
    if existing.record.status != "succeeded"
        || existing.record.feedback_action.as_deref() != Some("accept")
    {
        return Err(AppError::Other(
            "只有已接受且完成结算的 Agent 会话可以关联最终资产".into(),
        ));
    }
    if existing
        .record
        .final_asset_id
        .as_deref()
        .is_some_and(|existing_asset_id| existing_asset_id != asset_id)
    {
        return Err(AppError::Other(format!(
            "Cloud Agent run {} final asset cannot change after ingest",
            record.run_id
        )));
    }
    tx.execute(
        "UPDATE cloud_agent_runs SET final_asset_id=COALESCE(final_asset_id,?2),updated_at=MAX(updated_at,?3) WHERE run_id=?1",
        rusqlite::params![record.run_id, asset_id, chrono::Utc::now().timestamp()],
    )?;
    let persisted = query_stored_record(&tx, &record.run_id)?.record;
    tx.commit()?;
    drop(conn);
    project_agent_record(db, &persisted)?;
    Ok(persisted)
}

fn emit_creative_agent_changed(app: &AppHandle, record: &CloudAgentRunRecord) {
    if let (Some(project_id), Some(thread_id)) =
        (record.project_id.as_deref(), record.thread_id.as_deref())
    {
        let _ = app.emit(
            "creative://changed",
            json!({
                "projectId": project_id,
                "threadId": thread_id,
                "runId": &record.run_id,
                "status": &record.status,
            }),
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn begin_creative_launch(
    db: &Database,
    project_id: Option<&str>,
    thread_id: Option<&str>,
    prompt: &str,
    provider: &str,
    ratio: Option<&str>,
    visual_profile: Option<&VisualProfileCapsule>,
    reference_asset_ids: &[String],
    parent_node_id: Option<&str>,
    parent_asset_id: Option<&str>,
) -> Result<Option<ProjectAgentLaunchInput>, AppError> {
    let (Some(project_id), Some(thread_id)) = (project_id, thread_id) else {
        return Ok(None);
    };
    let launch_id = Ulid::new().to_string();
    let launch = ProjectAgentLaunchInput {
        project_id: project_id.to_string(),
        thread_id: thread_id.to_string(),
        launch_id: launch_id.clone(),
        prompt: prompt.to_string(),
        provider: provider.to_string(),
        ratio: ratio.map(str::to_string),
        visual_profile: visual_profile.map(|profile| VisualProfileRefV1 {
            profile_id: profile.profile_id.clone(),
            version: profile.version,
            hash: profile.hash.clone(),
        }),
        reference_asset_ids: reference_asset_ids.to_vec(),
        parent_node_id: parent_node_id.map(str::to_string),
        parent_asset_id: parent_asset_id.map(str::to_string),
    };
    db.begin_project_agent_launch(&launch)?;
    Ok(Some(launch))
}

#[allow(clippy::too_many_arguments)]
fn checkpoint_created_run(
    db: &Database,
    app: &AppHandle,
    created: &Value,
    run_id: &str,
    conversation_id: &str,
    skill_id: &str,
    skill_version: &str,
    agent_runtime: Option<&str>,
    intent_prompt: &str,
    reference_asset_ids: &[String],
    project_id: Option<&str>,
    thread_id: Option<&str>,
    creative_launch_id: Option<&str>,
    creative_launch: Option<&ProjectAgentLaunchInput>,
    default_budget: i64,
) -> Result<CloudAgentRunRecord, AppError> {
    let now = chrono::Utc::now().timestamp();
    let mut snapshot = json!({
        "conversationId": conversation_id,
        "run": {
            "id": run_id,
            "conversation_id": conversation_id,
            "skill_id": skill_id,
            "skill_version": skill_version,
            "agent_runtime": agent_runtime,
            "status": "uploading",
            "progress": 0,
            "budget_credits": created.get("budgetCredits").cloned().unwrap_or(json!(default_budget)),
        },
        "events": [], "approvals": [], "clarifications": [], "artifacts": [],
    });
    if let Some(launch) = creative_launch {
        set_project_agent_launch_snapshot(&mut snapshot, launch)?;
    }
    let record = CloudAgentRunRecord {
        run_id: run_id.to_string(),
        conversation_id: conversation_id.to_string(),
        skill_id: skill_id.to_string(),
        status: "uploading".into(),
        intent_prompt: intent_prompt.to_string(),
        reference_asset_ids: reference_asset_ids.to_vec(),
        project_id: project_id.map(str::to_string),
        thread_id: thread_id.map(str::to_string),
        creative_launch_id: creative_launch_id.map(str::to_string),
        snapshot,
        feedback_action: None,
        final_asset_id: None,
        created_at: now,
        updated_at: now,
    };
    let record = save_and_project_record(db, &record)?;
    emit_creative_agent_changed(app, &record);
    Ok(record)
}

fn checkpoint_transfer_failure(
    db: &Database,
    app: &AppHandle,
    record: &mut CloudAgentRunRecord,
    cancel_response: Option<&Value>,
) {
    let status = transfer_cleanup_status(cancel_response);
    record.status = status.into();
    record.snapshot["run"]["status"] = json!(status);
    record.updated_at = chrono::Utc::now().timestamp();
    if let Ok(persisted) = save_and_project_record(db, record) {
        *record = persisted;
    }
    emit_creative_agent_changed(app, record);
}

fn finalize_refreshed_record(
    db: &Database,
    record: CloudAgentRunRecord,
) -> Result<CloudAgentRunRecord, AppError> {
    project_agent_record(db, &record)?;
    checkpoint_completed_ingest_if_ready(db, &record)
}

async fn refresh_record(
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    run_id: &str,
) -> Result<CloudAgentRunRecord, AppError> {
    let mut expected = load_stored_record(db, run_id)?;
    for attempt in 0..2 {
        let snapshot = agent_action(
            cloud,
            auth,
            json!({ "action": "get", "runId": run_id }),
            "读取 Agent Run 失败",
        )
        .await?;
        let mut incoming = expected.record.clone();
        incoming.status = run_status(&snapshot)?;
        if let Some(action) = snapshot
            .pointer("/run/result_feedback_action")
            .and_then(Value::as_str)
            .filter(|action| matches!(*action, "accept" | "retry"))
        {
            incoming.feedback_action = Some(action.to_string());
        }
        incoming.snapshot = snapshot;
        incoming.updated_at = chrono::Utc::now().timestamp();

        // A response captured before cancel/finish must not be allowed to
        // regress the local terminal checkpoint, even if it arrives later.
        if is_terminal_agent_status(&expected.record.status)
            && expected.record.status != incoming.status
        {
            return finalize_refreshed_record(db, expected.record);
        }

        match save_record_if_unchanged(db, &expected, &incoming)? {
            SaveRecordCasResult::Saved(persisted) => {
                return finalize_refreshed_record(db, persisted);
            }
            SaveRecordCasResult::Conflict(current) => {
                if is_terminal_agent_status(&current.record.status)
                    && current.record.status != incoming.status
                {
                    return finalize_refreshed_record(db, current.record);
                }
                if attempt == 1 {
                    return finalize_refreshed_record(db, current.record);
                }
                expected = current;
            }
        }
    }
    unreachable!("bounded Cloud Agent refresh loop always returns")
}

fn normalize_intent_prompt(
    prompt: &str,
    references: &[CloudAgentReferenceRequest],
) -> Result<String, AppError> {
    let mut normalized = prompt.trim().to_string();
    if normalized.is_empty() || normalized.chars().count() > MAX_PROMPT_CHARS {
        return Err(AppError::Other("Agent 意图须为 1–4000 个字符".into()));
    }
    let mut tokens: Vec<(String, String)> = references
        .iter()
        .enumerate()
        .filter_map(|(index, reference)| {
            let token = reference
                .prompt_token
                .as_deref()?
                .trim()
                .trim_start_matches('@');
            (!token.is_empty()).then(|| (format!("@{token}"), format!("@图{}", index + 1)))
        })
        .collect();
    tokens.sort_by(|left, right| right.0.chars().count().cmp(&left.0.chars().count()));
    for (from, to) in tokens {
        normalized = normalized.replace(&from, &to);
    }
    Ok(normalized)
}

fn valid_https_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.host_str().is_some())
}

async fn upload_signed(
    cloud: &CloudClient,
    url: &str,
    mime: &str,
    bytes: Vec<u8>,
    label: &str,
) -> Result<(), AppError> {
    if !valid_https_url(url) {
        return Err(AppError::Cloud(format!("{label}上传地址不安全")));
    }
    let response = cloud
        .http()
        .put(url)
        .header(reqwest::header::CONTENT_TYPE, mime)
        .header("x-upsert", "true")
        .body(bytes)
        .send()
        .await
        .map_err(|error| AppError::Cloud(format!("{label}上传失败: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Cloud(format!(
            "{label}上传失败（HTTP {}）",
            response.status().as_u16()
        )));
    }
    Ok(())
}

fn validate_html_layout_options(options: HtmlLayoutOptions) -> Result<HtmlLayoutOptions, AppError> {
    if !(320..=2400).contains(&options.viewport_width)
        || !(240..=4000).contains(&options.viewport_height)
        || !matches!(options.device_scale_factor, 1 | 2)
        || !matches!(options.background.as_str(), "opaque" | "transparent")
    {
        return Err(AppError::Other("HTML 排版视口或背景参数无效".into()));
    }
    match options.capture_mode.as_str() {
        "viewport" | "full_page" => {
            if options.slice_height.is_some() || options.overlap.is_some() {
                return Err(AppError::Other("非切片模式不能设置切片参数".into()));
            }
        }
        "full_page_and_slices" => {
            let height = options
                .slice_height
                .ok_or_else(|| AppError::Other("切片模式必须设置切片高度".into()))?;
            let overlap = options.overlap.unwrap_or(0);
            if !(200..=4000).contains(&height) || overlap > 200 || overlap >= height {
                return Err(AppError::Other("HTML 排版切片参数无效".into()));
            }
        }
        _ => return Err(AppError::Other("HTML 排版截图模式无效".into())),
    }
    Ok(options)
}

async fn start_html_layout_run(
    app: &AppHandle,
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    entitlement: &EntitlementService,
    intent_prompt: String,
    references: Vec<CloudAgentReferenceRequest>,
    project_id: Option<String>,
    options: HtmlLayoutOptions,
    thread_id: Option<String>,
    parent_node_id: Option<String>,
    parent_asset_id: Option<String>,
) -> Result<CloudAgentRunRecord, AppError> {
    let options = validate_html_layout_options(options)?;
    let policy = entitlement.current_or_sync(auth).await.policy;
    if !policy.allows_agent_run(HTML_SKILL_ID) {
        return Err(AppError::Other("当前权益未开放 HTML 排版 Agent".into()));
    }
    if let Some(project) = project_id.as_deref() {
        if db.get_project(project)?.is_none() {
            return Err(AppError::Other("当前项目不存在".into()));
        }
    }
    let normalized_prompt = normalize_intent_prompt(&intent_prompt, &references)?;
    let mut image_bytes = Vec::with_capacity(references.len());
    let mut reference_ids = Vec::with_capacity(references.len());
    for reference in &references {
        let asset = db
            .get_asset(&reference.asset_id)?
            .ok_or_else(|| AppError::Other("参考图不在素材库中，请先入库再启动 Agent".into()))?;
        let path = asset
            .store_path
            .as_deref()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .ok_or_else(|| AppError::Other(format!("参考图 {} 的本地文件不存在", asset.name)))?;
        image_bytes.push(crate::codex::cloud_image::read_agent_reference_jpeg(&path).await?);
        reference_ids.push(reference.asset_id.clone());
    }
    let manifest_references = image_bytes
        .iter()
        .enumerate()
        .map(|(index, bytes)| HtmlLayoutReference {
            artifact_id: uuid::Uuid::new_v4().to_string(),
            token: format!("@图{}", index + 1),
            ordinal: index + 1,
            mime: "image/jpeg",
            bytes: bytes.len(),
            sha256: sha256_hex(bytes),
        })
        .collect::<Vec<_>>();
    let capture = HtmlLayoutCapture {
        mode: options.capture_mode.clone(),
        slice_height_css_px: options.slice_height,
        overlap_css_px: options.overlap,
    };
    let manifest = serde_json::to_vec(&HtmlLayoutManifest {
        schema_version: 1,
        layout_prompt: &normalized_prompt,
        references: &manifest_references,
        viewport: HtmlLayoutViewport {
            width_css_px: options.viewport_width,
            height_css_px: options.viewport_height,
            device_scale_factor: options.device_scale_factor,
        },
        capture,
        background: &options.background,
    })?;
    if manifest.len() > 64 * 1024 {
        return Err(AppError::Other("HTML 排版输入清单过大".into()));
    }
    let creative_launch = begin_creative_launch(
        db,
        project_id.as_deref(),
        thread_id.as_deref(),
        &normalized_prompt,
        "cloud",
        None,
        None,
        &reference_ids,
        parent_node_id.as_deref(),
        parent_asset_id.as_deref(),
    )?;
    let creative_launch_id = creative_launch
        .as_ref()
        .map(|launch| launch.launch_id.clone());
    let create_result = agent_action(
        cloud,
        auth,
        json!({
            "action": "create",
            "skillId": HTML_SKILL_ID,
            "goal": normalized_prompt,
            "inputCount": image_bytes.len(),
            "inputManifestHash": sha256_hex(&manifest),
            "idempotencyKey": creative_launch_id
                .as_ref()
                .map(|launch_id| format!("desktop-html-agent-{launch_id}"))
                .unwrap_or_else(|| format!("desktop-html-agent-{}", Ulid::new())),
            "imageProvider": "cloud",
        }),
        "创建 HTML 排版 Run 失败",
    )
    .await;
    let created = match create_result {
        Ok(created) => created,
        Err(error) => {
            if let (Some(session_id), Some(launch_id)) =
                (thread_id.as_deref(), creative_launch_id.as_deref())
            {
                let _ = db.update_project_agent_launch_status(session_id, launch_id, "failed");
                let _ = app.emit(
                    "creative://changed",
                    json!({ "threadId": session_id, "status": "failed" }),
                );
            }
            return Err(error);
        }
    };
    let run_id = created
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Cloud("创建 HTML 排版 Run 未返回 runId".into()))?
        .to_string();
    let conversation_id = created
        .get("conversationId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Cloud("创建 HTML 排版 Run 未返回 conversationId".into()))?
        .to_string();
    let mut created_checkpoint = checkpoint_created_run(
        db,
        app,
        &created,
        &run_id,
        &conversation_id,
        HTML_SKILL_ID,
        "0.1.0",
        None,
        &normalized_prompt,
        &reference_ids,
        project_id.as_deref(),
        thread_id.as_deref(),
        creative_launch_id.as_deref(),
        creative_launch.as_ref(),
        15,
    )?;
    let transfer_result: Result<(), AppError> = async {
        let request_url = created
            .get("uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Cloud("创建 HTML 排版 Run 未返回输入上传地址".into()))?;
        upload_signed(
            cloud,
            request_url,
            "application/json",
            manifest,
            "HTML 排版输入",
        )
        .await?;
        let uploads = created
            .get("inputUploads")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::Cloud("创建 HTML 排版 Run 未返回参考图上传清单".into()))?;
        if uploads.len() != image_bytes.len() {
            return Err(AppError::Cloud("HTML 排版参考图上传清单数量不一致".into()));
        }
        for (index, bytes) in image_bytes.into_iter().enumerate() {
            let upload = uploads
                .iter()
                .find(|item| {
                    item.get("ordinal").and_then(Value::as_u64) == Some((index + 1) as u64)
                })
                .and_then(|item| item.get("uploadUrl"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Cloud(format!("第 {} 张 HTML 参考图缺少上传地址", index + 1))
                })?;
            upload_signed(
                cloud,
                upload,
                "image/jpeg",
                bytes,
                &format!("第 {} 张 HTML 参考图", index + 1),
            )
            .await?;
        }
        agent_action(
            cloud,
            auth,
            json!({ "action": "enqueue", "runId": run_id }),
            "HTML 排版 Run 入队失败",
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = transfer_result {
        let cancel_response = agent_action(
            cloud,
            auth,
            json!({ "action": "cancel", "runId": run_id }),
            "清理未完成的 HTML 排版 Run 失败",
        )
        .await;
        checkpoint_transfer_failure(
            db,
            app,
            &mut created_checkpoint,
            cancel_response.as_ref().ok(),
        );
        return Err(error);
    }
    let now = chrono::Utc::now().timestamp();
    let mut fallback_snapshot = json!({
        "conversationId": conversation_id,
        "run": {
            "id": run_id,
            "conversation_id": conversation_id,
            "skill_id": HTML_SKILL_ID,
            "skill_version": "0.1.0",
            "status": "queued",
            "progress": 0,
            "budget_credits": created.get("budgetCredits").cloned().unwrap_or(json!(15)),
        },
        "events": [], "approvals": [], "clarifications": [], "artifacts": [],
    });
    if let Some(launch) = creative_launch.as_ref() {
        set_project_agent_launch_snapshot(&mut fallback_snapshot, launch)?;
    }
    let mut record = CloudAgentRunRecord {
        run_id,
        conversation_id,
        skill_id: HTML_SKILL_ID.into(),
        status: "queued".into(),
        intent_prompt: normalized_prompt,
        reference_asset_ids: reference_ids,
        project_id,
        thread_id,
        creative_launch_id,
        snapshot: fallback_snapshot,
        feedback_action: None,
        final_asset_id: None,
        created_at: now,
        updated_at: now,
    };
    record = save_and_project_record(db, &record)?;
    emit_creative_agent_changed(app, &record);
    if let Ok(refreshed) = refresh_record(db, cloud, auth, &record.run_id).await {
        record = refreshed;
        emit_creative_agent_changed(app, &record);
    }
    Ok(record)
}

async fn start_unified_agent_run(
    app: &AppHandle,
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    entitlement: &EntitlementService,
    intent_prompt: String,
    references: Vec<CloudAgentReferenceRequest>,
    ratio: Option<String>,
    project_id: Option<String>,
    visual_profile_id: Option<String>,
    options: HtmlLayoutOptions,
    thread_id: Option<String>,
    parent_node_id: Option<String>,
    parent_asset_id: Option<String>,
) -> Result<CloudAgentRunRecord, AppError> {
    let options = validate_html_layout_options(options)?;
    let entitlement_snapshot = entitlement.current_or_sync(auth).await;
    if !entitlement_snapshot.is_test_account
        || !entitlement_snapshot
            .policy
            .allows_agent_run(UNIFIED_SKILL_ID)
    {
        return Err(AppError::Other("当前测试账号未开放 DSH 统一 Agent".into()));
    }
    if visual_profile_id.is_some() && !entitlement_snapshot.policy.can_use_visual_profiles {
        return Err(AppError::Other("当前权益不支持项目视觉设定".into()));
    }
    if let Some(project) = project_id.as_deref() {
        if db.get_project(project)?.is_none() {
            return Err(AppError::Other("当前项目不存在".into()));
        }
    }
    let visual_profile_capsule = match visual_profile_id.as_deref() {
        Some(profile_id) => {
            let project_id = project_id
                .as_deref()
                .ok_or_else(|| AppError::Other("视觉设定只能在当前项目内使用".into()))?;
            Some(db.visual_profile_capsule(profile_id, project_id)?)
        }
        None => None,
    };
    let resolved_ratio = normalize_requested_ratio(ratio)?;
    let normalized_prompt = normalize_intent_prompt(&intent_prompt, &references)?;
    let mut image_bytes = Vec::with_capacity(references.len());
    let mut reference_ids = Vec::with_capacity(references.len());
    for reference in &references {
        let asset = db
            .get_asset(&reference.asset_id)?
            .ok_or_else(|| AppError::Other("参考图不在素材库中，请先入库再启动 Agent".into()))?;
        let path = asset
            .store_path
            .as_deref()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .ok_or_else(|| AppError::Other(format!("参考图 {} 的本地文件不存在", asset.name)))?;
        image_bytes.push(crate::codex::cloud_image::read_agent_reference_jpeg(&path).await?);
        reference_ids.push(reference.asset_id.clone());
    }
    let manifest_references = image_bytes
        .iter()
        .enumerate()
        .map(|(index, bytes)| HtmlLayoutReference {
            artifact_id: uuid::Uuid::new_v4().to_string(),
            token: format!("@图{}", index + 1),
            ordinal: index + 1,
            mime: "image/jpeg",
            bytes: bytes.len(),
            sha256: sha256_hex(bytes),
        })
        .collect::<Vec<_>>();
    let manifest = serde_json::to_vec(&UnifiedAgentManifest {
        schema_version: 1,
        goal: &normalized_prompt,
        references: &manifest_references,
        ratio: resolved_ratio.as_deref(),
        html_output: UnifiedHtmlOutput {
            viewport: HtmlLayoutViewport {
                width_css_px: options.viewport_width,
                height_css_px: options.viewport_height,
                device_scale_factor: options.device_scale_factor,
            },
            capture: HtmlLayoutCapture {
                mode: options.capture_mode.clone(),
                slice_height_css_px: options.slice_height,
                overlap_css_px: options.overlap,
            },
            background: &options.background,
        },
        visual_profile_capsule: visual_profile_capsule.as_ref(),
    })?;
    if manifest.len() > 64 * 1024 {
        return Err(AppError::Other("统一 Agent 输入清单过大".into()));
    }
    let creative_launch = begin_creative_launch(
        db,
        project_id.as_deref(),
        thread_id.as_deref(),
        &normalized_prompt,
        "cloud",
        resolved_ratio.as_deref(),
        visual_profile_capsule.as_ref(),
        &reference_ids,
        parent_node_id.as_deref(),
        parent_asset_id.as_deref(),
    )?;
    let creative_launch_id = creative_launch
        .as_ref()
        .map(|launch| launch.launch_id.clone());
    let mut create_body = json!({
        "action": "create",
        "skillId": UNIFIED_SKILL_ID,
        "goal": normalized_prompt,
        "inputCount": image_bytes.len(),
        "inputManifestHash": sha256_hex(&manifest),
        "idempotencyKey": creative_launch_id
            .as_ref()
            .map(|launch_id| format!("desktop-unified-agent-{launch_id}"))
            .unwrap_or_else(|| format!("desktop-unified-agent-{}", Ulid::new())),
        "imageProvider": "cloud",
        "agentRuntime": DSH_AGENT_RUNTIME,
    });
    if let Some(capsule) = visual_profile_capsule.as_ref() {
        create_body["visualProfile"] = json!({
            "profileId": &capsule.profile_id,
            "version": capsule.version,
            "hash": &capsule.hash,
        });
    }
    if let Some(value) = resolved_ratio.as_deref() {
        create_body["ratio"] = json!(value);
    }
    let created = match agent_action(cloud, auth, create_body, "创建 DSH 统一 Agent Run 失败").await
    {
        Ok(created) => created,
        Err(error) => {
            if let (Some(session_id), Some(launch_id)) =
                (thread_id.as_deref(), creative_launch_id.as_deref())
            {
                let _ = db.update_project_agent_launch_status(session_id, launch_id, "failed");
                let _ = app.emit(
                    "creative://changed",
                    json!({ "threadId": session_id, "status": "failed" }),
                );
            }
            return Err(error);
        }
    };
    let run_id = created
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Cloud("创建统一 Agent Run 未返回 runId".into()))?
        .to_string();
    let conversation_id = created
        .get("conversationId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Cloud("创建统一 Agent Run 未返回 conversationId".into()))?
        .to_string();
    let mut created_checkpoint = checkpoint_created_run(
        db,
        app,
        &created,
        &run_id,
        &conversation_id,
        UNIFIED_SKILL_ID,
        "0.1.0",
        Some(DSH_AGENT_RUNTIME),
        &normalized_prompt,
        &reference_ids,
        project_id.as_deref(),
        thread_id.as_deref(),
        creative_launch_id.as_deref(),
        creative_launch.as_ref(),
        30,
    )?;
    if created.get("agentRuntime").and_then(Value::as_str) != Some(DSH_AGENT_RUNTIME) {
        let cancel_response = agent_action(
            cloud,
            auth,
            json!({ "action": "cancel", "runId": &run_id }),
            "清理 runtime 不一致的统一 Agent Run 失败",
        )
        .await;
        checkpoint_transfer_failure(
            db,
            app,
            &mut created_checkpoint,
            cancel_response.as_ref().ok(),
        );
        return Err(AppError::Cloud(
            "统一 Agent Run 未锁定为 DSH runtime".into(),
        ));
    }
    let transfer_result: Result<(), AppError> = async {
        let request_url = created
            .get("uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Cloud("创建统一 Agent Run 未返回输入上传地址".into()))?;
        upload_signed(
            cloud,
            request_url,
            "application/json",
            manifest,
            "统一 Agent 输入",
        )
        .await?;
        let uploads = created
            .get("inputUploads")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::Cloud("创建统一 Agent Run 未返回参考图上传清单".into()))?;
        if uploads.len() != image_bytes.len() {
            return Err(AppError::Cloud(
                "统一 Agent 参考图上传清单数量不一致".into(),
            ));
        }
        for (index, bytes) in image_bytes.into_iter().enumerate() {
            let upload = uploads
                .iter()
                .find(|item| {
                    item.get("ordinal").and_then(Value::as_u64) == Some((index + 1) as u64)
                })
                .and_then(|item| item.get("uploadUrl"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Cloud(format!("第 {} 张统一 Agent 参考图缺少上传地址", index + 1))
                })?;
            upload_signed(
                cloud,
                upload,
                "image/jpeg",
                bytes,
                &format!("第 {} 张统一 Agent 参考图", index + 1),
            )
            .await?;
        }
        agent_action(
            cloud,
            auth,
            json!({ "action": "enqueue", "runId": run_id }),
            "统一 Agent Run 入队失败",
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = transfer_result {
        let cancel_response = agent_action(
            cloud,
            auth,
            json!({ "action": "cancel", "runId": run_id }),
            "清理未完成的统一 Agent Run 失败",
        )
        .await;
        checkpoint_transfer_failure(
            db,
            app,
            &mut created_checkpoint,
            cancel_response.as_ref().ok(),
        );
        return Err(error);
    }
    let now = chrono::Utc::now().timestamp();
    let mut fallback_snapshot = json!({
        "conversationId": conversation_id,
        "run": {
            "id": run_id,
            "conversation_id": conversation_id,
            "skill_id": UNIFIED_SKILL_ID,
            "skill_version": "0.1.0",
            "agent_runtime": DSH_AGENT_RUNTIME,
            "status": "queued",
            "progress": 0,
            "budget_credits": created.get("budgetCredits").cloned().unwrap_or(json!(30)),
            "visual_profile_id": visual_profile_capsule.as_ref().map(|capsule| &capsule.profile_id),
            "visual_profile_version": visual_profile_capsule.as_ref().map(|capsule| capsule.version),
            "visual_profile_hash": visual_profile_capsule.as_ref().map(|capsule| &capsule.hash),
        },
        "events": [], "approvals": [], "clarifications": [], "artifacts": [],
    });
    if let Some(launch) = creative_launch.as_ref() {
        set_project_agent_launch_snapshot(&mut fallback_snapshot, launch)?;
    }
    let mut record = CloudAgentRunRecord {
        run_id,
        conversation_id,
        skill_id: UNIFIED_SKILL_ID.into(),
        status: "queued".into(),
        intent_prompt: normalized_prompt,
        reference_asset_ids: reference_ids,
        project_id,
        thread_id,
        creative_launch_id,
        snapshot: fallback_snapshot,
        feedback_action: None,
        final_asset_id: None,
        created_at: now,
        updated_at: now,
    };
    record = save_and_project_record(db, &record)?;
    emit_creative_agent_changed(app, &record);
    if let Ok(refreshed) = refresh_record(db, cloud, auth, &record.run_id).await {
        record = refreshed;
        emit_creative_agent_changed(app, &record);
    }
    Ok(record)
}

#[tauri::command]
pub async fn cloud_agent_start(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
    intent_prompt: String,
    references: Vec<CloudAgentReferenceRequest>,
    ratio: Option<String>,
    project_id: Option<String>,
    image_provider: Option<String>,
    preference_capsule: Option<PreferenceCapsule>,
    visual_profile_id: Option<String>,
    skill_id: Option<String>,
    agent_runtime: Option<String>,
    html_options: Option<HtmlLayoutOptions>,
    thread_id: Option<String>,
    parent_node_id: Option<String>,
    parent_asset_id: Option<String>,
) -> Result<CloudAgentRunRecord, AppError> {
    if project_id.is_none() || thread_id.is_none() {
        return Err(AppError::Other(
            "新 Agent Run 必须归属于项目画板中的创作线程".into(),
        ));
    }
    if references.len() > MAX_REFERENCES {
        return Err(AppError::Other("Agent 最多处理 8 张参考图".into()));
    }
    if skill_id.as_deref() == Some(UNIFIED_SKILL_ID) {
        if agent_runtime.as_deref() != Some(DSH_AGENT_RUNTIME) {
            return Err(AppError::Other("统一 Agent 必须使用 DSH runtime".into()));
        }
        let options =
            html_options.ok_or_else(|| AppError::Other("统一 Agent HTML 输出参数缺失".into()))?;
        return start_unified_agent_run(
            &app,
            &db,
            &cloud,
            &auth,
            &entitlement,
            intent_prompt,
            references,
            ratio,
            project_id,
            visual_profile_id,
            options,
            thread_id,
            parent_node_id,
            parent_asset_id,
        )
        .await;
    }
    if skill_id.as_deref() == Some(HTML_SKILL_ID) {
        if agent_runtime.is_some() {
            return Err(AppError::Other("HTML 排版不支持 Agent Runtime 选择".into()));
        }
        let options = html_options.ok_or_else(|| AppError::Other("HTML 排版参数缺失".into()))?;
        return start_html_layout_run(
            &app,
            &db,
            &cloud,
            &auth,
            &entitlement,
            intent_prompt,
            references,
            project_id,
            options,
            thread_id,
            parent_node_id,
            parent_asset_id,
        )
        .await;
    }
    if skill_id.as_deref().is_some_and(|value| value != SKILL_ID) {
        return Err(AppError::Other("不支持的 Agent Skill".into()));
    }
    // 只阻止新建 Codex Agent Run；历史 Run 与已经停车的本机任务仍可查看/收尾。
    ensure_agent_provider_compatible(image_provider.as_deref())?;
    let entitlement_snapshot = entitlement.current_or_sync(&auth).await;
    let resolved_agent_runtime = resolve_agent_runtime(
        agent_runtime.as_deref(),
        entitlement_snapshot.is_test_account,
    )?;
    let policy = entitlement_snapshot.policy;
    if !policy.allows_agent_run(SKILL_ID) {
        return Err(AppError::Other("当前权益不支持 Bowerbird Agent".into()));
    }
    if image_provider.as_deref() == Some("jimeng") && !policy.can_use_byo {
        return Err(AppError::Other(
            "Agent 本机生图引擎需要 Pro 或 Studio 订阅".into(),
        ));
    }
    if visual_profile_id.is_some() && !policy.can_use_visual_profiles {
        return Err(AppError::Other("当前权益不支持项目视觉设定".into()));
    }
    // 新 Run 生图引擎：cloud = VPS 方舟 Seedream（默认）；jimeng = 桌面本地 CLI。
    // Codex Agent 暂停组合使用，但历史任务执行器仍保留 Codex 恢复能力。
    let image_provider = match image_provider.as_deref() {
        None | Some("cloud") => "cloud".to_string(),
        Some("jimeng") => {
            if crate::codex::jimeng::resolve_dreamina_binary().is_none() {
                return Err(AppError::Other(
                    "未找到可用的即梦 CLI，无法使用本机生图引擎".into(),
                ));
            }
            "jimeng".to_string()
        }
        Some(other) => {
            return Err(AppError::Other(format!("Agent 生图引擎无效：{other}")));
        }
    };
    let resolved_ratio = normalize_requested_ratio(ratio)?;
    if let Some(project) = project_id.as_deref() {
        if db.get_project(project)?.is_none() {
            return Err(AppError::Other("当前项目不存在".into()));
        }
    }
    if let Some(capsule) = preference_capsule.as_ref() {
        validate_preference_capsule(capsule, project_id.as_deref())?;
    }
    let visual_profile_capsule = match visual_profile_id.as_deref() {
        Some(profile_id) => {
            let project_id = project_id
                .as_deref()
                .ok_or_else(|| AppError::Other("视觉设定只能在当前项目内使用".into()))?;
            Some(db.visual_profile_capsule(profile_id, project_id)?)
        }
        None => None,
    };

    let normalized_prompt = normalize_intent_prompt(&intent_prompt, &references)?;
    let mut image_bytes = Vec::with_capacity(references.len());
    let mut reference_ids = Vec::with_capacity(references.len());
    let mut reference_ratios = Vec::with_capacity(references.len());
    for reference in &references {
        let asset = db
            .get_asset(&reference.asset_id)?
            .ok_or_else(|| AppError::Other("参考图不在素材库中，请先入库再启动 Agent".into()))?;
        let path = asset
            .store_path
            .as_deref()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .ok_or_else(|| AppError::Other(format!("参考图 {} 的本地文件不存在", asset.name)))?;
        reference_ratios.push(
            asset
                .width
                .zip(asset.height)
                .and_then(|(width, height)| nearest_ratio(width, height)),
        );
        image_bytes.push(crate::codex::cloud_image::read_agent_reference_jpeg(&path).await?);
        reference_ids.push(reference.asset_id.clone());
    }

    let ids: Vec<String> = (1..=image_bytes.len())
        .map(|index| format!("ref-{index}"))
        .collect();
    let tokens: Vec<String> = (1..=image_bytes.len())
        .map(|index| format!("@图{index}"))
        .collect();
    let manifest_references: Vec<ControlledReference<'_>> = image_bytes
        .iter()
        .enumerate()
        .map(|(index, bytes)| ControlledReference {
            reference_id: &ids[index],
            token: &tokens[index],
            ordinal: index + 1,
            mime: "image/jpeg",
            bytes: bytes.len(),
            sha256: sha256_hex(bytes),
            aspect_ratio: reference_ratios[index].as_deref(),
        })
        .collect();
    let manifest = serde_json::to_vec(&ControlledManifest {
        schema_version: 1,
        intent_prompt: &normalized_prompt,
        references: &manifest_references,
        ratio: resolved_ratio.as_deref(),
        preference_capsule: preference_capsule.as_ref(),
        visual_profile_capsule: visual_profile_capsule.as_ref(),
    })?;
    if manifest.len() > 64 * 1024 {
        return Err(AppError::Other("Agent 输入清单过大".into()));
    }

    let creative_launch = begin_creative_launch(
        &db,
        project_id.as_deref(),
        thread_id.as_deref(),
        &normalized_prompt,
        &image_provider,
        resolved_ratio.as_deref(),
        visual_profile_capsule.as_ref(),
        &reference_ids,
        parent_node_id.as_deref(),
        parent_asset_id.as_deref(),
    )?;
    let creative_launch_id = creative_launch
        .as_ref()
        .map(|launch| launch.launch_id.clone());

    let mut create_body = json!({
        "action": "create",
        "skillId": SKILL_ID,
        "goal": normalized_prompt,
        "inputCount": image_bytes.len(),
        "inputManifestHash": sha256_hex(&manifest),
        "idempotencyKey": creative_launch_id
            .as_ref()
            .map(|launch_id| format!("desktop-agent-{launch_id}"))
            .unwrap_or_else(|| format!("desktop-agent-{}", Ulid::new())),
        "imageProvider": image_provider,
        "agentRuntime": resolved_agent_runtime,
    });
    if let Some(capsule) = visual_profile_capsule.as_ref() {
        create_body["visualProfile"] = json!({
            "profileId": &capsule.profile_id,
            "version": capsule.version,
            "hash": &capsule.hash,
        });
    }
    // None 必须省略而不是序列化为 null；控制面契约只接受缺省或合法比例字符串。
    if let Some(value) = resolved_ratio.as_deref() {
        create_body["ratio"] = json!(value);
    }
    let created = match agent_action(&cloud, &auth, create_body, "创建 Agent Run 失败").await {
        Ok(created) => created,
        Err(error) => {
            if let (Some(session_id), Some(launch_id)) =
                (thread_id.as_deref(), creative_launch_id.as_deref())
            {
                let _ = db.update_project_agent_launch_status(session_id, launch_id, "failed");
                let _ = app.emit(
                    "creative://changed",
                    json!({ "threadId": session_id, "status": "failed" }),
                );
            }
            return Err(error);
        }
    };
    let run_id = created
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Cloud("创建 Agent Run 未返回 runId".into()))?
        .to_string();
    let conversation_id = created
        .get("conversationId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Cloud("创建 Agent Run 未返回 conversationId".into()))?
        .to_string();
    let mut created_checkpoint = checkpoint_created_run(
        &db,
        &app,
        &created,
        &run_id,
        &conversation_id,
        SKILL_ID,
        "0.1.2",
        Some(resolved_agent_runtime),
        &normalized_prompt,
        &reference_ids,
        project_id.as_deref(),
        thread_id.as_deref(),
        creative_launch_id.as_deref(),
        creative_launch.as_ref(),
        48,
    )?;
    let returned_agent_runtime = created.get("agentRuntime").and_then(Value::as_str);
    if returned_agent_runtime != Some(resolved_agent_runtime) {
        let cancel_response = agent_action(
            &cloud,
            &auth,
            json!({ "action": "cancel", "runId": &run_id }),
            "清理 runtime 不一致的 Agent Run 失败",
        )
        .await;
        checkpoint_transfer_failure(
            &db,
            &app,
            &mut created_checkpoint,
            cancel_response.as_ref().ok(),
        );
        let message = if returned_agent_runtime.is_some() {
            "服务端锁定的 Agent Runtime 与请求不一致"
        } else {
            "创建 Agent Run 未返回已锁定的 runtime"
        };
        return Err(AppError::Cloud(message.into()));
    }
    let transfer_result: Result<(), AppError> = async {
        let request_url = created
            .get("uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Cloud("创建 Agent Run 未返回输入上传地址".into()))?;
        upload_signed(
            &cloud,
            request_url,
            "application/json",
            manifest,
            "Agent 输入",
        )
        .await?;

        let uploads = created
            .get("inputUploads")
            .and_then(Value::as_array)
            .ok_or_else(|| AppError::Cloud("创建 Agent Run 未返回参考图上传清单".into()))?;
        if uploads.len() != image_bytes.len() {
            return Err(AppError::Cloud("Agent 参考图上传清单数量不一致".into()));
        }
        for (index, bytes) in image_bytes.into_iter().enumerate() {
            let upload = uploads
                .iter()
                .find(|item| {
                    item.get("ordinal").and_then(Value::as_u64) == Some((index + 1) as u64)
                })
                .and_then(|item| item.get("uploadUrl"))
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Cloud(format!("第 {} 张参考图缺少上传地址", index + 1)))?;
            upload_signed(
                &cloud,
                upload,
                "image/jpeg",
                bytes,
                &format!("第 {} 张参考图", index + 1),
            )
            .await?;
        }
        agent_action(
            &cloud,
            &auth,
            json!({ "action": "enqueue", "runId": run_id }),
            "Agent Run 入队失败",
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = transfer_result {
        // The Run already holds credits. Best-effort atomic cancellation avoids
        // leaving a failed local upload with a frozen hold.
        let cancel_response = agent_action(
            &cloud,
            &auth,
            json!({ "action": "cancel", "runId": run_id }),
            "清理未完成的 Agent Run 失败",
        )
        .await;
        checkpoint_transfer_failure(
            &db,
            &app,
            &mut created_checkpoint,
            cancel_response.as_ref().ok(),
        );
        return Err(error);
    }

    let now = chrono::Utc::now().timestamp();
    // 入队成功即先落本地记录。即使随后首次 get 短暂失败，重启后仍能恢复并继续轮询，
    // 不会把云端已创建、已冻结积分的 Run 变成桌面端不可见的孤儿任务。
    let mut fallback_snapshot = json!({
        "conversationId": conversation_id,
        "run": {
            "id": run_id,
            "conversation_id": conversation_id,
            "skill_id": SKILL_ID,
            "skill_version": "0.1.2",
            "agent_runtime": resolved_agent_runtime,
            "status": "queued",
            "progress": 0,
            "budget_credits": created.get("budgetCredits").cloned().unwrap_or(json!(48)),
            "visual_profile_id": visual_profile_capsule.as_ref().map(|capsule| &capsule.profile_id),
            "visual_profile_version": visual_profile_capsule.as_ref().map(|capsule| capsule.version),
            "visual_profile_hash": visual_profile_capsule.as_ref().map(|capsule| &capsule.hash),
        },
        "events": [],
        "approvals": [],
        "clarifications": [],
        "artifacts": [],
    });
    if let Some(launch) = creative_launch.as_ref() {
        set_project_agent_launch_snapshot(&mut fallback_snapshot, launch)?;
    }
    let mut record = CloudAgentRunRecord {
        run_id,
        conversation_id,
        skill_id: SKILL_ID.into(),
        status: "queued".into(),
        intent_prompt: normalized_prompt,
        reference_asset_ids: reference_ids,
        project_id,
        thread_id,
        creative_launch_id,
        snapshot: fallback_snapshot,
        feedback_action: None,
        final_asset_id: None,
        created_at: now,
        updated_at: now,
    };
    record = save_and_project_record(&db, &record)?;
    emit_creative_agent_changed(&app, &record);
    if let Ok(refreshed) = refresh_record(&db, &cloud, &auth, &record.run_id).await {
        record = refreshed;
        emit_creative_agent_changed(&app, &record);
    }
    Ok(record)
}

#[tauri::command]
pub async fn cloud_agent_latest(
    db: State<'_, Arc<Database>>,
) -> Result<Option<CloudAgentRunRecord>, AppError> {
    let mut records = list_records(&db, 1)?;
    recover_agent_projections(&db, &mut records);
    Ok(records.into_iter().next())
}

#[tauri::command]
pub async fn cloud_agent_list(
    db: State<'_, Arc<Database>>,
) -> Result<Vec<CloudAgentRunRecord>, AppError> {
    let mut records = list_records(&db, 100)?;
    recover_agent_projections(&db, &mut records);
    Ok(records)
}

#[tauri::command]
pub async fn cloud_agent_get(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
) -> Result<CloudAgentRunRecord, AppError> {
    let record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    emit_creative_agent_changed(&app, &record);
    Ok(record)
}

#[tauri::command]
pub async fn cloud_agent_decide_approval(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
    approval_id: String,
    approve: bool,
) -> Result<CloudAgentRunRecord, AppError> {
    agent_action(
        &cloud,
        &auth,
        json!({ "action": if approve { "approve" } else { "reject" }, "approvalId": approval_id }),
        if approve {
            "批准 Agent 计划失败"
        } else {
            "拒绝 Agent 计划失败"
        },
    )
    .await?;
    let record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    emit_creative_agent_changed(&app, &record);
    Ok(record)
}

#[tauri::command]
pub async fn cloud_agent_answer_clarification(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
    clarification_id: String,
    context_hash: String,
    answer: String,
) -> Result<CloudAgentRunRecord, AppError> {
    let answer = answer.trim().to_string();
    if answer.is_empty() || answer.chars().count() > 240 {
        return Err(AppError::Other("Agent 澄清答案无效".into()));
    }
    agent_action(
        &cloud,
        &auth,
        json!({
            "action": "answer_clarification",
            "clarificationId": clarification_id,
            "contextHash": context_hash,
            "answer": answer,
        }),
        "提交 Agent 澄清答案失败",
    )
    .await?;
    let record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    emit_creative_agent_changed(&app, &record);
    Ok(record)
}

#[tauri::command]
pub async fn cloud_agent_cancel(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
) -> Result<CloudAgentRunRecord, AppError> {
    agent_action(
        &cloud,
        &auth,
        json!({ "action": "cancel", "runId": run_id }),
        "取消 Agent Run 失败",
    )
    .await?;
    let record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    emit_creative_agent_changed(&app, &record);
    Ok(record)
}

#[tauri::command]
pub async fn cloud_agent_feedback(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
    feedback_action: String,
    text: Option<String>,
) -> Result<CloudAgentRunRecord, AppError> {
    if !matches!(feedback_action.as_str(), "accept" | "retry") {
        return Err(AppError::Other("Agent 反馈动作无效".into()));
    }
    let text = text.unwrap_or_default().trim().to_string();
    if text.chars().count() > MAX_FEEDBACK_CHARS {
        return Err(AppError::Other("Agent 反馈最多 2000 个字符".into()));
    }
    agent_action(
        &cloud,
        &auth,
        json!({ "action": "result_feedback", "runId": run_id, "feedbackAction": feedback_action, "text": text }),
        "提交 Agent 结果反馈失败",
    )
    .await?;
    let record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    let record = save_feedback_action_and_project(&db, &record, &feedback_action)?;
    emit_creative_agent_changed(&app, &record);
    Ok(record)
}

fn artifact_meta<'a>(snapshot: &'a Value, artifact_id: &str) -> Result<&'a Value, AppError> {
    snapshot
        .get("artifacts")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(artifact_id))
        })
        .filter(|item| {
            matches!(
                item.get("role").and_then(Value::as_str),
                Some(
                    "control_reference"
                        | "stage_result"
                        | "final_result"
                        | "viewport_screenshot"
                        | "full_page_screenshot"
                        | "slice_screenshot"
                )
            ) && item.get("user_visible").and_then(Value::as_bool) != Some(false)
                && item
                    .get("mime")
                    .and_then(Value::as_str)
                    .is_some_and(|mime| mime.starts_with("image/"))
        })
        .ok_or_else(|| AppError::Cloud("图片产物不存在、不可见或已被替换".into()))
}

fn render_output_meta(
    snapshot: &Value,
    artifact_id: &str,
) -> Option<(String, Option<u32>, u32, u32)> {
    let output = snapshot
        .pointer("/renderManifest/outputs")?
        .as_array()?
        .iter()
        .find(|item| item.get("artifactId").and_then(Value::as_str) == Some(artifact_id))?;
    let role = output.get("role")?.as_str()?.to_string();
    let clip = output.get("clipDevicePx")?;
    let width = u32::try_from(clip.get("width")?.as_u64()?).ok()?;
    let height = u32::try_from(clip.get("height")?.as_u64()?).ok()?;
    let index = output
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok());
    Some((role, index, width, height))
}

fn validate_artifact_image(
    mime: &str,
    bytes: &[u8],
    expected_dimensions: Option<(u32, u32)>,
) -> bool {
    if !artifact_magic_matches(mime, bytes) {
        return false;
    }
    match expected_dimensions {
        Some(expected) => image::load_from_memory(bytes)
            .map(|image| (image.width(), image.height()) == expected)
            .unwrap_or(false),
        None => true,
    }
}

async fn download_artifact(
    paths: &LibraryPaths,
    cloud: &CloudClient,
    auth: &AuthClient,
    record: &CloudAgentRunRecord,
    artifact_id: &str,
) -> Result<CloudAgentPreview, AppError> {
    if artifact_id.is_empty()
        || artifact_id.len() > 80
        || !artifact_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(AppError::Cloud("Agent 图片产物 id 无效".into()));
    }
    let artifact = artifact_meta(&record.snapshot, artifact_id)?;
    let mime = artifact.get("mime").and_then(Value::as_str).unwrap_or("");
    let extension = match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        _ => return Err(AppError::Cloud("Agent 图片产物格式无效".into())),
    };
    let expected_bytes = artifact.get("bytes").and_then(Value::as_u64).unwrap_or(0);
    let expected_hash = artifact.get("sha256").and_then(Value::as_str).unwrap_or("");
    let role = artifact
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("stage_result")
        .to_string();
    let render_meta = render_output_meta(&record.snapshot, artifact_id);
    if record.skill_id == HTML_SKILL_ID && render_meta.is_none() {
        return Err(AppError::Cloud("HTML 截图缺少可验证的渲染清单".into()));
    }
    let expected_dimensions = render_meta
        .as_ref()
        .map(|(_, _, width, height)| (*width, *height));
    if expected_bytes == 0 || expected_bytes > MAX_ARTIFACT_BYTES || expected_hash.len() != 64 {
        return Err(AppError::Cloud("Agent 图片产物校验信息无效".into()));
    }
    let dir = paths.root.join("agent-runs").join(&record.conversation_id);
    let path = dir.join(format!("{artifact_id}.{extension}"));
    if let Ok(cached) = tokio::fs::read(&path).await {
        if cached.len() as u64 == expected_bytes
            && sha256_hex(&cached).eq_ignore_ascii_case(expected_hash)
            && validate_artifact_image(mime, &cached, expected_dimensions)
        {
            return Ok(CloudAgentPreview {
                run_id: record.run_id.clone(),
                artifact_id: artifact_id.to_string(),
                path: path.to_string_lossy().into_owned(),
                mime: mime.into(),
                sha256: expected_hash.into(),
                role: render_meta
                    .as_ref()
                    .map(|value| value.0.clone())
                    .unwrap_or_else(|| role.clone()),
                index: render_meta.as_ref().and_then(|value| value.1),
                width: render_meta.as_ref().map(|value| value.2),
                height: render_meta.as_ref().map(|value| value.3),
            });
        }
    }
    let signed = agent_action(
        cloud,
        auth,
        json!({ "action": "artifact_url", "artifactId": artifact_id }),
        "签发 Agent 图片下载地址失败",
    )
    .await?;
    let url = signed.get("url").and_then(Value::as_str).unwrap_or("");
    if !valid_https_url(url) {
        return Err(AppError::Cloud("Agent 图片下载地址不安全".into()));
    }
    let response = cloud
        .http()
        .get(url)
        .send()
        .await
        .map_err(|error| AppError::Cloud(format!("下载 Agent 图片失败: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Cloud(format!(
            "下载 Agent 图片失败（HTTP {}）",
            response.status().as_u16()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::Cloud(format!("读取 Agent 图片失败: {error}")))?;
    if bytes.len() as u64 != expected_bytes
        || !sha256_hex(&bytes).eq_ignore_ascii_case(expected_hash)
    {
        return Err(AppError::Cloud("Agent 图片完整性校验失败".into()));
    }
    if !validate_artifact_image(mime, &bytes, expected_dimensions) {
        return Err(AppError::Cloud("Agent 图片实际格式不匹配".into()));
    }
    tokio::fs::create_dir_all(&dir).await?;
    tokio::fs::write(&path, &bytes).await?;
    Ok(CloudAgentPreview {
        run_id: record.run_id.clone(),
        artifact_id: artifact_id.to_string(),
        path: path.to_string_lossy().into_owned(),
        mime: mime.into(),
        sha256: expected_hash.into(),
        role: render_meta
            .as_ref()
            .map(|value| value.0.clone())
            .unwrap_or(role),
        index: render_meta.as_ref().and_then(|value| value.1),
        width: render_meta.as_ref().map(|value| value.2),
        height: render_meta.as_ref().map(|value| value.3),
    })
}

#[tauri::command]
pub async fn cloud_agent_preview_final(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
    artifact_id: String,
) -> Result<CloudAgentPreview, AppError> {
    let record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    download_artifact(&paths, &cloud, &auth, &record, &artifact_id).await
}

#[tauri::command]
pub async fn cloud_agent_preview_artifact(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
    artifact_id: String,
) -> Result<CloudAgentPreview, AppError> {
    let record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    download_artifact(&paths, &cloud, &auth, &record, &artifact_id).await
}

#[tauri::command]
pub async fn cloud_agent_ingest_final(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
    artifact_id: String,
) -> Result<Asset, AppError> {
    let mut record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    if record.status != "succeeded" || record.feedback_action.as_deref() != Some("accept") {
        return Err(AppError::Other(
            "只有已接受且完成结算的 Agent 最终图可以入库".into(),
        ));
    }
    if let Some(asset_id) = record.final_asset_id.as_deref() {
        let asset = db
            .get_asset(asset_id)?
            .ok_or_else(|| AppError::Other("Agent 最终资产记录已失效".into()))?;
        project_agent_record(&db, &record)?;
        agent_action(
            &cloud,
            &auth,
            json!({ "action": "artifact_received", "artifactId": artifact_id }),
            "确认 Agent 最终图接收失败",
        )
        .await?;
        return Ok(asset);
    }
    let preview = download_artifact(&paths, &cloud, &auth, &record, &artifact_id).await?;
    let source = PathBuf::from(&preview.path);
    let db_for_ingest = db.inner().clone();
    let paths_for_ingest = paths.inner().clone();
    let conversation = record.conversation_id.clone();
    let asset = tokio::task::spawn_blocking(move || {
        crate::core::ingest::ingest_generated(
            &paths_for_ingest,
            &db_for_ingest,
            &source,
            Some(&conversation),
            "bowerbird-agent",
        )
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    if let Some(project_id) = record.project_id.as_deref() {
        db.add_assets_to_project(project_id, std::slice::from_ref(&asset.id))?;
    }
    record = save_final_asset_and_project(&db, &record, &asset.id)?;
    if record.thread_id.is_some() {
        project_agent_artifact_and_map(
            &db,
            &record.run_id,
            &artifact_id,
            &preview.role,
            0,
            &asset,
        )?;
        emit_creative_agent_changed(&app, &record);
    }
    agent_action(
        &cloud,
        &auth,
        json!({ "action": "artifact_received", "artifactId": artifact_id }),
        "确认 Agent 最终图接收失败",
    )
    .await?;
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

fn existing_agent_asset(
    db: &Database,
    source: &std::path::Path,
) -> Result<Option<Asset>, AppError> {
    let origin = source.to_string_lossy().into_owned();
    let id = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM assets WHERE source='bowerbird-agent' AND origin_path=?1 ORDER BY created_at DESC LIMIT 1",
            [&origin],
            |row| row.get::<_, String>(0),
        ).optional()?
    };
    id.map(|asset_id| db.get_asset(&asset_id))
        .transpose()
        .map(|value| value.flatten())
        .map_err(AppError::from)
}

fn ingestible_artifacts(record: &CloudAgentRunRecord) -> Vec<(String, String)> {
    let artifacts = record
        .snapshot
        .get("artifacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    let has_render_manifest = record
        .snapshot
        .pointer("/renderManifest/outputs")
        .and_then(Value::as_array)
        .is_some();
    if record.skill_id != HTML_SKILL_ID && !has_render_manifest {
        return artifacts
            .filter_map(|item| {
                let id = item.get("id")?.as_str()?;
                let role = item.get("role")?.as_str()?;
                (matches!(role, "control_reference" | "stage_result" | "final_result")
                    && item.get("user_visible").and_then(Value::as_bool) != Some(false)
                    && item
                        .get("mime")
                        .and_then(Value::as_str)
                        .is_some_and(|mime| mime.starts_with("image/")))
                .then(|| (id.to_string(), role.to_string()))
            })
            .collect();
    }
    let visible = artifacts
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?;
            let role = item.get("role")?.as_str()?;
            (item.get("user_visible").and_then(Value::as_bool) != Some(false)
                && item
                    .get("mime")
                    .and_then(Value::as_str)
                    .is_some_and(|mime| mime.starts_with("image/")))
            .then(|| (id.to_string(), role.to_string()))
        })
        .collect::<std::collections::HashMap<_, _>>();
    record
        .snapshot
        .pointer("/renderManifest/outputs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|output| {
            let id = output.get("artifactId")?.as_str()?;
            let role = output.get("role")?.as_str()?;
            visible
                .get(id)
                .filter(|visible_role| visible_role.as_str() == role)
                .map(|_| (id.to_string(), role.to_string()))
        })
        .collect()
}

fn primary_ingestible_artifact(record: &CloudAgentRunRecord) -> Option<(usize, String, String)> {
    let generated = ingestible_artifacts(record);
    let preferred_index = if record.skill_id == HTML_SKILL_ID
        || record
            .snapshot
            .pointer("/renderManifest/outputs")
            .and_then(Value::as_array)
            .is_some()
    {
        generated
            .iter()
            .position(|(_, role)| role == "full_page_screenshot")
            .or_else(|| {
                generated
                    .iter()
                    .position(|(_, role)| role == "viewport_screenshot")
            })
            .or((!generated.is_empty()).then_some(0))
    } else {
        generated
            .iter()
            .position(|(_, role)| role == "final_result")
    }?;
    let (artifact_id, role) = generated.get(preferred_index)?.clone();
    Some((preferred_index, artifact_id, role))
}

fn accepted_ingest_result(record: &CloudAgentRunRecord) -> bool {
    let feedback_action = record.feedback_action.as_deref().or_else(|| {
        record
            .snapshot
            .pointer("/run/result_feedback_action")
            .and_then(Value::as_str)
    });
    record.status == "succeeded" && feedback_action == Some("accept")
}

fn ingest_artifact_fingerprint(record: &CloudAgentRunRecord) -> Option<String> {
    let artifacts = record.snapshot.get("artifacts")?.as_array()?;
    let mut identities = Vec::new();
    for (artifact_id, _) in ingestible_artifacts(record) {
        let artifact = artifacts
            .iter()
            .find(|artifact| artifact.get("id").and_then(Value::as_str) == Some(&artifact_id))?;
        let sha256 = artifact
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())?;
        identities.push(format!("{artifact_id}:{sha256}"));
    }
    if identities.is_empty() {
        return None;
    }
    identities.sort();
    identities.dedup();
    Some(sha256_hex(
        format!("{}:{}", record.run_id, identities.join("|")).as_bytes(),
    ))
}

fn ingest_artifact_receipts_complete(record: &CloudAgentRunRecord) -> bool {
    let generated = ingestible_artifacts(record);
    let Some(artifacts) = record.snapshot.get("artifacts").and_then(Value::as_array) else {
        return false;
    };
    !generated.is_empty()
        && generated.iter().all(|(artifact_id, _)| {
            artifacts.iter().any(|artifact| {
                artifact.get("id").and_then(Value::as_str) == Some(artifact_id.as_str())
                    && artifact
                        .get("downloaded_at")
                        .is_some_and(|value| !value.is_null())
            })
        })
}

fn ingest_checkpoint_matches(record: &CloudAgentRunRecord, checkpoint: &Value) -> bool {
    accepted_ingest_result(record)
        && record.final_asset_id.is_some()
        && ingest_artifact_receipts_complete(record)
        && checkpoint.get("schemaVersion").and_then(Value::as_u64) == Some(1)
        && checkpoint
            .get("completedAt")
            .and_then(Value::as_i64)
            .is_some()
        && checkpoint.get("fingerprint").and_then(Value::as_str)
            == ingest_artifact_fingerprint(record).as_deref()
}

fn mapped_ingest_artifacts_complete(
    conn: &rusqlite::Connection,
    record: &CloudAgentRunRecord,
) -> Result<bool, AppError> {
    let (Some(project_id), Some(thread_id)) =
        (record.project_id.as_deref(), record.thread_id.as_deref())
    else {
        return Ok(false);
    };
    for (artifact_id, _) in ingestible_artifacts(record) {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(\
               SELECT 1 FROM cloud_agent_artifact_assets mapping \
               JOIN assets asset ON asset.id=mapping.asset_id \
               JOIN canvas_nodes node ON node.id=mapping.node_id \
               JOIN project_assets member ON member.asset_id=mapping.asset_id AND member.project_id=?3 \
               WHERE mapping.run_id=?1 AND mapping.artifact_id=?2 \
                 AND node.project_id=?3 AND node.thread_id=?4\
             )",
            rusqlite::params![record.run_id, artifact_id, project_id, thread_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Persist the run-level completion checkpoint only after the whole accepted artifact
/// group has a local asset, project membership, canvas projection, and durable cloud ack.
/// The check and marker write share one immediate transaction with project deletion.
fn checkpoint_completed_ingest_if_ready(
    db: &Database,
    candidate: &CloudAgentRunRecord,
) -> Result<CloudAgentRunRecord, AppError> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut persisted = query_stored_record(&tx, &candidate.run_id)?.record;
    ensure_same_record_identity(&persisted, candidate)?;
    if persisted
        .snapshot
        .get(PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
        .is_some_and(|checkpoint| ingest_checkpoint_matches(&persisted, checkpoint))
    {
        tx.commit()?;
        return Ok(persisted);
    }
    let Some(fingerprint) = ingest_artifact_fingerprint(&persisted) else {
        tx.commit()?;
        return Ok(persisted);
    };
    if !accepted_ingest_result(&persisted)
        || persisted.final_asset_id.is_none()
        || !ingest_artifact_receipts_complete(&persisted)
        || !mapped_ingest_artifacts_complete(&tx, &persisted)?
    {
        tx.commit()?;
        return Ok(persisted);
    }
    let completed_at = chrono::Utc::now().timestamp();
    let object = persisted
        .snapshot
        .as_object_mut()
        .ok_or_else(|| AppError::Other("Agent snapshot must be a JSON object".into()))?;
    object.insert(
        PROJECT_AGENT_INGEST_SNAPSHOT_KEY.into(),
        json!({
            "schemaVersion": 1,
            "fingerprint": fingerprint,
            "completedAt": completed_at,
        }),
    );
    persisted.updated_at = persisted.updated_at.max(completed_at);
    write_record(&tx, &persisted)?;
    persisted = query_stored_record(&tx, &candidate.run_id)?.record;
    tx.commit()?;
    Ok(persisted)
}

#[tauri::command]
pub async fn cloud_agent_ingest_artifacts(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
) -> Result<Vec<Asset>, AppError> {
    let mut record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    if record.status != "succeeded" || record.feedback_action.as_deref() != Some("accept") {
        return Err(AppError::Other(
            "只有已接受且完成结算的 Agent 会话可以入库".into(),
        ));
    }
    let generated = ingestible_artifacts(&record);
    if generated.is_empty() {
        return Err(AppError::Other("Agent 会话没有可入库的图片产物".into()));
    }

    let primary_artifact_id =
        primary_ingestible_artifact(&record).map(|(_, artifact_id, _)| artifact_id);
    let mut assets = Vec::with_capacity(generated.len());
    for (ordinal, (artifact_id, role)) in generated.into_iter().enumerate() {
        let preview = download_artifact(&paths, &cloud, &auth, &record, &artifact_id).await?;
        let source = PathBuf::from(&preview.path);
        let asset = if let Some(existing) = existing_agent_asset(&db, &source)? {
            existing
        } else {
            let db_for_ingest = db.inner().clone();
            let paths_for_ingest = paths.inner().clone();
            let conversation = record.conversation_id.clone();
            let source_for_ingest = source.clone();
            tokio::task::spawn_blocking(move || {
                crate::core::ingest::ingest_generated(
                    &paths_for_ingest,
                    &db_for_ingest,
                    &source_for_ingest,
                    Some(&conversation),
                    "bowerbird-agent",
                )
            })
            .await
            .map_err(|error| AppError::Other(error.to_string()))??
        };
        if let Some(project_id) = record.project_id.as_deref() {
            db.add_assets_to_project(project_id, std::slice::from_ref(&asset.id))?;
        }
        if primary_artifact_id.as_deref() == Some(artifact_id.as_str()) {
            record = save_final_asset_and_project(&db, &record, &asset.id)?;
        }
        if record.thread_id.is_some() {
            project_agent_artifact_and_map(
                &db,
                &record.run_id,
                &artifact_id,
                &role,
                ordinal as i64,
                &asset,
            )?;
        }
        agent_action(
            &cloud,
            &auth,
            json!({ "action": "artifact_received", "artifactId": artifact_id }),
            "确认 Agent 图片接收失败",
        )
        .await?;
        assets.push(asset);
    }
    db.record_generation_conversation(&record.conversation_id, &record.conversation_id)?;
    record = refresh_record(&db, &cloud, &auth, &record.run_id).await?;
    if !record
        .snapshot
        .get(PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
        .is_some_and(|checkpoint| ingest_checkpoint_matches(&record, checkpoint))
    {
        return Err(AppError::Other(
            "Agent 产物已写入，但整组持久化确认尚未完成".into(),
        ));
    }
    let _ = app.emit("library://assets-changed", ());
    emit_creative_agent_changed(&app, &record);
    Ok(assets)
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn local_generation_instruction(provider: &str, prompt: &str, ratio: Option<&str>) -> String {
    if provider != "codex" {
        return prompt.to_string();
    }
    let ratio_line = ratio
        .map(|value| format!("输出画幅比例必须为 {value}。\n"))
        .unwrap_or_default();
    format!(
        "$imagegen\n请使用图像生成能力严格执行下面的已批准图像编辑步骤。只生成并返回一张图片。\n\
         参考图片按本次命令的附图顺序对应步骤输入；不要带入指令未要求的参考图内容。\n\
         {ratio_line}\n已批准的步骤指令：\n{prompt}"
    )
}

fn local_task_error_code(provider: &str, error: &AppError) -> String {
    // 服务端 safe_error_code 仅接受 [A-Za-z0-9._:-]{1,80}；中文错误归入固定码。
    let prefix = if provider == "codex" {
        "codex"
    } else {
        "dreamina"
    };
    let suffix = match error {
        AppError::Other(message) if message.contains("超时") => "timeout",
        _ => "failed",
    };
    format!("{prefix}_local_{suffix}")
}

fn local_result_cache_path(paths: &LibraryPaths, call_id: &str, mime: &str) -> Option<PathBuf> {
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return None,
    };
    Some(
        paths
            .root
            .join("agent-local-results")
            .join(format!("{call_id}.{extension}")),
    )
}

async fn load_cached_local_result(
    paths: &LibraryPaths,
    call_id: &str,
) -> Result<Option<(Vec<u8>, String)>, AppError> {
    for mime in ["image/png", "image/jpeg", "image/webp"] {
        let Some(path) = local_result_cache_path(paths, call_id, mime) else {
            continue;
        };
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(AppError::Other(format!(
                    "读取本机 Agent 结果缓存失败: {error}"
                )))
            }
        };
        if bytes.len() as u64 <= MAX_ARTIFACT_BYTES && detect_image_mime(&bytes) == Some(mime) {
            return Ok(Some((bytes, mime.to_string())));
        }
        let _ = tokio::fs::remove_file(path).await;
    }
    Ok(None)
}

async fn cache_local_result(
    paths: &LibraryPaths,
    call_id: &str,
    bytes: &[u8],
    mime: &str,
) -> Result<(), AppError> {
    let path = local_result_cache_path(paths, call_id, mime)
        .ok_or_else(|| AppError::Other("本机 Agent 结果格式无效".into()))?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Other("本机 Agent 结果缓存路径无效".into()))?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| AppError::Other(format!("创建本机 Agent 结果缓存失败: {error}")))?;
    tokio::fs::write(path, bytes)
        .await
        .map_err(|error| AppError::Other(format!("写入本机 Agent 结果缓存失败: {error}")))
}

async fn remove_cached_local_result(paths: &LibraryPaths, call_id: &str) {
    for mime in ["image/png", "image/jpeg", "image/webp"] {
        if let Some(path) = local_result_cache_path(paths, call_id, mime) {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

/// 本地 CLI Run 的执行步骤：云端停车 awaiting_local_task 后，由前端轮询发现
/// pendingLocalTask 并调用本命令。解析输入（参考图直接取本地库、上一步产物经签名
/// 下载）、运行任务指定的即梦 / Codex provider、把结果直传确定性 artifact key 并回报，
/// 云端校验后 Run 重新入队。失败时尽力回报 local_task_fail 让云端原子结算。
#[tauri::command]
pub async fn cloud_agent_execute_local_task(
    db: State<'_, Arc<Database>>,
    settings: State<'_, crate::core::settings::SettingsState>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
) -> Result<CloudAgentRunRecord, AppError> {
    let record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    if record.status != "awaiting_local_task" {
        return Ok(record);
    }
    let Some(task) = record.snapshot.get("pendingLocalTask") else {
        return Ok(record);
    };
    let call_id = task
        .get("callId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Cloud("本地任务缺少 callId".into()))?
        .to_string();
    let provider_key = task
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "jimeng" | "codex"))
        .ok_or_else(|| AppError::Cloud("本地任务 provider 无效".into()))?
        .to_string();
    let prompt = task
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let ratio = task
        .get("ratio")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if prompt.trim().is_empty() {
        return Err(AppError::Cloud("本地任务缺少生图指令".into()));
    }
    if let Some(expires_at) = task.get("expiresAt").and_then(Value::as_str) {
        if let Ok(deadline) = chrono::DateTime::parse_from_rfc3339(expires_at) {
            if chrono::Utc::now() > deadline {
                remove_cached_local_result(&paths, &call_id).await;
                return Err(AppError::Cloud("本地生图任务已超时".into()));
            }
        }
    }

    // 输入解析：role=input 直接取本地参考图（桌面本就有原图，无需回云下载）；
    // 其余为上一步生成产物，走既有可见产物签名下载（本地缓存命中免下载）。
    let mut reference_images: Vec<PathBuf> = Vec::new();
    let inputs = task
        .get("inputs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for input in &inputs {
        let role = input.get("role").and_then(Value::as_str).unwrap_or("input");
        let path = if role == "input" {
            let reference_id = input
                .get("stepId")
                .and_then(Value::as_str)
                .and_then(|step| step.strip_prefix("ref-"))
                .and_then(|ordinal| ordinal.parse::<usize>().ok())
                .filter(|ordinal| *ordinal >= 1);
            let asset_id = reference_id
                .and_then(|ordinal| record.reference_asset_ids.get(ordinal - 1))
                .ok_or_else(|| AppError::Cloud("本地任务参考图序号无效".into()))?;
            let asset = db
                .get_asset(asset_id)?
                .ok_or_else(|| AppError::Other("参考图不在素材库中".into()))?;
            asset
                .store_path
                .map(PathBuf::from)
                .filter(|path| path.is_file())
                .ok_or_else(|| AppError::Other(format!("参考图 {} 的本地文件不存在", asset.name)))?
        } else {
            let artifact_id = input
                .get("artifactId")
                .and_then(Value::as_str)
                .ok_or_else(|| AppError::Cloud("本地任务输入缺少产物 id".into()))?;
            PathBuf::from(
                download_artifact(&paths, &cloud, &auth, &record, artifact_id)
                    .await?
                    .path,
            )
        };
        reference_images.push(path);
    }

    let outcome = async {
        if let Some(cached) = load_cached_local_result(&paths, &call_id).await? {
            return Ok::<(Vec<u8>, String), AppError>(cached);
        }

        // 即梦与主生成队列共用账号级串行锁；Codex provider 自己持有全局图片目录锁。
        let _jimeng_permit = if provider_key == "jimeng" {
            Some(
                crate::core::generation_worker::JIMENG_FLY
                    .acquire()
                    .await
                    .unwrap(),
            )
        } else {
            None
        };
        let dreamina_model =
            (provider_key == "jimeng").then(|| settings.get().dreamina_model_version);
        let provider = crate::codex::resolve_gen_provider(
            Some(&provider_key),
            None,
            dreamina_model.as_deref(),
        )?;
        let instruction = local_generation_instruction(&provider_key, &prompt, ratio.as_deref());
        let request = crate::codex::types::CodexRequest {
            instruction,
            reference_images: reference_images.clone(),
            context_prompts: vec![],
            ratio: ratio.clone(),
            job_id: None,
        };
        // 进度不需要回流（云端时间线由 Worker 补事件）：开通道丢弃 chunk 即可。
        let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel(64);
        tokio::spawn(async move { while chunk_rx.recv().await.is_some() {} });
        let timeout_secs = if provider_key == "codex" { 1_200 } else { 600 };
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            provider.generate_image(request, &chunk_tx, None),
        )
        .await
        .map_err(|_| AppError::Other(format!("{provider_key} 生成超时")))??;
        if outcome.source_images.len() != 1 {
            if let Some(temp_dir) = &outcome.temp_dir {
                let _ = tokio::fs::remove_dir_all(temp_dir).await;
            }
            return Err(AppError::Other(format!(
                "{provider_key} 必须返回且只能返回一张图片，实际为 {} 张",
                outcome.source_images.len()
            )));
        }
        let image = outcome.source_images[0].clone();
        let bytes = tokio::fs::read(&image)
            .await
            .map_err(|error| AppError::Other(format!("读取 {provider_key} 结果失败: {error}")))?;
        let mime = detect_image_mime(&bytes)
            .ok_or_else(|| AppError::Other(format!("{provider_key} 结果不是有效的图片文件")))?
            .to_string();
        if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
            return Err(AppError::Other(format!(
                "{provider_key} 结果超出产物大小上限"
            )));
        }
        cache_local_result(&paths, &call_id, &bytes, &mime).await?;
        if let Some(temp_dir) = &outcome.temp_dir {
            let _ = tokio::fs::remove_dir_all(temp_dir).await;
        }
        Ok::<(Vec<u8>, String), AppError>((bytes, mime))
    }
    .await;

    let (bytes, mime) = match outcome {
        Ok(value) => value,
        Err(error) => {
            let _ = agent_action(
                &cloud,
                &auth,
                json!({
                    "action": "local_task_fail",
                    "runId": run_id,
                    "callId": call_id,
                    "errorCode": local_task_error_code(&provider_key, &error),
                    "safeMessage": error.to_string().chars().take(500).collect::<String>(),
                }),
                "回报本地任务失败",
            )
            .await;
            let _ = refresh_record(&db, &cloud, &auth, &run_id).await;
            return Err(error);
        }
    };
    let sha256 = sha256_hex(&bytes);
    let byte_len = bytes.len();

    let transfer = async {
        let prepared = agent_action(
            &cloud,
            &auth,
            json!({
                "action": "local_task_prepare",
                "runId": run_id,
                "callId": call_id,
                "mime": mime,
            }),
            "签发本地任务上传地址失败",
        )
        .await?;
        let url = prepared
            .get("uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::Cloud("本地任务上传地址缺失".into()))?;
        upload_signed(&cloud, url, &mime, bytes, "本机 CLI 生图结果").await?;
        agent_action(
            &cloud,
            &auth,
            json!({
                "action": "local_task_complete",
                "runId": run_id,
                "callId": call_id,
                "mime": mime,
                "sha256": sha256,
                "bytes": byte_len,
            }),
            "回报本地任务结果失败",
        )
        .await?;
        Ok::<(), AppError>(())
    }
    .await;
    if let Err(error) = transfer {
        // CLI 副作用已经发生；保留 call_id 缓存并让轮询重试上传/complete，绝不再次生图。
        // 服务端 expires_at 负责最终超时结算，瞬时网络错误不应把结果误判成 provider 失败。
        return Err(error);
    }
    remove_cached_local_result(&paths, &call_id).await;

    refresh_record(&db, &cloud, &auth, &run_id).await
}

#[cfg(test)]
mod tests {
    use super::{
        agent_group_payload, cache_local_result, ensure_agent_provider_compatible,
        existing_agent_asset, ingestible_artifacts, list_records, load_cached_local_result,
        local_generation_instruction, nearest_ratio, normalize_intent_prompt,
        normalize_requested_ratio, project_agent_record, record_from_row,
        remove_cached_local_result, resolve_agent_runtime, save_record,
        validate_html_layout_options, validate_preference_capsule, CloudAgentReferenceRequest,
        CloudAgentRunRecord, HtmlLayoutOptions, PreferenceCapsule, PreferenceFact, PreferenceScope,
        DSH_AGENT_RUNTIME, LEGACY_AGENT_RUNTIME,
    };
    use crate::core::paths::LibraryPaths;
    use crate::db::Database;
    use serde_json::json;

    #[test]
    fn transfer_cleanup_stays_reconcilable_until_cloud_confirms_cancelled() {
        assert_eq!(super::transfer_cleanup_status(None), "cancel_requested");
        assert_eq!(
            super::transfer_cleanup_status(Some(&json!({ "status": "cancel_requested" }))),
            "cancel_requested"
        );
        assert_eq!(
            super::transfer_cleanup_status(Some(&json!({ "status": "succeeded" }))),
            "cancel_requested"
        );
        assert_eq!(
            super::transfer_cleanup_status(Some(&json!({ "status": "cancelled" }))),
            "cancelled"
        );

        let local = CloudAgentRunRecord {
            run_id: "run-ambiguous-transfer".into(),
            conversation_id: "conversation-ambiguous-transfer".into(),
            skill_id: "skill".into(),
            status: "cancel_requested".into(),
            intent_prompt: "goal".into(),
            reference_asset_ids: vec![],
            project_id: Some("project-1".into()),
            thread_id: Some("thread-1".into()),
            creative_launch_id: Some("launch-1".into()),
            snapshot: json!({ "run": { "status": "cancel_requested" } }),
            feedback_action: None,
            final_asset_id: None,
            created_at: 1,
            updated_at: 1,
        };
        let mut authoritative = local.clone();
        authoritative.status = "succeeded".into();
        authoritative.snapshot = json!({ "run": { "status": "succeeded" } });
        authoritative.updated_at = 2;
        assert_eq!(
            super::merge_record(&local, &authoritative).unwrap().status,
            "succeeded",
            "an unconfirmed cleanup checkpoint must remain replaceable by cloud truth"
        );
    }

    #[test]
    fn local_ingest_checkpoint_survives_same_group_refresh_and_invalidates_on_change() {
        let mut existing = CloudAgentRunRecord {
            run_id: "run-ingested".into(),
            conversation_id: "conversation-ingested".into(),
            skill_id: "bowerbird-controlled-image-edit".into(),
            status: "succeeded".into(),
            intent_prompt: "完成创作".into(),
            reference_asset_ids: vec![],
            project_id: Some("project-1".into()),
            thread_id: Some("thread-1".into()),
            creative_launch_id: Some("launch-1".into()),
            snapshot: json!({
                "run": { "status": "succeeded", "result_feedback_action": "accept" },
                "artifacts": [{
                    "id": "artifact-final",
                    "role": "final_result",
                    "mime": "image/png",
                    "sha256": "sha-final",
                    "user_visible": true,
                    "downloaded_at": "2026-09-04T00:00:00Z"
                }]
            }),
            feedback_action: Some("accept".into()),
            final_asset_id: Some("asset-final".into()),
            created_at: 1,
            updated_at: 2,
        };
        let fingerprint = super::ingest_artifact_fingerprint(&existing).unwrap();
        existing.snapshot.as_object_mut().unwrap().insert(
            super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY.into(),
            json!({
                "schemaVersion": 1,
                "fingerprint": fingerprint,
                "completedAt": 2,
            }),
        );

        let mut same_group = existing.clone();
        same_group
            .snapshot
            .as_object_mut()
            .unwrap()
            .remove(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY);
        same_group.snapshot["artifacts"][0]["downloaded_at"] = json!(null);
        same_group.updated_at = 3;
        let merged = super::merge_record(&existing, &same_group).unwrap();
        assert!(merged
            .snapshot
            .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
            .is_some_and(|checkpoint| super::ingest_checkpoint_matches(&merged, checkpoint)));

        let mut changed_group = same_group;
        changed_group.snapshot["artifacts"][0]["sha256"] = json!("sha-revised");
        let changed = super::merge_record(&existing, &changed_group).unwrap();
        assert!(changed
            .snapshot
            .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
            .is_none());
    }

    #[test]
    fn whole_group_checkpoint_requires_durable_asset_membership_and_canvas_projection() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("project-1", "Project", "project-1", "project-1", "blank")
            .unwrap();
        db.ensure_project_canvas("project-1").unwrap();
        db.create_creative_thread(&crate::core::project_canvas::NewCreativeThread {
            id: "thread-1".into(),
            project_id: "project-1".into(),
            title: "Thread".into(),
            origin: crate::core::creative_session_contract::CreativeThreadOrigin::Direct,
        })
        .unwrap();
        let launch = crate::core::project_canvas::ProjectAgentLaunchInput {
            project_id: "project-1".into(),
            thread_id: "thread-1".into(),
            launch_id: "launch-1".into(),
            prompt: "完成创作".into(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec![],
            parent_node_id: None,
            parent_asset_id: None,
        };
        db.begin_project_agent_launch(&launch).unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,store_path,created_at) VALUES ('asset-final','终稿','/final.png',1)",
                [],
            )
            .unwrap();
        let mut snapshot = json!({
            "run": { "status": "succeeded", "result_feedback_action": "accept" },
            "artifacts": [{
                "id": "artifact-final",
                "role": "final_result",
                "mime": "image/png",
                "sha256": "sha-final",
                "user_visible": true,
                "downloaded_at": "2026-09-04T00:00:00Z"
            }]
        });
        super::set_project_agent_launch_snapshot(&mut snapshot, &launch).unwrap();
        let record = CloudAgentRunRecord {
            run_id: "run-ingested".into(),
            conversation_id: "conversation-ingested".into(),
            skill_id: "bowerbird-controlled-image-edit".into(),
            status: "succeeded".into(),
            intent_prompt: "完成创作".into(),
            reference_asset_ids: vec![],
            project_id: Some("project-1".into()),
            thread_id: Some("thread-1".into()),
            creative_launch_id: Some("launch-1".into()),
            snapshot,
            feedback_action: Some("accept".into()),
            final_asset_id: Some("asset-final".into()),
            created_at: 1,
            updated_at: 2,
        };
        let saved = save_record(&db, &record).unwrap();
        let incomplete = super::checkpoint_completed_ingest_if_ready(&db, &saved).unwrap();
        assert!(incomplete
            .snapshot
            .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
            .is_none());
        project_agent_record(&db, &saved).unwrap();
        let completed = super::checkpoint_completed_ingest_if_ready(&db, &saved).unwrap();
        assert!(completed
            .snapshot
            .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
            .is_some_and(|checkpoint| super::ingest_checkpoint_matches(&completed, checkpoint)));
    }

    #[test]
    fn startup_read_recovers_checkpoint_after_receipts_commit_crash_window() {
        let path = std::env::temp_dir().join(format!(
            "bowerbird-agent-ingest-checkpoint-restart-{}.db",
            ulid::Ulid::new()
        ));
        {
            let db = Database::open(&path).unwrap();
            db.migrate().unwrap();
            db.create_project(
                "project-restart-ingest",
                "Project",
                "project-restart-ingest",
                "project-restart-ingest",
                "blank",
            )
            .unwrap();
            db.ensure_project_canvas("project-restart-ingest").unwrap();
            db.create_creative_thread(&crate::core::project_canvas::NewCreativeThread {
                id: "thread-restart-ingest".into(),
                project_id: "project-restart-ingest".into(),
                title: "Thread".into(),
                origin: crate::core::creative_session_contract::CreativeThreadOrigin::Direct,
            })
            .unwrap();
            let launch = crate::core::project_canvas::ProjectAgentLaunchInput {
                project_id: "project-restart-ingest".into(),
                thread_id: "thread-restart-ingest".into(),
                launch_id: "launch-restart-ingest".into(),
                prompt: "完成创作".into(),
                provider: "cloud".into(),
                ratio: None,
                visual_profile: None,
                reference_asset_ids: vec![],
                parent_node_id: None,
                parent_asset_id: None,
            };
            db.begin_project_agent_launch(&launch).unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO assets(id,name,store_path,created_at) VALUES ('asset-restart-ingest','终稿','/restart-final.png',1)",
                    [],
                )
                .unwrap();
            let mut snapshot = json!({
                "run": { "status": "succeeded", "result_feedback_action": "accept" },
                "artifacts": [{
                    "id": "artifact-restart-ingest",
                    "role": "final_result",
                    "mime": "image/png",
                    "sha256": "sha-restart-ingest",
                    "user_visible": true,
                    "downloaded_at": null
                }]
            });
            super::set_project_agent_launch_snapshot(&mut snapshot, &launch).unwrap();
            let record = CloudAgentRunRecord {
                run_id: "run-restart-ingest".into(),
                conversation_id: "conversation-restart-ingest".into(),
                skill_id: "bowerbird-controlled-image-edit".into(),
                status: "succeeded".into(),
                intent_prompt: "完成创作".into(),
                reference_asset_ids: vec![],
                project_id: Some("project-restart-ingest".into()),
                thread_id: Some("thread-restart-ingest".into()),
                creative_launch_id: Some("launch-restart-ingest".into()),
                snapshot,
                feedback_action: Some("accept".into()),
                final_asset_id: Some("asset-restart-ingest".into()),
                created_at: 1,
                updated_at: 1,
            };
            let projected = save_record(&db, &record).unwrap();
            project_agent_record(&db, &projected).unwrap();

            // Simulate refresh_record committing the last artifact_received receipt,
            // followed by a process crash before checkpoint_completed_ingest_if_ready.
            let mut acknowledged = projected;
            acknowledged.snapshot["artifacts"][0]["downloaded_at"] = json!("2026-09-04T00:00:00Z");
            acknowledged.updated_at = 2;
            let acknowledged = save_record(&db, &acknowledged).unwrap();
            assert!(acknowledged
                .snapshot
                .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
                .is_none());
            assert_eq!(
                db.project_delete_impact("project-restart-ingest")
                    .unwrap()
                    .running_agent_count,
                1,
                "missing checkpoint must keep project deletion fail-closed"
            );
        }

        {
            let reopened = Database::open(&path).unwrap();
            let mut records = list_records(&reopened, 100).unwrap();
            assert_eq!(records.len(), 1);
            assert!(records[0]
                .snapshot
                .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
                .is_none());

            // A corrupt entry must stay uncheckpointed without preventing the
            // following valid list entry from repairing the durable marker.
            let persisted_without_marker = records.pop().unwrap();
            let mut broken = persisted_without_marker.clone();
            broken.project_id = Some("missing-project".into());
            records.extend([broken, persisted_without_marker]);
            super::recover_agent_projections(&reopened, &mut records);

            assert!(records[0]
                .snapshot
                .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
                .is_none());
            assert!(records[1]
                .snapshot
                .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
                .is_some_and(|checkpoint| {
                    super::ingest_checkpoint_matches(&records[1], checkpoint)
                }));
            let persisted = super::load_record(&reopened, "run-restart-ingest").unwrap();
            assert!(persisted
                .snapshot
                .get(super::PROJECT_AGENT_INGEST_SNAPSHOT_KEY)
                .is_some_and(|checkpoint| {
                    super::ingest_checkpoint_matches(&persisted, checkpoint)
                }));
            assert_eq!(
                reopened
                    .project_delete_impact("project-restart-ingest")
                    .unwrap()
                    .running_agent_count,
                0,
                "startup recovery must unblock deletion after all durable evidence exists"
            );
        }

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[tokio::test]
    async fn local_result_cache_reuses_one_call_and_cleans_up_after_completion() {
        let root =
            std::env::temp_dir().join(format!("bowerbird-agent-cache-{}", ulid::Ulid::new()));
        let paths = LibraryPaths::init(root.clone()).unwrap();
        let call_id = "a".repeat(64);
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

        cache_local_result(&paths, &call_id, &png, "image/png")
            .await
            .unwrap();
        let cached = load_cached_local_result(&paths, &call_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cached.0, png);
        assert_eq!(cached.1, "image/png");

        remove_cached_local_result(&paths, &call_id).await;
        assert!(load_cached_local_result(&paths, &call_id)
            .await
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn codex_local_instruction_explicitly_triggers_single_image_generation() {
        let instruction =
            local_generation_instruction("codex", "保留主体，只把背景改成雪山", Some("16:9"));
        assert!(instruction.starts_with("$imagegen\n"));
        assert!(instruction.contains("只生成并返回一张图片"));
        assert!(instruction.contains("输出画幅比例必须为 16:9"));
        assert!(instruction.contains("保留主体，只把背景改成雪山"));
    }

    #[test]
    fn jimeng_local_instruction_is_not_wrapped() {
        assert_eq!(
            local_generation_instruction("jimeng", "原始步骤", Some("1:1")),
            "原始步骤"
        );
    }

    #[test]
    fn codex_and_bowerbird_agent_are_temporarily_mutually_exclusive() {
        assert!(ensure_agent_provider_compatible(None).is_ok());
        assert!(ensure_agent_provider_compatible(Some("cloud")).is_ok());
        assert!(ensure_agent_provider_compatible(Some("jimeng")).is_ok());
        assert!(ensure_agent_provider_compatible(Some("codex")).is_err());
    }

    #[test]
    fn agent_runtime_defaults_legacy_and_gates_dsh_to_test_accounts() {
        assert_eq!(
            resolve_agent_runtime(None, false).unwrap(),
            LEGACY_AGENT_RUNTIME
        );
        assert_eq!(
            resolve_agent_runtime(Some(LEGACY_AGENT_RUNTIME), true).unwrap(),
            LEGACY_AGENT_RUNTIME
        );
        assert_eq!(
            resolve_agent_runtime(Some(DSH_AGENT_RUNTIME), true).unwrap(),
            DSH_AGENT_RUNTIME
        );
        assert!(resolve_agent_runtime(Some(DSH_AGENT_RUNTIME), false).is_err());
        assert!(resolve_agent_runtime(Some("unknown"), true).is_err());
    }

    #[test]
    fn intent_tokens_are_bound_to_reference_ordinals() {
        let prompt = normalize_intent_prompt(
            "让 @海报#2.jpg 保持主体，参考 @海报.jpg 的构图",
            &[
                CloudAgentReferenceRequest {
                    asset_id: "a".into(),
                    prompt_token: Some("海报#2.jpg".into()),
                },
                CloudAgentReferenceRequest {
                    asset_id: "b".into(),
                    prompt_token: Some("海报.jpg".into()),
                },
            ],
        )
        .unwrap();
        assert_eq!(prompt, "让 @图1 保持主体，参考 @图2 的构图");
    }

    #[test]
    fn agent_reference_ratio_uses_each_reference_dimensions() {
        assert_eq!(nearest_ratio(1024, 1536).as_deref(), Some("2:3"));
        assert_eq!(nearest_ratio(1536, 1024).as_deref(), Some("3:2"));
        assert_eq!(nearest_ratio(0, 1024), None);
        assert_eq!(normalize_requested_ratio(None).unwrap(), None);
        assert_eq!(
            normalize_requested_ratio(Some(" 9:16 ".into()))
                .unwrap()
                .as_deref(),
            Some("9:16")
        );
        assert!(normalize_requested_ratio(Some("auto".into())).is_err());
    }

    #[test]
    fn html_layout_options_enforce_closed_viewport_and_slice_ranges() {
        let valid = HtmlLayoutOptions {
            viewport_width: 900,
            viewport_height: 700,
            device_scale_factor: 2,
            capture_mode: "full_page_and_slices".into(),
            slice_height: Some(900),
            overlap: Some(80),
            background: "opaque".into(),
        };
        assert!(validate_html_layout_options(valid.clone()).is_ok());
        assert!(validate_html_layout_options(HtmlLayoutOptions {
            overlap: Some(900),
            ..valid.clone()
        })
        .is_err());
        assert!(validate_html_layout_options(HtmlLayoutOptions {
            capture_mode: "full_page".into(),
            ..valid
        })
        .is_err());
    }

    #[test]
    fn html_artifacts_follow_signed_render_manifest_slice_order() {
        let record = CloudAgentRunRecord {
            run_id: "run-html".into(),
            conversation_id: "conv-html".into(),
            skill_id: "bowerbird-html-layout-render".into(),
            status: "succeeded".into(),
            intent_prompt: "排版".into(),
            reference_asset_ids: vec![],
            project_id: None,
            thread_id: None,
            creative_launch_id: None,
            snapshot: json!({
                "artifacts": [
                    {"id":"slice-2","role":"slice_screenshot","mime":"image/png","user_visible":true},
                    {"id":"full","role":"full_page_screenshot","mime":"image/png","user_visible":true},
                    {"id":"slice-1","role":"slice_screenshot","mime":"image/png","user_visible":true}
                ],
                "renderManifest": {"outputs": [
                    {"artifactId":"full","role":"full_page_screenshot"},
                    {"artifactId":"slice-1","role":"slice_screenshot","index":0},
                    {"artifactId":"slice-2","role":"slice_screenshot","index":1}
                ]}
            }),
            feedback_action: Some("accept".into()),
            final_asset_id: None,
            created_at: 1,
            updated_at: 1,
        };
        assert_eq!(
            ingestible_artifacts(&record),
            vec![
                ("full".into(), "full_page_screenshot".into()),
                ("slice-1".into(), "slice_screenshot".into()),
                ("slice-2".into(), "slice_screenshot".into()),
            ]
        );
    }

    #[test]
    fn html_expiry_without_visible_artifacts_does_not_offer_remote_ingest() {
        let record = CloudAgentRunRecord {
            run_id: "run-expired".into(),
            conversation_id: "conv-expired".into(),
            skill_id: "bowerbird-html-layout-render".into(),
            status: "succeeded".into(),
            intent_prompt: "排版".into(),
            reference_asset_ids: vec![],
            project_id: None,
            thread_id: None,
            creative_launch_id: None,
            snapshot: json!({
                "artifacts": [],
                "renderManifest": {"outputs": [{"artifactId":"gone","role":"full_page_screenshot"}]}
            }),
            feedback_action: Some("accept".into()),
            final_asset_id: None,
            created_at: 1,
            updated_at: 1,
        };
        assert!(ingestible_artifacts(&record).is_empty());
    }

    #[test]
    fn repeated_group_ingest_reuses_the_asset_with_the_same_origin_path() {
        let root =
            std::env::temp_dir().join(format!("bowerbird-agent-ingest-{}", ulid::Ulid::new()));
        let paths = LibraryPaths::init(root.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let source = root.join("downloaded.png");
        image::RgbImage::from_pixel(2, 3, image::Rgb([10, 20, 30]))
            .save(&source)
            .unwrap();
        let first = crate::core::ingest::ingest_generated(
            &paths,
            &db,
            &source,
            Some("conv-idempotent"),
            "bowerbird-agent",
        )
        .unwrap();
        let repeated = existing_agent_asset(&db, &source).unwrap().unwrap();
        assert_eq!(repeated.id, first.id);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preference_capsule_accepts_only_explicit_project_scoped_facts() {
        let capsule = PreferenceCapsule {
            schema_version: 1,
            scope: PreferenceScope {
                project_id: Some("project-1".into()),
            },
            preferred: vec![PreferenceFact {
                category: "palette".into(),
                value: "低饱和蓝绿色".into(),
                confidence: 1.0,
                evidence_count: 1,
                explicit: true,
            }],
            avoid: vec![],
            workflow: vec![],
            generated_at: chrono::Utc::now().to_rfc3339(),
            expires_at: (chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        };
        validate_preference_capsule(&capsule, Some("project-1")).unwrap();
        assert!(validate_preference_capsule(&capsule, Some("project-2")).is_err());

        let mut global = capsule.clone();
        global.scope.project_id = None;
        validate_preference_capsule(&global, Some("project-1")).unwrap();

        let mut implicit = capsule;
        implicit.preferred[0].explicit = false;
        assert!(validate_preference_capsule(&implicit, Some("project-1")).is_err());
    }

    #[test]
    fn cloud_agent_checkpoint_uses_its_own_local_table() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("project-1", "未命名项目", "project-1", "project-1", "blank")
            .unwrap();
        db.ensure_project_canvas("project-1").unwrap();
        db.create_creative_thread(&crate::core::project_canvas::NewCreativeThread {
            id: "thread-1".into(),
            project_id: "project-1".into(),
            title: "换背景".into(),
            origin: crate::core::creative_session_contract::CreativeThreadOrigin::Direct,
        })
        .unwrap();
        db.begin_project_agent_launch(&crate::core::project_canvas::ProjectAgentLaunchInput {
            project_id: "project-1".into(),
            thread_id: "thread-1".into(),
            launch_id: "launch-1".into(),
            prompt: "换背景".into(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec![],
            parent_node_id: None,
            parent_asset_id: None,
        })
        .unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,store_path,created_at) VALUES ('agent-final','终稿','/agent-final.png',1)",
                [],
            )
            .unwrap();
        let record = CloudAgentRunRecord {
            run_id: "run-1".into(),
            conversation_id: "conv-1".into(),
            skill_id: "bowerbird-controlled-image-edit".into(),
            status: "succeeded".into(),
            intent_prompt: "换背景".into(),
            reference_asset_ids: vec![],
            project_id: Some("project-1".into()),
            thread_id: Some("thread-1".into()),
            creative_launch_id: Some("launch-1".into()),
            snapshot: json!({
                "run":{"status":"succeeded"},
                "artifacts":[{
                    "id":"artifact-final",
                    "role":"final_result",
                    "mime":"image/png",
                    "user_visible":true
                }]
            }),
            feedback_action: Some("accept".into()),
            final_asset_id: Some("agent-final".into()),
            created_at: 1,
            updated_at: 1,
        };
        save_record(&db, &record).unwrap();
        assert!(db.thread_for_agent("run-1").unwrap().is_none());
        project_agent_record(&db, &record).unwrap();
        assert_eq!(
            db.thread_for_agent("run-1").unwrap().as_deref(),
            Some("thread-1")
        );
        project_agent_record(&db, &record).unwrap();
        let snapshot = db.project_canvas_snapshot("project-1").unwrap();
        assert_eq!(
            snapshot
                .nodes
                .iter()
                .filter(|node| node.asset_id.as_deref() == Some("agent-final"))
                .count(),
            1,
            "恢复与重放只能投影一个最终资产节点"
        );
        let conn = db.conn.lock().unwrap();
        let loaded = conn.query_row(
            "SELECT run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at, thread_id, creative_launch_id FROM cloud_agent_runs WHERE run_id='run-1'",
            [], record_from_row,
        ).unwrap();
        assert_eq!(loaded.conversation_id, "conv-1");
        let task_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_queue", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_count, 0);
    }

    #[test]
    fn cloud_agent_run_merge_preserves_identity_owner_terminal_and_final_asset() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        for (project_id, thread_id) in [
            ("project-1", "thread-1"),
            ("project-1", "thread-2"),
            ("project-2", "thread-3"),
        ] {
            if db.get_project(project_id).unwrap().is_none() {
                db.create_project(project_id, project_id, project_id, project_id, "blank")
                    .unwrap();
                db.ensure_project_canvas(project_id).unwrap();
            }
            db.create_creative_thread(&crate::core::project_canvas::NewCreativeThread {
                id: thread_id.into(),
                project_id: project_id.into(),
                title: thread_id.into(),
                origin: crate::core::creative_session_contract::CreativeThreadOrigin::Direct,
            })
            .unwrap();
        }

        let launch = crate::core::project_canvas::ProjectAgentLaunchInput {
            project_id: "project-1".into(),
            thread_id: "thread-1".into(),
            launch_id: "launch-owned".into(),
            prompt: "换背景".into(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec![],
            parent_node_id: Some("parent-node-1".into()),
            parent_asset_id: Some("parent-asset-1".into()),
        };
        let mut original_snapshot = json!({"run":{"status":"uploading"}});
        super::set_project_agent_launch_snapshot(&mut original_snapshot, &launch).unwrap();
        let original = CloudAgentRunRecord {
            run_id: "run-owned".into(),
            conversation_id: "conv-owned".into(),
            skill_id: "bowerbird-controlled-image-edit".into(),
            status: "uploading".into(),
            intent_prompt: "换背景".into(),
            reference_asset_ids: vec![],
            project_id: Some("project-1".into()),
            thread_id: Some("thread-1".into()),
            creative_launch_id: Some("launch-owned".into()),
            snapshot: original_snapshot,
            feedback_action: None,
            final_asset_id: None,
            created_at: 1,
            updated_at: 1,
        };
        save_record(&db, &original).unwrap();

        let mut same_owner = original.clone();
        same_owner.status = "running".into();
        same_owner.snapshot = json!({"run":{"status":"running"}});
        same_owner.updated_at = 2;
        save_record(&db, &same_owner).unwrap();

        let preserved = super::load_record(&db, "run-owned").unwrap();
        assert_eq!(
            super::project_agent_launch_from_snapshot(&preserved.snapshot),
            Some(launch.clone()),
            "远端 snapshot 整包刷新不能抹掉本地精确父节点 checkpoint"
        );

        let mut changed_parent = same_owner.clone();
        let mut rebound_launch = launch.clone();
        rebound_launch.parent_node_id = Some("parent-node-2".into());
        super::set_project_agent_launch_snapshot(&mut changed_parent.snapshot, &rebound_launch)
            .unwrap();
        let error = save_record(&db, &changed_parent).unwrap_err();
        assert!(error.to_string().contains("creative parent cannot change"));

        let mutations = [
            (Some("project-2"), Some("thread-3"), "conv-owned"),
            (Some("project-1"), Some("thread-2"), "conv-owned"),
            (Some("project-1"), Some("thread-1"), "conv-rebound"),
        ];
        for (project_id, thread_id, conversation_id) in mutations {
            let mut rebound = same_owner.clone();
            rebound.project_id = project_id.map(str::to_string);
            rebound.thread_id = thread_id.map(str::to_string);
            rebound.conversation_id = conversation_id.into();
            rebound.status = "failed".into();
            rebound.snapshot = json!({"run":{"status":"failed"}});
            let error = save_record(&db, &rebound).unwrap_err();
            assert!(error.to_string().contains("cannot change"));
        }

        let persisted = super::load_record(&db, "run-owned").unwrap();
        assert_eq!(persisted.conversation_id, "conv-owned");
        assert_eq!(persisted.project_id.as_deref(), Some("project-1"));
        assert_eq!(persisted.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(
            persisted.creative_launch_id.as_deref(),
            Some("launch-owned")
        );
        assert_eq!(persisted.status, "running");

        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,store_path,created_at) VALUES ('asset-final','终稿','/final.png',1)",
                [],
            )
            .unwrap();
        let stale_expected = super::load_stored_record(&db, "run-owned").unwrap();
        let mut terminal = stale_expected.record.clone();
        terminal.status = "succeeded".into();
        terminal.snapshot = json!({
            "run":{"status":"succeeded","result_feedback_action":"accept"},
            "artifacts":[{"id":"artifact-final","downloaded_at":null}]
        });
        terminal.feedback_action = Some("accept".into());
        terminal.final_asset_id = Some("asset-final".into());
        terminal.updated_at = 3;
        let terminal = save_record(&db, &terminal).unwrap();
        assert_eq!(terminal.status, "succeeded");
        assert_eq!(terminal.final_asset_id.as_deref(), Some("asset-final"));

        let mut stale_refresh = stale_expected.record.clone();
        stale_refresh.status = "running".into();
        stale_refresh.snapshot = json!({"run":{"status":"running"}});
        stale_refresh.feedback_action = None;
        stale_refresh.final_asset_id = None;
        stale_refresh.updated_at = 4;
        let conflicted =
            match super::save_record_if_unchanged(&db, &stale_expected, &stale_refresh).unwrap() {
                super::SaveRecordCasResult::Saved(_) => panic!("stale refresh must fail CAS"),
                super::SaveRecordCasResult::Conflict(current) => current.record,
            };
        assert_eq!(conflicted.status, "succeeded");
        assert_eq!(conflicted.final_asset_id.as_deref(), Some("asset-final"));

        let merged = save_record(&db, &stale_refresh).unwrap();
        assert_eq!(merged.status, "succeeded");
        assert_eq!(merged.final_asset_id.as_deref(), Some("asset-final"));
        assert_eq!(
            super::project_agent_launch_from_snapshot(&merged.snapshot),
            Some(launch.clone())
        );
        assert_eq!(
            merged
                .snapshot
                .pointer("/run/status")
                .and_then(serde_json::Value::as_str),
            Some("succeeded")
        );

        let mut acknowledged = merged.clone();
        acknowledged.snapshot = json!({
            "run":{"status":"succeeded","result_feedback_action":"accept"},
            "artifacts":[{
                "id":"artifact-final",
                "downloaded_at":"2026-09-04T00:00:00Z"
            }]
        });
        acknowledged.updated_at = 5;
        let acknowledged = save_record(&db, &acknowledged).unwrap();
        assert_eq!(acknowledged.status, "succeeded");
        assert_eq!(
            acknowledged
                .snapshot
                .pointer("/artifacts/0/downloaded_at")
                .and_then(serde_json::Value::as_str),
            Some("2026-09-04T00:00:00Z"),
            "同一终态必须继续吸收 artifact_received 的持久确认"
        );
        assert_eq!(acknowledged.final_asset_id.as_deref(), Some("asset-final"));
        assert_eq!(
            super::project_agent_launch_from_snapshot(&acknowledged.snapshot),
            Some(launch)
        );

        let mut stale_terminal = acknowledged.clone();
        stale_terminal.snapshot = json!({
            "run":{"status":"succeeded","result_feedback_action":"accept"},
            "artifacts":[{"id":"artifact-final","downloaded_at":null}]
        });
        stale_terminal.updated_at = 6;
        let stale_terminal = save_record(&db, &stale_terminal).unwrap();
        assert_eq!(
            stale_terminal
                .snapshot
                .pointer("/artifacts/0/downloaded_at")
                .and_then(serde_json::Value::as_str),
            Some("2026-09-04T00:00:00Z"),
            "迟到的同终态响应不能擦除已经确认的 artifact receipt"
        );
    }

    #[test]
    fn legacy_agent_launch_checkpoint_defaults_missing_parent_node() {
        let launch: crate::core::project_canvas::ProjectAgentLaunchInput =
            serde_json::from_value(json!({
                "projectId": "project-1",
                "threadId": "thread-1",
                "launchId": "launch-legacy",
                "prompt": "继续创作",
                "provider": "cloud",
                "ratio": null,
                "visualProfile": null,
                "referenceAssetIds": [],
                "parentAssetId": "asset-1"
            }))
            .unwrap();
        assert!(launch.parent_node_id.is_none());
        assert_eq!(launch.parent_asset_id.as_deref(), Some("asset-1"));
    }

    #[test]
    fn cloud_agent_provider_conversation_survives_database_reopen() {
        let path = std::env::temp_dir().join(format!(
            "bowerbird-cloud-agent-restart-{}.db",
            ulid::Ulid::new()
        ));
        {
            let db = Database::open(&path).unwrap();
            db.migrate().unwrap();
            db.create_project("project-restart", "项目", "项目", "项目", "blank")
                .unwrap();
            db.ensure_project_canvas("project-restart").unwrap();
            db.create_creative_thread(&crate::core::project_canvas::NewCreativeThread {
                id: "thread-restart".into(),
                project_id: "project-restart".into(),
                title: "换背景".into(),
                origin: crate::core::creative_session_contract::CreativeThreadOrigin::Direct,
            })
            .unwrap();
            db.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO assets(id,name,store_path,created_at) VALUES ('parent-asset','父素材','/parent.png',1)",
                    [],
                )
                .unwrap();
            let parent_payload = serde_json::json!({
                "schema_version": 1,
                "snapshot": { "name": "父素材" },
                "execution": { "run_id": "older-run" }
            })
            .to_string();
            for (index, node_id) in ["parent-first", "parent-selected"].into_iter().enumerate() {
                db.create_canvas_node(&crate::core::project_canvas::NewCanvasNode {
                    id: node_id.into(),
                    project_id: "project-restart".into(),
                    thread_id: Some("thread-restart".into()),
                    kind: crate::core::creative_session_contract::CreativeNodeKind::Asset,
                    asset_id: Some("parent-asset".into()),
                    role: Some(crate::core::creative_session_contract::CreativeNodeRole::Output),
                    payload_json: parent_payload.clone(),
                    x: index as f64 * 220.0,
                    y: 0.0,
                    width: 190.0,
                    height: 180.0,
                    z_index: index as i64,
                    position_locked: false,
                })
                .unwrap();
            }
            let launch = crate::core::project_canvas::ProjectAgentLaunchInput {
                project_id: "project-restart".into(),
                thread_id: "thread-restart".into(),
                launch_id: "launch-restart".into(),
                prompt: "换背景".into(),
                provider: "cloud".into(),
                ratio: None,
                visual_profile: None,
                reference_asset_ids: vec![],
                parent_node_id: Some("parent-selected".into()),
                parent_asset_id: Some("parent-asset".into()),
            };
            let mut snapshot = json!({
                "conversationId":"provider-conversation-restart",
                "run":{
                    "id":"run-restart",
                    "conversation_id":"provider-conversation-restart",
                    "status":"uploading"
                }
            });
            super::set_project_agent_launch_snapshot(&mut snapshot, &launch).unwrap();
            let record = CloudAgentRunRecord {
                run_id: "run-restart".into(),
                conversation_id: "provider-conversation-restart".into(),
                skill_id: "bowerbird-controlled-image-edit".into(),
                status: "uploading".into(),
                intent_prompt: "换背景".into(),
                reference_asset_ids: vec![],
                project_id: Some("project-restart".into()),
                thread_id: Some("thread-restart".into()),
                creative_launch_id: Some("launch-restart".into()),
                snapshot,
                feedback_action: None,
                final_asset_id: None,
                created_at: 1,
                updated_at: 1,
            };
            save_record(&db, &record).unwrap();
        }

        {
            let reopened = Database::open(&path).unwrap();
            let mut restored = super::load_record(&reopened, "run-restart").unwrap();
            assert_eq!(restored.conversation_id, "provider-conversation-restart");
            assert_eq!(
                restored
                    .snapshot
                    .pointer("/run/conversation_id")
                    .and_then(serde_json::Value::as_str),
                Some("provider-conversation-restart")
            );
            assert_eq!(restored.status, "uploading");
            assert_eq!(restored.project_id.as_deref(), Some("project-restart"));
            assert_eq!(restored.thread_id.as_deref(), Some("thread-restart"));
            assert_eq!(
                restored.creative_launch_id.as_deref(),
                Some("launch-restart")
            );
            assert_eq!(
                super::project_agent_launch_from_snapshot(&restored.snapshot)
                    .and_then(|launch| launch.parent_node_id),
                Some("parent-selected".into())
            );
            super::recover_agent_projections(&reopened, std::slice::from_mut(&mut restored));
            assert_eq!(
                reopened.thread_for_agent("run-restart").unwrap().as_deref(),
                Some("thread-restart")
            );
            let canvas = reopened.project_canvas_snapshot("project-restart").unwrap();
            let projected = canvas
                .nodes
                .iter()
                .find(|node| {
                    node.kind
                        == crate::core::creative_session_contract::CreativeNodeKind::AgentGroup
                })
                .expect("restart recovery should restore the Agent execution node");
            let payload: crate::core::creative_session_contract::AgentGroupNodePayloadV1 =
                serde_json::from_str(&projected.payload_json).unwrap();
            assert_eq!(
                payload.conversation_id.as_deref(),
                Some("provider-conversation-restart")
            );
            let prompt = canvas
                .nodes
                .iter()
                .find(|node| {
                    node.kind == crate::core::creative_session_contract::CreativeNodeKind::Prompt
                })
                .expect("restart recovery should rebuild the Agent prompt");
            assert!(canvas.edges.iter().any(|edge| {
                edge.from_node_id == "parent-selected" && edge.to_node_id == prompt.id
            }));
            assert!(!canvas.edges.iter().any(|edge| {
                edge.from_node_id == "parent-first" && edge.to_node_id == prompt.id
            }));
        }

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }

    #[test]
    fn creative_agent_projection_keeps_a_bounded_safe_snapshot() {
        let events = (0..120)
            .map(|seq| {
                json!({
                    "seq": seq,
                    "type": "step_progress",
                    "step": "render",
                    "progress": seq,
                    "display_payload": { "summary": format!("事件 {seq}") },
                    "private_payload": { "signedUrl": "must-not-project" }
                })
            })
            .collect::<Vec<_>>();
        let record = CloudAgentRunRecord {
            run_id: "run-projection".into(),
            conversation_id: "conv-projection".into(),
            skill_id: "bowerbird-controlled-image-edit".into(),
            status: "awaiting_approval".into(),
            intent_prompt: "生成终稿".into(),
            reference_asset_ids: vec![],
            project_id: None,
            thread_id: Some("creative-1".into()),
            creative_launch_id: Some("launch-1".into()),
            snapshot: json!({
                "run": {
                    "status": "awaiting_approval",
                    "agent_runtime": "legacy_kernel",
                    "current_step": "plan",
                    "progress": 25,
                    "budget_credits": 48,
                    "visual_profile_id": "profile-1",
                    "visual_profile_version": 3,
                    "visual_profile_hash": "profile-hash"
                },
                "events": events,
                "approvals": [{
                    "id": "approval-1",
                    "kind": "controlled_image_edit_plan",
                    "status": "pending",
                    "proposal_hash": "hash",
                    "planned_tool_count": 2,
                    "estimated_additional_credits": 16,
                    "proposal": { "title": "执行计划", "summary": "两步生成" }
                }],
                "clarifications": [{
                    "id": "clarification-1",
                    "status": "pending",
                    "question": { "question": "使用哪种构图？", "recommendedAnswer": "居中构图" }
                }],
                "artifacts": [{
                    "id": "artifact-1",
                    "role": "stage_result",
                    "step_id": "render",
                    "mime": "image/png",
                    "user_visible": true,
                    "signed_url": "must-not-project"
                }]
            }),
            feedback_action: None,
            final_asset_id: None,
            created_at: 1,
            updated_at: 1,
        };
        let payload = agent_group_payload(&record);
        assert_eq!(payload.events.len(), 96);
        assert_eq!(payload.events[0].seq, 24);
        assert_eq!(payload.events.last().unwrap().progress, Some(100));
        assert_eq!(payload.approvals[0].title.as_deref(), Some("执行计划"));
        assert_eq!(
            payload.clarifications[0].recommended_answer.as_deref(),
            Some("居中构图")
        );
        assert_eq!(payload.artifacts[0].artifact_id, "artifact-1");
        assert_eq!(
            payload
                .visual_profile
                .as_ref()
                .map(|profile| profile.profile_id.as_str()),
            Some("profile-1")
        );
        let serialized = serde_json::to_string(&payload).unwrap();
        assert!(!serialized.contains("signedUrl"));
        assert!(!serialized.contains("must-not-project"));
    }

    #[test]
    fn cloud_agent_history_keeps_each_run_as_a_separate_session() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        for (index, prompt) in ["第一个 Agent 任务", "第二个 Agent 任务"]
            .into_iter()
            .enumerate()
        {
            let timestamp = index as i64 + 1;
            save_record(
                &db,
                &CloudAgentRunRecord {
                    run_id: format!("run-{timestamp}"),
                    conversation_id: format!("conv-{timestamp}"),
                    skill_id: "bowerbird-controlled-image-edit".into(),
                    status: "queued".into(),
                    intent_prompt: prompt.into(),
                    reference_asset_ids: vec![],
                    project_id: None,
                    thread_id: None,
                    creative_launch_id: None,
                    snapshot: json!({"run":{"status":"queued"}}),
                    feedback_action: None,
                    final_asset_id: None,
                    created_at: timestamp,
                    updated_at: timestamp,
                },
            )
            .unwrap();
        }

        let records = list_records(&db, 100).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].run_id, "run-2");
        assert_eq!(records[1].run_id, "run-1");
        assert_ne!(records[0].conversation_id, records[1].conversation_id);
    }
}
