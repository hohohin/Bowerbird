//! 即梦 dreamina CLI 的可用性检测与登录命令（Phase 2）。
//!
//! 与 `codex_health` 对称：检测 binary + 登录态（`credential.json`）。
//! `dreamina_login` 透传 OAuth Device Flow 的 stdout 给前端（UI Phase 3）。

use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::codex::jimeng::{dreamina_command, resolve_dreamina_binary};
use crate::commands::codex::CodexHealth;
use crate::error::AppError;

/// 检测 dreamina 是否可用：① CLI 可执行（`dreamina version`）；
/// ② `~/.dreamina_cli/credential.json` 非空（已登录）。
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
