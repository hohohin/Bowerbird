//! 即梦（Dreamina）CLI provider —— 官方 `dreamina` 命令行工具。
//!
//! 走 OAuth 登录态（`dreamina login`，即梦会员积分），与 codex CLI 同构的本地子进程。
//! 仅实现 `generate_image`（文生图 / 图生图）；`run`（理解类）不支持——即梦无文本对话能力。
//! 详见 AI-PROVIDERS.md §3（spike 实测）/§5.3。
//!
//! 依赖：`dreamina` CLI 已登录（`dreamina login`）且在 PATH（或 `%USERPROFILE%\bin`）。

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use tokio::process::Command;
use tokio::sync::mpsc;
use ulid::Ulid;

use crate::codex::types::{Capabilities, Chunk, CodexRequest, CodexResult, GenOutcome};
use crate::codex::GenProvider;
use crate::core::ingest::walk_images;
use crate::error::AppError;

/// `text2image --poll` 等待秒数。spike 实测单图 60s 内完成，给 120s 余量。
const POLL_SECS: u64 = 120;
/// 单次子进程（提交 / 查询）整体超时上限。
const CMD_TIMEOUT_SECS: u64 = 180;

pub struct DreaminaCliProvider {
    /// 可执行文件名/路径，默认 "dreamina"（经 `resolve_dreamina_binary` 解析）。
    pub binary: String,
    pub enabled: bool,
}

impl Default for DreaminaCliProvider {
    fn default() -> Self {
        Self {
            binary: resolve_dreamina_binary().unwrap_or_else(|| "dreamina".to_string()),
            enabled: true,
        }
    }
}

#[async_trait]
impl GenProvider for DreaminaCliProvider {
    fn name(&self) -> &'static str {
        "jimeng"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            chat: false,
            caption: false,
            generate: true,
        }
    }

    /// 即梦无文本对话能力（仅生成），理解类任务不支持（AI-PROVIDERS.md §4.3）。
    async fn run(&self, _req: CodexRequest) -> Result<CodexResult, AppError> {
        Err(AppError::Codex(
            "即梦无文本对话能力（仅生成；理解类走 codex）".into(),
        ))
    }

    /// 生成（出图）：spawn `dreamina text2image/image2image --poll` 提交任务 →
    /// `dreamina query_result --download_dir` 下载到临时目录 → `walk_images` 扫图。
    /// `source_images` 在临时目录，`temp_dir` 一并返回，由 command 层 ingest 后删目录。
    /// `resume_session` 忽略（续轮 image2image 传上一轮图留后续）。
    async fn generate_image(
        &self,
        req: CodexRequest,
        tx: &mpsc::Sender<Chunk>,
        _resume_session: Option<String>,
    ) -> Result<GenOutcome, AppError> {
        if !self.enabled {
            return Err(AppError::Codex("DreaminaCliProvider 未启用".into()));
        }
        let start = SystemTime::now();
        // dreamina 无逐字流式，推一条伪进度 Delta（AI-PROVIDERS.md §6.3 方案 A）。
        let _ = tx
            .send(Chunk::Delta {
                text: "[即梦] 生成中…".to_string(),
            })
            .await;

        // ① 提交生成任务：无参考图走 text2image，有则 image2image（参考图作 --images）。
        let mut submit = dreamina_command(&self.binary);
        if req.reference_images.is_empty() {
            submit.arg("text2image");
        } else {
            submit.arg("image2image");
            for img in &req.reference_images {
                submit.arg("--images").arg(img);
            }
        }
        submit.arg("--prompt").arg(&req.instruction);
        if let Some(r) = req.ratio.as_deref() {
            let r = r.trim();
            if !r.is_empty() {
                submit.arg("--ratio").arg(r);
            }
        }
        submit
            .arg("--resolution_type")
            .arg("2k")
            .arg("--generate_num")
            .arg("1")
            .arg("--poll")
            .arg(POLL_SECS.to_string());
        submit
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let submit_out = tokio::time::timeout(Duration::from_secs(CMD_TIMEOUT_SECS), submit.output())
            .await
            .map_err(|_| AppError::Codex(format!("dreamina 提交超时（{CMD_TIMEOUT_SECS}s）")))?
            .map_err(|e| {
                AppError::Codex(format!(
                    "启动 dreamina 失败: {e}（未安装/未登录？运行 `dreamina login`）"
                ))
            })?;
        let submit_stdout = String::from_utf8_lossy(&submit_out.stdout);
        if !submit_out.status.success() {
            let stderr_head: String =
                String::from_utf8_lossy(&submit_out.stderr).trim().chars().take(500).collect();
            let stdout_head: String = submit_stdout.trim().chars().take(300).collect();
            return Err(AppError::Codex(format!(
                "dreamina 提交退出 {} | stderr: {stderr_head} | stdout: {stdout_head}",
                submit_out.status
            )));
        }
        let submit_id = parse_submit_id(&submit_stdout)?;

        // ② 下载：query_result --download_dir 到临时目录（对标 ingest_from_url 临时目录惯例）。
        let download_dir = std::env::temp_dir().join(format!("bowerbird-dreamina-{}", Ulid::new()));
        std::fs::create_dir_all(&download_dir)
            .map_err(|e| AppError::Other(format!("建临时目录失败: {e}")))?;

        let mut query = dreamina_command(&self.binary);
        query
            .arg("query_result")
            .arg("--submit_id")
            .arg(&submit_id)
            .arg("--download_dir")
            .arg(&download_dir);
        query
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let query_out = tokio::time::timeout(Duration::from_secs(CMD_TIMEOUT_SECS), query.output())
            .await
            .map_err(|_| AppError::Codex(format!("dreamina query_result 超时（{CMD_TIMEOUT_SECS}s）")))?
            .map_err(|e| AppError::Codex(format!("启动 dreamina query_result 失败: {e}")))?;

        if !query_out.status.success() {
            let stderr_head: String =
                String::from_utf8_lossy(&query_out.stderr).trim().chars().take(500).collect();
            return Err(AppError::Codex(format!(
                "dreamina query_result 退出 {} | stderr: {stderr_head}",
                query_out.status
            )));
        }

        // 扫下载目录里的图（query_result 可能一次下多张）。
        let source_images = walk_images(&download_dir);
        if source_images.is_empty() {
            let qstdout = String::from_utf8_lossy(&query_out.stdout);
            let head: String = qstdout.trim().chars().take(300).collect();
            return Err(AppError::Codex(format!(
                "dreamina 未下载到图片（submit_id={submit_id}） | query stdout: {head}"
            )));
        }

        Ok(GenOutcome {
            text: format!("[即梦] 生成 {} 张图", source_images.len()),
            session_id: None, // 首轮 only；续轮（image2image 传上一轮图）留后续。
            elapsed_ms: start.elapsed().unwrap_or_default().as_millis() as u64,
            source_images,
            temp_dir: Some(download_dir), // command 层 ingest 后删此目录。
        })
    }
}

/// 从 `dreamina text2image --poll` 的 stdout JSON 解析 `submit_id`，并校验 `gen_status`。
/// spike 实测结构：`{ "submit_id": "<UUID>", "gen_status": "success", "result_json": {...} }`。
/// dreamina 输出 **pretty JSON（多行带缩进，非 JSONL）**，须整体解析为一个对象，
/// 不能按行找（codex JSONL 那样逐行 `{...}` 在这里只有首行是 `{`、不完整）。
/// gen_status ∈ {success, querying} 视为提交成功（AI-PROVIDERS.md §3.3 契约）；fail/空报错。
fn parse_submit_id(stdout: &str) -> Result<String, AppError> {
    let head = || -> String { stdout.trim().chars().take(400).collect() };
    // 取第一个 '{' 起（容忍前导提示行），流式解析取首个值（容忍尾随文本）。
    let start = stdout
        .find('{')
        .ok_or_else(|| AppError::Codex(format!("dreamina 提交输出无 JSON | stdout: {}", head())))?;
    let v: serde_json::Value = serde_json::Deserializer::from_str(&stdout[start..])
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Codex("dreamina 提交输出 JSON 为空".into()))?
        .map_err(|e| {
            AppError::Codex(format!("dreamina 提交输出 JSON 解析失败: {e} | stdout: {}", head()))
        })?;
    if v.get("gen_status").and_then(|s| s.as_str()) == Some("fail") {
        return Err(AppError::Codex(format!(
            "dreamina 生成失败（gen_status=fail） | stdout: {}",
            head()
        )));
    }
    v.get("submit_id")
        .and_then(|i| i.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Codex(format!("dreamina 提交输出未含 submit_id | stdout: {}", head())))
}

/// dreamina 二进制解析（对称 `resolve_codex_binary`）：
/// `BOWERBIRD_DREAMINA_BINARY` env → Windows `%USERPROFILE%\bin\dreamina.exe` → PATH →
/// Unix `~/.local/bin/dreamina` → PATH。
pub(crate) fn resolve_dreamina_binary() -> Option<String> {
    if let Ok(explicit) = std::env::var("BOWERBIRD_DREAMINA_BINARY") {
        if !explicit.trim().is_empty() {
            return Some(explicit);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let names = ["dreamina.exe", "dreamina.cmd", "dreamina.bat"];
        // 安装脚本把 dreamina 装到 %USERPROFILE%\bin；GUI 应用 PATH 可能未含它，主动查。
        if let Some(home) = std::env::var_os("USERPROFILE") {
            for name in names {
                let candidate = PathBuf::from(&home).join("bin").join(name);
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                for name in &names {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix：安装脚本装到 ~/.local/bin。
        if let Some(home) = std::env::var_os("HOME") {
            let candidate = PathBuf::from(&home).join(".local").join("bin").join("dreamina");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                let candidate = dir.join("dreamina");
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

/// dreamina 配置/登录态根目录：`USERPROFILE`（Windows）/ `HOME`（Unix）+ `.dreamina_cli`。
pub(crate) fn dreamina_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".dreamina_cli"))
}

/// 构造跨平台的 dreamina 子进程 Command。
/// dreamina 是原生二进制（非 npm .cmd/.bat shim），无需 codex 那套 `cmd.exe /D /S /C`；
/// 但 Windows 仍需 `CREATE_NO_WINDOW`（0x08000000）防 GUI release 弹黑窗。
pub(crate) fn dreamina_command(binary: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new(binary);
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        return command;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(binary)
    }
}
