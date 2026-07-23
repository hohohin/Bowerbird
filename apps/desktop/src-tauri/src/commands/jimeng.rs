//! 即梦 dreamina CLI 的可用性检测与登录命令（Phase 2）。
//!
//! 与 `codex_health` 对称：检测 binary + 登录态（`credential.json`）。
//! `dreamina_login` 透传 OAuth Device Flow 的 stdout 给前端（UI Phase 3）。

use std::process::Stdio;

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::codex::jimeng::{dreamina_command, dreamina_home, resolve_dreamina_binary};
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
    let logged_in = dreamina_home()
        .map(|h| {
            let p = h.join("credential.json");
            std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false)
        })
        .unwrap_or(false);
    if !logged_in {
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

/// 启动 dreamina OAuth 登录（`--headless`），逐行把 stdout 透传给前端（事件 `dreamina://login`），
/// 子进程退出后发 `dreamina://login-done`。stdout 含 `verification_uri` / `user_code` / `device_code`，
/// 前端（Phase 3）据此展示授权引导 + 调 `dreamina login checklogin` 轮询完成登录。
///
/// 本命令只负责启动 + 透传，不解析 OAuth 协议（UI Phase 3 做）。
#[tauri::command]
pub async fn dreamina_login(app: AppHandle) -> Result<(), AppError> {
    let binary = resolve_dreamina_binary()
        .ok_or_else(|| AppError::Codex("未检测到 dreamina CLI（需安装）".into()))?;
    let mut cmd = dreamina_command(&binary);
    cmd.arg("login").arg("--headless");
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Codex(format!("启动 dreamina login 失败: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Codex("无法获取 dreamina login stdout".into()))?;
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
