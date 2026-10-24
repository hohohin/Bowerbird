//! Portable folder records. The classifier runs against an isolated in-memory DB;
//! no SQLite connection is opened on a network share.
use super::{data::Label, LocalClassifier, Status};
use crate::{
    core::{external_files, paths::LibraryPaths},
    db::Database,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
};
use tauri::{AppHandle, Emitter};

const RECORD: &str = ".bowerbird/classification.json";
const MAX_RECORD_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Picture {
    pub id: String,
    pub path: String,
    pub fingerprint: String,
    pub tags: Vec<(String, String)>,
    pub rejected: Vec<String>,
    pub observation: Option<(String, String, i64)>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub version: u32,
    pub recursive: bool,
    pub labels: Vec<Label>,
    pub pictures: Vec<Picture>,
}
impl Default for Record {
    fn default() -> Self {
        Self {
            version: 1,
            recursive: false,
            labels: vec![],
            pictures: vec![],
        }
    }
}
#[derive(Serialize)]
pub struct FolderView {
    pub root: String,
    pub record: Record,
    pub storage: String,
}

pub(crate) fn local_record_root(root: &Path, local: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let key = root.to_string_lossy();
    #[cfg(target_os = "windows")]
    let key = key.to_lowercase();
    local.join(format!("{:x}", Sha256::digest(key.as_bytes())))
}
fn record_root(root: &Path, local: Option<&Path>) -> PathBuf {
    local.map(|p| local_record_root(root, p)).filter(|p| p.join(RECORD).is_file())
        .unwrap_or_else(|| root.to_path_buf())
}
fn has_record(root: &Path, local: Option<&Path>) -> bool { record_root(root, local).join(RECORD).is_file() }

fn safe_relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && !path.contains('\\')
        && !path.contains(':')
}
pub fn read(root: &Path) -> Result<Record, String> {
    let path = root.join(RECORD);
    let mut file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Record::default()),
        Err(e) => return Err(format!("无法读取文件夹分类记录：{e}")),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_RECORD_BYTES {
        return Err("分类记录超过大小限制".into());
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(&mut file, MAX_RECORD_BYTES + 1),
        &mut bytes,
    )
    .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err("分类记录超过大小限制".into());
    }
    let record: Record =
        serde_json::from_slice(&bytes).map_err(|e| format!("分类记录损坏，原文件已保留：{e}"))?;
    if record.version != 1 {
        return Err("此文件夹分类版本不受支持，请升级应用".into());
    }
    if record.labels.iter().any(|l| l.dimension.as_deref().is_some_and(|d| d != "other" && !matches!(d, "subject" | "type" | "style" | "mood"))) {
        return Err("分类记录包含无效标签维度，原文件已保留".into());
    }
    for label in &record.labels {
        if let Some(english) = &label.english {
            english.validate(&label.description).map_err(|e| e.to_string())?;
        }
    }
    let ids: HashSet<_> = record.labels.iter().map(|l| l.id.as_str()).collect();
    let pictures: HashSet<_> = record.pictures.iter().map(|p| p.id.as_str()).collect();
    let paths: HashSet<_> = record.pictures.iter().map(|p| p.path.as_str()).collect();
    if ids.len() != record.labels.len()
        || pictures.len() != record.pictures.len()
        || paths.len() != record.pictures.len()
        || record.pictures.iter().any(|p| {
            !safe_relative(&p.path)
                || p.tags.iter().any(|(id, origin)| {
                    !ids.contains(id.as_str())
                        || !["manual", "local", "legacy"].contains(&origin.as_str())
                })
                || p.rejected.iter().any(|id| !ids.contains(id.as_str()))
        })
    {
        return Err("分类记录包含无效路径或标签关联".into());
    }
    Ok(record)
}
pub fn view(path: &str) -> Result<FolderView, String> {
    view_with_storage(path, None)
}
pub fn view_with_storage(path: &str, local: Option<&Path>) -> Result<FolderView, String> {
    let directory = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !directory.is_dir() {
        return Err("请选择文件夹".into());
    }
    for root in directory.ancestors() {
        if has_record(root, local) {
            let storage_root = record_root(root, local);
            let record = read(&storage_root)?;
            if root == directory || record.recursive {
                return Ok(FolderView {
                    root: root.to_string_lossy().into_owned(),
                    record,
                    storage: if storage_root == root { "folder" } else { "local" }.into(),
                });
            }
            break;
        }
    }
    Ok(FolderView {
        root: directory.to_string_lossy().into_owned(),
        record: Record::default(),
        storage: "folder".into(),
    })
}

/// Return only the preview captured when this label was created.
pub fn source_preview(root: &str, local: Option<&Path>, paths: &LibraryPaths, tag_id: &str) -> Result<Option<String>, String> {
    let view = view_with_storage(root, local)?;
    let label = view.record.labels.iter().find(|l| l.id == tag_id).ok_or("标签已不存在")?;
    let Some(id) = label.provenance.as_ref().and_then(|p| p.asset_id.as_ref()) else { return Ok(None); };
    let Some(picture) = view.record.pictures.iter().find(|p| &p.id == id) else { return Ok(None); };
    let source = std::path::Path::new(&view.root).join(&picture.path);
    let canonical = match source.canonicalize() { Ok(path) => path, Err(_) => return Ok(None) };
    if !canonical.starts_with(&view.root) || crate::core::external_files::fingerprint(&canonical).ok().as_deref() != Some(&picture.fingerprint) { return Ok(None); }
    let preview = paths.root.join("folder-classification-previews").join(format!("{}.jpg", picture.fingerprint));
    let expected = label.provenance.as_ref().and_then(|p| p.preview_hash.as_ref());
    if expected.is_some() && !preview.exists() {
        crate::media::thumb::generate(&canonical, &preview, 480).map_err(|e| e.to_string())?;
    }
    Ok(expected.filter(|hash| crate::core::external_files::fingerprint(&preview).ok().as_ref() == Some(hash))
        .map(|_| preview.to_string_lossy().into_owned()))
}

pub fn tagged_images(path: &str, tag_id: &str) -> Result<Vec<external_files::FileEntry>, String> {
    tagged_images_with_storage(path, tag_id, None)
}
pub fn tagged_images_with_storage(path: &str, tag_id: &str, local: Option<&Path>) -> Result<Vec<external_files::FileEntry>, String> {
    let directory = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let scope = view_with_storage(path, local)?;
    let root = PathBuf::from(&scope.root);
    let mut entries = Vec::new();
    let mut allowed_directories = HashMap::new();
    for picture in scope.record.pictures {
        if !picture.tags.iter().any(|(id, _)| id == tag_id) {
            continue;
        }
        let file = root.join(&picture.path);
        if !file.starts_with(&directory)
            || (!scope.record.recursive && file.parent() != Some(root.as_path()))
            || !external_files::image_path(&file)
        {
            continue;
        }
        // Records survive missing files and changes in scope. Only show existing
        // images still owned by this catalog, without reading their pixels.
        let allowed = file.parent().into_iter().flat_map(Path::ancestors)
            .take_while(|parent| *parent != root)
            .all(|parent| *allowed_directories.entry(parent.to_path_buf()).or_insert_with(|| {
                fs::symlink_metadata(parent).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
                    && !has_record(parent, local)
            }));
        if !allowed || !fs::symlink_metadata(&file).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
            continue;
        }
        if !fs::canonicalize(&file).is_ok_and(|p| p.starts_with(&root) && p.starts_with(&directory)) {
            continue;
        }
        entries.push(external_files::FileEntry {
            name: file.file_name().unwrap().to_string_lossy().into_owned(),
            path: file.to_string_lossy().into_owned(),
            directory: false,
            ..Default::default()
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.path.cmp(&b.path)));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    struct Fixture {
        root: PathBuf,
        cache: LibraryPaths,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("bowerbird-folder-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("a/sub")).unwrap();
            fs::create_dir_all(root.join("b")).unwrap();
            Self {
                cache: LibraryPaths::init(root.join("cache")).unwrap(),
                root,
            }
        }
        fn image(&self, path: &str, color: u8) {
            image::RgbImage::from_pixel(16, 12, image::Rgb([color, 80, 120]))
                .save(self.root.join(path))
                .unwrap();
        }
        fn open(&self, path: &str) -> Session {
            Session::open(self.root.join(path).to_str().unwrap()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn folder_english_survives_roundtrip_and_library_updates_stay_isolated() {
        use super::super::data::EnglishLabel;
        let f = Fixture::new();
        let main = Database::open_in_memory().unwrap();
        main.migrate().unwrap();
        main.save_local_label(None, "主库规则", "排除背景", true).unwrap();
        let initial = main.local_labels().unwrap().remove(0);
        let main_english = EnglishLabel { name: "Library Rule".into(), description: "Exclude backgrounds.".into() };
        main.cache_label_english(&initial, &main_english).unwrap();
        let a = f.open("a");
        a.inherit_labels(&main.local_labels().unwrap()).unwrap();
        a.save().unwrap();
        assert_eq!(a.db.local_labels().unwrap().remove(0).english.as_ref(), Some(&main_english));
        a.db.save_local_label(Some(&initial.id), &initial.name, "目录自己的规则", true).unwrap();
        let folder_label = a.db.local_labels().unwrap().remove(0);
        let folder_english = EnglishLabel { name: "Folder Rule".into(), description: "Use this folder's own criteria.".into() };
        assert!(a.db.cache_label_english(&folder_label, &folder_english).unwrap());
        a.save().unwrap();
        drop(a);

        let reopened = f.open("a");
        assert_eq!(reopened.db.local_labels().unwrap().remove(0).english.as_ref(), Some(&folder_english));
        main.save_local_label(Some(&initial.id), &initial.name, "主库新规则", true).unwrap();
        let changed_main = main.local_labels().unwrap().remove(0);
        let changed_english = EnglishLabel { name: "Changed Library Rule".into(), description: "Changed library criteria.".into() };
        main.cache_label_english(&changed_main, &changed_english).unwrap();
        let added_id = main.save_local_label(None, "新主库标签", "新增定义", true).unwrap();
        let added = main.local_labels().unwrap().into_iter().find(|label| label.id == added_id).unwrap();
        main.cache_label_english(&added, &main_english).unwrap();
        reopened.inherit_labels(&main.local_labels().unwrap()).unwrap();
        reopened.save().unwrap();
        let labels = reopened.db.local_labels().unwrap();
        assert_eq!(labels.iter().find(|l| l.id == initial.id).unwrap().english.as_ref(), Some(&folder_english));
        assert_eq!(labels.iter().find(|l| l.id == added_id).unwrap().english.as_ref(), Some(&main_english));
        assert_eq!(main.local_labels().unwrap().iter().find(|l| l.id == initial.id).unwrap().english.as_ref(), Some(&changed_english));
        let record = read(&reopened.root).unwrap();
        assert_eq!(record.labels.iter().find(|l| l.id == initial.id).unwrap().english.as_ref(), Some(&folder_english));
    }

    #[test]
    fn folder_old_json_without_english_still_opens_and_caches_translation() {
        use super::super::data::EnglishLabel;
        let f = Fixture::new();
        let a = f.open("a");
        a.db.save_local_label(None, "旧目录标签", "原有规则", true).unwrap();
        a.save().unwrap();
        let path = a.root.join(RECORD);
        drop(a);
        let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        record["labels"][0].as_object_mut().unwrap().remove("english");
        fs::write(&path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
        let a = f.open("a");
        let label = a.db.local_labels().unwrap().remove(0);
        assert!(label.english.is_none());
        let translated = EnglishLabel { name: "Old Folder Label".into(), description: "Original criteria.".into() };
        a.db.cache_label_english(&label, &translated).unwrap();
        a.save().unwrap();
        assert_eq!(read(&a.root).unwrap().labels[0].english.as_ref(), Some(&translated));
    }

    #[test]
    fn folder_cloud_english_is_saved_with_chinese_rule_and_source() {
        use super::super::{cloud::NewLabel, data::{EnglishLabel, Prediction}};
        let f = Fixture::new();
        f.image("a/source.png", 20);
        let a = f.open("a");
        a.scan(&f.cache, false, &AtomicBool::new(false)).unwrap();
        let asset = a.db.local_targets(true).unwrap().remove(0);
        let english = EnglishLabel { name: "Paper Cutout".into(), description: "Layered cut paper; exclude flat printed graphics.".into() };
        let definition = NewLabel { name: "剪纸".into(), definition: "多层剪纸，排除平面印刷图案".into(), english: Some(english.clone()) };
        let prediction = Prediction { description: r#"{"reason":"明确的纸张层次"}"#.into(), tags: vec![definition.name.clone()], matches: vec![] };
        a.db.apply_classification_with_definitions(&asset, a.db.local_revision().unwrap(), &prediction, true, &[], super::super::jev::OBSERVATION_MODEL, &[definition]).unwrap();
        a.save().unwrap();
        drop(a);
        let reopened = f.open("a");
        let label = reopened.db.local_labels().unwrap().remove(0);
        assert_eq!(label.name, "剪纸");
        assert_eq!(label.description, "多层剪纸，排除平面印刷图案");
        assert_eq!(label.english.as_ref(), Some(&english));
        assert_eq!(label.provenance.as_ref().unwrap().kind, "cloud");
        assert_eq!(label.provenance.as_ref().unwrap().asset_id.as_deref(), Some(asset.as_str()));
        assert_eq!(label.count, 1);
    }

    #[test]
    fn folder_inherits_thirty_rules_and_keeps_five_discoveries_local() {
        let f = Fixture::new();
        f.image("a/p.png", 10);
        let main = Database::open_in_memory().unwrap();
        main.migrate().unwrap();
        for i in 0..30 {
            main.save_local_label(None, &format!("主库{i:02}"), "主库定义", i != 29).unwrap();
        }
        let initial = main.local_labels().unwrap();
        let a = f.open("a");
        a.inherit_labels(&initial).unwrap();
        a.scan(&f.cache, false, &AtomicBool::new(false)).unwrap();
        assert_eq!(a.db.local_labels().unwrap().len(), 30);
        assert!(a.db.local_labels().unwrap().iter().all(|l| l.count == 0 && !l.has_examples && l.provenance.as_ref().unwrap().kind == "library"));
        let image = a.db.local_targets(true).unwrap().remove(0);
        for i in 0..5 {
            let name = format!("新增{i}");
            let prediction = super::super::data::Prediction { description: r#"{"reason":"新视觉特征"}"#.into(), tags: vec![name.clone()], matches: vec![] };
            a.db.apply_classification_with_definitions(&image, a.db.local_revision().unwrap(), &prediction, true, &[], super::super::jev::OBSERVATION_MODEL,
                &[super::super::cloud::NewLabel { name, definition: "目录独有".into(), english: None }]).unwrap();
        }
        a.db.save_local_label(Some(&initial[0].id), &initial[0].name, "目录人工调整", false).unwrap();
        a.save().unwrap();
        assert_eq!(main.local_labels().unwrap().len(), 30);
        assert_eq!(serde_json::to_value(main.local_labels().unwrap()).unwrap(), serde_json::to_value(&initial).unwrap());
        drop(a);
        let reopened = f.open("a");
        assert_eq!(reopened.db.local_labels().unwrap().len(), 35);
        main.save_local_label(Some(&initial[0].id), &initial[0].name, "主库后来调整", true).unwrap();
        main.save_local_label(None, "新增0", "同名主库定义", true).unwrap();
        let added = main.save_local_label(None, "主库后来新增", "新规则", true).unwrap();
        reopened.inherit_labels(&main.local_labels().unwrap()).unwrap();
        reopened.save().unwrap();
        let labels = reopened.db.local_labels().unwrap();
        assert_eq!(labels.len(), 36);
        let kept = labels.iter().find(|l| l.id == initial[0].id).unwrap();
        assert_eq!(kept.description, "目录人工调整");
        assert!(!kept.enabled);
        assert!(labels.iter().any(|l| l.id == added && l.description == "新规则"));
        let cloud = labels.iter().find(|l| l.name == "新增0").unwrap();
        assert_eq!(cloud.description, "目录独有");
        assert_eq!(cloud.provenance.as_ref().unwrap().kind, "cloud");
        let root = reopened.root.to_str().unwrap();
        assert!(source_preview(root, None, &f.cache, &cloud.id).unwrap().is_some());
        let fresh_cache = LibraryPaths::init(f.root.join("fresh-cache")).unwrap();
        let saved_record = fs::read(reopened.root.join(RECORD)).unwrap();
        assert!(source_preview(root, None, &fresh_cache, &cloud.id).unwrap().is_some(), "a portable record can rebuild its missing local preview");
        assert_eq!(fs::read(reopened.root.join(RECORD)).unwrap(), saved_record, "viewing evidence never rewrites folder rules");
        f.image("a/p.png", 230);
        assert!(source_preview(root, None, &f.cache, &cloud.id).unwrap().is_none());
        reopened.scan(&f.cache, false, &AtomicBool::new(false)).unwrap();
        reopened.save().unwrap();
        assert!(source_preview(root, None, &f.cache, &cloud.id).unwrap().is_none(), "rescanning a changed image must not change creation evidence");
        fs::remove_file(f.root.join("a/p.png")).unwrap();
        assert!(source_preview(root, None, &f.cache, &cloud.id).unwrap().is_none());
    }

    #[test]
    fn tag_results_flatten_only_existing_images_in_the_current_subtree() {
        let f = Fixture::new();
        fs::create_dir_all(f.root.join("a/sub/deep")).unwrap();
        fs::create_dir_all(f.root.join("a/submarine")).unwrap();
        for path in ["a/p.png", "a/sub/n.png", "a/sub/deep/d.png", "a/submarine/s.png"] {
            f.image(path, 10);
        }
        let a = f.open("a");
        a.scan(&f.cache, true, &AtomicBool::new(false)).unwrap();
        let tag = a.db.save_local_label(None, "自然", "", true).unwrap();
        a.db.local_example(&tag, &a.db.local_targets(true).unwrap(), true).unwrap();
        a.save().unwrap();
        let root = a.root.clone();
        drop(a);
        let before = fs::read(root.join(RECORD)).unwrap();
        let all = tagged_images(root.to_str().unwrap(), &tag).unwrap();
        assert_eq!(all.len(), 4);
        assert!(all.iter().all(|e| !e.directory));
        let sub = tagged_images(root.join("sub").to_str().unwrap(), &tag).unwrap();
        assert_eq!(sub.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["d.png", "n.png"]);
        assert!(tagged_images(root.to_str().unwrap(), "unknown").unwrap().is_empty());
        fs::remove_file(root.join("p.png")).unwrap();
        let nested = f.open("a/sub/deep");
        nested.save().unwrap();
        drop(nested);
        let remaining = tagged_images(root.to_str().unwrap(), &tag).unwrap();
        assert_eq!(remaining.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["n.png", "s.png"]);
        assert_eq!(fs::read(root.join(RECORD)).unwrap(), before); // browsing never rewrites the catalog
        let mut record = read(&root).unwrap();
        record.recursive = false; // old descendant records may remain after shrinking the scope
        fs::write(root.join(RECORD), serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(tagged_images(root.to_str().unwrap(), &tag).unwrap().is_empty());
    }

    #[test]
    fn full_rescan_reset_survives_stop_and_folder_reopen() {
        let f = Fixture::new();
        f.image("a/p.png", 10);
        f.image("a/q.png", 20);
        let a = f.open("a");
        a.scan(&f.cache, false, &AtomicBool::new(false)).unwrap();
        let ids = a.db.local_targets(false).unwrap();
        let manual = a.db.save_local_label(None, "人工", "人工定义", true).unwrap();
        let automatic = a.db.save_local_label(None, "旧自动", "自动定义", true).unwrap();
        a.db.local_example(&manual, &ids[..1], true).unwrap();
        for id in &ids {
            a.db.apply_local_prediction(id, a.db.local_revision().unwrap(), &super::super::data::Prediction {
                matches:vec![automatic.clone()], tags:vec![], description:"旧结果".into(),
            }, true, &[]).unwrap();
        }
        a.save().unwrap();
        let (_, targets) = a.db.reset_classification_results(&ids, a.db.local_revision().unwrap()).unwrap();
        assert_eq!(targets, ids[1..]);
        a.save().unwrap(); // No model result follows: cancellation / failed request.
        drop(a);
        let reopened = f.open("a");
        reopened.scan(&f.cache, false, &AtomicBool::new(false)).unwrap();
        assert_eq!(reopened.db.local_targets(true).unwrap(), targets);
        assert_eq!(reopened.db.list_asset_tags(&ids[0]).unwrap().len(), 2);
        assert!(reopened.db.list_asset_tags(&ids[1]).unwrap().is_empty());
        assert_eq!(reopened.db.local_examples(&manual, "").unwrap(), vec![(ids[0].clone(), true)]);
        assert!(reopened.db.local_labels().unwrap().iter().any(|l| l.id==automatic && l.description=="自动定义"));
    }

    #[test]
    fn folder_records_isolate_labels_and_move_without_original_copies() {
        let f = Fixture::new();
        f.image("a/p.png", 10);
        let a = f.open("a");
        a.scan(&f.cache, false, &AtomicBool::new(false)).unwrap();
        let id = a.db.local_targets(true).unwrap()[0].clone();
        let tag =
            a.db.save_local_label(None, "产品", "仅目录 A", true)
                .unwrap();
        a.db.local_example(&tag, &[id.clone()], true).unwrap();
        a.db.cache_label_dimensions(a.db.local_revision().unwrap(), &a.db.local_labels().unwrap(), &["subject".into()]).unwrap();
        a.save().unwrap();
        let text = fs::read_to_string(a.root.join(RECORD)).unwrap();
        assert!(!text.contains(&f.root.to_string_lossy().replace('\\', "\\\\")));
        assert_eq!(fs::read_dir(&a.root).unwrap().count(), 3); // sub, original, metadata
        assert!(f.open("b").db.local_labels().unwrap().is_empty());
        let main = Database::open_in_memory().unwrap();
        main.migrate().unwrap();
        assert!(main.local_labels().unwrap().is_empty());
        drop(a);
        fs::rename(f.root.join("a"), f.root.join("moved")).unwrap();
        let moved = f.open("moved");
        moved
            .scan(&f.cache, false, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(moved.db.local_labels().unwrap()[0].name, "产品");
        assert_eq!(moved.db.local_labels().unwrap()[0].dimension.as_deref(), Some("subject"));
        assert_eq!(moved.db.local_targets(true).unwrap(), vec![id]);
    }
    #[test]
    fn scope_skips_nested_catalogs_and_changed_pixels_invalidate_automatic_results() {
        let f = Fixture::new();
        f.image("a/p.png", 10);
        f.image("a/sub/n.png", 20);
        let a = f.open("a");
        a.scan(&f.cache, false, &AtomicBool::new(false)).unwrap();
        assert_eq!(a.db.local_targets(true).unwrap().len(), 1);
        let id = a.db.local_targets(true).unwrap()[0].clone();
        let prediction = super::super::data::Prediction {
            description: "picture".into(),
            tags: vec!["摄影".into()],
            matches: vec![],
        };
        a.db.apply_local_prediction(&id, 0, &prediction, true, &[])
            .unwrap();
        a.save().unwrap();
        drop(a);
        f.image("a/p.png", 90);
        let a = f.open("a");
        a.scan(&f.cache, true, &AtomicBool::new(false)).unwrap();
        a.save().unwrap();
        assert_eq!(a.db.local_targets(true).unwrap().len(), 2);
        assert_eq!(
            read(&a.root)
                .unwrap()
                .pictures
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .tags
                .len(),
            0
        );
        drop(a);
        let sub = f.open("a/sub");
        sub.save().unwrap();
        drop(sub);
        let a = f.open("a");
        a.scan(&f.cache, true, &AtomicBool::new(false)).unwrap();
        assert_eq!(a.db.local_targets(true).unwrap().len(), 1);
        assert_eq!(
            view(f.root.join("a/sub").to_str().unwrap()).unwrap().root,
            f.root
                .join("a/sub")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
        );
    }
    #[test]
    #[cfg(windows)]
    fn readonly_catalog_uses_persistent_local_records_and_preserves_scope() {
        let f = Fixture::new();
        f.image("a/p.png", 10); f.image("a/sub/n.png", 20);
        let a = f.open("a");
        a.scan(&f.cache, true, &AtomicBool::new(false)).unwrap(); a.save().unwrap();
        let root = a.root.clone(); drop(a);
        let original = fs::read(root.join(RECORD)).unwrap();
        let mut permissions = fs::metadata(root.join(RECORD)).unwrap().permissions();
        permissions.set_readonly(true); fs::set_permissions(root.join(RECORD), permissions).unwrap();
        let local = f.root.join("persistent-records");
        let a = Session::open_with_storage(root.to_str().unwrap(), Some(&local)).unwrap();
        assert_ne!(a.storage_root, root);
        a.scan(&f.cache, true, &AtomicBool::new(false)).unwrap();
        let tag = a.db.save_local_label(None, "本机分类", "", true).unwrap();
        a.db.local_example(&tag, &a.db.local_targets(true).unwrap(), true).unwrap(); a.save().unwrap();
        assert!(Session::open_with_storage(root.to_str().unwrap(), Some(&local)).is_err());
        drop(a);
        let view = view_with_storage(root.to_str().unwrap(), Some(&local)).unwrap();
        assert_eq!(view.storage, "local");
        assert_eq!(tagged_images_with_storage(root.to_str().unwrap(), &tag, Some(&local)).unwrap().len(), 2);
        let nested = Session::open_with_storage(root.join("sub").to_str().unwrap(), Some(&local)).unwrap();
        nested.save().unwrap(); drop(nested);
        assert_eq!(tagged_images_with_storage(root.to_str().unwrap(), &tag, Some(&local)).unwrap().len(), 1);
        assert_eq!(fs::read(root.join(RECORD)).unwrap(), original);
        let mut permissions = fs::metadata(root.join(RECORD)).unwrap().permissions();
        permissions.set_readonly(false); fs::set_permissions(root.join(RECORD), permissions).unwrap();
        // Restoring permission does not overwrite either version silently.
        let reopened = Session::open_with_storage(root.to_str().unwrap(), Some(&local)).unwrap();
        assert_ne!(reopened.storage_root, root);
        assert_eq!(reopened.db.local_labels().unwrap()[0].name, "本机分类");
    }
    #[test]
    fn writer_lock_and_invalid_records_preserve_last_good_data() {
        let f = Fixture::new();
        let a = f.open("a");
        a.save().unwrap();
        assert!(Session::open(a.root.to_str().unwrap()).is_err());
        let good = fs::read(a.root.join(RECORD)).unwrap();
        fs::write(&a.lock, "another-owner").unwrap();
        assert!(a.save().is_err());
        assert_eq!(fs::read(a.root.join(RECORD)).unwrap(), good);
        let root = a.root.clone();
        drop(a);
        assert!(root.join(".bowerbird/classification.lock").exists());
        fs::remove_file(root.join(".bowerbird/classification.lock")).unwrap();
        fs::write(root.join(RECORD), b"not json").unwrap();
        assert!(Session::open(root.to_str().unwrap()).is_err());
        assert_eq!(fs::read(root.join(RECORD)).unwrap(), b"not json");
        assert!(!root.join(".bowerbird/classification.lock").exists());
    }
    #[test]
    fn changed_original_during_model_wait_does_not_publish_stale_result() {
        let f = Fixture::new();
        f.image("a/p.png", 10);
        let a = f.open("a");
        a.scan(&f.cache, false, &AtomicBool::new(false)).unwrap();
        a.save().unwrap();
        let before = fs::read(a.root.join(RECORD)).unwrap();
        let id = a.db.local_targets(true).unwrap()[0].clone();
        f.image("a/p.png", 90);
        let prediction = super::super::data::Prediction {
            description: "old pixels".into(),
            tags: vec!["风景".into()],
            matches: vec![],
        };
        a.db.apply_local_prediction(&id, 0, &prediction, true, &[])
            .unwrap();
        assert!(a.save().is_err());
        assert_eq!(fs::read(a.root.join(RECORD)).unwrap(), before);
        assert!(!safe_relative("../outside.png"));
        assert!(!safe_relative("C:/outside.png"));
    }
}

pub struct Session {
    pub root: PathBuf,
    pub db: Arc<Database>,
    record: Mutex<Record>,
    lock: PathBuf,
    token: String,
    storage_root: PathBuf,
    local: Option<PathBuf>,
}
impl Drop for Session {
    fn drop(&mut self) {
        if fs::read_to_string(&self.lock).ok().as_deref() == Some(&self.token) {
            let _ = fs::remove_file(&self.lock);
        }
    }
}
impl Session {
    pub fn open(root: &str) -> Result<Self, String> {
        Self::open_with_storage(root, None)
    }
    pub fn open_with_storage(root: &str, local: Option<&Path>) -> Result<Self, String> {
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        if !root.is_dir() {
            return Err("请选择文件夹".into());
        }
        let mut storage_root = record_root(&root, local);
        // Validate existing data before falling back; corruption is never treated as no permission.
        let record = read(&storage_root)?;
        let prepare = |storage: &Path| -> std::io::Result<()> {
            fs::create_dir_all(storage.join(".bowerbird"))?;
            if !fs::canonicalize(storage.join(".bowerbird"))?.starts_with(fs::canonicalize(storage)?) {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "分类数据目录不能链接到目标文件夹之外"));
            }
            if storage.join(RECORD).exists() { fs::OpenOptions::new().write(true).open(storage.join(RECORD))?; }
            let probe = storage.join(".bowerbird").join(format!("{}.probe", uuid::Uuid::new_v4()));
            let file = fs::OpenOptions::new().write(true).create_new(true).open(&probe)?;
            drop(file); fs::remove_file(probe)
        };
        if let Err(error) = prepare(&storage_root) {
            let readonly = error.kind() == std::io::ErrorKind::PermissionDenied
                || (cfg!(unix) && error.raw_os_error() == Some(30));
            if !readonly || storage_root != root || local.is_none() {
                return Err(format!("无法保存分类数据：{error}"));
            }
            storage_root = local_record_root(&root, local.unwrap());
            prepare(&storage_root).map_err(|e| format!("本机分类资料无法保存：{e}"))?;
            crate::core::file_workspace::write_json(&storage_root.join("source.json"), &serde_json::json!({
                "version": 1, "root": root, "storage": "local"
            })).map_err(|e| e.to_string())?;
        }
        let metadata = storage_root.join(".bowerbird");
        let resolved = fs::canonicalize(&metadata).map_err(|e| e.to_string())?;
        if !resolved.starts_with(fs::canonicalize(&storage_root).map_err(|e| e.to_string())?) {
            return Err("分类数据目录不能链接到目标文件夹之外".into());
        }
        let lock = metadata.join("classification.lock");
        let token = uuid::Uuid::new_v4().to_string();
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&lock)
            .map_err(|e| format!("无法取得文件夹写入锁：{e}。如上次异常退出，请确认所有设备均已停止分类后，移除 .bowerbird/classification.lock 再重试。"))?;
        if let Err(e) = file
            .write_all(token.as_bytes())
            .and_then(|_| file.sync_all())
        {
            let _ = fs::remove_file(&lock);
            return Err(e.to_string());
        }
        let result = (|| {
            let db = Arc::new(Database::open_in_memory().map_err(|e| e.to_string())?);
            db.migrate().map_err(|e| e.to_string())?;
            {
                let conn = db.conn.lock().unwrap();
                for l in &record.labels {
                    conn.execute("INSERT INTO tags(id,name,source,classification_description,classification_enabled,classification_dimension,classification_provenance,classification_english) VALUES(?1,?2,'auto',?3,?4,?5,?6,?7)",params![l.id,l.name,l.description,l.enabled,l.dimension,l.provenance.as_ref().map(serde_json::to_string).transpose().map_err(|e| e.to_string())?,l.english.as_ref().map(serde_json::to_string).transpose().map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
                }
                for p in &record.pictures {
                    conn.execute("INSERT INTO assets(id,name,ext,source,created_at) VALUES(?1,?2,'png','folder',0)",params![p.id,p.path]).map_err(|e| e.to_string())?;
                    for (tag, origin) in &p.tags {
                        conn.execute(
                            "INSERT INTO asset_tags(asset_id,tag_id,origin) VALUES(?1,?2,?3)",
                            params![p.id, tag, origin],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    for tag in &p.rejected {
                        conn.execute(
                            "INSERT INTO local_tag_rejections VALUES(?1,?2)",
                            params![p.id, tag],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    if let Some((model, text, at)) = &p.observation {
                        conn.execute(
                            "INSERT INTO local_visual_observations VALUES(?1,?2,?3,?4)",
                            params![p.id, model, text, at],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
            Ok(Self {
                root: root.clone(),
                db,
                record: Mutex::new(record),
                lock: lock.clone(),
                token: token.clone(),
                storage_root,
                local: local.map(Path::to_path_buf),
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(lock);
        }
        result
    }
    /// Copy missing rules into this folder's database only. Folder edits and
    /// discoveries remain authoritative; library asset identities are not copied.
    pub fn inherit_labels(&self, labels: &[Label]) -> Result<(), String> {
        let mut conn = self.db.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for label in labels {
            if let Some(english) = &label.english {
                english.validate(&label.description).map_err(|e| e.to_string())?;
            }
            let provenance = super::data::LabelProvenance {
                kind: "library".into(), asset_id: None, asset_name: None, reason: None,
                created_at: chrono::Utc::now().timestamp(),
                preview_hash: None,
            };
            tx.execute("INSERT INTO tags(id,name,source,classification_description,classification_enabled,classification_provenance,classification_english)
                SELECT ?1,?2,'auto',?3,?4,?5,?6 WHERE NOT EXISTS(SELECT 1 FROM tags WHERE id=?1 OR name=?2 COLLATE NOCASE)",
                params![label.id,label.name,label.description,label.enabled,serde_json::to_string(&provenance).map_err(|e| e.to_string())?,label.english.as_ref().map(serde_json::to_string).transpose().map_err(|e| e.to_string())?])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn scan(
        &self,
        paths: &LibraryPaths,
        recursive: bool,
        cancel: &std::sync::atomic::AtomicBool,
    ) -> Result<(), String> {
        let mut directories = vec![self.root.clone()];
        let mut record = self.record.lock().unwrap();
        record.recursive = recursive;
        let mut old: HashMap<String, Picture> = record
            .pictures
            .drain(..)
            .map(|p| (p.path.clone(), p))
            .collect();
        let mut pictures = Vec::new();
        while let Some(directory) = directories.pop() {
            for entry in fs::read_dir(directory).map_err(|e| format!("读取目录失败：{e}"))? {
                if cancel.load(Ordering::Relaxed) {
                    return Err("已停止扫描".into());
                }
                let entry = entry.map_err(|e| e.to_string())?;
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                let path = entry.path();
                if kind.is_dir() {
                    if recursive && !has_record(&path, self.local.as_deref()) {
                        directories.push(path);
                    }
                    continue;
                }
                if !kind.is_file() || !external_files::image_path(&path) {
                    continue;
                }
                let resolved = fs::canonicalize(&path).map_err(|e| e.to_string())?;
                if !resolved.starts_with(&self.root) {
                    continue;
                }
                let relative = path
                    .strip_prefix(&self.root)
                    .map_err(|e| e.to_string())?
                    .to_str()
                    .ok_or("文件路径不是有效 Unicode")?
                    .replace('\\', "/");
                let hash = external_files::fingerprint(&path).map_err(|e| e.to_string())?;
                let mut picture = old.remove(&relative).unwrap_or_else(|| Picture {
                    id: ulid::Ulid::new().to_string(),
                    path: relative,
                    ..Picture::default()
                });
                let thumbnail = paths
                    .root
                    .join("folder-classification-previews")
                    .join(format!("{hash}.jpg"));
                fs::create_dir_all(thumbnail.parent().unwrap()).map_err(|e| e.to_string())?;
                if !thumbnail.exists() {
                    crate::media::thumb::generate(&path, &thumbnail, 480)
                        .map_err(|e| e.to_string())?;
                }
                let thumb = thumbnail.to_string_lossy();
                if external_files::fingerprint(&path).map_err(|e| e.to_string())? != hash {
                    return Err("扫描时原图发生变化，请重试".into());
                }
                let conn = self.db.conn.lock().unwrap();
                conn.execute("INSERT OR IGNORE INTO assets(id,name,ext,source,created_at) VALUES(?1,?2,'png','folder',0)",params![picture.id,picture.path]).map_err(|e| e.to_string())?;
                if !picture.fingerprint.is_empty() && picture.fingerprint != hash {
                    conn.execute(
                        "DELETE FROM local_visual_observations WHERE asset_id=?1",
                        [&picture.id],
                    )
                    .map_err(|e| e.to_string())?;
                    conn.execute(
                        "DELETE FROM asset_tags WHERE asset_id=?1 AND origin='local'",
                        [&picture.id],
                    )
                    .map_err(|e| e.to_string())?;
                    // Changed pixels must not silently become a training example.
                    conn.execute("UPDATE asset_tags SET origin='legacy' WHERE asset_id=?1 AND origin='manual'",[&picture.id]).map_err(|e| e.to_string())?;
                    conn.execute(
                        "DELETE FROM local_tag_rejections WHERE asset_id=?1",
                        [&picture.id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                conn.execute(
                    "UPDATE assets SET thumb_path=?2,store_path=?3,origin_path=?3 WHERE id=?1",
                    params![picture.id, thumb, path.to_string_lossy()],
                )
                .map_err(|e| e.to_string())?;
                picture.fingerprint = hash;
                pictures.push(picture);
            }
        }
        // Unseen records are retained for reconnect/expanded scope; absent thumbnails
        // keep them out of this run and out of training examples.
        pictures.extend(old.into_values());
        pictures.sort_by(|a, b| a.path.cmp(&b.path));
        record.pictures = pictures;
        Ok(())
    }
    pub fn save(&self) -> Result<(), String> {
        self.save_checked(true)
    }
    fn save_checked(&self, validate_pixels: bool) -> Result<(), String> {
        if fs::read_to_string(&self.lock).map_err(|e| e.to_string())? != self.token {
            return Err("文件夹写入锁已失效".into());
        }
        let labels = self.db.local_labels().map_err(|e| e.to_string())?;
        let mut previous = self.record.lock().unwrap();
        let mut next = previous.clone();
        next.labels = labels;
        let old_by_id: HashMap<_, _> = previous.pictures.iter().map(|p| (&p.id, p)).collect();
        {
            let conn = self.db.conn.lock().unwrap();
            for picture in &mut next.pictures {
                let mut tags = conn
                    .prepare(
                        "SELECT tag_id,origin FROM asset_tags WHERE asset_id=?1 ORDER BY tag_id",
                    )
                    .map_err(|e| e.to_string())?;
                picture.tags = tags
                    .query_map([&picture.id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                let mut rejected = conn
                    .prepare(
                        "SELECT tag_id FROM local_tag_rejections WHERE asset_id=?1 ORDER BY tag_id",
                    )
                    .map_err(|e| e.to_string())?;
                picture.rejected = rejected
                    .query_map([&picture.id], |r| r.get(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                use rusqlite::OptionalExtension;
                picture.observation = conn.query_row("SELECT model,description,created_at FROM local_visual_observations WHERE asset_id=?1",[&picture.id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e| e.to_string())?;
                if validate_pixels
                    && old_by_id.get(&picture.id).is_some_and(|p| *p != picture)
                {
                    let path = fs::canonicalize(self.root.join(&picture.path))
                        .map_err(|e| e.to_string())?;
                    if !path.starts_with(&self.root)
                        || external_files::fingerprint(&path).map_err(|e| e.to_string())?
                            != picture.fingerprint
                    {
                        return Err(format!("原图已变化，本轮新增结果未保存：{}", picture.path));
                    }
                }
            }
        }
        let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            return Err("分类记录超过大小限制".into());
        }
        let temporary = self.storage_root.join(format!(".bowerbird/{}.tmp", self.token));
        let result = (|| -> Result<(), String> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|e| e.to_string())?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            drop(file);
            fs::rename(&temporary, self.storage_root.join(RECORD))
                .map_err(|e| format!("保存失败，上一份分类记录已保留：{e}"))?;
            Ok(())
        })();
        let _ = fs::remove_file(temporary);
        result?;
        *previous = next;
        Ok(())
    }
}

impl LocalClassifier {
    pub async fn edit_folder(
        &self,
        root: String,
        action: String,
        id: Option<String>,
        name: Option<String>,
        description: Option<String>,
        enabled: Option<bool>,
        ids: Option<Vec<String>>,
        positive: Option<bool>,
    ) -> Result<Option<String>, String> {
        let guard = self
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "请先停止分类任务，再修改文件夹标签")?;
        let local = self.folder_records_root();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let session = Session::open_with_storage(&root, Some(&local))?;
            let result = match action.as_str() {
                "save" => Some(
                    session
                        .db
                        .save_local_label(
                            id.as_deref(),
                            &name.unwrap_or_default(),
                            &description.unwrap_or_default(),
                            enabled.unwrap_or(true),
                        )
                        .map_err(|e| e.to_string())?,
                ),
                "delete" => {
                    session
                        .db
                        .delete_local_labels(&ids.unwrap_or_default())
                        .map_err(|e| e.to_string())?;
                    None
                }
                "example" => {
                    session
                        .db
                        .local_example(
                            &id.ok_or("缺少标签")?,
                            &ids.unwrap_or_default(),
                            positive.unwrap_or(true),
                        )
                        .map_err(|e| e.to_string())?;
                    None
                }
                _ => return Err("未知文件夹分类操作".into()),
            };
            session.save_checked(false)?;
            Ok(result)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    pub fn start_folder(
        self: &Arc<Self>,
        app: AppHandle,
        paths: Arc<LibraryPaths>,
        labels: Vec<Label>,
        root: String,
        recursive: bool,
        pending: bool,
        tag: Option<String>,
        use_jev: bool,
    ) -> Result<(), String> {
        let guard = self
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| "已有分类或下载任务在运行")?;
        if !use_jev && !super::runtime::installed(&self.root) {
            return Err("请先安装本地分类模型".into());
        }
        self.cancel.store(false, Ordering::Relaxed);
        self.background.store(false, Ordering::Relaxed);
        self.update(&app, |s| {
            *s = Status {
                run_id: ulid::Ulid::new().to_string(),
                busy: true,
                folder_root: Some(root.clone()),
                phase: "scanning".into(),
                message: "正在扫描文件夹图片…".into(),
                model: if use_jev {
                    super::jev::OBSERVATION_MODEL
                } else {
                    super::data::MODEL_ID
                }
                .into(),
                ..Status::default()
            }
        });
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _guard = guard;
            let result = async {
                let worker = this.clone();
                let cache = paths.clone();
                let session = tokio::task::spawn_blocking(move || {
                    let session = Session::open_with_storage(&root, Some(&worker.folder_records_root()))?;
                    session.inherit_labels(&labels)?;
                    session.scan(&cache, recursive, &worker.cancel)?;
                    session.save()?;
                    Ok::<_, String>(session)
                })
                .await
                .map_err(|e| e.to_string())??;
                this.run(&app, &session.db, &paths, tag, use_jev, pending, Some(&session), None)
                    .await
            }
            .await;
            this.update(&app, |s| {
                s.busy = false;
                s.current_asset = None;
                s.phase = if result.is_err() {
                    "error"
                } else if this.cancel.load(Ordering::Relaxed) {
                    "stopped"
                } else {
                    "complete"
                }
                .into();
                s.message = result.err().unwrap_or_else(|| {
                    if this.cancel.load(Ordering::Relaxed) {
                        "已停止，已保存的分类记录保留"
                    } else {
                        "文件夹分类完成"
                    }
                    .into()
                });
            });
            let _ = app.emit("folder-classification://changed", ());
        });
        Ok(())
    }
}
