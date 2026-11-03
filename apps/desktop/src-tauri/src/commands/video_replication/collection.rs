//! Independent collection uses the existing Douyin acquisition, never model execution.
use super::*;
use crate::core::{ingest, library::Asset};
use futures_util::{Stream, StreamExt};
use std::{collections::HashMap, net::SocketAddr, sync::atomic::{AtomicBool, Ordering}, time::{Duration, Instant}};
use tauri::Url;
use tokio::io::AsyncWriteExt;

const MAX_BYTES: u64 = 200 * 1024 * 1024;
static RUNNING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SAVE_LOCK: Mutex<()> = Mutex::new(());
static CREATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn source(text: &str) -> AppResult<(&'static str, String)> {
    if let Ok(url) = douyin::share_url(text) { return Ok(("douyin", url.to_string())); }
    Ok(("direct", direct_url(text.trim())?.to_string()))
}

fn direct_url(raw: &str) -> AppResult<Url> {
    let mut url = Url::parse(raw).map_err(|_| error("请粘贴一个完整的视频文件链接"))?;
    let host = url.host_str().unwrap_or("");
    let port = if url.scheme() == "https" { 443 } else { 80 };
    if raw.len() > 8192 || raw.chars().any(char::is_whitespace) || !["https", "http"].contains(&url.scheme())
        || !url.username().is_empty() || url.password().is_some() || url.port_or_known_default() != Some(port)
        || host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local")
        || host.trim_matches(['[',']']).parse().is_ok_and(|ip| !douyin::media::public_ip(ip)) {
        return Err(error("请使用公网视频文件链接，不支持本机地址或带账号密码的链接"));
    }
    if ["m3u8", "mpd"].iter().any(|ext| url.path().to_ascii_lowercase().ends_with(&format!(".{ext}"))) {
        return Err(error("暂不支持直播或分段播放列表，请使用视频文件链接"));
    }
    url.set_fragment(None);
    Ok(url)
}

fn check_project(db: &Database, project: &str) -> AppResult<()> {
    if !project.is_empty() && db.get_project(project)?.is_none() { return Err(error("采集目标项目已不存在，请重新选择项目")); }
    Ok(())
}

fn records(root: &Path, project: &str) -> AppResult<Vec<Value>> {
    let mut items = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if let Some(id) = entry.file_name().to_str() {
            if let Ok(mut value) = own(root, id, project) {
                if value["kind"] == "direct" {
                    if ["starting", "downloading"].contains(&field(&value,"state")) && !RUNNING.lock().unwrap().contains_key(id) {
                        value["state"] = json!("interrupted");
                        value["message"] = json!("获取已中断，可重新获取");
                    }
                    items.push(value);
                }
            }
        }
    }
    Ok(items)
}

fn same_source<'a>(items: &'a [Value], url: &str) -> Option<&'a Value> {
    items.iter().find(|task| field(task,"sourceUrl") == url || field(task,"originalUrl") == url)
}

fn validate_video(path: &Path) -> AppResult<crate::media::probe::ProbeMeta> {
    let meta = crate::media::probe::probe(path)?;
    if meta.size == 0 || meta.size > MAX_BYTES || !crate::media::probe::is_video(&meta.ext)
        || meta.width == 0 || meta.height == 0 || !meta.duration.is_finite() || meta.duration <= 0.0 {
        return Err(error("未取得有效视频，请检查链接并重新获取"));
    }
    Ok(meta)
}

async fn copy_download<S: Stream<Item=AppResult<Vec<u8>>>>(
    chunks: S, target: &Path, total: Option<u64>, cancelled: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> AppResult<()> {
    if total.is_some_and(|size| size > MAX_BYTES) { return Err(error("视频超过 200 MiB，请选择较小的视频")); }
    let mut file = tokio::fs::File::create(target).await?;
    let mut size = 0u64;
    let mut last = Instant::now();
    futures_util::pin_mut!(chunks);
    progress(0, total);
    loop {
        if cancelled.load(Ordering::Acquire) { return Err(error("已取消视频获取")); }
        let chunk = tokio::select! {
            chunk = chunks.next() => chunk,
            _ = tokio::time::sleep(Duration::from_millis(100)) => continue,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk?;
        size += chunk.len() as u64;
        if size > MAX_BYTES { return Err(error("视频超过 200 MiB，请选择较小的视频")); }
        file.write_all(&chunk).await?;
        if last.elapsed() >= Duration::from_millis(400) { progress(size, total); last = Instant::now(); }
    }
    if cancelled.load(Ordering::Acquire) { return Err(error("已取消视频获取")); }
    if size == 0 || total.is_some_and(|expected| expected != size) { return Err(error("视频下载不完整，请重新获取")); }
    file.flush().await?;
    file.sync_all().await?;
    progress(size, total);
    Ok(())
}

async fn download(root: &Path, id: &str, raw: &str, cancelled: &AtomicBool) -> AppResult<(tempfile::TempDir, PathBuf, String)> {
    let mut url = direct_url(raw)?;
    for _ in 0..6 {
        let host = url.host_str().unwrap().trim_matches(['[',']']);
        let port = url.port_or_known_default().unwrap();
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await
            .map_err(|_| error("无法连接视频地址，请检查链接后重试"))?.collect();
        if addresses.is_empty() || addresses.iter().any(|a| !douyin::media::public_ip(a.ip())) {
            return Err(error("视频地址未指向公网服务，请使用其他链接"));
        }
        let client = reqwest::Client::builder().no_proxy().resolve_to_addrs(host,&addresses)
            .redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(120)).build()
            .map_err(|_| error("无法开始下载，请稍后重试"))?;
        let response = client.get(url.clone()).header("Accept-Encoding","identity").send().await
            .map_err(|_| error("视频下载未完成，请检查网络后重试"))?;
        if response.status().is_redirection() {
            let location = response.headers().get("location").and_then(|v| v.to_str().ok()).ok_or_else(|| error("视频跳转地址无效，请检查链接"))?;
            url = direct_url(url.join(location).map_err(|_| error("视频跳转地址无效，请检查链接"))?.as_str())?;
            continue;
        }
        if response.status() != reqwest::StatusCode::OK { return Err(error("网站未允许下载此视频，请检查链接或先下载到本机")); }
        let mime = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        if mime.contains("html") || mime.contains("json") || mime.contains("mpegurl") || mime.contains("dash+xml") {
            return Err(error("链接返回的不是视频文件，请使用直接下载地址"));
        }
        let ext = Path::new(url.path()).extension().and_then(|s| s.to_str()).filter(|ext| crate::media::probe::is_video(ext))
            .unwrap_or(if mime.contains("webm") { "webm" } else if mime.contains("matroska") { "mkv" } else { "mp4" });
        let temporary = tempfile::Builder::new().prefix("download-").tempdir_in(folder(root,id)?)?;
        let target = temporary.path().join(format!("video.{ext}"));
        let total = response.content_length();
        let chunks = response.bytes_stream().map(|chunk| chunk.map(|v| v.to_vec()).map_err(|_| error("视频下载中断，请重新获取")));
        copy_download(chunks, &target, total, cancelled, |bytes,total| {
            let _ = patch(root,id,json!({"downloadedBytes":bytes,"totalBytes":total}));
        }).await?;
        return Ok((temporary, target, url.to_string()));
    }
    Err(error("视频跳转次数过多，请使用直接下载地址"))
}

fn finish_download(root: &Path, task: &Value, file: &Path, effective: &str, cancelled: &AtomicBool) -> AppResult<()> {
    let meta = validate_video(file)?;
    let fingerprint = hash(file)?;
    let _lock = LOCK.lock().unwrap();
    if cancelled.load(Ordering::Acquire) { return Err(error("已取消视频获取")); }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let directory = folder(root,&id)?;
    fs::create_dir_all(&directory)?;
    let destination = directory.join(format!("source.{}",meta.ext));
    fs::rename(file,&destination)?;
    let name = Url::parse(field(task,"sourceUrl")).ok().and_then(|url| url.path_segments()?.next_back().map(str::to_owned))
        .filter(|name| !name.is_empty()).unwrap_or_else(|| format!("视频.{}",meta.ext));
    let reference = json!({"id":id,"kind":"reference","projectId":task["projectId"],"name":name,"duration":meta.duration,
        "path":destination,"hash":fingerprint,"sourceUrl":task["sourceUrl"],"effectiveUrl":effective,"createdAt":now()});
    save(root,&reference)?;
    let mut current = read(root,field(task,"id"))?;
    current["state"] = json!("ready"); current["message"] = json!("视频已获取"); current["reference"] = public(reference); current["finishedAt"] = json!(now());
    save(root,&current)
}

fn launch_direct(root: &Path, task: Value) -> AppResult<Value> {
    let id = field(&task,"id").to_owned();
    let mut running = RUNNING.lock().unwrap();
    if running.get(&id).is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(error("视频正在停止，请稍后重新获取"));
    }
    if running.contains_key(&id) || task["state"] == "ready" { return Ok(task); }
    if !running.is_empty() { return Err(error("已有视频正在获取，请完成或取消后再试")); }
    let cancelled = Arc::new(AtomicBool::new(false));
    let state = patch(root,&id,json!({"state":"downloading","message":"正在下载视频","downloadedBytes":0,"totalBytes":null}))?;
    running.insert(id.clone(),cancelled.clone());
    let root = root.to_owned();
    tauri::async_runtime::spawn(async move {
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(120), download(&root,&id,field(&task,"sourceUrl"),&cancelled)) => result,
            _ = async { while !cancelled.load(Ordering::Acquire) { tokio::time::sleep(Duration::from_millis(100)).await; } } => Ok(Err(error("已取消视频获取"))),
        };
        let result = match result {
            Ok(Ok((temporary,path,effective))) => {
                let root = root.clone(); let cancelled = cancelled.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _temporary = temporary;
                    finish_download(&root,&task,&path,&effective,&cancelled)
                }).await.unwrap_or_else(|_| Err(error("视频校验未完成，请重新获取")))
            },
            Ok(Err(e)) => Err(e), Err(_) => Err(error("视频下载超时，请检查网络后重新获取")),
        };
        if let Err(e) = result {
            let (state,message) = if cancelled.load(Ordering::Acquire) { ("cancelled","已取消视频获取".into()) } else { ("failed",e.to_string()) };
            let _ = patch(&root,&id,json!({"state":state,"message":message}));
        }
        RUNNING.lock().unwrap().remove(&id);
    });
    Ok(state)
}

fn save_asset(paths: &LibraryPaths, db: &Database, root: &Path, project: &str, id: &str) -> AppResult<Asset> {
    let _lock = SAVE_LOCK.lock().unwrap();
    check_project(db,project)?;
    let task = own(root,id,project)?;
    if task["state"] != "ready" { return Err(error("视频尚未获取完成，请稍候再保存")); }
    let (reference,file) = verified_reference(root,field(&task["reference"],"id"),project)?;
    validate_video(&file)?;
    let mut asset = match task["assetId"].as_str().map(|id| db.get_asset(id)).transpose()?.flatten() {
        Some(asset) if asset.store_path.as_deref().is_some_and(|p| Path::new(p).is_file()) => asset,
        _ => ingest::ingest_new_file(&paths.for_project(db,(!project.is_empty()).then_some(project))?,db,&file)?,
    };
    let source_url = field(&reference,"originalUrl");
    let source_url = if source_url.is_empty() { field(&task,"sourceUrl") } else { source_url };
    {
        let conn = db.conn.lock().unwrap();
        // A new import (or this task's interrupted initialization) retains its unique
        // reference path. Reused assets have another origin; never rewrite their metadata.
        if asset.origin_path.as_deref() == file.to_str() && asset.source.as_deref() == Some("imported") {
            conn.execute("UPDATE assets SET library_hidden=0,source='video-collection',source_url=?2,origin_path=NULL,name=?3 WHERE id=?1",
                rusqlite::params![asset.id,source_url,field(&reference,"name")])?;
        } else {
            conn.execute("UPDATE assets SET library_hidden=0 WHERE id=?1",[&asset.id])?;
        }
    }
    if !project.is_empty() { db.add_assets_to_project(project,std::slice::from_ref(&asset.id))?; }
    patch(root,id,json!({"assetId":asset.id}))?;
    asset = db.get_asset(&asset.id)?.ok_or_else(|| error("素材未能保存，请重试"))?;
    Ok(asset)
}

#[tauri::command]
pub async fn video_collection(app: tauri::AppHandle, paths: State<'_,Arc<LibraryPaths>>, db: State<'_,Arc<Database>>,
    project_id: Option<String>, action: String, data: Value) -> AppResult<Value> {
    let project = project_id.as_deref().unwrap_or("");
    let root = paths.root.join("video-collection");
    fs::create_dir_all(&root)?;
    if action != "list" { check_project(&db,project)?; }
    if action == "list" || action == "create" {
        let _create = if action == "create" { Some(CREATE_LOCK.lock().await) } else { None };
        let mut items = records(&root,project)?;
        items.extend(douyin::handle(&app,&root,project,"douyin-list",json!({})).await?.as_array().cloned().unwrap_or_default());
        items.sort_by(|a,b| field(b,"createdAt").cmp(field(a,"createdAt")));
        if action == "list" { return Ok(json!(items)); }
        let (kind,url) = source(field(&data,"text"))?;
        if let Some(existing) = same_source(&items,&url) { return Ok(existing.clone()); }
        if kind == "douyin" { return douyin::handle(&app,&root,project,"douyin-create",json!({"text":data["text"]})).await; }
        let task = json!({"id":uuid::Uuid::new_v4().simple().to_string(),"kind":"direct","projectId":project,"sourceUrl":url,
            "shareText":data["text"],"state":"starting","createdAt":now()});
        save(&root,&task)?;
        return launch_direct(&root,task);
    }
    let id = field(&data,"id");
    let task = own(&root,id,project)?;
    match action.as_str() {
        "save" => {
            let paths = paths.inner().clone(); let db = db.inner().clone(); let project = project.to_owned(); let id = id.to_owned();
            let asset = tauri::async_runtime::spawn_blocking(move || save_asset(&paths,&db,&root,&project,&id)).await
                .map_err(|_| error("视频未能保存，请重试"))??;
            if let Some(path) = &asset.store_path {
                app.asset_protocol_scope().allow_file(path).map_err(|e| AppError::Other(e.to_string()))?;
            }
            let _ = app.emit("library://assets-changed",());
            serde_json::to_value(asset).map_err(Into::into)
        }
        "cancel" if task["kind"] == "direct" => {
            let flag = RUNNING.lock().unwrap().get(id).cloned();
            let _lock = LOCK.lock().unwrap();
            let mut latest = own(&root,id,project)?;
            if latest["state"] == "ready" { return Ok(latest); }
            if let Some(flag) = flag { flag.store(true,Ordering::Release); }
            latest["state"] = json!("cancelled"); latest["message"] = json!("已取消视频获取");
            save(&root,&latest)?;
            Ok(latest)
        }
        "retry" if task["kind"] == "direct" => launch_direct(&root,task),
        "cancel" | "retry" | "login" if task["kind"] == "douyin" => douyin::handle(&app,&root,project,&format!("douyin-{action}"),data).await,
        _ => Err(error("不支持此采集操作，请重新打开采集窗口")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_accepts_single_public_direct_link_and_douyin_share() {
        assert_eq!(source("https://example.com/clip.mp4?token=abc#position").unwrap(),
            ("direct", "https://example.com/clip.mp4?token=abc".into()));
        assert_eq!(source("分享 https://v.douyin.com/abc123/ 复制打开").unwrap(),
            ("douyin", "https://v.douyin.com/abc123/".into()));
        assert!(source("http://example.com/video").is_ok());
    }

    #[test]
    fn collection_rejects_credentials_local_targets_and_playlists() {
        for input in ["file:///C:/clip.mp4", "https://u:p@example.com/video", "http://127.0.0.1/a.mp4",
            "http://[::1]/video", "https://10.1.2.3/video", "https://localhost/video", "https://example.com:8443/a",
            "https://example.com/a.m3u8", "https://example.com/a.mpd", "https://example.com/a https://example.com/b", ""] {
            assert!(source(input).is_err(), "{input}");
        }
    }

    #[tokio::test]
    async fn collection_stream_reports_actual_bytes_and_rejects_partial_failed_or_cancelled_downloads() {
        let dir = tempfile::tempdir().unwrap(); let file = dir.path().join("download.mp4");
        let cancel = AtomicBool::new(false); let mut observed = Vec::new();
        copy_download(futures_util::stream::iter(vec![Ok(vec![1,2]),Ok(vec![3])]),&file,None,&cancel,|bytes,total| observed.push((bytes,total))).await.unwrap();
        assert_eq!(fs::read(&file).unwrap(),vec![1,2,3]);
        assert_eq!(observed.last(),Some(&(3,None)));
        for chunks in [vec![Ok(vec![1,2])],vec![Err(error("网络中断"))]] {
            assert!(copy_download(futures_util::stream::iter(chunks),&file,Some(3),&cancel,|_,_|{}).await.is_err());
        }
        assert!(copy_download(futures_util::stream::empty(),&file,Some(MAX_BYTES+1),&cancel,|_,_|{}).await.is_err());
        cancel.store(true,Ordering::Release);
        assert!(copy_download(futures_util::stream::iter(vec![Ok(vec![1])]),&file,None,&cancel,|_,_|{}).await.is_err());
    }

    fn fixture(root: &Path, project: &str) -> Value {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let task = json!({"id":id,"kind":"direct","projectId":project,"state":"downloading","sourceUrl":"https://example.com/clip.mp4","createdAt":now()});
        save(root,&task).unwrap();
        let file = root.join("video.mp4");
        fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/fragmented.mp4"),&file).unwrap();
        finish_download(root,&task,&file,"https://cdn.example.com/clip.mp4",&AtomicBool::new(false)).unwrap();
        read(root,&id).unwrap()
    }

    #[test]
    fn collection_saves_once_retains_source_and_rejects_cross_project_delivery() {
        let dir = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::init(dir.path().to_owned()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.create_project("original","Original","","original","user").unwrap();
        db.create_project("other","Other","","other","user").unwrap();
        let task = fixture(dir.path(),"original"); let id = field(&task,"id");
        assert!(save_asset(&paths,&db,dir.path(),"other",id).is_err());
        let first = save_asset(&paths,&db,dir.path(),"original",id).unwrap();
        let again = save_asset(&paths,&db,dir.path(),"original",id).unwrap();
        assert_eq!(first.id,again.id);
        assert_eq!(again.source_url.as_deref(),Some("https://example.com/clip.mp4"));
        assert_eq!(again.source.as_deref(),Some("video-collection"));
        assert_eq!(again.origin_path,None);
        assert_eq!(db.count_assets(None).unwrap(),1);
        let duplicate = fixture(dir.path(),"");
        assert_eq!(save_asset(&paths,&db,dir.path(),"",field(&duplicate,"id")).unwrap().id,first.id);
        let records = records(dir.path(),"original").unwrap();
        assert_eq!(same_source(&records,"https://example.com/clip.mp4").unwrap()["id"],task["id"]);
        assert!(same_source(&records,"https://example.com/other.mp4").is_none());
        let owner_count: i64 = db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='other'",[],|row| row.get(0)).unwrap();
        assert_eq!(owner_count,0);
    }

    #[test]
    fn collection_invalid_content_and_cancelled_completion_never_become_ready() {
        let dir = tempfile::tempdir().unwrap();
        let task = json!({"id":uuid::Uuid::new_v4().simple().to_string(),"kind":"direct","projectId":"","state":"downloading","sourceUrl":"https://example.com/a.mp4"});
        save(dir.path(),&task).unwrap();
        let file = dir.path().join("bad.png"); fs::write(&file,b"<html>login</html>").unwrap();
        assert!(finish_download(dir.path(),&task,&file,"https://example.com/a.mp4",&AtomicBool::new(false)).is_err());
        let file = dir.path().join("video.mp4");
        fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/fragmented.mp4"),&file).unwrap();
        assert!(finish_download(dir.path(),&task,&file,"https://example.com/a.mp4",&AtomicBool::new(true)).is_err());
        assert_eq!(read(dir.path(),field(&task,"id")).unwrap()["state"],"downloading");
        assert!(file.exists());
    }

    #[test]
    fn collection_reuse_preserves_existing_names_and_provenance() {
        for (name,source_tag) in [("source","imported"),("source.mp4","jimeng")] {
            let dir = tempfile::tempdir().unwrap();
            let paths = LibraryPaths::init(dir.path().to_owned()).unwrap();
            let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
            let local = dir.path().join("existing.mp4");
            fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/media/fragmented.mp4"),&local).unwrap();
            let existing = ingest::ingest_generated(&paths,&db,&local,None,source_tag).unwrap();
            db.conn.lock().unwrap().execute("UPDATE assets SET name=?2 WHERE id=?1",rusqlite::params![existing.id,name]).unwrap();
            let external = ingest::ingest_file(&paths,&db,&local).unwrap();
            db.conn.lock().unwrap().execute("UPDATE assets SET name='source.mp4' WHERE id=?1",[&external.id]).unwrap();
            let task = fixture(dir.path(),"");
            let result = save_asset(&paths,&db,dir.path(),"",field(&task,"id")).unwrap();
            assert_eq!(result.id,existing.id);
            assert_eq!(result.name,name);
            assert_eq!(result.source.as_deref(),Some(source_tag));
            assert_eq!(result.source_url,None);
            let external = db.get_asset(&external.id).unwrap().unwrap();
            assert_eq!(external.name,"source.mp4");
            assert_eq!(external.source.as_deref(),Some("external"));
            assert_eq!(external.source_url,None);
            assert_eq!(read(dir.path(),field(&task,"id")).unwrap()["sourceUrl"],"https://example.com/clip.mp4");
        }
    }
}
