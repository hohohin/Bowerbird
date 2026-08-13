//! 预设图（新手引导种子）：内置 manifest + 导入时按文件名识别并预填 generation_meta，
//! 让预设图成为「生成图」（右键自动显示「复用生成提示词」），不调 codex（离线降级约定 7）。
//!
//! 识别下沉到 ingest_file（所有导入入口的咽喉），任何方式导入预设图都自动预填。
//! 抄 generation_worker::finalize_generation_assets 的 generation_meta 写法 + samples::seed_one 的 UPDATE 范式。

use std::path::Path;

use crate::core::library::{Analysis, Asset};
use crate::db::Database;
use crate::error::AppResult;

/// 预设图在 assets.source 的标记（沿用 samples 的 built-in 标记，不污染侧栏 source 筛选）。
pub const PRESET_SOURCE: &str = "sample";

/// 一张预设图的 manifest 项。
#[derive(Clone)]
pub struct PresetSpec {
    /// resources/samples/<filename>（随包打包 + release_preset_pack 复制到文档目录）。
    pub filename: &'static str,
    /// 写入 assets.name（新用户没开 autoname，名字由 manifest 给）。
    pub display_name: &'static str,
    /// 独立 generation_session_id（多张必须各异，否则 list_assets 的 collapse_generation_groups 折叠成一张）。
    pub session_id: &'static str,
    /// 铺展 prompt（generation_meta.prompt；「复用生成提示词」载入创作板的内容）。
    pub prompt: &'static str,
    /// 未铺开的原始编辑框文本（含维度 chip；None 时前端 ?? 回退 prompt）。
    pub prompt_raw: Option<&'static str>,
    /// 参考图 store_path（预设图通常空）。
    pub references: &'static [&'static str],
}

// 注：prompt 待用户提供 2 张 AI 生成图后照实填入；现用占位保证 generation_history 有内容可复用。
//      文件名约定 preset-01 / preset-02（用户给图时按此命名放 resources/samples/）。
pub const PRESET_SPECS: &[PresetSpec] = &[
    PresetSpec {
        filename: "preset-01.webp",
        display_name: "预设示例 · 一",
        session_id: "builtin:preset:01",
        prompt: "（待填：preset-01 的生成 prompt）",
        prompt_raw: None,
        references: &[],
    },
    PresetSpec {
        filename: "preset-02.webp",
        display_name: "预设示例 · 二",
        session_id: "builtin:preset:02",
        prompt: "（待填：preset-02 的生成 prompt）",
        prompt_raw: None,
        references: &[],
    },
];

/// 按 file_stem 查 manifest（识别预设图）。用 stem 而非完整文件名，让 webp/png/jpg 都能命中
/// （测试造 png、用户实际用 webp）。
fn manifest_match(filename: &str) -> Option<&'static PresetSpec> {
    let stem = Path::new(filename).file_stem()?.to_str()?;
    PRESET_SPECS.iter().find(|s| {
        Path::new(s.filename)
            .file_stem()
            .and_then(|x| x.to_str())
            == Some(stem)
    })
}

/// 识别预设图并预填 generation 身份 + meta。在 ingest_file 入库后调。
/// 命中返回 true（asset 已被 UPDATE source/session_id/name + 写 generation_meta）。
/// 幂等：已有 generation_meta 只补字段不重写 meta（防 dedup 旁路二次写入）。
pub fn recognize_and_prefill(
    db: &Database,
    source_file: &Path,
    asset: &mut Asset,
) -> AppResult<bool> {
    let Some(fname) = source_file.file_name().and_then(|s| s.to_str()) else {
        return Ok(false);
    };
    let Some(spec) = manifest_match(fname) else {
        return Ok(false);
    };

    let already = db.has_analysis(&asset.id, "generation_meta")?;

    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET source=?1, generation_session_id=?2, name=?3 WHERE id=?4",
            rusqlite::params![PRESET_SOURCE, spec.session_id, spec.display_name, asset.id],
        )?;
    }
    asset.source = Some(PRESET_SOURCE.to_string());
    asset.generation_session_id = Some(spec.session_id.to_string());
    asset.name = spec.display_name.to_string();

    if !already {
        let payload = serde_json::json!({
            "prompt": spec.prompt,
            "prompt_raw": spec.prompt_raw,
            "session_id": spec.session_id,
            "references": spec.references,
            "provider": PRESET_SOURCE,
            "submit_id": null,
        })
        .to_string();
        db.insert_analysis(&Analysis {
            id: ulid::Ulid::new().to_string(),
            asset_id: asset.id.clone(),
            kind: "generation_meta".to_string(),
            payload,
            provider: Some(PRESET_SOURCE.to_string()),
            created_at: None,
        })?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ingest::ingest_file;
    use crate::core::library::Asset;
    use crate::core::paths::LibraryPaths;
    use crate::db::Database;
    use crate::media::phash::testutil::make_photo_file;
    use std::path::PathBuf;
    use ulid::Ulid;

    struct Tmp {
        dir: PathBuf,
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn setup() -> (Tmp, LibraryPaths, Database) {
        let dir = std::env::temp_dir().join(format!("bb-preset-{}", Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = LibraryPaths::init(dir.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        (Tmp { dir }, paths, db)
    }

    #[test]
    fn manifest_match_by_stem_across_extensions() {
        // webp/png/jpg 同 stem 都命中；不同 stem 不命中。
        assert!(manifest_match("preset-01.webp").is_some());
        assert!(manifest_match("preset-01.png").is_some());
        assert!(manifest_match("preset-02.jpg").is_some());
        assert!(manifest_match("my-photo.png").is_none());
    }

    /// ingest preset 文件名 → 预填 source/session_id/name + generation_meta。
    #[test]
    fn ingest_preset_filename_prefills_generation_meta() {
        let (tmp, paths, db) = setup();
        let img = make_photo_file(&tmp.dir, "preset-01.png", 256, 1);
        let asset: Asset = ingest_file(&paths, &db, &img).unwrap();
        assert_eq!(asset.source.as_deref(), Some("sample"));
        assert_eq!(asset.generation_session_id.as_deref(), Some("builtin:preset:01"));
        assert_eq!(asset.name, "预设示例 · 一");
        assert!(db.has_analysis(&asset.id, "generation_meta").unwrap());
        assert!(db.has_analysis(&asset.id, "caption").unwrap() == false); // 不写 caption
    }

    /// 普通文件名 → 不识别，保持 source=imported、无 generation_meta。
    #[test]
    fn ingest_normal_filename_not_recognized() {
        let (tmp, paths, db) = setup();
        let img = make_photo_file(&tmp.dir, "my-photo.png", 256, 2);
        let asset = ingest_file(&paths, &db, &img).unwrap();
        assert_eq!(asset.source.as_deref(), Some("imported"));
        assert!(asset.generation_session_id.is_none());
        assert!(!db.has_analysis(&asset.id, "generation_meta").unwrap());
    }

    /// 二次导入同图（phash dedup 命中已存）→ 不重复写 generation_meta。
    #[test]
    fn ingest_preset_idempotent_after_dedup() {
        let (tmp, paths, db) = setup();
        let img = make_photo_file(&tmp.dir, "preset-02.png", 256, 3);
        let _ = ingest_file(&paths, &db, &img).unwrap();
        let second = ingest_file(&paths, &db, &img).unwrap();
        // dedup 命中返回已存 asset（已是 sample）
        assert_eq!(second.source.as_deref(), Some("sample"));
        let count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM analyses WHERE asset_id=?1 AND kind='generation_meta'",
                rusqlite::params![second.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "重复导入不应新增 generation_meta");
    }

    /// 预填后 generation_history 能重建 turns，prompt = manifest prompt（复用回路验证）。
    #[test]
    fn generation_history_roundtrip_for_preset() {
        let (tmp, paths, db) = setup();
        let img = make_photo_file(&tmp.dir, "preset-01.png", 256, 4);
        let asset = ingest_file(&paths, &db, &img).unwrap();
        let hist = db.generation_history(&asset.id, None).unwrap();
        assert_eq!(hist.turns.len(), 1);
        let spec = manifest_match("preset-01.png").unwrap();
        assert_eq!(hist.turns[0].prompt, spec.prompt);
    }
}
