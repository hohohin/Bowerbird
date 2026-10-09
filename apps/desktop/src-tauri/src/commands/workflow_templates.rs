//! Local reusable definitions; exports contain no canvas bindings or execution state.
use std::sync::Arc;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use tauri::State;
use crate::{db::Database, error::{AppError, AppResult}};

fn invalid() -> AppError { AppError::Other("流程模板格式无效或包含不支持的字段".into()) }
fn fields(value: &Value, allowed: &[&str]) -> AppResult<()> {
    if value.as_object().is_none_or(|o| o.keys().any(|key| !allowed.contains(&key.as_str()))) { return Err(invalid()); }
    Ok(())
}
fn text(value: &Value, max: usize) -> bool { value.as_str().is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max) }
fn alias(value: &Value) -> bool { value.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 32 && s.as_bytes()[0].is_ascii_alphabetic() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')) }
fn content(value: &Value, kind: &Value) -> AppResult<()> {
    fields(value, &["text", "images"])?;
    if if kind == "text" { value["text"].as_str().is_none_or(|s| s.encode_utf16().count() > 32_000) } else { value.get("text").is_some() } { return Err(invalid()); }
    let images = match value.get("images") { Some(v) => v.as_array().ok_or_else(invalid)?.as_slice(), None => &[] };
    if images.len() > 48 || kind == "image" && images.is_empty() { return Err(invalid()); }
    let mut tokens = std::collections::HashSet::new();
    for picture in images {
        fields(picture, &["dataUrl", "token"])?;
        let data = picture["dataUrl"].as_str().ok_or_else(invalid)?;
        let (header, bytes) = data.split_once(',').ok_or_else(invalid)?;
        if data.len() > 12_000_000 || !matches!(header, "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/webp;base64" | "data:image/gif;base64" | "data:image/bmp;base64") { return Err(invalid()); }
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD.decode(bytes).map_err(|_| invalid())?;
        image::guess_format(&decoded).map_err(|_| invalid())?;
        if kind == "text" {
            let token = picture["token"].as_str().ok_or_else(invalid)?;
            if !tokens.insert(token) || token.strip_prefix("@图片").is_none_or(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit())) { return Err(invalid()); }
        }
    }
    Ok(())
}
fn validate(value: &Value) -> AppResult<()> {
    fields(value, &["format", "schemaVersion", "id", "revision", "name", "description", "plan", "inputs", "parameters", "outputs", "layout"])?;
    if value.get("layout").is_some() && value["schemaVersion"] != 3 { return Err(invalid()); }
    if value.to_string().len() > 32_000_000 || value["format"] != "bowerbird-workflow-template" || !matches!(value["schemaVersion"].as_i64(), Some(1 | 2 | 3))
        || !text(&value["id"], 80) || !text(&value["name"], 120) || value["revision"].as_i64().is_none_or(|n| !(0..9_007_199_254_740_991).contains(&n))
        || value["description"].as_str().is_none_or(|s| s.encode_utf16().count() > 2000) { return Err(invalid()); }
    let plan = &value["plan"]; fields(plan, &["summary", "nodes", "edges"])?;
    if !text(&plan["summary"], 2000) || plan.to_string().encode_utf16().count() > 16000 { return Err(invalid()); }
    let nodes = plan["nodes"].as_array().ok_or_else(invalid)?;
    let edges = plan["edges"].as_array().ok_or_else(invalid)?;
    if nodes.len() < 2 || nodes.len() > 24 || edges.len() > 64 { return Err(invalid()); }
    let mut ids = std::collections::HashSet::new();
    for node in nodes {
        fields(node, &["id", "kind", "action", "skill", "prompt", "ratio", "overwriteDescribe"])?;
        if node.get("overwriteDescribe").is_some_and(|flag| !flag.is_boolean() || node["kind"] != "instruction" || node["action"] != "describe") { return Err(invalid()); }
        if !alias(&node["id"]) || !ids.insert(node["id"].as_str().unwrap())
            || !matches!(node["kind"].as_str(), Some("trigger" | "instruction" | "agent" | "generation" | "skill" | "visual-profile"))
            || node.get("prompt").is_some_and(|p| p.as_str().is_none_or(|s| s.encode_utf16().count() > 4000)) { return Err(invalid()); }
    }
    let input_fields = if value["schemaVersion"] != 1 { vec!["id", "label", "type", "content"] } else { vec!["id", "label", "type"] };
    for (section, allowed) in [("inputs", input_fields), ("parameters", vec!["id", "label", "node", "field", "defaultValue"]), ("outputs", vec!["id", "label", "node", "port"])] {
        let items = value[section].as_array().ok_or_else(invalid)?;
        if items.len() > 48 || section == "outputs" && items.is_empty() { return Err(invalid()); }
        for item in items {
            fields(item, &allowed)?;
            if !alias(&item["id"]) || !ids.insert(item["id"].as_str().unwrap()) || !text(&item["label"], 120) { return Err(invalid()); }
            if section == "inputs" && !matches!(item["type"].as_str(), Some("text" | "image")) { return Err(invalid()); }
            if section == "inputs" { if let Some(value) = item.get("content") { content(value, &item["type"])?; } }
            if section != "inputs" && !nodes.iter().any(|node| node["id"] == item["node"]) { return Err(invalid()); }
            if section == "parameters" && (!matches!(item["field"].as_str(), Some("suffix" | "ratio")) || item["defaultValue"].as_str().is_none_or(|s| s.encode_utf16().count() > 2000)) { return Err(invalid()); }
            if section == "outputs" && !matches!(item["port"].as_str(), Some("text" | "image" | "visual-profile")) { return Err(invalid()); }
        }
    }
    if let Some(layout) = value.get("layout") {
        let cards = layout.as_array().ok_or_else(invalid)?;
        if cards.len() > 500 { return Err(invalid()); }
        let mut card_ids = std::collections::HashSet::new();
        let mut node_ids = std::collections::HashSet::new();
        let mut input_ids = std::collections::HashSet::new();
        for card in cards {
            fields(card, &["id", "node", "inputs", "type", "content", "x", "y", "width", "height", "enclosed"])?;
            if !alias(&card["id"]) || !card_ids.insert(card["id"].as_str().unwrap()) || !card["enclosed"].is_boolean()
                || ["x","y","width","height"].iter().any(|key| card[key].as_f64().is_none_or(|n| !n.is_finite() || n.abs() >= 10_000_000.))
                || card["width"].as_f64().unwrap() <= 0. || card["height"].as_f64().unwrap() <= 0. { return Err(invalid()); }
            if let Some(node) = card.get("node") {
                if !nodes.iter().any(|n| &n["id"] == node) || !node_ids.insert(node.as_str().ok_or_else(invalid)?)
                    || ["inputs","type","content"].iter().any(|key| card.get(key).is_some()) { return Err(invalid()); }
            } else {
                if !matches!(card["type"].as_str(), Some("text" | "image")) { return Err(invalid()); }
                for input in card["inputs"].as_array().ok_or_else(invalid)? {
                    if !value["inputs"].as_array().unwrap().iter().any(|i| &i["id"] == input) || !input_ids.insert(input.as_str().ok_or_else(invalid)?) { return Err(invalid()); }
                }
                if let Some(data) = card.get("content") { content(data, &card["type"])?; }
            }
        }
    }
    for edge in edges {
        fields(edge, &["from", "output", "to", "input"])?;
        if !nodes.iter().any(|node| node["id"] == edge["to"]) || !nodes.iter().chain(value["inputs"].as_array().unwrap()).any(|node| node["id"] == edge["from"])
            || !matches!(edge["output"].as_str(), Some("signal" | "text" | "image" | "visual-profile")) || edge["input"] != edge["output"] { return Err(invalid()); }
    }
    Ok(())
}

impl Database {
    fn workflow_templates_list(&self) -> AppResult<Vec<Value>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT document_json FROM workflow_templates ORDER BY updated_at DESC,id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|raw| Ok(serde_json::from_str(&raw)?)).collect()
    }
    fn workflow_template_save(&self, mut document: Value, expected_revision: i64) -> AppResult<Value> {
        validate(&document)?;
        if document["revision"] != expected_revision { return Err(invalid()); }
        let mut conn = self.conn.lock().unwrap(); let tx = conn.transaction()?;
        save_definition(&tx, &mut document, expected_revision)?;
        tx.commit()?; Ok(document)
    }
}
fn save_definition(tx: &rusqlite::Connection, document: &mut Value, expected_revision: i64) -> AppResult<()> {
        validate(document)?;
        let id = document["id"].as_str().unwrap().to_owned();
        let current = tx.query_row("SELECT revision FROM workflow_templates WHERE id=?1", [&id], |r| r.get::<_, i64>(0)).optional()?.unwrap_or(0);
        if current != expected_revision { return Err(AppError::Other("模板已被修改，请重新打开模板库".into())); }
        document["revision"] = (current + 1).into();
        tx.execute("INSERT INTO workflow_templates(id,revision,document_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json,updated_at=excluded.updated_at",
            params![id, current + 1, document.to_string(), chrono::Utc::now().timestamp_millis()])?;
        Ok(())
}
#[derive(serde::Deserialize)]
pub struct ContainerBounds { id: String, x: f64, y: f64, width: f64, height: f64 }
impl Database {
    fn workflow_encapsulate(&self, project_id: &str, revision: i64, name: &str, members: &[String], bounds: &[ContainerBounds], mut template: Option<Value>) -> AppResult<Value> {
        if members.is_empty() || members.len() > 500 || name.trim().is_empty() || name.chars().count() > 120 { return Err(invalid()); }
        let wanted: std::collections::HashSet<_> = members.iter().map(String::as_str).collect();
        if wanted.len() != members.len() || bounds.iter().any(|b| ![b.x,b.y,b.width,b.height].iter().all(|n| n.is_finite() && n.abs() < 10_000_000.) || b.width <= 0. || b.height <= 0.) { return Err(invalid()); }
        let mut conn = self.conn.lock().unwrap(); let tx = conn.transaction()?;
        let (current, raw): (i64, String) = tx.query_row("SELECT revision,document_json FROM canvas_workflows WHERE project_id=?1", [project_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?.unwrap_or((0, serde_json::json!({"schema_version":1,"nodes":[],"run":null}).to_string()));
        if revision != current { return Err(AppError::Other("画板已变化，请重新打开封装面板".into())); }
        let mut document: Value = serde_json::from_str(&raw)?;
        if document.get("runs").and_then(Value::as_array).into_iter().flatten().chain(document.get("run")).any(|r| matches!(r["status"].as_str(), Some("running" | "waiting"))) {
            return Err(AppError::Other("请先停止当前运行的工作流再封装".into()));
        }
        let native: Vec<(String,String,String,f64,f64,f64,f64)> = {
            let mut stmt = tx.prepare("SELECT id,kind,payload_json,x,y,width,height FROM canvas_nodes WHERE project_id=?1 AND hidden_at IS NULL AND id NOT IN (SELECT node_id FROM canvas_group_items WHERE project_id=?1) UNION ALL SELECT id,'group','{}',x,y,width,height FROM canvas_groups WHERE project_id=?1")?;
            let rows = stmt.query_map([project_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))?.collect::<Result<Vec<_>,_>>()?; rows
        };
        let mut rectangles = Vec::new();
        for (id, kind, payload, x,y,w,h) in &native {
            if kind == "note" && serde_json::from_str::<Value>(payload)?["note_type"] == "section" {
                if wanted.contains(id.as_str()) { return Err(AppError::Other("请选择容器内的卡片，暂不支持容器嵌套".into())); }
                continue;
            }
            rectangles.push((id.clone(),*x,*y,*w,*h));
        }
        for node in document["nodes"].as_array().ok_or_else(invalid)? {
            let id = node["id"].as_str().ok_or_else(invalid)?;
            if node["kind"] == "text" { continue; }
            let b = bounds.iter().find(|b| b.id == id);
            rectangles.push((id.to_owned(),node["x"].as_f64().ok_or_else(invalid)?,node["y"].as_f64().ok_or_else(invalid)?,b.map_or(320.,|b|b.width),b.map_or(400.,|b|b.height)));
        }
        let selected: Vec<_> = rectangles.iter().filter(|r| wanted.contains(r.0.as_str())).collect();
        if selected.len() != wanted.len() { return Err(AppError::Other("选中的卡片已不存在，请重新框选".into())); }
        let left = selected.iter().map(|r| r.1).fold(f64::INFINITY,f64::min)-32.;
        let top = selected.iter().map(|r| r.2).fold(f64::INFINITY,f64::min)-64.;
        let right = selected.iter().map(|r| r.1+r.3).fold(f64::NEG_INFINITY,f64::max)+32.;
        let bottom = selected.iter().map(|r| r.2+r.4).fold(f64::NEG_INFINITY,f64::max)+32.;
        // Preserve original positions unless enclosing them would visually swallow an unchecked card.
        let collision = rectangles.iter().any(|r| !wanted.contains(r.0.as_str()) && r.1 < right && r.1+r.3 > left && r.2 < bottom && r.2+r.4 > top);
        let dx = if collision { rectangles.iter().map(|r|r.1+r.3).fold(right,f64::max)+80.-left } else {0.};
        let now = chrono::Utc::now().timestamp();
        for (id,kind,payload,_,_,_,_) in &native {
            if wanted.contains(id.as_str()) {
                if kind == "group" { tx.execute("UPDATE canvas_groups SET x=x+?2,updated_at=?3 WHERE id=?1", params![id,dx,now])?; }
                else { tx.execute("UPDATE canvas_nodes SET x=x+?2,updated_at=?3 WHERE id=?1", params![id,dx,now])?; }
            }
            if kind == "note" {
                let mut note: Value = serde_json::from_str(payload)?;
                if note["note_type"] == "section" { if let Some(ids) = note["member_ids"].as_array_mut() {
                    ids.retain(|id| !id.as_str().is_some_and(|id|wanted.contains(id)));
                    let empty_container = ids.is_empty() && note["workflow_container"] == true;
                    tx.execute("UPDATE canvas_nodes SET payload_json=?2,updated_at=?3,hidden_at=CASE WHEN ?4 THEN ?3 ELSE hidden_at END WHERE id=?1", params![id,note.to_string(),now,empty_container])?;
                } }
            }
        }
        for node in document["nodes"].as_array_mut().ok_or_else(invalid)? {
            if node["id"].as_str().is_some_and(|id|wanted.contains(id)) { node["x"] = serde_json::json!(node["x"].as_f64().unwrap()+dx); }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let note = serde_json::json!({"schema_version":1,"note_type":"section","workflow_container":true,"text":name,"cells":[],"member_ids":members});
        tx.execute("INSERT INTO canvas_nodes(id,project_id,kind,payload_json,x,y,width,height,z_index,position_locked,created_at,updated_at) VALUES(?1,?2,'note',?3,?4,?5,?6,?7,0,0,?8,?8)",params![id,project_id,note.to_string(),left+dx,top,right-left,bottom-top,now])?;
        tx.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES(?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json",params![project_id,revision+1,document.to_string()])?;
        if let Some(ref mut definition) = template { let expected = definition["revision"].as_i64().ok_or_else(invalid)?; save_definition(&tx,definition,expected)?; }
        tx.execute("UPDATE project_canvases SET updated_at=?2 WHERE project_id=?1", params![project_id,now])?;
        tx.execute("UPDATE projects SET updated_at=?2 WHERE id=?1", params![project_id,now])?;
        tx.commit()?;
        Ok(serde_json::json!({"revision":revision+1,"document":document,"containerId":id,"bounds":{"x":left+dx,"y":top,"width":right-left,"height":bottom-top},"template":template}))
    }
}
#[tauri::command]
pub fn workflow_encapsulate(db: State<'_, Arc<Database>>, project_id: String, revision: i64, name: String, members: Vec<String>, bounds: Vec<ContainerBounds>, template: Option<Value>) -> AppResult<Value> {
    db.workflow_encapsulate(&project_id,revision,&name,&members,&bounds,template)
}
#[tauri::command]
pub fn workflow_templates_list(db: State<'_, Arc<Database>>) -> AppResult<Vec<Value>> { db.workflow_templates_list() }
#[tauri::command]
pub fn workflow_template_save(db: State<'_, Arc<Database>>, document: Value, expected_revision: i64) -> AppResult<Value> { db.workflow_template_save(document, expected_revision) }
#[tauri::command]
pub fn workflow_template_delete(db: State<'_, Arc<Database>>, id: String, expected_revision: i64) -> AppResult<()> {
    let count = db.conn.lock().unwrap().execute("DELETE FROM workflow_templates WHERE id=?1 AND revision=?2", params![id, expected_revision])?;
    if count != 1 { return Err(AppError::Other("模板已被修改或移除，请刷新模板库".into())); } Ok(())
}
#[tauri::command]
pub fn workflow_template_export(db: State<'_, Arc<Database>>, id: Option<String>, document: Option<Value>, path: String) -> AppResult<()> {
    let document = match (id, document) {
        (Some(id), None) => {
            let raw: String = db.conn.lock().unwrap().query_row("SELECT document_json FROM workflow_templates WHERE id=?1", [id], |r| r.get(0))?;
            serde_json::from_str(&raw)?
        }
        (None, Some(document)) => document,
        _ => return Err(invalid()),
    };
    export_document(&document, &path)
}
fn export_document(document: &Value, path: &str) -> AppResult<()> {
    if !path.to_ascii_lowercase().ends_with(".json") { return Err(AppError::Other("请选择 .json 流程文件".into())); }
    validate(document)?;
    let bytes = serde_json::to_vec_pretty(document)?;
    if bytes.len() > 32_000_000 { return Err(AppError::Other("流程数据包超过 32 MB，请减少携带的素材".into())); }
    std::fs::write(path, bytes)?; Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn template() -> Value { json!({"format":"bowerbird-workflow-template","schemaVersion":1,"id":"template","revision":0,"name":"海报","description":"","inputs":[],"parameters":[],"outputs":[{"id":"out","node":"draw","port":"image","label":"成品"}],"plan":{"summary":"海报","nodes":[{"id":"start","kind":"trigger"},{"id":"draw","kind":"generation","prompt":"猫"}],"edges":[{"from":"start","output":"signal","to":"draw","input":"signal"}]}}) }
    #[test]
    fn portable_storage_rejects_private_fields_and_stale_revisions() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let original = template(); let first = db.workflow_template_save(original.clone(), 0).unwrap();
        assert_eq!(first["revision"], 1); assert_eq!(db.workflow_templates_list().unwrap().len(), 1);
        assert!(db.workflow_template_save(original.clone(), 0).is_err());
        let second = db.workflow_template_save(first, 1).unwrap(); assert_eq!(second["revision"], 2);
        for field in ["provider", "inputs", "outputs", "planning", "sessionNodeIds", "profileId"] {
            let mut bad = original.clone(); bad["plan"]["nodes"][1][field] = json!("private"); assert!(validate(&bad).is_err());
        }
        let mut bad = original; bad["inputs"] = json!([{"id":"source1","label":"素材","type":"image","assetId":"private"}]); assert!(validate(&bad).is_err());
    }
    #[test]
    fn selection_exports_without_saving_a_library_template() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let dir = std::env::temp_dir().join(format!("bowerbird-workflow-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("分享工作流.bbworkflow.json");
        let document = template();
        export_document(&document, path.to_str().unwrap()).unwrap();
        let imported: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(imported, document);
        assert!(db.workflow_templates_list().unwrap().is_empty());
        assert!(export_document(&document, dir.join("wrong.txt").to_str().unwrap()).is_err());
        let mut bad = document; bad["provider"] = json!("private");
        assert!(export_document(&bad, path.to_str().unwrap()).is_err());
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(), imported);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn carried_content_round_trips_without_source_identities() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let mut document = template(); document["schemaVersion"] = json!(2);
        document["inputs"] = json!([
            {"id":"photo","label":"图片","type":"image","content":{"images":[{"dataUrl":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII="}]}},
            {"id":"copy","label":"文案","type":"text","content":{"text":"自带文案"}}
        ]);
        document["plan"]["edges"].as_array_mut().unwrap().extend([
            json!({"from":"photo","output":"image","to":"draw","input":"image"}),
            json!({"from":"copy","output":"text","to":"draw","input":"text"})
        ]);
        let saved = db.workflow_template_save(document.clone(), 0).unwrap();
        assert_eq!(db.workflow_templates_list().unwrap()[0], saved);
        let mut legacy = document.clone(); legacy["schemaVersion"] = json!(1); assert!(validate(&legacy).is_err());
        for bad_content in [json!({"images":[{"dataUrl":"https://example.test/image.png"}]}), json!({"images":[{"dataUrl":"data:image/png;base64,bm90LWFuLWltYWdl"}]}), json!({"path":"private"}), json!({"assetId":"private"})] {
            let mut bad = document.clone(); bad["inputs"][0]["content"] = bad_content; assert!(validate(&bad).is_err());
        }
    }
    #[test]
    fn layout_round_trip_rejects_private_or_duplicate_members() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        let mut doc = template(); doc["schemaVersion"] = json!(3);
        doc["layout"] = json!([
            {"id":"item1","node":"draw","x":300,"y":40,"width":320,"height":400,"enclosed":true},
            {"id":"item2","type":"text","inputs":[],"content":{"text":"外部文案"},"x":0,"y":0,"width":220,"height":160,"enclosed":false}
        ]);
        let saved = db.workflow_template_save(doc.clone(), 0).unwrap();
        assert_eq!(saved["layout"], doc["layout"]);
        let mut bad = doc.clone(); bad["layout"][0]["assetId"] = json!("private"); assert!(validate(&bad).is_err());
        let mut bad = doc.clone(); bad["layout"][1] = bad["layout"][0].clone(); assert!(validate(&bad).is_err());
        let mut bad = doc.clone(); bad["layout"][0]["width"] = json!(0); assert!(validate(&bad).is_err());
        let mut bad = doc; bad["schemaVersion"] = json!(2); assert!(validate(&bad).is_err());
    }
    fn enclosure_db() -> Database {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
            for (id,x) in [("left",0.),("outside",350.)] {
                conn.execute("INSERT INTO canvas_nodes(id,project_id,kind,payload_json,x,y,width,height,created_at,updated_at) VALUES(?1,'p','note',?2,?3,0,200,150,1,1)", params![id,json!({"schema_version":1,"note_type":"text","cells":[],"text":id}).to_string(),x]).unwrap();
            }
            let doc = json!({"schema_version":1,"nodes":[{"id":"draw","kind":"generation","x":700,"y":0,"inputs":{"text":[{"canvasNodeId":"outside","cellId":"body"}]},"prompt":"unchanged","outputs":{}}],"run":null});
            conn.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p',1,?1)", [doc.to_string()]).unwrap();
        }
        db
    }
    #[test]
    fn enclosure_is_atomic_preserves_wires_and_keeps_unchecked_cards_outside() {
        let db = enclosure_db();
        let members = vec!["left".to_owned(),"draw".to_owned()];
        db.workflow_template_save(template(),0).unwrap();
        // Template CAS failure must roll back canvas movement and container creation too.
        assert!(db.workflow_encapsulate("p",1,"流程",&members,&[],Some(template())).is_err());
        {
            let conn = db.conn.lock().unwrap();
            assert_eq!(conn.query_row("SELECT x FROM canvas_nodes WHERE id='left'",[],|r| r.get::<_,f64>(0)).unwrap(),0.);
            assert_eq!(conn.query_row("SELECT count(*) FROM canvas_nodes",[],|r| r.get::<_,i64>(0)).unwrap(),2);
            assert_eq!(conn.query_row("SELECT revision FROM canvas_workflows WHERE project_id='p'",[],|r| r.get::<_,i64>(0)).unwrap(),1);
        }
        let saved = db.workflow_encapsulate("p",1,"流程",&members,&[],None).unwrap();
        assert_eq!(saved["revision"],2);
        let conn = db.conn.lock().unwrap();
        let (x,raw): (f64,String) = conn.query_row("SELECT x,payload_json FROM canvas_nodes WHERE id=?1",[saved["containerId"].as_str().unwrap()],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert!(x > 550., "enclosure is relocated away from unchecked content");
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["member_ids"],json!(members));
        assert_eq!(conn.query_row("SELECT x FROM canvas_nodes WHERE id='outside'",[],|r| r.get::<_,f64>(0)).unwrap(),350.);
        let left: f64 = conn.query_row("SELECT x FROM canvas_nodes WHERE id='left'",[],|r|r.get(0)).unwrap();
        assert_eq!(saved["document"]["nodes"][0]["x"].as_f64().unwrap()-left,700.);
        assert_eq!(saved["document"]["nodes"][0]["inputs"]["text"][0]["canvasNodeId"],"outside");
        assert_eq!(saved["document"]["nodes"][0]["prompt"],"unchanged");
        drop(conn);
        assert!(db.workflow_encapsulate("p",1,"stale",&members,&[],None).is_err());
        assert!(db.workflow_encapsulate("p",2,"missing",&["missing".into()],&[],None).is_err());
    }
    #[test]
    fn enclosure_supports_native_only_and_rejects_running_workflows() {
        let db = enclosure_db();
        { let conn = db.conn.lock().unwrap(); conn.execute("UPDATE canvas_workflows SET document_json=json_set(document_json,'$.run',json('{\"status\":\"waiting\"}'))",[]).unwrap(); }
        assert!(db.workflow_encapsulate("p",1,"运行中",&["left".into()],&[],None).is_err());
        db.conn.lock().unwrap().execute("DELETE FROM canvas_workflows",[]).unwrap();
        let saved = db.workflow_encapsulate("p",0,"内容容器",&["left".into()],&[],None).unwrap();
        assert_eq!(saved["revision"],1); assert_eq!(saved["document"]["nodes"],json!([]));
        let second = db.workflow_encapsulate("p",1,"新容器",&["left".into()],&[],None).unwrap();
        assert_eq!(second["revision"],2);
        let hidden: Option<i64> = db.conn.lock().unwrap().query_row("SELECT hidden_at FROM canvas_nodes WHERE id=?1",[saved["containerId"].as_str().unwrap()],|r|r.get(0)).unwrap();
        assert!(hidden.is_some(), "regrouping removes the now-empty former enclosure");
    }
}
