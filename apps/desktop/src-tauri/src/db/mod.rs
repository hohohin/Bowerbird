//! SQLite 访问层。`Database` 持有单连接（Mutex 保护）。
//! Phase 0：单连接够用；后续若成瓶颈再换 r2d2 连接池。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::AppResult;

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
