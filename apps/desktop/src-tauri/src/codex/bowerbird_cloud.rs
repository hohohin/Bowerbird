use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::cloud::{AuthClient, CloudClient};
use crate::codex::types::{Capabilities, Chunk, CodexRequest, CodexResult, GenOutcome};
use crate::codex::GenProvider;
use crate::error::AppError;

#[derive(Clone)]
pub struct BowerbirdCloudProvider {
    cloud: CloudClient,
    auth: AuthClient,
}

impl BowerbirdCloudProvider {
    pub fn new(cloud: CloudClient, auth: AuthClient) -> Self {
        Self { cloud, auth }
    }
}

#[derive(Deserialize)]
struct GenerateResponse {
    status: String,
    #[serde(default)]
    images: Vec<CloudImage>,
    remote_task_id: Option<String>,
}

#[derive(Deserialize)]
struct CloudImage {
    mime: String,
    base64: String,
}

#[async_trait]
impl GenProvider for BowerbirdCloudProvider {
    fn name(&self) -> &'static str { "bowerbird-cloud" }

    fn capabilities(&self) -> Capabilities {
        Capabilities { chat: false, caption: true, generate: true }
    }

    async fn run(&self, _req: CodexRequest) -> Result<CodexResult, AppError> {
        Err(AppError::Cloud("理解能力请使用 CloudUnderstandProvider".into()))
    }

    async fn generate_image(
        &self,
        req: CodexRequest,
        tx: &mpsc::Sender<Chunk>,
        _resume_session: Option<String>,
    ) -> Result<GenOutcome, AppError> {
        let started = Instant::now();
        let endpoint = self.cloud.config().endpoint("generate-proxy")
            .ok_or_else(|| AppError::Cloud("Bowerbird Cloud 未启用或端点未配置".into()))?;
        let token = self.auth.access_token().await?;
        let job_id = req.job_id.clone().ok_or_else(|| AppError::Cloud("云生成缺少 job id".into()))?;

        let mut references = Vec::with_capacity(req.reference_images.len());
        for path in &req.reference_images {
            let bytes = tokio::fs::read(path).await
                .map_err(|error| AppError::Cloud(format!("读取参考图 {} 失败: {error}", path.display())))?;
            references.push(serde_json::json!({
                "mime": image_mime(path),
                "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            }));
        }

        let response = self.cloud.http().post(&endpoint).bearer_auth(&token).json(&serde_json::json!({
            "idempotency_key": job_id,
            "media": "image",
            "prompt": req.instruction,
            "reference_images": references,
            "ratio": req.ratio,
            "service": "image_sd",
        })).send().await.map_err(|error| AppError::Cloud(format!("云生成请求失败: {error}")))?;
        let status = response.status();
        let body = response.text().await
            .map_err(|error| AppError::Cloud(format!("读取云生成响应失败: {error}")))?;
        if !status.is_success() {
            let message = serde_json::from_str::<serde_json::Value>(&body).ok()
                .and_then(|value| value.pointer("/error/message").and_then(|v| v.as_str()).map(str::to_string))
                .unwrap_or_else(|| format!("云生成失败（HTTP {}）", status.as_u16()));
            return Err(AppError::Cloud(message));
        }
        let result: GenerateResponse = serde_json::from_str(&body)
            .map_err(|error| AppError::Cloud(format!("解析云生成响应失败: {error}")))?;
        let submit_id = if result.status == "queued" {
            let remote = result.remote_task_id.ok_or_else(|| AppError::Cloud("异步云任务缺少 remote_task_id".into()))?;
            let _ = tx.send(Chunk::Submit { submit_id: remote.clone() }).await;
            // Bounded poll: Mock async tasks become "succeeded" on a later poll, keeping the existing
            // pending_settlement hold honest (real reconciliation would confirm/rollback server-side).
            let mut success: Option<Vec<CloudImage>> = None;
            for _attempt in 0..30 {
                let polled = self.poll_remote(&endpoint, &remote, token.clone()).await?;
                match polled.status.as_str() {
                    "queued" => {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                    "succeeded" => {
                        success = Some(polled.images);
                        break;
                    }
                    _ => return Err(AppError::Cloud(format!("云任务异常状态: {}", polled.status))),
                }
            }
            let images = success.ok_or_else(|| AppError::Cloud("云任务处理超时".into()))?;
            Some((remote, images))
        } else {
            None
        };
        let (session_id, source_images) = match submit_id {
            Some((remote, images)) => (Some(remote), images),
            None => (Some(req.job_id.unwrap_or_default()), result.images),
        };

        let temp_dir = std::env::temp_dir().join(format!("bowerbird-cloud-{}", Ulid::new()));
        tokio::fs::create_dir_all(&temp_dir).await?;
        let mut paths = Vec::with_capacity(source_images.len());
        for (index, image) in source_images.into_iter().enumerate() {
            let bytes = base64::engine::general_purpose::STANDARD.decode(image.base64)
                .map_err(|error| AppError::Cloud(format!("云图片 base64 无效: {error}")))?;
            let extension = match image.mime.as_str() { "image/jpeg" => "jpg", "image/webp" => "webp", _ => "png" };
            let path = temp_dir.join(format!("result-{}.{}", index + 1, extension));
            tokio::fs::write(&path, bytes).await?;
            paths.push(path);
        }
        if paths.is_empty() { return Err(AppError::Cloud("云生成未返回图片".into())); }
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

impl BowerbirdCloudProvider {
    async fn poll_remote(
        &self,
        endpoint: &str,
        remote_task_id: &str,
        token: String,
    ) -> Result<GenerateResponse, AppError> {
        let response = self
            .cloud
            .http()
            .post(endpoint)
            .bearer_auth(token)
            .json(&serde_json::json!({ "remote_task_id": remote_task_id }))
            .send()
            .await
            .map_err(|error| AppError::Cloud(format!("轮询云任务失败: {error}")))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AppError::Cloud(format!("读取云任务响应失败: {error}")))?;
        if !status.is_success() {
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| value.pointer("/error/message").and_then(|v| v.as_str()).map(str::to_string))
                .unwrap_or_else(|| format!("云任务轮询失败（HTTP {}）", status.as_u16()));
            return Err(AppError::Cloud(message));
        }
        serde_json::from_str(&body)
            .map_err(|error| AppError::Cloud(format!("解析云任务响应失败: {error}")))
    }
}

fn image_mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}
