//! 提示词编排层（开发计划 §5.4）：选图组 → 创作包。
//!
//! `assemble_pack`：聚合各选中资产的主提示词（role=main），附参考图路径，
//! 产出可编辑、可复制外用、可发 codex 的「创作包」。

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreationPack {
    /// 聚合后的提示词正文。
    pub prompt: String,
    /// 参考图本地路径（原图）。
    pub references: Vec<String>,
    /// 选中的资产 id。
    pub asset_ids: Vec<String>,
}

pub fn assemble_pack(db: &Database, asset_ids: &[String]) -> AppResult<CreationPack> {
    let mut prompts: Vec<String> = Vec::new();
    let mut refs: Vec<String> = Vec::new();
    for id in asset_ids {
        let bodies = db.prompt_bodies_for_asset(id, "main")?;
        for b in bodies {
            if !prompts.iter().any(|p| p == &b) {
                prompts.push(b);
            }
        }
        if let Some(asset) = db.get_asset(id)? {
            if let Some(p) = asset.store_path {
                refs.push(p);
            }
        }
    }
    let prompt = if prompts.is_empty() {
        "（暂无主提示词 —— 在提示词编辑器中给所选图片绑定 role=main 的提示词）".to_string()
    } else {
        prompts.join("\n\n---\n\n")
    };
    Ok(CreationPack {
        prompt,
        references: refs,
        asset_ids: asset_ids.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ingest;
    use crate::core::paths::LibraryPaths;
    use crate::db::Database;
    use ulid::Ulid;

    struct Tmp {
        dir: std::path::PathBuf,
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn assemble_pack_aggregates_main_role_only() {
        let dir = std::env::temp_dir().join(format!("bb-prompt-{}", Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let tmp = Tmp {
            dir: dir.clone(),
        };
        let paths = LibraryPaths::init(dir.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();

        let make = |name: &str, rgb: [u8; 3]| {
            let p = dir.join(name);
            let img = image::ImageBuffer::from_pixel(20, 20, image::Rgb(rgb));
            img.save(&p).unwrap();
            p
        };
        let a1 = ingest::ingest_file(&paths, &db, &make("a.png", [10, 20, 30])).unwrap();
        let a2 = ingest::ingest_file(&paths, &db, &make("b.png", [40, 50, 60])).unwrap();

        // a1: 一个 main；a2: 一个 ref（不该进 pack）+ 一个 main
        db.create_prompt("p1", Some("t"), "main-A", Some("manual"), None)
            .unwrap();
        db.link_prompt(&a1.id, "p1", "main").unwrap();
        db.create_prompt("p2", Some("t"), "ref-B", Some("manual"), None)
            .unwrap();
        db.link_prompt(&a2.id, "p2", "ref").unwrap();
        db.create_prompt("p3", Some("t"), "main-C", Some("manual"), None)
            .unwrap();
        db.link_prompt(&a2.id, "p3", "main").unwrap();

        let pack = assemble_pack(&db, &[a1.id.clone(), a2.id.clone()]).unwrap();
        assert!(pack.prompt.contains("main-A"));
        assert!(pack.prompt.contains("main-C"));
        assert!(
            !pack.prompt.contains("ref-B"),
            "ref role 必须被排除出创作包"
        );
        assert_eq!(pack.references.len(), 2);
        drop(tmp);
    }
}
