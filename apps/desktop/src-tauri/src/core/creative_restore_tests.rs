use super::*;
use super::super::creative_files;
use serde_json::{json, Value};

struct Fixture { root: PathBuf, db: Database, paths: LibraryPaths }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("bb-records-{}", uuid::Uuid::new_v4()));
        let paths = LibraryPaths::init(root.join("index")).unwrap();
        let db = Database::open(&paths.db).unwrap(); db.migrate().unwrap();
        fs::create_dir(root.join("pictures")).unwrap();
        Self { root, db, paths }
    }
    fn directory(&self) -> PathBuf { self.root.join("pictures") }
    fn add(&self, id: &str) -> PathBuf {
        let path = self.directory().join(format!("{id}.png"));
        image::RgbImage::from_pixel(12, 15, image::Rgb([13, 42, 67])).save(&path).unwrap();
        let conn = self.db.conn.lock().unwrap();
        conn.execute("INSERT INTO assets(id,name,store_path,size,file_mtime) VALUES(?1,?1,?2,?3,10)", params![id,path.to_str().unwrap(),fs::metadata(&path).unwrap().len() as i64]).unwrap();
        path
    }
    fn export(&self) {
        creative_files::flush(&self.db, &self.root.join("fallback")).unwrap();
    }
    fn fresh_db(&self) -> Database {
        let db = Database::open(&self.root.join("fresh.db")).unwrap(); db.migrate().unwrap(); db
    }
    fn record(&self, id: &str) -> PathBuf { self.directory().join(".bowerbird").join(format!("{id}.json")) }
    fn edit(&self, id: &str, edit: impl FnOnce(&mut Value)) {
        let path = self.record(id);
        let mut value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        edit(&mut value); fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Drop SQLite before cleanup, including on Windows where open files cannot be removed.
        let mut conn = self.db.conn.lock().unwrap_or_else(|error| error.into_inner());
        let old = std::mem::replace(&mut *conn, Connection::open_in_memory().unwrap());
        drop(old); let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn portable_roundtrip_restores_metadata_once_without_copying_or_executing_jobs() {
    let f = Fixture::new(); let original = f.add("a");
    f.db.conn.lock().unwrap().execute_batch(r#"
        INSERT INTO analyses(id,asset_id,kind,payload) VALUES('caption','a','caption','{"caption":"海边"}');
        INSERT INTO analyses(id,asset_id,kind,payload) VALUES('generation','a','generation_meta','{"prompt":"海边"}');
        INSERT INTO analyses(id,asset_id,kind,payload) VALUES('workspace','a','layer_workspace','{"status":"running"}');
        INSERT INTO tags(id,name,color) VALUES('t','自然','#112233');
        INSERT INTO asset_tags(asset_id,tag_id) VALUES('a','t');
        INSERT INTO prompts(id,body) VALUES('p','画海边');
        INSERT INTO asset_prompts(asset_id,prompt_id,role) VALUES('a','p','used');
    "#).unwrap();
    f.export(); let bytes = fs::read(&original).unwrap(); let sidecar = fs::read(f.record("a")).unwrap();
    let db = f.fresh_db();
    let preview = preview(&db, &f.directory(), false).unwrap();
    assert_eq!(preview.items[0].action, "import");
    let result = restore(&db, &f.paths, &f.directory(), false, &preview.token).unwrap();
    assert_eq!((result.imported,result.relinked), (1,0));
    let conn = db.conn.lock().unwrap();
    let counts: (i64,i64,i64,i64) = conn.query_row("SELECT (SELECT count(*) FROM analyses),(SELECT count(*) FROM asset_tags),(SELECT count(*) FROM asset_prompts),(SELECT count(*) FROM creative_file_queue)", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(counts, (2,1,1,0)); drop(conn);
    assert_eq!(super::preview(&db, &f.directory(), false).unwrap().items[0].action, "existing");
    assert!(restore(&db, &f.paths, &f.directory(), false, &preview.token).is_err());
    assert_eq!(fs::read(f.record("a")).unwrap(), sidecar);
    db.delete_asset("a").unwrap();
    assert_eq!(fs::read(original).unwrap(), bytes);
}

#[test]
fn renamed_file_relinks_same_identity_and_preserves_local_metadata_and_project() {
    let f = Fixture::new(); let old = f.add("a"); f.export();
    f.db.create_project("p","项目",f.directory().to_str().unwrap(),"fixture","user").unwrap();
    f.db.add_assets_to_project("p",&["a".into()]).unwrap();
    f.db.conn.lock().unwrap().execute("UPDATE assets SET name='本机名称',rating=5 WHERE id='a'",[]).unwrap();
    let moved = f.directory().join("renamed.png"); fs::rename(&old, &moved).unwrap();
    let preview = preview(&f.db, &f.directory(), false).unwrap();
    assert_eq!(preview.items[0].action,"relink");
    assert_eq!(restore(&f.db,&f.paths,&f.directory(),false,&preview.token).unwrap().relinked,1);
    let asset = f.db.get_asset("a").unwrap().unwrap();
    assert_eq!(asset.name,"本机名称"); assert_eq!(asset.rating,Some(5));
    let count: i64 = f.db.conn.lock().unwrap().query_row("SELECT count(*) FROM project_assets WHERE project_id='p' AND asset_id='a'", [], |r| r.get(0)).unwrap();
    assert_eq!(count,1);
    assert_eq!(f.db.resolve_external_paths(&[old.to_str().unwrap().into()]).unwrap()[0],fs::canonicalize(&moved).unwrap().to_string_lossy());
    // A later whole-folder move also keeps the earliest historical reference usable.
    let folder = f.root.join("moved-folder"); fs::rename(f.directory(),&folder).unwrap();
    let next = super::preview(&f.db,&folder,false).unwrap();
    assert_eq!(restore(&f.db,&f.paths,&folder,false,&next.token).unwrap().relinked,1);
    assert_eq!(f.db.resolve_external_paths(&[old.to_str().unwrap().into()]).unwrap()[0],fs::canonicalize(folder.join("renamed.png")).unwrap().to_string_lossy());
}

#[test]
fn copies_conflicting_fingerprints_and_ambiguous_renames_are_blocked() {
    let f = Fixture::new(); let old = f.add("a"); f.export();
    let copied = f.root.join("copied"); fs::create_dir_all(copied.join(".bowerbird")).unwrap();
    fs::copy(&old,copied.join("a.png")).unwrap(); fs::copy(f.record("a"),copied.join(".bowerbird/a.json")).unwrap();
    assert_eq!(preview(&f.db,&copied,false).unwrap().items[0].action,"blocked");
    fs::rename(&old,f.directory().join("new.png")).unwrap();
    fs::copy(f.directory().join("new.png"),f.directory().join("duplicate.png")).unwrap();
    assert_eq!(preview(&f.db,&f.directory(),false).unwrap().items[0].action,"blocked");
    fs::remove_file(f.directory().join("duplicate.png")).unwrap();
    f.db.conn.lock().unwrap().execute("UPDATE creative_file_fingerprints SET sha256=?1 WHERE asset_id='a'", ["0".repeat(64)]).unwrap();
    assert!(preview(&f.db,&f.directory(),false).unwrap().items[0].message.contains("指纹冲突"));
    let db = f.fresh_db();
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name) VALUES('other','existing')",[]).unwrap();
    db.conn.lock().unwrap().execute("INSERT INTO external_asset_paths(asset_id,path) VALUES('other',?1)",[fs::canonicalize(f.directory().join("new.png")).unwrap().to_string_lossy()]).unwrap();
    assert!(preview(&db,&f.directory(),false).unwrap().items[0].message.contains("路径重复"));
}

#[test]
fn stale_preview_and_changed_media_never_write_database() {
    let f = Fixture::new(); let original = f.add("a"); f.export(); let db = f.fresh_db();
    let first = preview(&db,&f.directory(),false).unwrap();
    f.edit("a",|v|v["asset"]["name"]=json!("changed"));
    assert!(restore(&db,&f.paths,&f.directory(),false,&first.token).is_err());
    let second = preview(&db,&f.directory(),false).unwrap();
    image::RgbImage::from_pixel(12,15,image::Rgb([99,0,0])).save(original).unwrap();
    assert!(restore(&db,&f.paths,&f.directory(),false,&second.token).is_err());
    assert!(db.get_asset("a").unwrap().is_none());
}

#[test]
fn batch_failure_rolls_back_preceding_imports() {
    let f = Fixture::new(); f.add("a"); f.add("b"); f.export(); let db = f.fresh_db();
    // Simulate a database failure on the second item after the first has been written.
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER test_failed_write BEFORE INSERT ON assets WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'test write failure'); END;").unwrap();
    let preview = preview(&db,&f.directory(),false).unwrap();
    assert_eq!(preview.items.iter().filter(|i|i.action=="import").count(),2);
    assert!(restore(&db,&f.paths,&f.directory(),false,&preview.token).is_err());
    assert!(db.get_asset("a").unwrap().is_none()); assert!(db.get_asset("b").unwrap().is_none());
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT count(*) FROM creative_file_queue",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[test]
fn unsafe_legacy_and_duplicate_records_do_not_restore() {
    let f = Fixture::new(); f.add("a"); f.export(); let db = f.fresh_db();
    fs::copy(f.record("a"),f.record("duplicate")).unwrap();
    assert!(preview(&db,&f.directory(),false).unwrap().items.iter().all(|i|i.action=="blocked"));
    fs::remove_file(f.record("duplicate")).unwrap();
    f.edit("a",|v|v["tags"]=json!([{ "name":"", "color":null }]));
    assert_eq!(preview(&db,&f.directory(),false).unwrap().items[0].action,"blocked");
    f.edit("a",|v|v["tags"]=json!([]));
    f.edit("a",|v|v["file"]=json!("../a.png"));
    assert_eq!(preview(&db,&f.directory(),false).unwrap().items[0].action,"blocked");
    f.edit("a",|v|{v["file"]=json!("a.png"); v["version"]=json!(1);});
    assert!(preview(&db,&f.directory(),false).unwrap().items[0].message.contains("指纹"));
    let result = creative_files::save_directory(&f.db,&f.root.join("fallback"),&f.directory()).unwrap();
    assert_eq!((result.total,result.pending,result.local),(1,0,0));
    assert_eq!(preview(&db,&f.directory(),false).unwrap().items[0].action,"import");
}

#[test]
fn exporter_retains_original_record_when_media_was_replaced_outside_app() {
    let f = Fixture::new(); let original = f.add("a"); f.export();
    let old = fs::read(f.record("a")).unwrap();
    image::RgbImage::from_pixel(20,20,image::Rgb([99,0,0])).save(original).unwrap();
    let result = creative_files::save_directory(&f.db,&f.root.join("fallback"),&f.directory()).unwrap();
    assert_eq!(result.pending,1);
    assert_eq!(fs::read(f.record("a")).unwrap(),old);
    assert!(!f.root.join("fallback/a.json").exists());
}

#[test]
fn recursive_scan_is_explicit_and_preserves_existing_prompt_content() {
    let f = Fixture::new(); f.add("a"); f.export(); let db = f.fresh_db();
    f.edit("a",|v|v["prompts"]=json!([{ "id":"p", "body":"恢复内容", "role":"used" }]));
    db.conn.lock().unwrap().execute("INSERT INTO prompts(id,body) VALUES('p','本机内容')",[]).unwrap();
    assert!(preview(&db,&f.root,false).unwrap().items.is_empty());
    let preview = preview(&db,&f.root,true).unwrap();
    assert_eq!(preview.items.len(),1);
    restore(&db,&f.paths,&f.root,true,&preview.token).unwrap();
    let conn = db.conn.lock().unwrap();
    assert_eq!(conn.query_row("SELECT body FROM prompts WHERE id='p'",[],|r|r.get::<_,String>(0)).unwrap(),"本机内容");
    assert_eq!(conn.query_row("SELECT p.body FROM prompts p JOIN asset_prompts ap ON p.id=ap.prompt_id WHERE ap.asset_id='a'",[],|r|r.get::<_,String>(0)).unwrap(),"恢复内容");
}
