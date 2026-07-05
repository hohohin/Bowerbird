//! Tauri commands（前端 invoke 入口）。

pub mod codex;
pub mod library;
pub mod prompt;

use std::sync::Arc;

use tauri::State;

use crate::core::task_queue::{Task, TaskStatus};
use crate::db::Database;
use crate::error::AppError;

/// 简单回显，验证 invoke 双向通信。
#[tauri::command]
pub async fn ping(name: String) -> Result<String, AppError> {
    Ok(format!("pong, {name}"))
}

/// 数据库健康：表数 + FTS5 是否启用 + 队列计数。
#[tauri::command]
pub async fn db_health(db: State<'_, Arc<Database>>) -> Result<String, AppError> {
    let tables = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
            [],
            |r| r.get::<_, i64>(0),
        )?
    };
    let fts5 = db.fts5_enabled()?;
    let queued = Task::count(&db, TaskStatus::Queued).unwrap_or(0);
    Ok(format!(
        "tables={tables} | fts5={fts5} | queued_tasks={queued}"
    ))
}
