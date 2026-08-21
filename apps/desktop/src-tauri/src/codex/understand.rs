use std::time::Instant;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::cloud::{AuthClient, CloudClient, EntitlementService};
use crate::codex::cloud_image::read_cloud_jpeg;
use crate::codex::codex_cli::CodexCliProvider;
use crate::codex::types::{CodexRequest, CodexResult};
use crate::codex::GenProvider;
use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnderstandOperation {
    Caption,
    Autoname,
    Classify,
}

impl UnderstandOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Caption => "caption",
            Self::Autoname => "autoname",
            Self::Classify => "classify",
        }
    }
}

#[async_trait]
pub trait UnderstandProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn understand(
        &self,
        operation: UnderstandOperation,
        req: CodexRequest,
    ) -> Result<CodexResult, AppError>;
}

pub struct CodexUnderstandProvider(CodexCliProvider);

impl Default for CodexUnderstandProvider {
    fn default() -> Self {
        Self(CodexCliProvider::default())
    }
}

#[async_trait]
impl UnderstandProvider for CodexUnderstandProvider {
    fn name(&self) -> &str {
        "codex"
    }

    async fn understand(
        &self,
        _operation: UnderstandOperation,
        req: CodexRequest,
    ) -> Result<CodexResult, AppError> {
        self.0.run(req).await
    }
}

#[derive(Clone)]
pub struct CloudUnderstandProvider {
    cloud: CloudClient,
    auth: AuthClient,
}

impl CloudUnderstandProvider {
    pub fn new(cloud: CloudClient, auth: AuthClient) -> Self {
        Self { cloud, auth }
    }
}

#[derive(Deserialize)]
struct UnderstandResponse {
    status: String,
    #[serde(default)]
    text: Option<String>,
    job_id: Option<String>,
    error: Option<CloudJobError>,
}

#[derive(Deserialize)]
struct CloudJobError {
    message: String,
}

impl CloudUnderstandProvider {
    async fn post_understand(
        &self,
        endpoint: &str,
        body: serde_json::Value,
        error_label: &str,
    ) -> Result<UnderstandResponse, AppError> {
        let response = self
            .auth
            .send_authorized(self.cloud.http().post(endpoint).json(&body), error_label)
            .await?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AppError::Cloud(format!("读取云理解响应失败: {error}")))?;
        if !status.is_success() {
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("云理解失败（HTTP {}）", status.as_u16()));
            return Err(AppError::Cloud(message));
        }
        serde_json::from_str(&body)
            .map_err(|error| AppError::Cloud(format!("解析云理解响应失败: {error}")))
    }

    /// 轮询云理解任务直到终态；瞬时失败指数退避（对齐生图 `wait_for_cloud_job`）。
    async fn wait_for_understand_job(
        &self,
        endpoint: &str,
        job_id: &str,
    ) -> Result<UnderstandResponse, AppError> {
        let mut transient_failures = 0_u32;
        loop {
            match self
                .post_understand(
                    endpoint,
                    serde_json::json!({ "action": "get", "job_id": job_id }),
                    "轮询云理解任务失败",
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
                            let message =
                                result.error.map(|error| error.message).unwrap_or_else(|| {
                                    match result.status.as_str() {
                                        "outcome_unknown" => {
                                            "请求已提交方舟，但结果状态暂时无法确认".into()
                                        }
                                        "cancelled" => "云任务已取消".into(),
                                        _ => "云理解失败".into(),
                                    }
                                });
                            return Err(AppError::Cloud(message));
                        }
                        status => {
                            return Err(AppError::Cloud(format!("云理解任务异常状态: {status}")))
                        }
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    if message.contains("登录") || message.contains("请先登录") {
                        return Err(error);
                    }
                    transient_failures = transient_failures.saturating_add(1);
                    tracing::warn!(
                        "云理解任务轮询暂时失败：job={} retry={}",
                        job_id,
                        transient_failures
                    );
                    let delay = 5_u64.saturating_mul(2_u64.pow(transient_failures.min(3)));
                    tokio::time::sleep(std::time::Duration::from_secs(delay.min(40))).await;
                }
            }
        }
    }
}

#[async_trait]
impl UnderstandProvider for CloudUnderstandProvider {
    fn name(&self) -> &str {
        "bowerbird-cloud"
    }

    async fn understand(
        &self,
        operation: UnderstandOperation,
        req: CodexRequest,
    ) -> Result<CodexResult, AppError> {
        let started = Instant::now();
        let endpoint = self
            .cloud
            .config()
            .endpoint("understand-proxy")
            .ok_or_else(|| AppError::Cloud("当前构建未配置 Bowerbird Cloud".into()))?;
        // 无 reference_images = 纯文本调用（生成图维度数据命名）：image 传 null，图片不出本机；
        // 反推 / 归类仍必带一张图（由调用方保证）。
        let image = match req.reference_images.first() {
            Some(path) => Some(read_cloud_jpeg(path, false).await?),
            None => None,
        };
        let idempotency_key = req
            .job_id
            .clone()
            .unwrap_or_else(|| Ulid::new().to_string());

        // 同步模式（UNDERSTAND_ASYNC=false，服务端忽略 action）或幂等重放已完成时，
        // create 响应直接是终态 succeeded+text；异步模式下返回 202 进行中，转轮询。
        let mut result = self
            .post_understand(
                &endpoint,
                serde_json::json!({
                    "action": "create",
                    "idempotency_key": idempotency_key,
                    "operation": operation.as_str(),
                    "image": image,
                    "instruction": req.instruction,
                }),
                "云理解请求失败",
            )
            .await?;
        if result.status != "succeeded" {
            let job_id = result
                .job_id
                .clone()
                .ok_or_else(|| AppError::Cloud("异步云理解任务缺少 job_id".into()))?;
            result = self.wait_for_understand_job(&endpoint, &job_id).await?;
        }
        let text = match result.text {
            Some(text) if !text.trim().is_empty() => text,
            _ => {
                return Err(AppError::Cloud(
                    result
                        .error
                        .map(|error| error.message)
                        .unwrap_or_else(|| "云理解未返回文本".into()),
                ));
            }
        };
        Ok(CodexResult {
            text,
            provider: self.name().into(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            session_id: None,
            images: vec![],
        })
    }
}

pub fn resolve_understand_provider(
    provider: Option<&str>,
    cloud: Option<(CloudClient, AuthClient)>,
) -> Result<Box<dyn UnderstandProvider>, AppError> {
    match provider.unwrap_or("codex") {
        "codex" | "default" => Ok(Box::new(CodexUnderstandProvider::default())),
        "bowerbird-cloud" => {
            let (client, auth) =
                cloud.ok_or_else(|| AppError::Cloud("账号服务尚未初始化".into()))?;
            Ok(Box::new(CloudUnderstandProvider::new(client, auth)))
        }
        other => Err(AppError::Cloud(format!("未知理解 provider: {other}"))),
    }
}

/// 按账号权益选择理解 provider：Pro/Studio 使用本机 CLI；免费档仅在明确允许上传时走 Cloud。
pub async fn resolve_entitled_understand_provider(
    entitlement: &EntitlementService,
    cloud: CloudClient,
    auth: AuthClient,
    allow_cloud: bool,
) -> Result<Box<dyn UnderstandProvider>, AppError> {
    let snapshot = entitlement.current_or_sync(&auth).await;
    let provider = snapshot
        .policy
        .understand_provider(allow_cloud)
        .ok_or_else(|| {
            AppError::Cloud(
                "免费版只能使用 Bowerbird Cloud 理解；请登录并明确允许云端理解，或升级 Pro 解锁本机 CLI"
                    .into(),
            )
        })?;
    if provider == "bowerbird-cloud" && !auth.snapshot().logged_in {
        return Err(AppError::Cloud(
            "免费版反推需要先登录 Bowerbird Cloud（每日 10 次）".into(),
        ));
    }
    resolve_understand_provider(Some(provider), Some((cloud, auth)))
}

/// 用户显式选择理解 provider 时使用：按选项 resolve，但仍按权益门控（免费档不能选 codex）。
/// choice = None 时退回自动路由（resolve_entitled_understand_provider）。
pub async fn resolve_understand_provider_with_choice(
    entitlement: &EntitlementService,
    cloud: CloudClient,
    auth: AuthClient,
    choice: Option<&str>,
) -> Result<Box<dyn UnderstandProvider>, AppError> {
    match choice {
        None => resolve_entitled_understand_provider(entitlement, cloud, auth, true).await,
        Some("codex") => {
            let snapshot = entitlement.current_or_sync(&auth).await;
            if !snapshot.policy.can_use_byo {
                return Err(AppError::Cloud("升级 Pro 解锁本机 codex 反推".into()));
            }
            resolve_understand_provider(Some("codex"), None)
        }
        Some("bowerbird-cloud") => {
            if !auth.snapshot().logged_in {
                return Err(AppError::Cloud("反推需要先登录 Bowerbird Cloud".into()));
            }
            resolve_understand_provider(Some("bowerbird-cloud"), Some((cloud, auth)))
        }
        Some(other) => Err(AppError::Cloud(format!("未知理解 provider: {other}"))),
    }
}
