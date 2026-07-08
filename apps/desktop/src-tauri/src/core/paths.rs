//! 库目录路径管理（开发计划 §4.1）。
//!
//! Phase 1：库根固定在 app data dir；后续可加"切换/选择库目录"。
//!   <root>/library.db
//!   <root>/images/<yyyy>/<mm>/<ulid>.<ext>
//!   <root>/thumbnails/<id前2位>/<id>.jpg

use std::fs;
use std::path::PathBuf;

use chrono::Utc;

use crate::error::AppResult;

#[derive(Clone)]
pub struct LibraryPaths {
    pub root: PathBuf,
    pub images: PathBuf,
    pub thumbnails: PathBuf,
    pub db: PathBuf,
}

impl LibraryPaths {
    pub fn init(root: PathBuf) -> AppResult<Self> {
        let images = root.join("images");
        let thumbnails = root.join("thumbnails");
        let db = root.join("library.db");
        fs::create_dir_all(&images)?;
        fs::create_dir_all(&thumbnails)?;
        Ok(Self {
            root,
            images,
            thumbnails,
            db,
        })
    }

    pub fn asset_store_path(&self, id: &str, ext: &str) -> PathBuf {
        let now = Utc::now();
        self.images
            .join(now.format("%Y").to_string())
            .join(now.format("%m").to_string())
            .join(format!("{id}.{ext}"))
    }

    pub fn thumb_path(&self, id: &str) -> PathBuf {
        let prefix: String = id.chars().take(2).collect();
        self.thumbnails.join(prefix).join(format!("{id}.jpg"))
    }
}
