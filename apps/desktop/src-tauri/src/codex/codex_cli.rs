//! Codex CLI provider（OpenAI Codex 无头模式 `codex exec --image`）。
//!
//! 走 ChatGPT 订阅认证（不走 OpenAI API quota，绕过 insufficient_quota），
//! `-i/--image` 直接附加本地图片，真正多模态看图（反推用）。
//! 国内访问 chatgpt.com WebSocket 会 reset，codex 自动回退 HTTPS（见踩坑）。
//! 依赖：`codex` CLI 已登录（`codex login`）且在 PATH。
//!
//! 用 `--json` 输出 JSONL 事件流：从 `thread.started` 取 `thread_id`（session id，
//! 可用 `codex resume <id>` 在 TUI 回看完整对话），从 `item.completed` 取
//! `agent_message` 正文作为最终答案。

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

/// 解析 `codex exec --json` 的 JSONL 事件流：
/// - `thread.started` → `thread_id`（session id，用于 `codex resume <id>`）
/// - `item.completed`(item.type=agent_message) → `text`（最终答案，可能多段）
/// 跳过非 JSON 行（codex 的提示信息、stderr 误并等）。
fn parse_jsonl(stdout: &str) -> (Option<String>, String) {
    let mut session_id = None;
    let mut texts: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("thread.started") => {
                if let Some(id) = v.get("thread_id").and_then(|i| i.as_str()) {
                    session_id = Some(id.to_string());
                }
            }
            Some("item.completed") => {
                if let Some(item) = v.get("item") {
                    if item.get("type").and_then(|t| t.as_str()) == Some("agent_message") {
                        if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                            texts.push(text.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    (session_id, texts.join("\n"))
}

/// 兜底：解析非 `--json` 的文本输出（答案在 "\ncodex\n" 之后、"\ntokens used" 之前）。
/// 仅当 JSONL 解析失败时回退使用。
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
        cmd.arg("exec")
            .arg("--skip-git-repo-check")
            .arg("--json");
        for img in &req.reference_images {
            cmd.arg("--image").arg(img);
        }
        if !self.model.is_empty() {
            cmd.arg("-m").arg(&self.model);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 反推可取消：select 命中取消信号时 run future 被 drop，靠此自动 kill codex 子进程，
            // 避免取消后子进程仍在后台跑（消耗额度 / 与下次反推并发冲突）。
            .kill_on_drop(true);

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
        let (session_id, json_text) = parse_jsonl(&stdout);

        // JSONL 解析出 agent_message → 直接用（含退出码非 0 但已回退 HTTPS 拿到答案的情形）；
        // 否则：退出码非 0 报错；退出码 0 回退旧文本解析（兼容旧版 codex）。
        let text = if !json_text.is_empty() {
            json_text
        } else if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stderr_head: String = stderr.trim().chars().take(500).collect();
            return Err(AppError::Codex(format!(
                "codex 退出 {} | stderr: {stderr_head}",
                output.status
            )));
        } else {
            parse_answer(&stdout)
        };

        Ok(CodexResult {
            text,
            structured: None,
            provider: self.name().to_string(),
            elapsed_ms: start.elapsed().as_millis() as u64,
            session_id,
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
