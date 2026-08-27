//! 持久化任务队列（开发计划 §3.2 / §5.5；视频生成 spec Phase A）。
//!
//! codex/即梦 生成调用进 SQLite 队列，支持取消 / 重试 / 并发上限 / 恢复；
//! 单个生成子进程崩溃/超时不拖垮主进程。
//!
//! Phase 0：入队 / 取下一个 / 状态流转的基础原语。
//! Phase 3：接入 codex worker（消费队列 → 调 provider → 落库结果）。
//! Phase A（视频 spec task 1）：GenJob（生成任务）承载 + 取消 / 按 id / 列未完成 / 列最近。

use chrono::Utc;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::db::Database;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl TaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Queued => "queued",
            TaskStatus::Running => "running",
            TaskStatus::Done => "done",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub kind: String,
    pub payload: String, // JSON
    pub status: String,
    pub attempts: i64,
    pub max_attempts: i64,
    pub error: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub provider: Option<String>,
}

/// 生成任务（视频生成 spec）。序列化进 `task_queue.payload`（`kind="generation"`）。
///
/// `status` 是细粒度（供前端展示任务阶段）；`task_queue.status` 列存粗粒度（供调度查询），
/// 映射见 [`GenJob::coarse_status`]。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenJob {
    pub id: String,
    pub media: String,    // "image" | "video"
    pub provider: String, // "codex" | "jimeng"
    pub status: String, // queued|submitting|running|querying|downloading|ingesting|done|failed|cancelled_local
    pub prompt: String,
    /// 本轮真正提交给 provider 的最终指令（含视觉设定注入与 provider 包装）。
    /// 单独持久化，避免以后 PromptCompiler 变化导致历史回看失真。
    #[serde(default)]
    pub applied_prompt: Option<String>,
    #[serde(default)]
    pub references: Vec<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    /// 会话级分组（「重新编辑 / 重试」版本分支）：归入源会话（根 job id）；普通 job = None。
    /// done 入库时据此写 generation_conversations（session → conversation 映射）。
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// 首轮项目快照（恢复时把资产 link 回项目；codex_create_image 入队时填）。
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub ratio: Option<String>,
    /// V4：首轮冻结的已确认项目视觉设定。续轮/恢复始终复用该版本，不能跟随当前项目新版本漂移。
    #[serde(default)]
    pub visual_profile: Option<crate::core::visual_profile::VisualProfileCapsule>,
    #[serde(default)]
    pub submit_id: Option<String>,
    #[serde(default)]
    pub video_options: Option<serde_json::Value>, // Phase B（task 7）强类型化为 VideoOptions
    #[serde(default)]
    pub turns: serde_json::Value, // 前端轮次数组透传
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub queue_idx: Option<i64>,
    pub created_at: i64,
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub finished_at: Option<i64>,
}

impl GenJob {
    /// 细粒度 status → `task_queue.status` 列粗粒度（调度查询用）。
    pub fn coarse_status(fine: &str) -> &'static str {
        match fine {
            "done" => "done",
            "failed" => "failed",
            "cancelled_local" | "cancelled" => "cancelled",
            "queued" | "submitting" => "queued",
            _ => "running", // running|querying|downloading|ingesting
        }
    }
}

const TASK_COLS: &str = "id, kind, payload, status, attempts, max_attempts, error,
        created_at, started_at, finished_at, provider";

fn row_to_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        kind: r.get(1)?,
        payload: r.get(2)?,
        status: r.get(3)?,
        attempts: r.get(4)?,
        max_attempts: r.get(5)?,
        error: r.get(6)?,
        created_at: r.get(7)?,
        started_at: r.get(8)?,
        finished_at: r.get(9)?,
        provider: r.get(10)?,
    })
}

impl Task {
    /// 入队一个新任务（通用），返回新 id。
    pub fn enqueue(
        db: &Database,
        kind: &str,
        payload: &serde_json::Value,
        provider: Option<&str>,
    ) -> AppResult<String> {
        let id = Ulid::new().to_string();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO task_queue (id, kind, payload, status, created_at, provider)
             VALUES (?1, ?2, ?3, 'queued', ?4, ?5)",
            rusqlite::params![
                &id,
                kind,
                &payload.to_string(),
                Utc::now().timestamp(),
                provider
            ],
        )?;
        Ok(id)
    }

    /// 入队一个生成 job：payload 为 `GenJob` 序列化；`status`/`provider` 同步写列（粗粒度）。
    /// 主键用 `job.id`（前端 / worker / cancel 一致引用）。
    pub fn enqueue_gen_job(db: &Database, job: &GenJob) -> AppResult<String> {
        let coarse = GenJob::coarse_status(&job.status);
        let payload = serde_json::to_string(job)?;
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO task_queue (id, kind, payload, status, created_at, started_at, finished_at, provider)
             VALUES (?1, 'generation', ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![&job.id, &payload, coarse, job.created_at, job.started_at, job.finished_at, &job.provider],
        )?;
        Ok(job.id.clone())
    }

    /// 入队或覆盖一个生成 job（按 `job.id` upsert）。
    ///
    /// 首轮 INSERT 新行；续轮（同一会话 = 同一 `job_id` 再次 `codex_create_image`）ON CONFLICT
    /// 更新现有行：刷新 payload/status/started_at/provider，清空 finished_at/error，让会话级 job
    /// 重新进入 running。前端 `GenJob` = 一个生成会话（多轮），`task_queue` 行随会话级 job_id 复用，
    /// 故续轮不能再 INSERT（主键冲突）。
    pub fn upsert_gen_job(db: &Database, job: &GenJob) -> AppResult<String> {
        let coarse = GenJob::coarse_status(&job.status);
        let payload = serde_json::to_string(job)?;
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO task_queue (id, kind, payload, status, created_at, started_at, finished_at, provider)
             VALUES (?1, 'generation', ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                payload=excluded.payload,
                status=excluded.status,
                started_at=excluded.started_at,
                finished_at=excluded.finished_at,
                error=NULL,
                provider=excluded.provider",
            rusqlite::params![&job.id, &payload, coarse, job.created_at, job.started_at, job.finished_at, &job.provider],
        )?;
        Ok(job.id.clone())
    }

    /// 取下一个 queued 任务（按 created_at 升序）。
    pub fn next(db: &Database) -> AppResult<Option<Task>> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {TASK_COLS} FROM task_queue WHERE status = 'queued'
             ORDER BY created_at ASC LIMIT 1"
        ))?;
        let mut rows = stmt.query([])?;
        if let Some(r) = rows.next()? {
            Ok(Some(row_to_task(r)?))
        } else {
            Ok(None)
        }
    }

    /// 把任务标记为 running（开始执行）。
    pub fn mark_running(db: &Database, id: &str) -> AppResult<()> {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE task_queue SET status='running', started_at=?1, attempts=attempts+1 WHERE id=?2",
            rusqlite::params![Utc::now().timestamp(), id],
        )?;
        Ok(())
    }

    /// 任务完成。
    pub fn mark_done(db: &Database, id: &str) -> AppResult<()> {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE task_queue SET status='done', finished_at=?1 WHERE id=?2",
            rusqlite::params![Utc::now().timestamp(), id],
        )?;
        Ok(())
    }

    /// 任务失败（若未达 max_attempts，下次 next() 仍不会被取 —— 这里只记 error）。
    pub fn mark_failed(db: &Database, id: &str, err: &str) -> AppResult<()> {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE task_queue SET status='failed', finished_at=?1, error=?2 WHERE id=?3",
            rusqlite::params![Utc::now().timestamp(), err, id],
        )?;
        Ok(())
    }

    /// 取消任务（本地）：保留行与 payload（含 `submit_id`）便于事后取回，仅置状态。
    pub fn mark_cancelled(db: &Database, id: &str) -> AppResult<()> {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE task_queue SET status='cancelled', finished_at=?1 WHERE id=?2",
            rusqlite::params![Utc::now().timestamp(), id],
        )?;
        Ok(())
    }

    /// 删除一个终态（done/failed/cancelled）任务行：会话面板「移除会话记录」持久化用，
    /// 让 `recent_gen_sessions` 重启恢复不再出现该会话。仅终态可删（queued/running 行是
    /// 启动恢复的数据源，正在跑的会话移除只动前端内存）；行不存在为空操作。
    /// 生成图资产与 generation_meta 不受影响（按图「回看生成对话」仍可用）。
    pub fn delete_terminal(db: &Database, id: &str) -> AppResult<()> {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM task_queue WHERE id=?1 AND status IN ('done','failed','cancelled')",
            rusqlite::params![id],
        )?;
        Ok(())
    }

    /// 按 id 查单个任务。
    pub fn by_id(db: &Database, id: &str) -> AppResult<Option<Task>> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {TASK_COLS} FROM task_queue WHERE id=?1 LIMIT 1"
        ))?;
        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(r) = rows.next()? {
            Ok(Some(row_to_task(r)?))
        } else {
            Ok(None)
        }
    }

    /// 列出未完成（`queued`/`running`）的任务：启动恢复用。
    pub fn list_running(db: &Database) -> AppResult<Vec<Task>> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {TASK_COLS} FROM task_queue WHERE status IN ('queued','running')
             ORDER BY created_at ASC"
        ))?;
        let rows = stmt.query_map([], row_to_task)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 最近 N 个任务（任意状态），按创建时间倒序：任务中心 UI 用。
    pub fn list_recent(db: &Database, limit: i64) -> AppResult<Vec<Task>> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!(
            "SELECT {TASK_COLS} FROM task_queue ORDER BY created_at DESC LIMIT ?1"
        ))?;
        let rows = stmt.query_map(rusqlite::params![limit], row_to_task)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 若本任务是 `generation`，反序列化 payload 为 [`GenJob`]。
    pub fn gen_job(&self) -> Option<GenJob> {
        if self.kind != "generation" {
            return None;
        }
        serde_json::from_str::<GenJob>(&self.payload).ok()
    }

    /// 计数（按状态）。
    pub fn count(db: &Database, status: TaskStatus) -> AppResult<i64> {
        let conn = db.conn.lock().unwrap();
        let c: i64 = conn.query_row(
            "SELECT COUNT(*) FROM task_queue WHERE status=?1",
            rusqlite::params![status.as_str()],
            |r| r.get(0),
        )?;
        Ok(c)
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

    fn job(provider: &str, status: &str) -> GenJob {
        GenJob {
            id: Ulid::new().to_string(),
            media: "image".into(),
            provider: provider.into(),
            status: status.into(),
            prompt: "p".into(),
            applied_prompt: None,
            references: vec![],
            session_id: None,
            conversation_id: None,
            project_id: None,
            ratio: None,
            visual_profile: None,
            submit_id: None,
            video_options: None,
            turns: serde_json::json!([]),
            error: None,
            queue_idx: None,
            created_at: Utc::now().timestamp(),
            started_at: None,
            finished_at: None,
        }
    }

    #[test]
    fn coarse_status_mapping() {
        assert_eq!(GenJob::coarse_status("queued"), "queued");
        assert_eq!(GenJob::coarse_status("submitting"), "queued");
        assert_eq!(GenJob::coarse_status("running"), "running");
        assert_eq!(GenJob::coarse_status("querying"), "running");
        assert_eq!(GenJob::coarse_status("downloading"), "running");
        assert_eq!(GenJob::coarse_status("ingesting"), "running");
        assert_eq!(GenJob::coarse_status("done"), "done");
        assert_eq!(GenJob::coarse_status("failed"), "failed");
        assert_eq!(GenJob::coarse_status("cancelled_local"), "cancelled");
    }

    #[test]
    fn enqueue_gen_job_and_by_id() {
        let db = db();
        let mut j = job("jimeng", "queued");
        j.applied_prompt = Some("p\n\n必须保持：色彩=低饱和".into());
        let id = Task::enqueue_gen_job(&db, &j).unwrap();
        assert_eq!(id, j.id);
        let t = Task::by_id(&db, &id).unwrap().unwrap();
        assert_eq!(t.kind, "generation");
        assert_eq!(t.status, "queued"); // 粗粒度
        assert_eq!(t.provider.as_deref(), Some("jimeng"));
        let g = t.gen_job().unwrap();
        assert_eq!(g.media, "image");
        assert_eq!(g.prompt, "p");
        assert_eq!(
            g.applied_prompt.as_deref(),
            Some("p\n\n必须保持：色彩=低饱和")
        );
    }

    #[test]
    fn submit_id_persisted_in_payload() {
        let db = db();
        let mut j = job("jimeng", "querying");
        j.submit_id = Some("sid-123".into());
        Task::enqueue_gen_job(&db, &j).unwrap();
        let t = Task::by_id(&db, &j.id).unwrap().unwrap();
        // 细粒度 querying → 粗粒度 running
        assert_eq!(t.status, "running");
        assert_eq!(t.gen_job().unwrap().submit_id.as_deref(), Some("sid-123"));
    }

    #[test]
    fn list_running_excludes_terminal() {
        let db = db();
        Task::enqueue_gen_job(&db, &job("jimeng", "queued")).unwrap();
        Task::enqueue_gen_job(&db, &job("codex", "running")).unwrap();
        Task::enqueue_gen_job(&db, &job("jimeng", "done")).unwrap();
        Task::enqueue_gen_job(&db, &job("jimeng", "failed")).unwrap();
        let running = Task::list_running(&db).unwrap();
        assert_eq!(running.len(), 2); // 仅 queued + running
        assert!(running
            .iter()
            .all(|t| t.status == "queued" || t.status == "running"));
    }

    #[test]
    fn list_recent_orders_desc_and_limits() {
        let db = db();
        for i in 0..5 {
            let mut j = job("jimeng", "done");
            j.created_at = 1000 + i;
            j.id = format!("j{i}");
            Task::enqueue_gen_job(&db, &j).unwrap();
        }
        let recent = Task::list_recent(&db, 3).unwrap();
        assert_eq!(recent.len(), 3);
        assert!(recent[0].created_at >= recent[1].created_at);
    }

    #[test]
    fn delete_terminal_only_removes_terminal_rows() {
        // 会话面板移除已完成会话的持久化：终态行（done/failed/cancelled）可删，
        // 在跑行（启动恢复数据源）与不存在的 id 不受影响。
        let db = db();
        let done = job("jimeng", "done");
        let failed = job("codex", "failed");
        let running = job("codex", "running");
        Task::enqueue_gen_job(&db, &done).unwrap();
        Task::enqueue_gen_job(&db, &failed).unwrap();
        Task::enqueue_gen_job(&db, &running).unwrap();

        Task::delete_terminal(&db, &done.id).unwrap();
        assert!(Task::by_id(&db, &done.id).unwrap().is_none());

        Task::delete_terminal(&db, &running.id).unwrap();
        assert!(
            Task::by_id(&db, &running.id).unwrap().is_some(),
            "在跑行不可删"
        );

        Task::delete_terminal(&db, "no-such-row").unwrap(); // 空操作不报错
        assert!(Task::by_id(&db, &failed.id).unwrap().is_some());
    }

    #[test]
    fn mark_cancelled_keeps_row_for_recovery() {
        let db = db();
        let mut j = job("jimeng", "querying");
        j.submit_id = Some("sid-keep".into());
        Task::enqueue_gen_job(&db, &j).unwrap();
        Task::mark_cancelled(&db, &j.id).unwrap();
        let t = Task::by_id(&db, &j.id).unwrap().unwrap();
        assert_eq!(t.status, "cancelled");
        // submit_id 仍在 payload（事后取回）
        assert_eq!(t.gen_job().unwrap().submit_id.as_deref(), Some("sid-keep"));
        // cancelled 不进 list_running
        assert!(Task::list_running(&db).unwrap().is_empty());
    }

    #[test]
    fn gen_job_returns_none_for_non_generation() {
        let db = db();
        let id = Task::enqueue(&db, "other", &serde_json::json!({}), None).unwrap();
        let t = Task::by_id(&db, &id).unwrap().unwrap();
        assert_eq!(t.kind, "other");
        assert!(t.gen_job().is_none());
    }

    #[test]
    fn upsert_gen_job_reuses_row_on_revise() {
        let db = db();
        // 首轮：INSERT 新行（running）。
        let mut j = job("codex", "running");
        j.started_at = Some(j.created_at);
        Task::upsert_gen_job(&db, &j).unwrap();
        let t1 = Task::by_id(&db, &j.id).unwrap().unwrap();
        assert_eq!(t1.status, "running");
        // 完成 → done。
        Task::mark_done(&db, &j.id).unwrap();
        assert_eq!(Task::by_id(&db, &j.id).unwrap().unwrap().status, "done");
        // 续轮：同 job_id 再次 upsert（running），不冲突；行被刷新回 running，error 清空。
        j.status = "running".into();
        j.error = None;
        Task::upsert_gen_job(&db, &j).unwrap();
        let t2 = Task::by_id(&db, &j.id).unwrap().unwrap();
        assert_eq!(t2.status, "running");
        assert!(t2.error.is_none());
        // 仍是同一行（不会因续轮多出新行）。
        assert_eq!(Task::list_recent(&db, 10).unwrap().len(), 1);
    }
}
