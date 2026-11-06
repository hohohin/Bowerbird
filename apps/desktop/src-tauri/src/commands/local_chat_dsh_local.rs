//! A fresh, restricted session on the user's DSH host for each app turn.
//! The host owns its credentials/model selection; this bridge owns its preset and tools.
use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize)]
struct Pending {
    version: u8,
    base: String,
    session: String,
    rpc_id: String,
    after: i64,
}

fn session_id(turn: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "session-bowerbird-chat-{:x}",
        Sha256::digest(turn.as_bytes())
    )
}

fn local_base(base: &str) -> AppResult<String> {
    dsh::validate_connection(base, None)
}

struct Host {
    client: reqwest::Client,
    base: String,
}
impl Host {
    async fn connect(base: &str, auth: Option<&str>) -> AppResult<Self> {
        let base = local_base(base)?;
        let client = super::super::agent_ds::dsh_client(&base, auth)
            .await
            .map_err(|_| error("无法连接本机 DSH，请检查服务与登录链接"))?;
        Ok(Self { client, base })
    }

    async fn call(&self, method: &str, payload: Value, rpc_id: &str) -> AppResult<Value> {
        let mut response = self
            .client
            .post(format!("{}/api/{method}", self.base))
            .json(
                &json!({"type":"client-request","rpcId":rpc_id,"method":method,"payload":payload}),
            )
            .send()
            .await
            .map_err(|_| error("本机 DSH 连接中断；未自动重发，请取回原回复"))?;
        // A missing route is the only safe retry. An uncertain prompt may already be running.
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            let endpoint = method.replace('.', "/");
            let mut request = payload;
            if method == "session.prompt" {
                request["requestId"] = json!(rpc_id);
            }
            let args = if matches!(method, "session.list" | "agentPreset.list") {
                json!({"_request":request})
            } else {
                json!({"request":request})
            };
            response = self.client.post(format!("{}/api/{endpoint}", self.base))
                .json(&json!({"type":"client-request","rpcId":rpc_id,"method":endpoint,"payload":{"args":args}}))
                .send().await.map_err(|_| error("本机 DSH 连接中断；未自动重发，请取回原回复"))?;
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(error("本机 DSH 登录已失效，请更新登录链接后重试"));
        }
        if !response.status().is_success() {
            return Err(error("本机 DSH 请求未完成，请检查服务后取回原回复"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| error("本机 DSH 响应读取中断，请取回原回复"))?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(error("本机 DSH 回复超过长度限制"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| error("本机 DSH 响应格式无效"))?;
        if value["result"]["ok"] != true {
            return Err(error(
                "本机 DSH 未接受请求，请检查模型配置与服务版本；未自动重发",
            ));
        }
        Ok(value["result"]["value"].clone())
    }

    async fn history(&self, pending: &Pending) -> AppResult<Vec<Value>> {
        let mut entries = BTreeMap::new();
        let mut before = None;
        let mut bytes = 0;
        for _ in 0..64 {
            let mut request = json!({"sessionId":pending.session,"maxMessages":30});
            if let Some(seq) = before {
                request["beforeSeq"] = json!(seq);
            }
            let page = self
                .call(
                    "session.history",
                    request,
                    &uuid::Uuid::new_v4().to_string(),
                )
                .await?;
            let events = page["events"]
                .as_array()
                .ok_or_else(|| error("本机 DSH 历史格式无效"))?;
            let mut earliest = before.unwrap_or(i64::MAX);
            for entry in events {
                let seq = entry["event"]["seq"]
                    .as_i64()
                    .ok_or_else(|| error("本机 DSH 历史缺少顺序编号"))?;
                earliest = earliest.min(seq);
                if seq > pending.after && !entries.contains_key(&seq) {
                    bytes += entry.to_string().len();
                    if bytes > MAX_RESPONSE {
                        return Err(error("本机 DSH 本轮记录超过长度限制"));
                    }
                    entries.insert(seq, entry.clone());
                }
            }
            if page["hasMore"] != true || earliest <= pending.after {
                return Ok(entries.into_values().collect());
            }
            if events.is_empty() || before.is_some_and(|seq| earliest >= seq) {
                return Err(error("本机 DSH 历史分页无效"));
            }
            before = Some(earliest);
        }
        Err(error("本机 DSH 本轮记录超过分页限制"))
    }
}

pub(super) async fn health(base: &str, auth: Option<&str>) -> AppResult<()> {
    let host = Host::connect(base, auth).await?;
    let value = host
        .call(
            "agentPreset.list",
            json!({}),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    if value["authorable"] != true || !value["presets"].is_array() {
        return Err(error("本机 DSH 尚不支持独立对话工具，请更新 DSH 后重试"));
    }
    Ok(())
}

#[derive(Default)]
struct Reply {
    text: String,
    target: Option<i64>,
    latest: Option<i64>,
    reason: Option<String>,
}
impl Reply {
    fn status(&self) -> AppResult<Option<&'static str>> {
        match self.reason.as_deref() {
            None => Ok(None),
            Some("completed") => Ok(Some("done")),
            Some("aborted") => Ok(Some("stopped")),
            Some("interrupted") => Ok(Some("interrupted")),
            Some("max-tokens") => Err(error("本机 DSH 回复达到长度上限，已保留收到的内容")),
            Some("blocked") => Err(error("本机 DSH 本轮被阻止，请检查 DSH 后继续")),
            _ => Err(error(
                "本机 DSH 本轮未完成，已保留收到的内容；请检查模型配置或取回原回复",
            )),
        }
    }
}

fn fold_history(entries: &[Value], rpc_id: &str, after: i64) -> AppResult<Reply> {
    let mut reply = Reply::default();
    let mut parts: BTreeMap<i64, String> = BTreeMap::new();
    for entry in entries {
        let event = &entry["event"];
        if event["seq"]
            .as_i64()
            .ok_or_else(|| error("本机 DSH 历史编号无效"))?
            <= after
        {
            continue;
        }
        let data = &event["data"];
        match event["type"].as_str() {
            Some("turn/start") => reply.latest = data["turn"].as_i64(),
            Some("user/message")
                if data["source"]["rpcId"] == rpc_id || data["source"]["requestId"] == rpc_id =>
            {
                reply.target = reply.latest;
            }
            Some("assistant/chunk")
                if reply.target.is_some() && data["turn"].as_i64() == reply.target =>
            {
                if data["chunk"]["type"] == "text-delta" {
                    let step = data["step"]
                        .as_i64()
                        .ok_or_else(|| error("本机 DSH 回复步骤无效"))?;
                    parts
                        .entry(step)
                        .or_default()
                        .push_str(data["chunk"]["text"].as_str().unwrap_or(""));
                }
            }
            Some("assistant/message")
                if reply.target.is_some() && data["turn"].as_i64() == reply.target =>
            {
                // Replacement surface messages are context compaction, not new public replies.
                if event["surfaceOp"].is_object() {
                    continue;
                }
                let step = data["step"]
                    .as_i64()
                    .ok_or_else(|| error("本机 DSH 回复步骤无效"))?;
                let content = data["message"]["content"]
                    .as_array()
                    .ok_or_else(|| error("本机 DSH 回复内容无效"))?;
                let text = content
                    .iter()
                    .filter(|block| block["type"] == "text")
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("");
                parts.insert(step, text);
            }
            Some("turn/end") if reply.target.is_some() && data["turn"].as_i64() == reply.target => {
                reply.reason = Some(data["reason"]["kind"].as_str().unwrap_or("unknown").into());
            }
            _ => {}
        }
    }
    reply.text = parts
        .into_values()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if reply.text.len() > MAX_RESPONSE {
        return Err(error("本机 DSH 本轮回复超过长度限制"));
    }
    Ok(reply)
}

#[derive(Clone)]
struct GatewayState {
    app: AppHandle,
    db: Arc<Database>,
    id: String,
    turn: String,
    session: String,
    token: String,
    active: Arc<std::sync::atomic::AtomicBool>,
}

fn authorized(state: &GatewayState, headers: &axum::http::HeaderMap, body: &Value) -> bool {
    state.active.load(std::sync::atomic::Ordering::Acquire)
        && !headers.contains_key(axum::http::header::ORIGIN)
        && headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            == Some(format!("Bearer {}", state.token).as_str())
        && body["sessionId"] == state.session
        && body["callId"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 200)
}

async fn tool_call(
    axum::extract::State(state): axum::extract::State<GatewayState>,
    headers: axum::http::HeaderMap,
    axum::Json(body): axum::Json<Value>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    if !authorized(&state, &headers, &body) {
        return (
            axum::http::StatusCode::FORBIDDEN,
            axum::Json(json!({"error":"当前对话工具授权已失效"})),
        );
    }
    let auth = state.app.state::<AuthClient>();
    let entitlement = state.app.state::<EntitlementService>();
    let result = super::super::local_chat_cards::create_cards(
        &state.app,
        &state.db,
        &auth,
        &entitlement,
        &state.id,
        &state.turn,
        body["callId"].as_str().unwrap(),
        &body["arguments"],
    )
    .await;
    let value = match result {
        Ok(action) => json!({"success":true,"action":action}),
        Err(detail) => json!({"success":false,"error":detail.to_string()}),
    };
    (axum::http::StatusCode::OK, axum::Json(value))
}

struct Gateway {
    endpoint: String,
    token: String,
    active: Arc<std::sync::atomic::AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl Gateway {
    async fn start(
        app: &AppHandle,
        db: &Arc<Database>,
        id: &str,
        turn: &str,
        session: &str,
        mut cancel: watch::Receiver<bool>,
    ) -> AppResult<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}/cards", listener.local_addr()?);
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let state = GatewayState {
            app: app.clone(),
            db: db.clone(),
            id: id.into(),
            turn: turn.into(),
            session: session.into(),
            token: token.clone(),
            active: active.clone(),
        };
        let router = axum::Router::new()
            .route("/cards", axum::routing::post(tool_call))
            .layer(axum::extract::DefaultBodyLimit::max(512_000))
            .with_state(state);
        let cancellation = active.clone();
        let task = tokio::spawn(async move {
            let shutdown = async move {
                let _ = cancel.wait_for(|stop| *stop).await;
                cancellation.store(false, std::sync::atomic::Ordering::Release);
            };
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(shutdown)
                .await;
        });
        Ok(Self {
            endpoint,
            token,
            active,
            task,
        })
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.active
            .store(false, std::sync::atomic::Ordering::Release);
        self.task.abort();
    }
}

fn preset_source(endpoint: &str, token: &str, session: &str) -> String {
    format!(
        "const connection = {};\nconst tool = {};\n{}",
        json!({"endpoint":endpoint,"token":token,"session":session}),
        card_tool_spec(),
        include_str!("local_chat_dsh_tool.mjs")
    )
}

struct Preset {
    id: String,
    directory: PathBuf,
}
impl Drop for Preset {
    fn drop(&mut self) {
        // Only the files exclusively created by this turn; preserve any unexpected contents.
        for name in ["agent.cordis.yml", "bowerbird-tools.mjs"] {
            let _ = std::fs::remove_file(self.directory.join(name));
        }
        let _ = std::fs::remove_dir(&self.directory);
    }
}

fn prepare_preset(
    root: &std::path::Path,
    turn: &str,
    endpoint: &str,
    token: &str,
    session: &str,
) -> AppResult<Preset> {
    // A unique directory is never overwritten, including after interrupted installation.
    ulid::Ulid::from_string(turn).map_err(|_| error("对话轮次编号无效"))?;
    let id = format!("bowerbird-chat-{turn}");
    std::fs::create_dir_all(root)?;
    let directory = root.join(&id);
    std::fs::create_dir(&directory)?;
    let preset = Preset { id, directory };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&preset.directory, std::fs::Permissions::from_mode(0o700))?;
    }
    let rows = json!([
        {"id":"persona","name":"@deepseek-ai/dsh-persona","config":{"text":CHAT_INSTRUCTIONS,"complete":true,"includeRuntimeContext":false}},
        {"id":"bowerbird-cards","name":"./bowerbird-tools.mjs"}
    ]);
    std::fs::write(
        preset.directory.join("bowerbird-tools.mjs"),
        preset_source(endpoint, token, session),
    )?;
    // JSON is a strict subset of YAML. Publish the discoverable composition last.
    std::fs::write(
        preset.directory.join("agent.cordis.yml"),
        serde_json::to_vec(&rows)?,
    )?;
    Ok(preset)
}

fn preset_root() -> AppResult<PathBuf> {
    if let Some(home) = std::env::var_os("DSH_HOME").filter(|value| !value.is_empty()) {
        let home = PathBuf::from(home);
        if !home.is_absolute() {
            return Err(error("DSH_HOME 须为本机绝对目录"));
        }
        return Ok(home.join(".agent-presets"));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .ok_or_else(|| error("无法定位本机 DSH 用户目录"))?;
    Ok(PathBuf::from(home).join(".dsh/.agent-presets"))
}

pub(super) async fn run(
    app: &AppHandle,
    db: &Arc<Database>,
    id: &str,
    turn: &str,
    base: &str,
    auth: Option<&str>,
    cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let host = Host::connect(base, auth).await?;
    let session = session_id(turn);
    let gateway = Gateway::start(app, db, id, turn, &session, cancel.clone()).await?;
    let root = preset_root()?;
    let preset = prepare_preset(&root, turn, &gateway.endpoint, &gateway.token, &session)?;
    let cwd = root.parent().ok_or_else(|| error("本机 DSH 目录无效"))?;
    let created = host
        .call(
            "session.create",
            json!({"sessionId":session,"cwd":cwd,"agentPreset":preset.id}),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await?;
    if created["sessionId"] != session || created["agentPreset"] != preset.id {
        return Err(error("本机 DSH 未启用本轮独立工具，未发送对话"));
    }
    let chat = db
        .get_local_chat(id)?
        .ok_or_else(|| error("对话记录不存在"))?;
    let pending = Pending {
        version: 1,
        base: host.base.clone(),
        session,
        rpc_id: uuid::Uuid::new_v4().to_string(),
        after: -1,
    };
    // Save before dispatch: a lost acknowledgement must never create a second model turn.
    db.set_local_chat_provider_turn(turn, &serde_json::to_string(&pending)?)?;
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let accepted=host.call("session.prompt",json!({"sessionId":pending.session,"mode":"queue","content":[{"type":"text","text":dsh::prompt(&chat,turn)?}]}),&pending.rpc_id).await?;
    if accepted["accepted"] != true {
        return Err(error("本机 DSH 未确认接收，请取回原回复；未自动重发"));
    }
    let start = Instant::now();
    let mut cancellation = None;
    let mut cancel_sent = false;
    let mut saved = String::new();
    loop {
        let reply = fold_history(
            &host.history(&pending).await?,
            &pending.rpc_id,
            pending.after,
        )?;
        if reply.text != saved {
            db.update_local_chat_text(id, turn, &reply.text)?;
            saved = reply.text.clone();
            emit(app, db, id);
        }
        if let Some(status) = reply.status()? {
            return Ok(status);
        }
        if *cancel.borrow() {
            gateway
                .active
                .store(false, std::sync::atomic::Ordering::Release);
            cancellation.get_or_insert_with(Instant::now);
            if !cancel_sent && reply.target.is_some() {
                if reply.latest != reply.target {
                    return Err(error(
                        "本机 DSH 会话已发生变化，未中断其他轮次；请取回原回复",
                    ));
                }
                host.call(
                    "session.cancel",
                    json!({"sessionId":pending.session}),
                    &uuid::Uuid::new_v4().to_string(),
                )
                .await?;
                cancel_sent = true;
            }
        }
        if cancellation.is_some_and(|sent| sent.elapsed() > Duration::from_secs(20)) {
            return Err(error(
                "本机 DSH 尚未确认停止，工具通道已关闭；请稍后取回原回复",
            ));
        }
        if start.elapsed() > Duration::from_secs(1800) {
            return Err(error("本机 DSH 回复等待超时，未自动重发；请取回原回复"));
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}

pub(super) async fn recover(
    db: &Database,
    id: &str,
    base: &str,
    auth: Option<&str>,
) -> AppResult<()> {
    let (turn, saved) = db.local_chat_recovery(id)?;
    let pending: Pending =
        serde_json::from_str(&saved).map_err(|_| error("原本机 DSH 任务记录不完整"))?;
    if pending.version != 1
        || pending.base != local_base(base)?
        || pending.session != session_id(&turn)
    {
        return Err(error("本机 DSH 服务已改变，请连接原服务后取回回复"));
    }
    let host = Host::connect(base, auth).await?;
    let mut reply = fold_history(
        &host.history(&pending).await?,
        &pending.rpc_id,
        pending.after,
    )?;
    let complete = match reply.status() {
        Ok(Some("done")) => true,
        Ok(Some(_)) => false,
        Err(detail) => {
            reply.text.push_str(&format!("\n\n{detail}"));
            false
        }
        Ok(None) => return Err(error("原本机 DSH 任务尚未结束或无法确认；未重新发送")),
    };
    db.restore_local_chat_reply(id, &turn, &saved, &reply.text, complete)
}

#[cfg(test)]
#[path = "local_chat_dsh_local_tests.rs"]
mod tests;
