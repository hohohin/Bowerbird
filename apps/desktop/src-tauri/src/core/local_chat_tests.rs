use super::*;

fn agent_projection(db: &Database) -> serde_json::Value {
    let source: String = db.conn.lock().unwrap().query_row("SELECT document_json FROM canvas_workflows WHERE project_id='project-a'", [], |row| row.get(0)).unwrap();
    serde_json::from_str(&source).unwrap()
}

#[test]
fn local_chat_projects_one_agent_and_delivers_only_the_original_turn() {
    let db = fixture();
    let mut request = input("large-agent");
    request.text = "长篇输入".repeat(100_000);
    let first = db.begin_local_chat(&request).unwrap();
    let chat = &first.conversation.summary;
    let projection = agent_projection(&db);
    assert_eq!(projection["nodes"].as_array().unwrap().len(), 1);
    let node = &projection["nodes"][0];
    assert_eq!(node["id"], chat.node_id);
    assert_eq!(node["kind"], "agent");
    assert_eq!(node["chatConversationId"], chat.id);
    assert_eq!(node["prompt"], request.text);
    assert_eq!(first.conversation.submitted_turn_id.as_deref(), Some(first.turn_id.as_str()));
    assert_eq!(chat.status, "running");
    db.update_local_chat_text(&chat.id, &first.turn_id, "原轮次结果").unwrap();
    db.finish_local_chat(&chat.id, &first.turn_id, "done", None).unwrap();
    assert_eq!(agent_projection(&db)["nodes"][0]["outputs"]["text"]["text"], "原轮次结果");
    let mut next = input("agent-continue");
    next.conversation_id = Some(chat.id.clone());
    next.agent_node_id = Some(chat.node_id.clone());
    let second = db.begin_local_chat(&next).unwrap();
    let replay = db.local_chat_by_request(&request.request_id).unwrap().unwrap();
    assert_eq!(replay.submitted_turn_id.as_deref(), Some(first.turn_id.as_str()));
    assert_eq!(replay.summary.status, "running");
    db.finish_local_chat(&chat.id, &first.turn_id, "done", None).unwrap();
    assert_eq!(db.get_local_chat(&chat.id).unwrap().unwrap().summary.status, "running");
    assert_eq!(agent_projection(&db)["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(count(&db, "local_chat_turns"), 2);
    assert_eq!(count(&db, "canvas_nodes"), 1);
    db.finish_local_chat(&chat.id, &second.turn_id, "stopped", None).unwrap();
}

#[test]
fn local_chat_binds_existing_agent_atomically_and_rejects_foreign_cards() {
    let db = fixture();
    let doc = serde_json::json!({"schema_version":1,"nodes":[{"id":"agent-one","kind":"agent","prompt":"卡片任务","inputs":{},"outputs":{},"x":50,"y":60}],"run":null});
    db.conn.lock().unwrap().execute("INSERT INTO canvas_workflows(project_id,revision,document_json) VALUES('project-a',1,?1)", [doc.to_string()]).unwrap();
    let mut request = input("bound-agent");
    request.agent_node_id = Some("missing".into());
    assert!(db.begin_local_chat(&request).is_err());
    assert_eq!(count(&db, "local_chat_turns"), 0);
    request.agent_node_id = Some("agent-one".into());
    let first = db.begin_local_chat(&request).unwrap();
    assert_eq!(first.conversation.summary.node_id, "agent-one");
    assert_eq!(agent_projection(&db)["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(agent_projection(&db)["nodes"][0]["prompt"], "卡片任务");
    assert!(!db.begin_local_chat(&request).unwrap().is_new);
    assert_eq!(count(&db, "local_chat_turns"), 1);
    db.finish_local_chat(&first.conversation.summary.id, &first.turn_id, "done", None).unwrap();
    request.request_id = "wrong-card".into();
    request.conversation_id = Some(first.conversation.summary.id.clone());
    request.agent_node_id = Some("different".into());
    assert!(db.begin_local_chat(&request).is_err());
    assert_eq!(count(&db, "local_chat_turns"), 1);
}

#[test]
fn local_chat_dsh_providers_keep_identity_and_reject_codex_options() {
    let db = fixture();
    for provider in ["dsh-local", "dsh-cloud"] {
        let mut raw = serde_json::to_value(input(provider)).unwrap();
        raw["provider"] = serde_json::json!(provider);
        let request: ChatSendInput = serde_json::from_value(raw.clone()).expect("DSH provider accepted");
        let started = db.begin_local_chat(&request).unwrap();
        assert_eq!(started.conversation.summary.provider, provider);
        db.finish_local_chat(&started.conversation.summary.id, &started.turn_id, "done", None).unwrap();
        assert!(!db.replay_local_chat(&request).unwrap().unwrap().is_new);
        raw["conversationId"] = serde_json::json!(started.conversation.summary.id);
        raw["requestId"] = serde_json::json!(format!("{provider}-switch"));
        raw["provider"] = serde_json::json!("codex-local");
        assert!(db.begin_local_chat(&serde_json::from_value(raw.clone()).unwrap()).is_err());
        raw["provider"] = serde_json::json!(provider);
        raw["codexOptions"] = serde_json::json!({"model":"test"});
        assert!(db.begin_local_chat(&serde_json::from_value(raw).unwrap()).is_err());
    }
}

#[test]
fn local_chat_model_options_reject_cloud_and_malformed_values_without_creating_turns() {
    let db = fixture();
    for options in [serde_json::json!({"model":""}), serde_json::json!({"reasoningEffort":"high\n"})] {
        let mut raw = serde_json::to_value(input("bad-model")).unwrap();
        raw["codexOptions"] = options;
        assert!(db.begin_local_chat(&serde_json::from_value(raw).unwrap()).is_err());
    }
    let mut raw = serde_json::to_value(input("cloud-model")).unwrap();
    raw["provider"] = serde_json::json!("deepseek-cloud");
    raw["codexOptions"] = serde_json::json!({});
    assert!(db.begin_local_chat(&serde_json::from_value(raw).unwrap()).err().unwrap().to_string().contains("Codex"));
    assert!(db.list_local_chats("project-a").unwrap().is_empty());
}

#[test]
fn local_chat_model_selection_is_durable_inherited_and_part_of_request_identity() {
    let db = fixture();
    let mut raw = serde_json::to_value(input("model-one")).unwrap();
    raw["codexOptions"] = serde_json::json!({"model":"fixture-model","reasoningEffort":"high"});
    let first: ChatSendInput = serde_json::from_value(raw.clone()).unwrap();
    let started = db.begin_local_chat(&first).unwrap();
    let id = started.conversation.summary.id.clone();
    assert_eq!(serde_json::to_value(&started.conversation).unwrap()["codexOptions"], raw["codexOptions"]);
    db.finish_local_chat(&id, &started.turn_id, "done", None).unwrap();
    let mut next = input("model-two");
    next.conversation_id = Some(id.clone());
    let continued = db.begin_local_chat(&next).unwrap();
    assert_eq!(serde_json::to_value(&continued.conversation).unwrap()["codexOptions"], raw["codexOptions"]);
    db.finish_local_chat(&id, &continued.turn_id, "done", None).unwrap();
    raw["conversationId"] = serde_json::json!(id);
    raw["requestId"] = serde_json::json!("reset-model");
    raw["codexOptions"] = serde_json::json!({});
    let reset: ChatSendInput = serde_json::from_value(raw).unwrap();
    let reset = db.begin_local_chat(&reset).unwrap();
    assert_eq!(serde_json::to_value(&reset.conversation).unwrap()["codexOptions"], serde_json::json!({}));
    assert!(!db.replay_local_chat(&first).unwrap().unwrap().is_new);
    assert!(!db.replay_local_chat(&next).unwrap().unwrap().is_new);
    let mut conflict = serde_json::to_value(first).unwrap();
    conflict["codexOptions"]["reasoningEffort"] = serde_json::json!("low");
    assert!(db.replay_local_chat(&serde_json::from_value(conflict).unwrap()).is_err());
}

#[test]
fn local_chat_video_delivery_survives_completion_and_rejects_foreign_or_stopped_turns() {
    let db = fixture();
    let started = db.begin_local_chat(&input("video")).unwrap();
    let id = &started.conversation.summary.id;
    let turn = &started.turn_id;
    db.save_local_chat_video(id, turn, "正在渲染视频", "running", &[]).unwrap();
    assert!(db.save_local_chat_video(id, "foreign", "bad", "running", &[]).is_err());
    db.save_local_chat_video(id, turn, "视频已完成", "done", &["video-asset".into()]).unwrap();
    db.finish_local_chat(id, turn, "done", None).unwrap();
    db.recover_local_chats().unwrap();
    let chat = db.get_local_chat(id).unwrap().unwrap();
    let message = chat.messages.iter().find(|m|m.id.ends_with("-video")).unwrap();
    assert_eq!(message.reference_asset_ids, ["video-asset"]);
    assert_eq!(message.status, "done");
    assert!(db.save_local_chat_video(id, turn, "late", "running", &[]).is_err());
}
use crate::core::{
    creative_session_contract::CreativeNodeKind,
    project_canvas::{
        CanvasNodeRemoval, NewCanvasNode, ProjectCanvasMaterializeInput, ProjectTitleSource,
    },
};

fn fixture() -> Database {
    let db = Database::open_in_memory().unwrap();
    db.migrate().unwrap();
    for id in ["project-a", "project-b"] {
        db.materialize_project_canvas(
            &ProjectCanvasMaterializeInput {
                project_id: id.into(),
                name: id.into(),
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
    db
}
fn input(request: &str) -> ChatSendInput {
    ChatSendInput {
        provider: None,
        codex_options: None,
        project_id: "project-a".into(),
        conversation_id: None,
        agent_node_id: None,
        request_id: request.into(),
        text: "请帮我分析这组视觉方向".into(),
        reference_asset_ids: vec![],
        card_defaults: None,
        placement: Some(ChatPlacement {
            x: 150.0,
            y: 80.0,
            width: 300.0,
            height: 180.0,
            z_index: 9,
        }),
    }
}
fn count(db: &Database, table: &str) -> i64 {
    db.conn
        .lock()
        .unwrap()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn local_chat_provider_is_durable_inherited_and_part_of_request_identity() {
    let db = fixture();
    let mut value = serde_json::to_value(input("cloud-provider")).unwrap();
    value["provider"] = serde_json::json!("deepseek-cloud");
    let cloud: ChatSendInput = serde_json::from_value(value.clone()).unwrap();
    let started = db.begin_local_chat(&cloud).unwrap();
    assert_eq!(started.conversation.summary.provider, "deepseek-cloud");
    assert!(!db.begin_local_chat(&cloud).unwrap().is_new);
    value["provider"] = serde_json::json!("codex-local");
    let changed = serde_json::from_value(value).unwrap();
    assert!(db.begin_local_chat(&changed).is_err());
    db.finish_local_chat(
        &started.conversation.summary.id,
        &started.turn_id,
        "done",
        None,
    )
    .unwrap();
    let mut follow = input("cloud-follow");
    follow.conversation_id = Some(started.conversation.summary.id.clone());
    assert_eq!(
        db.begin_local_chat(&follow)
            .unwrap()
            .conversation
            .summary
            .provider,
        "deepseek-cloud"
    );
    let mut mismatch = serde_json::to_value(input("cloud-mismatch")).unwrap();
    mismatch["conversationId"] = serde_json::json!(started.conversation.summary.id);
    mismatch["provider"] = serde_json::json!("codex-local");
    assert!(db
        .begin_local_chat(&serde_json::from_value(mismatch).unwrap())
        .is_err());
    assert_eq!(count(&db, "local_chat_turns"), 2);
}

#[test]
fn local_chat_explicit_codex_replays_legacy_request_and_rejects_unknown_provider() {
    let db = fixture();
    let request = input("legacy-provider");
    db.begin_local_chat(&request).unwrap();
    let mut value = serde_json::to_value(request).unwrap();
    value["provider"] = serde_json::json!("codex-local");
    assert!(
        !db.begin_local_chat(&serde_json::from_value(value.clone()).unwrap())
            .unwrap()
            .is_new
    );
    value["provider"] = serde_json::json!("untrusted-provider");
    assert!(serde_json::from_value::<ChatSendInput>(value).is_err());
}

#[test]
fn local_chat_provider_migration_preserves_history_actions_and_foreign_keys() {
    for (version, provider) in [(48, ChatProvider::CodexLocal), (52, ChatProvider::DeepseekCloud)] {
    let db = Database::open_in_memory().unwrap();
    crate::db::migrations::migrations()
        .to_version(&mut db.conn.lock().unwrap(), version)
        .unwrap();
    db.materialize_project_canvas(
        &ProjectCanvasMaterializeInput {
            project_id: "project-a".into(),
            name: "Legacy".into(),
            workspace_path: "blank:legacy".into(),
            workspace_key: "blank:legacy".into(),
            kind: "blank".into(),
            title_source: ProjectTitleSource::Default,
            draft_json: r#"{"schema_version":1}"#.into(),
        },
        &[],
        &[],
        None,
    )
    .unwrap();
    let mut request = input("before-provider-migration");
    request.provider = Some(provider);
    request.card_defaults = Some(Default::default());
    let started = db.begin_local_chat(&request).unwrap();
    let action = db.create_local_chat_cards(&started.conversation.summary.id, &started.turn_id,"legacy-call",&serde_json::json!({"cards":[{"id":"text","kind":"content","title":"旧卡片","text":"保留"}]})).unwrap();
    db.update_local_chat_text(&started.conversation.summary.id, &started.turn_id, "旧回复")
        .unwrap();
    db.set_local_chat_provider_thread(&started.conversation.summary.id, "legacy-codex-thread")
        .unwrap();
    db.finish_local_chat(
        &started.conversation.summary.id,
        &started.turn_id,
        "done",
        None,
    )
    .unwrap();
    db.migrate().unwrap();
    let chat = db
        .get_local_chat(&started.conversation.summary.id)
        .unwrap()
        .unwrap();
    assert_eq!(chat.summary.provider, provider.as_str());
    assert_eq!(chat.messages[1].text, "旧回复");
    assert_eq!(chat.actions[0].id, action.id);
    assert_eq!(
        db.local_chat_provider_thread(&chat.summary.id)
            .unwrap()
            .as_deref(),
        Some("legacy-codex-thread")
    );
    assert!(!db.begin_local_chat(&request).unwrap().is_new);
    let conn = db.conn.lock().unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
    assert!(conn
        .execute(
            "UPDATE local_chat_conversations SET provider='arbitrary'",
            []
        )
        .is_err());
    }
}

#[test]
fn local_chat_creation_is_atomic_idempotent_and_separate_from_generation() {
    let db = fixture();
    let request = input("same");
    let first = db.begin_local_chat(&request).unwrap();
    let replay = db.begin_local_chat(&request).unwrap();
    assert!(first.is_new);
    assert!(!replay.is_new);
    assert_eq!(
        first.conversation.summary.id,
        replay.conversation.summary.id
    );
    assert_eq!(count(&db, "creative_threads"), 1);
    assert_eq!(count(&db, "canvas_nodes"), 1);
    assert_eq!(count(&db, "local_chat_turns"), 1);
    assert_eq!(count(&db, "local_chat_messages"), 2);
    assert_eq!(count(&db, "task_queue"), 0);
    let node = db
        .get_canvas_node(&first.conversation.summary.node_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        node.thread_id.as_deref(),
        Some(first.conversation.summary.thread_id.as_str())
    );
    assert_eq!(node.x, 150.0);
    assert_eq!(node.z_index, 9);
    assert!(node.payload_json.contains("conversation_id"));
    assert_eq!(first.conversation.messages[0].role, "user");
    assert_eq!(first.conversation.messages[1].role, "assistant");
    assert_eq!(db.list_local_chats("project-b").unwrap().len(), 0);
}

#[test]
fn local_chat_rejects_cross_project_replay_conflicts_and_parallel_turns() {
    let db = fixture();
    let request = input("first");
    let first = db.begin_local_chat(&request).unwrap();
    let mut changed = request.clone();
    changed.text = "different".into();
    assert!(db.begin_local_chat(&changed).is_err());
    changed = request.clone();
    changed.project_id = "project-b".into();
    assert!(db.begin_local_chat(&changed).is_err());
    let mut next = input("second");
    next.conversation_id = Some(first.conversation.summary.id.clone());
    assert!(db
        .begin_local_chat(&next)
        .unwrap_err_text()
        .contains("仍在回复"));
    db.finish_local_chat(&first.conversation.summary.id, &first.turn_id, "done", None)
        .unwrap();
    next.project_id = "project-b".into();
    assert!(db.begin_local_chat(&next).is_err());
    assert_eq!(count(&db, "local_chat_turns"), 1);
}

trait ErrorText<T> {
    fn unwrap_err_text(self) -> String;
}
impl<T> ErrorText<T> for AppResult<T> {
    fn unwrap_err_text(self) -> String {
        match self {
            Ok(_) => panic!("expected error"),
            Err(error) => error.to_string(),
        }
    }
}

#[test]
fn local_chat_validation_rolls_back_projection() {
    let db = fixture();
    for invalid in ["asset", "geometry", "project", "text"] {
        let mut request = input(invalid);
        match invalid {
            "asset" => request.reference_asset_ids.push("missing".into()),
            "geometry" => request.placement.as_mut().unwrap().width = -1.0,
            "project" => request.project_id = "missing".into(),
            _ => request.text = " ".into(),
        }
        assert!(db.begin_local_chat(&request).is_err());
    }
    assert_eq!(count(&db, "canvas_nodes"), 0);
    assert_eq!(count(&db, "creative_threads"), 0);
    assert_eq!(count(&db, "local_chat_conversations"), 0);
}

#[test]
fn local_chat_stop_and_restart_preserve_partial_history_and_session() {
    let db = fixture();
    let started = db.begin_local_chat(&input("first")).unwrap();
    let id = &started.conversation.summary.id;
    db.set_local_chat_provider_thread(id, "provider-session")
        .unwrap();
    db.update_local_chat_text(id, &started.turn_id, "已经收到的中文回复")
        .unwrap();
    db.mark_local_chat_stopping(id).unwrap();
    db.recover_local_chats().unwrap();
    let recovered = db.get_local_chat(id).unwrap().unwrap();
    assert_eq!(recovered.summary.status, "interrupted");
    assert_eq!(recovered.messages[1].text, "已经收到的中文回复");
    assert_eq!(recovered.messages[1].status, "interrupted");
    assert_eq!(
        db.local_chat_provider_thread(id).unwrap().as_deref(),
        Some("provider-session")
    );
    let replay = db.begin_local_chat(&input("first")).unwrap();
    assert!(!replay.is_new);
    assert_eq!(replay.conversation.summary.status, "interrupted");
    let mut next = input("next");
    next.conversation_id = Some(id.clone());
    let next = db.begin_local_chat(&next).unwrap();
    db.finish_local_chat(id, &started.turn_id, "done", None)
        .unwrap(); // A late old turn cannot finish the new turn.
    assert_eq!(
        db.get_local_chat(id).unwrap().unwrap().summary.status,
        "running"
    );
    db.finish_local_chat(id, &next.turn_id, "stopped", None)
        .unwrap();
    assert_eq!(count(&db, "creative_threads"), 1);
    assert_eq!(count(&db, "canvas_nodes"), 1);
}

#[test]
fn local_chat_cards_hide_without_erasing_audit_and_reopen_in_place() {
    let db = fixture();
    let started = db.begin_local_chat(&input("first")).unwrap();
    let summary = &started.conversation.summary;
    assert_eq!(
        db.remove_canvas_node(&summary.node_id).unwrap(),
        Some(CanvasNodeRemoval::Hidden)
    );
    assert!(db.get_local_chat(&summary.id).unwrap().is_some());
    assert!(db
        .update_canvas_note_payload(&summary.node_id, r#"{"schema_version":1,"text":"changed"}"#)
        .is_err());
    db.finish_local_chat(&summary.id, &started.turn_id, "done", None)
        .unwrap();
    let mut next = input("next");
    next.conversation_id = Some(summary.id.clone());
    db.begin_local_chat(&next).unwrap();
    let node = db.get_canvas_node(&summary.node_id).unwrap().unwrap();
    assert!(node.hidden_at.is_none());
    assert_eq!(node.x, 150.0);
    let manual = NewCanvasNode {
        id: "fake".into(),
        project_id: summary.project_id.clone(),
        thread_id: Some(summary.thread_id.clone()),
        kind: CreativeNodeKind::Note,
        asset_id: None,
        role: None,
        payload_json: node.payload_json,
        x: 0.0,
        y: 0.0,
        width: 300.0,
        height: 180.0,
        z_index: 0,
        position_locked: false,
    };
    assert!(db.create_canvas_node(&manual).is_err());
}

#[test]
fn local_chat_active_turn_allows_project_deletion_and_late_finish_cannot_restore_it() {
    let db = fixture();
    let started = db.begin_local_chat(&input("first")).unwrap();
    let id = &started.conversation.summary.id;
    db.delete_project("project-a", crate::core::projects::ProjectDeleteMode::Keep).unwrap();
    let _ = db.finish_local_chat(id, &started.turn_id, "done", None);
    assert!(db.get_project("project-a").unwrap().is_none());
    assert_eq!(db.conn.lock().unwrap().query_row("SELECT COUNT(*) FROM local_chat_conversations WHERE id=?1", [id], |r| r.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn local_chat_recovery_does_not_change_finished_history() {
    let db = fixture();
    let started = db.begin_local_chat(&input("first")).unwrap();
    let id = &started.conversation.summary.id;
    db.update_local_chat_text(id, &started.turn_id, "完整回复")
        .unwrap();
    db.finish_local_chat(id, &started.turn_id, "done", None)
        .unwrap();
    let before = serde_json::to_value(db.get_local_chat(id).unwrap()).unwrap();
    db.recover_local_chats().unwrap();
    assert_eq!(
        before,
        serde_json::to_value(db.get_local_chat(id).unwrap()).unwrap()
    );
}
