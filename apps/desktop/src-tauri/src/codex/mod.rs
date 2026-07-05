//! Codex Provider 抽象（开发计划 §2.4）。
//!
//! 统一 trait，首期实现 ClaudeCode（`claude -p`）+ Mock（开发/离线）。
//! Phase 3 会验证 `claude -p` 的多模态看图传参机制（路径/编码/MCP），届时
//! 在 `claude_code.rs` 内部切换，trait 不变。

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::error::AppError;

use self::types::{Chunk, CodexRequest, CodexResult};

pub mod types;
pub mod mock;
pub mod claude_code;

#[async_trait]
pub trait CodexProvider: Send + Sync {
    /// provider 标识（落库 `analyses.provider` / `prompts.source_model`）。
    fn name(&self) -> &'static str;

    /// 单轮：给定 prompt + 参考图，返回结构化结果（批量分析用）。
    async fn run(&self, req: CodexRequest) -> Result<CodexResult, AppError>;

    /// 流式：逐 token 推送（交互式拆解 / 实时呈现用）。
    async fn run_stream(
        &self,
        req: CodexRequest,
        tx: mpsc::Sender<Chunk>,
    ) -> Result<(), AppError>;
}
