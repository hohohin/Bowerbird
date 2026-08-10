use std::path::PathBuf;
use std::time::Instant;

use async_trait::async_trait;
use base64::Engine;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::cloud::{AuthClient, CloudClient, EntitlementService};
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
    fn name(&self) -> &'static str;
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
    fn name(&self) -> &'static str {
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
    fn name(&self) -> &'static str {
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
            .ok_or_else(|| AppError::Cloud("Bowerbird Cloud 未启用或端点未配置".into()))?;
        let token = self.auth.access_token().await?;
        let image_path = req
            .reference_images
            .first()
            .ok_or_else(|| AppError::Cloud("云理解需要一张图片".into()))?;
        let image = read_image(image_path).await?;
        let response = self
            .cloud
            .http()
            .post(endpoint)
            .bearer_auth(token)
            .json(&serde_json::json!({
                "idempotency_key": req.job_id.unwrap_or_else(|| Ulid::new().to_string()),
                "operation": operation.as_str(),
                "image": image,
                "instruction": req.instruction,
            }))
            .send()
            .await
            .map_err(|error| AppError::Cloud(format!("云理解请求失败: {error}")))?;
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

async fn read_image(path: &PathBuf) -> Result<serde_json::Value, AppError> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| AppError::Cloud(format!("读取图片 {} 失败: {error}", path.display())))?;
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "image/png",
    };
    Ok(serde_json::json!({
        "mime": mime,
        "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
    }))
}
