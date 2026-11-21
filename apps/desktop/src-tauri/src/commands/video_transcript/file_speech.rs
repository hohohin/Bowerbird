use super::{invalid, AppResult, AuthClient, CloudClient};
use crate::error::AppError;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;

const MAX_DURATION_MS: u64 = 7_200_000;
pub(super) const PRICE_CHANGED: &str = "视频转录价格已变化，请重新核对报价";
pub(super) const UNAVAILABLE: &str = "视频转录服务暂未开放";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub(super) available: bool,
    pub(super) credits: Option<i64>,
    pub(super) max_duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<CapabilityReason>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum CapabilityReason {
    PilotExhausted,
}

impl Capabilities {
    fn from_response(value: Value) -> AppResult<Self> {
        let available = value["available"]
            .as_bool()
            .ok_or_else(|| invalid("无法读取视频转录服务状态"))?;
        let credits = value["credits"].as_i64().filter(|credits| *credits > 0);
        let max_duration_ms = value["max_duration_ms"]
            .as_u64()
            .filter(|duration| (1..=MAX_DURATION_MS).contains(duration))
            .ok_or_else(|| invalid("视频转录服务时长配置无效"))?;
        let reason = (!available && value["reason"].as_str() == Some("pilot_exhausted"))
            .then_some(CapabilityReason::PilotExhausted);
        Ok(Self {
            available: available && credits.is_some(),
            credits: credits.filter(|_| available),
            max_duration_ms,
            reason,
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct Manifest {
    pub(super) sha256: String,
    pub(super) bytes: u64,
    pub(super) duration_ms: u64,
    pub(super) source_duration_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Attempt {
    pub(super) key: String,
    pub(super) owner: String,
    pub(super) credits: i64,
    pub(super) audio: Manifest,
    pub(super) job_id: Option<String>,
    pub(super) terminal: bool,
}

pub(super) fn audio_path(root: &Path, key: &str) -> PathBuf {
    let directory = format!("{:x}", Sha256::digest(key));
    root.join("video-transcripts")
        .join(directory)
        .join("speech-audio.mp3")
}

pub(super) async fn read_audio(path: &Path) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    tokio::fs::File::open(path)
        .await?
        .take(super::speech::MAX_FULL_AUDIO_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.is_empty() || bytes.len() as u64 > super::speech::MAX_FULL_AUDIO_BYTES {
        return Err(invalid("转录音轨大小无效，请重新检查原任务"));
    }
    Ok(bytes)
}

#[derive(Debug, Deserialize)]
pub(super) struct Job {
    pub(super) job_id: String,
    pub(super) status: String,
    pub(super) text: Option<String>,
    pub(super) upload_url: Option<String>,
    error: Option<JobError>,
}

impl Job {
    pub(super) fn message(&self, fallback: &str) -> AppError {
        invalid(
            self.error
                .as_ref()
                .and_then(|error| error.message.as_deref())
                .unwrap_or(fallback),
        )
    }
}

#[derive(Debug, Deserialize)]
struct JobError {
    message: Option<String>,
}

pub(super) enum Preparation {
    Original(Job),
    Rejected(AppError),
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
                "视频转录 Cloud 请求失败",
                self.owner,
            )
            .await?;
        let status = response.status();
        let payload = response
            .json()
            .await
            .map_err(|_| invalid("转录服务返回无效，请按原任务查询"))?;
        Ok((status, payload))
    }

    pub(super) async fn capabilities(&self) -> AppResult<Capabilities> {
        let (status, value) = self
            .request(json!({"action":"file-speech-capabilities"}))
            .await?;
        if !status.is_success() {
            return Err(error_response(&value, "读取视频转录报价失败，请刷新后重试"));
        }
        Capabilities::from_response(value)
    }

    pub(super) async fn prepare(&self, attempt: &Attempt) -> AppResult<Preparation> {
        let (status, value) = self
            .request(json!({
                "action":"file-speech-prepare", "idempotency_key":attempt.key,
                "expected_credits":attempt.credits, "audio":attempt.audio,
            }))
            .await?;
        if status.is_success() {
            return Ok(Preparation::Original(parse_job(
                value,
                attempt.job_id.as_deref(),
            )?));
        }
        let code = value
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // These responses precede acceptance. Unclassified responses may have
        // happened after pre-authorization and must be recovered by key.
        match (status.as_u16(), code) {
            (409, "invalid_request")
                if value.pointer("/error/message").and_then(Value::as_str)
                    == Some(PRICE_CHANGED) =>
            {
                Ok(Preparation::Rejected(invalid(PRICE_CHANGED)))
            }
            (503, "not_configured") => Ok(Preparation::Rejected(invalid(UNAVAILABLE))),
            (400, "invalid_request")
            | (401, "unauthorized")
            | (402, "insufficient_credits")
            | (403, "forbidden") => Ok(Preparation::Rejected(error_response(
                &value,
                "视频转录请求未通过，请重新核对报价",
            ))),
            _ => Err(error_response(
                &value,
                "视频转录提交结果未确认，请按原任务恢复",
            )),
        }
    }

    pub(super) async fn lookup(&self, attempt: &Attempt) -> AppResult<Option<Job>> {
        let (status, value) = self
            .request(json!({"action":"get-by-key","idempotency_key":attempt.key}))
            .await?;
        if status.is_success() {
            return Ok(Some(parse_job(value, attempt.job_id.as_deref())?));
        }
        if status == StatusCode::NOT_FOUND
            && attempt.job_id.is_none()
            && value.pointer("/error/code").and_then(Value::as_str) == Some("invalid_request")
        {
            return Ok(None);
        }
        Err(error_response(&value, "读取原转录任务失败，请稍后恢复"))
    }

    pub(super) async fn commit(&self, job_id: &str) -> AppResult<Job> {
        self.job(
            json!({"action":"file-speech-commit","job_id":job_id}),
            Some(job_id),
        )
        .await
    }

    pub(super) async fn get(&self, job_id: &str) -> AppResult<Job> {
        self.job(json!({"action":"get","job_id":job_id}), Some(job_id))
            .await
    }

    async fn job(&self, body: Value, id: Option<&str>) -> AppResult<Job> {
        let (status, value) = self.request(body).await?;
        if !status.is_success() {
            return Err(error_response(&value, "读取原转录任务失败，请稍后恢复"));
        }
        parse_job(value, id)
    }

    pub(super) async fn upload(
        &self,
        job: &Job,
        audio: &Manifest,
        bytes: Vec<u8>,
    ) -> AppResult<()> {
        if self.auth.snapshot().user_id.as_deref() != Some(self.owner) {
            return Err(invalid("账号已切换，请登录原账号后继续转录"));
        }
        let url = job
            .upload_url
            .as_deref()
            .ok_or_else(|| invalid("原任务未提供音轨上传地址，请稍后恢复"))?;
        let source = reqwest::Url::parse(url).map_err(|_| invalid("原转录任务的上传地址无效"))?;
        if source.path() != format!("/storage/v1/object/upload/sign/generation-temp/understand/{}/inputs/speech-audio.mp3", job.job_id) {
            return Err(invalid("原转录任务的上传地址不匹配"));
        }
        let upload_url = self
            .cloud
            .config()
            .generation_transfer_url(url, true)
            .ok_or_else(|| invalid("原转录任务的上传地址无效"))?;
        if bytes.len() as u64 != audio.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != audio.sha256
        {
            return Err(invalid("本机音轨已变化，请检查原任务后恢复"));
        }
        let response = self
            .cloud
            .http()
            .put(upload_url)
            .header("content-type", "audio/mpeg")
            .body(bytes)
            .send()
            .await
            .map_err(|_| AppError::Cloud("音轨上传未确认，请按原任务恢复".into()))?;
        if !response.status().is_success() {
            return Err(invalid("音轨上传未确认，请按原任务恢复"));
        }
        Ok(())
    }
}

fn error_response(value: &Value, fallback: &str) -> AppError {
    invalid(
        value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or(fallback),
    )
}

fn parse_job(value: Value, id: Option<&str>) -> AppResult<Job> {
    let job: Job =
        serde_json::from_value(value).map_err(|_| invalid("云端未返回有效的原转录任务"))?;
    if !uuid::Uuid::parse_str(&job.job_id).is_ok_and(|uuid| uuid.to_string() == job.job_id)
        || id.is_some_and(|previous| previous != job.job_id)
    {
        return Err(invalid("云端转录任务身份不匹配，请检查原任务"));
    }
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_transcript_capabilities_preserves_the_known_pilot_reason() {
        let cloud = |reason| {
            json!({
                "available": false, "credits": null, "max_duration_ms": 7_200_000, "reason": reason,
            })
        };
        let exhausted = Capabilities::from_response(cloud("pilot_exhausted")).unwrap();
        assert_eq!(
            serde_json::to_value(exhausted).unwrap(),
            json!({"available":false,"credits":null,"maxDurationMs":7200000,"reason":"pilot_exhausted"})
        );
        for value in [
            cloud("unknown_future_state"),
            json!({"available":false,"credits":null,"max_duration_ms":7_200_000}),
        ] {
            let ordinary = Capabilities::from_response(value).unwrap();
            assert!(serde_json::to_value(ordinary)
                .unwrap()
                .get("reason")
                .is_none());
        }
    }
}
