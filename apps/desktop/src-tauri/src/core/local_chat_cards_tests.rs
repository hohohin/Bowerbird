use super::*;
use crate::core::local_chat::{ChatSendInput, StartedChat};

fn fixture() -> (Database, StartedChat) {
    fixture_with_db(Database::open_in_memory().unwrap())
}
fn fixture_with_db(db: Database) -> (Database, StartedChat) {
    db.migrate().unwrap();
    {
        let conn = db.conn.lock().unwrap();
        conn.execute("INSERT INTO projects(id,name,workspace_path,workspace_key,created_at) VALUES('p','项目','blank:p','blank:p',1)",[]).unwrap();
        conn.execute(
            "INSERT INTO project_canvases(project_id,created_at,updated_at) VALUES('p',1,1)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO assets(id,name,store_path,created_at) VALUES('picture','image','image.png',1)",[]).unwrap();
    }
    let started = db
        .begin_local_chat(&ChatSendInput {
            provider: None,
            project_id: "p".into(),
            conversation_id: None,
            request_id: "request".into(),
            text: "请创建卡片".into(),
            reference_asset_ids: vec!["picture".into()],
            placement: None,
            card_defaults: Some(ChatCardDefaults {
                provider: "jimeng".into(),
                ..Default::default()
            }),
        })
        .unwrap();
    (db, started)
}
fn batch() -> Value {
    json!({"cards":[
    {"id":"copy","kind":"content","title":"文案","rows":[["第一行"],["第二行"]]},
    {"id":"draw","kind":"generation","title":"绘画","prompt":"创作海报","mediaType":"image","referenceAliases":["image1"]},
    {"id":"start","kind":"trigger","title":"开始"},
    {"id":"repeat","kind":"loop","title":"重复","mode":"count","count":3,"body":["draw"]}],
    "connections":[{"from":"start","to":"repeat","output":"signal","input":"signal"}]})
}
fn h3_batch() -> Value {
    json!({"cards":[
        {"id":"copy","kind":"content","title":"镜头方向","rows":[["缓慢推近"],["转向侧面"]]},
        {"id":"draw","kind":"generation","title":"首帧","prompt":"创作首帧","mediaType":"image"},
        {"id":"still","kind":"comfy-video","title":"H3 首尾帧","prompt":"产品缓慢旋转","firstFrameAlias":"image1","lastFrameAlias":"image1"},
        {"id":"linked","kind":"comfy-video","title":"H3 上游首帧","prompt":"镜头缓慢推近","seconds":11,"ratio":"auto","resolution":0.6,"lastFrameAlias":"image1"},
        {"id":"start","kind":"trigger","title":"开始"},
        {"id":"repeat","kind":"loop","title":"重复 H3","mode":"count","count":2,"body":["still","linked"]}],
        "connections":[
            {"from":"copy","to":"still","output":"text","input":"text"},
            {"from":"draw","to":"linked","output":"image","input":"first-frame"},
            {"from":"start","to":"repeat","output":"signal","input":"signal"}]})
}
fn section_batch(large: bool) -> Value {
    let mut args = h3_batch();
    if large {
        args["cards"][0]["rows"] = json!(vec![vec!["表格内容"; 12]; 100]);
        args["cards"][1]["prompt"] = json!("产品置于柔和光线中，画面保持简洁。".repeat(160));
    }
    args["cards"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"loose","kind":"content","title":"补充说明","text":"暂不归组"}));
    args["sections"] = json!([
        {"id":"planning","title":"前期规划","members":["copy","draw"]},
        {"id":"motion","title":"动态制作","members":["start","repeat","still","linked"]}
    ]);
    args
}
fn create(db: &Database, s: &StartedChat, args: &Value) -> AppResult<ChatCardAction> {
    db.create_local_chat_cards(&s.conversation.summary.id, &s.turn_id, "call", args)
}
fn document(db: &Database) -> Value {
    workflow(&db.conn.lock().unwrap(), "p").unwrap().1
}
fn replace_document(db: &Database, doc: &Value) {
    db.conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE canvas_workflows SET revision=revision+1,document_json=?1 WHERE project_id='p'",
            [doc.to_string()],
        )
        .unwrap();
}

fn parallel_document() -> Value {
    let mut live = base_node("live", "generation", 500.0, 60.0, "jimeng");
    live["outputs"] = json!({"image":{"type":"image","assetIds":["picture"]}});
    let runs = json!([
        {"id":"live-run","threadId":"live-thread","startId":"live","status":"running",
            "order":["live"],"lockedNodeIds":["live","reference"],"writeNodeIds":["live"],
            "steps":{"live":{"status":"running","jobId":"already-submitted","generationSubmission":"submitted","progress":0.25}}},
        {"id":"waiting-run","threadId":"waiting-thread","startId":"waiting","status":"waiting",
            "order":["waiting"],"lockedNodeIds":["waiting","reference"],"writeNodeIds":["waiting"],
            "steps":{"waiting":{"status":"waiting","requestId":"existing-request","error":"等待已有任务"}}}
    ]);
    json!({"schema_version":1,
        "nodes":[base_node("reference","generation",60.0,60.0,"jimeng"),live,base_node("waiting","generation",900.0,60.0,"jimeng")],
        "cardNames":{"reference":"参考","live":"正在绘画","waiting":"等待取回"},
        "run":runs[1],"runs":runs})
}

#[test]
fn local_chat_cards_create_and_undo_preserve_unrelated_active_runs_and_locks() {
    for legacy in [false, true] {
        let (db, s) = fixture();
        let mut before = parallel_document();
        if legacy {
            before["run"] = before["runs"][0].clone();
            before.as_object_mut().unwrap().remove("runs");
        }
        save_workflow(&db.conn.lock().unwrap(), "p", 0, &before).unwrap();
        let action = create(&db, &s, &batch()).unwrap();
        let after = document(&db);
        assert_eq!(after["run"], before["run"]);
        assert_eq!(after["runs"], before["runs"]);
        assert_eq!(
            &after["nodes"].as_array().unwrap()[..3],
            before["nodes"].as_array().unwrap()
        );
        assert_eq!(workflow(&db.conn.lock().unwrap(), "p").unwrap().0, 2);
        assert_eq!(after["nodes"].as_array().unwrap().len(), 6);
        db.undo_local_chat_cards(&s.conversation.summary.id, &action.id)
            .unwrap();
        assert_eq!(document(&db), before, "only this batch is removed");
        assert_eq!(workflow(&db.conn.lock().unwrap(), "p").unwrap().0, 3);
        assert!(db.get_canvas_node(&action.cards[0].id).unwrap().is_none());
        let tasks: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM task_queue", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tasks, 0, "creating cards never submits or restarts a run");
    }
}

#[test]
fn local_chat_cards_wal_progress_writer_requires_current_revision_and_keeps_batches() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("parallel-chat.sqlite");
    let (db, s) = fixture_with_db(Database::open(&path).unwrap());
    let writer = Database::open(&path).unwrap();
    save_workflow(&db.conn.lock().unwrap(), "p", 0, &parallel_document()).unwrap();
    let (stale_revision, mut stale) = workflow(&writer.conn.lock().unwrap(), "p").unwrap();
    let action = create(&db, &s, &batch()).unwrap();
    let after_create = document(&db);
    stale["runs"][0]["steps"]["live"]["progress"] = json!(0.75);
    assert!(save_workflow(&writer.conn.lock().unwrap(), "p", stale_revision, &stale).is_err());
    assert_eq!(
        document(&db),
        after_create,
        "stale progress cannot remove new cards"
    );

    let (revision, mut merged) = workflow(&writer.conn.lock().unwrap(), "p").unwrap();
    merged["runs"][0]["steps"]["live"]["progress"] = json!(0.75);
    save_workflow(&writer.conn.lock().unwrap(), "p", revision, &merged).unwrap();
    db.undo_local_chat_cards(&s.conversation.summary.id, &action.id)
        .unwrap();
    let after_undo = document(&db);
    assert_eq!(after_undo["runs"], merged["runs"]);
    assert_eq!(after_undo["run"], merged["run"]);
    assert_eq!(after_undo["nodes"].as_array().unwrap().len(), 3);

    // A second SQLite connection can hold an old WAL read snapshot while the app
    // commits a batch. Upgrading that snapshot to a writer must fail atomically.
    let conn = writer.conn.lock().unwrap();
    let snapshot = conn.unchecked_transaction().unwrap();
    let (revision, old) = workflow(&snapshot, "p").unwrap();
    let second = db
        .create_local_chat_cards(&s.conversation.summary.id, &s.turn_id, "second", &batch())
        .unwrap();
    assert!(save_workflow(&snapshot, "p", revision, &old).is_err());
    snapshot.rollback().unwrap();
    let latest = workflow(&conn, "p").unwrap().1;
    assert!(latest["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["id"] == second.cards[1].id));
    assert_eq!(latest["runs"], after_undo["runs"]);
    assert_eq!(latest["run"], after_undo["run"]);
}

#[test]
fn local_chat_cards_undo_rejects_its_own_active_run_or_run_dependency() {
    for field in ["order", "lockedNodeIds", "step"] {
        let (db, s) = fixture();
        save_workflow(&db.conn.lock().unwrap(), "p", 0, &parallel_document()).unwrap();
        let action = create(&db, &s, &batch()).unwrap();
        let mut doc = document(&db);
        let id = &action.cards[1].id;
        match field {
            "order" => {
                for scope in ["order", "lockedNodeIds", "writeNodeIds"] {
                    doc["runs"][0][scope]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(id));
                }
                doc["runs"][0]["steps"][id] = json!({"status":"running","jobId":"batch-job"});
            }
            "lockedNodeIds" => doc["runs"][0][field]
                .as_array_mut()
                .unwrap()
                .push(json!(id)),
            "step" => {
                doc["runs"][0]["steps"]["live"]["contentTarget"] =
                    json!({"nodeId":action.cards[0].id})
            }
            _ => unreachable!(),
        }
        crate::commands::canvas_workflow::validate(&doc).unwrap();
        replace_document(&db, &doc);
        assert!(
            db.undo_local_chat_cards(&s.conversation.summary.id, &action.id)
                .is_err(),
            "{field}"
        );
        assert_eq!(document(&db), doc);
        assert!(db.get_canvas_node(&action.cards[0].id).unwrap().is_some());
        assert_eq!(
            db.get_local_chat(&s.conversation.summary.id)
                .unwrap()
                .unwrap()
                .actions[0]
                .status,
            "created"
        );
    }
}

#[test]
fn local_chat_cards_undo_checks_exact_cached_content_ids_in_all_run_shapes() {
    for field in ["cellTexts", "cellValues"] {
        for legacy in [false, true] {
            let (db, s) = fixture();
            let mut before = parallel_document();
            if legacy {
                before["run"] = before["runs"][0].clone();
                before.as_object_mut().unwrap().remove("runs");
            }
            save_workflow(&db.conn.lock().unwrap(), "p", 0, &before).unwrap();
            for referenced in [false, true] {
                let action = db
                    .create_local_chat_cards(
                        &s.conversation.summary.id,
                        &s.turn_id,
                        if referenced { "used" } else { "unrelated" },
                        &batch(),
                    )
                    .unwrap();
                let mut doc = document(&db);
                let run = if legacy {
                    &mut doc["run"]
                } else {
                    &mut doc["runs"][0]
                };
                run["status"] = json!("done");
                let note_id = if referenced {
                    action.cards[0].id.clone()
                } else {
                    format!("{}-other", action.cards[0].id)
                };
                let key = json!([note_id, "*text"]).to_string();
                run[field] = json!({key: if field == "cellTexts" { json!("frozen") } else { json!({"type":"text","text":"frozen"}) }});
                crate::commands::canvas_workflow::validate(&doc).unwrap();
                replace_document(&db, &doc);
                let result = db.undo_local_chat_cards(&s.conversation.summary.id, &action.id);
                assert_eq!(result.is_err(), referenced, "{field}, legacy={legacy}");
                if referenced {
                    assert_eq!(document(&db), doc);
                    assert!(db.get_canvas_node(&action.cards[0].id).unwrap().is_some());
                }
            }
        }
    }
}

#[test]
fn local_chat_cards_compile_four_native_kinds_without_execution() {
    let (db, s) = fixture();
    let result = create(&db, &s, &batch()).unwrap();
    let doc = document(&db);
    assert_eq!(result.cards.len(), 4);
    assert_eq!(doc["nodes"].as_array().unwrap().len(), 3);
    assert!(doc["run"].is_null());
    let draw = doc["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["kind"] == "generation")
        .unwrap();
    assert_eq!(draw["provider"], "jimeng");
    assert_eq!(draw["inputs"]["image"][0]["slot"], 1);
    assert_eq!(draw["promptReferences"][0]["slot"], 1);
    assert_eq!(draw["promptReferences"][0]["label"], "图片来源 1");
    assert_eq!(draw["promptReferences"][1]["label"], "文本 1");
    assert_eq!(draw["inputs"]["image"][0]["assetId"], "picture");
    assert_eq!(draw["promptReferences"].as_array().unwrap().len(), 2);
    assert!(draw["prompt"].as_str().unwrap().contains("当前轮次：@["));
    let repeat = doc["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["kind"] == "loop")
        .unwrap();
    assert_eq!(repeat["loopCount"], 3);
    let note = db.get_canvas_node(&result.cards[0].id).unwrap().unwrap();
    let payload: Value = serde_json::from_str(&note.payload_json).unwrap();
    assert_eq!(payload["cells"][1][0]["text"], "第二行");
    assert_eq!(doc["cardNames"][&result.cards[0].id], "文案");
    let chat = db
        .get_local_chat(&s.conversation.summary.id)
        .unwrap()
        .unwrap();
    assert_eq!(chat.actions.len(), 1);
    let count: i64 = db
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM task_queue", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn local_chat_cards_h3_drafts_use_native_defaults_and_bounded_options() {
    let (db, s) = fixture();
    let args =
        json!({"cards":[{"id":"h3","kind":"comfy-video","title":"H3 草稿","prompt":"缓慢推近"}]});
    let action = create(&db, &s, &args).unwrap();
    assert_eq!(action.cards[0].kind, "comfy-video");
    let doc = document(&db);
    let h3 = &doc["nodes"][0];
    assert_eq!(h3["provider"], "comfy-video");
    assert_eq!(
        h3["comfyVideo"],
        json!({"endpoint":"http://127.0.0.1:8000","seconds":8,"ratio":"9:16","resolution":0.8})
    );
    assert_eq!(
        h3["inputs"],
        json!({}),
        "missing first frame remains an editable draft"
    );
    assert_eq!(h3["outputs"], json!({}));
    assert!(h3.get("generation").is_none());
    assert!(doc["run"].is_null());
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM task_queue", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    for ratio in ["auto", "9:16", "16:9", "4:3", "3:4", "1:1"] {
        for resolution in [0.6, 0.8, 1.0] {
            for seconds in [1, 15] {
                let mut args = args.clone();
                args["cards"][0]["ratio"] = json!(ratio);
                args["cards"][0]["resolution"] = json!(resolution);
                args["cards"][0]["seconds"] = json!(seconds);
                let compiled = compile(
                    &args,
                    &ChatCardDefaults::default(),
                    &[],
                    (0.0, 0.0),
                    "options",
                )
                .unwrap();
                let options = &compiled.nodes[0]["comfyVideo"];
                assert_eq!(options["ratio"], ratio);
                assert_eq!(options["resolution"], resolution);
                assert_eq!(options["seconds"], seconds);
                crate::commands::canvas_workflow::validate(
                    &json!({"schema_version":1,"nodes":compiled.nodes,"run":null}),
                )
                .unwrap();
            }
        }
    }
}

#[test]
fn local_chat_cards_h3_frames_text_loops_and_layout_are_native() {
    for mode in ["count", "rows"] {
        let (db, s) = fixture();
        let mut args = h3_batch();
        if mode == "rows" {
            args["cards"][5] = json!({"id":"repeat","kind":"loop","title":"逐行 H3","mode":"rows","source":"copy","body":["still","linked"]});
        }
        let action = create(&db, &s, &args).unwrap();
        let doc = document(&db);
        let nodes = doc["nodes"].as_array().unwrap();
        let node = |alias: &str| {
            let id = &action.cards.iter().find(|c| c.alias == alias).unwrap().id;
            nodes.iter().find(|n| n["id"] == *id).unwrap()
        };
        assert_eq!(
            node("still")["inputs"]["first-frame"],
            json!([{"assetId":"picture"}])
        );
        assert_eq!(
            node("still")["inputs"]["last-frame"],
            json!([{"assetId":"picture"}])
        );
        assert_eq!(
            node("linked")["inputs"]["first-frame"],
            json!([{"nodeId":node("draw")["id"],"portId":"image"}])
        );
        assert_eq!(
            node("still")["inputs"]["text"][0]["portId"],
            if mode == "rows" { "text" } else { "iteration" }
        );
        assert_eq!(
            node("still")["inputs"]["text"][1]["canvasNodeId"],
            action.cards[0].id
        );
        assert!(
            node("still").get("promptReferences").is_none(),
            "H3 consumes native text bindings directly"
        );
        assert_eq!(node("still")["prompt"], "产品缓慢旋转");
        assert!(
            node("start")["x"].as_f64().unwrap()
                >= node("linked")["x"].as_f64().unwrap() + 416.0 + 80.0
        );
        assert!(
            node("linked")["y"].as_f64().unwrap()
                >= node("still")["y"].as_f64().unwrap() + 720.0 + 80.0
        );
        let right = nodes
            .iter()
            .map(|n| {
                n["x"].as_f64().unwrap()
                    + if n["kind"] == "comfy-video" {
                        416.0
                    } else {
                        340.0
                    }
            })
            .fold(0.0, f64::max);
        let next = db.create_local_chat_cards(&s.conversation.summary.id, &s.turn_id, "next", &json!({"cards":[{"id":"next","kind":"comfy-video","title":"下一张","prompt":"缓慢移动"}]})).unwrap();
        let next_doc = document(&db);
        let next_node = next_doc["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == next.cards[0].id)
            .unwrap();
        assert!(next_node["x"].as_f64().unwrap() >= right + 80.0);
        crate::commands::canvas_workflow::validate(&doc).unwrap();
    }
}

#[test]
fn local_chat_cards_h3_survives_reopen_replay_and_undo_beside_active_runs() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("library.sqlite");
    let (db, s) = fixture_with_db(Database::open(&path).unwrap());
    let before = parallel_document();
    save_workflow(&db.conn.lock().unwrap(), "p", 0, &before).unwrap();
    let args = h3_batch();
    let action = create(&db, &s, &args).unwrap();
    let saved = document(&db);
    assert_eq!(saved["runs"], before["runs"]);
    assert_eq!(saved["run"], before["run"]);
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(document(&db), saved);
    let restored = db
        .get_local_chat(&s.conversation.summary.id)
        .unwrap()
        .unwrap();
    assert_eq!(restored.actions[0].cards[2].kind, "comfy-video");
    db.finish_local_chat(&s.conversation.summary.id, &s.turn_id, "done", None)
        .unwrap();
    assert_eq!(create(&db, &s, &args).unwrap().id, action.id);
    db.undo_local_chat_cards(&s.conversation.summary.id, &action.id)
        .unwrap();
    assert_eq!(document(&db), before);
    assert_eq!(create(&db, &s, &args).unwrap().status, "undone");
    drop(db);
}

#[test]
fn local_chat_cards_sections_compile_native_members_names_and_grid_without_execution() {
    for large in [false, true] {
        let args = section_batch(large);
        let compiled = compile(
            &args,
            &ChatCardDefaults::default(),
            &["picture".into()],
            (0.0, 0.0),
            "sections",
        )
        .unwrap();
        assert_eq!(compiled.cards.len(), 9);
        assert_eq!(compiled.nodes.len(), 5);
        let sections: Vec<_> = compiled
            .notes
            .iter()
            .filter(|note| note["payload"]["note_type"] == "section")
            .collect();
        assert_eq!(sections.len(), 2);
        for (index, section) in sections.iter().enumerate() {
            let payload = &section["payload"];
            assert_eq!(payload["cells"], json!([]));
            assert!(payload.get("artboard").is_none());
            assert!(payload.get("workflow_container").is_none());
            assert_eq!(payload["text"], payload["title"]);
            assert_eq!(
                compiled.names[section["id"].as_str().unwrap()],
                payload["title"]
            );
            let expected: Vec<_> = args["sections"][index]["members"]
                .as_array()
                .unwrap()
                .iter()
                .map(|alias| {
                    compiled
                        .cards
                        .iter()
                        .find(|card| card.alias == alias.as_str().unwrap())
                        .unwrap()
                        .id
                        .clone()
                })
                .collect();
            assert_eq!(payload["member_ids"], json!(expected));
            for id in expected {
                let member = compiled
                    .notes
                    .iter()
                    .chain(&compiled.nodes)
                    .find(|node| node["id"] == id)
                    .unwrap();
                let width =
                    member["width"]
                        .as_f64()
                        .unwrap_or(if member["kind"] == "comfy-video" {
                            416.0
                        } else {
                            340.0
                        });
                let height =
                    member["height"]
                        .as_f64()
                        .unwrap_or(if member["kind"] == "comfy-video" {
                            720.0
                        } else {
                            600.0
                        });
                assert!(member["x"].as_f64().unwrap() >= section["x"].as_f64().unwrap() + 72.0);
                assert!(member["y"].as_f64().unwrap() >= section["y"].as_f64().unwrap() + 96.0);
                assert!(
                    member["x"].as_f64().unwrap() + width
                        <= section["x"].as_f64().unwrap() + section["width"].as_f64().unwrap()
                            - 72.0
                );
                assert!(
                    member["y"].as_f64().unwrap() + height
                        <= section["y"].as_f64().unwrap() + section["height"].as_f64().unwrap()
                            - 64.0
                );
            }
        }
        assert!(
            sections[1]["x"].as_f64().unwrap()
                >= sections[0]["x"].as_f64().unwrap()
                    + sections[0]["width"].as_f64().unwrap()
                    + 160.0
        );
        let loose = compiled
            .notes
            .iter()
            .find(|note| note["id"] == compiled.cards[6].id)
            .unwrap();
        assert!(
            loose["y"].as_f64().unwrap()
                > sections
                    .iter()
                    .map(|s| s["y"].as_f64().unwrap() + s["height"].as_f64().unwrap())
                    .fold(0.0, f64::max)
        );
        if large {
            assert_eq!(compiled.notes[0]["width"], json!(2400.0));
            assert_eq!(compiled.notes[0]["height"], json!(6446.0));
        }
        assert!(compiled
            .nodes
            .iter()
            .all(|node| node["outputs"] == json!({}) && node.get("comfyVideoTask").is_none()));
    }
}

#[test]
fn local_chat_cards_sections_reopen_replay_and_undo_with_unrelated_runs_and_names() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("sections.sqlite");
    let (db, s) = fixture_with_db(Database::open(&path).unwrap());
    let mut before = parallel_document();
    before["cardNames"]["reference"] = json!("前期规划");
    save_workflow(&db.conn.lock().unwrap(), "p", 0, &before).unwrap();
    let args = section_batch(true);
    let action = create(&db, &s, &args).unwrap();
    assert_eq!(action.cards[7].title, "前期规划 2");
    let section = note_snapshot(&db.conn.lock().unwrap(), &action.cards[7].id)
        .unwrap()
        .unwrap();
    assert_eq!(section["payload"]["title"], json!("前期规划 2"));
    assert_eq!(section["payload"]["text"], json!("前期规划 2"));
    let saved = document(&db);
    assert_eq!(saved["runs"], before["runs"]);
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(document(&db), saved);
    assert_eq!(
        db.get_local_chat(&s.conversation.summary.id)
            .unwrap()
            .unwrap()
            .actions[0]
            .cards[7]
            .kind,
        "section"
    );
    assert_eq!(create(&db, &s, &args).unwrap().id, action.id);
    // Normal H3 environment synchronization remains compatible with whole-batch undo.
    let mut doc = document(&db);
    for node in doc["nodes"].as_array_mut().unwrap() {
        if node["kind"] == "comfy-video" {
            node["comfyVideo"]["endpoint"] = json!("http://127.0.0.1:8188");
        }
    }
    replace_document(&db, &doc);
    db.undo_local_chat_cards(&s.conversation.summary.id, &action.id)
        .unwrap();
    assert_eq!(document(&db), before);
    for card in action
        .cards
        .iter()
        .filter(|c| matches!(c.kind.as_str(), "section" | "content"))
    {
        assert!(db.get_canvas_node(&card.id).unwrap().is_none());
    }
    assert_eq!(create(&db, &s, &args).unwrap().status, "undone");
}

#[test]
fn local_chat_cards_sections_reject_invalid_members_and_ports_atomically() {
    let mut invalids = Vec::new();
    for section in [
        json!({"id":"zone","title":"分区","members":[]}),
        json!({"id":"zone","title":"分区","members":["outside"]}),
        json!({"id":"zone","title":"分区","members":["zone"]}),
        json!({"id":"zone","title":"分区","members":["copy","copy"]}),
        json!({"id":"copy","title":"分区","members":["draw"]}),
        json!({"id":"zone","title":" ","members":["copy"]}),
        json!({"id":"invalid alias","title":"分区","members":["copy"]}),
        json!({"id":"zone","title":"分区","members":["copy"],"x":100}),
    ] {
        let mut args = batch();
        args["sections"] = json!([section]);
        invalids.push(args);
    }
    for second in [
        json!({"id":"other","title":"二","members":["zone"]}),
        json!({"id":"other","title":"二","members":["copy"]}),
        json!({"id":"zone","title":"二","members":["draw"]}),
    ] {
        let mut args = batch();
        args["sections"] = json!([{"id":"zone","title":"一","members":["copy"]},second]);
        invalids.push(args);
    }
    for mutation in ["from", "to", "body", "source"] {
        let mut args = batch();
        args["sections"] = json!([{"id":"zone","title":"分区","members":["copy"]}]);
        match mutation {
            "from" => {
                args["connections"] =
                    json!([{"from":"zone","to":"draw","output":"text","input":"text"}])
            }
            "to" => {
                args["connections"] =
                    json!([{"from":"copy","to":"zone","output":"text","input":"text"}])
            }
            "body" => args["cards"][3]["body"] = json!(["zone"]),
            _ => {
                args["cards"][3] = json!({"id":"repeat","kind":"loop","title":"循环","mode":"rows","source":"zone","body":["draw"]})
            }
        }
        invalids.push(args);
    }
    for args in invalids {
        let (db, s) = fixture();
        assert!(create(&db, &s, &args).is_err(), "{args}");
        assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
        assert!(db
            .get_local_chat(&s.conversation.summary.id)
            .unwrap()
            .unwrap()
            .actions
            .is_empty());
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM canvas_nodes", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn local_chat_cards_sections_limit_is_independent_and_grid_avoids_existing_sections() {
    let cards: Vec<_> = (0..12).map(|i| json!({"id":format!("c{i}"),"kind":"content","title":format!("卡片{i}"),"text":"文字"})).collect();
    let sections: Vec<_> = (0..12).map(|i| json!({"id":format!("s{i}"),"title":format!("分区{i}"),"members":[format!("c{i}")]})).collect();
    let args = json!({"cards":cards,"sections":sections});
    let (db, s) = fixture();
    let payload =
        json!({"schema_version":1,"note_type":"section","text":"旧区","cells":[],"member_ids":[]});
    db.conn.lock().unwrap().execute("INSERT INTO canvas_nodes(id,project_id,kind,payload_json,x,y,width,height,created_at,updated_at) VALUES('existing-section','p','note',?1,10000,0,9000,400,1,1)",[payload.to_string()]).unwrap();
    let action = create(&db, &s, &args).unwrap();
    assert_eq!(action.cards.len(), 24);
    let bounds: Vec<_> = action
        .cards
        .iter()
        .filter(|c| c.kind == "section")
        .map(|card| {
            note_snapshot(&db.conn.lock().unwrap(), &card.id)
                .unwrap()
                .unwrap()
        })
        .collect();
    assert!(bounds
        .iter()
        .all(|note| note["x"].as_f64().unwrap() >= 19080.0));
    assert_eq!(
        bounds[0]["x"], bounds[2]["x"],
        "sections wrap after two columns"
    );
    for (i, first) in bounds.iter().enumerate() {
        for second in bounds.iter().skip(i + 1) {
            assert!(
                first["x"].as_f64().unwrap() + first["width"].as_f64().unwrap()
                    <= second["x"].as_f64().unwrap()
                    || second["x"].as_f64().unwrap() + second["width"].as_f64().unwrap()
                        <= first["x"].as_f64().unwrap()
                    || first["y"].as_f64().unwrap() + first["height"].as_f64().unwrap()
                        <= second["y"].as_f64().unwrap()
                    || second["y"].as_f64().unwrap() + second["height"].as_f64().unwrap()
                        <= first["y"].as_f64().unwrap()
            );
        }
    }
    let mut too_many = args.clone();
    too_many["sections"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"extra","title":"额外","members":["c0"]}));
    assert!(compile(
        &too_many,
        &ChatCardDefaults::default(),
        &[],
        (0.0, 0.0),
        "limit"
    )
    .is_err());
    let mut empty = args;
    empty["cards"] = json!([]);
    assert!(compile(
        &empty,
        &ChatCardDefaults::default(),
        &[],
        (0.0, 0.0),
        "empty"
    )
    .is_err());
}

#[test]
fn local_chat_cards_sections_rollback_on_late_failure_and_obey_turn_scope() {
    let (db, s) = fixture();
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_chat_action BEFORE INSERT ON local_chat_card_actions BEGIN SELECT RAISE(ABORT,'injected action failure'); END;").unwrap();
    assert!(create(&db, &s, &section_batch(false)).is_err());
    assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM canvas_nodes", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let (db, s) = fixture();
    assert!(db
        .create_local_chat_cards(
            &s.conversation.summary.id,
            "wrong-turn",
            "call",
            &section_batch(false)
        )
        .is_err());
    db.mark_local_chat_stopping(&s.conversation.summary.id)
        .unwrap();
    assert!(create(&db, &s, &section_batch(false)).is_err());
}

#[test]
fn local_chat_cards_sections_undo_rejects_changed_frames_members_and_external_dependencies() {
    for change in [
        "x",
        "height",
        "title",
        "members",
        "name",
        "member-content",
        "member-position",
        "run",
        "external-section",
    ] {
        let (db, s) = fixture();
        let action = create(&db, &s, &section_batch(false)).unwrap();
        let section = &action.cards[7].id;
        let member = &action.cards[0].id;
        match change {
            "x" | "height" => {
                db.conn
                    .lock()
                    .unwrap()
                    .execute(
                        &format!("UPDATE canvas_nodes SET {change}={change}+1 WHERE id=?1"),
                        [section],
                    )
                    .unwrap();
            }
            "title" | "members" => {
                let mut note = note_snapshot(&db.conn.lock().unwrap(), section)
                    .unwrap()
                    .unwrap();
                if change == "title" {
                    note["payload"]["text"] = json!("改过名称");
                } else {
                    note["payload"]["member_ids"] = json!([]);
                }
                db.conn
                    .lock()
                    .unwrap()
                    .execute(
                        "UPDATE canvas_nodes SET payload_json=?1 WHERE id=?2",
                        params![note["payload"].to_string(), section],
                    )
                    .unwrap();
            }
            "member-content" => {
                let mut note = note_snapshot(&db.conn.lock().unwrap(), member)
                    .unwrap()
                    .unwrap();
                note["payload"]["cells"][0][0]["text"] = json!("用户编辑");
                db.conn
                    .lock()
                    .unwrap()
                    .execute(
                        "UPDATE canvas_nodes SET payload_json=?1 WHERE id=?2",
                        params![note["payload"].to_string(), member],
                    )
                    .unwrap();
            }
            "external-section" => {
                let payload = json!({"schema_version":1,"note_type":"section","text":"其他分区","member_ids":[section]});
                db.conn.lock().unwrap().execute("INSERT INTO canvas_nodes(id,project_id,kind,payload_json,x,y,width,height,created_at,updated_at) VALUES('external-section','p','note',?1,0,0,300,200,1,1)",[payload.to_string()]).unwrap();
            }
            _ => {
                let mut doc = document(&db);
                match change {
                    "name" => doc["cardNames"][section] = json!("新分区名"),
                    "member-position" => doc["nodes"][0]["x"] = json!(0),
                    _ => {
                        doc["run"] = json!({"id":"finished","status":"done","order":[action.cards[2].id],"steps":{}})
                    }
                }
                replace_document(&db, &doc);
            }
        }
        assert!(
            db.undo_local_chat_cards(&s.conversation.summary.id, &action.id)
                .is_err(),
            "{change}"
        );
        assert!(db.get_canvas_node(section).unwrap().is_some());
        assert_eq!(
            db.get_local_chat(&s.conversation.summary.id)
                .unwrap()
                .unwrap()
                .actions[0]
                .status,
            "created"
        );
    }
}

#[test]
fn local_chat_cards_h3_undo_allows_environment_sync_but_preserves_edit_and_run_guards() {
    for field in [
        "endpoint",
        "seconds",
        "ratio",
        "resolution",
        "inputs",
        "outputs",
        "position",
        "run",
    ] {
        let (db, s) = fixture();
        let action = create(&db, &s, &h3_batch()).unwrap();
        let id = &action.cards[2].id;
        let mut doc = document(&db);
        let node = doc["nodes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|n| n["id"] == *id)
            .unwrap();
        node["comfyVideo"]["endpoint"] = json!("http://127.0.0.1:18189");
        match field {
            "endpoint" => {}
            "seconds" => node["comfyVideo"]["seconds"] = json!(12),
            "ratio" => node["comfyVideo"]["ratio"] = json!("1:1"),
            "resolution" => node["comfyVideo"]["resolution"] = json!(1),
            "inputs" => node["inputs"]["last-frame"] = json!([]),
            "outputs" => node["outputs"] = json!({"image":{"type":"image","assetIds":["picture"]}}),
            "position" => node["x"] = json!(node["x"].as_f64().unwrap() + 1.0),
            "run" => {
                doc["run"] = json!({"id":"h3-run","threadId":"thread","startId":id,"status":"done","order":[id],"steps":{id:{"status":"done"}}})
            }
            _ => unreachable!(),
        }
        crate::commands::canvas_workflow::validate(&doc).unwrap();
        replace_document(&db, &doc);
        let undone = db.undo_local_chat_cards(&s.conversation.summary.id, &action.id);
        if field == "endpoint" {
            undone.unwrap();
            assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
            assert!(db.get_canvas_node(&action.cards[0].id).unwrap().is_none());
        } else {
            assert!(undone.is_err(), "{field}");
            assert_eq!(document(&db), doc);
        }
    }
}

#[test]
fn local_chat_cards_h3_rejects_invalid_options_and_frame_sources_atomically() {
    let invalid_fields = [
        ("seconds", json!(0)),
        ("seconds", json!(16)),
        ("seconds", json!(1.5)),
        ("seconds", json!("8")),
        ("resolution", json!(0.7)),
        ("resolution", json!("0.8")),
        ("ratio", json!("21:9")),
        ("ratio", json!("2:3")),
        ("prompt", json!(" ")),
        ("prompt", json!("@[injected]")),
        ("prompt", json!("x".repeat(8001))),
        ("endpoint", json!("http://example.invalid")),
        ("provider", json!("jimeng")),
        ("firstFrameAlias", json!("picture")),
        ("lastFrameAlias", json!("image2")),
        ("firstFrameAlias", json!("image01")),
        ("firstFrameAlias", json!("image9")),
    ];
    for (field, value) in invalid_fields {
        let (db, s) = fixture();
        let mut args = h3_batch();
        args["cards"][2][field] = value;
        assert!(
            create(&db, &s, &args).is_err(),
            "{field}: {}",
            args["cards"][2][field]
        );
        assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
        assert!(db
            .get_local_chat(&s.conversation.summary.id)
            .unwrap()
            .unwrap()
            .actions
            .is_empty());
        assert_eq!(
            db.conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM canvas_nodes", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    for ext in ["gif", "mp4", "svg"] {
        let (db, s) = fixture();
        db.conn
            .lock()
            .unwrap()
            .execute("UPDATE assets SET ext=?1 WHERE id='picture'", [ext])
            .unwrap();
        assert!(create(&db, &s, &h3_batch()).is_err(), "{ext}");
        assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
        assert!(db
            .get_local_chat(&s.conversation.summary.id)
            .unwrap()
            .unwrap()
            .actions
            .is_empty());
    }
    let (db, s) = fixture();
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_h3_action BEFORE INSERT ON local_chat_card_actions BEGIN SELECT RAISE(ABORT,'injected action failure'); END;").unwrap();
    assert!(create(&db, &s, &h3_batch()).is_err());
    assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM canvas_nodes", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn local_chat_cards_h3_accepts_video_outputs_and_rejects_frame_conflicts() {
    let (db, s) = fixture();
    let mut args = h3_batch();
    args["cards"].as_array_mut().unwrap().push(json!({"id":"video","kind":"generation","title":"视频续写","prompt":"继续视频","mediaType":"video"}));
    args["connections"].as_array_mut().unwrap().extend([
        json!({"from":"still","to":"video","output":"image","input":"image"}),
        json!({"from":"still","to":"start","output":"image","input":"completion"}),
        json!({"from":"start","to":"still","output":"signal","input":"signal"}),
    ]);
    let action = create(&db, &s, &args).unwrap();
    let doc = document(&db);
    let video = doc["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == action.cards[6].id)
        .unwrap();
    assert_eq!(
        video["generation"]["videoOptions"]["kind"],
        "multimodal2video"
    );
    for case in [
        "alias-connection",
        "two-connections",
        "h3-frame",
        "video-frame",
        "h3-image",
        "content-frame",
        "image-port",
    ] {
        let (db, s) = fixture();
        let mut args = h3_batch();
        let wire = match case {
            "alias-connection" => {
                json!({"from":"draw","to":"still","output":"image","input":"first-frame"})
            }
            "two-connections" => {
                args["cards"].as_array_mut().unwrap().push(json!({"id":"other","kind":"generation","title":"另一个首帧","prompt":"首帧","mediaType":"image"}));
                json!({"from":"other","to":"linked","output":"image","input":"first-frame"})
            }
            "h3-frame" => {
                json!({"from":"still","to":"linked","output":"image","input":"last-frame"})
            }
            "video-frame" => {
                args["cards"][1]["mediaType"] = json!("video");
                json!({"from":"draw","to":"still","output":"image","input":"first-frame"})
            }
            "h3-image" => json!({"from":"still","to":"draw","output":"image","input":"image"}),
            "content-frame" => {
                json!({"from":"copy","to":"still","output":"text","input":"first-frame"})
            }
            "image-port" => json!({"from":"draw","to":"still","output":"image","input":"image"}),
            _ => unreachable!(),
        };
        args["connections"].as_array_mut().unwrap().push(wire);
        assert!(create(&db, &s, &args).is_err(), "{case}");
        assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
        assert!(db
            .get_local_chat(&s.conversation.summary.id)
            .unwrap()
            .unwrap()
            .actions
            .is_empty());
    }
}

#[test]
fn local_chat_cards_layout_uses_content_dimensions_and_video_uses_actual_inputs() {
    let (db, s) = fixture();
    let mut args = batch();
    args["cards"][0]["rows"] = json!([vec!["wide"; 12]]);
    args["cards"][1]["mediaType"] = json!("video");
    let result = create(&db, &s, &args).unwrap();
    let doc = document(&db);
    let note = db.get_canvas_node(&result.cards[0].id).unwrap().unwrap();
    let draw = &doc["nodes"][0];
    assert!(draw["x"].as_f64().unwrap() >= note.x + note.width + 80.0);
    assert_eq!(draw["generation"]["videoOptions"]["kind"], "image2video");
    assert!(draw["ratio"].is_null());
    let (db, s) = fixture();
    let mut args = batch();
    args["cards"][1]["mediaType"] = json!("video");
    args["cards"][1]["referenceAliases"] = json!([]);
    create(&db, &s, &args).unwrap();
    assert_eq!(
        document(&db)["nodes"][0]["generation"]["videoOptions"]["kind"],
        "text2video"
    );
}

#[test]
fn local_chat_cards_names_stay_unique_and_multiple_loops_are_rejected() {
    let (db, s) = fixture();
    let first = create(&db, &s, &batch()).unwrap();
    let second = db
        .create_local_chat_cards(&s.conversation.summary.id, &s.turn_id, "second", &batch())
        .unwrap();
    assert_eq!(first.cards[0].title, "文案");
    assert_eq!(second.cards[0].title, "文案 2");
    let mut args = batch();
    args["cards"].as_array_mut().unwrap().push(json!({"id":"second_loop","kind":"loop","title":"循环2","mode":"count","count":2,"body":["draw"]}));
    assert!(db
        .create_local_chat_cards(&s.conversation.summary.id, &s.turn_id, "third", &args)
        .is_err());
}

#[test]
fn local_chat_cards_rejects_known_unrunnable_media_and_empty_loop_inputs() {
    for case in [
        "gif",
        "video-output",
        "empty-rows",
        "image-ratio",
        "video-options",
    ] {
        let (db, s) = fixture();
        let mut args = batch();
        match case {
            "gif" => {
                args["cards"][1]["mediaType"] = json!("video");
                db.conn
                    .lock()
                    .unwrap()
                    .execute("UPDATE assets SET ext='gif' WHERE id='picture'", [])
                    .unwrap();
            }
            "video-output" => {
                args["cards"][1]["mediaType"] = json!("video");
                args["cards"].as_array_mut().unwrap().push(json!({"id":"other","kind":"generation","title":"图片","prompt":"生成图片","mediaType":"image"}));
                args["connections"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"from":"draw","to":"other","output":"image","input":"image"}));
            }
            "empty-rows" => {
                args["cards"][0]["rows"] = json!([[" "]]);
                args["cards"][3] = json!({"id":"repeat","kind":"loop","title":"逐行","mode":"rows","source":"copy","body":["draw"]});
            }
            "image-ratio" => args["cards"][1]["ratio"] = json!("21:9"),
            "video-options" => {
                args["cards"][1]["mediaType"] = json!("video");
                let mut defaults = ChatCardDefaults::default();
                defaults.video_options.model_version = "seedance2.0".into();
                defaults.video_options.duration = 30;
                db.conn
                    .lock()
                    .unwrap()
                    .execute(
                        "UPDATE local_chat_turns SET card_defaults_json=?1",
                        [serde_json::to_string(&defaults).unwrap()],
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(create(&db, &s, &args).is_err(), "{case}");
        assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
    }
}
#[test]
fn local_chat_cards_rows_source_and_body_are_real_prompt_inputs() {
    let (db, s) = fixture();
    let mut args = batch();
    args["cards"][3] = json!({"id":"repeat","kind":"loop","title":"逐行","mode":"rows","source":"copy","body":["draw"]});
    let result = create(&db, &s, &args).unwrap();
    let doc = document(&db);
    let nodes = doc["nodes"].as_array().unwrap();
    let owner = nodes.iter().find(|n| n["kind"] == "loop").unwrap();
    assert_eq!(
        owner["inputs"]["text"][0],
        json!({"canvasNodeId":result.cards[0].id,"cellId":"*text"})
    );
    let draw = nodes.iter().find(|n| n["kind"] == "generation").unwrap();
    assert_eq!(draw["inputs"]["text"][0]["portId"], "text");
    assert!(draw["prompt"].as_str().unwrap().contains("当前行内容：@["));
}
#[test]
fn local_chat_cards_call_replay_is_stable_after_finish_and_undo() {
    let (db, s) = fixture();
    let args = batch();
    let a = create(&db, &s, &args).unwrap();
    assert_eq!(create(&db, &s, &args).unwrap().id, a.id);
    db.finish_local_chat(&s.conversation.summary.id, &s.turn_id, "done", None)
        .unwrap();
    assert_eq!(create(&db, &s, &args).unwrap().id, a.id);
    let mut changed = args.clone();
    changed["cards"][1]["prompt"] = json!("different");
    assert!(create(&db, &s, &changed).is_err());
    db.undo_local_chat_cards(&s.conversation.summary.id, &a.id)
        .unwrap();
    assert_eq!(create(&db, &s, &args).unwrap().status, "undone");
    assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
    db.undo_local_chat_cards(&s.conversation.summary.id, &a.id)
        .unwrap();
}
#[test]
fn local_chat_cards_invalid_or_unowned_arguments_never_mutate_canvas() {
    let invalids = [
        json!({"cards":[{"id":"x","kind":"generation","title":"x","prompt":"x","mediaType":"image","x":10}]}),
        json!({"cards":[{"id":"x","kind":"generation","title":"x","prompt":"x","mediaType":"image","referenceAliases":["picture"]}]}),
        json!({"cards":[{"id":"x","kind":"generation","title":"x","prompt":"x","mediaType":"image","referenceAliases":["image2"]}]}),
        json!({"cards":[{"id":"x","kind":"content","title":"x","rows":[["a"],["b","c"]]}]}),
        json!({"cards":[{"id":"x","kind":"loop","title":"x","mode":"count","count":0,"body":["outside"]}]}),
        json!({"cards":[{"id":"x","kind":"trigger","title":"x"}],"connections":[{"from":"external","to":"x","output":"image","input":"completion"}]}),
    ];
    for args in invalids {
        let (db, s) = fixture();
        assert!(create(&db, &s, &args).is_err());
        assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
        assert!(db
            .get_local_chat(&s.conversation.summary.id)
            .unwrap()
            .unwrap()
            .actions
            .is_empty());
    }
}
#[test]
fn local_chat_cards_failure_after_projection_rolls_back_every_write() {
    let (db, s) = fixture();
    db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_chat_action BEFORE INSERT ON local_chat_card_actions BEGIN SELECT RAISE(ABORT,'injected action failure'); END;").unwrap();
    assert!(create(&db, &s, &batch()).is_err());
    assert!(document(&db)["nodes"].as_array().unwrap().is_empty());
    assert_eq!(
        db.conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM canvas_nodes", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn local_chat_cards_undo_only_removes_its_batch_and_keeps_manual_additions() {
    let (db, s) = fixture();
    let a = create(&db, &s, &batch()).unwrap();
    let mut doc = document(&db);
    // Browser JSON normalizes integral coordinates while saving an unrelated new card.
    for node in doc["nodes"].as_array_mut().unwrap() {
        for field in ["x", "y"] {
            node[field] = json!(node[field].as_f64().unwrap() as i64);
        }
    }
    let manual = base_node("manual", "generation", 13.0, 17.0, "codex");
    doc["nodes"].as_array_mut().unwrap().push(manual.clone());
    doc["cardNames"]["manual"] = json!("用户新增");
    replace_document(&db, &doc);
    db.undo_local_chat_cards(&s.conversation.summary.id, &a.id)
        .unwrap();
    let result = document(&db);
    assert_eq!(result["nodes"], json!([manual]));
    assert_eq!(result["cardNames"], json!({"manual":"用户新增"}));
    assert!(db.get_canvas_node(&a.cards[0].id).unwrap().is_none());
}
#[test]
fn local_chat_cards_undo_rejects_edited_output_external_wire_and_terminal_run() {
    for change in ["position", "output", "wire", "run", "name"] {
        let (db, s) = fixture();
        let a = create(&db, &s, &batch()).unwrap();
        let mut doc = document(&db);
        let id = a.cards[1].id.clone();
        match change {
            "position" => doc["nodes"][0]["x"] = json!(999),
            "output" => {
                doc["nodes"][0]["outputs"] = json!({"image":{"type":"image","assetIds":[]}})
            }
            "wire" => {
                let mut other = base_node("manual", "generation", 0.0, 0.0, "codex");
                other["inputs"] = json!({"image":[{"nodeId":id,"portId":"image"}]});
                doc["nodes"].as_array_mut().unwrap().push(other);
            }
            "run" => doc["run"] = json!({"id":"finished","status":"done","order":[id],"steps":{}}),
            "name" => doc["cardNames"][&id] = json!("手动名称"),
            _ => unreachable!(),
        }
        replace_document(&db, &doc);
        assert!(
            db.undo_local_chat_cards(&s.conversation.summary.id, &a.id)
                .is_err(),
            "{change}"
        );
        assert_eq!(document(&db), doc);
    }
}
#[test]
fn local_chat_cards_undo_rejects_content_edits_and_section_membership() {
    for external in [false, true] {
        let (db, s) = fixture();
        let a = create(&db, &s, &batch()).unwrap();
        let id = &a.cards[0].id;
        if external {
            let payload =
                json!({"schema_version":1,"note_type":"section","text":"","member_ids":[id]});
            db.conn.lock().unwrap().execute("INSERT INTO canvas_nodes(id,project_id,kind,payload_json,x,y,width,height,created_at,updated_at) VALUES('section','p','note',?1,0,0,300,200,1,1)",[payload.to_string()]).unwrap();
        } else {
            db.conn
                .lock()
                .unwrap()
                .execute("UPDATE canvas_nodes SET x=x+1 WHERE id=?1", [id])
                .unwrap();
        }
        assert!(db
            .undo_local_chat_cards(&s.conversation.summary.id, &a.id)
            .is_err());
        assert!(db.get_canvas_node(id).unwrap().is_some());
    }
}
#[test]
fn local_chat_cards_scope_stop_and_batch_budget_are_enforced() {
    let (db, s) = fixture();
    assert!(db
        .create_local_chat_cards(&s.conversation.summary.id, "other", "x", &batch())
        .is_err());
    for i in 0..4 {
        db.create_local_chat_cards(
            &s.conversation.summary.id,
            &s.turn_id,
            &format!("call{i}"),
            &batch(),
        )
        .unwrap();
    }
    assert!(db
        .create_local_chat_cards(&s.conversation.summary.id, &s.turn_id, "call5", &batch())
        .is_err());
    let (db, s) = fixture();
    db.mark_local_chat_stopping(&s.conversation.summary.id)
        .unwrap();
    assert!(create(&db, &s, &batch()).is_err());
}
#[test]
fn local_chat_cards_provider_upgrade_is_compare_and_swap_and_keeps_history() {
    let (db, s) = fixture();
    let id = &s.conversation.summary.id;
    assert_eq!(db.local_chat_provider_tool_version(id).unwrap(), 0);
    db.set_local_chat_provider_thread(id, "old").unwrap();
    assert!(db
        .replace_local_chat_provider_thread(id, "wrong", "new", 1)
        .is_err());
    db.replace_local_chat_provider_thread(id, "old", "new", 1)
        .unwrap();
    assert_eq!(
        db.local_chat_provider_thread(id).unwrap().as_deref(),
        Some("new")
    );
    assert_eq!(db.local_chat_provider_tool_version(id).unwrap(), 1);
    assert_eq!(db.get_local_chat(id).unwrap().unwrap().messages.len(), 2);
}

#[test]
#[ignore = "exports real compiler output for the isolated UI review fixture"]
fn local_chat_cards_export_review_fixtures() {
    let path = std::env::var("BOWERBIRD_CARD_FIXTURES").expect("explicit fixture output path");
    let mut examples = serde_json::Map::new();
    for mode in ["count", "rows", "h3", "sections", "sections_large"] {
        let (db, s) = fixture();
        let mut args = match mode {
            "h3" => h3_batch(),
            "sections" | "sections_large" => section_batch(mode == "sections_large"),
            _ => batch(),
        };
        if mode == "rows" {
            args["cards"][3] = json!({"id":"repeat","kind":"loop","title":"逐行循环","mode":"rows","source":"copy","body":["draw"]});
        }
        let action = create(&db, &s, &args).unwrap();
        let notes = action
            .cards
            .iter()
            .filter(|c| matches!(c.kind.as_str(), "content" | "section"))
            .map(|c| db.get_canvas_node(&c.id).unwrap().unwrap())
            .collect::<Vec<_>>();
        let (revision, document) = workflow(&db.conn.lock().unwrap(), "p").unwrap();
        examples.insert(mode.into(),json!({"args":args,"action":action,"workflow":{"revision":revision,"document":document},"notes":notes}));
    }
    std::fs::write(path, serde_json::to_vec_pretty(&examples).unwrap()).unwrap();
}
