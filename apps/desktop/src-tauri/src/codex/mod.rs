//! Codex Provider 抽象（开发计划 §2.4）。
//!
//! 当前唯一实现 [`CodexCliProvider`]（`codex exec --image`，ChatGPT 订阅认证，
//! 真正多模态看图）。Mock / ClaudeCode / DeepSeek / OpenAI HTTP 路线均已移除
//! （详见 PROJECT.md「多模态看图四条路径实测」与关键约定 1）。

use async_trait::async_trait;

use crate::error::AppError;

use self::types::{CodexRequest, CodexResult};

pub mod types;
pub mod codex_cli;
pub mod openai_api;

#[async_trait]
pub trait CodexProvider: Send + Sync {
    /// provider 标识（落库 `analyses.provider` / `prompts.source_model`）。
    fn name(&self) -> &'static str;

    /// 单轮：给定 prompt + 参考图，返回结果（反推 / 自动命名 / 生成提示词用）。
    /// 生成（出图）与流式见 `CodexCliProvider::generate_image`（inherent 方法）。
    async fn run(&self, req: CodexRequest) -> Result<CodexResult, AppError>;
}
