//! 即梦 dreamina CLI 的可用性检测与登录命令（Phase 2）。
//!
//! 与 `codex_health` 对称：检测 binary + 登录态（spawn `user_credit` 动态验证；token 由
//! dreamina 自管于 authsdk store，实测非 credential.json）。
//! `dreamina_login` 透传 OAuth Device Flow 的 stdout 给前端（UI Phase 3，已搁置——app spawn
//! 非 TTY 不写 token；改用 `open_dreamina_login` 拉起系统终端登录）。

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::codex::jimeng::{dreamina_command, resolve_dreamina_binary};
use crate::commands::codex::CodexHealth;
use crate::error::AppError;

/// 检测 dreamina 是否可用：① CLI 可执行（`dreamina version`）；② 已登录。
/// 登录态由 `check_dreamina_logged_in` spawn `user_credit` 动态验证（返回余额 JSON = 有效）。
/// 任一不满足返回 `ok=false` + 中文 reason，前端据此置灰（约定 7）。
#[tauri::command]
pub async fn dreamina_health() -> Result<CodexHealth, AppError> {
    let binary = resolve_dreamina_binary();
    let binary_ok = if let Some(binary) = binary.as_deref() {
        dreamina_command(binary)
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
            reason: "未检测到 dreamina CLI（运行 curl -s https://jimeng.jianying.com/cli | bash 安装）".into(),
        });
    }
    let binary_str = binary.as_deref().unwrap_or("dreamina");
    if !check_dreamina_logged_in(binary_str).await {
        return Ok(CodexHealth {
            ok: false,
            reason: "dreamina 未登录（运行 dreamina login）".into(),
        });
    }
    Ok(CodexHealth {
        ok: true,
        reason: String::new(),
    })
}

/// 检测 dreamina 登录态：spawn `user_credit`，exit 0 + stdout 含余额字段 = 已登录。
/// dreamina 自管登录态文件（实测非 credential.json），user_credit 动态验证最准（§7.5）。
async fn check_dreamina_logged_in(binary: &str) -> bool {
    match dreamina_command(binary).arg("user_credit").output().await {
        Ok(o) => {
            o.status.success()
                && {
                    let s = String::from_utf8_lossy(&o.stdout);
                    s.contains("total_credit") || s.contains("user_id") || s.contains("vip_level")
                }
        }
        Err(_) => false,
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
pub async fn dreamina_check_login(device_code: String) -> Result<CodexHealth, AppError> {
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
    if check_dreamina_logged_in(&binary).await {
        Ok(CodexHealth { ok: true, reason: String::new() })
    } else {
        // 诊断：附 device_code 前 8 + checklogin exit + 输出（如「登录已过期」/未授权）。
        let dc_head: String = device_code.chars().take(8).collect();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let diag = if !stdout.is_empty() { stdout } else { stderr };
        let diag: String = diag.chars().take(200).collect();
        Ok(CodexHealth {
            ok: false,
            reason: format!("授权未完成（device_code {dc_head}…, checklogin exit {}）| {diag}", out.status),
        })
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
        // binary 是 resolve_dreamina_binary 返回的固定路径（env 或 ~/.local/bin/dreamina），
        // 非用户自由输入，osascript do script 单参传入无注入风险。
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"{binary} login\"\nend tell"
        );
        tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| AppError::Jimeng(format!("启动 Terminal 失败: {e}")))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(not(target_os = "macos"))]
        {
            Err(AppError::Jimeng("当前系统暂不支持打开即梦登录终端".into()))
        }
    }
    #[cfg(target_os = "windows")]
    {
        // `start "" cmd.exe /K` 另开常驻命令提示符跑 `dreamina login`；/K 跑完留窗让用户看到
        // 「登录成功」。用 resolve_dreamina_binary 的完整路径而非裸 `dreamina`——install 把二进制
        // 装到 %USERPROFILE%\bin 且故意不改 PATH（resolve_dreamina_binary 主动查该目录），
        // 裸命令在新终端的 PATH 里找不到会报「不是内部或外部命令」。路径可能含空格，用引号包裹；
        // binary 非用户自由输入，无注入风险。
        tokio::process::Command::new("cmd.exe")
            .arg("/D")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg("cmd.exe")
            .arg("/K")
            .arg(format!("\"{binary}\" login"))
            .spawn()
            .map_err(|e| AppError::Jimeng(format!("启动命令提示符失败: {e}")))?;
        Ok(())
    }
}

/// dreamina 官方二进制下载基址（spike 实测，与官方 install 脚本 DOWNLOAD_BASE 一致）。
const DREAMINA_DOWNLOAD_BASE: &str =
    "https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta";

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
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };
        let url = format!("{}/dreamina_cli_darwin_{}", DREAMINA_DOWNLOAD_BASE, arch);
        let dir = PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join(".local")
            .join("bin");
        (url, dir.join("dreamina"))
    }
    #[cfg(target_os = "linux")]
    {
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "amd64" };
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

    tokio::fs::create_dir_all(&install_dir)
        .await
        .map_err(|e| AppError::Jimeng(format!("创建安装目录失败 {}: {e}", install_dir.display())))?;
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
