use super::{current_description, source, FileStamp};
use crate::{
    cloud::{AuthClient, CloudClient},
    commands::video_asset_revision::{registration, save_revision, snapshot_source, Registration, RevisionGuard, SourceUsage},
    core::{
        external_files::{fingerprint, preview_key},
        folder_connections::registered_path_spelling,
        library::Analysis,
        paths::LibraryPaths,
    },
    db::Database,
    error::{AppError, AppResult},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{hash_map::Entry, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};
use tauri::{AppHandle, Emitter, State};

pub(crate) mod transport;
use transport::{Manifest, Service};

const SEGMENT_MS: u64 = 7_200_000;
const MAX_DESCRIPTION_CHARS: usize = 80_000;
type ActiveKey = (PathBuf, String);
static ACTIVE: LazyLock<Mutex<HashMap<ActiveKey, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct Activity(ActiveKey);
impl Drop for Activity {
    fn drop(&mut self) {
        ACTIVE.lock().unwrap().remove(&self.0);
    }
}

fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}

pub(crate) fn source_version(path: &Path) -> AppResult<String> {
    let key = preview_key(&registered_path_spelling(path), &std::fs::metadata(path)?)?;
    Ok(format!("v1:{:x}", Sha256::digest(key.as_bytes())))
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Running,
    Completed,
    Interrupted,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    status: Status,
    text: Option<String>,
    segment_count: u64,
    completed_segments: usize,
    cloud_pending: bool,
    error: Option<String>,
    quote_required: bool,
    price_changed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    duration_seconds: f64,
    duration_ms: u64,
    source_hash: String,
    segment_count: u64,
    credits: Option<i64>,
    pricing_version: Option<i64>,
    charge_required: bool,
    cloud_pending: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u8,
    plan_version: u8,
    source_hash: String,
    version: String,
    stamp: FileStamp,
    #[serde(flatten)]
    registration: Registration,
    owner: String,
    duration_ms: u64,
    credits: i64,
    pricing_version: i64,
    parent_key: String,
    status: Status,
    current: bool,
    text: String,
    descriptions: Vec<String>,
    pending: Option<Attempt>,
    error: Option<String>,
    #[serde(default)]
    terminal: bool,
    #[serde(default)]
    price_changed: bool,
}

#[derive(Deserialize, Serialize)]
struct Attempt {
    manifest: Manifest,
    job_id: Option<String>,
}

impl Record {
    fn progress(&self, active: bool) -> Progress {
        Progress {
            status: if self.status == Status::Running && !active {
                Status::Interrupted
            } else {
                self.status
            },
            text: (self.status == Status::Completed).then(|| self.text.clone()),
            segment_count: segment_count(self.duration_ms),
            completed_segments: self.descriptions.len(),
            cloud_pending: self.unfinished_admission(),
            error: self.error.clone(),
            quote_required: self.status != Status::Completed
                && !self.unfinished_admission()
                && !active
                && !self.terminal,
            price_changed: self.price_changed,
        }
    }

    fn unfinished_admission(&self) -> bool {
        self.status != Status::Completed
            && !self.terminal
            && (self.pending.is_some() || !self.descriptions.is_empty())
    }
}

fn segment_count(duration_ms: u64) -> u64 {
    duration_ms.div_ceil(SEGMENT_MS)
}

fn bounds(duration_ms: u64, index: usize) -> AppResult<(u64, u64)> {
    let start = (index as u64)
        .checked_mul(SEGMENT_MS)
        .filter(|start| *start < duration_ms)
        .ok_or_else(|| invalid("视频分析分段计划无效"))?;
    Ok((start, start.saturating_add(SEGMENT_MS).min(duration_ms)))
}

fn price(duration_ms: u64, rate: i64) -> Option<i64> {
    if duration_ms == 0 || rate <= 0 {
        return None;
    }
    i64::try_from((u128::from(duration_ms) * rate as u128).div_ceil(3_600_000)).ok()
}

fn load(db: &Database, asset_id: &str) -> AppResult<Option<Record>> {
    let payload: Option<String> = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT payload FROM analyses WHERE kind='video_analysis' AND asset_id=?1
         AND json_valid(payload) AND json_extract(payload,'$.current')=1
         AND json_extract(payload,'$.planVersion')=1 LIMIT 1",
            [asset_id],
            |row| row.get(0),
        )
        .optional()?;
    payload
        .map(|payload| serde_json::from_str(&payload).map_err(AppError::from))
        .transpose()
}

fn save(db: &Database, asset_id: &str, path: &Path, record: &Record) -> AppResult<()> {
    save_revision(
        db,
        &Analysis {
            id: format!("video-analysis:{asset_id}:{}", record.source_hash),
            kind: "video_analysis".into(),
            asset_id: asset_id.into(),
            provider: Some("doubao-vision".into()),
            payload: serde_json::to_string(record)?,
            created_at: None,
        },
        true,
        Some(RevisionGuard {
            path,
            stamp: &record.stamp,
            registration: &record.registration,
            source_hash: &record.source_hash,
        }),
    )
}

fn ensure_current(db: &Database, asset_id: &str, path: &Path, record: &Record) -> AppResult<()> {
    if !db.connected_source_matches(asset_id, path)?
        || FileStamp::read(path)? != record.stamp
        || source_version(path)? != record.version
        || !record
            .registration
            .matches(&registration(db, asset_id)?, &record.source_hash)
    {
        return Err(invalid("视频原件已变化，请重新获取报价"));
    }
    Ok(())
}

async fn local_info(db: Arc<Database>, asset_id: String) -> AppResult<(PathBuf, String, u64)> {
    let (path, version) = tokio::task::spawn_blocking(move || {
        let path = source(&db, &asset_id, SourceUsage::VideoAnalysis)?;
        let version = source_version(&path)?;
        Ok::<_, AppError>((path, version))
    })
    .await
    .map_err(|_| invalid("无法读取视频原件"))??;
    let duration_ms = transport::duration(&path, true).await?;
    if source_version(&path)? != version {
        return Err(invalid("读取期间视频已变化，请重新获取报价"));
    }
    Ok((path, version, duration_ms))
}

#[tauri::command]
pub async fn video_analysis_capabilities(
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
) -> AppResult<transport::Capabilities> {
    let Some(owner) = auth.snapshot().user_id else {
        return Ok(transport::Capabilities::closed());
    };
    Service {
        cloud: &cloud,
        auth: &auth,
        owner: &owner,
    }
    .capabilities()
    .await
}

#[tauri::command]
pub async fn video_analysis_quote(
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    asset_id: String,
) -> AppResult<Quote> {
    let (_, version, duration_ms) = local_info(db.inner().clone(), asset_id.clone()).await?;
    let owner = auth.snapshot().user_id;
    let existing = load(&db, &asset_id)?.filter(|record| record.version == version);
    if existing.as_ref().is_some_and(|record| record.terminal) {
        return Err(invalid("原画面分析任务已结束，请先核对云端任务和账本"));
    }
    let pending = existing.filter(Record::unfinished_admission);
    if pending
        .as_ref()
        .is_some_and(|record| Some(record.owner.as_str()) != owner.as_deref())
    {
        return Err(invalid("此视频有待恢复的分析，请登录原账号"));
    }
    let complete = current_description(&db, &asset_id)?.is_some();
    let (credits, pricing_version) = match (pending.as_ref(), owner) {
        (Some(record), _) => (Some(record.credits), Some(record.pricing_version)),
        (None, Some(owner)) if !complete => {
            let caps = Service {
                cloud: &cloud,
                auth: &auth,
                owner: &owner,
            }
            .capabilities()
            .await?;
            (
                caps.credits_per_hour
                    .and_then(|rate| price(duration_ms, rate)),
                caps.pricing_version,
            )
        }
        _ => (None, None),
    };
    Ok(Quote {
        duration_seconds: duration_ms as f64 / 1000.0,
        duration_ms,
        source_hash: version,
        segment_count: segment_count(duration_ms),
        credits,
        pricing_version,
        charge_required: !complete && pending.is_none(),
        cloud_pending: pending.is_some(),
    })
}

#[tauri::command]
pub async fn video_analysis_progress(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    auth: State<'_, AuthClient>,
    asset_id: String,
) -> AppResult<Option<Progress>> {
    let active = ACTIVE
        .lock()
        .unwrap()
        .contains_key(&(paths.root.clone(), asset_id.clone()));
    let db = db.inner().clone();
    let owner = auth.snapshot().user_id;
    tokio::task::spawn_blocking(move || {
        let Some(record) = load(&db, &asset_id)? else {
            return Ok(None);
        };
        let Ok(path) = source(&db, &asset_id, SourceUsage::VideoAnalysis) else {
            return Ok(None);
        };
        if ensure_current(&db, &asset_id, &path, &record).is_err()
            || (record.status != Status::Completed
                && owner.as_deref() != Some(record.owner.as_str()))
        {
            return Ok(None);
        }
        Ok(Some(record.progress(active)))
    })
    .await
    .map_err(|_| invalid("无法读取画面分析进度"))?
}

#[tauri::command]
pub async fn video_analysis_pause(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    auth: State<'_, AuthClient>,
    asset_id: String,
    expected_user_id: String,
) -> AppResult<bool> {
    auth.with_current_user(&expected_user_id, || {
        if !load(&db, &asset_id)?.is_some_and(|record| record.owner == expected_user_id) {
            return Ok(false);
        }
        let mut active = ACTIVE.lock().unwrap();
        let Some(pause) = active.get_mut(&(paths.root.clone(), asset_id)) else {
            return Ok(false);
        };
        *pause = true;
        Ok(true)
    })
}

#[tauri::command]
pub async fn video_analysis_start(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    asset_id: String,
    expected_user_id: String,
    expected_source_hash: String,
    expected_credits: Option<i64>,
    expected_pricing_version: Option<i64>,
) -> AppResult<Progress> {
    let Some(owner) = auth
        .snapshot()
        .user_id
        .filter(|owner| *owner == expected_user_id)
    else {
        return Err(invalid("账号已切换，请登录原账号继续画面分析"));
    };
    let root = paths.root.clone();
    let key = (root.clone(), asset_id.clone());
    let issued = {
        let mut active = ACTIVE.lock().unwrap();
        match active.entry(key.clone()) {
            Entry::Occupied(_) => false,
            Entry::Vacant(entry) => {
                entry.insert(false);
                true
            }
        }
    };
    if !issued {
        return load(&db, &asset_id)?
            .filter(|record| record.owner == owner)
            .map(|record| record.progress(true))
            .ok_or_else(|| invalid("正在准备画面分析"));
    }
    let activity = Activity(key);
    let checked_db = db.inner().clone();
    let checked_asset = asset_id.clone();
    let (path, full_hash, stamp, registered, version) = tokio::task::spawn_blocking(move || {
        let initial_path = source(&checked_db, &checked_asset, SourceUsage::VideoAnalysis)?;
        let version = source_version(&initial_path)?;
        if version != expected_source_hash {
            return Err(invalid("视频原件已变化，请重新获取报价"));
        }
        let (path, full_hash, stamp) = snapshot_source(&checked_db, &checked_asset, SourceUsage::VideoAnalysis)?;
        if path != initial_path || source_version(&path)? != version {
            return Err(invalid("视频原件已变化，请重新获取报价"));
        }
        let registered = registration(&checked_db, &checked_asset)?;
        Ok::<_, AppError>((path, full_hash, stamp, registered, version))
    })
    .await
    .map_err(|_| invalid("无法核对视频原件"))??;
    if let Some(saved) = current_description(&db, &asset_id)? {
        return Ok(Progress {
            status: Status::Completed,
            text: Some(saved.text),
            segment_count: 0,
            completed_segments: 0,
            cloud_pending: false,
            error: None,
            quote_required: false,
            price_changed: false,
        });
    }
    let duration_ms = transport::duration(&path, true).await?;
    let previous = load(&db, &asset_id)?.filter(|record| record.source_hash == full_hash);
    let mut record = if let Some(previous) =
        previous.filter(|record| record.unfinished_admission() || record.terminal)
    {
        if previous.owner != owner || previous.duration_ms != duration_ms {
            return Err(invalid("原分析任务需要原账号和未变化的视频"));
        }
        if previous.terminal {
            return Ok(previous.progress(false));
        }
        previous
    } else {
        let caps = Service {
            cloud: &cloud,
            auth: &auth,
            owner: &owner,
        }
        .capabilities()
        .await?;
        let confirmed = caps
            .credits_per_hour
            .and_then(|rate| price(duration_ms, rate));
        let (Some(credits), Some(pricing_version)) = (confirmed, caps.pricing_version) else {
            return Err(invalid("画面分析服务暂未开放"));
        };
        if Some(credits) != expected_credits || Some(pricing_version) != expected_pricing_version {
            return Ok(Progress {
                status: Status::Interrupted,
                text: None,
                segment_count: segment_count(duration_ms),
                completed_segments: 0,
                cloud_pending: false,
                error: Some("画面分析价格已变化，请重新核对报价".into()),
                quote_required: true,
                price_changed: true,
            });
        }
        let parent_identity = (
            1u8,
            &owner,
            &asset_id,
            &full_hash,
            duration_ms,
            pricing_version,
            uuid::Uuid::new_v4(),
        );
        let parent_key = format!(
            "library-visual:{:x}",
            Sha256::digest(serde_json::to_vec(&parent_identity)?)
        );
        Record {
            schema_version: 1,
            plan_version: 1,
            source_hash: full_hash,
            version: version.clone(),
            stamp: stamp.clone(),
            registration: registered.clone(),
            owner: owner.clone(),
            duration_ms,
            credits,
            pricing_version,
            parent_key,
            status: Status::Running,
            current: true,
            text: String::new(),
            descriptions: vec![],
            pending: None,
            error: None,
            terminal: false,
            price_changed: false,
        }
    };
    record.version = version;
    record.stamp = stamp;
    record.registration = registered;
    record.status = Status::Running;
    record.error = None;
    record.price_changed = false;
    ensure_current(&db, &asset_id, &path, &record)?;
    if let Some(saved) = current_description(&db, &asset_id)? {
        return Ok(Progress {
            status: Status::Completed,
            text: Some(saved.text),
            segment_count: 0,
            completed_segments: 0,
            cloud_pending: false,
            error: None,
            quote_required: false,
            price_changed: false,
        });
    }
    auth.with_current_user(&owner, || save(&db, &asset_id, &path, &record))?;
    let progress = record.progress(true);
    let (db, cloud, auth) = (
        db.inner().clone(),
        cloud.inner().clone(),
        auth.inner().clone(),
    );
    tauri::async_runtime::spawn(async move {
        let _activity = activity;
        let service = Service {
            cloud: &cloud,
            auth: &auth,
            owner: &owner,
        };
        if let Err(error) = finish(&db, &asset_id, &path, &root, &service, &mut record).await {
            record.status = Status::Interrupted;
            record.error = Some(error.to_string());
            if ensure_current(&db, &asset_id, &path, &record).is_ok() {
                let _ = save(&db, &asset_id, &path, &record);
            }
        }
        let _ = app.emit("library://assets-changed", ());
    });
    Ok(progress)
}

async fn finish(
    db: &Database,
    asset_id: &str,
    path: &Path,
    root: &Path,
    service: &Service<'_>,
    record: &mut Record,
) -> AppResult<()> {
    while (record.descriptions.len() as u64) < segment_count(record.duration_ms) {
        ensure_current(db, asset_id, path, record)?;
        if !record.descriptions.is_empty()
            && record.pending.is_none()
            && ACTIVE
                .lock()
                .unwrap()
                .get(&(root.to_owned(), asset_id.into()))
                == Some(&true)
        {
            record.status = Status::Interrupted;
            record.error = None;
            return save(db, asset_id, path, record);
        }
        let index = record.descriptions.len();
        let (start_ms, end_ms) = bounds(record.duration_ms, index)?;
        let key = format!("{}:{}", record.parent_key, index);
        let scratch = root
            .join("video-analysis")
            .join(format!("{:x}", Sha256::digest(key.as_bytes())));
        let proxy = scratch.join("visual-input.mp4");
        if record.pending.is_none() {
            let manifest =
                transport::prepare_proxy(path, &proxy, start_ms, end_ms, record.duration_ms)
                    .await?;
            ensure_current(db, asset_id, path, record)?;
            record.pending = Some(Attempt {
                manifest,
                job_id: None,
            });
            service
                .auth
                .with_current_user(service.owner, || save(db, asset_id, path, record))?;
        }
        let attempt = record
            .pending
            .as_ref()
            .ok_or_else(|| invalid("原分析分段身份丢失"))?;
        let found = service.lookup(&key, attempt.job_id.as_deref()).await?;
        let mut job = match found {
            Some(job) => job,
            None => match service.prepare(record, &key, &attempt.manifest).await? {
                transport::Preparation::Accepted(job) => job,
                transport::Preparation::Rejected {
                    error,
                    price_changed,
                } => {
                    if index == 0 {
                        record.pending = None;
                        record.price_changed = price_changed;
                        let _ = tokio::fs::remove_file(&proxy).await;
                    }
                    return Err(error);
                }
            },
        };
        record.pending.as_mut().unwrap().job_id = Some(job.job_id.clone());
        save(db, asset_id, path, record)?;
        if matches!(job.status.as_str(), "awaiting_upload" | "uploading") {
            let repair_manifest = match service.commit(&job.job_id).await {
                Ok(committed) if !uploading(&committed) => {
                    job = committed;
                    false
                }
                Ok(_) => false,
                Err(_) if !job.has_upload_url() => true,
                Err(error) => return Err(error),
            };
            if uploading(&job) && !job.has_upload_url() {
                let manifest = &record.pending.as_ref().unwrap().manifest;
                job = match service.prepare(record, &key, manifest).await? {
                    transport::Preparation::Accepted(signed) if signed.job_id == job.job_id => {
                        signed
                    }
                    _ => return Err(invalid("无法确认原画面分析任务的上传地址")),
                };
                if repair_manifest && uploading(&job) {
                    let committed = service.commit(&job.job_id).await?;
                    if !uploading(&committed) {
                        job = committed;
                    }
                }
            }
            if uploading(&job) {
                if !tokio::fs::try_exists(&proxy).await? {
                    transport::prepare_proxy(path, &proxy, start_ms, end_ms, record.duration_ms)
                        .await?;
                }
                ensure_current(db, asset_id, path, record)?;
                let sent = service
                    .upload(&job, &record.pending.as_ref().unwrap().manifest, &proxy)
                    .await;
                job = service.commit(&job.job_id).await?;
                if uploading(&job) {
                    sent?;
                    return Err(invalid("云端尚未确认收到画面代理，请按原任务恢复"));
                }
            }
        }
        job = service.wait(job).await?;
        match job.status.as_str() {
            "succeeded" | "completed" => {
                let text = job
                    .text
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .ok_or_else(|| invalid("云端未返回画面描述，请恢复原任务"))?;
                record.descriptions.push(text.chars().take(8_000).collect());
                record.pending = None;
                save(db, asset_id, path, record)?;
                let _ = tokio::fs::remove_file(&proxy).await;
                let _ = tokio::fs::remove_dir(&scratch).await;
            }
            "failed" | "cancelled" | "expired" => {
                record.terminal = true;
                let _ = tokio::fs::remove_file(&proxy).await;
                let _ = tokio::fs::remove_dir(&scratch).await;
                return Err(invalid("该分析任务已结束，请核对云端任务和账本"));
            }
            _ => return Err(invalid("云端分析结果未确认，请恢复原任务")),
        }
    }
    let verify_path = path.to_owned();
    let hash = tokio::task::spawn_blocking(move || fingerprint(&verify_path))
        .await
        .map_err(|_| invalid("无法核对分析对应的原件"))??;
    ensure_current(db, asset_id, path, record)?;
    if hash != record.source_hash {
        return Err(invalid("视频原件已变化，未保存本次画面描述"));
    }
    record.text = merge_descriptions(&record.descriptions, record.duration_ms)?;
    record.status = Status::Completed;
    service
        .auth
        .with_current_user(service.owner, || save(db, asset_id, path, record))
}

fn uploading(job: &transport::Job) -> bool {
    matches!(job.status.as_str(), "awaiting_upload" | "uploading")
}

fn merge_descriptions(parts: &[String], duration_ms: u64) -> AppResult<String> {
    if parts.len() == 1 {
        return Ok(parts[0].clone());
    }
    let mut text = String::new();
    let mut remaining = MAX_DESCRIPTION_CHARS;
    for (index, part) in parts.iter().enumerate() {
        let (start, end) = bounds(duration_ms, index)?;
        let section = format!(
            "[{}–{} 秒]\n{}\n\n",
            start / 1000,
            end as f64 / 1000.0,
            part
        );
        let before = text.len();
        text.extend(section.chars().take(remaining));
        remaining = remaining.saturating_sub(text[before..].chars().count());
        if remaining == 0 {
            break;
        }
    }
    Ok(text.trim_end().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_analysis_split_and_quote_round_entire_timeline_once() {
        assert_eq!(segment_count(7_200_000), 1);
        assert_eq!(segment_count(7_200_001), 2);
        assert_eq!(bounds(7_200_001, 0).unwrap(), (0, 7_200_000));
        assert_eq!(bounds(7_200_001, 1).unwrap(), (7_200_000, 7_200_001));
        assert!(bounds(7_200_001, 2).is_err());
        assert_eq!(price(7_200_001, 3), Some(7));
        assert_eq!(price(3_600_000, 3), Some(3));
    }

    #[test]
    fn video_analysis_merge_preserves_source_order() {
        let result = merge_descriptions(&["球场".into(), "山景".into()], 7_201_500).unwrap();
        assert!(result.contains("[0–7200 秒]\n球场"));
        assert!(result.ends_with("[7200–7201.5 秒]\n山景"));
    }
}
