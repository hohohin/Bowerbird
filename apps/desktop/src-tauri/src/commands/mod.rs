//! Tauri commands（前端 invoke 入口）。

pub mod codex;
pub mod library;
pub mod prompt;

use std::sync::Arc;

use tauri::State;

use crate::codex::mock::MockProvider;
use crate::codex::types::CodexRequest;
use crate::codex::CodexProvider;
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

/// Codex 通路：用 MockProvider 跑一次，验证 trait + 类型流转。
#[tauri::command]
pub async fn codex_health() -> Result<String, AppError> {
    let provider = MockProvider::default();
    let req = CodexRequest {
        instruction: "描述这张参考图的构图与配色".to_string(),
        reference_images: vec!["/tmp/sample.png".into()],
        context_prompts: vec!["cyberpunk city".to_string()],
        output_schema: None,
    };
    let r = provider.run(req).await?;
    let head: String = r.text.chars().take(80).collect();
    Ok(format!("[{}] {}ms — {}", r.provider, r.elapsed_ms, head))
}
