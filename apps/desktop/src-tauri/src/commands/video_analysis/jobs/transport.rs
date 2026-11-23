use super::{invalid, AppResult, AuthClient, CloudClient, Record, SEGMENT_MS};
use crate::media::tools::{self, Tool};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};
use uuid::Uuid;

const MAX_BYTES: u64 = 32_000_000;
const MEDIA_NAME: &str = "visual-input.mp4";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    available: bool,
    pub(super) credits_per_hour: Option<i64>,
    pub(super) pricing_version: Option<i64>,
    max_segment_duration_ms: u64,
}

impl Capabilities {
    pub(super) fn closed() -> Self {
        Self {
            available: false,
            credits_per_hour: None,
            pricing_version: None,
            max_segment_duration_ms: SEGMENT_MS,
        }
    }
}

#[derive(Deserialize, Serialize)]
pub(super) struct Manifest {
    mime: String,
    bytes: u64,
    sha256: String,
    duration_ms: u64,
    start_ms: u64,
    end_ms: u64,
    source_duration_ms: u64,
}

#[derive(Deserialize)]
pub(super) struct Job {
    pub(super) job_id: String,
    pub(super) status: String,
    pub(super) text: Option<String>,
    upload_url: Option<String>,
}

impl Job {
    pub(super) fn has_upload_url(&self) -> bool {
        self.upload_url.is_some()
    }
}

pub(super) enum Preparation {
    Accepted(Job),
    Rejected {
        error: crate::error::AppError,
        price_changed: bool,
    },
}

pub(super) struct Service<'a> {
    pub(super) cloud: &'a CloudClient,
    pub(super) auth: &'a AuthClient,
    pub(super) owner: &'a str,
}

impl Service<'_> {
    async fn request(&self, body: Value) -> AppResult<(StatusCode, Value)> {
        let endpoint = self
            .cloud
            .config()
            .endpoint("understand-proxy")
            .ok_or_else(|| invalid("当前构建未配置 Bowerbird Cloud"))?;
        let response = self
            .auth
            .send_authorized_for_user(
                self.cloud.http().post(endpoint).json(&body),
                "读取云端画面分析任务失败",
                self.owner,
            )
            .await?;
        let status = response.status();
        let value = response
            .json()
            .await
            .map_err(|_| invalid("云端返回异常，请按原任务恢复"))?;
        Ok((status, value))
    }

    pub(super) async fn capabilities(&self) -> AppResult<Capabilities> {
        let (status, value) = self
            .request(json!({"action":"library-visual-capabilities"}))
            .await?;
        if !status.is_success()
            || value["available"].as_bool() != Some(true)
            || value["max_segment_duration_ms"].as_u64() != Some(SEGMENT_MS)
        {
            return Ok(Capabilities::closed());
        }
        let credits = value["credits_per_hour"]
            .as_i64()
            .filter(|value| *value > 0);
        let version = value["pricing_version"].as_i64().filter(|value| *value > 0);
        match (credits, version) {
            (Some(credits), Some(version)) => Ok(Capabilities {
                available: true,
                credits_per_hour: Some(credits),
                pricing_version: Some(version),
                max_segment_duration_ms: SEGMENT_MS,
            }),
            _ => Ok(Capabilities::closed()),
        }
    }

    pub(super) async fn lookup(&self, key: &str, id: Option<&str>) -> AppResult<Option<Job>> {
        let (status, value) = self
            .request(json!({"action":"get-by-key","idempotency_key":key}))
            .await?;
        if status == StatusCode::NOT_FOUND
            && id.is_none()
            && value.pointer("/error/code").and_then(Value::as_str) == Some("invalid_request")
        {
            return Ok(None);
        }
        parse_response(status, value, id).map(Some)
    }

    pub(super) async fn prepare(
        &self,
        record: &Record,
        key: &str,
        video: &Manifest,
    ) -> AppResult<Preparation> {
        let (status, value) = self.request(json!({
            "action":"library-visual-prepare", "idempotency_key":key, "parent_key":record.parent_key,
            "expected_credits":record.credits, "pricing_version":record.pricing_version, "video":video,
        })).await?;
        let code = value
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let price_changed = status == StatusCode::CONFLICT
            && code == "invalid_request"
            && value.pointer("/error/message").and_then(Value::as_str)
                == Some("画面分析报价已变化");
        if price_changed
            || matches!(
                (status.as_u16(), code),
                (400, "invalid_request")
                    | (401, "unauthorized")
                    | (402, "insufficient_credits")
                    | (403, "forbidden")
                    | (503, "not_configured")
            )
        {
            return Ok(Preparation::Rejected {
                error: response_error(&value),
                price_changed,
            });
        }
        parse_response(status, value, None).map(Preparation::Accepted)
    }

    pub(super) async fn upload(
        &self,
        job: &Job,
        manifest: &Manifest,
        proxy: &Path,
    ) -> AppResult<()> {
        if self.auth.snapshot().user_id.as_deref() != Some(self.owner) {
            return Err(invalid("账号已切换，请登录原账号后继续画面分析"));
        }
        let url = job
            .upload_url
            .as_deref()
            .ok_or_else(|| invalid("原任务未提供代理上传地址"))?;
        let parsed = reqwest::Url::parse(url).map_err(|_| invalid("原任务的上传地址无效"))?;
        if parsed.path()
            != format!(
                "/storage/v1/object/upload/sign/generation-temp/understand/{}/inputs/{MEDIA_NAME}",
                job.job_id
            )
        {
            return Err(invalid("原任务的上传地址不匹配"));
        }
        let url = self
            .cloud
            .config()
            .generation_transfer_url(url, true)
            .ok_or_else(|| invalid("原任务的上传地址无效"))?;
        let bytes = read_proxy(proxy).await?;
        if bytes.len() as u64 != manifest.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != manifest.sha256
        {
            return Err(invalid("本机画面代理已变化，请检查原任务后恢复"));
        }
        if self.auth.snapshot().user_id.as_deref() != Some(self.owner) {
            return Err(invalid("账号已切换，请登录原账号后继续画面分析"));
        }
        let response = self
            .cloud
            .http()
            .put(url)
            .header("content-type", "video/mp4")
            .body(bytes)
            .send()
            .await
            .map_err(|_| invalid("画面代理上传未确认，请按原任务恢复"))?;
        if !response.status().is_success() {
            return Err(invalid("画面代理上传未确认，请按原任务恢复"));
        }
        Ok(())
    }

    pub(super) async fn commit(&self, id: &str) -> AppResult<Job> {
        let (status, value) = self
            .request(json!({"action":"library-visual-commit","job_id":id}))
            .await?;
        parse_response(status, value, Some(id))
    }

    pub(super) async fn wait(&self, mut job: Job) -> AppResult<Job> {
        let start = tokio::time::Instant::now();
        while matches!(
            job.status.as_str(),
            "queued" | "leased" | "running" | "processing" | "uploading" | "cancel_requested"
        ) {
            if start.elapsed() >= Duration::from_secs(1800) {
                return Err(invalid("原分析仍在处理，请稍后恢复"));
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
            let (status, value) = self
                .request(json!({"action":"library-visual-get","job_id":job.job_id}))
                .await?;
            job = parse_response(status, value, Some(&job.job_id))?;
        }
        Ok(job)
    }
}

fn response_error(value: &Value) -> crate::error::AppError {
    invalid(
        value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("云端分析未确认，请按原任务恢复"),
    )
}

fn parse_response(status: StatusCode, value: Value, id: Option<&str>) -> AppResult<Job> {
    if !status.is_success() {
        return Err(response_error(&value));
    }
    let job: Job = serde_json::from_value(value).map_err(|_| invalid("云端分析任务返回无效"))?;
    if !Uuid::parse_str(&job.job_id).is_ok_and(|uuid| uuid.to_string() == job.job_id)
        || id.is_some_and(|previous| previous != job.job_id)
    {
        return Err(invalid("云端分析任务身份不匹配"));
    }
    Ok(job)
}

fn media_command(tool: Tool) -> AppResult<Command> {
    let mut command = Command::new(tools::resolve(tool)?);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.kill_on_drop(true);
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn video_analysis_proxy_strips_audio_and_handles_short_tail() {
        if tools::resolve(Tool::Ffmpeg).is_err() || tools::resolve(Tool::Ffprobe).is_err() {
            eprintln!("Skipping FFmpeg proxy check: tool not installed.");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.mp4");
        let output = temp.path().join("proxy").join(MEDIA_NAME);
        let status = media_command(Tool::Ffmpeg)
            .unwrap()
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=25",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=800",
                "-t",
                "1.24",
                "-c:v",
                "libx264",
            ])
            .arg(&source)
            .status()
            .await
            .unwrap();
        assert!(status.success());
        assert!(duration(&source, false).await.is_err());
        let ms = duration(&source, true).await.unwrap();
        let manifest = prepare_proxy(&source, &output, ms - 1, ms, ms)
            .await
            .unwrap();
        assert_eq!(manifest.start_ms, ms - 1);
        assert_eq!(manifest.source_duration_ms, ms);
        assert_eq!(
            manifest.duration_ms,
            duration(&output, false).await.unwrap()
        );
        assert_eq!(manifest.bytes, std::fs::metadata(output).unwrap().len());
    }
}

pub(super) async fn duration(path: &Path, source: bool) -> AppResult<u64> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        media_command(Tool::Ffprobe)?
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,duration:stream_disposition=attached_pic:format=duration",
                "-of",
                "json",
            ])
            .arg(path)
            .output(),
    )
    .await
    .map_err(|_| invalid("读取视频时长超时"))??;
    if !output.status.success() {
        return Err(invalid("无法读取视频时长"));
    }
    let value: Value = serde_json::from_slice(&output.stdout)?;
    let streams = value["streams"]
        .as_array()
        .ok_or_else(|| invalid("无法读取视频轨道"))?;
    let video = streams
        .iter()
        .find(|stream| {
            stream["codec_type"] == "video"
                && stream["disposition"]["attached_pic"].as_u64() != Some(1)
        })
        .ok_or_else(|| invalid("原件没有可分析的视频轨道"))?;
    if !source && streams.iter().any(|stream| stream["codec_type"] == "audio") {
        return Err(invalid("画面代理含有音轨"));
    }
    let field = if source
        && video["duration"]
            .as_str()
            .filter(|value| *value != "N/A")
            .is_some()
    {
        &video["duration"]
    } else {
        &value["format"]["duration"]
    };
    let seconds = field
        .as_str()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0 && *value < u64::MAX as f64 / 1000.0)
        .ok_or_else(|| invalid("无法确认视频时长"))?;
    Ok((seconds * 1000.0).ceil() as u64)
}

async fn read_proxy(path: &Path) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    tokio::fs::File::open(path)
        .await?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
        return Err(invalid("画面代理大小超过上限"));
    }
    Ok(bytes)
}

pub(super) async fn prepare_proxy(
    path: &Path,
    output: &Path,
    start_ms: u64,
    end_ms: u64,
    source_duration_ms: u64,
) -> AppResult<Manifest> {
    let parent = output.parent().ok_or_else(|| invalid("画面代理路径无效"))?;
    tokio::fs::create_dir_all(parent).await?;
    let requested_ms = end_ms - start_ms;
    let manifest = async {
        encode_proxy(path, output, start_ms, end_ms, false).await?;
        let duration_ms = match duration(output, false).await {
            Ok(duration_ms) => duration_ms,
            // The requested tail can end between decoded frames. Reuse the last
            // sampled frame immediately before it while retaining exact billing bounds.
            Err(_) if requested_ms < 500 => {
                encode_proxy(path, output, start_ms, end_ms, true).await?;
                duration(output, false).await?
            }
            Err(error) => return Err(error),
        };
        let bytes = read_proxy(output).await?;
        if duration_ms.abs_diff(requested_ms) > 2000 || duration_ms > SEGMENT_MS {
            return Err(invalid("画面代理时长不匹配，未提交云端"));
        }
        Ok(Manifest {
            mime: "video/mp4".into(),
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            duration_ms,
            start_ms,
            end_ms,
            source_duration_ms,
        })
    }
    .await;
    if manifest.is_err() {
        let _ = tokio::fs::remove_file(output).await;
        let _ = tokio::fs::remove_dir(parent).await;
    }
    manifest
}

async fn encode_proxy(
    path: &Path,
    output: &Path,
    start_ms: u64,
    end_ms: u64,
    last_frame: bool,
) -> AppResult<()> {
    let input_start_ms = if last_frame {
        start_ms.saturating_sub(1000)
    } else {
        start_ms
    };
    let start = format!("{:.3}", input_start_ms as f64 / 1000.0);
    let length = format!("{:.3}", (end_ms - input_start_ms) as f64 / 1000.0);
    const SCALE: &str = "scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2";
    let mut command = media_command(Tool::Ffmpeg)?;
    command.args(["-v", "error", "-nostdin", "-y", "-ss", &start]);
    if last_frame {
        command.args(["-t", &length]);
    }
    command.arg("-i").arg(path);
    let filter = if last_frame {
        command.args(["-frames:v", "1"]);
        format!("fps=4:round=up,{SCALE},reverse,fps=2:round=up")
    } else {
        command.args(["-t", &length]);
        format!("fps=2:round=up,{SCALE}")
    };
    let status = tokio::time::timeout(
        Duration::from_secs(1800),
        command
            .args([
                "-map",
                "0:V:0",
                "-an",
                "-sn",
                "-dn",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-vf",
                &filter,
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "veryfast",
                "-crf",
                "34",
                "-maxrate",
                "25k",
                "-bufsize",
                "50k",
                "-movflags",
                "+faststart",
                "-fs",
                "32000000",
            ])
            .arg(output)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| invalid("生成画面代理超时"))??;
    if !status.success() {
        return Err(invalid("无法生成画面代理"));
    }
    Ok(())
}
