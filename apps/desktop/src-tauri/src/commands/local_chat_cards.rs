use crate::{
    cloud::{AuthClient, EntitlementService},
    core::{local_chat::ChatConversation, local_chat_cards::ChatCardAction},
    db::Database,
    error::{AppError, AppResult},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

fn publish(app: &AppHandle, db: &Database, conversation: &str, action: &str) {
    if let Ok(Some(chat)) = db.get_local_chat(conversation) {
        let _=app.emit("local-chat://cards-changed",serde_json::json!({"projectId":chat.summary.project_id,"conversationId":conversation,"actionId":action}));
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
    if let Some(action) =
        db.replay_local_chat_card_action(conversation_id, turn_id, call_id, args)?
    {
        return Ok(action);
    }
    super::canvas_workflow::require_pro(auth, entitlement).await?;
    let action = db.create_local_chat_cards(conversation_id, turn_id, call_id, args)?;
    publish(app, db, conversation_id, &action.id);
    Ok(action)
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
    publish(&app, &db, &conversation_id, &action_id);
    db.get_local_chat(&conversation_id)?
        .ok_or_else(|| AppError::Other("对话记录不存在".into()))
}
