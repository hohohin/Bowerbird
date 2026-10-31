//! Durable chat identity and public transcript. Provider sessions are opaque resume tokens.
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::{
    db::Database,
    error::{AppError, AppResult},
};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ChatProvider {
    #[default]
    CodexLocal,
    DeepseekCloud,
}
impl ChatProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CodexLocal => "codex-local",
            Self::DeepseekCloud => "deepseek-cloud",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatPlacement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub z_index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatSendInput {
    pub provider: Option<ChatProvider>,
    pub project_id: String,
    pub conversation_id: Option<String>,
    pub request_id: String,
    pub text: String,
    #[serde(default)]
    pub reference_asset_ids: Vec<String>,
    pub placement: Option<ChatPlacement>,
    pub card_defaults: Option<super::local_chat_cards::ChatCardDefaults>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub project_id: String,
    pub thread_id: String,
    pub node_id: String,
    pub title: String,
    pub provider: String,
    pub status: String,
    pub turn_count: i64,
    pub preview: String,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub turn_id: String,
    pub role: String,
    pub text: String,
    pub reference_asset_ids: Vec<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversation {
    #[serde(flatten)]
    pub summary: ChatSummary,
    pub messages: Vec<ChatMessage>,
    pub actions: Vec<super::local_chat_cards::ChatCardAction>,
}

pub struct StartedChat {
    pub conversation: ChatConversation,
    pub turn_id: String,
    pub is_new: bool,
}

fn error(text: &str) -> AppError {
    AppError::Other(text.into())
}
const SUMMARY_SQL: &str = "SELECT c.id,c.project_id,c.thread_id,c.node_id,c.title,c.provider,c.status,
 (SELECT COUNT(*) FROM local_chat_turns t WHERE t.conversation_id=c.id),
 COALESCE((SELECT substr(m.text,1,240) FROM local_chat_messages m WHERE m.conversation_id=c.id AND m.role='assistant' AND m.text<>'' ORDER BY m.created_at DESC,m.id DESC LIMIT 1),''),
 c.revision,c.created_at,c.updated_at,c.error FROM local_chat_conversations c";

fn summary(row: &Row<'_>) -> rusqlite::Result<ChatSummary> {
    Ok(ChatSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        thread_id: row.get(2)?,
        node_id: row.get(3)?,
        title: row.get(4)?,
        provider: row.get(5)?,
        status: row.get(6)?,
        turn_count: row.get(7)?,
        preview: row.get(8)?,
        revision: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        error: row.get(12)?,
    })
}

fn read(conn: &Connection, id: &str) -> AppResult<Option<ChatConversation>> {
    let Some(summary) = conn
        .query_row(&format!("{SUMMARY_SQL} WHERE c.id=?1"), [id], summary)
        .optional()?
    else {
        return Ok(None);
    };
    let mut statement = conn.prepare("SELECT id,turn_id,role,text,reference_asset_ids,status,created_at,updated_at FROM local_chat_messages WHERE conversation_id=?1 ORDER BY created_at,id")?;
    let messages = statement
        .query_map([id], |row| {
            let references: String = row.get(4)?;
            Ok(ChatMessage {
                id: row.get(0)?,
                turn_id: row.get(1)?,
                role: row.get(2)?,
                text: row.get(3)?,
                reference_asset_ids: serde_json::from_str(&references).unwrap_or_default(),
                status: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let actions = super::local_chat_cards::read_actions(conn, id)?;
    Ok(Some(ChatConversation {
        summary,
        messages,
        actions,
    }))
}

fn request_fingerprint(input: &ChatSendInput, provider: ChatProvider) -> AppResult<String> {
    // Placement belongs to the first projection, not the identity of a replayed send.
    let mut fingerprint =
        serde_json::json!({"text":input.text.trim(),"referenceAssetIds":input.reference_asset_ids});
    if let Some(defaults) = &input.card_defaults {
        fingerprint["cardDefaults"] = serde_json::to_value(defaults)?;
    }
    // Preserve pre-provider Codex request identities across the migration.
    if provider != ChatProvider::CodexLocal {
        fingerprint["provider"] = serde_json::json!(provider);
    }
    Ok(serde_json::to_string(&fingerprint)?)
}

fn provider_for(conn: &Connection, input: &ChatSendInput) -> AppResult<ChatProvider> {
    let Some(id) = &input.conversation_id else {
        return Ok(input.provider.unwrap_or_default());
    };
    let current = read(conn, id)?.ok_or_else(|| error("对话记录不存在"))?;
    if current.summary.project_id != input.project_id {
        return Err(error("该对话不属于当前项目"));
    }
    let provider = match current.summary.provider.as_str() {
        "codex-local" => ChatProvider::CodexLocal,
        "deepseek-cloud" => ChatProvider::DeepseekCloud,
        _ => return Err(error("对话服务无效，请新建对话")),
    };
    if input
        .provider
        .is_some_and(|requested| requested != provider)
    {
        return Err(error("此对话的服务已固定，请新建对话以切换服务"));
    }
    Ok(provider)
}

fn replay(conn: &Connection, input: &ChatSendInput) -> AppResult<Option<StartedChat>> {
    let previous: Option<(String, String, String)> = conn
        .query_row(
            "SELECT id,conversation_id,request_json FROM local_chat_turns WHERE request_id=?1",
            [&input.request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((turn_id, id, request)) = previous else {
        return Ok(None);
    };
    let conversation = read(conn, &id)?.ok_or_else(|| error("对话记录不存在"))?;
    if conversation.summary.project_id != input.project_id
        || input
            .conversation_id
            .as_ref()
            .is_some_and(|value| value != &id)
        || request != request_fingerprint(input, provider_for(conn, input)?)?
    {
        return Err(error("发送编号已用于其他内容，请保留草稿并重新发送"));
    }
    Ok(Some(StartedChat {
        conversation,
        turn_id,
        is_new: false,
    }))
}

impl Database {
    pub fn local_chat_provider(&self, input: &ChatSendInput) -> AppResult<ChatProvider> {
        provider_for(&self.conn.lock().unwrap(), input)
    }
    pub fn list_local_chats(&self, project: &str) -> AppResult<Vec<ChatSummary>> {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(&format!(
            "{SUMMARY_SQL} WHERE c.project_id=?1 ORDER BY c.updated_at DESC,c.id DESC"
        ))?;
        let result = statement
            .query_map([project], summary)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(result)
    }
    pub fn get_local_chat(&self, id: &str) -> AppResult<Option<ChatConversation>> {
        read(&self.conn.lock().unwrap(), id)
    }
    pub fn replay_local_chat(&self, input: &ChatSendInput) -> AppResult<Option<StartedChat>> {
        replay(&self.conn.lock().unwrap(), input)
    }

    pub fn begin_local_chat(&self, input: &ChatSendInput) -> AppResult<StartedChat> {
        if let Some(defaults) = &input.card_defaults {
            defaults.validate()?;
        }
        if input.project_id.trim().is_empty()
            || input.request_id.trim().is_empty()
            || input.request_id.len() > 200
            || input.text.trim().is_empty()
            || input.text.len() > 100_000
            || input.reference_asset_ids.len() > 8
        {
            return Err(error("请填写对话内容，每次最多引用 8 张图片"));
        }
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        if let Some(previous) = replay(&tx, input)? {
            return Ok(previous);
        }
        let provider = provider_for(&tx, input)?;
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM projects p JOIN project_canvases c ON p.id=c.project_id WHERE p.id=?1 AND p.archived_at IS NULL)",[&input.project_id],|row|row.get(0))?;
        if !exists {
            return Err(error("项目不存在或已归档，请重新打开项目"));
        }
        for asset in &input.reference_asset_ids {
            let exists: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
                [asset],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(error("引用图片已被删除，请重新选择图片"));
            }
        }
        let id = match &input.conversation_id {
            Some(id) => {
                let current = read(&tx, id)?.ok_or_else(|| error("对话记录不存在"))?;
                if current.summary.project_id != input.project_id {
                    return Err(error("该对话不属于当前项目"));
                }
                if matches!(current.summary.status.as_str(), "running" | "stopping") {
                    return Err(error("此对话仍在回复，请等待或停止当前回复"));
                }
                id.clone()
            }
            None => {
                let id = ulid::Ulid::new().to_string();
                let thread_id = format!("chat-thread-{id}");
                let node_id = format!("chat-node-{id}");
                let title: String = input.text.trim().chars().take(40).collect();
                let placement = input.placement.clone().unwrap_or(ChatPlacement {
                    x: 0.0,
                    y: 0.0,
                    width: 300.0,
                    height: 180.0,
                    z_index: 0,
                });
                if ![placement.x, placement.y, placement.width, placement.height]
                    .iter()
                    .all(|value| value.is_finite())
                    || placement.width <= 0.0
                    || placement.height <= 0.0
                {
                    return Err(error("对话卡片位置无效，请重新打开画板"));
                }
                tx.execute("INSERT INTO creative_threads(id,project_id,title,origin,created_at,updated_at) VALUES(?1,?2,?3,'direct',?4,?4)",params![thread_id,input.project_id,title,now/1000])?;
                let payload = serde_json::json!({"schema_version":1,"note_type":"chat","text":title,"conversation_id":id}).to_string();
                tx.execute("INSERT INTO canvas_nodes(id,project_id,thread_id,kind,payload_json,x,y,width,height,z_index,created_at,updated_at) VALUES(?1,?2,?3,'note',?4,?5,?6,?7,?8,?9,?10,?10)",params![node_id,input.project_id,thread_id,payload,placement.x,placement.y,placement.width,placement.height,placement.z_index,now/1000])?;
                tx.execute("INSERT INTO local_chat_conversations(id,project_id,thread_id,node_id,title,status,created_at,updated_at,provider) VALUES(?1,?2,?3,?4,?5,'idle',?6,?6,?7)",params![id,input.project_id,thread_id,node_id,title,now,provider.as_str()])?;
                id
            }
        };
        let turn_id = ulid::Ulid::new().to_string();
        tx.execute("INSERT INTO local_chat_turns(id,conversation_id,request_id,request_json,status,created_at,updated_at) VALUES(?1,?2,?3,?4,'running',?5,?5)",params![turn_id,id,input.request_id,request_fingerprint(input,provider)?,now])?;
        if let Some(defaults) = &input.card_defaults {
            tx.execute(
                "UPDATE local_chat_turns SET card_defaults_json=?2 WHERE id=?1",
                params![turn_id, serde_json::to_string(defaults)?],
            )?;
        }
        tx.execute("INSERT INTO local_chat_messages(id,conversation_id,turn_id,role,text,reference_asset_ids,status,created_at,updated_at) VALUES(?1,?2,?3,'user',?4,?5,'done',?6,?6)",params![format!("{turn_id}-0-user"),id,turn_id,input.text.trim(),serde_json::to_string(&input.reference_asset_ids)?,now])?;
        tx.execute("INSERT INTO local_chat_messages(id,conversation_id,turn_id,role,text,status,created_at,updated_at) VALUES(?1,?2,?3,'assistant','','running',?4,?4)",params![format!("{turn_id}-1-assistant"),id,turn_id,now])?;
        tx.execute("UPDATE local_chat_conversations SET status='running',error=NULL,revision=revision+1,updated_at=?2 WHERE id=?1",params![id,now])?;
        tx.execute("UPDATE canvas_nodes SET hidden_at=NULL WHERE id=(SELECT node_id FROM local_chat_conversations WHERE id=?1)",[&id])?;
        tx.execute(
            "UPDATE project_canvases SET updated_at=?2 WHERE project_id=?1",
            params![input.project_id, now / 1000],
        )?;
        let conversation = read(&tx, &id)?.unwrap();
        tx.commit()?;
        Ok(StartedChat {
            conversation,
            turn_id,
            is_new: true,
        })
    }

    pub fn local_chat_provider_thread(&self, id: &str) -> AppResult<Option<String>> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT provider_thread_id FROM local_chat_conversations WHERE id=?1",
            [id],
            |row| row.get(0),
        )?)
    }
    pub fn set_local_chat_provider_thread(&self, id: &str, provider_id: &str) -> AppResult<()> {
        self.conn.lock().unwrap().execute("UPDATE local_chat_conversations SET provider_thread_id=?2 WHERE id=?1 AND (provider_thread_id IS NULL OR provider_thread_id=?2)",params![id,provider_id])?;
        Ok(())
    }
    pub fn set_local_chat_provider_turn(&self, turn: &str, provider_id: &str) -> AppResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE local_chat_turns SET provider_turn_id=?2 WHERE id=?1",
            params![turn, provider_id],
        )?;
        Ok(())
    }
    pub fn local_chat_recovery(&self, id: &str) -> AppResult<(String, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT t.id,t.provider_turn_id FROM local_chat_turns t JOIN local_chat_conversations c ON c.id=t.conversation_id WHERE c.id=?1 AND c.provider='deepseek-cloud' AND c.status IN ('stopped','interrupted','failed') AND t.provider_turn_id IS NOT NULL ORDER BY t.created_at DESC,t.id DESC LIMIT 1",[id],|row| Ok((row.get(0)?,row.get(1)?)))
            .map_err(|_| error("此对话暂无可取回的 Cloud 任务"))
    }
    pub fn restore_local_chat_reply(
        &self,
        id: &str,
        turn: &str,
        checkpoint: &str,
        text: &str,
        complete: bool,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let latest: Option<String> = tx.query_row("SELECT id FROM local_chat_turns WHERE conversation_id=?1 ORDER BY created_at DESC,id DESC LIMIT 1",[id],|row|row.get(0)).optional()?;
        let status = if complete { "done" } else { "interrupted" };
        if latest.as_deref()!=Some(turn) || tx.execute("UPDATE local_chat_turns SET status=?4 WHERE id=?2 AND conversation_id=?1 AND provider_turn_id=?3 AND status IN ('stopped','interrupted','failed')",params![id,turn,checkpoint,status])? != 1 {
            return Err(error("对话已有新进展，请重新打开对话后查看"));
        }
        let now = Utc::now().timestamp_millis();
        tx.execute("UPDATE local_chat_messages SET text=?3,status=?4,updated_at=?5 WHERE conversation_id=?1 AND turn_id=?2 AND role='assistant'",params![id,turn,text,status,now])?;
        tx.execute("UPDATE local_chat_conversations SET status=?2,error=NULL,revision=revision+1,updated_at=?3 WHERE id=?1",params![id,if complete {"idle"} else {"interrupted"},now])?;
        tx.commit()?;
        Ok(())
    }
    pub fn update_local_chat_text(&self, id: &str, turn: &str, text: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let changed = tx.execute("UPDATE local_chat_messages SET text=?3,updated_at=?4 WHERE conversation_id=?1 AND turn_id=?2 AND role='assistant' AND status='running'",params![id,turn,text,Utc::now().timestamp_millis()])?;
        if changed > 0 {
            tx.execute(
                "UPDATE local_chat_conversations SET revision=revision+1 WHERE id=?1",
                [id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn finish_local_chat(
        &self,
        id: &str,
        turn: &str,
        status: &str,
        detail: Option<&str>,
    ) -> AppResult<()> {
        if !matches!(status, "done" | "stopped" | "interrupted" | "failed") {
            return Err(error("对话状态无效"));
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let now = Utc::now().timestamp_millis();
        let changed = tx.execute("UPDATE local_chat_turns SET status=?3,updated_at=?4 WHERE id=?2 AND conversation_id=?1 AND status IN ('running','stopping')",params![id,turn,status,now])?;
        if changed > 0 {
            tx.execute("UPDATE local_chat_messages SET status=?3,updated_at=?4 WHERE conversation_id=?1 AND turn_id=?2 AND status='running'",params![id,turn,status,now])?;
            tx.execute("UPDATE local_chat_conversations SET status=?2,error=?3,updated_at=?4,revision=revision+1 WHERE id=?1",params![id,if status=="done" { "idle" } else { status },detail,now])?;
            tx.execute("UPDATE creative_threads SET updated_at=?2 WHERE id=(SELECT thread_id FROM local_chat_conversations WHERE id=?1)",params![id,now/1000])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn mark_local_chat_stopping(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("UPDATE local_chat_turns SET status='stopping' WHERE conversation_id=?1 AND status='running'",[id])?;
        tx.execute("UPDATE local_chat_conversations SET status='stopping',revision=revision+1 WHERE id=?1 AND status='running'",[id])?;
        tx.commit()?;
        Ok(())
    }
    /// Startup only: reading history never resumes or repeats a model request.
    pub fn recover_local_chats(&self) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE local_chat_messages SET status='interrupted' WHERE status='running'",
            [],
        )?;
        tx.execute("UPDATE local_chat_turns SET status='interrupted' WHERE status IN ('running','stopping')",[])?;
        tx.execute("UPDATE local_chat_conversations SET status='interrupted',error='应用上次关闭时回复尚未结束，已保留收到的内容；可以继续发送新消息。',revision=revision+1 WHERE status IN ('running','stopping')",[])?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "local_chat_tests.rs"]
mod tests;
