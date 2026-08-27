//! V2 视觉设定云端提炼 · 桌面云客户端：提交冻结证据卡 → 轮询 visual-profile 任务
//! → 返回云端 draft JSON（由 core 层校验后落库）。载荷只含反推文字（脱敏断言在上游）。

use serde::Deserialize;
use ulid::Ulid;

use crate::cloud::{AuthClient, CloudClient};
use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
struct VisualProfileJobResponse {
    status: String,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    draft: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<CloudJobError>,
}

#[derive(Debug, Deserialize)]
struct CloudJobError {
    #[serde(default)]
    message: String,
}

pub struct VisualProfileCloudClient {
    cloud: CloudClient,
    auth: AuthClient,
}

impl VisualProfileCloudClient {
    pub fn new(cloud: CloudClient, auth: AuthClient) -> Self {
        Self { cloud, auth }
    }

    async fn post(
        &self,
        endpoint: &str,
        body: serde_json::Value,
        error_label: &str,
    ) -> Result<VisualProfileJobResponse, AppError> {
        let response = self
            .auth
            .send_authorized(self.cloud.http().post(endpoint).json(&body), error_label)
            .await?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| AppError::Cloud(format!("读取云端提炼响应失败: {error}")))?;
        if !status.is_success() && status.as_u16() != 202 {
            let message = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("云端提炼失败（HTTP {}）", status.as_u16()));
            return Err(AppError::Cloud(message));
        }
        serde_json::from_str(&text)
            .map_err(|error| AppError::Cloud(format!("解析云端提炼响应失败: {error}")))
    }

    /// 提交 + 轮询直到终态；成功返回 draft JSON 字符串。瞬时失败指数退避（对齐 understand）。
    pub async fn extract(&self, cards: &serde_json::Value) -> AppResult<String> {
        let endpoint = self
            .cloud
            .config()
            .endpoint("visual-profile")
            .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
        let idempotency_key = Ulid::new().to_string();
        let mut result = self
            .post(
                &endpoint,
                serde_json::json!({
                    "action": "create",
                    "idempotencyKey": idempotency_key,
                    "cards": cards,
                }),
                "云端提炼请求失败",
            )
            .await?;
        if result.status != "succeeded" {
            let job_id = result
                .job_id
                .clone()
                .ok_or_else(|| AppError::Cloud("云端提炼任务缺少 job_id".into()))?;
            result = self.wait_for_job(&endpoint, &job_id).await?;
        }
        match (result.status.as_str(), result.draft) {
            ("succeeded", Some(draft)) => Ok(draft.to_string()),
            _ => Err(AppError::Cloud(
                result
                    .error
                    .map(|error| error.message)
                    .unwrap_or_else(|| "云端提炼未返回结果".into()),
            )),
        }
    }

    /// V3 方向验证图：纯文生图（reference_assets 恒为空——不携带任何来源素材），
    /// 走普通 Cloud 生成计费链路（generate-proxy G0 异步队列）。返回落地的本地图片路径。
    pub async fn generate_validation_image(&self, prompt: &str, service: &str) -> AppResult<std::path::PathBuf> {
        let endpoint = self
            .cloud
            .config()
            .endpoint("generate-proxy")
            .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
        let idempotency_key = format!("visual-validation-{}", Ulid::new());
        let response = self
            .auth
            .send_authorized(
                self.cloud.http().post(&endpoint).json(&serde_json::json!({
                    "idempotency_key": idempotency_key,
                    "media": "image",
                    "prompt": prompt,
                    "reference_images": [],
                    "service": service,
                })),
                "验证图生成请求失败",
            )
            .await?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AppError::Cloud(format!("读取验证图响应失败: {error}")))?;
        if !status.is_success() && status.as_u16() != 202 {
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value.pointer("/error/message").and_then(|v| v.as_str()).map(str::to_string)
                })
                .unwrap_or_else(|| format!("验证图生成失败（HTTP {}）", status.as_u16()));
            return Err(AppError::Cloud(message));
        }
        let result: crate::codex::bowerbird_cloud::GenerateResponse = serde_json::from_str(&body)
            .map_err(|error| AppError::Cloud(format!("解析验证图响应失败: {error}")))?;
        if result.status == "succeeded" {
            return Err(AppError::Cloud("验证图不应同步返回，请重试".into()));
        }
        let remote = result
            .remote_task_id
            .ok_or_else(|| AppError::Cloud("验证图任务缺少 job_id".into()))?;
        if !matches!(
            result.status.as_str(),
            "uploading" | "queued" | "leased" | "running" | "cancel_requested"
        ) {
            return Err(AppError::Cloud(
                result.error.map(|error| error.message).unwrap_or_else(|| "验证图任务未入队".into()),
            ));
        }
        let (paths, _temp_dir) = crate::codex::bowerbird_cloud::wait_for_cloud_job(
            &self.cloud,
            &self.auth,
            &endpoint,
            &remote,
        )
        .await?;
        paths
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Cloud("验证图任务未返回图片".into()))
    }

    async fn wait_for_job(&self, endpoint: &str, job_id: &str) -> Result<VisualProfileJobResponse, AppError> {
        let mut transient_failures = 0_u32;
        loop {
            match self
                .post(
                    endpoint,
                    serde_json::json!({ "action": "get", "job_id": job_id }),
                    "轮询云端提炼任务失败",
                )
                .await
            {
                Ok(result) => {
                    transient_failures = 0;
                    match result.status.as_str() {
                        "uploading" | "queued" | "leased" | "running" | "cancel_requested" => {
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        }
                        "succeeded" => return Ok(result),
                        "failed" | "cancelled" | "outcome_unknown" => {
                            let message = result.error.map(|error| error.message).unwrap_or_else(|| {
                                match result.status.as_str() {
                                    "outcome_unknown" => "请求已提交模型，但结果状态暂时无法确认".into(),
                                    "cancelled" => "提炼任务已取消".into(),
                                    _ => "云端提炼失败".into(),
                                }
                            });
                            return Err(AppError::Cloud(message));
                        }
                        status => {
                            return Err(AppError::Cloud(format!("云端提炼任务异常状态: {status}")));
                        }
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    if message.contains("登录") || message.contains("请先登录") {
                        return Err(error);
                    }
                    transient_failures = transient_failures.saturating_add(1);
                    tracing::warn!("云端提炼轮询暂时失败：job={job_id} retry={transient_failures}");
                    let delay = 5_u64.saturating_mul(2_u64.pow(transient_failures.min(3)));
                    tokio::time::sleep(std::time::Duration::from_secs(delay.min(40))).await;
                }
            }
        }
    }
}
