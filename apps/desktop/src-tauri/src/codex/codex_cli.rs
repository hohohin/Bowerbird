//! Codex CLI provider（OpenAI Codex 无头模式 `codex exec --image`）。
//!
//! 走 ChatGPT 订阅认证（不走 OpenAI API quota，绕过 insufficient_quota），
//! `-i/--image` 直接附加本地图片，真正多模态看图（反推用）。
//! 国内访问 chatgpt.com WebSocket 会 reset，codex 自动回退 HTTPS（见踩坑）。
//! 依赖：`codex` CLI 已登录（`codex login`）且在 PATH。

use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::codex::types::{Chunk, CodexRequest, CodexResult};
use crate::codex::CodexProvider;
use crate::error::AppError;

pub struct CodexCliProvider {
    /// 可执行文件名/路径，默认 "codex"。
    pub binary: String,
    /// 模型；空则用 codex 默认（当前 gpt-5.x）。
    pub model: String,
    pub enabled: bool,
}

impl Default for CodexCliProvider {
    fn default() -> Self {
        Self {
            binary: "codex".to_string(),
            model: String::new(),
            enabled: true,
        }
    }
}

/// 解析 `codex exec` 文本输出：答案在 "\ncodex\n" 之后、"\ntokens used" 之前。
fn parse_answer(stdout: &str) -> String {
    if let Some(idx) = stdout.find("\ncodex\n") {
        let after = &stdout[idx + "\ncodex\n".len()..];
        let answer = match after.find("\ntokens used") {
            Some(end) => &after[..end],
            None => after,
        };
        let trimmed = answer.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    // 兜底：返回 stdout 末尾非空段
    stdout.trim().to_string()
}

#[async_trait]
impl CodexProvider for CodexCliProvider {
    fn name(&self) -> &'static str {
        "codex-cli"
    }

    async fn run(&self, req: CodexRequest) -> Result<CodexResult, AppError> {
        if !self.enabled {
            return Err(AppError::Codex("CodexCliProvider 未启用".into()));
        }
        let start = Instant::now();

        let mut cmd = Command::new(&self.binary);
        cmd.arg("exec").arg("--skip-git-repo-check");
        for img in &req.reference_images {
            cmd.arg("--image").arg(img);
        }
        if !self.model.is_empty() {
            cmd.arg("-m").arg(&self.model);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            AppError::Codex(format!(
                "启动 codex 失败: {e}（未安装/未登录？运行 `codex login`）"
            ))
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(req.instruction.as_bytes()).await;
        }

        let output = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output())
            .await
            .map_err(|_| AppError::Codex("codex 执行超时（180s）".into()))?
            .map_err(|e| AppError::Codex(format!("等待 codex 失败: {e}")))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr_head: String = stderr.trim().chars().take(500).collect();
            // codex 有时退出码非 0 但 stdout 有答案（如 WS reset 后回退）；优先看 stdout。
            let answer = parse_answer(&stdout);
            if !answer.is_empty() {
                return Ok(CodexResult {
                    text: answer,
                    structured: None,
                    provider: self.name().to_string(),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                });
            }
            return Err(AppError::Codex(format!(
                "codex 退出 {} | stderr: {stderr_head}",
                output.status
            )));
        }

        let text = parse_answer(&stdout);
        Ok(CodexResult {
            text,
            structured: None,
            provider: self.name().to_string(),
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn run_stream(
        &self,
        req: CodexRequest,
        tx: mpsc::Sender<Chunk>,
    ) -> Result<(), AppError> {
        // codex exec 是整体输出（非流），run 完一次性 Done。
        let r = self.run(req).await?;
        let _ = tx.send(Chunk::Done(r)).await;
        Ok(())
    }
}
