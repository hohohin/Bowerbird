use super::*;
use serde_json::json;
struct Fixture {root:PathBuf, files:FileWorkspace, db:Database, index:PathBuf, parent:PathBuf}
impl Fixture {
    fn new()->Self {
        let root=std::env::temp_dir().join(format!("bb-file-move-{}",uuid::Uuid::new_v4()));
        let index=root.join("index");let parent=root.join("disk");fs::create_dir_all(&index).unwrap();fs::create_dir(&parent).unwrap();
        let db=Database::open(&index.join("library.db")).unwrap();db.migrate().unwrap();
        let files=FileWorkspace::open(index.join("file-workspace.json"),root.join("BowerbirdLibrary")).unwrap();
        Self{root,files,db,index,parent}
    }
    fn seed(&self)->PathBuf {
        let dir=self.files.project_directory("p","项目").unwrap();let path=dir.join("image.png");fs::write(&path,b"original image").unwrap();
        self.db.create_project("p","项目",dir.to_str().unwrap(),"p","blank").unwrap();
        self.db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,store_path,origin_path) VALUES('a','image',?1,?1)",[path.to_str().unwrap()]).unwrap();
        self.db.add_assets_to_project("p",&["a".into()]).unwrap();
        self.db.ensure_project_canvas("p").unwrap();
        self.db.conn.lock().unwrap().execute("UPDATE project_canvases SET draft_json=?1 WHERE project_id='p'",[json!({"schema_version":1,"reference":path,"text":format!("说明 {}",path.display())}).to_string()]).unwrap();
        write_json(&dir.join(".bowerbird/a.json"),&json!({"reference":path,"file":"image.png"})).unwrap();
        path
    }
    fn schedule(&self)->Preview {
        let view=preview(&self.files,&self.parent,&self.index).unwrap();
        schedule(&self.files,&self.db,&self.parent,&self.index,&view.token).unwrap();view
    }
}
impl Drop for Fixture {fn drop(&mut self){let mut c=self.db.conn.lock().unwrap_or_else(|e|e.into_inner());drop(std::mem::replace(&mut *c,Connection::open_in_memory().unwrap()));let _=fs::remove_dir_all(&self.root);}}

#[test]
fn migration_preserves_files_identity_project_and_rewrites_structured_references() {
    let f=Fixture::new();let old=f.seed();let old_root=f.files.proposed_root();
    let outside=f.root.join("outside");fs::create_dir(&outside).unwrap();f.files.set_place(&outside,true).unwrap();f.files.set_place(&old_root,true).unwrap();
    let view=f.schedule();assert_eq!(view.projects,1);assert_eq!(view.files,2);
    assert!(!view.target.exists());assert_eq!(f.files.proposed_root(),old_root);
    resume(&f.files,&f.db).unwrap();assert_eq!(status(&f.files).unwrap().unwrap().state,"completed");
    let new=f.db.get_asset("a").unwrap().unwrap().store_path.unwrap();assert!(Path::new(&new).starts_with(&view.target));assert_eq!(fs::read(&new).unwrap(),fs::read(&old).unwrap());
    assert!(old.is_file());assert_eq!(f.files.ensure_root().unwrap(),fs::canonicalize(&view.target).unwrap());
    assert!(f.files.project_directory("p","名称").unwrap().starts_with(&view.target));
    assert!(f.files.snapshot().places.contains(&fs::canonicalize(&outside).unwrap()));
    assert_eq!(f.db.resolve_external_paths(&[old.to_str().unwrap().into()]).unwrap(),vec![new.clone()]);
    let payload:String=f.db.conn.lock().unwrap().query_row("SELECT draft_json FROM project_canvases WHERE project_id='p'",[],|r|r.get(0)).unwrap();let payload:serde_json::Value=serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["reference"],new);assert_eq!(payload["text"],format!("说明 {}",old.display()));
    let record:serde_json::Value=serde_json::from_slice(&fs::read(Path::new(&new).parent().unwrap().join(".bowerbird/a.json")).unwrap()).unwrap();assert_eq!(record["reference"],new);
    assert!(f.index.join("library.db").is_file());
    let reopened=FileWorkspace::open(f.index.join("file-workspace.json"),f.root.join("unused")).unwrap();assert_eq!(reopened.proposed_root(),view.target);
}
#[test]
fn empty_first_use_can_select_location_without_creating_default_root() {
    let f=Fixture::new();let old=f.files.proposed_root();let view=f.schedule();assert!(view.create_only);assert_eq!(view.files,0);
    resume(&f.files,&f.db).unwrap();assert_eq!(f.files.proposed_root(),view.target);assert!(!old.exists());
}
#[test]
fn rejects_nested_occupied_and_stale_targets_and_cancel_writes_no_files() {
    let f=Fixture::new();f.seed();let source=f.files.proposed_root();
    assert!(preview(&f.files,&source,&f.index).is_err());
    let view=preview(&f.files,&f.parent,&f.index).unwrap();
    fs::create_dir(&view.target).unwrap();fs::write(view.target.join("unrelated"),b"keep").unwrap();
    assert!(schedule(&f.files,&f.db,&f.parent,&f.index,&view.token).is_err());assert_eq!(fs::read(view.target.join("unrelated")).unwrap(),b"keep");
    let other=f.root.join("otherdisk");fs::create_dir(&other).unwrap();let view=preview(&f.files,&other,&f.index).unwrap();
    fs::write(source.join("new.txt"),b"new").unwrap();assert!(schedule(&f.files,&f.db,&other,&f.index,&view.token).is_err());
    let view=preview(&f.files,&other,&f.index).unwrap();schedule(&f.files,&f.db,&other,&f.index,&view.token).unwrap();cancel(&f.files).unwrap();resume(&f.files,&f.db).unwrap();
    assert!(!view.target.exists());assert_eq!(f.files.proposed_root(),source);
}
#[test]
fn failure_rolls_back_index_and_keeps_original_config_and_source() {
    let f=Fixture::new();let old=f.seed();let config=f.files.snapshot();let view=f.schedule();
    f.db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_move BEFORE UPDATE OF store_path ON assets BEGIN SELECT RAISE(ABORT,'simulated failure'); END;").unwrap();
    resume(&f.files,&f.db).unwrap();assert_eq!(status(&f.files).unwrap().unwrap().state,"failed");assert_eq!(f.files.snapshot(),config);
    assert_eq!(f.db.get_asset("a").unwrap().unwrap().store_path.unwrap(),old.to_str().unwrap());assert!(view.target.is_dir());assert!(old.is_file());
    assert_eq!(f.db.conn.lock().unwrap().query_row("SELECT count(*) FROM file_workspace_moves",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}
#[test]
fn committed_index_recovers_config_switch_without_recopying_files() {
    let f=Fixture::new();f.seed();f.schedule();let old=f.files.snapshot();let mut state=status(&f.files).unwrap().unwrap();
    resume(&f.files,&f.db).unwrap();
    f.files.replace_config(old).unwrap();state.state="copying".into();write_json(&f.files.migration_path(),&state).unwrap();
    fs::write(state.target.join("new-after-commit.txt"),b"keep").unwrap();
    resume(&f.files,&f.db).unwrap();assert_eq!(f.files.proposed_root(),state.target);assert_eq!(status(&f.files).unwrap().unwrap().state,"completed");assert_eq!(fs::read(state.target.join("new-after-commit.txt")).unwrap(),b"keep");
}
#[test]
fn copying_interruption_can_resume_and_active_tasks_block_scheduling() {
    let f=Fixture::new();let old=f.seed();
    f.db.conn.lock().unwrap().execute("INSERT INTO task_queue(id,kind,payload,created_at,status) VALUES('job','generation','{}',1,'running')",[]).unwrap();
    let view=preview(&f.files,&f.parent,&f.index).unwrap();assert!(schedule(&f.files,&f.db,&f.parent,&f.index,&view.token).is_err());
    f.db.conn.lock().unwrap().execute("UPDATE task_queue SET status='done' WHERE id='job'",[]).unwrap();f.schedule();
    let mut state=status(&f.files).unwrap().unwrap();state.state="copying".into();write_json(&f.files.migration_path(),&state).unwrap();
    fs::create_dir(&state.target).unwrap();fs::write(state.target.join(format!(".bowerbird-migration-{}",state.id)),&state.id).unwrap();
    let partial=state.target.join(old.strip_prefix(&state.source).unwrap());fs::create_dir_all(partial.parent().unwrap()).unwrap();fs::copy(&old,&partial).unwrap();
    resume(&f.files,&f.db).unwrap();assert_eq!(status(&f.files).unwrap().unwrap().state,"completed");
}
#[test]
fn local_classification_follows_moved_root_without_overwriting_source_record() {
    let f=Fixture::new();let old=f.seed();let folder=old.parent().unwrap();let base=f.index.join("local-classification/folder-records");
    let local=super::super::local_classification::folder::local_record_root(folder,&base);
    write_json(&local.join("source.json"),&json!({"version":1,"root":folder,"storage":"local"})).unwrap();
    write_json(&local.join(".bowerbird/classification.json"),&json!({"version":1,"labels":[],"pictures":[]})).unwrap();
    let view=f.schedule();resume(&f.files,&f.db).unwrap();assert_eq!(status(&f.files).unwrap().unwrap().state,"completed");
    let moved=remap(folder.to_str().unwrap(),&view.source,&view.target).unwrap();let relocated=super::super::local_classification::folder::local_record_root(Path::new(&moved),&base);
    assert_eq!(fs::read(local.join(".bowerbird/classification.json")).unwrap(),fs::read(relocated.join(".bowerbird/classification.json")).unwrap());
    let value:serde_json::Value=serde_json::from_slice(&fs::read(relocated.join("source.json")).unwrap()).unwrap();assert_eq!(value["root"],moved);
}

#[test]
fn paused_local_agent_checkpoints_allow_migration_and_keep_resumable_paths() {
    let f=Fixture::new();let old=f.seed();
    for (id,state) in [("tool-1","awaiting_tool"),("tool-2","awaiting_tool"),("approval","awaiting_approval")] {
        f.db.conn.lock().unwrap().execute(
            "INSERT INTO local_agent_runs(id,skill_id,target_asset_id,status,phase,checkpoint_json,created_at,updated_at) VALUES(?1,'smart-refinement','a',?2,'refine',?3,1,1)",
            params![id,state,json!({"status":state,"generatedImagePath":old}).to_string()]).unwrap();
    }
    let view=f.schedule();resume(&f.files,&f.db).unwrap();
    assert_eq!(status(&f.files).unwrap().unwrap().state,"completed");
    let conn=f.db.conn.lock().unwrap();
    let mut stmt=conn.prepare("SELECT status,checkpoint_json FROM local_agent_runs ORDER BY id").unwrap();
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
    assert_eq!(rows.len(),3);
    for (state,checkpoint) in rows {
        let checkpoint:serde_json::Value=serde_json::from_str(&checkpoint).unwrap();
        assert_eq!(checkpoint["status"],state);
        assert_eq!(checkpoint["generatedImagePath"],remap(old.to_str().unwrap(),&view.source,&view.target).unwrap());
    }
    assert!(old.is_file());
}

#[test]
fn active_generation_still_blocks_a_paused_local_agent_and_names_the_blocker() {
    let f=Fixture::new();f.seed();
    let conn=f.db.conn.lock().unwrap();
    conn.execute_batch("INSERT INTO local_agent_runs(id,skill_id,target_asset_id,status,phase,checkpoint_json,created_at,updated_at) VALUES('local','smart-refinement','a','awaiting_tool','refine','{}',1,1);
        INSERT INTO task_queue(id,kind,payload,created_at,status) VALUES('job','generation','{}',1,'running');").unwrap();
    drop(conn);
    let view=preview(&f.files,&f.parent,&f.index).unwrap();
    let error=schedule(&f.files,&f.db,&f.parent,&f.index,&view.token).unwrap_err().to_string();
    assert!(error.contains("生成或后台任务 1 项"),"{error}");assert!(!error.contains("本机 Agent"));
    assert!(status(&f.files).unwrap().is_none());assert!(!view.target.exists());
}

#[test]
fn active_agents_and_workflows_still_block_with_category_counts() {
    let f=Fixture::new();f.seed();
    let conn=f.db.conn.lock().unwrap();
    conn.execute_batch("INSERT INTO local_agent_runs(id,skill_id,target_asset_id,status,phase,checkpoint_json,created_at,updated_at) VALUES('local','smart-refinement','a','running','refine','{}',1,1);
        INSERT INTO cloud_agent_runs(run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,snapshot_json,created_at,updated_at) VALUES('cloud','conversation','test','awaiting_local_task','','[]','{}',1,1);
        INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p',1,'{\"schema_version\":1,\"run\":{\"status\":\"waiting\"}}');").unwrap();
    let error=ensure_idle(&conn).unwrap_err().to_string();
    for category in ["本机 Agent 1 项","云端 Agent 1 项","工作流 1 项"] {assert!(error.contains(category),"{error}");}
    conn.execute_batch("UPDATE local_agent_runs SET status='succeeded'; UPDATE cloud_agent_runs SET status='succeeded'; UPDATE canvas_workflows SET document_json='{\"schema_version\":1,\"run\":{\"status\":\"done\"}}';").unwrap();
    ensure_idle(&conn).unwrap();
}
#[test]
fn prefix_matching_never_changes_neighbor_folder_or_prompt_text() {
    let f=Fixture::new();let source=f.files.ensure_root().unwrap();let target=f.parent.join("BowerbirdLibrary");
    assert!(remap(&format!("{}-other/a.png",source.display()),&source,&target).is_none());
    assert!(remap(&format!("使用 {}/a.png",source.display()),&source,&target).is_none());
    assert_eq!(remap(source.to_str().unwrap(),&source,&target),Some(target.to_string_lossy().into_owned()));
}
