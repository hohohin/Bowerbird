//! User-visible files have a separate home from the existing database and caches.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}, sync::Mutex};

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Debug)]
pub struct FileWorkspaceConfig {
    pub root: Option<PathBuf>,
    pub places: Vec<PathBuf>,
    #[serde(default)]
    pub projects: BTreeMap<String, PathBuf>,
}

pub struct FileWorkspace {
    config_path: PathBuf,
    default_root: PathBuf,
    config: Mutex<FileWorkspaceConfig>,
}

pub fn default_root(executable: &Path) -> AppResult<PathBuf> {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = executable.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
        return bundle.parent().map(|p| p.join("BowerbirdLibrary"))
            .ok_or_else(|| AppError::Other("无法确定应用所在目录".into()));
    }
    executable.parent().and_then(Path::parent).map(|p| p.join("BowerbirdLibrary"))
        .ok_or_else(|| AppError::Other("无法确定安装目录的同级位置".into()))
}

pub fn write_json(path: &Path, value: &impl Serialize) -> AppResult<()> {
    let parent = path.parent().ok_or_else(|| AppError::Other("缺少资料目录".into()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn writable_directory(path: &Path) -> AppResult<PathBuf> {
    fs::create_dir_all(path)?;
    let root = fs::canonicalize(path)?;
    let probe = root.join(format!(".bowerbird-write-{}", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&probe)?;
    let result = file.write_all(b"write probe").and_then(|_| file.sync_all());
    drop(file);
    let cleanup = fs::remove_file(probe);
    result?;
    cleanup?;
    Ok(root)
}

pub(super) fn project_path(root: &Path, id: &str, name: &str) -> AppResult<PathBuf> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(AppError::Other("无效项目标识".into()));
    }
    let name: String = name.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)).take(60).collect();
    let name = name.trim().trim_end_matches('.');
    let name = if name.is_empty() { "未命名项目" } else { name };
    Ok(root.join("项目").join(format!("{name}-{id}")))
}

impl FileWorkspace {
    pub fn open(config_path: PathBuf, default_root: PathBuf) -> AppResult<Self> {
        let config = match fs::read(&config_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileWorkspaceConfig::default(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { config_path, default_root, config: Mutex::new(config) })
    }

    pub fn snapshot(&self) -> FileWorkspaceConfig { self.config.lock().unwrap().clone() }
    pub(super) fn migration_path(&self) -> PathBuf { self.config_path.with_file_name("file-workspace-migration.json") }
    pub(super) fn replace_config(&self, next: FileWorkspaceConfig) -> AppResult<()> {
        let mut config = self.config.lock().unwrap();
        write_json(&self.config_path, &next)?; *config = next; Ok(())
    }
    pub fn local_records_root(&self) -> PathBuf { self.config_path.parent().unwrap().join("creative-records") }
    pub fn proposed_root(&self) -> PathBuf {
        self.config.lock().unwrap().root.clone().unwrap_or_else(|| self.default_root.clone())
    }

    pub fn ensure_root(&self) -> AppResult<PathBuf> {
        let mut config = self.config.lock().unwrap();
        let requested = config.root.as_ref().unwrap_or(&self.default_root);
        // An unavailable configured disk must not silently create an empty replacement.
        if config.root.is_some() && !requested.is_dir() {
            return Err(AppError::Other(format!("FILE_ROOT_REQUIRED:资料目录不可用，请重新连接或选择位置：{}", requested.display())));
        }
        let root = writable_directory(requested).map_err(|e| AppError::Other(format!(
            "FILE_ROOT_REQUIRED:资料目录无法写入，请选择一个可写位置：{}（{e}）", requested.display())))?;
        if config.root.is_none() {
            let mut next = config.clone(); next.root = Some(root.clone());
            write_json(&self.config_path, &next)?; *config = next;
        }
        Ok(root)
    }

    pub fn configure(&self, root: &Path) -> AppResult<PathBuf> {
        let root = writable_directory(root)?;
        let mut config = self.config.lock().unwrap();
        let mut next = config.clone(); next.root = Some(root.clone());
        // Existing project directories remain where they were created.
        write_json(&self.config_path, &next)?; *config = next;
        Ok(root)
    }

    pub fn project_directory(&self, id: &str, name: &str) -> AppResult<PathBuf> {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(AppError::Other("无效项目标识".into()));
        }
        if let Some(path) = self.snapshot().projects.get(id) {
            if !path.is_dir() { return Err(AppError::Other("项目目录不可用，请重新连接原目录".into())); }
            return writable_directory(path);
        }
        let root = self.ensure_root()?;
        let path = project_path(&root,id,name)?;
        let mut config = self.config.lock().unwrap();
        if let Some(path) = config.projects.get(id) { return writable_directory(path); }
        fs::create_dir_all(path.parent().unwrap())?;
        fs::create_dir(&path)?;
        let mut next = config.clone(); next.projects.insert(id.into(), path.clone());
        if let Err(error) = write_json(&self.config_path, &next) {
            let _ = fs::remove_dir(&path); return Err(error);
        }
        *config = next;
        Ok(path)
    }

    pub fn set_place(&self, path: &Path, added: bool) -> AppResult<FileWorkspaceConfig> {
        // Removing an offline location is still possible.
        let path = if added { fs::canonicalize(path)? } else { path.to_path_buf() };
        if added && !path.is_dir() { return Err(AppError::Other("请选择文件夹".into())); }
        let mut config = self.config.lock().unwrap();
        let mut next = config.clone();
        next.places.retain(|p| p != &path);
        if added { next.places.push(path); }
        write_json(&self.config_path, &next)?; *config = next.clone();
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("bowerbird-files-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn root_and_projects_survive_restart_and_reconfiguration() {
        let temp = Temp::new();
        let config = temp.path().join("app/settings.json");
        let root = temp.path().join("BowerbirdLibrary");
        let files = FileWorkspace::open(config.clone(), root.clone()).unwrap();
        assert!(!root.exists());
        let project = files.project_directory("project-1", "海报/设计").unwrap();
        fs::write(project.join("keep.png"), b"original").unwrap();
        files.configure(&temp.path().join("second")).unwrap();
        let reopened = FileWorkspace::open(config, temp.path().join("different-default")).unwrap();
        assert_eq!(reopened.project_directory("project-1", "改名").unwrap(), fs::canonicalize(&project).unwrap());
        assert!(reopened.project_directory("project-2", "另一个").unwrap().starts_with(reopened.ensure_root().unwrap()));
        assert_eq!(fs::read(project.join("keep.png")).unwrap(), b"original");
        assert!(files.project_directory("../escape", "bad").is_err());
    }
    #[test]
    fn generated_files_follow_the_frozen_project_without_moving_the_database() {
        let temp = Temp::new();
        let files = std::sync::Arc::new(FileWorkspace::open(temp.path().join("settings.json"), temp.path().join("BowerbirdLibrary")).unwrap());
        let mut paths = crate::core::paths::LibraryPaths::init(temp.path().join("old-library")).unwrap();
        paths.files = Some(files);
        let db = crate::db::Database::open(&paths.db).unwrap(); db.migrate().unwrap();
        db.create_project("project-one", "一", "", "blank:project-one", "blank").unwrap();
        db.create_project("project-two", "二", "", "blank:project-two", "blank").unwrap();
        let source = temp.path().join("source.png");
        image::RgbImage::from_pixel(16, 12, image::Rgb([120, 80, 20])).save(&source).unwrap();
        let first = paths.for_project(&db, Some("project-one")).unwrap();
        let second = paths.for_project(&db, Some("project-two")).unwrap();
        let a = crate::core::ingest::ingest_generated(&first, &db, &source, Some("session"), "test").unwrap();
        let b = crate::core::ingest::ingest_generated(&second, &db, &source, Some("session"), "test").unwrap();
        assert_ne!(Path::new(a.store_path.as_ref().unwrap()).parent(), Path::new(b.store_path.as_ref().unwrap()).parent());
        assert!(Path::new(a.store_path.as_ref().unwrap()).starts_with(first.destination.unwrap()));
        let collected = crate::core::ingest::ingest_generated(&paths, &db, &source, None, "test").unwrap();
        assert_eq!(Path::new(collected.store_path.as_ref().unwrap()).parent().unwrap().file_name().unwrap(), "收集箱");
        assert_eq!(paths.db, temp.path().join("old-library/library.db"));
        assert!(db.get_asset(&a.id).unwrap().is_some());
        assert_eq!(db.index_external(&paths, Path::new(a.store_path.as_ref().unwrap())).unwrap().id, a.id);
        assert!(!db.is_external_asset(&a.id).unwrap());
        assert!(paths.managed_file_root(Path::new(a.store_path.as_ref().unwrap())).is_some());
        assert!(paths.managed_file_root(&source).is_none());
    }
    #[test]
    fn unavailable_root_does_not_fall_back_and_browsing_does_not_register_places() {
        let temp = Temp::new();
        let root = temp.path().join("root");
        fs::write(&root, b"not a directory").unwrap();
        let files = FileWorkspace::open(temp.path().join("config.json"), root).unwrap();
        assert!(files.ensure_root().unwrap_err().to_string().contains("FILE_ROOT_REQUIRED"));
        assert!(files.snapshot().root.is_none());
        assert!(files.snapshot().places.is_empty());
        let location = temp.path().join("nas"); fs::create_dir(&location).unwrap();
        let saved = files.set_place(&location, true).unwrap();
        let canonical = saved.places[0].clone();
        fs::remove_dir(&location).unwrap();
        assert!(files.set_place(&canonical, false).unwrap().places.is_empty());
    }
}
