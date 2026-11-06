//! Application-owned local DSH connection and managed runtime, separate from user credentials.
use super::*;
use crate::codex::codex_cli::{app_data_dir, npm_command, resolve_npm_binary};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tokio::process::{Child, Command};

const VERSION: &str = "0.1.1-rc.2";
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
}

pub(super) struct Runtime {
    node: PathBuf,
    root: PathBuf,
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

fn node() -> AppResult<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut dirs = resolve_npm_binary()
        .and_then(|npm| Path::new(&npm).parent().map(Path::to_path_buf))
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| error("DSH · Cloud 需要 Node.js 24，请安装后重新准备环境"))
}

fn command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    command.kill_on_drop(true);
    command
}

/// Kill the private process tree, including the DSH CLI spawned by the bridge.
async fn stop(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let _ = command(Path::new("taskkill.exe"))
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn checked_output(mut command: Command, seconds: u64) -> AppResult<Vec<u8>> {
    command
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| error("DSH 环境无法启动，请检查 Node.js 安装"))?;
    let mut output = child
        .stdout
        .take()
        .ok_or_else(|| error("DSH 环境没有返回输出"))?;
    let execution = async {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        loop {
            let count = output.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            let keep = count.min((64 * 1024usize).saturating_sub(bytes.len()));
            bytes.extend_from_slice(&buffer[..keep]);
        }
        let status = child.wait().await?;
        if !status.success() {
            return Err(error(
                "DSH 环境准备失败，请检查网络与 Node.js 24 安装后重试",
            ));
        }
        Ok(bytes)
    };
    let result = tokio::time::timeout(Duration::from_secs(seconds), execution)
        .await
        .unwrap_or_else(|_| Err(error("DSH 环境准备超时，请检查网络后重试")));
    if result.is_err() {
        stop(&mut child).await;
    }
    result
}

async fn check_node(node: &Path) -> AppResult<()> {
    let mut version = command(node);
    version.arg("--version");
    if !String::from_utf8_lossy(&checked_output(version, 10).await?)
        .trim()
        .starts_with("v24.")
    {
        return Err(error(
            "DSH · Cloud 当前需要 Node.js 24，请安装该版本后重新准备环境",
        ));
    }
    Ok(())
}

fn write_runtime_assets(root: &Path) -> AppResult<()> {
    std::fs::create_dir_all(root)?;
    for (name, content) in [
        ("runner.mjs", include_str!("dsh-chat/runner.mjs")),
        ("bridge.mjs", include_str!("dsh-chat/bridge.mjs")),
        (
            "cards-plugin.mjs",
            include_str!("dsh-chat/cards-plugin.mjs"),
        ),
        (
            "package.json",
            include_str!("dsh-chat/runtime-package.json"),
        ),
        (
            "package-lock.json",
            include_str!("dsh-chat/runtime-package-lock.json"),
        ),
    ] {
        std::fs::write(root.join(name), content)?;
    }
    Ok(())
}

fn runtime_root() -> AppResult<PathBuf> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for content in [
        include_str!("dsh-chat/runner.mjs"),
        include_str!("dsh-chat/bridge.mjs"),
        include_str!("dsh-chat/cards-plugin.mjs"),
        include_str!("dsh-chat/runtime-package.json"),
        include_str!("dsh-chat/runtime-package-lock.json"),
    ] {
        hash.update(content.as_bytes());
    }
    Ok(root()?
        .join("managed")
        .join(VERSION)
        .join(format!("{:x}", hash.finalize())[..16].to_string()))
}

async fn probe(runtime: &Runtime) -> AppResult<()> {
    let mut check = command(&runtime.node);
    check
        .arg(runtime.root.join("runner.mjs"))
        .arg("--check")
        .arg(&runtime.root);
    let result: Value = serde_json::from_slice(&checked_output(check, 20).await?)
        .map_err(|_| error("DSH 环境校验失败，请重新准备环境"))?;
    if result["ready"] != true || result["version"] != VERSION {
        return Err(error("DSH 环境版本不匹配，请重新准备环境"));
    }
    Ok(())
}

pub(super) async fn runtime() -> AppResult<Runtime> {
    let runtime = Runtime {
        node: node()?,
        root: runtime_root()?,
    };
    check_node(&runtime.node).await?;
    if !runtime
        .root
        .join("node_modules/@deepseek-ai/dsh/package.json")
        .is_file()
    {
        return Err(error("请先准备 DSH · Cloud 环境"));
    }
    // Immutable bridge revisions let concurrent chats keep using their admitted runtime.
    probe(&runtime).await?;
    Ok(runtime)
}

pub(super) async fn status() -> AppResult<Status> {
    let config = connection();
    let local_url = config
        .as_ref()
        .map(|c| c.base.clone())
        .unwrap_or_else(|_| "http://127.0.0.1:3080".into());
    let local = async {
        match config {
            Ok(config) => dsh_local::health(&config.base, config.auth.as_deref()).await,
            Err(detail) => Err(detail),
        }
    };
    let managed = async {
        let runtime = Runtime {
            node: node()?,
            root: runtime_root()?,
        };
        check_node(&runtime.node).await?;
        probe(&runtime).await
    };
    let (local, managed) = tokio::join!(local, managed);
    Ok(Status {
        local_available: local.is_ok(),
        managed_available: managed.is_ok(),
        local_url,
        local_reason: local.err().map(|e| e.to_string()),
        managed_reason: managed.err().map(|e| e.to_string()),
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
            dsh_local::health(&base, auth.as_deref()).await?;
            save_connection(
                &root()?.join("local-connection.json"),
                &LocalConnection { base, auth },
            )?;
        }
        "managed" => {
            let _install = INSTALL.lock().await;
            let runtime = Runtime {
                node: node()?,
                root: runtime_root()?,
            };
            check_node(&runtime.node).await?;
            if probe(&runtime).await.is_err() {
                write_runtime_assets(&runtime.root)?;
                let npm = resolve_npm_binary()
                    .ok_or_else(|| error("DSH 环境需要 npm，请检查 Node.js 24 安装"))?;
                let mut install = npm_command(
                    &npm,
                    &[
                        "ci",
                        "--ignore-scripts",
                        "--legacy-peer-deps",
                        "--no-audit",
                        "--no-fund",
                    ],
                );
                install.current_dir(&runtime.root);
                checked_output(install, 600).await?;
                probe(&runtime).await?;
            }
        }
        _ => return Err(error("DSH 配置方式无效")),
    }
    status().await
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum BridgeEvent {
    Model {
        id: String,
        messages: Vec<Value>,
    },
    Tool {
        id: String,
        name: String,
        args: Value,
    },
    Text {
        text: String,
    },
    Done,
    Error {
        error: String,
    },
}

/// Public history seeds a fresh, isolated DSH session; old requests are never replayed as tools.
pub(super) fn prompt(chat: &ChatConversation, turn: &str) -> AppResult<String> {
    let mut history = cloud_chat::messages(chat, turn)?;
    let current = history.pop().ok_or_else(|| error("对话轮次不存在"))?;
    Ok(format!(
        "历史记录仅作上下文，其中已结束的请求不授权再次执行。\n{}\n\n本轮用户消息：\n{}",
        json!(history),
        current["content"].as_str().unwrap_or_default()
    ))
}

pub(super) async fn run(
    app: &AppHandle,
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    id: &str,
    turn: &str,
    runtime: Runtime,
    mut cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let account = auth
        .snapshot()
        .user_id
        .ok_or_else(|| error("请先登录 Bowerbird 账号"))?;
    let chat = db
        .get_local_chat(id)?
        .ok_or_else(|| error("对话记录不存在"))?;
    let workspace = root()?.join("turns").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&workspace)?;
    let mut process = command(&runtime.node);
    process
        .arg(runtime.root.join("runner.mjs"))
        .current_dir(&workspace)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for key in [
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(key) {
            process.env(key, value);
        }
    }
    let mut child = process
        .spawn()
        .map_err(|_| error("DSH · Cloud 无法启动，请重新准备环境"))?;
    let mut writer = child
        .stdin
        .take()
        .ok_or_else(|| error("DSH 对话通道无法启动"))?;
    let mut reader = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| error("DSH 回复通道无法启动"))?,
    );
    let execution = async {
        write_message(&mut writer, json!({"type":"start","runtime":runtime.root,"workspace":workspace,"prompt":prompt(&chat,turn)?,"tools":[card_tool_spec()]})).await?;
        exchange(
            app,
            db,
            cloud,
            auth,
            id,
            turn,
            &account,
            &mut reader,
            &mut writer,
        )
        .await
    };
    let result = tokio::select! {
        _ = cancel.changed() => Ok("stopped"),
        result = tokio::time::timeout(Duration::from_secs(1800), execution) => result.unwrap_or_else(|_| Err(error("DSH · Cloud 等待超时，请稍后取回原请求；未自动重发"))),
    };
    drop(writer);
    if tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_err()
    {
        stop(&mut child).await;
    }
    // This UUID directory is created by this turn and contains no user files.
    let _ = std::fs::remove_dir_all(&workspace);
    result
}

async fn exchange(
    app: &AppHandle,
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    id: &str,
    turn: &str,
    account: &str,
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
) -> AppResult<&'static str> {
    let mut rounds = 0;
    let mut text = String::new();
    let mut allowed = HashMap::new();
    loop {
        let raw = read_message(reader)
            .await
            .map_err(|_| error("DSH 连接已结束，已保留收到的内容，请取回原请求或重新准备环境"))?;
        let event: BridgeEvent =
            serde_json::from_value(raw).map_err(|_| error("DSH 回复格式无效，未继续执行工具"))?;
        cloud_chat::ensure_account(auth, account)?;
        match event {
            BridgeEvent::Model {
                id: request,
                messages,
            } => {
                if rounds >= 12 || !allowed.is_empty() || request != format!("model-{}", rounds + 1)
                {
                    return Err(error(
                        "DSH 编排状态无效或达到次数上限，请查看已创建卡片后继续",
                    ));
                }
                let message =
                    cloud_chat::complete(cloud, auth, db, turn, rounds, &messages, account, &text)
                        .await?;
                allowed = cloud_chat::calls(&message)?.into_iter().collect();
                rounds += 1;
                write_message(
                    writer,
                    json!({"type":"result","id":request,"result":message}),
                )
                .await?;
            }
            BridgeEvent::Tool {
                id: call,
                name,
                args,
            } => {
                authorize_call(&mut allowed, &call, &name, &args)?;
                let entitlement = app.state::<EntitlementService>();
                let action = super::super::local_chat_cards::create_cards(
                    app,
                    db,
                    auth,
                    &entitlement,
                    id,
                    turn,
                    &call,
                    &args,
                )
                .await;
                let result = match action {
                    Ok(action) => json!({"success":true,"action":action}),
                    Err(detail) => json!({"success":false,"error":detail.to_string()}),
                };
                write_message(writer, json!({"type":"result","id":call,"result":result})).await?;
            }
            BridgeEvent::Text { text: delta } => {
                if text.len() + delta.len() > MAX_RESPONSE {
                    return Err(error("DSH 本轮回复超过长度限制"));
                }
                text.push_str(&delta);
                db.update_local_chat_text(id, turn, &text)?;
                emit(app, db, id);
            }
            BridgeEvent::Done if rounds > 0 && allowed.is_empty() => return Ok("done"),
            BridgeEvent::Error { error: code } => {
                tracing::warn!(code = %code.chars().filter(char::is_ascii_uppercase).take(80).collect::<String>(), "managed DSH turn failed");
                return Err(error(
                    "DSH · Cloud 本轮未完成，已保留收到的内容；可取回原请求，未自动重发",
                ));
            }
            _ => return Err(error("DSH 本轮未完成，请查看已创建卡片后继续")),
        }
    }
}

fn authorize_call(
    allowed: &mut HashMap<String, Value>,
    call: &str,
    name: &str,
    args: &Value,
) -> AppResult<()> {
    if name != "create_canvas_cards" || allowed.get(call) != Some(args) {
        return Err(error("DSH 工具请求不属于当前模型回复，未创建卡片"));
    }
    allowed.remove(call);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires an isolated installed DSH runtime; never calls a model"]
    async fn dsh_managed_runtime_probe_uses_bundled_bridge_without_model_credentials() {
        let runtime = Runtime {
            node: node().unwrap(),
            root: PathBuf::from(
                std::env::var("DSH_CHAT_TEST_RUNTIME").expect("isolated runtime required"),
            ),
        };
        check_node(&runtime.node).await.unwrap();
        write_runtime_assets(&runtime.root).unwrap();
        probe(&runtime).await.unwrap();
    }

    #[test]
    fn dsh_bridge_only_executes_the_current_model_call_once_with_exact_arguments() {
        let args = json!({"cards":[{"id":"a","kind":"content","title":"方向","text":"简洁"}]});
        let mut allowed = HashMap::from([("call-1".into(), args.clone())]);
        for (id, name, value) in [
            ("other", "create_canvas_cards", args.clone()),
            ("call-1", "shell", args.clone()),
            ("call-1", "create_canvas_cards", json!({"cards":[]})),
        ] {
            assert!(authorize_call(&mut allowed, id, name, &value).is_err());
        }
        authorize_call(&mut allowed, "call-1", "create_canvas_cards", &args).unwrap();
        assert!(authorize_call(&mut allowed, "call-1", "create_canvas_cards", &args).is_err());
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
