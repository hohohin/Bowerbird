use super::*;
use std::sync::Arc;
use serde_json::json;

struct Fixture { root: PathBuf, paths: LibraryPaths, db: Database, files: Arc<FileWorkspace> }
impl Fixture {
    fn new() -> Self {
        let root=std::env::temp_dir().join(format!("bb-history-move-{}",uuid::Uuid::new_v4()));
        let mut paths=LibraryPaths::init(root.join("index")).unwrap();
        let db=Database::open(&paths.db).unwrap();db.migrate().unwrap();
        let files=Arc::new(FileWorkspace::open(paths.root.join("file-workspace.json"),root.join("BowerbirdLibrary")).unwrap());
        paths.files=Some(files.clone());
        for id in ["p1","p2"] {db.create_project(id,"同名项目","",id,"blank").unwrap();}
        Self{root,paths,db,files}
    }
    fn asset(&self,id: &str,projects: &[&str]) -> PathBuf {
        let path=self.paths.images.join(format!("{id}.png"));fs::write(&path,format!("synthetic image {id}")).unwrap();
        self.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,store_path,size) VALUES(?1,?1,'png',?2,?3)",params![id,path.to_string_lossy(),fs::metadata(&path).unwrap().len()]).unwrap();
        for project in projects {self.db.add_assets_to_project(project,&[id.into()]).unwrap();}
        path
    }
    fn schedule(&self) {let view=preview(&self.files,&self.db,&self.paths.images).unwrap();schedule(&self.files,&self.db,&self.paths.images,&view.token).unwrap();}
    fn run(&self) {self.schedule();super::super::resume(&self.files,&self.db).unwrap();assert_eq!(status(&self.files).unwrap().unwrap().state,"completed");}
    fn path(&self,id:&str)->PathBuf {self.db.get_asset(id).unwrap().unwrap().store_path.unwrap().into()}
}
impl Drop for Fixture {fn drop(&mut self){let mut c=self.db.conn.lock().unwrap_or_else(|e|e.into_inner());drop(std::mem::replace(&mut *c,Connection::open_in_memory().unwrap()));let _=fs::remove_dir_all(&self.root);}}

#[test]
fn history_groups_by_project_stores_shared_once_and_preserves_metadata_identity() {
    let f=Fixture::new();let old=f.asset("shared",&["p1","p2"]);f.asset("other",&["p2"]);f.asset("global",&[]);
    let outside=f.root.join("external.png");fs::write(&outside,b"external original").unwrap();
    let existing=f.files.project_directory("p1","同名项目").unwrap();fs::write(existing.join("new.png"),b"already here").unwrap();
    {
        let conn=f.db.conn.lock().unwrap();
        conn.execute("INSERT INTO assets(id,name,store_path) VALUES('external','external',?1)",[outside.to_string_lossy()]).unwrap();
        conn.execute("INSERT INTO external_assets(asset_id,fingerprint) VALUES('external','hash')",[]).unwrap();
        conn.execute("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('analysis','shared','generation_meta',?1)",[json!({"reference":old,"prompt":format!("text {}",old.display())}).to_string()]).unwrap();
        conn.execute_batch("INSERT INTO tags(id,name) VALUES('tag','分类'); INSERT INTO asset_tags(asset_id,tag_id,origin) VALUES('shared','tag','manual');").unwrap();
    }
    let view=preview(&f.files,&f.db,&f.paths.images).unwrap();
    assert_eq!((view.files,view.projects,view.global,view.shared),(3,2,1,1));
    assert_eq!(view.folders.iter().map(|p|p.files).sum::<usize>(),2);
    assert!(status(&f.files).unwrap().is_none());assert!(old.is_file());
    f.run();let moved=f.path("shared");assert!(moved.starts_with(&existing));assert!(old.is_file());
    let config=f.files.snapshot();let second=&config.projects["p2"];
    assert_ne!(config.projects["p1"],*second);assert!(!second.join("shared.png").exists());assert!(f.path("other").starts_with(second));
    assert_eq!(f.path("global").parent().unwrap().file_name().unwrap(),"全局素材");assert_eq!(f.path("external"),outside);
    assert_eq!(fs::read(existing.join("new.png")).unwrap(),b"already here");
    let record:serde_json::Value=serde_json::from_slice(&fs::read(moved.parent().unwrap().join(".bowerbird/shared.json")).unwrap()).unwrap();
    assert_eq!(record["asset"]["id"],"shared");assert_eq!(record["tags"][0]["name"],"分类");assert_eq!(record["sha256"],fingerprint(&moved).unwrap());
    let payload:serde_json::Value=serde_json::from_str(record["analyses"][0]["payload"].as_str().unwrap()).unwrap();
    assert_eq!(payload["reference"],moved.to_string_lossy().as_ref());assert_eq!(payload["prompt"],format!("text {}",old.display()));
    let count:i64=f.db.conn.lock().unwrap().query_row("SELECT count(*) FROM project_assets WHERE asset_id='shared'",[],|r|r.get(0)).unwrap();assert_eq!(count,2);
    assert_eq!(f.db.resolve_external_paths(&[old.to_string_lossy().into_owned()]).unwrap(),vec![moved.to_string_lossy().into_owned()]);
    assert_eq!(preview(&f.files,&f.db,&f.paths.images).unwrap().files,0);
}

#[test]
fn history_missing_conflicting_and_stale_inputs_do_not_change_index() {
    let f=Fixture::new();let old=f.asset("a",&["p1"]);
    let view=preview(&f.files,&f.db,&f.paths.images).unwrap();
    f.db.add_assets_to_project("p2",&["a".into()]).unwrap();
    assert!(schedule(&f.files,&f.db,&f.paths.images,&view.token).is_err());
    let view=preview(&f.files,&f.db,&f.paths.images).unwrap();let target=view.folders[0].path.join("a.png");
    fs::create_dir_all(target.parent().unwrap()).unwrap();fs::write(&target,b"unrelated").unwrap();
    assert!(preview(&f.files,&f.db,&f.paths.images).is_err());assert_eq!(fs::read(&target).unwrap(),b"unrelated");
    fs::remove_file(&target).unwrap();fs::remove_file(&old).unwrap();assert!(preview(&f.files,&f.db,&f.paths.images).is_err());
    assert_eq!(f.path("a"),old);assert!(status(&f.files).unwrap().is_none());
}

#[test]
fn history_conflicting_alias_cannot_be_overwritten_even_with_identical_bytes() {
    let f=Fixture::new();f.asset("a",&[]);let view=preview(&f.files,&f.db,&f.paths.images).unwrap();let target=view.target.join("全局素材/a.png");
    let conn=f.db.conn.lock().unwrap();conn.execute("INSERT INTO assets(id,name) VALUES('other','other')",[]).unwrap();
    conn.execute("INSERT INTO external_asset_paths(asset_id,path) VALUES('other',?1)",[target.to_string_lossy()]).unwrap();drop(conn);
    assert!(schedule(&f.files,&f.db,&f.paths.images,&view.token).is_err());assert!(!target.exists());
}

#[test]
fn duplicate_source_identity_is_rejected_and_active_work_blocks_shared_transfer() {
    let f=Fixture::new();let old=f.asset("a",&["p1","p2"]);
    f.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,store_path) VALUES('duplicate','duplicate',?1)",[old.to_string_lossy()]).unwrap();
    assert!(preview(&f.files,&f.db,&f.paths.images).is_err());
    f.db.conn.lock().unwrap().execute("DELETE FROM assets WHERE id='duplicate'",[]).unwrap();f.run();let before=f.path("a");
    f.db.conn.lock().unwrap().execute_batch("INSERT INTO task_queue(id,kind,payload,status,created_at,project_id) VALUES('busy','generation','{}','running',1,'p2');").unwrap();
    assert!(f.db.delete_project_keep_managed(&f.paths,"p1").is_err());assert_eq!(f.path("a"),before);assert!(before.is_file());assert!(f.db.get_project("p1").unwrap().is_some());
}

#[test]
fn history_cancel_and_active_tasks_never_copy_files() {
    let f=Fixture::new();f.asset("a",&[]);let view=preview(&f.files,&f.db,&f.paths.images).unwrap();
    f.db.conn.lock().unwrap().execute_batch("INSERT INTO task_queue(id,kind,payload,status,created_at) VALUES('running','generation','{}','running',1);").unwrap();
    assert!(schedule(&f.files,&f.db,&f.paths.images,&view.token).is_err());
    f.db.conn.lock().unwrap().execute("UPDATE task_queue SET status='done'",[]).unwrap();f.schedule();
    super::super::cancel(&f.files).unwrap();super::super::resume(&f.files,&f.db).unwrap();assert!(!view.target.exists());
}

#[test]
fn history_rolls_back_references_on_commit_failure_and_can_retry_identical_copies() {
    let f=Fixture::new();let old=f.asset("a",&["p1"]);f.schedule();let config=f.files.snapshot();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_move BEFORE UPDATE OF store_path ON assets BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    super::super::resume(&f.files,&f.db).unwrap();assert_eq!(status(&f.files).unwrap().unwrap().state,"failed");assert_eq!(f.path("a"),old);assert_eq!(f.files.snapshot(),config);assert!(old.exists());
    f.db.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_move;").unwrap();f.run();assert_ne!(f.path("a"),old);
}

#[test]
fn history_startup_rejects_membership_changes_and_commit_marker_recovers_config() {
    let f=Fixture::new();let old=f.asset("a",&["p1"]);f.schedule();
    f.db.add_assets_to_project("p2",&["a".into()]).unwrap();super::super::resume(&f.files,&f.db).unwrap();
    assert_eq!(status(&f.files).unwrap().unwrap().state,"failed");assert_eq!(f.path("a"),old);
    f.schedule();let mut plan=status(&f.files).unwrap().unwrap();let before=f.files.snapshot();super::super::resume(&f.files,&f.db).unwrap();let moved=f.path("a");
    f.files.replace_config(before).unwrap();plan.state="copying".into();write_json(&f.files.migration_path(),&plan).unwrap();
    // A committed migration does not need its backup source to finish switching config.
    fs::remove_file(old).unwrap();super::super::resume(&f.files,&f.db).unwrap();assert_eq!(status(&f.files).unwrap().unwrap().state,"completed");assert_eq!(f.path("a"),moved);assert!(f.files.snapshot().projects.contains_key("p1"));
}

#[test]
fn deleting_storage_project_transfers_shared_file_and_sidecar_in_both_modes() {
    for exclusive in [false,true] {
        let f=Fixture::new();f.asset("shared",&["p1","p2"]);f.asset("only",&["p1"]);f.run();let old=f.path("shared");let only=f.path("only");
        let result=if exclusive {let impact=f.db.project_exclusive_impact(&f.paths,"p1").unwrap();f.db.delete_project_exclusive(&f.paths,"p1",&impact.confirmation).unwrap()}
            else {f.db.delete_project_keep_managed(&f.paths,"p1").unwrap()};
        assert_eq!(result.moved_assets,1);assert!(result.cleanup_pending.is_empty());assert!(f.db.get_project("p1").unwrap().is_none());
        let moved=f.path("shared");assert!(moved.starts_with(&f.files.snapshot().projects["p2"]));assert!(moved.is_file());assert!(!old.exists());
        assert!(!old.parent().unwrap().join(".bowerbird/shared.json").exists());assert!(moved.parent().unwrap().join(".bowerbird/shared.json").is_file());
        assert_eq!(only.exists(),!exclusive);assert_eq!(f.db.resolve_external_paths(&[old.to_string_lossy().into_owned()]).unwrap(),vec![moved.to_string_lossy().into_owned()]);
    }
}

#[test]
fn transfer_conflict_or_delete_failure_preserves_project_and_original_file() {
    let f=Fixture::new();f.asset("shared",&["p1","p2"]);f.run();let old=f.path("shared");let target=f.files.snapshot().projects["p2"].join("shared.png");
    fs::write(&target,b"unrelated").unwrap();assert!(f.db.delete_project_keep_managed(&f.paths,"p1").is_err());assert!(old.is_file());assert_eq!(f.path("shared"),old);assert!(f.db.get_project("p1").unwrap().is_some());assert_eq!(fs::read(&target).unwrap(),b"unrelated");
    fs::remove_file(&target).unwrap();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'synthetic deletion failure'); END;").unwrap();
    assert!(f.db.delete_project_keep_managed(&f.paths,"p1").is_err());assert!(old.is_file());assert_eq!(f.path("shared"),old);assert!(f.db.get_project("p1").unwrap().is_some());
    f.db.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_delete;").unwrap();f.db.delete_project_keep_managed(&f.paths,"p1").unwrap();assert_eq!(f.path("shared"),target);assert!(!old.exists());
}

#[test]
fn deleting_non_owner_does_not_move_file_and_workflow_only_references_get_a_home() {
    let f=Fixture::new();let old=f.asset("shared",&["p1"]);
    f.db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p2',1,?1)",[json!({"schema_version":1,"nodes":[{"image":"shared","reference":old}]}).to_string()]).unwrap();
    f.run();let moved=f.path("shared");
    f.db.delete_project_keep_managed(&f.paths,"p1").unwrap();let next=f.path("shared");assert_ne!(next,moved);assert!(next.starts_with(&f.files.snapshot().projects["p2"]));
    let f=Fixture::new();f.asset("shared",&["p1","p2"]);f.run();let old=f.path("shared");
    let result=f.db.delete_project_keep_managed(&f.paths,"p2").unwrap();assert_eq!(result.moved_assets,0);assert_eq!(f.path("shared"),old);assert!(old.exists());
}

#[test]
fn historical_generation_session_is_project_ownership_without_membership() {
    let f=Fixture::new();f.asset("generated",&["p1"]);
    f.db.conn.lock().unwrap().execute_batch("UPDATE assets SET generation_session_id='session' WHERE id='generated'; INSERT INTO task_queue(id,kind,payload,status,created_at,project_id) VALUES('job','generation','{\"session_id\":\"session\"}','done',1,'p2');").unwrap();
    let view=preview(&f.files,&f.db,&f.paths.images).unwrap();assert_eq!(view.shared,1);f.run();
    f.db.delete_project_keep_managed(&f.paths,"p1").unwrap();assert!(f.path("generated").starts_with(&f.files.snapshot().projects["p2"]));
}
