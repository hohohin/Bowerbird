//! Codex Provider 公共类型（开发计划 §2.4）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 发给 codex 的请求：指令 + 参考图 + 上下文提示词。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexRequest {
    pub instruction: String,
    #[serde(default)]
    pub reference_images: Vec<PathBuf>,
    #[serde(default)]
    pub context_prompts: Vec<String>,
    /// 出图比例（如 "16:9"）。仅即梦 provider 读（拼 dreamina `--ratio`）；
    /// codex 不用此字段（ratio 已注入 instruction 文本，见 codex_create_image）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ratio: Option<String>,
}

/// 单次调用结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexResult {
    pub text: String,
    pub provider: String,
    pub elapsed_ms: u64,
    /// codex 会话 id（`codex exec --json` 的 `thread_id`），可用 `codex resume <id>`
    /// 在 TUI 里回看本次调用的完整对话（含图）。仅 CodexCliProvider 填充。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// codex 本次生成的图像（已 copy 进 `library/generations/`，前端 convertFileSrc 直渲染）。
    /// 仅 `codex_create_image`（图像生成流程）填充；反推 / 生成提示词不填。
    /// 落盘位置固定在 `~/.codex/generated_images/<uuid>/ig_*.png`（codex 内置 imagegen 技能），
    /// 由 `generate_image` 按 mtime 扫出并 copy。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<PathBuf>,
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

/// `CodexCliProvider::generate_image` 的产出：codex 跑完后的文本 + 会话 id + 生成的源图
/// （在 `~/.codex/generated_images/`，不在 asset scope 内，不能直渲染）。command 层把它
/// `ingest_generated` 进库后，拼成 `CodexResult`（images = 库内 asset 路径）发 `Done`。
#[derive(Debug, Clone)]
pub struct GenOutcome {
    pub text: String,
    pub session_id: Option<String>,
    pub elapsed_ms: u64,
    pub source_images: Vec<PathBuf>,
    /// `source_images` 所在临时目录（如有）。command 层 `ingest_generated` 后应删此目录；
    /// `None` 表示源图在持久位置（如 codex 的 `~/.codex/`），不需清理。即梦 provider 用（下载目录）。
    pub temp_dir: Option<PathBuf>,
}

/// provider 能力自述（AI-PROVIDERS.md §4.3：理解类只走 codex，切换只发生在生成）。
/// 理解类（`chat` / `caption`）仅 codex；`generate` codex + 即梦都有。
/// UI 据此决定 provider 下拉项是否可选、续轮能否切换。
#[allow(dead_code)] // Phase 3 前端 provider 切换 UI 消费；Phase 1/2 仅 codex 实现自述、暂无调用方
#[derive(Debug, Clone, Copy)]
pub struct Capabilities {
    pub chat: bool,
    pub caption: bool,
    pub generate: bool,
}
