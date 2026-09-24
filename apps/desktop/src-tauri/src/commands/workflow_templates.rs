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
    fields(value, &["format", "schemaVersion", "id", "revision", "name", "description", "plan", "inputs", "parameters", "outputs"])?;
    if value.to_string().len() > 32_000_000 || value["format"] != "bowerbird-workflow-template" || !matches!(value["schemaVersion"].as_i64(), Some(1 | 2))
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
    let input_fields = if value["schemaVersion"] == 2 { vec!["id", "label", "type", "content"] } else { vec!["id", "label", "type"] };
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
        let id = document["id"].as_str().unwrap().to_owned();
        let mut conn = self.conn.lock().unwrap(); let tx = conn.transaction()?;
        let current = tx.query_row("SELECT revision FROM workflow_templates WHERE id=?1", [&id], |r| r.get::<_, i64>(0)).optional()?.unwrap_or(0);
        if current != expected_revision { return Err(AppError::Other("模板已被修改，请重新打开模板库".into())); }
        document["revision"] = (current + 1).into();
        tx.execute("INSERT INTO workflow_templates(id,revision,document_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json,updated_at=excluded.updated_at",
            params![id, current + 1, document.to_string(), chrono::Utc::now().timestamp_millis()])?;
        tx.commit()?; Ok(document)
    }
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
pub fn workflow_template_export(db: State<'_, Arc<Database>>, id: String, path: String) -> AppResult<()> {
    if !path.to_ascii_lowercase().ends_with(".json") { return Err(AppError::Other("请选择 .json 流程文件".into())); }
    let raw: String = db.conn.lock().unwrap().query_row("SELECT document_json FROM workflow_templates WHERE id=?1", [id], |r| r.get(0))?;
    let document: Value = serde_json::from_str(&raw)?; validate(&document)?;
    std::fs::write(path, serde_json::to_vec_pretty(&document)?)?; Ok(())
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
}
