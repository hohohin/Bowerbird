//! 数据库迁移。
//! - `0001_init.sql`：§4.2 全部表
//! - `0002_fts.sql`：FTS5 同步触发器 + 存量回填
//! - `0003_templates.sql`：维度模板 seed（后交互收敛，由 0004 清空）
//! - `0004_templates_clear.sql`：清空 seed 模板行（创作板改用前端维度标签 + 图 caption）
//! - `0005_tags_source.sql`：tags 加 source 列 + seed 预置自动归类词表（P2）
//! - `0006_color_buckets.sql`：asset_colors 颜色量化桶表（P3）
//! - `0007_generation_groups.sql`：assets 加 generation_session_id + 回填（生成图同流程合并）
//! - `0008_collections.sql`：多对多收藏夹（folders.kind='collection' + asset_collections）
//! - `0009_presets.sql`：创作板「用途」预设（presets 表，命名 prompt 片段，发送时注入）

use rusqlite_migration::{M, Migrations};

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        M::up(include_str!("../../sql/0001_init.sql")),
        M::up(include_str!("../../sql/0002_fts.sql")),
        M::up(include_str!("../../sql/0003_templates.sql")),
        M::up(include_str!("../../sql/0004_templates_clear.sql")),
        M::up(include_str!("../../sql/0005_tags_source.sql")),
        M::up(include_str!("../../sql/0006_color_buckets.sql")),
        M::up(include_str!("../../sql/0007_generation_groups.sql")),
        M::up(include_str!("../../sql/0008_collections.sql")),
        M::up(include_str!("../../sql/0009_presets.sql")),
    ])
}
