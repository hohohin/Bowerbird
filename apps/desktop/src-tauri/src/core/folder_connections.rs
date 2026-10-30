//! Connected directories own entries, never copies of existing originals.
use super::{external_files, library::Asset, paths::LibraryPaths};
use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn invalid(value: impl Into<String>) -> AppError {
    AppError::Other(value.into())
}
fn string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn id() -> String {
    ulid::Ulid::new().to_string()
}
fn name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn valid_name(value: &str) -> AppResult<&str> {
    let value = value.trim();
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.ends_with(['.', ' '])
        || value.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || value.chars().any(char::is_control)
    {
        return Err(invalid("请输入有效名称，不包含路径分隔符或特殊字符"));
    }
    Ok(value)
}
fn directory(path: &Path) -> AppResult<PathBuf> {
    let path = fs::canonicalize(path)?;
    if !path.is_dir() {
        return Err(invalid("请选择已有文件夹"));
    }
    Ok(path)
}
fn media(path: &Path) -> bool {
    external_files::image_path(path) || external_files::video_path(path)
}
fn reference(path: &Path) -> bool {
    path.extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("bowerbird"))
}
fn stamp(path: &Path) -> AppResult<(i64, String)> {
    let value = fs::metadata(path)?;
    Ok((value.len() as i64, format!("{:?}", value.modified()?)))
}

#[derive(Clone, Serialize)]
pub struct FolderConnection {
    pub id: String,
    pub parent_id: Option<String>,
    pub root_id: String,
    pub name: String,
    pub path: String,
    pub available: bool,
    pub count: i64,
    pub scanning: bool,
    pub error: Option<String>,
}
#[derive(Serialize)]
pub struct ConnectionEntry {
    pub id: String,
    pub folder_id: String,
    pub asset_id: String,
    pub name: String,
    pub path: String,
    pub is_reference: bool,
    pub available: bool,
    pub asset: Asset,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialReference {
    version: u32,
    kind: String,
    asset_id: String,
    target_relative: Option<String>,
    target_path: String,
    sha256: String,
}

fn relative(from: &Path, target: &Path) -> Option<String> {
    let left: Vec<_> = from.components().collect();
    let right: Vec<_> = target.components().collect();
    let common = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    if common == 0 {
        return None;
    }
    let mut result = PathBuf::new();
    for _ in common..left.len() {
        result.push("..");
    }
    for part in &right[common..] {
        result.push(part.as_os_str());
    }
    Some(string(&result).replace('\\', "/"))
}
fn load_reference(path: &Path) -> AppResult<MaterialReference> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err(invalid("分身文件过大，未读取"));
    }
    let value: MaterialReference = serde_json::from_slice(&bytes)?;
    if value.version != 1
        || value.kind != "bowerbird-reference"
        || value.asset_id.is_empty()
        || value.asset_id.len() > 128
        || !value
            .asset_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        || value.sha256.len() != 64
        || !value.sha256.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(invalid("分身文件格式无效"));
    }
    Ok(value)
}
fn write_reference(path: &Path, asset: &Asset, replace: bool) -> AppResult<()> {
    let target = Path::new(
        asset
            .store_path
            .as_deref()
            .ok_or_else(|| invalid("原文件不可用"))?,
    );
    if !target.is_file() || reference(target) {
        return Err(invalid("原文件不可用，无法创建分身"));
    }
    let value = MaterialReference {
        version: 1,
        kind: "bowerbird-reference".into(),
        asset_id: asset.id.clone(),
        target_relative: relative(path.parent().unwrap(), target),
        target_path: string(target),
        sha256: external_files::fingerprint(target)?,
    };
    if replace {
        return super::file_workspace::write_json(path, &value);
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(&serde_json::to_vec_pretty(&value)?)?;
    file.sync_all()?;
    Ok(())
}

impl Database {
    pub fn connected_root_ids(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM connected_roots ORDER BY rowid")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn connect_directory(&self, path: &Path, project: Option<&str>) -> AppResult<String> {
        let path = directory(path)?;
        let conn = self.conn.lock().unwrap();
        if let Some(project) = project {
            if !conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
                [project],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(invalid("项目已不存在"));
            }
        }
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM connected_folders WHERE path=?1",
                [string(&path)],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            drop(conn);
            self.connect_project(&existing, project)?;
            return Ok(existing);
        }
        let mut stmt = conn.prepare("SELECT path FROM connected_roots")?;
        for other in stmt.query_map([], |r| r.get::<_, String>(0))? {
            let other = other?;
            if Path::new(&other).starts_with(&path) {
                return Err(invalid("此目录包含已经连接的目录，请先断开已有连接"));
            }
            if path.starts_with(&other) {
                return Err(invalid("此目录已在连接范围内，请刷新后从集合中选择"));
            }
        }
        let id = id();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO connected_roots(id,path,project_id) VALUES(?1,?2,?3)",
            params![id, string(&path), project],
        )?;
        tx.execute(
            "INSERT INTO connected_folders(id,root_id,path,name) VALUES(?1,?1,?2,?3)",
            params![id, string(&path), name(&path)],
        )?;
        tx.commit()?;
        drop(stmt);
        drop(conn);
        self.connect_project(&id, project)?;
        Ok(id)
    }
    fn connect_project(&self, folder: &str, project: Option<&str>) -> AppResult<()> {
        let Some(project) = project else {
            return Ok(());
        };
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO connected_folder_projects(folder_id,project_id) VALUES(?1,?2)",
            params![folder, project],
        )?;
        tx.execute("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM connected_folders f JOIN tree t ON f.parent_id=t.id) INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) SELECT ?2,e.asset_id,strftime('%s','now') FROM connected_entries e JOIN tree t ON t.id=e.folder_id",params![folder,project])?;
        tx.commit()?;
        Ok(())
    }
    fn connect_entry_projects(&self, folder: &str, asset: &str) -> AppResult<()> {
        self.conn.lock().unwrap().execute("WITH RECURSIVE parents(id,parent_id) AS (SELECT id,parent_id FROM connected_folders WHERE id=?1 UNION ALL SELECT f.id,f.parent_id FROM connected_folders f JOIN parents p ON f.id=p.parent_id) INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) SELECT p.project_id,?2,strftime('%s','now') FROM connected_folder_projects p JOIN parents f ON f.id=p.folder_id",params![folder,asset])?;
        Ok(())
    }
    pub fn connected_folder(&self, id: &str) -> AppResult<FolderConnection> {
        self.connection_folders(None, None)?
            .into_iter()
            .find(|f| f.id == id)
            .ok_or_else(|| invalid("集合已不存在，请刷新后重试"))
    }
    pub fn connection_folders(
        &self,
        project: Option<&str>,
        media_filter: Option<&str>,
    ) -> AppResult<Vec<FolderConnection>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT f.id,f.parent_id,f.root_id,f.name,f.path,f.available AND r.available,r.scanning,r.error,
          (SELECT COUNT(*) FROM connected_entries e JOIN assets a ON a.id=e.asset_id WHERE e.folder_id=f.id
            AND (?1 IS NULL OR EXISTS(SELECT 1 FROM project_assets p WHERE p.asset_id=a.id AND p.project_id=?1))
            AND (?2 IS NULL OR ?2='all' OR (?2='videos')=(lower(COALESCE(a.ext,'')) IN ('mp4','mov','webm','mkv','avi','m4v'))))
          FROM connected_folders f JOIN connected_roots r ON r.id=f.root_id ORDER BY r.rowid,lower(f.name),f.id")?;
        let values = stmt
            .query_map(params![project, media_filter], |r| {
                Ok(FolderConnection {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    root_id: r.get(2)?,
                    name: r.get(3)?,
                    path: r.get(4)?,
                    available: r.get(5)?,
                    scanning: r.get(6)?,
                    error: r.get(7)?,
                    count: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values)
    }
    pub fn connection_entry_ids(
        &self,
        folder: Option<&str>,
        project: Option<&str>,
        media_filter: Option<&str>,
        offset: i64,
        limit: i64,
    ) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT e.id FROM connected_entries e JOIN assets a ON a.id=e.asset_id
          WHERE (?1 IS NULL OR e.folder_id=?1) AND (?2 IS NULL OR EXISTS(SELECT 1 FROM project_assets p WHERE p.asset_id=a.id AND p.project_id=?2))
          AND (?3 IS NULL OR ?3='all' OR (?3='videos')=(lower(COALESCE(a.ext,'')) IN ('mp4','mov','webm','mkv','avi','m4v')))
          ORDER BY lower(e.name),e.id LIMIT ?4 OFFSET ?5")?;
        let values = stmt
            .query_map(
                params![
                    folder,
                    project,
                    media_filter,
                    limit.clamp(1, 2000),
                    offset.max(0)
                ],
                |r| r.get(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values)
    }
    fn every_entry_id(&self, folder: Option<&str>) -> AppResult<Vec<String>> {
        let mut result = Vec::new();
        loop {
            let batch = self.connection_entry_ids(folder, None, None, result.len() as i64, 2000)?;
            let complete = batch.len() < 2000;
            result.extend(batch);
            if complete {
                break;
            }
        }
        Ok(result)
    }
    pub fn resolve_connection_entries(&self, ids: &[String]) -> AppResult<Vec<ConnectionEntry>> {
        if ids.len() > 2000 {
            return Err(invalid("一次最多操作 2000 项，请分批操作"));
        }
        let mut result = Vec::new();
        for id in ids {
            let row = self.conn.lock().unwrap().query_row("SELECT e.folder_id,e.asset_id,e.name,e.path,e.is_reference,e.available AND f.available AND r.available FROM connected_entries e JOIN connected_folders f ON f.id=e.folder_id JOIN connected_roots r ON r.id=f.root_id WHERE e.id=?1", [id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,bool>(4)?,r.get::<_,bool>(5)?))).optional()?;
            if let Some((folder_id, asset_id, name, path, is_reference, available)) = row {
                if let Some(asset) = self.get_asset(&asset_id)? {
                    let available = available
                        && asset
                            .store_path
                            .as_deref()
                            .is_some_and(|path| Path::new(path).is_file());
                    result.push(ConnectionEntry {
                        id: id.clone(),
                        folder_id,
                        asset_id,
                        name,
                        path,
                        is_reference,
                        available,
                        asset,
                    });
                }
            }
        }
        Ok(result)
    }
    fn writable_connection(&self, id: &str) -> AppResult<FolderConnection> {
        let folder = self.connected_folder(id)?;
        if !folder.available || !Path::new(&folder.path).is_dir() {
            return Err(invalid("文件夹暂不可用，请重新连接后重试"));
        }
        if fs::symlink_metadata(&folder.path)?.file_type().is_symlink()
            || fs::canonicalize(&folder.path)? != Path::new(&folder.path)
        {
            return Err(invalid("目录已变为链接，请重新定位后重试"));
        }
        Ok(folder)
    }
    fn register_connected_asset(&self, paths: &LibraryPaths, path: &Path) -> AppResult<Asset> {
        // Recover a uniquely identifiable original moved outside the app. Never merge two live originals.
        let known:bool=self.conn.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM external_asset_paths WHERE path=?1 UNION ALL SELECT 1 FROM assets WHERE store_path=?1)",[string(path)],|r|r.get(0))?;
        let hash = external_files::fingerprint(path)?;
        let candidates: Vec<(String, String)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt=conn.prepare("SELECT a.id,a.store_path FROM assets a JOIN external_assets e ON e.asset_id=a.id WHERE e.fingerprint=?1")?;
            let rows = stmt
                .query_map([&hash], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let missing: Vec<_> = candidates
            .into_iter()
            .filter(|(_, p)| !Path::new(p).exists())
            .collect();
        if !known && missing.len() == 1 {
            let (id, old) = &missing[0];
            self.repoint_asset(id, Path::new(old), path)?;
        }
        let asset = super::ingest::ingest_file(paths, self, path)?;
        self.conn.lock().unwrap().execute(
            "UPDATE external_assets SET library_member=1 WHERE asset_id=?1",
            [&asset.id],
        )?;
        self.conn.lock().unwrap().execute(
            "UPDATE assets SET library_hidden=0 WHERE id=?1",
            [&asset.id],
        )?;
        Ok(asset)
    }
    fn resolve_reference(&self, paths: &LibraryPaths, path: &Path) -> AppResult<Asset> {
        let value = load_reference(path)?;
        if let Some(asset) = self.get_asset(&value.asset_id)? {
            let expected:Option<String>=self.conn.lock().unwrap().query_row("SELECT COALESCE(e.fingerprint,f.sha256) FROM assets a LEFT JOIN external_assets e ON e.asset_id=a.id LEFT JOIN creative_file_fingerprints f ON f.asset_id=a.id WHERE a.id=?1",[&value.asset_id],|r|r.get(0))?;
            let expected = expected.or_else(|| {
                asset
                    .store_path
                    .as_deref()
                    .and_then(|p| external_files::fingerprint(Path::new(p)).ok())
            });
            if expected.as_deref() != Some(value.sha256.as_str()) {
                return Err(invalid("分身与已有素材的校验信息不一致，未更改原素材"));
            }
            if asset
                .store_path
                .as_deref()
                .is_some_and(|p| Path::new(p).is_file())
            {
                return Ok(asset);
            }
        }
        let relative = value
            .target_relative
            .as_ref()
            .map(|p| path.parent().unwrap().join(p.replace('\\', "/")));
        let candidate = relative
            .filter(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from(value.target_path));
        if !media(&candidate)
            || reference(&candidate)
            || external_files::fingerprint(&candidate)? != value.sha256
        {
            return Err(invalid("分身的原文件失联，请重新定位原文件目录"));
        }
        if self.get_asset(&value.asset_id)?.is_some() {
            let old = self
                .get_asset(&value.asset_id)?
                .unwrap()
                .store_path
                .unwrap_or_default();
            self.repoint_asset(
                &value.asset_id,
                Path::new(&old),
                &fs::canonicalize(candidate)?,
            )?;
            return self
                .get_asset(&value.asset_id)?
                .ok_or_else(|| invalid("素材已不存在"));
        }
        self.index_external_with_id(paths, &candidate, Some(&value.asset_id))?;
        let asset = super::ingest::ingest_file(paths, self, &candidate)?;
        self.conn.lock().unwrap().execute(
            "UPDATE external_assets SET library_member=1 WHERE asset_id=?1",
            [&asset.id],
        )?;
        self.conn.lock().unwrap().execute(
            "UPDATE assets SET library_hidden=0 WHERE id=?1",
            [&asset.id],
        )?;
        Ok(asset)
    }
    /// A failed/incomplete walk never removes cached entries. Only completed directory listings reconcile removals.
    pub fn scan_connection(&self, paths: &LibraryPaths, root_id: &str) -> AppResult<()> {
        self.scan_connection_with_progress(paths, root_id, || {})
    }
    pub fn scan_connection_with_progress(
        &self,
        paths: &LibraryPaths,
        root_id: &str,
        mut progress: impl FnMut(),
    ) -> AppResult<()> {
        let root = self.connected_folder(root_id)?;
        self.conn.lock().unwrap().execute(
            "UPDATE connected_roots SET scanning=1,error=NULL WHERE id=?1",
            [root_id],
        )?;
        progress();
        let result = self.scan_connection_inner(paths, &root, &mut progress);
        let message = result.as_ref().err().map(ToString::to_string);
        self.conn.lock().unwrap().execute(
            "UPDATE connected_roots SET scanning=0,error=?2,scanned_at=?3,available=?4 WHERE id=?1",
            params![
                root_id,
                message,
                chrono::Utc::now().timestamp(),
                Path::new(&root.path).is_dir()
            ],
        )?;
        result
    }
    fn scan_connection_inner(
        &self,
        paths: &LibraryPaths,
        root: &FolderConnection,
        progress: &mut impl FnMut(),
    ) -> AppResult<()> {
        let mut pending = vec![(root.id.clone(), PathBuf::from(&root.path))];
        let mut errors = Vec::new();
        while let Some((folder_id, path)) = pending.pop() {
            // Directory junctions can change without changing the registered path. Do not walk
            // outside the chosen location (or recurse into a cycle) after such a replacement.
            if fs::canonicalize(&path).is_ok_and(|canonical| canonical != path) {
                self.mark_folder_unavailable(&folder_id)?;
                errors.push("目录位置已变化，请重新定位后刷新".to_owned());
                continue;
            }
            let listed: Vec<_> =
                match fs::read_dir(&path).and_then(|items| items.collect::<Result<Vec<_>, _>>()) {
                    Ok(value) => value,
                    Err(error) => {
                        self.mark_folder_unavailable(&folder_id)?;
                        errors.push(error.to_string());
                        continue;
                    }
                };
            self.conn.lock().unwrap().execute(
                "UPDATE connected_folders SET available=1 WHERE id=?1",
                [&folder_id],
            )?;
            let mut seen = HashSet::new();
            let mut seen_folders = HashSet::new();
            let mut complete = true;
            for item in listed {
                let file_type = match item.file_type() {
                    Ok(value) => value,
                    Err(error) => {
                        errors.push(error.to_string());
                        complete = false;
                        continue;
                    }
                };
                let file = item.path();
                let file_name = name(&file);
                if file_type.is_symlink()
                    || file_name == ".bowerbird"
                    || file_name.starts_with(".bowerbird-")
                {
                    continue;
                }
                if file_type.is_dir() {
                    seen_folders.insert(string(&file));
                    let conn = self.conn.lock().unwrap();
                    let existing: Option<String> = conn
                        .query_row(
                            "SELECT id FROM connected_folders WHERE path=?1",
                            [string(&file)],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let next_id = existing.unwrap_or_else(id);
                    conn.execute("INSERT INTO connected_folders(id,root_id,parent_id,path,name) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(path) DO UPDATE SET available=1",params![next_id,root.id,folder_id,string(&file),file_name])?;
                    pending.push((next_id, file));
                    continue;
                }
                if !file_type.is_file() || (!media(&file) && !reference(&file)) {
                    continue;
                }
                seen.insert(string(&file));
                let processed = (|| -> AppResult<()> {
                    let (size, mtime) = stamp(&file)?;
                    let old:Option<(String,i64,String)>=self.conn.lock().unwrap().query_row("SELECT asset_id,COALESCE(size,-1),COALESCE(mtime,'') FROM connected_entries WHERE path=?1",[string(&file)],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
                    let reference_resolved = !reference(&file)
                        || old
                            .as_ref()
                            .and_then(|(asset, _, _)| self.get_asset(asset).ok().flatten())
                            .and_then(|a| a.store_path)
                            .is_some_and(|p| Path::new(&p).is_file());
                    if reference_resolved
                        && old
                            .as_ref()
                            .is_some_and(|(_, s, m)| *s == size && *m == mtime)
                    {
                        self.conn.lock().unwrap().execute(
                            "UPDATE connected_entries SET available=1 WHERE path=?1",
                            [string(&file)],
                        )?;
                        return Ok(());
                    }
                    let asset = if reference(&file) {
                        self.resolve_reference(paths, &file)?
                    } else {
                        self.register_connected_asset(paths, &file)?
                    };
                    if stamp(&file)? != (size, mtime.clone()) {
                        return Err(invalid("文件正在变化，请稍后刷新"));
                    }
                    self.conn.lock().unwrap().execute("INSERT INTO connected_entries(id,folder_id,asset_id,path,name,is_reference,size,mtime) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(path) DO UPDATE SET asset_id=excluded.asset_id,available=1,size=excluded.size,mtime=excluded.mtime",params![id(),folder_id,asset.id,string(&file),file_name,reference(&file),size,mtime])?;
                    // Refresh preserves explicit project removals. A new entry/identity joins
                    // connected projects; explicitly reconnecting a folder restores cached members.
                    if old
                        .as_ref()
                        .is_none_or(|(previous, _, _)| previous != &asset.id)
                    {
                        self.connect_entry_projects(&folder_id, &asset.id)?;
                    }
                    Ok(())
                })();
                if let Err(error) = processed {
                    self.conn.lock().unwrap().execute(
                        "UPDATE connected_entries SET available=0 WHERE path=?1",
                        [string(&file)],
                    )?;
                    errors.push(format!("{}：{}", file_name, error));
                }
                progress();
            }
            // Reconcile only after all directory entries were read successfully; assets/creative data survive.
            if !complete {
                continue;
            }
            let conn = self.conn.lock().unwrap();
            let old: Vec<(String, String)> = {
                let mut stmt =
                    conn.prepare("SELECT id,path FROM connected_entries WHERE folder_id=?1")?;
                let rows = stmt
                    .query_map([&folder_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for (id, path) in old {
                if !seen.contains(&path) {
                    conn.execute("DELETE FROM connected_entries WHERE id=?1", [id])?;
                }
            }
            let old: Vec<(String, String)> = {
                let mut stmt =
                    conn.prepare("SELECT id,path FROM connected_folders WHERE parent_id=?1")?;
                let rows = stmt
                    .query_map([&folder_id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            for (id, path) in old {
                if !seen_folders.contains(&path) {
                    conn.execute("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM connected_folders f JOIN tree t ON f.parent_id=t.id) UPDATE connected_folders SET available=0 WHERE id IN tree",[id])?;
                }
            }
            drop(conn);
            progress();
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(invalid(format!(
                "部分素材未能刷新，已有资料已保留：{}",
                errors.into_iter().take(4).collect::<Vec<_>>().join("；")
            )))
        }
    }
    fn mark_folder_unavailable(&self, id: &str) -> AppResult<()> {
        self.conn.lock().unwrap().execute("WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM connected_folders f JOIN tree t ON f.parent_id=t.id) UPDATE connected_folders SET available=0 WHERE id IN tree",[id])?;
        Ok(())
    }
    pub fn create_connected_directory(
        &self,
        parent: Option<&str>,
        base: Option<&Path>,
        value: &str,
        project: Option<&str>,
    ) -> AppResult<String> {
        let value = valid_name(value)?;
        if let Some(parent) = parent {
            let folder = self.writable_connection(parent)?;
            let path = Path::new(&folder.path).join(value);
            fs::create_dir(&path)?;
            let id = id();
            let result=self.conn.lock().unwrap().execute("INSERT INTO connected_folders(id,root_id,parent_id,path,name) VALUES(?1,?2,?3,?4,?5)",params![id,folder.root_id,parent,string(&path),value]);
            if let Err(error) = result {
                let _ = fs::remove_dir(&path);
                return Err(error.into());
            }
            self.connect_project(&id, project)?;
            Ok(id)
        } else {
            let path = directory(base.ok_or_else(|| invalid("请选择保存位置"))?)?.join(value);
            fs::create_dir(&path)?;
            let result = self.connect_directory(&path, project);
            if result.is_err() {
                let _ = fs::remove_dir(&path);
            }
            result
        }
    }
    pub fn disconnect_directory(&self, id: &str) -> AppResult<()> {
        let folder = self.connected_folder(id)?;
        if folder.parent_id.is_some() {
            return Err(invalid("请从连接的根目录断开"));
        }
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM connected_roots WHERE id=?1", [id])?;
        Ok(())
    }
    fn repoint_asset(&self, id: &str, old: &Path, new: &Path) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        repoint_asset_in(&tx, id, old, new)?;
        tx.commit()?;
        Ok(())
    }
    fn rewrite_references(&self) -> AppResult<()> {
        let ids = self.every_entry_id(None)?;
        let mut failed = Vec::new();
        for batch in ids.chunks(2000) {
            for entry in self.resolve_connection_entries(batch)? {
                if entry.is_reference && entry.available {
                    if let Err(error) = write_reference(Path::new(&entry.path), &entry.asset, true)
                    {
                        tracing::warn!("reference update {}: {error}", entry.id);
                        failed.push(entry.name);
                    }
                }
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(invalid(format!(
                "文件已移动，部分分身的跨设备定位信息未能更新：{}；请检查写入权限后刷新",
                failed.join("、")
            )))
        }
    }
    fn repoint_tree(
        &self,
        source: &FolderConnection,
        destination: &Path,
        target: Option<&FolderConnection>,
    ) -> AppResult<()> {
        let folders: Vec<_> = self
            .connection_folders(None, None)?
            .into_iter()
            .filter(|f| Path::new(&f.path).starts_with(&source.path))
            .collect();
        let mut updates = Vec::new();
        for folder in &folders {
            let next =
                destination.join(Path::new(&folder.path).strip_prefix(&source.path).unwrap());
            let ids = self.every_entry_id(Some(&folder.id))?;
            for batch in ids.chunks(2000) {
                for entry in self.resolve_connection_entries(batch)? {
                    let next_file = next.join(&entry.name);
                    updates.push((entry, next_file));
                }
            }
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        for (entry, next_file) in updates {
            if !entry.is_reference {
                repoint_asset_in(&tx, &entry.asset_id, Path::new(&entry.path), &next_file)?;
            }
            tx.execute(
                "UPDATE connected_entries SET path=?2 WHERE id=?1",
                params![entry.id, string(&next_file)],
            )?;
        }
        for folder in folders {
            let next =
                destination.join(Path::new(&folder.path).strip_prefix(&source.path).unwrap());
            tx.execute(
                "UPDATE connected_folders SET path=?2,root_id=?3,available=1 WHERE id=?1",
                params![
                    folder.id,
                    string(&next),
                    target
                        .map(|f| f.root_id.as_str())
                        .unwrap_or(&source.root_id)
                ],
            )?;
        }
        tx.execute(
            "UPDATE connected_folders SET name=?2,parent_id=?3 WHERE id=?1",
            params![
                source.id,
                name(destination),
                target.map(|f| &f.id).or(source.parent_id.as_ref())
            ],
        )?;
        if source.parent_id.is_none() {
            if target.is_some() {
                tx.execute("DELETE FROM connected_roots WHERE id=?1", [&source.root_id])?;
            } else {
                tx.execute(
                    "UPDATE connected_roots SET path=?2,available=1 WHERE id=?1",
                    params![source.root_id, string(destination)],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn relocate_connected_directory(&self, id: &str, path: &Path) -> AppResult<()> {
        let folder = self.connected_folder(id)?;
        if folder.parent_id.is_some() {
            return Err(invalid("请选择连接的根目录重新定位"));
        }
        let destination = directory(path)?;
        // Verify every known original before changing identity mappings.
        for f in self
            .connection_folders(None, None)?
            .into_iter()
            .filter(|f| f.root_id == id)
        {
            let ids = self.every_entry_id(Some(&f.id))?;
            for batch in ids.chunks(2000) {
                for entry in self
                    .resolve_connection_entries(batch)?
                    .into_iter()
                    .filter(|e| !e.is_reference)
                {
                    let target = destination.join(
                        Path::new(&entry.path)
                            .strip_prefix(&folder.path)
                            .map_err(|_| invalid("目录结构已变化"))?,
                    );
                    let expected: Option<String> = self
                        .conn
                        .lock()
                        .unwrap()
                        .query_row(
                            "SELECT fingerprint FROM external_assets WHERE asset_id=?1",
                            [&entry.asset_id],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let expected = expected
                        .or_else(|| external_files::fingerprint(Path::new(&entry.path)).ok())
                        .ok_or_else(|| invalid("原文件缺少校验信息，无法确认新位置"))?;
                    if external_files::fingerprint(&target)? != expected {
                        return Err(invalid("新位置与原文件内容不一致，未重新定位"));
                    }
                }
            }
        }
        self.repoint_tree(&folder, &destination, None)?;
        self.rewrite_references()
    }
    pub fn rename_connected_directory(&self, id: &str, value: &str) -> AppResult<()> {
        let folder = self.writable_connection(id)?;
        let destination = Path::new(&folder.path).with_file_name(valid_name(value)?);
        if destination == Path::new(&folder.path) {
            return Ok(());
        }
        move_path_with(Path::new(&folder.path), &destination, || {
            self.repoint_tree(&folder, &destination, None)
        })?;
        self.rewrite_references()
    }
    pub fn move_connected_directory(&self, id: &str, target: &str) -> AppResult<()> {
        let source = self.writable_connection(id)?;
        let target = self.writable_connection(target)?;
        if Path::new(&target.path).starts_with(&source.path) {
            return Err(invalid("集合不能移入自身或其下级目录"));
        }
        let destination = Path::new(&target.path).join(&source.name);
        if destination == Path::new(&source.path) {
            return Ok(());
        }
        move_path_with(Path::new(&source.path), &destination, || {
            self.repoint_tree(&source, &destination, Some(&target))
        })?;
        self.rewrite_references()
    }
    pub fn create_material_references(
        &self,
        paths: &LibraryPaths,
        asset_ids: &[String],
        folder_id: &str,
    ) -> AppResult<()> {
        let folder = self.writable_connection(folder_id)?;
        for asset_id in asset_ids.iter().collect::<HashSet<_>>() {
            let exists: bool = self.conn.lock().unwrap().query_row(
                "SELECT EXISTS(SELECT 1 FROM connected_entries WHERE folder_id=?1 AND asset_id=?2)",
                params![folder_id, asset_id],
                |r| r.get(0),
            )?;
            if exists {
                continue;
            }
            let asset = self
                .get_asset(asset_id)?
                .ok_or_else(|| invalid("素材已不存在"))?;
            let original = Path::new(
                asset
                    .store_path
                    .as_deref()
                    .ok_or_else(|| invalid("原文件不可用"))?,
            );
            let filename = format!("{}.bowerbird", name(original));
            let mut path = Path::new(&folder.path).join(&filename);
            for sequence in 1..10000 {
                if !path.exists() {
                    break;
                }
                path = Path::new(&folder.path)
                    .join(format!("{} ({sequence}).bowerbird", name(original)));
            }
            write_reference(&path, &asset, false)?;
        }
        self.scan_connection(paths, &folder.root_id)
    }
    pub fn move_connection_entries(&self, ids: &[String], target: &str) -> AppResult<()> {
        let folder = self.writable_connection(target)?;
        for entry in self.resolve_connection_entries(ids)? {
            self.writable_connection(&entry.folder_id)?;
            let destination = Path::new(&folder.path).join(&entry.name);
            if destination == Path::new(&entry.path) {
                continue;
            }
            move_path_with(Path::new(&entry.path), &destination, || {
                let conn = self.conn.lock().unwrap();
                let tx = conn.unchecked_transaction()?;
                if !entry.is_reference {
                    repoint_asset_in(&tx, &entry.asset_id, Path::new(&entry.path), &destination)?;
                }
                tx.execute(
                    "UPDATE connected_entries SET path=?2,folder_id=?3 WHERE id=?1",
                    params![entry.id, string(&destination), target],
                )?;
                tx.commit()?;
                Ok(())
            })?;
            self.connect_entry_projects(target, &entry.asset_id)?;
        }
        self.rewrite_references()
    }
    /// Asset-level naming in the shared detail dialog must also update physical entries.
    /// An unconnected external asset retains the older display-name-only behavior.
    pub fn rename_connected_asset_if_present(&self, asset_id: &str, stem: &str) -> AppResult<bool> {
        let entry:Option<(String,String)>=self.conn.lock().unwrap().query_row(
            "SELECT e.id,e.name FROM connected_entries e JOIN assets a ON a.id=e.asset_id WHERE e.asset_id=?1 AND e.is_reference=0 AND e.path=a.store_path LIMIT 1",
            [asset_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((id, old_name)) = entry else {
            return Ok(false);
        };
        let mut filename = valid_name(stem)?.to_owned();
        if let Some(ext) = Path::new(&old_name).extension() {
            filename.push('.');
            filename.push_str(&ext.to_string_lossy());
        }
        self.rename_connection_entry(&id, &filename)?;
        Ok(true)
    }
    pub fn has_connected_asset(&self, asset_id: &str) -> AppResult<bool> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM connected_entries WHERE asset_id=?1)",
            [asset_id],
            |r| r.get(0),
        )?)
    }
    pub fn rename_connection_entry(&self, id: &str, value: &str) -> AppResult<()> {
        let entry = self
            .resolve_connection_entries(&[id.to_owned()])?
            .pop()
            .ok_or_else(|| invalid("素材条目已不存在"))?;
        self.writable_connection(&entry.folder_id)?;
        let mut value = valid_name(value)?.to_owned();
        if entry.is_reference && !value.ends_with(".bowerbird") {
            value.push_str(".bowerbird");
        }
        if !entry.is_reference && Path::new(&value).extension().is_none() {
            if let Some(ext) = Path::new(&entry.name).extension() {
                value.push('.');
                value.push_str(&ext.to_string_lossy());
            }
        }
        let destination = Path::new(&entry.path).with_file_name(&value);
        if destination == Path::new(&entry.path) {
            return Ok(());
        }
        move_path_with(Path::new(&entry.path), &destination, || {
            let conn = self.conn.lock().unwrap();
            let tx = conn.unchecked_transaction()?;
            if !entry.is_reference {
                repoint_asset_in(&tx, &entry.asset_id, Path::new(&entry.path), &destination)?;
                tx.execute(
                    "UPDATE assets SET name=?2,name_manual=1 WHERE id=?1",
                    params![
                        entry.asset_id,
                        destination
                            .file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                    ],
                )?;
            }
            tx.execute(
                "UPDATE connected_entries SET path=?2,name=?3 WHERE id=?1",
                params![id, string(&destination), value],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        self.rewrite_references()
    }
    pub fn trash_connection_entries(&self, ids: &[String]) -> AppResult<()> {
        self.trash_entries_with(ids, recycle)
    }
    fn trash_entries_with(
        &self,
        ids: &[String],
        trash: impl Fn(&Path) -> AppResult<()>,
    ) -> AppResult<()> {
        for entry in self.resolve_connection_entries(ids)? {
            self.writable_connection(&entry.folder_id)?;
            trash(Path::new(&entry.path))?;
            self.conn
                .lock()
                .unwrap()
                .execute("DELETE FROM connected_entries WHERE id=?1", [entry.id])?;
        }
        Ok(())
    }
    pub fn trash_connected_directory(&self, id: &str) -> AppResult<()> {
        let folder = self.writable_connection(id)?;
        recycle(Path::new(&folder.path))?;
        if folder.parent_id.is_none() {
            self.disconnect_directory(id)
        } else {
            self.conn
                .lock()
                .unwrap()
                .execute("DELETE FROM connected_folders WHERE id=?1", [id])?;
            Ok(())
        }
    }
}

fn repoint_asset_in(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    old: &Path,
    new: &Path,
) -> AppResult<()> {
    let conflict: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM external_asset_paths WHERE path=?1 AND asset_id<>?2)",
        params![string(new), id],
        |r| r.get(0),
    )?;
    if conflict {
        return Err(invalid("目标路径仍关联另一份素材，请使用其他名称"));
    }
    for path in [old, new] {
        tx.execute(
            "INSERT OR IGNORE INTO external_asset_paths(asset_id,path) VALUES(?1,?2)",
            params![id, string(path)],
        )?;
    }
    tx.execute("UPDATE assets SET store_path=?2,origin_path=CASE WHEN origin_path=?3 THEN ?2 ELSE origin_path END,thumb_path=CASE WHEN thumb_path=?3 THEN ?2 ELSE thumb_path END WHERE id=?1",params![id,string(new),string(old)])?;
    Ok(())
}

/// Database paths switch only after the complete destination has been verified. Cross-volume
/// source cleanup follows that commit, so even an interrupted cleanup leaves a usable identity.
fn move_path_with(
    source: &Path,
    destination: &Path,
    commit: impl FnOnce() -> AppResult<()>,
) -> AppResult<()> {
    if fs::symlink_metadata(destination).is_ok() {
        return Err(invalid("目标位置已有同名文件，请使用其他名称"));
    }
    if fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Err(invalid("不移动文件系统链接，请选择原文件"));
    }
    match rename_no_replace(source, destination) {
        Ok(()) => {
            if let Err(error) = commit() {
                if rename_no_replace(destination, source).is_err() {
                    return Err(invalid(format!(
                        "文件已移至 {}，资料更新失败；请重新定位该目录。详情：{error}",
                        string(destination)
                    )));
                }
                return Err(error);
            }
            Ok(())
        }
        Err(error) if is_cross_volume(&error) => copy_move_with(source, destination, commit),
        Err(error) => Err(error.into()),
    }
}
fn is_cross_volume(error: &std::io::Error) -> bool {
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(17)
    }
    #[cfg(not(windows))]
    {
        error.raw_os_error() == Some(18)
    }
}
fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        unsafe extern "C" {
            fn renamex_np(
                from: *const std::ffi::c_char,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        let from = CString::new(source.as_os_str().as_bytes())?;
        let to = CString::new(destination.as_os_str().as_bytes())?;
        // RENAME_EXCL refuses overwrites even if another process creates the destination.
        if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 4) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        fs::rename(source, destination)
    }
}
fn copy_move_with(
    source: &Path,
    destination: &Path,
    commit: impl FnOnce() -> AppResult<()>,
) -> AppResult<()> {
    fn copy(
        source: &Path,
        destination: &Path,
        manifest: &mut Vec<(PathBuf, PathBuf, String)>,
    ) -> AppResult<()> {
        let metadata = fs::symlink_metadata(source)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid("跨盘移动暂不支持含符号链接的目录"));
        }
        if metadata.is_dir() {
            fs::create_dir(destination)?;
            for item in fs::read_dir(source)? {
                let item = item?;
                copy(&item.path(), &destination.join(item.file_name()), manifest)?;
            }
        } else {
            let hash = external_files::fingerprint(source)?;
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(destination)?;
            std::io::copy(&mut fs::File::open(source)?, &mut output)?;
            output.sync_all()?;
            if external_files::fingerprint(destination)? != hash
                || external_files::fingerprint(source)? != hash
            {
                return Err(invalid("移动校验失败，原文件已保留"));
            }
            manifest.push((source.into(), destination.into(), hash));
        }
        Ok(())
    }
    let mut manifest = Vec::new();
    if let Err(error) = copy(source, destination, &mut manifest) {
        return Err(invalid(format!(
            "移动未完成，原文件已保留，目标可能有未完成的副本：{}。{error}",
            string(destination)
        )));
    }
    for (path, _, hash) in &manifest {
        if external_files::fingerprint(path)? != *hash {
            return Err(invalid("原文件在移动中发生变化，已保留两处文件"));
        }
    }
    commit()?;
    let cleanup = (|| -> AppResult<()> {
        // Check again immediately before each deletion. Unknown/new files are never removed.
        for (path, destination, hash) in &manifest {
            if external_files::fingerprint(path)? != *hash {
                return Err(invalid("原文件在移动中发生变化"));
            }
            if external_files::fingerprint(destination)? != *hash {
                return Err(invalid("目标文件在移动中发生变化，原文件已保留"));
            }
            fs::remove_file(path)?;
        }
        fn empty_directories(path: &Path) -> AppResult<()> {
            for item in fs::read_dir(path)? {
                let item = item?;
                if item.file_type()?.is_dir() {
                    empty_directories(&item.path())?;
                }
            }
            fs::remove_dir(path)?;
            Ok(())
        }
        if source.is_dir() {
            empty_directories(source)?;
        }
        Ok(())
    })();
    cleanup.map_err(|error| {
        invalid(format!(
            "文件已移至 {}，旧位置部分文件未能清理，已保留供核对。{error}",
            string(destination)
        ))
    })
}

fn recycle(path: &Path) -> AppResult<()> {
    #[cfg(not(target_os = "windows"))]
    use std::process::Command;
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(invalid("文件已变为链接，请刷新后重试"));
    }
    let canonical = fs::canonicalize(path)?;
    if canonical != path {
        return Err(invalid("文件位置已变化，请刷新后重试"));
    }
    let path = canonical;
    #[cfg(target_os = "windows")]
    {
        return windows_recycle::recycle(&path);
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "tell application \"Finder\" to delete POSIX file (item 1 of argv)",
            "-e",
            "end run",
            "--",
        ])
        .arg(&path)
        .output()?
        .status;
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let status = Command::new("gio")
        .arg("trash")
        .arg("--")
        .arg(&path)
        .output()?
        .status;
    #[cfg(not(target_os = "windows"))]
    if !status.success() || path.exists() {
        return Err(invalid(
            "无法移到系统回收站，文件已保留；请检查权限或手动处理",
        ));
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows_recycle {
    use super::*;
    use windows::{
        core::{implement, HSTRING},
        Win32::{
            Foundation::E_ABORT,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::*,
        },
    };
    #[implement(IFileOperationProgressSink)]
    struct RecycleOnly;
    // Reject any fallback to permanent deletion, including non-recyclable volumes.
    #[allow(non_snake_case, unused_variables)]
    impl IFileOperationProgressSink_Impl for RecycleOnly_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, hrresult: windows::core::HRESULT) -> windows::core::Result<()> {
            hrresult.ok()
        }
        fn PreRenameItem(
            &self,
            dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            psznewname: &windows::core::PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostRenameItem(
            &self,
            dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            psznewname: &windows::core::PCWSTR,
            hrrename: windows::core::HRESULT,
            psinewlycreated: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreMoveItem(
            &self,
            dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &windows::core::PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostMoveItem(
            &self,
            dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &windows::core::PCWSTR,
            hrmove: windows::core::HRESULT,
            psinewlycreated: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreCopyItem(
            &self,
            dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &windows::core::PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostCopyItem(
            &self,
            dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &windows::core::PCWSTR,
            hrcopy: windows::core::HRESULT,
            psinewlycreated: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreDeleteItem(
            &self,
            dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            if dwflags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
                Err(E_ABORT.into())
            } else {
                Ok(())
            }
        }
        fn PostDeleteItem(
            &self,
            dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            hrdelete: windows::core::HRESULT,
            psinewlycreated: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            hrdelete.ok()
        }
        fn PreNewItem(
            &self,
            dwflags: u32,
            psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &windows::core::PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostNewItem(
            &self,
            dwflags: u32,
            psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &windows::core::PCWSTR,
            psztemplatename: &windows::core::PCWSTR,
            dwfileattributes: u32,
            hrnew: windows::core::HRESULT,
            psinewitem: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn UpdateProgress(&self, iworktotal: u32, iworksofar: u32) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn refuses_permanent_delete_before_shell_touches_any_file() {
        let sink: IFileOperationProgressSink = RecycleOnly.into();
        unsafe {
            assert!(sink.PreDeleteItem(0, None).is_err());
            assert!(sink
                .PreDeleteItem(TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32, None)
                .is_ok());
        }
    }
    pub(super) fn recycle(path: &Path) -> AppResult<()> {
        let path = path.to_owned();
        std::thread::spawn(move || -> AppResult<()> {
            let run = || -> windows::core::Result<()> {
                unsafe {
                    CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
                    struct Apartment;
                    impl Drop for Apartment {
                        fn drop(&mut self) {
                            unsafe {
                                CoUninitialize();
                            }
                        }
                    }
                    let _apartment = Apartment;
                    let operation: IFileOperation =
                        CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
                    operation.SetOperationFlags(
                        FOFX_RECYCLEONDELETE
                            | FOFX_EARLYFAILURE
                            | FOF_NOERRORUI
                            | FOF_SILENT
                            | FOF_NOCONFIRMATION
                            | FOF_WANTNUKEWARNING,
                    )?;
                    let raw = string(&path);
                    let shell_path = if let Some(v) = raw.strip_prefix(r"\\?\UNC\") {
                        format!(r"\\{v}")
                    } else {
                        raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned()
                    };
                    let item: IShellItem =
                        SHCreateItemFromParsingName(&HSTRING::from(shell_path), None)?;
                    let sink: IFileOperationProgressSink = RecycleOnly.into();
                    operation.DeleteItem(&item, &sink)?;
                    operation.PerformOperations()?;
                    if operation.GetAnyOperationsAborted()?.as_bool() {
                        return Err(E_ABORT.into());
                    }
                    Ok(())
                }
            };
            run().map_err(|e| {
                tracing::warn!("recycle failed: {e}");
                invalid("无法移到系统回收站，文件已保留；请检查权限或手动处理")
            })?;
            if path.exists() {
                return Err(invalid("文件未移到回收站，已保留原文件"));
            }
            Ok(())
        })
        .join()
        .map_err(|_| invalid("无法启动系统回收站操作，文件已保留"))?
    }
}

#[cfg(test)]
#[path = "folder_connections_tests.rs"]
mod tests;
