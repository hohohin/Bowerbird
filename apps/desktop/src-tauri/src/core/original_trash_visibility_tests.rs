use crate::{
    core::{
        catalog_browser::CatalogFilter,
        creative_session_contract::{CreativeNodeKind, CreativeNodeRole},
        external_files,
        paths::LibraryPaths,
        project_canvas::NewCanvasNode,
    },
    db::Database,
};
use std::fs;

fn fixture() -> (tempfile::TempDir, LibraryPaths, Database, String) {
    let directory = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(directory.path()).unwrap();
    let paths = LibraryPaths::init(root.join("library")).unwrap();
    let db = Database::open(&paths.db).unwrap();
    db.migrate().unwrap();
    let source = root.join("original.png");
    image::RgbImage::from_pixel(4, 4, image::Rgb([10, 20, 30])).save(&source).unwrap();
    let asset = db.index_connected_file(&paths, &source, None).unwrap();
    (directory, paths, db, asset.id)
}

fn mark_trashed(db: &Database, id: &str) {
    let asset = db.get_asset(id).unwrap().unwrap();
    let path = asset.store_path.unwrap();
    let hash = external_files::fingerprint(std::path::Path::new(&path)).unwrap();
    let conn = db.conn.lock().unwrap();
    conn.execute("INSERT INTO trashed_asset_originals(asset_id,path,fingerprint) VALUES(?1,?2,?3)", rusqlite::params![id,path,hash]).unwrap();
    conn.execute("UPDATE assets SET library_hidden=1 WHERE id=?1", [id]).unwrap();
}

fn marker_count(db: &Database, id: &str) -> i64 {
    db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM trashed_asset_originals WHERE asset_id=?1", [id], |row| row.get(0)).unwrap()
}

#[test]
fn original_trash_visibility_excludes_external_original_from_all_and_tags() {
    let (_directory, _paths, db, id) = fixture();
    db.conn.lock().unwrap().execute_batch("INSERT INTO tags(id,name) VALUES('tag','保存的标签');").unwrap();
    db.conn.lock().unwrap().execute("INSERT INTO asset_tags(asset_id,tag_id) VALUES(?1,'tag')", [&id]).unwrap();
    mark_trashed(&db, &id);
    assert!(db.material_catalog_assets("tags", Some("tag"), None).unwrap().is_empty());
    let filter = CatalogFilter { kind: "all".into(), media: "images".into(), ..Default::default() };
    assert!(db.catalog_page(&filter, 0, 60).unwrap().is_empty());
    assert_eq!(db.catalog_overview(&filter, None).unwrap().total, 0);
    assert!(db.get_asset(&id).unwrap().is_some());
    let tags: i64 = db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM asset_tags WHERE asset_id=?1", [&id], |row| row.get(0)).unwrap();
    assert_eq!(tags, 1);
}

#[test]
fn original_trash_visibility_survives_last_canvas_instance_removal() {
    let (_directory, _paths, db, id) = fixture();
    db.create_project("project", "project", "blank:project", "project", "blank").unwrap();
    db.ensure_project_canvas("project").unwrap();
    db.create_canvas_node(&NewCanvasNode {
        id: "node".into(), project_id: "project".into(), thread_id: None,
        kind: CreativeNodeKind::Asset, asset_id: Some(id.clone()), role: Some(CreativeNodeRole::Reference),
        payload_json: r#"{"schema_version":1,"snapshot":{"name":"original"}}"#.into(), x: 0., y: 0., width: 100., height: 100., z_index: 1, position_locked: false,
    }).unwrap();
    mark_trashed(&db, &id);
    db.conn.lock().unwrap().execute("UPDATE canvas_nodes SET hidden_at=1 WHERE id='node'", []).unwrap();
    assert!(db.get_asset(&id).unwrap().unwrap().library_hidden, "removing the last canvas instance must not revive a recycled original");
    db.conn.lock().unwrap().execute("DELETE FROM canvas_nodes WHERE id='node'", []).unwrap();
    assert!(db.get_asset(&id).unwrap().unwrap().library_hidden);
    assert_eq!(db.count_assets(None).unwrap(), 0);
}

#[test]
fn original_trash_visibility_restores_on_successful_connected_index_only() {
    let (_directory, paths, db, id) = fixture();
    let original = db.get_asset(&id).unwrap().unwrap().store_path.unwrap();
    let moved = format!("{original}.recycled");
    mark_trashed(&db, &id);
    fs::rename(&original, &moved).unwrap();
    assert!(db.index_connected_file(&paths, std::path::Path::new(&original), None).is_err());
    assert_eq!(marker_count(&db, &id), 1);
    fs::rename(moved, &original).unwrap();
    let restored = db.index_connected_file(&paths, std::path::Path::new(&original), None).unwrap();
    assert_eq!(restored.id, id);
    assert_eq!(marker_count(&db, &id), 0);
    assert!(!restored.library_hidden);
    assert_eq!(db.material_catalog_assets("tags", None, None).unwrap().len(), 1);
}

#[test]
fn original_trash_visibility_restores_external_and_managed_browser_references() {
    let (_directory, paths, db, id) = fixture();
    let original = db.get_asset(&id).unwrap().unwrap().store_path.unwrap();
    for managed in [false, true] {
        if managed { db.conn.lock().unwrap().execute("DELETE FROM external_assets WHERE asset_id=?1", [&id]).unwrap(); }
        mark_trashed(&db, &id);
        let restored = db.index_external(&paths, std::path::Path::new(&original)).unwrap();
        assert_eq!(restored.id, id);
        assert_eq!(marker_count(&db, &id), 0);
        assert!(!restored.library_hidden);
    }
}

#[test]
fn original_trash_visibility_does_not_revive_from_a_historical_alias() {
    let (directory, paths, db, id) = fixture();
    let original = db.get_asset(&id).unwrap().unwrap().store_path.unwrap();
    mark_trashed(&db, &id);
    let alias = directory.path().join("historical.png");
    fs::rename(&original, &alias).unwrap();
    let alias = fs::canonicalize(alias).unwrap();
    db.conn.lock().unwrap().execute("INSERT INTO external_asset_paths(asset_id,path) VALUES(?1,?2)", rusqlite::params![id,alias.to_string_lossy()]).unwrap();
    let indexed = db.index_external(&paths, &alias).unwrap();
    assert_eq!(indexed.id, id);
    assert_eq!(marker_count(&db, &id), 1);
    assert!(indexed.library_hidden);
}

#[test]
fn original_trash_visibility_migration_0050_preserves_v49_records_across_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("migration.db");
    let db = Database::open(&path).unwrap();
    crate::db::migrations::migrations()
        .to_version(&mut db.conn.lock().unwrap(), 49)
        .unwrap();
    db.conn.lock().unwrap().execute_batch(
        "INSERT INTO assets(id,name,ext,source,store_path,library_hidden,name_manual) VALUES('asset','手动素材名','png','generated','original.png',1,1);
         INSERT INTO tags(id,name) VALUES('retained-tag','手动标签');
         INSERT INTO asset_tags(asset_id,tag_id) VALUES('asset','retained-tag');
         INSERT INTO analyses(id,asset_id,kind,payload) VALUES('analysis','asset','caption','{\"caption\":\"保留分析\"}');"
    ).unwrap();
    db.create_project("project", "project", "blank:project", "project", "blank").unwrap();
    db.ensure_project_canvas("project").unwrap();
    db.create_canvas_node(&NewCanvasNode {
        id: "node".into(), project_id: "project".into(), thread_id: None,
        kind: CreativeNodeKind::Asset, asset_id: Some("asset".into()), role: Some(CreativeNodeRole::Reference),
        payload_json: r#"{"schema_version":1,"snapshot":{"name":"original"}}"#.into(),
        x: 20., y: 30., width: 100., height: 80., z_index: 1, position_locked: false,
    }).unwrap();
    let asset = serde_json::to_value(db.get_asset("asset").unwrap()).unwrap();
    let nodes = serde_json::to_value(db.list_canvas_nodes("project").unwrap()).unwrap();
    db.migrate().unwrap();
    assert_eq!(marker_count(&db, "asset"), 0, "existing files must not be treated as recycled during upgrade");
    db.conn.lock().unwrap().execute(
        "INSERT INTO trashed_asset_originals(asset_id,path,fingerprint) VALUES('asset','original.png','confirmed-fingerprint')", []
    ).unwrap();
    drop(db);

    for _ in 0..2 {
        let db = Database::open(&path).unwrap();
        db.migrate().unwrap();
        assert_eq!(serde_json::to_value(db.get_asset("asset").unwrap()).unwrap(), asset);
        assert_eq!(serde_json::to_value(db.list_canvas_nodes("project").unwrap()).unwrap(), nodes);
        assert_eq!(marker_count(&db, "asset"), 1, "startup must preserve the existing trash marker");
        let conn = db.conn.lock().unwrap();
        let tag: String = conn.query_row(
            "SELECT t.name FROM tags t JOIN asset_tags a ON a.tag_id=t.id WHERE a.asset_id='asset'", [], |row| row.get(0)
        ).unwrap();
        assert_eq!(tag, "手动标签");
        let analysis: String = conn.query_row("SELECT payload FROM analyses WHERE id='analysis'", [], |row| row.get(0)).unwrap();
        assert_eq!(analysis, r#"{"caption":"保留分析"}"#);
        let guards: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='trashed_original_keep_hidden'", [], |row| row.get(0)
        ).unwrap();
        assert_eq!(guards, 1);
    }
}
