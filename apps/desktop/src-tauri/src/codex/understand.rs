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
    text: String,
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
        let image_path = req
            .reference_images
            .first()
            .ok_or_else(|| AppError::Cloud("云理解需要一张图片".into()))?;
        let image = read_cloud_jpeg(image_path, false).await?;
        let response = self
            .auth
            .send_authorized(
                self.cloud.http().post(endpoint).json(&serde_json::json!({
                    "idempotency_key": req.job_id.unwrap_or_else(|| Ulid::new().to_string()),
                    "operation": operation.as_str(),
                    "image": image,
                    "instruction": req.instruction,
                })),
                "云理解请求失败",
            )
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
        let result: UnderstandResponse = serde_json::from_str(&body)
            .map_err(|error| AppError::Cloud(format!("解析云理解响应失败: {error}")))?;
        Ok(CodexResult {
            text: result.text,
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
