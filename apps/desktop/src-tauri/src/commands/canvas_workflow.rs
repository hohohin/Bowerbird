//! Versioned, local workflow definitions. Provider jobs keep their existing authority.
use std::{collections::{HashMap, HashSet}, sync::Arc};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use crate::{db::Database, error::{AppError, AppResult}};
use crate::cloud::{AuthClient, EntitlementService};
use crate::core::project_canvas::{NewCanvasNode, insert_node_tx, touch_canvas_tx};

pub(crate) async fn require_pro(auth: &AuthClient, entitlement: &EntitlementService) -> AppResult<()> {
    let snapshot = entitlement.current_or_sync(auth).await;
    let login = auth.snapshot();
    if !login.logged_in || snapshot.user_id.is_empty() || login.user_id.as_deref() != Some(snapshot.user_id.as_str())
        || !matches!(snapshot.tier.as_str(), "pro" | "studio")
        || !matches!(snapshot.offline_state, Some(crate::cloud::entitlement::OfflineState::Fresh | crate::cloud::entitlement::OfflineState::Grace)) {
        return Err(AppError::Other("工作流卡片的创建、编辑和运行需要 Pro；已有结果仍可查看和导出".into()));
    }
    Ok(())
}

// Existing accepted runs can finish after expiry. Results do not change the paid definition.
fn paid_definition(document: &Value) -> Vec<Value> {
    document["nodes"].as_array().into_iter().flatten().filter(|n| n["kind"] != "text")
        .map(|node| {
            let mut node = node.clone();
            if let Some(fields) = node.as_object_mut() {
                for key in ["outputs","outputPorts","sessionNodeIds","activeSessionNodeId","resultNodeIds","resultGroupId","completionSeen","triggerCount","describeCache","profileCache"] { fields.remove(key); }
            }
            node
        }).collect()
}

fn has_new_run(before: &Value, after: &Value) -> bool {
    let ids = |doc: &Value| -> HashSet<String> {
        doc["runs"].as_array().into_iter().flatten().chain(std::iter::once(&doc["run"]))
            .filter_map(|r| r["id"].as_str().map(str::to_owned)).collect()
    };
    !ids(after).is_subset(&ids(before))
}

#[tauri::command]
pub async fn canvas_workflow_authorize(auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>) -> AppResult<()> {
    require_pro(&auth, &entitlement).await
}

#[derive(Serialize)]
pub struct WorkflowSnapshot { revision: i64, document: Value }

fn invalid() -> AppError { AppError::Other("工作流数据无效".into()) }

fn validate_image_output(value: &Value, assets: &mut HashSet<String>) -> AppResult<()> {
    // An asynchronous image output may contain only exact generation-session references.
    if value.get("assetIds").is_none() && value.get("nodeIds").is_none() { return Err(invalid()); }
    if let Some(ids) = value.get("nodeIds") {
        if ids.as_array().is_none_or(|ids| ids.iter().any(|id| id.as_str().is_none_or(str::is_empty))) { return Err(invalid()); }
    }
    if let Some(ids) = value.get("assetIds") {
        for asset in ids.as_array().ok_or_else(invalid)? {
            assets.insert(asset.as_str().ok_or_else(invalid)?.to_owned());
        }
    }
    Ok(())
}

fn validate_loop(run: &Value, nodes: &[Value], assets: &mut HashSet<String>) -> AppResult<()> {
    let Some(state) = run.get("loop") else { return Ok(()); };
    let owner = state["nodeId"].as_str().ok_or_else(invalid)?;
    if !nodes.iter().any(|node| node["id"] == owner && node["kind"] == "loop") { return Err(invalid()); }
    let order = run["order"].as_array().ok_or_else(invalid)?;
    if !order.contains(&json!(owner)) { return Err(invalid()); }
    let body = state["bodyIds"].as_array().filter(|body| !body.is_empty()).ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    for id in body {
        let key = id.as_str().ok_or_else(invalid)?;
        if key == owner || !order.contains(id) || !ids.insert(key) { return Err(invalid()); }
    }
    let index = state["index"].as_u64().ok_or_else(invalid)? as usize;
    let start_index = match state.get("startIndex") {
        Some(value) => value.as_u64().filter(|index| *index < 100).ok_or_else(invalid)? as usize,
        None => 0,
    };
    let completed = state["completed"].as_array().ok_or_else(invalid)?;
    if let Some(items) = state.get("items") {
        let items = items.as_array().filter(|items| !items.is_empty() && items.len() <= 100).ok_or_else(invalid)?;
        let processed = start_index + completed.len();
        if start_index >= items.len() || index >= items.len() || !(processed == index || processed == items.len() && index + 1 == items.len()) { return Err(invalid()); }
        if run["status"] == "done" && processed != items.len() { return Err(invalid()); }
        for item in items {
            if !item["text"].is_string() { return Err(invalid()); }
            for asset in item["assetIds"].as_array().ok_or_else(invalid)? {
                assets.insert(asset.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?.to_owned());
            }
        }
    } else if index != start_index || !completed.is_empty() || run["status"] == "done" { return Err(invalid()); }
    for item in completed {
        let outputs = item["outputs"].as_object().ok_or_else(invalid)?;
        let steps = item["steps"].as_object().ok_or_else(invalid)?;
        if outputs.len() != ids.len() || steps.len() != ids.len()
            || outputs.keys().any(|id| !ids.contains(id.as_str()))
            || steps.iter().any(|(id, step)| !ids.contains(id.as_str()) || step["status"] != "done") { return Err(invalid()); }
        for ports in outputs.values() {
            for value in ports.as_object().ok_or_else(invalid)?.values() {
                if !matches!(value["type"].as_str(), Some("text" | "image" | "visual-profile" | "session")) { return Err(invalid()); }
                if value["type"] == "image" {
                    validate_image_output(value, assets)?;
                } else if let Some(list) = value.get("assetIds") {
                    for asset in list.as_array().ok_or_else(invalid)? {
                        assets.insert(asset.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?.to_owned());
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn validate(document: &Value) -> AppResult<HashSet<String>> {
    if document["schema_version"] != 1 || document.to_string().len() > 2_000_000 { return Err(invalid()); }
    let nodes = document["nodes"].as_array().ok_or_else(invalid)?;
    if nodes.len() > 500 { return Err(invalid()); }
    let mut ids = HashSet::new();
    let mut assets = HashSet::new();
    let mut dependencies: HashMap<&str, Vec<&str>> = HashMap::new();
    for node in nodes {
        let id = node["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?;
        if !ids.insert(id) || !matches!(node["kind"].as_str(), Some("instruction" | "generation" | "skill" | "agent" | "comfy-video" | "visual-profile" | "text" | "trigger" | "planner" | "loop"))
            || !matches!(node["action"].as_str(), Some("describe" | "reuse" | "layers"))
            || node["x"].as_f64().filter(|v| v.is_finite()).is_none()
            || node["y"].as_f64().filter(|v| v.is_finite()).is_none()
            || !node["prompt"].is_string() || !node["provider"].is_string()
            || !node["trigger"].is_boolean() || !node["outputPorts"].is_array() { return Err(invalid()); }
        let inputs = node["inputs"].as_object().ok_or_else(invalid)?;
        if node["kind"] == "planner" && (node["trigger"] != false || inputs.keys().any(|key| key != "text" && key != "image")
            || node["outputs"].as_object().is_none_or(|outputs| !outputs.is_empty()) || node["outputPorts"].as_array().is_none_or(|ports| !ports.is_empty())) { return Err(invalid()); }
        if node["kind"] == "trigger" && inputs.keys().any(|key| key != "completion") { return Err(invalid()); }
        if node.get("triggerCount").is_some_and(|count| node["kind"] != "trigger" || count.as_u64().is_none_or(|count| count > 9999)) { return Err(invalid()); }
        if let Some(seen) = node.get("completionSeen") {
            if node["kind"] != "trigger" { return Err(invalid()); }
            let mut unique = HashSet::new();
            for session in seen.as_array().ok_or_else(invalid)? {
                if !unique.insert(session.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?) { return Err(invalid()); }
            }
        }
        if node["kind"] == "loop" {
            if node.get("loopMode").is_some_and(|mode| !matches!(mode.as_str(), Some("images" | "rows" | "count"))) { return Err(invalid()); }
            if node.get("loopStartItem").is_some_and(|value| value.as_u64().is_none_or(|item| !(1..=100).contains(&item))) { return Err(invalid()); }
            if node["loopMode"] == "count" {
                if node["loopCount"].as_u64().is_none_or(|count| !(1..=100).contains(&count)) { return Err(invalid()); }
            } else if node.get("loopCount").is_some() { return Err(invalid()); }
            let port = if node["loopMode"] == "count" { "signal" } else if node["loopMode"] == "rows" { "text" } else { "image" };
            if inputs.keys().any(|key| key != port && key != "signal") { return Err(invalid()); }
        }
        if node["kind"] == "text" && node["textSource"].is_string() {
            if node["textSource"].as_str().is_none_or(str::is_empty) || inputs.keys().any(|key| key != "signal") || node.get("textTarget").is_some() { return Err(invalid()); }
            if nodes.iter().any(|other| other["id"] != node["id"] && other["textSource"] == node["textSource"]) { return Err(invalid()); }
        } else if node["kind"] == "text" {
            if node["textTarget"]["nodeId"].as_str().is_none_or(str::is_empty)
                || node["textTarget"]["cellId"].as_str().is_none_or(str::is_empty)
                || inputs.values().filter_map(Value::as_array).map(Vec::len).sum::<usize>() != 1
                || inputs.keys().any(|key| key != "text" && key != "image") { return Err(invalid()); }
            if nodes.iter().any(|other| other["id"] != node["id"] && other["kind"] == "text" && other["textTarget"]["nodeId"] == node["textTarget"]["nodeId"] && other["textTarget"]["cellId"] == node["textTarget"]["cellId"]) { return Err(invalid()); }
            if let Some(axis) = node["textTarget"].get("appendAxis") {
                if !matches!(axis.as_str(), Some("row" | "column")) || node["textTarget"]["append"] != true { return Err(invalid()); }
                let cells = node["textTarget"]["axisCellIds"].as_array().filter(|cells| !cells.is_empty()).ok_or_else(invalid)?;
                let mut unique = HashSet::new();
                for cell in cells {
                    let id = cell.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?;
                    if !unique.insert(id) { return Err(invalid()); }
                }
                if node["textTarget"].get("axisOffset").is_some_and(|offset| offset.as_u64().is_none()) { return Err(invalid()); }
            }
            if let Some(value) = node["textTarget"].get("cellIds") {
                let cells = value.as_array().ok_or_else(invalid)?;
                let mut unique = HashSet::new();
                for cell in cells {
                    let id = cell.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?;
                    if !unique.insert(id) || nodes.iter().any(|other| other["id"] != node["id"] && other["textTarget"]["nodeId"] == node["textTarget"]["nodeId"]
                        && (other["textTarget"]["cellId"] == *cell || other["textTarget"]["cellIds"].as_array().is_some_and(|ids| ids.contains(cell)))) { return Err(invalid()); }
                }
            }
        }
        let mut deps = Vec::new();
        for (port, bindings) in inputs {
            if port == "completion" {
                if node["kind"] != "trigger" { return Err(invalid()); }
                for binding in bindings.as_array().ok_or_else(invalid)? {
                    if binding.get("canvasNodeId").is_some() {
                        if binding["canvasNodeId"].as_str().is_none_or(str::is_empty) || binding["cellId"] != "image"
                            || binding.as_object().is_none_or(|value| value.len() != 2) { return Err(invalid()); }
                        continue;
                    }
                    let producer = nodes.iter().find(|source| source["id"] == binding["nodeId"]).ok_or_else(invalid)?;
                    if matches!(producer["kind"].as_str(), Some("trigger" | "planner")) || producer.get("textSource").is_some()
                        || !matches!(binding["portId"].as_str(), Some("text" | "image" | "visual-profile" | "iteration"))
                        || binding.as_object().is_none_or(|value| value.len() != 2) { return Err(invalid()); }
                }
                continue; // Completion events do not participate in the data dependency DAG.
            }
            let image_port = port == "image" || node["kind"] == "comfy-video" && matches!(port.as_str(), "first-frame" | "last-frame");
            if !image_port && !matches!(port.as_str(), "text" | "visual-profile" | "signal") { return Err(invalid()); }
            for binding in bindings.as_array().ok_or_else(invalid)? {
                if port == "signal" {
                    let producer = nodes.iter().find(|node| node["id"] == binding["nodeId"]).ok_or_else(invalid)?;
                    if producer["kind"] != "trigger" || binding["portId"] != "signal" || binding.as_object().is_none_or(|value| value.len() != 2) { return Err(invalid()); }
                    deps.push(producer["id"].as_str().ok_or_else(invalid)?);
                    continue;
                }
                if binding["portId"] == "signal" { return Err(invalid()); }
                if binding["groupId"].is_string() {
                    if !image_port || binding.get("nodeId").is_some() || binding.get("assetId").is_some() || binding.get("canvasNodeId").is_some() { return Err(invalid()); }
                    for asset in binding["assetIds"].as_array().ok_or_else(invalid)? {
                        assets.insert(asset.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?.to_owned());
                    }
                } else if let Some(asset) = binding["assetId"].as_str() {
                    if !image_port || binding.get("nodeId").is_some() { return Err(invalid()); }
                    assets.insert(asset.to_owned());
                } else if binding["canvasNodeId"].is_string() {
                    if (port != "text" && !image_port) || !binding["cellId"].is_string() || binding.get("nodeId").is_some() { return Err(invalid()); }
                    if matches!(binding["cellId"].as_str(), Some("*" | "*text" | "*latest" | "*latest-image")) {
                        if (matches!(binding["cellId"].as_str(), Some("*" | "*latest-image")) && !image_port)
                            || (matches!(binding["cellId"].as_str(), Some("*text" | "*latest")) && port != "text") { return Err(invalid()); }
                        for producer in nodes.iter().filter(|node| node["kind"] == "text" && node["textTarget"]["nodeId"] == binding["canvasNodeId"]) {
                            deps.push(producer["id"].as_str().ok_or_else(invalid)?);
                        }
                    }
                    if let Some(producer) = nodes.iter().find(|node| node["kind"] == "text" && node["textTarget"]["nodeId"] == binding["canvasNodeId"] && (node["textTarget"]["cellId"] == binding["cellId"] || node["textTarget"]["cellIds"].as_array().is_some_and(|ids| ids.contains(&binding["cellId"]))))
                        .or_else(|| nodes.iter().find(|node| node["resultNodeIds"].as_array().is_some_and(|ids| ids.contains(&binding["canvasNodeId"])))) {
                        deps.push(producer["id"].as_str().ok_or_else(invalid)?);
                    }
                } else {
                    if nodes.iter().any(|node| node["id"] == binding["nodeId"] && node["kind"] == "planner") { return Err(invalid()); }
                    deps.push(binding["nodeId"].as_str().ok_or_else(invalid)?);
                    if !binding["portId"].is_string() { return Err(invalid()); }
                }
            }
        }
        dependencies.insert(id, deps);
        for value in node["outputs"].as_object().ok_or_else(invalid)?.values() {
            match value["type"].as_str() {
                Some("session") if value["nodeIds"].as_array().is_some_and(|ids| ids.iter().all(|id| id.is_string())) => {},
                Some("image") => validate_image_output(value, &mut assets)?,
                Some("text") if value["text"].is_string() => {
                    if let Some(ids) = value.get("assetIds") {
                        for asset in ids.as_array().ok_or_else(invalid)? {
                            assets.insert(asset.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?.to_owned());
                        }
                    }
                },
                Some("visual-profile") if value["profileId"].as_str().is_some_and(|id| !id.is_empty()) && value["version"].as_i64().is_some_and(|v| v > 0) => {},
                _ => return Err(invalid()),
            }
        }
    }
    let mut settled = HashSet::new();
    while settled.len() < nodes.len() {
        let before = settled.len();
        for (id, deps) in &dependencies {
            if deps.iter().any(|dep| !ids.contains(dep)) { return Err(invalid()); }
            if deps.iter().all(|dep| settled.contains(dep)) { settled.insert(*id); }
        }
        if before == settled.len() { return Err(AppError::Other("工作流包含循环".into())); }
    }
    let runs = match document.get("runs") {
        Some(value) => value.as_array().ok_or_else(invalid)?.iter().collect::<Vec<_>>(),
        None => if document["run"].is_null() { vec![] } else { vec![&document["run"]] },
    };
    let mut run_ids = HashSet::new();
    let mut accesses: Vec<(HashSet<&str>, HashSet<&str>)> = Vec::new();
    for run in runs {
        if let Some(queue) = run.get("triggerQueue") {
            for id in queue.as_array().ok_or_else(invalid)? {
                if !nodes.iter().any(|node| node["id"] == *id && node["kind"] == "trigger") { return Err(invalid()); }
            }
        }
        validate_loop(run, nodes, &mut assets)?;
        if run["order"].as_array().is_some_and(|order| order.iter().any(|id| nodes.iter().any(|node| node["id"] == *id && node["kind"] == "planner"))) { return Err(invalid()); }
        if !matches!(run["status"].as_str(), Some("running" | "waiting" | "done" | "failed" | "stopped"))
            || !run["id"].is_string() || !run["threadId"].is_string()
            || !run["steps"].is_object()
            || run["order"].as_array().ok_or_else(invalid)?.iter().any(|id| id.as_str().is_none_or(|id| !ids.contains(id))) { return Err(invalid()); }
        if !run_ids.insert(run["id"].as_str().ok_or_else(invalid)?) { return Err(invalid()); }
        if matches!(run["status"].as_str(), Some("running" | "waiting")) {
            let locked = run.get("lockedNodeIds").unwrap_or(&run["order"]).as_array().ok_or_else(invalid)?;
            let mut reads_and_writes = HashSet::new();
            for id in locked {
                let id = id.as_str().ok_or_else(invalid)?;
                if !ids.contains(id) || !reads_and_writes.insert(id) { return Err(invalid()); }
            }
            let mut writes = HashSet::new();
            for id in run.get("writeNodeIds").unwrap_or(&run["order"]).as_array().ok_or_else(invalid)? {
                let id = id.as_str().ok_or_else(invalid)?;
                if !reads_and_writes.contains(id) || !writes.insert(id) { return Err(invalid()); }
            }
            if run["order"].as_array().ok_or_else(invalid)?.iter().any(|id| !writes.contains(id.as_str().unwrap()))
                || accesses.iter().any(|(other_access, other_writes)| !writes.is_disjoint(other_access) || !other_writes.is_disjoint(&reads_and_writes)) { return Err(invalid()); }
            accesses.push((reads_and_writes, writes));
        }
    }
    Ok(assets)
}

impl Database {
    fn workflow_get(&self, project_id: &str) -> AppResult<WorkflowSnapshot> {
        let conn = self.conn.lock().unwrap();
        let value: Option<(i64, String)> = conn.query_row("SELECT revision,document_json FROM canvas_workflows WHERE project_id=?1", [project_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        match value {
            Some((revision, raw)) => Ok(WorkflowSnapshot { revision, document: serde_json::from_str(&raw)? }),
            None => Ok(WorkflowSnapshot { revision: 0, document: json!({"schema_version":1,"nodes":[],"run":null}) }),
        }
    }
    fn workflow_save(&self, project_id: &str, revision: i64, document: Value) -> AppResult<i64> {
        self.workflow_save_with_content(project_id, revision, document, None)
    }
    fn workflow_save_with_content(&self, project_id: &str, revision: i64, document: Value, created_content: Option<&NewCanvasNode>) -> AppResult<i64> {
        let assets = validate(&document)?;
        if let Some(card) = created_content {
            let payload: Value = serde_json::from_str(&card.payload_json)?;
            if card.project_id != project_id || card.kind != crate::core::creative_session_contract::CreativeNodeKind::Note
                || card.thread_id.is_some() || card.asset_id.is_some() || card.role.is_some()
                || payload["note_type"] != "text"
                || !document["nodes"].as_array().unwrap().iter().any(|node| node["kind"] == "text"
                    && node["textTarget"]["nodeId"] == card.id && node["textTarget"]["image"] == true) {
                return Err(invalid());
            }
        }
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: i64 = tx.query_row("SELECT revision FROM canvas_workflows WHERE project_id=?1", [project_id], |r| r.get(0)).optional()?.unwrap_or(0);
        if current != revision { return Err(AppError::Other("工作流已被其他窗口修改，请重新打开项目".into())); }
        if let Some(card) = created_content {
            let now = chrono::Utc::now().timestamp();
            touch_canvas_tx(&tx, project_id, now)?;
            insert_node_tx(&tx, card, now)?;
        }
        for asset in assets {
            // Missing assets remain explicit broken inputs; never resurrect deleted files.
            tx.execute("INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at) SELECT ?1,id,strftime('%s','now')*1000 FROM assets WHERE id=?2", params![project_id, asset])?;
        }
        tx.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES (?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json", params![project_id, revision + 1, document.to_string()])?;
        tx.commit()?;
        Ok(revision + 1)
    }
}

#[tauri::command]
pub async fn canvas_workflow_get(db: State<'_, Arc<Database>>, project_id: String) -> AppResult<WorkflowSnapshot> { db.workflow_get(&project_id) }
#[tauri::command]
pub async fn canvas_workflow_save(db: State<'_, Arc<Database>>, auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, project_id: String, revision: i64, document: Value, created_content: Option<NewCanvasNode>) -> AppResult<i64> {
    let before = db.workflow_get(&project_id)?.document;
    if created_content.is_some() || paid_definition(&before) != paid_definition(&document) || (has_new_run(&before,&document) && !paid_definition(&document).is_empty()) {
        require_pro(&auth, &entitlement).await?;
    }
    db.workflow_save_with_content(&project_id, revision, document, created_content.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paid_edits_and_new_runs_are_distinct_from_accepted_results() {
        let before=json!({"nodes":[node("paid",json!({}))],"runs":[{"id":"accepted"}],"run":null});
        let mut result=before.clone(); result["nodes"][0]["outputs"]=json!({"image":{"type":"image","assetIds":["result"]}});
        assert_eq!(paid_definition(&before),paid_definition(&result));
        assert!(!has_new_run(&before,&result));
        result["nodes"][0]["prompt"]=json!("changed"); assert_ne!(paid_definition(&before),paid_definition(&result));
        result["runs"]=json!([{"id":"accepted"},{"id":"new"}]); assert!(has_new_run(&before,&result));
        assert!(paid_definition(&json!({"nodes":[{"id":"text","kind":"text"}]})).is_empty());
    }
    fn node(id: &str, inputs: Value) -> Value { json!({"id":id,"kind":"generation","action":"describe","x":0,"y":0,"prompt":"test","provider":"codex","trigger":false,"inputs":inputs,"outputs":{},"outputPorts":[]}) }
    #[test]
    fn comfy_video_frame_ports_and_single_video_survive_storage() {
        let db=Database::open_in_memory().unwrap();db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)",[]).unwrap();
        let mut card=node("h3",json!({"first-frame":[{"assetId":"first"}],"last-frame":[{"assetId":"last"}],"text":[{"nodeId":"source","portId":"text"}]}));
        card["kind"]=json!("comfy-video");card["comfyVideo"]=json!({"seconds":11,"ratio":"4:3","resolution":0.6,"endpoint":"http://127.0.0.1:8000"});
        card["outputs"]=json!({"image":{"type":"image","assetIds":["video"]}});
        let doc=json!({"schema_version":1,"nodes":[node("source",json!({})),card],"run":null});
        assert_eq!(validate(&doc).unwrap(),HashSet::from(["first".into(),"last".into(),"video".into()]));
        db.workflow_save("p",0,doc.clone()).unwrap();assert_eq!(db.workflow_get("p").unwrap().document,doc);
        let mut invalid_doc=doc.clone();invalid_doc["nodes"][1]["kind"]=json!("generation");assert!(validate(&invalid_doc).is_err());
    }
    #[test]
    fn agent_image_session_output_roundtrips_without_finished_assets() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut agent = node("agent", json!({})); agent["kind"] = json!("agent");
        let mut doc = json!({"schema_version":1,"nodes":[agent],"run":null});
        for (revision, value) in [
            json!({"type":"image","nodeIds":["gen-prompt:original-job:original-turn:0"]}),
            json!({"type":"image","assetIds":["existing-image"],"nodeIds":["gen-prompt:original-job:original-turn:0"]}),
            json!({"type":"image","assetIds":[]}),
            json!({"type":"session","nodeIds":["legacy-session"]}),
        ].into_iter().enumerate() {
            doc["nodes"][0]["outputs"] = json!({"image":value});
            let assets = validate(&doc).unwrap();
            assert_eq!(assets, if revision == 1 { HashSet::from(["existing-image".to_owned()]) } else { HashSet::new() });
            db.workflow_save("p", revision as i64, doc.clone()).unwrap();
            assert_eq!(db.workflow_get("p").unwrap().document, doc);
        }
        for value in [
            json!({"type":"image"}), json!({"type":"image","nodeIds":"session"}),
            json!({"type":"image","nodeIds":[12]}), json!({"type":"image","nodeIds":[""]}),
            json!({"type":"image","assetIds":[],"nodeIds":null}),
            json!({"type":"image","assetIds":[12],"nodeIds":["session"]}),
        ] {
            doc["nodes"][0]["outputs"] = json!({"image":value});
            assert!(validate(&doc).is_err());
        }
    }

    #[test]
    fn loop_checkpoint_roundtrip_and_completed_asset_references() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut owner = node("loop", json!({"image":[{"assetId":"input"}]})); owner["kind"] = json!("loop");
        let run = json!({"id":"run","startId":"loop","threadId":"thread","status":"waiting","order":["loop","draw"],
            "steps":{"loop":{"status":"done"},"draw":{"status":"waiting","jobId":"original-job"}},
            "loop":{"nodeId":"loop","bodyIds":["draw"],"index":1,"items":[{"text":"","assetIds":["input"]},{"text":"","assetIds":["second"]}],
                "completed":[{"outputs":{"draw":{"image":{"type":"image","assetIds":["first-output"]}}},"steps":{"draw":{"status":"done","jobId":"first-job"}}}]}});
        let doc = json!({"schema_version":1,"nodes":[owner,node("draw",json!({"image":[{"nodeId":"loop","portId":"image"}]}))],"run":run.clone(),"runs":[run]});
        assert_eq!(validate(&doc).unwrap(), HashSet::from(["input".to_owned(),"second".to_owned(),"first-output".to_owned()]));
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
        assert!(db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p'", []).is_err());
        for patch in [json!({"index":2}),json!({"completed":[]}),json!({"bodyIds":["loop"]}),json!({"bodyIds":["missing"]}),json!({"bodyIds":["draw","draw"]})] {
            let mut invalid_doc = doc.clone();
            for (key, value) in patch.as_object().unwrap() { invalid_doc["runs"][0]["loop"][key] = value.clone(); }
            assert!(validate(&invalid_doc).is_err(), "{patch}");
        }
        let mut done = doc.clone();
        done["runs"][0]["loop"]["completed"].as_array_mut().unwrap().push(doc["runs"][0]["loop"]["completed"][0].clone());
        done["runs"][0]["status"] = json!("done");
        assert!(validate(&done).is_ok());
        // A completed Agent iteration keeps the submitted turn, even before pixels exist.
        let mut sessions = doc.clone();
        sessions["runs"][0]["loop"]["completed"][0]["outputs"]["draw"]["image"] = json!({"type":"image","nodeIds":["original-session"]});
        assert_eq!(validate(&sessions).unwrap(), HashSet::from(["input".to_owned(),"second".to_owned()]));
        db.workflow_save("p", 1, sessions.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, sessions);
        sessions["runs"][0]["loop"]["completed"][0]["outputs"]["draw"]["image"]["nodeIds"] = json!([12]);
        assert!(validate(&sessions).is_err());
    }
    #[test]
    fn loop_modes_and_unprepared_checkpoint_are_validated() {
        let mut owner = node("loop", json!({})); owner["kind"] = json!("loop");
        let mut doc = json!({"schema_version":1,"nodes":[owner,node("draw",json!({"image":[{"nodeId":"loop","portId":"image"}]}))],"run":null});
        assert!(validate(&doc).is_ok());
        doc["nodes"][0]["loopMode"] = json!("unknown"); assert!(validate(&doc).is_err());
        doc["nodes"][0]["loopMode"] = json!("rows");
        doc["nodes"][0]["inputs"] = json!({"image":[{"assetId":"a"}]}); assert!(validate(&doc).is_err());
        doc["nodes"][0]["inputs"] = json!({"text":[{"canvasNodeId":"table","cellId":"*text"}]});
        doc["run"] = json!({"id":"r","threadId":"t","status":"waiting","order":["loop","draw"],"steps":{},"loop":{"nodeId":"loop","bodyIds":["draw"],"index":0,"completed":[]}});
        assert!(validate(&doc).is_ok());
        doc["run"]["loop"]["index"] = json!(1); assert!(validate(&doc).is_err());
    }
    #[test]
    fn count_loop_requires_bounded_count_and_no_content_input() {
        let mut owner = node("loop", json!({})); owner["kind"] = json!("loop");
        owner["loopMode"] = json!("count"); owner["loopCount"] = json!(3);
        let mut doc = json!({"schema_version":1,"nodes":[owner,node("draw",json!({"text":[{"nodeId":"loop","portId":"iteration"}]}))],"run":null});
        assert!(validate(&doc).is_ok());
        for count in [json!(0), json!(101), json!(1.5), json!("3"), Value::Null] {
            doc["nodes"][0]["loopCount"] = count; assert!(validate(&doc).is_err());
        }
        doc["nodes"][0]["loopCount"] = json!(100); assert!(validate(&doc).is_ok());
        doc["nodes"][0]["inputs"] = json!({"image":[{"assetId":"a"}]}); assert!(validate(&doc).is_err());
        doc["nodes"][0]["inputs"] = json!({}); doc["nodes"][0]["loopMode"] = json!("images"); assert!(validate(&doc).is_err());
    }
    #[test]
    fn loop_selected_start_and_offset_completion_are_validated() {
        let mut owner = node("loop", json!({"image":[{"assetId":"a"}]})); owner["kind"] = json!("loop");
        owner["loopStartItem"] = json!(2);
        let run = json!({"id":"r","threadId":"t","status":"waiting","order":["loop","draw"],"steps":{},
            "loop":{"nodeId":"loop","bodyIds":["draw"],"startIndex":1,"index":1,"completed":[]}});
        let mut doc = json!({"schema_version":1,"nodes":[owner,node("draw",json!({"image":[{"nodeId":"loop","portId":"image"}]}))],"run":run});
        assert!(validate(&doc).is_ok());
        for invalid_item in [json!(0), json!(101), json!(1.5), json!("2"), Value::Null] {
            doc["nodes"][0]["loopStartItem"] = invalid_item; assert!(validate(&doc).is_err());
        }
        doc["nodes"][0]["loopStartItem"] = json!(2);
        doc["run"]["loop"]["items"] = json!([{"text":"甲","assetIds":["a"]},{"text":"乙","assetIds":["b"]}]);
        assert!(validate(&doc).is_ok());
        doc["run"]["status"] = json!("done"); assert!(validate(&doc).is_err());
        doc["run"]["loop"]["completed"] = json!([{"outputs":{"draw":{"image":{"type":"image","assetIds":["result"]}}},"steps":{"draw":{"status":"done"}}}]);
        let assets = validate(&doc).unwrap(); assert!(assets.contains("a") && assets.contains("b") && assets.contains("result"));
        for invalid_start in [json!(0), json!(2), json!(100), json!(-1), json!(0.5)] {
            doc["run"]["loop"]["startIndex"] = invalid_start; assert!(validate(&doc).is_err());
        }
    }
    #[test]
    fn agent_table_and_owned_cells_survive_storage() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut agent = node("agent", json!({})); agent["kind"] = json!("agent");
        agent["outputs"] = json!({"text":{"type":"text","text":"模块\t文案\n写螺\t紫心宝螺", "table":{"columns":["模块","文案"],"rows":[["写螺","紫心宝螺"]]}}});
        let mut writer = node("writer", json!({"text":[{"nodeId":"agent","portId":"text"}]})); writer["kind"] = json!("text");
        writer["textTarget"] = json!({"nodeId":"table","cellId":"a","cellIds":["a","b","c","d"],"tableCellIds":[["a","b"],["c","d"]],"append":true});
        let doc = json!({"schema_version":1,"nodes":[agent,writer],"run":null});
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }
    #[test]
    fn content_axis_targets_survive_storage_and_reject_invalid_axes() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut writer = node("writer", json!({"image":[{"assetId":"image"}]})); writer["kind"] = json!("text");
        writer["textTarget"] = json!({"nodeId":"table","cellId":"b","cellIds":["b","c"],"append":true,"image":true,"appendAxis":"row","axisCellIds":["a","b","c"],"axisOffset":1});
        let mut doc = json!({"schema_version":1,"nodes":[writer],"run":null});
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
        doc["nodes"][0]["textTarget"]["appendAxis"] = json!("column");
        assert!(validate(&doc).is_ok());
        for (key, value) in [("appendAxis", json!("diagonal")), ("append", json!(false)), ("axisCellIds", json!([])), ("axisCellIds", json!(["a", "a"])), ("axisCellIds", json!([""])), ("axisOffset", json!(-1))] {
            let mut invalid = doc.clone(); invalid["nodes"][0]["textTarget"][key] = value;
            assert!(validate(&invalid).is_err(), "{key}");
        }
    }
    #[test]
    fn describe_card_caches_survive_storage_independently() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let cards: Vec<Value> = ["composition", "palette"].into_iter().map(|instruction| {
            let mut card = node(instruction, json!({})); card["kind"] = json!("instruction");
            card["prompt"] = json!(instruction);
            card["describeCache"] = json!({"instruction":instruction,"results":[{"assetId":"same-image","sections":[{"title":"result","body":instruction}]}]});
            card
        }).collect();
        let doc = json!({"schema_version":1,"nodes":cards,"run":null});
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }
    #[test]
    fn template_instance_snapshot_survives_workflow_storage() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut root = node("start", json!({})); root["kind"] = json!("trigger");
        root["templateInstance"] = json!({"template":{"id":"template","revision":2,"name":"海报"},"nodeIds":["start","draw"],"bindings":{},"values":{"brief":"白色背景"},"definitions":["root","draw"]});
        let doc = json!({"schema_version":1,"nodes":[root,node("draw",json!({"signal":[{"nodeId":"start","portId":"signal"}]}))],"run":null});
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }
    #[test]
    fn planner_is_persisted_but_never_an_execution_or_output_node() {
        let mut planner = node("assistant", json!({"image":[{"assetId":"photo"}]}));
        planner["kind"] = json!("planner");
        planner["planning"] = json!({"status":"waiting","requestId":"request"});
        let doc = json!({"schema_version":1,"nodes":[planner],"run":null});
        assert!(validate(&doc).is_ok());
        let mut triggered = doc.clone(); triggered["nodes"][0]["trigger"] = json!(true);
        assert!(validate(&triggered).is_err());
        let mut downstream = doc.clone(); downstream["nodes"].as_array_mut().unwrap().push(node("draw", json!({"text":[{"nodeId":"assistant","portId":"text"}]})));
        assert!(validate(&downstream).is_err());
        let mut running = doc.clone(); running["run"] = json!({"id":"r","threadId":"t","status":"done","order":["assistant"],"steps":{}});
        assert!(validate(&running).is_err());
    }
    #[test]
    fn folder_image_bindings_collect_references_and_reject_wrong_ports() {
        let mut doc = json!({"schema_version":1,"nodes":[node("a",json!({"image":[{"groupId":"folder","assetIds":["first","second"]}]}))],"run":null});
        assert_eq!(validate(&doc).unwrap(), HashSet::from(["first".to_owned(), "second".to_owned()]));
        doc["nodes"][0]["inputs"] = json!({"text":[{"groupId":"folder","assetIds":["first"]}]});
        assert!(validate(&doc).is_err());
        doc["nodes"][0]["inputs"] = json!({"image":[{"groupId":"folder","assetIds":[12]}]});
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn completion_trigger_allows_bounded_feedback_but_not_data_cycles() {
        let mut switch = node("switch", json!({"completion":[{"nodeId":"video","portId":"image"}]}));
        switch["kind"] = json!("trigger"); switch["triggerCount"] = json!(2);
        let mut video = node("video", json!({"signal":[{"nodeId":"switch","portId":"signal"}]}));
        video["kind"] = json!("comfy-video");
        let doc = json!({"schema_version":1,"nodes":[switch,video],"run":null});
        assert!(validate(&doc).is_ok());
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut queued = doc.clone();
        queued["run"] = json!({"id":"run","threadId":"thread","startId":"video","status":"waiting","order":["video"],"steps":{"video":{"status":"done"}},"triggerQueue":["switch"],"lockedNodeIds":["switch","video"],"writeNodeIds":["switch","video"]});
        db.workflow_save("p", 0, queued.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, queued);
        queued["run"]["triggerQueue"] = json!(["missing"]); assert!(validate(&queued).is_err());
        for count in [json!(-1), json!(1.5), json!(10000), json!("2")] {
            let mut bad = doc.clone(); bad["nodes"][0]["triggerCount"] = count; assert!(validate(&bad).is_err());
        }
        let mut zero = doc.clone(); zero["nodes"][0]["triggerCount"] = json!(0); assert!(validate(&zero).is_ok());
        let mut missing = doc.clone(); missing["nodes"][0]["inputs"]["completion"][0]["nodeId"] = json!("missing"); assert!(validate(&missing).is_err());
        let mut self_event = doc.clone(); self_event["nodes"][0]["inputs"]["completion"][0]["nodeId"] = json!("switch"); assert!(validate(&self_event).is_err());
        let mut data_cycle = doc.clone(); data_cycle["nodes"][1]["inputs"]["text"] = json!([{"nodeId":"video","portId":"text"}]); assert!(validate(&data_cycle).is_err());
    }
    #[test]
    fn queued_completion_requires_expanded_execution_scope_before_next_wave() {
        let mut switch = node("switch", json!({"completion":[{"nodeId":"video","portId":"image"}]}));
        switch["kind"] = json!("trigger"); switch["triggerCount"] = json!(1);
        let mut video = node("video", json!({"signal":[{"nodeId":"switch","portId":"signal"}]}));
        video["kind"] = json!("comfy-video");
        // The trigger was armed while this source was running, so it was not initially reserved.
        let mut doc = json!({"schema_version":1,"nodes":[switch,video],"run":{
            "id":"run","threadId":"thread","startId":"video","status":"waiting","order":["video"],
            "steps":{"video":{"status":"done"}},"triggerQueue":["switch"],"lockedNodeIds":["video"],"writeNodeIds":["video"]}});
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        db.workflow_save("p", 0, doc.clone()).unwrap();
        doc["nodes"][0]["triggerCount"] = json!(0);
        doc["run"]["startId"] = json!("switch"); doc["run"]["order"] = json!(["switch","video"]);
        doc["run"]["triggerQueue"] = json!([]);
        doc["run"]["steps"] = json!({"switch":{"status":"pending"},"video":{"status":"pending"}});
        assert!(db.workflow_save("p", 1, doc.clone()).is_err());
        assert_eq!(db.workflow_get("p").unwrap().revision, 1);
        doc["run"]["lockedNodeIds"] = json!(["video","switch"]);
        doc["run"]["writeNodeIds"] = json!(["video","switch"]);
        db.workflow_save("p", 1, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }
    #[test]
    fn completion_trigger_accepts_native_sessions_and_persists_deduplication() {
        let mut switch = node("switch", json!({"completion":[{"canvasNodeId":"session","cellId":"image"}]}));
        switch["kind"] = json!("trigger"); switch["triggerCount"] = json!(1);
        switch["completionSeen"] = json!(["previous-turn"]);
        let doc = json!({"schema_version":1,"nodes":[switch],"run":null});
        assert!(validate(&doc).is_ok());
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
        for binding in [json!({"canvasNodeId":"","cellId":"image"}), json!({"canvasNodeId":"session","cellId":"text"}),
            json!({"assetId":"asset"}), json!({"canvasNodeId":"session","cellId":"image","nodeId":"switch"})] {
            let mut bad = doc.clone(); bad["nodes"][0]["inputs"]["completion"] = json!([binding]); assert!(validate(&bad).is_err());
        }
        for seen in [json!("session"), json!([""]), json!(["turn","turn"]), json!([1])] {
            let mut bad = doc.clone(); bad["nodes"][0]["completionSeen"] = seen; assert!(validate(&bad).is_err());
        }
    }
    #[test]
    fn trigger_signal_targets_cards_without_data_ports() {
        let mut switch = node("switch", json!({}));
        switch["kind"] = json!("trigger");
        let target = node("target", json!({"signal":[{"nodeId":"switch","portId":"signal"}]}));
        let mut doc = json!({"schema_version":1,"nodes":[switch,target],"run":null});
        assert!(validate(&doc).is_ok());
        doc["nodes"][1]["kind"] = json!("text");
        doc["nodes"][1]["textSource"] = json!("table");
        assert!(validate(&doc).is_ok());
        doc["nodes"][0]["kind"] = json!("generation");
        assert!(validate(&doc).is_err());
        doc["nodes"][0]["kind"] = json!("trigger");
        doc["nodes"][0]["inputs"] = json!({"signal":[{"nodeId":"switch","portId":"signal"}]});
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn text_cell_writers_validate_dependencies_and_unique_targets() {
        let mut source = node("source", json!({}));
        source["kind"] = json!("text");
        source["textSource"] = json!("table");
        let mut source_doc = json!({"schema_version":1,"nodes":[source],"run":null});
        assert!(validate(&source_doc).is_ok());
        source_doc["nodes"][0]["inputs"] = json!({"image":[{"assetId":"a"}]});
        assert!(validate(&source_doc).is_err());
        let mut writer = node("writer", json!({"image":[{"assetId":"image"}]}));
        writer["kind"] = json!("text");
        writer["textTarget"] = json!({"nodeId":"table","cellId":"cell"});
        let consumer = node("consumer", json!({"text":[{"canvasNodeId":"table","cellId":"cell"}]}));
        let mut doc = json!({"schema_version":1,"nodes":[writer,consumer],"run":null});
        assert!(validate(&doc).is_ok());
        doc["nodes"][0]["inputs"] = json!({"text":[{"nodeId":"consumer","portId":"text"}]});
        assert!(validate(&doc).is_err());
        doc["nodes"][0]["inputs"] = json!({"image":[{"assetId":"image"}]});
        let mut duplicate = doc["nodes"][0].clone();
        duplicate["id"] = json!("duplicate");
        doc["nodes"].as_array_mut().unwrap().push(duplicate);
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn rejects_cycles_and_missing_dependencies() {
        let mut doc = json!({"schema_version":1,"nodes":[node("a",json!({"image":[{"nodeId":"b","portId":"image"}]})),node("b",json!({}))],"run":null});
        assert!(validate(&doc).is_ok());
        doc["nodes"][1]["inputs"] = json!({"image":[{"nodeId":"a","portId":"image"}]});
        assert!(validate(&doc).is_err());
        doc["nodes"][1]["inputs"] = json!({"image":[{"nodeId":"missing","portId":"image"}]});
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn main_image_input_secondary_slots_are_owned_dependencies() {
        let mut writer = node("writer", json!({"image":[{"assetId":"a"}]}));
        writer["kind"] = json!("text");
        writer["textTarget"] = json!({"nodeId":"table","cellId":"first","cellIds":["first","second"],"append":true,"image":true});
        let consumer = node("consumer", json!({"image":[{"canvasNodeId":"table","cellId":"second"}]}));
        let mut doc = json!({"schema_version":1,"nodes":[writer.clone(),consumer]});
        assert!(validate(&doc).is_ok());
        doc["nodes"][0]["inputs"] = json!({"image":[{"nodeId":"consumer","portId":"image"}]});
        assert!(validate(&doc).is_err());
        let mut other = writer.clone(); other["id"] = json!("other"); other["textTarget"] = json!({"nodeId":"table","cellId":"second"});
        doc["nodes"] = json!([writer,other]);
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn content_text_aggregate_tracks_writers_and_rejects_cycles() {
        let mut writer = node("writer", json!({"text":[{"canvasNodeId":"source","cellId":"cell"}]}));
        writer["kind"] = json!("text"); writer["textTarget"] = json!({"nodeId":"content","cellId":"one"});
        let consumer = node("consumer", json!({"text":[{"canvasNodeId":"content","cellId":"*text"}]}));
        let mut doc = json!({"schema_version":1,"nodes":[writer,consumer]});
        assert!(validate(&doc).is_ok());
        doc["nodes"][0]["inputs"] = json!({"text":[{"nodeId":"consumer","portId":"text"}]});
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn image_container_aggregate_tracks_all_cell_writers() {
        let mut first = node("first", json!({"image":[{"assetId":"a"}]}));
        first["kind"] = json!("text"); first["textTarget"] = json!({"nodeId":"container","cellId":"one","image":true});
        let mut second = first.clone(); second["id"] = json!("second"); second["textTarget"]["cellId"] = json!("two");
        let consumer = node("consumer", json!({"image":[{"canvasNodeId":"container","cellId":"*"}]}));
        let mut doc = json!({"schema_version":1,"nodes":[first,second,consumer],"run":null});
        assert!(validate(&doc).is_ok());
        doc["nodes"][1]["inputs"] = json!({"image":[{"nodeId":"consumer","portId":"image"}]});
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn latest_row_selectors_validate_types_and_track_every_writer() {
        for (port, selector) in [("text", "*latest"), ("image", "*latest-image"), ("first-frame", "*latest-image"), ("last-frame", "*latest-image")] {
            let mut first = node("first", json!({"image":[{"assetId":"a"}]}));
            first["kind"] = json!("text"); first["textTarget"] = json!({"nodeId":"container","cellId":"one","image":true});
            let mut second = first.clone(); second["id"] = json!("second"); second["textTarget"]["cellId"] = json!("two");
            let mut consumer = node("consumer", json!({port:[{"canvasNodeId":"container","cellId":selector}]}));
            if port.ends_with("-frame") { consumer["kind"] = json!("comfy-video"); }
            let mut doc = json!({"schema_version":1,"nodes":[first,second,consumer],"run":null});
            assert!(validate(&doc).is_ok(), "{port}: {selector}");
            doc["nodes"][1]["inputs"] = json!({"image":[{"nodeId":"consumer","portId":"image"}]});
            assert!(validate(&doc).is_err(), "latest must include later writers in cycle detection");
        }
        for (port, selector) in [("image", "*latest"), ("text", "*latest-image")] {
            let doc = json!({"schema_version":1,"nodes":[node("consumer",json!({port:[{"canvasNodeId":"container","cellId":selector}]}))]});
            assert!(validate(&doc).is_err(), "{selector} cannot feed {port}");
        }
    }
    #[test]
    fn rejects_cycles_through_generated_text_tables() {
        let mut producer = node("describe", json!({}));
        producer["resultNodeIds"] = json!(["table"]);
        let consumer = node("generate", json!({"text":[{"canvasNodeId":"table","cellId":"prompt"}]}));
        let mut doc = json!({"schema_version":1,"nodes":[producer,consumer],"run":null});
        assert!(validate(&doc).is_ok());
        doc["nodes"][0]["inputs"] = json!({"text":[{"nodeId":"generate","portId":"text"}]});
        assert!(validate(&doc).is_err());
    }
    #[test]
    fn revision_and_running_delete_guard() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let doc = json!({"schema_version":1,"nodes":[node("a",json!({}))],"run":null});
        assert_eq!(db.workflow_save("p", 0, doc.clone()).unwrap(), 1);
        assert!(db.workflow_save("p", 0, doc.clone()).is_err());
        let mut running = doc; running["run"] = json!({"id":"run","threadId":"t","status":"waiting","steps":{},"order":["a"]});
        db.workflow_save("p", 1, running).unwrap();
        assert!(db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p'", []).is_err());
        assert_eq!(db.workflow_get("p").unwrap().revision, 2);
    }
    #[test]
    fn generation_content_connection_is_atomic_with_workflow() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        db.ensure_project_canvas("p").unwrap();
        let card: NewCanvasNode = serde_json::from_value(json!({"id":"relay","projectId":"p","threadId":null,"kind":"note","assetId":null,"role":null,
            "payloadJson":json!({"schema_version":1,"note_type":"text","text":"","member_ids":[],"cells":[[{"id":"cell","text":"","bold":false,"italic":false,"align":"left","content_type":"image"}]]}).to_string(),
            "x":200,"y":100,"width":200,"height":166,"zIndex":1,"positionLocked":false})).unwrap();
        let mut writer = node("writer", json!({"image":[{"nodeId":"source","portId":"image"}]}));
        writer["kind"] = json!("text"); writer["textTarget"] = json!({"nodeId":"relay","cellId":"cell","image":true,"append":true});
        let doc = json!({"schema_version":1,"nodes":[node("source",json!({})),writer,node("target",json!({"image":[{"canvasNodeId":"relay","cellId":"*latest-image"}]}))],"run":null});
        // A failure after INSERT of the native card rolls it back as well.
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER fail_workflow_insert BEFORE INSERT ON canvas_workflows BEGIN SELECT RAISE(ABORT,'injected save failure'); END;").unwrap();
        assert!(db.workflow_save_with_content("p", 0, doc.clone(), Some(&card)).is_err());
        assert!(db.get_canvas_node("relay").unwrap().is_none());
        assert_eq!(db.workflow_get("p").unwrap().revision, 0);
        db.conn.lock().unwrap().execute_batch("DROP TRIGGER fail_workflow_insert;").unwrap();
        assert_eq!(db.workflow_save_with_content("p", 0, doc.clone(), Some(&card)).unwrap(), 1);
        assert_eq!(db.get_canvas_node("relay").unwrap().unwrap().payload_json, card.payload_json);
        let mut conflict = card.clone(); conflict.id = "conflict".into();
        let mut next = doc.clone(); next["nodes"][1]["textTarget"]["nodeId"] = json!("conflict");
        next["nodes"][2]["inputs"]["image"][0]["canvasNodeId"] = json!("conflict");
        assert!(db.workflow_save_with_content("p", 0, next.clone(), Some(&conflict)).is_err());
        assert!(db.get_canvas_node("conflict").unwrap().is_none());
        conflict.width = -1.0;
        assert!(db.workflow_save_with_content("p", 1, next, Some(&conflict)).is_err());
        assert_eq!(db.workflow_get("p").unwrap().revision, 1);
        // Foreign projects and unrelated native cards cannot enter this narrow API.
        let mut foreign = card.clone(); foreign.project_id = "q".into();
        assert!(db.workflow_save_with_content("p", 1, doc.clone(), Some(&foreign)).is_err());
        assert!(db.workflow_save_with_content("p", 1, json!({"schema_version":1,"nodes":[],"run":null}), Some(&card)).is_err());
        // Replaying an already committed identical card never duplicates it.
        assert_eq!(db.workflow_save_with_content("p", 1, doc, Some(&card)).unwrap(), 2);
        assert_eq!(db.list_canvas_nodes("p").unwrap().len(), 1);
    }
    #[test]
    fn parallel_workflow_locks_and_delete_guard() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut doc = json!({"schema_version":1,"nodes":[node("a",json!({})),node("b",json!({}))],"run":null,
            "runs":[{"id":"one","threadId":"t1","status":"running","steps":{},"order":["a"],"lockedNodeIds":["a"]},
                {"id":"two","threadId":"t2","status":"done","steps":{},"order":["b"],"lockedNodeIds":["b"]}]});
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert!(db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p'", []).is_err());
        doc["runs"][1]["status"] = json!("waiting");
        assert!(validate(&doc).is_ok());
        doc["runs"][1]["lockedNodeIds"] = json!(["a"]);
        assert!(validate(&doc).is_err());
        doc["runs"][0]["status"] = json!("stopped");
        doc["runs"][1]["status"] = json!("done");
        db.workflow_save("p", 1, doc).unwrap();
        db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p'", []).unwrap();
    }
    #[test]
    fn parallel_readers_share_dependencies_but_reject_writes() {
        let mut doc = json!({"schema_version":1,"nodes":[node("profile",json!({})),node("a",json!({})),node("b",json!({}))],"run":null,
            "runs":[{"id":"one","threadId":"t1","status":"running","steps":{},"order":["a"],"lockedNodeIds":["a","profile"],"writeNodeIds":["a"]},
                {"id":"two","threadId":"t2","status":"waiting","steps":{},"order":["b"],"lockedNodeIds":["b","profile"],"writeNodeIds":["b"]}]});
        assert!(validate(&doc).is_ok());
        // Also allow pre-upgrade records whose execution order identifies their writes.
        doc["runs"][0].as_object_mut().unwrap().remove("writeNodeIds");
        assert!(validate(&doc).is_ok());
        doc["runs"][1]["writeNodeIds"] = json!(["b","profile"]);
        assert!(validate(&doc).is_err());
        doc["runs"][1]["writeNodeIds"] = json!([]);
        assert!(validate(&doc).is_err());
    }
}
