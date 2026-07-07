//! 数据库迁移。
//! - `0001_init.sql`：§4.2 全部表
//! - `0002_fts.sql`：FTS5 同步触发器 + 存量回填
//! - `0003_templates.sql`：维度模板 seed（后交互收敛，由 0004 清空）
//! - `0004_templates_clear.sql`：清空 seed 模板行（创作板改用前端维度标签 + 图 caption）

use rusqlite_migration::{M, Migrations};

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("../../sql/0001_init.sql")),
        M::up(include_str!("../../sql/0002_fts.sql")),
        M::up(include_str!("../../sql/0003_templates.sql")),
        M::up(include_str!("../../sql/0004_templates_clear.sql")),
    ])
}
