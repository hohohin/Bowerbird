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
    DshLocal,
    #[serde(alias = "deepseek-cloud")]
    DshCloud,
}
impl ChatProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CodexLocal => "codex-local",
            Self::DshLocal => "dsh-local",
            Self::DshCloud => "dsh-cloud",
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
pub struct ChatCodexOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}
impl ChatCodexOptions {
    fn validate(&self) -> AppResult<()> {
        for value in [&self.model, &self.reasoning_effort].into_iter().flatten() {
            if value.is_empty() || value.len() > 200 || value.trim() != value || value.chars().any(char::is_control) {
                return Err(error("Codex 模型或推理强度无效，请重新选择"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatH3Parameters {
    pub mode: String,
    pub seconds: f64,
    pub ratio: String,
    pub first_frame_count: u8,
    pub last_frame_count: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "id", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ChatDshSkill {
    TextEditor {},
    H3VideoPrompt { parameters: ChatH3Parameters },
}
impl ChatDshSkill {
    pub fn validate(&self) -> AppResult<()> {
        if let Self::H3VideoPrompt { parameters: p } = self {
            if !p.seconds.is_finite() || p.seconds <= 0.0 || p.seconds > 120.0
                || !matches!(p.ratio.as_str(), "9:16"|"16:9"|"4:3"|"3:4"|"1:1"|"auto")
                || !matches!((p.mode.as_str(),p.first_frame_count,p.last_frame_count),
                    ("text",0,0)|("reference",1,0)|("frames",1,0|1)) {
                return Err(error("H3 视频提示词参数无效，请重新设置"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatSendInput {
    pub provider: Option<ChatProvider>,
    pub codex_options: Option<ChatCodexOptions>,
    pub dsh_skill: Option<ChatDshSkill>,
    pub project_id: String,
    pub conversation_id: Option<String>,
    /// Attach the shared conversation to an existing workflow Agent card.
    pub agent_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual_card_run: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_options: Option<ChatCodexOptions>,
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
    /// First server-memory turn following a local-only transcript (display only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vps_history_start_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitted_turn_id: Option<String>,
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
 c.revision,c.created_at,c.updated_at,c.error,
 COALESCE((SELECT json_extract(t.request_json,'$.resolvedCodexOptions') FROM local_chat_turns t WHERE t.conversation_id=c.id ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1),
          (SELECT json_extract(n.payload_json,'$.initialCodexOptions') FROM canvas_nodes n WHERE n.id=c.node_id))
 FROM local_chat_conversations c";

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
        codex_options: row.get::<_, Option<String>>(13)?.and_then(|value| serde_json::from_str(&value).ok()),
    })
}

fn read(conn: &Connection, id: &str) -> AppResult<Option<ChatConversation>> {
    let Some(summary) = conn
        .query_row(&format!("{SUMMARY_SQL} WHERE c.id=?1"), [id], summary)
        .optional()?
    else {
        return Ok(None);
    };
    let mut statement = conn.prepare("SELECT m.id,m.turn_id,m.role,m.text,m.reference_asset_ids,m.status,m.created_at,m.updated_at
        FROM local_chat_messages m JOIN local_chat_turns t ON t.id=m.turn_id WHERE m.conversation_id=?1
        ORDER BY t.created_at,t.rowid,m.created_at,m.id")?;
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
    let vps_history_start_turn_id = if summary.provider == "dsh-cloud" && summary.turn_count > 1 {
        conn.query_row("WITH turns AS (
            SELECT id,rowid AS seq,COALESCE(CASE WHEN json_valid(provider_turn_id) THEN json_extract(provider_turn_id,'$.engine') END,'') AS engine,
              (json_extract(request_json,'$.agentNodeId') IS NULL OR json_extract(request_json,'$.manualCardRun') IS 1) AS interactive
            FROM local_chat_turns WHERE conversation_id=?1
        ), first_v2 AS (SELECT id,seq FROM turns WHERE interactive AND engine='dsh-vps-v2' ORDER BY seq LIMIT 1)
        SELECT id FROM first_v2 WHERE EXISTS (SELECT 1 FROM turns WHERE turns.seq<first_v2.seq AND turns.engine<>'dsh-vps-v2')",
            [id], |row| row.get(0)).optional()?
    } else { None };
    Ok(Some(ChatConversation {
        summary,
        messages,
        actions,
        vps_history_start_turn_id,
        submitted_turn_id: None,
    }))
}

/// A chat and a workflow Agent share one canvas identity and one conversation.
/// Keep the existing note row as the history foreign key; the workflow card is its projection.
fn project_agent_card(conn: &Connection, chat: &ChatConversation, input: &ChatSendInput) -> AppResult<()> {
    let previous: Option<(i64, String)> = conn.query_row(
        "SELECT revision,document_json FROM canvas_workflows WHERE project_id=?1",
        [&input.project_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let (revision, mut document) = match previous {
        Some((revision, text)) => (revision, serde_json::from_str::<serde_json::Value>(&text)?),
        None => (0, serde_json::json!({"schema_version":1,"nodes":[],"run":null})),
    };
    let nodes = document["nodes"].as_array_mut().ok_or_else(|| error("工作流数据无效"))?;
    let id = &chat.summary.node_id;
    if !nodes.iter().any(|node| node["id"] == *id) {
        let (x, y, width, height): (f64, f64, f64, f64) = conn.query_row(
            "SELECT x,y,width,height FROM canvas_nodes WHERE id=?1 AND project_id=?2", params![id,input.project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        nodes.push(serde_json::json!({"id":id,"kind":"agent","x":x,"y":y,"layoutSize":{"width":width,"height":height},
            "action":"describe","skill":"image-edit","prompt":input.text,"ratio":null,
            "provider":input.card_defaults.as_ref().map(|d| d.provider.as_str()).unwrap_or("codex"),
            "inputs":{"image":input.reference_asset_ids.iter().map(|id|serde_json::json!({"assetId":id})).collect::<Vec<_>>()},
            "outputs":{},"outputPorts":[],"trigger":false}));
    }
    let node = nodes.iter_mut().find(|node| node["id"] == *id).unwrap();
    if node["kind"] != "agent" || node["chatConversationId"].as_str().is_some_and(|value| value != chat.summary.id) {
        return Err(error("Agent 卡片与对话身份不匹配"));
    }
    let before = node.clone();
    if node["chatConversationId"].is_null() {
        if let Some(skill) = &input.dsh_skill { node["chatDshSkill"] = serde_json::to_value(skill)?; }
    }
    node["chatConversationId"] = serde_json::json!(chat.summary.id);
    node["chatProvider"] = serde_json::json!(chat.summary.provider);
    if let Some(options) = &chat.summary.codex_options { node["chatCodexOptions"] = serde_json::to_value(options)?; }
    if *node != before {
        conn.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES(?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json",
            params![input.project_id,revision+1,document.to_string()])?;
    }
    Ok(())
}

fn project_agent_result(conn: &Connection, id: &str, turn: &str) -> AppResult<()> {
    let latest: String = conn.query_row("SELECT id FROM local_chat_turns WHERE conversation_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1", [id], |row| row.get(0))?;
    if latest != turn { return Ok(()); }
    let chat = read(conn, id)?.ok_or_else(|| error("对话记录不存在"))?;
    let previous: Option<(i64, String)> = conn.query_row("SELECT revision,document_json FROM canvas_workflows WHERE project_id=?1", [&chat.summary.project_id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
    let Some((revision, source)) = previous else { return Ok(()); };
    let mut document: serde_json::Value = serde_json::from_str(&source)?;
    let Some(node) = document["nodes"].as_array_mut().and_then(|nodes| nodes.iter_mut().find(|node| node["id"] == chat.summary.node_id && node["chatConversationId"] == id)) else { return Ok(()); };
    let text = chat.messages.iter().filter(|m| m.turn_id == turn && m.role == "assistant" && m.status == "done").map(|m|m.text.as_str()).collect::<Vec<_>>().join("\n\n");
    let assets = chat.messages.iter().filter(|m| m.turn_id == turn && m.role == "tool" && m.status == "done").flat_map(|m|m.reference_asset_ids.clone()).collect::<Vec<_>>();
    let mut outputs = serde_json::json!({});
    if !text.trim().is_empty() { outputs["text"] = serde_json::json!({"type":"text","text":text}); }
    if !assets.is_empty() { outputs["image"] = serde_json::json!({"type":"image","assetIds":assets}); }
    node["outputs"] = outputs;
    conn.execute("UPDATE canvas_workflows SET revision=?2,document_json=?3 WHERE project_id=?1", params![chat.summary.project_id,revision+1,document.to_string()])?;
    Ok(())
}

fn request_fingerprint(input: &ChatSendInput, provider: ChatProvider) -> AppResult<String> {
    // Placement belongs to the first projection, not the identity of a replayed send.
    let mut fingerprint =
        serde_json::json!({"text":input.text.trim(),"referenceAssetIds":input.reference_asset_ids});
    if let Some(defaults) = &input.card_defaults {
        fingerprint["cardDefaults"] = serde_json::to_value(defaults)?;
    }
    if let Some(options) = &input.codex_options {
        fingerprint["codexOptions"] = serde_json::to_value(options)?;
    }
    if let Some(id) = &input.agent_node_id {
        fingerprint["agentNodeId"] = serde_json::json!(id);
    }
    if input.manual_card_run {
        if input.agent_node_id.is_none() { return Err(error("手动运行缺少 Agent 卡片身份")); }
        fingerprint["manualCardRun"] = serde_json::json!(true);
    }
    if let Some(skill) = &input.dsh_skill {
        fingerprint["dshSkill"] = serde_json::to_value(skill)?;
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
        "dsh-local" => ChatProvider::DshLocal,
        "dsh-cloud" => ChatProvider::DshCloud,
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
    let mut original: serde_json::Value = serde_json::from_str(&request)?;
    if let Some(object) = original.as_object_mut() { object.remove("resolvedCodexOptions"); }
    if original["provider"] == "deepseek-cloud" {
        original["provider"] = serde_json::json!(ChatProvider::DshCloud);
    }
    if conversation.summary.project_id != input.project_id
        || input
            .conversation_id
            .as_ref()
            .is_some_and(|value| value != &id)
        || original != serde_json::from_str::<serde_json::Value>(&request_fingerprint(input, provider_for(conn, input)?)?)?
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
    pub fn local_chat_by_request(&self, request_id: &str) -> AppResult<Option<ChatConversation>> {
        let conn = self.conn.lock().unwrap();
        let identity: Option<(String, String)> = conn.query_row(
            "SELECT conversation_id,id FROM local_chat_turns WHERE request_id=?1",
            [request_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((id, turn)) = identity else { return Ok(None); };
        let mut chat = read(&conn, &id)?.ok_or_else(|| error("对话记录不存在"))?;
        chat.submitted_turn_id = Some(turn);
        Ok(Some(chat))
    }
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

    /// Keep the public workflow node and all its connections. The old conversation's private
    /// note remains available for history, provider recovery, and independent continuations.
    pub fn new_agent_chat(&self, project: &str, node_id: &str, previous_id: &str, target: Option<ChatProvider>, options: Option<ChatCodexOptions>) -> AppResult<ChatConversation> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let source: String = tx.query_row(
            "SELECT w.document_json FROM canvas_workflows w JOIN projects p ON p.id=w.project_id WHERE w.project_id=?1 AND p.archived_at IS NULL",
            [project], |row| row.get(0),
        ).optional()?.ok_or_else(|| error("请重新打开卡片所属的项目"))?;
        let mut document: serde_json::Value = serde_json::from_str(&source)?;
        let runs = document["runs"].as_array().into_iter().flatten().chain(std::iter::once(&document["run"]));
        if runs.filter(|run| matches!(run["status"].as_str(), Some("running" | "waiting")))
            .any(|run| run.get("lockedNodeIds").unwrap_or(&run["order"]).as_array().is_some_and(|ids| ids.iter().any(|id| id == node_id))) {
            return Err(error("此卡片关联的工作流正在运行，请先停止对应流程"));
        }
        let node = document["nodes"].as_array_mut().and_then(|nodes| nodes.iter_mut().find(|n| n["kind"] == "agent" && n["id"] == node_id))
            .ok_or_else(|| error("Agent 卡片已不存在"))?;
        if node["chatConversationId"] != previous_id { return Err(error("卡片的对话已切换，请重新打开卡片")); }
        let previous = tx.query_row(&format!("{SUMMARY_SQL} WHERE c.id=?1 AND c.node_id=?2 AND c.project_id=?3"),
            params![previous_id,node_id,project], summary).optional()?.ok_or_else(|| error("对话与 Agent 卡片不匹配"))?;
        if matches!(previous.status.as_str(), "running" | "stopping") { return Err(error("请等待当前回复完成，或先停止回复")); }
        let provider = target.map(ChatProvider::as_str).unwrap_or(&previous.provider);
        let switching = provider != previous.provider;
        if previous.turn_count == 0 && !switching { return Ok(read(&tx, previous_id)?.unwrap()); }
        let options = if provider == ChatProvider::CodexLocal.as_str() {
            options.or_else(|| if switching { None } else { previous.codex_options })
        } else {
            if !switching && options.is_some() { return Err(error("此对话服务不支持 Codex 模型设置")); }
            None
        };
        if let Some(options) = &options { options.validate()?; }
        let now = Utc::now().timestamp_millis();
        let (id, thread) = if previous.turn_count == 0 {
            tx.execute("UPDATE local_chat_conversations SET provider=?2,updated_at=?3,revision=revision+1 WHERE id=?1",
                params![previous_id,provider,now])?;
            (previous.id, previous.thread_id)
        } else {
            let id = ulid::Ulid::new().to_string();
            let thread = format!("chat-thread-{id}");
            let history_node = format!("chat-history-{id}");
            tx.execute("INSERT INTO canvas_nodes(id,project_id,thread_id,kind,payload_json,x,y,width,height,z_index,created_at,updated_at,hidden_at)
                SELECT ?2,project_id,thread_id,kind,payload_json,x,y,width,height,z_index,created_at,updated_at,?3 FROM canvas_nodes WHERE id=?1",
                params![node_id,history_node,now/1000])?;
            tx.execute("UPDATE local_chat_conversations SET node_id=?2,revision=revision+1 WHERE id=?1", params![previous_id,history_node])?;
            tx.execute("INSERT INTO creative_threads(id,project_id,title,origin,created_at,updated_at) VALUES(?1,?2,'新对话','direct',?3,?3)",
                params![thread,project,now/1000])?;
            tx.execute("INSERT INTO local_chat_conversations(id,project_id,thread_id,node_id,title,status,provider,created_at,updated_at) VALUES(?1,?2,?3,?4,'新对话','idle',?5,?6,?6)",
                params![id,project,thread,node_id,provider,now])?;
            (id, thread)
        };
        let payload = serde_json::json!({"schema_version":1,"note_type":"chat","conversation_id":id,"text":"新对话","initialCodexOptions":options});
        tx.execute("UPDATE canvas_nodes SET thread_id=?2,payload_json=?3,updated_at=?4 WHERE id=?1",
            params![node_id,thread,payload.to_string(),now/1000])?;
        node["chatConversationId"] = serde_json::json!(id);
        node["chatProvider"] = serde_json::json!(provider);
        let fields = node.as_object_mut().unwrap();
        if switching || provider != ChatProvider::DshCloud.as_str() { fields.remove("chatDshSkill"); }
        if let Some(options) = options { fields.insert("chatCodexOptions".into(), serde_json::to_value(options)?); }
        else { fields.remove("chatCodexOptions"); }
        tx.execute("UPDATE canvas_workflows SET revision=revision+1,document_json=?2 WHERE project_id=?1", params![project,document.to_string()])?;
        tx.execute("UPDATE project_canvases SET updated_at=?2 WHERE project_id=?1", params![project,now/1000])?;
        let fresh = read(&tx, &id)?.unwrap();
        tx.commit()?;
        Ok(fresh)
    }
    pub fn replay_local_chat(&self, input: &ChatSendInput) -> AppResult<Option<StartedChat>> {
        replay(&self.conn.lock().unwrap(), input)
    }

    pub fn begin_local_chat(&self, input: &ChatSendInput) -> AppResult<StartedChat> {
        if let Some(options) = &input.codex_options { options.validate()?; }
        if let Some(defaults) = &input.card_defaults {
            defaults.validate()?;
        }
        if input.project_id.trim().is_empty()
            || input.request_id.trim().is_empty()
            || input.request_id.len() > 200
            || input.text.trim().is_empty()
            || input.reference_asset_ids.len() > 8
        {
            return Err(error("请填写对话内容，每次最多引用 8 个素材"));
        }
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        if let Some(previous) = replay(&tx, input)? {
            return Ok(previous);
        }
        let provider = provider_for(&tx, input)?;
        if let Some(skill) = &input.dsh_skill {
            if provider != ChatProvider::DshCloud { return Err(error("此技能需要 DSH · Cloud")); }
            skill.validate()?;
        }
        if provider != ChatProvider::CodexLocal && input.codex_options.is_some() {
            return Err(error("该对话服务不支持 Codex 模型与推理强度，请移除这些设置"));
        }
        let options = if let Some(options) = &input.codex_options { Some(options.clone()) }
            else if let Some(id) = &input.conversation_id { read(&tx, id)?.and_then(|chat|chat.summary.codex_options) }
            else { None };
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
                return Err(error("引用素材已被删除，请重新选择"));
            }
        }
        let id = match &input.conversation_id {
            Some(id) => {
                let current = read(&tx, id)?.ok_or_else(|| error("对话记录不存在"))?;
                if current.summary.project_id != input.project_id {
                    return Err(error("该对话不属于当前项目"));
                }
                if input.agent_node_id.as_ref().is_some_and(|node| node != &current.summary.node_id) {
                    return Err(error("对话与 Agent 卡片不匹配"));
                }
                if matches!(current.summary.status.as_str(), "running" | "stopping") {
                    return Err(error("此对话仍在回复，请等待或停止当前回复"));
                }
                if current.summary.turn_count == 0 {
                    let title: String = input.text.trim().chars().take(40).collect();
                    tx.execute("UPDATE local_chat_conversations SET title=?2 WHERE id=?1", params![id,title])?;
                    tx.execute("UPDATE creative_threads SET title=?2 WHERE id=?1", params![current.summary.thread_id,title])?;
                    tx.execute("UPDATE canvas_nodes SET payload_json=json_remove(json_set(payload_json,'$.text',?2),'$.initialCodexOptions') WHERE id=?1", params![current.summary.node_id,title])?;
                }
                id.clone()
            }
            None => {
                let id = ulid::Ulid::new().to_string();
                let thread_id = format!("chat-thread-{id}");
                let node_id = input.agent_node_id.clone().unwrap_or_else(|| format!("chat-node-{id}"));
                if input.agent_node_id.is_some() {
                    let document: Option<String> = tx.query_row("SELECT document_json FROM canvas_workflows WHERE project_id=?1", [&input.project_id], |row| row.get(0)).optional()?;
                    let document: serde_json::Value = serde_json::from_str(&document.ok_or_else(|| error("Agent 卡片已不存在"))?)?;
                    let node = document["nodes"].as_array().and_then(|nodes| nodes.iter().find(|node| node["id"] == node_id && node["kind"] == "agent"))
                        .ok_or_else(|| error("Agent 卡片已不存在"))?;
                    if node["chatConversationId"].as_str().is_some() { return Err(error("Agent 已有关联对话，请重新读取卡片")); }
                }
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
        let mut request: serde_json::Value = serde_json::from_str(&request_fingerprint(input,provider)?)?;
        if let Some(options) = &options { request["resolvedCodexOptions"] = serde_json::to_value(options)?; }
        tx.execute("INSERT INTO local_chat_turns(id,conversation_id,request_id,request_json,status,created_at,updated_at) VALUES(?1,?2,?3,?4,'running',?5,?5)",params![turn_id,id,input.request_id,request.to_string(),now])?;
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
        let mut conversation = read(&tx, &id)?.unwrap();
        project_agent_card(&tx, &conversation, input)?;
        conversation.submitted_turn_id = Some(turn_id.clone());
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
    pub fn local_chat_turn_options(&self, turn: &str) -> AppResult<Option<ChatCodexOptions>> {
        let raw: Option<String> = self.conn.lock().unwrap().query_row(
            "SELECT json_extract(request_json,'$.resolvedCodexOptions') FROM local_chat_turns WHERE id=?1", [turn], |row|row.get(0))?;
        raw.map(|value|serde_json::from_str(&value).map_err(Into::into)).transpose()
    }
    /// Unmarked card requests, including older saved workflow requests, use only the current input.
    pub fn local_chat_turn_uses_history(&self, turn: &str) -> AppResult<bool> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT json_extract(request_json,'$.agentNodeId') IS NULL OR json_extract(request_json,'$.manualCardRun') IS 1
             FROM local_chat_turns WHERE id=?1", [turn], |row|row.get(0))?)
    }
    pub fn vps_chat_turn_message(&self, conversation: &str, turn: &str) -> AppResult<(String,usize)> {
        self.conn.lock().unwrap().query_row("SELECT m.text,json_array_length(m.reference_asset_ids)
            FROM local_chat_messages m JOIN local_chat_conversations c ON c.id=m.conversation_id
            WHERE c.id=?1 AND c.provider='dsh-cloud' AND m.turn_id=?2 AND m.role='user'",
            params![conversation,turn], |row| Ok((row.get(0)?,row.get(1)?)))
            .optional()?.ok_or_else(|| error("云端对话轮次不存在"))
    }
    pub fn set_local_chat_provider_thread(&self, id: &str, provider_id: &str) -> AppResult<()> {
        self.conn.lock().unwrap().execute("UPDATE local_chat_conversations SET provider_thread_id=?2 WHERE id=?1 AND (provider_thread_id IS NULL OR provider_thread_id=?2)",params![id,provider_id])?;
        Ok(())
    }
    pub fn clear_local_chat_provider_thread(&self, id: &str) -> AppResult<()> {
        self.conn.lock().unwrap().execute("UPDATE local_chat_conversations SET provider_thread_id=NULL WHERE id=?1", [id])?;
        Ok(())
    }
    pub fn set_local_chat_provider_turn(&self, turn: &str, provider_id: &str) -> AppResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE local_chat_turns SET provider_turn_id=?2 WHERE id=?1",
            params![turn, provider_id],
        )?;
        Ok(())
    }
    pub fn save_vps_chat_checkpoint(&self, turn: &str, checkpoint: &str) -> AppResult<()> {
        let changed = self.conn.lock().unwrap().execute("UPDATE local_chat_turns SET provider_turn_id=
            CASE WHEN status='stopping' THEN json_set(?2,'$.cancel_requested',json('true')) ELSE ?2 END
            WHERE id=?1 AND status IN ('running','stopping')",params![turn,checkpoint])?;
        if changed != 1 { return Err(error("原云端 DSH 轮次已结束")); }
        Ok(())
    }
    pub fn local_chat_recovery(&self, id: &str) -> AppResult<(String, String)> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT t.id,t.provider_turn_id FROM local_chat_turns t JOIN local_chat_conversations c ON c.id=t.conversation_id WHERE c.id=?1 AND c.provider IN ('deepseek-cloud','dsh-local','dsh-cloud') AND c.status IN ('stopped','interrupted','failed') ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1",[id],|row| Ok((row.get(0)?,row.get(1)?)))
            .map_err(|_| error("此对话暂无可取回的任务"))
    }
    pub fn local_chat_turn_has_dsh_skill(&self, turn: &str) -> AppResult<bool> {
        Ok(self.conn.lock().unwrap().query_row("SELECT json_type(request_json,'$.dshSkill')='object' FROM local_chat_turns WHERE id=?1",
            [turn], |row| Ok(row.get::<_, Option<bool>>(0)?.unwrap_or(false)))?)
    }
    /// Reattach the original VPS job to its latest turn for polling and receipt replay.
    pub fn resume_vps_chat(&self, id: &str, turn: &str, checkpoint: &str) -> AppResult<ChatConversation> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let changed = tx.execute("UPDATE local_chat_turns SET status='running' WHERE id=?2 AND conversation_id=?1 AND provider_turn_id=?3
            AND status IN ('interrupted','failed','stopped') AND ?2=(SELECT id FROM local_chat_turns WHERE conversation_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1)
            AND EXISTS(SELECT 1 FROM local_chat_conversations WHERE id=?1 AND provider='dsh-cloud' AND status IN ('interrupted','failed','stopped'))",
            params![id,turn,checkpoint])?;
        if changed != 1 { return Err(error("对话已有新进展，请重新打开查看")); }
        tx.execute("UPDATE local_chat_messages SET status='running' WHERE conversation_id=?1 AND turn_id=?2 AND role='assistant'",params![id,turn])?;
        tx.execute("UPDATE local_chat_conversations SET status='running',error=NULL,revision=revision+1 WHERE id=?1",[id])?;
        let chat = read(&tx, id)?.ok_or_else(|| error("对话记录不存在"))?;
        tx.commit()?;
        Ok(chat)
    }
    pub fn record_local_chat_recovery_error(&self, id: &str, turn: &str, checkpoint: &str, detail: &str) -> AppResult<()> {
        let changed = self.conn.lock().unwrap().execute(
            "UPDATE local_chat_conversations SET error=?4,revision=revision+1,updated_at=?5
             WHERE id=?1 AND status IN ('stopped','interrupted','failed')
             AND ?2=(SELECT id FROM local_chat_turns WHERE conversation_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT 1)
             AND EXISTS(SELECT 1 FROM local_chat_turns WHERE id=?2 AND provider_turn_id=?3)",
            params![id, turn, checkpoint, detail, Utc::now().timestamp_millis()],
        )?;
        if changed == 0 { return Err(error("对话已有新进展，请重新打开对话后查看")); }
        Ok(())
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
        if complete { project_agent_result(&tx, id, turn)?; }
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
    /// Native video progress and delivery; model text never supplies attachment IDs.
    pub fn save_local_chat_video(&self, id: &str, turn: &str, text: &str, status: &str, assets: &[String]) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let active: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM local_chat_turns t JOIN local_chat_conversations c ON c.id=t.conversation_id WHERE t.id=?2 AND c.id=?1 AND c.provider='codex-local' AND t.status='running')", params![id,turn], |row| row.get(0))?;
        if !active || !matches!(status, "running" | "done" | "failed") { return Err(error("视频请求不属于当前运行中的对话")); }
        let now = Utc::now().timestamp_millis();
        tx.execute("INSERT INTO local_chat_messages(id,conversation_id,turn_id,role,text,reference_asset_ids,status,created_at,updated_at) VALUES(?1,?2,?3,'tool',?4,?5,?6,?7,?7) ON CONFLICT(id) DO UPDATE SET text=excluded.text,reference_asset_ids=excluded.reference_asset_ids,status=excluded.status,updated_at=excluded.updated_at", params![format!("{turn}-video"),id,turn,text,serde_json::to_string(assets)?,status,now])?;
        tx.execute("UPDATE local_chat_conversations SET revision=revision+1 WHERE id=?1",[id])?;
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
            // A completed model reply does not mean an unfinished render delivered a video.
            if status == "done" {
                tx.execute("UPDATE local_chat_messages SET status='interrupted',text='视频尚未交付，可以继续对话完成。' WHERE conversation_id=?1 AND turn_id=?2 AND id=?3 AND status='running'", params![id,turn,format!("{turn}-video")])?;
            }
            tx.execute("UPDATE local_chat_messages SET status=?3,updated_at=?4 WHERE conversation_id=?1 AND turn_id=?2 AND status='running'",params![id,turn,status,now])?;
            tx.execute("UPDATE local_chat_conversations SET status=?2,error=?3,updated_at=?4,revision=revision+1 WHERE id=?1",params![id,if status=="done" { "idle" } else { status },detail,now])?;
            tx.execute("UPDATE creative_threads SET updated_at=?2 WHERE id=(SELECT thread_id FROM local_chat_conversations WHERE id=?1)",params![id,now/1000])?;
            if status == "done" { project_agent_result(&tx, id, turn)?; }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn mark_local_chat_stopping(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("UPDATE local_chat_turns SET provider_turn_id=json_set(provider_turn_id,'$.cancel_requested',json('true'))
            WHERE conversation_id=?1 AND status='running' AND CASE WHEN json_valid(provider_turn_id) THEN json_extract(provider_turn_id,'$.engine') IN ('dsh-vps-v1','dsh-vps-v2') ELSE 0 END",[id])?;
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
