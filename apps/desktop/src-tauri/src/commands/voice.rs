//! Local voice profiles and durable synthesis requests. No cloud inference.
use std::{collections::HashMap, fs, io::Write, path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, MutexGuard, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::{Deserialize, Serialize};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager, State};
use crate::{cloud::{AuthClient, EntitlementService}, core::{ingest, library::Asset, paths::LibraryPaths},
    db::Database, error::{AppError, AppResult}, media};

mod store;
mod worker;

use store::{Jobs, run_dir};
use worker::Stage;

struct Active {
    id: String,
    cancel: Arc<AtomicBool>,
    publishing: bool,
}

struct ActiveJob(String);

impl Drop for ActiveJob {
    fn drop(&mut self) {
        let mut active = lock(&ACTIVE);
        if active.as_ref().is_some_and(|job| job.id == self.0) { active.take(); }
    }
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static FILES: LazyLock<Mutex<HashMap<PathBuf, Jobs>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
// Publication commits the existing ingest and metadata transactions as one recoverable operation.
static PUBLISH: Mutex<()> = Mutex::new(());

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> { mutex.lock().unwrap_or_else(|poison| poison.into_inner()) }
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
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(default)] pub request_key: Option<String>,
    #[serde(default)] pub voice_name: String, #[serde(default)] pub recoverable: bool,
    #[serde(default)] pub stage: Option<String>,
    #[serde(default)] pub progress: Option<u8>,
    #[serde(default)] pub error_code: Option<String>,
    #[serde(default)] pub warning: Option<String>,
    #[serde(default)] pub has_diagnostic: bool,
    #[serde(default)] pub seed: Option<u32>,
    #[serde(default)] pub language: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview { asset_id: Option<String>, start: Option<f64>, end: Option<f64>, transcript: Option<String>, draft_key: String }
#[derive(Serialize)]
pub struct Snapshot {
    config: Config,
    voices: Vec<Voice>,
    jobs: Vec<Job>,
    assets: Vec<Asset>,
    has_more: bool,
    has_history: bool,
}

#[derive(Serialize)]
pub struct JobResult { job: Job, asset: Option<Asset> }
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

fn index<'a>(files: &'a mut HashMap<PathBuf, Jobs>, base: &Path) -> AppResult<&'a mut Jobs> {
    use std::collections::hash_map::Entry;
    Ok(match files.entry(base.to_owned()) {
        Entry::Occupied(entry) => entry.into_mut(),
        Entry::Vacant(entry) => entry.insert(Jobs::load(base)?),
    })
}

fn save_job(base: &Path, job: &Job) -> AppResult<()> {
    let mut files = lock(&FILES);
    let jobs = index(&mut files, base)?;
    write(&job_path(base, &job.id), job)?;
    jobs.insert(base, job);
    Ok(())
}

fn is_active(id: &str) -> bool {
    lock(&ACTIVE).as_ref().is_some_and(|job| job.id == id)
}

fn record_view(base: &Path, id: &str) -> AppResult<Job> {
    let mut job: Job = read(&job_path(base, id))?;
    if job.id != id { return Err(error("声音任务记录不匹配")); }
    let dir = run_dir(base, id);
    if job.status == "running" {
        if is_active(id) {
            if let Ok(stage) = read::<Stage>(&dir.join("status.json")) {
                job.progress = stage.progress;
                job.warning = stage.warning;
                if matches!(stage.stage.as_str(), "preparing_reference" | "loading_model" | "synthesizing" | "saving") {
                    job.stage = Some(stage.stage);
                } else if stage.stage == "succeeded" {
                    job.stage = Some("saving".into());
                }
            }
        } else {
            // Reread a final receipt if the task exited between reading JSON and ACTIVE.
            job = read(&job_path(base, id))?;
            if job.status == "running" {
                job.status = "interrupted".into();
                job.message = "上次生成已中断；如文件已完成，可以取回结果，否则请重新生成".into();
                job.stage = None;
            }
        }
    }
    job.recoverable = !matches!(job.status.as_str(), "running" | "cancelled" | "succeeded")
        && store::owned_file(&dir.join("output.wav"));
    job.has_diagnostic = store::diagnostic(base, id).is_some();
    Ok(job)
}

fn emit_job(app: &AppHandle, job: &Job) {
    let _ = app.emit("voice://job-updated", serde_json::json!({
        "project": job.project, "id": job.id, "request_key": job.request_key,
        "purpose": job.purpose, "status": job.status,
    }));
}

fn allow_asset(app: &AppHandle, asset: &Asset) {
    if let Some(path) = &asset.store_path { let _ = app.asset_protocol_scope().allow_file(path); }
}

async fn blocking<T: Send + 'static>(operation: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(operation).await.map_err(|err| error(&err.to_string()))?
}

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
    let base = root(&paths);
    blocking(move || {
        validate_config(&config)?;
        let _files = lock(&FILES);
        write(&base.join("config.json"), &config)
    }).await
}
#[tauri::command]
pub async fn voice_snapshot(
    app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>,
    project: String, before: Option<String>, history_limit: Option<usize>,
) -> AppResult<Snapshot> {
    if let Some(before) = &before { valid_id(before)?; }
    let base = root(&paths);
    let db = db.inner().clone();
    blocking(move || {
        let (ids, has_more, has_history) = index(&mut lock(&FILES), &base)?
            .history(&project, before.as_deref(), history_limit.unwrap_or(30).min(100));
        let config = if base.join("config.json").exists() { read(&base.join("config.json"))? } else { Config::default() };
        let voices: Vec<Voice> = records(&base.join("voices"))?;
        let jobs: Vec<_> = ids.iter().map(|id| record_view(&base, id)).collect::<AppResult<_>>()?;
        let mut ids: Vec<_> = voices.iter().map(|voice| voice.asset_id.clone())
            .chain(jobs.iter().filter_map(|job| job.asset_id.clone())).collect();
        ids.sort();
        ids.dedup();
        let assets = db.get_assets_by_ids(&ids)?;
        for asset in &assets { allow_asset(&app, asset); }
        for voice in &voices { let _ = app.asset_protocol_scope().allow_file(&voice.reference); }
        Ok(Snapshot { config, voices, jobs, assets, has_more, has_history })
    }).await
}

#[tauri::command]
pub async fn voice_job(
    app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>,
    project: String, id: Option<String>, request_key: Option<String>,
) -> AppResult<Option<JobResult>> {
    let base = root(&paths);
    let db = db.inner().clone();
    blocking(move || {
        let id = match id {
            Some(id) => { valid_id(&id)?; Some(id) }
            None => {
                let mut files = lock(&FILES);
                let jobs = index(&mut files, &base)?;
                request_key.and_then(|key| jobs.request(&project, &key).map(str::to_owned))
            }
        };
        let Some(id) = id else { return Ok(None); };
        if !job_path(&base, &id).is_file() { return Ok(None); }
        let job = record_view(&base, &id)?;
        if job.project != project { return Ok(None); }
        let asset = job.asset_id.as_ref().map(|id| db.get_asset(id)).transpose()?.flatten();
        if let Some(asset) = &asset { allow_asset(&app, asset); }
        Ok(Some(JobResult { job, asset }))
    }).await
}
#[tauri::command]
pub async fn voice_save(db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, name: String, asset_id: String, transcript: String, start: Option<f64>, end: Option<f64>) -> AppResult<Voice> {
    if name.trim().is_empty() { return Err(error("请填写角色名称")); }
    let db = db.inner().clone(); let paths = paths.inner().clone();
    blocking(move || {
        let id = ulid::Ulid::new().to_string(); let base = root(&paths);
        let destination = base.join("references").join(format!("{id}.wav"));
        fs::create_dir_all(base.join("references"))?;
        let staging = tempfile::tempdir_in(base.join("references"))?;
        let prepared = staging.path().join("reference.wav");
        let duration = prepare_reference(&db, &asset_id, &prepared, start, end)?;
        let voice = Voice { id: id.clone(), name: name.trim().into(), asset_id,
            reference: destination.to_string_lossy().into_owned(), transcript: transcript.trim().into(), duration: Some(duration) };
        let _files = lock(&FILES);
        fs::rename(prepared, &destination)?;
        if let Err(e) = write(&base.join("voices").join(format!("{id}.json")), &voice) { let _ = fs::remove_file(destination); return Err(e); }
        Ok(voice)
    }).await
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
    valid_id(&id)?;
    let base = root(&paths);
    blocking(move || {
        let _files = lock(&FILES);
        let path = base.join("voices").join(format!("{id}.json"));
        if let Some(name) = name {
            if name.trim().is_empty() { return Err(error("请填写声音名称")); }
            let mut voice: Voice = read(&path)?;
            voice.name = name.trim().into();
            write(&path, &voice)
        } else {
            if path.exists() { fs::remove_file(path)?; }
            // Keep the independent reference until maintenance has checked frozen jobs.
            Ok(())
        }
    }).await
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
fn voice_asset_title(text: &str) -> String {
    let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() <= 48 {
        return title;
    }
    title.chars().take(47).chain(std::iter::once('…')).collect()
}

fn publish(db: &Database, paths: &LibraryPaths, job: &mut Job) -> AppResult<Asset> {
    // Recover a committed import even if the process stopped before writing its JSON receipt.
    let key = format!("voice:{}", job.id);
    let previous: Option<String> = lock(&db.conn).query_row("SELECT asset_id FROM analyses WHERE id=?1", [&key], |r| r.get(0)).optional()?;
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
    let pending: Option<String> = lock(&db.conn).query_row(
        "SELECT id FROM assets WHERE source='voxcpm' AND origin_path=?1 LIMIT 1",
        [output.to_string_lossy().as_ref()], |r| r.get(0)).optional()?;
    let asset = match pending {
        Some(id) => db.get_asset(&id)?.ok_or_else(|| error("生成文件暂不可读，请重试取回"))?,
        None => ingest::ingest_generated(&destination, db, &output, None, "voxcpm")?,
    };
    let saved = (|| -> AppResult<()> {
        let mut conn = lock(&db.conn); let tx = conn.transaction()?;
        tx.execute("UPDATE assets SET name=?1,origin_path=NULL,duration=?2 WHERE id=?3", params![voice_asset_title(&job.text),audio.duration,asset.id])?;
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

fn normalize_language(language: Option<String>) -> AppResult<Option<String>> {
    match language.as_deref().unwrap_or_default().trim() {
        "" | "auto" => Ok(None),
        code @ (
            "zh" | "yue" | "zh-sc" | "zh-db" | "zh-wu" | "zh-hn" | "zh-sx" | "zh-sd" | "zh-tj" | "zh-mn" |
            "en" | "ja" | "ko" | "fr" | "de" | "es" | "ru" | "it" | "pt" | "ar" | "th" | "vi" |
            "id" | "ms" | "hi" | "tr" | "nl" | "pl" | "sv" | "da" | "no" | "fi" | "el" | "he" | "sw" | "km" | "lo" | "my" | "tl"
        ) => Ok(Some(code.to_owned())),
        _ => Err(error("不支持的配音语种，请重新选择")),
    }
}

#[tauri::command]
pub async fn voice_start(
    app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>,
    auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, project: String,
    text: String, description: Option<String>, voice_id: Option<String>, preview: Option<Preview>,
    request_key: Option<String>, seed: Option<u32>, language: Option<String>,
) -> AppResult<String> {
    access(&auth, &entitlement).await?;
    let base = root(&paths);
    let db = db.inner().clone(); let paths = paths.inner().clone();
    blocking(move || {
        let admission = reserve_job(&base, &db, project, text, description, voice_id, preview.as_ref(), request_key, seed, language)?;
        let (job, task, cancel) = match admission {
            Admission::Existing(id) => return Ok(id),
            Admission::New { job, task, cancel } => (job, task, cancel),
        };
        let id = job.id.clone();
        emit_job(&app, &job);
        tokio::task::spawn_blocking(move || {
            execute(&app, &db, &paths, job, preview, &cancel, task);
        });
        Ok(id)
    }).await
}

enum Admission {
    Existing(String),
    New { job: Job, task: ActiveJob, cancel: Arc<AtomicBool> },
}

fn reserve_job(
    base: &Path, db: &Database, project: String, text: String, description: Option<String>,
    voice_id: Option<String>, preview: Option<&Preview>, request_key: Option<String>, seed: Option<u32>, language: Option<String>,
) -> AppResult<Admission> {
    let mut files = lock(&FILES);
    let jobs = index(&mut files, base)?;
    if let Some(id) = request_key.as_deref().and_then(|key| jobs.request(&project, key)) {
        return Ok(Admission::Existing(id.to_owned()));
    }
    validate_clone_request(description.as_deref().unwrap_or_default(), voice_id.as_deref(), preview)?;
    if text.trim().is_empty() { return Err(error("请填写要生成的台词")); }
    let language = normalize_language(language)?;
    if db.get_project(&project)?.is_none() { return Err(error("项目已不存在，请重新打开项目")); }
    let mut active = lock(&ACTIVE);
    if active.is_some() { return Err(error("已有声音正在生成，请等待完成或取消后再试")); }
    let config: Config = read(&base.join("config.json")).map_err(|_| error("请先配置本机声音环境"))?;
    validate_config(&config)?;
    let voice: Option<Voice> = match &voice_id {
        Some(id) => { valid_id(id)?; Some(read(&base.join("voices").join(format!("{id}.json")))?) }
        None => None,
    };
    if voice.as_ref().is_some_and(|voice| !Path::new(&voice.reference).is_file()) {
        return Err(error("角色参考录音缺失，请重新导入并保存角色"));
    }
    let job = Job {
        id: ulid::Ulid::new().to_string(), project, text, description: String::new(), voice_id,
        reference: voice.as_ref().map(|voice| voice.reference.clone()),
        transcript: voice.as_ref().map(|voice| voice.transcript.clone()),
        voice_name: voice.as_ref().map(|voice| voice.name.clone()).unwrap_or_else(|| "录音克隆试听".into()),
        purpose: if preview.is_some() { "preview" } else { "speech" }.into(),
        draft_key: preview.map(|preview| preview.draft_key.clone()).unwrap_or_default(), request_key,
        config, status: "running".into(), message: "正在生成，可以关闭面板，稍后查看结果".into(),
        stage: Some("preparing_reference".into()), asset_id: None, recoverable: false,
        progress: None, error_code: None, warning: None, has_diagnostic: false, seed, language,
    };
    write(&job_path(base, &job.id), &job)?;
    jobs.insert(base, &job);
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some(Active { id: job.id.clone(), cancel: cancel.clone(), publishing: false });
    let task = ActiveJob(job.id.clone());
    Ok(Admission::New { job, task, cancel })
}

fn execute(
    app: &AppHandle, db: &Database, paths: &LibraryPaths, mut job: Job,
    preview: Option<Preview>, cancel: &AtomicBool, task: ActiveJob,
) {
    let base = root(paths);
    let result = (|| -> AppResult<Stage> {
        fs::create_dir_all(run_dir(&base, &job.id))?;
        if let Some(p) = preview {
            if let Some(asset) = p.asset_id {
                let reference = run_dir(&base, &job.id).join("reference.wav");
                prepare_reference(db, &asset, &reference, p.start, p.end)?;
                job.reference = Some(reference.to_string_lossy().into());
                job.transcript = p.transcript;
            }
        }
        worker::run(&base, &job, cancel, |_| emit_job(app, &job))
    })();
    let _publish = lock(&PUBLISH);
    // Commit or cancel under the same lock used by voice_cancel. After this
    // boundary the WAV is complete and publishing it has idempotent recovery.
    let cancelled = {
        let mut active = lock(&ACTIVE);
        let cancelled = cancel.load(Ordering::SeqCst);
        if let Some(active) = active.as_mut() { active.publishing = true; }
        cancelled
    };
    if cancelled {
        job.status = "cancelled".into();
        job.message = "生成已取消，可以重新生成".into();
    } else {
        let result = result.and_then(|stage| {
            job.progress = stage.progress;
            job.warning = stage.warning;
            if stage.stage == "succeeded" { return publish(db, paths, &mut job); }
            let fallback = stage.user_message.is_none().then(|| worker::runner_failure(&run_dir(&base, &job.id)));
            job.error_code = stage.error_code.or_else(|| fallback.as_ref().and_then(|state| state.error_code.clone()));
            Err(error(stage.user_message.as_deref().or_else(|| fallback.as_ref().and_then(|state| state.user_message.as_deref()))
                .unwrap_or("声音生成失败，请检查环境并重试")))
        });
        match result {
            Ok(asset) => {
                job.status = "succeeded".into();
                job.message = "已保存到项目素材库".into();
                allow_asset(app, &asset);
                let _ = app.emit("library://assets-changed", ());
            }
            Err(cause) => {
                job.status = "failed".into();
                job.message = cause.to_string();
                worker::append_diagnostic(&run_dir(&base, &job.id), &format!("Desktop voice task failed: {cause}"));
            }
        }
    }
    job.stage = None;
    let receipt = save_job(&base, &job);
    if let Err(cause) = &receipt { tracing::error!("voice receipt failed: {cause}"); }
    if receipt.is_ok() || cancelled {
        store::cleanup_terminal(&base, &job);
    }
    drop(task);
    emit_job(app, &job);
}
#[tauri::command]
pub async fn voice_cancel(id: String) -> AppResult<()> {
    blocking(move || {
        let active = lock(&ACTIVE);
        if let Some(active) = active.as_ref().filter(|active| active.id == id && !active.publishing) {
            active.cancel.store(true, Ordering::SeqCst);
        }
        Ok(())
    }).await
}
#[tauri::command]
pub async fn voice_recover(app: AppHandle, db: State<'_, Arc<Database>>, paths: State<'_, Arc<LibraryPaths>>, id: String) -> AppResult<()> {
    valid_id(&id)?;
    let paths = paths.inner().clone();
    let db = db.inner().clone();
    blocking(move || {
        let _publish = lock(&PUBLISH);
        let base = root(&paths);
        if is_active(&id) { return Err(error("任务仍在运行，请稍后查看")); }
        let mut job = record_view(&base, &id)?;
        if job.status == "cancelled" { return Err(error("任务已取消，请重新生成")); }
        let asset = publish(&db, &paths, &mut job)?;
        job.status = "succeeded".into();
        job.message = "已保存到项目素材库".into();
        job.error_code = None;
        job.recoverable = false;
        save_job(&base, &job)?;
        store::cleanup_terminal(&base, &job);
        allow_asset(&app, &asset);
        emit_job(&app, &job);
        let _ = app.emit("library://assets-changed", ());
        Ok(())
    }).await
}

#[tauri::command]
pub async fn voice_diagnostic(paths: State<'_, Arc<LibraryPaths>>, project: String, id: String) -> AppResult<()> {
    valid_id(&id)?;
    let base = root(&paths);
    let path = blocking(move || {
        let job = record_view(&base, &id)?;
        if job.project != project { return Err(error("声音任务不属于当前项目")); }
        store::diagnostic(&base, &id).ok_or_else(|| error("诊断日志不存在或已过期"))
    }).await?;
    super::library::reveal_path_in_explorer(path.to_string_lossy().into_owned()).await
}

pub(crate) fn shutdown() {
    if let Some(active) = lock(&ACTIVE).as_ref() {
        active.cancel.store(true, Ordering::SeqCst);
    }
    worker::shutdown();
}

fn maintenance(base: &Path) -> AppResult<()> {
    let ids = index(&mut lock(&FILES), base)?.ids();
    let mut diagnostics = 0;
    for id in ids {
        let _publish = lock(&PUBLISH);
        if is_active(&id) { continue; }
        let stored: Job = read(&job_path(base, &id))?;
        let job = record_view(base, &id)?;
        if stored.status == "running" { save_job(base, &job)?; }
        store::prune_run(base, &job, &mut diagnostics);
    }
    worker::sweep_artifacts(base);
    let mut files = lock(&FILES);
    store::cleanup_references(base, index(&mut files, base)?)
}

pub(crate) fn start_maintenance(paths: Arc<LibraryPaths>) {
    let base = root(&paths);
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        let mut last_sweep = None;
        loop {
            tick.tick().await;
            let sweep = last_sweep.is_none_or(|time: std::time::Instant| time.elapsed() >= Duration::from_secs(30 * 60));
            let base = base.clone();
            if let Err(cause) = blocking(move || {
                worker::reap_idle();
                if sweep { maintenance(&base)?; }
                Ok(())
            }).await {
                tracing::warn!("Voice maintenance: {cause}");
            }
            if sweep { last_sweep = Some(std::time::Instant::now()); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn asset_title_collapses_whitespace_and_truncates_by_character() {
        assert_eq!(voice_asset_title("  欢迎\n\t来到\u{3000}这里。  "), "欢迎 来到 这里。");
        assert_eq!(voice_asset_title(&"声".repeat(48)), "声".repeat(48));
        assert_eq!(voice_asset_title(&"声".repeat(49)), format!("{}…", "声".repeat(47)));
    }

    #[test]
    fn language_defaults_to_auto_and_validates_explicit_codes() {
        for value in [None, Some(""), Some(" \t "), Some(" auto ")] {
            assert_eq!(normalize_language(value.map(str::to_owned)).unwrap(), None);
        }
        for (value, code) in [(" yue ", "yue"), ("zh-mn", "zh-mn"), ("en", "en")] {
            assert_eq!(normalize_language(Some(value.into())).unwrap().as_deref(), Some(code));
        }
        assert!(normalize_language(Some("粤语".into())).unwrap_err().to_string().contains("不支持的配音语种，请重新选择"));
    }

    #[test]
    fn legacy_job_without_language_loads_as_automatic() {
        let mut legacy = serde_json::to_value(job()).unwrap();
        legacy.as_object_mut().unwrap().remove("language");
        let restored: Job = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.language, None);
        assert_eq!(restored.text, "测试声音");
    }

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
        assert!(worker::run(dir.path(), &job(), &AtomicBool::new(false), |_| {}).unwrap_err().to_string().contains("参考录音"));
        assert!(!dir.path().join("runs").exists());
    }
    pub(super) fn job() -> Job { Job { id: ulid::Ulid::new().to_string(), project: "p".into(), text: "测试声音".into(),
        description: String::new(), voice_id: None, reference: None, transcript: None, config: Config::default(),
        status: "running".into(), message: String::new(), asset_id: None,
        purpose: String::new(), draft_key: String::new(), request_key: None, voice_name: String::new(), recoverable: false,
        stage: None, progress: None, error_code: None, warning: None, has_diagnostic: false, seed: None, language: None } }
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
        first.text = "  欢迎来到这里。\n  等你好久了。\t".into();
        first.language = Some("yue".into());
        let pending = ingest::ingest_generated(&paths, &db, &path, None, "voxcpm").unwrap();
        let asset = publish(&db, &paths, &mut first).unwrap();
        assert_eq!(asset.id, pending.id, "recover asset insert before metadata commit");
        assert_eq!(db.get_asset(&asset.id).unwrap().unwrap().name, "欢迎来到这里。 等你好久了。");
        assert_eq!(first.text, "  欢迎来到这里。\n  等你好久了。\t");
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
        let base = root(&paths);
        let mut stages = Vec::new();
        let started = std::time::Instant::now();
        let mut generate = |request: &Job| {
            let stage = worker::run(&base, request, &AtomicBool::new(false), |stage| stages.push(stage.stage.clone()))
                .unwrap();
            assert_eq!(stage.stage, "succeeded", "{stage:?}\n{}", fs::read_to_string(run_dir(&base, &request.id).join("diagnostic.log")).unwrap_or_default());
        };
        generate(&request);
        let cold = started.elapsed();
        let initial_worker = worker::worker_pid().unwrap();
        assert!(stages.contains(&"loading_model".into()));
        stages.clear();
        let started = std::time::Instant::now();
        let mut next = request.clone();
        next.id = ulid::Ulid::new().to_string();
        let stage = worker::run(&base, &next, &AtomicBool::new(false), |stage| stages.push(stage.stage.clone())).unwrap();
        assert_eq!(stage.stage, "succeeded", "{stage:?}");
        let warm = started.elapsed();
        assert_eq!(worker::worker_pid(), Some(initial_worker));
        assert!(!stages.contains(&"loading_model".into()));
        eprintln!("VoxCPM2 cold={cold:?}; warm={warm:?}; worker_pid={initial_worker}");
        worker::expire_worker();
        assert_eq!(worker::worker_pid(), None);
        let asset = publish(&db, &paths, &mut request).unwrap();
        assert!(Path::new(asset.store_path.as_deref().unwrap()).is_file()); assert!(asset.duration.unwrap() > 0.0);
        let cancel = AtomicBool::new(true); let mut cancelled = job(); cancelled.config = request.config;
        assert!(worker::run(&base, &cancelled, &cancel, |_| {}).unwrap_err().to_string().contains("取消"));
    }

    #[test]
    fn task_index_keeps_project_request_identity_and_bounded_history() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        fs::create_dir(base.join("jobs")).unwrap();
        let first = ulid::Ulid::from_parts(1, 1).to_string();
        let mut request = job();
        request.id = first.clone();
        request.request_key = Some("retry-key".into());
        request.purpose = "preview".into();
        for i in 1..=600 {
            request.id = ulid::Ulid::from_parts(i, 1).to_string();
            if i >= 3 {
                request.purpose = "speech".into();
                request.request_key = None;
                request.project = if i % 2 == 0 { "p".into() } else { "other".into() };
            }
            fs::write(job_path(base, &request.id), serde_json::to_vec(&request).unwrap()).unwrap();
        }
        let started = std::time::Instant::now();
        let index = Jobs::load(base).unwrap();
        let cold = started.elapsed();
        let started = std::time::Instant::now();
        let (page, has_more, has_history) = index.history("p", None, 30);
        assert_eq!(page.len(), 30);
        assert!(has_more && has_history);
        assert!(!page.contains(&first));
        let cursor = page.last().unwrap();
        assert!(index.history("p", Some(cursor), 30).0.iter().all(|id| id < cursor));
        assert_eq!(index.request("p", "retry-key"), Some(first.as_str()));
        assert!(index.request("other", "retry-key").is_none());
        for id in page { assert_eq!(record_view(base, &id).unwrap().project, "p"); }
        assert_eq!(record_view(base, &first).unwrap().purpose, "preview");
        eprintln!("600-record index initialization={cold:?}, bounded history + single query={:?}", started.elapsed());
    }

    #[test]
    fn concurrent_admission_with_the_same_key_creates_one_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("p", "voice", "blank:p", "blank:p", "blank").unwrap();
        let python = base.join("fixture-python.exe");
        let model = base.join("model");
        fs::create_dir(&model).unwrap();
        for path in [&python, &model.join("model.safetensors"), &model.join("audiovae.pth")] {
            fs::write(path, b"fixture").unwrap();
        }
        fs::write(model.join("config.json"), br#"{"architecture":"voxcpm2"}"#).unwrap();
        write(&base.join("config.json"), &Config {
            python: python.to_string_lossy().into(), model: model.to_string_lossy().into(),
        }).unwrap();
        let preview = Preview { asset_id: Some("fixture".into()), start: Some(0.0), end: Some(1.0),
            transcript: None, draft_key: "draft".into() };
        let engines = std::sync::Barrier::new(2);
        let reserve = || {
            engines.wait();
            reserve_job(base, &db, "p".into(), "test".into(), None, None, Some(&preview), Some("same-key".into()), None, Some(" yue ".into())).unwrap()
        };
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(reserve);
            let second = scope.spawn(reserve);
            (first.join().unwrap(), second.join().unwrap())
        });
        let (job, existing) = match (&first, &second) {
            (Admission::New { job, .. }, Admission::Existing(existing))
            | (Admission::Existing(existing), Admission::New { job, .. }) => (job, existing),
            _ => panic!("expected one new and one existing admission"),
        };
        assert_eq!(&job.id, existing);
        assert_eq!(read::<Job>(&job_path(base, &job.id)).unwrap().language.as_deref(), Some("yue"));
        assert!(is_active(existing));
        assert_eq!(fs::read_dir(base.join("jobs")).unwrap().count(), 1);
    }

    #[test]
    fn cleanup_preserves_recoverable_output_and_frozen_reference() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        let references = base.join("references");
        let reference = references.join(format!("{}.wav", ulid::Ulid::new()));
        let orphan = references.join(format!("{}.wav", ulid::Ulid::new()));
        let uploaded = references.join("user-owned.wav");
        for path in [&reference, &orphan, &uploaded] { wav(path); }
        let mut recoverable = job();
        recoverable.status = "interrupted".into();
        recoverable.reference = Some(reference.to_string_lossy().into());
        for status in ["succeeded", "cancelled", recoverable.status.as_str()] {
            let mut task = if status == "interrupted" { recoverable.clone() } else { job() };
            task.status = status.into();
            let run = run_dir(base, &task.id);
            let output = run.join("output.wav");
            wav(&output);
            wav(&run.join("reference.wav"));
            write(&job_path(base, &task.id), &task).unwrap();
            store::cleanup_terminal(base, &task);
            assert_eq!(output.exists(), status == "interrupted");
            assert_eq!(run.join("reference.wav").exists(), status == "interrupted");
        }
        let jobs = Jobs::load(base).unwrap();
        store::cleanup_references(base, &jobs).unwrap();
        assert!(reference.exists());
        assert!(!orphan.exists());
        assert!(uploaded.exists());
        recoverable.status = "succeeded".into();
        write(&job_path(base, &recoverable.id), &recoverable).unwrap();
        store::cleanup_terminal(base, &recoverable);
        store::cleanup_references(base, &jobs).unwrap();
        assert!(!reference.exists());
    }
}
