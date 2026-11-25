use super::video_asset_revision::{read_registration, FileStamp};
use crate::{
    core::{ingest, library::Asset, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
    media::{
        self,
        tools::{self, Tool},
    },
};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock, Mutex, Weak},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

static AUDIO_QUEUE: Semaphore = Semaphore::const_new(2);
static SOURCES: LazyLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const QUEUE_TIMEOUT: Duration = Duration::from_secs(310);
struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tauri::command]
pub async fn extract_video_audio(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    source_path: String,
    operation_id: String,
    project_id: Option<String>,
) -> AppResult<Asset> {
    let (asset, created) = extract_queued(
        db.inner().clone(),
        paths.inner().clone(),
        source_path,
        operation_id,
        project_id,
    )
    .await?;
    if let Some(path) = &asset.store_path {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    if created {
        let _ = app.emit("library://assets-changed", ());
    }
    Ok(asset)
}

fn source_lock(id: &str) -> Arc<AsyncMutex<()>> {
    let mut sources = SOURCES.lock().unwrap();
    sources.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = sources.get(id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    sources.insert(id.to_owned(), Arc::downgrade(&lock));
    lock
}

async fn extract_queued(
    db: Arc<Database>,
    paths: Arc<LibraryPaths>,
    source: String,
    operation: String,
    project: Option<String>,
) -> AppResult<(Asset, bool)> {
    if operation.is_empty()
        || operation.len() > 80
        || !operation
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(AppError::Other("操作标识无效，请重新打开视频后重试".into()));
    }
    let lookup = db.clone();
    let id = tokio::task::spawn_blocking(move || registered_source(&lookup, &source))
        .await
        .map_err(|error| AppError::Other(error.to_string()))??;
    // Requests for the same source wait outside the FFmpeg queue.
    let guards = tokio::time::timeout(QUEUE_TIMEOUT, async {
        let source = source_lock(&id).lock_owned().await;
        AUDIO_QUEUE.acquire().await.map(|permit| (source, permit))
    })
    .await
    .map_err(|_| AppError::Other("等待提取音轨超时，请稍后重试".into()))?
    .map_err(|error| AppError::Other(error.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _guards = guards;
        extract(&db, &paths, &id, &operation, project.as_deref())
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}

fn registered_source(db: &Database, source: &str) -> AppResult<String> {
    db.conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT id FROM assets WHERE store_path IN (?1,?2,?3) LIMIT 1",
            params![source, source.replace('\\', "/"), source.replace('/', "\\")],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::Other("请先将视频保存到素材库，再提取音轨".into()))
}

struct AudioSource<'a> {
    id: &'a str,
    path: PathBuf,
    registered_path: String,
    stamp: FileStamp,
}

impl AudioSource<'_> {
    fn confirm(&self, conn: &Connection) -> AppResult<()> {
        read_registration(conn, self.id)?;
        let current: Option<String> = conn.query_row(
            "SELECT store_path FROM assets WHERE id=?1",
            [self.id],
            |row| row.get(0),
        )?;
        if current.as_deref() != Some(self.registered_path.as_str())
            || FileStamp::read(&self.path).as_ref().ok() != Some(&self.stamp)
        {
            return Err(source_changed());
        }
        Ok(())
    }
}

struct PreviousOperation {
    asset_id: String,
    has_stamp: bool,
}

fn previous_operation(
    conn: &Connection,
    record: &str,
    source: &str,
    project: Option<&str>,
) -> AppResult<Option<PreviousOperation>> {
    let previous: Option<(String, String)> = conn
        .query_row(
            "SELECT asset_id,payload FROM analyses WHERE id=?1",
            [record],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((asset_id, payload)) = previous else {
        return Ok(None);
    };
    let payload: serde_json::Value = serde_json::from_str(&payload)?;
    if payload["source_asset_id"] != source || payload["project_id"] != serde_json::json!(project) {
        return Err(AppError::Other(
            "保存目标发生变化，请重新打开视频后重试".into(),
        ));
    }
    Ok(Some(PreviousOperation {
        asset_id,
        has_stamp: payload["source_mtime"].is_string(),
    }))
}

fn existing_audio(db: &Database, id: &str) -> AppResult<Option<Asset>> {
    Ok(db.get_asset(id)?.filter(|asset| {
        asset
            .store_path
            .as_deref()
            .is_some_and(|path| Path::new(path).is_file())
    }))
}

fn source_changed() -> AppError {
    AppError::Other("提取期间视频已变化，请重新打开视频后重试".into())
}

fn write_record(
    conn: &Connection,
    id: &str,
    asset_id: &str,
    kind: &str,
    payload: &str,
) -> AppResult<()> {
    conn.execute("INSERT INTO analyses(id,asset_id,kind,payload,created_at) VALUES(?1,?2,?3,?4,strftime('%s','now'))
        ON CONFLICT(id) DO UPDATE SET asset_id=excluded.asset_id,kind=excluded.kind,payload=excluded.payload",
        params![id, asset_id, kind, payload])?;
    Ok(())
}

fn extract(
    db: &Database,
    paths: &LibraryPaths,
    id: &str,
    operation: &str,
    project: Option<&str>,
) -> AppResult<(Asset, bool)> {
    let original = db
        .get_asset(id)?
        .ok_or_else(|| AppError::NotFound(id.to_owned()))?;
    if !media::probe::is_video(original.ext.as_deref().unwrap_or_default()) {
        return Err(AppError::Media("请从视频素材提取音轨".into()));
    }
    if let Some(project) = project {
        if db.get_project(project)?.is_none() {
            return Err(AppError::Other(
                "目标项目已不存在，请返回画板重新选择".into(),
            ));
        }
    }
    let record = format!("video-audio:{operation}");
    let previous = previous_operation(&db.conn.lock().unwrap(), &record, id, project)?;
    // Records from before source stamps still replay by exact operation identity.
    // They cannot prove a cache match for any other operation.
    if let Some(previous) = previous.filter(|previous| !previous.has_stamp) {
        if let Some(asset) = existing_audio(db, &previous.asset_id)? {
            return Ok((asset, false));
        }
    }
    let path = db.resolve_asset_original(id)?;
    let stamp = FileStamp::read(&path)?;
    let source = AudioSource {
        id,
        path,
        stamp,
        registered_path: original.store_path.unwrap_or_default(),
    };
    let (size, modified) = source.stamp.parts();
    let mut payload = serde_json::json!({
        "source_asset_id": id, "project_id": project, "source_size": size, "source_mtime": modified,
    });
    let cache_id = format!(
        "video-audio-source:{:x}",
        Sha256::digest(payload.to_string())
    );
    payload["source_path"] = serde_json::json!(source.path.to_string_lossy());
    let payload = payload.to_string();
    let cached_id: Option<String> = db
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT asset_id FROM analyses WHERE id=?1 AND kind='video_audio'",
            [&cache_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = cached_id {
        if let Some(asset) = existing_audio(db, &id)? {
            let conn = db.conn.lock().unwrap();
            let tx = conn.unchecked_transaction()?;
            source.confirm(&tx)?;
            if previous_operation(&tx, &record, source.id, project)?
                .is_none_or(|previous| previous.asset_id != asset.id)
            {
                write_record(&tx, &record, &asset.id, "video_audio_operation", &payload)?;
            }
            tx.commit()?;
            return Ok((asset, false));
        }
    }
    let scratch = Scratch(
        paths
            .root
            .join(".video-audio")
            .join(ulid::Ulid::new().to_string()),
    );
    fs::create_dir_all(&scratch.0)?;
    let output = scratch.0.join("audio.wav");
    encode(&source.path, &output, &scratch.0.join("ffmpeg.log"))?;
    let waveform = media::audio::decode(&output)?;
    if waveform.duration <= 0.0 || !waveform.duration.is_finite() {
        return Err(AppError::Media("音轨内容无效，请检查视频文件".into()));
    }
    let destination = paths.for_project(db, project)?;
    let clip = ingest::GeneratedAudioClip {
        name: format!("{}-音轨", original.name),
        duration: waveform.duration,
        project_id: project,
    };
    let asset = ingest::ingest_generated_audio_with(
        &destination,
        db,
        &output,
        clip,
        "video-audio",
        |tx, asset| {
            source.confirm(tx)?;
            previous_operation(tx, &record, id, project)?;
            write_record(tx, &cache_id, &asset.id, "video_audio", &payload)?;
            write_record(tx, &record, &asset.id, "video_audio_operation", &payload)
        },
    )?;
    Ok((asset, true))
}

fn encode(source: &Path, output: &Path, log: &Path) -> AppResult<()> {
    let binary = tools::resolve(Tool::Ffmpeg)
        .map_err(|_| AppError::Media("提取音轨需要本机 FFmpeg，请安装后重试".into()))?;
    let mut child = tools::command(binary)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(source)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-c:a",
            "pcm_s16le",
            "-fs",
            "536870912",
        ])
        .arg(output)
        .stdout(Stdio::null())
        .stderr(fs::File::create(log)?)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                if fs::metadata(output)?.len() >= 536_870_912 {
                    return Err(AppError::Media("音轨过大，请先裁剪视频后提取".into()));
                }
                return Ok(());
            }
            Ok(Some(_)) => {
                let detail = fs::read_to_string(log).unwrap_or_default();
                tracing::warn!(
                    "video audio extraction failed: {}",
                    detail.chars().take(2000).collect::<String>()
                );
                return Err(AppError::Media(
                    if detail.contains("matches no streams") {
                        "视频没有可提取的音轨，请选择带声音的视频"
                    } else {
                        "音轨提取失败，请检查视频是否完整或使用兼容格式"
                    }
                    .into(),
                ));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Media("音轨提取未完成，请缩短视频后重试".into()));
            }
        }
    }
}

#[cfg(test)]
#[path = "video_audio_tests.rs"]
mod tests;
