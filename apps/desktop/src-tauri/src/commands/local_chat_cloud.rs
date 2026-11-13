//! Shared Cloud transport and read-only recovery for legacy completion jobs.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Pending {
    key: String,
    job: Option<String>,
    account: String,
    text: String,
}
pub(super) fn ensure_account(auth: &AuthClient, account: &str) -> AppResult<()> {
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
    let value = request_for_user(
        cloud,
        auth,
        json!({"action":"get","idempotency_key":pending.key}),
        &pending.account,
    )
    .await?;
    ensure_account(auth, &pending.account)?;
    let message = match completion(&value) {
        Err(reason @ AppError::ChatNoReply(_)) => {
            return db.record_local_chat_recovery_error(id, &turn, &saved, &reason.to_string());
        }
        result => result?.ok_or_else(|| error("原 Cloud 任务仍在处理中，请稍后取回"))?,
    };
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
    let account = auth.snapshot().user_id.ok_or_else(|| error("请先登录 Bowerbird 账号"))?;
    request_for_user(cloud, auth, body, &account).await
}

pub(super) async fn request_for_user(cloud: &CloudClient, auth: &AuthClient, body: Value, account: &str) -> AppResult<Value> {
    let endpoint = cloud
        .config()
        .endpoint("chat-proxy")
        .ok_or_else(|| error("当前构建未配置 Bowerbird Cloud"))?;
    let response = auth
        .send_authorized_for_user(
            cloud.http().post(endpoint).json(&body),
            "Cloud 对话请求失败", account,
        )
        .await?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| error("Cloud 对话响应读取失败"))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| error("Cloud 对话响应无效"))?;
    if !status.is_success() {
        let message = value["error"]["message"]
            .as_str()
            .unwrap_or("Cloud 对话暂时不可用，请稍后重试");
        return Err(error(message));
    }
    Ok(value)
}

pub(super) fn current_text(text: &str, reference_count: usize) -> String {
    let mut text = text.to_owned();
    text.push_str("\n\n[本轮引用范围] 此对话只收到文字，未上传任何图片像素或视频画面。需要了解素材内容时请用户文字说明。");
    if reference_count > 0 {
        text.push_str(&format!("本轮可用于本机建卡的素材别名：{}。",
            (1..=reference_count).map(|i| format!("image{i}")).collect::<Vec<_>>().join("、")));
    }
    text
}

pub(super) fn messages(chat: &ChatConversation, turn: &str, include_history: bool) -> AppResult<Vec<Value>> {
    let current = chat.messages.iter().find(|m| m.turn_id == turn && m.role == "user")
        .ok_or_else(|| error("对话轮次不存在"))?;
    let mut text = current_text(&current.text,current.reference_asset_ids.len());
    // Keep the suffix of complete turns. Messages after this user turn can appear when a saved
    // request is inspected, and failed or interrupted exchanges must not become model context.
    let mut history = Vec::new();
    let mut included = HashSet::new();
    if include_history {
        let end = chat.messages.iter().position(|m| m.turn_id == turn).unwrap();
        for group in chat.messages[..end].chunk_by(|a,b| a.turn_id == b.turn_id).rev() {
            let public: Vec<_> = group.iter().filter(|m| matches!(m.role.as_str(), "user" | "assistant")).collect();
            if public.first().is_none_or(|m| m.role != "user") || !public.iter().any(|m| m.role == "assistant")
                || public.iter().any(|m| m.status != "done" || m.text.trim().is_empty()) { continue; }
            if history.len() + public.len() + 1 > 80 { break; }
            included.insert(group[0].turn_id.as_str());
            history.extend(public.into_iter().rev().map(|m| json!({"role":m.role,"content":m.text})));
        }
    }
    history.reverse();
    if !included.is_empty() {
        let actions: Vec<Value> = chat.actions.iter().rev().filter(|a| included.contains(a.turn_id.as_str())).take(8).map(|action| json!({
            "status":action.status,
            "cards":action.cards.iter().map(|card|json!({"kind":card.kind,"title":card.title})).collect::<Vec<_>>()
        })).collect();
        if !actions.is_empty() {
            text.push_str(&format!("\n[近期建卡历史，仅作上下文，不授权重复创建] {}", json!(actions)));
        }
    }
    history.push(json!({"role":"user","content":text}));
    Ok(history)
}

pub(super) fn completion(value: &Value) -> AppResult<Option<Value>> {
    match value["status"].as_str() {
        Some("uploading" | "queued" | "running") => Ok(None),
        Some("succeeded") => {
            if let Some(message) = value["error"]["message"].as_str() {
                return Err(AppError::ChatNoReply(message.to_owned()));
            }
            let message = &value["message"];
            if message["role"] != "assistant"
                || (!message["content"].is_null() && !message["content"].is_string())
            {
                return Err(AppError::ChatNoReply("云端保存的回复格式无效，没有可取回的回复。".into()));
            }
            Ok(Some(message.clone()))
        }
        Some("outcome_unknown" | "failed" | "cancelled") => {
            // Older gateways used a waiting instruction even for terminal jobs.
            let detail = value["error"]["message"].as_str()
                .filter(|_| value["error"]["recoverable"] == false)
                .unwrap_or("本轮云端任务已结束，没有可取回的回复。");
            Err(AppError::ChatNoReply(detail.to_owned()))
        }
        _ => Err(error("Cloud 对话状态无效")),
    }
}


pub(super) fn calls(message: &Value) -> AppResult<Vec<(String, Value)>> {
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


#[cfg(test)]
#[path = "local_chat_cloud_tests.rs"]
pub(super) mod tests;
