use crate::{
    cloud::{AuthClient, EntitlementService},
    core::{local_chat::ChatConversation, local_chat_cards::ChatCardAction},
    db::Database,
    error::{AppError, AppResult},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Listener, State};

fn publish(app: &AppHandle, db: &Database, conversation: &str, action: &str, scheduled: bool) {
    if let Ok(Some(chat)) = db.get_local_chat(conversation) {
        let _=app.emit("local-chat://cards-changed",serde_json::json!({"projectId":chat.summary.project_id,"conversationId":conversation,"actionId":action,"scheduled":scheduled}));
        let _ = app.emit("local-chat://updated", chat);
    }
}
/// Only the scoped app-server callback calls this; no webview IPC accepts model creation arguments.
pub async fn create_cards(
    app: &AppHandle,
    db: &Database,
    auth: &AuthClient,
    entitlement: &EntitlementService,
    conversation_id: &str,
    turn_id: &str,
    call_id: &str,
    args: &Value,
) -> AppResult<ChatCardAction> {
    create_cards_for_account(app,db,auth,entitlement,conversation_id,turn_id,call_id,args,None).await
}
pub(super) async fn create_cards_for_account(
    app: &AppHandle, db: &Database, auth: &AuthClient, entitlement: &EntitlementService,
    conversation_id: &str, turn_id: &str, call_id: &str, args: &Value, account: Option<&str>,
) -> AppResult<ChatCardAction> {
    if let Some(action) =
        db.replay_local_chat_card_action(conversation_id, turn_id, call_id, args)?
    {
        return Ok(action);
    }
    super::canvas_workflow::require_pro(auth, entitlement).await?;
    let user = auth.snapshot().user_id.ok_or_else(|| AppError::Other("请先登录".into()))?;
    let owner = account.unwrap_or(&user);
    let mut action = auth.with_current_user(owner, || {
        db.create_local_chat_cards_for_account(conversation_id, turn_id, call_id, args, owner)
    })?;
    let scheduled = args["cards"].as_array().is_some_and(|cards| cards.iter().any(|card|
        card["kind"] == "trigger" && matches!(card["triggerMode"].as_str(), Some("daily" | "once"))));
    publish(app, db, conversation_id, &action.id, scheduled);
    if action.run_status.as_deref() == Some("requested") && action.fresh {
        let reply = format!("local-chat://run-result-{}", action.id);
        let (send, receive) = tokio::sync::oneshot::channel();
        let listener = app.once(reply, move |event| {
            let _ = send.send(serde_json::from_str::<bool>(event.payload()).unwrap_or(false));
        });
        let status = if app.emit_to("main", "local-chat://start-card", &action.id).is_err() {
            "failed"
        } else {
            match tokio::time::timeout(std::time::Duration::from_secs(45), receive).await {
                Ok(Ok(true)) => "started",
                Ok(Ok(false)) => "failed",
                _ => "unknown",
            }
        };
        app.unlisten(listener);
        db.finish_chat_card_dispatch(&action.id, status)?;
        action.run_status = Some(status.into());
        if let Ok(Some(chat)) = db.get_local_chat(conversation_id) { let _ = app.emit("local-chat://updated", chat); }
    }
    Ok(action)
}

#[tauri::command]
pub fn local_chat_claim_card_run(
    webview: tauri::Webview, db: State<'_, Arc<Database>>, auth: State<'_, AuthClient>, action_id: String,
) -> AppResult<Option<(String, String)>> {
    if webview.label() != "main" { return Err(AppError::Other("请在主窗口运行卡片".into())); }
    let user = auth.snapshot().user_id.ok_or_else(|| AppError::Other("请先登录".into()))?;
    auth.with_current_user(&user, || db.claim_chat_card_run(&action_id, &user))
}

#[tauri::command]
pub async fn local_chat_cards_undo(
    app: AppHandle,
    db: State<'_, Arc<Database>>,
    auth: State<'_, AuthClient>,
    entitlement: State<'_, EntitlementService>,
    conversation_id: String,
    action_id: String,
) -> AppResult<ChatConversation> {
    super::canvas_workflow::require_pro(&auth, &entitlement).await?;
    db.undo_local_chat_cards(&conversation_id, &action_id)?;
    publish(&app, &db, &conversation_id, &action_id, true);
    db.get_local_chat(&conversation_id)?
        .ok_or_else(|| AppError::Other("对话记录不存在".into()))
}
