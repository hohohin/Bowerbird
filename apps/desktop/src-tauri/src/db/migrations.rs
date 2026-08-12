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
//! - `0010_projects.sql`：项目 workspace 登记 + project_assets 素材多对多成员关系
//! - `0011_dhash_fuzzy_dedupe.sql`：采集去重升级为 dHash 阈值去重；存量近重复搬进
//!   「已合并去重（重复）」收藏夹（保留高分在主瀑布流，见 hook）

use rusqlite_migration::{Migrations, M};

/// 「已合并去重（重复）」收藏夹 id。hook 仅在确实搬入素材时才创建该收藏夹
/// （空收藏夹会污染侧栏「收藏夹」区）。
const MERGED_FOLDER_ID: &str = "merged_duplicates";

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
        M::up(include_str!("../../sql/0010_projects.sql")),
        M::up_with_hook(
            include_str!("../../sql/0011_dhash_fuzzy_dedupe.sql"),
            |tx: &rusqlite::Transaction| merge_existing_duplicates(tx),
        ),
    ])
}

/// 扫描存量资产，把 dHash 距离 ≤ [`crate::media::phash::DEDUP_HAMMING_MAX`] 的近重复对中
/// 分辨率较低 / 较晚的那张搬进「已合并去重（重复）」收藏夹。保留较高分辨率在主瀑布流；
/// 数据不删（资产行 / 文件 / 分析都在），用户可打开收藏夹查看或删除。
fn merge_existing_duplicates(tx: &rusqlite::Transaction) -> rusqlite_migration::HookResult {
    // 一次性取出所有带 phash 的资产（存量级，通常几千张内；不做 O(n²) 于超大库，
    // 但本库以千图级为目标，n² 的海明比较仍是毫秒级）。
    struct Row {
        id: String,
        phash: String,
        w: i64,
        h: i64,
        created_at: i64,
    }
    let mut stmt = tx
        .prepare("SELECT id, phash, width, height, created_at FROM assets WHERE phash IS NOT NULL")
        .map_err(rusqlite_migration::HookError::from)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Row {
                id: r.get(0)?,
                phash: r.get(1)?,
                w: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                h: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                created_at: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            })
        })
        .map_err(rusqlite_migration::HookError::from)?;
    let mut assets: Vec<Row> = Vec::new();
    for row in rows {
        assets.push(row.map_err(rusqlite_migration::HookError::from)?);
    }

    // 找出每对近重复中「应搬走」的 id（分辨率更低；分辨率相同则更晚）。
    // 只处理一次：对每对，把低分/较晚那张加入搬移集合；两张同为低分且互不包含时可能
    // 两个都进集合，但对 a-b 与 b-c 的链式近重复，用「是否已在集合」避免重复搬同一张。
    let mut to_move: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for i in 0..assets.len() {
        for j in (i + 1)..assets.len() {
            let a = &assets[i];
            let b = &assets[j];
            // 低熵保护：纯色/平滑渐变图的 dHash 会退化为全 0 / 极低置位（不同纯色可能同值），
            // 无法可靠判定身份，一律不合并。与 `find_asset_by_phash` 实时去重保持一致。
            if !crate::media::phash::is_high_entropy(&a.phash)
                || !crate::media::phash::is_high_entropy(&b.phash)
            {
                continue;
            }
            let Some(dist) = crate::media::phash::hamming(&a.phash, &b.phash) else {
                continue;
            };
            if dist > crate::media::phash::DEDUP_HAMMING_MAX {
                continue;
            }
            // 决定留哪张在主瀑布流：分辨率（宽×高）大的留；分辨率相同留更早的。
            let a_area = a.w.saturating_mul(a.h);
            let b_area = b.w.saturating_mul(b.h);
            let loser_id = if a_area > b_area {
                &b.id
            } else if b_area > a_area {
                &a.id
            } else if a.created_at <= b.created_at {
                &b.id
            } else {
                &a.id
            };
            if seen.insert(loser_id.clone()) {
                to_move.push(loser_id.clone());
            }
        }
    }

    if to_move.is_empty() {
        return Ok(());
    }

    // 有近重复才建收藏夹（避免空收藏夹污染侧栏）。
    tx.execute(
        "INSERT INTO folders (id, name, parent_id, kind, created_at) \
         VALUES (?1, '已合并去重（重复）', NULL, 'collection', strftime('%s','now'))",
        rusqlite::params![MERGED_FOLDER_ID],
    )
    .map_err(rusqlite_migration::HookError::from)?;

    for id in &to_move {
        let now = chrono::Utc::now().timestamp();
        tx.execute(
            "INSERT OR IGNORE INTO asset_collections (asset_id, folder_id, created_at) \
             VALUES (?1, ?2, ?3)",
            rusqlite::params![id, MERGED_FOLDER_ID, now],
        )
        .map_err(rusqlite_migration::HookError::from)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::phash;
    use image::RgbImage;

    use crate::media::phash::testutil::make_photo;

    /// 升级到 v10（旧库状态）后插入近重复资产，再升级到最新（0011 hook 应把低清变体
    /// 搬进「已合并去重」收藏夹，保留高清在主瀑布流）。
    #[test]
    fn migration_0011_moves_existing_near_duplicates() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let ms = migrations();
        ms.to_version(&mut conn, 10).unwrap();

        // 构造高清 + 低清变体，计算真实 phash。
        let tmp = std::env::temp_dir().join(format!("bb-mig-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let full = tmp.join("full.png");
        make_photo(640, 0).save(&full).unwrap();
        let small = tmp.join("small.png");
        image::DynamicImage::ImageRgb8(make_photo(640, 0))
            .resize_exact(236, 236, image::imageops::FilterType::Triangle)
            .save(&small)
            .unwrap();
        let full_hash = phash::compute(&full).unwrap().unwrap();
        let small_hash = phash::compute(&small).unwrap().unwrap();
        assert!(
            phash::hamming(&full_hash, &small_hash).unwrap() <= phash::DEDUP_HAMMING_MAX,
            "变体距离 {} 应在阈值内",
            phash::hamming(&full_hash, &small_hash).unwrap()
        );

        // v10 旧库：直接插入两行（高清先、低清后）。
        conn.execute(
            "INSERT INTO assets (id, name, phash, width, height, created_at) \
             VALUES ('full-1', 'full', ?1, 640, 640, 100), ('small-1', 'small', ?2, 236, 236, 200)",
            rusqlite::params![full_hash, small_hash],
        )
        .unwrap();

        // 升级到最新 → 0011 hook 执行。
        ms.to_latest(&mut conn).unwrap();

        // 收藏夹应已创建。
        let folder: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folders WHERE id = 'merged_duplicates' AND kind = 'collection'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(folder, 1, "应创建「已合并去重」收藏夹");

        // 低清变体应被搬进收藏夹；高清应在主瀑布流（不在收藏夹）。
        let in_collection = |id: &str| -> bool {
            conn.query_row(
                "SELECT COUNT(*) FROM asset_collections WHERE asset_id = ?1 AND folder_id = 'merged_duplicates'",
                rusqlite::params![id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                > 0
        };
        assert!(in_collection("small-1"), "低清变体应进收藏夹");
        assert!(!in_collection("full-1"), "高清应保留在主瀑布流");
    }

    /// 无近重复时不应创建空收藏夹（避免污染侧栏）。
    #[test]
    fn migration_0011_no_duplicates_creates_no_folder() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let ms = migrations();
        ms.to_version(&mut conn, 10).unwrap();

        let tmp = std::env::temp_dir().join(format!("bb-mig-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let a = tmp.join("a.png");
        make_photo(320, 0).save(&a).unwrap();
        let b = tmp.join("b.png");
        make_photo(320, 1).save(&b).unwrap();
        let ha = phash::compute(&a).unwrap().unwrap();
        let hb = phash::compute(&b).unwrap().unwrap();
        assert!(
            phash::hamming(&ha, &hb).unwrap() > phash::DEDUP_HAMMING_MAX,
            "两张不同图距离 {} 应大于阈值",
            phash::hamming(&ha, &hb).unwrap()
        );
        conn.execute(
            "INSERT INTO assets (id, name, phash, width, height, created_at) \
             VALUES ('a-1', 'a', ?1, 320, 320, 100), ('b-1', 'b', ?2, 320, 320, 200)",
            rusqlite::params![ha, hb],
        )
        .unwrap();

        ms.to_latest(&mut conn).unwrap();
        let folder: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM folders WHERE id = 'merged_duplicates'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(folder, 0, "无近重复时不应创建收藏夹");
    }

    /// 两张不同的低熵图（纯色，dHash 退化且可能相同）不应被误合并。
    #[test]
    fn migration_0011_does_not_merge_low_entropy_different_images() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let ms = migrations();
        ms.to_version(&mut conn, 10).unwrap();

        // 两张不同纯色图：dHash 都退化（可能全 0 或极低熵）。若没有低熵保护，
        // 它们会被误判为「同一张」而合并。
        let red: [u8; 3] = [255, 0, 0];
        let green: [u8; 3] = [0, 255, 0];
        let make_flat = |name: &str, color: [u8; 3], dir: &std::path::Path| {
            let mut img = RgbImage::new(64, 64);
            for px in img.pixels_mut() {
                *px = image::Rgb(color);
            }
            let p = dir.join(name);
            img.save(&p).unwrap();
            p
        };
        let tmp = std::env::temp_dir().join(format!("bb-mig-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let ha = phash::compute(&make_flat("red.png", red, &tmp))
            .unwrap()
            .unwrap();
        let hb = phash::compute(&make_flat("green.png", green, &tmp))
            .unwrap()
            .unwrap();
        // 两种纯色的 dHash 大概率都低熵（置位 bit 少）。
        assert!(!phash::is_high_entropy(&ha) || !phash::is_high_entropy(&hb));

        conn.execute(
            "INSERT INTO assets (id, name, phash, width, height, created_at) \
             VALUES ('red-1', 'red', ?1, 64, 64, 100), ('green-1', 'green', ?2, 64, 64, 200)",
            rusqlite::params![ha, hb],
        )
        .unwrap();

        ms.to_latest(&mut conn).unwrap();
        let in_collection = |id: &str| -> bool {
            conn.query_row(
                "SELECT COUNT(*) FROM asset_collections WHERE asset_id = ?1 AND folder_id = 'merged_duplicates'",
                rusqlite::params![id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                > 0
        };
        assert!(!in_collection("red-1"), "低熵图 red 不应被误合并");
        assert!(!in_collection("green-1"), "低熵图 green 不应被误合并");
    }
}
