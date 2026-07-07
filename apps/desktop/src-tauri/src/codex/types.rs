//! Codex Provider 公共类型（开发计划 §2.4）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 发给 codex 的请求：指令 + 参考图 + 上下文提示词 + 期望输出 schema。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexRequest {
    pub instruction: String,
    #[serde(default)]
    pub reference_images: Vec<PathBuf>,
    #[serde(default)]
    pub context_prompts: Vec<String>,
    /// 期望结构化输出的 JSON Schema（可选；provider 尽力满足）。
    #[serde(default)]
    pub output_schema: Option<serde_json::Value>,
}

/// 单次调用结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexResult {
    pub text: String,
    #[serde(default)]
    pub structured: Option<serde_json::Value>,
    pub provider: String,
    pub elapsed_ms: u64,
    /// codex 会话 id（`codex exec --json` 的 `thread_id`），可用 `codex resume <id>`
    /// 在 TUI 里回看本次调用的完整对话（含图）。仅 CodexCliProvider 填充。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// 流式分片：增量文本 / 完成 / 错误。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Chunk {
    /// 增量文本（一段 token）。
    Delta { text: String },
    /// 流结束，附带最终结果。
    Done(CodexResult),
    /// 流中错误。
    Error { message: String },
}
