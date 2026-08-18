//! 资源库 CRUD：assets / folders / tags 的结构与查询。
//! Database 的业务方法 split-impl 在本文件（连接管理仍在 db/mod.rs）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::db::Database;
use crate::error::{AppError, AppResult};

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
    pub prompt_raw: Option<String>,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
) -> (
    Option<Vec<CaptionSection>>,
    Option<BTreeMap<String, String>>,
    Option<String>,
) {
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

const ASSET_COLS: &str =
    "id, name, ext, origin_path, store_path, thumb_path, size, width, height, \
    duration, phash, colors, rating, source, source_url, folder_id, created_at, file_mtime, \
    generation_session_id";
const ASSET_COLS_A: &str = "a.id, a.name, a.ext, a.origin_path, a.store_path, a.thumb_path, \
    a.size, a.width, a.height, a.duration, a.phash, a.colors, a.rating, a.source, \
    a.source_url, a.folder_id, a.created_at, a.file_mtime, a.generation_session_id";

/// 瀑布流「同流程合并」：列表已 `ORDER BY created_at DESC` → 同 generation_session_id 的首见者
/// 即最新一张。按 session 去重保首见、丢后续过程图；无 session（非生成图）原样全留。
/// search_assets 同为 created_at DESC 序，行为一致。泛型：Asset 与 PromptedAsset 各传
/// 一个 session 提取闭包即可（commands 层应用）。
pub fn collapse_generation_groups<T>(
    items: Vec<T>,
    session: impl Fn(&T) -> Option<&str>,
) -> Vec<T> {
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

/// 文件 stem 净化（`rename_asset_files` 用）：替换 Windows 非法字符与控制字符
/// （对齐 projects.rs `move_destination` 的替换表）、trim 首尾空白 + 尾随 `.`/空格、
/// 限长 64 字符；空或命中 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）→ 回退 id。
fn sanitize_file_stem(raw: &str, id: &str) -> String {
    let mut s: String = raw
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    s = s.trim().trim_end_matches(|c| c == '.' || c == ' ').to_string();
    if s.is_empty() {
        return id.to_string();
    }
    if s.chars().count() > 64 {
        s = s.chars().take(64).collect();
    }
    // Windows 保留名：带扩展名也算（CON.txt 同样保留）。
    let base = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&base.as_str()) {
        let suffix: String = id.chars().take(6).collect();
        return format!("{s}_{suffix}");
    }
    s
}

/// 同目录换名目标（`rename_asset_files` 用）：保留旧扩展名；目标已存在且不是自身 →
/// 追加 `_<id 前6>`（对齐 move_destination 防覆盖）。
fn unique_destination(old: &Path, stem: &str, id: &str) -> PathBuf {
    let parent = old.parent().unwrap_or_else(|| Path::new("."));
    let ext = old.extension().and_then(|v| v.to_str()).unwrap_or("");
    let file_name = |stem: &str| {
        if ext.is_empty() {
            stem.to_string()
        } else {
            format!("{stem}.{ext}")
        }
    };
    let candidate = parent.join(file_name(stem));
    if candidate == old || !candidate.exists() {
        candidate
    } else {
        let suffix: String = id.chars().take(6).collect();
        parent.join(file_name(&format!("{stem}_{suffix}")))
    }
}

/// 移动文件：优先 rename（同卷）；跨卷/失败时 copy + 删除源（与 projects.rs `move_file` 同款）。
fn rename_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(src, dst)?;
            std::fs::remove_file(src)
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
        self.list_assets_ex(folder_id, project_id, false, limit, offset)
    }

    /// 同 [list_assets]；hide_in_projects = true 时排除已加入任一项目的素材
    /// （设置「在全局素材中隐藏项目素材」。仅全局视图传 true——项目视图本来就只显示项目素材）。
    pub fn list_assets_ex(
        &self,
        folder_id: Option<&str>,
        project_id: Option<&str>,
        hide_in_projects: bool,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<Asset>> {
        if let Some(fid) = folder_id {
            if let Some(folder) = self.get_folder(fid)? {
                if folder.kind.as_deref() == Some("smart") {
                    return self.list_assets_smart_ex(
                        folder.smart_query.as_deref().unwrap_or(""),
                        project_id,
                        hide_in_projects,
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
             AND (?3 = 0 OR ?2 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_assets pa \
                 WHERE pa.asset_id = assets.id)) \
             ORDER BY created_at DESC LIMIT ?4 OFFSET ?5"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![folder_id, project_id, hide_in_projects, limit, offset],
            asset_from_row,
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn count_assets(&self, project_id: Option<&str>) -> AppResult<i64> {
        self.count_assets_ex(project_id, false)
    }

    /// 同 [count_assets]；hide_in_projects = true 时只数未加入任一项目的素材。
    pub fn count_assets_ex(
        &self,
        project_id: Option<&str>,
        hide_in_projects: bool,
    ) -> AppResult<i64> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM assets a WHERE (?1 IS NULL OR EXISTS(\
               SELECT 1 FROM project_assets pa WHERE pa.asset_id = a.id AND pa.project_id IS ?1\
             )) AND (?2 = 0 OR ?1 IS NOT NULL OR NOT EXISTS(\
               SELECT 1 FROM project_assets pa WHERE pa.asset_id = a.id\
             ))",
            rusqlite::params![project_id, hide_in_projects],
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

    /// 手动重命名素材：同步改磁盘文件名（store/thumb 同目录换名）+ DB name/store_path/thumb_path。
    /// 文件名 = 净化后的新名（对齐 projects.rs move_destination 的净化 + Windows 保留名/尾随点空格），
    /// 同目录重名时追加 `_<id 前6>`（不覆盖）；扩展名保留旧值。svg（thumb==store）的 thumb 跟随 store。
    /// 先 rename 文件、后改 DB（FTS 由 0002 的 `AFTER UPDATE OF name` 触发器自动同步）；
    /// DB 失败时回滚已移动的文件（best-effort），避免 DB 指向已改名文件造成破图。
    /// 仅供用户手动改名调用——autoname 仍走 `update_asset_name`（只改 DB，不跟随）。
    pub fn rename_asset_files(&self, id: &str, new_name: &str) -> AppResult<()> {
        // 先取路径，drop conn 后再做文件 IO（delete_asset 同模式）。
        let (store_path, thumb_path) = {
            let conn = self.conn.lock().unwrap();
            let row: Option<(Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT store_path, thumb_path FROM assets WHERE id = ?1",
                    rusqlite::params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            row.unwrap_or((None, None))
        };
        let Some(store_path) = store_path else {
            return Err(AppError::Other("该素材没有本地文件，无法重命名".into()));
        };
        let old_store = Path::new(&store_path);
        // 新 stem：净化新名（空/保留名回退 id）；同目录冲突追加 `_<id 前6>`。
        let stem = sanitize_file_stem(new_name, id);
        let new_store = unique_destination(old_store, &stem, id);
        let new_store_str = new_store.to_string_lossy().into_owned();
        let thumb_follows_store = thumb_path.as_deref() == Some(&store_path);
        let new_thumb = if thumb_follows_store {
            Some(new_store_str.clone())
        } else {
            thumb_path.as_deref().map(|tp| {
                unique_destination(Path::new(tp), &stem, id)
                    .to_string_lossy()
                    .into_owned()
            })
        };

        // 文件 rename（同卷优先，失败 copy+delete 回退——与 projects.rs move_file 同款）。
        let store_moved = if old_store != new_store.as_path() {
            rename_file(old_store, &new_store)?;
            true
        } else {
            false
        };
        let thumb_moved = if thumb_follows_store {
            // thumb==store（svg）：旧 thumb 已随 store 的 rename 移走，无需单独移动。
            false
        } else if let (Some(old_tp), Some(new_tp)) =
            (thumb_path.as_deref(), new_thumb.as_deref())
        {
            if old_tp != new_tp {
                rename_file(Path::new(old_tp), Path::new(new_tp))?;
                true
            } else {
                false
            }
        } else {
            false
        };

        // 写回 DB；失败回滚已移动的文件，避免 DB 指向已改名文件造成破图。
        let db_result = self.update_asset_paths(id, new_name, &new_store_str, new_thumb.as_deref());
        if let Err(e) = db_result {
            if store_moved {
                let _ = std::fs::rename(&new_store, old_store);
            }
            if thumb_moved {
                if let (Some(old_tp), Some(new_tp)) =
                    (thumb_path.as_deref(), new_thumb.as_deref())
                {
                    let _ = std::fs::rename(new_tp, old_tp);
                }
            }
            return Err(e);
        }
        Ok(())
    }

    /// `rename_asset_files` 的 DB 写回（name + store/thumb 路径）。
    fn update_asset_paths(
        &self,
        id: &str,
        name: &str,
        store_path: &str,
        thumb_path: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET name = ?1, store_path = ?2, thumb_path = ?3 WHERE id = ?4",
            rusqlite::params![name, store_path, thumb_path, id],
        )?;
        Ok(())
    }

    /// 按 dHash 阈值找「近似重复」的已有资产（采集去重）。
    ///
    /// 同一张图被以不同分辨率采集（Pinterest 236w 网格缩略图 vs 原图 / srcset 变体）时，
    /// dHash 距离很小（实测个位数），精确相等匹配会漏 → 瀑布流出现两张一样的素材。
    /// 故从精确匹配升级为海明距离 ≤ [`crate::media::phash::DEDUP_HAMMING_MAX`] 的阈值匹配：
    /// 对带 phash 的存量资产做一次扫描（千图级，毫秒级），命中即视为重复。
    /// 多张命中时保留分辨率最大（更早，防抖动）的那张——高分图入库后，低分变体被归并掉。
    /// 低熵保护：纯色/平滑渐变等低熵图的 dHash 会退化为全 0 / 极低置位（不同纯色可能同值），
    /// 无法可靠判定身份，一律不做去重（见踩坑「纯色图 dHash 退化」）。
    pub fn find_asset_by_phash(&self, phash: &str) -> AppResult<Option<Asset>> {
        if !crate::media::phash::is_high_entropy(phash) {
            // 新图低熵：退化哈希不可信，不去重（否则会误并两张不同的纯色图）。
            return Ok(None);
        }
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT {ASSET_COLS} FROM assets WHERE phash IS NOT NULL");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], asset_from_row)?;
        let mut best: Option<Asset> = None;
        for row in rows {
            let asset = row?;
            let Some(candidate) = asset.phash.as_deref() else {
                continue;
            };
            // 存量低熵哈希同样不可信，跳过。
            if !crate::media::phash::is_high_entropy(candidate) {
                continue;
            }
            let Some(dist) = crate::media::phash::hamming(phash, candidate) else {
                continue;
            };
            if dist > crate::media::phash::DEDUP_HAMMING_MAX {
                continue;
            }
            let area = |a: &Asset| a.width.unwrap_or(0).saturating_mul(a.height.unwrap_or(0));
            if best.as_ref().is_none_or(|b| area(b) < area(&asset)) {
                best = Some(asset);
            }
        }
        Ok(best)
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
        let mut stmt = conn
            .prepare("SELECT id, name, parent_id, kind, smart_query FROM folders ORDER BY name")?;
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

    pub fn remove_asset_from_collection(
        &self,
        asset_id: &str,
        collection_id: &str,
    ) -> AppResult<()> {
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
        self.list_assets_by_collection_ex(collection_id, project_id, false, limit, offset)
    }

    /// 同 [list_assets_by_collection]；hide_in_projects = true 时排除已加入任一项目的素材。
    pub fn list_assets_by_collection_ex(
        &self,
        collection_id: &str,
        project_id: Option<&str>,
        hide_in_projects: bool,
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
             AND (?5 = 0 OR ?2 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_assets pa \
                 WHERE pa.asset_id = a.id)) \
             ORDER BY a.created_at DESC LIMIT ?3 OFFSET ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![collection_id, project_id, limit, offset, hide_in_projects],
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
        let mut stmt = conn
            .prepare("SELECT id, name, body, created_at, updated_at FROM presets ORDER BY name")?;
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
        self.list_assets_smart_ex(query, project_id, false, limit, offset)
    }

    /// 同 [list_assets_smart]；hide_in_projects = true 时排除已加入任一项目的素材。
    pub fn list_assets_smart_ex(
        &self,
        query: &str,
        project_id: Option<&str>,
        hide_in_projects: bool,
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
                 AND (?5 = 0 OR ?3 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_assets pa \
                   WHERE pa.asset_id = assets.id)) \
                 ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params![limit, offset, project_id, name, hide_in_projects],
                asset_from_row,
            )?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            return Ok(out);
        }
        // 「生成图」视图：任一 provider（codex / 即梦 / Bowerbird Cloud）出图入库时都写
        // generation_session_id，按它过滤比枚举 source 值更面向未来（新 provider 自动覆盖）。
        if query == "source:generated" {
            let sql = format!(
                "SELECT {ASSET_COLS} FROM assets WHERE generation_session_id IS NOT NULL \
                 AND (?3 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
                   WHERE pa.asset_id = assets.id AND pa.project_id IS ?3)) \
                 AND (?4 = 0 OR ?3 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_assets pa \
                   WHERE pa.asset_id = assets.id)) \
                 ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(
                rusqlite::params![limit, offset, project_id, hide_in_projects],
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
             AND (?5 = 0 OR ?4 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = assets.id)) \
             ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![limit, offset, val, project_id, hide_in_projects],
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
    pub fn prompt_bodies_for_asset(&self, asset_id: &str, role: &str) -> AppResult<Vec<String>> {
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

    /// 关键词搜索（Eagle 式多维度命中）。
    ///
    /// 语法：空白分词 → 多词 AND；`-词` 排除（该词命中任何维度的资产被剔除）。
    /// 每个词按字面子串匹配以下任一维度：
    /// - 文件名（assets.name）/ 来源网址（assets.source_url）
    /// - 标签（tags 表 JOIN——FTS 的 tags 列从未被维护，见 0002 设计）
    /// - prompt 正文（prompts.body，经 asset_prompts 关联）
    /// - 反推「反推提示词」维度：analyses(kind=caption).payload 的 sections 中
    ///   title='反推提示词' 的 body。**只认这个 section**——未反推/旧格式 payload
    ///   没有该 section，搜不到（刻意行为，不是 bug）。
    /// - 所在文件夹名（folders.name）
    /// - 项目名（projects.name）：命中项目名 → 该项目**全部**素材入选。
    ///
    /// 全维度 LIKE 子串（% _ \ 转义为字面）。FTS5 只索引 name 且 trigram <3 字符
    /// 无法分词，多维度下统一 LIKE 语义更简单；library_fts 表与 0002 触发器保留不动。
    pub fn search_assets(
        &self,
        query: &str,
        project_id: Option<&str>,
        limit: i64,
    ) -> AppResult<Vec<Asset>> {
        self.search_assets_ex(query, project_id, false, limit)
    }

    /// 同 [search_assets]；hide_in_projects = true 时排除已加入任一项目的素材。
    pub fn search_assets_ex(
        &self,
        query: &str,
        project_id: Option<&str>,
        hide_in_projects: bool,
        limit: i64,
    ) -> AppResult<Vec<Asset>> {
        // 分词：`-` 前缀为排除词；词内字符按字面匹配（LIKE 转义 % _ \）。
        let like = |t: &str| {
            format!(
                "%{}%",
                t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
            )
        };
        let mut pos: Vec<String> = Vec::new();
        let mut neg: Vec<String> = Vec::new();
        for term in query.split_whitespace() {
            if let Some(t) = term.strip_prefix('-').filter(|t| !t.is_empty()) {
                neg.push(like(t));
            } else {
                pos.push(like(term));
            }
        }
        if pos.is_empty() {
            return Ok(Vec::new());
        }
        // 每个词一个参数位 ?N；term_cond 生成该词的多维度 OR 块（正词取原式、负词包 NOT）。
        let term_cond = |p: usize| {
            format!(
                "(a.name LIKE ?{p} ESCAPE '\\' \
                  OR a.source_url LIKE ?{p} ESCAPE '\\' \
                  OR EXISTS(SELECT 1 FROM asset_tags at JOIN tags t ON t.id = at.tag_id \
                    WHERE at.asset_id = a.id AND t.name LIKE ?{p} ESCAPE '\\') \
                  OR EXISTS(SELECT 1 FROM asset_prompts ap JOIN prompts pm ON pm.id = ap.prompt_id \
                    WHERE ap.asset_id = a.id AND pm.body LIKE ?{p} ESCAPE '\\') \
                  OR EXISTS(SELECT 1 FROM analyses an, json_each(an.payload, '$.sections') s \
                    WHERE an.asset_id = a.id AND an.kind = 'caption' \
                      AND json_extract(s.value, '$.title') = '反推提示词' \
                      AND json_extract(s.value, '$.body') LIKE ?{p} ESCAPE '\\') \
                  OR EXISTS(SELECT 1 FROM folders f WHERE f.id = a.folder_id \
                    AND f.name LIKE ?{p} ESCAPE '\\') \
                  OR EXISTS(SELECT 1 FROM project_assets pa JOIN projects pr \
                    ON pr.id = pa.project_id \
                    WHERE pa.asset_id = a.id AND pr.name LIKE ?{p} ESCAPE '\\'))"
            )
        };
        let mut patterns: Vec<String> = Vec::new();
        let mut conds: Vec<String> = Vec::new();
        for t in pos {
            patterns.push(t);
            conds.push(term_cond(patterns.len()));
        }
        for t in neg {
            patterns.push(t);
            conds.push(format!("NOT {}", term_cond(patterns.len())));
        }
        let n = patterns.len();
        let sql = format!(
            "SELECT a.id, a.name, a.ext, a.origin_path, a.store_path, a.thumb_path, \
             a.size, a.width, a.height, a.duration, a.phash, a.colors, a.rating, a.source, \
             a.source_url, a.folder_id, a.created_at, a.file_mtime, a.generation_session_id \
             FROM assets a \
             WHERE {} \
             AND (?{} IS NULL OR EXISTS(SELECT 1 FROM project_assets pf \
                 WHERE pf.asset_id = a.id AND pf.project_id IS ?{})) \
             AND (?{} = 0 OR ?{} IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_assets pg \
                 WHERE pg.asset_id = a.id)) \
             ORDER BY a.created_at DESC LIMIT ?{}",
            conds.join(" AND "),
            n + 1,
            n + 1,
            n + 2,
            n + 1,
            n + 3
        );
        let mut vals: Vec<rusqlite::types::Value> = patterns
            .into_iter()
            .map(rusqlite::types::Value::Text)
            .collect();
        vals.push(
            project_id
                .map(|p| rusqlite::types::Value::from(p.to_string()))
                .unwrap_or(rusqlite::types::Value::Null),
        );
        vals.push(rusqlite::types::Value::from(hide_in_projects));
        vals.push(rusqlite::types::Value::from(limit));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(vals), asset_from_row)?;
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

    /// 会话级分组持久化：记 session → conversation（「重新编辑 / 重试」版本分支归组）。
    /// 幂等（session 为主键，重复写覆盖）；分组查询 [`Database::list_generation_group`] 据此
    /// 把 session 组扩成 conversation 组。
    pub fn record_generation_conversation(
        &self,
        session_id: &str,
        conversation_id: &str,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO generation_conversations (session_id, conversation_id) VALUES (?1, ?2) \
             ON CONFLICT(session_id) DO UPDATE SET conversation_id=excluded.conversation_id",
            rusqlite::params![session_id, conversation_id],
        )?;
        Ok(())
    }

    /// 取该资产所属生成会话的全部图（含自己），按 id ASC（ULID 时序 = 过程顺序）。
    /// 会话级归组：session 有 conversation 映射 → 返回整个 conversation（「重新编辑 / 重试」
    /// 各版本 session）的全部图；无映射 → 退回本 session（一次生成多图的过程组）。
    /// 资产无 generation_session_id（非生成图）→ 子查询返回 NULL → `IN (NULL)` 恒假 →
    /// 返回空（前端据此判断「非组、无轮播」）。
    pub fn list_generation_group(
        &self,
        asset_id: &str,
        project_id: Option<&str>,
    ) -> AppResult<Vec<Asset>> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT {ASSET_COLS} FROM assets \
             WHERE generation_session_id IN ( \
               SELECT gc.session_id FROM generation_conversations gc \
                 WHERE gc.conversation_id = ( \
                   SELECT conversation_id FROM generation_conversations \
                     WHERE session_id = \
                       (SELECT generation_session_id FROM assets WHERE id = ?1)) \
               UNION ALL \
               SELECT generation_session_id FROM assets WHERE id = ?1) \
             AND (?2 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = assets.id AND pa.project_id IS ?2)) \
             ORDER BY id ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![asset_id, project_id], asset_from_row)?;
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
            "SELECT json_extract(an.payload, '$.prompt'), json_extract(an.payload, '$.prompt_raw'), a.store_path, an.payload \
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
                r.get::<_, Option<String>>(1)?, // prompt_raw
                r.get::<_, Option<String>>(2)?, // store_path
                r.get::<_, String>(3)?,         // payload
            ))
        })?;
        for row in rows {
            let (prompt, prompt_raw, store_path, payload) = row?;
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
            // 相邻同 prompt = 同一轮多图，合并；否则开新轮（首轮的 prompt_raw 随新轮记一次）。
            if turns.last().map(|t| t.prompt.as_str()) == Some(prompt.as_str()) {
                turns.last_mut().unwrap().images.push(path);
            } else {
                turns.push(GenerationHistoryTurn {
                    prompt,
                    prompt_raw,
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
            let sql =
                format!("SELECT {ASSET_COLS} FROM assets WHERE store_path IN ({placeholders})");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(first_references.iter()), |r| {
                    asset_from_row(r)
                })?;
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
    pub fn list_prompted_assets(&self, project_id: Option<&str>) -> AppResult<Vec<PromptedAsset>> {
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

    /// 有 caption（反推数据）的资产 id 集合（轻量，供瀑布流标 🏷️，不拉 caption 正文）。
    /// project 过滤与 list_prompted_assets 一致（生成组未 collapse，仅用于 id 存在性判断）。
    pub fn list_captioned_asset_ids(&self, project_id: Option<&str>) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT assets.id FROM assets \
             WHERE EXISTS (SELECT 1 FROM analyses WHERE asset_id = assets.id AND kind = 'caption') \
             AND (?1 IS NULL OR EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = assets.id AND pa.project_id IS ?1))",
        )?;
        let rows = stmt.query_map(rusqlite::params![project_id], |r| r.get::<_, String>(0))?;
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

    /// 按 id 取单条分析结果（编辑反推维度前校验 kind 用）。
    pub fn get_analysis(&self, id: &str) -> AppResult<Option<Analysis>> {
        let conn = self.conn.lock().unwrap();
        let out = conn
            .query_row(
                "SELECT id, asset_id, kind, payload, provider, created_at FROM analyses WHERE id = ?1",
                rusqlite::params![id],
                |r| {
                    Ok(Analysis {
                        id: r.get(0)?,
                        asset_id: r.get(1)?,
                        kind: r.get(2)?,
                        payload: r.get(3)?,
                        provider: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(out)
    }

    /// 编辑反推维度后写回 payload（维度正文 / 重算的 text 与 dimensions）。
    pub fn update_analysis_payload(&self, id: &str, payload: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE analyses SET payload = ?2 WHERE id = ?1",
            rusqlite::params![id, payload],
        )?;
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
        self.list_assets_by_color_ex(folder_id, project_id, bucket, false, limit, offset)
    }

    /// 同 [list_assets_by_color]；hide_in_projects = true 时排除已加入任一项目的素材。
    pub fn list_assets_by_color_ex(
        &self,
        folder_id: Option<&str>,
        project_id: Option<&str>,
        bucket: &str,
        hide_in_projects: bool,
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
             AND (?6 = 0 OR ?4 IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_assets pa \
               WHERE pa.asset_id = assets.id)) \
             ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![limit, offset, folder_id, project_id, bucket, hide_in_projects],
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

    /// 造带真实磁盘文件的 asset（store + 独立 thumb；thumb_follows=true 时 thumb==store，svg 场景）。
    /// 返回 (store, thumb) 路径，测试结束时调用方负责 remove_dir_all 清理目录。
    fn put_asset_with_files(
        db: &Database,
        dir: &std::path::Path,
        id: &str,
        ext: &str,
        thumb_follows: bool,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let store = dir.join("images").join(format!("{id}.{ext}"));
        let thumb = if thumb_follows {
            store.clone()
        } else {
            dir.join("thumbnails").join(format!("{id}.jpg"))
        };
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        if !thumb_follows {
            std::fs::create_dir_all(thumb.parent().unwrap()).unwrap();
        }
        std::fs::write(&store, b"x").unwrap();
        std::fs::write(&thumb, b"y").unwrap();
        db.insert_asset(&Asset {
            id: id.to_string(),
            name: id.to_string(),
            ext: Some(ext.to_string()),
            origin_path: None,
            store_path: Some(store.to_string_lossy().into_owned()),
            thumb_path: Some(thumb.to_string_lossy().into_owned()),
            size: Some(1),
            width: Some(10),
            height: Some(10),
            duration: Some(0.0),
            phash: None,
            colors: None,
            rating: None,
            source: Some("imported".into()),
            source_url: None,
            folder_id: None,
            created_at: None,
            file_mtime: None,
            generation_session_id: None,
        })
        .unwrap();
        (store, thumb)
    }

    #[test]
    fn rename_asset_files_renames_disk_and_db() {
        let db = db();
        let stamp = Ulid::new().to_string();
        let dir = std::env::temp_dir().join(format!("bb-rename-{stamp}"));
        let (store, thumb) = put_asset_with_files(&db, &dir, &stamp, "png", false);

        db.rename_asset_files(&stamp, "夏日·海滩").unwrap();

        let a = db.get_asset(&stamp).unwrap().unwrap();
        assert_eq!(a.name, "夏日·海滩");
        let new_store = a.store_path.unwrap();
        let new_thumb = a.thumb_path.unwrap();
        assert!(new_store.ends_with("夏日·海滩.png"), "got {new_store}");
        assert!(new_thumb.ends_with("夏日·海滩.jpg"), "got {new_thumb}");
        assert!(Path::new(&new_store).exists());
        assert!(Path::new(&new_thumb).exists());
        assert!(!store.exists(), "旧 store 文件应被移走");
        assert!(!thumb.exists(), "旧 thumb 文件应被移走");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_asset_files_sanitizes_and_avoids_overwrite() {
        let db = db();
        let stamp = Ulid::new().to_string();
        let dir = std::env::temp_dir().join(format!("bb-rename2-{stamp}"));
        let (_store, _thumb) = put_asset_with_files(&db, &dir, &stamp, "png", false);
        // 同目录先占一个「冲突名.png」，改名命中它时不得覆盖。
        let conflict = dir.join("images").join("冲突名.png");
        std::fs::write(&conflict, b"other").unwrap();

        // 非法字符全净化成 _；目标已被占 → 追加 `_<id 前6>`。
        db.rename_asset_files(&stamp, "冲突名/\\:*?\"<>|").unwrap();

        let a = db.get_asset(&stamp).unwrap().unwrap();
        let new_store = a.store_path.unwrap();
        assert!(new_store.contains("冲突名_"), "got {new_store}");
        let file_name = Path::new(&new_store)
            .file_name()
            .unwrap()
            .to_string_lossy();
        assert!(
            !file_name.chars().any(|c| "\\/:*?\"<>|".contains(c)),
            "非法字符应被净化，got {file_name}"
        );
        assert!(Path::new(&new_store).exists());
        assert!(conflict.exists(), "已有文件不应被覆盖");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_asset_files_svg_thumb_follows_store() {
        let db = db();
        let stamp = Ulid::new().to_string();
        let dir = std::env::temp_dir().join(format!("bb-rename3-{stamp}"));
        let (store, _thumb) = put_asset_with_files(&db, &dir, &stamp, "svg", true);

        db.rename_asset_files(&stamp, "矢量图").unwrap();

        let a = db.get_asset(&stamp).unwrap().unwrap();
        assert!(a.store_path.as_deref().unwrap().ends_with("矢量图.svg"));
        assert_eq!(a.thumb_path, a.store_path, "svg 的 thumb 应跟随 store 路径");
        assert!(!store.exists(), "旧 svg 文件应被移走");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_by_name() {
        let db = db();
        let id = put_asset(&db, "cyberpunk-cityscape");
        put_asset(&db, "portrait-001");
        let r = db.search_assets("cyberpunk", None, 10).unwrap();
        assert!(r.iter().any(|a| a.id == id), "应按文件名命中");
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn search_special_chars_no_syntax_error() {
        let db = db();
        let id = put_asset(&db, "it's a \"test\" (copy)");
        // 含 ' " ( ) % 的输入按字面匹配，不报错、不构成通配
        let r = db.search_assets("it's a \"test\" (copy)", None, 10).unwrap();
        assert!(r.iter().any(|a| a.id == id), "特殊字符应按字面命中");
        let _ = db.search_assets("'", None, 10).unwrap();
        assert!(db.search_assets("   ", None, 10).unwrap().is_empty());
    }

    #[test]
    fn search_short_query_and_literal_wildcards() {
        let db = db();
        let id = put_asset(&db, "风景参考");
        put_asset(&db, "portrait-001");
        // 「风景」2 字中文短词也应命中文件名
        let r = db.search_assets("风景", None, 10).unwrap();
        assert!(r.iter().any(|a| a.id == id), "短中文词应命中文件名");
        assert_eq!(r.len(), 1);
        // 含 % _ 通配符的输入按字面匹配，不构成通配
        assert!(db.search_assets("%", None, 10).unwrap().is_empty());
    }

    #[test]
    fn search_matches_tags() {
        let db = db();
        let id = put_asset(&db, "portrait-001");
        let tid = db.get_or_create_tag("灵感", "manual").unwrap();
        db.set_asset_tags(&id, &[tid], "manual").unwrap();
        // 搜「灵」：文件名不含，应经标签命中
        let r = db.search_assets("灵", None, 10).unwrap();
        assert!(r.iter().any(|a| a.id == id), "短词应能经标签命中");
        // 多字标签词命中不受影响
        let r = db.search_assets("灵感", None, 10).unwrap();
        assert!(r.iter().any(|a| a.id == id), "标签词应命中");
    }

    #[test]
    fn search_matches_source_url() {
        let db = db();
        let id = put_asset(&db, "01HASHXYZ"); // hash 名本身搜不出内容词
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE assets SET source='extension', \
                 source_url='https://dribbble.com/shots/123' WHERE id=?1",
                rusqlite::params![id],
            )
            .unwrap();
        }
        let r = db.search_assets("dribbble", None, 10).unwrap();
        assert!(r.iter().any(|a| a.id == id), "应按来源网址/域名命中");
    }

    #[test]
    fn search_matches_prompt_body() {
        let db = db();
        let id = put_asset(&db, "generated-001");
        db.create_prompt("pm1", None, "一只白猫坐在窗台上，赛博朋克风格", None, None)
            .unwrap();
        db.link_prompt(&id, "pm1", "main").unwrap();
        let r = db.search_assets("赛博朋克", None, 10).unwrap();
        assert!(r.iter().any(|a| a.id == id), "应按 prompt 正文命中");
    }

    #[test]
    fn search_matches_caption_prompt_section_only() {
        let db = db();
        let id = put_asset(&db, "photo-001");
        db.insert_analysis(&Analysis {
            id: Ulid::new().to_string(),
            asset_id: id.clone(),
            kind: "caption".to_string(),
            payload: serde_json::json!({
                "sections": [
                    { "title": "构图", "body": "竖幅近景，主体居中" },
                    { "title": "反推提示词", "body": "一只发光的白色小羊在草地上奔跑" }
                ]
            })
            .to_string(),
            provider: None,
            created_at: None,
        })
        .unwrap();
        // 命中：词只出现在「反推提示词」section
        let r = db.search_assets("小羊", None, 10).unwrap();
        assert!(
            r.iter().any(|a| a.id == id),
            "应按反推「反推提示词」维度命中"
        );
        // 不命中：词只在其它 section（构图）——只认反推提示词维度
        assert!(
            db.search_assets("竖幅", None, 10).unwrap().is_empty(),
            "构图等其它 section 不参与搜索"
        );
    }

    #[test]
    fn search_matches_folder_and_project_name() {
        let db = db();
        // 项目名命中 → 该项目全部素材入选（即使文件名与搜索词无关）
        let m1 = put_asset(&db, "01AAA");
        let m2 = put_asset(&db, "02BBB");
        let outside = put_asset(&db, "03CCC");
        db.create_project("pj1", "品牌视觉", "/tmp/pj1", "/tmp/pj1", "user")
            .unwrap();
        db.add_assets_to_project("pj1", &[m1.clone(), m2.clone()])
            .unwrap();
        let r = db.search_assets("品牌视觉", None, 100).unwrap();
        let ids: Vec<&str> = r.iter().map(|a| a.id.as_str()).collect();
        assert!(
            ids.contains(&m1.as_str()) && ids.contains(&m2.as_str()),
            "项目名命中应返回项目内全部素材"
        );
        assert!(!ids.contains(&outside.as_str()), "项目外资产不入选");

        // 文件夹名命中 → 夹内资产
        let fid = Ulid::new().to_string();
        db.create_folder(&fid, "灵感收藏", None).unwrap();
        db.set_assets_folder(&[outside.clone()], &fid).unwrap();
        let r = db.search_assets("灵感", None, 100).unwrap();
        assert!(r.iter().any(|a| a.id == outside), "应按文件夹名命中");
    }

    #[test]
    fn search_multi_term_and_exclusion() {
        let db = db();
        let city = put_asset(&db, "city-night");
        put_asset(&db, "forest-day");
        // 多词 AND：两个词都命中才入选
        let r = db.search_assets("city night", None, 10).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, city);
        // 排除词：night 命中 city-night，但 -city 把它剔除
        assert!(db.search_assets("night -city", None, 10).unwrap().is_empty());
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
        // 单条读取：命中 / 未命中
        assert_eq!(db.get_analysis(&an_id).unwrap().unwrap().asset_id, aid);
        assert!(db.get_analysis("no-such-id").unwrap().is_none());
        // 编辑维度后写回 payload
        db.update_analysis_payload(&an_id, r#"{"text":"a night scene"}"#)
            .unwrap();
        assert_eq!(
            db.get_analysis(&an_id).unwrap().unwrap().payload,
            r#"{"text":"a night scene"}"#
        );
        db.delete_analysis(&an_id).unwrap();
        assert_eq!(db.list_analyses_by_asset(&aid).unwrap().len(), 0);
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
                Some(rs) => serde_json::json!({
                    "prompt": prompt,
                    "prompt_raw": format!("{prompt}（未铺开）"),
                    "session_id": sid,
                    "references": rs,
                }),
                None => serde_json::json!({
                    "prompt": prompt,
                    "prompt_raw": format!("{prompt}（未铺开）"),
                    "session_id": sid,
                }),
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
        put_meta(
            &db,
            "02T1A",
            "g1",
            "首版",
            session,
            Some(vec!["/ref/a.png", "/ref/b.png"]),
        );
        put_meta(&db, "02T1B", "g2", "首版", session, None); // 同轮另一图（合并）
        put_meta(&db, "02T2", "g3", "修改1", session, None);
        put_meta(&db, "02XX", "g4", "别的会话", "sess-B", None); // 排除

        let h = db.generation_history("g1", None).unwrap();
        assert_eq!(h.session_id.as_deref(), Some(session));
        assert_eq!(h.turns.len(), 2, "两轮：首版（2图合并）+ 修改1");
        assert_eq!(h.turns[0].prompt, "首版");
        assert_eq!(h.turns[0].prompt_raw.as_deref(), Some("首版（未铺开）"));
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
    fn list_generation_group_merges_conversation_versions() {
        // 同 conversation 的各版本 session（「重新编辑 / 重试」分支）并成一组：id ASC（末位 =
        // 最新版本产出），组内任一成员视角同组；无映射 session 不混入；映射写入幂等。
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
        put_codex(&db, "02B", "sess-B"); // 版本分支（重试 / 编辑后新版）
        put_codex(&db, "03C", "sess-C"); // 另一会话，不归组
        db.record_generation_conversation("sess-A", "conv-1").unwrap();
        db.record_generation_conversation("sess-B", "conv-1").unwrap();

        let group = db.list_generation_group("01A", None).unwrap();
        let ids: Vec<&str> = group.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["01A", "02B"]); // 跨 session 并组，id ASC
        // 组内另一成员视角同组（瀑布流各成员卡片拿到同一份组）。
        assert_eq!(db.list_generation_group("02B", None).unwrap().len(), 2);
        // 无映射的 session 仍自成一组。
        let g3 = db.list_generation_group("03C", None).unwrap();
        assert_eq!(
            g3.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            vec!["03C"]
        );
        // 重复写映射幂等，分组不变。
        db.record_generation_conversation("sess-B", "conv-1").unwrap();
        assert_eq!(db.list_generation_group("02B", None).unwrap().len(), 2);
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
            r[0].dimensions
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
        assert!(
            a.folder_id.is_none(),
            "删夹后素材应回全部（folder_id NULL）"
        );
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
        let names: Vec<String> = db
            .list_asset_tags(&aid)
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(names.contains(&"风景".to_string()));
        assert!(names.contains(&"我的收藏".to_string()));

        // 重设 auto（换类别）不应误删 manual
        let auto2 = db.get_or_create_tag("人像", "auto").unwrap();
        db.set_asset_tags(&aid, &[auto2], "auto").unwrap();
        let names: Vec<String> = db
            .list_asset_tags(&aid)
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert!(!names.contains(&"风景".to_string()), "旧 auto 应被替换");
        assert!(names.contains(&"人像".to_string()));
        assert!(
            names.contains(&"我的收藏".to_string()),
            "manual 不应被 auto 操作误删"
        );
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
        assert_eq!(
            db.list_assets_smart("tag:不存在", None, 100, 0)
                .unwrap()
                .len(),
            0
        );
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
        assert_eq!(
            counts.len(),
            1,
            "只有被用到的 auto tag 才出现（seed 其余 count=0）"
        );
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
        assert!(collections
            .iter()
            .all(|f| f.kind.as_deref() == Some("collection")));

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
        assert_eq!(
            db.list_assets_by_collection(&c1, None, 100, 0)
                .unwrap()
                .len(),
            0
        );
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
        let p1 = db
            .list_presets()
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
        db.create_project("p1", "P1", "/tmp/p1", "/tmp/p1", "user").unwrap();
        db.add_assets_to_project("p1", std::slice::from_ref(&in_project))
            .unwrap();

        assert_eq!(db.count_assets(None).unwrap(), 2);
        assert_eq!(db.count_assets(Some("p1")).unwrap(), 1);
        assert_eq!(
            db.list_assets(None, Some("p1"), 100, 0).unwrap()[0].id,
            in_project
        );
        let search = db.search_assets("cyberpunk", Some("p1"), 100).unwrap();
        assert_eq!(search.len(), 1);
        assert_eq!(search[0].id, in_project);
        assert_ne!(outside, in_project);
    }

    #[test]
    fn hide_in_projects_filters_global_queries() {
        let db = db();
        let in_project = put_asset_at(&db, "cyberpunk-project", 2);
        let outside = put_asset_at(&db, "cyberpunk-global", 1);
        db.create_project("p1", "P1", "/tmp/p1", "/tmp/p1", "user").unwrap();
        db.add_assets_to_project("p1", std::slice::from_ref(&in_project))
            .unwrap();

        // 全局视图 + hide：只剩未入项目的素材（list / count / search / smart / color）。
        let list = db.list_assets_ex(None, None, true, 100, 0).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, outside);
        assert_eq!(db.count_assets_ex(None, true).unwrap(), 1);
        let search = db.search_assets_ex("cyberpunk", None, true, 100).unwrap();
        assert_eq!(search.len(), 1);
        assert_eq!(search[0].id, outside);
        let smart = db.list_assets_smart_ex("", None, true, 100, 0).unwrap();
        assert_eq!(smart.len(), 1);
        assert_eq!(smart[0].id, outside);

        // 项目视图不受 hide 影响：仍显示项目素材。
        let list = db.list_assets_ex(None, Some("p1"), true, 100, 0).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, in_project);
        assert_eq!(db.count_assets_ex(Some("p1"), true).unwrap(), 1);

        // hide=false：行为与旧签名一致（全局 2 / 项目 1）。
        assert_eq!(db.list_assets_ex(None, None, false, 100, 0).unwrap().len(), 2);
        assert_eq!(db.count_assets_ex(None, false).unwrap(), 2);
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
        assert!(db
            .list_assets_by_color(Some(&fid), None, "blue", 100, 0)
            .unwrap()
            .is_empty());
        let in_folder = db
            .list_assets_by_color(Some(&fid), None, "red", 100, 0)
            .unwrap();
        assert_eq!(in_folder.len(), 1);
        assert_eq!(in_folder[0].id, a1);
    }
}
