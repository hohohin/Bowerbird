//! 即梦（Dreamina）CLI provider —— 官方 `dreamina` 命令行工具。
//!
//! 走 OAuth 登录态（`dreamina login`，即梦会员积分），与 codex CLI 同构的本地子进程。
//! 仅实现 `generate_image`（文生图 / 图生图）；`run`（理解类）不支持——即梦无文本对话能力。
//! 详见 AI-PROVIDERS.md §3（spike 实测）/§5.3。
//!
//! 依赖：`dreamina` CLI 已登录（`dreamina login`）且在 PATH（或 `%USERPROFILE%\bin`）。

use std::path::{Path, PathBuf};
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

/// `text2image --poll` 等待秒数：仅用于 submit 后快速拿 submit_id（落库），**不等生成完成**。
/// 1s 退出（dreamina 仍在云端生成，stdout 给 querying JSON 含 submit_id）；后续 `query_result`
/// 自己 poll（poll_query_and_download）直到生成完成下载。这样 submit_id 秒级落库，app 被杀也能恢复。
const POLL_SECS: u64 = 1;
/// 单次子进程（提交 / 查询）整体超时上限。
const CMD_TIMEOUT_SECS: u64 = 180;

pub struct DreaminaCliProvider {
    /// 可执行文件名/路径，默认 "dreamina"（经 `resolve_dreamina_binary` 解析）。
    pub binary: String,
    /// 出图模型版本（`--model_version`）。text2image 支持 3.0~5.0Pro，image2image 仅 4.0+；
    /// 由 settings（`dreamina_model_version`）在每次生成前注入，改设置即热生效。
    pub model_version: String,
    pub enabled: bool,
}

impl Default for DreaminaCliProvider {
    fn default() -> Self {
        Self {
            binary: resolve_dreamina_binary().unwrap_or_else(|| "dreamina".to_string()),
            model_version: crate::core::settings::DEFAULT_DREAMINA_MODEL_VERSION.to_string(),
            enabled: true,
        }
    }
}

#[async_trait]
impl GenProvider for DreaminaCliProvider {
    fn name(&self) -> &str {
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
        Err(AppError::Jimeng(
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
        tx: &mpsc::Sender<Chunk>, // 即梦无逐字流式不推 Delta；但 submit 拿到 submit_id 时推 Submit（持久化 + 恢复用）
        resume_session: Option<String>,
    ) -> Result<GenOutcome, AppError> {
        if !self.enabled {
            return Err(AppError::Jimeng("DreaminaCliProvider 未启用".into()));
        }
        let start = SystemTime::now();

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
        submit.arg("--model_version").arg(&self.model_version);
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

        let submit_out =
            tokio::time::timeout(Duration::from_secs(CMD_TIMEOUT_SECS), submit.output())
                .await
                .map_err(|_| AppError::Jimeng(format!("dreamina 提交超时（{CMD_TIMEOUT_SECS}s）")))?
                .map_err(|e| {
                    AppError::Jimeng(format!(
                        "启动 dreamina 失败: {e}（未安装/未登录？运行 `dreamina login`）"
                    ))
                })?;
        let submit_stdout = String::from_utf8_lossy(&submit_out.stdout);
        if !submit_out.status.success() {
            let stderr_head: String = String::from_utf8_lossy(&submit_out.stderr)
                .trim()
                .chars()
                .take(500)
                .collect();
            let stdout_head: String = submit_stdout.trim().chars().take(300).collect();
            return Err(AppError::Jimeng(format!(
                "dreamina 提交退出 {} | stderr: {stderr_head} | stdout: {stdout_head}",
                submit_out.status
            )));
        }
        let submit_id = parse_submit_id(&submit_stdout)?;
        // 立即回填 submit_id：app 在下载完成前被杀也能恢复续查（provider 拿到瞬间发，不等下载）。
        let _ = tx
            .send(Chunk::Submit {
                submit_id: submit_id.clone(),
            })
            .await;

        // ② poll query_result 下载：submit --poll 1 只拿 submit_id（dreamina 仍在云端生成），
        //    这里轮询 query_result 直到生成完成下载到图。submit_id 已落库，app 被杀也能恢复续查。
        let source_images =
            poll_query_and_download(&self.binary, &submit_id, 30, Duration::from_secs(10)).await?;
        let temp_dir = source_images
            .first()
            .and_then(|p| p.parent().map(|x| x.to_path_buf()));

        Ok(GenOutcome {
            text: format!("[即梦] 生成 {} 张图", source_images.len()),
            // 会话标识：续轮（resume_session）沿用首轮 submit_id（回看关联各轮）；首轮用本次 submit_id。
            session_id: resume_session.clone().or(Some(submit_id.clone())),
            submit_id: Some(submit_id),
            elapsed_ms: start.elapsed().unwrap_or_default().as_millis() as u64,
            source_images,
            temp_dir, // command 层 ingest 后删此目录（poll 最后一次成功的下载目录）。
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
    let start = stdout.find('{').ok_or_else(|| {
        AppError::Jimeng(format!("dreamina 提交输出无 JSON | stdout: {}", head()))
    })?;
    let v: serde_json::Value = serde_json::Deserializer::from_str(&stdout[start..])
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Jimeng("dreamina 提交输出 JSON 为空".into()))?
        .map_err(|e| {
            AppError::Jimeng(format!(
                "dreamina 提交输出 JSON 解析失败: {e} | stdout: {}",
                head()
            ))
        })?;
    if v.get("gen_status").and_then(|s| s.as_str()) == Some("fail") {
        return Err(AppError::Jimeng(format!(
            "dreamina 生成失败（gen_status=fail） | stdout: {}",
            head()
        )));
    }
    v.get("submit_id")
        .and_then(|i| i.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            AppError::Jimeng(format!(
                "dreamina 提交输出未含 submit_id | stdout: {}",
                head()
            ))
        })
}

/// dreamina `query_result --submit_id --download_dir` → `walk_images` 扫产物。
/// 供正常 `generate_image` 与启动恢复 worker 复用。失败返回原始状态/stderr 错误（恢复 worker
/// 据此区分「远端仍在 querying」与致命错，见 generation_worker::poll_query_and_download）。
pub(crate) async fn query_and_download(
    binary: &str,
    submit_id: &str,
    download_dir: &Path,
) -> Result<Vec<PathBuf>, AppError> {
    let mut query = dreamina_command(binary);
    query
        .arg("query_result")
        .arg("--submit_id")
        .arg(submit_id)
        .arg("--download_dir")
        .arg(download_dir);
    query
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let query_out = tokio::time::timeout(Duration::from_secs(CMD_TIMEOUT_SECS), query.output())
        .await
        .map_err(|_| {
            AppError::Jimeng(format!("dreamina query_result 超时（{CMD_TIMEOUT_SECS}s）"))
        })?
        .map_err(|e| AppError::Jimeng(format!("启动 dreamina query_result 失败: {e}")))?;
    if !query_out.status.success() {
        let stderr_head: String = String::from_utf8_lossy(&query_out.stderr)
            .trim()
            .chars()
            .take(500)
            .collect();
        return Err(AppError::Jimeng(format!(
            "dreamina query_result 退出 {} | stderr: {stderr_head}",
            query_out.status
        )));
    }
    // 扫下载目录里的图（query_result 可能一次下多张）。
    let source_images = walk_images(download_dir);
    if source_images.is_empty() {
        let qstdout = String::from_utf8_lossy(&query_out.stdout);
        let head: String = qstdout.trim().chars().take(300).collect();
        return Err(AppError::Jimeng(format!(
            "dreamina 未下载到图片（submit_id={submit_id}） | query stdout: {head}"
        )));
    }
    Ok(source_images)
}

/// 策略 B：bounded poll loop（默认 30 次 × 10s = 5min 上限）。每次 `query_and_download`（新临时目录），
/// 间隔睡眠。供 `generate_image`（submit --poll 1 后轮询下载）与启动恢复 worker 复用。
/// 致命错（submit_id 无效/fail）早退；querying/空图类继续轮询到上限后返回末次错误。
pub(crate) async fn poll_query_and_download(
    binary: &str,
    submit_id: &str,
    max_attempts: u32,
    interval: Duration,
) -> Result<Vec<PathBuf>, AppError> {
    let mut last_err: Option<AppError> = None;
    for _ in 0..max_attempts {
        let dir = std::env::temp_dir().join(format!("bowerbird-dreamina-{}", Ulid::new()));
        if let Err(e) = std::fs::create_dir_all(&dir) {
            last_err = Some(AppError::Other(format!("建临时目录失败: {e}")));
            tokio::time::sleep(interval).await;
            continue;
        }
        match query_and_download(binary, submit_id, &dir).await {
            Ok(imgs) if !imgs.is_empty() => return Ok(imgs),
            Ok(_) => {
                let _ = std::fs::remove_dir_all(&dir);
                last_err = Some(AppError::Jimeng("远端仍在生成，未下载到图片".into()));
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                let msg = e.to_string();
                let fatal = msg.contains("无效")
                    || msg.contains("not found")
                    || msg.contains("不存在")
                    || msg.contains("fail");
                if fatal {
                    return Err(e);
                }
                last_err = Some(e);
            }
        }
        tokio::time::sleep(interval).await;
    }
    Err(last_err.unwrap_or_else(|| AppError::Jimeng("轮询超时，远端仍在生成".into())))
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
            let candidate = PathBuf::from(&home)
                .join(".local")
                .join("bin")
                .join("dreamina");
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

/// 即梦远端任务（`dreamina list_task` 单项，spike 实测字段）。孤儿比对/取回用（约定 23 阶段 3）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RemoteJimengTask {
    pub submit_id: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub gen_task_type: String,
    pub gen_status: String,
}

/// `dreamina list_task --limit N` → 远端任务列表。stdout 顶层包裹格式 spike 未实证
/// （数组 / `{tasks:[...]}` / 单对象皆可能）：递归收集所有含 submit_id 的 JSON 对象，
/// 对包裹形状免疫；解析整体失败返回 Err（调用方静默跳过扫描）。
pub(crate) async fn list_remote_tasks(
    binary: &str,
    limit: u32,
) -> Result<Vec<RemoteJimengTask>, AppError> {
    let mut command = dreamina_command(binary);
    command
        .arg("list_task")
        .arg("--limit")
        .arg(limit.to_string());
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(CMD_TIMEOUT_SECS), command.output())
        .await
        .map_err(|_| AppError::Jimeng(format!("dreamina list_task 超时（{CMD_TIMEOUT_SECS}s）")))?
        .map_err(|e| AppError::Jimeng(format!("启动 dreamina list_task 失败: {e}")))?;
    if !out.status.success() {
        let stderr_head: String = String::from_utf8_lossy(&out.stderr)
            .trim()
            .chars()
            .take(300)
            .collect();
        return Err(AppError::Jimeng(format!(
            "dreamina list_task 退出 {} | stderr: {stderr_head}",
            out.status
        )));
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(Vec::new());
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&stdout).or_else(|_| {
        // NDJSON 兜底：逐行解析聚合成数组（CLI 未来若按行输出也能吃到）。
        let items: Vec<serde_json::Value> = stdout
            .lines()
            .filter_map(|line| serde_json::from_str(line.trim()).ok())
            .collect();
        serde_json::to_value(items)
    });
    let value =
        parsed.map_err(|e| AppError::Jimeng(format!("dreamina list_task 输出解析失败: {e}")))?;
    let mut tasks = Vec::new();
    collect_task_objects(&value, &mut tasks);
    Ok(tasks)
}

/// 递归收集含 `submit_id` + `gen_status` 的对象为任务项；已命中的对象不再深入
/// （result_json/commerce_info 子树里不会有任务对象）。
fn collect_task_objects(value: &serde_json::Value, out: &mut Vec<RemoteJimengTask>) {
    match value {
        serde_json::Value::Object(map) => {
            let submit_id = map.get("submit_id").and_then(|v| v.as_str());
            let gen_status = map.get("gen_status").and_then(|v| v.as_str());
            if let (Some(submit_id), Some(gen_status)) = (submit_id, gen_status) {
                out.push(RemoteJimengTask {
                    submit_id: submit_id.to_string(),
                    prompt: map
                        .get("prompt")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    gen_task_type: map
                        .get("gen_task_type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    gen_status: gen_status.to_string(),
                });
                return;
            }
            for child in map.values() {
                collect_task_objects(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                collect_task_objects(child, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::collect_task_objects;

    #[test]
    fn collects_tasks_from_array_wrapper_and_single_object() {
        let mut out = Vec::new();
        collect_task_objects(
            &serde_json::json!([
                { "submit_id": "a", "prompt": "一只猫", "gen_task_type": "text2image", "gen_status": "querying" },
                { "submit_id": "b", "gen_status": "success", "result_json": { "images": [] } }
            ]),
            &mut out,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].prompt, "一只猫");
        assert_eq!(out[1].gen_task_type, "");

        // {tasks:[...]} 包裹：递归命中内层数组
        let mut out = Vec::new();
        collect_task_objects(
            &serde_json::json!({ "tasks": [ { "submit_id": "c", "gen_status": "fail", "fail_reason": "x" } ] }),
            &mut out,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].submit_id, "c");
        assert_eq!(out[0].gen_status, "fail");

        // 单对象（无包裹）
        let mut out = Vec::new();
        collect_task_objects(
            &serde_json::json!({ "submit_id": "d", "gen_status": "querying" }),
            &mut out,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].submit_id, "d");
    }

    #[test]
    fn ignores_objects_without_task_fields() {
        let mut out = Vec::new();
        collect_task_objects(
            &serde_json::json!({ "data": { "logid": "x", "credit_count": 10 } }),
            &mut out,
        );
        assert!(out.is_empty());
    }
}
