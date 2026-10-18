//! User-selected file-root migration, executed at startup before any writer/recovery worker.
//! Copies and verifies bytes before atomically changing the index. Never deletes source files.
use super::{creative_restore::path_key, external_files::fingerprint, file_workspace::{FileWorkspace, FileWorkspaceConfig, write_json}};
use crate::{db::Database, error::{AppError, AppResult}};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}, time::UNIX_EPOCH};

fn invalid(message: impl Into<String>) -> AppError { AppError::Other(message.into()) }
static PLAN_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[derive(Clone, Serialize, Deserialize)]
pub struct MoveStatus {
    pub id: String, pub state: String, pub source: PathBuf, pub target: PathBuf,
    pub error: Option<String>, old_config: FileWorkspaceConfig, next_config: FileWorkspaceConfig,
    #[serde(default)] create_only: bool,
    #[serde(default, skip_serializing_if="Option::is_none")] history: Option<history::Plan>,
}
#[derive(Serialize)]
pub struct Preview { pub source: PathBuf, pub target: PathBuf, pub files: usize, pub bytes: u64, pub projects: usize, pub token: String, pub create_only: bool }
#[derive(Serialize, PartialEq)]
struct Entry { path: PathBuf, size: u64, modified: u128, directory: bool }

/// Component-aware, case-insensitive on Windows; preserves the spelling of the suffix.
fn remap(value: &str, source: &Path, target: &Path) -> Option<String> {
    let normalized = value.replace('\\', "/");
    let normalized = normalized.strip_prefix("//?/UNC/").map(|v|format!("//{v}"))
        .unwrap_or_else(||normalized.strip_prefix("//?/").unwrap_or(&normalized).to_owned());
    let old = path_key(source); let key = path_key(Path::new(value));
    if key == old { return Some(target.to_string_lossy().into_owned()); }
    if !key.starts_with(&(old.clone()+"/")) { return None; }
    // Find a suffix by components instead of slicing case-folded UTF-8 byte offsets.
    let count = old.split('/').count();
    let suffix = normalized.split('/').skip(count).collect::<Vec<_>>().join("/");
    Some(target.join(suffix).to_string_lossy().into_owned())
}
fn nested(a: &Path,b: &Path) -> bool { remap(&a.to_string_lossy(),b,b).is_some() }

fn scan(root: &Path) -> AppResult<Vec<Entry>> {
    if !root.is_dir() { return Err(invalid("原资料目录不可用，请先连接原磁盘")); }
    let mut pending = vec![root.to_path_buf()]; let mut entries = Vec::new();
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?; let path = entry.path(); let kind = entry.file_type()?;
            if kind.is_symlink() || !fs::canonicalize(&path)?.starts_with(root) { return Err(invalid(format!("目录包含链接，无法完整迁移：{}",path.display()))); }
            if !kind.is_file() && !kind.is_dir() { return Err(invalid("目录包含不支持的特殊文件")); }
            let meta = entry.metadata()?;
            entries.push(Entry { path: path.strip_prefix(root).unwrap().to_path_buf(), size: if kind.is_file(){meta.len()}else{0}, modified: if kind.is_file(){meta.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()}else{0}, directory:kind.is_dir() });
            if kind.is_dir() { pending.push(path); }
            if entries.len() > 500_000 { return Err(invalid("目录超过五十万项，请先拆分后迁移")); }
        }
    }
    entries.sort_by(|a,b|a.path.cmp(&b.path)); Ok(entries)
}
pub fn status(files: &FileWorkspace) -> AppResult<Option<MoveStatus>> {
    match fs::read(files.migration_path()) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind()==std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub fn preview(files: &FileWorkspace, parent: &Path, index_root: &Path) -> AppResult<Preview> {
    let proposed=files.proposed_root();
    let create_only=files.snapshot().root.is_none() && !proposed.exists();
    let source = if create_only {fs::canonicalize(proposed.parent().ok_or_else(||invalid("默认位置无效"))?)?.join(proposed.file_name().unwrap())}
        else {fs::canonicalize(&proposed).map_err(|_|invalid("BowerbirdLibrary 当前不可用，请先连接原磁盘"))?};
    let parent = fs::canonicalize(parent)?;
    if !parent.is_dir() { return Err(invalid("请选择目标文件夹")); }
    let target = if parent.file_name().is_some_and(|n|n.to_string_lossy().eq_ignore_ascii_case("BowerbirdLibrary")) { parent }
        else { parent.join("BowerbirdLibrary") };
    if nested(&source,&target) || nested(&target,&source) { return Err(invalid("目标不能与原目录相同，也不能互为父子目录")); }
    let index_root = fs::canonicalize(index_root)?;
    if nested(&target,&index_root) || nested(&index_root,&target) || nested(&index_root,&source) {
        return Err(invalid("资料文件夹不能包含或覆盖本机数据库与缓存目录"));
    }
    if target.exists() {
        if fs::symlink_metadata(&target)?.file_type().is_symlink() || !target.is_dir() || fs::read_dir(&target)?.next().is_some() {
            return Err(invalid("目标 BowerbirdLibrary 必须为空；不会合并或覆盖已有文件"));
        }
    }
    let entries = if create_only{vec![]}else{scan(&source)?};
    let config = files.snapshot();
    let token = format!("{:x}",Sha256::digest(serde_json::to_vec(&(&source,&target,&config,&entries))?));
    Ok(Preview { source: source.clone(),target,files:entries.iter().filter(|e|!e.directory).count(),bytes:entries.iter().map(|e|e.size).sum(),projects:config.projects.values().filter(|p|nested(p,&source)).count(),token,create_only })
}
pub fn schedule(files: &FileWorkspace, db: &Database, parent: &Path, index_root: &Path, token: &str) -> AppResult<()> {
    let _gate=PLAN_GATE.lock().unwrap();
    if status(files)?.is_some_and(|s|matches!(s.state.as_str(),"pending"|"copying")) { return Err(invalid("已有待迁移计划，请先取消或重启完成")); }
    let preview = preview(files,parent,index_root)?;
    if preview.token != token { return Err(invalid("目录或配置已变化，请重新选择并预览")); }
    ensure_idle(&db.conn.lock().unwrap())?;
    let probe_dir = if preview.target.is_dir(){preview.target.clone()}else{preview.target.parent().unwrap().to_path_buf()};
    let probe = probe_dir.join(format!(".bowerbird-write-{}",uuid::Uuid::new_v4()));
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&probe).map_err(|e|invalid(format!("目标位置无法写入：{e}")))?;
    let written = out.write_all(b"probe").and_then(|_|out.sync_all()); drop(out); let cleanup = fs::remove_file(&probe); written?; cleanup?;
    let old_config = files.snapshot(); let mut next_config = old_config.clone(); next_config.root = Some(preview.target.clone());
    for path in next_config.projects.values_mut().chain(next_config.places.iter_mut()) {
        if let Some(next) = remap(&path.to_string_lossy(),&preview.source,&preview.target) { *path = PathBuf::from(next); }
    }
    write_json(&files.migration_path(),&MoveStatus { id:uuid::Uuid::new_v4().to_string(),state:"pending".into(),source:preview.source,target:preview.target,error:None,old_config,next_config,create_only:preview.create_only,history:None })
}
pub fn cancel(files: &FileWorkspace) -> AppResult<()> {
    let _gate=PLAN_GATE.lock().unwrap();
    if let Some(mut state) = status(files)? {
        if state.state != "pending" { return Err(invalid("只有尚未执行的迁移可以取消")); }
        state.state = "cancelled".into(); write_json(&files.migration_path(),&state)?;
    } Ok(())
}
fn ensure_idle(conn: &Connection) -> AppResult<()> {
    // Local preview checkpoints wait for an explicit frontend continuation. A tool's
    // actual generation is tracked independently in task_queue. Keep these checkpoints
    // resumable (including their remapped paths), rather than requiring cancellation.
    let (tasks,local,cloud,workflows):(i64,i64,i64,i64) = conn.query_row(
        "SELECT (SELECT count(*) FROM task_queue WHERE status IN ('queued','running')),
        (SELECT count(*) FROM local_agent_runs WHERE status NOT IN ('done','completed','succeeded','failed','cancelled','canceled','awaiting_tool','awaiting_approval')),
        (SELECT count(*) FROM cloud_agent_runs WHERE status NOT IN ('done','completed','succeeded','failed','cancelled','canceled','expired')),
        (SELECT count(*) FROM canvas_workflows WHERE json_extract(document_json,'$.run.status') IN ('running','waiting'))",
        [],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let blockers:Vec<_> = [("生成或后台任务",tasks),("本机 Agent",local),("云端 Agent",cloud),("工作流",workflows)]
        .into_iter().filter(|(_,count)|*count>0).map(|(name,count)|format!("{name} {count} 项")).collect();
    if !blockers.is_empty() { return Err(invalid(format!("暂不能迁移资料目录：{}尚未结束，请先完成或取消后重试",blockers.join("、")))); } Ok(())
}
fn rewrite_json(value: &mut serde_json::Value, source: &Path,target: &Path) {
    rewrite_json_with(value,&|text|remap(text,source,target));
}
fn rewrite_json_with(value: &mut serde_json::Value, map: &impl Fn(&str)->Option<String>) {
    match value {
        serde_json::Value::String(text) => if let Some(next)=map(text) { *text=next; },
        serde_json::Value::Array(values) => for value in values { rewrite_json_with(value,map); },
        serde_json::Value::Object(values) => for value in values.values_mut() { rewrite_json_with(value,map); },
        _ => (),
    }
}
fn rewrite_index(conn: &Connection, source: &Path,target: &Path) -> AppResult<()> {
    rewrite_index_with(conn,&|text|remap(text,source,target))
}
fn rewrite_index_with(conn: &Connection, map: &impl Fn(&str)->Option<String>) -> AppResult<()> {
    for (table,column,json) in [
        ("assets","store_path",false),("assets","origin_path",false),("assets","thumb_path",false),
        ("projects","workspace_path",false),("creative_file_queue","source_path",false),
        ("analyses","payload",true),("task_queue","payload",true),("local_agent_runs","checkpoint_json",true),
        ("cloud_agent_runs","snapshot_json",true),("project_canvases","draft_json",true),("canvas_nodes","payload_json",true),
        ("canvas_workflows","document_json",true),("workflow_templates","document_json",true),
    ] {
        let rows = { let mut stmt=conn.prepare(&format!("SELECT rowid,{column} FROM {table} WHERE {column} IS NOT NULL"))?;
            let rows=stmt.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?; rows };
        for (rowid,old) in rows {
            let next = if json { if let Ok(mut value)=serde_json::from_str::<serde_json::Value>(&old) {
                let original=value.clone(); rewrite_json_with(&mut value,map); if original!=value {Some(serde_json::to_string(&value)?)}else{None}
            }else{None} }else{map(&old)};
            if let Some(next)=next { conn.execute(&format!("UPDATE {table} SET {column}=?1 WHERE rowid=?2"),params![next,rowid])?; }
        }
    }
    Ok(())
}
fn copy_file(from: &Path,to: &Path) -> AppResult<()> {
    let hash = fingerprint(from)?;
    if to.exists() { if !to.is_file() || fs::symlink_metadata(to)?.file_type().is_symlink() || fingerprint(to)?!=hash { return Err(invalid(format!("目标已有不同内容，原目录保持不变：{}",to.display()))); } return Ok(()); }
    let mut input=fs::File::open(from)?; let mut output=fs::OpenOptions::new().write(true).create_new(true).open(to)?;
    std::io::copy(&mut input,&mut output)?; output.sync_all()?; drop(output);
    if fingerprint(to)?!=hash || fingerprint(from)?!=hash { return Err(invalid("复制期间文件发生变化或校验失败，未切换目录")); } Ok(())
}
fn copy_tree(source: &Path,target: &Path,entries:&[Entry]) -> AppResult<()> {
    for (index,entry) in entries.iter().enumerate() {
        let to=target.join(&entry.path);
        if to.exists() && fs::symlink_metadata(&to)?.file_type().is_symlink() {return Err(invalid("目标目录包含链接，已停止迁移"));}
        if !fs::canonicalize(to.parent().unwrap())?.starts_with(target) {return Err(invalid("目标路径越出迁移范围"));}
        if entry.directory { fs::create_dir_all(&to)?; }
        else { fs::create_dir_all(to.parent().unwrap())?; copy_file(&source.join(&entry.path),&to)?; }
        if !fs::canonicalize(&to)?.starts_with(target) {return Err(invalid("目标目录中的链接越出迁移范围"));}
        if index%50==0 {tracing::info!("BowerbirdLibrary migration: {index}/{}",entries.len());}
    } Ok(())
}
fn local_classification(files:&FileWorkspace,source:&Path,target:&Path)->AppResult<()> {
    let base=files.local_records_root().parent().unwrap().join("local-classification/folder-records");
    if !base.is_dir(){return Ok(());}
    for entry in fs::read_dir(&base)? {
        let dir=entry?.path(); let record=dir.join("source.json"); if !record.is_file(){continue;}
        let mut value:serde_json::Value=serde_json::from_slice(&fs::read(record)?)?;
        let Some(root)=value["root"].as_str().and_then(|r|remap(r,source,target)) else {continue;};
        let next=super::local_classification::folder::local_record_root(Path::new(&root),&base);
        // Never overwrite another independently edited local record at the new location.
        fs::create_dir_all(next.join(".bowerbird"))?;
        copy_file(&dir.join(".bowerbird/classification.json"),&next.join(".bowerbird/classification.json"))?;
        value["root"]=serde_json::json!(root); write_json(&next.join("source.json"),&value)?;
    } Ok(())
}
fn rewrite_sidecars(source:&Path,target:&Path,entries:&[Entry])->AppResult<()> {
    for entry in entries.iter().filter(|e|!e.directory && e.path.extension().is_some_and(|e|e=="json") && e.path.components().any(|c|c.as_os_str()==".bowerbird")) {
        if entry.size>32*1024*1024 {return Err(invalid("随图资料超过 32 MB，未切换位置"));}
        let path=target.join(&entry.path);
        if let Ok(mut value)=serde_json::from_slice::<serde_json::Value>(&fs::read(&path)?) {
            let before=value.clone();rewrite_json(&mut value,source,target);
            if value!=before {write_json(&path,&value)?;}
        }
    } Ok(())
}

/// Startup only. A failed copy leaves the original configuration active; a committed index
/// must finish its config switch before workers are allowed to start.
pub fn resume(files:&FileWorkspace,db:&Database)->AppResult<()> {
    let Some(mut state)=status(files)? else {return Ok(());};
    if !matches!(state.state.as_str(),"pending"|"copying"){return Ok(());}
    if state.history.is_some() { return history::resume(files,db,state); }
    let committed:bool=db.conn.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM file_workspace_moves WHERE id=?1)",[&state.id],|r|r.get(0))?;
    if !committed {
        let result=(||->AppResult<()> {
            if files.snapshot()!=state.old_config {return Err(invalid("迁移计划创建后配置发生变化，请重新预览"));}
            ensure_idle(&db.conn.lock().unwrap())?;
            if state.create_only && state.source.exists(){return Err(invalid("默认目录已建立，请重新预览迁移"));}
            let entries=if state.create_only{vec![]}else{scan(&state.source)?};
            if (!state.create_only && path_key(&fs::canonicalize(&state.source)?)!=path_key(&state.source))
                || path_key(&fs::canonicalize(state.target.parent().unwrap())?)!=path_key(state.target.parent().unwrap()) {
                return Err(invalid("迁移目录或目标父目录已被替换，请重新选择"));
            }
            let marker=state.target.join(format!(".bowerbird-migration-{}",state.id));
            if state.target.exists() && !marker.is_file() && fs::read_dir(&state.target)?.next().is_some() {return Err(invalid("目标已有文件，已停止迁移"));}
            if state.target.exists() && fs::symlink_metadata(&state.target)?.file_type().is_symlink() {return Err(invalid("目标目录不能是链接"));}
            fs::create_dir_all(&state.target)?;
            let allowed:std::collections::HashSet<_>=entries.iter().map(|e|e.path.clone()).collect();
            for entry in scan(&state.target)? {
                if state.target.join(&entry.path)!=marker && !allowed.contains(&entry.path) {return Err(invalid("目标目录出现计划之外的文件，已停止迁移"));}
            }
            if !marker.exists(){let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&marker)?;file.write_all(state.id.as_bytes())?;file.sync_all()?;}
            state.state="copying".into(); write_json(&files.migration_path(),&state)?;
            copy_tree(&state.source,&state.target,&entries)?;
            if !state.create_only && scan(&state.source)?!=entries {return Err(invalid("复制期间原目录发生变化，未切换位置"));}
            local_classification(files,&state.source,&state.target)?;
            rewrite_sidecars(&state.source,&state.target,&entries)?;
            let mut conn=db.conn.lock().unwrap(); let tx=conn.transaction()?;
            // Keep historical aliases valid for references outside structured JSON too.
            let aliases={let mut stmt=tx.prepare("SELECT id,store_path FROM assets WHERE store_path IS NOT NULL UNION SELECT asset_id,path FROM external_asset_paths")?;
                let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;rows};
            for (id,old) in aliases.iter().filter(|_|!state.create_only) {
                if let Some(new)=remap(&old,&state.source,&state.target) {
                    let conflict:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM external_asset_paths WHERE path=?1 AND asset_id<>?2)",params![new,id],|r|r.get(0))?;
                    if conflict || aliases.iter().any(|(other,path)|other!=id && path_key(Path::new(path))==path_key(Path::new(&new))) {return Err(invalid("新路径已被其他素材引用，未切换位置"));}
                    for path in [old.clone(),new] {tx.execute("INSERT OR IGNORE INTO external_asset_paths(asset_id,path) VALUES(?1,?2)",params![id,path])?;}
                }
            }
            if !state.create_only {rewrite_index(&tx,&state.source,&state.target)?;}
            tx.execute("INSERT INTO file_workspace_moves(id,committed_at) VALUES(?1,?2)",params![state.id,chrono::Utc::now().timestamp()])?;
            tx.commit()?; Ok(())
        })();
        if let Err(error)=result {
            state.state="failed".into();state.error=Some(format!("{error}。原目录仍在使用；已复制的文件保留在 {}。",state.target.display()));
            write_json(&files.migration_path(),&state)?;return Ok(());
        }
    }
    // If interrupted here, the committed marker makes this idempotent on next launch.
    files.replace_config(state.next_config.clone())?;
    state.state="completed".into();state.error=None;write_json(&files.migration_path(),&state)?;
    let _=fs::remove_file(state.target.join(format!(".bowerbird-migration-{}",state.id)));
    Ok(())
}

#[cfg(test)]
#[path="file_workspace_move_tests.rs"]
mod tests;

#[path="legacy_library_move.rs"]
pub mod history;
