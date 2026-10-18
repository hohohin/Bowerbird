//! Explicit, previewed recovery of portable image records. Never moves originals or restores jobs.
use crate::{db::Database, error::{AppError, AppResult}};
use super::{external_files, library::{Asset, Prompt}, paths::LibraryPaths};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::Read, path::{Component, Path, PathBuf}};

const LIMIT: usize = 1000;
const MAX_BYTES: u64 = 16 * 1024 * 1024;
fn invalid(text: impl Into<String>) -> AppError { AppError::Other(text.into()) }
fn valid_id(id: &str) -> bool { !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

#[derive(Deserialize)]
struct SavedAnalysis { id: String, kind: String, payload: String, provider: Option<String>, created_at: Option<i64> }
#[derive(Deserialize)]
struct SavedTag { name: String, color: Option<String> }
#[derive(Deserialize)]
struct SavedPrompt { #[serde(flatten)] prompt: Prompt, role: Option<String> }
#[derive(Deserialize)]
struct Record {
    version: u32, file: String, sha256: String, asset: Asset,
    analyses: Vec<SavedAnalysis>, tags: Vec<SavedTag>, prompts: Vec<SavedPrompt>,
}
struct Candidate { record: Record, path: PathBuf, record_hash: String, record_path: String }
#[derive(Clone, Serialize)]
pub struct Item { pub record_path: String, pub file: String, pub asset_id: Option<String>, pub action: String, pub message: String }
#[derive(Serialize)]
pub struct Preview { pub token: String, pub items: Vec<Item> }
#[derive(Serialize)]
pub struct Restored { pub imported: usize, pub relinked: usize }

fn load(path: &Path) -> AppResult<(Record,String)> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(MAX_BYTES+1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES { return Err(invalid("资料文件超过 16 MB，未读取")); }
    let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
    if raw["deleted"] == true { return Err(invalid("这是已删除素材的记录")); }
    if raw["version"] != 2 || raw["sha256"].as_str().is_none() { return Err(invalid("资料没有内容指纹，请在原设备重新保存随图资料")); }
    let record: Record = serde_json::from_value(raw)?;
    let mut components = Path::new(&record.file).components();
    if record.version != 2 || !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some()
        || record.file.contains(['/', '\\', ':']) || !valid_id(&record.asset.id)
        || record.sha256.len() != 64 || !record.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || record.analyses.len() > LIMIT || record.tags.len() > LIMIT || record.prompts.len() > LIMIT {
        return Err(invalid("资料中的文件名、身份或数量无效"));
    }
    for analysis in &record.analyses {
        if restore_kind(&analysis.kind) && !serde_json::from_str::<serde_json::Value>(&analysis.payload)?.is_object() {
            return Err(invalid("分析资料必须是 JSON 对象"));
        }
    }
    if record.tags.iter().any(|tag| tag.name.trim().is_empty() || tag.name.trim().len() > 1000) {
        return Err(invalid("标签名称无效"));
    }
    Ok((record,digest(&bytes)))
}

fn media_files(root: &Path) -> AppResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && (external_files::image_path(&entry.path()) || external_files::video_path(&entry.path())) {
            files.push(entry.path());
        }
    }
    if files.len() > 10000 { return Err(invalid("当前文件夹超过一万项媒体，请分目录恢复")); }
    Ok(files)
}

fn candidates(root: &Path, recursive: bool) -> AppResult<(Vec<Candidate>, Vec<Item>)> {
    let root = fs::canonicalize(root)?;
    if !root.is_dir() { return Err(invalid("请选择文件夹")); }
    let mut pending = vec![root]; let mut candidates = Vec::new(); let mut issues = Vec::new();
    let mut visited = 0;
    while let Some(directory) = pending.pop() {
        visited += 1;
        if visited > LIMIT { return Err(invalid("子文件夹过多，请缩小恢复范围")); }
        if recursive {
            for entry in fs::read_dir(&directory)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() && !entry.file_name().to_string_lossy().starts_with('.') { pending.push(entry.path()); }
            }
        }
        let metadata = directory.join(".bowerbird");
        if !metadata.exists() { continue; }
        if fs::symlink_metadata(&metadata)?.file_type().is_symlink() || !fs::canonicalize(&metadata)?.starts_with(&directory) {
            issues.push(Item { record_path: metadata.display().to_string(), file: directory.display().to_string(), asset_id: None, action: "blocked".into(), message: "资料目录是外部链接，已跳过".into() }); continue;
        }
        let mut hashes = HashMap::<PathBuf,String>::new();
        let media = media_files(&directory)?;
        for entry in fs::read_dir(&metadata)? {
            let entry = entry?; let path = entry.path();
            if !entry.file_type()?.is_file() || path.extension().and_then(|e| e.to_str()) != Some("json")
                || matches!(path.file_name().and_then(|p| p.to_str()), Some("classification.json" | "project.json" | "source.json")) { continue; }
            if candidates.len()+issues.len() >= LIMIT { return Err(invalid("资料超过一千项，请缩小恢复范围")); }
            let result = (|| -> AppResult<Candidate> {
                let (record, record_hash) = load(&path)?;
                let named = directory.join(&record.file);
                let mut matches = Vec::new();
                let ordered = media.iter().filter(|file| **file == named).chain(media.iter().filter(|file| **file != named));
                for file in ordered {
                    if !hashes.contains_key(file) { hashes.insert(file.clone(), external_files::fingerprint(file)?); }
                    if hashes[file] == record.sha256 {
                        if file == &named { matches = vec![file.clone()]; break; }
                        matches.push(file.clone());
                    }
                }
                if matches.len() != 1 { return Err(invalid(if matches.is_empty() { "没有找到内容一致的图片或视频" } else { "存在多个相同副本，无法确定原文件" })); }
                Ok(Candidate { record, path: fs::canonicalize(&matches[0])?, record_hash, record_path: path.display().to_string() })
            })();
            match result {
                Ok(candidate) => candidates.push(candidate),
                Err(error) => issues.push(Item { record_path: path.display().to_string(), file: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), asset_id: None, action: "blocked".into(), message: error.to_string() }),
            }
        }
    }
    candidates.sort_by(|a,b| a.record_path.cmp(&b.record_path));
    issues.sort_by(|a,b| a.record_path.cmp(&b.record_path));
    Ok((candidates,issues))
}

pub(super) fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    let value = value.strip_prefix("//?/UNC/").map(|v| format!("//{v}")).unwrap_or_else(|| value.strip_prefix("//?/").unwrap_or(&value).to_owned());
    if cfg!(windows) { value.to_lowercase() } else { value }
}

fn plan(conn: &Connection, candidates: &[Candidate], issues: &[Item]) -> AppResult<Preview> {
    let mut items = Vec::new(); let mut signature = Vec::new();
    let all_paths = {
        let mut stmt = conn.prepare("SELECT id,store_path FROM assets WHERE store_path IS NOT NULL")?;
        let result = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        result
    };
    let aliases = {
        let mut stmt = conn.prepare("SELECT asset_id,path FROM external_asset_paths")?;
        let result = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        result
    };
    for candidate in candidates {
        let id = &candidate.record.asset.id;
        let existing: Option<Option<String>> = conn.query_row("SELECT store_path FROM assets WHERE id=?1", [id], |r| r.get(0)).optional()?;
        let expected: Option<String> = conn.query_row("SELECT sha256 FROM creative_file_fingerprints WHERE asset_id=?1 UNION ALL SELECT fingerprint FROM external_assets WHERE asset_id=?1 LIMIT 1", [id], |r| r.get(0)).optional()?;
        let key = path_key(&candidate.path);
        let repeated = candidates.iter().filter(|other| other.record.asset.id == *id || other.path == candidate.path).count() > 1;
        let old_key = existing.as_ref().and_then(|path| path.as_ref()).map(|path| path_key(Path::new(path)));
        let occupied = all_paths.iter().any(|(other,path)| other != id && path_key(Path::new(path)) == key)
            || aliases.iter().any(|(other,path)| other != id && { let alias = path_key(Path::new(path)); alias == key || old_key.as_ref() == Some(&alias) });
        let (action, message) = if repeated || occupied {
            ("blocked", "素材身份或路径重复，保留现有记录")
        } else if expected.as_ref().is_some_and(|value| value != &candidate.record.sha256) {
            ("blocked", "本机记录与随图资料的内容指纹冲突")
        } else if let Some(old) = &existing {
            match old {
                Some(old) if path_key(Path::new(old)) == key => ("existing", "已登记，保留本机创作资料"),
                Some(old) if fs::metadata(old).err().is_none_or(|error| error.kind() != std::io::ErrorKind::NotFound) => ("blocked", "原位置仍有文件或暂时无权读取，请先检查原位置"),
                _ => ("relink", "修复失效引用，保留本机创作资料与项目关联"),
            }
        } else { ("import", "恢复图片描述、生成参数、标签与提示词") };
        items.push(Item { record_path: candidate.record_path.clone(), file: candidate.path.display().to_string(), asset_id: Some(id.clone()), action: action.into(), message: message.into() });
        signature.push(serde_json::json!([candidate.record_hash,candidate.record.sha256,existing,expected]));
    }
    items.extend_from_slice(issues);
    let token = digest(&serde_json::to_vec(&(&items,signature))?);
    Ok(Preview { token, items })
}

pub fn preview(db: &Database, root: &Path, recursive: bool) -> AppResult<Preview> {
    let (candidates,issues) = candidates(root,recursive)?;
    plan(&db.conn.lock().unwrap(), &candidates, &issues)
}

fn restore_kind(kind: &str) -> bool {
    matches!(kind, "caption" | "generation_meta" | "annotation" | "keywords" | "ocr" | "layout" | "inspiration_card")
}
fn import_metadata(conn: &Connection, record: &Record) -> AppResult<()> {
    let id = &record.asset.id;
    for analysis in &record.analyses {
        // Layer workspaces, jobs and remote execution handles are not restored as runnable state.
        if !restore_kind(&analysis.kind) { continue; }
        let payload: serde_json::Value = serde_json::from_str(&analysis.payload)?;
        if !payload.is_object() { return Err(invalid("分析资料必须是 JSON 对象")); }
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM analyses WHERE id=?1)", [&analysis.id], |r| r.get(0))?;
        let aid = if valid_id(&analysis.id) && !exists { analysis.id.clone() } else { ulid::Ulid::new().to_string() };
        conn.execute("INSERT INTO analyses(id,asset_id,kind,payload,provider,created_at) VALUES(?1,?2,?3,?4,?5,?6)", params![aid,id,analysis.kind,analysis.payload,analysis.provider,analysis.created_at])?;
    }
    for tag in &record.tags {
        let name = tag.name.trim();
        if name.is_empty() || name.len() > 1000 { return Err(invalid("标签名称无效")); }
        let existing: Option<String> = conn.query_row("SELECT id FROM tags WHERE name=?1", [name], |r| r.get(0)).optional()?;
        let tid = existing.unwrap_or_else(|| ulid::Ulid::new().to_string());
        conn.execute("INSERT OR IGNORE INTO tags(id,name,color) VALUES(?1,?2,?3)", params![tid,name,tag.color])?;
        conn.execute("INSERT OR IGNORE INTO asset_tags(asset_id,tag_id,origin) VALUES(?1,?2,'manual')", params![id,tid])?;
    }
    for saved in &record.prompts {
        let prompt = &saved.prompt;
        // Shared prompt IDs never overwrite another library's prompt; reuse only exact content.
        let existing: Option<String> = conn.query_row("SELECT body FROM prompts WHERE id=?1", [&prompt.id], |r| r.get(0)).optional()?;
        let pid = if valid_id(&prompt.id) && existing.as_ref().is_none_or(|body| body == &prompt.body) { prompt.id.clone() } else { ulid::Ulid::new().to_string() };
        conn.execute("INSERT OR IGNORE INTO prompts(id,title,body,kind,source_model,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![pid,prompt.title,prompt.body,prompt.kind,prompt.source_model,prompt.created_at,prompt.updated_at])?;
        conn.execute("INSERT OR IGNORE INTO asset_prompts(asset_id,prompt_id,role) VALUES(?1,?2,?3)", params![id,pid,saved.role])?;
    }
    Ok(())
}

pub fn restore(db: &Database, paths: &LibraryPaths, root: &Path, recursive: bool, token: &str) -> AppResult<Restored> {
    let _guard = super::creative_files::RECORD_GATE.lock().unwrap();
    let (candidates,issues) = candidates(root,recursive)?;
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction()?;
    let current = plan(&tx,&candidates,&issues)?;
    if current.token != token { return Err(invalid("文件或本机记录已变化，请重新预览后恢复")); }
    let mut restored = Restored { imported: 0, relinked: 0 };
    for (candidate,item) in candidates.iter().zip(current.items.iter()) {
        if !matches!(item.action.as_str(), "import" | "relink") { continue; }
        let record = &candidate.record; let asset = &record.asset; let id = &asset.id;
        let path = candidate.path.to_string_lossy().into_owned();
        let media = crate::media::probe::probe(&candidate.path)?;
        let thumb = external_files::preview(paths, &candidate.path).ok();
        if external_files::fingerprint(&candidate.path)? != record.sha256 { return Err(invalid("图片在恢复期间发生变化，请重新预览")); }
        let old: Option<Option<String>> = tx.query_row("SELECT store_path FROM assets WHERE id=?1", [id], |r| r.get(0)).optional()?;
        if item.action == "import" {
            tx.execute("INSERT INTO assets(id,name,ext,origin_path,store_path,thumb_path,size,width,height,duration,rating,source,source_url,created_at,file_mtime,generation_session_id,library_hidden) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1)", params![id,asset.name,media.ext,path,thumb,media.size as i64,media.width as i64,media.height as i64,media.duration,asset.rating,asset.source,asset.source_url,asset.created_at,asset.file_mtime,asset.generation_session_id])?;
            import_metadata(&tx, record)?;
            restored.imported += 1;
        } else {
            tx.execute("UPDATE assets SET store_path=?2,thumb_path=?3,origin_path=?2 WHERE id=?1", params![id,path,thumb])?;
            restored.relinked += 1;
        }
        // Recovered files stay externally owned, even when previously generated in a managed root.
        tx.execute("INSERT INTO external_assets(asset_id,fingerprint) VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET fingerprint=excluded.fingerprint", params![id,record.sha256])?;
        for alias in old.flatten().into_iter().chain(std::iter::once(path.clone())) {
            let conflict: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM external_asset_paths WHERE path=?1 AND asset_id<>?2)", params![alias,id], |r| r.get(0))?;
            if conflict { return Err(invalid("引用路径已属于其他素材，未执行恢复")); }
            tx.execute("INSERT OR IGNORE INTO external_asset_paths(asset_id,path) VALUES(?1,?2)", params![id,alias])?;
        }
        tx.execute("INSERT INTO creative_file_fingerprints(asset_id,sha256,asset_size,asset_mtime) VALUES(?1,?2,?3,?4) ON CONFLICT(asset_id) DO UPDATE SET sha256=excluded.sha256,asset_size=excluded.asset_size,asset_mtime=excluded.asset_mtime", params![id,record.sha256,asset.size,asset.file_mtime])?;
        // Reading a portable record must not immediately overwrite that record in the shared folder.
        tx.execute("DELETE FROM creative_file_queue WHERE asset_id=?1", [id])?;
    }
    tx.commit()?;
    Ok(restored)
}

#[cfg(test)]
#[path = "creative_restore_tests.rs"]
mod tests;
