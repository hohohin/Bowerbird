//! 资源库 CRUD：assets / folders / tags 的结构与查询。
//! Database 的业务方法 split-impl 在本文件（连接管理仍在 db/mod.rs）。

use std::collections::BTreeMap;

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
    })
}

const ASSET_COLS: &str = "id, name, ext, origin_path, store_path, thumb_path, size, width, height, \
    duration, phash, colors, rating, source, source_url, folder_id, created_at, file_mtime";

impl Database {
    pub fn insert_asset(&self, a: &Asset) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id, name, ext, origin_path, store_path, thumb_path, size, width, \
             height, duration, phash, colors, rating, source, source_url, folder_id, created_at, \
             file_mtime) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
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
            ],
        )?;
        Ok(())
    }

    /// folder_id = None 表示「全部」。若 folder_id 指向智能文件夹，按其 smart_query 过滤。
    pub fn list_assets(
        &self,
        folder_id: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        if let Some(fid) = folder_id {
            if let Some(folder) = self.get_folder(fid)? {
                if folder.kind.as_deref() == Some("smart") {
                    return self.list_assets_smart(
                        folder.smart_query.as_deref().unwrap_or(""),
                        limit,
                        offset,
                    );
                }
            }
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {ASSET_COLS} FROM assets WHERE (?1 IS NULL OR folder_id IS ?1) \
             ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![folder_id, limit, offset], asset_from_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn count_assets(&self) -> AppResult<i64> {
        let conn = self.conn.lock().unwrap();
        let n: i64 =
            conn.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))?;
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

        // 物理删除：去重（SVG 的 thumb_path == store_path），best-effort
        // （文件已不存在不算错——例如导入时缩略图生成失败留下的空引用）。
        let mut seen = std::collections::HashSet::new();
        for p in [store_path, thumb_path].into_iter().flatten() {
            if !seen.insert(p.clone()) {
                continue;
            }
            if let Err(e) = std::fs::remove_file(&p) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("delete file failed for {p}: {e}");
                }
            }
        }
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

    /// 按 smart_query 过滤资产。前缀：`source:xxx` / `ext:xxx` / `tag:<name>`（未知前缀返回全部）。
    /// `tag:` 走 asset_tags JOIN——不进 FTS（0002 触发器不维护 tags 列，见 P2 设计）。
    pub fn list_assets_smart(
        &self,
        query: &str,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        if let Some(name) = query.strip_prefix("tag:") {
            let sql = format!(
                "SELECT {ASSET_COLS} FROM assets WHERE id IN (\
                   SELECT at.asset_id FROM asset_tags at JOIN tags t ON t.id = at.tag_id WHERE t.name = ?3\
                 ) ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params![limit, offset, name], asset_from_row)?;
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
            "SELECT {ASSET_COLS} FROM assets WHERE {cond} ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![limit, offset, val], asset_from_row)?;
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
    pub fn search_assets(&self, query: &str, limit: i64) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        // JOIN 后 assets 与 library_fts 都有 name 列 → 必须用 a. 前缀消歧。
        let sql = "SELECT a.id, a.name, a.ext, a.origin_path, a.store_path, a.thumb_path, \
            a.size, a.width, a.height, a.duration, a.phash, a.colors, a.rating, a.source, \
            a.source_url, a.folder_id, a.created_at, a.file_mtime \
            FROM assets a JOIN library_fts f ON f.asset_id = a.id \
            WHERE library_fts MATCH ?1 ORDER BY rank LIMIT ?2";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params![query, limit], asset_from_row)?;
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

    /// 创作板用：有 caption（反推）的资产 + 最新 caption 正文（开发计划 §5.4）。
    /// 创作板打开时瀑布流只显示这些；缩略图槽的 prompt 内容来自 caption / dimensions。
    pub fn list_prompted_assets(&self) -> AppResult<Vec<PromptedAsset>> {
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
             ORDER BY created_at DESC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
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
    pub fn list_tags_with_count(&self, source: &str) -> AppResult<Vec<TagCount>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, COUNT(at.asset_id) AS cnt FROM tags t \
             LEFT JOIN asset_tags at ON at.tag_id = t.id WHERE t.source = ?1 \
             GROUP BY t.id HAVING cnt > 0 ORDER BY cnt DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![source], |r| {
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
        bucket: &str,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {ASSET_COLS} FROM assets \
             WHERE (?3 IS NULL OR folder_id IS ?3) \
             AND id IN (SELECT asset_id FROM asset_colors WHERE bucket = ?4) \
             ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![limit, offset, folder_id, bucket], asset_from_row)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 全库色板：每个桶 + 资产数（count>0），hex 从 color::BUCKETS 注入。不受 500 限制。
    pub fn palette_overview(&self) -> AppResult<Vec<ColorBucket>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT bucket, COUNT(*) AS cnt FROM asset_colors \
             GROUP BY bucket HAVING cnt > 0 ORDER BY cnt DESC LIMIT 12",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
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
            created_at: Some(0),
            file_mtime: Some(0),
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
        let r = db.search_assets("cyberpunk", 10).unwrap();
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

        let r = db.list_prompted_assets().unwrap();
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

        let r = db.list_prompted_assets().unwrap();
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

        let r = db.list_assets_smart("tag:风景", 100, 0).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, a1);
        // 未知标签 → 空（不是返回全部）
        assert_eq!(db.list_assets_smart("tag:不存在", 100, 0).unwrap().len(), 0);
    }

    #[test]
    fn list_tags_with_count_only_returns_used() {
        let db = db();
        let a1 = put_asset(&db, "x");
        let tid = db.get_or_create_tag("风景", "auto").unwrap();
        db.set_asset_tags(&a1, &[tid], "auto").unwrap();
        // 另建一个 auto tag 但不关联任何资产 → 不出现（HAVING count>0）
        let _ = db.get_or_create_tag("静物", "auto").unwrap();

        let counts = db.list_tags_with_count("auto").unwrap();
        assert_eq!(counts.len(), 1, "只有被用到的 auto tag 才出现（seed 其余 count=0）");
        assert_eq!(counts[0].name, "风景");
        assert_eq!(counts[0].count, 1);
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
        let pal = db.palette_overview().unwrap();
        assert_eq!(pal.len(), 3);
        let red = pal.iter().find(|c| c.key == "red").unwrap();
        assert_eq!(red.count, 1);
        assert_eq!(red.hex, "#D92424");

        // 全库 red → a1
        let reds = db.list_assets_by_color(None, "red", 100, 0).unwrap();
        assert_eq!(reds.len(), 1);
        assert_eq!(reds[0].id, a1);

        // 带文件夹：色夹里 blue → 空（a2 不在夹）；色夹里 red → a1
        assert!(db.list_assets_by_color(Some(&fid), "blue", 100, 0).unwrap().is_empty());
        let in_folder = db.list_assets_by_color(Some(&fid), "red", 100, 0).unwrap();
        assert_eq!(in_folder.len(), 1);
        assert_eq!(in_folder[0].id, a1);
    }
}
