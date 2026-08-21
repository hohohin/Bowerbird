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

use crate::codex::types::{Capabilities, Chunk, CodexRequest, CodexResult, GenOutcome};
use crate::codex::GenProvider;
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
            binary: resolve_codex_binary().unwrap_or_else(|| "codex".to_string()),
            model: String::new(),
            enabled: true,
        }
    }
}

// generate_image 见下方 `impl GenProvider for CodexCliProvider`（Phase 1 从 inherent 提升为 trait 方法）。

const GEN_IMAGE_EXTS: [&str; 4] = ["png", "webp", "jpg", "jpeg"];

fn is_gen_image(p: &std::path::Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| GEN_IMAGE_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// 递归收集 dir 下所有图片文件的绝对路径（跑前/跑后快照用）。
fn collect_gen_images(dir: &std::path::Path, out: &mut std::collections::HashSet<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_gen_images(&p, out);
        } else if is_gen_image(&p) {
            out.insert(p);
        }
    }
}

fn list_generated_images(root: Option<&std::path::Path>) -> std::collections::HashSet<PathBuf> {
    let mut set = std::collections::HashSet::new();
    if let Some(r) = root {
        collect_gen_images(r, &mut set);
    }
    set
}

/// 取 `~/.codex/generated_images/` 里「跑前快照 `before` 之后新增」的图片源路径（按路径排序）。
/// 不 copy（command 层 `ingest_generated` 进库）；比 mtime 稳：不受时钟精度 / 落盘时机 /
/// resume 另起 session 子目录影响（mtime 偶发漏图）。
fn list_new_generated(
    root: Option<&std::path::Path>,
    before: &std::collections::HashSet<PathBuf>,
) -> Vec<PathBuf> {
    let mut after = std::collections::HashSet::new();
    if let Some(r) = root {
        collect_gen_images(r, &mut after);
    }
    let mut new_files: Vec<PathBuf> = after
        .iter()
        .filter(|p| !before.contains(*p))
        .cloned()
        .collect();
    new_files.sort();
    new_files
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
impl GenProvider for CodexCliProvider {
    fn name(&self) -> &str {
        "codex-cli"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            chat: true,
            caption: true,
            generate: true,
        }
    }

    async fn run(&self, req: CodexRequest) -> Result<CodexResult, AppError> {
        if !self.enabled {
            return Err(AppError::Codex("CodexCliProvider 未启用".into()));
        }
        let start = Instant::now();

        let mut cmd = codex_command(&self.binary);
        cmd.arg("exec").arg("--skip-git-repo-check").arg("--json");
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
    async fn generate_image(
        &self,
        req: CodexRequest,
        tx: &mpsc::Sender<Chunk>,
        resume_session: Option<String>,
    ) -> Result<GenOutcome, AppError> {
        if !self.enabled {
            return Err(AppError::Codex("CodexCliProvider 未启用".into()));
        }
        let start = SystemTime::now();

        // codex 内置 imagegen 把产物固定写进 ~/.codex/generated_images/（见踩坑）。
        // 跑前快照已有图，跑完按「新增文件」copy —— 比 mtime 稳：不受时钟精度 / 落盘时机 /
        // resume 续接另起 session 子目录影响（mtime 偶发漏图）。
        let codex_home = codex_home();
        let gen_root = codex_home.map(|h| h.join("generated_images"));
        let before = list_generated_images(gen_root.as_deref());

        let mut cmd = codex_command(&self.binary);
        cmd.arg("exec").arg("--skip-git-repo-check").arg("--json");
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
        let mut stdout = BufReader::new(stdout);

        // 读行 + 等退出整体套 600s 超时（防 codex 挂住不关 stdout 时无限阻塞）。
        // 多张图串行生成耗时翻倍（每张数十秒），故比反推的 180s 宽松；覆盖典型 4–6 张。
        let (status, session_id, texts) =
            match tokio::time::timeout(Duration::from_secs(600), async {
                let mut session_id: Option<String> = None;
                let mut texts: Vec<String> = Vec::new();
                let mut line_bytes = Vec::new();
                loop {
                    line_bytes.clear();
                    let read = stdout
                        .read_until(b'\n', &mut line_bytes)
                        .await
                        .map_err(|e| AppError::Codex(format!("读 codex 输出失败: {e}")))?;
                    if read == 0 {
                        break;
                    }
                    // Windows 的 npm shim / CLI 偶发在 JSONL 流混入本地代码页字节；
                    // 严格 lines() 会因 invalid UTF-8 终止整个生成，lossy 解码只替换异常字节，
                    // 完整 JSON 事件仍能照常解析。
                    let line_lossy = String::from_utf8_lossy(&line_bytes);
                    let line = line_lossy.trim();
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
                                if item.get("type").and_then(|t| t.as_str())
                                    == Some("agent_message")
                                {
                                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                                        let _ = tx
                                            .send(Chunk::Delta {
                                                text: text.to_string(),
                                            })
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
            })
            .await
            {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    let _ = child.kill().await;
                    let stderr_str = stderr_task.await.unwrap_or_default();
                    let stderr_head: String = stderr_str.trim().chars().take(500).collect();
                    let detail = if stderr_head.is_empty() {
                        "codex 未输出 stderr；请在命令提示符运行 codex --version 和 codex login"
                            .to_string()
                    } else {
                        format!("stderr: {stderr_head}")
                    };
                    return Err(AppError::Codex(format!(
                        "codex 生成超时（600s） | {detail}"
                    )));
                }
            };

        let stderr_str = stderr_task.await.unwrap_or_default();
        if !status.success() && texts.is_empty() {
            let stderr_head: String = stderr_str.trim().chars().take(500).collect();
            return Err(AppError::Codex(format!(
                "codex 退出 {} | stderr: {stderr_head}",
                status
            )));
        }

        // 扫 codex generated_images，取「跑前快照之后新增」的源图路径（在 ~/.codex/，
        // 不在 asset scope 内，由 command 层 ingest_generated 进库后才能渲染）。
        let source_images =
            tokio::task::spawn_blocking(move || list_new_generated(gen_root.as_deref(), &before))
                .await
                .map_err(|e| AppError::Other(e.to_string()))?;

        if source_images.is_empty() {
            let reply: String = texts.join("\n").trim().chars().take(500).collect();
            let detail = if reply.is_empty() {
                "codex 没有返回文字，也没有在 generated_images 中写入图片".to_string()
            } else {
                format!("codex 回复：{reply}")
            };
            return Err(AppError::Codex(format!("codex 未生成图片 | {detail}")));
        }

        Ok(GenOutcome {
            text: texts.join("\n"),
            session_id,
            submit_id: None, // codex provider 无 submit_id 概念（仅即梦走 Chunk::Submit 回填）
            elapsed_ms: start.elapsed().unwrap_or_default().as_millis() as u64,
            source_images,
            temp_dir: None,
        })
    }
}

/// 应用数据目录（与 setup 时 Tauri `app.path().app_data_dir()` 同值，identifier 固定
/// `com.bowerbird.desktop`）。`resolve_codex_binary` 等无 AppHandle 的自由函数用它
/// 定位托管安装的 codex，须与 lib.rs setup 的取法保持一致（Windows Roaming AppData /
/// macOS Application Support / Linux XDG_DATA_HOME）。
pub(crate) fn app_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return Some(PathBuf::from(appdata).join("com.bowerbird.desktop"));
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("com.bowerbird.desktop"),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(xdg).join("com.bowerbird.desktop"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = std::env::var_os("HOME") {
        return Some(
            PathBuf::from(home)
                .join(".local/share")
                .join("com.bowerbird.desktop"),
        );
    }
    None
}

/// 托管安装的 codex 二进制（一键直装解压到 `{app_data}/codex-cli/vendor/<triple>/bin/`）。
/// triple 由安装时的平台包决定，这里扫 `vendor/*/bin/` 定位，不对目录名做硬编码。
pub(crate) fn managed_codex_binary() -> Option<PathBuf> {
    let vendor = app_data_dir()?.join("codex-cli").join("vendor");
    let name = if cfg!(target_os = "windows") {
        "codex.exe"
    } else {
        "codex"
    };
    std::fs::read_dir(&vendor)
        .ok()?
        .flatten()
        .map(|e| e.path().join("bin").join(name))
        .find(|p| p.is_file())
}

/// Windows 的 npm 全局入口通常是 `codex.cmd`，不能直接交给 CreateProcess；
/// 同时覆盖 GUI 应用常见的 PATH 不完整场景，主动检查 npm 默认目录。
/// 非 Windows 直接在 PATH 找 `codex`。可用 `BOWERBIRD_CODEX_BINARY` 环境变量显式覆盖。
pub(crate) fn resolve_codex_binary() -> Option<String> {
    if let Ok(explicit) = std::env::var("BOWERBIRD_CODEX_BINARY") {
        if !explicit.trim().is_empty() {
            return Some(explicit);
        }
    }

    // 应用内一键直装的独立版优先（版本由应用管理，不依赖用户装 Node / npm）。
    if let Some(managed) = managed_codex_binary() {
        return Some(managed.to_string_lossy().into_owned());
    }

    #[cfg(target_os = "windows")]
    {
        let names = ["codex.exe", "codex.cmd", "codex.bat"];
        // Codex Desktop 自带的 WindowsApps CLI 可能落后于服务端模型缓存格式。
        // 优先使用 onboarding 指引安装的 npm CLI，再回退到 PATH 中的版本。
        if let Some(appdata) = std::env::var_os("APPDATA") {
            for name in names {
                let candidate = PathBuf::from(&appdata).join("npm").join(name);
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                for name in names {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("codex");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// codex 凭证/产物根目录：`CODEX_HOME` 优先，否则 `USERPROFILE`（Windows）/ `HOME`（Unix）+ `.codex`。
/// 与反推/生成的取图快照、auth.json 检测共用，保证三处对「codex home」的判定一致。
pub(crate) fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|home| PathBuf::from(home).join(".codex"))
        })
}

/// 构造跨平台的 codex 子进程 Command。
/// Windows 上 `.cmd`/`.bat` 入口必须经 `cmd.exe /D /S /C` 调起（CreateProcess 不解析 PATHEXT）；
/// 并加 `CREATE_NO_WINDOW`（0x08000000）—— Tauri release 是 windows_subsystem="windows"，
/// 不加此 flag 时 console 子进程会弹出空白 cmd 窗口（stderr/stdout 仍由 pipe 正常捕获）。
pub(crate) fn codex_command(binary: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        let lower = binary.to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut command = Command::new("cmd.exe");
            command.arg("/D").arg("/S").arg("/C").arg(binary);
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            return command;
        }
        let mut command = Command::new(binary);
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        return command;
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(binary)
    }
}

/// npm 二进制发现（一键安装 codex CLI 用）：`BOWERBIRD_NPM_BINARY` 显式覆盖；
/// Windows 先找 `%APPDATA%\npm\npm.{cmd,exe,bat}`（与 codex 同目录，装 Node 后默认在此），
/// 再扫 PATH；非 Windows 在 PATH 找 `npm`。
pub(crate) fn resolve_npm_binary() -> Option<String> {
    if let Ok(explicit) = std::env::var("BOWERBIRD_NPM_BINARY") {
        if !explicit.trim().is_empty() {
            return Some(explicit);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let names = ["npm.exe", "npm.cmd", "npm.bat"];
        if let Some(appdata) = std::env::var_os("APPDATA") {
            for name in names {
                let candidate = PathBuf::from(&appdata).join("npm").join(name);
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
        if let Some(path) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path) {
                for name in names {
                    let candidate = dir.join(name);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("npm");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// 构造跨平台的 npm 子进程 Command（一键安装用）。args 随构造时传入。
/// Windows 上 npm.cmd 路径常含空格（如 `C:\Program Files\nodejs\npm.cmd`），cmd.exe /C
/// 对含空格 .cmd 必须用「外层引号包整条命令 + 内层引号包路径」的形式（`/S /C ""path" args"`），
/// 并用 `raw_arg` 绕开 Rust 标准 arg 转义与 cmd 引号规则的冲突——标准 `.arg` 会让 cmd
/// 把含空格路径拆成多 token 解析失败 exit 1。非 Windows 直接 spawn + args。
pub(crate) fn npm_command(binary: &str, args: &[&str]) -> Command {
    #[cfg(target_os = "windows")]
    {
        let joined = args.join(" ");
        let mut command = Command::new("cmd.exe");
        command.raw_arg(format!("/D /S /C \"\"{binary}\" {joined}\""));
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new(binary);
        for a in args {
            command.arg(a);
        }
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use ulid::Ulid;

    #[test]
    fn list_new_only_returns_files_new_since_snapshot() {
        let root = std::env::temp_dir().join(format!("bb-scan-root-{}", Ulid::new()));
        fs::create_dir_all(&root).unwrap();

        // 跑前快照：已有一张旧图（不该返回）。
        fs::write(root.join("old.png"), b"old").unwrap();
        let before = list_generated_images(Some(&root));

        // 跑后新增两张图（该返回），外加一个非图片（不该返回）。
        fs::write(root.join("new1.png"), b"n1").unwrap();
        fs::write(root.join("new2.webp"), b"n2").unwrap();
        fs::write(root.join("note.txt"), b"x").unwrap();

        let new_files = list_new_generated(Some(&root), &before);

        assert_eq!(
            new_files.len(),
            2,
            "应只返回跑后新增的 2 张图，旧图与非图片排除"
        );
        let names: Vec<String> = new_files
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
            .collect();
        assert!(names.contains(&"new1.png".to_string()));
        assert!(names.contains(&"new2.webp".to_string()));

        fs::remove_dir_all(&root).ok();
    }
}
