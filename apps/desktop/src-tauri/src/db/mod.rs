//! SQLite 访问层。`Database` 持有单连接（Mutex 保护）。
//! Phase 0：单连接够用；后续若成瓶颈再换 r2d2 连接池。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};

use crate::error::{AppError, AppResult};

pub mod migrations;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        let conn = Connection::open(path)?;
        // WAL 提升并发读；外键约束开。
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_read_only(path: &Path) -> AppResult<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 内存库（用于测试 / 临时会话）。
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn migrate(&self) -> AppResult<()> {
        let mut conn = self.conn.lock().unwrap();
        reject_unpublished_creative_session_lineage(&conn)?;
        migrations::migrations().to_latest(&mut conn)?;
        Ok(())
    }

    /// FTS5 是否在编译期启用（验证 bundled 生效）。
    pub fn fts5_enabled(&self) -> AppResult<bool> {
        // `PRAGMA compile_options` 返回单列 `compile_options`，每行一个选项字符串。
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'",
            [],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }
}

fn sqlite_table_exists(conn: &Connection, table: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )?)
}

/// 旧 CANVAS-SESSION-PLAN 曾在开发副本占用 v21-v23。正式版本现在用相同落号承载
/// PROJECT-CANVAS-PLAN，因此不能只看 `user_version`：命中旧表指纹时必须从 v20
/// Online Backup 重建，绝不能把两套不可兼容的事实源拼在同一个库里。
fn reject_unpublished_creative_session_lineage(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if !(21..=23).contains(&version) {
        return Ok(());
    }
    let has_old_sessions = sqlite_table_exists(conn, "creative_sessions")?;
    let has_project_canvases = sqlite_table_exists(conn, "project_canvases")?;
    if has_old_sessions || !has_project_canvases {
        return Err(AppError::Other(format!(
            "检测到未发布的一画板一会话开发库 schema v{version}；请丢弃该开发副本，并从 schema v20 的 SQLite Online Backup 重建项目画板库"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_old_v21_v23_creative_session_fingerprint() {
        for version in 21..=23 {
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(&format!(
                "PRAGMA user_version={version}; CREATE TABLE creative_sessions(id TEXT PRIMARY KEY);"
            ))
            .unwrap();
            let error = reject_unpublished_creative_session_lineage(&conn).unwrap_err();
            assert!(error.to_string().contains("Online Backup"));
        }
    }

    #[test]
    fn accepts_v20_and_current_project_canvas_fingerprint() {
        let v20 = Connection::open_in_memory().unwrap();
        v20.execute_batch("PRAGMA user_version=20;").unwrap();
        reject_unpublished_creative_session_lineage(&v20).unwrap();

        let current = Connection::open_in_memory().unwrap();
        current
            .execute_batch("PRAGMA user_version=23; CREATE TABLE project_canvases(project_id TEXT PRIMARY KEY);")
            .unwrap();
        reject_unpublished_creative_session_lineage(&current).unwrap();
    }
}
