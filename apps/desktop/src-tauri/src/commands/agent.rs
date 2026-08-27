use std::{path::PathBuf, process::Stdio, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::{io::AsyncWriteExt, process::Command, time::Duration};

use crate::{db::Database, error::AppError};

const SKILL_ID: &str = "smart-refinement";
const SMART_REFINEMENT_ENTRYPOINT: &str = "src/local/cli.ts";
const PROMPT_AGENT_ENTRYPOINT: &str = "src/local/prompt-agent-cli.ts";
const MAX_CHECKPOINT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalAgentRun {
    pub id: String,
    pub skill_id: String,
    pub target_asset_id: String,
    pub status: String,
    pub phase: String,
    pub checkpoint: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

fn ensure_preview_enabled() -> Result<(), AppError> {
    if cfg!(debug_assertions) {
        Ok(())
    } else {
        Err(AppError::Other("本机 Agent 预览仅在开发构建中开放".into()))
    }
}

pub(crate) fn worker_dir() -> Result<PathBuf, AppError> {
    if let Some(path) = std::env::var_os("BOWERBIRD_AGENT_WORKER_DIR") {
        let candidate = PathBuf::from(path);
        if candidate.join("src/local/cli.ts").is_file() {
            return Ok(candidate);
        }
    }
    let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../agent-worker");
    if candidate.join("src/local/cli.ts").is_file() {
        return Ok(candidate);
    }
    Err(AppError::Other(
        "未找到 apps/agent-worker；可设置 BOWERBIRD_AGENT_WORKER_DIR".into(),
    ))
}

async fn invoke_worker(entrypoint: &str, payload: Value) -> Result<Value, AppError> {
    ensure_preview_enabled()?;
    let dir = worker_dir()?;
    let env_file = dir.join("../cloud/.env");
    if !env_file.is_file() {
        return Err(AppError::Other(
            "缺少 apps/cloud/.env，无法读取本机 DeepSeek 配置".into(),
        ));
    }
    if entrypoint != SMART_REFINEMENT_ENTRYPOINT && entrypoint != PROMPT_AGENT_ENTRYPOINT {
        return Err(AppError::Other("未知的本机 Agent 入口".into()));
    }
    let mut child = Command::new("node")
        .arg(format!("--env-file={}", env_file.display()))
        .arg(entrypoint)
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| AppError::Other(format!("启动本机 Agent Worker 失败: {error}")))?;
    let input = serde_json::to_vec(&payload)
        .map_err(|error| AppError::Other(format!("序列化 Agent checkpoint 失败: {error}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&input)
            .await
            .map_err(|error| AppError::Other(format!("写入 Agent Worker 失败: {error}")))?;
    }
    let output = tokio::time::timeout(Duration::from_secs(90), child.wait_with_output())
        .await
        .map_err(|_| AppError::Other("DeepSeek 回合超时".into()))?
        .map_err(|error| AppError::Other(format!("等待 Agent Worker 失败: {error}")))?;
    if !output.status.success() {
        let safe = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Other(if safe.is_empty() {
            "本机 Agent Worker 执行失败".into()
        } else {
            format!("本机 Agent Worker 执行失败: {safe}")
        }));
    }
    if output.stdout.len() > MAX_CHECKPOINT_BYTES {
        return Err(AppError::Other("Agent checkpoint 超过本机预览上限".into()));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| AppError::Other(format!("解析 Agent Worker 响应失败: {error}")))
}

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalAgentRun> {
    let checkpoint_json: String = row.get(5)?;
    let checkpoint = serde_json::from_str(&checkpoint_json).unwrap_or(Value::Null);
    Ok(LocalAgentRun {
        id: row.get(0)?,
        skill_id: row.get(1)?,
        target_asset_id: row.get(2)?,
        status: row.get(3)?,
        phase: row.get(4)?,
        checkpoint,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn load_run(db: &Database, run_id: &str) -> Result<LocalAgentRun, AppError> {
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT id, skill_id, target_asset_id, status, phase, checkpoint_json, created_at, updated_at FROM local_agent_runs WHERE id=?1",
        [run_id],
        row_to_run,
    )
    .map_err(AppError::from)
}

fn save_run(db: &Database, run: &LocalAgentRun) -> Result<(), AppError> {
    let encoded = serde_json::to_string(&run.checkpoint)
        .map_err(|error| AppError::Other(format!("序列化 Agent checkpoint 失败: {error}")))?;
    if encoded.len() > MAX_CHECKPOINT_BYTES {
        return Err(AppError::Other("Agent checkpoint 超过本机预览上限".into()));
    }
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO local_agent_runs (id, skill_id, target_asset_id, status, phase, checkpoint_json, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET status=excluded.status, phase=excluded.phase, checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at",
        rusqlite::params![run.id, run.skill_id, run.target_asset_id, run.status, run.phase, encoded, run.created_at, run.updated_at],
    )?;
    Ok(())
}

fn run_from_checkpoint(
    id: String,
    target_asset_id: String,
    checkpoint: Value,
    created_at: i64,
) -> Result<LocalAgentRun, AppError> {
    let status = checkpoint
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Other("Agent checkpoint 缺少 status".into()))?
        .to_string();
    let phase = checkpoint
        .get("phase")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Other("Agent checkpoint 缺少 phase".into()))?
        .to_string();
    Ok(LocalAgentRun {
        id,
        skill_id: SKILL_ID.into(),
        target_asset_id,
        status,
        phase,
        checkpoint,
        created_at,
        updated_at: chrono::Utc::now().timestamp(),
    })
}

#[tauri::command]
pub async fn local_agent_health() -> Result<bool, AppError> {
    ensure_preview_enabled()?;
    Ok(worker_dir()?.join("../cloud/.env").is_file())
}

#[tauri::command]
pub async fn local_agent_start(
    db: State<'_, Arc<Database>>,
    asset_id: String,
    goal: String,
    project_id: Option<String>,
    visual_profile_id: Option<String>,
) -> Result<LocalAgentRun, AppError> {
    ensure_preview_enabled()?;
    let goal = goal.trim();
    if goal.is_empty() || goal.chars().count() > 4_000 {
        return Err(AppError::Other("精修目标须为 1–4000 个字符".into()));
    }
    if db.get_asset(&asset_id)?.is_none() {
        return Err(AppError::Other("目标素材不存在".into()));
    }
    let caption = db.latest_caption_text(&asset_id)?;
    if caption.as_deref().unwrap_or("").trim().is_empty() {
        return Err(AppError::Other(
            "请先对这张图执行一次反推，再启动智能精修".into(),
        ));
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
    let id = format!("local_{}", ulid::Ulid::new());
    let now = chrono::Utc::now().timestamp();
    let checkpoint = json!({
        "schemaVersion": 1,
        "runId": id,
        "input": {
            "targetAssetId": asset_id,
            "goal": goal,
            "caption": caption,
            "referenceAssetIds": [],
            "visualProfileCapsule": visual_profile_capsule
        },
        "phase": "parse_intent",
        "status": "running",
        "records": [],
        "modelTurnCount": 0,
        "generateAttemptCount": 0,
        "spentCredits": 0
    });
    let advanced = invoke_worker(
        SMART_REFINEMENT_ENTRYPOINT,
        json!({ "checkpoint": checkpoint }),
    )
    .await?;
    let run = run_from_checkpoint(id, asset_id, advanced, now)?;
    save_run(&db, &run)?;
    Ok(run)
}

#[tauri::command]
pub async fn local_agent_compile_prompt(input: Value) -> Result<Value, AppError> {
    ensure_preview_enabled()?;
    input
        .get("originalPrompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= 12_000)
        .ok_or_else(|| AppError::Other("Agent 模式需要有效的原始 prompt".into()))?;
    input
        .get("references")
        .and_then(Value::as_array)
        .filter(|items| items.len() <= 8)
        .ok_or_else(|| AppError::Other("Agent 模式最多处理 8 张参考图".into()))?;
    let result = invoke_worker(PROMPT_AGENT_ENTRYPOINT, input).await?;
    result
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Other("Agent 没有返回可用 prompt".into()))?;
    Ok(result)
}

#[tauri::command]
pub async fn local_agent_resume(
    db: State<'_, Arc<Database>>,
    run_id: String,
    approval: Option<bool>,
    tool_result: Option<Value>,
) -> Result<LocalAgentRun, AppError> {
    ensure_preview_enabled()?;
    let existing = load_run(&db, &run_id)?;
    if existing.skill_id != SKILL_ID {
        return Err(AppError::Other(
            "该旧版 Agent Run 已停止支持继续执行".into(),
        ));
    }
    let mut payload = json!({ "checkpoint": existing.checkpoint });
    if let Some(value) = approval {
        payload["approval"] = json!(value);
    }
    if let Some(value) = tool_result {
        payload["toolResult"] = value;
    }
    let advanced = invoke_worker(SMART_REFINEMENT_ENTRYPOINT, payload).await?;
    let run = run_from_checkpoint(
        existing.id,
        existing.target_asset_id,
        advanced,
        existing.created_at,
    )?;
    save_run(&db, &run)?;
    Ok(run)
}

#[tauri::command]
pub async fn local_agent_latest(
    db: State<'_, Arc<Database>>,
    asset_id: String,
) -> Result<Option<LocalAgentRun>, AppError> {
    ensure_preview_enabled()?;
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, skill_id, target_asset_id, status, phase, checkpoint_json, created_at, updated_at FROM local_agent_runs WHERE target_asset_id=?1 AND skill_id=?2 ORDER BY updated_at DESC LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![asset_id, SKILL_ID])?;
    match rows.next()? {
        Some(row) => Ok(Some(row_to_run(row)?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn local_agent_find_asset_id(
    db: State<'_, Arc<Database>>,
    store_path: String,
) -> Result<Option<String>, AppError> {
    ensure_preview_enabled()?;
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT id FROM assets WHERE store_path=?1 LIMIT 1")?;
    let mut rows = stmt.query([store_path])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{load_run, run_from_checkpoint, save_run};
    use crate::db::Database;
    use serde_json::json;

    #[test]
    fn local_agent_checkpoint_uses_separate_table() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO assets (id, name) VALUES ('asset-1', 'a')", [])
            .unwrap();
        drop(conn);
        let run = run_from_checkpoint(
            "run-1".into(),
            "asset-1".into(),
            json!({"status":"awaiting_approval","phase":"decide_refine"}),
            1,
        )
        .unwrap();
        save_run(&db, &run).unwrap();
        let loaded = load_run(&db, "run-1").unwrap();
        assert_eq!(loaded.status, "awaiting_approval");
        let conn = db.conn.lock().unwrap();
        let task_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_queue", [], |row| row.get(0))
            .unwrap();
        assert_eq!(task_count, 0);
    }
}
