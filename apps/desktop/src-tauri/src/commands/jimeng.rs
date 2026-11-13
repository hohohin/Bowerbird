//! 即梦 dreamina CLI 的可用性检测与登录命令（Phase 2）。
//!
//! 与 `codex_health` 对称：检测 binary + 登录态（spawn `user_credit` 动态验证；token 由
//! dreamina 自管于 authsdk store，实测非 credential.json）。
//! `dreamina_login` 透传 OAuth Device Flow 的 stdout 给前端（UI Phase 3，已搁置——app spawn
//! 非 TTY 不写 token；改用 `open_dreamina_login` 拉起系统终端登录）。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::codex::jimeng::{dreamina_command, resolve_dreamina_binary};
use crate::commands::codex::CodexHealth;
use crate::error::AppError;

/// 即梦健康检测结果缓存（TTL 内重复检测直接复用，不重复 spawn `version`/`user_credit`——
/// 后者是联网调用。界面可复用结果，重新检测、授权变动和新任务提交时复查）。
const HEALTH_TTL: Duration = Duration::from_secs(120);
static HEALTH_CACHE: Mutex<Option<(DreaminaHealth, Instant)>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DreaminaStatus { Ready, Missing, LoginRequired, Unconfirmed }

#[derive(Clone, Debug, Serialize)]
pub struct DreaminaHealth {
    pub status: DreaminaStatus,
    pub ok: bool,
    pub reason: String,
}

impl DreaminaHealth {
    fn new(status: DreaminaStatus, reason: &str) -> Self {
        Self { status, ok: status == DreaminaStatus::Ready, reason: reason.into() }
    }
}

fn cached_health() -> Option<DreaminaHealth> {
    let cache = HEALTH_CACHE.lock().unwrap();
    cache
        .as_ref()
        .filter(|(_, at)| at.elapsed() < HEALTH_TTL)
        .map(|(h, _)| h.clone())
}

fn store_health(h: DreaminaHealth) -> DreaminaHealth {
    *HEALTH_CACHE.lock().unwrap() = Some((h.clone(), Instant::now()));
    h
}

fn clear_health_cache() {
    *HEALTH_CACHE.lock().unwrap() = None;
}

const LOGIN_REQUIRED: &str = "即梦自有订阅未登录，请先登录授权。";
const HEALTH_UNCONFIRMED: &str = "暂时无法确认即梦自有订阅状态，请检查网络后重新检测。";

fn login_required(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    ["未检测到有效登录态", "未登录", "请先登录", "unauthorized", "please login", "not logged in"]
        .iter()
        .any(|reason| message.contains(reason))
}

/// A queued request may outlive its authorization. Keep its original CLI diagnostics.
pub(super) fn refresh_after_auth_error(app: &AppHandle, error: &AppError) {
    if matches!(error, AppError::Jimeng(reason) if cli_rejected_login(reason)) {
        let health = store_health(DreaminaHealth::new(DreaminaStatus::LoginRequired, LOGIN_REQUIRED));
        let _ = app.emit("dreamina://health-changed", &health);
    }
}

fn cli_rejected_login(reason: &str) -> bool {
    // Inspect transport stderr. The stdout JSON can echo an arbitrary user prompt.
    let stderr = if let Some((_, output)) = reason.split_once(" | stderr: ") {
        output.split_once(" | stdout: ").map_or(output, |(err, _)| err)
    } else if let Some(exit) = reason.strip_prefix("dreamina 退出 ") {
        exit.split_once("：").map_or("", |(_, output)| output.lines().next().unwrap_or(""))
    } else {
        return false;
    };
    login_required(stderr)
}

/// 找不到 CLI 才提示安装。已有 CLI 直接用账号查询同时验证可执行性和登录态。
/// 登录态由 `dreamina_login_health` spawn `user_credit` 动态验证（返回余额 JSON = 有效）。
/// 任一不满足返回 `ok=false` + 中文 reason，前端据此置灰（约定 7）。
/// `force=true` 跳过缓存强制重检（手动「重新检测」/安装/登录/登出后），默认吃 120s TTL 缓存。
#[tauri::command]
pub async fn dreamina_health(force: Option<bool>) -> Result<DreaminaHealth, AppError> {
    if force != Some(true) {
        if let Some(h) = cached_health() {
            return Ok(h);
        }
    }
    let health = match resolve_dreamina_binary() {
        Some(binary) => dreamina_login_health(&binary).await,
        None => DreaminaHealth::new(DreaminaStatus::Missing, "未安装即梦 CLI，请在自有订阅设置中安装。"),
    };
    Ok(store_health(health))
}

fn credit_health(success: bool, stdout: &str, stderr: &str) -> DreaminaHealth {
    let ok = success && super::dreamina_account::json(stdout).is_ok_and(|value| {
        ["total_credit", "user_id", "vip_level"].iter()
            .any(|field| value.get(*field).is_some_and(|v| !v.is_null()))
    });
    if ok {
        DreaminaHealth::new(DreaminaStatus::Ready, "")
    } else if login_required(stderr) || login_required(stdout) {
        DreaminaHealth::new(DreaminaStatus::LoginRequired, LOGIN_REQUIRED)
    } else {
        DreaminaHealth::new(DreaminaStatus::Unconfirmed, HEALTH_UNCONFIRMED)
    }
}

/// Check provider-owned credentials without treating a network failure as a logout.
async fn dreamina_login_health(binary: &str) -> DreaminaHealth {
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        dreamina_command(binary).arg("user_credit").kill_on_drop(true).output(),
    ).await;
    match result {
        Ok(Ok(o)) => credit_health(
            o.status.success(),
            &String::from_utf8_lossy(&o.stdout),
            &String::from_utf8_lossy(&o.stderr),
        ),
        Ok(Err(_)) => DreaminaHealth::new(DreaminaStatus::Unconfirmed, "无法启动已安装的即梦 CLI，请检查程序后重新检测。"),
        Err(_) => DreaminaHealth::new(DreaminaStatus::Unconfirmed, HEALTH_UNCONFIRMED),
    }
}

#[cfg(test)]
mod generation_health_tests {
    use super::*;

    #[test]
    fn empty_balance_is_ready_but_a_missing_login_or_failed_probe_is_not() {
        assert!(credit_health(true, r#"{"total_credit":0}"#, "").ok);
        let reported = "未检测到有效登录态，请先执行 dreamina login";
        assert_eq!(credit_health(false, "", reported).reason, LOGIN_REQUIRED);
        assert_eq!(credit_health(true, reported, "").reason, LOGIN_REQUIRED);
        assert_eq!(credit_health(false, "", "context deadline exceeded").reason, HEALTH_UNCONFIRMED);
        assert_eq!(credit_health(true, "unexpected total_credit response", "").reason, HEALTH_UNCONFIRMED);
        assert_eq!(credit_health(false, "", "timeout").status, DreaminaStatus::Unconfirmed);
        assert_eq!(credit_health(false, "", reported).status, DreaminaStatus::LoginRequired);
    }

    #[test]
    fn headless_login_accepts_existing_session_or_device_flow() {
        assert!(parse_login_flow("已复用当前本地 OAuth 登录态。").unwrap().is_none());
        let flow = parse_login_flow("verification_uri: https://example.test/auth\nuser_code: ABCD\ndevice_code: test-device")
            .unwrap().unwrap();
        assert_eq!(flow.user_code, "ABCD");
        assert!(parse_login_flow("unexpected output").is_err());
    }

    #[test]
    fn submission_diagnostics_refresh_only_a_confirmed_login_failure() {
        assert!(cli_rejected_login("dreamina 提交退出 exit code: 1 | stderr: 未检测到有效登录态，请先执行 dreamina login | stdout: "));
        assert!(cli_rejected_login("dreamina 退出 exit code: 1：unauthorized"));
        assert!(!cli_rejected_login("启动 dreamina 失败（未安装/未登录？运行 dreamina login）"));
        assert!(!cli_rejected_login("dreamina 提交退出 exit code: 1 | stderr: timeout | stdout: please login"));
    }
}

/// 启动 dreamina OAuth 登录（非 headless）：输出 verification_uri + **自动 poll 到授权完成**
/// （dreamina login 内置 checklogin，不需单独第二步；headless 模式才要手动 checklogin）。
/// 逐行透传 stdout（`dreamina://login`），子进程退出（授权完成/超时）后发 `dreamina://login-done`
/// （App 刷 health）。
#[tauri::command]
pub async fn dreamina_login(app: AppHandle) -> Result<(), AppError> {
    let binary = resolve_dreamina_binary()
        .ok_or_else(|| AppError::Jimeng("未检测到 dreamina CLI（需安装）".into()))?;
    let mut cmd = dreamina_command(&binary);
    cmd.arg("login"); // 非 headless：输出链接 + 自动等授权完成（一步）
                      // stderr 丢弃（null）：dreamina login poll 期间往 stderr 输出状态，若 pipe 不读会塞满 → 子进程
                      // block 在写 stderr → 不 poll/不写 token（pipe deadlock，实测授权后未写登录态的根因）。stdout 仍 pipe 供读 verification_uri。
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Jimeng(format!("启动 dreamina login 失败: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Jimeng("无法获取 dreamina login stdout".into()))?;
    let app_clone = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_clone.emit("dreamina://login", &line);
        }
        let _ = child.wait().await;
        let _ = app_clone.emit("dreamina://login-done", ());
    });
    Ok(())
}

/// dreamina OAuth 第二步（headless 不自动登录，必须 checklogin 完成写登录态）：
/// 用户网页授权后，跑 `dreamina login checklogin --device_code=<code> --poll=60` 轮询授权完成，
/// 再测 user_credit 返回最新 health（前端据此 setDreaminaHealth）。
#[tauri::command]
pub async fn dreamina_check_login(device_code: String) -> Result<DreaminaHealth, AppError> {
    let binary = resolve_dreamina_binary()
        .ok_or_else(|| AppError::Jimeng("未检测到 dreamina CLI（需安装）".into()))?;
    let mut cmd = dreamina_command(&binary);
    cmd.arg("login")
        .arg("checklogin")
        .arg(format!("--device_code={}", device_code))
        .arg("--poll")
        .arg("60");
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(90), cmd.output())
        .await
        .map_err(|_| AppError::Jimeng("dreamina checklogin 超时（90s）".into()))?
        .map_err(|e| AppError::Jimeng(format!("启动 checklogin 失败: {e}")))?;
    let health = dreamina_login_health(&binary).await;
    if health.status != DreaminaStatus::LoginRequired {
        Ok(store_health(health))
    } else {
        tracing::info!(exit = ?out.status.code(), "即梦授权查询结束，账号仍未登录");
        Ok(store_health(DreaminaHealth::new(DreaminaStatus::LoginRequired, "即梦尚未确认网页授权，请重新打开授权页并完成确认。")))
    }
}

/// 「打开即梦登录终端」：唤起系统终端跑 `dreamina login`（OAuth）。
/// dreamina login 非 headless 依赖 stdout 是真 TTY 才走完 OAuth + 写 token；app 内 spawn
/// （Stdio::piped）非 TTY 会让进程早退、不写 token（PROJECT.md 踩坑），故拉起真正的系统终端
/// 窗口（真 TTY）让 dreamina 完整跑完。对称 `open_codex_session`。
#[tauri::command]
pub async fn open_dreamina_login() -> Result<(), AppError> {
    let binary = resolve_dreamina_binary()
        .ok_or_else(|| AppError::Jimeng("未检测到 dreamina CLI，请先安装".into()))?;
    #[cfg(target_os = "macos")]
    {
        let mut command = dreamina_command(&binary);
        command.arg("login");
        super::macos_terminal::open(&command)
            .await
            .map_err(|e| AppError::Jimeng(format!("启动 Terminal 失败: {e}")))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err(AppError::Jimeng("当前系统暂不支持打开即梦登录终端".into()))
    }
    #[cfg(target_os = "windows")]
    {
        // cmd /D /S /K 直接执行完整路径的 dreamina（绕开 `start`——start 的引号重组在剥引号时
        // 会把含空格的路径退化成裸命令名，PATH 找不到就报「无法将 … 项识别为…」）。
        // 用 resolve_dreamina_binary 的完整路径而非裸 `dreamina`；`/D /S /K ""path" login"`
        // 是 PROJECT.md 踩坑已验证的 cmd 引号模式（npm_command），raw_arg 绕开 Rust 二次转义。
        // binary 非用户自由输入，无注入风险。
        let mut cmd = tokio::process::Command::new("cmd.exe");
        let launcher = crate::cli_credentials::launcher();
        cmd.raw_arg(&format!("/D /S /K \"\"{}\" \"{binary}\" login\"", launcher.display()));
        crate::cli_credentials::dreamina_environment(&mut cmd);
        // CREATE_NEW_CONSOLE（0x10）：强制 cmd 开新终端窗口。dev 模式 Bowerbird 是 console 子系统
        // （attach 到 `npm run tauri dev` 的终端），cmd 默认继承父 console 而不开新窗——dreamina login
        // 输出流进 dev 终端、无独立交互；CREATE_NEW_CONSOLE 总是开独立窗口（与 release GUI 行为一致）。
        cmd.creation_flags(0x00000010);
        cmd.spawn()
            .map_err(|e| AppError::Jimeng(format!("启动命令提示符失败: {e}")))?;
        Ok(())
    }
}

/// dreamina 官方二进制下载基址（spike 实测，与官方 install 脚本 DOWNLOAD_BASE 一致）。
const DREAMINA_DOWNLOAD_BASE: &str =
    "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta";

/// 把 dir 追加到 Windows 用户级 PATH（SetEnvironmentVariable 'User'，官方 install 脚本同款做法）。
/// dreamina_install 装到 %USERPROFILE%\bin 后调用，让新开终端能直接输 `dreamina`。
/// GUI 里已运行的进程 PATH 不刷新（resolve_dreamina_binary 主动查目录兜底，App 内无需重启）。
#[cfg(target_os = "windows")]
fn ensure_dir_in_user_path(dir: &Path) {
    // dir 来自 dreamina_install_target（基于 USERPROFILE），无需再取环境变量。
    let script = format!(
        r#"$t='{dir}';$c=[Environment]::GetEnvironmentVariable('Path','User');if([string]::IsNullOrWhiteSpace($c)){{[Environment]::SetEnvironmentVariable('Path',$t,'User')}}elseif(-not($c.Split(';')-contains $t)){{[Environment]::SetEnvironmentVariable('Path',$c+';'+$t,'User')}}"#,
        dir = dir.display()
    );
    let _ = tokio::process::Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

/// 当前平台的 (下载 URL, 安装路径)。安装路径与 `resolve_dreamina_binary` 查的目录一致
/// （Windows `%USERPROFILE%\bin\dreamina.exe`、Unix `~/.local/bin/dreamina`），故无需改 PATH。
fn dreamina_install_target() -> (String, PathBuf) {
    #[cfg(target_os = "windows")]
    {
        // 官方 install 脚本 Windows 仅支持 amd64（arm64 暂不支持）。
        let url = format!("{}/dreamina_cli_windows_amd64.exe", DREAMINA_DOWNLOAD_BASE);
        let dir = PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join("bin");
        (url, dir.join("dreamina.exe"))
    }
    #[cfg(target_os = "macos")]
    {
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        };
        let url = format!("{}/dreamina_cli_darwin_{}", DREAMINA_DOWNLOAD_BASE, arch);
        let dir = PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join(".local")
            .join("bin");
        (url, dir.join("dreamina"))
    }
    #[cfg(target_os = "linux")]
    {
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        };
        let url = format!("{}/dreamina_cli_linux_{}", DREAMINA_DOWNLOAD_BASE, arch);
        let dir = PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join(".local")
            .join("bin");
        (url, dir.join("dreamina"))
    }
}

/// 当前 dreamina 安装的取消信号（独立于 codex SETUP_CANCEL / 生成取消；onboarding 顺序执行不并发）。
static DREAMINA_SETUP_CANCEL: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
    std::sync::Mutex::new(None);

/// 一键安装 dreamina CLI（对称 `codex_install`）：app 内 reqwest 下载官方二进制到本地，
/// 绕过 `curl | bash`——Windows 无 bash、PowerShell 的 curl 是 Invoke-WebRequest 别名，用户手敲必失败。
/// 不改 PATH——`resolve_dreamina_binary` 主动查 `%USERPROFILE%\bin` / `~/.local/bin`。
/// 流式进度经 `dreamina://setup-progress`（stage=install）；成功复查 + emit `dreamina://health-changed`。
#[tauri::command]
pub async fn dreamina_install(app: AppHandle) -> Result<CodexHealth, AppError> {
    let (url, install_path) = dreamina_install_target();
    let install_dir = install_path
        .parent()
        .ok_or_else(|| AppError::Jimeng("无法解析 dreamina 安装目录".into()))?
        .to_path_buf();
    let file_name = install_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("dreamina")
        .to_string();
    let tmp_path = install_dir.join(format!(".{file_name}.tmp"));

    tokio::fs::create_dir_all(&install_dir).await.map_err(|e| {
        AppError::Jimeng(format!("创建安装目录失败 {}: {e}", install_dir.display()))
    })?;
    let _ = app.emit(
        "dreamina://setup-progress",
        serde_json::json!({ "stage": "install", "line": format!("下载 {url}") }),
    );

    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    DREAMINA_SETUP_CANCEL.lock().unwrap().replace(cancel_tx);

    let app_for_dl = app.clone();
    let download = async {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| AppError::Jimeng(format!("构建 HTTP client 失败: {e}")))?;
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Jimeng(format!("请求 dreamina 二进制失败: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Jimeng(format!("下载失败 HTTP {}", resp.status())));
        }
        let total = resp.content_length();
        let mut file = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(|e| AppError::Jimeng(format!("创建临时文件失败: {e}")))?;
        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_pct: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Jimeng(format!("下载中断: {e}")))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| AppError::Jimeng(format!("写入失败: {e}")))?;
            downloaded += chunk.len() as u64;
            if let Some(t) = total {
                let pct = downloaded * 100 / t.max(1);
                if pct >= last_pct + 10 {
                    last_pct = pct;
                    let _ = app_for_dl.emit(
                        "dreamina://setup-progress",
                        serde_json::json!({ "stage": "install", "line": format!("下载 {}%", pct) }),
                    );
                }
            }
        }
        file.flush()
            .await
            .map_err(|e| AppError::Jimeng(format!("flush 失败: {e}")))?;
        Ok::<(), AppError>(())
    };

    let result = tokio::select! {
        r = download => r,
        _ = &mut cancel_rx => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            DREAMINA_SETUP_CANCEL.lock().unwrap().take();
            return Err(AppError::Jimeng("已取消".into()));
        }
    };
    DREAMINA_SETUP_CANCEL.lock().unwrap().take();
    result?;

    // .tmp → 目标（同目录 rename，不跨卷）。
    tokio::fs::rename(&tmp_path, &install_path)
        .await
        .map_err(|e| AppError::Jimeng(format!("安装文件落位失败: {e}")))?;

    // Windows 追加安装目录到 User PATH（让新开终端能直接输 `dreamina`；App 内 resolve 已兜底）。
    #[cfg(target_os = "windows")]
    ensure_dir_in_user_path(&install_dir);

    // Unix 设可执行权限（Windows exe 无需）。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&install_path) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&install_path, perms);
        }
    }

    let _ = app.emit(
        "dreamina://setup-progress",
        serde_json::json!({ "stage": "install", "line": "下载完成，验证中…" }),
    );

    // 复查：spawn `dreamina version` 成功 = 二进制可执行。
    let binary_ok = if let Some(b) = resolve_dreamina_binary() {
        dreamina_command(&b)
            .arg("version")
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    };
    if !binary_ok {
        return Ok(CodexHealth {
            ok: false,
            reason: "dreamina 下载完成但无法执行；请重启应用后再试".into(),
        });
    }
    let _ = app.emit("dreamina://health-changed", ());
    Ok(CodexHealth {
        ok: true,
        reason: String::new(),
    })
}

/// 取消正在进行的 dreamina 安装（`dreamina_install`）。无任务在跑则空操作。
#[tauri::command]
pub async fn cancel_dreamina_setup() -> Result<(), AppError> {
    if let Some(tx) = DREAMINA_SETUP_CANCEL.lock().unwrap().take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 登出即梦：app 内 spawn `dreamina logout`（非交互，无需终端 TTY），清 dreamina 自管的登录态。
/// 前端调用后自行 recheck 刷新 health（logout 后 dreaminaHealth 应变「未登录」）。
#[tauri::command]
pub async fn dreamina_logout() -> Result<(), AppError> {
    let binary = resolve_dreamina_binary()
        .ok_or_else(|| AppError::Jimeng("未检测到 dreamina CLI".into()))?;
    let out = dreamina_command(&binary)
        .arg("logout")
        .output()
        .await
        .map_err(|e| AppError::Jimeng(format!("启动 dreamina logout 失败: {e}")))?;
    if !out.status.success() {
        let head: String = String::from_utf8_lossy(&out.stderr)
            .trim()
            .chars()
            .take(200)
            .collect();
        return Err(AppError::Jimeng(format!(
            "dreamina logout 退出 {} | {head}",
            out.status
        )));
    }
    // 登出后登录态已变，清缓存避免 TTL 内返回「已登录」。
    clear_health_cache();
    Ok(())
}

/// `dreamina login --headless` 的 OAuth Device Flow 字段（spike 实测输出，2026-08-07）。
/// 用于 app 内自动完成登录（方案 B）：app spawn headless 拿这些字段 → 自动开浏览器 → 展示授权码
/// → `dreamina_check_login` 用 device_code 补完写 token。不依赖真 TTY（headless 打印后即退出）。
#[derive(Debug, Clone, Serialize)]
pub struct DreaminaDeviceFlow {
    pub verification_uri: String,
    pub user_code: String,
    pub device_code: String,
    pub poll_interval_secs: Option<u64>,
    pub expires_at: Option<String>,
}

/// 启动 `dreamina login --headless`（app 内 spawn 即可，不依赖 TTY），解析并返回 OAuth
/// Device Flow 字段。调用方拿到 verification_uri 后应自动打开浏览器 + 展示 user_code。
#[tauri::command]
pub async fn dreamina_login_headless() -> Result<Option<DreaminaDeviceFlow>, AppError> {
    let binary = resolve_dreamina_binary()
        .ok_or_else(|| AppError::Jimeng("未检测到 dreamina CLI，请先安装".into()))?;
    let mut cmd = dreamina_command(&binary);
    cmd.arg("login").arg("--headless");
    // headless 非交互（打印字段后退出），stderr 丢弃；stdout 全量读。
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(45), cmd.output())
        .await
        .map_err(|_| AppError::Jimeng("获取即梦授权链接超时，请检查网络后重试。".into()))?
        .map_err(|_| AppError::Jimeng("无法启动已安装的即梦 CLI，请检查程序后重新检测。".into()))?;
    if !out.status.success() {
        tracing::info!(exit = ?out.status.code(), "即梦未返回授权链接");
        return Err(AppError::Jimeng("未能从即梦获取授权链接，请检查网络后重试。".into()));
    }
    parse_login_flow(&String::from_utf8_lossy(&out.stdout))
}

fn parse_login_flow(text: &str) -> Result<Option<DreaminaDeviceFlow>, AppError> {
    // spike 实测输出：`verification_uri: <uri>` / `user_code:` / `device_code:` / `poll_interval:` / `expires_at:`。
    // 已有本地登录态时仅输出「已复用当前本地 OAuth 登录态。」——让前端先 recheck 判定。
    if text.lines().any(|l| l.contains("已复用当前本地 OAuth 登录态")) {
        return Ok(None);
    }
    let uri = text
        .lines()
        .find_map(|l| {
            l.strip_prefix("verification_uri:")
                .map(|v| v.trim().to_string())
        })
        .ok_or_else(|| AppError::Jimeng("未从 dreamina 输出解析到 verification_uri".into()))?;
    let user_code = text
        .lines()
        .find_map(|l| l.strip_prefix("user_code:").map(|v| v.trim().to_string()))
        .ok_or_else(|| AppError::Jimeng("未解析到 user_code".into()))?;
    let device_code = text
        .lines()
        .find_map(|l| l.strip_prefix("device_code:").map(|v| v.trim().to_string()))
        .ok_or_else(|| AppError::Jimeng("未解析到 device_code".into()))?;
    let poll_interval_secs = text.lines().find_map(|l| {
        l.strip_prefix("poll_interval:")
            .and_then(|v| v.trim().trim_end_matches('s').parse::<u64>().ok())
    });
    let expires_at = text
        .lines()
        .find_map(|l| l.strip_prefix("expires_at:").map(|v| v.trim().to_string()));
    Ok(Some(DreaminaDeviceFlow {
        verification_uri: uri,
        user_code,
        device_code,
        poll_interval_secs,
        expires_at,
    }))
}
