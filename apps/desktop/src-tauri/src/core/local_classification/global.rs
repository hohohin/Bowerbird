//! Global rules live in the local library database. Folder records stay independent.
use super::data::Label;
use crate::{core::{file_workspace::FileWorkspaceConfig, paths::LibraryPaths}, db::Database};
use std::{collections::{HashMap, HashSet}, path::Path, sync::atomic::{AtomicBool, Ordering}};

#[derive(serde::Serialize)]
pub struct Picture {
    pub id: String,
    pub path: String,
    pub tags: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct View {
    pub labels: Vec<Label>,
    pub pictures: Vec<Picture>,
}

/// Reading an aggregate never imports or writes to the original files.
pub fn view(db: &Database, paths: &[String]) -> Result<View, String> {
    let mut labels = db.local_labels().map_err(|e| e.to_string())?;
    let json = serde_json::to_string(paths).map_err(|e| e.to_string())?;
    let conn = db.conn.lock().unwrap();
    let mut statement = conn.prepare(
        "WITH requested AS (SELECT DISTINCT value FROM json_each(?1)), located AS (\
         SELECT a.id,p.value AS path FROM requested p JOIN assets a ON a.store_path=p.value \
         UNION SELECT a.id,p.value FROM requested p JOIN external_asset_paths e ON e.path=p.value JOIN assets a ON a.id=e.asset_id) \
         SELECT a.id,a.path,t.tag_id FROM located a LEFT JOIN asset_tags t ON t.asset_id=a.id ORDER BY a.id,a.path"
    ).map_err(|e| e.to_string())?;
    let rows = statement.query_map([json], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?)))
        .map_err(|e| e.to_string())?;
    let mut pictures: Vec<Picture> = vec![];
    let mut counts = HashMap::<String, i64>::new();
    let mut counted = HashSet::new();
    for row in rows {
        let (id, path, tag) = row.map_err(|e| e.to_string())?;
        if pictures.last().is_none_or(|p| p.id != id || p.path != path) { pictures.push(Picture { id: id.clone(), path, tags: vec![] }); }
        if let Some(tag) = tag {
            if counted.insert((id, tag.clone())) { *counts.entry(tag.clone()).or_default() += 1; }
            pictures.last_mut().unwrap().tags.push(tag);
        }
    }
    for label in &mut labels { label.count = counts.get(&label.id).copied().unwrap_or(0); }
    Ok(View { labels, pictures })
}

pub struct Scope {
    pub ids: HashSet<String>,
    pub unavailable: Vec<String>,
    pub failed: usize,
}

pub fn project_ids(db: &Database, project: &str) -> Result<HashSet<String>, String> {
    if db.get_project(project).map_err(|e| e.to_string())?.is_none() {
        return Err("项目已不存在".into());
    }
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT a.id FROM project_assets p JOIN assets a ON a.id=p.asset_id WHERE p.project_id=?1 AND a.library_hidden=0")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([project], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())
}

pub fn project_labels(db: &Database, project: &str) -> Result<Vec<Label>, String> {
    let ids = project_ids(db, project)?;
    let mut labels = db.local_labels().map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    let conn = db.conn.lock().unwrap();
    let mut stmt = conn.prepare("SELECT tag_id,COUNT(*) FROM asset_tags WHERE asset_id IN (SELECT value FROM json_each(?1)) GROUP BY tag_id")
        .map_err(|e| e.to_string())?;
    let counts = stmt.query_map([json], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?.collect::<Result<HashMap<_, _>, _>>().map_err(|e| e.to_string())?;
    for label in &mut labels { label.count = counts.get(&label.id).copied().unwrap_or(0); }
    Ok(labels)
}

/// Called only by an explicit classification run, under the classifier task gate.
pub fn prepare(db: &Database, paths: &LibraryPaths, config: FileWorkspaceConfig, cancel: &AtomicBool,
    progress: impl Fn(String)) -> Result<Scope, String> {
    progress("正在读取全局素材位置".into());
    let files = crate::commands::file_workspace::collect_files(config).map_err(|e| e.to_string())?;
    let images: Vec<_> = files.entries.into_iter().filter(|e| crate::core::external_files::image_path(Path::new(&e.path))).collect();
    let mut scope = Scope { ids: HashSet::new(), unavailable: files.unavailable, failed: 0 };
    for (index, entry) in images.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) { break; }
        progress(format!("正在准备全局素材 {}/{}：{}", index + 1, images.len(), entry.name));
        match db.index_external(paths, Path::new(&entry.path)) {
            Ok(asset) => { scope.ids.insert(asset.id); }
            Err(error) => { scope.failed += 1; scope.unavailable.push(format!("{}：{error}", entry.path)); }
        }
    }
    Ok(scope)
}

/// Some(empty) is intentionally different from an unrestricted historical run.
pub fn retain_scope(targets: &mut Vec<String>, scope: Option<&HashSet<String>>) {
    if let Some(scope) = scope { targets.retain(|id| scope.contains(id)); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_scope_keeps_shared_rules_but_excludes_other_and_hidden_assets() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.create_project("p", "项目", "blank:p", "blank:p", "blank").unwrap();
        db.create_project("empty", "空项目", "blank:empty", "blank:empty", "blank").unwrap();
        db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,thumb_path,created_at,library_hidden) VALUES('a','a','png','a.png',1,0),('b','b','png','b.png',1,0),('hidden','hidden','png','h.png',1,1); INSERT INTO project_assets(project_id,asset_id,created_at) VALUES('p','a',1),('p','hidden',1);").unwrap();
        let label = db.save_local_label(None, "共享规则", "共享说明", true).unwrap();
        db.local_example(&label, &["a".into(), "b".into(), "hidden".into()], true).unwrap();
        let scope = project_ids(&db, "p").unwrap();
        assert_eq!(scope, HashSet::from(["a".into()]));
        let mut targets = vec!["a".into(), "b".into(), "hidden".into()];
        retain_scope(&mut targets, Some(&scope));
        assert_eq!(targets, vec!["a"]);
        let labels = project_labels(&db, "p").unwrap();
        assert_eq!(labels[0].id, label); assert_eq!(labels[0].count, 1);
        assert_eq!(db.local_labels().unwrap()[0].count, 3);
        assert_eq!(project_labels(&db, "empty").unwrap()[0].count, 0);
        retain_scope(&mut targets, Some(&project_ids(&db, "empty").unwrap()));
        assert!(targets.is_empty());
        assert!(project_ids(&db, "missing").is_err());
        assert!(project_labels(&db, "missing").is_err());
    }

    #[test]
    fn global_rules_keep_folder_records_and_scope_only_registered_images() {
        let root = std::env::temp_dir().join(format!("bb-global-classification-{}", uuid::Uuid::new_v4()));
        let library = LibraryPaths::init(root.join("local")).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let first = root.join("share-a"); let second = root.join("share-b");
        for folder in [&first, &second] {
            std::fs::create_dir_all(folder.join(".bowerbird")).unwrap();
            std::fs::write(folder.join(".bowerbird/classification.json"), b"existing independent classification").unwrap();
            image::RgbImage::new(16, 12).save(folder.join("photo.png")).unwrap();
        }
        let original = std::fs::read(first.join("photo.png")).unwrap();
        let config = FileWorkspaceConfig { places: vec![first.clone(), second.clone(), first.clone(), root.join("offline")], ..Default::default() };
        let scope = prepare(&db, &library, config, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(scope.ids.len(), 2); assert_eq!(scope.unavailable.len(), 1); assert_eq!(scope.failed, 0);
        db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,store_path,thumb_path,created_at) VALUES('outside','outside','png','/outside.png','/thumb.png',1)").unwrap();
        let label = db.save_local_label(None, "全局水彩", "统一规则", true).unwrap();
        db.local_example(&label, &scope.ids.iter().cloned().collect::<Vec<_>>(), true).unwrap();
        db.local_example(&label, &["outside".into()], true).unwrap();
        let paths: Vec<_> = [&first, &second].iter().map(|p| std::fs::canonicalize(p.join("photo.png")).unwrap().to_string_lossy().into_owned()).collect();
        let result = view(&db, &paths).unwrap();
        assert_eq!(result.pictures.len(), 2); assert_eq!(result.labels[0].count, 2);
        assert!(result.pictures.iter().all(|p| p.tags == vec![label.clone()]));
        // A retained alias after copying/relinking still exposes the same identity.
        db.conn.lock().unwrap().execute("INSERT INTO external_asset_paths(asset_id,path) VALUES(?1,'/alias.png')", [&result.pictures[0].id]).unwrap();
        let mut aliased = paths.clone(); aliased.push("/alias.png".into());
        let aliases = view(&db, &aliased).unwrap();
        assert_eq!(aliases.pictures.len(), 3); assert_eq!(aliases.labels[0].count, 2);
        let mut targets = db.local_targets_for_model(false, super::super::data::MODEL_ID).unwrap();
        retain_scope(&mut targets, Some(&scope.ids));
        assert_eq!(targets.len(), 2); assert!(!targets.contains(&"outside".into()));
        retain_scope(&mut targets, Some(&HashSet::new())); assert!(targets.is_empty());
        let empty = view(&db, &[]).unwrap(); assert!(empty.pictures.is_empty()); assert_eq!(empty.labels[0].count, 0);
        assert_eq!(std::fs::read(first.join("photo.png")).unwrap(), original);
        for folder in [&first, &second] {
            assert_eq!(std::fs::read(folder.join(".bowerbird/classification.json")).unwrap(), b"existing independent classification");
            assert_eq!(std::fs::read_dir(folder).unwrap().count(), 2, "no new files on source share");
        }
        let cancelled = prepare(&db, &library, FileWorkspaceConfig { places: vec![first], ..Default::default() }, &AtomicBool::new(true), |_| {}).unwrap();
        assert!(cancelled.ids.is_empty());
        std::fs::write(second.join("damaged.png"), b"not an image").unwrap();
        let partial = prepare(&db, &library, FileWorkspaceConfig { places: vec![second], ..Default::default() }, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(partial.ids.len(), 1); assert_eq!(partial.failed, 1);
        drop(db); std::fs::remove_dir_all(root).unwrap();
    }
}
