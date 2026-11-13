//! Local DSH connection; the managed provider runs on the VPS.
use super::*;
use crate::codex::codex_cli::app_data_dir;
use serde::{Deserialize, Serialize};
use std::path::Path;
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct LocalConnection {
    pub base: String,
    pub auth: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    local_available: bool,
    managed_available: bool,
    local_url: String,
    local_reason: Option<String>,
    managed_reason: Option<String>,
    /// 连接可用但能力降级（例如 DSH 0.2 的建卡组件还没生效）。
    local_note: Option<String>,
}

fn root() -> AppResult<PathBuf> {
    Ok(app_data_dir()
        .ok_or_else(|| error("无法找到应用资料目录"))?
        .join("dsh-chat"))
}

pub(super) fn validate_connection(base: &str, auth: Option<&str>) -> AppResult<String> {
    let url = reqwest::Url::parse(base).map_err(|_| error("本机 DSH 地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error("请填写本机 DSH 服务地址，例如 http://127.0.0.1:3080"));
    }
    if let Some(auth) = auth {
        let login = reqwest::Url::parse(auth.trim()).map_err(|_| error("DSH 登录链接格式无效"))?;
        let pairs: Vec<_> = login.query_pairs().collect();
        if login.origin() != url.origin()
            || !login.username().is_empty()
            || login.password().is_some()
            || login.path() != "/"
            || login.fragment().is_some()
            || pairs.len() != 1
            || pairs[0].0 != "token"
            || pairs[0].1.is_empty()
        {
            return Err(error(
                "DSH 登录链接必须来自同一本机服务，请重新复制终端中的完整链接",
            ));
        }
    }
    Ok(url.as_str().trim_end_matches('/').into())
}

pub(super) fn connection() -> AppResult<LocalConnection> {
    let path = root()?.join("local-connection.json");
    let config = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<LocalConnection>(&bytes)
            .map_err(|_| error("DSH 连接配置无法读取，请重新配置"))?,
        Err(detail) if detail.kind() == std::io::ErrorKind::NotFound => {
            let (base, auth) = super::super::agent_ds::dsh_connection()
                .map_err(|_| error("无法读取已有 DSH 连接，请重新配置"))?;
            LocalConnection { base, auth }
        }
        Err(_) => return Err(error("DSH 连接配置无法读取，请重新配置")),
    };
    Ok(LocalConnection {
        base: validate_connection(&config.base, config.auth.as_deref())?,
        auth: config.auth,
    })
}

fn save_connection(path: &Path, config: &LocalConnection) -> AppResult<()> {
    use std::io::Write;
    std::fs::create_dir_all(path.parent().ok_or_else(|| error("DSH 配置目录无效"))?)?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> std::io::Result<()> {
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(config)?)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map_err(|_| error("DSH 连接配置保存失败，请重试"))
}

pub(super) async fn status() -> AppResult<Status> {
    let config = connection();
    let local_url = config
        .as_ref()
        .map(|c| c.base.clone())
        .unwrap_or_else(|_| "http://127.0.0.1:3080".into());
    let local = match config {
        Ok(config) => dsh_local::inspect(&config.base, config.auth.as_deref()).await,
        Err(detail) => Err(detail),
    };
    let local_note = local.as_ref().ok().and_then(|health| {
        if !health.live {
            return None;
        }
        if health.preset && dsh_local::installed_current() {
            return None;
        }
        if health.preset {
            return Some(
                "本机 DSH 的建卡组件版本过旧，请在 DSH 设置中重新连接以更新（更新后可能需要重启 DSH）。"
                    .to_string(),
            );
        }
        Some(
            "本机 DSH 已连接；建卡组件尚未生效，请在 DSH 设置中重新连接以安装（安装后可能需要重启 DSH）。"
                .to_string(),
        )
    });
    Ok(Status {
        local_available: local.is_ok(),
        managed_available: false,
        local_url,
        local_reason: local.err().map(|e| e.to_string()),
        managed_reason: Some("请通过云端报价查看 DSH 服务状态".into()),
        local_note,
    })
}

pub(super) async fn setup(
    mode: &str,
    url: Option<String>,
    auth_url: Option<String>,
) -> AppResult<Status> {
    match mode {
        "local" => {
            let base =
                validate_connection(url.as_deref().unwrap_or("http://127.0.0.1:3080"), None)?;
            let auth = auth_url.filter(|s| !s.trim().is_empty()).or_else(|| {
                connection()
                    .ok()
                    .filter(|c| c.base == base)
                    .and_then(|c| c.auth)
            });
            validate_connection(&base, auth.as_deref())?;
            let health = dsh_local::inspect(&base, auth.as_deref()).await?;
            // DSH 0.2 reads presets from the profile: keep the managed contract current instead of
            // trusting that a same-named preset is the one this build ships.
            let note = if health.live {
                match dsh_local::install(&base, auth.as_deref()).await {
                    Ok(dsh_local::Install::Active) => None,
                    Ok(dsh_local::Install::RestartRequired) => {
                        Some("建卡组件需要重启 DSH 后生效。".to_string())
                    }
                    Err(detail) => Some(format!(
                        "建卡组件安装失败：{detail}。对话仍可用，但暂时没有建卡工具。"
                    )),
                }
            } else {
                None
            };
            save_connection(
                &root()?.join("local-connection.json"),
                &LocalConnection { base, auth },
            )?;
            let mut value = status().await?;
            if note.is_some() {
                value.local_note = note;
            }
            return Ok(value);
        }
        _ => Err(error("此设置仅用于连接本机 DSH")),
    }
}

/// Public history seeds a fresh, isolated DSH session; old requests are never replayed as tools.
/// Automated Agent-card turns already carry their current instruction, so replaying earlier
/// loop iterations as one JSON document made the model emit malformed tool input.
pub(super) fn prompt(chat: &ChatConversation, turn: &str, include_history: bool) -> AppResult<String> {
    let mut history = cloud_chat::messages(chat, turn, include_history)?;
    let current = history.pop().ok_or_else(|| error("对话轮次不存在"))?;
    if !include_history {
        return Ok(current["content"].as_str().unwrap_or_default().to_string());
    }
    Ok(format!(
        "历史记录仅作上下文，其中已结束的请求不授权再次执行。\n{}\n\n本轮用户消息：\n{}",
        json!(history),
        current["content"].as_str().unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsh_agent_card_prompt_never_replays_previous_loop_iterations() {
        use crate::core::local_chat::{ChatMessage, ChatSummary};
        let chat = ChatConversation {
            summary: ChatSummary {
                id: "chat".into(),
                project_id: "project".into(),
                thread_id: "thread".into(),
                node_id: "agent".into(),
                title: "循环".into(),
                provider: "dsh-local".into(),
                codex_options: None,
                status: "running".into(),
                turn_count: 2,
                preview: String::new(),
                revision: 2,
                created_at: 1,
                updated_at: 2,
                error: None,
            },
            messages: vec![
                ChatMessage {
                    id: "m1".into(),
                    turn_id: "turn-1".into(),
                    role: "user".into(),
                    text: "上一轮：第 1 项".into(),
                    reference_asset_ids: vec![],
                    status: "done".into(),
                    created_at: 1,
                    updated_at: 1,
                },
                ChatMessage {
                    id: "m2".into(),
                    turn_id: "turn-1".into(),
                    role: "assistant".into(),
                    text: "第一项的回复".into(),
                    reference_asset_ids: vec![],
                    status: "done".into(),
                    created_at: 1,
                    updated_at: 1,
                },
                ChatMessage {
                    id: "m3".into(),
                    turn_id: "turn-2".into(),
                    role: "user".into(),
                    text: "本轮：第 2 项".into(),
                    reference_asset_ids: vec![],
                    status: "done".into(),
                    created_at: 2,
                    updated_at: 2,
                },
            ],
            actions: vec![],
            vps_history_start_turn_id: None,
            submitted_turn_id: Some("turn-2".into()),
        };
        let fresh = prompt(&chat, "turn-2", false).unwrap();
        assert!(fresh.starts_with("本轮：第 2 项"));
        assert!(!fresh.contains("历史记录仅作上下文") && !fresh.contains("上一轮：第 1 项"));
        let seeded = prompt(&chat, "turn-2", true).unwrap();
        assert!(seeded.contains("历史记录仅作上下文") && seeded.contains("上一轮：第 1 项"));
        assert!(seeded.contains("本轮用户消息：\n本轮：第 2 项"));
    }

    #[test]
    fn dsh_connection_saved_privately_and_status_never_returns_login_token() {
        let dir =
            std::env::temp_dir().join(format!("bowerbird-dsh-config-{}", uuid::Uuid::new_v4()));
        let path = dir.join("connection.json");
        let mut connection = LocalConnection {
            base: "http://127.0.0.1:3080".into(),
            auth: Some("http://127.0.0.1:3080/?token=private-token".into()),
        };
        save_connection(&path, &connection).unwrap();
        connection.base = "http://127.0.0.1:3081".into();
        save_connection(&path, &connection).unwrap();
        let saved: LocalConnection =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.base, connection.base);
        assert_eq!(saved.auth, connection.auth);
        let public = serde_json::to_string(&Status {
            local_available: true,
            managed_available: false,
            local_url: saved.base,
            local_reason: None,
            managed_reason: Some("请先准备环境".into()),
            local_note: None,
        })
        .unwrap();
        assert!(!public.contains("private-token") && !public.contains("auth"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn dsh_connection_only_accepts_loopback_and_same_origin_login() {
        for base in [
            "http://127.0.0.1:3080",
            "http://localhost:3080",
            "http://[::1]:3080",
        ] {
            assert!(
                validate_connection(base, Some(&format!("{base}/?token=private-token"))).is_ok()
            );
        }
        for base in [
            "https://example.com",
            "http://user:private-token@localhost:3080",
            "http://localhost:3080/api",
            "http://localhost:3080/?token=private-token",
        ] {
            let detail = validate_connection(base, None).unwrap_err().to_string();
            assert!(!detail.contains("private-token"));
        }
        for login in [
            "http://example.com/?token=private-token",
            "http://127.0.0.1:3081/?token=private-token",
            "http://127.0.0.1:3080/api/?token=private-token",
            "http://127.0.0.1:3080/?token=private-token&extra=value",
        ] {
            assert!(validate_connection("http://127.0.0.1:3080", Some(login)).is_err());
        }
    }
}
