//! Versioned, local workflow definitions. Provider jobs keep their existing authority.
use std::{collections::{HashMap, HashSet}, future::Future, sync::Arc};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use crate::{db::Database, error::{AppError, AppResult}};
use crate::cloud::{AuthClient, EntitlementService};
use super::project_canvas::run_canvas_db;

pub mod shot_delivery;
mod validation;
pub(crate) use validation::validate;
use crate::core::project_canvas::{NewCanvasNode, insert_node_tx, touch_canvas_tx};

pub(crate) async fn require_pro(auth: &AuthClient, entitlement: &EntitlementService) -> AppResult<()> {
    let snapshot = entitlement.current_or_sync(auth).await;
    let login = auth.snapshot();
    if !login.logged_in || snapshot.user_id.is_empty() || login.user_id.as_deref() != Some(snapshot.user_id.as_str())
        || !matches!(snapshot.tier.as_str(), "pro" | "studio")
        || !matches!(snapshot.offline_state, Some(crate::cloud::entitlement::OfflineState::Fresh | crate::cloud::entitlement::OfflineState::Grace)) {
        return Err(AppError::Other("运行工作流卡片需要 Pro。已有结果仍可查看和导出".into()));
    }
    Ok(())
}

fn workflow_card_requires_pro(node: &Value) -> bool {
    match node["kind"].as_str() {
        Some("text") => false,
        Some("generation") => node["generation"]["media"] == "video"
            && !matches!(node["generation"]["localVideo"], Value::Null | Value::Bool(false)),
        _ => true,
    }
}

fn effective_workflow_runs(document: &Value) -> &[Value] {
    match document.get("runs") {
        Some(runs) => runs.as_array().map(Vec::as_slice).unwrap_or_default(),
        None => document.get("run").filter(|run| !run.is_null())
            .map(std::slice::from_ref).unwrap_or_default(),
    }
}

fn workflow_run_active(run: &Value) -> bool {
    matches!(run["status"].as_str(), Some("running" | "waiting"))
}

fn workflow_ids(value: &Value) -> impl Iterator<Item = &str> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str)
}

fn workflow_write_ids(run: &Value) -> impl Iterator<Item = &str> {
    workflow_ids(run.get("writeNodeIds").unwrap_or(&run["order"]))
}

fn same_run_identity(before: &Value, after: &Value) -> bool {
    before["threadId"] == after["threadId"] && before["accountId"] == after["accountId"]
}

fn same_video_recovery(before: &Value, after: &Value, nodes: &[Value]) -> bool {
    let Some(node_id) = after["startId"].as_str() else { return false; };
    if after["completionRecoveryOnly"] != true
        || !same_run_identity(before, after)
        || !workflow_ids(&after["order"]).eq([node_id])
        || !workflow_write_ids(after).eq([node_id])
        || workflow_ids(&after["triggerQueue"]).next().is_some()
        || !after["loop"].is_null()
        || !nodes.iter().any(|node| node["id"] == node_id && node["kind"] == "comfy-video")
    {
        return false;
    }
    let original = &before["steps"][node_id];
    let resumed = &after["steps"][node_id];
    original["comfyCancelled"] != true
        && after["steps"].as_object().is_some_and(|steps| steps.keys().all(|id|
            id == node_id || before["steps"].get(id) == steps.get(id)))
        && original["jobId"].as_str().is_some_and(|id| !id.is_empty())
        && original["jobId"] == resumed["jobId"]
        // Local H3 uses the job ID alone. Keep the turn key when a saved run has one.
        && original["turnKey"] == resumed["turnKey"]
}

fn completed_paid_step(run: &Value, paid: &HashSet<&str>) -> bool {
    run["steps"].as_object().is_some_and(|steps| steps.iter().any(|(id, step)|
        paid.contains(id.as_str()) && step["status"] == "done"))
}

fn consumes_accepted_completion(before: &Value, after: &Value, paid: &HashSet<&str>) -> bool {
    let queue = before["triggerQueue"].as_array().and_then(|queue| queue.split_first());
    queue.is_some_and(|(head, remaining)| {
        head == &after["startId"]
            && workflow_ids(&after["order"]).next().is_some()
            && after["triggerQueue"].as_array().is_some_and(|queue| queue == remaining)
            && workflow_ids(&before["order"]).all(|id| before["steps"][id]["status"] == "done")
            && completed_paid_step(before, paid)
    })
}

fn paid_step_ids<'a>(run: &'a Value, paid: &'a HashSet<&'a str>) -> impl Iterator<Item = &'a str> {
    run["steps"].as_object().into_iter().flat_map(|steps| steps.keys())
        .map(String::as_str).filter(move |id| paid.contains(id))
}

fn accepted_run_checkpoint(
    before: &Value, after: &Value, nodes: &[Value], paid: &HashSet<&str>, invokes_paid: bool,
) -> bool {
    if before["status"] == "stopped" || workflow_run_active(before) && before["completionRecoveryOnly"] == true {
        return same_video_recovery(before, after, nodes);
    }
    if !workflow_run_active(before) || !same_run_identity(before, after) {
        return false;
    }
    if invokes_paid && consumes_accepted_completion(before, after, paid) {
        return true;
    }
    // A free phase cannot add a paid step and later present it as an accepted completion.
    if paid_step_ids(after, paid).any(|id| before["steps"].get(id).is_none()) {
        return false;
    }
    if !invokes_paid {
        return true;
    }

    let waiting_for_queue_head = after["status"] == "waiting"
        && after["order"].as_array().is_some_and(Vec::is_empty)
        && workflow_write_ids(after).next().is_none()
        && after["triggerQueue"] == before["triggerQueue"]
        && workflow_ids(&after["triggerQueue"]).next() == after["startId"].as_str();
    if waiting_for_queue_head {
        return true;
    }
    let previous_writes: HashSet<_> = workflow_write_ids(before).collect();
    let mut previous_order = workflow_ids(&before["order"]);
    // Detaching or deleting an idle card can only narrow an accepted phase.
    before["startId"] == after["startId"]
        && workflow_ids(&after["order"]).all(|id| previous_order.any(|previous| previous == id))
        && workflow_write_ids(after).all(|id| !paid.contains(id) || previous_writes.contains(id))
}

fn requires_run_pro(before: &Value, after: &Value) -> bool {
    let Some(nodes) = after["nodes"].as_array() else { return false; };
    let paid: HashSet<_> = nodes.iter().filter(|node| workflow_card_requires_pro(node))
        .filter_map(|node| node["id"].as_str()).collect();
    if paid.is_empty() { return false; }

    let earlier: HashMap<_, _> = effective_workflow_runs(before).iter()
        .filter_map(|run| Some((run["id"].as_str()?, run))).collect();
    effective_workflow_runs(after).iter().filter(|run| workflow_run_active(run)).any(|run| {
        let invokes_paid = run["startId"].as_str().into_iter()
            .chain(workflow_ids(&run["order"]))
            .chain(workflow_write_ids(run))
            .any(|node| paid.contains(node));
        let previous = run["id"].as_str().and_then(|id| earlier.get(id).copied());
        (invokes_paid || paid_step_ids(run, &paid).next().is_some())
            && !previous.is_some_and(|old| accepted_run_checkpoint(old, run, nodes, &paid, invokes_paid))
    })
}

fn workflow_save_requires_pro(before: &Value, after: &Value, _creates_content: bool) -> bool {
    requires_run_pro(before, after)
}

// The schedule and the new run are claimed in the same SQLite transaction.
// A CAS merge from another window must never consume the same appointment twice.
fn validate_schedule_claims(before: &Value, after: &Value) -> AppResult<()> {
    let old_runs: Vec<&Value> = before["runs"].as_array().into_iter().flatten().chain(std::iter::once(&before["run"])).collect();
    let mut claimed = HashSet::new();
    for run in after["runs"].as_array().into_iter().flatten().chain(std::iter::once(&after["run"])) {
        let Some(schedule_id) = run["scheduleId"].as_str() else { continue; };
        // Undo can restore terminal history; it cannot start provider work.
        if !matches!(run["status"].as_str(), Some("running" | "waiting")) { continue; }
        if old_runs.iter().any(|old| old["id"] == run["id"]) || !claimed.insert(run["id"].as_str()) { continue; }
        let previous_node = before["nodes"].as_array().into_iter().flatten().find(|node| node["id"] == run["startId"]).unwrap_or(&Value::Null);
        let current_node = after["nodes"].as_array().into_iter().flatten().find(|node| node["id"] == run["startId"]).unwrap_or(&Value::Null);
        let previous = &previous_node["triggerSchedule"];
        let current = &current_node["triggerSchedule"];
        let daily = previous["dailyAt"].is_string();
        let expected_id = if daily { format!("{}@{}", previous["id"].as_str().unwrap_or(""), previous["at"]) }
            else { previous["id"].as_str().unwrap_or("").to_owned() };
        let advanced = if daily { current["status"] == "armed" && current["at"].as_u64() > previous["at"].as_u64() }
            else { current["status"] == "fired" && current["at"] == previous["at"] };
        let mode = if daily { "daily" } else { "once" };
        if previous_node.get("triggerMode").is_some_and(|value| value != mode) || current_node.get("triggerMode").is_some_and(|value| value != mode)
            || expected_id != schedule_id || previous["status"] != "armed" || current["id"] != previous["id"]
            || current["dailyAt"] != previous["dailyAt"] || !advanced
            || old_runs.iter().any(|old| old["scheduleId"] == schedule_id) {
            return Err(AppError::Other("此定时已取消或已触发，请重新打开项目查看".into()));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn canvas_workflow_authorize(auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>) -> AppResult<()> {
    require_pro(&auth, &entitlement).await
}

#[derive(Serialize)]
pub struct WorkflowSnapshot { revision: i64, document: Value }

fn invalid() -> AppError { AppError::Other("工作流数据无效".into()) }

// A prior saved document can predate the current validator. Read only the
// ownership-bearing fields so saving it never needs to revalidate old runs.
fn saved_workflow_assets(document: &Value) -> HashSet<&str> {
    let mut assets = HashSet::new();
    for node in document["nodes"].as_array().into_iter().flatten() {
        let inputs = [&node["inputs"], &node["savedComfyR2V"]];
        for binding in inputs.into_iter().filter_map(Value::as_object)
            .flat_map(|ports| ports.values()).filter_map(Value::as_array).flatten()
        {
            assets.extend(binding["assetId"].as_str());
            assets.extend(binding["videoFrame"]["assetId"].as_str());
            assets.extend(binding["videoAudio"]["assetId"].as_str());
            if binding["groupId"].is_string() {
                assets.extend(binding["assetIds"].as_array().into_iter().flatten().filter_map(Value::as_str));
            }
        }
        for binding in node["savedComfyAudio"].as_array().into_iter().flatten().filter(|binding| binding.get("videoAudio").is_some()) {
            assets.extend(binding["assetId"].as_str());
            assets.extend(binding["videoAudio"]["assetId"].as_str());
        }
        for output in node["outputs"].as_object().into_iter().flat_map(|ports| ports.values()) {
            if matches!(output["type"].as_str(), Some("text" | "image")) {
                assets.extend(output["assetIds"].as_array().into_iter().flatten().filter_map(Value::as_str));
            }
        }
    }
    for run in effective_workflow_runs(document) {
        for item in run["loop"]["items"].as_array().into_iter().flatten() {
            assets.extend(item["assetIds"].as_array().into_iter().flatten().filter_map(Value::as_str));
        }
        for item in run["loop"]["completed"].as_array().into_iter().flatten() {
            for ports in item["outputs"].as_object().into_iter().flat_map(|nodes| nodes.values()) {
                for output in ports.as_object().into_iter().flat_map(|ports| ports.values()) {
                    assets.extend(output["assetIds"].as_array().into_iter().flatten().filter_map(Value::as_str));
                }
            }
        }
    }
    assets
}

fn ensure_workflow_revision(current: i64, expected: i64) -> AppResult<()> {
    if current != expected {
        return Err(AppError::Other("工作流已被其他窗口修改，请重新打开项目".into()));
    }
    Ok(())
}

impl Database {
    fn workflow_get(&self, project_id: &str) -> AppResult<WorkflowSnapshot> {
        let value: Option<(i64, String)> = self.with_canvas_reader(|conn| {
            Ok(conn.query_row(
                "SELECT revision,document_json FROM canvas_workflows WHERE project_id=?1",
                [project_id], |r| Ok((r.get(0)?, r.get(1)?)),
            ).optional()?)
        })?;
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
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current, previous): (i64, Option<String>) = tx.query_row(
            "SELECT revision,document_json FROM canvas_workflows WHERE project_id=?1",
            [project_id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?.unwrap_or((0, None));
        ensure_workflow_revision(current, revision)?;
        let previous = previous.as_deref().map(serde_json::from_str).transpose()?.unwrap_or(Value::Null);
        validate_schedule_claims(&previous, &document)?;
        // Conversation history keeps its native row. Its single visible Agent projection
        // owns placement and visibility, including undo of a removed card.
        for node in document["nodes"].as_array().unwrap() {
            if let Some(id) = node.get("chatConversationId") {
                let id = id.as_str().ok_or_else(invalid)?;
                let native: Option<String> = tx.query_row("SELECT node_id FROM local_chat_conversations WHERE id=?1 AND project_id=?2", params![id,project_id], |row|row.get(0)).optional()?;
                if node["kind"] != "agent" || native.as_deref() != node["id"].as_str() { return Err(invalid()); }
                tx.execute("UPDATE canvas_nodes SET x=?2,y=?3,width=COALESCE(?4,width),height=COALESCE(?5,height),hidden_at=NULL WHERE id=?1 AND project_id=?6", params![native.unwrap(),node["x"].as_f64(),node["y"].as_f64(),node["layoutSize"]["width"].as_f64(),node["layoutSize"]["height"].as_f64(),project_id])?;
            }
        }
        for node in previous["nodes"].as_array().into_iter().flatten().filter(|node| node["chatConversationId"].is_string()) {
            if !document["nodes"].as_array().unwrap().iter().any(|current| current["id"] == node["id"]) {
                let running: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM local_chat_conversations WHERE id=?1 AND status IN ('running','stopping'))", [node["chatConversationId"].as_str()], |row|row.get(0))?;
                if running { return Err(AppError::Other("请先停止 Agent，再移除卡片".into())); }
                tx.execute("UPDATE canvas_nodes SET hidden_at=COALESCE(hidden_at,strftime('%s','now')*1000) WHERE id=?1 AND project_id=?2", params![node["id"].as_str(),project_id])?;
            }
        }
        if let Some(card) = created_content {
            let now = chrono::Utc::now().timestamp();
            touch_canvas_tx(&tx, project_id, now)?;
            insert_node_tx(&tx, card, now)?;
        }
        let existing_assets = saved_workflow_assets(&previous);
        let added: Vec<_> = assets.iter().filter(|asset| !existing_assets.contains(asset.as_str())).collect();
        if !added.is_empty() {
            // An unchanged reference must respect a later explicit project removal.
            tx.execute(
                "INSERT OR IGNORE INTO project_assets(project_id,asset_id,created_at)
                 SELECT ?1,a.id,strftime('%s','now')*1000 FROM json_each(?2) wanted JOIN assets a ON a.id=wanted.value",
                params![project_id, serde_json::to_string(&added)?],
            )?;
        }
        tx.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES (?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json", params![project_id, revision + 1, document.to_string()])?;
        tx.commit()?;
        Ok(revision + 1)
    }
}

#[tauri::command]
pub async fn canvas_workflow_get(db: State<'_, Arc<Database>>, project_id: String) -> AppResult<WorkflowSnapshot> {
    run_canvas_db(db.inner(), move |db| db.workflow_get(&project_id)).await
}
#[tauri::command]
pub async fn canvas_workflow_save(db: State<'_, Arc<Database>>, auth: State<'_, AuthClient>, entitlement: State<'_, EntitlementService>, project_id: String, revision: i64, document: Value, created_content: Option<NewCanvasNode>) -> AppResult<i64> {
    save_workflow_with_authorization(db.inner(), project_id, revision, document, created_content, || {
        require_pro(&auth, &entitlement)
    }).await
}

async fn save_workflow_with_authorization<F>(
    db: &Arc<Database>,
    project_id: String,
    revision: i64,
    document: Value,
    created_content: Option<NewCanvasNode>,
    authorize: impl FnOnce() -> F,
) -> AppResult<i64>
where
    F: Future<Output = AppResult<()>>,
{
    let before = run_canvas_db(db, {
        let project_id = project_id.clone();
        move |db| db.workflow_get(&project_id)
    }).await?;
    ensure_workflow_revision(before.revision, revision)?;
    if workflow_save_requires_pro(&before.document, &document, created_content.is_some()) {
        authorize().await?;
    }
    run_canvas_db(db, move |db| {
        db.workflow_save_with_content(&project_id, revision, document, created_content.as_ref())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn node(id: &str, inputs: Value) -> Value { json!({"id":id,"kind":"generation","action":"describe","x":0,"y":0,"prompt":"test","provider":"codex","trigger":false,"inputs":inputs,"outputs":{},"outputPorts":[]}) }
    fn workflow_gate_database() -> Arc<Database> {
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.migrate().unwrap();
        db.lock_conn().unwrap().execute(
            "INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)",
            [],
        ).unwrap();
        db
    }

    fn paid_card() -> Value {
        let mut card = node("instruction", json!({}));
        card["kind"] = json!("instruction");
        card
    }

    fn gate_run(id: &str, card_id: &str, status: &str) -> Value {
        json!({"id":id, "startId":card_id, "threadId":"thread", "order":[card_id],
            "status":status, "steps":{(card_id):{"status":"pending"}}})
    }

    async fn save_as_free(db: &Arc<Database>, revision: i64, document: Value) -> AppResult<i64> {
        save_workflow_with_authorization(db, "p".into(), revision, document, None, || async {
            Err(AppError::Other("需要 Pro".into()))
        }).await
    }

    #[tokio::test]
    async fn workflow_gate_free_generation_creation_edit_and_mixed_board_run() {
        let db = workflow_gate_database();
        let mut doc = json!({"schema_version":1,"nodes":[node("draw",json!({}))],"run":null});
        assert_eq!(save_as_free(&db, 0, doc.clone()).await.unwrap(), 1);
        doc["nodes"][0]["prompt"] = json!("changed");
        assert_eq!(save_as_free(&db, 1, doc.clone()).await.unwrap(), 2);

        doc["nodes"].as_array_mut().unwrap().push(paid_card());
        assert_eq!(db.workflow_save("p", 2, doc.clone()).unwrap(), 3);
        let mut run = gate_run("free", "draw", "running");
        run["lockedNodeIds"] = json!(["draw", "instruction"]);
        run["writeNodeIds"] = json!(["draw"]);
        doc["runs"] = json!([run]);
        doc["run"] = doc["runs"][0].clone();
        assert_eq!(save_as_free(&db, 3, doc.clone()).await.unwrap(), 4);
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }

    #[tokio::test]
    async fn workflow_gate_paid_run_lifecycle_preserves_accepted_checkpoints() {
        let db = workflow_gate_database();
        let mut doc = json!({"schema_version":1,"nodes":[paid_card()],"run":null});
        assert_eq!(db.workflow_save("p", 0, doc.clone()).unwrap(), 1);
        doc["run"] = gate_run("paid-history", "instruction", "running");
        assert_eq!(save_as_free(&db, 1, doc.clone()).await.unwrap_err().to_string(), "需要 Pro");
        assert_eq!(db.workflow_get("p").unwrap().revision, 1);

        assert_eq!(db.workflow_save("p", 1, doc.clone()).unwrap(), 2);
        doc["run"]["status"] = json!("waiting");
        assert_eq!(save_as_free(&db, 2, doc.clone()).await.unwrap(), 3);
        doc["run"]["status"] = json!("done");
        assert_eq!(save_as_free(&db, 3, doc.clone()).await.unwrap(), 4);

        doc["run"]["status"] = json!("running");
        assert_eq!(save_as_free(&db, 4, doc.clone()).await.unwrap_err().to_string(), "需要 Pro");
        assert_eq!(db.workflow_get("p").unwrap().revision, 4);
    }

    #[tokio::test]
    async fn workflow_gate_ignores_shadow_run_but_protects_new_write_scope() {
        let db = workflow_gate_database();
        let mut document = json!({"schema_version":1,"nodes":[node("draw",json!({})),paid_card()],"runs":[]});
        document["run"] = gate_run("shadow", "instruction", "running");
        assert_eq!(db.workflow_save("p", 0, document.clone()).unwrap(), 1);
        document["runs"] = json!([document["run"].clone()]);
        assert_eq!(save_as_free(&db, 1, document.clone()).await.unwrap_err().to_string(), "需要 Pro");

        let mut run = gate_run("free", "draw", "running");
        run["lockedNodeIds"] = json!(["draw", "instruction"]);
        run["writeNodeIds"] = json!(["draw"]);
        document["runs"] = json!([run]);
        assert_eq!(save_as_free(&db, 1, document.clone()).await.unwrap(), 2);
        let mut paid_edit = document.clone();
        paid_edit["nodes"][1]["prompt"] = json!("new instruction");
        assert_eq!(save_as_free(&db, 2, paid_edit.clone()).await.unwrap(), 3);
        document = paid_edit;
        document["runs"][0]["writeNodeIds"] = json!(["draw", "instruction"]);
        assert_eq!(save_as_free(&db, 3, document).await.unwrap_err().to_string(), "需要 Pro");
        assert_eq!(db.workflow_get("p").unwrap().revision, 3);
    }

    #[tokio::test]
    async fn workflow_gate_paid_completions_use_only_accepted_queue_checkpoints() {
        for previous_paid in [false, true] {
            let db = workflow_gate_database();
            let mut trigger = node("trigger", json!({}));
            trigger["kind"] = json!("trigger");
            let start = if previous_paid { "instruction" } else { "draw" };
            let mut run = gate_run("two-phases", start, "running");
            run["steps"][start]["status"] = json!("done");
            let mut doc = json!({"schema_version":1,"nodes":[node("draw",json!({})),paid_card(),trigger],"run":run});
            assert_eq!(db.workflow_save("p", 0, doc.clone()).unwrap(), 1);

            if !previous_paid {
                let mut extra_paid_step = doc.clone();
                extra_paid_step["run"]["steps"]["instruction"] = json!({"status":"done"});
                assert_eq!(save_as_free(&db, 1, extra_paid_step).await.unwrap_err().to_string(), "需要 Pro");
            }

            doc["run"]["triggerQueue"] = json!(["trigger"]);
            assert_eq!(save_as_free(&db, 1, doc.clone()).await.unwrap(), 2);
            // The completion event stays pending while the target is busy.
            doc["run"]["status"] = json!("waiting");
            doc["run"]["startId"] = json!("trigger");
            doc["run"]["order"] = json!([]);
            assert_eq!(save_as_free(&db, 2, doc.clone()).await.unwrap(), 3);
            doc["run"]["status"] = json!("running");
            doc["run"]["triggerQueue"] = json!([]);
            doc["run"]["order"] = json!(["trigger","draw"]);
            doc["run"]["steps"]["trigger"] = json!({"status":"pending"});
            doc["run"]["steps"]["draw"] = json!({"status":"pending"});
            let launch = save_as_free(&db, 3, doc).await;
            if previous_paid {
                assert_eq!(launch.unwrap(), 4);
            } else {
                assert_eq!(launch.unwrap_err().to_string(), "需要 Pro");
                assert_eq!(db.workflow_get("p").unwrap().revision, 3);
            }
        }
    }

    #[tokio::test]
    async fn workflow_gate_stopped_video_recovers_only_the_original_request() {
        for turn_key in [None, Some("original-turn")] {
            let db = workflow_gate_database();
            let mut video = node("video", json!({}));
            video["kind"] = json!("comfy-video");
            let mut old = gate_run("video-run", "video", "stopped");
            old["steps"]["video"] = json!({"status":"waiting", "jobId":"video-job"});
            if let Some(turn_key) = turn_key {
                old["steps"]["video"]["turnKey"] = json!(turn_key);
            }
            let mut doc = json!({"schema_version":1,"nodes":[video],"run":old});
            assert_eq!(db.workflow_save("p", 0, doc.clone()).unwrap(), 1);

            doc["run"]["status"] = json!("waiting");
            doc["run"]["completionRecoveryOnly"] = json!(true);
            for (key, value) in [("turnKey", "different-turn"), ("jobId", "another-job")] {
                let mut changed = doc.clone();
                changed["run"]["steps"]["video"][key] = json!(value);
                assert_eq!(save_as_free(&db, 1, changed).await.unwrap_err().to_string(), "需要 Pro");
            }
            assert_eq!(save_as_free(&db, 1, doc.clone()).await.unwrap(), 2);

            doc["run"]["status"] = json!("running");
            assert_eq!(save_as_free(&db, 2, doc.clone()).await.unwrap(), 3);
            doc["run"]["completionRecoveryOnly"] = json!(false);
            assert_eq!(save_as_free(&db, 3, doc).await.unwrap_err().to_string(), "需要 Pro");
            assert_eq!(db.workflow_get("p").unwrap().revision, 3);
        }
    }

    #[tokio::test]
    async fn workflow_gate_keeps_legacy_local_video_paid() {
        let db = workflow_gate_database();
        let mut video = node("video", json!({}));
        video["generation"] = json!({"media":"video","localVideo":{"endpoint":"http://127.0.0.1:8188"}});
        let mut doc = json!({"schema_version":1,"nodes":[video],"run":null});
        assert_eq!(save_as_free(&db, 0, doc.clone()).await.unwrap(), 1);
        doc["run"] = gate_run("legacy-local", "video", "running");
        assert_eq!(save_as_free(&db, 1, doc).await.unwrap_err().to_string(), "需要 Pro");
        assert_eq!(db.workflow_get("p").unwrap().revision, 1);
    }

    #[tokio::test]
    async fn workflow_save_checks_revision_before_and_after_authorization() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        db.migrate().unwrap();
        db.lock_conn().unwrap().execute(
            "INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", [],
        ).unwrap();
        let empty = json!({"schema_version":1,"nodes":[],"run":null});
        assert_eq!(db.workflow_save("p", 0, empty.clone()).unwrap(), 1);
        let paid = json!({"schema_version":1,"nodes":[paid_card()],"run":gate_run("race", "instruction", "running")});

        let calls = std::cell::Cell::new(0);
        let stale = save_workflow_with_authorization(&db, "p".into(), 0, paid.clone(), None, || async {
            calls.set(calls.get() + 1);
            Ok(())
        }).await.unwrap_err();
        assert!(stale.to_string().contains("工作流已被其他窗口修改"));
        assert_eq!(calls.get(), 0);

        let raced = save_workflow_with_authorization(&db, "p".into(), 1, paid, None, || async {
            calls.set(calls.get() + 1);
            assert_eq!(db.workflow_save("p", 1, empty.clone()).unwrap(), 2);
            Ok(())
        }).await.unwrap_err();
        assert!(raced.to_string().contains("工作流已被其他窗口修改"));
        assert_eq!(calls.get(), 1);
        let saved = db.workflow_get("p").unwrap();
        assert_eq!(saved.revision, 2);
        assert_eq!(saved.document, empty);
    }

    #[test]
    fn workflow_validation_preserves_unknown_fields_and_reports_typed_paths() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.lock_conn().unwrap().execute(
            "INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)",
            [],
        ).unwrap();
        let mut node = node("durable", json!({}));
        node["futureMetadata"] = json!({"request":"frozen","values":[1,2,3]});
        let mut doc = json!({"schema_version":1,"nodes":[node],"run":null,"extra":{"keep":true}});
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);

        doc["nodes"][0]["kind"] = json!("unregistered");
        let error = validate(&doc).unwrap_err().to_string();
        assert!(error.contains("durable") && error.contains("nodes[0].kind"), "{error}");
        doc["nodes"][0]["kind"] = json!("generation");
        doc["nodes"][0]["inputs"]["image"] = json!([{"nodeId":"missing","portId":"image"}]);
        let error = validate(&doc).unwrap_err().to_string();
        assert!(error.contains("durable") && error.contains("nodes[0].inputs.image[0]"), "{error}");
    }

    #[test]
    fn workflow_kahn_accepts_reverse_chain_and_reports_a_cycle_member() {
        let mut nodes: Vec<_> = (0..500).rev().map(|index| {
            let inputs = if index == 0 { json!({}) } else {
                json!({"image":[{"nodeId":format!("n{}", index - 1),"portId":"image"}]})
            };
            node(&format!("n{index}"), inputs)
        }).collect();
        let document = json!({"schema_version":1, "nodes":nodes, "run":null});
        assert!(validate(&document).is_ok());
        nodes[499]["inputs"] = json!({"image":[{"nodeId":"n1","portId":"image"}]});
        let cyclic = json!({"schema_version":1, "nodes":nodes, "run":null});
        let error = validate(&cyclic).unwrap_err().to_string();
        assert!(error.contains("工作流包含循环"), "{error}");
        assert!(error.contains("n0，nodes[499]") || error.contains("n1，nodes[498]"), "{error}");
    }

    #[test]
    fn workflow_asset_delta_preserves_explicit_project_removal() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.lock_conn().unwrap().execute_batch(
            "INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1);
             INSERT INTO assets(id,name,ext,created_at) VALUES('first','first','png',1),('second','second','png',1),('parked','parked','png',1),
               ('clip','clip','mp4',1),('audio','audio','wav',1);",
        ).unwrap();
        let mut video = node("paid", json!({"image":[{"assetId":"first"}]}));
        video["generation"] = json!({"media":"video"});
        video["savedComfyR2V"] = json!({"reference-image":[{"assetId":"parked"}]});
        video["savedComfyAudio"] = json!([{"assetId":"clip","videoAudio":{"assetId":"audio"}}]);
        let first = json!({"schema_version":1,"nodes":[video],"run":null});
        db.workflow_save("p", 0, first.clone()).unwrap();
        db.lock_conn().unwrap().execute("DELETE FROM project_assets WHERE project_id='p' AND asset_id IN ('first','parked','clip','audio')", []).unwrap();
        let mut added = first;
        added["nodes"][0]["inputs"]["image"].as_array_mut().unwrap().push(json!({"assetId":"second"}));
        db.workflow_save("p", 1, added).unwrap();
        let conn = db.lock_conn().unwrap();
        let ids = conn.prepare("SELECT asset_id FROM project_assets WHERE project_id='p' ORDER BY asset_id")
            .unwrap().query_map([], |row| row.get::<_, String>(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(ids, ["second"]);
    }

    #[tokio::test]
    async fn workflow_gate_allows_cleanup_and_reconnection_of_a_paid_source() {
        let db = workflow_gate_database();
        let draw = node("draw", json!({"text":[{"nodeId":"instruction","portId":"text","slot":1}]}));
        let mut document = json!({"schema_version":1,"nodes":[paid_card(), draw],"run":null});
        assert_eq!(db.workflow_save("p", 0, document.clone()).unwrap(), 1);
        document["nodes"][1]["inputs"]["image"] = json!([{"assetId":"free-reference"}]);
        assert_eq!(save_as_free(&db, 1, document.clone()).await.unwrap(), 2);
        document["nodes"][0]["x"] = json!(140);
        document["nodes"][1]["inputs"] = json!({});
        assert_eq!(save_as_free(&db, 2, document.clone()).await.unwrap(), 3);
        document["nodes"][1]["inputs"] = json!({"text":[{"nodeId":"instruction","portId":"text","slot":1}]});
        assert_eq!(save_as_free(&db, 3, document).await.unwrap(), 4);
        assert_eq!(db.workflow_get("p").unwrap().revision, 4);
    }

    #[test]
    fn workflow_edits_and_parked_audio_removal_require_no_pro() {
        let mut source = node("video", json!({}));
        source["kind"] = json!("comfy-video");
        let audio = json!({"nodeId":"video","portId":"image","videoAudio":{}});
        let mut receiver = node("receiver", json!({"image":[{"nodeId":"video","portId":"image","slot":1},{"assetId":"still","slot":2}]}));
        receiver["generation"] = json!({"media":"video","localVideo":{}});
        receiver["savedComfyAudio"] = json!([audio]);
        let before = json!({"schema_version":1,"nodes":[source,receiver],"run":null});

        let mut moved = before.clone();
        moved["nodes"][0]["x"] = json!(120);
        moved["nodes"][1]["y"] = json!(180);
        let mut disconnected = moved.clone();
        disconnected["nodes"][1]["inputs"]["image"] = json!([{"assetId":"still","slot":1}]);
        disconnected["nodes"][1]["savedComfyAudio"] = json!([]);
        let mut removed = disconnected.clone();
        removed["nodes"].as_array_mut().unwrap().remove(0);
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("p","test","blank:p","blank:p","blank").unwrap();
        assert_eq!(db.workflow_save("p", 0, before.clone()).unwrap(), 1);
        assert_eq!(db.workflow_save("p", 1, moved).unwrap(), 2);
        assert_eq!(db.workflow_save("p", 2, disconnected).unwrap(), 3);
        assert_eq!(db.workflow_save("p", 3, removed.clone()).unwrap(), 4);
        assert_eq!(db.workflow_get("p").unwrap().document, removed);

        let mut writer = before.clone();
        let mut text = node("writer", json!({"image":[{"nodeId":"video","portId":"image"}]}));
        text["kind"] = json!("text");
        text["textTarget"] = json!({"nodeId":"note","cellId":"cell","image":true});
        writer["nodes"].as_array_mut().unwrap().push(text);
        assert!(!workflow_save_requires_pro(&before, &writer, false));
        let mut run = before.clone();
        run["run"] = gate_run("new-run", "video", "running");
        assert!(workflow_save_requires_pro(&before, &run, false));
    }
    #[test]
    fn dimension_wire_roundtrips_and_accepts_another_input() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let text = json!({"assetId":"photo","assetNodeId":"card","autoConnect":"wire","dimension":{"id":null,"title":"构图","body":"中心构图"}});
        let image = json!({"assetId":"photo","assetNodeId":"card","autoConnect":"wire"});
        let mut doc = json!({"schema_version":1,"nodes":[node("target",json!({"text":[text],"image":[image]}))],"run":null});
        let revision = db.workflow_save("p", 0, doc.clone()).unwrap();
        let loaded = db.workflow_get("p").unwrap();
        assert_eq!(loaded.document, doc);
        doc["nodes"][0]["inputs"]["image"].as_array_mut().unwrap().push(json!({"assetId":"second"}));
        db.workflow_save("p", revision, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
        for invalid_text in [image.clone(), json!({"dimension":{"title":"构图","body":"正文"}}),
            json!({"assetId":"photo","dimension":{"title":"构图","body":42}})] {
            doc["nodes"][0]["inputs"]["text"][0] = invalid_text;
            assert!(validate(&doc).is_err());
        }
    }
    #[test]
    fn video_frame_bindings_keep_both_source_and_frame_assets() {
        let binding = json!({"assetId":"clip","assetNodeId":"clip-node","autoConnect":"wire","mediaFilter":["image"],
            "videoFrame":{"position":"first","assetId":"still"}});
        let mut document = json!({"schema_version":1,"nodes":[node("target",json!({"image":[binding]}))],"run":null});
        assert_eq!(validate(&document).unwrap(), HashSet::from(["clip".to_owned(), "still".to_owned()]));
        let frame = &mut document["nodes"][0]["inputs"]["image"][0]["videoFrame"];
        frame["position"] = json!("middle");
        assert!(validate(&document).is_err());
        document["nodes"][0]["inputs"]["image"][0]["videoFrame"] = json!({"position":"last","assetId":"clip"});
        assert!(validate(&document).is_err());
        document["nodes"][0]["inputs"]["image"][0]["videoFrame"] = json!({"position":"last"});
        assert!(validate(&document).is_err());
    }
    #[test]
    fn video_audio_bindings_keep_both_assets_and_only_accept_audio_ports() {
        let binding = json!({"assetId":"clip","assetNodeId":"original","autoConnect":"wire",
            "mediaFilter":["image","video","audio"],"videoAudio":{"assetId":"sound"}});
        let receiver = json!({"media":"video","videoOptions":{"model_version":"seedance2.5"}});
        let mut target = node("target", json!({"image":[binding]}));
        target["generation"] = receiver.clone();
        let mut document = json!({"schema_version":1,"nodes":[target],"run":null});
        assert_eq!(validate(&document).unwrap(), HashSet::from(["clip".to_owned(), "sound".to_owned()]));
        for options in [json!({"kind":"frames2video"}), json!({"model_version":"seedance1.5"})] {
            document["nodes"][0]["generation"]["videoOptions"] = options;
            assert!(validate(&document).is_err());
        }
        document["nodes"][0]["generation"] = receiver;
        for patch in [json!({"videoFrame":{"position":"first"}}), json!({"videoAudio":null}),
            json!({"videoAudio":[]}), json!({"videoAudio":{}}), json!({"videoAudio":{"assetId":""}}),
            json!({"videoAudio":{"assetId":"clip"}}), json!({"groupId":"group"}),
            json!({"assetIds":["clip"]}), json!({"canvasNodeId":"table"}), json!({"cellId":"cell"}),
            json!({"dimension":{}}), json!({"mediaFilter":["image"]}), json!({"portId":"image"})] {
            let mut bad = binding.clone();
            bad.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            document["nodes"][0]["inputs"]["image"][0] = bad;
            assert!(validate(&document).is_err(), "{patch}");
        }
    }
    #[test]
    fn dynamic_video_audio_bindings_roundtrip_and_participate_in_cycles() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let binding = json!({"nodeId":"source","portId":"image","autoConnect":"wire","mediaFilter":["audio"],"videoAudio":{}});
        let mut source = node("source", json!({}));
        source["kind"] = json!("director3d");
        let mut target = node("target", json!({"r2v-audio":[binding]}));
        target["kind"] = json!("comfy-video");
        target["comfyVideo"]["mode"] = json!("r2v");
        let document = json!({"schema_version":1,"nodes":[source,target],"run":null});
        assert_eq!(db.workflow_save("p", 0, document.clone()).unwrap(), 1);
        assert_eq!(db.workflow_get("p").unwrap().document, document);

        for port in ["first-frame","last-frame","reference-image","reference-video","text","signal"] {
            let mut invalid = document.clone();
            invalid["nodes"][1]["inputs"] = json!({port:[binding]});
            assert!(validate(&invalid).is_err(), "{port}");
        }
        for patch in [json!({"videoAudio":{"assetId":"frozen"}}), json!({"assetId":"clip"}),
            json!({"assetNodeId":"instance"}), json!({"portId":"text"}), json!({"nodeId":"missing"})] {
            let mut invalid = document.clone();
            invalid["nodes"][1]["inputs"]["r2v-audio"][0].as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            assert!(validate(&invalid).is_err(), "{patch}");
        }
        let mut invalid = document.clone();
        invalid["nodes"][0]["kind"] = json!("generation");
        assert!(validate(&invalid).is_err(), "still image source");
        let mut cycle = document.clone();
        cycle["nodes"][0]["inputs"]["image"] = json!([{"nodeId":"target","portId":"image"}]);
        assert!(validate(&cycle).unwrap_err().to_string().contains("循环"));

        for card in [
            json!({"kind":"voice"}),
            json!({"kind":"agent","skill":"hyperframes","agentTransport":"codex-cli"}),
            json!({"kind":"generation","generation":{"media":"video"}}),
        ] {
            let mut target = node("target", json!({"image":[binding]}));
            target.as_object_mut().unwrap().extend(card.as_object().unwrap().clone());
            let mut valid = document.clone();
            valid["nodes"][1] = target;
            assert!(validate(&valid).is_ok(), "{card}");
        }
        for card in [json!({"kind":"agent"}), json!({"kind":"agent","skill":"hyperframes","agentTransport":"local-ds"}),
            json!({"kind":"trigger"}), json!({"kind":"generation","generation":{"media":"image"}})] {
            let mut target = node("target", json!({"image":[binding]}));
            target.as_object_mut().unwrap().extend(card.as_object().unwrap().clone());
            let mut invalid = document.clone();
            invalid["nodes"][1] = target;
            assert!(validate(&invalid).is_err(), "{card}");
        }
    }
    #[test]
    fn dynamic_video_frame_bindings_roundtrip_before_generation_and_reject_cycles() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let binding = json!({"nodeId":"source","portId":"image","autoConnect":"wire","mediaFilter":["image"],"videoFrame":{"position":"last"}});
        let mut source = node("source", json!({})); source["kind"] = json!("comfy-video");
        let mut target = node("target", json!({"first-frame":[binding]})); target["kind"] = json!("comfy-video");
        let mut document = json!({"schema_version":1,"nodes":[source,target],"run":null});
        assert!(validate(&document).unwrap().is_empty());
        assert_eq!(db.workflow_save("p", 0, document.clone()).unwrap(), 1);
        assert_eq!(db.workflow_get("p").unwrap().document, document);

        let mut cycle = document.clone();
        cycle["nodes"][0]["inputs"]["first-frame"] = json!([{"nodeId":"target","portId":"image","videoFrame":{"position":"first"}}]);
        assert!(validate(&cycle).unwrap_err().to_string().contains("循环"));
        let mut invalid = document.clone();
        for patch in [json!({"assetId":"old-clip"}), json!({"videoFrame":{"position":"last","assetId":"old-still"}}),
            json!({"videoFrame":{"position":"middle"}}), json!({"portId":"text"}), json!({"nodeId":"missing"}),
            json!({"assetNodeId":"other"}), json!({"mediaFilter":["video"]})] {
            let mut bad = binding.clone();
            bad.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            invalid["nodes"][1]["inputs"]["first-frame"][0] = bad;
            assert!(validate(&invalid).is_err(), "{patch}");
        }
        for port in ["text","image","reference-video","reference-audio","r2v-audio"] {
            invalid["nodes"][1]["inputs"] = json!({port:[binding]});
            assert!(validate(&invalid).is_err(), "{port}");
        }
        for receiver in [json!({"kind":"trigger"}), json!({"kind":"voice"}), json!({"kind":"text","textSource":"table"}),
            json!({"kind":"text","textTarget":{"nodeId":"table","cellId":"cell","image":false}})] {
            let mut invalid = document.clone();
            let target = &mut invalid["nodes"][1];
            target.as_object_mut().unwrap().extend(receiver.as_object().unwrap().clone());
            target["inputs"] = json!({"image":[binding]});
            assert!(validate(&invalid).is_err(), "{receiver}");
        }
        let mut parked = document.clone();
        parked["nodes"][1]["comfyVideo"]["mode"] = json!("r2v");
        assert!(validate(&parked).is_ok(), "inactive legacy frame socket remains valid");
        parked["nodes"][1]["kind"] = json!("generation");
        parked["nodes"][1]["generation"]["media"] = json!("video");
        parked["nodes"][1]["inputs"] = json!({});
        parked["nodes"][1]["savedComfyR2V"] = json!({"reference-image":[binding]});
        assert!(validate(&parked).is_ok(), "parked reference-image socket remains valid");
        document["nodes"][0]["kind"] = json!("generation");
        assert!(validate(&document).is_err(), "a still image cannot supply a video frame");
        document["nodes"][0]["generation"]["media"] = json!("video");
        assert!(validate(&document).is_ok());
        document["nodes"][0]["kind"] = json!("director3d");
        assert!(validate(&document).is_ok());
        document["nodes"][0]["kind"] = json!("agent");
        document["nodes"][0]["skill"] = json!("hyperframes");
        assert!(validate(&document).is_ok());
    }
    #[test]
    fn shared_agent_moves_and_hides_its_history_projection_atomically() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute_batch("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1); INSERT INTO project_canvases(project_id,created_at,updated_at) VALUES('p',1,1);").unwrap();
        let input = serde_json::from_value(json!({"projectId":"p","requestId":"agent","text":"任务","referenceAssetIds":[]})).unwrap();
        let started = db.begin_local_chat(&input).unwrap();
        let mut snapshot = db.workflow_get("p").unwrap();
        let mut moved = snapshot.document.clone(); moved["nodes"][0]["x"] = json!(125); moved["nodes"][0]["y"] = json!(250);
        assert!(!workflow_save_requires_pro(&snapshot.document, &moved, false));
        let revision = db.workflow_save("p", snapshot.revision, moved).unwrap();
        let position: (f64,f64) = db.conn.lock().unwrap().query_row("SELECT x,y FROM canvas_nodes WHERE id=?1", [&started.conversation.summary.node_id], |row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(position, (125.,250.));
        let empty = json!({"schema_version":1,"nodes":[],"run":null});
        assert!(!workflow_save_requires_pro(&snapshot.document, &empty, false));
        assert!(db.workflow_save("p", revision, empty.clone()).is_err());
        db.finish_local_chat(&started.conversation.summary.id, &started.turn_id, "done", None).unwrap();
        snapshot = db.workflow_get("p").unwrap();
        let revision = db.workflow_save("p", snapshot.revision, empty).unwrap();
        let hidden: bool = db.conn.lock().unwrap().query_row("SELECT hidden_at IS NOT NULL FROM canvas_nodes WHERE id=?1", [&started.conversation.summary.node_id], |row|row.get(0)).unwrap();
        assert!(hidden); assert_eq!(db.list_local_chats("p").unwrap().len(), 1);
        let mut foreign = snapshot.document.clone(); foreign["nodes"][0]["chatConversationId"] = json!("foreign");
        assert!(db.workflow_save("p", revision, foreign).is_err());
        db.workflow_save("p", revision, snapshot.document).unwrap();
        let hidden: bool = db.conn.lock().unwrap().query_row("SELECT hidden_at IS NOT NULL FROM canvas_nodes WHERE id=?1", [&started.conversation.summary.node_id], |row|row.get(0)).unwrap();
        assert!(!hidden);
    }
    #[test]
    fn long_agent_history_and_start_snapshot_roundtrip_without_truncation() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let source = "长文引用😀\n\"原文\"\\".repeat(40_000);
        let mut agent = node("agent", json!({"text":[{"canvasNodeId":"document","cellId":"*text"}]}));
        agent["kind"] = json!("agent");
        let history = json!({"id":"previous","threadId":"thread-old","startId":"agent","order":["agent"],"status":"done",
            "steps":{"agent":{"status":"done","agentRunId":"accepted-cloud-run","agentInput":{"source":source},"agentOutputs":{"text":{"type":"text","text":source}}}}});
        let run = json!({"id":"new","threadId":"thread-new","startId":"agent","order":["agent"],"status":"running",
            "lockedNodeIds":["agent"],"writeNodeIds":["agent"],"cellTexts":{"input":source},"cellValues":{"input":{"type":"text","text":source}},
            "steps":{"agent":{"status":"pending"}}});
        let mut doc = json!({"schema_version":1,"nodes":[agent],"runs":[history,run],"run":run});
        assert!(doc.to_string().len() > 2_000_000);
        assert_eq!(db.workflow_save("p", 0, doc.clone()).unwrap(), 1);
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
        // The next checkpoint must also fit without pruning accepted request IDs
        // or changing the frozen input needed for recovery.
        doc["runs"][1]["status"] = json!("waiting");
        doc["runs"][1]["steps"]["agent"] = json!({"status":"waiting","localDsRequestId":"accepted-local-request","agentInput":{"source":source}});
        doc["run"] = doc["runs"][1].clone();
        assert_eq!(db.workflow_save("p", 1, doc.clone()).unwrap(), 2);
        let saved = db.workflow_get("p").unwrap();
        assert_eq!(saved.document, doc);
        assert_eq!(saved.document["runs"][0], history);
        assert_eq!(saved.document["runs"][1]["cellValues"]["input"]["text"], source);
        let mut invalid_doc = doc.clone();
        invalid_doc["runs"][1]["lockedNodeIds"] = json!([]);
        assert!(db.workflow_save("p", 2, invalid_doc).is_err(), "large history must still validate execution locks");
        assert!(db.workflow_save("p", 1, doc.clone()).is_err(), "revision conflicts still reject stale writes");
        assert_eq!(db.workflow_get("p").unwrap().revision, 2);
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }
    #[test]
    fn trigger_schedule_validates_time_identity_and_state() {
        let mut trigger = node("timer", json!({})); trigger["kind"] = json!("trigger");
        trigger["triggerSchedule"] = json!({"id":"appointment","at":1800000000000u64,"status":"armed"});
        let doc = json!({"schema_version":1,"nodes":[trigger],"run":null});
        assert!(validate(&doc).is_ok());
        for (field, value) in [("at", json!(0)), ("at", json!(-1)), ("at", json!(1.5)), ("at", json!("1800000000000")),
            ("at", json!(8_640_000_000_000_001u64)), ("id", json!("")), ("status", json!("repeat"))] {
            let mut invalid_doc = doc.clone(); invalid_doc["nodes"][0]["triggerSchedule"][field] = value;
            assert!(validate(&invalid_doc).is_err(), "{field}");
        }
        let mut changed = doc.clone(); changed["nodes"][0]["kind"] = json!("generation"); assert!(validate(&changed).is_err());
        changed = doc.clone(); changed["nodes"][0]["triggerSchedule"]["status"] = json!("failed");
        assert!(validate(&changed).is_ok());
    }
    #[test]
    fn trigger_modes_roundtrip_and_inactive_appointments_cannot_be_claimed() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut trigger = node("timer", json!({})); trigger["kind"] = json!("trigger");
        trigger["triggerSchedule"] = json!({"id":"once","at":1800000000000u64,"status":"armed"});
        let mut doc = json!({"schema_version":1,"nodes":[trigger],"run":null});
        for (revision, mode) in ["manual", "daily", "once", "completion"].into_iter().enumerate() {
            doc["nodes"][0]["triggerMode"] = json!(mode);
            db.workflow_save("p", revision as i64, doc.clone()).unwrap();
            assert_eq!(db.workflow_get("p").unwrap().document, doc);
            let mut claim = doc.clone(); claim["nodes"][0]["triggerSchedule"]["status"] = json!("fired");
            claim["run"] = json!({"id":"r","startId":"timer","scheduleId":"once","status":"running"});
            assert_eq!(validate_schedule_claims(&doc, &claim).is_ok(), mode == "once");
        }
        for mode in [json!("unknown"), json!(null), json!(true)] {
            doc["nodes"][0]["triggerMode"] = mode; assert!(validate(&doc).is_err());
        }
        doc["nodes"][0]["triggerMode"] = json!("manual"); doc["nodes"][0]["kind"] = json!("generation");
        doc["nodes"][0].as_object_mut().unwrap().remove("triggerSchedule"); assert!(validate(&doc).is_err());
    }
    #[test]
    fn trigger_schedule_claim_is_atomic_and_cannot_be_replayed() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut trigger = node("timer", json!({})); trigger["kind"] = json!("trigger");
        trigger["triggerSchedule"] = json!({"id":"appointment","at":1800000000000u64,"status":"armed"});
        let armed = json!({"schema_version":1,"nodes":[trigger],"run":null});
        db.workflow_save("p", 0, armed.clone()).unwrap();
        let mut fired = armed.clone(); fired["nodes"][0]["triggerSchedule"]["status"] = json!("fired");
        fired["run"] = json!({"id":"r","startId":"timer","scheduleId":"appointment","threadId":"t","status":"waiting","order":["timer"],"steps":{"timer":{"status":"pending"}}});
        db.workflow_save("p", 1, fired.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, fired);
        let mut duplicate = fired.clone(); duplicate["run"]["id"] = json!("another-window");
        assert!(db.workflow_save("p", 2, duplicate).is_err());
        assert_eq!(db.workflow_get("p").unwrap().revision, 2);
        fired["run"]["status"] = json!("done"); fired["run"]["steps"]["timer"]["status"] = json!("done");
        db.workflow_save("p", 2, fired).unwrap();
        let mut cancelled = armed.clone(); cancelled["nodes"][0].as_object_mut().unwrap().remove("triggerSchedule");
        let mut candidate = armed.clone(); candidate["nodes"][0]["triggerSchedule"]["status"] = json!("fired");
        candidate["run"] = json!({"id":"new","startId":"timer","scheduleId":"appointment","status":"running"});
        assert!(validate_schedule_claims(&cancelled, &candidate).is_err());
    }
    #[test]
    fn daily_trigger_validates_local_time_and_allows_progress_updates() {
        let mut trigger = node("timer", json!({})); trigger["kind"] = json!("trigger");
        trigger["triggerSchedule"] = json!({"id":"daily","at":1800000000000u64,"dailyAt":"21:00","status":"armed"});
        let doc = json!({"schema_version":1,"nodes":[trigger],"run":null});
        assert!(validate(&doc).is_ok());
        for time in [json!("24:00"), json!("21:60"), json!("9:00"), json!("21:00:00"), json!("aa:00"), json!(""), json!(null), json!(2100)] {
            let mut bad = doc.clone(); bad["nodes"][0]["triggerSchedule"]["dailyAt"] = time;
            assert!(validate(&bad).is_err());
        }
        let mut next = doc.clone(); next["nodes"][0]["triggerSchedule"]["at"] = json!(1800086400000u64);
        assert!(validate(&next).is_ok());
        next["nodes"][0]["triggerSchedule"]["dailyAt"] = json!("22:00");
        assert!(validate(&next).is_ok());
        next["nodes"][0]["triggerSchedule"]["status"] = json!("fired"); assert!(validate(&next).is_err());
    }
    #[test]
    fn director_card_roundtrips_scene_reference_and_exported_mp4() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut card = node("stage",json!({"image":[{"assetId":"photo"}]}));
        card["kind"] = json!("director3d");
        card["directorDocument"] = json!({"scene":{"objectList":[{"threeJsonId":"box-1"}]}});
        card["directorVideoId"] = json!("movie");
        card["outputs"] = json!({"image":{"type":"image","assetIds":["movie"]}});
        let doc = json!({"schema_version":1,"nodes":[card],"run":null});
        assert_eq!(validate(&doc).unwrap(),HashSet::from(["photo".into(),"movie".into()]));
        db.workflow_save("p",0,doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document,doc);
    }
    #[test]
    fn voice_card_persists_recording_preview_and_spoken_output() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut card = node("voice", json!({"image":[{"assetId":"recording"}]}));
        card["kind"] = json!("voice");
        card["voice"] = json!({"sampleText":"修改后的试听", "clip":{"assetId":"recording","start":1,"end":3,"name":"旁白","transcript":""}});
        let mut doc = json!({"schema_version":1,"nodes":[card],"run":null});
        assert_eq!(validate(&doc).unwrap(), HashSet::from(["recording".into()]));
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
        doc["nodes"][0]["inputs"] = json!({});
        doc["nodes"][0]["voice"]["id"] = json!("saved-voice");
        doc["nodes"][0]["prompt"] = json!("角色的台词");
        doc["nodes"][0]["outputs"] = json!({"image":{"type":"image","assetIds":["spoken-audio"]}});
        assert_eq!(validate(&doc).unwrap(), HashSet::from(["spoken-audio".into()]));
        db.workflow_save("p", 1, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }
    #[test]
    fn daily_trigger_claims_each_occurrence_once_and_advances_atomically() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut trigger = node("timer", json!({})); trigger["kind"] = json!("trigger");
        trigger["triggerSchedule"] = json!({"id":"daily","at":1800000000000u64,"dailyAt":"21:00","status":"armed"});
        let mut doc = json!({"schema_version":1,"nodes":[trigger],"runs":[],"run":null});
        db.workflow_save("p", 0, doc.clone()).unwrap();
        for (day, at) in [1800000000000u64, 1800086400000u64].into_iter().enumerate() {
            let revision = 1 + day as i64 * 2;
            let run = json!({"id":format!("r{day}"),"startId":"timer","scheduleId":format!("daily@{at}"),"threadId":"t","status":"running","order":["timer"],"steps":{"timer":{"status":"pending"}}});
            doc["runs"].as_array_mut().unwrap().push(run.clone()); doc["run"] = run;
            assert!(db.workflow_save("p", revision, doc.clone()).is_err(), "claim without advancing the next occurrence");
            doc["nodes"][0]["triggerSchedule"]["at"] = json!(at + 86400000);
            db.workflow_save("p", revision, doc.clone()).unwrap();
            let mut duplicate = doc.clone(); duplicate["runs"][day]["id"] = json!("other-window"); duplicate["run"] = duplicate["runs"][day].clone();
            assert!(db.workflow_save("p", revision + 1, duplicate).is_err());
            doc["runs"][day]["status"] = json!("done"); doc["run"] = doc["runs"][day].clone();
            db.workflow_save("p", revision + 1, doc.clone()).unwrap();
        }
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }
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
        db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p'", []).unwrap();
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
    fn automatic_binding_metadata_is_validated_and_survives_storage() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let doc = json!({"schema_version":1,"nodes":[node("target",json!({"image":[{
            "assetId":"photo", "autoConnect":"connection", "mediaFilter":["image"]
        }]}))],"run":null});
        assert!(validate(&doc).is_ok());
        for metadata in [json!({"autoConnect":""}), json!({"autoConnect":2}), json!({"mediaFilter":[]}),
            json!({"mediaFilter":["image","image"]}), json!({"mediaFilter":["unknown"]})] {
            let mut invalid_doc = doc.clone();
            for (key, value) in metadata.as_object().unwrap() { invalid_doc["nodes"][0]["inputs"]["image"][0][key] = value.clone(); }
            assert!(validate(&invalid_doc).is_err());
        }
        // Storage keeps the versioned JSON, including the automatic connection identity.
        assert_eq!(db.workflow_save("p", 0, doc.clone()).unwrap(), 1);
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
    }
    #[test]
    fn saves_new_image_card_on_a_board_with_h3_audio() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut video = node("video", json!({"reference-audio":[{
            "assetId":"sample","assetNodeId":"audio-card","autoConnect":"audio-wire","mediaFilter":["audio"]
        }]}));
        video["kind"] = json!("comfy-video");
        let history = json!({"id":"completed","threadId":"thread","startId":"video","status":"done",
            "order":["video"],"steps":{"video":{"status":"done","jobId":"original-job"}}});
        let existing = json!({"schema_version":1,"nodes":[video],"run":history,"runs":[history]});
        // Model an existing project saved by a build that already knows about the audio input.
        db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p',1,?1)",
            [existing.to_string()]).unwrap();
        let mut snapshot = db.workflow_get("p").unwrap();
        let mut image = node("image", json!({}));
        image["generation"] = json!({"media":"image"});
        snapshot.document["nodes"].as_array_mut().unwrap().push(image);
        let doc = snapshot.document;
        assert_eq!(validate(&doc).unwrap(), HashSet::from(["sample".to_owned()]));
        assert_eq!(db.workflow_save("p", snapshot.revision, doc.clone()).unwrap(), 2);
        let reopened = db.workflow_get("p").unwrap();
        assert_eq!(reopened.revision, 2);
        assert_eq!(reopened.document, doc);
        assert_eq!(reopened.document["nodes"][0], existing["nodes"][0]);
        assert_eq!(reopened.document["runs"], existing["runs"]);
        let mut invalid = doc.clone();
        invalid["nodes"][0]["kind"] = json!("generation");
        assert!(validate(&invalid).is_err());
        let mut invalid = doc.clone();
        invalid["nodes"][0]["inputs"]["reference-audio"][0]["mediaFilter"] = json!(["image"]);
        assert!(validate(&invalid).is_err());
        let mut invalid = doc;
        invalid["nodes"][0]["inputs"]["reference-audio"] = json!([{"assetId":"sample"},{"assetId":"extra"}]);
        assert!(validate(&invalid).is_err());
    }
    #[test]
    fn saves_and_reopens_typed_h3_r2v_bindings_without_reactivating_parked_wires() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut h3 = node("h3", json!({
            "reference-image": [{"assetId":"still", "mediaFilter":["image"]}],
            "reference-video": [{"assetId":"clip", "mediaFilter":["video"]}],
            "r2v-audio": [{"assetId":"voice-a"}, {"assetId":"voice-b"}, {"assetId":"voice-c"}],
            "first-frame": [{"nodeId":"other", "portId":"image"}]
        }));
        h3["kind"] = json!("comfy-video");
        h3["comfyVideo"]["mode"] = json!("r2v");
        let other = node("other", json!({"image":[{"nodeId":"h3", "portId":"image"}]}));
        let doc = json!({"schema_version":1,"nodes":[h3,other],"run":null});
        assert_eq!(validate(&doc).unwrap(), HashSet::from(["still", "clip", "voice-a", "voice-b", "voice-c"].map(str::to_owned)));
        assert_eq!(db.workflow_save("p", 0, doc.clone()).unwrap(), 1);
        assert_eq!(db.workflow_get("p").unwrap().document, doc);

        let mut wrong_media = doc.clone();
        wrong_media["nodes"][0]["inputs"]["reference-video"][0]["mediaFilter"] = json!(["image"]);
        assert!(validate(&wrong_media).is_err());
        let mut overflow = doc.clone();
        overflow["nodes"][0]["inputs"]["r2v-audio"].as_array_mut().unwrap().push(json!({"assetId":"voice-d"}));
        assert!(validate(&overflow).is_err());
        let mut active_cycle = doc.clone();
        active_cycle["nodes"][0]["comfyVideo"]["mode"] = json!("frames");
        assert!(validate(&active_cycle).is_err());

        let mut remote = doc;
        remote["nodes"][0]["kind"] = json!("generation");
        remote["nodes"][0]["generation"] = json!({"media":"video"});
        remote["nodes"][0]["inputs"] = json!({});
        remote["nodes"][0]["savedComfyR2V"] = json!({"reference-video":[{"nodeId":"other","portId":"image"}]});
        assert_eq!(db.workflow_save("p", 1, remote.clone()).unwrap(), 2);
        assert_eq!(db.workflow_get("p").unwrap().document, remote);
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
        let draw = node("draw", json!({}));
        let mut switch = node("switch", json!({"completion":[{"canvasNodeId":"session","cellId":"image"},
            {"nodeId":"draw","portId":"image","autoConnect":"link","pendingCompletionSession":"current-turn"}]}));
        switch["kind"] = json!("trigger"); switch["triggerCount"] = json!(1);
        switch["completionSeen"] = json!(["previous-turn"]);
        let doc = json!({"schema_version":1,"nodes":[switch,draw],"run":null});
        assert!(validate(&doc).is_ok());
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        db.workflow_save("p", 0, doc.clone()).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().document, doc);
        for binding in [json!({"canvasNodeId":"","cellId":"image"}), json!({"canvasNodeId":"session","cellId":"text"}),
            json!({"nodeId":"draw","portId":"image","pendingCompletionSession":""}),
            json!({"canvasNodeId":"session","cellId":"image","pendingCompletionSession":"turn"}),
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
    fn revision_and_running_project_deletion() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let doc = json!({"schema_version":1,"nodes":[node("a",json!({}))],"run":null});
        assert_eq!(db.workflow_save("p", 0, doc.clone()).unwrap(), 1);
        assert!(db.workflow_save("p", 0, doc.clone()).is_err());
        let mut running = doc; running["run"] = json!({"id":"run","threadId":"t","status":"waiting","steps":{},"order":["a"]});
        db.workflow_save("p", 1, running).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().revision, 2);
        db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p'", []).unwrap();
        assert_eq!(db.workflow_get("p").unwrap().revision, 0);
        assert!(db.get_project("p").unwrap().is_none());
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
    fn parallel_workflow_locks_allow_project_deletion() {
        let db = Database::open_in_memory().unwrap(); db.migrate().unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','p','p','p',1)", []).unwrap();
        let mut doc = json!({"schema_version":1,"nodes":[node("a",json!({})),node("b",json!({}))],"run":null,
            "runs":[{"id":"one","threadId":"t1","status":"running","steps":{},"order":["a"],"lockedNodeIds":["a"]},
                {"id":"two","threadId":"t2","status":"done","steps":{},"order":["b"],"lockedNodeIds":["b"]}]});
        db.workflow_save("p", 0, doc.clone()).unwrap();
        db.conn.lock().unwrap().execute("DELETE FROM projects WHERE id='p'", []).unwrap();
        doc["runs"][1]["status"] = json!("waiting");
        assert!(validate(&doc).is_ok());
        doc["runs"][1]["lockedNodeIds"] = json!(["a"]);
        assert!(validate(&doc).is_err());
        doc["runs"][0]["status"] = json!("stopped");
        doc["runs"][1]["status"] = json!("done");
        assert!(db.workflow_save("p", 1, doc).is_err());
    }
    #[test]
    fn trigger_can_start_a_second_target_while_first_target_runs() {
        let mut trigger = node("start", json!({}));
        trigger["kind"] = json!("trigger");
        let mut doc = json!({"schema_version":1,"nodes":[trigger,node("a",json!({})),node("b",json!({}))],
            "runs":[{"id":"one","threadId":"t1","status":"running","steps":{},"order":["start","a"]},
                    {"id":"two","threadId":"t2","status":"running","steps":{},"order":["start","b"]}]});
        assert!(validate(&doc).is_ok());
        doc["runs"][1]["order"] = json!(["start","a"]);
        assert!(validate(&doc).is_err());
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

    #[test]
    fn active_workflow_saves_pending_deletion_with_trimmed_scope() {
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        db.create_project("p","test","blank:p","blank:p","blank").unwrap();
        let mut owner = node("loop", json!({}));
        owner["kind"] = json!("loop");
        let from_loop = json!({"image":[{"nodeId":"loop","portId":"image"}]});
        let accepted = json!({"status":"running","jobId":"original-job","turnKey":"original-turn",
            "generationRunInput":{"prompt":"已提交","references":[["original-image"]]}});
        let first = json!({"id":"first","threadId":"t1","startId":"loop","status":"running",
            "order":["loop","keep","remove"],"lockedNodeIds":["loop","keep","remove","shared"],"writeNodeIds":["loop","keep","remove"],
            "steps":{"loop":{"status":"done"},"keep":accepted,"remove":{"status":"pending"}},
            "inputOutputs":{"shared":{"image":{"type":"image","assetIds":["frozen-image"]}},"remove":{"text":{"type":"text","text":"历史"}}},
            "loop":{"nodeId":"loop","bodyIds":["keep","remove"],"index":1,"items":[{"text":"第一项","assetIds":[]},{"text":"第二项","assetIds":[]}],
                "completed":[{"outputs":{"keep":{},"remove":{}},"steps":{"keep":{"status":"done","jobId":"old-keep"},"remove":{"status":"done","jobId":"old-remove"}}}]}});
        let other = json!({"id":"other","threadId":"t2","startId":"outside","status":"running","order":["outside"],
            "lockedNodeIds":["outside","shared"],"writeNodeIds":["outside"],"steps":{"outside":{"status":"running"}}});
        let before = json!({"schema_version":1,"nodes":[owner,node("keep",from_loop.clone()),node("remove",from_loop),
            node("shared",json!({})),node("outside",json!({}))],"run":other,"runs":[first,other]});
        assert!(!validate(&before).unwrap().contains("frozen-image"), "run snapshots do not relink project assets");
        let mut invalid_snapshot = before.clone();
        invalid_snapshot["runs"][0]["inputOutputs"]["outside"] = json!({});
        assert!(validate(&invalid_snapshot).is_err(), "a run cannot snapshot nodes outside its scope");
        invalid_snapshot = before.clone();
        invalid_snapshot["runs"][0]["inputOutputs"]["shared"]["image"]["assetIds"] = json!([17]);
        assert!(validate(&invalid_snapshot).is_err(), "frozen outputs use the same shape as live outputs");
        assert_eq!(db.workflow_save("p", 0, before.clone()).unwrap(), 1);

        let mut cleaned = before.clone();
        cleaned["nodes"].as_array_mut().unwrap().remove(2);
        assert!(db.workflow_save("p", 1, cleaned.clone()).is_err(), "stale node IDs cannot be persisted");
        let run = &mut cleaned["runs"][0];
        run["order"] = json!(["loop","keep"]);
        run["lockedNodeIds"] = json!(["loop","keep","shared"]);
        run["writeNodeIds"] = json!(["loop","keep"]);
        run["steps"].as_object_mut().unwrap().remove("remove");
        run["loop"]["bodyIds"] = json!(["keep"]);
        assert!(validate(&cleaned).is_err(), "completed loop rows must match the surviving body");
        let completed = &mut cleaned["runs"][0]["loop"]["completed"][0];
        completed["outputs"].as_object_mut().unwrap().remove("remove");
        completed["steps"].as_object_mut().unwrap().remove("remove");
        assert!(validate(&cleaned).is_err(), "deleted keys cannot remain in the active snapshot");
        cleaned["runs"][0]["inputOutputs"].as_object_mut().unwrap().remove("remove");
        assert!(!workflow_save_requires_pro(&before, &cleaned, false));
        let mut reordered = cleaned.clone();
        reordered["runs"][0]["order"] = json!(["keep","loop"]);
        assert!(workflow_save_requires_pro(&before, &reordered, false), "changing execution order is not a trim");
        let mut expanded = cleaned.clone();
        expanded["runs"][0]["order"] = json!(["loop","keep","shared"]);
        expanded["runs"][0]["writeNodeIds"] = json!(["loop","keep","shared"]);
        assert!(workflow_save_requires_pro(&before, &expanded, false), "an accepted phase cannot add work");
        assert_eq!(db.workflow_save("p", 1, cleaned.clone()).unwrap(), 2);
        let saved = db.workflow_get("p").unwrap();
        assert_eq!(saved.document, cleaned);
        assert_eq!(saved.document["runs"][0]["steps"]["keep"], accepted);
        assert_eq!(saved.document["runs"][0]["loop"]["completed"][0]["steps"]["keep"]["jobId"], "old-keep");
        assert!(db.workflow_save("p", 1, cleaned.clone()).is_err(), "stale revision cannot revive the old plan");
        cleaned["runs"][1]["lockedNodeIds"] = json!(["outside","shared","keep"]);
        cleaned["runs"][1]["writeNodeIds"] = json!(["outside","keep"]);
        assert!(db.workflow_save("p", 2, cleaned).is_err(), "a second run cannot write an accepted card");
        assert_eq!(db.workflow_get("p").unwrap().revision, 2);
    }
}
