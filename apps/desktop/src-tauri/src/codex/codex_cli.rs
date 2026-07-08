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

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use ulid::Ulid;

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

impl CodexCliProvider {
    /// 图像生成：spawn `codex exec --json --image ...`，prompt 经 stdin 喂入。
    ///
    /// 与 `run`（反推用、整输出）不同——逐行读 JSONL，每条 `agent_message` 即时推为
    /// `Chunk::Delta`（app 内流式反馈）；跑完扫 `~/.codex/generated_images/` 取本次新增图
    /// （mtime ≥ start），copy 进 `generations_dir`（落在 asset scope `$APPDATA/**` 内，
    /// 可被 convertFileSrc 渲染），最后发 `Chunk::Done`（`images` = copy 后的库内路径）。
    ///
    /// 取图走 mtime 扫盘而非事件解析：codex 内置 imagegen 技能把产物固定写到
    /// `~/.codex/generated_images/<uuid>/ig_*.png`，路径不在 JSONL 一等字段里（spike 实测），
    /// 扫盘最稳。codex exec 默认只读沙箱会阻止写 cwd，故不能改用 cwd 扫盘。
    pub async fn generate_image(
        &self,
        req: CodexRequest,
        generations_dir: PathBuf,
        tx: mpsc::Sender<Chunk>,
        resume_session: Option<String>,
    ) -> Result<(), AppError> {
        if !self.enabled {
            return Err(AppError::Codex("CodexCliProvider 未启用".into()));
        }
        let start = SystemTime::now();

        let mut cmd = Command::new(&self.binary);
        cmd.arg("exec")
            .arg("--skip-git-repo-check")
            .arg("--json");
        match &resume_session {
            // 续接：codex 记得本会话历史 + 上一张图，按新指令编辑出图（spike 实测可行）。
            // `resume <sid> -`：`-` 让 resume 从 stdin 读本轮指令；--image 通常不需要（codex
            // 已有上一张图），但若调用方传了新参考图也支持。
            Some(sid) => {
                cmd.arg("resume");
                for img in &req.reference_images {
                    cmd.arg("--image").arg(img);
                }
                cmd.arg(sid).arg("-");
            }
            None => {
                for img in &req.reference_images {
                    cmd.arg("--image").arg(img);
                }
            }
        }
        if !self.model.is_empty() {
            cmd.arg("-m").arg(&self.model);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 生成可取消：select 命中取消信号时本 future 被 drop，靠此自动 kill codex 子进程。
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            AppError::Codex(format!(
                "启动 codex 失败: {e}（未安装/未登录？运行 `codex login`）"
            ))
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(req.instruction.as_bytes()).await;
        }

        // stderr 异步排空到 String，供失败时拼错误信息（不阻塞 stdout 行读）。
        let stderr_handle = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            if let Some(mut s) = stderr_handle {
                let _ = s.read_to_end(&mut buf).await;
            }
            String::from_utf8_lossy(&buf).to_string()
        });

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Codex("无法获取 codex stdout".into()))?;
        let mut lines = BufReader::new(stdout).lines();

        // 读行 + 等退出整体套 300s 超时（防 codex 挂住不关 stdout 时无限阻塞）。
        let (status, session_id, texts) = match tokio::time::timeout(
            Duration::from_secs(300),
            async {
                let mut session_id: Option<String> = None;
                let mut texts: Vec<String> = Vec::new();
                while let Some(line) = lines
                    .next_line()
                    .await
                    .map_err(|e| AppError::Codex(format!("读 codex 输出失败: {e}")))?
                {
                    let line = line.trim();
                    if line.is_empty() || !line.starts_with('{') {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("thread.started") => {
                            if let Some(id) =
                                v.get("thread_id").and_then(|i| i.as_str())
                            {
                                session_id = Some(id.to_string());
                            }
                        }
                        Some("item.completed") => {
                            if let Some(item) = v.get("item") {
                                if item.get("type").and_then(|t| t.as_str())
                                    == Some("agent_message")
                                {
                                    if let Some(text) =
                                        item.get("text").and_then(|t| t.as_str())
                                    {
                                        let _ = tx
                                            .send(Chunk::Delta { text: text.to_string() })
                                            .await;
                                        texts.push(text.to_string());
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                let status = child
                    .wait()
                    .await
                    .map_err(|e| AppError::Codex(format!("等待 codex 失败: {e}")))?;
                Ok::<_, AppError>((status, session_id, texts))
            },
        )
        .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(e),
            Err(_) => return Err(AppError::Codex("codex 生成超时（300s）".into())),
        };

        let stderr_str = stderr_task.await.unwrap_or_default();
        if !status.success() && texts.is_empty() {
            let stderr_head: String = stderr_str.trim().chars().take(500).collect();
            return Err(AppError::Codex(format!(
                "codex 退出 {} | stderr: {stderr_head}",
                status
            )));
        }

        // 扫 codex generated_images 取本次（mtime ≥ start）新增图 → copy 进库。
        let codex_home = std::env::var("CODEX_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| std::env::var("HOME").map(|h| PathBuf::from(h).join(".codex")).ok());
        let gen_root = codex_home.map(|h| h.join("generated_images"));
        let copied = tokio::task::spawn_blocking(move || {
            scan_and_copy_generated(gen_root.as_deref(), &generations_dir, start)
        })
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;

        let result = CodexResult {
            text: texts.join("\n"),
            provider: self.name().to_string(),
            elapsed_ms: start.elapsed().unwrap_or_default().as_millis() as u64,
            session_id,
            images: copied,
        };
        let _ = tx.send(Chunk::Done(result)).await;
        Ok(())
    }
}

/// 扫 `~/.codex/generated_images/<uuid>/ig_*.{png,webp,jpg,jpeg}`，取 mtime ≥ `start` 的文件，
/// copy 到 `dst_dir/<ulid>-<n>.<ext>`，返回 copy 后的库内路径。
/// `root=None`（解析不出 CODEX_HOME/HOME）时返回空。
fn scan_and_copy_generated(
    root: Option<&std::path::Path>,
    dst_dir: &std::path::Path,
    start: SystemTime,
) -> Vec<PathBuf> {
    let mut copied = Vec::new();
    let Some(root) = root else {
        return copied;
    };
    let _ = std::fs::create_dir_all(dst_dir);
    let ulid = Ulid::new().to_string();
    let exts = ["png", "webp", "jpg", "jpeg"];
    let Ok(rd) = std::fs::read_dir(root) else {
        return copied;
    };
    for entry in rd.flatten() {
        // 每条是 <uuid> 子目录，内含 ig_*.png。
        if !entry.path().is_dir() {
            continue;
        }
        let Ok(sub) = std::fs::read_dir(entry.path()) else {
            continue;
        };
        for f in sub.flatten() {
            let p = f.path();
            let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            let ext_lower = ext.to_lowercase();
            if !exts.contains(&ext_lower.as_str()) {
                continue;
            }
            let Ok(meta) = f.metadata() else {
                continue;
            };
            let Ok(mtime) = meta.modified() else {
                continue;
            };
            if mtime < start {
                continue;
            }
            let n = copied.len();
            let dst = dst_dir.join(format!("{ulid}-{n}.{ext}"));
            if std::fs::copy(&p, &dst).is_ok() {
                copied.push(dst);
            }
        }
    }
    copied
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
            provider: self.name().to_string(),
            elapsed_ms: start.elapsed().as_millis() as u64,
            session_id,
            images: Vec::new(),
        })
    }
}
