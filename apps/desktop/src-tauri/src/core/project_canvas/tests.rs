use super::*;
use super::execution_projection::projection_id;
use super::note_assets::document_asset_ids;
use rusqlite::{params, TransactionBehavior};
use std::path::Path;
use crate::core::creative_session_contract::{
    AgentGroupNodePayloadV1, CreativeEdgeKind,
    CreativeNodeKind, CreativeNodeRole, CreativeThreadOrigin, PromptNodePayloadV1,
};
use crate::db::Database;
use crate::core::creative_session_contract::{AssetNodePayloadV1, AssetSnapshotV1, CreativeGenerationRelation};

fn db() -> Database {
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    db
}

#[test]
fn opening_project_canvas_scope_updates_last_opened_without_rewriting_canvas() {
    let db = db();
    materialize(&db, "p");
    let canvas = db.get_project_canvas("p").unwrap().unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute("UPDATE projects SET last_opened_at = 1 WHERE id = 'p'", [])
        .unwrap();

    db.open_project_canvas_scope("p").unwrap();

    assert!(db.get_project("p").unwrap().unwrap().last_opened_at > 1);
    assert_eq!(db.get_project_canvas("p").unwrap(), Some(canvas));
}

fn batch_group(project_id: &str, id: &str, members: &[&str]) -> CanvasGroupBatchCreate {
    CanvasGroupBatchCreate {
        value: NewCanvasGroup {
            id: id.into(), project_id: project_id.into(), name: id.into(), role: None,
            x: 3.0, y: 6.0, width: 100.0, height: 100.0, z_index: 1,
        },
        node_ids: members.iter().map(|id| (*id).into()).collect(),
    }
}

#[test]
fn batch_create_rolls_back_and_exact_replays_include_groups() {
    let db = db();
    materialize(&db, "p");
    materialize(&db, "other");
    db.create_canvas_node(&note("other", "foreign")).unwrap();
    let values = [note("p", "first"), note("p", "second")];
    let invalid = [batch_group("p", "group", &["first", "foreign"])];
    assert!(db.create_canvas_nodes_batch("p", &values, &invalid).is_err());
    assert!(db.list_canvas_nodes("p").unwrap().is_empty());
    assert!(db.list_canvas_groups("p").unwrap().is_empty());

    let valid = [batch_group("p", "group", &["second", "first"])];
    let created = db.create_canvas_nodes_batch("p", &values, &valid).unwrap();
    assert_eq!(created.nodes.len(), 2);
    assert_eq!(created.groups.len(), 1);
    let replay = db.create_canvas_nodes_batch("p", &values, &valid).unwrap();
    assert_eq!(created.nodes, replay.nodes);
    assert_eq!(created.groups, replay.groups);

    let changed = [batch_group("p", "group", &["first", "second"])];
    assert!(db.create_canvas_nodes_batch("p", &[note("p", "late")], &changed).is_err());
    assert!(db.get_canvas_node("late").unwrap().is_none());
    let members = db.list_canvas_group_items("p").unwrap();
    assert_eq!(members.iter().map(|item| item.node_id.as_str()).collect::<Vec<_>>(), ["second", "first"]);
}

#[test]
fn batch_layout_rolls_back_on_hidden_missing_and_cross_project_entries() {
    let db = db();
    materialize(&db, "p");
    materialize(&db, "other");
    for (project, id) in [("p", "first"), ("p", "hidden"), ("other", "foreign")] {
        db.create_canvas_node(&note(project, id)).unwrap();
    }
    db.lock_conn().unwrap().execute("UPDATE canvas_nodes SET hidden_at=1 WHERE id='hidden'", []).unwrap();
    let layout = |id: &str| CanvasNodeBatchLayout {
        node_id: id.into(),
        value: CanvasNodeLayoutUpdate {
            x: 200.0, y: 300.0, width: 400.0, height: 500.0, z_index: 6, position_locked: true,
        },
    };
    let original = db.get_canvas_node("first").unwrap().unwrap();
    for id in ["hidden", "missing", "foreign"] {
        assert!(db.update_canvas_nodes_batch("p", &[layout("first"), layout(id)], &[]).is_err());
        assert_eq!(db.get_canvas_node("first").unwrap(), Some(original.clone()));
    }
    let group = batch_group("other", "foreign-group", &[]);
    let mut group = db.create_canvas_group_with_items(&group.value, &group.node_ids).unwrap();
    group.project_id = "p".into(); // The stored row still belongs to the other project.
    assert!(db.update_canvas_nodes_batch("p", &[layout("first")], &[group]).is_err());
    assert_eq!(db.get_canvas_node("first").unwrap(), Some(original));
    db.update_canvas_nodes_batch("p", &[layout("first")], &[]).unwrap();
    assert_eq!(db.get_canvas_node("first").unwrap().unwrap().x, 200.0);
}

#[test]
fn visible_canvas_nodes_filter_project_and_hidden_instances() {
    let db = db();
    for project in ["p", "other"] {
        materialize(&db, project);
    }
    for (project, id) in [("p", "visible"), ("p", "hidden"), ("p", "unrequested"), ("other", "foreign")] {
        db.create_canvas_node(&note(project, id)).unwrap();
    }
    db.conn.lock().unwrap().execute("UPDATE canvas_nodes SET hidden_at=1 WHERE id='hidden'", []).unwrap();
    let ids = ["hidden", "visible", "visible", "missing", "foreign"].map(String::from);
    let nodes = db.visible_canvas_nodes("p", &ids).unwrap();
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0], db.get_canvas_node("visible").unwrap().unwrap());
    assert!(db.visible_canvas_nodes("p", &[]).unwrap().is_empty());
}

#[test]
fn snapshot_clears_persisted_manual_gallery_with_an_escaped_json_key() {
    let db = db();
    materialize(&db, "p");
    db.create_canvas_node(&note("p", "escaped")).unwrap();
    let legacy = r#"{"schema_version":1,"text":"original","generation_gallery_\u006bey":"manual\u003atest","workflow_generation_group":"old","manual_gallery_node":true}"#;
    db.lock_conn().unwrap().execute(
        "UPDATE canvas_nodes SET payload_json=?1 WHERE id='escaped'", [legacy],
    ).unwrap();

    let snapshot = db.project_canvas_snapshot("p").unwrap();
    let payload: serde_json::Value = serde_json::from_str(&snapshot.nodes[0].payload_json).unwrap();
    assert_eq!(payload["text"], "original");
    for field in ["generation_gallery_key", "workflow_generation_group", "manual_gallery_node"] {
        assert!(payload.get(field).is_none());
    }
    assert_eq!(db.get_canvas_node("escaped").unwrap().unwrap().payload_json, legacy);
}

#[test]
fn snapshot_preserves_non_object_payloads_during_gallery_projection() {
    let db = db();
    materialize(&db, "p");
    db.create_canvas_node(&note("p", "legacy")).unwrap();
    db.create_canvas_node(&note("p", "regular")).unwrap();
    db.lock_conn().unwrap().execute_batch(
        "UPDATE canvas_nodes SET payload_json='[42]' WHERE id='legacy';
         INSERT INTO generation_gallery_merges(source_key,group_key)
         VALUES('node:legacy','manual:test'),('node:regular','manual:test');",
    ).unwrap();

    let nodes = db.project_canvas_snapshot("p").unwrap().nodes;
    assert_eq!(nodes.iter().find(|node| node.id == "legacy").unwrap().payload_json, "[42]");
    let regular = nodes.iter().find(|node| node.id == "regular").unwrap();
    let projected: serde_json::Value = serde_json::from_str(&regular.payload_json).unwrap();
    assert_eq!(projected["generation_gallery_key"], "manual:test");
    assert!(db.remove_canvas_node("legacy").unwrap().is_some());
    assert!(db.get_canvas_node("regular").unwrap().is_some());
}

#[test]
fn canvas_write_waits_for_another_writer_while_wal_reads_continue() {
    use std::{sync::mpsc, thread, time::Duration};

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("canvas.db");
    let db = Database::open(&path).unwrap();
    db.migrate().unwrap();
    materialize(&db, "p");
    db.create_canvas_node(&note("p", "first")).unwrap();
    db.create_canvas_node(&note("p", "second")).unwrap();
    let writer = Database::open(&path).unwrap();
    let reader = Database::open_read_only(&path).unwrap();
    let mut conn = db.lock_conn().unwrap();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
    tx.execute("UPDATE canvas_nodes SET x=75 WHERE id='first'", []).unwrap();

    let (started, start) = mpsc::channel();
    let (finished, finish) = mpsc::channel();
    let write = thread::spawn(move || {
        let layout = CanvasNodeLayoutUpdate {
            x: 150.0, y: 30.0, width: 200.0, height: 100.0, z_index: 5, position_locked: false,
        };
        started.send(()).unwrap();
        finished.send(writer.update_canvas_node_layout("second", &layout)).unwrap();
    });
    start.recv_timeout(Duration::from_secs(2)).unwrap();
    let while_locked = finish.recv_timeout(Duration::from_millis(100));
    let snapshot = reader.project_canvas_snapshot("p").unwrap();
    assert_ne!(snapshot.nodes.iter().find(|node| node.id == "first").unwrap().x, 75.0);
    tx.commit().unwrap();

    assert!(matches!(while_locked, Err(mpsc::RecvTimeoutError::Timeout)));
    let moved = finish.recv_timeout(Duration::from_secs(3)).unwrap().unwrap().unwrap();
    assert_eq!(moved.x, 150.0);
    assert_eq!(reader.get_canvas_node("first").unwrap().unwrap().x, 75.0);
    write.join().unwrap();
}

#[test]
fn project_canvas_has_asset_checks_visible_instances_in_the_requested_project() {
    let db = db();
    for project in ["p", "other"] {
        materialize(&db, project);
    }
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO assets(id,name,ext,source,created_at) VALUES('a','a','png','imported',1)", []).unwrap();
        for (id, project, kind, role, hidden) in [
            ("hidden", "p", "asset", Some("reference"), Some(1)),
            ("note", "p", "note", None, None),
            ("foreign", "other", "asset", Some("reference"), None),
        ] {
            conn.execute(
                "INSERT INTO canvas_nodes
                 (id,project_id,kind,asset_id,role,payload_json,x,y,width,height,hidden_at,created_at,updated_at)
                 VALUES (?1,?2,?3,'a',?4,'{\"schema_version\":1}',0,0,10,10,?5,1,1)",
                params![id, project, kind, role, hidden],
            ).unwrap();
        }
    }
    assert!(!db.project_canvas_has_asset("p", "a").unwrap());
    assert!(db.project_canvas_has_asset("other", "a").unwrap());
    assert!(!db.project_canvas_has_asset("other", "missing").unwrap());
    assert!(matches!(db.project_canvas_has_asset("missing", "a"), Err(crate::error::AppError::NotFound(_))));
    db.conn.lock().unwrap().execute("UPDATE canvas_nodes SET hidden_at=NULL WHERE id='hidden'", []).unwrap();
    assert!(db.project_canvas_has_asset("p", "a").unwrap());
}

#[test]
fn h3_gallery_restores_legacy_results_and_scopes_persisted_producers() {
    use crate::core::catalog_browser::CatalogFilter;
    let db = db();
    for project in ["p1", "p2"] {
        materialize(&db, project);
        db.create_creative_thread(&NewCreativeThread { id: project.into(), project_id: project.into(), title: "H3".into(), origin: CreativeThreadOrigin::Direct }).unwrap();
    }
    for i in 1..=5 {
        let project = if i == 5 { "p2" } else { "p1" };
        let asset = format!("video-{i}");
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,source,created_at) VALUES(?1,?1,'mp4','comfy-h3',?2)", params![asset, i]).unwrap();
        db.add_assets_to_project(project, &[asset.clone()]).unwrap();
        let mut node = output(project, project, &format!("workflow-comfy:job-{i}"), &asset);
        if i >= 3 {
            let mut payload: serde_json::Value = serde_json::from_str(&node.payload_json).unwrap();
            payload["workflow_source"] = if i == 4 { "other" } else { "shared" }.into();
            node.payload_json = payload.to_string();
        }
        db.create_canvas_node(&node).unwrap();
    }
    let history = serde_json::json!({"schema_version":1,"nodes":[],"runs":[
        {"steps":{"shared":{"jobId":"job-1"}}},{"steps":{"shared":{"jobId":"job-2"}}}]});
    db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p1',1,?1)", [history.to_string()]).unwrap();
    let snapshot = db.project_canvas_snapshot("p1").unwrap();
    let group = |id: &str| {
        let node = snapshot.nodes.iter().find(|n| n.id == id).unwrap();
        serde_json::from_str::<serde_json::Value>(&node.payload_json).unwrap()["workflow_generation_group"].clone()
    };
    assert_eq!(group("workflow-comfy:job-1"), group("workflow-comfy:job-3"));
    assert_ne!(group("workflow-comfy:job-1"), group("workflow-comfy:job-4"));
    assert!(db.get_canvas_node("workflow-comfy:job-1").unwrap().unwrap().payload_json.find("workflow_generation_group").is_none());
    let filter = CatalogFilter { kind:"all".into(),media:"videos".into(),generated:Some(true),..Default::default() };
    assert_eq!(db.catalog_overview(&filter, None).unwrap().total, 3);
    assert_eq!(db.catalog_ids(&filter, 0, 10).unwrap(), vec!["video-5","video-4","video-3"]);
    assert_eq!(db.catalog_generation_groups(&filter, &["video-3".into()]).unwrap()["video-3"].len(), 3);
    let scoped = CatalogFilter { project_id:Some("p1".into()),..filter.clone() };
    assert_eq!(db.catalog_overview(&scoped, None).unwrap().total, 2);
    assert_eq!(db.catalog_page(&scoped, 1, 1).unwrap()[0].id, "video-3");
    let searched = CatalogFilter { query:Some("video-1".into()),..scoped };
    assert_eq!(db.catalog_ids(&searched, 0, 10).unwrap(), vec!["video-1"]);
    assert_eq!(db.catalog_generation_groups(&searched, &["video-1".into()]).unwrap()["video-1"].len(), 1);
    db.remove_canvas_node("workflow-comfy:job-2").unwrap();
    assert!(db.project_canvas_snapshot("p1").unwrap().nodes.iter().find(|n| n.id == "workflow-comfy:job-2").unwrap().hidden_at.is_some());
    db.dissolve_generation_group(Some("video-3"), None).unwrap();
    assert_eq!(db.catalog_overview(&filter, None).unwrap().total, 5);
    assert_eq!(db.catalog_generation_groups(&filter, &["video-1".into()]).unwrap()["video-1"].len(), 1);
    let separated = db.project_canvas_snapshot("p1").unwrap();
    for id in ["workflow-comfy:job-1", "workflow-comfy:job-3"] {
        let node = separated.nodes.iter().find(|node| node.id == id).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&node.payload_json).unwrap()["generation_group_dissolved"], true);
    }
    assert!(db.project_canvas_snapshot("p2").unwrap().nodes.iter().all(|node| !node.payload_json.contains("generation_group_dissolved")), "another project's producer stays independent");
}

#[test]
fn workflow_galleries_cover_images_video_agent_tools_and_provider_handoffs() {
    use crate::core::catalog_browser::CatalogFilter;
    let db = db();
    materialize(&db, "p");
    db.create_creative_thread(&NewCreativeThread { id:"t".into(),project_id:"p".into(),title:"test".into(),origin:CreativeThreadOrigin::Direct }).unwrap();
    for (job, conversation) in [("image-1","first"),("image-2","second"),("handoff","first"),("video-1","v1"),("video-2","v2"),("tool-1","tool"),("tool-2","tool")] {
        let mut prompt = note("p", &format!("gen-prompt:{job}:turn:0"));
        prompt.kind = CreativeNodeKind::Prompt;
        prompt.thread_id = Some("t".into());
        prompt.payload_json = serde_json::json!({"schema_version":1,"text":"test","job_id":job,"conversation_id":conversation,"turn_key":"turn"}).to_string();
        db.create_canvas_node(&prompt).unwrap();
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,created_at,generation_session_id) VALUES(?1,?1,'png',1,?2)", params![job,conversation]).unwrap();
        let mut result = output("p", "t", &format!("gen-output:{job}:turn:{job}"), job);
        let mut payload: serde_json::Value = serde_json::from_str(&result.payload_json).unwrap();
        payload["execution"] = serde_json::json!({"job_id":job,"turn_key":"turn"});
        result.payload_json = payload.to_string();
        db.create_canvas_node(&result).unwrap();
    }
    for request in ["hf-1","hf-2"] {
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,created_at) VALUES(?1,?1,'mp4',2)", [request]).unwrap();
        db.create_canvas_node(&output("p", "t", &format!("workflow-video:{request}"), request)).unwrap();
    }
    let history = serde_json::json!({"schema_version":1,"nodes":[],"runs":[
        {"steps":{"image":{"jobId":"image-1"},"video":{"jobId":"video-1"},"hyperframes":{"localDsRequestId":"hf-1"},"agent":{"localDsGenerations":{"call":{"jobId":"tool-1"},"second":{"jobId":"tool-2"}}}}},
        {"steps":{"image":{"jobId":"image-2"},"video":{"jobId":"video-2"},"hyperframes":{"localDsRequestId":"hf-2"}}}]});
    db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p',1,?1)",[history.to_string()]).unwrap();
    db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,created_at) VALUES('projection-missing','projection-missing','png',3);
        INSERT INTO analyses(id,asset_id,kind,payload) VALUES('missing','projection-missing','generation_meta','{\"job_id\":\"image-2\",\"conversation_id\":\"second\"}');").unwrap();
    let snapshot = db.project_canvas_snapshot("p").unwrap();
    let group = |id: &str| serde_json::from_str::<serde_json::Value>(&snapshot.nodes.iter().find(|n| n.id==id).unwrap().payload_json).unwrap()["workflow_generation_group"].clone();
    let image = group("gen-prompt:image-1:turn:0");
    assert!(image.is_string());
    for id in ["gen-prompt:image-2:turn:0","gen-prompt:handoff:turn:0","gen-output:handoff:turn:handoff"] { assert_eq!(image,group(id)); }
    assert_eq!(group("workflow-video:hf-1"),group("workflow-video:hf-2"));
    assert_ne!(image,group("gen-prompt:video-1:turn:0"));
    let filter = CatalogFilter { kind:"all".into(),media:"all".into(),generated:Some(true),..Default::default() };
    assert_eq!(db.catalog_overview(&filter,None).unwrap().total,5);
    assert_eq!(group("gen-prompt:tool-1:turn:0"),serde_json::json!("asset:gen-prompt:tool-1:turn:0"));
    assert_ne!(group("gen-output:tool-1:turn:tool-1"),group("gen-output:tool-2:turn:tool-2"));
    let members = db.catalog_generation_groups(&filter,&["image-2".into(),"video-2".into(),"hf-2".into(),"tool-1".into()]).unwrap();
    assert_eq!(members["image-2"].len(),4);
    assert_eq!(members["video-2"].len(),2);
    assert_eq!(members["hf-2"].len(),2);
    assert_eq!(members["tool-1"].len(),1);
    assert!(!db.get_canvas_node("gen-prompt:image-1:turn:0").unwrap().unwrap().payload_json.contains("workflow_generation_group"));
}

#[test]
fn gallery_provenance_covers_agent_finals_chat_video_and_missing_provider_sessions() {
    use crate::core::catalog_browser::CatalogFilter;
    let db = db();
    materialize(&db, "p");
    db.create_creative_thread(&NewCreativeThread { id:"t".into(),project_id:"p".into(),title:"test".into(),origin:CreativeThreadOrigin::Direct }).unwrap();
    db.create_canvas_node(&note("p","chat-node")).unwrap();
    for (i,id) in ["agent-1","agent-2","intermediate","chat-1","chat-2","reference","raw-1","raw-2","meta-1","meta-2"].iter().enumerate() {
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,created_at) VALUES(?1,?1,'png',?2)",params![id,i as i64]).unwrap();
    }
    for (run, asset, role) in [("run-1","agent-1",CreativeNodeRole::Final),("run-2","agent-2",CreativeNodeRole::Final),("run-2","intermediate",CreativeNodeRole::Intermediate)] {
        db.conn.lock().unwrap().execute("INSERT OR IGNORE INTO cloud_agent_runs(run_id,conversation_id,skill_id,status,intent_prompt,reference_asset_ids,project_id,snapshot_json,created_at,updated_at) VALUES(?1,'agent-conversation','skill','succeeded','','[]','p','{}',1,1)",[run]).unwrap();
        let mut node = output("p","t",&format!("agent-artifact:{run}:0:{asset}"),asset);
        node.role = Some(role);
        let mut payload: serde_json::Value = serde_json::from_str(&node.payload_json).unwrap();
        payload["execution"] = serde_json::json!({"run_id":run,"artifact_id":asset});
        node.payload_json = payload.to_string();
        db.create_canvas_node(&node).unwrap();
    }
    {
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("UPDATE assets SET generation_session_id='agent-conversation' WHERE id LIKE 'agent-%';
            INSERT INTO local_chat_conversations(id,project_id,thread_id,node_id,title,status,created_at,updated_at) VALUES('chat','p','t','chat-node','test','idle',1,1);
            INSERT INTO local_chat_turns(id,conversation_id,request_id,request_json,status,created_at,updated_at) VALUES('turn-1','chat','request-1','{}','done',1,1),('turn-2','chat','request-2','{}','done',2,2);
            INSERT INTO local_chat_messages(id,conversation_id,turn_id,role,text,reference_asset_ids,status,created_at,updated_at) VALUES
              ('turn-1-video','chat','turn-1','tool','','[\"chat-1\"]','done',1,1),('turn-2-video','chat','turn-2','tool','','[\"chat-2\"]','done',2,2),
              ('reference-message','chat','turn-1','user','','[\"reference\"]','done',1,1);
            INSERT INTO analyses(id,asset_id,kind,payload) VALUES('meta-1','meta-1','generation_meta','{\"conversation_id\":\"missing-session\"}'),('meta-2','meta-2','generation_meta','{\"conversation_id\":\"missing-session\"}');").unwrap();
        let history = serde_json::json!({"schema_version":1,"nodes":[],"runs":[
            {"steps":{"raw":{"localDsRequestId":"legacy","agentOutputs":{"image":{"assetIds":["raw-1"]}}}}},
            {"steps":{"raw":{"localDsRequestId":"new","generatedAssetIds":["raw-2"],"agentOutputTargets":[{}],"agentOutputs":{"image":{"assetIds":["raw-2","reference"]}}}}}]});
        conn.execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p',1,?1)",[history.to_string()]).unwrap();
    }
    let snapshot = db.project_canvas_snapshot("p").unwrap();
    let group = |id: &str| serde_json::from_str::<serde_json::Value>(&snapshot.nodes.iter().find(|n| n.id==id).unwrap().payload_json).unwrap()["workflow_generation_group"].clone();
    assert_eq!(group("agent-artifact:run-1:0:agent-1"),serde_json::json!("generation:agent-conversation"));
    assert_eq!(group("agent-artifact:run-1:0:agent-1"),group("agent-artifact:run-2:0:agent-2"));
    assert!(group("agent-artifact:run-2:0:intermediate").is_null());
    db.conn.lock().unwrap().execute("UPDATE canvas_workflows SET document_json=json_set(document_json,'$.runs[0].steps.cloud',json('{\"agentRunId\":\"run-1\"}')) WHERE project_id='p'",[]).unwrap();
    let owned = db.project_canvas_snapshot("p").unwrap();
    for id in ["agent-artifact:run-1:0:agent-1","agent-artifact:run-2:0:agent-2"] {
        let payload: serde_json::Value = serde_json::from_str(&owned.nodes.iter().find(|n| n.id==id).unwrap().payload_json).unwrap();
        assert_eq!(payload["workflow_generation_group"],serde_json::json!(format!("asset:{id}")));
    }
    let filter = CatalogFilter { kind:"all".into(),media:"all".into(),generated:Some(true),..Default::default() };
    assert_eq!(db.catalog_overview(&filter,None).unwrap().total,6);
    let members = db.catalog_generation_groups(&filter,&["agent-2".into(),"chat-2".into(),"raw-2".into(),"meta-2".into(),"reference".into()]).unwrap();
    for id in ["agent-2","raw-2"] { assert_eq!(members[id].len(),1,"Agent image {id}"); }
    for id in ["chat-2","meta-2"] { assert_eq!(members[id].len(),2,"{id}"); }
    assert!(!members.contains_key("reference"));
    assert_eq!(db.catalog_ids(&CatalogFilter { generated:Some(false),..filter },0,20).unwrap(),vec!["reference","intermediate"]);
}

fn materialize(db: &Database, id: &str) {
    db.materialize_project_canvas(
        &ProjectCanvasMaterializeInput {
            project_id: id.into(),
            name: format!("项目 {id}"),
            workspace_path: format!("blank:{id}"),
            workspace_key: format!("blank:{id}"),
            kind: "blank".into(),
            title_source: ProjectTitleSource::Default,
            draft_json: r#"{"schema_version":1}"#.into(),
        },
        &[],
        &[],
        None,
    )
    .unwrap();
}

fn note(project_id: &str, id: &str) -> NewCanvasNode {
    NewCanvasNode {
        id: id.into(),
        project_id: project_id.into(),
        thread_id: None,
        kind: CreativeNodeKind::Note,
        asset_id: None,
        role: None,
        payload_json: r#"{"schema_version":1,"text":"note"}"#.into(),
        x: 0.0,
        y: 0.0,
        width: 160.0,
        height: 100.0,
        z_index: 0,
        position_locked: false,
    }
}

fn prompt(project_id: &str, thread_id: &str, id: &str) -> NewCanvasNode {
    NewCanvasNode {
        id: id.into(),
        project_id: project_id.into(),
        thread_id: Some(thread_id.into()),
        kind: CreativeNodeKind::Prompt,
        asset_id: None,
        role: None,
        payload_json: r#"{"schema_version":1,"text":"prompt"}"#.into(),
        x: 200.0,
        y: 0.0,
        width: 220.0,
        height: 120.0,
        z_index: 1,
        position_locked: false,
    }
}

fn output(project_id: &str, thread_id: &str, id: &str, asset_id: &str) -> NewCanvasNode {
    NewCanvasNode {
        id: id.into(),
        project_id: project_id.into(),
        thread_id: Some(thread_id.into()),
        kind: CreativeNodeKind::Asset,
        asset_id: Some(asset_id.into()),
        role: Some(CreativeNodeRole::Output),
        payload_json: serde_json::to_string(&AssetNodePayloadV1 {
            draft_document_id: None,
            workflow_source: None,
            workflow_generation_group: None,
            schema_version: 1,
            snapshot: AssetSnapshotV1 {
                name: asset_id.into(),
                width: None,
                height: None,
            },
            execution: None,
        })
        .unwrap(),
        x: 0.0,
        y: 0.0,
        width: 190.0,
        height: 180.0,
        z_index: 1,
        position_locked: false,
    }
}

#[test]
fn materialize_is_atomic_and_one_project_has_one_canvas() {
    let db = db();
    materialize(&db, "p1");
    assert_eq!(db.ensure_project_canvas("p1").unwrap().project_id, "p1");
    let conn = db.conn.lock().unwrap();
    assert!(conn
        .execute(
            "INSERT INTO project_canvases (project_id,draft_json,created_at,updated_at) VALUES ('p1','{\"schema_version\":1}',2,2)",
            [],
        )
        .is_err());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM project_canvases", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn large_content_card_round_trips_without_losing_cells() {
    let db = db();
    materialize(&db, "p1");
    let cells: Vec<Vec<serde_json::Value>> = (0..51).map(|r| (0..9).map(|c| {
        serde_json::json!({
            "id": format!("cell-{r}-{c}"), "text": "保留表格正文与换行\n".repeat(5),
            "bold": r == 0, "italic": false, "align": "left", "content_type": "text"
        })
    }).collect()).collect();
    let text = cells.iter().map(|row| row.iter().map(|cell| cell["text"].as_str().unwrap())
        .collect::<Vec<_>>().join("\t")).collect::<Vec<_>>().join("\n");
    let payload = serde_json::json!({
        "schema_version": 1, "note_type": "text", "text": text, "cells": cells
    }).to_string();
    assert!(payload.len() > 64 * 1024);
    db.create_canvas_node(&NewCanvasNode { payload_json: payload.clone(), ..note("p1", "large") }).unwrap();
    db.create_canvas_node(&note("p1", "receiver")).unwrap();
    db.update_canvas_note_payload("receiver", &payload).unwrap();
    for node in db.project_canvas_snapshot("p1").unwrap().nodes {
        assert_eq!(node.payload_json, payload);
    }
    let oversized = serde_json::json!({"schema_version": 1, "text": "x".repeat(4 * 1024 * 1024)}).to_string();
    assert!(db.update_canvas_note_payload("receiver", &oversized).is_err());
    assert!(db.create_canvas_node(&NewCanvasNode { payload_json: oversized, ..note("p1", "too-large") }).is_err());
    let snapshot = db.project_canvas_snapshot("p1").unwrap();
    assert_eq!(snapshot.nodes.len(), 2);
    assert!(snapshot.nodes.iter().all(|node| node.payload_json == payload));
}

#[test]
fn document_note_source_examples_do_not_register_project_media() {
    let db = db();
    materialize(&db, "p1");
    for id in ["frontmatter", "fenced", "indented", "adjacent", "valid"] {
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,created_at) VALUES(?1,?1,1)", [id]).unwrap();
    }
    let markdown = "---\n<img data-bowerbird-asset=\"frontmatter\" data-caption=\"\" />\n---\n\n```html\n\n<img data-bowerbird-asset=\"fenced\" data-caption=\"\" />\n\n```\n\n    <img data-bowerbird-asset=\"indented\" data-caption=\"\" />\n\n<div>\n<img data-bowerbird-asset=\"adjacent\" data-caption=\"\" />\n</div>\n\n<img data-bowerbird-asset=\"valid\" data-caption=\"\" />\n";
    let payload = serde_json::json!({"schema_version":1,"note_type":"document","text":markdown,"cells":[],"member_ids":[]}).to_string();
    db.create_canvas_node(&NewCanvasNode { payload_json: payload, ..note("p1", "document") }).unwrap();
    let registered: Vec<String> = db.conn.lock().unwrap().prepare("SELECT asset_id FROM project_assets WHERE project_id='p1' ORDER BY asset_id").unwrap().query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(registered, vec!["valid"]);
}

#[test]
fn document_note_nested_media_uses_current_rich_state_only() {
    let source = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/fixtures/text-editor-demo/rich-reference.md"));
    assert_eq!(document_asset_ids(source), vec!["nested-photo"]);
    assert!(document_asset_ids(&source.replace("Reference", "Changed")).is_empty());
}

#[test]
fn document_note_round_trip_protects_registered_media_without_reinterpreting_text() {
    let db = db();
    materialize(&db, "p1");
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,created_at) VALUES('photo','reference',1),('audio','audio',1),('legacy','legacy',1)", []).unwrap();
    let markdown = "# 剧本\n\n**第一幕**\n\n<img data-bowerbird-asset=\"%70hoto\" data-caption=\"\" />\n\n<audio data-bowerbird-asset=\"audio\" data-caption=\"\" />\n\n![旧引用](bowerbird-asset:legacy)\n";
    let payload = serde_json::json!({"schema_version":1,"note_type":"document","title":"剧本","text":markdown,"cells":[],"member_ids":[]}).to_string();
    db.create_canvas_node(&NewCanvasNode { payload_json: payload.clone(), ..note("p1", "document") }).unwrap();
    assert_eq!(db.project_canvas_snapshot("p1").unwrap().nodes[0].payload_json, payload);
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p1' AND asset_id IN ('photo','audio','legacy')", [], |row| row.get::<_,i64>(0)).unwrap(), 3);
    db.update_canvas_note_payload("document", &payload.replace("第一幕", "第二幕")).unwrap();
    db.remove_canvas_node("document").unwrap();
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets", [], |row| row.get::<_,i64>(0)).unwrap(), 3);
}

#[test]
fn generation_cell_reference_survives_note_save_and_result_resolution() {
    let db = db();
    materialize(&db, "p1");
    db.create_canvas_node(&note("p1", "table")).unwrap();
    let mut payload = serde_json::json!({"schema_version":1,"note_type":"text","text":"","member_ids":[],
        "cells":[[{"id":"cell","content_type":"image","text":"","bold":false,"italic":false,"align":"left",
            "generation_ref":{"session_node_id":"saved-session"}}]]});
    db.update_canvas_note_payload("table", &payload.to_string()).unwrap();
    let snapshot = db.project_canvas_snapshot("p1").unwrap();
    let saved = snapshot.nodes.iter().find(|node| node.id == "table").unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&saved.payload_json).unwrap()["cells"][0][0]["generation_ref"]["session_node_id"], "saved-session");
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,created_at) VALUES('generated-image','result',1)", []).unwrap();
    payload["cells"][0][0]["generation_ref"]["output_node_id"] = serde_json::json!("result-node");
    payload["cells"][0][0]["image_refs"] = serde_json::json!([{"asset_id":"generated-image","token":"@图片1"}]);
    db.update_canvas_note_payload("table", &payload.to_string()).unwrap();
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p1' AND asset_id='generated-image'", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
    payload["cells"][0][0]["generation_ref"]["session_node_id"] = serde_json::json!("");
    assert!(db.update_canvas_note_payload("table", &payload.to_string()).is_err());
    payload["cells"][0][0]["generation_ref"]["session_node_id"] = serde_json::json!("saved-session");
    payload["cells"][0][0]["content_type"] = serde_json::json!("text");
    assert!(db.update_canvas_note_payload("table", &payload.to_string()).is_err());
}

#[test]
fn artboard_base_survives_reload_and_records_project_membership() {
    let db = db();
    materialize(&db, "p1");
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,created_at) VALUES('artboard-base','model',1)", []).unwrap();
    let mut value = note("p1", "artboard");
    value.payload_json = r#"{"schema_version":1,"text":"画板","note_type":"section","cells":[],"member_ids":[],"artboard":{"base_asset_id":"artboard-base"}}"#.into();
    db.create_canvas_node(&value).unwrap();
    let snapshot = db.project_canvas_snapshot("p1").unwrap();
    assert_eq!(snapshot.nodes.iter().find(|node| node.id == "artboard").unwrap().payload_json, value.payload_json);
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p1' AND asset_id='artboard-base'", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
    let missing = value.payload_json.replace("artboard-base", "missing-base");
    assert!(db.update_canvas_note_payload("artboard", &missing).is_err());
    let wrong_kind = value.payload_json.replace("section", "text");
    assert!(db.update_canvas_note_payload("artboard", &wrong_kind).is_err());
    assert_eq!(db.project_canvas_snapshot("p1").unwrap().nodes.iter().find(|node| node.id == "artboard").unwrap().payload_json, value.payload_json);
    db.remove_canvas_node("artboard").unwrap();
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM assets WHERE id='artboard-base'", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
}

#[test]
fn note_editing_preserves_layout_and_rejects_execution_nodes() {
    let db = db();
    materialize(&db, "p1");
    let original = db.create_canvas_node(&note("p1", "text")).unwrap();
    let payload = r#"{"schema_version":1,"text":"hello","note_type":"text","cells":[[{"text":"hello","bold":true,"italic":true,"align":"center"}]],"member_ids":[]}"#;
    let updated = db.update_canvas_note_payload("text", payload).unwrap();
    assert_eq!(updated.payload_json, payload);
    let mut with_cell_id: serde_json::Value = serde_json::from_str(payload).unwrap();
    with_cell_id["cells"][0][0]["id"] = serde_json::json!("stable-cell");
    with_cell_id["cells"][0][0]["image_refs"] = serde_json::json!([{"asset_id":"reference-image","token":"@图片1"}]);
    let saved_cell = db.update_canvas_note_payload("text", &with_cell_id.to_string()).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&saved_cell.payload_json).unwrap()["cells"][0][0]["id"], "stable-cell");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&saved_cell.payload_json).unwrap()["cells"][0][0]["image_refs"][0]["asset_id"], "reference-image");
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,created_at) VALUES('container-image','image',1)", []).unwrap();
    let mut image_grid = with_cell_id.clone();
    image_grid["note_type"] = serde_json::json!("images");
    image_grid["cells"][0][0]["image_refs"][0]["asset_id"] = serde_json::json!("container-image");
    let saved_grid = db.update_canvas_note_payload("text", &image_grid.to_string()).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&saved_grid.payload_json).unwrap()["note_type"], "images");
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p1' AND asset_id='container-image'", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
    image_grid["note_type"] = serde_json::json!("text");
    image_grid["cells"][0][0]["content_type"] = serde_json::json!("image");
    image_grid["cells"][0].as_array_mut().unwrap().push(serde_json::json!({"id":"text-cell","text":"原样文本","content_type":"text","bold":false,"italic":false,"align":"left"}));
    assert_eq!(db.remove_assets_from_project("p1", &["container-image".into()], false).unwrap(), 1);
    let mixed = db.update_canvas_note_payload("text", &image_grid.to_string()).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&mixed.payload_json).unwrap()["cells"][0][0]["content_type"], "image");
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p1' AND asset_id='container-image'", [], |row| row.get::<_,i64>(0)).unwrap(), 0, "editing another cell must not re-add a removed member");
    image_grid["cells"][0][0]["content_type"] = serde_json::json!("invalid");
    assert!(db.update_canvas_note_payload("text", &image_grid.to_string()).is_err());
    assert_eq!((updated.x, updated.y, updated.width), (original.x, original.y, original.width));
    assert_eq!(updated.thread_id, None);
    for height in [100, 155, 300] {
        let mut spaced: serde_json::Value = serde_json::from_str(payload).unwrap();
        spaced["line_height_percent"] = serde_json::json!(height);
        let json = spaced.to_string();
        db.update_canvas_note_payload("text", &json).unwrap();
        let snapshot = db.project_canvas_snapshot("p1").unwrap();
        assert_eq!(snapshot.nodes.iter().find(|node| node.id == "text").unwrap().payload_json, json);
    }
    for height in [99, 301] {
        let mut spaced: serde_json::Value = serde_json::from_str(payload).unwrap();
        spaced["line_height_percent"] = serde_json::json!(height);
        assert!(db.update_canvas_note_payload("text", &spaced.to_string()).is_err());
    }
    let view = CanvasViewInput {
        project_id: "p1".into(), pan_x: 0.0, pan_y: 0.0, zoom: 0.1,
        source_panel_width: None, workspace_width: None, active_node_id: None,
        focused_thread_id: None, view_mode: ProjectCanvasViewMode::Canvas,
        timeline_scope: ProjectTimelineScope::All,
    };
    db.upsert_canvas_view(&view).unwrap();
    assert_eq!(db.project_canvas_snapshot("p1").unwrap().view.unwrap().zoom, 0.1);
    assert!(db.update_canvas_note_payload("text", r#"{"schema_version":1,"text":"","cells":[[]]}"#).is_err());
    let section = r#"{"schema_version":1,"text":"分区","note_type":"section","cells":[],"member_ids":["text"]}"#;
    db.create_canvas_node(&NewCanvasNode { payload_json: section.into(), ..note("p1", "section") }).unwrap();
    let mut colored: serde_json::Value = serde_json::from_str(section).unwrap();
    colored["section_color"] = serde_json::json!("#347b53");
    assert_eq!(db.update_canvas_note_payload("section", &colored.to_string()).unwrap().payload_json, colored.to_string());
    colored["section_color"] = serde_json::json!("invalid");
    assert!(db.update_canvas_note_payload("section", &colored.to_string()).is_err());
    assert_eq!(db.project_canvas_snapshot("p1").unwrap().nodes.len(), 2);
    db.create_creative_thread(&NewCreativeThread { id: "t".into(), project_id: "p1".into(), title: "t".into(), origin: CreativeThreadOrigin::Direct }).unwrap();
    db.create_canvas_node(&prompt("p1", "t", "execution")).unwrap();
    assert!(db.update_canvas_note_payload("execution", payload).is_err());
    db.remove_canvas_node("text").unwrap();
    assert!(db.update_canvas_note_payload("text", payload).is_err());
}

#[test]
fn workflow_generation_stays_anchored_and_recovery_preserves_layout() {
    let db = db(); materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread { id: "t1".into(), project_id: "p1".into(), title: "workflow".into(), origin: CreativeThreadOrigin::Direct }).unwrap();
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,store_path,created_at) VALUES('a','a','/a.png',1)", []).unwrap();
    let mut reference = output("p1", "t1", "reference", "a");
    reference.x = -900.0; reference.y = -400.0; reference.role = Some(CreativeNodeRole::Reference);
    db.create_canvas_node(&reference).unwrap();
    let doc = serde_json::json!({"schema_version":1,"nodes":[{"id":"w","x":100,"y":200,"sessionNodeIds":["gen-prompt:job:turn:0"]}],"run":null});
    db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p1',1,?1)", [doc.to_string()]).unwrap();
    let input = ProjectGenerationTurnInput {
        project_id:"p1".into(), thread_id:"t1".into(), generation_conversation_id:"conversation".into(), job_id:"job".into(), turn_key:"turn".into(),
        prompt:"test".into(), applied_prompt:"test".into(), provider:"test".into(), provider_session_id:None, ratio:None, visual_profile:None,
        references:vec!["/a.png".into()], reference_node_ids:vec![Some("reference".into())], parent_node_id:None, parent_asset_path:None, relation:None, retry_anchor_node_id:None,
    };
    let graph = db.begin_project_generation_turn(&input).unwrap();
    let first = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&first.payload_json).unwrap()["conversation_id"], "conversation");
    assert_eq!((first.x, first.y, first.position_locked), (484.0, 200.0, true));
    db.begin_project_generation_turn(&input).unwrap();
    let recovered = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
    assert_eq!((recovered.x,recovered.y),(first.x,first.y));
    let doc = serde_json::json!({"schema_version":1,"nodes":[
        {"id":"w","x":100,"y":200,"sessionNodeIds":["gen-prompt:job:turn:0","gen-prompt:job2:turn2:0"]},
        {"id":"downstream","x":1100,"y":200,"inputs":{"image":[{"nodeId":"w","portId":"image"}]}}
    ],"run":null});
    db.conn.lock().unwrap().execute("UPDATE canvas_workflows SET document_json=?1 WHERE project_id='p1'", [doc.to_string()]).unwrap();
    let next_input = ProjectGenerationTurnInput { job_id:"job2".into(), turn_key:"turn2".into(), ..input };
    let next = db.begin_project_generation_turn(&next_input).unwrap();
    let next_card = db.get_canvas_node(&next.prompt_node_id).unwrap().unwrap();
    assert_eq!((next_card.x,next_card.y), (first.x,first.y)); // Folded history reuses the visible gallery.
    let old = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
    assert_eq!((old.x,old.y),(first.x,first.y));
}

#[test]
fn first_workflow_image_replaces_source_at_delivery_and_replays_without_moving_it() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(), project_id: "p1".into(), title: "workflow".into(), origin: CreativeThreadOrigin::Direct,
    }).unwrap();
    let save = |document: &serde_json::Value| {
        db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p1',1,?1) ON CONFLICT(project_id) DO UPDATE SET document_json=excluded.document_json", [document.to_string()]).unwrap();
    };
    let mut doc = serde_json::json!({"schema_version":1,"nodes":[{"id":"image-card","kind":"generation","x":100,"y":200,
        "sessionNodeIds":["gen-prompt:job:first:0"],"activeSessionNodeId":"gen-prompt:job:first:0"}],
        "run":{"steps":{"image-card":{"jobId":"job"}}}});
    save(&doc);
    let input = ProjectGenerationTurnInput {
        project_id:"p1".into(), thread_id:"t1".into(), generation_conversation_id:"conversation".into(), job_id:"job".into(), turn_key:"first".into(),
        prompt:"first".into(), applied_prompt:"first".into(), provider:"test".into(), provider_session_id:None, ratio:None, visual_profile:None,
        references:vec![], reference_node_ids:vec![], parent_node_id:None, parent_asset_path:None, relation:None, retry_anchor_node_id:None,
    };
    let prompt = db.begin_project_generation_turn(&input).unwrap().prompt_node_id;
    let position = |id: &str| { let node = db.get_canvas_node(id).unwrap().unwrap(); (node.x, node.y) };
    assert_eq!(position(&prompt), (100.0, 200.0));
    // The source can be moved while the provider owns the submitted task.
    doc["nodes"][0]["x"] = 240.into();
    doc["nodes"][0]["y"] = 330.into();
    save(&doc);
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,ext,store_path,width,height,created_at) VALUES('first-image','first','png','/first.png',190,150,1)", []).unwrap();
    let assets = [db.get_asset("first-image").unwrap().unwrap()];
    let output = db.complete_project_generation_turn("p1", "t1", "job", "first", None, &assets).unwrap().remove(0);
    assert_eq!(position(&prompt), (240.0, 330.0));
    assert_eq!(position(&output), (240.0, 330.0));
    db.conn.lock().unwrap().execute("UPDATE canvas_nodes SET x=520,y=480 WHERE id IN (?1,?2)", params![prompt, output]).unwrap();
    db.complete_project_generation_turn("p1", "t1", "job", "first", None, &assets).unwrap();
    assert_eq!(position(&prompt), (520.0, 480.0));
    assert_eq!(position(&output), (520.0, 480.0));

    doc["nodes"][0]["sessionNodeIds"] = serde_json::json!([prompt,"gen-prompt:job2:second:0"]);
    doc["nodes"][0]["activeSessionNodeId"] = "gen-prompt:job2:second:0".into();
    doc["run"]["steps"]["image-card"]["jobId"] = "job2".into();
    save(&doc);
    let next = db.begin_project_generation_turn(&ProjectGenerationTurnInput {
        job_id:"job2".into(), turn_key:"second".into(), generation_conversation_id:"conversation2".into(), ..input
    }).unwrap();
    assert_eq!(position(&next.prompt_node_id), (520.0, 480.0));
}

#[test]
fn first_workflow_video_replaces_source_without_moving_old_image_or_replayed_video() {
    let db = db(); materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(), project_id: "p1".into(), title: "workflow".into(), origin: CreativeThreadOrigin::Direct,
    }).unwrap();
    let save = |document: &serde_json::Value| {
        db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p1',1,?1) ON CONFLICT(project_id) DO UPDATE SET document_json=excluded.document_json", [document.to_string()]).unwrap();
    };
    let mut doc = serde_json::json!({"schema_version":1,"nodes":[{"id":"card","kind":"generation","x":100,"y":200,
        "sessionNodeIds":["gen-prompt:job-image:one:0"],"activeSessionNodeId":"gen-prompt:job-image:one:0"}],
        "runs":[{"steps":{"card":{"jobId":"job-image"}}}]});
    save(&doc);
    db.conn.lock().unwrap().execute_batch("INSERT INTO assets(id,name,ext,store_path,width,height,created_at) VALUES
        ('image','old image','png','/still.png',190,150,1),('video','first video','mp4','/first.mp4',1920,1080,2),
        ('next-video','next video','mp4','/next.mp4',1920,1080,3)").unwrap();
    let image = ProjectGenerationTurnInput { project_id:"p1".into(),thread_id:"t1".into(),generation_conversation_id:"old-image".into(),
        job_id:"job-image".into(),turn_key:"one".into(),prompt:"image".into(),applied_prompt:"image".into(),provider:"test".into(),
        provider_session_id:None,ratio:None,visual_profile:None,references:vec![],reference_node_ids:vec![],parent_node_id:None,
        parent_asset_path:None,relation:None,retry_anchor_node_id:None };
    let image_prompt = db.begin_project_generation_turn(&image).unwrap().prompt_node_id;
    let image_id = db.complete_project_generation_turn("p1", "t1", "job-image", "one", None, &[db.get_asset("image").unwrap().unwrap()]).unwrap().remove(0);
    let position = |id: &str| { let node = db.get_canvas_node(id).unwrap().unwrap(); (node.x, node.y) };
    let old_position = position(&image_prompt);

    let video = ProjectGenerationTurnInput { job_id: "job-video".into(), turn_key: "two".into(), generation_conversation_id: "first-video".into(), ..image };
    doc["nodes"][0]["generation"]["media"] = "video".into();
    doc["nodes"][0]["x"] = 240.into();
    doc["nodes"][0]["y"] = 330.into();
    doc["nodes"][0]["activeSessionNodeId"] = "gen-prompt:job-video:two:0".into();
    doc["nodes"][0]["sessionNodeIds"].as_array_mut().unwrap().push("gen-prompt:job-video:two:0".into());
    doc["runs"].as_array_mut().unwrap().push(serde_json::json!({"steps":{"card":{"jobId":"job-video"}}}));
    save(&doc);
    let video_prompt = db.begin_project_generation_turn(&video).unwrap().prompt_node_id;
    let assets = [db.get_asset("video").unwrap().unwrap()];
    let video_id = db.complete_project_generation_turn("p1", "t1", "job-video", "two", None, &assets).unwrap().remove(0);
    assert_eq!(position(&video_id), (240.0, 330.0));
    assert_eq!(position(&video_prompt), (240.0, 330.0));
    assert_eq!(position(&image_prompt), old_position);
    assert_eq!(position(&image_id), old_position);
    let canvas = db.project_canvas_snapshot("p1").unwrap();
    assert_eq!(canvas.nodes.iter().find(|node| node.id == video_id).unwrap().output_is_video, Some(true));
    assert_eq!(canvas.nodes.iter().find(|node| node.id == image_id).unwrap().output_is_video, Some(false));

    db.conn.lock().unwrap().execute("UPDATE canvas_nodes SET x=920,y=880 WHERE id IN (?1,?2)", params![video_prompt, video_id]).unwrap();
    db.complete_project_generation_turn("p1", "t1", "job-video", "two", None, &assets).unwrap();
    assert_eq!(position(&video_id), (920.0, 880.0));
    assert_eq!(position(&video_prompt), (920.0, 880.0));

    let next = ProjectGenerationTurnInput { job_id: "job-next".into(), turn_key: "three".into(), generation_conversation_id: "next-video".into(), ..video };
    doc["nodes"][0]["activeSessionNodeId"] = "gen-prompt:job-next:three:0".into();
    doc["nodes"][0]["sessionNodeIds"].as_array_mut().unwrap().push("gen-prompt:job-next:three:0".into());
    doc["runs"].as_array_mut().unwrap().push(serde_json::json!({"steps":{"card":{"jobId":"job-next"}}}));
    save(&doc);
    db.begin_project_generation_turn(&next).unwrap();
    let next_id = db.complete_project_generation_turn("p1", "t1", "job-next", "three", None, &[db.get_asset("next-video").unwrap().unwrap()]).unwrap().remove(0);
    assert!(position(&next_id).0 > 240.0);
    assert_eq!(position(&video_id), (920.0, 880.0));
    assert_eq!(position(&image_prompt), old_position);
}

#[test]
fn independent_workflow_products_use_compact_grid_and_replay_keeps_manual_positions() {
    let db = db(); materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread { id:"t1".into(),project_id:"p1".into(),title:"grid".into(),origin:CreativeThreadOrigin::Direct }).unwrap();
    let workflow = serde_json::json!({"schema_version":1,"nodes":[{"id":"agent","kind":"agent","x":100,"y":100,
        "layoutSize":{"width":320,"height":156},"sessionNodeIds":["gen-prompt:job:one:0"]}],
        "runs":[{"id":"run","steps":{"agent":{"localDsGenerations":{"request":{"jobId":"job"}}}}}]});
    db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('p1',1,?1)",[workflow.to_string()]).unwrap();
    let input = ProjectGenerationTurnInput { project_id:"p1".into(),thread_id:"t1".into(),generation_conversation_id:"conversation".into(),
        job_id:"job".into(),turn_key:"one".into(),prompt:"test".into(),applied_prompt:"test".into(),provider:"test".into(),provider_session_id:None,
        ratio:None,visual_profile:None,references:vec![],reference_node_ids:vec![],parent_node_id:None,parent_asset_path:None,relation:None,retry_anchor_node_id:None };
    db.begin_project_generation_turn(&input).unwrap();
    let assets: Vec<_> = (0..6).map(|i| {
        let id = format!("asset{i}");
        db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,store_path,ext,width,height,created_at) VALUES(?1,?1,?2,'png',190,150,1)",params![id,format!("/{id}.png")]).unwrap();
        db.get_asset(&id).unwrap().unwrap()
    }).collect();
    let ids = db.complete_project_generation_turn("p1","t1","job","one",None,&assets).unwrap();
    let nodes: Vec<_> = ids.iter().map(|id| db.get_canvas_node(id).unwrap().unwrap()).collect();
    assert_eq!((nodes[0].x,nodes[0].y),(484.0,100.0));
    assert_eq!(nodes[3].y-nodes[0].y,nodes[0].height+32.0);
    assert_eq!((nodes[0].x,nodes[1].x,nodes[2].x),(484.0,706.0,928.0));
    assert_eq!(nodes[3].x,nodes[0].x);
    db.conn.lock().unwrap().execute("UPDATE canvas_nodes SET x=2000,y=3000,position_locked=1 WHERE id=?1",[&ids[0]]).unwrap();
    db.complete_project_generation_turn("p1","t1","job","one",None,&assets).unwrap();
    let moved = db.get_canvas_node(&ids[0]).unwrap().unwrap();
    assert_eq!((moved.x,moved.y,moved.position_locked),(2000.0,3000.0,true));
    let mut conn = db.conn.lock().unwrap(); let tx = conn.transaction().unwrap();
    let visible = placement::obstacles(&tx,"p1",&workflow,&[]).unwrap();
    assert_eq!(visible.len(),7,"six individual images and their workflow source, no hidden prompt");
}

#[test]
fn legacy_canvas_conversations_restore_from_outputs_without_mutating_saved_payloads() {
    let db = db(); materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread { id: "t1".into(), project_id: "p1".into(), title: "gallery".into(), origin: CreativeThreadOrigin::Direct }).unwrap();
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name,generation_session_id) VALUES('image','image','provider-session')", []).unwrap();
    db.record_generation_conversation("provider-session", "original-conversation").unwrap();
    let saved = r#"{"schema_version":1,"text":"old turn","job_id":"old-job","turn_key":"one"}"#;
    db.create_canvas_node(&NewCanvasNode { payload_json: saved.into(), ..prompt("p1", "t1", "session") }).unwrap();
    let mut result = output("p1", "t1", "output", "image");
    let mut payload: serde_json::Value = serde_json::from_str(&result.payload_json).unwrap();
    payload["execution"] = serde_json::json!({"job_id":"old-job","turn_key":"one"});
    result.payload_json = payload.to_string();
    db.create_canvas_node(&result).unwrap();
    for nodes in [db.list_canvas_nodes("p1").unwrap(), db.project_canvas_snapshot("p1").unwrap().nodes] {
        let prompt = nodes.iter().find(|node| node.id == "session").unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&prompt.payload_json).unwrap()["conversation_id"], "original-conversation");
    }
    assert_eq!(db.get_canvas_node("session").unwrap().unwrap().payload_json, saved);
}

#[test]
fn gallery_with_failed_latest_turn_keeps_previous_image_bounds() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t".into(), project_id: "p1".into(), title: "test".into(), origin: CreativeThreadOrigin::Direct,
    }).unwrap();
    db.conn.lock().unwrap().execute("INSERT INTO assets(id,name) VALUES('image','image')", []).unwrap();
    for (id, status) in [("first", "done"), ("latest", "failed")] {
        let mut card = prompt("p1", "t", id);
        card.payload_json = serde_json::json!({"schema_version":1,"text":id,"conversation_id":"gallery",
            "job_id":id,"turn_key":id,"status":status}).to_string();
        db.create_canvas_node(&card).unwrap();
    }
    let mut image = output("p1", "t", "output", "image");
    image.payload_json = serde_json::json!({"schema_version":1,"snapshot":{"name":"image","width":400,"height":200},
        "execution":{"job_id":"first","turn_key":"first"}}).to_string();
    db.create_canvas_node(&image).unwrap();
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().unwrap();
    let visible = placement::obstacles(&tx, "p1", &serde_json::json!({}), &[]).unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].height, visible[0].width / 2.0);
}

#[test]
fn failed_retry_turn_stacks_on_anchor_card() {
    let db = db(); materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread { id: "t1".into(), project_id: "p1".into(), title: "retry".into(), origin: CreativeThreadOrigin::Direct }).unwrap();
    let failed = db.begin_project_generation_turn(&ProjectGenerationTurnInput {
        project_id:"p1".into(), thread_id:"t1".into(), generation_conversation_id:"conversation".into(), job_id:"job1".into(), turn_key:"turn1".into(),
        prompt:"test".into(), applied_prompt:"test".into(), provider:"test".into(), provider_session_id:None, ratio:None, visual_profile:None,
        references:vec![], reference_node_ids:vec![], parent_node_id:None, parent_asset_path:None, relation:None, retry_anchor_node_id:None,
    }).unwrap();
    // 原失败卡被用户挪到画布左上角；失败只改状态、不动位置。
    db.conn.lock().unwrap().execute("UPDATE canvas_nodes SET x=-420.0,y=-180.0 WHERE id=?1", [&failed.prompt_node_id]).unwrap();
    db.update_project_generation_turn_status("p1", "t1", "job1", "turn1", "failed", None).unwrap();
    let retry = db.begin_project_generation_turn(&ProjectGenerationTurnInput {
        project_id:"p1".into(), thread_id:"t1".into(), generation_conversation_id:"conversation".into(), job_id:"job2".into(), turn_key:"turn2".into(),
        prompt:"test".into(), applied_prompt:"test".into(), provider:"test".into(), provider_session_id:None, ratio:None, visual_profile:None,
        references:vec![], reference_node_ids:vec![], parent_node_id:None, parent_asset_path:None,
        relation:Some(CreativeGenerationRelation::Retry), retry_anchor_node_id:Some(failed.prompt_node_id.clone()),
    }).unwrap();
    let anchor = db.get_canvas_node(&failed.prompt_node_id).unwrap().unwrap();
    let stacked = db.get_canvas_node(&retry.prompt_node_id).unwrap().unwrap();
    assert_eq!((stacked.x, stacked.y), (anchor.x, anchor.y));
    assert!(stacked.position_locked);
    assert!(stacked.z_index > anchor.z_index);
    // 锚点被删/隐藏后静默回退常规落位，重试本身不能失败。
    db.remove_canvas_node(&failed.prompt_node_id).unwrap();
    let fallback = db.begin_project_generation_turn(&ProjectGenerationTurnInput {
        project_id:"p1".into(), thread_id:"t1".into(), generation_conversation_id:"conversation".into(), job_id:"job3".into(), turn_key:"turn3".into(),
        prompt:"test".into(), applied_prompt:"test".into(), provider:"test".into(), provider_session_id:None, ratio:None, visual_profile:None,
        references:vec![], reference_node_ids:vec![], parent_node_id:None, parent_asset_path:None,
        relation:Some(CreativeGenerationRelation::Retry), retry_anchor_node_id:Some(failed.prompt_node_id.clone()),
    }).unwrap();
    let card = db.get_canvas_node(&fallback.prompt_node_id).unwrap().unwrap();
    assert!(!card.position_locked);
}

#[test]
fn bubble_notes_persist_tail_and_reject_table_cells() {
    let db = db();
    materialize(&db, "p1");
    let mut payload = serde_json::json!({
        "schema_version": 1, "text": "说明", "note_type": "bubble",
        "cells": [[{"text":"说明", "bold":false, "italic":false, "align":"left"}]],
        "bubble_tail": {"side":"bottom", "position":25}
    });
    db.create_canvas_node(&NewCanvasNode { payload_json: payload.to_string(), ..note("p1", "bubble") }).unwrap();
    for side in ["top", "right", "bottom", "left"] {
        payload["bubble_tail"] = serde_json::json!({"side":side, "position":65});
        db.update_canvas_note_payload("bubble", &payload.to_string()).unwrap();
        assert_eq!(db.project_canvas_snapshot("p1").unwrap().nodes[0].payload_json, payload.to_string());
    }
    payload["bubble_tail"]["position"] = serde_json::json!(101);
    assert!(db.update_canvas_note_payload("bubble", &payload.to_string()).is_err());
    payload["bubble_tail"]["position"] = serde_json::json!(25);
    let cell = payload["cells"][0][0].clone();
    payload["cells"] = serde_json::json!([[cell.clone(), cell.clone()]]);
    assert!(db.update_canvas_note_payload("bubble", &payload.to_string()).is_err());
    payload["cells"] = serde_json::json!([[cell.clone()], [cell]]);
    assert!(db.update_canvas_note_payload("bubble", &payload.to_string()).is_err());
    payload["cells"] = serde_json::json!([]);
    assert!(db.update_canvas_note_payload("bubble", &payload.to_string()).is_err());
}

#[test]
fn nodes_require_valid_project_thread_and_stable_replay_is_idempotent() {
    let db = db();
    materialize(&db, "p1");
    materialize(&db, "p2");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "线程".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    let value = prompt("p1", "t1", "prompt");
    let first = db.create_canvas_node(&value).unwrap();
    let replay = db.create_canvas_node(&value).unwrap();
    assert_eq!(first, replay);
    assert!(db.create_canvas_node(&prompt("p2", "t1", "bad")).is_err());
    let mut unowned = prompt("p1", "t1", "unowned");
    unowned.thread_id = None;
    assert!(db.create_canvas_node(&unowned).is_err());
}

#[test]
fn layout_update_dto_rejects_execution_payload_fields() {
    let error = serde_json::from_value::<CanvasNodeLayoutUpdate>(serde_json::json!({
        "payloadJson": "{\"schema_version\":1}",
        "x": 12.0,
        "y": 24.0,
        "width": 190.0,
        "height": 180.0,
        "zIndex": 3,
        "positionLocked": false
    }))
    .unwrap_err();

    assert!(error.to_string().contains("unknown field `payloadJson`"));
}

#[test]
fn stale_layout_updates_preserve_execution_payload_owner_and_hidden_state() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "生成线程".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,created_at) VALUES ('asset-1','初始结果',1)",
            [],
        )
        .unwrap();
    }

    let turn = ProjectGenerationTurnInput {
        project_id: "p1".into(),
        thread_id: "t1".into(),
        generation_conversation_id: "conversation-1".into(),
        job_id: "job-1".into(),
        turn_key: "turn-1".into(),
        prompt: "生成一张海报".into(),
        applied_prompt: "生成一张海报，暖色".into(),
        provider: "test-provider".into(),
        provider_session_id: None,
        ratio: Some("1:1".into()),
        visual_profile: None,
        reference_node_ids: vec![],
        references: vec![],
        parent_node_id: None,
        parent_asset_path: None,
        relation: None,
        retry_anchor_node_id: None,
    };
    let graph = db.begin_project_generation_turn(&turn).unwrap();
    let initial_asset = db.get_asset("asset-1").unwrap().unwrap();
    let output_node_id = db
        .complete_project_generation_turn("p1", "t1", "job-1", "turn-1", None, &[initial_asset])
        .unwrap()
        .pop()
        .unwrap();
    let stale_prompt = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
    let stale_output = db.get_canvas_node(&output_node_id).unwrap().unwrap();

    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET name='后端最终结果' WHERE id='asset-1'",
            [],
        )
        .unwrap();
    }
    let final_asset = db.get_asset("asset-1").unwrap().unwrap();
    db.complete_project_generation_turn(
        "p1",
        "t1",
        "job-1",
        "turn-1",
        Some("provider-session-final"),
        &[final_asset],
    )
    .unwrap();
    db.update_project_generation_turn_status(
        "p1",
        "t1",
        "job-1",
        "turn-1",
        "failed",
        Some("provider-session-final"),
    )
    .unwrap();

    let latest_prompt = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
    let latest_output = db.get_canvas_node(&output_node_id).unwrap().unwrap();
    assert_ne!(stale_prompt.payload_json, latest_prompt.payload_json);
    assert_ne!(stale_output.payload_json, latest_output.payload_json);

    let moved_prompt = db
        .update_canvas_node_layout(
            &graph.prompt_node_id,
            &CanvasNodeLayoutUpdate {
                x: stale_prompt.x + 17.0,
                y: stale_prompt.y + 19.0,
                width: stale_prompt.width + 11.0,
                height: stale_prompt.height + 13.0,
                z_index: stale_prompt.z_index + 7,
                position_locked: true,
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(moved_prompt.payload_json, latest_prompt.payload_json);
    assert_eq!(moved_prompt.project_id, latest_prompt.project_id);
    assert_eq!(moved_prompt.thread_id, latest_prompt.thread_id);
    assert_eq!(moved_prompt.kind, latest_prompt.kind);
    assert_eq!(moved_prompt.asset_id, latest_prompt.asset_id);
    assert_eq!(moved_prompt.role, latest_prompt.role);
    assert_eq!(moved_prompt.hidden_at, latest_prompt.hidden_at);
    let prompt_payload: PromptNodePayloadV1 =
        serde_json::from_str(&moved_prompt.payload_json).unwrap();
    assert_eq!(prompt_payload.status.as_deref(), Some("failed"));
    assert_eq!(
        prompt_payload.provider_session_id.as_deref(),
        Some("provider-session-final")
    );

    let moved_output = db
        .update_canvas_node_layout(
            &output_node_id,
            &CanvasNodeLayoutUpdate {
                x: stale_output.x + 23.0,
                y: stale_output.y + 29.0,
                width: stale_output.width + 17.0,
                height: stale_output.height + 19.0,
                z_index: stale_output.z_index + 9,
                position_locked: true,
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(moved_output.payload_json, latest_output.payload_json);
    assert_eq!(moved_output.project_id, latest_output.project_id);
    assert_eq!(moved_output.thread_id, latest_output.thread_id);
    assert_eq!(moved_output.kind, latest_output.kind);
    assert_eq!(moved_output.asset_id, latest_output.asset_id);
    assert_eq!(moved_output.role, latest_output.role);
    assert_eq!(moved_output.hidden_at, latest_output.hidden_at);
    let output_payload: AssetNodePayloadV1 =
        serde_json::from_str(&moved_output.payload_json).unwrap();
    assert_eq!(output_payload.snapshot.name, "后端最终结果");
    assert_eq!(
        output_payload
            .execution
            .as_ref()
            .and_then(|execution| execution.job_id.as_deref()),
        Some("job-1")
    );

    assert_eq!(
        db.remove_canvas_node(&output_node_id).unwrap(),
        Some(CanvasNodeRemoval::Hidden)
    );
    let hidden_output = db.get_canvas_node(&output_node_id).unwrap().unwrap();
    assert!(hidden_output.hidden_at.is_some());
    let error = db
        .update_canvas_node_layout(
            &output_node_id,
            &CanvasNodeLayoutUpdate {
                x: hidden_output.x + 100.0,
                y: hidden_output.y + 100.0,
                width: hidden_output.width,
                height: hidden_output.height,
                z_index: hidden_output.z_index + 1,
                position_locked: false,
            },
        )
        .unwrap_err();
    assert!(error.to_string().contains("hidden canvas node"));
    assert_eq!(
        db.get_canvas_node(&output_node_id).unwrap().unwrap(),
        hidden_output
    );
}

#[test]
fn shared_reference_upgrade_preserves_ownership_and_rejects_cross_thread_outputs() {
    let db = Database::open_in_memory().unwrap();
    crate::db::migrations::migrations()
        .to_version(&mut db.conn.lock().unwrap(), 23)
        .unwrap();
    materialize(&db, "p1");
    materialize(&db, "p2");
    for (project, thread) in [("p1", "t1"), ("p1", "t2"), ("p2", "t3")] {
        db.create_creative_thread(&NewCreativeThread {
            id: thread.into(),
            project_id: project.into(),
            title: thread.into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
    }
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO assets(id,name,created_at) VALUES ('a','reference',1)",
            [],
        )
        .unwrap();
    let mut reference = output("p1", "t1", "reference", "a");
    reference.role = Some(CreativeNodeRole::Reference);
    db.create_canvas_node(&reference).unwrap();
    db.create_canvas_node(&output("p1", "t1", "output", "a"))
        .unwrap();
    db.create_canvas_node(&prompt("p1", "t2", "target"))
        .unwrap();
    db.create_canvas_node(&prompt("p2", "t3", "other-project"))
        .unwrap();
    let insert = "INSERT INTO canvas_edges(id,project_id,thread_id,from_node_id,to_node_id,kind,ordinal,created_at) VALUES (?1,?2,?3,?4,?5,?6,0,1)";
    let shared = params!["shared", "p1", "t2", "reference", "target", "input"];
    assert!(db.conn.lock().unwrap().execute(insert, shared).is_err());
    let before = db.get_canvas_node("reference").unwrap().unwrap();
    // This is the v23 -> v24 contract; v25 deliberately adds generated asset inputs.
    crate::db::migrations::migrations()
        .to_version(&mut db.conn.lock().unwrap(), 24)
        .unwrap();
    assert_eq!(db.get_canvas_node("reference").unwrap().unwrap(), before);
    let conn = db.conn.lock().unwrap();
    conn.execute(insert, shared).unwrap();
    for kind in ["input", "continued", "retry", "branch"] {
        assert!(conn
            .execute(insert, params![kind, "p1", "t2", "output", "target", kind])
            .is_err());
    }
    assert!(conn
        .execute(
            insert,
            params![
                "wrong-target-thread",
                "p1",
                "t1",
                "reference",
                "target",
                "input"
            ]
        )
        .is_err());
    assert!(conn
        .execute(
            insert,
            params![
                "cross-project",
                "p2",
                "t3",
                "reference",
                "other-project",
                "input"
            ]
        )
        .is_err());
    drop(conn);
    db.migrate().unwrap();
    let conn = db.conn.lock().unwrap();
    conn.execute(insert, params!["generated-input", "p1", "t2", "output", "target", "input"]).unwrap();
    for kind in ["continued", "retry", "branch"] {
        assert!(conn.execute(insert, params![kind, "p1", "t2", "output", "target", kind]).is_err());
    }
    assert!(conn.execute(insert, params!["wrong-target-v25", "p1", "t1", "reference", "target", "input"]).is_err());
    assert!(conn.execute(insert, params!["cross-project-v25", "p2", "t3", "reference", "other-project", "input"]).is_err());
}

#[test]
fn agent_reuses_selected_reference_and_keeps_repeated_launches_nearby() {
    let db = db();
    materialize(&db, "p1");
    for id in ["t1", "t2"] {
        db.create_creative_thread(&NewCreativeThread {
            id: id.into(),
            project_id: "p1".into(),
            title: id.into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
    }
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO assets (id,name,created_at) VALUES ('a','reference',1)",
            [],
        )
        .unwrap();
    let mut original = output("p1", "t1", "original", "a");
    original.role = Some(CreativeNodeRole::Reference);
    original.x = 50.0;
    original.y = 70.0;
    db.create_canvas_node(&original).unwrap();
    let mut duplicate = original.clone();
    duplicate.id = "duplicate".into();
    duplicate.x = 4000.0;
    db.create_canvas_node(&duplicate).unwrap();
    let mut launch = ProjectAgentLaunchInput {
        project_id: "p1".into(),
        thread_id: "t1".into(),
        launch_id: "launch1".into(),
        prompt: "edit".into(),
        provider: "cloud".into(),
        ratio: None,
        visual_profile: None,
        reference_asset_ids: vec!["a".into()],
        reference_node_ids: vec![Some("original".into())],
        parent_node_id: None,
        parent_asset_id: None,
    };
    let first = db.begin_project_agent_launch(&launch).unwrap();
    assert_eq!(first.reference_node_ids, vec!["original"]);
    let first_node = db.get_canvas_node(&first.prompt_node_id).unwrap().unwrap();
    assert_eq!((first_node.x, first_node.y), (312.0, 70.0));
    launch.launch_id = "launch2".into();
    launch.thread_id = "t2".into();
    let second = db.begin_project_agent_launch(&launch).unwrap();
    let second_node = db.get_canvas_node(&second.prompt_node_id).unwrap().unwrap();
    assert_eq!(second.reference_node_ids, vec!["original"]);
    assert_eq!(second_node.x, first_node.x);
    assert!(second_node.y >= first_node.y + first_node.height + 32.0);
    assert_eq!(
        db.project_canvas_snapshot("p1")
            .unwrap()
            .nodes
            .iter()
            .filter(|n| n.asset_id.as_deref() == Some("a"))
            .count(),
        2
    );
    assert_eq!(
        db.get_canvas_node("original").unwrap().unwrap().x,
        original.x
    );
    db.update_canvas_node_layout(
        &second.prompt_node_id,
        &CanvasNodeLayoutUpdate {
            x: 900.0,
            y: 800.0,
            width: second_node.width,
            height: second_node.height,
            z_index: second_node.z_index,
            position_locked: true,
        },
    )
    .unwrap();
    assert_eq!(
        db.remove_canvas_node("original").unwrap(),
        Some(CanvasNodeRemoval::Hidden)
    );
    assert_eq!(
        db.begin_project_agent_launch(&launch)
            .unwrap()
            .reference_node_ids,
        vec!["original"]
    );
    let recovered = db.get_canvas_node(&second.prompt_node_id).unwrap().unwrap();
    assert_eq!((recovered.x, recovered.y), (900.0, 800.0));
    assert!(db
        .get_canvas_node("original")
        .unwrap()
        .unwrap()
        .hidden_at
        .is_some());
    assert_eq!(
        db.remove_canvas_node(&second.prompt_node_id).unwrap(),
        Some(CanvasNodeRemoval::Hidden)
    );
    db.begin_project_agent_launch(&launch).unwrap();
    db.update_project_agent_launch_status("t2", "launch2", "succeeded")
        .unwrap();
    assert!(db
        .get_canvas_node(&second.prompt_node_id)
        .unwrap()
        .unwrap()
        .hidden_at
        .is_some());
    launch.launch_id = "invalid".into();
    assert!(db.begin_project_agent_launch(&launch).is_err());
    assert!(db
        .get_canvas_node(&projection_id("agent-prompt", "invalid", "0", "0"))
        .unwrap()
        .is_none());
}

#[test]
fn restore_removed_card_preserves_layout_payload_and_edges() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "test".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    let launch = ProjectAgentLaunchInput {
        project_id: "p1".into(),
        thread_id: "t1".into(),
        launch_id: "restore-test".into(),
        prompt: "restore me".into(),
        provider: "cloud".into(),
        ratio: None,
        visual_profile: None,
        reference_asset_ids: vec![],
        reference_node_ids: vec![],
        parent_node_id: None,
        parent_asset_id: None,
    };
    let graph = db.begin_project_agent_launch(&launch).unwrap();
    let original = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
    db.remove_canvas_node(&original.id).unwrap();
    db.update_project_agent_launch_status("t1", "restore-test", "succeeded")
        .unwrap();
    assert!(db
        .restore_canvas_node("wrong-project", &original.id)
        .is_err());
    assert!(db
        .get_canvas_node(&original.id)
        .unwrap()
        .unwrap()
        .hidden_at
        .is_some());
    let restored = db.restore_canvas_node("p1", &original.id).unwrap().unwrap();
    assert!(restored.hidden_at.is_none());
    assert_eq!((restored.x, restored.y), (original.x, original.y));
    assert!(restored.payload_json.contains("succeeded"));
    assert_eq!(restored.thread_id, original.thread_id);
    db.begin_project_agent_launch(&launch).unwrap();
    assert!(db
        .get_canvas_node(&original.id)
        .unwrap()
        .unwrap()
        .hidden_at
        .is_none());
    assert!(db.restore_canvas_node("p1", "missing").unwrap().is_none());
}

#[test]
fn agent_fallback_reuses_unique_grouped_reference_and_anchors_to_group() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "t1".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    db.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO assets (id,name,created_at) VALUES ('a','reference',1)",
            [],
        )
        .unwrap();
    let mut original = output("p1", "t1", "original", "a");
    original.thread_id = None;
    original.role = Some(CreativeNodeRole::Reference);
    db.create_canvas_node(&original).unwrap();
    db.create_canvas_group_with_items(
        &NewCanvasGroup {
            id: "group".into(),
            project_id: "p1".into(),
            name: "references".into(),
            role: None,
            x: 500.0,
            y: 800.0,
            width: 300.0,
            height: 250.0,
            z_index: 1,
        },
        &["original".into()],
    )
    .unwrap();
    let launch = ProjectAgentLaunchInput {
        project_id: "p1".into(),
        thread_id: "t1".into(),
        launch_id: "launch".into(),
        prompt: "edit".into(),
        provider: "cloud".into(),
        ratio: None,
        visual_profile: None,
        reference_asset_ids: vec!["a".into()],
        reference_node_ids: vec![],
        parent_node_id: None,
        parent_asset_id: None,
    };
    let graph = db.begin_project_agent_launch(&launch).unwrap();
    assert_eq!(graph.reference_node_ids, vec!["original"]);
    let prompt = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
    assert_eq!((prompt.x, prompt.y), (872.0, 800.0));
    assert_eq!(
        db.project_canvas_snapshot("p1").unwrap().group_items.len(),
        1
    );
}

#[test]
fn asset_location_compatibility_requires_one_visible_node() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "线程".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,created_at) VALUES ('asset-1','素材',1)",
            [],
        )
        .unwrap();
    }
    db.create_canvas_node(&output("p1", "t1", "node-1", "asset-1"))
        .unwrap();
    assert_eq!(
        db.project_canvas_location_for_asset("asset-1").unwrap(),
        Some(("p1".into(), "node-1".into(), Some("t1".into())))
    );

    db.create_canvas_node(&output("p1", "t1", "node-2", "asset-1"))
        .unwrap();
    let error = db.project_canvas_location_for_asset("asset-1").unwrap_err();
    assert!(error.to_string().contains("multiple visible canvas nodes"));

    let continuation_error = db
        .begin_project_agent_launch(&ProjectAgentLaunchInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            launch_id: "launch-ambiguous".into(),
            prompt: "继续创作".into(),
            provider: "bowerbird-agent".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec![],
            reference_node_ids: vec![],
            parent_node_id: None,
            parent_asset_id: Some("asset-1".into()),
        })
        .unwrap_err();
    assert!(continuation_error
        .to_string()
        .contains("multiple visible continuation nodes"));
}

#[test]
fn exact_node_location_rejects_cross_project_and_cross_thread() {
    let db = db();
    materialize(&db, "p1");
    materialize(&db, "p2");
    for (project_id, thread_id) in [("p1", "t1"), ("p1", "t2"), ("p2", "t3")] {
        db.create_creative_thread(&NewCreativeThread {
            id: thread_id.into(),
            project_id: project_id.into(),
            title: thread_id.into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
    }
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,created_at) VALUES ('asset-1','素材',1)",
            [],
        )
        .unwrap();
    }
    db.create_canvas_node(&output("p1", "t1", "node-1", "asset-1"))
        .unwrap();

    assert_eq!(
        db.project_canvas_location_for_node("p1", "t1", "node-1")
            .unwrap(),
        ("p1".into(), "node-1".into(), Some("t1".into()))
    );
    let wrong_project = db
        .project_canvas_location_for_node("p2", "t3", "node-1")
        .unwrap_err();
    assert!(wrong_project.to_string().contains("another project"));
    let wrong_thread = db
        .project_canvas_location_for_node("p1", "t2", "node-1")
        .unwrap_err();
    assert!(wrong_thread.to_string().contains("another creative thread"));
}

#[test]
fn explicit_parent_node_is_exact_and_rejects_wrong_owner_asset_role_or_visibility() {
    let db = db();
    materialize(&db, "p1");
    materialize(&db, "p2");
    for (project_id, thread_id) in [("p1", "t1"), ("p1", "t2"), ("p2", "t3")] {
        db.create_creative_thread(&NewCreativeThread {
            id: thread_id.into(),
            project_id: project_id.into(),
            title: thread_id.into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
    }
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,store_path,created_at) VALUES ('asset-1','素材 1','/asset-1.png',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,store_path,created_at) VALUES ('asset-2','素材 2','/asset-2.png',1)",
            [],
        )
        .unwrap();
    }
    db.create_canvas_node(&output("p1", "t1", "parent-exact", "asset-1"))
        .unwrap();
    db.create_canvas_node(&output("p1", "t1", "parent-duplicate", "asset-1"))
        .unwrap();
    db.create_canvas_node(&output("p1", "t2", "parent-other-thread", "asset-1"))
        .unwrap();
    db.create_canvas_node(&output("p2", "t3", "parent-other-project", "asset-1"))
        .unwrap();
    let mut reference = output("p1", "t1", "parent-reference", "asset-1");
    reference.role = Some(CreativeNodeRole::Reference);
    db.create_canvas_node(&reference).unwrap();

    let generation_input = |job_id: &str, parent_node_id: &str, parent_asset_path: &str| {
        ProjectGenerationTurnInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            generation_conversation_id: format!("conversation-{job_id}"),
            job_id: job_id.into(),
            turn_key: "turn-1".into(),
            prompt: "继续生成".into(),
            applied_prompt: "继续生成".into(),
            provider: "test-provider".into(),
            provider_session_id: None,
            ratio: None,
            visual_profile: None,
            reference_node_ids: vec![],
            references: vec![],
            parent_node_id: Some(parent_node_id.into()),
            parent_asset_path: Some(parent_asset_path.into()),
            relation: Some(
                crate::core::creative_session_contract::CreativeGenerationRelation::Continued,
            ),
            retry_anchor_node_id: None,
        }
    };

    let graph = db
        .begin_project_generation_turn(&generation_input(
            "job-exact",
            "parent-exact",
            "/asset-1.png",
        ))
        .unwrap();
    assert_eq!(graph.parent_node_id.as_deref(), Some("parent-exact"));
    assert!(db
        .project_canvas_snapshot("p1")
        .unwrap()
        .edges
        .iter()
        .any(|edge| edge.from_node_id == "parent-exact"
            && edge.to_node_id == graph.prompt_node_id));

    let cross_thread = db
        .begin_project_generation_turn(&generation_input(
            "job-cross-thread",
            "parent-other-thread",
            "/asset-1.png",
        ))
        .unwrap_err();
    assert!(cross_thread.to_string().contains("another creative thread"));
    let cross_project = db
        .begin_project_generation_turn(&generation_input(
            "job-cross-project",
            "parent-other-project",
            "/asset-1.png",
        ))
        .unwrap_err();
    assert!(cross_project.to_string().contains("another project"));
    let wrong_asset = db
        .begin_project_generation_turn(&generation_input(
            "job-wrong-asset",
            "parent-exact",
            "/asset-2.png",
        ))
        .unwrap_err();
    assert!(wrong_asset
        .to_string()
        .contains("does not match parent asset path"));
    let wrong_role = db
        .begin_project_generation_turn(&generation_input(
            "job-wrong-role",
            "parent-reference",
            "/asset-1.png",
        ))
        .unwrap_err();
    assert!(wrong_role
        .to_string()
        .contains("must be an output, intermediate, or final asset"));

    let agent_graph = db
        .begin_project_agent_launch(&ProjectAgentLaunchInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            launch_id: "launch-exact".into(),
            prompt: "继续 Agent 创作".into(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec![],
            reference_node_ids: vec![],
            parent_node_id: Some("parent-duplicate".into()),
            parent_asset_id: Some("asset-1".into()),
        })
        .unwrap();
    assert_eq!(
        agent_graph.parent_node_id.as_deref(),
        Some("parent-duplicate")
    );
    let wrong_agent_asset = db
        .begin_project_agent_launch(&ProjectAgentLaunchInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            launch_id: "launch-wrong-asset".into(),
            prompt: "继续 Agent 创作".into(),
            provider: "cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: vec![],
            reference_node_ids: vec![],
            parent_node_id: Some("parent-duplicate".into()),
            parent_asset_id: Some("asset-2".into()),
        })
        .unwrap_err();
    assert!(wrong_agent_asset
        .to_string()
        .contains("does not match parent asset asset-2"));

    assert_eq!(
        db.remove_canvas_node("parent-exact").unwrap(),
        Some(CanvasNodeRemoval::Hidden)
    );
    let hidden = db
        .begin_project_generation_turn(&generation_input(
            "job-hidden",
            "parent-exact",
            "/asset-1.png",
        ))
        .unwrap_err();
    assert!(hidden.to_string().contains("visible canvas parent node"));
}

#[test]
fn groups_are_project_wide_while_edges_are_thread_scoped_and_acyclic() {
    let db = db();
    materialize(&db, "p1");
    for id in ["t1", "t2"] {
        db.create_creative_thread(&NewCreativeThread {
            id: id.into(),
            project_id: "p1".into(),
            title: id.into(),
            origin: CreativeThreadOrigin::Direct,
        })
        .unwrap();
    }
    let free = db.create_canvas_node(&note("p1", "free")).unwrap();
    let p1 = db
        .create_canvas_node(&prompt("p1", "t1", "prompt-1"))
        .unwrap();
    let p2 = db
        .create_canvas_node(&prompt("p1", "t2", "prompt-2"))
        .unwrap();
    let group = db
        .create_canvas_group_with_items(
            &NewCanvasGroup {
                id: "g".into(),
                project_id: "p1".into(),
                name: "跨线程空间组".into(),
                role: None,
                x: 0.0,
                y: 0.0,
                width: 600.0,
                height: 300.0,
                z_index: 0,
            },
            &[free.id.clone(), p1.id.clone(), p2.id.clone()],
        )
        .unwrap();
    assert_eq!(group.project_id, "p1");

    let asset_payload = serde_json::to_string(&AssetNodePayloadV1 {
        draft_document_id: None,
        workflow_source: None,
        workflow_generation_group: None,
        schema_version: 1,
        snapshot: AssetSnapshotV1 {
            name: "结果".into(),
            width: None,
            height: None,
        },
        execution: None,
    })
    .unwrap();
    let output = db
        .create_canvas_node(&NewCanvasNode {
            id: "output".into(),
            project_id: "p1".into(),
            thread_id: Some("t1".into()),
            kind: CreativeNodeKind::Asset,
            asset_id: None,
            role: Some(CreativeNodeRole::Output),
            payload_json: asset_payload,
            x: 500.0,
            y: 0.0,
            width: 190.0,
            height: 180.0,
            z_index: 2,
            position_locked: false,
        })
        .unwrap();
    db.create_canvas_edge(&NewCanvasEdge {
        id: "edge".into(),
        project_id: "p1".into(),
        thread_id: "t1".into(),
        from_node_id: p1.id,
        to_node_id: output.id.clone(),
        kind: CreativeEdgeKind::Produced,
        ordinal: 0,
    })
    .unwrap();
    assert!(db
        .create_canvas_edge(&NewCanvasEdge {
            id: "cross".into(),
            project_id: "p1".into(),
            thread_id: "t1".into(),
            from_node_id: output.id,
            to_node_id: p2.id,
            kind: CreativeEdgeKind::Continued,
            ordinal: 0,
        })
        .is_err());
}

#[test]
fn agent_reference_nodes_keep_execution_identity_and_are_only_hidden() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "Agent 线程".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,created_at) VALUES ('reference-asset','参考图',1)",
            [],
        )
        .unwrap();
    }
    let launch = ProjectAgentLaunchInput {
        project_id: "p1".into(),
        thread_id: "t1".into(),
        launch_id: "launch-1".into(),
        prompt: "制作海报".into(),
        provider: "bowerbird-agent".into(),
        ratio: Some("1:1".into()),
        visual_profile: None,
        reference_asset_ids: vec!["reference-asset".into()],
        reference_node_ids: vec![],
        parent_node_id: None,
        parent_asset_id: None,
    };

    let graph = db.begin_project_agent_launch(&launch).unwrap();
    let reference_node_id = graph.reference_node_ids.first().unwrap();
    let reference_node = db.get_canvas_node(reference_node_id).unwrap().unwrap();
    let payload: AssetNodePayloadV1 =
        serde_json::from_str(&reference_node.payload_json).unwrap();
    assert_eq!(
        payload.execution.and_then(|execution| execution.run_id),
        Some("launch-1".into())
    );
    assert!(matches!(
        db.remove_canvas_node(reference_node_id).unwrap(),
        Some(CanvasNodeRemoval::Hidden)
    ));
    assert!(db
        .get_canvas_node(reference_node_id)
        .unwrap()
        .unwrap()
        .hidden_at
        .is_some());

    db.begin_project_agent_launch(&launch).unwrap();
    assert!(db
        .get_canvas_node(reference_node_id)
        .unwrap()
        .unwrap()
        .hidden_at
        .is_some());
}

#[test]
fn physical_asset_deletion_hides_only_empty_generating_turns_and_survives_replay() {
    use crate::core::projects::AssetDeleteMode;

    let db = db();
    let files = tempfile::tempdir().unwrap();
    let path = |id: &str| files.path().join(id).to_string_lossy().into_owned();
    for (project_id, thread_id) in [("p1", "t1"), ("p2", "t2")] {
        materialize(&db, project_id);
        db.create_creative_thread(&NewCreativeThread {
            id: thread_id.into(), project_id: project_id.into(), title: thread_id.into(),
            origin: CreativeThreadOrigin::Direct,
        }).unwrap();
    }
    {
        let conn = db.conn.lock().unwrap();
        for id in ["a", "b", "c", "reference"] {
            std::fs::write(path(id), b"synthetic image").unwrap();
            conn.execute("INSERT INTO assets(id,name,store_path,created_at) VALUES (?1,?1,?2,1)", params![id, path(id)]).unwrap();
        }
    }
    let turn = ProjectGenerationTurnInput {
        project_id: "p1".into(), thread_id: "t1".into(),
        generation_conversation_id: "conversation".into(), job_id: "job".into(), turn_key: "one".into(),
        prompt: "生成图片".into(), applied_prompt: "生成图片".into(), provider: "test".into(),
        provider_session_id: None, ratio: None, visual_profile: None,
        references: vec![path("reference")], reference_node_ids: vec![],
        parent_node_id: None, parent_asset_path: None, relation: None, retry_anchor_node_id: None,
    };
    let graph = db.begin_project_generation_turn(&turn).unwrap();
    let outputs = db.complete_project_generation_turn("p1", "t1", "job", "one", None,
        &[db.get_asset("a").unwrap().unwrap(), db.get_asset("b").unwrap().unwrap()]).unwrap();
    let next = ProjectGenerationTurnInput { turn_key: "two".into(), references: vec![path("a")], ..turn.clone() };
    let next_graph = db.begin_project_generation_turn(&next).unwrap();
    db.complete_project_generation_turn("p1", "t1", "job", "two", None,
        &[db.get_asset("c").unwrap().unwrap()]).unwrap();
    // A deduplicated result may be produced in multiple projects. Every exact producer is cleaned.
    let other = ProjectGenerationTurnInput {
        project_id: "p2".into(), thread_id: "t2".into(), generation_conversation_id: "other".into(),
        job_id: "other-job".into(), references: vec![], ..turn.clone()
    };
    let other_graph = db.begin_project_generation_turn(&other).unwrap();
    db.complete_project_generation_turn("p2", "t2", "other-job", "one", None,
        &[db.get_asset("a").unwrap().unwrap()]).unwrap();

    // Removing only project membership or a reference image never deletes its generation card.
    db.delete_asset_with_mode("a", AssetDeleteMode::Keep, Some("p1")).unwrap();
    db.delete_asset("reference").unwrap();
    assert!(db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap().hidden_at.is_none());
    assert!(db.get_canvas_node(&other_graph.prompt_node_id).unwrap().unwrap().hidden_at.is_none());

    db.delete_asset_with_mode("a", AssetDeleteMode::Delete, Some("p1")).unwrap();
    assert!(db.get_canvas_node(&other_graph.prompt_node_id).unwrap().unwrap().hidden_at.is_some());
    assert!(db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap().hidden_at.is_none(), "second output survives");
    assert!(db.get_canvas_node(&next_graph.prompt_node_id).unwrap().unwrap().hidden_at.is_none(), "reference consumers survive");

    // A failed DB deletion must roll back card visibility as well as the asset row.
    db.conn.lock().unwrap().execute_batch(
        "CREATE TRIGGER reject_test_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT, 'delete failed'); END;"
    ).unwrap();
    assert!(db.delete_asset("b").is_err());
    assert!(db.get_asset("b").unwrap().is_some());
    assert!(Path::new(&path("b")).exists());
    assert!(db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap().hidden_at.is_none());
    db.conn.lock().unwrap().execute_batch("DROP TRIGGER reject_test_delete").unwrap();

    db.delete_asset("b").unwrap();
    assert!(!Path::new(&path("b")).exists());
    assert!(db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap().hidden_at.is_some());
    assert!(db.get_canvas_node(&next_graph.prompt_node_id).unwrap().unwrap().hidden_at.is_none(), "another turn in the conversation survives");
    for id in outputs {
        let node = db.get_canvas_node(&id).unwrap().unwrap();
        assert!(node.hidden_at.is_some());
        assert!(node.asset_id.is_none());
    }
    // Replaying a completed turn cannot restore a removed card. History remains intact.
    let replay = ProjectGenerationTurnInput { references: vec![], ..turn };
    db.begin_project_generation_turn(&replay).unwrap();
    db.complete_project_generation_turn("p1", "t1", "job", "one", None, &[]).unwrap();
    assert!(db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap().hidden_at.is_some());
    assert_eq!(db.conn.lock().unwrap().query_row(
        "SELECT COUNT(*) FROM canvas_edges WHERE from_node_id=?1 AND kind='produced'",
        [&graph.prompt_node_id], |row| row.get::<_, i64>(0)).unwrap(), 2);
    db.delete_asset("c").unwrap();
    assert!(db.get_canvas_node(&next_graph.prompt_node_id).unwrap().unwrap().hidden_at.is_some());
}

#[test]
fn deleting_asset_keeps_tombstone_and_project_delete_detaches_running_work() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "线程".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,created_at) VALUES ('a','素材',1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,created_at) VALUES ('kept','项目资产',1)",
            [],
        )
        .unwrap();
    }
    db.add_assets_to_project("p1", &["kept".into()]).unwrap();
    let payload = serde_json::to_string(&AssetNodePayloadV1 {
        draft_document_id: None,
        workflow_source: None,
        workflow_generation_group: None,
        schema_version: 1,
        snapshot: AssetSnapshotV1 {
            name: "素材".into(),
            width: None,
            height: None,
        },
        execution: None,
    })
    .unwrap();
    db.create_canvas_node(&NewCanvasNode {
        id: "asset-node".into(),
        project_id: "p1".into(),
        thread_id: None,
        kind: CreativeNodeKind::Asset,
        asset_id: Some("a".into()),
        role: Some(CreativeNodeRole::Reference),
        payload_json: payload,
        x: 0.0,
        y: 0.0,
        width: 190.0,
        height: 180.0,
        z_index: 0,
        position_locked: false,
    })
    .unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM assets WHERE id='a'", []).unwrap();
    }
    assert_eq!(
        db.get_canvas_node("asset-node").unwrap().unwrap().asset_id,
        None
    );
    assert!(db.archive_creative_thread("t1").unwrap());
    assert!(db
        .get_creative_thread("t1")
        .unwrap()
        .unwrap()
        .archived_at
        .is_some());
    assert!(!db.archive_creative_thread("t1").unwrap());
    assert!(db.restore_creative_thread("t1").unwrap());
    assert!(db
        .get_creative_thread("t1")
        .unwrap()
        .unwrap()
        .archived_at
        .is_none());
    assert!(!db.restore_creative_thread("t1").unwrap());
    assert!(db.archive_creative_thread("t1").unwrap());

    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO task_queue (id,kind,payload,status,created_at,project_id,thread_id) VALUES ('job','generation','{}','running',1,'p1','t1')",
            [],
        )
        .unwrap();
    }
    let impact = db.project_delete_impact("p1").unwrap();
    assert_eq!(impact.project_asset_count, 1);
    assert_eq!(impact.thread_count, 1);
    assert_eq!(impact.node_count, 1);
    assert_eq!(impact.running_generation_count, 1);

    {
        let conn = db.conn.lock().unwrap();
        conn.execute("DELETE FROM projects WHERE id='p1'", [])
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM project_canvases", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM assets WHERE id='kept'", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1,
            "删除项目不得删除中央素材"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM task_queue WHERE id='job'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1,
            "删除项目不得删除底层执行审计"
        );
    }
}
#[test]
fn collected_image_replay_keeps_one_visible_card() {
    let db = reference_placement_fixture();
    let asset = db.get_asset("a").unwrap().unwrap();
    db.place_collected_image("p1", &asset).unwrap();
    db.place_collected_image("p1", &asset).unwrap();
    let nodes = db.list_canvas_nodes("p1").unwrap();
    assert_eq!(nodes.iter().filter(|node| node.asset_id.as_deref() == Some("a")).count(), 1);
}

fn reference_placement_fixture() -> Database {
    let db = db();
    materialize(&db, "p1");
    materialize(&db, "p2");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "layout".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    for id in ["existing", "a", "b", "c", "d"] {
        db.conn.lock().unwrap().execute(
            "INSERT INTO assets(id,name,store_path,width,height,created_at) VALUES (?1,?1,?2,400,600,1)",
            params![id, format!("/{id}.png")],
        ).unwrap();
    }
    let mut original = output("p1", "t1", "original", "existing");
    original.role = Some(CreativeNodeRole::Reference);
    original.x = 50.0;
    original.y = 70.0;
    db.create_canvas_node(&original).unwrap();
    let mut far = note("p1", "far");
    far.x = 20_000.0;
    db.create_canvas_node(&far).unwrap();
    let mut foreign = original;
    foreign.id = "foreign".into();
    foreign.project_id = "p2".into();
    foreign.thread_id = None;
    foreign.asset_id = Some("a".into());
    db.create_canvas_node(&foreign).unwrap();
    db
}

fn launch_layout_references(
    db: &Database,
    agent: bool,
    launch: &str,
    refs: &[&str],
    parent: bool,
) -> ProjectGenerationTurnGraph {
    if agent {
        db.begin_project_agent_launch(&ProjectAgentLaunchInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            launch_id: launch.into(),
            prompt: "layout".into(),
            provider: "bowerbird-cloud".into(),
            ratio: None,
            visual_profile: None,
            reference_asset_ids: refs.iter().map(|id| id.to_string()).collect(),
            reference_node_ids: vec![],
            parent_node_id: parent.then(|| "parent".into()),
            parent_asset_id: parent.then(|| "existing".into()),
        })
        .unwrap()
    } else {
        db.begin_project_generation_turn(&ProjectGenerationTurnInput {
            project_id: "p1".into(),
            thread_id: "t1".into(),
            generation_conversation_id: "conversation".into(),
            job_id: launch.into(),
            turn_key: "turn".into(),
            prompt: "layout".into(),
            applied_prompt: "layout".into(),
            provider: "jimeng".into(),
            provider_session_id: None,
            ratio: None,
            visual_profile: None,
            references: refs.iter().map(|id| format!("/{id}.png")).collect(),
            reference_node_ids: vec![],
            parent_node_id: parent.then(|| "parent".into()),
            parent_asset_path: parent.then(|| "/existing.png".into()),
            relation: parent.then_some(
                crate::core::creative_session_contract::CreativeGenerationRelation::Continued,
            ),
            retry_anchor_node_id: None,
        })
        .unwrap()
    }
}

fn assert_reference_rects_clear(db: &Database, ids: &[String]) {
    let snapshot = db.project_canvas_snapshot("p1").unwrap();
    for id in ids {
        let a = snapshot.nodes.iter().find(|node| &node.id == id).unwrap();
        for b in snapshot
            .nodes
            .iter()
            .filter(|node| node.id != a.id && node.hidden_at.is_none())
        {
            assert!(
                a.x + a.width <= b.x
                    || b.x + b.width <= a.x
                    || a.y + a.height <= b.y
                    || b.y + b.height <= a.y,
                "overlap: {} and {}",
                a.id,
                b.id
            );
        }
        for g in &snapshot.groups {
            assert!(
                a.x + a.width <= g.x
                    || g.x + g.width <= a.x
                    || a.y + a.height <= g.y
                    || g.y + g.height <= a.y
            );
        }
    }
}

fn assert_same_canvas_layout(before: &[CanvasNode], after: &[CanvasNode]) {
    assert_eq!(before.len(), after.len());
    for (a, b) in before.iter().zip(after) {
        assert_eq!(
            (
                &a.id,
                &a.thread_id,
                &a.asset_id,
                a.x,
                a.y,
                a.width,
                a.height,
                a.position_locked,
                a.hidden_at
            ),
            (
                &b.id,
                &b.thread_id,
                &b.asset_id,
                b.x,
                b.y,
                b.width,
                b.height,
                b.position_locked,
                b.hidden_at
            )
        );
    }
}

#[test]
fn new_references_stay_near_card_despite_far_nodes_and_keep_existing_inputs() {
    for agent in [false, true] {
        let db = reference_placement_fixture();
        let original = db.get_canvas_node("original").unwrap().unwrap();
        let foreign = db.get_canvas_node("foreign").unwrap().unwrap();
        let graph = launch_layout_references(
            &db,
            agent,
            "mixed",
            &["existing", "a", "b", "a", "c", "d"],
            false,
        );
        let card = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
        assert_eq!(
            (card.x, card.y),
            (312.0, 70.0),
            "new inputs must not drag the card to the global right edge"
        );
        assert_eq!(graph.reference_node_ids.len(), 5);
        assert_eq!(graph.reference_node_ids[0], "original");
        let refs = &graph.reference_node_ids[1..];
        for id in refs {
            let node = db.get_canvas_node(id).unwrap().unwrap();
            assert!((node.x - card.x).abs() < 900.0 && (node.y - card.y).abs() < 900.0);
        }
        assert_reference_rects_clear(&db, refs);
        assert_eq!(db.get_canvas_node("original").unwrap().unwrap(), original);
        assert_eq!(db.get_canvas_node("foreign").unwrap().unwrap(), foreign);
        let before = db.project_canvas_snapshot("p1").unwrap();
        assert_eq!(
            launch_layout_references(
                &db,
                agent,
                "mixed",
                &["existing", "a", "b", "a", "c", "d"],
                false
            ),
            graph
        );
        assert_same_canvas_layout(
            &before.nodes,
            &db.project_canvas_snapshot("p1").unwrap().nodes,
        );
        println!(
            "REFERENCE_COORDS agent={agent} card=({}, {}) refs={:?}",
            card.x,
            card.y,
            before
                .nodes
                .iter()
                .filter(|n| refs.contains(&n.id))
                .map(|n| (&n.id, n.x, n.y, n.width, n.height))
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn library_reference_reuses_existing_instances_without_creating_another() {
    for agent in [false, true] {
        let db = reference_placement_fixture();
        let mut duplicate = output("p1", "t1", "second-instance", "existing");
        duplicate.role = Some(CreativeNodeRole::Reference);
        duplicate.x = 5000.0;
        db.create_canvas_node(&duplicate).unwrap();
        let graph =
            launch_layout_references(&db, agent, "reuse", &["existing", "existing"], false);
        assert_eq!(graph.reference_node_ids, vec!["original"]);
        assert_eq!(
            db.project_canvas_snapshot("p1")
                .unwrap()
                .nodes
                .iter()
                .filter(|node| node.asset_id.as_deref() == Some("existing"))
                .count(),
            2
        );
        assert_eq!(
            db.get_canvas_node("second-instance").unwrap().unwrap().x,
            5000.0
        );
    }
}

#[test]
fn missing_references_on_replay_follow_moved_visible_card_and_avoid_groups() {
    for agent in [false, true] {
        let db = reference_placement_fixture();
        let graph = launch_layout_references(&db, agent, "replay", &[], false);
        let card_id = if agent {
            let payload: AgentGroupNodePayloadV1 = serde_json::from_value(serde_json::json!({
                "schema_version":1,"run_id":"run","skill_id":"bowerbird-unified-agent","status":"running"
            })).unwrap();
            db.project_agent_run_on_canvas("p1", "t1", "replay", &payload)
                .unwrap()
        } else {
            graph.prompt_node_id.clone()
        };
        let card = db.get_canvas_node(&card_id).unwrap().unwrap();
        db.update_canvas_node_layout(
            &card_id,
            &CanvasNodeLayoutUpdate {
                x: -1600.0,
                y: -800.0,
                width: card.width,
                height: card.height,
                z_index: card.z_index,
                position_locked: true,
            },
        )
        .unwrap();
        // Reserve the first slot with a real persisted material group.
        db.create_canvas_group_with_items(
            &NewCanvasGroup {
                id: "obstacle".into(),
                project_id: "p1".into(),
                name: "group".into(),
                role: None,
                x: -1600.0,
                y: -800.0 + card.height + 40.0,
                width: 190.0,
                height: 272.0,
                z_index: 0,
            },
            &[],
        )
        .unwrap();
        let before = db.project_canvas_snapshot("p1").unwrap();
        let restored = launch_layout_references(&db, agent, "replay", &["a", "b"], false);
        for id in &restored.reference_node_ids {
            let node = db.get_canvas_node(id).unwrap().unwrap();
            assert!(
                node.x >= -1600.0 && node.x < -700.0 && node.y >= -800.0 && node.y < 200.0,
                "reference must follow the moved card, got ({},{})",
                node.x,
                node.y
            );
        }
        assert_reference_rects_clear(&db, &restored.reference_node_ids);
        for node in before.nodes {
            let after = db.get_canvas_node(&node.id).unwrap().unwrap();
            assert_eq!(
                (
                    after.x,
                    after.y,
                    after.width,
                    after.height,
                    after.position_locked
                ),
                (
                    node.x,
                    node.y,
                    node.width,
                    node.height,
                    node.position_locked
                )
            );
            if node.kind == CreativeNodeKind::Asset {
                assert_eq!(after, node);
            }
        }
        let saved = db.project_canvas_snapshot("p1").unwrap();
        launch_layout_references(&db, agent, "replay", &["a", "b"], false);
        assert_same_canvas_layout(
            &saved.nodes,
            &db.project_canvas_snapshot("p1").unwrap().nodes,
        );
    }
}

#[test]
fn continuation_references_use_parent_region_and_startup_video_recovery_is_stable() {
    for agent in [false, true] {
        let db = reference_placement_fixture();
        let mut parent = output("p1", "t1", "parent", "existing");
        parent.x = -2000.0;
        parent.y = 1400.0;
        db.create_canvas_node(&parent).unwrap();
        let graph = launch_layout_references(&db, agent, "continued", &["a"], true);
        let card = db.get_canvas_node(&graph.prompt_node_id).unwrap().unwrap();
        assert_eq!((card.x, card.y), (-1738.0, 1400.0));
        let reference = db
            .get_canvas_node(&graph.reference_node_ids[0])
            .unwrap()
            .unwrap();
        assert!((reference.x - card.x).abs() < 900.0 && (reference.y - card.y).abs() < 500.0);
        assert_reference_rects_clear(&db, &graph.reference_node_ids);
        if !agent {
            let job: crate::core::task_queue::GenJob = serde_json::from_value(serde_json::json!({
                "id":"continued","media":"video","provider":"jimeng","status":"running","prompt":"layout","created_at":1,
                "project_id":"p1","thread_id":"t1","turn_key":"turn","conversation_id":"conversation",
                "references":["/a.png"],"parent_node_id":"parent","parent_asset_path":"/existing.png","creative_relation":"continued"
            })).unwrap();
            for _ in 0..2 {
                crate::core::generation_worker::recover_project_generation_projection(
                    &db, &job, "running",
                )
                .unwrap();
                assert_eq!(
                    db.get_canvas_node(&reference.id).unwrap().unwrap(),
                    reference
                );
            }
        }
    }
}
#[test]
fn generation_reuses_the_exact_canvas_reference_node_instead_of_copying_it() {
    let db = db();
    materialize(&db, "p1");
    db.create_creative_thread(&NewCreativeThread {
        id: "t1".into(),
        project_id: "p1".into(),
        title: "生成线程".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO assets (id,name,store_path,created_at) VALUES ('asset-1','原参考图','/asset-1.png',1)",
            [],
        )
        .unwrap();
    }
    db.create_creative_thread(&NewCreativeThread {
        id: "reference-owner".into(),
        project_id: "p1".into(),
        title: "此前使用参考图的线程".into(),
        origin: CreativeThreadOrigin::Direct,
    })
    .unwrap();
    let mut original = output("p1", "reference-owner", "original-reference", "asset-1");
    original.role = Some(CreativeNodeRole::Reference);
    original.x = 37.0;
    original.y = 59.0;
    db.create_canvas_node(&original).unwrap();

    let mut input = ProjectGenerationTurnInput {
        project_id: "p1".into(),
        thread_id: "t1".into(),
        generation_conversation_id: "conversation-1".into(),
        job_id: "job-1".into(),
        turn_key: "turn-1".into(),
        prompt: "参考原图生成".into(),
        applied_prompt: "参考原图生成".into(),
        provider: "test-provider".into(),
        provider_session_id: None,
        ratio: None,
        visual_profile: None,
        references: vec!["/asset-1.png".into()],
        reference_node_ids: vec![Some("original-reference".into())],
        parent_node_id: None,
        parent_asset_path: None,
        relation: None,
        retry_anchor_node_id: None,
    };
    let graph = db.begin_project_generation_turn(&input).unwrap();

    assert_eq!(graph.reference_node_ids, vec!["original-reference"]);
    let snapshot = db.project_canvas_snapshot("p1").unwrap();
    assert_eq!(
        snapshot
            .nodes
            .iter()
            .filter(|node| node.asset_id.as_deref() == Some("asset-1"))
            .count(),
        1
    );
    let preserved = snapshot
        .nodes
        .iter()
        .find(|node| node.id == "original-reference")
        .unwrap();
    assert_eq!((preserved.x, preserved.y), (37.0, 59.0));
    assert_eq!(preserved.thread_id.as_deref(), Some("reference-owner"));
    assert!(snapshot.edges.iter().any(|edge| {
        edge.kind == CreativeEdgeKind::Input
            && edge.from_node_id == "original-reference"
            && edge.to_node_id == graph.prompt_node_id
    }));

    // Without a chip node id, unique project-wide lookup must reuse it too.
    input.job_id = "job-fallback".into();
    input.turn_key = "turn-fallback".into();
    input.reference_node_ids.clear();
    let fallback = db.begin_project_generation_turn(&input).unwrap();
    assert_eq!(fallback.reference_node_ids, vec!["original-reference"]);
    assert_eq!(db.begin_project_generation_turn(&input).unwrap(), fallback);

    // A previous generated result can be referenced directly, even when the
    // same central asset also has another instance in this project.
    let generated = output("p1", "reference-owner", "generated-reference", "asset-1");
    db.create_canvas_node(&generated).unwrap();
    input.job_id = "job-output-reference".into();
    input.turn_key = "turn-output-reference".into();
    input.reference_node_ids = vec![Some("generated-reference".into())];
    let from_output = db.begin_project_generation_turn(&input).unwrap();
    assert_eq!(from_output.reference_node_ids, vec!["generated-reference"]);
    assert_eq!(db.project_canvas_snapshot("p1").unwrap().nodes.iter().filter(|n| n.asset_id.as_deref()==Some("asset-1")).count(),2);

    input.job_id = "job-invalid".into();
    input.turn_key = "turn-invalid".into();
    input.reference_node_ids = vec![Some("original-reference".into())];
    input.references = vec!["/different-asset.png".into()];
    assert!(db
        .begin_project_generation_turn(&input)
        .unwrap_err()
        .to_string()
        .contains("does not match"));
    input.references = vec!["/asset-1.png".into()];
    db.remove_canvas_node("original-reference").unwrap();
    assert!(db.begin_project_generation_turn(&input).is_err());

    // A draft can outlive an unconnected canvas instance removed by the user.
    // Keep the original image, but do not guess another instance of that image.
    let mut detached = original.clone();
    detached.id = "removed-draft-reference".into();
    detached.thread_id = None;
    db.create_canvas_node(&detached).unwrap();
    db.remove_canvas_node(&detached.id).unwrap();
    assert!(db.get_canvas_node(&detached.id).unwrap().is_none());
    input.job_id = "job-stale-draft".into();
    input.turn_key = "turn-stale-draft".into();
    input.reference_node_ids = vec![Some(detached.id.clone())];
    let repaired = db.begin_project_generation_turn(&input).unwrap();
    assert_eq!(repaired.reference_node_ids.len(), 1);
    let reference = db.get_canvas_node(&repaired.reference_node_ids[0]).unwrap().unwrap();
    assert_eq!(reference.asset_id.as_deref(), Some("asset-1"));
    assert_eq!(reference.role, Some(CreativeNodeRole::Reference));
    assert_ne!(reference.id, "generated-reference");
    assert_ne!(reference.id, detached.id);
    assert_eq!(db.begin_project_generation_turn(&input).unwrap(), repaired);

    // A missing canvas locator does not permit a missing central asset.
    input.job_id = "job-stale-missing-image".into();
    input.references = vec!["/missing.png".into()];
    assert!(db.begin_project_generation_turn(&input).is_err());
    // An explicit continuation parent must never be replaced by a reference.
    input.references = vec!["/asset-1.png".into()];
    input.parent_node_id = Some(detached.id);
    input.parent_asset_path = Some("/asset-1.png".into());
    assert!(db.begin_project_generation_turn(&input).is_err());
}

#[test]
fn library_references_keep_history_without_canvas_nodes_or_edges_on_recovery() {
    let db = reference_placement_fixture();
    let job: crate::core::task_queue::GenJob = serde_json::from_value(serde_json::json!({
        "id":"library-only","provider":"jimeng","status":"running","prompt":"使用素材库参考",
        "created_at":1,"project_id":"p1","thread_id":"t1","turn_key":"turn",
        "references":["/existing.png","/a.png"],"reference_node_ids":[null,null]
    })).unwrap();
    let before = db.project_canvas_snapshot("p1").unwrap();
    for _ in 0..2 {
        crate::core::generation_worker::recover_project_generation_projection(&db, &job, "running").unwrap();
        let snapshot = db.project_canvas_snapshot("p1").unwrap();
        assert_eq!(snapshot.nodes.len(), before.nodes.len() + 1, "only the conversation card is new");
        assert_eq!(snapshot.edges.len(), before.edges.len(), "even an existing matching canvas image is not connected");
        let prompt = snapshot.nodes.iter().find(|node| node.kind == CreativeNodeKind::Prompt).unwrap();
        let payload: PromptNodePayloadV1 = serde_json::from_str(&prompt.payload_json).unwrap();
        assert_eq!(payload.reference_assets.iter().map(|r| r.asset_id.as_str()).collect::<Vec<_>>(), vec!["existing", "a"]);
        assert_eq!(payload.reference_assets[1].snapshot.name, "a");
    }
    assert_eq!(job.references, vec!["/existing.png", "/a.png"], "provider references remain intact");
    assert!(db.conn.lock().unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM project_assets WHERE project_id='p1' AND asset_id='a')", [], |row| row.get::<_, bool>(0),
    ).unwrap());
}

#[test]
fn mixed_reference_sources_only_connect_explicit_canvas_inputs() {
    let db = reference_placement_fixture();
    let mut input = ProjectGenerationTurnInput {
        project_id: "p1".into(), thread_id: "t1".into(), generation_conversation_id: "mixed".into(),
        job_id: "mixed".into(), turn_key: "turn".into(), prompt: "混合引用".into(), applied_prompt: "混合引用".into(),
        provider: "jimeng".into(), provider_session_id: None, ratio: None, visual_profile: None,
        references: vec!["/a.png".into(), "/existing.png".into()],
        reference_node_ids: vec![None, Some("original".into())],
        parent_node_id: None, parent_asset_path: None, relation: None, retry_anchor_node_id: None,
    };
    let graph = db.begin_project_generation_turn(&input).unwrap();
    assert_eq!(graph.reference_node_ids, vec!["original"]);
    assert_eq!(db.begin_project_generation_turn(&input).unwrap(), graph);
    let snapshot = db.project_canvas_snapshot("p1").unwrap();
    let edges: Vec<_> = snapshot.edges.iter().filter(|edge| edge.to_node_id == graph.prompt_node_id).collect();
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].from_node_id, "original");
    assert_eq!(edges[0].ordinal, 1, "null slots must not shift exact reference bindings");
    assert!(!snapshot.nodes.iter().any(|node| node.asset_id.as_deref() == Some("a")));
    input.reference_node_ids.clear();
    input.job_id = "legacy".into();
    let legacy = db.begin_project_generation_turn(&input).unwrap();
    assert_eq!(legacy.reference_node_ids.len(), 2, "legacy callers keep their projection");
}
