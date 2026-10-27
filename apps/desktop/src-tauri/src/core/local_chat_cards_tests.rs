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
    for mode in ["count", "rows"] {
        let (db, s) = fixture();
        let mut args = batch();
        if mode == "rows" {
            args["cards"][3] = json!({"id":"repeat","kind":"loop","title":"逐行循环","mode":"rows","source":"copy","body":["draw"]});
        }
        let action = create(&db, &s, &args).unwrap();
        let notes = action
            .cards
            .iter()
            .filter(|c| c.kind == "content")
            .map(|c| db.get_canvas_node(&c.id).unwrap().unwrap())
            .collect::<Vec<_>>();
        let (revision, document) = workflow(&db.conn.lock().unwrap(), "p").unwrap();
        examples.insert(mode.into(),json!({"args":args,"action":action,"workflow":{"revision":revision,"document":document},"notes":notes}));
    }
    std::fs::write(path, serde_json::to_vec_pretty(&examples).unwrap()).unwrap();
}
