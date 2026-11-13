//! One VPS DSH job owns the entire turn. Only its pending canvas tool runs on the desktop.
use super::*;
use crate::core::local_chat::ChatDshSkill;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::future::Future;

pub(super) const ENGINE: &str = "dsh-vps-v2";

#[derive(Serialize, Deserialize)]
pub(super) struct Pending {
    engine: String,
    pub(super) key: String,
    job: Option<String>,
    pub(super) account: String,
    #[serde(default)]
    cancel_requested: bool,
    receipt: Option<Receipt>,
}

#[derive(Serialize, Deserialize)]
struct Receipt {
    call: String,
    arguments_hash: String,
    result: Value,
}

impl Pending {
    pub(super) fn new(turn: &str, account: String) -> Self {
        Self {
            engine: ENGINE.into(),
            key: format!("chat-dsh-{turn}"),
            job: None,
            account,
            cancel_requested: false,
            receipt: None,
        }
    }
    pub(super) fn parse(turn: &str, saved: &str) -> AppResult<Option<Self>> {
        let value: Value = serde_json::from_str(saved)?;
        if value.get("engine").is_none() {
            return Ok(None);
        }
        let pending: Self = serde_json::from_value(value)?;
        if !matches!(pending.engine.as_str(), "dsh-vps-v1" | ENGINE) || pending.key != format!("chat-dsh-{turn}") {
            return Err(error("原云端 DSH 任务记录无效"));
        }
        Ok(Some(pending))
    }
    fn save(&self, db: &Database, turn: &str) -> AppResult<()> {
        db.save_vps_chat_checkpoint(turn, &serde_json::to_string(self)?)
    }
    fn query(&self, action: &str) -> Value {
        match &self.job {
            Some(job) => json!({"action":action,"job_id":job}),
            None => json!({"action":action,"idempotency_key":self.key}),
        }
    }
}

pub(super) fn create_body(
    db: &Database,
    id: &str,
    turn: &str,
    key: &str,
    skill: Option<&ChatDshSkill>,
) -> AppResult<Value> {
    let (text, references) = db.vps_chat_turn_message(id,turn)?;
    let conversation = if db.local_chat_turn_uses_history(turn)? { format!("c-{id}") } else { format!("t-{turn}") };
    let mut body = json!({"action":"create","engine":ENGINE,"idempotency_key":key,"conversation_id":conversation,
        "messages":[{"role":"user","content":cloud_chat::current_text(&text,references)}],"tools_enabled":skill.is_none()});
    if let Some(skill) = skill {
        body["skill"] = serde_json::to_value(skill)?;
    }
    Ok(body)
}

pub(super) async fn run(
    app: &AppHandle,
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    id: &str,
    turn: &str,
    pending: Pending,
    create: Option<Value>,
    cancel: watch::Receiver<bool>,
) -> AppResult<&'static str> {
    let entitlement = app.state::<EntitlementService>();
    let entitlement = entitlement.inner();
    let scoped_account = pending.account.clone();
    let account = scoped_account.as_str();
    tokio::time::timeout(
        Duration::from_secs(1800),
        drive(
            db,
            cloud,
            auth,
            id,
            turn,
            pending,
            create,
            cancel,
            |call: String, args: Value| async move {
                let action = super::super::local_chat_cards::create_cards_for_account(
                    app,
                    db,
                    auth,
                    entitlement,
                    id,
                    turn,
                    &call,
                    &args,
                    Some(account),
                )
                .await?;
                Ok(card_receipt(&action))
            },
        ),
    )
    .await
    .unwrap_or_else(|_| Err(error("云端 DSH 等待超时，可以取回原请求")))
}

fn card_receipt(action: &crate::core::local_chat_cards::ChatCardAction) -> Value {
    let mut result = json!({"success":true,"created_count":action.cards.len()});
    if let Some(status) = &action.run_status {
        result["run_status"] = json!(match status.as_str() {
            "started" => "started", "failed" => "failed", _ => "unknown",
        });
    }
    result
}

async fn drive<Fut: Future<Output = AppResult<Value>> + Send>(
    db: &Database,
    cloud: &CloudClient,
    auth: &AuthClient,
    id: &str,
    turn: &str,
    mut pending: Pending,
    create: Option<Value>,
    mut cancel: watch::Receiver<bool>,
    apply: impl Fn(String, Value) -> Fut + Send + Sync,
) -> AppResult<&'static str> {
    let account = pending.account.as_str();
    let request = |body: Value| async move {
        cloud_chat::ensure_account(auth, account)?;
        let value = cloud_chat::request_for_user(cloud, auth, body, account).await?;
        cloud_chat::ensure_account(auth, account)?;
        Ok::<Value, AppError>(value)
    };
    // Wait for admission before cancelling so a slow create cannot outrun its own cancel.
    let recovering = create.is_none();
    let mut next = if let Some(body) = create {
        if *cancel.borrow() {
            return Ok("stopped");
        }
        pending.save(db, turn)?;
        body
    } else {
        pending.query("get")
    };
    loop {
        let cancelling = pending.cancel_requested || *cancel.borrow();
        if cancelling {
            pending.cancel_requested = true;
            pending.save(db, turn)?;
            next = pending.query("cancel");
        }
        let value = match request(next).await {
            Err(_) if !cancelling && *cancel.borrow() => {
                next = pending.query("cancel");
                continue;
            }
            response => response?,
        };
        let job = value["job_id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or_else(|| error("云端 DSH 未返回原任务编号，可以取回原请求"))?;
        match &pending.job {
            Some(expected) if expected != job => {
                return Err(error("云端返回了其他任务，已停止处理"))
            }
            None => {
                pending.job = Some(job.into());
                pending.save(db, turn)?;
            }
            _ => {}
        }
        if value["error"]["code"] == "chat_cancelled" || value["status"] == "cancelled" {
            return Ok("stopped");
        }
        if let Some(message) = cloud_chat::completion(&value)? {
            if message
                .get("tool_calls")
                .is_some_and(|calls| !calls.is_null())
            {
                return Err(error("云端 DSH 返回了无效的最终工具请求"));
            }
            let text = message["content"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| error("云端 DSH 回复为空"))?;
            db.update_local_chat_text(id, turn, text)?;
            return Ok("done");
        }
        if cancelling {
            return Err(error("尚未确认云端 DSH 已停止，可以继续取回原请求"));
        }
        if *cancel.borrow() {
            next = pending.query("cancel");
            continue;
        }
        if let Some(tool) = value.get("pending_tool").filter(|t| !t.is_null()) {
            let call = tool["id"]
                .as_str()
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= 120
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                })
                .ok_or_else(|| error("云端建卡请求编号无效"))?;
            if tool["name"] != "create_canvas_cards"
                || !tool["arguments"].is_object()
                || db.local_chat_turn_has_dsh_skill(turn)?
            {
                return Err(error("本轮云端对话没有获准使用此工具"));
            }
            let args = &tool["arguments"];
            let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(args)?));
            if let Some(receipt) = pending.receipt.as_ref().filter(|r| r.call == call) {
                if receipt.arguments_hash != hash {
                    return Err(error("原建卡请求参数已变化"));
                }
            } else {
                let applied = if recovering {
                    // Retrieving a reply cannot authorize new local card mutations. The native
                    // transaction also covers a crash between card creation and receipt storage.
                    db.replay_local_chat_card_action(id, turn, call, args)
                        .and_then(|action| {
                            action
                                .as_ref().map(card_receipt)
                                .ok_or_else(|| error("取回时不执行新建卡请求"))
                        })
                } else {
                    apply(call.into(), args.clone()).await
                };
                let result = match applied {
                    Ok(receipt) => receipt,
                    Err(_) => json!({"success":false,"error":"card_creation_failed"}),
                };
                pending.receipt = Some(Receipt {
                    call: call.into(),
                    arguments_hash: hash,
                    result,
                });
                pending.save(db, turn)?;
            }
            request(json!({"action":"tool_result","job_id":job,"call_id":call,"result":pending.receipt.as_ref().unwrap().result})).await?;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(750)) => {},
            _ = cancel.changed() => {},
        }
        next = pending.query("get");
    }
}

#[cfg(test)]
#[path = "local_chat_dsh_vps_tests.rs"]
mod tests;
