//! Move centrally managed historical media into project folders without changing asset IDs.
use super::*;
use crate::core::{creative_files, file_workspace::project_path, paths::LibraryPaths};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    id: String, source: PathBuf, target: PathBuf, hash: String, bytes: u64,
    projects: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Folder { pub id: String, pub name: String, pub path: PathBuf, pub files: usize }
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct MissingFile { pub id: String, pub path: PathBuf }
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Plan { items: Vec<Item>, folders: Vec<Folder>, #[serde(default)] missing: Vec<MissingFile> }
#[derive(Serialize)]
pub struct HistoryPreview {
    pub source: PathBuf, pub target: PathBuf, pub files: usize, pub bytes: u64,
    pub projects: usize, pub global: usize, pub shared: usize, pub folders: Vec<Folder>, pub token: String,
    pub missing: Vec<MissingFile>,
}

// The oldest referencing project owns the single physical file. Hidden canvas uses
// also count; removing a visible card must not orphan a retained reference.
fn references(conn: &Connection, id: &str, source: &Path) -> AppResult<Vec<(String,String)>> {
    let mut stmt=conn.prepare("SELECT p.id,p.name FROM projects p WHERE
        EXISTS(SELECT 1 FROM project_assets a WHERE a.project_id=p.id AND a.asset_id=?1) OR
        EXISTS(SELECT 1 FROM canvas_nodes n WHERE n.project_id=p.id AND n.asset_id=?1) OR
        EXISTS(SELECT 1 FROM canvas_nodes n, json_tree(n.payload_json) j WHERE n.project_id=p.id AND j.type='text' AND j.value IN (?1,?2)) OR
        EXISTS(SELECT 1 FROM project_canvases c, json_tree(c.draft_json) j WHERE c.project_id=p.id AND j.type='text' AND j.value IN (?1,?2)) OR
        EXISTS(SELECT 1 FROM canvas_workflows w, json_tree(w.document_json) j WHERE w.project_id=p.id AND j.type='text' AND j.value IN (?1,?2)) OR
        EXISTS(SELECT 1 FROM task_queue q, json_tree(CASE WHEN json_valid(q.payload) THEN q.payload ELSE '{}' END) j WHERE q.project_id=p.id AND j.type='text' AND j.value IN (?1,?2)) OR
        EXISTS(SELECT 1 FROM cloud_agent_runs r WHERE r.project_id=p.id AND (r.final_asset_id=?1 OR EXISTS(SELECT 1 FROM cloud_agent_artifact_assets a WHERE a.run_id=r.run_id AND a.asset_id=?1))) OR
        EXISTS(SELECT 1 FROM assets a JOIN task_queue q ON q.project_id=p.id WHERE a.id=?1 AND json_valid(q.payload) AND a.generation_session_id=json_extract(q.payload,'$.session_id')) OR
        EXISTS(SELECT 1 FROM assets a, thread_generation_links l JOIN creative_threads t ON t.id=l.thread_id WHERE a.id=?1 AND t.project_id=p.id AND (l.generation_conversation_id=a.generation_session_id OR EXISTS(SELECT 1 FROM generation_conversations g WHERE g.session_id=a.generation_session_id AND g.conversation_id=l.generation_conversation_id))) OR
        EXISTS(SELECT 1 FROM cloud_agent_runs r JOIN thread_agent_links l ON l.run_id=r.run_id JOIN creative_threads t ON t.id=l.thread_id WHERE t.project_id=p.id AND (r.final_asset_id=?1 OR EXISTS(SELECT 1 FROM cloud_agent_artifact_assets a WHERE a.run_id=r.run_id AND a.asset_id=?1))) OR
        EXISTS(SELECT 1 FROM local_agent_runs r WHERE r.project_id=p.id AND r.target_asset_id=?1) OR
        EXISTS(SELECT 1 FROM local_agent_runs r, json_tree(CASE WHEN json_valid(r.checkpoint_json) THEN r.checkpoint_json ELSE '{}' END) j WHERE r.project_id=p.id AND j.type='text' AND j.value IN (?1,?2)) OR
        EXISTS(SELECT 1 FROM cloud_agent_runs r, json_tree(CASE WHEN json_valid(r.snapshot_json) THEN r.snapshot_json ELSE '{}' END) j WHERE r.project_id=p.id AND j.type='text' AND j.value IN (?1,?2)) OR
        EXISTS(SELECT 1 FROM cloud_agent_runs r, json_tree(CASE WHEN json_valid(r.reference_asset_ids) THEN r.reference_asset_ids ELSE '[]' END) j WHERE r.project_id=p.id AND j.type='text' AND j.value IN (?1,?2))
        ORDER BY p.created_at,p.id")?;
    let rows=stmt.query_map(params![id,source.to_string_lossy()],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    Ok(rows)
}

fn filename(id: &str, source: &Path) -> AppResult<String> {
    if id.is_empty() || id.len()>128 || !id.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'-' || c==b'_') {return Err(invalid("素材标识无法安全用于文件名"));}
    Ok(match source.extension().and_then(|s|s.to_str()) {Some(ext)=>format!("{id}.{ext}"),None=>id.into()})
}
// Check each existing ancestor, including Windows junctions, before any write.
fn no_links(path: &Path) -> AppResult<()> {
    if !path.is_absolute() || path.components().any(|c|matches!(c,std::path::Component::ParentDir)) {return Err(invalid("迁移路径必须是无父目录跳转的绝对路径"));}
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta)=>{
                #[cfg(windows)]
                { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 {return Err(invalid("迁移路径不能包含链接或联接目录"));} }
                if meta.file_type().is_symlink() {return Err(invalid("迁移路径不能包含链接"));}
            },
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>(),
            Err(e)=>return Err(e.into()),
        }
    } Ok(())
}
fn root_path(files: &FileWorkspace) -> AppResult<PathBuf> {
    let root=files.proposed_root();no_links(&root)?;
    if root.is_dir() {return Ok(fs::canonicalize(root)?);}
    if files.snapshot().root.is_some() {return Err(invalid("资料目录不可用，请先连接原磁盘"));}
    Ok(fs::canonicalize(root.parent().ok_or_else(||invalid("资料目录无效"))?)?.join(root.file_name().unwrap()))
}
fn destination(conn: &Connection, root: &Path, item: &Item) -> AppResult<()> {
    if !nested(&item.target,root) || nested(&item.target,&item.source) {return Err(invalid("目标文件超出资料目录或与原文件重叠"));}
    no_links(&item.source)?;no_links(&item.target)?;
    if !item.source.is_file() {return Err(invalid(format!("历史素材文件不可用，请先恢复原文件：{}",item.source.display())));}
    if item.target.exists() && (!item.target.is_file() || fingerprint(&item.target)?!=item.hash) {return Err(invalid(format!("目标已有不同内容，不会覆盖：{}",item.target.display())));}
    let mut stmt=conn.prepare("SELECT id,store_path FROM assets WHERE id<>?1 AND store_path IS NOT NULL UNION SELECT asset_id,path FROM external_asset_paths WHERE asset_id<>?1")?;
    let rows=stmt.query_map([&item.id],|r|r.get::<_,String>(1))?;
    for row in rows {let key=path_key(Path::new(&row?));if key==path_key(&item.target) || key==path_key(&item.source) {return Err(invalid("文件路径已属于其他素材，未迁移"));}}
    Ok(())
}
fn build(files: &FileWorkspace, conn: &Connection, images: &Path) -> AppResult<(PathBuf,Plan)> {
    no_links(images)?;
    if !fs::metadata(images).map_err(|e|invalid(format!("历史素材目录不可访问，请先连接原磁盘：{e}")))?.is_dir() {return Err(invalid("历史素材目录不可用"));}
    let root=root_path(files)?;
    if nested(&root,images) || nested(images,&root) {return Err(invalid("历史素材与资料目录不能重叠"));}
    let config=files.snapshot();
    let mut folders:BTreeMap<String,Folder>=BTreeMap::new();
    let mut stmt=conn.prepare("SELECT id,store_path FROM assets WHERE store_path IS NOT NULL AND id NOT IN (SELECT asset_id FROM external_assets) ORDER BY id")?;
    let assets=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    let mut items=Vec::new();
    let mut missing=Vec::new();
    for (id,raw) in assets {
        let source=PathBuf::from(raw);if !nested(&source,images) {continue;}
        no_links(&source)?;
        match fs::metadata(&source) {
            Ok(meta) if meta.is_file()=>(),
            Ok(_)=>return Err(invalid(format!("历史素材路径不是文件：{}",source.display()))),
            Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{missing.push(MissingFile{id,path:source});continue;},
            Err(e)=>return Err(invalid(format!("无法读取历史素材 {}：{e}",source.display()))),
        }
        let refs=references(conn,&id,&source)?;
        for (project,name) in &refs {
            if !folders.contains_key(project) {
                let path=config.projects.get(project).cloned().map(Ok).unwrap_or_else(||project_path(&root,project,name))?;
                if !nested(&path,&root) {return Err(invalid(format!("项目“{name}”有独立资料目录，请先统一到当前 BowerbirdLibrary 后迁移历史素材")));}
                no_links(&path)?;
                folders.insert(project.clone(),Folder{id:project.clone(),name:name.clone(),path,files:0});
            }
        }
        let folder=if let Some((owner,_))=refs.first() {let folder=folders.get_mut(owner).unwrap();folder.files+=1;folder.path.clone()}else{root.join("全局素材")};
        let target=folder.join(filename(&id,&source)?);
        let item=Item{id,hash:fingerprint(&source)?,bytes:fs::metadata(&source)?.len(),source,target,projects:refs.into_iter().map(|(id,_)|id).collect()};
        destination(conn,&root,&item)?;items.push(item);
    }
    Ok((root,Plan{items,folders:folders.into_values().collect(),missing}))
}
fn token(config: &FileWorkspaceConfig, plan: &Plan) -> AppResult<String> {Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&(config,plan))?)))}
pub fn preview(files: &FileWorkspace, db: &Database, images: &Path) -> AppResult<HistoryPreview> {
    let (target,plan)=build(files,&db.conn.lock().unwrap(),images)?;
    Ok(HistoryPreview{source:images.into(),target,files:plan.items.len(),bytes:plan.items.iter().map(|i|i.bytes).sum(),projects:plan.folders.len(),global:plan.items.iter().filter(|i|i.projects.is_empty()).count(),shared:plan.items.iter().filter(|i|i.projects.len()>1).count(),token:token(&files.snapshot(),&plan)?,folders:plan.folders,missing:plan.missing})
}
pub fn schedule(files: &FileWorkspace, db: &Database, images: &Path, expected: &str, skip_missing: bool) -> AppResult<()> {
    let _gate=PLAN_GATE.lock().unwrap();
    if status(files)?.is_some_and(|s|matches!(s.state.as_str(),"pending"|"copying")) {return Err(invalid("已有待迁移计划，请先取消或重启完成"));}
    let conn=db.conn.lock().unwrap();ensure_idle(&conn)?;
    let (target,plan)=build(files,&conn,images)?;let old_config=files.snapshot();
    if plan.items.is_empty() {return Err(invalid("没有需要迁移的历史素材"));}
    if token(&old_config,&plan)?!=expected {return Err(invalid("素材、项目归属或文件已变化，请重新预览"));}
    if !plan.missing.is_empty() && !skip_missing {return Err(invalid("存在缺失文件，请在预览中确认跳过后再迁移"));}
    let probe_root=if target.exists(){target.clone()}else{target.parent().unwrap().into()};
    let probe=probe_root.join(format!(".bowerbird-write-{}",uuid::Uuid::new_v4()));
    let file=fs::OpenOptions::new().write(true).create_new(true).open(&probe).map_err(|e|invalid(format!("资料目录不可写，请先选择可写位置：{e}")))?;file.sync_all()?;drop(file);fs::remove_file(probe)?;
    let mut next_config=old_config.clone();next_config.root=Some(target.clone());
    for folder in &plan.folders {next_config.projects.insert(folder.id.clone(),folder.path.clone());}
    write_json(&files.migration_path(),&MoveStatus{id:uuid::Uuid::new_v4().to_string(),state:"pending".into(),source:images.into(),target,error:None,old_config,next_config,create_only:false,history:Some(plan)})
}
fn mapping(items: &[Item]) -> HashMap<String,String> {items.iter().map(|i|(path_key(&i.source),i.target.to_string_lossy().into_owned())).collect()}
fn write_record(conn: &Connection, item: &Item, map: &HashMap<String,String>) -> AppResult<()> {
    let mut value=creative_files::record_snapshot(conn,&item.id)?.ok_or_else(||invalid("素材资料已不存在"))?;
    // Analysis payloads themselves are serialized JSON in portable records.
    if let Some(analyses)=value["analyses"].as_array_mut() {for analysis in analyses {if let Some(raw)=analysis["payload"].as_str() {if let Ok(mut payload)=serde_json::from_str::<serde_json::Value>(raw) {rewrite_json_with(&mut payload,&|s|map.get(&path_key(Path::new(s))).cloned());analysis["payload"]=serde_json::json!(serde_json::to_string(&payload)?);}}}}
    value["file"]=serde_json::json!(item.target.file_name().unwrap().to_string_lossy());value["sha256"]=serde_json::json!(item.hash);
    let record=item.target.parent().unwrap().join(".bowerbird").join(format!("{}.json",item.id));
    no_links(&record)?;fs::create_dir_all(record.parent().unwrap())?;
    let bytes=serde_json::to_vec_pretty(&value)?;
    if record.exists() {if fs::read(&record)?!=bytes {return Err(invalid(format!("目标随图资料已有不同内容，不会覆盖：{}",record.display())));}return Ok(());}
    let mut output=fs::OpenOptions::new().write(true).create_new(true).open(record)?;output.write_all(&bytes)?;output.sync_all()?;Ok(())
}
fn copy_items(conn: &Connection, root: Option<&Path>, items: &[Item]) -> AppResult<()> {
    let map=mapping(items);
    for item in items {
        destination(conn,root.unwrap_or_else(||item.target.parent().unwrap()),item)?;
        if fingerprint(&item.source)?!=item.hash {return Err(invalid("源素材已变化，请重新预览"));}
        fs::create_dir_all(item.target.parent().unwrap())?;copy_file(&item.source,&item.target)?;
        if fingerprint(&item.target)?!=item.hash {return Err(invalid("复制校验失败，未切换引用"));}
        write_record(conn,item,&map)?;
    } Ok(())
}
fn update_index(conn: &Connection, items: &[Item]) -> AppResult<()> {
    let map=mapping(items);rewrite_index_with(conn,&|s|map.get(&path_key(Path::new(s))).cloned())?;
    for item in items {
        for path in [&item.source,&item.target] {conn.execute("INSERT OR IGNORE INTO external_asset_paths(asset_id,path) VALUES(?1,?2)",params![item.id,path.to_string_lossy()])?;}
    } Ok(())
}
pub(super) fn resume(files: &FileWorkspace, db: &Database, mut state: MoveStatus) -> AppResult<()> {
    let committed:bool=db.conn.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM file_workspace_moves WHERE id=?1)",[&state.id],|r|r.get(0))?;
    if !committed {
        let result=(||->AppResult<()> {
            if files.snapshot()!=state.old_config {return Err(invalid("迁移计划创建后配置发生变化，请重新预览"));}
            let mut conn=db.conn.lock().unwrap();let tx=conn.transaction()?;ensure_idle(&tx)?;
            let (root,current)=build(files,&tx,&state.source)?;
            if Some(&current)!=state.history.as_ref() || path_key(&root)!=path_key(&state.target) {return Err(invalid("历史素材或项目归属已变化，请重新预览"));}
            state.state="copying".into();write_json(&files.migration_path(),&state)?;
            for folder in &current.folders {no_links(&folder.path)?;fs::create_dir_all(&folder.path)?;}
            copy_items(&tx,Some(&root),&current.items)?;
            // Recheck every source after the entire copy, before committing any path.
            for item in &current.items {if fingerprint(&item.source)?!=item.hash {return Err(invalid("复制期间源素材发生变化，未切换引用"));}}
            update_index(&tx,&current.items)?;
            for folder in &current.folders {tx.execute("UPDATE projects SET workspace_path=?1 WHERE id=?2",params![folder.path.to_string_lossy(),folder.id])?;}
            tx.execute("INSERT INTO file_workspace_moves(id,committed_at) VALUES(?1,?2)",params![state.id,chrono::Utc::now().timestamp()])?;tx.commit()?;Ok(())
        })();
        if let Err(error)=result {state.state="failed".into();state.error=Some(format!("{error}。原素材和索引仍保留；已复制的目标文件也已保留。"));write_json(&files.migration_path(),&state)?;return Ok(());}
    }
    files.replace_config(state.next_config.clone())?;state.state="completed".into();state.error=None;write_json(&files.migration_path(),&state)?;Ok(())
}

/// Called inside the project-deletion transaction. Source files are returned to the
/// existing durable deletion journal: rollback restores them, commit removes them.
pub(crate) fn transfer_shared(conn: &Connection, paths: &LibraryPaths, project: &str) -> AppResult<(usize,Vec<PathBuf>)> {
    let Some(files)=&paths.files else{return Ok((0,vec![]));};
    let config=files.snapshot();let Some(owner)=config.projects.get(project) else{return Ok((0,vec![]));};
    let mut stmt=conn.prepare("SELECT id,store_path FROM assets WHERE store_path IS NOT NULL AND id NOT IN (SELECT asset_id FROM external_assets) AND id NOT IN (SELECT asset_id FROM connected_entries) ORDER BY id")?;
    let assets=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    let mut items=vec![];let mut originals=vec![];
    for (id,raw) in assets {
        let source=PathBuf::from(raw);if !nested(&source,owner){continue;}
        let refs=references(conn,&id,&source)?;
        let Some((next,name))=refs.iter().find(|(id,_)|id!=project) else{continue;};
        ensure_idle(conn)?;no_links(&source)?;
        let folder=files.project_directory(next,name)?;
        let target=folder.join(filename(&id,&source)?);
        let item=Item{id,source:source.clone(),target,hash:fingerprint(&source)?,bytes:fs::metadata(&source)?.len(),projects:vec![next.clone()]};
        destination(conn,&folder,&item)?;
        let sidecar=source.parent().unwrap().join(".bowerbird").join(format!("{}.json",item.id));
        if sidecar.exists(){no_links(&sidecar)?;originals.push(sidecar);}
        originals.push(source);items.push(item);
    }
    // Each destination may already be a configured project on another disk.
    copy_items(conn,None,&items)?;
    for item in &items {if fingerprint(&item.source)?!=item.hash {return Err(invalid("转存期间源文件发生变化，项目尚未删除"));}}
    update_index(conn,&items)?;
    Ok((items.len(),originals))
}

#[cfg(test)]
#[path="legacy_library_move_tests.rs"]
mod tests;
