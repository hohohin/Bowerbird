//! Claude Code provider（`claude -p` 子进程）。
//!
//! Phase 0：单轮 JSON 调用骨架；`enabled` 默认 false（用户需在设置启用，
//! 避免无意中消耗 token / 依赖账号）。
//!
//! **关键 spike（Phase 3 实测）**：`claude -p` 的多模态「看图」传参机制
//! 当前 `build_prompt` 把参考图路径拼为文本 —— 这是占位。Phase 3 将实测
//! 真实机制（候选：`claude -p` 的图片 flag / stdin 多模态 content blocks /
//! MCP 资源引用），届时只改本文件内部，trait 与调用方不变。

use std::process::Stdio;
use std::time::Instant;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::codex::types::{Chunk, CodexRequest, CodexResult};
use crate::codex::CodexProvider;
use crate::error::AppError;

pub struct ClaudeCodeProvider {
    /// 可执行文件名/路径。默认 "claude"（需在 PATH）。
    pub binary: String,
    /// 模型 id。默认 sonnet（性价比）。
    pub model: String,
    /// 额外参数（如 `--yes` 自动确认权限）。
    pub extra_args: Vec<String>,
    /// 未启用时所有调用直接返回错误。
    pub enabled: bool,
}

impl Default for ClaudeCodeProvider {
    fn default() -> Self {
        Self {
            binary: "claude".to_string(),
            model: "claude-sonnet-4-6".to_string(),
            extra_args: vec!["--yes".to_string()],
            enabled: false,
        }
    }
}

/// 组装 prompt 文本（参考图 + 上下文 + 指令 + schema）。
/// 注：图片「看图」传参机制 Phase 3 实测替换。
fn build_prompt(req: &CodexRequest) -> String {
    let mut s = String::new();
    if !req.reference_images.is_empty() {
        s.push_str("# 参考图（本地路径）\n");
        for (i, p) in req.reference_images.iter().enumerate() {
            s.push_str(&format!("{}. {}\n", i + 1, p.display()));
        }
        s.push_str("\n请基于以上参考图回答下列指令。\n\n");
    }
    if !req.context_prompts.is_empty() {
        s.push_str("# 上下文提示词\n");
        for p in &req.context_prompts {
            s.push_str(&format!("- {}\n", p));
        }
        s.push('\n');
    }
    s.push_str("# 指令\n");
    s.push_str(&req.instruction);
    if let Some(schema) = &req.output_schema {
        s.push_str("\n\n# 期望输出格式（JSON Schema）\n");
        s.push_str(&schema.to_string());
    }
    s
}

#[async_trait]
impl CodexProvider for ClaudeCodeProvider {
    fn name(&self) -> &'static str {
        "claude-code"
    }

    async fn run(&self, req: CodexRequest) -> Result<CodexResult, AppError> {
        if !self.enabled {
            return Err(AppError::Codex(
                "ClaudeCodeProvider 未启用（在设置中开启）".to_string(),
            ));
        }
        let prompt = build_prompt(&req);
        let start = Instant::now();

        let mut cmd = Command::new(&self.binary);
        cmd.arg("-p")
            .arg("--output-format")
            .arg("json")
            .arg("--model")
            .arg(&self.model);
        for a in &self.extra_args {
            cmd.arg(a);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::Codex(format!("启动 claude 失败: {e}")))?;

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
        }

        let output = child
            .wait_with_output()
            .await
            .map_err(|e| AppError::Codex(format!("等待 claude 失败: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Codex(format!(
                "claude 退出码 {} | stderr: {}",
                output.status.code().unwrap_or(-1),
                stderr.trim()
            )));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        // `claude -p --output-format json` 输出 JSON 信封，模型正文在 `result` 字段。
        let parsed: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| {
            let head = stdout.chars().take(500).collect::<String>();
            AppError::Codex(format!("解析 claude JSON 失败: {e} | 原始: {head}"))
        })?;
        let text = parsed
            .get("result")
            .and_then(|v| v.as_str())
            .unwrap_or(&stdout)
            .to_string();

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
        if !self.enabled {
            return Err(AppError::Codex(
                "ClaudeCodeProvider 未启用（在设置中开启）".to_string(),
            ));
        }
        let prompt = build_prompt(&req);
        let start = Instant::now();

        let mut cmd = Command::new(&self.binary);
        cmd.arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--model")
            .arg(&self.model);
        for a in &self.extra_args {
            cmd.arg(a);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::Codex(format!("启动 claude 失败: {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes()).await;
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Codex("no stdout".into()))?;
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut full = String::new();

        // stream-json：每行一个事件 JSON。assistant 含 text，result 为最终。
        while let Ok(Some(line)) = lines.next_line().await {
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("assistant") => {
                    if let Some(arr) = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(|c| c.as_array())
                    {
                        for c in arr {
                            if let Some(text) = c.get("text").and_then(|t| t.as_str()) {
                                full.push_str(text);
                                if tx
                                    .send(Chunk::Delta {
                                        text: text.to_string(),
                                    })
                                    .await
                                    .is_err()
                                {
                                    return Ok(()); // 接收端关闭
                                }
                            }
                        }
                    }
                }
                Some("result") => {
                    let text = v
                        .get("result")
                        .and_then(|r| r.as_str())
                        .unwrap_or(&full)
                        .to_string();
                    let _ = tx
                        .send(Chunk::Done(CodexResult {
                            text,
                            structured: None,
                            provider: self.name().to_string(),
                            elapsed_ms: start.elapsed().as_millis() as u64,
                        }))
                        .await;
                }
                _ => {}
            }
        }
        Ok(())
    }
}
