//! 生成 / 理解 provider 抽象（开发计划 §2.4，AI-PROVIDERS.md §5）。
//!
//! 当前实现 [`CodexCliProvider`]（`codex exec --image`，ChatGPT 订阅认证，
//! 真正多模态看图）。即梦（官方 dreamina CLI）待 Phase 2 接入（同构子进程）。
//! Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线均已移除
//! （详见 PROJECT.md「多模态看图四条路径实测」与关键约定 1）。

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::error::AppError;

use self::codex_cli::CodexCliProvider;
use self::types::{Capabilities, Chunk, CodexRequest, CodexResult, GenOutcome};

pub mod bowerbird_cloud;
pub(crate) mod cloud_image;
pub mod codex_cli;
pub mod install;
pub mod jimeng;
pub mod openai_api;
pub mod types;
pub mod understand;

/// 生成 / 理解 provider。codex（理解 + 生成）与即梦（仅生成，Phase 2）各一实现。
/// 命令层经 [`resolve_gen_provider`] 按 `provider` 参数取实现（AI-PROVIDERS.md §5.2）。
#[async_trait]
pub trait GenProvider: Send + Sync {
    /// provider 标识（落库 `analyses.provider` / `prompts.source_model`）；Cloud 档位
    /// 为运行时字符串（云端数据驱动），本地 CLI 引擎为固定标识。
    fn name(&self) -> &str;

    /// 能力自述：理解类（chat / caption）仅 codex；generate 两者都有（AI-PROVIDERS.md §4.3）。
    #[allow(dead_code)] // Phase 3 前端 provider 切换 UI 消费；Phase 1/2 仅 provider 自述、暂无调用方
    fn capabilities(&self) -> Capabilities;

    /// 单轮：给定 prompt + 参考图，返回结果（反推 / 自动命名 / 生成提示词用）。
    async fn run(&self, req: CodexRequest) -> Result<CodexResult, AppError>;

    /// 生成（出图）：spawn 子进程画图，逐条结果经 `tx` 推 `Chunk`（codex=Delta 流式，
    /// 即梦=伪进度），返回源图路径（由 command 层 ingest 进库）。`resume_session`
    /// 对 codex 是 session_id（resume 续轮），即梦自行解释为「上一轮图句柄」。
    async fn generate_image(
        &self,
        req: CodexRequest,
        tx: &mpsc::Sender<Chunk>,
        resume_session: Option<String>,
    ) -> Result<GenOutcome, AppError>;
}

/// 按 `provider` 参数取实现（AI-PROVIDERS.md §5.2）。
///
/// - `None | "codex" | "default"` → [`CodexCliProvider`]（默认，当前唯一实现）；
/// - `"jimeng"` → [`DreaminaCliProvider`]，`dreamina_model` 注入 `--model_version`
///   （来自 settings，每次生成都重读 → 设置页热修改即生效）；
/// - 任意 `bowerbird-cloud*` 前缀 key → [`BowerbirdCloudProvider`]（档位由云端数据驱动，
///   service 经 [`bowerbird_cloud::cloud_service_for_key`] 解析，遗留 key 同样兼容）；
/// - 其他 → 报错。
///
/// Phase 1 `None` 直接默认 codex；Phase 3 加全局默认配置后，`None` 改读配置。
pub fn resolve_gen_provider(
    provider: Option<&str>,
    cloud: Option<(crate::cloud::CloudClient, crate::cloud::AuthClient)>,
    dreamina_model: Option<&str>,
) -> Result<Box<dyn GenProvider>, AppError> {
    let provider = provider.unwrap_or("codex");
    match provider {
        "codex" | "default" => Ok(Box::new(CodexCliProvider::default())),
        "jimeng" => {
            let mut p = jimeng::DreaminaCliProvider::default();
            if let Some(model) = dreamina_model.filter(|m| !m.trim().is_empty()) {
                p.model_version = model.trim().to_string();
            }
            Ok(Box::new(p))
        }
        key if key.starts_with("bowerbird-cloud") => {
            let (client, auth) =
                cloud.ok_or_else(|| AppError::Cloud("账号服务尚未初始化".into()))?;
            let service = bowerbird_cloud::cloud_service_for_key(key);
            Ok(Box::new(bowerbird_cloud::BowerbirdCloudProvider::new(
                client,
                auth,
                key.to_string(),
                service,
            )))
        }
        other => Err(AppError::Codex(format!("未知 provider: {other}").into())),
    }
}

/// provider key 是否为 Cloud 生图变体（Pro / Lite / Fast）。
pub fn is_cloud_generation_provider(provider: Option<&str>) -> bool {
    provider.is_some_and(|p| p.starts_with("bowerbird-cloud"))
}
