//! SQLite 访问层。磁盘库的前台浏览从独立的 WAL 只读连接读取。

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::error::{AppError, AppResult};

pub mod migrations;
mod classification_presets;

const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_millis(5000);

pub struct Database {
    // Close the reader before the writer so it does not hold the WAL open at shutdown.
    browser: Option<Mutex<Connection>>,
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> AppResult<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    pub(crate) fn from_connection(conn: Connection) -> AppResult<Self> {
        conn.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
        // WAL 提升并发读；外键约束开。
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let browser = conn
            .path()
            .filter(|path| !path.is_empty())
            .map(|path| Self::read_only_connection(Path::new(path)))
            .transpose()?
            .map(Mutex::new);
        Ok(Self {
            browser,
            conn: Mutex::new(conn),
        })
    }

    pub fn open_read_only(path: &Path) -> AppResult<Self> {
        Ok(Self {
            browser: None,
            conn: Mutex::new(Self::read_only_connection(path)?),
        })
    }

    fn read_only_connection(path: &Path) -> AppResult<Connection> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        Ok(conn)
    }

    pub(crate) fn browser_connection(&self) -> MutexGuard<'_, Connection> {
        self.browser.as_ref().unwrap_or(&self.conn).lock().unwrap()
    }

    /// 内存库（用于测试 / 临时会话）。
    pub fn open_in_memory() -> AppResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
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
    fn sets_busy_timeout_on_writer_and_read_only_connections() {
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("library.db");
        let conn = Connection::open(&path).unwrap();
        conn.busy_timeout(Duration::ZERO).unwrap();
        let writer = Database::from_connection(conn).unwrap();
        let reader = Database::open_read_only(&path).unwrap();
        let check_timeout = |conn: &Connection| {
            let timeout_ms: i64 = conn
                .pragma_query_value(None, "busy_timeout", |row| row.get(0))
                .unwrap();
            assert_eq!(timeout_ms, 5000);
        };
        check_timeout(&writer.conn.lock().unwrap());
        check_timeout(&writer.browser_connection());
        check_timeout(&reader.browser_connection());
        assert!(writer
            .browser_connection()
            .is_readonly(rusqlite::DatabaseName::Main)
            .unwrap());
    }

    #[test]
    fn memory_browser_reuses_the_existing_connection() {
        let db = Database::open_in_memory().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute_batch("CREATE TABLE fixture(id); INSERT INTO fixture VALUES(7)")
            .unwrap();
        let number: i64 = db
            .browser_connection()
            .query_row("SELECT id FROM fixture", [], |row| row.get(0))
            .unwrap();
        assert_eq!(number, 7);
    }

    #[test]
    fn read_only_connection_waits_for_a_short_exclusive_wal_lock() {
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("library.db");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL;
                 CREATE TABLE canvas(id INTEGER); INSERT INTO canvas VALUES (1);",
            )
            .unwrap();
        let reader = Database::open_read_only(&path).unwrap();
        let probe = Database::open_read_only(&path).unwrap();
        {
            let conn = probe.conn.lock().unwrap();
            conn.busy_timeout(Duration::ZERO).unwrap();
            let error = conn
                .query_row("SELECT id FROM canvas", [], |row| row.get::<_, i64>(0))
                .unwrap_err();
            assert_eq!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy)
            );
        }
        drop(probe);

        let (started, start) = std::sync::mpsc::channel();
        let (finished, finish) = std::sync::mpsc::channel();
        let read = std::thread::spawn(move || {
            started.send(()).unwrap();
            let conn = reader.conn.lock().unwrap();
            let result = conn.query_row("SELECT id FROM canvas", [], |row| row.get::<_, i64>(0));
            finished.send(result).unwrap();
        });
        start.recv_timeout(Duration::from_secs(2)).unwrap();
        let while_locked = finish.recv_timeout(Duration::from_millis(100));
        drop(writer);
        assert!(matches!(
            while_locked,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        assert_eq!(finish.recv_timeout(Duration::from_secs(3)).unwrap().unwrap(), 1);
        read.join().unwrap();
    }

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
