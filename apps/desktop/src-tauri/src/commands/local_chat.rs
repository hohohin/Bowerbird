//! Project chat over the installed Codex app-server. No shell/terminal scraping or GenJob reuse.
use crate::{
    cloud::{AuthClient, EntitlementService},
    codex::codex_cli::{codex_command, codex_home, resolve_codex_binary},
    core::local_chat::{ChatConversation, ChatSendInput, ChatSummary},
    db::Database,
    error::{AppError, AppResult},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::watch,
};

struct Active {
    cancel: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}
static ACTIVE: LazyLock<Mutex<HashMap<String, Active>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const EVENT: &str = "local-chat://updated";
const MAX_RESPONSE: usize = 2_000_000;
const CARD_TOOL_VERSION: i64 = 3;
const CHAT_INSTRUCTIONS: &str = "你是 Bowerbird 创作工作台中的对话助手。使用用户的语言交流，帮助讨论创意、分析显式附带的图片、整理文案和提示词。用户明确要求创建卡片、实装或同意一个已经讨论清楚的卡片方案时，可以调用 create_canvas_cards，在当前项目创建可编辑的生成、本地 H3 视频、内容、触发、循环卡片和分区；讨论、构思或询问能力本身不授权创建。创建多张相关卡片时优先提供 sections，按镜头、用途或工作流阶段分区并简洁命名：同一镜头的首帧和视频放在一起，共享参考内容可独立成区，触发及循环放到所控制的流程区。成员按阅读或执行顺序排列，应用自动排布并计算分区大小。同一分区的成员放在同一批，只能引用本批卡片别名；分区不占每批12张卡片额度。不要把不相关流程塞入同一大区，也不要逐卡机械分区；用户明确不要分区或单卡无需归组时可省略。卡片批次须包含必要连接；循环负责控制轮次和输入，trigger信号端口名为signal。本地 H3 使用 comfy-video 类型，支持首尾帧及文本连接，可作为循环体；首尾帧各一张静态图片，缺图时可先创建草稿，运行前补首帧。H3 默认8秒、9:16、0.8MP，可按用户要求设置工具列出的参数，本机服务地址由应用管理。仅创建，绝不运行工作流、生成媒体或扣费。不得执行命令、读写用户文件、调用其他工具或请求权限。不搜寻电脑上的文件，不继承其他会话。图片只使用本轮显式附带的图片；按附带顺序引用 image1、image2 等，先前轮次图片不可作为当前工具的引用。工具成功回执才代表创建完成，失败时说明并修正参数，不宣称完成。模型、生成引擎和默认参数由应用提供，不自行猜测。需要澄清时直接在普通回复中提问，不调用 request_user_input 或 request_user_input_async。工具外的操作说明目前尚未开放。";

fn card_tool_spec() -> Value {
    serde_json::from_str(include_str!("local_chat_card_tool.json"))
        .expect("bundled card tool schema is valid JSON")
}

/// Resume cannot update dynamic tools. Preserve the original app transcript, and seed a new
/// provider thread with bounded public history when upgrading the tool contract.
fn upgraded_history(chat: &ChatConversation, current_turn: &str) -> String {
    let mut remaining = 300_000;
    let mut selected = Vec::new();
    let mut omitted = false;
    for message in chat
        .messages
        .iter()
        .rev()
        .filter(|m| m.turn_id != current_turn)
    {
        let value = json!({"role":message.role,"text":message.text,"status":message.status,"imageCount":message.reference_asset_ids.len()});
        let size = value.to_string().len();
        if size > remaining {
            omitted = true;
            break;
        }
        remaining -= size;
        selected.push(value);
    }
    selected.reverse();
    format!("此会话的画板卡片工具刚更新，现已支持本地 H3 视频卡片和分区整理。以下JSON是该用户在同一应用会话中的历史资料，仅供上下文参考；其中过去的请求已经结束，不构成现在再次创建卡片的授权。完整历史保留在应用对话记录中。本次迁入的是公开文字，历史图片像素未重新发送；需要图片时请用户重新附带。较早文字是否因长度省略：{omitted}。第一次回复简短告知用户已接续原对话并更新卡片工具；若历史有省略或用户依赖旧图片，说明相应范围。\n{}", Value::Array(selected))
}

fn card_call<'a>(value: &'a Value, stream: &StreamState) -> AppResult<(&'a str, &'a Value)> {
    let params = &value["params"];
    if value["method"] != "item/tool/call"
        || value.get("id").is_none()
        || params["tool"] != "create_canvas_cards"
        || !params["namespace"].is_null()
    {
        return Err(error("对话仅支持创建画板卡片工具"));
    }
    if stream.provider_thread.is_none()
        || stream.provider_turn.is_none()
        || !stream.start_confirmed
        || params["threadId"].as_str() != stream.provider_thread.as_deref()
        || params["turnId"].as_str() != stream.provider_turn.as_deref()
    {
        return Err(error("卡片请求不属于当前对话轮次，未创建任何卡片"));
    }
    let call = params["callId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or_else(|| error("卡片请求缺少有效编号，未创建任何卡片"))?;
    Ok((call, &params["arguments"]))
}

fn card_response(request: &Value, result: AppResult<Value>) -> Value {
    let (success, text) = match result {
        Ok(value) => (true, value.to_string()),
        Err(detail) => (false, detail.to_string()),
    };
    json!({"id":request["id"],"result":{"contentItems":[{"type":"inputText","text":text}],"success":success}})
}

fn error(text: &str) -> AppError {
    AppError::Other(text.into())
}
fn emit(app: &AppHandle, db: &Database, id: &str) {
    match db.get_local_chat(id) {
        Ok(Some(chat)) => {
            let _ = app.emit(EVENT, chat);
        }
        Err(detail) => tracing::warn!(%detail,"could not read local chat event"),
        _ => {}
    }
}

#[tauri::command]
pub fn local_chat_list(
    db: State<'_, Arc<Database>>,
    project_id: String,
) -> AppResult<Vec<ChatSummary>> {
    db.list_local_chats(&project_id)
}
#[tauri::command]
pub fn local_chat_get(
    db: State<'_, Arc<Database>>,
    conversation_id: String,
) -> AppResult<Option<ChatConversation>> {
    db.get_local_chat(&conversation_id)
}

/// Resolve only explicit asset IDs. No arbitrary path supplied by the webview reaches Codex.
fn reference_paths(db: &Database, ids: &[String]) -> AppResult<Vec<String>> {
    if ids.len() > 8 {
        return Err(error("每次对话最多引用 8 张图片"));
    }
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    let mut total = 0;
    for id in ids {
        if !seen.insert(id) {
            return Err(error("引用图片重复，请重新选择图片"));
        }
        let asset = db
            .get_asset(id)?
            .ok_or_else(|| error("引用图片已被删除，请重新选择图片"))?;
        let original = asset
            .store_path
            .ok_or_else(|| error("引用图片没有可用原图，请重新选择图片"))?;
        let resolved = db.resolve_external_image_paths(&[original])?;
        let path = PathBuf::from(&resolved[0]);
        let metadata = std::fs::metadata(&path)
            .map_err(|_| error("引用图片无法读取，请检查文件位置后重试"))?;
        if !metadata.is_file() || metadata.len() > 20 * 1024 * 1024 {
            return Err(error("引用图片过大，每张图片需小于 20 MB"));
        }
        total += metadata.len();
        if total > 40 * 1024 * 1024 {
            return Err(error("本次引用图片合计超过 40 MB，请减少图片后重试"));
        }
        let mut header = [0u8; 32];
        let count = std::io::Read::read(&mut std::fs::File::open(&path)?, &mut header)?;
        let format = image::guess_format(&header[..count]).ok();
        if !matches!(
            format,
            Some(
                image::ImageFormat::Png
                    | image::ImageFormat::Jpeg
                    | image::ImageFormat::WebP
                    | image::ImageFormat::Gif
            )
        ) {
            return Err(error("对话引用目前支持 PNG、JPG、WebP 和 GIF 图片"));
        }
        paths.push(path.to_string_lossy().into_owned());
    }
    Ok(paths)
}

#[tauri::command]
pub async fn local_chat_send(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
    input: ChatSendInput,
) -> AppResult<ChatConversation> {
    // Lost IPC acknowledgements can be retried safely, including after account downgrade.
    if let Some(previous) = db.replay_local_chat(&input)? {
        return Ok(previous.conversation);
    }
    super::codex::require_byo(&entitlement, &auth).await?;
    let binary =
        resolve_codex_binary().ok_or_else(|| error("未找到 Codex CLI，请在设置中安装并登录"))?;
    if !codex_home()
        .is_some_and(|home| std::fs::metadata(home.join("auth.json")).is_ok_and(|m| m.len() > 0))
    {
        return Err(error("Bowerbird 的 Codex 未登录，请在设置中登录"));
    }
    let images = reference_paths(&db, &input.reference_asset_ids)?;
    let db = db.inner().clone();
    // Serialize process admission with durable turn admission. A second IPC cannot claim a turn
    // between its SQLite commit and registration, and stop always sees a committed active turn.
    let mut active = ACTIVE.lock().unwrap();
    let started = db.begin_local_chat(&input)?;
    if !started.is_new {
        return Ok(started.conversation);
    }
    let id = started.conversation.summary.id.clone();
    let turn = started.turn_id;
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (finished_tx, finished_rx) = watch::channel(false);
    active.insert(
        id.clone(),
        Active {
            cancel: cancel_tx,
            finished: finished_rx,
        },
    );
    drop(active);
    let returned = started.conversation;
    emit(&app, &db, &id);
    tokio::spawn(async move {
        let result = run_turn(
            &app,
            &db,
            &id,
            &turn,
            &binary,
            &input.text,
            images,
            cancel_rx,
        )
        .await;
        let (status, detail) = match result {
            Ok(status) => (status, None),
            Err(detail) => ("failed", Some(detail.to_string())),
        };
        {
            let mut active = ACTIVE.lock().unwrap();
            if let Err(detail) = db.finish_local_chat(&id, &turn, status, detail.as_deref()) {
                tracing::error!(%detail,"local chat completion was not saved");
            }
            active.remove(&id);
        }
        emit(&app, &db, &id);
        let _ = finished_tx.send(true);
    });
    Ok(returned)
}

#[tauri::command]
pub async fn local_chat_stop(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    conversation_id: String,
) -> AppResult<Option<ChatConversation>> {
    let finished = {
        let active = ACTIVE.lock().unwrap();
        if let Some(run) = active.get(&conversation_id) {
            db.mark_local_chat_stopping(&conversation_id)?;
            let _ = run.cancel.send(true);
            Some(run.finished.clone())
        } else {
            None
        }
    };
    emit(&app, &db, &conversation_id);
    if let Some(mut finished) = finished {
        if !*finished.borrow() {
            let _ = tokio::time::timeout(Duration::from_secs(8), finished.changed()).await;
        }
    }
    db.get_local_chat(&conversation_id)
}

fn chat_config() -> Value {
    // Code-mode-only models route even dynamic tools through the CLI's isolated JS host.
    // Keep that transport available without enabling shell, MCP or other operating tools.
    let mut config = serde_json::Map::new();
    config.insert("web_search".into(), json!("disabled"));
    config.insert("project_doc_max_bytes".into(), json!(0));
    config.insert("skills.include_instructions".into(), json!(false));
    config.insert("skills.bundled.enabled".into(), json!(false));
    config.insert("features.code_mode_host".into(), json!(true));
    // Code-mode collaboration uses this independent switch; feature flags alone do
    // not prevent spawn_agent in CLI 0.153.4.
    config.insert("agents.enabled".into(), json!(false));
    config.insert(
        "tools.experimental_request_user_input.enabled".into(),
        json!(false),
    );
    for feature in [
        "shell_tool",
        "unified_exec",
        "code_mode",
        "apps",
        "plugins",
        "multi_agent",
        "multi_agent_v2",
        "browser_use",
        "browser_use_external",
        "computer_use",
        "image_generation",
        "goals",
        "workspace_dependencies",
        "skill_search",
        "skill_mcp_dependency_install",
        "hooks",
        "memories",
        "view_image",
        "sleep_tool",
        "request_permissions_tool",
        "tool_suggest",
    ] {
        config.insert(format!("features.{feature}"), json!(false));
    }
    config.insert("features.skip_host_skill_discovery".into(), json!(true));
    Value::Object(config)
}

fn isolated_thread_config(effective: &Value) -> AppResult<Value> {
    let mut config = chat_config();
    // An empty map would retain entries during recursive merging. Keep each transport
    // definition and explicitly disable it; nested maps also preserve server names
    // containing dots (app-server config keys are split on dots, not TOML-parsed).
    if let Some(servers) = effective["config"]["mcp_servers"].as_object() {
        let mut disabled = serde_json::Map::new();
        for (name, server) in servers {
            // config/read returns explicit nulls, which config overrides convert to
            // invalid TOML strings. Only transport discriminators are needed for a
            // disabled entry; never replay environment values or authorization headers.
            let mut entry = json!({"enabled":false,"required":false});
            for key in ["command", "url"] {
                if let Some(value) = server[key].as_str() {
                    entry[key] = json!(value);
                }
            }
            if entry.get("command").is_none() && entry.get("url").is_none() {
                return Err(error(
                    "Codex 工具配置无法隔离，本轮内容尚未发送，请检查 CLI 设置",
                ));
            }
            disabled.insert(name.clone(), entry);
        }
        config["mcp_servers"] = Value::Object(disabled);
    }
    Ok(config)
}

fn command(binary: &str, root: &std::path::Path) -> tokio::process::Command {
    let mut command = codex_command(binary);
    command
        .current_dir(root)
        .arg("app-server")
        .args(["--listen", "stdio://"]);
    command.args([
        "-c",
        "approval_policy=\"never\"",
        "-c",
        "sandbox_mode=\"read-only\"",
    ]);
    for (key, value) in chat_config().as_object().unwrap() {
        command.arg("-c").arg(format!("{key}={value}"));
    }
    #[cfg(windows)]
    command.args(["-c", "windows.sandbox=\"unelevated\""]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

async fn write_message(writer: &mut (impl AsyncWrite + Unpin), value: Value) -> AppResult<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_message(reader: &mut (impl tokio::io::AsyncBufRead + Unpin)) -> AppResult<Value> {
    // Bound one protocol line before allocation can grow with arbitrary CLI output.
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Err(error(
                "Codex 连接已结束，已保留收到的内容，请检查登录后继续对话",
            ));
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |n| n + 1);
        if bytes.len() + count > MAX_RESPONSE {
            return Err(error("Codex 返回内容过大，已保留收到的内容"));
        }
        let ended = available[count - 1] == b'\n';
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if ended {
            return Ok(serde_json::from_slice(&bytes)?);
        }
    }
}

/// Requests originating from the server are never treated as notifications or approvals.
fn rejection(value: &Value) -> Option<Value> {
    let id = value.get("id")?;
    let method = value.get("method")?.as_str()?;
    let result = match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            json!({"decision":"decline"})
        }
        "execCommandApproval" | "applyPatchApproval" => json!({"decision":"denied"}),
        "item/permissions/requestApproval" => json!({"permissions":{},"scope":"turn"}),
        _ => {
            return Some(
                json!({"id":id,"error":{"code":-32601,"message":"This chat client does not support tool or approval requests"}}),
            )
        }
    };
    Some(json!({"id":id,"result":result}))
}

async fn rpc(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    writer: &mut (impl AsyncWrite + Unpin),
    id: u32,
    method: &str,
    params: Value,
) -> AppResult<Value> {
    write_message(writer, json!({"id":id,"method":method,"params":params})).await?;
    loop {
        let value = read_message(reader).await?;
        if let Some(response) = rejection(&value) {
            write_message(writer, response).await?;
            return Err(error("当前对话未开启工具操作或权限审批，请仅发送对话内容"));
        }
        if value["id"] == id {
            if value.get("error").is_some() {
                return Err(error(&format!("Codex 请求未完成：{}", value["error"])));
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| error("Codex 返回协议不完整，请在设置中更新 CLI 后重试"));
        }
    }
}

#[derive(Default)]
struct StreamState {
    provider_thread: Option<String>,
    provider_turn: Option<String>,
    start_confirmed: bool,
    items: Vec<(String, String)>,
    last_saved: Option<Instant>,
}
impl StreamState {
    fn text(&self) -> String {
        self.items
            .iter()
            .filter(|(_, text)| !text.is_empty())
            .map(|(_, text)| text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
    fn apply(&mut self, value: &Value) -> AppResult<Option<&'static str>> {
        let params = &value["params"];
        // Never import a notification from another thread/turn into this transcript.
        if self.provider_thread.as_deref() != params["threadId"].as_str() {
            return Ok(None);
        }
        let event_turn = params["turnId"]
            .as_str()
            .or_else(|| params["turn"]["id"].as_str());
        if let Some(known) = self.provider_turn.as_deref() {
            if event_turn != Some(known) {
                return Ok(None);
            }
        } else if let Some(turn) = event_turn {
            self.provider_turn = Some(turn.into());
        } else {
            return Ok(None);
        }
        match value["method"].as_str().unwrap_or("") {
            "item/agentMessage/delta" => {
                let id = params["itemId"]
                    .as_str()
                    .ok_or_else(|| error("Codex 回复缺少消息编号"))?;
                let delta = params["delta"].as_str().unwrap_or("");
                if let Some((_, text)) = self.items.iter_mut().find(|(key, _)| key == id) {
                    text.push_str(delta);
                } else {
                    self.items.push((id.into(), delta.into()));
                }
            }
            "item/completed" if params["item"]["type"] == "agentMessage" => {
                let item = &params["item"];
                let id = item["id"]
                    .as_str()
                    .ok_or_else(|| error("Codex 回复缺少消息编号"))?;
                let text = item["text"].as_str().unwrap_or("").to_owned();
                if let Some((_, previous)) = self.items.iter_mut().find(|(key, _)| key == id) {
                    *previous = text;
                } else {
                    self.items.push((id.into(), text));
                }
            }
            "turn/completed" => {
                return match params["turn"]["status"].as_str() {
                    Some("completed") => Ok(Some("done")),
                    Some("interrupted") => Ok(Some("stopped")),
                    Some("failed") => Err(error(&format!(
                        "Codex 回复未完成：{}",
                        params["turn"]["error"]
                    ))),
                    _ => Err(error("Codex 返回了未知结束状态，已保留收到的内容")),
                }
            }
            _ => {}
        }
        if self.items.iter().map(|(_, text)| text.len()).sum::<usize>() > MAX_RESPONSE {
            return Err(error("Codex 回复过长，已保留收到的内容"));
        }
        Ok(None)
    }
    fn save(
        &mut self,
        app: &AppHandle,
        db: &Database,
        id: &str,
        turn: &str,
        force: bool,
    ) -> AppResult<()> {
        if force
            || self
                .last_saved
                .is_none_or(|last| last.elapsed() >= Duration::from_millis(120))
        {
            db.update_local_chat_text(id, turn, &self.text())?;
            emit(app, db, id);
            self.last_saved = Some(Instant::now());
        }
        Ok(())
    }
}

async fn read_stderr(mut stream: impl AsyncRead + Unpin) -> std::io::Result<String> {
    let mut tail = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..count]);
        if tail.len() > 8192 {
            tail.drain(..tail.len() - 8192);
        }
    }
    Ok(String::from_utf8_lossy(&tail).into_owned())
}

fn validate_chat_home(home: &std::path::Path) -> AppResult<()> {
    // CLI 0.153.4 injects home-level AGENTS independently of project_doc_max_bytes.
    // Do not edit shared Bowerbird CLI state or silently send those instructions.
    for name in ["AGENTS.md", "AGENTS.override.md"] {
        let path = home.join(name);
        match std::fs::metadata(path) {
            Ok(metadata) if metadata.len()>0 => return Err(error("Bowerbird 的 Codex 目录包含额外全局指令，本轮内容尚未发送；请移除该目录中的 AGENTS 指令后重试")),
            Err(detail) if detail.kind()!=std::io::ErrorKind::NotFound => return Err(detail.into()),
            _ => {}
        }
    }
    Ok(())
}

async fn run_turn(
    app: &AppHandle,
    db: &Database,
    id: &str,
    turn: &str,
    binary: &str,
    text: &str,
    images: Vec<String>,
    mut cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let home = codex_home().ok_or_else(|| error("Codex 资料目录不可用"))?;
    validate_chat_home(&home)?;
    let root = home.join("chat-workspaces").join(id);
    std::fs::create_dir_all(&root)?;
    let root = std::fs::canonicalize(root)?;
    let mut child = command(binary, &root)
        .spawn()
        .map_err(|detail| error(&format!("Codex 无法启动，请检查设置中的安装：{detail}")))?;
    let mut writer = child
        .stdin
        .take()
        .ok_or_else(|| error("Codex 输入连接不可用"))?;
    let mut reader = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| error("Codex 输出连接不可用"))?,
    );
    let stderr = tokio::spawn(read_stderr(
        child
            .stderr
            .take()
            .ok_or_else(|| error("Codex 诊断连接不可用"))?,
    ));
    let mut stream = StreamState::default();
    let previous = db.local_chat_provider_thread(id)?;
    let upgrading =
        previous.is_some() && db.local_chat_provider_tool_version(id)? < CARD_TOOL_VERSION;
    let history = if upgrading {
        Some(upgraded_history(
            &db.get_local_chat(id)?
                .ok_or_else(|| error("对话已不存在"))?,
            turn,
        ))
    } else {
        None
    };
    let execution = async {
        tokio::time::timeout(Duration::from_secs(30),rpc(&mut reader,&mut writer,1,"initialize",json!({"clientInfo":{"name":"bowerbird","title":"Bowerbird","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))).await.map_err(|_|error("Codex 启动等待超时，请检查设置中的 CLI 安装后重试"))??;
        write_message(&mut writer, json!({"method":"initialized","params":{}})).await?;
        let effective = tokio::time::timeout(
            Duration::from_secs(30),
            rpc(
                &mut reader,
                &mut writer,
                5,
                "config/read",
                json!({"includeLayers":false}),
            ),
        )
        .await
        .map_err(|_| error("Codex 对话权限检查超时，本轮内容尚未发送"))??;
        let mut params = json!({"cwd":root,"approvalPolicy":"never","sandbox":"read-only","config":isolated_thread_config(&effective)?,"baseInstructions":CHAT_INSTRUCTIONS,"developerInstructions":CHAT_INSTRUCTIONS});
        let method = if let Some(previous) = previous.as_ref().filter(|_| !upgrading) {
            params["threadId"] = json!(previous);
            "thread/resume"
        } else {
            params["dynamicTools"] = json!([card_tool_spec()]);
            "thread/start"
        };
        let response = tokio::time::timeout(
            Duration::from_secs(60),
            rpc(&mut reader, &mut writer, 2, method, params),
        )
        .await
        .map_err(|_| error("Codex 会话准备超时，本轮内容尚未发送，请检查登录后重试"))??;
        if response["approvalPolicy"] != "never" || response["sandbox"]["type"] != "readOnly" {
            return Err(error(
                "Codex 未确认只读对话权限，本次未发送内容，请更新 CLI 后重试",
            ));
        }
        let provider_thread = response["thread"]["id"]
            .as_str()
            .ok_or_else(|| error("Codex 未返回会话编号，请更新 CLI 后重试"))?
            .to_owned();
        if !upgrading
            && previous
                .as_ref()
                .is_some_and(|previous| previous != &provider_thread)
        {
            return Err(error("Codex 接续了不同会话，本次未发送内容"));
        }
        stream.provider_thread = Some(provider_thread.clone());
        let mut input = Vec::new();
        if let Some(history) = &history {
            input.push(json!({"type":"text","text":history,"text_elements":[]}));
        }
        input.push(json!({"type":"text","text":text,"text_elements":[]}));
        if !images.is_empty() {
            input.push(json!({"type":"text","text":format!("本轮显式引用图片按以下顺序对应工具别名：{}",(1..=images.len()).map(|i|format!("image{i}")).collect::<Vec<_>>().join("、")),"text_elements":[]}));
        }
        for path in images {
            input.push(json!({"type":"localImage","path":path}));
        }
        // Pump start notifications too: some versions emit them before the RPC response.
        write_message(&mut writer,json!({"id":3,"method":"turn/start","params":{"threadId":provider_thread,"input":input,"approvalPolicy":"never","sandboxPolicy":{"type":"readOnly","networkAccess":false}}})).await?;
        loop {
            let value = read_message(&mut reader).await?;
            if value["method"] == "item/tool/call" && value.get("id").is_some() {
                let result = match card_call(&value, &stream) {
                    Ok((call, args)) => {
                        let auth = app.state::<AuthClient>();
                        let entitlement = app.state::<EntitlementService>();
                        super::local_chat_cards::create_cards(
                            app,
                            db,
                            &auth,
                            &entitlement,
                            id,
                            turn,
                            call,
                            args,
                        )
                        .await
                        .and_then(|action| serde_json::to_value(action).map_err(Into::into))
                    }
                    Err(detail) => Err(detail),
                };
                // The helper commits and emits before the provider receives success. A retry
                // of the same call returns that durable batch instead of creating duplicates.
                write_message(&mut writer, card_response(&value, result)).await?;
                continue;
            }
            if let Some(response) = rejection(&value) {
                write_message(&mut writer, response).await?;
                return Err(error("当前对话未开启工具操作或权限审批，已保留回复内容"));
            }
            if value["id"] == 3 {
                if value.get("error").is_some() {
                    return Err(error(&format!("Codex 未接受本轮对话：{}", value["error"])));
                }
                let provider_turn = value["result"]["turn"]["id"]
                    .as_str()
                    .ok_or_else(|| error("Codex 未返回轮次编号"))?;
                if stream
                    .provider_turn
                    .as_deref()
                    .is_some_and(|known| known != provider_turn)
                {
                    return Err(error("Codex 本轮回复编号不一致"));
                }
                stream.provider_turn = Some(provider_turn.into());
                // Do not replace a legacy provider thread until its history and new input
                // have been accepted. A canceled/failed preparation can then retry migration.
                if upgrading {
                    db.replace_local_chat_provider_thread(
                        id,
                        previous.as_deref().unwrap(),
                        &provider_thread,
                        CARD_TOOL_VERSION,
                    )?;
                } else {
                    db.set_local_chat_provider_thread(id, &provider_thread)?;
                    db.set_local_chat_provider_tool_version(id, CARD_TOOL_VERSION)?;
                }
                db.set_local_chat_provider_turn(turn, provider_turn)?;
                stream.start_confirmed = true;
            } else {
                let result = stream.apply(&value)?;
                stream.save(app, db, id, turn, result.is_some())?;
                if let Some(status) = result {
                    return Ok(status);
                }
            }
        }
    };
    let mut result = tokio::select! {
        _=cancel.changed()=>Ok("stopped"),
        result=tokio::time::timeout(Duration::from_secs(1800),execution)=>result.unwrap_or_else(|_|Err(error("本轮对话等待超时，已保留收到的内容，请查看历史后继续对话"))),
    };
    if *cancel.borrow() {
        if let (Some(thread_id), Some(turn_id)) = (&stream.provider_thread, &stream.provider_turn) {
            let _=write_message(&mut writer,json!({"id":4,"method":"turn/interrupt","params":{"threadId":thread_id,"turnId":turn_id}})).await;
            let stopped = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let value = read_message(&mut reader).await?;
                    if let Some(response) = rejection(&value) {
                        write_message(&mut writer, response).await?;
                    }
                    if let Some(status) = stream.apply(&value)? {
                        return Ok::<_, AppError>(status);
                    }
                }
            })
            .await;
            if let Ok(Ok(status)) = stopped {
                result = Ok(status);
            }
        }
    }
    // Always reap the app-server before admitting another turn on its provider session.
    let _ = child.kill().await;
    let _ = child.wait().await;
    if let Ok(Ok(Ok(tail))) = tokio::time::timeout(Duration::from_secs(2), stderr).await {
        if result.is_err() && !tail.trim().is_empty() {
            tracing::warn!(diagnostic=%tail,"local chat app-server exited with an error");
        }
    }
    stream.save(app, db, id, turn, true)?;
    result
}

#[cfg(test)]
#[path = "local_chat_tests.rs"]
mod tests;
