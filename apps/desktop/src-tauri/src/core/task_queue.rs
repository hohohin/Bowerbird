//! 持久化任务队列（开发计划 §3.2 / §5.5）。
//!
//! codex 调用进 SQLite 队列，支持取消 / 重试 / 并发上限；
//! 单个 codex 子进程崩溃/超时不拖垮主进程。
//!
//! Phase 0：入队 / 取下一个 / 状态流转的基础原语。
//! Phase 3：接入 codex worker（消费队列 → 调 provider → 落库结果）。

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

impl Task {
    /// 入队一个新任务，返回新 id。
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
            rusqlite::params![&id, kind, &payload.to_string(), Utc::now().timestamp(), provider],
        )?;
        Ok(id)
    }

    /// 取下一个 queued 任务（按 created_at 升序）。
    pub fn next(db: &Database) -> AppResult<Option<Task>> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, payload, status, attempts, max_attempts, error,
                    created_at, started_at, finished_at, provider
             FROM task_queue WHERE status = 'queued'
             ORDER BY created_at ASC LIMIT 1",
        )?;
        let mut rows = stmt.query([])?;
        if let Some(r) = rows.next()? {
            Ok(Some(Task {
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
            }))
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
