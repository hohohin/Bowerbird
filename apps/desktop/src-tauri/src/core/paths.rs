//! 库目录路径管理（开发计划 §4.1）。
//!
//! Phase 1：库根固定在 app data dir；后续可加"切换/选择库目录"。
//!   <root>/library.db
//!   <root>/images/<yyyy>/<mm>/<ulid>.<ext>
//!   <root>/thumbnails/<id前2位>/<id>.jpg

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;

use crate::error::AppResult;

#[derive(Clone)]
pub struct LibraryPaths {
    pub root: PathBuf,
    pub images: PathBuf,
    pub thumbnails: PathBuf,
    pub db: PathBuf,
    pub files: Option<Arc<super::file_workspace::FileWorkspace>>,
    pub destination: Option<PathBuf>,
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
            files: None,
            destination: None,
        })
    }

    pub fn for_project(&self, db: &crate::db::Database, project_id: Option<&str>) -> AppResult<Self> {
        let mut next = self.clone();
        if let (Some(files), Some(id)) = (&self.files, project_id) {
            let project = db.get_project(id)?.ok_or_else(|| crate::error::AppError::Other("目标项目已不存在".into()))?;
            next.destination = Some(files.project_directory(id, &project.name)?);
        }
        Ok(next)
    }

    pub fn asset_store_path(&self, id: &str, ext: &str) -> AppResult<PathBuf> {
        if let Some(destination) = &self.destination { return Ok(destination.join(format!("{id}.{ext}"))); }
        if let Some(files) = &self.files { return Ok(files.ensure_root()?.join("收集箱").join(format!("{id}.{ext}"))); }
        let now = Utc::now();
        Ok(self.images
            .join(now.format("%Y").to_string())
            .join(now.format("%m").to_string())
            .join(format!("{id}.{ext}")))
    }

    pub fn thumb_path(&self, id: &str) -> PathBuf {
        let prefix: String = id.chars().take(2).collect();
        self.thumbnails.join(prefix).join(format!("{id}.jpg"))
    }

    /// Only application-created media locations, never arbitrary added browsing locations.
    pub fn managed_file_root(&self, path: &std::path::Path) -> Option<PathBuf> {
        let canonical = fs::canonicalize(path).ok()?;
        let mut roots = vec![self.images.clone(), self.thumbnails.clone()];
        if let Some(files) = &self.files {
            let config = files.snapshot();
            if let Some(root) = config.root { roots.push(root.join("收集箱")); roots.push(root.join("全局素材")); }
            roots.extend(config.projects.into_values());
        }
        roots.into_iter().filter_map(|root| fs::canonicalize(root).ok()).find(|root| canonical.starts_with(root))
    }
}
