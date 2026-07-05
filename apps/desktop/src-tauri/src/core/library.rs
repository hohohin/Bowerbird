//! 资源库 CRUD：assets / folders / tags 的结构与查询。
//! Database 的业务方法 split-impl 在本文件（连接管理仍在 db/mod.rs）。

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

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

    /// 按 smart_query 过滤资产（`source:xxx` / `ext:xxx`，未知前缀返回全部）。
    pub fn list_assets_smart(
        &self,
        query: &str,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        let (cond, val): (&str, String) = if let Some(v) = query.strip_prefix("source:") {
            ("source = ?3", v.to_string())
        } else if let Some(v) = query.strip_prefix("ext:") {
            ("ext = ?3", v.to_string())
        } else {
            ("1=1", String::new())
        };
        let conn = self.conn.lock().unwrap();
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

    pub fn delete_analysis(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM analyses WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
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
}
