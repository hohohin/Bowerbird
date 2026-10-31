//! Cloud transports one completion at a time; the existing desktop chat owns history/tools.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Pending {
    key: String,
    job: Option<String>,
    account: String,
    text: String,
}
fn ensure_account(auth: &AuthClient, account: &str) -> AppResult<()> {
    if auth.snapshot().user_id.as_deref() != Some(account) {
        return Err(error("账号已切换，请回到原账号后取回回复"));
    }
    Ok(())
}

pub(super) async fn recover(
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    id: &str,
) -> AppResult<()> {
    let (turn, saved) = db.local_chat_recovery(id)?;
    let pending: Pending =
        serde_json::from_str(&saved).map_err(|_| error("原 Cloud 任务记录不完整，无法取回"))?;
    ensure_account(auth, &pending.account)?;
    let value = request(
        cloud,
        auth,
        json!({"action":"get","idempotency_key":pending.key}),
    )
    .await?;
    ensure_account(auth, &pending.account)?;
    let message =
        completion(&value)?.ok_or_else(|| error("原 Cloud 任务仍在处理中，请稍后取回"))?;
    let has_calls = !calls(&message)?.is_empty();
    let mut text = pending.text;
    if let Some(content) = message["content"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(content);
    }
    if has_calls {
        text.push_str("\n\n原回复包含卡片创建请求。本次仅取回文字，未继续执行工具；已创建卡片请查看本轮回执，需要继续时请发送新消息。");
    }
    db.restore_local_chat_reply(id, &turn, &saved, &text, !has_calls)
}

pub(super) async fn request(
    cloud: &CloudClient,
    auth: &AuthClient,
    body: Value,
) -> AppResult<Value> {
    let endpoint = cloud
        .config()
        .endpoint("chat-proxy")
        .ok_or_else(|| error("当前构建未配置 Bowerbird Cloud"))?;
    let response = auth
        .send_authorized(
            cloud.http().post(endpoint).json(&body),
            "Cloud 对话请求失败",
        )
        .await?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| error("Cloud 对话响应读取失败"))?;
    if bytes.len() > MAX_RESPONSE {
        return Err(error("Cloud 对话响应过大"));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| error("Cloud 对话响应无效"))?;
    if !status.is_success() {
        let message = value["error"]["message"]
            .as_str()
            .unwrap_or("Cloud 对话暂时不可用，请稍后重试");
        return Err(error(message));
    }
    Ok(value)
}

fn messages(chat: &ChatConversation, turn: &str) -> AppResult<Vec<Value>> {
    let current = chat
        .messages
        .iter()
        .find(|m| m.turn_id == turn && m.role == "user")
        .ok_or_else(|| error("对话轮次不存在"))?;
    let mut text = current.text.clone();
    text.push_str("\n\n[本轮引用范围] DeepSeek Cloud 只收到文字，未上传任何图片像素，不能声称已看图或分析图像。历史图片同样未上传。");
    if !current.reference_asset_ids.is_empty() {
        text.push_str(&format!("本轮仅供本机建卡的图片别名：{}。可引用这些别名创建卡片，需要视觉内容时请用户文字说明。",
            (1..=current.reference_asset_ids.len()).map(|i| format!("image{i}")).collect::<Vec<_>>().join("、")));
    }
    if !chat.actions.is_empty() {
        let actions: Vec<Value> = chat.actions.iter().rev().take(8).map(|action| json!({
            "status":action.status,
            "cards":action.cards.iter().map(|card|json!({"kind":card.kind,"title":card.title})).collect::<Vec<_>>()
        })).collect();
        text.push_str(&format!(
            "\n[近期建卡历史，仅作上下文，不授权重复创建] {}",
            json!(actions)
        ));
    }
    let mut messages = vec![json!({"role":"user","content":text})];
    let mut bytes = messages[0].to_string().len();
    for old in chat.messages.iter().rev().filter(|m| {
        m.turn_id != turn && !m.text.is_empty() && matches!(m.role.as_str(), "user" | "assistant")
    }) {
        let message = json!({"role":old.role,"content":old.text});
        bytes += message.to_string().len();
        // Reserve space for tool replies in this bounded turn. Full history stays in SQLite.
        if bytes > 220_000 || messages.len() >= 80 {
            break;
        }
        messages.push(message);
    }
    messages.reverse();
    Ok(messages)
}

fn completion(value: &Value) -> AppResult<Option<Value>> {
    match value["status"].as_str() {
        Some("uploading" | "queued" | "running") => Ok(None),
        Some("succeeded") => {
            if let Some(message) = value["error"]["message"].as_str() {
                return Err(error(message));
            }
            let message = &value["message"];
            if message["role"] != "assistant"
                || (!message["content"].is_null() && !message["content"].is_string())
            {
                return Err(error("Cloud 对话消息格式无效"));
            }
            Ok(Some(message.clone()))
        }
        Some("outcome_unknown") => Err(error(
            "Cloud 本轮结果暂无法确认，未自动重发；请稍后查看原任务",
        )),
        Some("failed" | "cancelled") => Err(error(
            value["error"]["message"]
                .as_str()
                .unwrap_or("Cloud 对话未完成，请稍后重试"),
        )),
        _ => Err(error("Cloud 对话状态无效")),
    }
}

async fn complete(
    cloud: &CloudClient,
    auth: &AuthClient,
    db: &Database,
    turn: &str,
    round: usize,
    messages: &[Value],
    account: &str,
    text: &str,
) -> AppResult<Value> {
    ensure_account(auth, account)?;
    let mut pending = Pending {
        key: format!("chat-{turn}-{round}"),
        job: None,
        account: account.into(),
        text: text.into(),
    };
    db.set_local_chat_provider_turn(turn, &serde_json::to_string(&pending)?)?;
    let mut value = request(cloud, auth, json!({"action":"create", "idempotency_key":pending.key, "messages":messages, "tools_enabled":true})).await?;
    ensure_account(auth, account)?;
    let job = value["job_id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or_else(|| error("Cloud 对话未返回任务编号"))?
        .to_owned();
    pending.job = Some(job.clone());
    db.set_local_chat_provider_turn(turn, &serde_json::to_string(&pending)?)?;
    loop {
        if let Some(message) = completion(&value)? {
            return Ok(message);
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
        ensure_account(auth, account)?;
        value = request(cloud, auth, json!({"action":"get", "job_id":job})).await?;
        ensure_account(auth, account)?;
    }
}

fn calls(message: &Value) -> AppResult<Vec<(String, Value)>> {
    let Some(raw) = message.get("tool_calls").filter(|v| !v.is_null()) else {
        return Ok(vec![]);
    };
    let raw = raw
        .as_array()
        .filter(|v| v.len() <= 4)
        .ok_or_else(|| error("Cloud 工具请求过多或格式无效"))?;
    let mut ids = HashSet::new();
    raw.iter()
        .map(|call| {
            let id = call["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 200)
                .ok_or_else(|| error("Cloud 工具请求缺少编号"))?;
            if !ids.insert(id)
                || call["type"] != "function"
                || call["function"]["name"] != "create_canvas_cards"
            {
                return Err(error("Cloud 对话仅支持创建画板卡片工具"));
            }
            let args = call["function"]["arguments"]
                .as_str()
                .ok_or_else(|| error("Cloud 卡片参数无效"))?;
            Ok((
                id.into(),
                serde_json::from_str(args).map_err(|_| error("Cloud 卡片参数无效"))?,
            ))
        })
        .collect()
}

pub(super) async fn run(
    app: &AppHandle,
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    id: &str,
    turn: &str,
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
    let mut messages = messages(&chat, turn)?;
    let mut text = String::new();
    let execution = async {
        for round in 0..12 {
            let message =
                complete(cloud, auth, db, turn, round, &messages, &account, &text).await?;
            let calls = calls(&message)?;
            if let Some(content) = message["content"].as_str().filter(|s| !s.is_empty()) {
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(content);
                if text.len() > MAX_RESPONSE {
                    return Err(error("Cloud 本轮回复超过长度限制"));
                }
                db.update_local_chat_text(id, turn, &text)?;
                emit(app, db, id);
            }
            messages.push(message);
            if calls.is_empty() {
                return Ok("done");
            }
            for (call, args) in calls {
                ensure_account(auth, &account)?;
                let entitlement = app.state::<EntitlementService>();
                let result = super::super::local_chat_cards::create_cards(
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
                let result = match result {
                    Ok(action) => json!({"success":true,"action":action}),
                    Err(detail) => json!({"success":false,"error":detail.to_string()}),
                };
                messages
                    .push(json!({"role":"tool","tool_call_id":call,"content":result.to_string()}));
            }
        }
        Err(error(
            "本轮卡片编排已达到次数上限，请查看已创建卡片后继续对话",
        ))
    };
    tokio::select! {
        _ = cancel.changed() => Ok("stopped"),
        result = tokio::time::timeout(Duration::from_secs(1800), execution) => result.unwrap_or_else(|_| Err(error("Cloud 对话等待超时，已保留收到的内容；未自动重发任务"))),
    }
}

#[cfg(test)]
#[path = "local_chat_cloud_tests.rs"]
mod tests;
