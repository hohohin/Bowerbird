//! 资源库 CRUD：assets / folders / tags 的结构与查询。
//! Database 的业务方法 split-impl 在本文件（连接管理仍在 db/mod.rs）。

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::db::Database;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub ext: Option<String>,
    pub origin_path: Option<String>,
    pub store_path: Option<String>,
    pub thumb_path: Option<String>,
    pub size: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration: Option<f64>,
    pub phash: Option<String>,
    pub colors: Option<String>,
    pub rating: Option<i64>,
    pub source: Option<String>,
    pub source_url: Option<String>,
    pub folder_id: Option<String>,
    pub created_at: Option<i64>,
    pub file_mtime: Option<i64>,
    pub generation_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub kind: Option<String>,
    pub smart_query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prompt {
    pub id: String,
    pub title: Option<String>,
    pub body: String,
    pub kind: Option<String>,
    pub source_model: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// 创作板「用途」：命名的预设 prompt 片段，发送 codex 时作为基底注入（不进编辑器）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub body: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// 资产 ↔ 提示词 的关联（含 role）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetPrompt {
    pub prompt: Prompt,
    pub role: String,
}

/// 拆解分析结果（开发计划 §4.2 analyses 表，全由 codex 产出）。
/// payload 是 JSON（如 caption：`{"text": "..."}`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Analysis {
    pub id: String,
    pub asset_id: String,
    pub kind: String, // caption | keywords | ocr | layout | inspiration_card
    pub payload: String,
    pub provider: Option<String>,
    pub created_at: Option<i64>,
}

/// 生成对话一轮（回看用）：用户输入的 prompt + 本轮产出的图（store_path）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationHistoryTurn {
    pub prompt: String,
    pub images: Vec<String>,
}

/// 某生成图所在 codex 会话的完整生成时间线（「回看生成对话」用）。
/// `references` 取首版 generation_meta 的参考图（按 store_path 反查的完整 asset，含 name/
/// thumb_path/store_path）：前端「复用到创作板」据此还原参考图，「新会话重新生成」从 store_path 派生。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationHistory {
    pub session_id: Option<String>,
    pub turns: Vec<GenerationHistoryTurn>,
    pub references: Vec<Asset>,
}

/// 反推 caption 解析出的一个维度片段（动态标题 + 正文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptionSection {
    pub title: String,
    pub body: String,
}

/// 创作板用：带反推 caption 的资产。`asset` flatten 后直接作 Asset 序列化，
/// 额外附 `caption`（最新一条 analyses(kind=caption) 的正文）与结构化维度片段。
/// `sections` 是模型实际输出的全部维度（按文档顺序），创作板据此动态生成维度下拉。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptedAsset {
    #[serde(flatten)]
    pub asset: Asset,
    pub caption: Option<String>,
    pub sections: Option<Vec<CaptionSection>>,
    pub dimensions: Option<BTreeMap<String, String>>,
    pub parse_status: Option<String>,
}

/// 自动归类侧栏聚合用：某 source 的 tag + 资产计数（count>0）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagCount {
    pub id: String,
    pub name: String,
    pub count: i64,
}

/// 某资产的 tag（name + source，详情页区分 auto/manual）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetTag {
    pub name: String,
    pub source: String,
}

/// 色板聚合：某颜色桶 + 资产数 + 桶代表 hex（前端色块渲染，hex 由后端注入消除双源）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorBucket {
    pub key: String,
    pub count: i64,
    pub hex: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CaptionPayload {
    sections: Option<Vec<CaptionSection>>,
    dimensions: Option<BTreeMap<String, String>>,
    parse_status: Option<String>,
}

fn parse_caption_payload(
    payload: Option<String>,
) -> (Option<Vec<CaptionSection>>, Option<BTreeMap<String, String>>, Option<String>) {
    let Some(payload) = payload else {
        return (None, None, None);
    };
    let Ok(parsed) = serde_json::from_str::<CaptionPayload>(&payload) else {
        return (None, None, None);
    };
    let sections = parsed.sections.filter(|s| !s.is_empty());
    let dimensions = parsed.dimensions.filter(|d| !d.is_empty());
    (sections, dimensions, parsed.parse_status)
}

fn asset_from_row(r: &rusqlite::Row) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: r.get("id")?,
        name: r.get("name")?,
        ext: r.get("ext")?,
        origin_path: r.get("origin_path")?,
        store_path: r.get("store_path")?,
        thumb_path: r.get("thumb_path")?,
        size: r.get("size")?,
        width: r.get("width")?,
        height: r.get("height")?,
        duration: r.get("duration")?,
        phash: r.get("phash")?,
        colors: r.get("colors")?,
        rating: r.get("rating")?,
        source: r.get("source")?,
        source_url: r.get("source_url")?,
        folder_id: r.get("folder_id")?,
        created_at: r.get("created_at")?,
        file_mtime: r.get("file_mtime")?,
        generation_session_id: r.get("generation_session_id")?,
    })
}

const ASSET_COLS: &str = "id, name, ext, origin_path, store_path, thumb_path, size, width, height, \
    duration, phash, colors, rating, source, source_url, folder_id, created_at, file_mtime, \
    generation_session_id";
const ASSET_COLS_A: &str = "a.id, a.name, a.ext, a.origin_path, a.store_path, a.thumb_path, \
    a.size, a.width, a.height, a.duration, a.phash, a.colors, a.rating, a.source, \
    a.source_url, a.folder_id, a.created_at, a.file_mtime, a.generation_session_id";

/// 瀑布流「同流程合并」：列表已 `ORDER BY created_at DESC` → 同 generation_session_id 的首见者
/// 即最新一张。按 session 去重保首见、丢后续过程图；无 session（非生成图）原样全留。
/// search_assets 走 rank 序，首见=最高相关一张，可接受。泛型：Asset 与 PromptedAsset 各传
/// 一个 session 提取闭包即可（commands 层应用）。
pub fn collapse_generation_groups<T>(items: Vec<T>, session: impl Fn(&T) -> Option<&str>) -> Vec<T> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|x| match session(x) {
            Some(s) => seen.insert(s.to_string()), // 新 session → 插入成功=保留(true)；已见 → false 丢弃
            None => true,                          // 非生成图：全留
        })
        .collect()
}

pub fn delete_asset_files(store_path: Option<&Path>, thumb_path: Option<&Path>) {
    let mut seen = std::collections::HashSet::new();
    for path in [store_path, thumb_path].into_iter().flatten() {
        if !seen.insert(path.to_path_buf()) {
            continue;
        }
        if let Err(error) = std::fs::remove_file(path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("delete file failed for {}: {error}", path.display());
            }
        }
    }
}

impl Database {
    pub fn insert_asset(&self, a: &Asset) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id, name, ext, origin_path, store_path, thumb_path, size, width, \
             height, duration, phash, colors, rating, source, source_url, folder_id, created_at, \
             file_mtime, generation_session_id) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
            rusqlite::params![
                a.id,
                a.name,
                a.ext,
                a.origin_path,
                a.store_path,
                a.thumb_path,
                a.size,
                a.width,
                a.height,
                a.duration,
                a.phash,
                a.colors,
                a.rating,
                a.source,
                a.source_url,
                a.folder_id,
                a.created_at,
                a.file_mtime,
                a.generation_session_id,
            ],
        )?;
        Ok(())
    }

    /// folder_id = None 表示「全部」。若 folder_id 指向智能文件夹，按其 smart_query 过滤。
    pub fn list_assets(
        &self,
        folder_id: Option<&str>,
        project_id: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        if let Some(fid) = folder_id {
            if let Some(folder) = self.get_folder(fid)? {
                if folder.kind.as_deref() == Some("smart") {
                    return self.list_assets_smart(
                        folder.smart_query.as_deref().unwrap_or(""),
                        project_id,
                        limit,
                        offset,
                    );
                }
            }
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {ASSET_COLS} FROM assets \
             WHERE (?1 IS NULL OR folder_id IS ?1) \
             AND (?2 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
                 WHERE pa.asset_id = assets.id AND pa.project_id IS ?2)) \
             ORDER BY created_at DESC LIMIT ?3 OFFSET ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![folder_id, project_id, limit, offset],
            asset_from_row,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn count_assets(&self, project_id: Option<&str>) -> AppResult<i64> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM assets a WHERE (?1 IS NULL OR EXISTS(\
               SELECT 1 FROM project_assets pa WHERE pa.asset_id = a.id AND pa.project_id IS ?1\
             ))",
            rusqlite::params![project_id],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    /// 改资产名。命中 0002_fts.sql 的 `AFTER UPDATE OF name` 触发器，
    /// FTS5 搜索索引自动重建（DELETE+INSERT），无需额外同步。
    pub fn update_asset_name(&self, id: &str, name: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET name = ?1 WHERE id = ?2",
            rusqlite::params![name, id],
        )?;
        Ok(())
    }

    pub fn find_asset_by_phash(&self, phash: &str) -> AppResult<Option<Asset>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {ASSET_COLS} FROM assets WHERE phash = ?1 LIMIT 1");
        let asset = conn
            .query_row(&sql, rusqlite::params![phash], asset_from_row)
            .optional()?;
        Ok(asset)
    }

    pub fn delete_asset(&self, id: &str) -> AppResult<()> {
        // 先取出磁盘路径（删 DB 后查不到）。asset_prompts/asset_tags/analyses
        // 由外键 ON DELETE CASCADE 自动清理（foreign_keys 在连接打开时已启用）。
        let conn = self.conn.lock().unwrap();
        let (store_path, thumb_path): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT store_path, thumb_path FROM assets WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None));
        conn.execute("DELETE FROM assets WHERE id = ?1", rusqlite::params![id])?;
        drop(conn); // 释放锁后再做文件 IO，避免阻塞其它 DB 操作。
        delete_asset_files(
            store_path.as_deref().map(Path::new),
            thumb_path.as_deref().map(Path::new),
        );
        Ok(())
    }

    /// 批量移动若干资产到指定文件夹（「以选中建立文件夹」等场景）。
    pub fn set_assets_folder(&self, ids: &[String], folder_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE assets SET folder_id = ?1 WHERE id = ?2",
                rusqlite::params![folder_id, id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_folders(&self) -> AppResult<Vec<Folder>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, parent_id, kind, smart_query FROM folders ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                kind: r.get(3)?,
                smart_query: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn create_folder(&self, id: &str, name: &str, parent_id: Option<&str>) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO folders (id, name, parent_id, kind, created_at) VALUES (?1, ?2, ?3, 'folder', strftime('%s','now'))",
            rusqlite::params![id, name, parent_id],
        )?;
        Ok(())
    }

    pub fn get_folder(&self, id: &str) -> AppResult<Option<Folder>> {
        let conn = self.conn.lock().unwrap();
        let f = conn
            .query_row(
                "SELECT id, name, parent_id, kind, smart_query FROM folders WHERE id = ?1",
                rusqlite::params![id],
                |r| {
                    Ok(Folder {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        parent_id: r.get(2)?,
                        kind: r.get(3)?,
                        smart_query: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(f)
    }

    /// 改文件夹名。排除 root（可信层防护，前端已过滤）。
    /// FTS5 不受影响：library_fts 只跟 assets.name，folders 表操作不触碰它。
    pub fn rename_folder(&self, id: &str, name: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE folders SET name = ?1 WHERE id = ?2 AND id != 'root'",
            rusqlite::params![name, id],
        )?;
        Ok(())
    }

    /// 删文件夹。排除 root。依赖外键：普通夹素材 ON DELETE SET NULL 回「全部」、
    /// smart 夹无影响（查询型）、子夹 CASCADE（当前 flat 无嵌套）。
    pub fn delete_folder(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM folders WHERE id = ?1 AND id != 'root'",
            rusqlite::params![id],
        )?;
        Ok(())
    }

    /// 智能文件夹。smart_query 简化为 `source:<s>` 或 `ext:<e>` 前缀语法。
    pub fn create_smart_folder(&self, id: &str, name: &str, smart_query: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO folders (id, name, parent_id, kind, smart_query, created_at) \
             VALUES (?1, ?2, NULL, 'smart', ?3, strftime('%s','now'))",
            rusqlite::params![id, name, smart_query],
        )?;
        Ok(())
    }

    pub fn create_collection(&self, id: &str, name: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO folders (id, name, parent_id, kind, created_at) \
             VALUES (?1, ?2, NULL, 'collection', strftime('%s','now'))",
            rusqlite::params![id, name],
        )?;
        Ok(())
    }

    pub fn list_collections(&self) -> AppResult<Vec<Folder>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, parent_id, kind, smart_query \
             FROM folders WHERE kind = 'collection' ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                kind: r.get(3)?,
                smart_query: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn list_collections_for_asset(&self, asset_id: &str) -> AppResult<Vec<Folder>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT f.id, f.name, f.parent_id, f.kind, f.smart_query \
             FROM folders f JOIN asset_collections ac ON ac.folder_id = f.id \
             WHERE ac.asset_id = ?1 AND f.kind = 'collection' \
             ORDER BY f.name",
        )?;
        let rows = stmt.query_map(rusqlite::params![asset_id], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
                kind: r.get(3)?,
                smart_query: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn add_asset_to_collection(&self, asset_id: &str, collection_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO asset_collections (asset_id, folder_id, created_at) \
             VALUES (?1, ?2, strftime('%s','now'))",
            rusqlite::params![asset_id, collection_id],
        )?;
        Ok(())
    }

    pub fn remove_asset_from_collection(&self, asset_id: &str, collection_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM asset_collections WHERE asset_id = ?1 AND folder_id = ?2",
            rusqlite::params![asset_id, collection_id],
        )?;
        Ok(())
    }

    pub fn list_assets_by_collection(
        &self,
        collection_id: &str,
        project_id: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {ASSET_COLS_A} FROM assets a \
             JOIN asset_collections ac ON ac.asset_id = a.id \
             WHERE ac.folder_id = ?1 \
             AND (?2 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
                 WHERE pa.asset_id = a.id AND pa.project_id IS ?2)) \
             ORDER BY a.created_at DESC LIMIT ?3 OFFSET ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![collection_id, project_id, limit, offset],
            asset_from_row,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 创建「用途」预设（命名 prompt 片段，发送时作为基底注入）。
    pub fn create_preset(&self, id: &str, name: &str, body: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO presets (id, name, body, created_at, updated_at) \
             VALUES (?1, ?2, ?3, strftime('%s','now'), strftime('%s','now'))",
            rusqlite::params![id, name, body],
        )?;
        Ok(())
    }

    /// 全部用途，按 name 排序。
    pub fn list_presets(&self) -> AppResult<Vec<Preset>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, name, body, created_at, updated_at FROM presets ORDER BY name")?;
        let rows = stmt.query_map([], |r| {
            Ok(Preset {
                id: r.get(0)?,
                name: r.get(1)?,
                body: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 改用途的 name + body（更新 updated_at）。
    pub fn update_preset(&self, id: &str, name: &str, body: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE presets SET name = ?1, body = ?2, updated_at = strftime('%s','now') WHERE id = ?3",
            rusqlite::params![name, body, id],
        )?;
        Ok(())
    }

    pub fn delete_preset(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM presets WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    }

    /// 按 smart_query 过滤资产。前缀：`source:xxx` / `ext:xxx` / `tag:<name>`（未知前缀返回全部）。
    /// `tag:` 走 asset_tags JOIN——不进 FTS（0002 触发器不维护 tags 列，见 P2 设计）。
    pub fn list_assets_smart(
        &self,
        query: &str,
        project_id: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        if let Some(name) = query.strip_prefix("tag:") {
            let sql = format!(
                "SELECT {ASSET_COLS} FROM assets WHERE id IN (\
                   SELECT at.asset_id FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE t.name = ?4\
                 ) AND (?3 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
                   WHERE pa.asset_id = assets.id AND pa.project_id IS ?3)) \
                 ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params![limit, offset, project_id, name],
                asset_from_row,
            )?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            return Ok(out);
        }
        let (cond, val): (&str, String) = if let Some(v) = query.strip_prefix("source:") {
            ("source = ?3", v.to_string())
        } else if let Some(v) = query.strip_prefix("ext:") {
            ("ext = ?3", v.to_string())
        } else {
            ("1=1", String::new())
        };
        let sql = format!(
            "SELECT {ASSET_COLS} FROM assets WHERE {cond} \
             AND (?4 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = assets.id AND pa.project_id IS ?4)) \
             ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![limit, offset, val, project_id],
            asset_from_row,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ============ 提示词体系（核心枢纽，§5.4）============
    pub fn create_prompt(
        &self,
        id: &str,
        title: Option<&str>,
        body: &str,
        kind: Option<&str>,
        source_model: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO prompts (id, title, body, kind, source_model, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'), strftime('%s','now'))",
            rusqlite::params![id, title, body, kind, source_model],
        )?;
        Ok(())
    }

    pub fn update_prompt(&self, id: &str, title: Option<&str>, body: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE prompts SET title = ?1, body = ?2, updated_at = strftime('%s','now') WHERE id = ?3",
            rusqlite::params![title, body, id],
        )?;
        Ok(())
    }

    pub fn get_prompt(&self, id: &str) -> AppResult<Option<Prompt>> {
        let conn = self.conn.lock().unwrap();
        let p = conn
            .query_row(
                "SELECT id, title, body, kind, source_model, created_at, updated_at \
                 FROM prompts WHERE id = ?1",
                rusqlite::params![id],
                |r| {
                    Ok(Prompt {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        body: r.get(2)?,
                        kind: r.get(3)?,
                        source_model: r.get(4)?,
                        created_at: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                },
            )
            .optional()?;
        Ok(p)
    }

    pub fn delete_prompt(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM prompts WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    }

    pub fn link_prompt(&self, asset_id: &str, prompt_id: &str, role: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO asset_prompts (asset_id, prompt_id, role) VALUES (?1, ?2, ?3)",
            rusqlite::params![asset_id, prompt_id, role],
        )?;
        Ok(())
    }

    pub fn unlink_prompt(&self, asset_id: &str, prompt_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM asset_prompts WHERE asset_id = ?1 AND prompt_id = ?2",
            rusqlite::params![asset_id, prompt_id],
        )?;
        Ok(())
    }

    pub fn list_prompts_by_asset(&self, asset_id: &str) -> AppResult<Vec<AssetPrompt>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.id, p.title, p.body, p.kind, p.source_model, p.created_at, p.updated_at, ap.role \
             FROM prompts p JOIN asset_prompts ap ON ap.prompt_id = p.id \
             WHERE ap.asset_id = ?1 ORDER BY ap.rowid",
        )?;
        let rows = stmt.query_map(rusqlite::params![asset_id], |r| {
            Ok(AssetPrompt {
                prompt: Prompt {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    body: r.get(2)?,
                    kind: r.get(3)?,
                    source_model: r.get(4)?,
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                },
                role: r.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 取某资产指定角色的提示词正文（assemble_pack 用）。
    pub fn prompt_bodies_for_asset(
        &self,
        asset_id: &str,
        role: &str,
    ) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.body FROM prompts p JOIN asset_prompts ap ON ap.prompt_id = p.id \
             WHERE ap.asset_id = ?1 AND ap.role = ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![asset_id, role], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_asset(&self, id: &str) -> AppResult<Option<Asset>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {ASSET_COLS} FROM assets WHERE id = ?1");
        let a = conn
            .query_row(&sql, rusqlite::params![id], asset_from_row)
            .optional()?;
        Ok(a)
    }

    /// 全文检索（FTS5，trigram）。匹配 name/tags/prompt_body/annotation/ocr。
    pub fn search_assets(
        &self,
        query: &str,
        project_id: Option<&str>,
        limit: i64,
    ) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        // JOIN 后 assets 与 library_fts 都有 name 列 → 必须用 a. 前缀消歧。
        let sql = "SELECT a.id, a.name, a.ext, a.origin_path, a.store_path, a.thumb_path, \
            a.size, a.width, a.height, a.duration, a.phash, a.colors, a.rating, a.source, \
            a.source_url, a.folder_id, a.created_at, a.file_mtime, a.generation_session_id \
            FROM assets a JOIN library_fts f ON f.asset_id = a.id \
            WHERE library_fts MATCH ?1 \
            AND (?2 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
                WHERE pa.asset_id = a.id AND pa.project_id IS ?2)) \
            ORDER BY rank LIMIT ?3";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(
            rusqlite::params![query, project_id, limit],
            asset_from_row,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ============ 拆解分析（§5.6，Phase 5）============
    pub fn insert_analysis(&self, a: &Analysis) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO analyses (id, asset_id, kind, payload, provider, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))",
            rusqlite::params![a.id, a.asset_id, a.kind, a.payload, a.provider],
        )?;
        Ok(())
    }

    pub fn list_analyses_by_asset(&self, asset_id: &str) -> AppResult<Vec<Analysis>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, asset_id, kind, payload, provider, created_at FROM analyses \
             WHERE asset_id = ?1 ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![asset_id], |r| {
            Ok(Analysis {
                id: r.get(0)?,
                asset_id: r.get(1)?,
                kind: r.get(2)?,
                payload: r.get(3)?,
                provider: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 该资产是否已有指定 kind 的分析结果（采集即命名用：已有 caption 则跳过，避免重复调 codex）。
    pub fn has_analysis(&self, asset_id: &str, kind: &str) -> AppResult<bool> {
        let conn = self.conn.lock().unwrap();
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM analyses WHERE asset_id = ?1 AND kind = ?2)",
            rusqlite::params![asset_id, kind],
            |r| r.get(0),
        )?;
        Ok(exists)
    }

    /// 取某 codex 生成会话的 prompt 链（按时间顺序、相邻去重 → 一轮一条）。
    /// 生成图 caption 用：generation_meta 的 $.session_id 匹配，取 $.prompt；
    /// 同一轮可能产出多张图（多行同 prompt），相邻去重后得到「轮次」序列
    /// [首版 prompt, 修改1, 修改2, ...]。id 是 ULID（时间序），跨轮时序稳定。
    pub fn generation_prompt_chain(&self, session_id: &str) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT json_extract(payload, '$.prompt') FROM analyses \
             WHERE kind = 'generation_meta' \
               AND json_extract(payload, '$.session_id') = ?1 \
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id], |r| {
            r.get::<_, Option<String>>(0)
        })?;
        let mut chain: Vec<String> = Vec::new();
        for r in rows {
            if let Some(p) = r? {
                if chain.last().map(String::as_str) != Some(p.as_str()) {
                    chain.push(p);
                }
            }
        }
        Ok(chain)
    }

    /// 取该资产所属生成会话的全部图（含自己），按 id ASC（ULID 时序 = 过程顺序）。
    /// 资产无 generation_session_id（非生成图）→ 子查询返回 NULL → `generation_session_id = NULL`
    /// 恒假 → 返回空（前端据此判断「非组、无轮播」）。
    pub fn list_generation_group(
        &self,
        asset_id: &str,
        project_id: Option<&str>,
    ) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {ASSET_COLS} FROM assets \
             WHERE generation_session_id = \
               (SELECT generation_session_id FROM assets WHERE id = ?1) \
             AND (?2 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = assets.id AND pa.project_id IS ?2)) \
             ORDER BY id ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![asset_id, project_id],
            asset_from_row,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 取某生成图所在 codex 会话的完整生成时间线（「回看生成对话」用）：每轮 prompt + 该轮
    /// 产出的图（store_path）。从 generation_meta 重建——按 created_at ASC, id ASC 排序，相邻
    /// 相同 prompt 合并为同一轮（一次 codex_create_image 产多张图 → 多行同 prompt、时序相邻）。
    /// `first_references` 取首版 generation_meta 的参考图，供前端「新会话重新生成」复用。
    /// 非生成图（assets.generation_session_id 为 NULL）→ session_id=None、turns 空。
    pub fn generation_history(
        &self,
        asset_id: &str,
        project_id: Option<&str>,
    ) -> AppResult<GenerationHistory> {
        let conn = self.conn.lock().unwrap();
        // 先取会话 id；asset 不存在、无 session_id 或不在项目 scope → 空 history。
        let session_id: Option<String> = conn
            .query_row(
                "SELECT generation_session_id FROM assets a WHERE a.id = ?1 \
                 AND (?2 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
                   WHERE pa.asset_id = a.id AND pa.project_id IS ?2))",
                rusqlite::params![asset_id, project_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let Some(session_id) = session_id else {
            return Ok(GenerationHistory {
                session_id: None,
                turns: vec![],
                references: vec![],
            });
        };
        let mut stmt = conn.prepare(
            "SELECT json_extract(an.payload, '$.prompt'), a.store_path, an.payload \
             FROM analyses an JOIN assets a ON a.id = an.asset_id \
             WHERE an.kind = 'generation_meta' \
               AND json_extract(an.payload, '$.session_id') = ?1 \
               AND (?2 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
                 WHERE pa.asset_id = a.id AND pa.project_id IS ?2)) \
             ORDER BY an.created_at ASC, an.id ASC",
        )?;
        let mut turns: Vec<GenerationHistoryTurn> = Vec::new();
        let mut first_references: Vec<String> = Vec::new();
        let mut refs_done = false;
        let rows = stmt.query_map(rusqlite::params![session_id, project_id], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?, // prompt
                r.get::<_, Option<String>>(1)?, // store_path
                r.get::<_, String>(2)?,         // payload
            ))
        })?;
        for row in rows {
            let (prompt, store_path, payload) = row?;
            // 首版 generation_meta 的参考图（供「新会话重新生成」复用）。
            if !refs_done {
                refs_done = true;
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&payload) {
                    if let Some(arr) = v.get("references").and_then(|x| x.as_array()) {
                        first_references = arr
                            .iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect();
                    }
                }
            }
            let (Some(prompt), Some(path)) = (prompt, store_path) else {
                continue;
            };
            // 相邻同 prompt = 同一轮多图，合并；否则开新轮。
            if turns.last().map(|t| t.prompt.as_str()) == Some(prompt.as_str()) {
                turns.last_mut().unwrap().images.push(path);
            } else {
                turns.push(GenerationHistoryTurn {
                    prompt,
                    images: vec![path],
                });
            }
        }
        // 首版参考图：按 store_path 反查完整 asset（复用还原参考图用；图已删则该项缺失、被跳过）。
        let references = if first_references.is_empty() {
            Vec::new()
        } else {
            let placeholders = (0..first_references.len())
                .map(|i| format!("?{}", i + 1))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT {ASSET_COLS} FROM assets WHERE store_path IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params_from_iter(first_references.iter()),
                |r| asset_from_row(r),
            )?;
            let mut out = Vec::new();
            for r in rows {
                let asset = r?;
                if let Some(project_id) = project_id {
                    let visible: bool = conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM project_assets \
                         WHERE project_id = ?1 AND asset_id = ?2)",
                        rusqlite::params![project_id, &asset.id],
                        |row| row.get(0),
                    )?;
                    if !visible {
                        continue;
                    }
                }
                out.push(asset);
            }
            out
        };
        Ok(GenerationHistory {
            session_id: Some(session_id),
            turns,
            references,
        })
    }

    /// 创作板用：有 caption（反推）的资产 + 最新 caption 正文（开发计划 §5.4）。
    /// 创作板打开时瀑布流只显示这些；缩略图槽的 prompt 内容来自 caption / dimensions。
    pub fn list_prompted_assets(
        &self,
        project_id: Option<&str>,
    ) -> AppResult<Vec<PromptedAsset>> {
        let conn = self.conn.lock().unwrap();
        // 无 JOIN → ASSET_COLS 不需表前缀；caption 取最新 analyses(kind=caption) 的 $.text。
        // caption_payload 用于反序列化结构化 dimensions；旧 payload 只有 text 时也兼容。
        let sql = format!(
            "SELECT {ASSET_COLS}, (\
               SELECT json_extract(payload, '$.text') FROM analyses \
               WHERE asset_id = assets.id AND kind = 'caption' \
               ORDER BY created_at DESC LIMIT 1\
             ) AS caption, (\
               SELECT payload FROM analyses \
               WHERE asset_id = assets.id AND kind = 'caption' \
               ORDER BY created_at DESC LIMIT 1\
             ) AS caption_payload \
             FROM assets \
             WHERE EXISTS (SELECT 1 FROM analyses WHERE asset_id = assets.id AND kind = 'caption') \
             AND (?1 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = assets.id AND pa.project_id IS ?1)) \
             ORDER BY created_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![project_id], |r| {
            let (sections, dimensions, parse_status) =
                parse_caption_payload(r.get::<_, Option<String>>("caption_payload")?);
            Ok(PromptedAsset {
                asset: asset_from_row(r)?,
                caption: r.get::<_, Option<String>>("caption")?,
                sections,
                dimensions,
                parse_status,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete_analysis(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM analyses WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    }

    // ============ 标签 / 自动归类（P2）============
    // tags 表（0001_init.sql）早就在；source 列由 0005 加（auto=codex / manual=用户）。
    // 不碰 FTS：tag 检索走 list_assets_smart 的 tag: JOIN（0002 触发器不维护 tags 列）。

    /// 幂等取/建 tag。name UNIQUE 兜底；source 区分 auto(codex) / manual(用户)。
    pub fn get_or_create_tag(&self, name: &str, source: &str) -> AppResult<String> {
        let conn = self.conn.lock().unwrap();
        if let Some(id) = conn
            .query_row(
                "SELECT id FROM tags WHERE name = ?1",
                rusqlite::params![name],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        let id = Ulid::new().to_string();
        conn.execute(
            "INSERT OR IGNORE INTO tags (id, name, source) VALUES (?1, ?2, ?3)",
            rusqlite::params![id, name, source],
        )?;
        Ok(id)
    }

    /// 全量替换某资产在指定 source 下的 tag 关联（删该 source 旧关联 + 插新）。
    /// auto 与 manual 互不干扰（按 source 隔离）。
    pub fn set_asset_tags(
        &self,
        asset_id: &str,
        tag_ids: &[String],
        source: &str,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM asset_tags WHERE asset_id = ?1 \
             AND tag_id IN (SELECT id FROM tags WHERE source = ?2)",
            rusqlite::params![asset_id, source],
        )?;
        for tid in tag_ids {
            tx.execute(
                "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?1, ?2)",
                rusqlite::params![asset_id, tid],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 某资产的全部 tag：按 source 再 name 排序（详情页区分 auto/manual）。
    pub fn list_asset_tags(&self, asset_id: &str) -> AppResult<Vec<AssetTag>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.name, t.source FROM tags t \
             JOIN asset_tags at ON at.tag_id = t.id WHERE at.asset_id = ?1 \
             ORDER BY t.source, t.name",
        )?;
        let rows = stmt.query_map(rusqlite::params![asset_id], |r| {
            Ok(AssetTag {
                name: r.get::<_, String>(0)?,
                source: r.get::<_, String>(1)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 该资产是否已有 auto tag（防顶手改：自动归类仅对无 auto tag 的图跑）。
    pub fn has_auto_tag(&self, asset_id: &str) -> AppResult<bool> {
        let conn = self.conn.lock().unwrap();
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id \
             WHERE at.asset_id = ?1 AND t.source = 'auto')",
            rusqlite::params![asset_id],
            |r| r.get(0),
        )?;
        Ok(exists)
    }

    /// 全部 auto 词表名（注入 codex instruction 的受控词表）。
    pub fn list_auto_tag_names(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT name FROM tags WHERE source = 'auto' ORDER BY name")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 侧栏聚合：某 source 的 tag + 每个的资产计数（count>0），不受 list_assets 的 500 限制。
    pub fn list_tags_with_count(
        &self,
        source: &str,
        project_id: Option<&str>,
    ) -> AppResult<Vec<TagCount>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, COUNT(at.asset_id) AS cnt FROM tags t \
             LEFT JOIN asset_tags at ON at.tag_id = t.id \
             WHERE t.source = ?1 AND (?2 IS NULL OR EXISTS(\
               SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = at.asset_id AND pa.project_id IS ?2\
             )) \
             GROUP BY t.id HAVING cnt > 0 ORDER BY cnt DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![source, project_id], |r| {
            Ok(TagCount {
                id: r.get::<_, String>(0)?,
                name: r.get::<_, String>(1)?,
                count: r.get::<_, i64>(2)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 取某资产最新 caption 的正文 $.text（批量重归类喂给 codex 用）；无则 None。
    pub fn latest_caption_text(&self, asset_id: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let text: Option<String> = conn
            .query_row(
                "SELECT json_extract(payload, '$.text') FROM analyses \
                 WHERE asset_id = ?1 AND kind = 'caption' ORDER BY created_at DESC LIMIT 1",
                rusqlite::params![asset_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(text)
    }

    /// 列出所有「无 auto tag 且有 caption」的资产 id（批量重归类目标）。
    pub fn list_assets_to_classify(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT a.id FROM assets a \
             WHERE NOT EXISTS (SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id \
                               WHERE at.asset_id = a.id AND t.source = 'auto') \
             AND EXISTS (SELECT 1 FROM analyses an WHERE an.asset_id = a.id AND an.kind = 'caption') \
             ORDER BY a.created_at DESC",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ============ 颜色量化桶（P3）============
    // asset_colors(asset_id, bucket) 多对多；与 asset_tags 对称。不进 FTS（结构化查询）。

    /// 全量替换某资产的颜色桶（事务 DELETE + INSERT OR IGNORE，幂等）。
    pub fn set_asset_colors(&self, asset_id: &str, buckets: &[&str]) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM asset_colors WHERE asset_id = ?1",
            rusqlite::params![asset_id],
        )?;
        for b in buckets {
            tx.execute(
                "INSERT OR IGNORE INTO asset_colors (asset_id, bucket) VALUES (?1, ?2)",
                rusqlite::params![asset_id, b],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 按颜色桶筛选资产，带 folder 上下文（folder + color 叠加）。folder_id=None 表示全库。
    pub fn list_assets_by_color(
        &self,
        folder_id: Option<&str>,
        project_id: Option<&str>,
        bucket: &str,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {ASSET_COLS} FROM assets \
             WHERE (?3 IS NULL OR folder_id IS ?3) \
             AND (?4 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = assets.id AND pa.project_id IS ?4)) \
             AND id IN (SELECT asset_id FROM asset_colors WHERE bucket = ?5) \
             ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![limit, offset, folder_id, project_id, bucket],
            asset_from_row,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 全库色板：每个桶 + 资产数（count>0），hex 从 color::BUCKETS 注入。不受 500 限制。
    pub fn palette_overview(&self, project_id: Option<&str>) -> AppResult<Vec<ColorBucket>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT ac.bucket, COUNT(*) AS cnt FROM asset_colors ac \
             WHERE (?1 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = ac.asset_id AND pa.project_id IS ?1)) \
             GROUP BY ac.bucket HAVING cnt > 0 ORDER BY cnt DESC LIMIT 12",
        )?;
        let rows = stmt.query_map(rusqlite::params![project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (key, count) = r?;
            let hex = crate::media::color::BUCKETS
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, h)| h.to_string())
                .unwrap_or_else(|| "#888888".to_string());
            out.push(ColorBucket { key, count, hex });
        }
        Ok(out)
    }

    /// 列出所有有 colors 的 (id, colors_json)，供重建色板（P3 recompute_colors）。
    pub fn list_colors_for_recompute(&self) -> AppResult<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, colors FROM assets WHERE colors IS NOT NULL")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ulid::Ulid;

    fn db() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db
    }

    fn put_asset(db: &Database, name: &str) -> String {
        put_asset_at(db, name, 0)
    }

    fn put_asset_at(db: &Database, name: &str, created_at: i64) -> String {
        let id = Ulid::new().to_string();
        db.insert_asset(&Asset {
            id: id.clone(),
            name: name.to_string(),
            ext: Some("png".into()),
            origin_path: None,
            store_path: Some(format!("/tmp/{id}.png")),
            thumb_path: None,
            size: Some(0),
            width: Some(10),
            height: Some(10),
            duration: Some(0.0),
            phash: None,
            colors: None,
            rating: Some(0),
            source: Some("imported".into()),
            source_url: None,
            folder_id: None,
            created_at: Some(created_at),
            file_mtime: Some(0),
            generation_session_id: None,
        })
        .unwrap();
        id
    }

    #[test]
    fn fts5_search_by_name() {
        let db = db();
        let id = put_asset(&db, "cyberpunk-cityscape");
        put_asset(&db, "portrait-001");
        // trigram：搜 "cyberpunk" 应只命中第一张
        let r = db.search_assets("cyberpunk", None, 10).unwrap();
        assert!(r.iter().any(|a| a.id == id), "FTS5 应按文件名命中");
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn analysis_roundtrip() {
        let db = db();
        let aid = put_asset(&db, "x");
        let an_id = Ulid::new().to_string();
        db.insert_analysis(&Analysis {
            id: an_id.clone(),
            asset_id: aid.clone(),
            kind: "caption".to_string(),
            payload: r#"{"text":"a city scene"}"#.to_string(),
            provider: Some("mock".into()),
            created_at: None,
        })
        .unwrap();
        let list = db.list_analyses_by_asset(&aid).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, "caption");
        db.delete_analysis(&an_id).unwrap();
        assert_eq!(db.list_analyses_by_asset(&aid).unwrap().len(), 0);
    }

    #[test]
    fn generation_prompt_chain_orders_and_dedups() {
        // 同一会话两轮 generation_meta（首轮 2 图同 prompt、次轮 1 图）→ 按时序相邻去重为
        // [首版, 修改1]；另一会话的行被 session 过滤排除。analysis id 字典序保证跨轮时序。
        let db = db();
        let a1 = put_asset(&db, "g1");
        let a2 = put_asset(&db, "g2");
        let a3 = put_asset(&db, "g3");
        let _a4 = put_asset(&db, "g4");

        fn put_meta(db: &Database, id: &str, aid: &str, prompt: &str, sid: &str) {
            db.insert_analysis(&Analysis {
                id: id.to_string(),
                asset_id: aid.to_string(),
                kind: "generation_meta".to_string(),
                payload: serde_json::json!({ "prompt": prompt, "session_id": sid }).to_string(),
                provider: Some("codex-cli".into()),
                created_at: None,
            })
            .unwrap();
        }

        let session = "sess-A";
        put_meta(&db, "01T1A", &a1, "首版", session);
        put_meta(&db, "01T1B", &a2, "首版", session); // 同轮另一图（同 prompt，应被去重）
        put_meta(&db, "01T2", &a3, "修改1", session);
        put_meta(&db, "01XX", &_a4, "别的会话", "sess-B"); // 不同会话，应被排除

        let chain = db.generation_prompt_chain(session).unwrap();
        assert_eq!(chain, vec!["首版".to_string(), "修改1".to_string()]);
    }

    #[test]
    fn generation_history_rebuilds_turns_with_images() {
        // 同一会话两轮 generation_meta：首轮 2 图（同 prompt）合并为一轮多图、次轮 1 图；
        // first_references 取首版参考图；另一会话被排除；非生成图返回空。回看历史的核心契约。
        let db = db();
        // put_asset 辅助不设 generation_session_id，故生成图直接 insert_asset 带 session。
        fn put_gen(db: &Database, id: &str, session: &str) {
            db.insert_asset(&Asset {
                id: id.into(),
                name: id.into(),
                ext: Some("png".into()),
                origin_path: None,
                store_path: Some(format!("/tmp/{id}.png")),
                thumb_path: None,
                size: Some(0),
                width: Some(10),
                height: Some(10),
                duration: Some(0.0),
                phash: None,
                colors: None,
                rating: Some(0),
                source: Some("codex".into()),
                source_url: None,
                folder_id: None,
                created_at: None,
                file_mtime: Some(0),
                generation_session_id: Some(session.into()),
            })
            .unwrap();
        }
        put_gen(&db, "g1", "sess-H");
        put_gen(&db, "g2", "sess-H");
        put_gen(&db, "g3", "sess-H");
        put_gen(&db, "g4", "sess-B"); // 别的会话（应被排除）

        fn put_meta(
            db: &Database,
            id: &str,
            aid: &str,
            prompt: &str,
            sid: &str,
            refs: Option<Vec<&str>>,
        ) {
            let payload = match refs {
                Some(rs) => serde_json::json!({ "prompt": prompt, "session_id": sid, "references": rs }),
                None => serde_json::json!({ "prompt": prompt, "session_id": sid }),
            };
            db.insert_analysis(&Analysis {
                id: id.to_string(),
                asset_id: aid.to_string(),
                kind: "generation_meta".to_string(),
                payload: payload.to_string(),
                provider: Some("codex-cli".into()),
                created_at: None,
            })
            .unwrap();
        }

        let session = "sess-H";
        // 参考图：真实 asset（store_path 与 generation_meta.references 对应），供 references 反查。
        fn put_ref(db: &Database, id: &str, store_path: &str) {
            db.insert_asset(&Asset {
                id: id.into(),
                name: id.into(),
                ext: Some("png".into()),
                origin_path: None,
                store_path: Some(store_path.into()),
                thumb_path: None,
                size: Some(0),
                width: Some(10),
                height: Some(10),
                duration: Some(0.0),
                phash: None,
                colors: None,
                rating: Some(0),
                source: Some("imported".into()),
                source_url: None,
                folder_id: None,
                created_at: None,
                file_mtime: Some(0),
                generation_session_id: None,
            })
            .unwrap();
        }
        put_ref(&db, "ra", "/ref/a.png");
        put_ref(&db, "rb", "/ref/b.png");
        put_meta(&db, "02T1A", "g1", "首版", session, Some(vec!["/ref/a.png", "/ref/b.png"]));
        put_meta(&db, "02T1B", "g2", "首版", session, None); // 同轮另一图（合并）
        put_meta(&db, "02T2", "g3", "修改1", session, None);
        put_meta(&db, "02XX", "g4", "别的会话", "sess-B", None); // 排除

        let h = db.generation_history("g1", None).unwrap();
        assert_eq!(h.session_id.as_deref(), Some(session));
        assert_eq!(h.turns.len(), 2, "两轮：首版（2图合并）+ 修改1");
        assert_eq!(h.turns[0].prompt, "首版");
        assert_eq!(h.turns[0].images.len(), 2);
        assert_eq!(h.turns[1].prompt, "修改1");
        assert_eq!(h.turns[1].images.len(), 1);
        // 首版参考图按 store_path 反查为完整 asset（复用还原用）。
        let ref_ids: Vec<String> = h.references.iter().map(|a| a.id.clone()).collect();
        assert_eq!(ref_ids.len(), 2, "两参考图均命中");
        assert!(ref_ids.contains(&"ra".to_string()));
        assert!(ref_ids.contains(&"rb".to_string()));

        // 非生成图（无 generation_session_id）→ 空 history。
        let plain = put_asset(&db, "plain");
        let h2 = db.generation_history(&plain, None).unwrap();
        assert!(h2.session_id.is_none());
        assert!(h2.turns.is_empty());
    }

    #[test]
    fn collapse_generation_groups_keeps_latest_per_session() {
        // 纯函数测试：列表已 created_at DESC，同 session 首见=最新，去重保首见；非生成图全留。
        let mk = |id: &str, session: Option<&str>| Asset {
            id: id.into(),
            name: id.into(),
            ext: None,
            origin_path: None,
            store_path: None,
            thumb_path: None,
            size: None,
            width: None,
            height: None,
            duration: None,
            phash: None,
            colors: None,
            rating: None,
            source: None,
            source_url: None,
            folder_id: None,
            created_at: None,
            file_mtime: None,
            generation_session_id: session.map(String::from),
        };
        let items = vec![
            mk("a1", Some("s1")), // s1 最新
            mk("a2", Some("s1")), // s1 过程图（应丢）
            mk("b1", None),       // 非生成图（留）
            mk("c1", Some("s2")), // s2
        ];
        let out = collapse_generation_groups(items, |a| a.generation_session_id.as_deref());
        let ids: Vec<&str> = out.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["a1", "b1", "c1"]);
    }

    #[test]
    fn list_generation_group_returns_session_siblings_ordered() {
        // 同 session 的图按 id ASC（时序）返回；异 session 不混入；非生成图（无 session）返回空。
        let db = db();
        fn put_codex(db: &Database, id: &str, session: &str) {
            db.insert_asset(&Asset {
                id: id.into(),
                name: id.into(),
                ext: Some("png".into()),
                origin_path: None,
                store_path: Some(format!("/tmp/{id}.png")),
                thumb_path: None,
                size: Some(0),
                width: Some(10),
                height: Some(10),
                duration: Some(0.0),
                phash: None,
                colors: None,
                rating: Some(0),
                source: Some("codex".into()),
                source_url: None,
                folder_id: None,
                created_at: Some(0),
                file_mtime: Some(0),
                generation_session_id: Some(session.into()),
            })
            .unwrap();
        }
        put_codex(&db, "01A", "sess-A");
        put_codex(&db, "01B", "sess-A");
        put_codex(&db, "01C", "sess-A");
        put_codex(&db, "02X", "sess-B"); // 异 session

        let group = db.list_generation_group("01A", None).unwrap();
        let ids: Vec<&str> = group.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["01A", "01B", "01C"]); // id ASC = 过程顺序
        assert!(!ids.contains(&"02X"));

        // 非生成图（无 session）→ 子查询 NULL → 空。
        let plain = put_asset(&db, "plain");
        assert!(db.list_generation_group(&plain, None).unwrap().is_empty());
    }

    #[test]
    fn prompted_assets_filter_and_caption() {
        // list_prompted_assets 只返回有 caption 的资产，并带最新 caption 正文与结构化维度。
        let db = db();
        let a1 = put_asset(&db, "with-caption");
        let _a2 = put_asset(&db, "no-caption"); // 未反推，不应出现

        db.insert_analysis(&Analysis {
            id: Ulid::new().to_string(),
            asset_id: a1.clone(),
            kind: "caption".to_string(),
            payload: serde_json::json!({
                "schema_version": 1,
                "text": "a neon-lit city street",
                "sections": [
                    { "title": "类型", "body": "摄影 / 街景" },
                    { "title": "光影", "body": "neon rim light" },
                    { "title": "色调", "body": "cyan and magenta" }
                ],
                "dimensions": {
                    "light": "neon rim light",
                    "palette": "cyan and magenta"
                },
                "parse_status": "partial"
            })
            .to_string(),
            provider: Some("codex-cli".into()),
            created_at: None,
        })
        .unwrap();

        let r = db.list_prompted_assets(None).unwrap();
        assert_eq!(r.len(), 1, "只应有 1 个有 caption 的资产");
        assert_eq!(r[0].asset.id, a1);
        assert_eq!(
            r[0].caption.as_deref(),
            Some("a neon-lit city street"),
            "应取最新 caption 的 $.text"
        );
        assert_eq!(r[0].parse_status.as_deref(), Some("partial"));
        let sections = r[0].sections.as_ref().expect("应有 sections");
        assert_eq!(sections.len(), 3);
        assert_eq!(sections[0].title, "类型");
        assert_eq!(sections[1].body, "neon rim light");
        assert_eq!(
            r[0]
                .dimensions
                .as_ref()
                .and_then(|d| d.get("light"))
                .map(String::as_str),
            Some("neon rim light")
        );
    }

    #[test]
    fn prompted_assets_support_legacy_caption_payload() {
        let db = db();
        let a1 = put_asset(&db, "legacy-caption");

        db.insert_analysis(&Analysis {
            id: Ulid::new().to_string(),
            asset_id: a1.clone(),
            kind: "caption".to_string(),
            payload: r#"{"text":"legacy raw caption"}"#.to_string(),
            provider: Some("codex-cli".into()),
            created_at: None,
        })
        .unwrap();

        let r = db.list_prompted_assets(None).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].caption.as_deref(), Some("legacy raw caption"));
        assert!(r[0].dimensions.is_none());
        assert!(r[0].parse_status.is_none());
    }

    #[test]
    fn rename_and_delete_folder_guard_root_and_null_assets() {
        let db = db();
        let fid = Ulid::new().to_string();
        db.create_folder(&fid, "临时", None).unwrap();

        let aid = Ulid::new().to_string();
        db.insert_asset(&Asset {
            id: aid.clone(),
            name: "x".into(),
            ext: Some("png".into()),
            origin_path: None,
            store_path: None,
            thumb_path: None,
            size: Some(0),
            width: Some(1),
            height: Some(1),
            duration: Some(0.0),
            phash: None,
            colors: None,
            rating: Some(0),
            source: Some("imported".into()),
            source_url: None,
            folder_id: Some(fid.clone()),
            created_at: Some(0),
            file_mtime: Some(0),
            generation_session_id: None,
        })
        .unwrap();

        // rename 改名生效。
        db.rename_folder(&fid, "改名后").unwrap();
        assert_eq!(db.get_folder(&fid).unwrap().unwrap().name, "改名后");

        // root 受保护：改名/删除都不生效（名仍「全部」、行仍在）。
        db.rename_folder("root", "hack").unwrap();
        assert_eq!(db.get_folder("root").unwrap().unwrap().name, "全部");
        db.delete_folder("root").unwrap();
        assert!(db.get_folder("root").unwrap().is_some());

        // 删普通夹：夹消失，素材 folder_id 被 FK 置 NULL（回到「全部」）。
        db.delete_folder(&fid).unwrap();
        assert!(db.get_folder(&fid).unwrap().is_none());
        let a = db.get_asset(&aid).unwrap().unwrap();
        assert!(a.folder_id.is_none(), "删夹后素材应回全部（folder_id NULL）");
    }

    #[test]
    fn tags_get_or_create_idempotent_and_source_isolated() {
        let db = db();
        // get_or_create 幂等（同名返回同 id；seed 已有「风景」也走查同一行）
        let id1 = db.get_or_create_tag("风景", "auto").unwrap();
        let id2 = db.get_or_create_tag("风景", "auto").unwrap();
        assert_eq!(id1, id2);

        let aid = put_asset(&db, "x");
        let auto_id = db.get_or_create_tag("风景", "auto").unwrap();
        db.set_asset_tags(&aid, &[auto_id], "auto").unwrap();
        let manual_id = db.get_or_create_tag("我的收藏", "manual").unwrap();
        db.set_asset_tags(&aid, &[manual_id], "manual").unwrap();

        assert!(db.has_auto_tag(&aid).unwrap());
        let names: Vec<String> = db.list_asset_tags(&aid).unwrap().into_iter().map(|t| t.name).collect();
        assert!(names.contains(&"风景".to_string()));
        assert!(names.contains(&"我的收藏".to_string()));

        // 重设 auto（换类别）不应误删 manual
        let auto2 = db.get_or_create_tag("人像", "auto").unwrap();
        db.set_asset_tags(&aid, &[auto2], "auto").unwrap();
        let names: Vec<String> = db.list_asset_tags(&aid).unwrap().into_iter().map(|t| t.name).collect();
        assert!(!names.contains(&"风景".to_string()), "旧 auto 应被替换");
        assert!(names.contains(&"人像".to_string()));
        assert!(names.contains(&"我的收藏".to_string()), "manual 不应被 auto 操作误删");
    }

    #[test]
    fn list_assets_smart_tag_prefix_filters() {
        let db = db();
        let a1 = put_asset(&db, "有标签");
        let _a2 = put_asset(&db, "无标签");
        let tid = db.get_or_create_tag("风景", "auto").unwrap();
        db.set_asset_tags(&a1, &[tid], "auto").unwrap();

        let r = db.list_assets_smart("tag:风景", None, 100, 0).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, a1);
        // 未知标签 → 空（不是返回全部）
        assert_eq!(db.list_assets_smart("tag:不存在", None, 100, 0).unwrap().len(), 0);
    }

    #[test]
    fn list_tags_with_count_only_returns_used() {
        let db = db();
        let a1 = put_asset(&db, "x");
        let tid = db.get_or_create_tag("风景", "auto").unwrap();
        db.set_asset_tags(&a1, &[tid], "auto").unwrap();
        // 另建一个 auto tag 但不关联任何资产 → 不出现（HAVING count>0）
        let _ = db.get_or_create_tag("静物", "auto").unwrap();

        let counts = db.list_tags_with_count("auto", None).unwrap();
        assert_eq!(counts.len(), 1, "只有被用到的 auto tag 才出现（seed 其余 count=0）");
        assert_eq!(counts[0].name, "风景");
        assert_eq!(counts[0].count, 1);
    }

    #[test]
    fn collection_roundtrip_and_guards() {
        let db = db();
        let a1 = put_asset_at(&db, "a1", 1);
        let a2 = put_asset_at(&db, "a2", 2);
        let c1 = Ulid::new().to_string();
        let c2 = Ulid::new().to_string();
        db.create_collection(&c1, "收藏 A").unwrap();
        db.create_collection(&c2, "收藏 B").unwrap();

        let collections = db.list_collections().unwrap();
        assert_eq!(collections.len(), 2);
        assert!(collections.iter().all(|f| f.kind.as_deref() == Some("collection")));

        // 幂等：重复收藏不产生重复行。
        db.add_asset_to_collection(&a1, &c1).unwrap();
        db.add_asset_to_collection(&a1, &c1).unwrap();
        db.add_asset_to_collection(&a1, &c2).unwrap();
        let linked = db.list_collections_for_asset(&a1).unwrap();
        assert_eq!(linked.len(), 2);

        // collection 查询只返回关联资产，并按 created_at DESC。
        db.add_asset_to_collection(&a2, &c1).unwrap();
        let assets = db.list_assets_by_collection(&c1, None, 100, 0).unwrap();
        let ids: Vec<&str> = assets.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec![a2.as_str(), a1.as_str()]);

        // 普通文件夹不能作为收藏目标（trigger 防误用）。
        let fid = Ulid::new().to_string();
        db.create_folder(&fid, "普通夹", None).unwrap();
        assert!(db.add_asset_to_collection(&a1, &fid).is_err());

        // 删除收藏夹只清关系，不删素材。
        db.delete_folder(&c1).unwrap();
        assert!(db.get_asset(&a1).unwrap().is_some());
        assert_eq!(db.list_assets_by_collection(&c1, None, 100, 0).unwrap().len(), 0);
        assert_eq!(db.list_collections_for_asset(&a1).unwrap().len(), 1);

        // 删除素材清理收藏关系。
        db.delete_asset(&a1).unwrap();
        assert!(db.list_collections_for_asset(&a1).unwrap().is_empty());
    }

    #[test]
    fn preset_crud_roundtrip() {
        let db = db();
        db.create_preset("p1", "用途B", "body-b").unwrap();
        db.create_preset("p2", "用途A", "body-a").unwrap();

        // list 按 name 排序（用途A < 用途B）。
        let list = db.list_presets().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "用途A");
        assert_eq!(list[1].body, "body-b");

        // update 改 name + body。
        db.update_preset("p1", "用途C", "body-c").unwrap();
        let p1 = db.list_presets()
            .unwrap()
            .into_iter()
            .find(|p| p.id == "p1")
            .unwrap();
        assert_eq!(p1.name, "用途C");
        assert_eq!(p1.body, "body-c");

        // delete。
        db.delete_preset("p2").unwrap();
        assert_eq!(db.list_presets().unwrap().len(), 1);
    }

    #[test]
    fn project_scope_intersects_library_queries() {
        let db = db();
        let in_project = put_asset_at(&db, "cyberpunk-project", 2);
        let outside = put_asset_at(&db, "cyberpunk-global", 1);
        db.create_project("p1", "P1", "/tmp/p1", "/tmp/p1")
            .unwrap();
        db.add_assets_to_project("p1", std::slice::from_ref(&in_project))
            .unwrap();

        assert_eq!(db.count_assets(None).unwrap(), 2);
        assert_eq!(db.count_assets(Some("p1")).unwrap(), 1);
        assert_eq!(db.list_assets(None, Some("p1"), 100, 0).unwrap()[0].id, in_project);
        let search = db.search_assets("cyberpunk", Some("p1"), 100).unwrap();
        assert_eq!(search.len(), 1);
        assert_eq!(search[0].id, in_project);
        assert_ne!(outside, in_project);
    }

    #[test]
    fn asset_colors_set_idempotent_and_palette_and_folder_filter() {
        let db = db();
        let a1 = put_asset(&db, "红图"); // put_asset 返回 id(String)
        let a2 = put_asset(&db, "蓝图");

        // a1 放进一个夹（测 folder + color 叠加）
        let fid = "01TESTCOLORFOLDER".to_string();
        db.create_folder(&fid, "色夹", None).unwrap();
        db.set_assets_folder(&[a1.clone()], &fid).unwrap();

        // set 桶（幂等：重复跑不重复）
        db.set_asset_colors(&a1, &["red", "orange"]).unwrap();
        db.set_asset_colors(&a1, &["red", "orange"]).unwrap();
        db.set_asset_colors(&a2, &["blue"]).unwrap();

        // palette_overview：3 桶，hex 从 BUCKETS 注入
        let pal = db.palette_overview(None).unwrap();
        assert_eq!(pal.len(), 3);
        let red = pal.iter().find(|c| c.key == "red").unwrap();
        assert_eq!(red.count, 1);
        assert_eq!(red.hex, "#D92424");

        // 全库 red → a1
        let reds = db.list_assets_by_color(None, None, "red", 100, 0).unwrap();
        assert_eq!(reds.len(), 1);
        assert_eq!(reds[0].id, a1);

        // 带文件夹：色夹里 blue → 空（a2 不在夹）；色夹里 red → a1
        assert!(db.list_assets_by_color(Some(&fid), None, "blue", 100, 0).unwrap().is_empty());
        let in_folder = db.list_assets_by_color(Some(&fid), None, "red", 100, 0).unwrap();
        assert_eq!(in_folder.len(), 1);
        assert_eq!(in_folder[0].id, a1);
    }
}
