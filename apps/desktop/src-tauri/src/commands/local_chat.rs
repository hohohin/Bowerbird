//! Project chat over the installed Codex app-server. No shell/terminal scraping or GenJob reuse.
use crate::{
    cloud::{AuthClient, CloudClient, EntitlementService},
    codex::codex_cli::{codex_command, codex_home, resolve_codex_binary},
    core::{local_chat::{ChatConversation, ChatProvider, ChatSendInput, ChatSummary}, paths::LibraryPaths},
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
    turn_id: String,
    cancel: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}
static ACTIVE: LazyLock<Mutex<HashMap<String, Active>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const EVENT: &str = "local-chat://updated";
#[path = "local_chat_cloud.rs"]
mod cloud_chat;
#[path = "local_chat_models.rs"]
mod models;
#[path = "local_chat_questions.rs"]
mod questions;
#[path = "local_chat_codex_questions.rs"]
mod codex_questions;
#[path = "local_chat_dsh.rs"]
mod dsh;
pub(crate) use dsh::stop_owned as stop_dsh_host;
#[path = "local_chat_dsh_local.rs"]
mod dsh_local;
#[path = "local_chat_dsh_vps.rs"]
mod dsh_vps;
const CARD_TOOL_VERSION: i64 = 8;
const CHAT_INSTRUCTIONS: &str =
    include_str!("../../../../cloud/supabase/functions/_shared/chat-instructions.txt");

use crate::core::local_chat_cards::card_tool_spec;

fn local_instructions() -> String {
    format!("{}\n{}\n{}", CHAT_INSTRUCTIONS
        .replace("不得执行命令、读写用户文件、调用其他工具或请求权限。", "不得执行任意命令、读写工程外用户文件或请求权限。")
        .replace("工具外的操作说明目前尚未开放。", ""), super::agent_ds::chat_video::INSTRUCTIONS,
        "如果缺少会影响本轮交付的重要决定，使用 request_user_input 提问，等待答复后再执行依赖该答案的操作。可以给出简短选项或允许文字作答。不要询问密码、令牌等机密，也不要用普通消息或异步提问代替需要等待的提问。")
}

fn card_call<'a>(value: &'a Value, stream: &StreamState) -> AppResult<(&'a str, &'a Value)> {
    let params = &value["params"];
    if value["method"] != "item/tool/call"
        || value.get("id").is_none()
        || !matches!(params["tool"].as_str(), Some("create_canvas_cards" | "hyperframes_video"))
        || !params["namespace"].is_null()
    {
        return Err(error("对话仅支持已开放的画板和视频工具"));
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
            if !matches!(chat.summary.status.as_str(), "running" | "stopping") {
                let _ = app.emit("local-chat://cards-changed", json!({"projectId":chat.summary.project_id,"conversationId":id}));
            }
            let _ = app.emit(EVENT, chat);
        }
        Err(detail) => tracing::warn!(%detail,"could not read local chat event"),
        _ => {}
    }
}

#[tauri::command]
pub async fn local_chat_list(
    paths: State<'_, Arc<LibraryPaths>>,
    project_id: String,
) -> AppResult<Vec<ChatSummary>> {
    let path = paths.db.clone();
    tokio::task::spawn_blocking(move || Database::open_read_only(&path)?.list_local_chats(&project_id))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}
#[tauri::command]
pub async fn local_chat_revision(db: State<'_, Arc<Database>>, conversation_id: String) -> AppResult<Option<i64>> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.local_chat_revision(&conversation_id))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn local_chat_get(
    db: State<'_, Arc<Database>>,
    conversation_id: String,
) -> AppResult<Option<ChatConversation>> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.get_local_chat(&conversation_id))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub async fn local_chat_get_by_request(db: State<'_, Arc<Database>>, request_id: String) -> AppResult<Option<ChatConversation>> {
    let db = db.inner().clone();
    tokio::task::spawn_blocking(move || db.local_chat_by_request(&request_id))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}

#[tauri::command]
pub fn local_chat_new_on_card(
    app: AppHandle, db: State<'_, Arc<Database>>, project_id: String, node_id: String,
    conversation_id: String, provider: Option<ChatProvider>, codex_options: Option<crate::core::local_chat::ChatCodexOptions>,
) -> AppResult<ChatConversation> {
    let chat = db.new_agent_chat(&project_id, &node_id, &conversation_id, provider, codex_options)?;
    emit(&app, &db, &conversation_id);
    if chat.summary.id != conversation_id {
        let _ = app.emit(EVENT, &chat);
    }
    Ok(chat)
}

fn chat_video_path(path: &str) -> bool {
    std::path::Path::new(path).extension().and_then(|ext| ext.to_str()).is_some_and(crate::media::probe::is_video)
}

fn chat_audio_path(path: &str) -> bool {
    std::path::Path::new(path).extension().and_then(|ext| ext.to_str()).is_some_and(crate::media::audio::is_audio)
}

/// Resolve explicit library assets in selection order, which also defines the card tool aliases.
fn reference_paths(db: &Database, ids: &[String]) -> AppResult<Vec<String>> {
    if ids.len() > 8 {
        return Err(error("每次对话最多引用 8 个素材"));
    }
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    let mut total = 0;
    for id in ids {
        if !seen.insert(id) {
            return Err(error("引用素材重复，请重新选择"));
        }
        let asset = db
            .get_asset(id)?
            .ok_or_else(|| error("引用素材已被删除，请重新选择"))?;
        let original = asset
            .store_path
            .ok_or_else(|| error("引用素材缺少原文件，请重新选择"))?;
        let video = chat_video_path(&original);
        let audio = chat_audio_path(&original);
        let resolved = if video || audio { db.resolve_external_paths(&[original])? } else { db.resolve_external_image_paths(&[original])? };
        let path = PathBuf::from(&resolved[0]);
        let metadata = std::fs::metadata(&path)
            .map_err(|_| error("引用素材无法读取，请检查文件位置后重试"))?;
        if !metadata.is_file() { return Err(error("引用素材缺少原文件，请重新选择")); }
        if video && chat_video_path(&resolved[0]) || audio && chat_audio_path(&resolved[0]) {
            paths.push(resolved[0].clone());
            continue;
        }
        if metadata.len() > 20 * 1024 * 1024 {
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

fn append_chat_references(input: &mut Vec<Value>, paths: &[String]) {
    for (index, path) in paths.iter().enumerate() {
        let alias = format!("image{}", index + 1);
        if chat_video_path(path) {
            input.push(json!({"type":"text","text":format!("素材 {alias} 是本轮引用的本地视频，可供建卡及视频制作工具使用。对话只收到了视频引用。"),"text_elements":[]}));
        } else if chat_audio_path(path) {
            input.push(json!({"type":"text","text":format!("素材 {alias} 是本轮引用的本地音频，可供 H3 R2V 建卡使用。"),"text_elements":[]}));
        } else {
            input.push(json!({"type":"text","text":format!("以下图片对应建卡素材 {alias}"),"text_elements":[]}));
            input.push(json!({"type":"localImage","path":path}));
        }
    }
}

#[tauri::command]
pub async fn local_chat_models() -> AppResult<Vec<models::CodexChatModel>> {
    let binary = resolve_codex_binary().ok_or_else(||error("未找到 Codex CLI，请在设置中安装并登录"))?;
    models::load(&binary).await
}

#[tauri::command]
pub async fn local_chat_dsh_status() -> AppResult<dsh::Status> {
    dsh::status().await
}

#[tauri::command]
pub async fn local_chat_dsh_account(action: String, attempt_id: Option<String>) -> AppResult<dsh::AccountStatus> {
    dsh::account(&action, attempt_id.as_deref()).await
}

#[tauri::command]
pub async fn local_chat_dsh_setup(mode: String, url: Option<String>, auth_url: Option<String>) -> AppResult<dsh::Status> {
    dsh::setup(&mode, url, auth_url).await
}

#[tauri::command]
pub async fn local_chat_quote(
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
) -> AppResult<Value> {
    cloud_chat::request(&cloud, &auth, json!({"action":"quote"})).await
}

#[tauri::command]
pub async fn local_chat_quote_paid(
    cloud: State<'_, CloudClient>, auth: State<'_, AuthClient>, model: String,
) -> AppResult<Value> {
    let account = auth.snapshot().user_id.ok_or_else(|| error("请先登录 Bowerbird 账号"))?;
    dsh_vps::paid_quote(&cloud, &auth, &account, &model).await
}

#[tauri::command]
pub async fn local_chat_paid_receipt(
    db: State<'_, Arc<Database>>, cloud: State<'_, CloudClient>, auth: State<'_, AuthClient>,
    conversation_id: String, turn_id: String,
) -> AppResult<Value> {
    let Some(saved) = db.local_chat_vps_checkpoint(&conversation_id, &turn_id)? else { return Ok(Value::Null); };
    let Some(pending) = dsh_vps::Pending::parse(&turn_id, &saved)? else { return Ok(Value::Null); };
    pending.paid_receipt(&cloud, &auth).await
}

#[tauri::command]
pub async fn local_chat_recover(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    cloud: State<'_, CloudClient>,
    auth: State<'_, AuthClient>,
    conversation_id: String,
) -> AppResult<ChatConversation> {
    let chat = db.get_local_chat(&conversation_id)?.ok_or_else(|| error("对话记录不存在"))?;
    if chat.summary.provider == "dsh-cloud" {
        let (turn, saved) = db.local_chat_recovery(&conversation_id)?;
        if let Some(pending) = dsh_vps::Pending::parse(&turn, &saved)? {
            cloud_chat::ensure_account(&auth, &pending.account)?;
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let (done, finished) = watch::channel(false);
            let running = {
                let mut active = ACTIVE.lock().unwrap();
                if active.contains_key(&conversation_id) { return Err(error("这段对话正在回复")); }
                let running = db.resume_vps_chat(&conversation_id, &turn, &saved)?;
                active.insert(conversation_id.clone(), Active { turn_id: turn.clone(), cancel: cancel_tx, finished });
                running
            };
            let _ = app.emit(EVENT,&running);
            let (db,cloud,auth) = (db.inner().clone(),cloud.inner().clone(),auth.inner().clone());
            tokio::spawn(async move {
                let result = dsh_vps::run(&app,&db,&cloud,&auth,&conversation_id,&turn,pending,None,cancel_rx).await;
                finish_chat(&app,&db,&conversation_id,&turn,result,done);
            });
            return Ok(running);
        }
    }
    match chat.summary.provider.as_str() {
        "dsh-cloud" => cloud_chat::recover(&db, &cloud, &auth, &conversation_id).await?,
        "dsh-local" => {
            let (_, saved) = db.local_chat_recovery(&conversation_id)?;
            let config = dsh::recovery_connection(&saved).await?;
            dsh_local::recover(&db, &conversation_id, &config.base, config.auth.as_deref()).await?;
        }
        _ => return Err(error("该对话服务不支持取回原请求")),
    }
    emit(&app, &db, &conversation_id);
    db.get_local_chat(&conversation_id)?
        .ok_or_else(|| error("对话记录不存在"))
}

#[tauri::command]
pub async fn local_chat_questions(
    webview: tauri::Webview, db: State<'_, Arc<Database>>, conversation_id: String,
) -> AppResult<Vec<questions::QuestionBatch>> {
    if webview.label() != "main" { return Err(error("请在主窗口查看 Agent 问题")); }
    let batches = codex_questions::batches(&conversation_id);
    if !batches.is_empty() { return Ok(batches); }
    let Some(turn) = dsh_local::questions::QuestionTurn::load(&db, &conversation_id).await? else { return Ok(Vec::new()); };
    turn.batches().await
}

#[tauri::command]
pub async fn local_chat_answer_question(
    webview: tauri::Webview, app: AppHandle, db: State<'_, Arc<Database>>, conversation_id: String,
    turn_id: String, call_id: String, answers: Vec<questions::Answer>,
) -> AppResult<()> {
    if webview.label() != "main" { return Err(error("请在主窗口回答 Agent 问题")); }
    if let Some(result) = codex_questions::answer(&conversation_id, &turn_id, &call_id, &answers) {
        return result;
    }
    static SUBMISSION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _submission = SUBMISSION.lock().await;
    let target = dsh_local::questions::QuestionTurn::load(&db, &conversation_id).await?
        .filter(|target| target.turn_id == turn_id).ok_or_else(|| error("此问题已结束，请查看最新对话"))?;
    target.validate(&call_id, &answers).await?;
    let (cancel, stop) = watch::channel(false);
    let (done, finished) = watch::channel(false);
    let (existing, resumed) = {
        let mut active = ACTIVE.lock().unwrap();
        if db.local_chat_dsh_question_checkpoint(&conversation_id)?.as_ref().is_none_or(|(turn, saved)| turn != &turn_id || saved != &target.checkpoint) {
            return Err(error("此问题已结束，请查看最新对话"));
        }
        if let Some(run) = active.get(&conversation_id) {
            if run.turn_id != turn_id || *run.cancel.borrow() { return Err(error("此轮已停止或切换")); }
            (Some(run.cancel.subscribe()), None)
        } else {
            let chat = db.resume_local_dsh_question(&conversation_id, &turn_id, &target.checkpoint)?;
            active.insert(conversation_id.clone(), Active { turn_id: turn_id.clone(), cancel, finished });
            (None, Some(chat))
        }
    };
    if let Some(mut cancel) = existing {
        if *cancel.borrow() { return Err(error("此轮已停止")); }
        return tokio::select! {
            biased;
            _ = cancel.changed() => Err(error("此轮已停止")),
            result = target.answer(&call_id, &answers) => result,
        };
    }
    if let Some(chat) = resumed { let _ = app.emit(EVENT, chat); }
    let (received, receipt) = tokio::sync::oneshot::channel();
    let db = db.inner().clone();
    tokio::spawn(async move {
        let result = target.reattach(app.clone(), db.clone(), conversation_id.clone(), call_id, answers, stop, received).await;
        finish_chat(&app, &db, &conversation_id, &turn_id, result, done);
    });
    receipt.await.map_err(|_| error("未能恢复原问答任务，请查看对话状态"))?
}

#[tauri::command]
pub async fn local_chat_send(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
    cloud: State<'_, CloudClient>,
    input: ChatSendInput,
    paid_authorization: Option<dsh_vps::PaidAuthorization>,
) -> AppResult<ChatConversation> {
    // Lost IPC acknowledgements can be retried safely, including after account downgrade.
    if let Some(mut previous) = db.replay_local_chat(&input)? {
        previous.conversation.submitted_turn_id = Some(previous.turn_id);
        return Ok(previous.conversation);
    }
    if input.agent_node_id.is_some() { super::canvas_workflow::require_pro(&auth, &entitlement).await?; }
    let provider = db.local_chat_provider(&input)?;
    if paid_authorization.is_some() && provider != ChatProvider::DshCloud {
        return Err(error("本轮 Bcoin 授权仅适用于云端 DSH 对话。"));
    }
    enum Runtime { Codex(String), DshLocal(dsh::LocalConnection), DshCloud(String, Value) }
    let runtime = match provider {
        ChatProvider::CodexLocal => {
            super::codex::require_byo(&entitlement, &auth).await?;
            let binary = resolve_codex_binary()
                .ok_or_else(|| error("未找到 Codex CLI，请在设置中安装并登录"))?;
            if !codex_home().is_some_and(|home| {
                std::fs::metadata(home.join("auth.json")).is_ok_and(|m| m.len() > 0)
            }) {
                return Err(error("Bowerbird 的 Codex 未登录，请在设置中登录"));
            }
            Runtime::Codex(binary)
        }
        ChatProvider::DshCloud => {
            let account = auth.snapshot().user_id.ok_or_else(|| error("请先登录 Bowerbird 账号"))?;
            let quote = if let Some(authorization) = &paid_authorization {
                let inherited = if input.codex_options.is_none() {
                    input.conversation_id.as_deref().map(|id| db.get_local_chat(id)).transpose()?.flatten()
                        .and_then(|chat| chat.summary.codex_options)
                } else { None };
                let model = input.codex_options.as_ref().or(inherited.as_ref())
                    .and_then(|options| options.model.as_deref()).unwrap_or("deepseek-flash");
                authorization.recheck(&cloud, &auth, &account, model).await?
            } else {
                let quote = cloud_chat::request_for_user(&cloud, &auth, json!({"action":"quote"}), &account).await?;
                if quote["paid_available"] == true {
                    return Err(error("请在对话中确认本轮 Bcoin 授权后发送。"));
                }
                if quote["available"] != true || quote["dsh_vps_v2_available"] != true || quote["unit_cost"] != 0 {
                    return Err(error("云端 DSH 会话服务暂未开放"));
                }
                quote
            };
            cloud_chat::ensure_account(&auth,&account)?;
            if input.dsh_skill.is_some() && quote["dsh_vps_skills_available"] != true { return Err(error("云端 DSH 技能暂未开放")); }
            Runtime::DshCloud(account, quote)
        }
        ChatProvider::DshLocal => {
            super::codex::require_byo(&entitlement, &auth).await?;
            let config = dsh::active_connection().await?;
            dsh_local::inspect(&config.base, config.auth.as_deref()).await?;
            Runtime::DshLocal(config)
        }
    };
    let media_paths = reference_paths(&db, &input.reference_asset_ids)?;
    let db = db.inner().clone();
    let cloud = cloud.inner().clone();
    let auth = auth.inner().clone();
    // Serialize process admission with durable turn admission. A second IPC cannot claim a turn
    // between its SQLite commit and registration, and stop always sees a committed active turn.
    let mut active = ACTIVE.lock().unwrap();
    let mut started = db.begin_local_chat(&input)?;
    started.conversation.submitted_turn_id = Some(started.turn_id.clone());
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
            turn_id: turn.clone(),
            cancel: cancel_tx,
            finished: finished_rx,
        },
    );
    drop(active);
    let returned = started.conversation;
    emit(&app, &db, &id);
    let _ = app.emit("local-chat://cards-changed", json!({"projectId":input.project_id,"conversationId":id}));
    tokio::spawn(async move {
        let result = match runtime {
            Runtime::Codex(binary) => run_turn(
                &app,
                &db,
                &id,
                &turn,
                &binary,
                &input.text,
                media_paths,
                cancel_rx,
            )
            .await,
            Runtime::DshCloud(account, quote) => {
                let mut pending = dsh_vps::Pending::new(&turn,account);
                match dsh_vps::create_body(&db, &id, &turn, &pending.key, input.dsh_skill.as_ref()) {
                    Ok(mut body) => {
                        if input.dsh_skill.is_none() {
                            for capability in ["image_card_provider", "video_card_options", "h3_r2v"] {
                                if quote[capability] == true { body[capability] = json!(true); }
                            }
                        }
                        if let Some(authorization) = &paid_authorization {
                            authorization.apply(&mut body);
                            pending.paid = true;
                        }
                        dsh_vps::run(&app,&db,&cloud,&auth,&id,&turn,pending,Some(body),cancel_rx).await
                    }
                    Err(detail) => Err(detail),
                }
            }
            Runtime::DshLocal(config) => dsh_local::run(&app, &db, &id, &turn, &config.base, config.auth.as_deref(), cancel_rx).await,
        };
        finish_chat(&app, &db, &id, &turn, result, finished_tx);
    });
    Ok(returned)
}

fn finish_chat(app: &AppHandle, db: &Database, id: &str, turn: &str, result: AppResult<&'static str>, finished: watch::Sender<bool>) {
    let (status, detail) = match result {
        Ok(status) => (status, None),
        Err(detail) => ("failed", Some(detail.to_string())),
    };
    {
        let mut active = ACTIVE.lock().unwrap();
        if let Err(detail) = db.finish_local_chat(id, turn, status, detail.as_deref()) {
            tracing::error!(%detail,"local chat completion was not saved");
        }
        active.remove(id);
    }
    emit(app, db, id);
    let _ = finished.send(true);
}

#[tauri::command]
pub async fn local_chat_stop(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    conversation_id: String,
    turn_id: Option<String>,
) -> AppResult<Option<ChatConversation>> {
    let finished = {
        let active = ACTIVE.lock().unwrap();
        if let Some(run) = active.get(&conversation_id).filter(|run| turn_id.as_ref().is_none_or(|id| id == &run.turn_id)) {
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
    config["tools.experimental_request_user_input.enabled"] = json!(true);
    config["features.default_mode_request_user_input"] = json!(true);
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

// Preserve the complete current reply on disk for crash recovery. Only the
// changed text crosses IPC. Offsets use JavaScript string (UTF-16) units.
fn save_stream_text(app: &AppHandle, db: &Database, id: &str, turn: &str, previous: &str, text: &str) -> AppResult<()> {
    if text == previous { return Ok(()); }
    if let Some((message_id, revision, updated_at)) = db.update_local_chat_text(id, turn, text)? {
        if text.is_empty() {
            // The summary may now show an earlier turn's preview.
            emit(app, db, id);
        } else {
            let suffix = text.strip_prefix(previous);
            let _ = app.emit("local-chat://text", json!({
                "conversationId": id, "messageId": message_id, "revision": revision, "updatedAt": updated_at,
                "offset": previous.encode_utf16().count(), "replace": suffix.is_none(),
                "text": suffix.unwrap_or(text), "preview": text.chars().take(240).collect::<String>()
            }));
        }
    }
    Ok(())
}

#[derive(Default)]
struct StreamState {
    provider_thread: Option<String>,
    provider_turn: Option<String>,
    start_confirmed: bool,
    early_notifications: std::collections::VecDeque<Value>,
    items: Vec<(String, String)>,
    last_saved: Option<Instant>,
    saved_text: String,
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
        let Some(event_turn) = event_turn else { return Ok(None) };
        let Some(known) = self.provider_turn.as_deref() else {
            if matches!(value["method"].as_str(), Some("item/agentMessage/delta" | "item/completed" | "turn/completed")) {
                self.early_notifications.push_back(value.clone());
            }
            return Ok(None);
        };
        if event_turn != known {
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
            let text = self.text();
            save_stream_text(app, db, id, turn, &self.saved_text, &text)?;
            self.saved_text = text;
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
    media_paths: Vec<String>,
    mut cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    if *cancel.borrow() {
        return Ok("stopped");
    }
    let interactive = db.local_chat_turn_uses_history(turn)?;
    let previous = if interactive { db.local_chat_provider_thread(id)? } else { None };
    let options = db.local_chat_turn_options(turn)?;
    if interactive && previous.is_none() && db.local_chat_has_prior_interactive_turn(id, turn)? {
        return Err(error("原 Codex 会话无法继续，请开启新对话或按当前输入重跑"));
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
    let (video_stop, video_cancel) = watch::channel(false);
    let mut pending_video = None;
    let (waiting, waiting_for_user) = watch::channel(false);
    let mut questions = codex_questions::QuestionTurn::new(id, turn, waiting);
    let execution = async {
        tokio::time::timeout(Duration::from_secs(30),rpc(&mut reader,&mut writer,1,"initialize",json!({"clientInfo":{"name":"bowerbird","title":"Bowerbird","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))).await.map_err(|_|error("Codex 启动等待超时，请检查设置中的 CLI 安装后重试"))??;
        write_message(&mut writer, json!({"method":"initialized","params":{}})).await?;
        let options = if let Some(options) = options.as_ref() {
            let catalog = tokio::time::timeout(Duration::from_secs(30), models::catalog(&mut reader, &mut writer))
                .await.map_err(|_|error("Codex 模型验证超时，本轮内容尚未发送，请重试"))??;
            Some(models::resolve(options, &catalog)?)
        } else { None };
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
        let mut params = json!({"cwd":root,"approvalPolicy":"never","sandbox":"read-only","config":isolated_thread_config(&effective)?,"baseInstructions":local_instructions(),"developerInstructions":local_instructions()});
        if let Some(options) = &options { models::apply_thread(&mut params, options); }
        let method = if let Some(previous) = previous.as_ref() {
            params["threadId"] = json!(previous);
            "thread/resume"
        } else {
            params["dynamicTools"] = json!([card_tool_spec(), super::agent_ds::chat_video::spec()]);
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
        if previous
                .as_ref()
                .is_some_and(|previous| previous != &provider_thread)
        {
            return Err(error("Codex 接续了不同会话，本次未发送内容"));
        }
        stream.provider_thread = Some(provider_thread.clone());
        let mut input = Vec::new();
        input.push(json!({"type":"text","text":text,"text_elements":[]}));
        append_chat_references(&mut input, &media_paths);
        // Pump start notifications too: some versions emit them before the RPC response.
        let mut params = json!({"threadId":provider_thread,"input":input,"approvalPolicy":"never","sandboxPolicy":{"type":"readOnly","networkAccess":false}});
        if let Some(options) = &options { models::apply_turn(&mut params, options); }
        write_message(&mut writer,json!({"id":3,"method":"turn/start","params":params})).await?;
        let mut confirmed_notifications = std::collections::VecDeque::new();
        loop {
            let value = match confirmed_notifications.pop_front() {
                Some(value) => value,
                None => questions.next_message(&mut reader, &mut writer).await?,
            };
            if value["method"] == "item/tool/requestUserInput" && value.get("id").is_some() {
                if let Err(detail) = questions.open(&value, &stream) {
                    write_message(&mut writer, json!({"id":value["id"],"error":{"code":-32602,"message":detail.to_string()}})).await?;
                    return Err(detail);
                }
                continue;
            }
            if value["method"] == "serverRequest/resolved"
                && value["params"]["threadId"].as_str() == stream.provider_thread.as_deref()
                && questions.resolved(&value["params"]["requestId"])
            {
                return Err(error("Codex 的问题已关闭，本轮未交付，请在原对话中继续"));
            }
            if value["method"] == "item/tool/call" && value.get("id").is_some() {
                if value["params"]["tool"] == "hyperframes_video" {
                    let result = match card_call(&value, &stream) {
                        Ok((call, args)) => {
                            let auth = app.state::<AuthClient>();
                            let entitlement = app.state::<EntitlementService>();
                            match super::canvas_workflow::require_pro(&auth, &entitlement).await {
                                Err(error) => Err(error),
                                Ok(()) => {
                                    let app = app.clone();
                                    let db = app.state::<Arc<Database>>().inner().clone();
                                    let (id, turn, call, args, media_paths, cancel) = (id.to_owned(), turn.to_owned(), call.to_owned(), args.clone(), media_paths.clone(), video_cancel.clone());
                                    pending_video = Some(tokio::spawn(async move {
                                        super::agent_ds::chat_video::call(&app, &db, &id, &turn, &call, &args, &media_paths, cancel).await
                                    }));
                                    let result = pending_video.as_mut().unwrap().await.map_err(|e|error(&format!("视频工具未完成：{e}"))).and_then(|v|v);
                                    pending_video = None;
                                    result
                                }
                            }
                        }
                        Err(error) => Err(error),
                    };
                    let response = match result { Ok(result) => json!({"id":value["id"],"result":result}), Err(error) => card_response(&value, Err(error)) };
                    write_message(&mut writer, response).await?;
                    continue;
                }
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
                stream.provider_turn = Some(provider_turn.into());
                if interactive && previous.is_none() {
                    db.set_local_chat_provider_thread(id, &provider_thread)?;
                    db.set_local_chat_provider_tool_version(id, CARD_TOOL_VERSION)?;
                }
                db.set_local_chat_provider_turn(turn, provider_turn)?;
                stream.start_confirmed = true;
                confirmed_notifications = std::mem::take(&mut stream.early_notifications);
            } else {
                let result = stream.apply(&value)?;
                if result == Some("done") && questions.pending() {
                    return Err(error("Codex 结束时仍有未答问题，本轮未交付，请在原对话中继续"));
                }
                stream.save(app, db, id, turn, result.is_some())?;
                if let Some(status) = result {
                    return Ok(status);
                }
            }
        }
    };
    let mut result = tokio::select! {
        biased;
        _=cancel.changed()=>Ok("stopped"),
        result=execution=>result,
        _=codex_questions::execution_budget(waiting_for_user, Duration::from_secs(1800))=>Err(error("本轮对话等待超时，已保留收到的内容，请查看历史后继续对话")),
    };
    drop(questions);
    let _ = video_stop.send(true);
    if let Some(task) = pending_video.take() { let _ = task.await; }
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
