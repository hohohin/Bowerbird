use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;
use rusqlite::OptionalExtension;

use crate::cloud::{AuthClient, CloudClient};
use crate::core::{library::Asset, paths::LibraryPaths};
use crate::db::Database;
use crate::error::AppError;

const SKILL_ID: &str = "bowerbird-controlled-image-edit";
const MAX_REFERENCES: usize = 8;
const MAX_PROMPT_CHARS: usize = 4_000;
const MAX_FEEDBACK_CHARS: usize = 2_000;
const MAX_ARTIFACT_BYTES: u64 = 20 * 1024 * 1024;
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

fn save_record(db: &Database, record: &CloudAgentRunRecord) -> Result<(), AppError> {
    let reference_asset_ids = serde_json::to_string(&record.reference_asset_ids)?;
    let snapshot = serde_json::to_string(&record.snapshot)?;
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO cloud_agent_runs (run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) \
         ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, project_id=excluded.project_id, snapshot_json=excluded.snapshot_json, feedback_action=excluded.feedback_action, final_asset_id=excluded.final_asset_id, updated_at=excluded.updated_at",
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
        ],
    )?;
    Ok(())
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CloudAgentRunRecord> {
    let references: String = row.get(5)?;
    let snapshot: String = row.get(7)?;
    Ok(CloudAgentRunRecord {
        run_id: row.get(0)?,
        conversation_id: row.get(1)?,
        skill_id: row.get(2)?,
        status: row.get(3)?,
        intent_prompt: row.get(4)?,
        reference_asset_ids: serde_json::from_str(&references).unwrap_or_default(),
        project_id: row.get(6)?,
        snapshot: serde_json::from_str(&snapshot).unwrap_or(Value::Null),
        feedback_action: row.get(8)?,
        final_asset_id: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn load_record(db: &Database, run_id: &str) -> Result<CloudAgentRunRecord, AppError> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at FROM cloud_agent_runs WHERE run_id=?1",
        [run_id],
        record_from_row,
    )
    .map_err(AppError::from)
}

fn list_records(db: &Database, limit: usize) -> Result<Vec<CloudAgentRunRecord>, AppError> {
    let conn = db.conn.lock().unwrap();
    let mut statement = conn.prepare(
        "SELECT run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at \
         FROM cloud_agent_runs ORDER BY created_at DESC, rowid DESC LIMIT ?1",
    )?;
    let records = statement
        .query_map([limit.clamp(1, 200) as i64], record_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(records)
}

async fn refresh_record(
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    run_id: &str,
) -> Result<CloudAgentRunRecord, AppError> {
    let mut record = load_record(db, run_id)?;
    let snapshot = agent_action(
        cloud,
        auth,
        json!({ "action": "get", "runId": run_id }),
        "读取 Agent Run 失败",
    )
    .await?;
    record.status = run_status(&snapshot)?;
    if let Some(action) = snapshot
        .pointer("/run/result_feedback_action")
        .and_then(Value::as_str)
        .filter(|action| matches!(*action, "accept" | "retry"))
    {
        record.feedback_action = Some(action.to_string());
    }
    record.snapshot = snapshot;
    record.updated_at = chrono::Utc::now().timestamp();
    save_record(db, &record)?;
    Ok(record)
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

#[tauri::command]
pub async fn cloud_agent_start(
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    intent_prompt: String,
    references: Vec<CloudAgentReferenceRequest>,
    ratio: Option<String>,
    project_id: Option<String>,
) -> Result<CloudAgentRunRecord, AppError> {
    if references.len() > MAX_REFERENCES {
        return Err(AppError::Other("Agent 最多处理 8 张参考图".into()));
    }
    let resolved_ratio = normalize_requested_ratio(ratio)?;
    if let Some(project) = project_id.as_deref() {
        if db.get_project(project)?.is_none() {
            return Err(AppError::Other("当前项目不存在".into()));
        }
    }

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
            asset.width.zip(asset.height).and_then(|(width, height)| nearest_ratio(width, height)),
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
    })?;
    if manifest.len() > 64 * 1024 {
        return Err(AppError::Other("Agent 输入清单过大".into()));
    }

    let mut create_body = json!({
        "action": "create",
        "skillId": SKILL_ID,
        "goal": normalized_prompt,
        "inputCount": image_bytes.len(),
        "inputManifestHash": sha256_hex(&manifest),
        "idempotencyKey": format!("desktop-agent-{}", Ulid::new()),
    });
    // None 必须省略而不是序列化为 null；控制面契约只接受缺省或合法比例字符串。
    if let Some(value) = resolved_ratio.as_deref() {
        create_body["ratio"] = json!(value);
    }
    let created = agent_action(&cloud, &auth, create_body, "创建 Agent Run 失败").await?;
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
        let _ = agent_action(
            &cloud,
            &auth,
            json!({ "action": "cancel", "runId": run_id }),
            "清理未完成的 Agent Run 失败",
        )
        .await;
        return Err(error);
    }

    let now = chrono::Utc::now().timestamp();
    // 入队成功即先落本地记录。即使随后首次 get 短暂失败，重启后仍能恢复并继续轮询，
    // 不会把云端已创建、已冻结积分的 Run 变成桌面端不可见的孤儿任务。
    let fallback_snapshot = json!({
        "conversationId": conversation_id,
        "run": {
            "id": run_id,
            "conversation_id": conversation_id,
            "skill_id": SKILL_ID,
            "skill_version": "0.1.1",
            "status": "queued",
            "progress": 0,
            "budget_credits": created.get("budgetCredits").cloned().unwrap_or(json!(48)),
        },
        "events": [],
        "approvals": [],
        "artifacts": [],
    });
    let mut record = CloudAgentRunRecord {
        run_id,
        conversation_id,
        skill_id: SKILL_ID.into(),
        status: "queued".into(),
        intent_prompt: normalized_prompt,
        reference_asset_ids: reference_ids,
        project_id,
        snapshot: fallback_snapshot,
        feedback_action: None,
        final_asset_id: None,
        created_at: now,
        updated_at: now,
    };
    save_record(&db, &record)?;
    if let Ok(snapshot) = agent_action(
        &cloud,
        &auth,
        json!({ "action": "get", "runId": record.run_id }),
        "读取 Agent Run 失败",
    )
    .await
    {
        record.status = run_status(&snapshot)?;
        record.snapshot = snapshot;
        record.updated_at = chrono::Utc::now().timestamp();
        save_record(&db, &record)?;
    }
    Ok(record)
}

#[tauri::command]
pub async fn cloud_agent_latest(
    db: State<'_, Arc<Database>>,
) -> Result<Option<CloudAgentRunRecord>, AppError> {
    Ok(list_records(&db, 1)?.into_iter().next())
}

#[tauri::command]
pub async fn cloud_agent_list(
    db: State<'_, Arc<Database>>,
) -> Result<Vec<CloudAgentRunRecord>, AppError> {
    list_records(&db, 100)
}

#[tauri::command]
pub async fn cloud_agent_get(
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    run_id: String,
) -> Result<CloudAgentRunRecord, AppError> {
    refresh_record(&db, &cloud, &auth, &run_id).await
}

#[tauri::command]
pub async fn cloud_agent_decide_approval(
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
    refresh_record(&db, &cloud, &auth, &run_id).await
}

#[tauri::command]
pub async fn cloud_agent_cancel(
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
    refresh_record(&db, &cloud, &auth, &run_id).await
}

#[tauri::command]
pub async fn cloud_agent_feedback(
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
    let mut record = refresh_record(&db, &cloud, &auth, &run_id).await?;
    record.feedback_action = Some(feedback_action);
    record.updated_at = chrono::Utc::now().timestamp();
    save_record(&db, &record)?;
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
            matches!(item.get("role").and_then(Value::as_str), Some("control_reference" | "stage_result" | "final_result"))
                && item.get("user_visible").and_then(Value::as_bool) != Some(false)
                && item.get("mime").and_then(Value::as_str).is_some_and(|mime| mime.starts_with("image/"))
        })
        .ok_or_else(|| AppError::Cloud("图片产物不存在、不可见或已被替换".into()))
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
    if expected_bytes == 0 || expected_bytes > MAX_ARTIFACT_BYTES || expected_hash.len() != 64 {
        return Err(AppError::Cloud("Agent 图片产物校验信息无效".into()));
    }
    let dir = paths.root.join("agent-runs").join(&record.conversation_id);
    let path = dir.join(format!("{artifact_id}.{extension}"));
    if let Ok(cached) = tokio::fs::read(&path).await {
        if cached.len() as u64 == expected_bytes
            && sha256_hex(&cached).eq_ignore_ascii_case(expected_hash)
            && artifact_magic_matches(mime, &cached)
        {
            return Ok(CloudAgentPreview {
                run_id: record.run_id.clone(),
                artifact_id: artifact_id.to_string(),
                path: path.to_string_lossy().into_owned(),
                mime: mime.into(),
                sha256: expected_hash.into(),
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
    if !artifact_magic_matches(mime, &bytes) {
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
        return db
            .get_asset(asset_id)?
            .ok_or_else(|| AppError::Other("Agent 最终资产记录已失效".into()));
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
    record.final_asset_id = Some(asset.id.clone());
    record.updated_at = chrono::Utc::now().timestamp();
    save_record(&db, &record)?;
    let _ = agent_action(
        &cloud,
        &auth,
        json!({ "action": "artifact_received", "artifactId": artifact_id }),
        "确认 Agent 最终图接收失败",
    )
    .await;
    let _ = app.emit("library://assets-changed", ());
    Ok(asset)
}

fn existing_agent_asset(db: &Database, source: &std::path::Path) -> Result<Option<Asset>, AppError> {
    let origin = source.to_string_lossy().into_owned();
    let id = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM assets WHERE source='bowerbird-agent' AND origin_path=?1 ORDER BY created_at DESC LIMIT 1",
            [&origin],
            |row| row.get::<_, String>(0),
        ).optional()?
    };
    id.map(|asset_id| db.get_asset(&asset_id)).transpose().map(|value| value.flatten()).map_err(AppError::from)
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
        return Err(AppError::Other("只有已接受且完成结算的 Agent 会话可以入库".into()));
    }
    let generated: Vec<(String, String)> = record.snapshot
        .get("artifacts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let role = item.get("role")?.as_str()?;
            let id = item.get("id")?.as_str()?;
            (matches!(role, "control_reference" | "stage_result" | "final_result")
                && item.get("user_visible").and_then(Value::as_bool) != Some(false)
                && item.get("mime").and_then(Value::as_str).is_some_and(|mime| mime.starts_with("image/")))
                .then(|| (id.to_string(), role.to_string()))
        })
        .collect();
    if generated.is_empty() {
        return Err(AppError::Other("Agent 会话没有可入库的图片产物".into()));
    }

    let mut assets = Vec::with_capacity(generated.len());
    for (artifact_id, role) in generated {
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
        if role == "final_result" {
            record.final_asset_id = Some(asset.id.clone());
        }
        save_record(&db, &record)?;
        let _ = agent_action(
            &cloud,
            &auth,
            json!({ "action": "artifact_received", "artifactId": artifact_id }),
            "确认 Agent 图片接收失败",
        )
        .await;
        assets.push(asset);
    }
    db.record_generation_conversation(&record.conversation_id, &record.conversation_id)?;
    let _ = app.emit("library://assets-changed", ());
    Ok(assets)
}

#[cfg(test)]
mod tests {
    use super::{
        list_records, nearest_ratio, normalize_intent_prompt, normalize_requested_ratio,
        record_from_row, save_record, CloudAgentReferenceRequest, CloudAgentRunRecord,
    };
    use crate::db::Database;
    use serde_json::json;

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
    fn cloud_agent_checkpoint_uses_its_own_local_table() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let record = CloudAgentRunRecord {
            run_id: "run-1".into(),
            conversation_id: "conv-1".into(),
            skill_id: "bowerbird-controlled-image-edit".into(),
            status: "queued".into(),
            intent_prompt: "换背景".into(),
            reference_asset_ids: vec![],
            project_id: None,
            snapshot: json!({"run":{"status":"queued"}}),
            feedback_action: None,
            final_asset_id: None,
            created_at: 1,
            updated_at: 1,
        };
        save_record(&db, &record).unwrap();
        let conn = db.conn.lock().unwrap();
        let loaded = conn.query_row(
            "SELECT run_id, conversation_id, skill_id, status, intent_prompt, reference_asset_ids, project_id, snapshot_json, feedback_action, final_asset_id, created_at, updated_at FROM cloud_agent_runs WHERE run_id='run-1'",
            [], record_from_row,
        ).unwrap();
        assert_eq!(loaded.conversation_id, "conv-1");
        let task_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_queue", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_count, 0);
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
