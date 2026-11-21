use crate::{
    cloud::{AuthClient, CloudClient},
    core::{library::Analysis, paths::LibraryPaths},
    db::Database,
    error::{AppError, AppResult},
    media::probe,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};
use tauri::{AppHandle, Emitter, State};

use super::{
    video_asset_revision::{registration, save_revision, snapshot_source, source, FileStamp, Registration},
    video_replication::{speech, stage_for_owner, stage_recovery, StageRecovery},
};

mod file_speech;

type ActiveKey = (PathBuf, String);
static ACTIVE: LazyLock<Mutex<HashSet<ActiveKey>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static STARTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Activity(ActiveKey);
impl Drop for Activity {
    fn drop(&mut self) {
        ACTIVE.lock().unwrap().remove(&self.0);
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Status {
    Running,
    Completed,
    NoAudio,
    NoSpeech,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptWord {
    start_ms: u64,
    end_ms: u64,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Utterance {
    start_ms: f64,
    end_ms: f64,
    text: String,
    #[serde(
        default,
        deserialize_with = "deserialize_transcript_words",
        skip_serializing_if = "Vec::is_empty"
    )]
    words: Vec<TranscriptWord>,
}

fn deserialize_transcript_words<'de, D>(deserializer: D) -> Result<Vec<TranscriptWord>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mut value = serde_json::Value::deserialize(deserializer)?;
    if let Some(words) = value.as_array_mut() {
        // Older speech responses can have untimed blank separators.
        words.retain(|word| {
            !word["text"]
                .as_str()
                .is_some_and(|text| text.trim().is_empty())
        });
    }
    Ok(serde_json::from_value(value).unwrap_or_default())
}

impl Utterance {
    fn constrain_words(&mut self, duration_ms: u64) {
        let mut previous_end = self.start_ms;
        for word in &self.words {
            if (word.start_ms as f64) < previous_end
                || word.end_ms < word.start_ms
                || (word.end_ms as f64) > self.end_ms
            {
                self.words.clear();
                return;
            }
            previous_end = word.end_ms as f64;
        }
        self.words.retain_mut(|word| {
            word.end_ms = word.end_ms.min(duration_ms);
            word.start_ms <= word.end_ms
        });
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTranscript {
    status: Status,
    text: String,
    utterances: Vec<Utterance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cloud_pending: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_segments: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_segments: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quote_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    price_changed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_refresh_timing: Option<bool>,
}

impl VideoTranscript {
    fn new(status: Status) -> Self {
        Self {
            status,
            text: String::new(),
            utterances: vec![],
            error: None,
            cloud_pending: None,
            total_segments: None,
            completed_segments: None,
            quote_required: None,
            price_changed: None,
            can_refresh_timing: None,
        }
    }

    fn interrupted(message: &str, cloud_pending: bool) -> Self {
        let mut state = Self::new(Status::Interrupted);
        state.interrupt(message, cloud_pending);
        state
    }

    fn interrupt(&mut self, message: &str, cloud_pending: bool) {
        self.status = Status::Interrupted;
        self.error = Some(message.into());
        self.cloud_pending = Some(cloud_pending);
    }

    fn is_complete(&self) -> bool {
        matches!(
            self.status,
            Status::Completed | Status::NoAudio | Status::NoSpeech
        )
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(flatten)]
    view: VideoTranscript,
    source_hash: String,
    stamp: FileStamp,
    #[serde(flatten)]
    registration: Registration,
    owner: Option<String>,
    #[serde(default)]
    attempt: u32,
    current: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    segmentation: Option<Segmentation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    full_attempts: Vec<file_speech::Attempt>,
}

impl Record {
    fn matches_registration(&self, current: &Registration) -> bool {
        self.registration.matches(current, &self.source_hash)
    }

    fn timing_attempt(&self, owner: &str) -> Option<&file_speech::Attempt> {
        if !self.current
            || self.view.status != Status::Completed
            || self.view.utterances.is_empty()
            || self
                .view
                .utterances
                .iter()
                .any(|line| !line.words.is_empty())
        {
            return None;
        }
        self.full_attempts.last().filter(|attempt| {
            attempt.terminal
                && attempt.owner == owner
                && attempt.key.starts_with("file-speech:")
                && attempt
                    .job_id
                    .as_deref()
                    .is_some_and(|job| uuid::Uuid::parse_str(job).is_ok())
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Segmentation {
    plan: Vec<speech::Segment>,
    segment_attempt: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptQuote {
    source_hash: String,
    duration_seconds: f64,
    charge_required: bool,
    cloud_pending: bool,
    no_audio: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedQuote {
    source_hash: String,
}

const QUOTE_REQUIRED: &str = "请核对本次转录费用后继续";

fn invalid(message: &str) -> AppError {
    AppError::Other(message.into())
}

fn record_id(asset_id: &str, source_hash: &str) -> String {
    format!("video-transcript:{asset_id}:{source_hash}")
}

fn load(db: &Database, asset_id: &str, source_hash: Option<&str>) -> AppResult<Option<Record>> {
    let payload = match source_hash {
        Some(hash) => db.get_analysis(&record_id(asset_id, hash))?.map(|analysis| analysis.payload),
        None => db.conn.lock().unwrap().query_row(
            "SELECT payload FROM analyses WHERE asset_id=?1 AND kind='video_transcript' AND json_extract(payload,'$.current')=1",
            [asset_id], |row| row.get::<_, String>(0),
        ).optional()?,
    };
    payload
        .map(|payload| serde_json::from_str(&payload).map_err(AppError::from))
        .transpose()
}

fn save(db: &Database, asset_id: &str, record: &Record, select_revision: bool) -> AppResult<()> {
    save_revision(db, &Analysis {
        id: record_id(asset_id, &record.source_hash),
        asset_id: asset_id.to_owned(),
        kind: "video_transcript".into(),
        payload: serde_json::to_string(record)?,
        provider: Some("doubao-speech".into()),
        created_at: None,
    }, select_revision)
}

fn save_final(db: &Database, root: &Path, asset_id: &str, record: &Record) -> AppResult<()> {
    save(db, asset_id, record, false)?;
    if let Some(attempt) = record
        .full_attempts
        .last()
        .filter(|attempt| attempt.terminal)
    {
        let _ = fs::remove_file(file_speech::audio_path(root, &attempt.key));
    }
    Ok(())
}

fn current_view(
    db: &Database,
    root: &Path,
    asset_id: &str,
    owner: Option<&str>,
) -> AppResult<Option<VideoTranscript>> {
    let Some(mut record) = load(db, asset_id, None)? else {
        return Ok(None);
    };
    let Ok(current) = registration(db, asset_id) else {
        return Ok(None);
    };
    if !record.matches_registration(&current) {
        return Ok(None);
    }
    if let Some(path) = db.get_asset(asset_id)?.and_then(|asset| asset.store_path) {
        if FileStamp::read(Path::new(&path)).is_ok_and(|stamp| stamp != record.stamp)
            || (Path::new(&path).is_file() && !db.connected_source_matches(asset_id, Path::new(&path))?) {
            return Ok(None);
        }
    }
    let active = ACTIVE
        .lock()
        .unwrap()
        .contains(&(root.into(), asset_id.into()));
    if record.view.status == Status::Running && !active {
        let pending = cloud_pending(root, asset_id, &record);
        record.view.interrupt("转录已中断，可恢复原任务", pending);
    }
    record.view.can_refresh_timing =
        (!active && owner.is_some_and(|id| record.timing_attempt(id).is_some())).then_some(true);
    Ok(Some(record.view))
}

struct CheckedSource {
    path: PathBuf,
    hash: String,
    stamp: FileStamp,
    registration: Registration,
    duration_seconds: f64,
}

async fn check_source(db: Arc<Database>, asset_id: String) -> AppResult<CheckedSource> {
    tokio::task::spawn_blocking(move || {
        let (path, hash, stamp) = snapshot_source(&db, &asset_id).map_err(|error| match error {
            AppError::Other(_) => error,
            _ => invalid("无法读取视频原件，请检查文件是否可用"),
        })?;
        let media =
            probe::probe(&path).map_err(|_| invalid("无法读取视频时长，请检查视频格式和完整性"))?;
        if !media.duration.is_finite() || media.duration <= 0.0 {
            return Err(invalid("无法确认视频时长，请检查原文件后重试"));
        }
        if media.duration > speech::MAX_FULL_AUDIO_SECONDS {
            return Err(invalid("视频超过 2 小时，请先裁剪后再转录"));
        }
        if FileStamp::read(&path).as_ref().ok() != Some(&stamp) {
            return Err(invalid("读取期间视频已变化，请重新转录"));
        }
        Ok(CheckedSource {
            path,
            hash,
            stamp,
            registration: registration(&db, &asset_id)?,
            duration_seconds: media.duration,
        })
    })
    .await
    .map_err(|_| invalid("无法读取视频原件"))?
}

async fn verify_source(
    db: Arc<Database>,
    asset_id: &str,
    input: &Path,
    expected: &str,
) -> AppResult<(FileStamp, Registration)> {
    let asset_id = asset_id.to_owned();
    let input = input.to_owned();
    let expected = expected.to_owned();
    tokio::task::spawn_blocking(move || {
        let (resolved, current, stamp) = snapshot_source(&db, &asset_id)?;
        if resolved != input || current != expected {
            return Err(invalid("转录期间视频已变化，请转录当前原件"));
        }
        Ok((stamp, registration(&db, &asset_id)?))
    })
    .await
    .map_err(|_| invalid("无法核对视频原件"))?
}

#[derive(Deserialize)]
struct SpeechResult {
    text: String,
    utterances: Vec<Utterance>,
}

fn parse_result(result: serde_json::Value) -> AppResult<VideoTranscript> {
    parse_timed_result(result, speech::MAX_SECONDS * 1000.0)
}

fn parse_timed_result(result: serde_json::Value, duration_ms: f64) -> AppResult<VideoTranscript> {
    let mut speech: SpeechResult = serde_json::from_value(result)
        .map_err(|_| invalid("语音服务结果无法读取，请取回原任务"))?;
    if speech.text.trim().is_empty() && speech.utterances.is_empty() {
        return Ok(VideoTranscript::new(Status::NoSpeech));
    }
    let mut previous_end = 0.0;
    for utterance in &mut speech.utterances {
        if utterance.start_ms < previous_end
            || utterance.end_ms <= utterance.start_ms
            || utterance.end_ms > duration_ms + 250.0
        {
            return Err(invalid("语音服务返回的时间信息无效，请取回原任务"));
        }
        previous_end = utterance.end_ms;
        utterance.constrain_words(duration_ms.floor() as u64);
    }
    if speech.text.trim().is_empty() || speech.utterances.is_empty() {
        return Err(invalid("语音服务结果不完整，请取回原任务"));
    }
    Ok(VideoTranscript {
        text: speech.text,
        utterances: speech.utterances,
        ..VideoTranscript::new(Status::Completed)
    })
}

fn parse_full_result(text: &str, source_duration_ms: f64) -> AppResult<VideoTranscript> {
    let result =
        serde_json::from_str(text).map_err(|_| invalid("语音服务结果无法读取，请按原任务恢复"))?;
    let mut view = parse_timed_result(result, source_duration_ms)?;
    for utterance in &mut view.utterances {
        if utterance.start_ms >= source_duration_ms {
            return Err(invalid("转录句段超出原片范围，请按原任务恢复"));
        }
        utterance.end_ms = utterance.end_ms.min(source_duration_ms);
    }
    Ok(view)
}

fn stage_location(root: &Path, asset_id: &str, record: &Record) -> (PathBuf, String) {
    let identity = format!(
        "{asset_id}:{}:{}:{}",
        record.source_hash,
        record.owner.as_deref().unwrap_or_default(),
        record.attempt
    );
    let key = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let directory = root.join("video-transcripts").join(&key);
    (directory, format!("replication:library-speech:{key}"))
}

struct SegmentStage {
    directory: PathBuf,
    name: String,
    key: String,
}

impl SegmentStage {
    fn receipts(&self) -> PathBuf {
        self.directory.join("stages")
    }

    fn recovery(&self) -> AppResult<StageRecovery> {
        stage_recovery(&self.receipts(), &self.name)
    }
}

fn next_stage(root: &Path, asset_id: &str, record: &Record) -> Option<SegmentStage> {
    let (directory, legacy_key) = stage_location(root, asset_id, record);
    let Some(segmentation) = &record.segmentation else {
        return Some(SegmentStage {
            directory,
            name: "speech".into(),
            key: legacy_key,
        });
    };
    let index = record.view.completed_segments.unwrap_or(0);
    if index >= segmentation.plan.len() {
        return None;
    }
    let attempt = segmentation.segment_attempt;
    Some(SegmentStage {
        directory,
        name: format!("speech-{index:03}-{attempt}"),
        key: format!("{legacy_key}:seg:{index}:{attempt}"),
    })
}

fn legacy_can_resume(root: &Path, asset_id: &str, record: &Record) -> AppResult<bool> {
    match next_stage(root, asset_id, record) {
        Some(stage) => Ok(matches!(
            stage.recovery()?,
            StageRecovery::Pending | StageRecovery::Finished
        )),
        // A process can stop after saving the last segment and before saving the final view.
        None => Ok(record.segmentation.is_some()),
    }
}

fn cloud_pending(root: &Path, asset_id: &str, record: &Record) -> bool {
    record.full_attempts.last().map_or_else(
        || legacy_can_resume(root, asset_id, record).unwrap_or(true),
        |attempt| !attempt.terminal,
    )
}

fn confirmed_price(
    record: &Record,
    quote: Option<&ConfirmedQuote>,
    expected_credits: Option<i64>,
) -> AppResult<i64> {
    if let Some(quote) = quote {
        if quote.source_hash != record.source_hash {
            return Err(invalid("报价后视频原件已变化，请重新核对后再转录"));
        }
        if let Some(credits) = expected_credits.filter(|credits| *credits > 0) {
            return Ok(credits);
        }
    }
    Err(invalid(QUOTE_REQUIRED))
}

fn fresh_record(source: &CheckedSource, owner: Option<String>) -> Record {
    Record {
        view: VideoTranscript::new(Status::Running),
        source_hash: source.hash.clone(),
        stamp: source.stamp.clone(),
        registration: source.registration.clone(),
        owner,
        attempt: 0,
        current: true,
        segmentation: None,
        full_attempts: vec![],
    }
}

fn merge_segment(
    view: &mut VideoTranscript,
    segment: speech::Segment,
    result: serde_json::Value,
) -> AppResult<()> {
    let duration_ms = segment
        .end_ms
        .checked_sub(segment.start_ms)
        .filter(|duration| *duration > 0)
        .ok_or_else(|| invalid("语音服务返回的分段时间无效，请取回原任务"))?
        as f64;
    let mut parsed = parse_timed_result(result, duration_ms)?;
    let offset = segment.start_ms as f64;
    for utterance in &mut parsed.utterances {
        if utterance.start_ms >= duration_ms {
            return Err(invalid("语音服务返回的分段时间无效，请取回原任务"));
        }
        utterance.start_ms += offset;
        utterance.end_ms = utterance.end_ms.min(duration_ms) + offset;
        for word in &mut utterance.words {
            word.start_ms += segment.start_ms;
            word.end_ms += segment.start_ms;
        }
    }
    if !parsed.text.is_empty() {
        if !view.text.is_empty() {
            view.text.push('\n');
        }
        view.text.push_str(&parsed.text);
        view.utterances.extend(parsed.utterances);
    }
    Ok(())
}

struct TranscriptRun<'a> {
    db: Arc<Database>,
    asset_id: &'a str,
    input: &'a Path,
    root: &'a Path,
    cloud: &'a CloudClient,
    auth: &'a AuthClient,
    owner: &'a str,
    source_duration_seconds: f64,
}

impl TranscriptRun<'_> {
    fn service(&self) -> file_speech::Service<'_> {
        file_speech::Service {
            cloud: self.cloud,
            auth: self.auth,
            owner: self.owner,
        }
    }

    async fn verify(&self, record: &Record) -> AppResult<(FileStamp, Registration)> {
        verify_source(
            self.db.clone(),
            self.asset_id,
            self.input,
            &record.source_hash,
        )
        .await
    }
}

async fn recover_legacy(
    run: &TranscriptRun<'_>,
    record: &mut Record,
) -> AppResult<VideoTranscript> {
    while let Some(stage) = next_stage(run.root, run.asset_id, record) {
        if !matches!(
            stage.recovery()?,
            StageRecovery::Pending | StageRecovery::Finished
        ) {
            return Err(invalid("已取回历史转录，可重新核对费用后获取完整文稿"));
        }
        let result = stage_for_owner(
            &stage.receipts(),
            &stage.key,
            &stage.name,
            None,
            run.owner,
            run.cloud,
            run.auth,
            None,
        )
        .await?;
        let Some(segmentation) = &mut record.segmentation else {
            return parse_result(result);
        };
        let index = record.view.completed_segments.unwrap_or(0);
        merge_segment(&mut record.view, segmentation.plan[index], result)?;
        record.view.completed_segments = Some(index + 1);
        segmentation.segment_attempt = 0;
        save(&run.db, run.asset_id, record, false)?;
    }
    let mut view = record.view.clone();
    view.status = if view.text.is_empty() {
        Status::NoSpeech
    } else {
        Status::Completed
    };
    Ok(view)
}

async fn start_file_speech(
    run: &TranscriptRun<'_>,
    record: &mut Record,
    credits: i64,
) -> AppResult<VideoTranscript> {
    let capability = run.service().capabilities().await?;
    if !capability.available {
        return Err(invalid(file_speech::UNAVAILABLE));
    }
    if capability.credits != Some(credits) {
        return Err(invalid(file_speech::PRICE_CHANGED));
    }
    let source_duration_ms = (run.source_duration_seconds * 1000.0).ceil() as u64;
    if source_duration_ms > capability.max_duration_ms {
        return Err(invalid("视频时长超过当前转录服务上限，请先裁剪后重试"));
    }
    let key = format!("file-speech:{}", uuid::Uuid::new_v4());
    let audio_path = file_speech::audio_path(run.root, &key);
    fs::create_dir_all(audio_path.parent().expect("private audio directory"))?;
    let prepared = async {
        let Some(audio) =
            speech::prepare_full_mp3(run.input, &audio_path, run.source_duration_seconds).await?
        else {
            return Ok(None);
        };
        run.verify(record).await?;
        let bytes = file_speech::read_audio(&audio_path).await?;
        if audio.size_bytes != bytes.len() as u64 {
            return Err(invalid("本机音轨已变化，请重新准备转录"));
        }
        Ok::<_, AppError>(Some(file_speech::Manifest {
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes: audio.size_bytes,
            duration_ms: (audio.duration_seconds * 1000.0).round() as u64,
            source_duration_ms,
        }))
    }
    .await;
    let manifest = match prepared {
        Ok(Some(audio)) => audio,
        Ok(None) => return Ok(VideoTranscript::new(Status::NoAudio)),
        Err(error) => {
            let _ = fs::remove_file(&audio_path);
            return Err(error);
        }
    };
    record.full_attempts.push(file_speech::Attempt {
        key,
        owner: run.owner.to_owned(),
        audio: manifest,
        credits,
        job_id: None,
        terminal: false,
    });
    let previous_view = std::mem::replace(&mut record.view, VideoTranscript::new(Status::Running));
    if let Err(error) = save(&run.db, run.asset_id, record, false) {
        record.full_attempts.pop();
        record.view = previous_view;
        let _ = fs::remove_file(&audio_path);
        return Err(error);
    }
    run_file_speech(run, record, true).await
}

async fn run_file_speech(
    run: &TranscriptRun<'_>,
    record: &mut Record,
    create: bool,
) -> AppResult<VideoTranscript> {
    use file_speech::Preparation;
    let service = run.service();
    let original = {
        let attempt = record
            .full_attempts
            .last()
            .expect("active file speech attempt");
        let found = if create {
            None
        } else {
            service.lookup(attempt).await?
        };
        if let Some(job) = found {
            job
        } else {
            // Only explicit recovery after a read-only 404 can re-enter prepare.
            // It must retain the persisted key, manifest and confirmed tariff.
            run.verify(record).await?;
            match service.prepare(attempt).await {
                Ok(Preparation::Original(job)) => job,
                Ok(Preparation::Rejected(error)) => {
                    // Only the initial explicit rejection or the database quote
                    // gate (serialized against this key) can rule out an older acceptance.
                    if create
                        || matches!(&error, AppError::Other(message) if message == file_speech::PRICE_CHANGED)
                    {
                        record
                            .full_attempts
                            .last_mut()
                            .expect("active file speech attempt")
                            .terminal = true;
                    }
                    return Err(error);
                }
                // A lost reply may have reserved the original job. Lookup is read-only.
                Err(error) => match service.lookup(attempt).await {
                    Ok(Some(job)) => job,
                    _ => return Err(error),
                },
            }
        }
    };
    let attempt = record
        .full_attempts
        .last_mut()
        .expect("active file speech attempt");
    if attempt.job_id.is_none() {
        attempt.job_id = Some(original.job_id.clone());
        save(&run.db, run.asset_id, record, false)?;
    }
    let attempt = record
        .full_attempts
        .last()
        .expect("active file speech attempt");
    let mut job = original;
    if job.status == "uploading" {
        job = complete_file_upload(run, record, attempt, job).await?;
    }
    let source_duration_ms = attempt.audio.source_duration_ms as f64;
    for _ in 0..360 {
        match job.status.as_str() {
            "succeeded" => {
                let Some(text) = job.text.as_ref() else {
                    record
                        .full_attempts
                        .last_mut()
                        .expect("active file speech attempt")
                        .terminal = true;
                    return Err(job.message("原转录结果已过期"));
                };
                return parse_full_result(text, source_duration_ms);
            }
            "failed" | "cancelled" => {
                record
                    .full_attempts
                    .last_mut()
                    .expect("active file speech attempt")
                    .terminal = true;
                return Err(job.message("原转录已结束，可以重新核对费用"));
            }
            "queued" | "leased" | "running" | "cancel_requested" => {}
            _ => return Err(job.message("原转录任务状态未确认，请稍后恢复")),
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        job = service.get(&job.job_id).await?;
    }
    Err(invalid("转录仍在进行，请稍后按原任务恢复"))
}

async fn complete_file_upload(
    run: &TranscriptRun<'_>,
    record: &Record,
    attempt: &file_speech::Attempt,
    candidate: file_speech::Job,
) -> AppResult<file_speech::Job> {
    let service = run.service();
    let repair_manifest = match service.commit(&candidate.job_id).await {
        Ok(committed) if committed.status != "uploading" => return Ok(committed),
        Ok(_) => false,
        // A prepare can reserve the original key before its manifest is written.
        Err(_) if candidate.upload_url.is_none() => true,
        Err(error) => return Err(error),
    };
    run.verify(record).await?;
    let signed = if candidate.upload_url.is_some() {
        candidate
    } else {
        match service.prepare(attempt).await? {
            file_speech::Preparation::Original(job) => job,
            file_speech::Preparation::Rejected(error) => return Err(error),
        }
    };
    if signed.status != "uploading" {
        return Ok(signed);
    }
    if repair_manifest {
        let committed = service.commit(&signed.job_id).await?;
        if committed.status != "uploading" {
            return Ok(committed);
        }
    }
    let audio_path = file_speech::audio_path(run.root, &attempt.key);
    if !audio_path.exists() {
        // A recreated file must still match the manifest's hash during upload.
        speech::prepare_full_mp3(run.input, &audio_path, run.source_duration_seconds).await?;
        run.verify(record).await?;
    }
    let bytes = file_speech::read_audio(&audio_path).await?;
    let sent = service.upload(&signed, &attempt.audio, bytes).await;
    let committed = service.commit(&signed.job_id).await?;
    if committed.status == "uploading" {
        sent?;
        return Err(invalid("云端尚未确认收到音轨，请按原任务恢复"));
    }
    Ok(committed)
}

#[tauri::command]
pub async fn video_transcript_get(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    auth: State<'_, AuthClient>,
    asset_id: String,
) -> AppResult<Option<VideoTranscript>> {
    let db = db.inner().clone();
    let root = paths.root.clone();
    let owner = auth.snapshot().user_id;
    tokio::task::spawn_blocking(move || current_view(&db, &root, &asset_id, owner.as_deref()))
        .await
        .map_err(|_| invalid("无法读取视频转录"))?
}

async fn refresh_completed_timing(
    db: Arc<Database>,
    root: &Path,
    asset_id: &str,
    service: file_speech::Service<'_>,
) -> AppResult<VideoTranscript> {
    let _activity = {
        let _start = STARTS.lock().await;
        let key = (root.to_owned(), asset_id.to_owned());
        if !ACTIVE.lock().unwrap().insert(key.clone()) {
            return Err(invalid("视频转录正在处理，请稍后补齐字词时间"));
        }
        Activity(key)
    };
    let record =
        load(&db, asset_id, None)?.ok_or_else(|| invalid("当前原件没有可补齐的转录文稿"))?;
    let attempt = record
        .timing_attempt(service.owner)
        .ok_or_else(|| invalid("请使用转录原账号和原件补齐字词时间"))?;
    let input = source(&db, asset_id)?;
    let (stamp, registered) =
        verify_source(db.clone(), asset_id, &input, &record.source_hash).await?;
    if stamp != record.stamp || !record.matches_registration(&registered) {
        return Err(invalid("视频原件已变化，请保留现有转录文稿"));
    }
    let job = service
        .lookup(attempt)
        .await?
        .filter(|job| job.status == "succeeded")
        .ok_or_else(|| invalid("原转录结果暂不可用，请稍后再试"))?;
    let text = job
        .text
        .as_deref()
        .ok_or_else(|| invalid("原转录结果已过期，已保留本机文稿"))?;
    let timings = parse_full_result(text, attempt.audio.source_duration_ms as f64)?;
    let (after_stamp, after_registration) =
        verify_source(db.clone(), asset_id, &input, &record.source_hash).await?;
    if after_stamp != stamp || after_registration != registered {
        return Err(invalid("视频原件已变化，请保留现有转录文稿"));
    }
    if service.auth.snapshot().user_id.as_deref() != Some(service.owner) {
        return Err(invalid("账号已切换，请使用转录原账号补齐字词时间"));
    }

    let mut conn = db.conn.lock().unwrap();
    let transaction = conn.transaction()?;
    let id = record_id(asset_id, &record.source_hash);
    let raw = transaction
        .query_row(
            "SELECT payload FROM analyses WHERE id=?1 AND json_extract(payload,'$.current')=1",
            [&id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| invalid("视频文稿已变化，请刷新预览后再试"))?;
    let mut local: Record = serde_json::from_str(&raw)?;
    if local.stamp != stamp
        || !local.matches_registration(&registered)
        || !local
            .timing_attempt(service.owner)
            .is_some_and(|latest| latest.key == attempt.key && latest.job_id == attempt.job_id)
    {
        return Err(invalid("视频文稿已变化，请刷新预览后再试"));
    }
    if timings.status != Status::Completed
        || local.view.text != timings.text
        || local.view.utterances.len() != timings.utterances.len()
        || local
            .view
            .utterances
            .iter()
            .zip(&timings.utterances)
            .any(|(old, new)| {
                old.text != new.text || old.start_ms != new.start_ms || old.end_ms != new.end_ms
            })
    {
        return Err(invalid("原转录正文或句段时间与本机不一致，已保留现有文稿"));
    }
    if timings.utterances.iter().all(|line| line.words.is_empty()) {
        return Err(invalid("原转录目前没有可补齐的字词时间，已保留现有文稿"));
    }
    let mut payload: serde_json::Value = serde_json::from_str(&raw)?;
    for (index, (old, new)) in local
        .view
        .utterances
        .iter_mut()
        .zip(timings.utterances)
        .enumerate()
    {
        if !new.words.is_empty() {
            old.words = new.words;
            payload["utterances"][index]["words"] = serde_json::to_value(&old.words)?;
        }
    }
    transaction.execute(
        "UPDATE analyses SET payload=?1 WHERE id=?2",
        params![serde_json::to_string(&payload)?, id],
    )?;
    transaction.commit()?;
    local.view.can_refresh_timing = None;
    Ok(local.view)
}

#[tauri::command]
pub async fn video_transcript_refresh_timing(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    asset_id: String,
    expected_user_id: Option<String>,
) -> AppResult<VideoTranscript> {
    let owner = auth
        .snapshot()
        .user_id
        .filter(|owner| {
            expected_user_id
                .as_ref()
                .is_none_or(|expected| expected == owner)
        })
        .ok_or_else(|| invalid("请登录转录原账号后补齐字词时间"))?;
    let view = refresh_completed_timing(
        db.inner().clone(),
        &paths.root,
        &asset_id,
        file_speech::Service {
            cloud: &cloud,
            auth: &auth,
            owner: &owner,
        },
    )
    .await?;
    let _ = app.emit("library://assets-changed", ());
    Ok(view)
}

#[tauri::command]
pub async fn video_transcript_capabilities(
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
) -> AppResult<file_speech::Capabilities> {
    let Some(owner) = auth.snapshot().user_id else {
        return Ok(file_speech::Capabilities {
            available: false,
            credits: None,
            max_duration_ms: (speech::MAX_FULL_AUDIO_SECONDS * 1000.0) as u64,
            reason: None,
        });
    };
    file_speech::Service {
        cloud: &cloud,
        auth: &auth,
        owner: &owner,
    }
    .capabilities()
    .await
}

#[tauri::command]
pub async fn video_transcript_quote(
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    asset_id: String,
) -> AppResult<TranscriptQuote> {
    let db = db.inner().clone();
    let root = paths.root.clone();
    let source = check_source(db.clone(), asset_id.clone()).await?;
    let record =
        load(&db, &asset_id, Some(&source.hash))?.unwrap_or_else(|| fresh_record(&source, None));
    let running = ACTIVE
        .lock()
        .unwrap()
        .contains(&(root.clone(), asset_id.clone()));
    let pending =
        !running && !record.view.is_complete() && cloud_pending(&root, &asset_id, &record);
    let candidate = !record.view.is_complete() && !pending && !running;
    let no_audio = record.view.status == Status::NoAudio
        || (candidate && !speech::has_audio_track(&source.path).await?);
    if FileStamp::read(&source.path).as_ref().ok() != Some(&source.stamp) {
        return Err(invalid("读取期间视频已变化，请重新获取报价"));
    }
    Ok(TranscriptQuote {
        source_hash: source.hash,
        duration_seconds: source.duration_seconds,
        charge_required: candidate && !no_audio,
        cloud_pending: pending,
        no_audio,
    })
}

#[tauri::command]
pub async fn video_transcript_start(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    paths: State<'_, Arc<LibraryPaths>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    asset_id: String,
    expected_user_id: Option<String>,
    expected_credits: Option<i64>,
    quote: Option<ConfirmedQuote>,
) -> AppResult<VideoTranscript> {
    let owner = auth.snapshot().user_id;
    if expected_user_id.is_some() && expected_user_id != owner {
        return Err(invalid("账号已切换，请用原账号继续视频转录"));
    }
    let root = paths.root.clone();
    let key = (root.clone(), asset_id.clone());
    let checked = check_source(db.inner().clone(), asset_id.clone()).await;
    let _start = STARTS.lock().await;
    if ACTIVE.lock().unwrap().contains(&key) {
        return Ok(load(&db, &asset_id, None)?.map_or_else(
            || VideoTranscript::new(Status::Running),
            |record| record.view,
        ));
    }
    let checked = match checked {
        Ok(source) => source,
        Err(error) => {
            let pending = load(&db, &asset_id, None)?
                .is_some_and(|record| cloud_pending(&root, &asset_id, &record));
            let message = if pending {
                "原视频暂不可用，请恢复原件后取回已提交的转录".to_owned()
            } else {
                error.to_string()
            };
            return Ok(VideoTranscript::interrupted(&message, pending));
        }
    };
    let mut record = load(&db, &asset_id, Some(&checked.hash))?
        .unwrap_or_else(|| fresh_record(&checked, owner.clone()));
    record.stamp = checked.stamp.clone();
    record.registration = checked.registration;
    record.current = true;
    if record.view.is_complete() {
        save(&db, &asset_id, &record, true)?;
        let _ = app.emit("library://assets-changed", ());
        return Ok(record.view);
    }
    let resume = cloud_pending(&root, &asset_id, &record);
    let Some(owner) = owner else {
        return Ok(VideoTranscript::interrupted(
            "请登录 Bowerbird 后转录视频",
            resume,
        ));
    };
    let credits = if resume {
        let original_owner = record
            .full_attempts
            .last()
            .map(|attempt| attempt.owner.as_str())
            .or(record.owner.as_deref());
        if original_owner != Some(owner.as_str()) {
            return Ok(VideoTranscript::interrupted(
                "此视频有待取回的转录，请登录原账号后继续",
                true,
            ));
        }
        None
    } else {
        if quote
            .as_ref()
            .is_some_and(|quote| quote.source_hash == record.source_hash)
            && !speech::has_audio_track(&checked.path).await?
        {
            if FileStamp::read(&checked.path).as_ref().ok() != Some(&checked.stamp) {
                return Ok(VideoTranscript::interrupted(
                    "读取期间视频已变化，请重新获取报价",
                    false,
                ));
            }
            record.view = VideoTranscript::new(Status::NoAudio);
            save(&db, &asset_id, &record, true)?;
            let _ = app.emit("library://assets-changed", ());
            return Ok(record.view);
        }
        match confirmed_price(&record, quote.as_ref(), expected_credits) {
            Ok(credits) => Some(credits),
            Err(error) => {
                record.view.interrupt(&error.to_string(), false);
                record.view.quote_required = Some(true);
                return Ok(record.view);
            }
        }
    };
    record.view.status = Status::Running;
    record.view.error = None;
    record.view.cloud_pending = None;
    record.view.quote_required = None;
    record.view.price_changed = None;
    let running = record.view.clone();
    save(&db, &asset_id, &record, true)?;
    ACTIVE.lock().unwrap().insert(key.clone());
    let activity = Activity(key);
    let db = db.inner().clone();
    let cloud = cloud.inner().clone();
    let auth = auth.inner().clone();
    tauri::async_runtime::spawn(async move {
        let _activity = activity;
        let run = TranscriptRun {
            db: db.clone(),
            asset_id: &asset_id,
            input: &checked.path,
            root: &root,
            cloud: &cloud,
            auth: &auth,
            owner: &owner,
            source_duration_seconds: checked.duration_seconds,
        };
        let result = async {
            let outcome = match credits {
                Some(credits) => start_file_speech(&run, &mut record, credits).await?,
                None if record.full_attempts.is_empty() => {
                    recover_legacy(&run, &mut record).await?
                }
                None => run_file_speech(&run, &mut record, false).await?,
            };
            let (stamp, registered) = run.verify(&record).await?;
            record.stamp = stamp;
            record.registration = registered;
            Ok::<_, AppError>(outcome)
        }
        .await;
        match result {
            Ok(value) => {
                record.view = value;
                if let Some(attempt) = record.full_attempts.last_mut() {
                    attempt.terminal = true;
                }
            }
            Err(error) => {
                tracing::warn!(asset = %asset_id, %error, "video transcription did not complete");
                let message = match &error {
                    AppError::Other(message) if !message.starts_with("json:") => message.as_str(),
                    AppError::Cloud(_) => "转录连接中断，请按原任务状态恢复",
                    _ => "无法完成视频转录，请检查原件或音频工具后重试",
                };
                let pending = cloud_pending(&root, &asset_id, &record);
                record.view.interrupt(message, pending);
                if message == file_speech::PRICE_CHANGED {
                    record.view.price_changed = Some(true);
                }
            }
        }
        if let Err(error) = save_final(&db, &root, &asset_id, &record) {
            tracing::warn!(asset = %asset_id, %error, "could not save video transcription");
        }
        let _ = app.emit("library://assets-changed", ());
    });
    Ok(running)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::{catalog_browser::CatalogFilter, external_files::fingerprint};
    use serde_json::json;

    fn row(source_hash: &str, status: Status, db: &Database, path: &Path) -> Record {
        Record {
            view: VideoTranscript::new(status),
            source_hash: source_hash.into(),
            stamp: FileStamp::read(path).unwrap(),
            registration: registration(db, "vid").unwrap(),
            owner: Some("original-owner".into()),
            attempt: 0,
            current: true,
            segmentation: None,
            full_attempts: vec![],
        }
    }

    #[test]
    fn video_transcript_search_matches_text_and_exclusions_with_library_scope_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vid.mp4");
        fs::write(&path, b"fixture").unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("p", "p", "/p", "/p", "user").unwrap();
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,ext,created_at,store_path,size,file_mtime) VALUES('vid','movie','mp4',10,?1,7,4)",
            [path.to_str().unwrap()],
        ).unwrap();
        let mut first = row("hash-a", Status::Completed, &db, &path);
        first.view = parse_result(json!({
            "text": "窗边风景 100%_中文",
            "utterances": [{
                "text":"窗边风景 100%_中文","startMs":30,"endMs":225,
                "words":[{"text":"窗边","startMs":50,"endMs":85}]
            }]
        }))
        .unwrap();
        save(&db, "vid", &first, true).unwrap();
        let ids = |query: &str, project: Option<&str>| {
            db.search_assets(query, project, 10)
                .unwrap()
                .into_iter()
                .map(|asset| asset.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids("100%_ 中文", None), ["vid"]);
        assert!(ids("窗边 -风景", None).is_empty());
        assert_eq!(ids("窗边 -未知", None), ["vid"]);
        assert!(ids("窗边", Some("p")).is_empty());
        let filter = CatalogFilter {
            kind: "all".into(),
            media: "videos".into(),
            query: Some("100%_中文".into()),
            ..Default::default()
        };
        assert_eq!(db.catalog_ids(&filter, 0, 10).unwrap(), ["vid"]);
        let loaded = current_view(&db, dir.path(), "vid", None).unwrap().unwrap();
        assert_eq!(loaded.utterances[0].words[0].text, "窗边");
        assert_eq!(loaded.utterances[0].words[0].start_ms, 50);

        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE assets SET file_mtime=5 WHERE id='vid'", [])
            .unwrap();
        assert!(ids("窗边", None).is_empty());
        assert!(db.catalog_ids(&filter, 0, 10).unwrap().is_empty());
        assert!(current_view(&db, dir.path(), "vid", None)
            .unwrap()
            .is_none());

        let second = row("hash-b", Status::Running, &db, &path);
        save(&db, "vid", &second, true).unwrap();
        let reopened = current_view(&db, dir.path(), "vid", None).unwrap().unwrap();
        assert_eq!(reopened.status, Status::Interrupted);
        assert_eq!(reopened.cloud_pending, Some(false));
        let mut reused = load(&db, "vid", Some("hash-a")).unwrap().unwrap();
        assert_eq!(reused.view.status, Status::Completed);
        assert_eq!(reused.view.utterances[0].words[0].end_ms, 85);
        reused.registration = registration(&db, "vid").unwrap();
        reused.current = true;
        save(&db, "vid", &reused, true).unwrap();
        assert_eq!(ids("窗边", None), ["vid"]);
    }

    #[test]
    fn video_transcript_no_speech_timestamps_and_input_validation() {
        let empty = parse_result(json!({"text":"","utterances":[]})).unwrap();
        assert_eq!(empty.status, Status::NoSpeech);
        let row = parse_result(json!({"text":"实际对白","utterances":[{
            "text":"实际对白","startMs":24,"endMs":2324
        }]}))
        .unwrap();
        assert_eq!(row.status, Status::Completed);
        assert_eq!(row.utterances[0].end_ms, 2324.0);
        assert!(row.utterances[0].words.is_empty());
        assert!(serde_json::to_value(&row).unwrap()["utterances"][0]
            .get("words")
            .is_none());
        assert!(parse_result(json!({"text":"缺时间","utterances":[]})).is_err());
        assert!(parse_result(json!({"text":"重叠","utterances":[{"text":"重","startMs":1,"endMs":12},{"text":"叠","startMs":11,"endMs":14}]})).is_err());
    }

    #[test]
    fn video_transcript_words_keep_zero_points_and_fail_soft_on_invalid_arrays() {
        let make = |words| {
            parse_timed_result(
                json!({
                    "text":"片尾。",
                    "utterances":[{"text":"片尾。","startMs":100,"endMs":1120,"words":words}]
                }),
                1000.0,
            )
            .unwrap()
        };
        let current = make(json!([
            {"text":"片","startMs":120,"endMs":120},
            {"text":" ","startMs":-1,"endMs":-1},
            {"text":"尾","startMs":970,"endMs":1060},
            {"text":"。","startMs":1070,"endMs":1080}
        ]));
        let words = &current.utterances[0].words;
        assert_eq!(words.len(), 2);
        assert_eq!((words[0].start_ms, words[0].end_ms), (120, 120));
        assert_eq!((words[1].start_ms, words[1].end_ms), (970, 1000));
        for bad in [
            serde_json::Value::Null,
            json!([{"text":"片","startMs":99,"endMs":120}]),
            json!([{"text":"片","startMs":120.5,"endMs":140}]),
            json!([{"text":"片","startMs":120,"endMs":1121}]),
            json!([{"text":"片","startMs":120,"endMs":140},{"text":"尾","startMs":130,"endMs":200}]),
        ] {
            let degraded = make(bad);
            assert_eq!(degraded.text, "片尾。");
            assert!(degraded.utterances[0].words.is_empty());
        }
    }

    #[test]
    fn video_transcript_legacy_words_clip_before_adding_the_saved_offset() {
        let segment = speech::Segment {
            start_ms: 115_000,
            end_ms: 115_100,
        };
        let result = json!({
            "text":"结束。",
            "utterances":[{"text":"结束。","startMs":75,"endMs":130,"words":[
                {"text":"结","startMs":80,"endMs":80},
                {"text":"束","startMs":85,"endMs":110},
                {"text":"。","startMs":111,"endMs":125}
            ]}]
        });
        let mut view = VideoTranscript::new(Status::Running);
        merge_segment(&mut view, segment, result.clone()).unwrap();
        let line = &view.utterances[0];
        assert_eq!(line.end_ms, 115_100.0);
        assert_eq!(line.words.len(), 2);
        assert_eq!(
            (line.words[0].start_ms, line.words[0].end_ms),
            (115_080, 115_080)
        );
        assert_eq!(
            (line.words[1].start_ms, line.words[1].end_ms),
            (115_085, 115_100)
        );
        let reversed = speech::Segment {
            start_ms: segment.end_ms,
            end_ms: segment.start_ms,
        };
        assert!(merge_segment(&mut view, reversed, result).is_err());
        assert_eq!(view.text, "结束。");
    }

    #[test]
    fn video_transcript_full_quote_requires_confirmed_price_and_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        fs::write(&path, b"fixture").unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,ext) VALUES('vid','fixture','mp4')",
                [],
            )
            .unwrap();
        let record = row("content-v1", Status::Interrupted, &db, &path);
        let quote = ConfirmedQuote {
            source_hash: "content-v1".into(),
        };
        assert_eq!(confirmed_price(&record, Some(&quote), Some(5)).unwrap(), 5);
        assert!(confirmed_price(&record, None, Some(5)).is_err());
        assert!(confirmed_price(&record, Some(&quote), None).is_err());
        assert!(confirmed_price(&record, Some(&quote), Some(0)).is_err());
        let changed = ConfirmedQuote {
            source_hash: "content-v2".into(),
        };
        assert!(confirmed_price(&record, Some(&changed), Some(5)).is_err());

        let legacy = serde_json::to_value(&record).unwrap();
        assert!(legacy.get("fullAttempts").is_none());
        assert!(legacy.get("segmentation").is_none());
        let decoded: Record = serde_json::from_value(legacy).unwrap();
        assert_eq!(
            stage_location(dir.path(), "vid", &decoded),
            stage_location(dir.path(), "vid", &record),
        );
        assert!(!cloud_pending(dir.path(), "vid", &decoded));
    }

    #[tokio::test]
    async fn video_transcript_restarts_at_pending_segment_without_unauthorized_next_charge() {
        use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
        use serde_json::Value;
        type Calls = Arc<Mutex<Vec<Value>>>;
        async fn mock(
            State(calls): State<Calls>,
            Json(request): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            calls.lock().unwrap().push(request.clone());
            let key = request["idempotency_key"].as_str().unwrap_or_default();
            let local_result = |text: &str| {
                json!({
                    "status":"succeeded","job_id":"local-mock",
                    "text":json!({"text":text,"utterances":[{
                        "text":text,"startMs":25,"endMs":225,
                        "words":[{"text":"段","startMs":75,"endMs":125}]
                    }]}).to_string(),
                })
            };
            match request["action"].as_str() {
                Some("replication-capabilities") => (
                    StatusCode::OK,
                    Json(
                        json!({"services":[{"operation":"speech-transcription","available":true,"credits":5}]}),
                    ),
                ),
                Some("create") if key.ends_with(":seg:0:0") => {
                    (StatusCode::OK, Json(local_result("第一段")))
                }
                Some("create") => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error":{"message":"response lost"}})),
                ),
                Some("get-by-key") if key.ends_with(":seg:1:0") => {
                    (StatusCode::OK, Json(local_result("第二段")))
                }
                _ => (StatusCode::BAD_REQUEST, Json(json!({}))),
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        fs::write(&path, b"fixture").unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.migrate().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,ext,store_path) VALUES('vid','fixture','mp4',?1)",
                [path.to_str().unwrap()],
            )
            .unwrap();
        let source = CheckedSource {
            path: path.clone(),
            hash: "source".into(),
            stamp: FileStamp::read(&path).unwrap(),
            registration: registration(&db, "vid").unwrap(),
            duration_seconds: 250.0,
        };
        let plan = speech::plan_segments(250.0).unwrap();
        let calls: Calls = Arc::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/functions/v1/understand-proxy", post(mock))
            .with_state(calls.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let cloud = CloudClient::new(crate::cloud::config::CloudConfig {
            supabase_url: Some(url),
            supabase_publishable_key: Some("local-test".into()),
            account_api_url: None,
        })
        .unwrap();
        let auth = AuthClient::with_test_session(cloud.clone());
        let mut initial = fresh_record(&source, Some("test-user".into()));
        initial.segmentation = Some(Segmentation {
            plan: plan.clone(),
            segment_attempt: 0,
        });
        initial.view.total_segments = Some(plan.len());
        let first = next_stage(dir.path(), "vid", &initial).unwrap();
        let request =
            json!({"operation":"speech-transcription","image":null,"audio":{"base64":"mock"}});
        let first_result = stage_for_owner(
            &first.receipts(),
            &first.key,
            &first.name,
            Some(request.clone()),
            "test-user",
            &cloud,
            &auth,
            Some(5),
        )
        .await
        .unwrap();
        merge_segment(&mut initial.view, plan[0], first_result).unwrap();
        initial.view.completed_segments = Some(1);
        let second = next_stage(dir.path(), "vid", &initial).unwrap();
        assert!(stage_for_owner(
            &second.receipts(),
            &second.key,
            &second.name,
            Some(request),
            "test-user",
            &cloud,
            &auth,
            Some(5)
        )
        .await
        .is_err());
        save(&db, "vid", &initial, true).unwrap();

        let reopened = current_view(&db, dir.path(), "vid", None).unwrap().unwrap();
        assert_eq!(reopened.status, Status::Interrupted);
        assert_eq!(reopened.completed_segments, Some(1));
        assert_eq!(reopened.cloud_pending, Some(true));
        let mut record = load(&db, "vid", Some("source")).unwrap().unwrap();
        let run = TranscriptRun {
            db: db.clone(),
            asset_id: "vid",
            input: &path,
            root: dir.path(),
            cloud: &cloud,
            auth: &auth,
            owner: "test-user",
            source_duration_seconds: 250.0,
        };
        auth.set_test_user("other-account");
        assert!(recover_legacy(&run, &mut record)
            .await
            .unwrap_err()
            .to_string()
            .contains("账号"));
        assert_eq!(calls.lock().unwrap().len(), 4);
        auth.set_test_user("test-user");
        assert_eq!(
            recover_legacy(&run, &mut record)
                .await
                .unwrap_err()
                .to_string(),
            "已取回历史转录，可重新核对费用后获取完整文稿"
        );
        assert_eq!(record.view.completed_segments, Some(2));
        assert_eq!(record.view.text, "第一段\n第二段");
        assert_eq!(record.view.utterances[1].start_ms, 115_025.0);
        assert_eq!(
            (
                record.view.utterances[1].words[0].start_ms,
                record.view.utterances[1].words[0].end_ms
            ),
            (115_075, 115_125)
        );
        assert_eq!(
            load(&db, "vid", Some("source"))
                .unwrap()
                .unwrap()
                .view
                .completed_segments,
            Some(2)
        );
        assert_eq!(calls.lock().unwrap().len(), 5);
        assert_eq!(
            calls.lock().unwrap()[4],
            json!({"action":"get-by-key","idempotency_key":second.key})
        );
        assert!(!cloud_pending(dir.path(), "vid", &record));
        server.abort();
    }

    #[tokio::test]
    async fn video_transcript_refresh_reads_the_original_job_and_writes_only_verified_word_times() {
        use axum::{extract::State, routing::post, Json, Router};
        use serde_json::Value;
        const JOB: &str = "12345678-1234-4123-8123-123456789abc";
        const KEY: &str = "file-speech:12345678-1234-4123-8123-123456789def";
        type Replies = Arc<Mutex<(Vec<Value>, Value)>>;
        async fn mock(State(replies): State<Replies>, Json(request): Json<Value>) -> Json<Value> {
            let mut replies = replies.lock().unwrap();
            replies.0.push(request);
            Json(replies.1.clone())
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        fs::write(&path, b"synthetic fixture").unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.migrate().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,ext,store_path) VALUES('vid','fixture','mp4',?1)",
                [path.to_str().unwrap()],
            )
            .unwrap();
        let hash = fingerprint(&path).unwrap();
        let mut saved = row(&hash, Status::Completed, &db, &path);
        saved.view = parse_full_result(
            r#"{"text":"乙。","utterances":[{"text":"乙。","startMs":1,"endMs":500}]}"#,
            1000.0,
        )
        .unwrap();
        saved.full_attempts.push(file_speech::Attempt {
            key: KEY.into(),
            owner: "test-user".into(),
            credits: 1,
            audio: file_speech::Manifest {
                sha256: "0".repeat(64),
                bytes: 42,
                duration_ms: 1000,
                source_duration_ms: 1000,
            },
            job_id: Some(JOB.into()),
            terminal: true,
        });
        save(&db, "vid", &saved, true).unwrap();
        let id = record_id("vid", &hash);
        db.conn.lock().unwrap().execute(
            "UPDATE analyses SET payload=json_set(payload,'$.utterances[0].futureField','retained') WHERE id=?1",
            [&id],
        ).unwrap();
        let eligible = |owner| {
            current_view(&db, dir.path(), "vid", owner)
                .unwrap()
                .unwrap()
                .can_refresh_timing
        };
        assert_eq!(eligible(None), None);
        assert_eq!(eligible(Some("another-user")), None);
        assert_eq!(eligible(Some("test-user")), Some(true));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let result = |job, sentence_start| {
            json!({"job_id":job,"status":"succeeded","text":json!({
            "text":"乙。","utterances":[{"text":"乙。","startMs":sentence_start,"endMs":500,
                "words":[{"text":"乙","startMs":92,"endMs":150}]}]
        }).to_string()})
        };
        let replies = Arc::new(Mutex::new((vec![], result(JOB, 2))));
        let router = Router::new()
            .route("/functions/v1/understand-proxy", post(mock))
            .with_state(replies.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let cloud = CloudClient::new(crate::cloud::config::CloudConfig {
            supabase_url: Some(url),
            supabase_publishable_key: Some("local-test".into()),
            account_api_url: None,
        })
        .unwrap();
        let auth = AuthClient::with_test_session(cloud.clone());
        let refresh = |owner| {
            refresh_completed_timing(
                db.clone(),
                dir.path(),
                "vid",
                file_speech::Service {
                    cloud: &cloud,
                    auth: &auth,
                    owner,
                },
            )
        };
        let active = (dir.path().to_owned(), "vid".to_owned());
        ACTIVE.lock().unwrap().insert(active.clone());
        let activity = Activity(active);
        assert!(refresh("test-user").await.is_err());
        drop(activity);
        assert!(refresh("another-user").await.is_err());
        assert!(replies.lock().unwrap().0.is_empty());
        assert!(refresh("test-user").await.is_err()); // Sentence clock differs.
        replies.lock().unwrap().1 = result("12345678-1234-4123-8123-123456789fff", 1);
        assert!(refresh("test-user").await.is_err()); // The returned UUID differs.
        assert_eq!(eligible(Some("test-user")), Some(true));
        replies.lock().unwrap().1 = result(JOB, 1);
        let repaired = refresh("test-user").await.unwrap();
        assert_eq!(repaired.text, "乙。");
        assert_eq!(repaired.utterances[0].words[0].start_ms, 92);
        assert_eq!(eligible(Some("test-user")), None);
        let persisted: Value =
            serde_json::from_str(&db.get_analysis(&id).unwrap().unwrap().payload).unwrap();
        assert_eq!(persisted["utterances"][0]["futureField"], "retained");
        assert_eq!(persisted["utterances"][0]["words"][0]["endMs"], 150);
        assert_eq!(
            replies.lock().unwrap().0,
            vec![json!({"action":"get-by-key","idempotency_key":KEY}); 3]
        );
        server.abort();
    }

    #[tokio::test]
    async fn video_transcript_full_resume_reuses_original_key_and_keeps_final_timestamp() {
        use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
        use serde_json::Value;
        const JOB: &str = "12345678-1234-4123-8123-123456789abc";
        const KEY: &str = "file-speech:12345678-1234-4123-8123-123456789def";
        type Calls = Arc<Mutex<Vec<Value>>>;
        async fn mock(
            State(calls): State<Calls>,
            Json(request): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            let mut calls = calls.lock().unwrap();
            calls.push(request.clone());
            match request["action"].as_str() {
                Some("file-speech-prepare") if calls.len() == 1 => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error":{"message":"response lost"}})),
                ),
                Some("get-by-key") => (
                    StatusCode::NOT_FOUND,
                    Json(json!({"error":{"code":"invalid_request","message":"not found"}})),
                ),
                Some("file-speech-prepare") => (
                    StatusCode::ACCEPTED,
                    Json(json!({"job_id": JOB, "status":"uploading"})),
                ),
                Some("file-speech-commit") if calls.len() == 5 => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error":{"message":"manifest missing"}})),
                ),
                Some("file-speech-commit") => (
                    StatusCode::OK,
                    Json(json!({"job_id": JOB, "status":"succeeded", "text":json!({
                        "text": "片尾对白",
                        "utterances": [{
                            "text":"片尾对白", "startMs": 7198000, "endMs": 7200120,
                            "words":[
                                {"text":"片尾","startMs":7198000,"endMs":7199220},
                                {"text":"对白","startMs":7199800,"endMs":7200060}
                            ]
                        }],
                    }).to_string()})),
                ),
                _ => (StatusCode::BAD_REQUEST, Json(json!({}))),
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        fs::write(&path, b"fixture").unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.migrate().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,ext,store_path) VALUES('vid','fixture','mp4',?1)",
                [path.to_str().unwrap()],
            )
            .unwrap();
        let hash = fingerprint(&path).unwrap();
        let path = source(&db, "vid").unwrap();
        let mut record = row(&hash, Status::Running, &db, &path);
        let scratch = file_speech::audio_path(dir.path(), KEY);
        fs::create_dir_all(scratch.parent().unwrap()).unwrap();
        fs::write(&scratch, b"local scratch").unwrap();
        record.full_attempts.push(file_speech::Attempt {
            key: KEY.into(),
            owner: "test-user".into(),
            credits: 5,
            audio: file_speech::Manifest {
                sha256: "0".repeat(64),
                bytes: 28_800_512,
                duration_ms: 7_200_120,
                source_duration_ms: 7_200_000,
            },
            job_id: None,
            terminal: false,
        });
        save(&db, "vid", &record, true).unwrap();
        let calls: Calls = Arc::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/functions/v1/understand-proxy", post(mock))
            .with_state(calls.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let cloud = CloudClient::new(crate::cloud::config::CloudConfig {
            supabase_url: Some(url),
            supabase_publishable_key: Some("local-test".into()),
            account_api_url: None,
        })
        .unwrap();
        let auth = AuthClient::with_test_session(cloud.clone());
        let run = TranscriptRun {
            db: db.clone(),
            asset_id: "vid",
            input: &path,
            root: dir.path(),
            cloud: &cloud,
            auth: &auth,
            owner: "test-user",
            source_duration_seconds: 7200.0,
        };
        assert!(run_file_speech(&run, &mut record, true).await.is_err());
        assert_eq!(calls.lock().unwrap().len(), 2);
        save_final(&db, dir.path(), "vid", &record).unwrap();
        assert_eq!(fs::read(&scratch).unwrap(), b"local scratch");
        let mut reopened = load(&db, "vid", Some(&hash)).unwrap().unwrap();
        assert!(cloud_pending(dir.path(), "vid", &reopened));
        auth.set_test_user("another-user");
        assert!(run_file_speech(&run, &mut reopened, false).await.is_err());
        assert_eq!(calls.lock().unwrap().len(), 2);
        auth.set_test_user("test-user");
        let result = run_file_speech(&run, &mut reopened, false).await.unwrap();
        assert_eq!(result.status, Status::Completed);
        assert_eq!(result.utterances[0].start_ms, 7_198_000.0);
        assert_eq!(result.utterances[0].end_ms, 7_200_000.0);
        assert_eq!(result.utterances[0].words[1].end_ms, 7_200_000);
        let persisted = load(&db, "vid", Some(&hash)).unwrap().unwrap();
        assert_eq!(persisted.full_attempts.len(), 1);
        assert_eq!(persisted.full_attempts[0].job_id.as_deref(), Some(JOB));
        reopened.view = result;
        reopened.full_attempts[0].terminal = true;
        save_final(&db, dir.path(), "vid", &reopened).unwrap();
        assert!(!scratch.exists());
        let sent = calls.lock().unwrap();
        assert_eq!(sent.len(), 7);
        assert_eq!(
            sent[1],
            json!({"action":"get-by-key","idempotency_key":KEY})
        );
        assert_eq!(sent[1], sent[2]);
        assert_eq!(sent[0]["idempotency_key"], KEY);
        assert_eq!(sent[0]["expected_credits"], 5);
        assert_eq!(sent[0], sent[3]);
        assert_eq!(sent[0], sent[5]);
        assert_eq!(sent[4], json!({"action":"file-speech-commit","job_id":JOB}));
        assert_eq!(sent[4], sent[6]);
        server.abort();
    }

    #[tokio::test]
    async fn video_transcript_relink_does_not_validate_audio_from_the_previous_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        let moved = dir.path().join("moved.mp4");
        fs::write(&path, b"expected").unwrap();
        fs::write(&moved, b"expected").unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.migrate().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO assets(id,name,ext,store_path) VALUES('vid','fixture','mp4',?1)",
                [path.to_str().unwrap()],
            )
            .unwrap();
        let (input, hash, _) = snapshot_source(&db, "vid").unwrap();
        verify_source(db.clone(), "vid", &input, &hash)
            .await
            .unwrap();
        fs::write(&path, b"different").unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE assets SET store_path=?1 WHERE id='vid'",
                [moved.to_str().unwrap()],
            )
            .unwrap();
        assert!(verify_source(db.clone(), "vid", &input, &hash)
            .await
            .is_err());
        let (new_input, _, _) = snapshot_source(&db, "vid").unwrap();
        verify_source(db, "vid", &new_input, &hash).await.unwrap();
    }
}
