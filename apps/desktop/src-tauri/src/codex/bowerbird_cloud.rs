use std::path::PathBuf;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::cloud::{AuthClient, CloudClient};
use crate::codex::cloud_image::read_cloud_jpeg;
use crate::codex::types::{Capabilities, Chunk, CodexRequest, CodexResult, GenOutcome};
use crate::codex::GenProvider;
use crate::error::AppError;

/// Cloud 生图 provider：档位由云端数据驱动（entitlement.generation_services），
/// key/service 都是运行时字符串——云端上新档位无需桌面发版。
///
/// key 约定：`bowerbird-cloud-<service>`（如 `bowerbird-cloud-image_hd`）；少量遗留 key
/// （裸 `bowerbird-cloud` / `-fast` / `-lite` / `-standard`）由 [`cloud_service_for_key`] 映射。
#[derive(Clone)]
pub struct BowerbirdCloudProvider {
    cloud: CloudClient,
    auth: AuthClient,
    key: String,
    service: String,
}

impl BowerbirdCloudProvider {
    pub fn new(cloud: CloudClient, auth: AuthClient, key: String, service: String) -> Self {
        Self {
            cloud,
            auth,
            key,
            service,
        }
    }
}

/// cloud provider key → generate-proxy 的计费/路由 service。
/// 新式 key 后缀即 service（`bowerbird-cloud-image_hd` → `image_hd`）；遗留 key 显式映射；
/// 非法值兜底 `image_hd`（Edge 侧仍会按 service_costs 二次校验）。
pub fn cloud_service_for_key(key: &str) -> String {
    let suffix = key
        .strip_prefix("bowerbird-cloud")
        .unwrap_or("")
        .trim_start_matches('-');
    match suffix {
        "" => "image_hd",
        "fast" => "image_fast",
        "lite" | "standard" => "image_lite",
        service => service,
    }
    .to_string()
}

#[derive(Deserialize)]
pub(crate) struct GenerateResponse {
    pub(crate) status: String,
    #[serde(default)]
    images: Vec<CloudImage>,
    pub(crate) remote_task_id: Option<String>,
    artifact: Option<CloudArtifact>,
    pub(crate) error: Option<CloudJobError>,
}

#[derive(Deserialize)]
struct CloudImage {
    mime: String,
    base64: String,
}

#[derive(Deserialize)]
struct CloudArtifact {
    url: String,
    mime: String,
    bytes: u64,
    sha256: String,
}

#[derive(Deserialize)]
pub(crate) struct CloudJobError {
    pub(crate) message: String,
}

#[async_trait]
impl GenProvider for BowerbirdCloudProvider {
    fn name(&self) -> &str {
        &self.key
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            chat: false,
            caption: true,
            generate: true,
        }
    }

    async fn run(&self, _req: CodexRequest) -> Result<CodexResult, AppError> {
        Err(AppError::Cloud(
            "理解能力请使用 CloudUnderstandProvider".into(),
        ))
    }

    async fn generate_image(
        &self,
        req: CodexRequest,
        tx: &mpsc::Sender<Chunk>,
        resume_session: Option<String>,
    ) -> Result<GenOutcome, AppError> {
        let started = Instant::now();
        let endpoint = self
            .cloud
            .config()
            .endpoint("generate-proxy")
            .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
        let job_id = req
            .job_id
            .clone()
            .ok_or_else(|| AppError::Cloud("云生成缺少 job id".into()))?;
        // 幂等键按轮次区分：首轮（无 resume）= job_id 原样，同键同内容可幂等重放；续轮
        // （resume）对云端是一次全新生成（prompt/参考图都不同），沿用 job_id 会撞
        // manifest hash 校验（409 幂等键已用于不同的生成内容），故每次续轮提交带 ULID
        // 后缀——与即梦每次续轮全新 submit 的语义一致。
        let idempotency_key = match resume_session.as_deref() {
            Some(_) => format!("{job_id}-{}", Ulid::new()),
            None => job_id.clone(),
        };

        let mut references = Vec::with_capacity(req.reference_images.len());
        for path in &req.reference_images {
            references.push(read_cloud_jpeg(path, true).await?);
        }

        let response = self
            .auth
            .send_authorized(
                self.cloud.http().post(&endpoint).json(&serde_json::json!({
                    "idempotency_key": idempotency_key,
                    "media": "image",
                    "prompt": req.instruction,
                    "reference_images": references,
                    "ratio": req.ratio,
                    "service": self.service,
                })),
                "云生成请求失败",
            )
            .await?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AppError::Cloud(format!("读取云生成响应失败: {error}")))?;
        if !status.is_success() {
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("云生成失败（HTTP {}）", status.as_u16()));
            return Err(AppError::Cloud(message));
        }
        let result: GenerateResponse = serde_json::from_str(&body)
            .map_err(|error| AppError::Cloud(format!("解析云生成响应失败: {error}")))?;
        if matches!(
            result.status.as_str(),
            "uploading" | "queued" | "leased" | "running" | "cancel_requested"
        ) {
            let remote = result
                .remote_task_id
                .ok_or_else(|| AppError::Cloud("异步云任务缺少 remote_task_id".into()))?;
            let _ = tx
                .send(Chunk::Submit {
                    submit_id: remote.clone(),
                })
                .await;
            let (paths, temp_dir) =
                wait_for_cloud_job(&self.cloud, &self.auth, &endpoint, &remote).await?;
            return Ok(GenOutcome {
                text: String::new(),
                session_id: Some(remote.clone()),
                submit_id: Some(remote),
                elapsed_ms: started.elapsed().as_millis() as u64,
                source_images: paths,
                temp_dir: Some(temp_dir),
            });
        }
        if result.status == "succeeded" {
            if let Some(artifact) = result.artifact {
                let remote = result.remote_task_id.unwrap_or_else(|| job_id.clone());
                let (paths, temp_dir) = download_artifact(&self.cloud, &remote, artifact).await?;
                acknowledge_artifact(&self.auth, &self.cloud, &endpoint, &remote).await;
                return Ok(GenOutcome {
                    text: String::new(),
                    session_id: Some(remote.clone()),
                    submit_id: Some(remote),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    source_images: paths,
                    temp_dir: Some(temp_dir),
                });
            }
        } else if let Some(error) = result.error {
            return Err(AppError::Cloud(error.message));
        }
        let session_id = Some(job_id);
        let source_images = result.images;

        let temp_dir = std::env::temp_dir().join(format!("bowerbird-cloud-{}", Ulid::new()));
        tokio::fs::create_dir_all(&temp_dir).await?;
        let mut paths = Vec::with_capacity(source_images.len());
        for (index, image) in source_images.into_iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(image.base64)
                .map_err(|error| AppError::Cloud(format!("云图片 base64 无效: {error}")))?;
            let extension = match image.mime.as_str() {
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                _ => "png",
            };
            let path = temp_dir.join(format!("result-{}.{}", index + 1, extension));
            tokio::fs::write(&path, bytes).await?;
            paths.push(path);
        }
        if paths.is_empty() {
            return Err(AppError::Cloud("云生成未返回图片".into()));
        }
        Ok(GenOutcome {
            text: String::new(),
            session_id: session_id.clone(),
            submit_id: session_id,
            elapsed_ms: started.elapsed().as_millis() as u64,
            source_images: paths,
            temp_dir: Some(temp_dir),
        })
    }
}

async fn poll_remote(
    cloud: &CloudClient,
    auth: &AuthClient,
    endpoint: &str,
    remote_task_id: &str,
) -> Result<GenerateResponse, AppError> {
    let response = auth
        .send_authorized(
            cloud
                .http()
                .post(endpoint)
                .json(&serde_json::json!({ "action": "get", "job_id": remote_task_id })),
            "轮询云任务失败",
        )
        .await?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::Cloud(format!("读取云任务响应失败: {error}")))?;
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("云任务轮询失败（HTTP {}）", status.as_u16()));
        return Err(AppError::Cloud(message));
    }
    serde_json::from_str(&body)
        .map_err(|error| AppError::Cloud(format!("解析云任务响应失败: {error}")))
}

pub(crate) async fn wait_for_cloud_job(
    cloud: &CloudClient,
    auth: &AuthClient,
    endpoint: &str,
    remote_task_id: &str,
) -> Result<(Vec<PathBuf>, PathBuf), AppError> {
    let mut transient_failures = 0_u32;
    loop {
        match poll_remote(cloud, auth, endpoint, remote_task_id).await {
            Ok(result) => {
                transient_failures = 0;
                match result.status.as_str() {
                    "uploading" | "queued" | "leased" | "running" | "cancel_requested" => {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                    "succeeded" => {
                        let artifact = result
                            .artifact
                            .ok_or_else(|| AppError::Cloud("云任务成功但缺少下载产物".into()))?;
                        let downloaded = download_artifact(cloud, remote_task_id, artifact).await?;
                        acknowledge_artifact(auth, cloud, endpoint, remote_task_id).await;
                        return Ok(downloaded);
                    }
                    "failed" | "cancelled" | "outcome_unknown" => {
                        let message =
                            result
                                .error
                                .map(|error| error.message)
                                .unwrap_or_else(|| match result.status.as_str() {
                                    "outcome_unknown" => {
                                        "请求已提交方舟，但结果状态暂时无法确认".into()
                                    }
                                    "cancelled" => "云任务已取消".into(),
                                    _ => "云生成失败".into(),
                                });
                        return Err(AppError::Cloud(message));
                    }
                    status => return Err(AppError::Cloud(format!("云任务异常状态: {status}"))),
                }
            }
            Err(error) => {
                let message = error.to_string();
                if message.contains("登录") || message.contains("请先登录") {
                    return Err(error);
                }
                transient_failures = transient_failures.saturating_add(1);
                tracing::warn!(
                    "云任务轮询暂时失败：job={} retry={}",
                    remote_task_id,
                    transient_failures
                );
                let delay = 5_u64.saturating_mul(2_u64.pow(transient_failures.min(3)));
                tokio::time::sleep(std::time::Duration::from_secs(delay.min(40))).await;
            }
        }
    }
}

async fn download_artifact(
    cloud: &CloudClient,
    remote_task_id: &str,
    artifact: CloudArtifact,
) -> Result<(Vec<PathBuf>, PathBuf), AppError> {
    if !artifact.url.starts_with("https://") {
        return Err(AppError::Cloud("云图片下载地址不安全".into()));
    }
    if artifact.bytes == 0 || artifact.bytes > 20 * 1024 * 1024 {
        return Err(AppError::Cloud("云图片大小无效".into()));
    }
    if artifact.sha256.len() != 64 || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::Cloud("云图片校验信息无效".into()));
    }
    let response = cloud
        .http()
        .get(&artifact.url)
        .send()
        .await
        .map_err(|error| AppError::Cloud(format!("下载云图片失败: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Cloud(format!(
            "下载云图片失败（HTTP {}）",
            response.status().as_u16()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::Cloud(format!("读取云图片失败: {error}")))?;
    if bytes.len() as u64 != artifact.bytes {
        return Err(AppError::Cloud("云图片大小校验失败".into()));
    }
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if !actual_hash.eq_ignore_ascii_case(&artifact.sha256) {
        return Err(AppError::Cloud("云图片完整性校验失败".into()));
    }
    let extension = match artifact.mime.as_str() {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/png" => "png",
        _ => return Err(AppError::Cloud("云图片格式无效".into())),
    };
    let temp_dir = std::env::temp_dir().join(format!("bowerbird-cloud-{}", Ulid::new()));
    tokio::fs::create_dir_all(&temp_dir).await?;
    let path = temp_dir.join(format!("result-{remote_task_id}.{extension}"));
    tokio::fs::write(&path, bytes).await?;
    Ok((vec![path], temp_dir))
}

async fn acknowledge_artifact(
    auth: &AuthClient,
    cloud: &CloudClient,
    endpoint: &str,
    remote_task_id: &str,
) {
    let _ = auth
        .send_authorized(
            cloud.http().post(endpoint).json(&serde_json::json!({
                "action": "artifact_received",
                "job_id": remote_task_id,
            })),
            "确认云图片接收失败",
        )
        .await;
}

pub(crate) async fn recover_cloud_generation(
    cloud: &CloudClient,
    auth: &AuthClient,
    remote_task_id: &str,
) -> Result<(Vec<PathBuf>, PathBuf), AppError> {
    let endpoint = cloud
        .config()
        .endpoint("generate-proxy")
        .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
    wait_for_cloud_job(cloud, auth, &endpoint, remote_task_id).await
}
