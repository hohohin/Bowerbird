//! Local voice profiles and durable synthesis requests. No cloud inference.
use std::{fs, io::Write, path::{Path, PathBuf}, process::Stdio,
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::{Deserialize, Serialize};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::{cloud::{AuthClient, EntitlementService}, core::{ingest, library::Asset, paths::LibraryPaths},
    db::Database, error::{AppError, AppResult}, media};

static ACTIVE: Mutex<Option<(String, Arc<AtomicBool>)>> = Mutex::new(None);
static FILES: Mutex<()> = Mutex::new(());
fn error(text: &str) -> AppError { AppError::Other(text.into()) }
pub(super) fn root(paths: &LibraryPaths) -> PathBuf { paths.root.join("voice-studio") }
fn valid_id(id: &str) -> AppResult<()> {
    ulid::Ulid::from_string(id).map_err(|_| error("记录标识无效，请重新打开声音面板"))?; Ok(())
}
pub(super) fn read<T: serde::de::DeserializeOwned>(path: &Path) -> AppResult<T> { Ok(serde_json::from_slice(&fs::read(path)?)?) }
pub(super) fn write(path: &Path, value: &impl Serialize) -> AppResult<()> {
    fs::create_dir_all(path.parent().unwrap())?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| AppError::Io(e.error))?; Ok(())
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Config { pub python: String, pub model: String }
#[derive(Clone, Serialize, Deserialize)]
pub struct Voice { pub id: String, pub name: String, pub asset_id: String, pub reference: String, pub transcript: String,
    #[serde(default)] pub duration: Option<f64> }
#[derive(Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: String, pub project: String, pub text: String, pub description: String,
    pub voice_id: Option<String>, pub reference: Option<String>, pub transcript: Option<String>,
    pub config: Config, pub status: String, pub message: String, pub asset_id: Option<String>,
    #[serde(default)] pub purpose: String, #[serde(default)] pub draft_key: String,
    #[serde(default)] pub voice_name: String, #[serde(default)] pub recoverable: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview { asset_id: Option<String>, start: Option<f64>, end: Option<f64>, transcript: Option<String>, draft_key: String }
#[derive(Serialize)]
pub struct Snapshot { config: Config, voices: Vec<Voice>, jobs: Vec<Job>, assets: Vec<Asset> }
fn records<T: serde::de::DeserializeOwned>(dir: &Path) -> AppResult<Vec<T>> {
    if !dir.exists() { return Ok(vec![]); }
    let mut values = vec![];
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "json") { values.push(read(&path)?); }
    }
    Ok(values)
}
fn job_path(base: &Path, id: &str) -> PathBuf { base.join("jobs").join(format!("{id}.json")) }
pub(super) async fn access(auth: &AuthClient, entitlement: &EntitlementService) -> AppResult<()> {
    let snapshot = entitlement.current_or_sync(auth).await;
    let login = auth.snapshot();
    if !login.logged_in || snapshot.user_id.is_empty() || login.user_id.as_deref() != Some(snapshot.user_id.as_str())
        || !(snapshot.is_test_account || snapshot.policy.can_use_byo)
        || !matches!(snapshot.offline_state, Some(crate::cloud::entitlement::OfflineState::Fresh | crate::cloud::entitlement::OfflineState::Grace)) {
        return Err(error("本机声音生成需要有效的 Pro／Studio 权益，请在设置中查看账号"));
    }
    Ok(())
}
pub(super) fn validate_config(config: &Config) -> AppResult<()> {
    if !Path::new(&config.python).is_absolute() || !Path::new(&config.python).is_file() {
        return Err(error("请选择已安装 VoxCPM 的 Python 程序"));
    }
    let model = Path::new(&config.model);
    if !model.is_absolute() || !model.join("model.safetensors").is_file() || !model.join("audiovae.pth").is_file() {
        return Err(error("请选择已完整下载的 VoxCPM2 模型目录"));
    }
    let config: serde_json::Value = read(&model.join("config.json"))?;
    if config["architecture"] != "voxcpm2" { return Err(error("请选择 VoxCPM2 模型，不支持旧版模型")); }
    Ok(())
}
#[tauri::command]
pub async fn voice_configure(paths: State<'_, Arc<LibraryPaths>>, config: Config) -> AppResult<()> {
    validate_config(&config)?;
    let _lock = FILES.lock().unwrap();
    write(&root(&paths).join("config.json"), &config)
}
#[tauri::command]
pub async fn voice_snapshot(app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, project: String) -> AppResult<Snapshot> {
    let _lock = FILES.lock().unwrap();
    let base = root(&paths);
    let config = if base.join("config.json").exists() { read(&base.join("config.json"))? } else { Config::default() };
    let voices: Vec<Voice> = records(&base.join("voices"))?;
    let mut jobs: Vec<Job> = records(&base.join("jobs"))?;
    let active = ACTIVE.lock().unwrap();
    for job in &mut jobs {
        if job.status == "running" && !active.as_ref().is_some_and(|(id, _)| id == &job.id) {
            job.status = "interrupted".into();
            job.message = "上次生成已中断；如文件已完成，可以取回结果，否则请重新生成".into();
            write(&job_path(&base, &job.id), job)?;
        }
    }
    jobs.retain(|job| job.project == project);
    jobs.sort_by(|a,b| b.id.cmp(&a.id));
    let mut ids: Vec<_> = voices.iter().map(|voice| voice.asset_id.clone()).chain(jobs.iter().filter_map(|job| job.asset_id.clone())).collect();
    ids.sort(); ids.dedup();
    let assets = db.get_assets_by_ids(&ids)?;
    for asset in &assets { if let Some(path) = &asset.store_path { let _ = app.asset_protocol_scope().allow_file(path); } }
    for voice in &voices { let _ = app.asset_protocol_scope().allow_file(&voice.reference); }
    for job in &mut jobs { job.recoverable = !matches!(job.status.as_str(), "running" | "cancelled" | "succeeded") && base.join("runs").join(&job.id).join("output.wav").is_file(); }
    Ok(Snapshot { config, voices, jobs, assets })
}
#[tauri::command]
pub async fn voice_save(db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, name: String, asset_id: String, transcript: String, start: Option<f64>, end: Option<f64>) -> AppResult<Voice> {
    if name.trim().is_empty() { return Err(error("请填写角色名称")); }
    let db = db.inner().clone(); let paths = paths.inner().clone();
    tokio::task::spawn_blocking(move || {
        let id = ulid::Ulid::new().to_string(); let base = root(&paths);
        let destination = base.join("references").join(format!("{id}.wav"));
        let duration = prepare_reference(&db, &asset_id, &destination, start, end)?;
        let voice = Voice { id: id.clone(), name: name.trim().into(), asset_id,
            reference: destination.to_string_lossy().into_owned(), transcript: transcript.trim().into(), duration: Some(duration) };
        let _lock = FILES.lock().unwrap();
        if let Err(e) = write(&base.join("voices").join(format!("{id}.json")), &voice) { let _ = fs::remove_file(destination); return Err(e); }
        Ok(voice)
    }).await.map_err(|e| AppError::Other(e.to_string()))?
}
fn clip_range(duration: f64, start: Option<f64>, end: Option<f64>) -> AppResult<(f64, f64)> {
    let start = start.unwrap_or(0.0); let end = end.unwrap_or(duration);
    if !start.is_finite() || !end.is_finite() || start < 0.0 || end > duration + 0.01 || end - start < 0.999 || end - start > 30.001 {
        return Err(error("请在录音内选择 1–30 秒的片段"));
    }
    Ok((start, end.min(duration)))
}
fn prepare_reference(db: &Database, asset_id: &str, destination: &Path, start: Option<f64>, end: Option<f64>) -> AppResult<f64> {
    let asset = db.get_asset(asset_id)?.ok_or_else(|| error("参考录音不存在，请重新导入"))?;
    if !matches!(asset.ext.as_deref(), Some("wav" | "mp3" | "flac" | "m4a" | "ogg")) { return Err(error("请选择支持的音频文件作为参考录音")); }
    let source = Path::new(asset.store_path.as_deref().ok_or_else(|| error("请重新导入参考录音"))?);
    let duration = media::audio::decode(source)?.duration;
    let (start, end) = clip_range(duration, start, end)?;
    fs::create_dir_all(destination.parent().unwrap())?;
    let temporary = destination.with_extension("partial.wav");
    let status = media::tools::command(media::tools::resolve(media::tools::Tool::Ffmpeg)?)
        .args(["-nostdin", "-y", "-v", "error"]).arg("-i").arg(source)
        .args(["-ss", &start.to_string(), "-t", &(end-start).to_string(), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le"])
        .arg(&temporary).output()?;
    if !status.status.success() { let _ = fs::remove_file(&temporary); return Err(error("录音片段读取失败，请换一段录音重试")); }
    let result = media::audio::decode(&temporary)?.duration;
    fs::rename(temporary, destination)?; Ok(result)
}
#[tauri::command]
pub async fn voice_manage(paths: State<'_, Arc<LibraryPaths>>, id: String, name: Option<String>) -> AppResult<()> {
    valid_id(&id)?; let _lock = FILES.lock().unwrap();
    let path = root(&paths).join("voices").join(format!("{id}.json"));
    if let Some(name) = name {
        if name.trim().is_empty() { return Err(error("请填写声音名称")); }
        let mut voice: Voice = read(&path)?; voice.name = name.trim().into(); write(&path, &voice)
    } else { if path.exists() { fs::remove_file(path)?; } Ok(()) } // Keep reference for already frozen jobs.
}
#[tauri::command]
pub async fn voice_export(app: AppHandle, db: State<'_, Arc<Database>>, asset_id: String) -> AppResult<()> {
    use tauri_plugin_dialog::DialogExt;
    let asset = db.get_asset(&asset_id)?.ok_or_else(|| error("音频已移除，请重新生成"))?;
    if asset.ext.as_deref() != Some("wav") { return Err(error("请选择已生成的声音")); }
    tokio::task::spawn_blocking(move || {
        if let Some(path) = app.dialog().file().add_filter("WAV 音频", &["wav"]).set_file_name("配音.wav").blocking_save_file() {
            let path = path.into_path().map_err(|e| error(&e.to_string()))?;
            let source = PathBuf::from(asset.store_path.ok_or_else(|| error("音频原文件不可用"))?);
            if path != source { fs::copy(source, path)?; }
        } Ok(())
    }).await.map_err(|e| error(&e.to_string()))?
}
fn publish(db: &Database, paths: &LibraryPaths, job: &mut Job) -> AppResult<Asset> {
    // Recover a committed import even if the process stopped before writing its JSON receipt.
    let key = format!("voice:{}", job.id);
    let previous: Option<String> = db.conn.lock().unwrap().query_row("SELECT asset_id FROM analyses WHERE id=?1", [&key], |r| r.get(0)).optional()?;
    if let Some(id) = previous {
        let asset = db.get_asset(&id)?.ok_or_else(|| error("已生成素材被移除，请重新生成"))?;
        if !asset.store_path.as_deref().is_some_and(|p| Path::new(p).is_file()) { return Err(error("已生成的音频文件被移除，请重新生成")); }
        job.asset_id = Some(id); return Ok(asset);
    }
    if db.get_project(&job.project)?.is_none() { return Err(error("原项目已不存在，生成文件仍保留，请恢复项目后取回")); }
    let output = root(paths).join("runs").join(&job.id).join("output.wav");
    if !output.is_file() { return Err(error("没有完整的生成文件，请重新生成")); }
    let audio = media::audio::decode(&output)?;
    let destination = paths.for_project(db, Some(&job.project))?;
    // ingest_generated records origin_path with its asset insert. Recover that insert
    // if the process exited before the following metadata transaction committed.
    let pending: Option<String> = db.conn.lock().unwrap().query_row(
        "SELECT id FROM assets WHERE source='voxcpm' AND origin_path=?1 LIMIT 1",
        [output.to_string_lossy().as_ref()], |r| r.get(0)).optional()?;
    let asset = match pending {
        Some(id) => db.get_asset(&id)?.ok_or_else(|| error("生成文件暂不可读，请重试取回"))?,
        None => ingest::ingest_generated(&destination, db, &output, None, "voxcpm")?,
    };
    let saved = (|| -> AppResult<()> {
        let mut conn = db.conn.lock().unwrap(); let tx = conn.transaction()?;
        tx.execute("UPDATE assets SET name=?1,origin_path=NULL,duration=?2 WHERE id=?3", params![job.text.chars().take(24).collect::<String>(),audio.duration,asset.id])?;
        tx.execute("INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) VALUES(?1,?2,strftime('%s','now'))", params![job.project,asset.id])?;
        tx.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,'voice_generation',?3,strftime('%s','now'))", params![key,asset.id,serde_json::to_string(job)?])?;
        tx.commit()?; Ok(())
    })();
    if let Err(e) = saved { let _ = db.delete_asset(&asset.id); return Err(e); }
    job.asset_id = Some(asset.id.clone());
    db.get_asset(&asset.id)?.ok_or_else(|| error("生成结果暂不可读，请取回结果"))
}
fn validate_clone_request(description: &str, voice_id: Option<&str>, preview: Option<&Preview>) -> AppResult<()> {
    let has_source = match preview {
        Some(p) => p.asset_id.as_deref().is_some_and(|id| !id.trim().is_empty()),
        None => voice_id.is_some_and(|id| !id.trim().is_empty()),
    };
    if !description.trim().is_empty() || !has_source { return Err(error("当前仅支持声音克隆，请选择参考录音或已保存的声音")); }
    Ok(())
}
fn run(base: &Path, job: &Job, cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) { return Err(error("生成已取消，可以重新生成")); }
    if !job.reference.as_deref().is_some_and(|p| Path::new(p).is_file()) { return Err(error("请先选择有效的参考录音，再生成克隆配音")); }
    let dir = base.join("runs").join(&job.id); fs::create_dir_all(&dir)?;
    write(&dir.join("request.json"), job)?;
    fs::write(dir.join("runner.py"), include_str!("voice_runner.py"))?;
    let mut command = std::process::Command::new(&job.config.python);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.arg(dir.join("runner.py")).arg(dir.join("request.json")).arg("--watch-parent")
        .env("PYTHONUTF8", "1").env("HF_HUB_OFFLINE", "1").env("NUMBA_CACHE_DIR", base.join("numba-cache"))
        .env("BOWERBIRD_VOICE_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(fs::File::create(dir.join("diagnostic.log"))?).spawn()
        .map_err(|_| error("无法启动本机声音环境，请检查 Python 程序与依赖安装"))?;
    loop {
        if cancel.load(Ordering::SeqCst) { let _ = child.kill(); let _ = child.wait(); return Err(error("生成已取消，可以重新生成")); }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(error("声音生成失败，请检查 VoxCPM2 环境、显存和参考录音；诊断已保留")),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e.into()); }
        }
    }
}
#[tauri::command]
pub async fn voice_start(app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, project: String, text: String, description: Option<String>, voice_id: Option<String>, preview: Option<Preview>) -> AppResult<String> {
    validate_clone_request(description.as_deref().unwrap_or_default(), voice_id.as_deref(), preview.as_ref())?;
    access(&auth, &entitlement).await?;
    if text.trim().is_empty() { return Err(error("请填写要生成的台词")); }
    if db.get_project(&project)?.is_none() { return Err(error("项目已不存在，请重新打开项目")); }
    let _lock = FILES.lock().unwrap(); let mut active = ACTIVE.lock().unwrap();
    if active.is_some() { return Err(error("已有声音正在生成，请等待完成或取消后再试")); }
    let base = root(&paths);
    let config: Config = read(&base.join("config.json")).map_err(|_| error("请先配置本机声音环境"))?; validate_config(&config)?;
    let voice: Option<Voice> = match &voice_id { Some(id) => { valid_id(id)?; Some(read(&base.join("voices").join(format!("{id}.json")))?) }, None => None };
    if voice.as_ref().is_some_and(|v| !Path::new(&v.reference).is_file()) { return Err(error("角色参考录音缺失，请重新导入并保存角色")); }
    let mut job = Job { id: ulid::Ulid::new().to_string(), project, text, description: String::new(), voice_id,
        reference: voice.as_ref().map(|v| v.reference.clone()), transcript: voice.as_ref().map(|v| v.transcript.clone()),
        voice_name: voice.as_ref().map(|v| v.name.clone()).unwrap_or_else(|| "录音克隆试听".into()), recoverable: false,
        purpose: if preview.is_some() { "preview" } else { "speech" }.into(), draft_key: preview.as_ref().map(|p| p.draft_key.clone()).unwrap_or_default(),
        config, status: "running".into(), message: "正在生成，可以关闭面板，稍后查看结果".into(), asset_id: None };
    write(&job_path(&base, &job.id), &job)?;
    let id = job.id.clone(); let cancel = Arc::new(AtomicBool::new(false)); *active = Some((id.clone(), cancel.clone()));
    let db = db.inner().clone(); let paths = paths.inner().clone();
    tokio::task::spawn_blocking(move || {
        let result = (|| -> AppResult<()> {
            if let Some(p) = preview { if let Some(asset) = p.asset_id {
                let reference = base.join("runs").join(&job.id).join("reference.wav");
                prepare_reference(&db, &asset, &reference, p.start, p.end)?;
                job.reference = Some(reference.to_string_lossy().into()); job.transcript = p.transcript;
            } }
            if cancel.load(Ordering::SeqCst) { return Err(error("生成已取消")); }
            run(&base, &job, &cancel)
        })();
        let _lock = FILES.lock().unwrap();
        let result = if cancel.load(Ordering::SeqCst) { Err(error("生成已取消，可以重新生成")) } else { result.and_then(|_| publish(&db, &paths, &mut job)) };
        match result {
            Ok(asset) => { job.status = "succeeded".into(); job.message = "已保存到项目素材库".into();
                if let Some(path) = asset.store_path { let _ = app.asset_protocol_scope().allow_file(path); }
                let _ = app.emit("library://assets-changed", ()); },
            Err(e) => { job.status = if cancel.load(Ordering::SeqCst) { "cancelled" } else { "failed" }.into(); job.message = e.to_string(); }
        }
        if let Err(e) = write(&job_path(&base, &job.id), &job) { tracing::error!("voice receipt failed: {e}"); }
        *ACTIVE.lock().unwrap() = None;
    });
    Ok(id)
}
#[tauri::command]
pub async fn voice_cancel(id: String) -> AppResult<()> {
    let active = ACTIVE.lock().unwrap();
    if let Some((current, cancel)) = active.as_ref() { if current == &id { cancel.store(true, Ordering::SeqCst); } }
    Ok(())
}
#[tauri::command]
pub async fn voice_recover(app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, id: String) -> AppResult<()> {
    valid_id(&id)?; let _lock = FILES.lock().unwrap(); let base = root(&paths);
    if ACTIVE.lock().unwrap().as_ref().is_some_and(|(current,_)| current == &id) { return Err(error("任务仍在运行，请稍后查看")); }
    let mut job: Job = read(&job_path(&base, &id))?;
    if job.status == "cancelled" { return Err(error("任务已取消，请重新生成")); }
    let asset = publish(&db, &paths, &mut job)?;
    job.status = "succeeded".into(); job.message = "已保存到项目素材库".into(); write(&job_path(&base,&id), &job)?;
    if let Some(path) = asset.store_path { let _ = app.asset_protocol_scope().allow_file(path); }
    let _ = app.emit("library://assets-changed", ()); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_reference_based_generation_is_accepted() {
        assert!(validate_clone_request("", Some("voice"), None).is_ok());
        assert!(validate_clone_request("", None, None).is_err());
        assert!(validate_clone_request("温暖女声", Some("voice"), None).is_err());
        let mut preview = Preview { asset_id: Some("recording".into()), start: Some(0.0), end: Some(3.0), transcript: None, draft_key: "clip".into() };
        assert!(validate_clone_request("", None, Some(&preview)).is_ok());
        preview.asset_id = None;
        assert!(validate_clone_request("", None, Some(&preview)).is_err());
        let dir=tempfile::tempdir().unwrap();
        assert!(run(dir.path(), &job(), &AtomicBool::new(false)).unwrap_err().to_string().contains("参考录音"));
        assert!(!dir.path().join("runs").exists());
    }
    fn job() -> Job { Job { id: ulid::Ulid::new().to_string(), project: "p".into(), text: "测试声音".into(),
        description: String::new(), voice_id: None, reference: None, transcript: None, config: Config::default(),
        status: "running".into(), message: String::new(), asset_id: None,
        purpose: String::new(), draft_key: String::new(), voice_name: String::new(), recoverable: false } }
    fn wav(path: &Path) {
        let mut data = Vec::new(); let bytes = 16000u32 * 2;
        data.extend(b"RIFF"); data.extend((36 + bytes).to_le_bytes()); data.extend(b"WAVEfmt ");
        data.extend(16u32.to_le_bytes()); data.extend(1u16.to_le_bytes()); data.extend(1u16.to_le_bytes());
        data.extend(16000u32.to_le_bytes()); data.extend(32000u32.to_le_bytes()); data.extend(2u16.to_le_bytes()); data.extend(16u16.to_le_bytes());
        data.extend(b"data"); data.extend(bytes.to_le_bytes());
        for i in 0..16000 { data.extend((((i as f32 * 0.17).sin() * 6000.0) as i16).to_le_bytes()); }
        fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(path, data).unwrap();
    }
    #[test]
    fn durable_publish_is_idempotent_and_rolls_back_failed_import() {
        let dir = tempfile::tempdir().unwrap(); let paths = LibraryPaths::init(dir.path().into()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.create_project("p", "voice", "blank:p", "blank:p", "blank").unwrap();
        let mut first = job(); let path = root(&paths).join("runs").join(&first.id).join("output.wav"); wav(&path);
        let pending = ingest::ingest_generated(&paths, &db, &path, None, "voxcpm").unwrap();
        let asset = publish(&db, &paths, &mut first).unwrap();
        assert_eq!(asset.id, pending.id, "recover asset insert before metadata commit");
        first.asset_id = None; // Simulate crash after DB commit, before writing JSON receipt.
        assert_eq!(publish(&db, &paths, &mut first).unwrap().id, asset.id);
        assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p'", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        let mut second = job(); wav(&root(&paths).join("runs").join(&second.id).join("output.wav"));
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_voice BEFORE INSERT ON analyses WHEN NEW.kind='voice_generation' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(publish(&db, &paths, &mut second).is_err());
        assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        second.project = "missing".into(); assert!(publish(&db, &paths, &mut second).is_err());
        assert!(publish(&db, &paths, &mut job()).is_err());
    }
    #[test]
    fn records_replace_atomically_and_reject_path_ids() {
        let dir = tempfile::tempdir().unwrap(); let file = dir.path().join("record.json");
        write(&file, &Config { python: "first".into(), model: "模型".into() }).unwrap();
        write(&file, &Config { python: "second".into(), model: "模型".into() }).unwrap();
        assert_eq!(read::<Config>(&file).unwrap().python, "second");
        assert!(valid_id("../../config").is_err()); assert!(valid_id(&ulid::Ulid::new().to_string()).is_ok());
        assert!(validate_config(&Config::default()).is_err());
    }
    #[test]
    fn reference_clip_is_copied_as_independent_pcm_and_bounds_are_checked() {
        assert!(clip_range(40.0, Some(2.0), Some(12.0)).is_ok());
        for (start,end) in [(f64::NAN,2.0),(-1.0,2.0),(1.0,1.5),(0.0,31.0),(39.0,41.0)] { assert!(clip_range(40.0,Some(start),Some(end)).is_err()); }
        let dir=tempfile::tempdir().unwrap(); let paths=LibraryPaths::init(dir.path().into()).unwrap();
        let db=Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let source=dir.path().join("source.wav"); wav(&source);
        let asset=ingest::ingest_generated(&paths,&db,&source,None,"test").unwrap();
        let reference=dir.path().join("reference.wav");
        let duration=prepare_reference(&db,&asset.id,&reference,Some(0.0),Some(1.0)).unwrap();
        assert!((duration-1.0).abs()<0.01); assert!(source.is_file());
        let decoded=media::audio::decode(&reference).unwrap(); assert!((decoded.duration-1.0).abs()<0.01);
        assert!(prepare_reference(&db,&asset.id,&dir.path().join("bad.wav"),Some(0.5),Some(1.0)).is_err());
    }
    #[test]
    #[ignore = "requires explicit VOICE_TEST_PYTHON and VOICE_TEST_MODEL, local GPU only"]
    fn real_runner_generates_and_publishes_in_temporary_library() {
        let dir = tempfile::tempdir().unwrap(); let paths = LibraryPaths::init(dir.path().into()).unwrap();
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.create_project("p", "voice", "blank:p", "blank:p", "blank").unwrap();
        let mut request = job(); request.text = "欢迎回来，我们可以开始今天的创作了。".into();
        request.config = Config { python: std::env::var("VOICE_TEST_PYTHON").unwrap(), model: std::env::var("VOICE_TEST_MODEL").unwrap() };
        request.reference = std::env::var("VOICE_TEST_REFERENCE").ok();
        validate_config(&request.config).unwrap();
        if let Err(error) = run(&root(&paths), &request, &AtomicBool::new(false)) {
            let log = fs::read_to_string(root(&paths).join("runs").join(&request.id).join("diagnostic.log")).unwrap_or_default();
            panic!("{error}\n{log}");
        }
        let asset = publish(&db, &paths, &mut request).unwrap();
        assert!(Path::new(asset.store_path.as_deref().unwrap()).is_file()); assert!(asset.duration.unwrap() > 0.0);
        let cancel = AtomicBool::new(true); let mut cancelled = job(); cancelled.config = request.config;
        assert!(run(&root(&paths), &cancelled, &cancel).unwrap_err().to_string().contains("取消"));
    }
}
