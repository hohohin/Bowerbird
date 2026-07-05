//! 数据库迁移。
//! - `0001_init.sql`：§4.2 全部表
//! - `0002_fts.sql`：FTS5 同步触发器 + 存量回填

use rusqlite_migration::{M, Migrations};

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("../../sql/0001_init.sql")),
        M::up(include_str!("../../sql/0002_fts.sql")),
    ])
}
