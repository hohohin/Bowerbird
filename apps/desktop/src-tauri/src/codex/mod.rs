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
pub mod codex_cli;
pub mod jimeng;
pub mod openai_api;
pub mod types;
pub mod understand;

/// 生成 / 理解 provider。codex（理解 + 生成）与即梦（仅生成，Phase 2）各一实现。
/// 命令层经 [`resolve_gen_provider`] 按 `provider` 参数取实现（AI-PROVIDERS.md §5.2）。
#[async_trait]
pub trait GenProvider: Send + Sync {
    /// provider 标识（落库 `analyses.provider` / `prompts.source_model`）。
    fn name(&self) -> &'static str;

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
/// - `"jimeng"` → Phase 2 接入；
/// - 其他 → 报错。
///
/// Phase 1 `None` 直接默认 codex；Phase 3 加全局默认配置后，`None` 改读配置。
pub fn resolve_gen_provider(
    provider: Option<&str>,
    cloud: Option<(crate::cloud::CloudClient, crate::cloud::AuthClient)>,
) -> Result<Box<dyn GenProvider>, AppError> {
    match provider.unwrap_or("codex") {
        "codex" | "default" => Ok(Box::new(CodexCliProvider::default())),
        "jimeng" => Ok(Box::new(jimeng::DreaminaCliProvider::default())),
        "bowerbird-cloud" => {
            let (client, auth) =
                cloud.ok_or_else(|| AppError::Cloud("账号服务尚未初始化".into()))?;
            Ok(Box::new(bowerbird_cloud::BowerbirdCloudProvider::new(
                client, auth,
            )))
        }
        other => Err(AppError::Codex(format!("未知 provider: {other}").into())),
    }
}
