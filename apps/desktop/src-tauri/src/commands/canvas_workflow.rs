//! Versioned, local workflow definitions. Provider jobs keep their existing authority.
use std::{collections::{HashMap, HashSet}, sync::Arc};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use crate::{db::Database, error::{AppError, AppResult}};

#[derive(Serialize)]
pub struct WorkflowSnapshot { revision: i64, document: Value }

fn invalid() -> AppError { AppError::Other("工作流数据无效".into()) }

fn validate(document: &Value) -> AppResult<HashSet<String>> {
    if document["schema_version"] != 1 || document.to_string().len() > 2_000_000 { return Err(invalid()); }
    let nodes = document["nodes"].as_array().ok_or_else(invalid)?;
    if nodes.len() > 500 { return Err(invalid()); }
    let mut ids = HashSet::new();
    let mut assets = HashSet::new();
    let mut dependencies: HashMap<&str, Vec<&str>> = HashMap::new();
    for node in nodes {
        let id = node["id"].as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?;
        if !ids.insert(id) || !matches!(node["kind"].as_str(), Some("instruction" | "generation" | "skill" | "agent" | "visual-profile" | "text" | "trigger"))
            || !matches!(node["action"].as_str(), Some("describe" | "reuse" | "layers"))
            || node["x"].as_f64().filter(|v| v.is_finite()).is_none()
            || node["y"].as_f64().filter(|v| v.is_finite()).is_none()
            || !node["prompt"].is_string() || !node["provider"].is_string()
            || !node["trigger"].is_boolean() || !node["outputPorts"].is_array() { return Err(invalid()); }
        let inputs = node["inputs"].as_object().ok_or_else(invalid)?;
        if node["kind"] == "trigger" && !inputs.is_empty() { return Err(invalid()); }
        if node["kind"] == "text" && node["textSource"].is_string() {
            if node["textSource"].as_str().is_none_or(str::is_empty) || inputs.keys().any(|key| key != "signal") || node.get("textTarget").is_some() { return Err(invalid()); }
            if nodes.iter().any(|other| other["id"] != node["id"] && other["textSource"] == node["textSource"]) { return Err(invalid()); }
        } else if node["kind"] == "text" {
            if node["textTarget"]["nodeId"].as_str().is_none_or(str::is_empty)
                || node["textTarget"]["cellId"].as_str().is_none_or(str::is_empty)
                || inputs.values().filter_map(Value::as_array).map(Vec::len).sum::<usize>() != 1
                || inputs.keys().any(|key| key != "text" && key != "image") { return Err(invalid()); }
            if nodes.iter().any(|other| other["id"] != node["id"] && other["kind"] == "text" && other["textTarget"]["nodeId"] == node["textTarget"]["nodeId"] && other["textTarget"]["cellId"] == node["textTarget"]["cellId"]) { return Err(invalid()); }
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
            if !matches!(port.as_str(), "text" | "image" | "visual-profile" | "signal") { return Err(invalid()); }
            for binding in bindings.as_array().ok_or_else(invalid)? {
                if port == "signal" {
                    let producer = nodes.iter().find(|node| node["id"] == binding["nodeId"]).ok_or_else(invalid)?;
                    if producer["kind"] != "trigger" || binding["portId"] != "signal" || binding.as_object().is_none_or(|value| value.len() != 2) { return Err(invalid()); }
                    deps.push(producer["id"].as_str().ok_or_else(invalid)?);
                    continue;
                }
                if binding["portId"] == "signal" { return Err(invalid()); }
                if binding["groupId"].is_string() {
                    if port != "image" || binding.get("nodeId").is_some() || binding.get("assetId").is_some() || binding.get("canvasNodeId").is_some() { return Err(invalid()); }
                    for asset in binding["assetIds"].as_array().ok_or_else(invalid)? {
                        assets.insert(asset.as_str().filter(|id| !id.is_empty()).ok_or_else(invalid)?.to_owned());
                    }
                } else if let Some(asset) = binding["assetId"].as_str() {
                    if port != "image" || binding.get("nodeId").is_some() { return Err(invalid()); }
                    assets.insert(asset.to_owned());
                } else if binding["canvasNodeId"].is_string() {
                    if (port != "text" && port != "image") || !binding["cellId"].is_string() || binding.get("nodeId").is_some() { return Err(invalid()); }
                    if binding["cellId"] == "*" || binding["cellId"] == "*text" {
                        if (binding["cellId"] == "*" && port != "image") || (binding["cellId"] == "*text" && port != "text") { return Err(invalid()); }
                        for producer in nodes.iter().filter(|node| node["kind"] == "text" && node["textTarget"]["nodeId"] == binding["canvasNodeId"]) {
                            deps.push(producer["id"].as_str().ok_or_else(invalid)?);
                        }
                    }
                    if let Some(producer) = nodes.iter().find(|node| node["kind"] == "text" && node["textTarget"]["nodeId"] == binding["canvasNodeId"] && (node["textTarget"]["cellId"] == binding["cellId"] || node["textTarget"]["cellIds"].as_array().is_some_and(|ids| ids.contains(&binding["cellId"]))))
                        .or_else(|| nodes.iter().find(|node| node["resultNodeIds"].as_array().is_some_and(|ids| ids.contains(&binding["canvasNodeId"])))) {
                        deps.push(producer["id"].as_str().ok_or_else(invalid)?);
                    }
                } else {
                    deps.push(binding["nodeId"].as_str().ok_or_else(invalid)?);
                    if !binding["portId"].is_string() { return Err(invalid()); }
                }
            }
        }
        dependencies.insert(id, deps);
        for value in node["outputs"].as_object().ok_or_else(invalid)?.values() {
            match value["type"].as_str() {
                Some("session") if value["nodeIds"].as_array().is_some_and(|ids| ids.iter().all(|id| id.is_string())) => {},
                Some("image") => for asset in value["assetIds"].as_array().ok_or_else(invalid)? {
                    assets.insert(asset.as_str().ok_or_else(invalid)?.to_owned());
                },
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
        let assets = validate(&document)?;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let current: i64 = tx.query_row("SELECT revision FROM canvas_workflows WHERE project_id=?1", [project_id], |r| r.get(0)).optional()?.unwrap_or(0);
        if current != revision { return Err(AppError::Other("工作流已被其他窗口修改，请重新打开项目".into())); }
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
pub async fn canvas_workflow_save(db: State<'_, Arc<Database>>, project_id: String, revision: i64, document: Value) -> AppResult<i64> { db.workflow_save(&project_id, revision, document) }

#[cfg(test)]
mod tests {
    use super::*;
    fn node(id: &str, inputs: Value) -> Value { json!({"id":id,"kind":"generation","action":"describe","x":0,"y":0,"prompt":"test","provider":"codex","trigger":false,"inputs":inputs,"outputs":{},"outputPorts":[]}) }
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
