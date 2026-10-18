//! Portable image metadata. SQLite remains the index; failed exports stay queued across restarts.
use crate::{db::Database, error::{AppError, AppResult}};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, sync::Arc};
pub(super) static RECORD_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn rows(conn: &Connection, sql: &str, id: &str) -> AppResult<Vec<Value>> {
    let mut statement = conn.prepare(sql)?;
    let names: Vec<String> = statement.column_names().iter().map(|s| s.to_string()).collect();
    let values = statement.query_map([id], |row| {
        let mut value = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let field = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(n) => json!(n),
                ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into_owned()),
                ValueRef::Blob(_) => Value::Null,
            };
            value.insert(name.clone(), field);
        }
        Ok(Value::Object(value))
    })?.collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

fn snapshot(db: &Database, id: &str, token: &str) -> AppResult<Option<Value>> {
    let conn = db.conn.lock().unwrap();
    let current: Option<String> = conn.query_row("SELECT token FROM creative_file_queue WHERE asset_id=?1", [id], |r| r.get(0)).optional()?;
    if current.as_deref() != Some(token) { return Ok(None); }
    record_snapshot(&conn,id)
}

pub(super) fn record_snapshot(conn: &Connection, id: &str) -> AppResult<Option<Value>> {
    let asset = rows(&conn, "SELECT id,name,ext,size,width,height,duration,rating,source,source_url,created_at,file_mtime,generation_session_id FROM assets WHERE id=?1", id)?;
    let Some(asset) = asset.into_iter().next() else { return Ok(Some(json!({ "version": 1, "asset_id": id, "deleted": true }))); };
    Ok(Some(json!({
        "version": 2, "asset": asset,
        "analyses": rows(&conn, "SELECT id,kind,payload,provider,created_at FROM analyses WHERE asset_id=?1 ORDER BY id", id)?,
        "tags": rows(&conn, "SELECT t.id,t.name,t.color,at.origin FROM tags t JOIN asset_tags at ON at.tag_id=t.id WHERE at.asset_id=?1 ORDER BY t.id", id)?,
        "prompts": rows(&conn, "SELECT p.*,ap.role FROM prompts p JOIN asset_prompts ap ON ap.prompt_id=p.id WHERE ap.asset_id=?1 ORDER BY p.id", id)?,
    })))
}

fn content_identity(db: &Database, id: &str, token: &str, source: &Path, value: &Value) -> AppResult<Option<String>> {
    if value["deleted"] == true { return Ok(None); }
    let size = value["asset"]["size"].as_i64();
    let mtime = value["asset"]["file_mtime"].as_i64();
    let (saved, external) = {
        let conn = db.conn.lock().unwrap();
        let saved = conn.query_row("SELECT sha256,asset_size,asset_mtime FROM creative_file_fingerprints WHERE asset_id=?1", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,Option<i64>>(1)?,r.get::<_,Option<i64>>(2)?))).optional()?;
        let external = conn.query_row("SELECT fingerprint FROM external_assets WHERE asset_id=?1", [id], |r| r.get::<_,String>(0)).optional()?;
        (saved, external)
    };
    let before = match fs::metadata(source) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return saved.map(|v| Some(v.0)).ok_or_else(|| AppError::Other("原文件不可用且尚无内容指纹，已保留待保存资料".into())),
        Err(error) => return Err(error.into()),
    };
    let hash = super::external_files::fingerprint(source)?;
    let after = fs::metadata(source)?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(AppError::Other("图片正在变化，创作资料等待重试".into()));
    }
    let changed = if let Some(expected) = external { expected != hash }
        else { saved.is_some_and(|(expected,s,m)| s == size && m == mtime && expected != hash) };
    if changed { return Err(AppError::Other("图片内容已在应用外变化，已保留原创作资料".into())); }
    let updated = db.conn.lock().unwrap().execute("INSERT INTO creative_file_fingerprints(asset_id,sha256,asset_size,asset_mtime) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM assets WHERE id=?1) AND EXISTS(SELECT 1 FROM creative_file_queue WHERE asset_id=?1 AND token=?5) ON CONFLICT(asset_id) DO UPDATE SET sha256=excluded.sha256,asset_size=excluded.asset_size,asset_mtime=excluded.asset_mtime", rusqlite::params![id,hash,size,mtime,token])?;
    if updated == 0 { return Err(AppError::Other("资料已更新，等待重新保存".into())); }
    Ok(Some(hash))
}

fn sidecar(source: &Path, id: &str, value: &Value) -> AppResult<PathBuf> {
    // Never recreate a disconnected share or a missing image directory.
    let parent = source.parent().filter(|p| p.is_dir()).ok_or_else(|| AppError::Other("图片目录不可用".into()))?;
    let metadata = parent.join(".bowerbird");
    fs::create_dir_all(&metadata)?;
    if !fs::canonicalize(&metadata)?.starts_with(fs::canonicalize(parent)?) {
        return Err(AppError::Other("创作资料目录不能链接到图片文件夹之外".into()));
    }
    let path = metadata.join(format!("{id}.json"));
    super::file_workspace::write_json(&path, value)?;
    Ok(path)
}

/// Local fallback is persistent user data, with the original absolute path for lookup.
pub fn flush(db: &Database, local: &Path) -> AppResult<usize> {
    flush_selected(db, local, None)
}

fn flush_selected(db: &Database, local: &Path, selected: Option<&[String]>) -> AppResult<usize> {
    let _guard = RECORD_GATE.lock().unwrap();
    let pending = {
        let conn = db.conn.lock().unwrap();
        let filter = selected.map(serde_json::to_string).transpose()?;
        let limit = selected.map_or(64, |ids| ids.len() as i64);
        let mut stmt = conn.prepare("SELECT asset_id,token,source_path FROM creative_file_queue WHERE (?1 IS NULL OR asset_id IN (SELECT value FROM json_each(?1))) ORDER BY error IS NOT NULL,rowid LIMIT ?2")?;
        let values = stmt.query_map(rusqlite::params![filter,limit], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?)))?
            .collect::<Result<Vec<_>,_>>()?;
        values
    };
    let mut completed = 0;
    for (id, token, source) in pending {
        // IDs may originate in an imported index; never use arbitrary path components.
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { continue; }
        let Some(mut value) = snapshot(db, &id, &token)? else { continue; };
        let Some(source) = source else {
            db.conn.lock().unwrap().execute("DELETE FROM creative_file_queue WHERE asset_id=?1 AND token=?2", [&id,&token])?;
            continue;
        };
        let source = PathBuf::from(source);
        value["file"] = json!(source.file_name().unwrap_or_default().to_string_lossy());
        match content_identity(db, &id, &token, &source, &value) {
            Ok(hash) => value["sha256"] = json!(hash),
            Err(error) => {
                db.conn.lock().unwrap().execute("UPDATE creative_file_queue SET error=?3 WHERE asset_id=?1 AND token=?2", [&id,&token,&error.to_string()])?;
                continue;
            }
        }
        let local_path = local.join(format!("{id}.json"));
        // Once a fallback exists, retain its authority until an explicit reconciliation.
        let result = if local_path.exists() { Err(AppError::Other("使用本机创作资料".into())) }
            else { sidecar(&source, &id, &value).map(|_| ()) };
        let result = result.or_else(|_| {
            value["source_path"] = json!(source);
            value["storage"] = json!("local");
            super::file_workspace::write_json(&local_path, &value)
        });
        let conn = db.conn.lock().unwrap();
        match result {
            Ok(()) => {
                completed += conn.execute("DELETE FROM creative_file_queue WHERE asset_id=?1 AND token=?2", [&id,&token])?;
            }
            Err(error) => {
                let message = error.to_string();
                conn.execute("UPDATE creative_file_queue SET error=?3 WHERE asset_id=?1 AND token=?2", [&id,&token,&message])?;
                tracing::warn!("creative metadata export pending for {id}: {message}");
            }
        }
    }
    Ok(completed)
}

#[derive(serde::Serialize)]
pub struct SavedDirectory { pub total: usize, pub pending: usize, pub local: usize }

/// Explicitly upgrades old sidecars for already indexed media in this exact directory.
pub fn save_directory(db: &Database, local: &Path, root: &Path) -> AppResult<SavedDirectory> {
    let root = fs::canonicalize(root)?;
    if !root.is_dir() { return Err(AppError::Other("请选择文件夹".into())); }
    let candidates = {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,store_path FROM assets WHERE store_path IS NOT NULL")?;
        let values = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        values
    };
    let selected: Vec<(String,String)> = candidates.into_iter().filter(|(_,path)| {
        Path::new(path).parent().is_some_and(|parent| super::creative_restore::path_key(parent) == super::creative_restore::path_key(&root))
    }).collect();
    let ids: Vec<String> = selected.iter().map(|(id,_)| id.clone()).collect();
    {
        let conn = db.conn.lock().unwrap();
        for (id,path) in &selected {
            conn.execute("INSERT INTO creative_file_queue(asset_id,token,source_path) VALUES(?1,hex(randomblob(16)),?2) ON CONFLICT(asset_id) DO UPDATE SET token=excluded.token,source_path=excluded.source_path,error=NULL", rusqlite::params![id,path])?;
        }
    }
    flush_selected(db, local, Some(&ids))?;
    let pending: usize = db.conn.lock().unwrap().query_row("SELECT count(*) FROM creative_file_queue WHERE asset_id IN (SELECT value FROM json_each(?1))", [serde_json::to_string(&ids)?], |r| r.get(0))?;
    let local = ids.iter().filter(|id| local.join(format!("{id}.json")).is_file()).count();
    Ok(SavedDirectory { total: ids.len(), pending, local })
}

pub fn watch(db: Arc<Database>, local: PathBuf) {
    tauri::async_runtime::spawn(async move {
        loop {
            let db = db.clone(); let local = local.clone();
            match tauri::async_runtime::spawn_blocking(move || flush(&db, &local)).await {
                Ok(Ok(_)) => (),
                result => tracing::warn!("creative metadata export retry: {result:?}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_metadata_updates_and_pending_exports_survive_reopen() {
        let root = std::env::temp_dir().join(format!("bb-creative-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("images")).unwrap();
        let source = root.join("images/p.png"); fs::write(&source, b"original").unwrap();
        let db_path = root.join("index.db");
        let db = Database::open(&db_path).unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,store_path) VALUES('a','picture',?1)", [source.to_str().unwrap()]).unwrap();
        drop(db);
        let db = Database::open(&db_path).unwrap();
        assert_eq!(flush(&db, &root.join("local")).unwrap(), 1);
        let saved = root.join("images/.bowerbird/a.json");
        let value: Value = serde_json::from_slice(&fs::read(&saved).unwrap()).unwrap();
        assert_eq!(value["file"], "p.png");
        assert!(value.get("source_path").is_none());
        db.conn.lock().unwrap().execute_batch("INSERT INTO analyses(id,asset_id,kind,payload) VALUES('meta','a','generation_meta','prompt'); INSERT INTO tags(id,name) VALUES('t','旧标签'); INSERT INTO asset_tags(asset_id,tag_id) VALUES('a','t'); UPDATE tags SET name='新标签' WHERE id='t';").unwrap();
        assert_eq!(flush(&db, &root.join("local")).unwrap(), 1);
        let value: Value = serde_json::from_slice(&fs::read(&saved).unwrap()).unwrap();
        assert_eq!(value["analyses"][0]["payload"], "prompt");
        assert_eq!(value["tags"][0]["name"], "新标签");
        // Lost source directory exports to persistent local storage; original bytes are untouched.
        fs::rename(root.join("images"), root.join("moved")).unwrap();
        db.conn.lock().unwrap().execute("UPDATE assets SET rating=5 WHERE id='a'", []).unwrap();
        assert_eq!(flush(&db, &root.join("local")).unwrap(), 1);
        let value: Value = serde_json::from_slice(&fs::read(root.join("local/a.json")).unwrap()).unwrap();
        assert_eq!(value["storage"], "local");
        assert_eq!(value["asset"]["rating"], 5);
        assert_eq!(fs::read(root.join("moved/p.png")).unwrap(), b"original");
        assert!(!root.join("images").exists());
        // If both destinations fail, the committed source data and export request survive restart.
        let blocked = root.join("blocked"); fs::write(&blocked, b"not a folder").unwrap();
        db.conn.lock().unwrap().execute("UPDATE assets SET rating=4 WHERE id='a'", []).unwrap();
        assert_eq!(flush(&db, &blocked).unwrap(), 0);
        assert!(db.conn.lock().unwrap().query_row("SELECT error FROM creative_file_queue WHERE asset_id='a'", [], |r| r.get::<_,Option<String>>(0)).unwrap().is_some());
        drop(db);
        let db = Database::open(&db_path).unwrap();
        assert_eq!(flush(&db, &root.join("local")).unwrap(), 1);
        let value: Value = serde_json::from_slice(&fs::read(root.join("local/a.json")).unwrap()).unwrap();
        assert_eq!(value["asset"]["rating"], 4);
        drop(db); fs::remove_dir_all(root).unwrap();
    }
}
