//! Narrow chat-to-canvas compiler. Model arguments never contain storage IDs or execution state.
use crate::{
    db::Database,
    error::{AppError, AppResult},
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

fn error(message: &str) -> AppError {
    AppError::Other(message.into())
}
fn invalid() -> AppError {
    error("卡片参数无效，请调整内容后重试；本次未创建卡片")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatCardDefaults {
    pub provider: String,
    pub video_channel: String,
    pub video_options: VideoDefaults,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VideoDefaults {
    pub kind: String,
    pub model_version: String,
    pub duration: u32,
    pub video_resolution: String,
}
impl Default for ChatCardDefaults {
    fn default() -> Self {
        Self {
            provider: "codex".into(),
            video_channel: "jimeng".into(),
            video_options: VideoDefaults {
                kind: "text2video".into(),
                model_version: "seedance2.5".into(),
                duration: 5,
                video_resolution: "720p".into(),
            },
        }
    }
}
impl ChatCardDefaults {
    pub fn validate(&self) -> AppResult<()> {
        if !(matches!(self.provider.as_str(), "codex" | "jimeng")
            || self.provider.starts_with("bowerbird-cloud-image_"))
            || self.provider.len() > 100
            || !self
                .provider
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || !matches!(self.video_channel.as_str(), "jimeng" | "cloud")
            || !matches!(
                self.video_options.kind.as_str(),
                "text2video" | "image2video" | "frames2video" | "multimodal2video"
            )
            || !matches!(
                self.video_options.model_version.as_str(),
                "seedance2.5"
                    | "seedance2.0"
                    | "seedance2.0mini"
                    | "seedance2.0fast"
                    | "seedance2.0_vip"
                    | "seedance2.0fast_vip"
                    | "seedance1.5pro"
                    | "seedance1.0fast"
            )
            || !(4..=30).contains(&self.video_options.duration)
            || !matches!(
                self.video_options.video_resolution.as_str(),
                "480p" | "720p" | "1080p" | "4k"
            )
        {
            return Err(error("当前卡片生成选项无效，请重新选择生成选项"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedChatCard {
    pub alias: String,
    pub id: String,
    pub kind: String,
    pub title: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCardAction {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub status: String,
    pub cards: Vec<CreatedChatCard>,
    pub created_at: i64,
    pub undone_at: Option<i64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CardBatch {
    cards: Vec<CardSpec>,
    #[serde(default)]
    connections: Vec<ConnectionSpec>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum CardSpec {
    Generation {
        id: String,
        title: String,
        prompt: String,
        #[serde(rename = "mediaType")]
        media_type: String,
        ratio: Option<String>,
        #[serde(default, rename = "referenceAliases")]
        reference_aliases: Vec<String>,
    },
    Content {
        id: String,
        title: String,
        text: Option<String>,
        rows: Option<Vec<Vec<String>>>,
    },
    Trigger {
        id: String,
        title: String,
        count: Option<u32>,
    },
    Loop {
        id: String,
        title: String,
        mode: String,
        count: Option<u32>,
        source: Option<String>,
        body: Vec<String>,
    },
}
impl CardSpec {
    fn identity(&self) -> (&str, &str, &str) {
        match self {
            Self::Generation { id, title, .. } => (id, title, "generation"),
            Self::Content { id, title, .. } => (id, title, "content"),
            Self::Trigger { id, title, .. } => (id, title, "trigger"),
            Self::Loop { id, title, .. } => (id, title, "loop"),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionSpec {
    from: String,
    to: String,
    output: String,
    input: String,
}
struct Compilation {
    cards: Vec<CreatedChatCard>,
    nodes: Vec<Value>,
    notes: Vec<Value>,
    names: serde_json::Map<String, Value>,
}

fn base_node(id: &str, kind: &str, x: f64, y: f64, provider: &str) -> Value {
    json!({"id":id,"kind":kind,"x":x,"y":y,"action":"describe","skill":"image-edit","prompt":"","ratio":null,"provider":provider,"inputs":{},"outputs":{},"outputPorts":[],"trigger":false})
}
fn add_input(node: &mut Value, port: &str, mut binding: Value, label: &str) {
    let referenced = node["kind"] == "generation" && matches!(port, "text" | "image");
    if node["inputs"].get(port).is_none() {
        node["inputs"][port] = json!([]);
    }
    let inputs = node["inputs"][port].as_array_mut().unwrap();
    if inputs.iter().any(|old| {
        let mut old = old.clone();
        old.as_object_mut().unwrap().remove("slot");
        old == binding
    }) {
        return;
    }
    let slot = inputs.len() + 1;
    if referenced {
        binding["slot"] = json!(slot);
    }
    inputs.push(binding.clone());
    if referenced {
        if node.get("promptReferences").is_none() {
            node["promptReferences"] = json!([]);
        }
        let reference = format!("chat-ref-{}", ulid::Ulid::new());
        node["promptReferences"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":reference,"type":port,"input":binding,"slot":slot,"label":format!("{} {slot}",if port=="text"{"文本"}else{"图片来源"})}));
        node["prompt"] = json!(format!(
            "{}\n{}：@[{}]",
            node["prompt"].as_str().unwrap_or(""),
            label.replace("@[", "@ ["),
            reference
        ));
    }
}
fn compile(
    args: &Value,
    defaults: &ChatCardDefaults,
    images: &[String],
    anchor: (f64, f64),
    prefix: &str,
) -> AppResult<Compilation> {
    if args.to_string().len() > 64_000 {
        return Err(invalid());
    }
    let batch: CardBatch = serde_json::from_value(args.clone()).map_err(|_| invalid())?;
    if batch.cards.is_empty() || batch.cards.len() > 12 || batch.connections.len() > 24 {
        return Err(invalid());
    }
    if batch
        .cards
        .iter()
        .filter(|c| matches!(c, CardSpec::Loop { .. }))
        .count()
        > 1
    {
        return Err(error("每批卡片最多包含一个循环，请将独立循环分批创建"));
    }
    let mut aliases = HashMap::new();
    let mut cards = Vec::new();
    let mut nodes = Vec::new();
    let mut notes = Vec::new();
    let mut names = serde_json::Map::new();
    for (index, spec) in batch.cards.iter().enumerate() {
        let (alias, title, kind) = spec.identity();
        if alias.is_empty()
            || alias.len() > 40
            || !alias
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            || title.trim().is_empty()
            || title.chars().count() > 80
            || aliases.contains_key(alias)
        {
            return Err(invalid());
        }
        let id = format!("chat-card-{prefix}-{index}");
        aliases.insert(alias.to_owned(), (id.clone(), kind.to_owned()));
        let x = anchor.0 + (index % 3) as f64 * 420.0;
        let y = anchor.1 + (index / 3) as f64 * 400.0;
        cards.push(CreatedChatCard {
            alias: alias.into(),
            id: id.clone(),
            kind: kind.into(),
            title: title.trim().into(),
        });
        names.insert(id.clone(), json!(title.trim()));
        if let CardSpec::Content { text, rows, .. } = spec {
            let rows = match (text, rows) {
                (Some(text), None) => vec![vec![text.clone()]],
                (None, Some(rows)) => rows.clone(),
                _ => return Err(invalid()),
            };
            let columns = rows.first().map_or(0, Vec::len);
            if rows.is_empty()
                || rows.len() > 100
                || columns == 0
                || columns > 12
                || rows.iter().any(|r| r.len() != columns)
                || rows
                    .iter()
                    .flatten()
                    .map(|s| s.chars().count())
                    .sum::<usize>()
                    > 24_000
            {
                return Err(invalid());
            }
            let cells:Vec<Vec<Value>>=rows.iter().enumerate().map(|(r,row)|row.iter().enumerate().map(|(c,text)|json!({"id":format!("{id}-cell-{r}-{c}"),"text":text,"bold":false,"italic":false,"align":"left"})).collect()).collect();
            let payload = json!({"schema_version":1,"note_type":"text","text":"","title":title.trim(),"cells":cells,"column_widths":vec![1;columns],"row_heights":vec![1;rows.len()]});
            crate::core::creative_session_contract::parse_node_payload(
                crate::core::creative_session_contract::CreativeNodeKind::Note,
                &payload.to_string(),
            )
            .map_err(|_| invalid())?;
            notes.push(json!({"id":id,"payload":payload,"x":x,"y":y,"width":(columns as f64*200.0).max(320.0),"height":(rows.len() as f64*80.0+48.0).clamp(160.0,2000.0)}));
            continue;
        }
        let mut node = base_node(&id, kind, x, y, &defaults.provider);
        match spec {
            CardSpec::Generation {
                prompt,
                media_type,
                ratio,
                reference_aliases,
                ..
            } => {
                if prompt.trim().is_empty()
                    || prompt.chars().count() > 8000
                    || prompt.contains("@[")
                    || !matches!(media_type.as_str(), "image" | "video")
                    || reference_aliases.len() > 8
                {
                    return Err(invalid());
                }
                if ratio.as_ref().is_some_and(|r| {
                    !matches!(
                        r.as_str(),
                        "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9"
                    )
                }) {
                    return Err(invalid());
                }
                node["prompt"] = json!(prompt.trim());
                if media_type == "image" && ratio.as_deref() == Some("21:9") {
                    return Err(error("图片比例不受支持，请使用常用图片比例"));
                }
                node["ratio"] = json!(ratio);
                if media_type == "video" {
                    let provider = if defaults.video_channel == "cloud" {
                        format!(
                            "bowerbird-cloud-video_seedance25_{}",
                            defaults.video_options.video_resolution
                        )
                    } else {
                        "jimeng".into()
                    };
                    node["provider"] = json!(provider);
                    node["generation"] = json!({"media":"video","videoChannel":defaults.video_channel,"videoOptions":defaults.video_options,"ratio":ratio});
                } else {
                    node["generation"] = json!({"media":"image","ratio":ratio});
                }
                let mut seen = HashSet::new();
                for alias in reference_aliases {
                    let index = alias
                        .strip_prefix("image")
                        .and_then(|s| s.parse::<usize>().ok())
                        .filter(|i| *i > 0 && *i <= images.len())
                        .ok_or_else(invalid)?;
                    if alias != &format!("image{index}") || !seen.insert(index) {
                        return Err(invalid());
                    }
                    add_input(
                        &mut node,
                        "image",
                        json!({"assetId":images[index-1]}),
                        &format!("参考图片 {index}"),
                    );
                }
            }
            CardSpec::Trigger { count, .. } => {
                if count.is_some_and(|c| c > 9999) {
                    return Err(invalid());
                }
                node["triggerCount"] = json!(count.unwrap_or(1));
            }
            CardSpec::Loop {
                mode,
                count,
                source,
                body,
                ..
            } => {
                if body.is_empty() || body.len() > 10 || !matches!(mode.as_str(), "count" | "rows")
                {
                    return Err(invalid());
                }
                node["loopMode"] = json!(mode);
                node["loopStartItem"] = json!(1);
                if mode == "count" {
                    if source.is_some() || count.is_none_or(|n| !(1..=100).contains(&n)) {
                        return Err(invalid());
                    }
                    node["loopCount"] = json!(count);
                } else if count.is_some() || source.is_none() {
                    return Err(invalid());
                }
            }
            _ => unreachable!(),
        }
        nodes.push(node);
    }
    let mut body_owners = HashSet::new();
    for spec in &batch.cards {
        if let CardSpec::Loop {
            id,
            mode,
            source,
            body,
            ..
        } = spec
        {
            let loop_id = &aliases[id].0;
            if let Some(source) = source {
                let (source_id, kind) = aliases.get(source).ok_or_else(invalid)?;
                if kind != "content" {
                    return Err(invalid());
                }
                let source_note = notes.iter().find(|n| n["id"] == *source_id).unwrap();
                if !source_note["payload"]["cells"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|r| r.as_array().unwrap())
                    .any(|c| c["text"].as_str().is_some_and(|t| !t.trim().is_empty()))
                {
                    return Err(error("逐行循环的内容卡不能为空，请先提供至少一行内容"));
                }
                let owner = nodes.iter_mut().find(|n| n["id"] == *loop_id).unwrap();
                add_input(
                    owner,
                    "text",
                    json!({"canvasNodeId":source_id,"cellId":"*text"}),
                    "内容行",
                );
            }
            for alias in body {
                let (target, kind) = aliases.get(alias).ok_or_else(invalid)?;
                if kind != "generation" || !body_owners.insert(alias) {
                    return Err(invalid());
                }
                let target = nodes.iter_mut().find(|n| n["id"] == *target).unwrap();
                let (port, label) = if mode == "rows" {
                    ("text", "当前行内容")
                } else {
                    ("iteration", "当前轮次")
                };
                add_input(
                    target,
                    "text",
                    json!({"nodeId":loop_id,"portId":port}),
                    label,
                );
            }
        }
    }
    let mut seen = HashSet::new();
    for connection in &batch.connections {
        let (from, kind) = aliases.get(&connection.from).ok_or_else(invalid)?;
        let (to, to_kind) = aliases.get(&connection.to).ok_or_else(invalid)?;
        if from == to
            || to_kind == "content"
            || !seen.insert((
                &connection.from,
                &connection.to,
                &connection.output,
                &connection.input,
            ))
        {
            return Err(invalid());
        }
        let output_type = match (kind.as_str(), connection.output.as_str()) {
            ("content", "text") => "text",
            ("generation", "image") => "image",
            ("trigger", "signal") => "signal",
            ("loop", "iteration") => "text",
            ("loop", "text")
                if nodes
                    .iter()
                    .any(|n| n["id"] == *from && n["loopMode"] == "rows") =>
            {
                "text"
            }
            _ => return Err(invalid()),
        };
        let valid = match (to_kind.as_str(), connection.input.as_str()) {
            ("generation", "text" | "image" | "signal") => connection.input == output_type,
            ("trigger", "completion") => kind == "generation",
            ("loop", "signal") => output_type == "signal",
            _ => false,
        };
        if !valid {
            return Err(invalid());
        }
        if connection.input == "image"
            && nodes
                .iter()
                .any(|n| n["id"] == *from && n["generation"]["media"] == "video")
            && nodes
                .iter()
                .any(|n| n["id"] == *to && n["generation"]["media"] == "image")
        {
            return Err(error("视频输出不能直接接到图片生成，请先提取视频帧"));
        }
        let binding = if kind == "content" {
            json!({"canvasNodeId":from,"cellId":"*text"})
        } else {
            json!({"nodeId":from,"portId":connection.output})
        };
        let target = nodes.iter_mut().find(|n| n["id"] == *to).unwrap();
        add_input(
            target,
            &connection.input,
            binding,
            &cards.iter().find(|c| c.id == *from).unwrap().title,
        );
    }
    // Final placement uses the real content-card dimensions, not a fixed cell grid.
    let mut widths = [340.0f64; 3];
    let mut heights = vec![380.0f64; (cards.len() + 2) / 3];
    for (index, card) in cards.iter().enumerate() {
        if let Some(note) = notes.iter().find(|n| n["id"] == card.id) {
            widths[index % 3] = widths[index % 3].max(note["width"].as_f64().unwrap());
            heights[index / 3] = heights[index / 3].max(note["height"].as_f64().unwrap());
        }
    }
    for (index, card) in cards.iter().enumerate() {
        let x = anchor.0 + widths[..index % 3].iter().map(|w| w + 80.0).sum::<f64>();
        let y = anchor.1 + heights[..index / 3].iter().map(|h| h + 80.0).sum::<f64>();
        let target = if card.kind == "content" {
            notes.iter_mut().find(|n| n["id"] == card.id).unwrap()
        } else {
            nodes.iter_mut().find(|n| n["id"] == card.id).unwrap()
        };
        target["x"] = json!(x);
        target["y"] = json!(y);
    }
    // Select a runnable video input mode after explicit references and batch wiring exist.
    for node in &mut nodes {
        if node["generation"]["media"] == "video" {
            let images = node["inputs"]["image"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let dynamic = images.iter().any(|i| i.get("assetId").is_none());
            let count = images.len();
            let selected = defaults.video_options.kind.as_str();
            let mode = if count == 0 {
                "text2video"
            } else if dynamic {
                "multimodal2video"
            } else if selected == "frames2video" && count == 2 {
                "frames2video"
            } else if selected == "multimodal2video" {
                selected
            } else if count == 1 {
                "image2video"
            } else {
                "multimodal2video"
            };
            let options = &mut node["generation"]["videoOptions"];
            options["kind"] = json!(mode);
            if defaults.video_channel == "cloud" {
                options["model_version"] = json!("seedance2.5");
                if options["video_resolution"] == "4k" {
                    options["video_resolution"] = json!("720p");
                }
            }
            let model = options["model_version"].as_str().unwrap();
            let duration = options["duration"].as_u64().unwrap();
            let resolution = options["video_resolution"].as_str().unwrap();
            let valid_duration = match model {
                "seedance2.5" => (4..=30).contains(&duration),
                "seedance1.5pro" => (5..=12).contains(&duration),
                "seedance1.0fast" => (5..=10).contains(&duration),
                _ => (4..=15).contains(&duration),
            };
            let valid_resolution = match model {
                "seedance2.5" => matches!(resolution, "480p" | "720p" | "1080p"),
                "seedance2.0_vip" => matches!(resolution, "720p" | "1080p" | "4k"),
                _ => resolution == "720p",
            };
            if !valid_duration || !valid_resolution {
                return Err(error(
                    "视频时长或分辨率不适用于当前模型，请重新选择视频选项",
                ));
            }
            if (model == "seedance1.0fast" && mode != "image2video")
                || (model == "seedance1.5pro" && !matches!(mode, "image2video" | "frames2video"))
            {
                return Err(error("当前视频模型不支持这些输入，请切换视频模型后再创建"));
            }
            if defaults.video_channel == "cloud" {
                node["provider"] = json!(format!(
                    "bowerbird-cloud-video_seedance25_{}",
                    node["generation"]["videoOptions"]["video_resolution"]
                        .as_str()
                        .unwrap()
                ));
            }
            if matches!(mode, "image2video" | "frames2video") {
                node["ratio"] = Value::Null;
                node["generation"]["ratio"] = Value::Null;
            } else if node["ratio"]
                .as_str()
                .is_some_and(|r| !matches!(r, "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9"))
            {
                return Err(error("视频比例不受支持，请使用常用横竖屏比例"));
            }
        }
    }
    Ok(Compilation {
        cards,
        nodes,
        notes,
        names,
    })
}

fn action(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatCardAction> {
    let raw: String = row.get(5)?;
    let cards = serde_json::from_str(&raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(ChatCardAction {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        call_id: row.get(3)?,
        status: row.get(4)?,
        cards,
        created_at: row.get(6)?,
        undone_at: row.get(7)?,
    })
}
const ACTION_SELECT:&str="SELECT id,conversation_id,turn_id,call_id,status,cards_json,created_at,undone_at FROM local_chat_card_actions";
pub(crate) fn read_actions(conn: &Connection, id: &str) -> AppResult<Vec<ChatCardAction>> {
    let mut query = conn.prepare(&format!(
        "{ACTION_SELECT} WHERE conversation_id=?1 ORDER BY created_at,id"
    ))?;
    let result = query
        .query_map([id], action)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(result)
}
fn replay(
    conn: &Connection,
    conversation: &str,
    turn: &str,
    call: &str,
    args: &Value,
) -> AppResult<Option<ChatCardAction>> {
    let existing=conn.query_row("SELECT args_json FROM local_chat_card_actions WHERE conversation_id=?1 AND turn_id=?2 AND call_id=?3",params![conversation,turn,call],|r|r.get::<_,String>(0)).optional()?;
    if let Some(raw) = existing {
        if serde_json::from_str::<Value>(&raw)? != *args {
            return Err(error("同一工具调用编号对应的内容发生变化，本次未创建卡片"));
        }
        return Ok(Some(conn.query_row(
            &format!("{ACTION_SELECT} WHERE conversation_id=?1 AND turn_id=?2 AND call_id=?3"),
            params![conversation, turn, call],
            action,
        )?));
    }
    Ok(None)
}
fn workflow(conn: &Connection, project: &str) -> AppResult<(i64, Value)> {
    let found = conn
        .query_row(
            "SELECT revision,document_json FROM canvas_workflows WHERE project_id=?1",
            [project],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    match found {
        Some((revision, raw)) => Ok((revision, serde_json::from_str(&raw)?)),
        None => Ok((0, json!({"schema_version":1,"nodes":[],"run":null}))),
    }
}
fn save_workflow(conn: &Connection, project: &str, revision: i64, doc: &Value) -> AppResult<()> {
    crate::commands::canvas_workflow::validate(doc)?;
    let changed=conn.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) SELECT ?1,?2+1,?3 WHERE ?2=0 OR EXISTS(SELECT 1 FROM canvas_workflows WHERE project_id=?1) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json WHERE canvas_workflows.revision=?2",params![project,revision,doc.to_string()])?;
    if changed != 1 {
        return Err(error("工作流已被其他窗口修改，请重新读取后重试"));
    }
    Ok(())
}
fn contains_id(value: &Value, ids: &HashSet<String>) -> bool {
    match value {
        Value::String(s) => ids.contains(s),
        Value::Array(a) => a.iter().any(|v| contains_id(v, ids)),
        Value::Object(o) => o
            .iter()
            .any(|(k, v)| ids.contains(k) || contains_id(v, ids)),
        _ => false,
    }
}
fn run_references_cards(run: &Value, ids: &HashSet<String>) -> bool {
    contains_id(run, ids)
        || ["cellTexts", "cellValues"].iter().any(|field| {
            run[*field].as_object().is_some_and(|cells| {
                cells.keys().any(|key| {
                    // Runtime freezes only consumed content cells under
                    // JSON.stringify([canvasNodeId, cellId]) keys.
                    serde_json::from_str::<(String, Value)>(key)
                        .is_ok_and(|(node_id, _)| ids.contains(&node_id))
                })
            })
        })
}
// A JavaScript save serializes 420.0 as 420. That is not a user edit.
fn same_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same_json(a, b)))
        }
        _ => left == right,
    }
}
fn note_snapshot(conn: &Connection, id: &str) -> AppResult<Option<Value>> {
    Ok(conn.query_row("SELECT payload_json,x,y,width,height,z_index,position_locked,hidden_at,thread_id FROM canvas_nodes WHERE id=?1",[id],|r|Ok(json!({"id":id,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(0)?).unwrap_or(Value::Null),"x":r.get::<_,f64>(1)?,"y":r.get::<_,f64>(2)?,"width":r.get::<_,f64>(3)?,"height":r.get::<_,f64>(4)?,"z":r.get::<_,i64>(5)?,"locked":r.get::<_,i64>(6)?,"hidden":r.get::<_,Option<i64>>(7)?,"thread":r.get::<_,Option<String>>(8)?}))).optional()?)
}

impl Database {
    pub fn replay_local_chat_card_action(
        &self,
        conversation: &str,
        turn: &str,
        call: &str,
        args: &Value,
    ) -> AppResult<Option<ChatCardAction>> {
        replay(&self.conn.lock().unwrap(), conversation, turn, call, args)
    }
    pub fn create_local_chat_cards(
        &self,
        conversation: &str,
        turn: &str,
        call: &str,
        args: &Value,
    ) -> AppResult<ChatCardAction> {
        if call.is_empty() || call.len() > 200 {
            return Err(invalid());
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        if let Some(action) = replay(&tx, conversation, turn, call, args)? {
            return Ok(action);
        }
        let owner:Option<(String,String,f64,f64,String)>=tx.query_row("SELECT c.project_id,c.thread_id,n.x,n.y,t.card_defaults_json FROM local_chat_conversations c JOIN local_chat_turns t ON t.conversation_id=c.id JOIN canvas_nodes n ON n.id=c.node_id JOIN projects p ON p.id=c.project_id WHERE c.id=?1 AND t.id=?2 AND c.status='running' AND t.status='running' AND p.archived_at IS NULL",params![conversation,turn],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let (project, thread, x, y, raw_defaults) =
            owner.ok_or_else(|| error("本轮对话已结束或项目已关闭，本次未创建卡片"))?;
        let defaults = if raw_defaults == "{}" {
            ChatCardDefaults::default()
        } else {
            serde_json::from_str(&raw_defaults)?
        };
        defaults.validate()?;
        let images:Vec<String>=serde_json::from_str(&tx.query_row("SELECT reference_asset_ids FROM local_chat_messages WHERE conversation_id=?1 AND turn_id=?2 AND role='user'",params![conversation,turn],|r|r.get::<_,String>(0))?)?;
        for id in &images {
            if !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1)",
                [id],
                |r| r.get::<_, bool>(0),
            )? {
                return Err(error("本轮参考图片已删除，本次未创建卡片"));
            }
        }
        let batch_count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM local_chat_card_actions WHERE conversation_id=?1 AND turn_id=?2",
            params![conversation, turn],
            |r| r.get(0),
        )?;
        if batch_count >= 4 {
            return Err(error("本轮已创建 4 批卡片，请下一轮再添加"));
        }
        let (revision, mut doc) = workflow(&tx, &project)?;
        // Batch aliases can only reference newly compiled cards. Append to the latest
        // document in this transaction, preserving every unrelated run and reservation.
        let id = ulid::Ulid::new().to_string();
        let native_right:f64=tx.query_row("SELECT COALESCE(MAX(x+width),?2) FROM canvas_nodes WHERE project_id=?1 AND hidden_at IS NULL",params![project,x],|r|r.get(0))?;
        let workflow_right = doc["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| n["x"].as_f64())
            .fold(x, |right, n| right.max(n + 340.0));
        let mut compiled = compile(
            args,
            &defaults,
            &images,
            (
                (x + 420.0)
                    .max(native_right + 80.0)
                    .max(workflow_right + 80.0),
                y,
            ),
            &id,
        )?;
        for node in &compiled.nodes {
            if node["generation"]["media"] == "video" {
                for input in node["inputs"]["image"].as_array().into_iter().flatten() {
                    if let Some(asset) = input["assetId"].as_str() {
                        let (ext, path): (Option<String>, Option<String>) = tx.query_row(
                            "SELECT ext,store_path FROM assets WHERE id=?1",
                            [asset],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )?;
                        let extension = ext
                            .or_else(|| {
                                path.as_deref()
                                    .and_then(|p| std::path::Path::new(p).extension())
                                    .map(|s| s.to_string_lossy().into_owned())
                            })
                            .unwrap_or_default()
                            .to_ascii_lowercase();
                        if !matches!(
                            extension.trim_start_matches('.'),
                            "png" | "jpg" | "jpeg" | "webp" | "bmp"
                        ) {
                            return Err(error(
                                "视频参考仅支持 PNG、JPEG、WebP 和 BMP，请更换参考图",
                            ));
                        }
                    }
                }
            }
        }
        let mut used: HashSet<String> = doc["cardNames"]
            .as_object()
            .into_iter()
            .flat_map(|names| names.values())
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        for card in &mut compiled.cards {
            let original = card.title.clone();
            let mut suffix = 2;
            while used.contains(&card.title) {
                card.title = format!("{} {suffix}", original.chars().take(74).collect::<String>());
                suffix += 1;
            }
            used.insert(card.title.clone());
            compiled.names.insert(card.id.clone(), json!(card.title));
            if let Some(note) = compiled.notes.iter_mut().find(|n| n["id"] == card.id) {
                note["payload"]["title"] = json!(card.title);
            }
        }
        let nodes = doc["nodes"].as_array_mut().ok_or_else(invalid)?;
        nodes.extend(compiled.nodes.clone());
        if doc.get("cardNames").is_none() {
            doc["cardNames"] = json!({});
        }
        doc["cardNames"]
            .as_object_mut()
            .ok_or_else(invalid)?
            .extend(compiled.names.clone());
        let now = Utc::now().timestamp_millis();
        let mut note_records = Vec::new();
        for note in &compiled.notes {
            tx.execute("INSERT INTO canvas_nodes(id,project_id,thread_id,kind,payload_json,x,y,width,height,z_index,created_at,updated_at) VALUES(?1,?2,?3,'note',?4,?5,?6,?7,?8,0,?9,?9)",params![note["id"].as_str(),project,thread,note["payload"].to_string(),note["x"].as_f64(),note["y"].as_f64(),note["width"].as_f64(),note["height"].as_f64(),now/1000])?;
            note_records.push(note_snapshot(&tx, note["id"].as_str().unwrap())?.unwrap());
        }
        save_workflow(&tx, &project, revision, &doc)?;
        for asset in &images {
            tx.execute("INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) VALUES(?1,?2,?3)",params![project,asset,now/1000])?;
        }
        let footprint = json!({"nodes":compiled.nodes,"notes":note_records,"names":compiled.names});
        let result = ChatCardAction {
            id: id.clone(),
            conversation_id: conversation.into(),
            turn_id: turn.into(),
            call_id: call.into(),
            status: "created".into(),
            cards: compiled.cards,
            created_at: now,
            undone_at: None,
        };
        tx.execute("INSERT INTO local_chat_card_actions(id,conversation_id,turn_id,call_id,args_json,cards_json,footprint_json,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'created',?8)",params![id,conversation,turn,call,args.to_string(),serde_json::to_string(&result.cards)?,footprint.to_string(),now])?;
        tx.execute(
            "UPDATE local_chat_conversations SET revision=revision+1,updated_at=?2 WHERE id=?1",
            params![conversation, now],
        )?;
        tx.execute(
            "UPDATE project_canvases SET updated_at=?2 WHERE project_id=?1",
            params![project, now / 1000],
        )?;
        tx.commit()?;
        Ok(result)
    }
    pub fn undo_local_chat_cards(&self, conversation: &str, action_id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let (project,status,raw):(String,String,String)=tx.query_row("SELECT c.project_id,a.status,a.footprint_json FROM local_chat_card_actions a JOIN local_chat_conversations c ON c.id=a.conversation_id WHERE a.id=?1 AND a.conversation_id=?2",params![action_id,conversation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||error("找不到这次卡片操作"))?;
        if status == "undone" {
            return Ok(());
        }
        let footprint: Value = serde_json::from_str(&raw)?;
        let (revision, mut doc) = workflow(&tx, &project)?;
        let ids: HashSet<String> = footprint["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(footprint["notes"].as_array().into_iter().flatten())
            .map(|n| n["id"].as_str().unwrap().to_owned())
            .collect();
        let conflict =
            || error("这些卡片已被编辑、运行或连接到其他内容，无法撤销；请在画板中手动调整");
        if run_references_cards(&doc["run"], &ids)
            || doc["runs"]
                .as_array()
                .is_some_and(|runs| runs.iter().any(|run| run_references_cards(run, &ids)))
        {
            return Err(conflict());
        }
        for original in footprint["nodes"].as_array().unwrap() {
            if !doc["nodes"]
                .as_array()
                .and_then(|nodes| nodes.iter().find(|n| n["id"] == original["id"]))
                .is_some_and(|current| same_json(current, original))
            {
                return Err(conflict());
            }
        }
        for (id, name) in footprint["names"].as_object().unwrap() {
            if doc["cardNames"][id] != *name {
                return Err(conflict());
            }
        }
        for node in doc["nodes"].as_array().ok_or_else(invalid)? {
            if !ids.contains(node["id"].as_str().unwrap_or("")) && contains_id(node, &ids) {
                return Err(conflict());
            }
        }
        for note in footprint["notes"].as_array().unwrap() {
            if !note_snapshot(&tx, note["id"].as_str().unwrap())?
                .as_ref()
                .is_some_and(|current| same_json(current, note))
            {
                return Err(conflict());
            }
        }
        let mut statement = tx.prepare("SELECT id,payload_json FROM canvas_nodes")?;
        for entry in
            statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        {
            let (id, raw) = entry?;
            if !ids.contains(&id) && contains_id(&serde_json::from_str(&raw)?, &ids) {
                return Err(conflict());
            }
        }
        drop(statement);
        let mut statement =
            tx.prepare("SELECT document_json FROM canvas_workflows WHERE project_id<>?1")?;
        for raw in statement.query_map([&project], |r| r.get::<_, String>(0))? {
            if contains_id(&serde_json::from_str(&raw?)?, &ids) {
                return Err(conflict());
            }
        }
        drop(statement);
        for id in &ids {
            let linked:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM canvas_edges WHERE from_node_id=?1 OR to_node_id=?1) OR EXISTS(SELECT 1 FROM canvas_group_items WHERE node_id=?1)",[id],|r|r.get(0))?;
            if linked {
                return Err(conflict());
            }
        }
        doc["nodes"]
            .as_array_mut()
            .unwrap()
            .retain(|n| !ids.contains(n["id"].as_str().unwrap_or("")));
        if let Some(names) = doc["cardNames"].as_object_mut() {
            for id in &ids {
                names.remove(id);
            }
        }
        save_workflow(&tx, &project, revision, &doc)?;
        for note in footprint["notes"].as_array().unwrap() {
            tx.execute(
                "DELETE FROM canvas_nodes WHERE id=?1",
                [note["id"].as_str().unwrap()],
            )?;
        }
        let now = Utc::now().timestamp_millis();
        tx.execute(
            "UPDATE local_chat_card_actions SET status='undone',undone_at=?2 WHERE id=?1",
            params![action_id, now],
        )?;
        tx.execute(
            "UPDATE local_chat_conversations SET revision=revision+1,updated_at=?2 WHERE id=?1",
            params![conversation, now],
        )?;
        tx.execute(
            "UPDATE project_canvases SET updated_at=?2 WHERE project_id=?1",
            params![project, now / 1000],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn local_chat_provider_tool_version(&self, id: &str) -> AppResult<i64> {
        Ok(self.conn.lock().unwrap().query_row(
            "SELECT provider_tool_version FROM local_chat_conversations WHERE id=?1",
            [id],
            |r| r.get(0),
        )?)
    }
    pub fn set_local_chat_provider_tool_version(&self, id: &str, version: i64) -> AppResult<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE local_chat_conversations SET provider_tool_version=?2 WHERE id=?1",
            params![id, version],
        )?;
        Ok(())
    }
    pub fn replace_local_chat_provider_thread(
        &self,
        id: &str,
        expected_old: &str,
        new_id: &str,
        version: i64,
    ) -> AppResult<()> {
        let changed=self.conn.lock().unwrap().execute("UPDATE local_chat_conversations SET provider_thread_id=?3,provider_tool_version=?4 WHERE id=?1 AND provider_thread_id=?2",params![id,expected_old,new_id,version])?;
        if changed != 1 {
            return Err(error("对话运行身份已变化，请刷新后继续"));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "local_chat_cards_tests.rs"]
mod tests;
