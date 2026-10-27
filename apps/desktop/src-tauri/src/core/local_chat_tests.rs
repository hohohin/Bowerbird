use super::*;
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
        project_id: "project-a".into(),
        conversation_id: None,
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
fn local_chat_active_turn_blocks_project_deletion_but_terminal_turn_does_not() {
    let db = fixture();
    let started = db.begin_local_chat(&input("first")).unwrap();
    let id = &started.conversation.summary.id;
    assert!(
        crate::core::projects::ensure_project_has_no_unfinished_work(
            &db.conn.lock().unwrap(),
            "project-a",
            false
        )
        .is_err()
    );
    db.finish_local_chat(id, &started.turn_id, "done", None)
        .unwrap();
    crate::core::projects::ensure_project_has_no_unfinished_work(
        &db.conn.lock().unwrap(),
        "project-a",
        false,
    )
    .unwrap();
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
